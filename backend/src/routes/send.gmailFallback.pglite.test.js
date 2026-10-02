// One send job is one delivery, through the REAL routes/send.js, job queue, services/sendDelivery.js,
// services/mailSendTransport.js and services/gmailApiSender.js against PGlite with the real
// migrations: a double submit enqueues one job, and its run tries the Gmail API once, falls back to
// SMTP once, and is done. Running the queue again delivers nothing. Only `fetch` (Gmail's API), the
// SMTP transport and the OAuth token layer are mocked. Replaces send.gmailApiIdempotency.test.js.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../services/testing/realSchema.js';

const dbState = { db: null };
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: req.get('x-test-user') }; next(); } }));
const imapManager = vi.hoisted(() => ({ broadcast: () => {}, syncFolderOnDemand: async () => {}, findUidByMessageId: async () => null }));
vi.mock('../index.js', () => ({ imapManager }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => null) }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn(), oauthRefreshFailureResult: vi.fn() }));
vi.mock('../services/oauth/tokenManager.js', async () => {
  const actual = await vi.importActual('../services/oauth/tokenManager.js');
  return { ...actual, ensureFreshOAuthAccount: vi.fn(async (account) => account) };
});
vi.mock('../services/oauth/googleApps.js', () => ({ markGmailApiDisabled: vi.fn(async () => {}), clearGmailApiDisabled: vi.fn(async () => {}) }));

const express = (await import('express')).default;
const sendRoutes = (await import('./send.js')).default;
const { createAccountSmtpTransport } = await import('../services/smtpTransport.js');
const { registerSendJobKind } = await import('../services/sendQueue.js');
const { runDueJobs } = await import('../services/jobQueue.js');

const ACCOUNT = '40000000-0000-4000-8000-000000000011';
const USER = '42000000-0000-4000-8000-000000000011';
const realFetch = global.fetch;
let db;
let server;
let base;
let fetchMock;
let smtpSendMail;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  const app = express();
  app.use(express.json());
  app.use('/api/mail', sendRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
});

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  registerSendJobKind({ imapManager });
  await db.exec('DELETE FROM outgoing_messages; DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query("INSERT INTO users (id, username) VALUES ($1, 'anna')", [USER]);
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, oauth_provider, oauth_access_token, oauth_refresh_token, smtp_host, smtp_port)
     VALUES ($1, 'Gmail', 'me@example.com', 'google', 'plain-access-token', 'plain-refresh-token', 'smtp.gmail.com', 465)`,
    [ACCOUNT]
  );
  const account = (await db.query('SELECT * FROM email_accounts WHERE id = $1', [ACCOUNT])).rows[0];
  smtpSendMail = vi.fn().mockResolvedValue({});
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: smtpSendMail } });
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => { global.fetch = realFetch; });

const send = () => realFetch(`${base}/api/mail/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-test-user': USER, 'X-Idempotency-Key': 'key-1' },
  body: JSON.stringify({ accountId: ACCOUNT, to: ['you@example.com'], subject: 'Test', body: 'Hello' }),
});

describe('one send job covers a real Gmail-API-then-SMTP-fallback delivery', () => {
  it('enqueues once for a repeated key, and its run tries the API once, falls back to SMTP once, and is done', async () => {
    // Gmail says its API is off for this project (403 accessNotConfigured): a definite refusal.
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 403,
      json: async () => ({ error: { message: 'Gmail API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }),
    });
    const first = await (await send()).json();
    const second = await (await send()).json();
    expect(second.jobId).toBe(first.jobId);

    await db.query("UPDATE jobs SET run_at = now() - interval '1 second'");
    await runDueJobs({ wait: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(smtpSendMail).toHaveBeenCalledTimes(1);
    expect((await db.query('SELECT status FROM jobs WHERE id = $1', [first.jobId])).rows[0].status).toBe('done');

    await runDueJobs({ wait: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(smtpSendMail).toHaveBeenCalledTimes(1);
  });
});
