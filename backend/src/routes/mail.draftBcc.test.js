import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Same mock surface the other mail.* route tests use so importing mail.js is side-effect free.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    fetchHeaders: vi.fn(),
    noteUserActivity: vi.fn(),
    // A letter with no pending move is read where its row says (moveQueue.serverLocation).
    moveQueue: { serverLocation: vi.fn(async (m) => ({ folder: m.folder, uid: Number(m.uid) })) },
  },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let ctx;
beforeEach(async () => {
  query.mockReset();
  imapManager.fetchHeaders.mockReset();
  imapManager.noteUserActivity.mockReset();
  imapManager.moveQueue.serverLocation.mockReset();
  imapManager.moveQueue.serverLocation.mockImplementation(async (m) => ({ folder: m.folder, uid: Number(m.uid) }));
  if (!ctx) ctx = await startServer();
});
afterAll(() => ctx?.server?.close());

// First query: the message row (mailboxes are shared install-wide — no per-user ownership check,
// same as the other per-message routes in mail.js). Second: the account row, only reached when
// bcc_addresses is not a known non-empty array.
function mockDraft(bccAddresses, messageId = '<d1@example.com>') {
  query
    .mockResolvedValueOnce({ rows: [{ account_id: ACCOUNT_ID, uid: 7, folder: 'Drafts', message_id: messageId, bcc_addresses: bccAddresses }] })
    .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] })
    .mockResolvedValue({ rows: [] });
}

const getBcc = async () => {
  const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/bcc`);
  return { status: res.status, body: await res.json() };
};

describe('GET /messages/:id/bcc — a saved draft\'s Bcc for the composer', () => {
  it('returns the Bcc stored with the draft, without asking the server', async () => {
    const stored = [{ name: 'Hidden Person', email: 'hidden@example.com' }];
    mockDraft(stored);
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: stored });
    expect(imapManager.fetchHeaders).not.toHaveBeenCalled();
  });

  // bcc_addresses is NOT NULL DEFAULT '[]' (0058), so a stored empty array does not prove the
  // draft has no Bcc — a row no writer ever set it on got the same '[]' by default. Only a
  // non-empty stored array is trusted; an empty one is treated the same as unknown and read from
  // the server, same as NULL.
  it('reads the server copy when the stored Bcc is an empty array, not known to be empty', async () => {
    mockDraft([]);
    imapManager.fetchHeaders.mockResolvedValue('Message-ID: <d1@example.com>\r\nBcc: someone@example.com\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [{ name: '', email: 'someone@example.com' }] });
    expect(imapManager.fetchHeaders).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 7, 'Drafts');
  });

  it('answers empty when the stored Bcc is an empty array and the server copy really has none', async () => {
    mockDraft([]);
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nMessage-ID: <d1@example.com>\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [] });
    expect(imapManager.fetchHeaders).toHaveBeenCalled();
  });

  it('parses bcc_addresses stored as a JSON string the same as a parsed array', async () => {
    const stored = [{ name: '', email: 'a@example.com' }];
    mockDraft(JSON.stringify(stored));
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: stored });
  });

  it('reads an unknown Bcc from the server copy: folded, encoded, and a quoted comma', async () => {
    // A draft saved before bcc_addresses existed, or by another client.
    mockDraft(null);
    imapManager.fetchHeaders.mockResolvedValue([
      'From: a@example.com',
      'Message-ID: <d1@example.com>',
      'Bcc: "Doe, Jane" <jane@example.com>, =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?=',
      ' <jm@example.de>, plain@example.org',
      '',
    ].join('\r\n'));
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [
      { name: 'Doe, Jane', email: 'jane@example.com' },
      { name: 'Jürgen Müller', email: 'jm@example.de' },
      { name: '', email: 'plain@example.org' },
    ] });
    expect(imapManager.fetchHeaders).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 7, 'Drafts');
    expect(imapManager.noteUserActivity).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('keeps every recipient when the server copy has more than one Bcc line', async () => {
    mockDraft(null);
    imapManager.fetchHeaders.mockResolvedValue('Message-ID: <d1@example.com>\r\nBcc: one@example.com\r\nBcc: two@example.com\r\n');
    const { body } = await getBcc();
    expect(body.bcc.map(r => r.email)).toEqual(['one@example.com', 'two@example.com']);
  });

  it('returns an empty Bcc when the server copy has headers but no Bcc', async () => {
    mockDraft(null);
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nMessage-ID: <d1@example.com>\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [] });
  });

  // Each of these used to open the draft with an empty Bcc, which its next save made permanent.
  it('fails rather than answer empty when the server returns no headers', async () => {
    mockDraft(null);
    imapManager.fetchHeaders.mockResolvedValue('');
    const { status, body } = await getBcc();
    expect(status).toBe(502);
    expect(body).not.toHaveProperty('bcc');
  });

  it('fails rather than answer empty when the server cannot be reached', async () => {
    mockDraft(null);
    imapManager.fetchHeaders.mockRejectedValue(new Error('pool exhausted'));
    const { status, body } = await getBcc();
    expect(status).toBe(502);
    expect(body).not.toHaveProperty('bcc');
  });

  it('refuses a uid that now holds a different message', async () => {
    mockDraft(null, '<d1@example.com>');
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nMessage-ID: <other@example.com>\r\nBcc: someone@example.com\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(409);
    expect(body).not.toHaveProperty('bcc');
  });

  it('refuses a server copy without the Message-ID the row has', async () => {
    // Sync stores NULL for a message with no Message-ID, so this is never the same message.
    mockDraft(null, '<d1@example.com>');
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nBcc: someone@example.com\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(409);
    expect(body).not.toHaveProperty('bcc');
  });

  it('reads a draft whose row has no Message-ID', async () => {
    mockDraft(null, null);
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nBcc: someone@example.com\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [{ name: '', email: 'someone@example.com' }] });
  });

  it('matches Message-IDs regardless of brackets, whitespace and case', async () => {
    mockDraft(null, '<D1@Example.com>');
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nMessage-ID:\r\n <d1@example.com>\r\nBcc: someone@example.com\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [{ name: '', email: 'someone@example.com' }] });
  });

  it('answers 404 for an id with no message row, without touching IMAP', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await getBcc();
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Message not found' });
    expect(query.mock.calls[0][1]).toEqual([MESSAGE_ID]);
    expect(imapManager.fetchHeaders).not.toHaveBeenCalled();
  });

  it('answers move-pending instead of fetching when the draft\'s move is still in flight', async () => {
    mockDraft(null);
    imapManager.moveQueue.serverLocation.mockResolvedValue(null);
    const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/bcc`);
    expect(res.status).toBe(409);
    expect(imapManager.fetchHeaders).not.toHaveBeenCalled();
  });
});
