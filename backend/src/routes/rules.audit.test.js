import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-3' }; next(); },
}));
vi.mock('../services/inboxRules.js', () => ({ applyInboxRules: vi.fn(), isDangerousRegex: () => false }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import express from 'express';
import rulesRoutes from './rules.js';
import { query } from '../services/db.js';
import { recordAudit } from '../services/auditLog.js';

const MAILBOX = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const OTHER = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const FORWARD_RULE = {
  name: 'Copy invoices',
  accountId: MAILBOX,
  conditions: [{ field: 'from', operator: 'contains', value: 'billing@' }],
  actions: [{ type: 'mark_read' }, { type: 'forward', value: ' books@example.net ' }],
};

// Anyone may make a forwarding rule; the rule is visible to everyone and every change is journaled.
describe('inbox rules are visible and journaled', () => {
  let stored;
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/rules', rulesRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    vi.clearAllMocks();
    stored = { id: '11111111-1111-4111-8111-111111111111', account_id: MAILBOX, name: 'Copy invoices', actions: [{ type: 'forward', value: 'old@example.org' }] };
    query.mockReset().mockImplementation(async (sql, params) => {
      if (sql === 'SELECT id FROM email_accounts WHERE id = $1') return { rows: [{ id: params[0] }] };
      if (sql.includes('FROM folders')) return { rows: [{ total: '0', match: '0' }] };
      if (sql.includes('COUNT(*) AS cnt FROM inbox_rules')) return { rows: [{ cnt: '0' }] };
      if (sql.startsWith('SELECT id, account_id, name, actions FROM inbox_rules')) return { rows: stored ? [stored] : [] };
      if (sql.includes('INSERT INTO inbox_rules') || sql.includes('UPDATE inbox_rules')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111', created_by: 'user-3', created_by_name: 'author@example.com' }] };
      }
      if (sql.startsWith('DELETE FROM inbox_rules')) return { rows: stored ? [stored] : [] };
      if (sql.startsWith('SELECT id, account_id FROM inbox_rules WHERE enabled = true')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111', account_id: MAILBOX }, { id: 'rule-2', account_id: MAILBOX }, { id: 'rule-3', account_id: OTHER }] };
      }
      if (sql === 'SELECT id FROM email_accounts') return { rows: [{ id: MAILBOX }, { id: OTHER }] };
      if (sql.includes('FROM inbox_rules r LEFT JOIN users')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111', created_by: 'user-1', created_by_name: 'someone@example.com', actions: stored.actions }] };
      }
      return { rows: [] };
    });
  });

  const send = (method, path, body) => fetch(`${base}/api/rules${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('lists every rule with its author and forward target, whoever asks', async () => {
    const res = await send('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ created_by_name: 'someone@example.com', actions: [{ type: 'forward', value: 'old@example.org' }] });
    expect(query.mock.calls[0][0]).toMatch(/COALESCE\(NULLIF\(u\.email, ''\), u\.username\) AS created_by_name/);
  });

  it('answers a new or changed rule with its author', async () => {
    const created = await send('POST', '/', FORWARD_RULE);
    expect(created.body.created_by_name).toBe('author@example.com');
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO inbox_rules'))[0];
    expect(insert).toMatch(/^WITH r AS \(INSERT INTO inbox_rules[\s\S]*LEFT JOIN users u ON u\.id = r\.created_by$/);
  });

  it('journals a new rule with its forward target', async () => {
    expect((await send('POST', '/', FORWARD_RULE)).status).toBe(201);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-3', accountId: MAILBOX, action: 'rule.created',
      details: { ruleId: '11111111-1111-4111-8111-111111111111', name: 'Copy invoices', actions: ['mark_read', 'forward'], forwardTo: 'books@example.net' },
    });
  });

  it('journals a rule without a forward action too', async () => {
    await send('POST', '/', { ...FORWARD_RULE, actions: [{ type: 'star' }] });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'rule.created', details: expect.objectContaining({ actions: ['star'], forwardTo: null }),
    }));
  });

  it('journals a change with the forward target before and after', async () => {
    expect((await send('PUT', '/11111111-1111-4111-8111-111111111111', { ...FORWARD_RULE, accountId: OTHER, enabled: false })).status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-3', accountId: OTHER, action: 'rule.updated',
      details: {
        ruleId: '11111111-1111-4111-8111-111111111111', name: 'Copy invoices', actions: ['mark_read', 'forward'], forwardTo: 'books@example.net',
        enabled: false, previousForwardTo: 'old@example.org', previousAccountId: MAILBOX,
      },
    });
  });

  it('answers 404 and journals nothing for a rule that does not exist', async () => {
    stored = null;
    expect((await send('PUT', '/11111111-1111-4111-8111-111111111111', FORWARD_RULE)).status).toBe(404);
    expect((await send('DELETE', '/11111111-1111-4111-8111-111111111111')).status).toBe(404);
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE inbox_rules'))).toBe(false);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('journals a deleted rule with what it forwarded to', async () => {
    expect((await send('DELETE', '/11111111-1111-4111-8111-111111111111')).status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-3', accountId: MAILBOX, action: 'rule.deleted',
      details: { ruleId: '11111111-1111-4111-8111-111111111111', name: 'Copy invoices', actions: ['forward'], forwardTo: 'old@example.org' },
    });
  });

  it('journals a hand-started run per mailbox with the rules it runs', async () => {
    expect((await send('POST', '/run', { accountId: MAILBOX })).status).toBe(202);
    await vi.waitFor(() => expect(recordAudit).toHaveBeenCalled());
    const [entries] = recordAudit.mock.calls.find(([arg]) => Array.isArray(arg));
    expect(query.mock.calls.find(([sql]) => sql.startsWith('SELECT id, account_id FROM inbox_rules'))[1]).toEqual([[MAILBOX]]);
    expect(entries).toContainEqual({ actorUserId: 'user-3', accountId: MAILBOX, action: 'rule.run', details: { ruleIds: ['11111111-1111-4111-8111-111111111111', 'rule-2'], allMailboxes: false } });
  });

  it('marks a run over every mailbox', async () => {
    expect((await send('POST', '/run', {})).status).toBe(202);
    await vi.waitFor(() => expect(recordAudit).toHaveBeenCalled());
    const [entries] = recordAudit.mock.calls.find(([arg]) => Array.isArray(arg));
    expect(entries.map((e) => e.accountId).sort()).toEqual([MAILBOX, OTHER].sort());
    expect(entries.every((e) => e.details.allMailboxes === true)).toBe(true);
  });
});
