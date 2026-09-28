import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// #381: download a message as .eml. The route serves the raw RFC 822 source with a
// filename derived from the subject. Mailboxes are shared install-wide (migration 0056
// dropped their owner column), so there is no per-user ownership check here.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    fetchRawMessage: vi.fn(),
    fetchMessageSize: vi.fn(),
    broadcast: vi.fn(),
    // A letter with no pending move is read where its row says (moveQueue.serverLocation),
    // same as every other IMAP read in mail.js (headers, attachments, body).
    moveQueue: { serverLocation: vi.fn(async (m) => ({ folder: m.folder, uid: Number(m.uid) })) },
  },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const MSG_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const RAW = 'From: a@b.c\r\nSubject: Quarterly report\r\n\r\nBody\r\n';

function buildApp() {
  const app = express();
  app.use('/api/mail', mailRoutes);
  return app;
}

describe('GET /api/mail/messages/:id/raw.eml (#381)', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.fetchRawMessage.mockReset().mockResolvedValue(Buffer.from(RAW));
    imapManager.fetchMessageSize.mockReset().mockResolvedValue(RAW.length);
    imapManager.moveQueue.serverLocation.mockReset().mockImplementation(async (m) => ({ folder: m.folder, uid: Number(m.uid) }));
    query.mockImplementation((sql) => {
      if (sql.includes('FROM messages m')) {
        return Promise.resolve({ rows: [{ id: MSG_ID, uid: '42', folder: 'INBOX', subject: 'Quarterly report', account_id: ACCOUNT_ID }] });
      }
      if (sql.includes('SELECT * FROM email_accounts')) {
        return Promise.resolve({ rows: [{ id: ACCOUNT_ID, imap_host: 'imap.example.com' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('serves the raw source with the rfc822 type and a subject-derived filename', async () => {
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('message/rfc822');
    expect(res.headers.get('content-disposition')).toContain('.eml');
    expect(res.headers.get('content-disposition')).toContain('Quarterly');
    expect(await res.text()).toBe(RAW);
    // Resolved through serverLocation, so it fetches the real (resolved) uid/folder, not
    // necessarily the DB row's raw fields verbatim.
    expect(imapManager.fetchRawMessage.mock.calls[0].slice(1)).toEqual([42, 'INBOX']);
    expect(imapManager.fetchMessageSize.mock.calls[0].slice(1)).toEqual([42, 'INBOX']);
  });

  // Review finding (Medium): a message's raw source is the sum of all its parts, so it can
  // exceed the attachment route's own 50 MB cap even when no single attachment does.
  it('413s an oversized message before buffering it, without fetching the raw source', async () => {
    imapManager.fetchMessageSize.mockResolvedValue(51 * 1024 * 1024);
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/50 MB/);
    // Stable code, not the English text, so the frontend can show its own localized message.
    expect(body.code).toBe('message_too_large');
    expect(imapManager.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('allows a message right at the cap, and one just under it', async () => {
    imapManager.fetchMessageSize.mockResolvedValue(50 * 1024 * 1024);
    const atCap = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(atCap.status).toBe(200);

    imapManager.fetchMessageSize.mockResolvedValue(50 * 1024 * 1024 - 1);
    const underCap = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(underCap.status).toBe(200);
  });

  // A server that doesn't answer the size FETCH (size: null) should not block an otherwise
  // legitimate download — same "0 means unknown, allow it" stance the attachment route takes.
  it('proceeds when the server does not answer the size fetch', async () => {
    imapManager.fetchMessageSize.mockResolvedValue(null);
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(200);
    expect(imapManager.fetchRawMessage).toHaveBeenCalled();
  });

  // Upstream #507 (maathimself/mailflow): String.prototype.slice counts UTF-16 code units, not
  // code points, so a subject whose 80th unit lands inside an astral character (an emoji, 2
  // units) used to cut a surrogate pair in half. The lone surrogate then made encodeURIComponent
  // throw inside attachmentDisposition's rfc5987(), 500ing the whole download. truncateFilename
  // (contentDisposition.js) fixes it by dropping the whole emoji rather than splitting it.
  it('drops an emoji split by the 80-char filename cut instead of failing', async () => {
    const subjectWithEmojiAtCut = `${'a'.repeat(79)}\u{1F600} more text after the cut`; // 😀 sits at code point 79
    query.mockImplementation((sql) => {
      if (sql.includes('FROM messages m')) {
        return Promise.resolve({ rows: [{ id: MSG_ID, uid: '42', folder: 'INBOX', subject: subjectWithEmojiAtCut, account_id: ACCOUNT_ID }] });
      }
      if (sql.includes('SELECT * FROM email_accounts')) {
        return Promise.resolve({ rows: [{ id: ACCOUNT_ID, imap_host: 'imap.example.com' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(200); // not a 500 from a lone-surrogate URIError
    const disposition = res.headers.get('content-disposition');
    const ext = disposition.match(/filename\*=UTF-8''(.+)$/)[1];
    // The straddling emoji is dropped, not split — same 79 'a's, no partial surrogate.
    expect(decodeURIComponent(ext)).toBe(`${'a'.repeat(79)}.eml`);
  });

  it('404s an id no row matches, without touching IMAP', async () => {
    query.mockImplementation(() => Promise.resolve({ rows: [] }));
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(404);
    expect(imapManager.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('rejects a malformed id before any query', async () => {
    const res = await fetch(`${base}/api/mail/messages/not-a-uuid/raw.eml`);
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('404s when the server has no source for the UID', async () => {
    imapManager.fetchRawMessage.mockResolvedValue(null);
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(404);
  });

  // Our fork is DB-first for moves (moveQueue.js): a letter mid-move carries a placeholder
  // uid that does not exist on the server yet. Fetching raw source for such a letter must
  // wait for the move rather than sending the placeholder to IMAP (see the recent
  // "keep pending-move placeholder uids away from IMAP everywhere" audit).
  it('answers move_pending instead of fetching a placeholder uid', async () => {
    imapManager.moveQueue.serverLocation.mockResolvedValue(null);
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('move_pending');
    expect(imapManager.fetchMessageSize).not.toHaveBeenCalled();
    expect(imapManager.fetchRawMessage).not.toHaveBeenCalled();
  });
});
