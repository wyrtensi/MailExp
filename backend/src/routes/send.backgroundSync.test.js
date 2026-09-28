import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// The Sent folder syncs a panel runs after a send are background work: nobody waits for them, so
// they must not take the pooled session kept for user actions (imapManager backgroundPoolCap).
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    pluginFacade: {},
  },
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []) } }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';

// A password mailbox (the mail node): no server-side Sent copy, so the panel APPENDs it.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null };
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
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  redisClient.del.mockResolvedValue(1);
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue('Sent');
});
const post = key => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
  body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello' }),
});

describe('the Sent folder sync after a send', () => {
  it('runs as background work after the Sent copy is appended', async () => {
    imapManager.appendToSent.mockResolvedValue({ uid: null });
    expect((await post('bg1')).status).toBe(200);
    await vi.waitFor(() => expect(imapManager.syncFolderOnDemand).toHaveBeenCalled(), { timeout: 3000 });
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Sent', { background: true });
  });

  it('runs as background work after a failed append (the fallback 8 s later)', async () => {
    imapManager.appendToSent.mockRejectedValue(new Error('append refused'));
    expect((await post('bg2')).status).toBe(200);
    await vi.waitFor(() => expect(imapManager.syncFolderOnDemand).toHaveBeenCalled(), { timeout: 10000, interval: 200 });
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Sent', { background: true });
  }, 15000);

  it('runs as background work for a mailbox whose server saves the Sent copy', async () => {
    // 'microsoft' (non-Gmail OAuth) exercises serverAutoSaves without the Gmail-API send path.
    const oauth = { ...account, oauth_provider: 'microsoft' };
    query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [oauth] : [{ preferences: {}, id: 'book1' }] }));
    createAccountSmtpTransport.mockResolvedValue({ account: oauth, transport: { sendMail } });
    expect((await post('bg3')).status).toBe(200);
    await vi.waitFor(() => expect(imapManager.syncFolderOnDemand).toHaveBeenCalled(), { timeout: 5000, interval: 200 });
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(oauth, 'Sent', { background: true });
  }, 10000);
});
