import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/sendQueue.js', async (importOriginal) => ({
  ...(await importOriginal()),
  enqueueOutgoingSend: vi.fn(),
  existingSendJob: vi.fn(async () => null),
}));
import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { enqueueOutgoingSend } from '../services/sendQueue.js';

// D-16: a mail node mailbox sends only from its own address. An alias with another address left
// from before (an admin turns it into a separate mailbox or deletes it) is refused here, before the
// letter is queued, rather than by the node's SMTP after the undo window.
const ALIAS_ID = '33333333-3333-4333-8333-333333333333';
let account;
let alias;
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
  account = { id: 'a1', email_address: 'me@example.com', name: 'Me', signature: null, mail_node: true };
  alias = { id: ALIAS_ID, account_id: 'a1', name: 'Other', email: 'other@example.com', reply_to: null, signature: null };
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    if (sql.includes('FROM account_aliases')) return { rows: [alias] };
    return { rows: [{ preferences: {} }] };
  });
  enqueueOutgoingSend.mockResolvedValue({ job: { id: '1', status: 'queued', run_at: new Date(), payload: {} }, created: true });
});
const post = () => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'node-alias' },
  body: JSON.stringify({ accountId: 'a1', aliasId: ALIAS_ID, to: ['you@example.com'], subject: 'Hi', body: 'Hello' }),
});

describe('sending from an alias of a mail node mailbox', () => {
  it('refuses an alias with another address before queueing', async () => {
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('node_alias_stale');
    expect(enqueueOutgoingSend).not.toHaveBeenCalled();
  });

  it('sends under a second name with the mailbox address', async () => {
    alias.email = 'ME@example.com';
    expect((await post()).status).toBe(200);
    const from = enqueueOutgoingSend.mock.calls[0][0].mail.options.from;
    expect(from).toBe('Other <ME@example.com>');
  });

  it('keeps an alias with another address for a mailbox that is not on the mail node', async () => {
    account.mail_node = false;
    expect((await post()).status).toBe(200);
    expect(enqueueOutgoingSend).toHaveBeenCalledTimes(1);
  });
});
