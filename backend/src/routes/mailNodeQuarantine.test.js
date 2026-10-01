import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The quarantine and "why is this letter in Spam" routes (R-20): who sees what, the journal of
// releases and deletions, the setting, and the verdict lookup.

const session = vi.hoisted(() => ({ isAdmin: true }));
const db = vi.hoisted(() => ({ message: null, aliases: [] }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql) => {
    if (sql.includes('is_admin')) return { rows: [{ is_admin: session.isAdmin }] };
    if (sql.includes('FROM messages m JOIN email_accounts')) return { rows: db.message ? [db.message] : [] };
    if (sql.includes('FROM account_aliases')) return { rows: db.aliases };
    return { rows: [] };
  }),
}));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
  requireAdmin: (_req, res, next) => (session.isAdmin ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
const node = vi.hoisted(() => ({ cfg: null, list: [], item: null }));
vi.mock('../services/mailNode/mailcow.js', async (importActual) => ({
  ...(await importActual()),
  getMailNodeConfig: vi.fn(async () => node.cfg),
  listQuarantine: vi.fn(async () => node.list),
  getQuarantineItem: vi.fn(async () => node.item),
  releaseQuarantineItem: vi.fn(async () => ({ learned: true, warnings: [] })),
  deleteQuarantineItem: vi.fn(async () => {}),
}));
const panel = vi.hoisted(() => ({ userView: false, mailboxes: new Map(), history: [] }));
vi.mock('../services/mailNode/quarantine.js', async (importActual) => ({
  ...(await importActual()),
  getQuarantineUserView: vi.fn(async () => panel.userView),
  setQuarantineUserView: vi.fn(async () => {}),
  panelNodeMailboxes: vi.fn(async () => panel.mailboxes),
  readRspamdHistory: vi.fn(async () => panel.history),
}));

import express from 'express';
import routes from './mailNodeQuarantine.js';
import { recordAudit } from '../services/auditLog.js';
import { MailNodeError, deleteQuarantineItem, releaseQuarantineItem } from '../services/mailNode/mailcow.js';
import { readRspamdHistory, setQuarantineUserView } from '../services/mailNode/quarantine.js';

const CFG = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120 };
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const entry = (id, rcpt, extra = {}) => ({
  id, qid: `Q${id}`, subject: `S${id}`, score: 9, sender: 'spam@bad.test', rcpt, action: 'add header',
  created: '2026-10-01T10:00:02.000Z', notified: false, virus: false, ...extra,
});
const historyRow = (fields) => ({
  messageId: null, time: '2026-10-01T10:00:00.000Z', score: 9, requiredScore: 15, spamScore: 8, rejectScore: 15, action: 'add header', skipped: false,
  symbols: [{ name: 'R_SPF_FAIL', score: 8, options: [], description: 'SPF fail' }, { name: 'MIME_GOOD', score: -0.1, options: [], description: null }, { name: 'ARC_NA', score: 0, options: [], description: null }],
  ip: '198.51.100.7', senderSmtp: '', senderMime: '', rcptSmtp: ['info@example.com'], rcptMime: [], subject: 'S1', ...fields,
});

describe('/api/mail-node quarantine', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail-node', routes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    vi.clearAllMocks();
    session.isAdmin = true;
    node.cfg = CFG;
    node.list = [entry(1, 'info@example.com'), entry(2, 'manual@example.com')];
    node.item = null;
    panel.userView = false;
    panel.mailboxes = new Map([['info@example.com', ACCOUNT]]);
    panel.history = [historyRow({})];
    db.message = null;
    db.aliases = [];
  });

  const call = (method, path, body) => fetch(`${base}/api/mail-node${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });

  it('lists every entry to an administrator, with the account and the heaviest symbols where found', async () => {
    const body = await (await call('GET', '/quarantine')).json();
    expect(body).toMatchObject({ admin: true, total: 2, truncated: false, historyRead: true });
    expect(body.items.map((i) => [i.id, i.accountId, i.topSymbols])).toEqual([
      [1, ACCOUNT, [{ name: 'R_SPF_FAIL', score: 8 }]],
      [2, null, null],
    ]);
  });

  it('keeps the list when the history cannot be read', async () => {
    readRspamdHistory.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'x'));
    const body = await (await call('GET', '/quarantine')).json();
    expect(body).toMatchObject({ total: 2, historyRead: false });
    expect(body.items[0].topSymbols).toBeNull();
  });

  it('shows users nothing without the setting, and only the panel mailboxes with it', async () => {
    session.isAdmin = false;
    const refused = await call('GET', '/quarantine');
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('quarantine_admin_only');
    expect((await call('GET', '/quarantine/1')).status).toBe(403);
    panel.userView = true;
    const body = await (await call('GET', '/quarantine')).json();
    expect(body).toMatchObject({ admin: false, total: 1 });
    expect(body.items.map((i) => i.id)).toEqual([1]);
  });

  it('shows one entry with its letter parsed, never the stored letter itself', async () => {
    node.item = { ...entry(1, 'info@example.com'), ip: '198.51.100.7', symbols: [], user: null, msg: 'Subject: Hi\r\nContent-Type: text/html\r\n\r\n<img src="https://t.test/x"><p>Hi</p>' };
    const body = await (await call('GET', '/quarantine/1')).json();
    expect(body).toMatchObject({ id: 1, accountId: ACCOUNT, admin: true, ip: '198.51.100.7', letter: { subject: 'Hi', html: '<img src="https://t.test/x"><p>Hi</p>' } });
    expect(body.msg).toBeUndefined();
  });

  it('hides from a user an entry of a mailbox the panel does not have', async () => {
    session.isAdmin = false;
    panel.userView = true;
    node.item = { ...entry(2, 'manual@example.com'), ip: null, symbols: [], user: null, msg: '' };
    expect((await call('GET', '/quarantine/2')).status).toBe(404);
    session.isAdmin = true;
    expect((await call('GET', '/quarantine/2')).status).toBe(200);
  });

  it('refuses an id that is not a number and a missing entry', async () => {
    for (const bad of ['abc', '0', '1e3', '12345678901']) {
      const res = await call('GET', `/quarantine/${bad}`);
      expect(res.status).toBe(400);
    }
    expect((await call('GET', '/quarantine/9')).status).toBe(404);
  });

  it('releases as an administrator and journals it on the mailbox', async () => {
    const res = await call('POST', '/quarantine/1/release');
    expect(await res.json()).toEqual({ ok: true, learned: true, warnings: [] });
    expect(releaseQuarantineItem).toHaveBeenCalledWith(CFG, 1);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.quarantine_released', accountId: ACCOUNT,
      details: { id: 1, qid: 'Q1', rcpt: 'info@example.com', sender: 'spam@bad.test', score: 9, action: 'add header', learned: true },
    });
  });

  it('deletes as an administrator, journaling a mailbox the panel lacks by address', async () => {
    expect((await call('DELETE', '/quarantine/2')).status).toBe(200);
    expect(deleteQuarantineItem).toHaveBeenCalledWith(CFG, 2);
    expect(recordAudit.mock.calls[0][0]).toMatchObject({ action: 'mail_node.quarantine_deleted', accountEmail: 'manual@example.com' });
  });

  it('answers 404 for an entry gone from the node and keeps a node refusal', async () => {
    expect((await call('POST', '/quarantine/9/release')).status).toBe(404);
    expect((await call('DELETE', '/quarantine/9')).status).toBe(404);
    expect(releaseQuarantineItem).not.toHaveBeenCalled();
    releaseQuarantineItem.mockRejectedValueOnce(new MailNodeError('mail_node_refused', 'The mail node refused: Cannot connect to Postfix'));
    const res = await call('POST', '/quarantine/1/release');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'The mail node refused: Cannot connect to Postfix', code: 'mail_node_refused' });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('keeps releasing and deleting with administrators, even with the setting on', async () => {
    session.isAdmin = false;
    panel.userView = true;
    expect((await call('POST', '/quarantine/1/release')).status).toBe(403);
    expect((await call('DELETE', '/quarantine/1')).status).toBe(403);
    expect((await call('PUT', '/quarantine/settings', { userView: false })).status).toBe(403);
  });

  it('saves the setting and journals a change only', async () => {
    expect(await (await call('GET', '/quarantine/settings')).json()).toEqual({ userView: false });
    expect((await call('PUT', '/quarantine/settings', { userView: 'yes' })).status).toBe(400);
    expect(await (await call('PUT', '/quarantine/settings', { userView: true })).json()).toEqual({ ok: true, userView: true });
    expect(setQuarantineUserView).toHaveBeenCalledWith(true);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.config_changed', details: { settings: 'quarantine', fields: ['userView'] },
    });
    panel.userView = true;
    vi.clearAllMocks();
    await call('PUT', '/quarantine/settings', { userView: true });
    expect(setQuarantineUserView).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('refuses when the node is not set up', async () => {
    node.cfg = null;
    expect((await call('GET', '/quarantine')).status).toBe(409);
  });

  describe('why is this letter in Spam', () => {
    const letter = (fields = {}) => ({
      message_id: '<abc@sender.test>', date: new Date('2026-10-01T10:00:00Z'), subject: 'S1', eop_category: 'SPM',
      account_id: ACCOUNT, email_address: 'Info@Example.com', imap_host: 'mail.example.com', mail_node: true, ...fields,
    });

    it('answers rspamd verdict by Message-ID for any signed-in user, nonzero symbols only', async () => {
      session.isAdmin = false;
      db.message = letter();
      panel.history = [historyRow({ messageId: 'abc@sender.test' })];
      const body = await (await call('GET', `/messages/${MESSAGE}/spam-verdict`)).json();
      expect(body).toEqual({
        eopCategory: 'SPM', historyRows: 1, historyDepth: 1000,
        rspamd: {
          matchedBy: 'message_id', time: '2026-10-01T10:00:00.000Z', score: 9, spamScore: 8, rejectScore: 15, action: 'add header', skipped: false,
          symbols: [{ name: 'R_SPF_FAIL', score: 8, description: 'SPF fail' }, { name: 'MIME_GOOD', score: -0.1, description: null }],
        },
      });
    });

    it('matches an alias of the mailbox and says when the history has no row', async () => {
      db.message = letter({ message_id: null });
      db.aliases = [{ email: 'sales@example.com' }];
      panel.history = [historyRow({ rcptSmtp: ['sales@example.com'], time: '2026-10-01T10:02:00.000Z' })];
      expect((await (await call('GET', `/messages/${MESSAGE}/spam-verdict`)).json()).rspamd.matchedBy).toBe('recipient_time');
      panel.history = [];
      expect(await (await call('GET', `/messages/${MESSAGE}/spam-verdict`)).json()).toEqual({
        eopCategory: 'SPM', historyRows: 0, historyDepth: 1000, rspamd: null,
      });
    });

    it('refuses a letter outside the node, on another host, or missing', async () => {
      expect((await call('GET', '/messages/not-a-uuid/spam-verdict')).status).toBe(400);
      expect((await call('GET', `/messages/${MESSAGE}/spam-verdict`)).status).toBe(404);
      db.message = letter({ mail_node: false });
      expect((await (await call('GET', `/messages/${MESSAGE}/spam-verdict`)).json()).code).toBe('message_not_mail_node');
      db.message = letter({ imap_host: 'old.example.com' });
      expect((await call('GET', `/messages/${MESSAGE}/spam-verdict`)).status).toBe(409);
      db.message = letter();
      readRspamdHistory.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ECONNREFUSED)'));
      expect((await call('GET', `/messages/${MESSAGE}/spam-verdict`)).status).toBe(502);
    });
  });
});
