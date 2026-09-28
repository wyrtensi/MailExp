import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// End-to-end through the REAL routes/send.js + REAL services/mailSendTransport.js + REAL
// services/gmailApiSender.js, with only `fetch` and the account-lookup/DB-adjacent layers mocked.
// send.gmailApiWiring.test.js already covers send.js's own logic against a mocked
// createAccountSendTransport; this instead proves the single Redis idempotency reservation in
// send.js really does cover the whole Gmail-API-then-SMTP-fallback sequence as ONE delivery, not
// just a delivery outcome that happens to be handed to it pre-decided.
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn(), oauthRefreshFailureResult: vi.fn() }));
vi.mock('../services/oauth/tokenManager.js', async () => {
  const actual = await vi.importActual('../services/oauth/tokenManager.js');
  return { ...actual, ensureFreshOAuthAccount: vi.fn(async (account) => account) };
});
vi.mock('../services/oauth/googleApps.js', () => ({ markGmailApiDisabled: vi.fn(), clearGmailApiDisabled: vi.fn() }));

import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { markGmailApiDisabled, clearGmailApiDisabled } from '../services/oauth/googleApps.js';

const account = {
  id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'google',
  oauth_app_id: 'app-1', oauth_access_token: 'plain-access-token', oauth_refresh_token: 'plain-refresh-token',
  smtp_host: 'smtp.gmail.com', smtp_port: 465,
};
// Captured before any test replaces global.fetch (with a mock standing in for the outbound call
// to Gmail's API) — the test's own calls into its local Express server must go through the real
// fetch, not the mock.
const realFetch = global.fetch;

let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

let fetchMock;
let smtpSendMail;
beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async sql => {
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    if (sql.includes('FROM users')) return { rows: [{ preferences: {} }] };
    return { rows: [] };
  });
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  redisClient.del.mockResolvedValue(1);
  resolveSentFolder.mockResolvedValue(null);
  markGmailApiDisabled.mockResolvedValue(undefined);
  clearGmailApiDisabled.mockResolvedValue(undefined);
  smtpSendMail = vi.fn().mockResolvedValue({});
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: smtpSendMail } });
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => { delete global.fetch; });

const send = (key) => realFetch(`${base}/api/mail/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
  body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello' }),
});

describe('one idempotency reservation covers a real Gmail-API-then-SMTP-fallback send', () => {
  it('tries the Gmail API once, falls back to SMTP under the same request, and a retry with the same key delivers nothing again', async () => {
    // The Gmail API call: Gmail says its API is off for this project (403 accessNotConfigured).
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 403,
      json: async () => ({ error: { message: 'Gmail API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }),
    });

    const first = await send('key-1');
    const body = await first.json();
    expect(first.status).toBe(200);
    expect(body).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1); // one Gmail API attempt, no fallback retry loop
    expect(smtpSendMail).toHaveBeenCalledTimes(1); // exactly one SMTP delivery
    expect(markGmailApiDisabled).toHaveBeenCalledWith('app-1');
    // One reservation set (in-flight) then overwritten with the final cached result — never
    // deleted, since the message was in fact delivered (over SMTP).
    expect(redisClient.set).toHaveBeenCalledTimes(2);
    expect(redisClient.del).not.toHaveBeenCalled();

    // A retry with the SAME idempotency key must not attempt delivery again at all — this
    // simulates the cached-result branch a real retry after a lost response would hit.
    const cachedResult = JSON.stringify(body);
    redisClient.get.mockResolvedValueOnce(cachedResult);
    const retry = await send('key-1');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still just the one Gmail API attempt
    expect(smtpSendMail).toHaveBeenCalledTimes(1); // still just the one SMTP delivery
  });
});
