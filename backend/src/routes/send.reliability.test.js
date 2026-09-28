import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
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

const account = {
  id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'google',
  smtp_host: 'smtp.gmail.com', smtp_port: 465,
};
const sendMail = vi.fn();
let server, base;
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
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  redisClient.del.mockResolvedValue(1);
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});
const post = (recipients = { to: ['you@example.com'] }) => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'send1' },
  body: JSON.stringify({ accountId: 'a1', ...recipients, subject: 'Test', body: 'Hello' }),
});
describe('send failure semantics', () => {
  it('does not deliver when idempotency lookup fails', async () => {
    redisClient.get.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect((await post()).status).toBe(503);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('does not deliver or remove another lock when reservation fails', async () => {
    redisClient.set.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect((await post()).status).toBe(503);
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('does not clear a concurrent send lock after a pre-reservation failure', async () => {
    createAccountSmtpTransport.mockRejectedValueOnce(new Error('SMTP setup failed'));
    expect((await post()).status).toBe(500);
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('reports delivery success with a Sent-copy warning after post-delivery failure', async () => {
    resolveSentFolder.mockRejectedValueOnce(new Error('database unavailable'));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sentCopySaved: false });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(redisClient.set).toHaveBeenLastCalledWith('send_idem:u1:send1', JSON.stringify({ ok: true, sentCopySaved: false }), { EX: 86400 });
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('releases its own reservation after an SMTP rejection', async () => {
    // nodemailer puts the server's reply code on the error; a reply means DATA was not accepted.
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Message failed: 550 rejected'), { code: 'EMESSAGE', responseCode: 550, command: 'DATA' }));
    expect((await post()).status).toBe(500);
    expect(redisClient.del).toHaveBeenCalledWith('send_idem:u1:send1');
  });
  it('releases its own reservation when the server could not be reached, with a specific host:port error', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ESOCKET', command: 'CONN' }));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Could not connect to smtp.gmail.com:465 (connection refused). The server's network may block outgoing mail ports.",
      code: 'smtp_connection_failed', reason: 'refused', host: 'smtp.gmail.com', port: 465,
    });
    expect(redisClient.del).toHaveBeenCalledWith('send_idem:u1:send1');
  });
  it('releases its own reservation when connecting times out, with a specific host:port error', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' }));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Could not connect to smtp.gmail.com:465 (timed out). The server's network may block outgoing mail ports.",
      code: 'smtp_connection_failed', reason: 'timeout', host: 'smtp.gmail.com', port: 465,
    });
    expect(redisClient.del).toHaveBeenCalledWith('send_idem:u1:send1');
  });
  it('reports a DNS lookup failure the same way', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.gmail.com'), { code: 'EDNS', command: 'CONN' }));
    const res = await post();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({
      error: "Could not connect to smtp.gmail.com:465 (host not found). The server's network may block outgoing mail ports.",
      code: 'smtp_connection_failed', reason: 'not_found', host: 'smtp.gmail.com', port: 465,
    });
  });
  it('reports a TLS handshake failure the same way', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Error initiating TLS - self signed certificate'), { code: 'ETLS', command: 'CONN' }));
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBe('tls');
  });
  it('keeps auth rejections on their existing generic message', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Invalid login: 535 5.7.8 authentication failed'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }));
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Authentication failed. Check your email account credentials.' });
  });
  it('keeps the reservation when the connection breaks with no server reply', async () => {
    // nodemailer tags a mid-session close as CONN too, so it may come after DATA was accepted.
    // Releasing the lock would let the retry deliver the message a second time.
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' }));
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('send_uncertain');
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('blocks a concurrent submission', async () => {
    redisClient.set.mockResolvedValueOnce(null);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This message is already being sent.', code: 'send_in_progress' });
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('reports a submission whose key is already in flight with the stable code', async () => {
    redisClient.get.mockResolvedValueOnce('__inflight__');
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This message is already being sent.', code: 'send_in_progress' });
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
describe('recipients', () => {
  it('sends a message addressed only in Bcc without an empty To header', async () => {
    const res = await post({ to: [], bcc: ['hidden@example.com'] });
    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledOnce();
    const options = sendMail.mock.calls[0][0];
    expect(options.to).toBeUndefined();
    expect(options.bcc).toContain('hidden@example.com');
  });
  it('rejects a message with no recipient in any field', async () => {
    const res = await post({ to: [], cc: [], bcc: [] });
    expect(res.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
describe('OAuth reconnect-required on send', () => {
  const reconnectResult = {
    status: 409,
    code: 'oauth_reconnect_required',
    error: 'Access to this account was revoked or has expired. Reconnect the account to send mail.',
  };
  it('returns the stable code before reserving or delivering', async () => {
    createAccountSmtpTransport.mockResolvedValueOnce(reconnectResult);
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('oauth_reconnect_required');
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.set).not.toHaveBeenCalled();
  });
  it('maps a forced refresh that needs reconnect during the send to the stable code and frees the reservation', async () => {
    const tokenErr = Object.assign(new Error('OAuth access was revoked or expired — reconnect the account'), { name: 'OAuthTokenError', code: 'oauth_reconnect_required' });
    sendMail.mockRejectedValueOnce(tokenErr);
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: expect.any(String), code: 'oauth_reconnect_required' });
    expect(redisClient.del).toHaveBeenCalledWith('send_idem:u1:send1');
  });
  it('maps a transient refresh failure during the send to a retryable status', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('OAuth token refresh failed: oauth_refresh_failed'), { name: 'OAuthTokenError', code: 'oauth_refresh_failed' }));
    const res = await post();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('oauth_refresh_failed');
    expect(redisClient.del).toHaveBeenCalledWith('send_idem:u1:send1');
  });
});
