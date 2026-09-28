import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));

import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';

// oauth_provider is 'microsoft' (non-Gmail OAuth) so this exercises serverAutoSaves without the
// Gmail-API send path — send.gmailApiTransport.test.js covers the Gmail-specific behavior.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'microsoft' };
const sendMail = vi.fn();
let server;
let base;
let errorSpy;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  query.mockImplementation(async (sql) => {
    if (sql.includes('INSERT INTO mailbox_audit_log')) throw Object.assign(new Error('journal down'), { code: '57P01' });
    return { rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] };
  });
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});
afterEach(() => { errorSpy.mockRestore(); });

const auditInsert = () => query.mock.calls.find(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'));
const post = (body) => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ accountId: 'a1', subject: 'Quarterly numbers', body: 'Confidential body text', ...body }),
});

describe('sending is journaled', () => {
  it('records the accepted message without subject or body, and a journal failure keeps the send successful', async () => {
    const res = await post({ to: ['you@example.com'], cc: ['cc@example.com'], bcc: ['hidden@example.com'] });

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    await vi.waitFor(() => expect(auditInsert()).toBeTruthy());
    const [, [payload]] = auditInsert();
    expect(JSON.parse(payload)).toEqual([{
      actor_user_id: 'u1', actor_email: null, account_id: 'a1', account_email: null, action: 'message.sent',
      details: {
        messageId: sendMail.mock.calls[0][0].messageId,
        to: ['you@example.com'], cc: ['cc@example.com'], bcc: ['hidden@example.com'],
      },
    }]);
    expect(payload).not.toMatch(/Quarterly numbers|Confidential body text/);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('[audit] Failed to record entries:', '57P01'));
  });

  it('records nothing when the SMTP server rejects the message', async () => {
    sendMail.mockRejectedValueOnce(new Error('550 rejected'));
    expect((await post({ to: ['you@example.com'] })).status).toBe(500);
    expect(auditInsert()).toBeUndefined();
  });
});
