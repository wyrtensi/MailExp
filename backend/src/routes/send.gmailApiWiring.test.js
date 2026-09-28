import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// send.js's own responsibilities around the Gmail API path: looking up threadId, adopting a
// reconciled Message-ID, and turning a `.definite` mail-send error into the right JSON response.
// The Gmail API mechanics themselves (HTTP, classification, SMTP fallback decisions) are covered
// by services/gmailApiSender.test.js and services/mailSendTransport.test.js — here
// createAccountSendTransport is mocked directly so these tests only exercise routes/send.js.
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/mailSendTransport.js', () => ({ createAccountSendTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));

import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';
import { createAccountSendTransport } from '../services/mailSendTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';

const account = {
  id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'google',
  smtp_host: 'smtp.gmail.com', smtp_port: 465,
};
const sendMail = vi.fn();
let server, base, idempotencyCounter = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

beforeEach(() => {
  vi.clearAllMocks();
  idempotencyCounter += 1;
  query.mockImplementation(async sql => {
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    if (sql.includes('FROM users')) return { rows: [{ preferences: {} }] };
    if (sql.includes('FROM messages')) return { rows: [] };
    return { rows: [] };
  });
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  redisClient.del.mockResolvedValue(1);
  createAccountSendTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({ via: 'api', messageId: undefined });
  resolveSentFolder.mockResolvedValue(null);
});

const post = (body = {}) => fetch(`${base}/api/mail/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': `k${idempotencyCounter}` },
  body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello', ...body }),
});

describe('Gmail API threadId lookup', () => {
  it('looks up provider_thread_id by the replied-to Message-ID and passes threadId as hex', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts')) return { rows: [account] };
      if (sql.includes('FROM users')) return { rows: [{ preferences: {} }] };
      if (sql.includes('FROM messages')) return { rows: [{ provider_thread_id: '291' }] }; // 291 decimal = 123 hex
      return { rows: [] };
    });
    const res = await post({ inReplyTo: '<original@example.com>' });
    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledWith(expect.anything(), { threadId: '123' });
    const threadLookup = query.mock.calls.find(c => c[0].includes('FROM messages'));
    expect(threadLookup[1]).toEqual([account.id, 'original@example.com']);
  });

  it('passes threadId: null when no matching message has a stored thread id', async () => {
    const res = await post({ inReplyTo: '<unknown@example.com>' });
    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledWith(expect.anything(), { threadId: null });
  });

  it('does not query for a thread id when not replying', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(query.mock.calls.some(c => c[0].includes('FROM messages'))).toBe(false);
    expect(sendMail).toHaveBeenCalledWith(expect.anything(), { threadId: null });
  });

  it('does not query for a thread id for a non-Gmail account even when replying', async () => {
    const msAccount = { ...account, oauth_provider: 'microsoft' };
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts')) return { rows: [msAccount] };
      if (sql.includes('FROM users')) return { rows: [{ preferences: {} }] };
      return { rows: [] };
    });
    createAccountSendTransport.mockResolvedValue({ account: msAccount, transport: { sendMail } });
    const res = await post({ inReplyTo: '<original@example.com>' });
    expect(res.status).toBe(200);
    expect(query.mock.calls.some(c => c[0].includes('FROM messages'))).toBe(false);
  });
});

describe('Message-ID reconciliation', () => {
  it('adopts the Message-ID the transport reports when it differs from ours', async () => {
    sendMail.mockResolvedValue({ via: 'api', messageId: '<real@gmail.com>' });
    const { recordAudit } = await import('../services/auditLog.js');
    const res = await post();
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ messageId: '<real@gmail.com>' }),
    }));
  });

  it('keeps our own Message-ID when the transport does not report a different one', async () => {
    sendMail.mockResolvedValue({ via: 'api' });
    const { recordAudit } = await import('../services/auditLog.js');
    const res = await post();
    expect(res.status).toBe(200);
    const usedId = recordAudit.mock.calls[0][0].details.messageId;
    expect(usedId).toMatch(/^<[0-9a-f]+@example\.com>$/);
  });
});

describe('idempotency across the API and SMTP-fallback paths', () => {
  it('caches whichever transport actually delivered, and a retry with the same key never sends again', async () => {
    sendMail.mockResolvedValue({ via: 'smtp', messageId: undefined }); // e.g. the API fell back to SMTP internally
    const key = `k${idempotencyCounter}`;
    const first = await fetch(`${base}/api/mail/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
      body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello' }),
    });
    expect(first.status).toBe(200);
    const cached = JSON.stringify(await first.json());
    expect(sendMail).toHaveBeenCalledTimes(1);

    // Simulate the retry finding the cached result via Redis (as the real send_idem:* key would).
    redisClient.get.mockResolvedValueOnce(cached);
    const retry = await fetch(`${base}/api/mail/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
      body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello' }),
    });
    expect(retry.status).toBe(200);
    expect(JSON.stringify(await retry.json())).toBe(cached);
    expect(sendMail).toHaveBeenCalledTimes(1); // still just the one delivery
  });
});

describe('a definite mail-send failure', () => {
  it('reports the transport-supplied status/code/message and releases the idempotency reservation', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('One of the recipient addresses was rejected.'), {
      code: 'gmail_invalid_recipient', status: 400, definite: true,
    }));
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'One of the recipient addresses was rejected.', code: 'gmail_invalid_recipient' });
    expect(redisClient.del).toHaveBeenCalled();
  });

  it('treats an uncertain (non-SMTP-shaped, non-.definite) failure as send_uncertain, keeping the reservation', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('send_uncertain');
    expect(redisClient.del).not.toHaveBeenCalled();
  });

  it('reports a fallback SMTP setup failure the same way as a Gmail API rejection', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('SMTP password is corrupted or missing — please re-enter your account password in Settings.'), {
      status: 502, definite: true, mailSendFallbackSetupFailed: true,
    }));
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/SMTP password is corrupted/);
  });
});
