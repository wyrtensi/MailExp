import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// A full IMAP pool fails the body fetch with poolExhausted (upstream #474). That is our own
// connection budget, not a broken server, so the route says "busy, try again" with a 503.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    fetchMessageBody: vi.fn(),
    noteUserActivity: vi.fn(),
    // A letter with no pending move is read where its row says (moveQueue.serverLocation).
    moveQueue: { serverLocation: async (m) => ({ folder: m.folder, uid: Number(m.uid) }) },
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
  imapManager.fetchMessageBody.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  if (!ctx) ctx = await startServer();
  // The message row (no cached body, so the route goes to IMAP), then the account row.
  query
    .mockResolvedValueOnce({ rows: [{ id: MESSAGE_ID, account_id: ACCOUNT_ID, uid: 42, folder: 'INBOX', user_id: 'user-1' }] })
    .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] })
    .mockResolvedValue({ rows: [] });
});
afterAll(() => ctx?.server?.close());

describe('GET /messages/:id/body when the account is busy', () => {
  it('answers 503 busy for an exhausted pool', async () => {
    imapManager.fetchMessageBody.mockRejectedValue(Object.assign(new Error('IMAP pool busy, please retry'), { poolExhausted: true }));
    const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/body`);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.busy).toBe(true);
    expect(body.code).toBe('mailbox_busy');
  });

  it('answers the same 503 busy while a backoff holds new logins back', async () => {
    imapManager.fetchMessageBody.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { providerRefusing: true }));
    const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/body`);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.code).toBe('mailbox_busy');
  });

  it('says the password was rejected when that is what holds the login back', async () => {
    imapManager.fetchMessageBody.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { providerRefusing: true, authRejected: true }));
    const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/body`);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.code).toBe('mailbox_auth_rejected');
    // Neutral about where to fix it: a mail-node mailbox cannot change its password in its settings.
    expect(body.error).toBe('The mail server does not accept the sign-in to this mailbox. Ask an administrator to check the mailbox.');
  });

  it('answers 503 busy when the server refuses the connection outright', async () => {
    imapManager.fetchMessageBody.mockRejectedValue(new Error('Maximum number of connections from user+IP exceeded (mail_max_userip_connections=20)'));
    const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/body`);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('mailbox_busy');
  });

  it('still answers 500 for any other failure', async () => {
    imapManager.fetchMessageBody.mockRejectedValue(new Error('Mailbox does not exist'));
    const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/body`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.busy).toBeUndefined();
    // The server's own text stays in the log; the screen gets a code to translate.
    expect(body).toEqual({ error: 'Failed to load the message body', code: 'body_fetch_failed' });
  });
});
