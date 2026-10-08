import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-2' }; next(); },
}));
vi.mock('../services/inboxRules.js', () => ({ applyInboxRules: vi.fn(), isDangerousRegex: () => false }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import express from 'express';
import rulesRoutes from './rules.js';
import { query } from '../services/db.js';

const MAILBOX = 'f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6';
const RULE = {
  name: 'Move invoices',
  conditions: [{ field: 'from', operator: 'contains', value: 'billing@' }],
  actions: [{ type: 'move', value: 'Invoices' }],
};

// Rules are shared by every user and each one applies to exactly one mailbox.
describe('rules belong to one mailbox', () => {
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
    query.mockReset().mockImplementation(async (sql) => {
      if (sql === 'SELECT id FROM email_accounts WHERE id = $1') return { rows: [{ id: MAILBOX }] };
      if (sql.includes('FROM folders')) return { rows: [{ total: '2', match: '1' }] };
      if (sql.includes('COUNT(*) AS cnt FROM inbox_rules')) return { rows: [{ cnt: '3' }] };
      if (sql.includes('INSERT INTO inbox_rules') || sql.includes('UPDATE inbox_rules')) return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      if (sql.startsWith('SELECT id, account_id, name, actions FROM inbox_rules')) return { rows: [{ id: '11111111-1111-4111-8111-111111111111', account_id: MAILBOX, name: 'x', actions: [] }] };
      return { rows: [] };
    });
  });

  const send = (method, path, body) => fetch(`${base}/api/rules${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('lists the rules of every mailbox', async () => {
    expect((await send('GET', '/')).status).toBe(200);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/FROM inbox_rules r LEFT JOIN users u ON u\.id = r\.created_by\s+ORDER BY r\.priority ASC, r\.created_at ASC/);
    expect(sql).not.toMatch(/WHERE/);
  });

  it('requires a mailbox to create or change a rule', async () => {
    expect(await send('POST', '/', RULE)).toMatchObject({ status: 400, body: { code: 'account_required' } });
    expect(await send('PUT', '/11111111-1111-4111-8111-111111111111', RULE)).toMatchObject({ status: 400, body: { code: 'account_required' } });
    expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql))).toBe(false);
  });

  it('answers 404 for a mailbox that does not exist', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    expect((await send('POST', '/', { ...RULE, accountId: MAILBOX })).status).toBe(404);
  });

  it('stores the mailbox, the author and the move action', async () => {
    expect((await send('POST', '/', { ...RULE, accountId: MAILBOX })).status).toBe(201);
    const [sql, params] = query.mock.calls.find(([s]) => s.includes('INSERT INTO inbox_rules'));
    expect(sql).toMatch(/\(created_by, account_id, name/);
    expect(params.slice(0, 3)).toEqual(['user-2', MAILBOX, 'Move invoices']);
    expect(JSON.parse(params[8])).toEqual([{ type: 'move', value: 'Invoices' }]);
  });

  it('changes and deletes a rule whoever created it', async () => {
    expect((await send('PUT', '/11111111-1111-4111-8111-111111111111', { ...RULE, accountId: MAILBOX })).status).toBe(200);
    const [updateSql, updateParams] = query.mock.calls.find(([s]) => s.includes('UPDATE inbox_rules'));
    expect(updateSql).toMatch(/WHERE id = \$8\s+RETURNING \*/);
    expect(updateParams).toHaveLength(8);
    query.mockResolvedValueOnce({ rows: [{ id: '11111111-1111-4111-8111-111111111111' }] });
    expect((await send('DELETE', '/11111111-1111-4111-8111-111111111111')).status).toBe(200);
    expect(query).toHaveBeenLastCalledWith('DELETE FROM inbox_rules WHERE id = $1 RETURNING id, account_id, name, actions', ['11111111-1111-4111-8111-111111111111']);
  });
});
