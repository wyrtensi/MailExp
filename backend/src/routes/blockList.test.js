import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-2' }; next(); },
}));

import express from 'express';
import blockListRoutes from './blockList.js';
import { query } from '../services/db.js';

const MAILBOX = 'a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7';
const OTHER = 'b8b8b8b8-8888-4888-8888-b8b8b8b8b8b8';

// Every user sees and edits the block list; each entry blocks a sender for one mailbox.
describe('block list per mailbox', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/block-list', blockListRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset().mockImplementation(async (sql, params = []) => {
      if (sql === 'SELECT id FROM email_accounts WHERE id = $1') return { rows: params[0] === MAILBOX ? [{ id: MAILBOX }] : [] };
      if (sql.includes('INSERT INTO block_list')) return { rows: [{ id: '33333333-3333-4333-8333-333333333333', account_id: params[0], email_address: params[1] }] };
      return { rows: [] };
    });
  });

  const send = (method, path, body) => fetch(`${base}/api/block-list${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('lists the entries of every mailbox', async () => {
    expect((await send('GET', '')).status).toBe(200);
    expect(query).toHaveBeenCalledWith('SELECT * FROM block_list ORDER BY created_at DESC');
  });

  it('requires an existing mailbox', async () => {
    expect(await send('POST', '', { emailAddress: 'spam@example.com' })).toMatchObject({ status: 400, body: { code: 'account_required' } });
    expect((await send('POST', '', { accountId: OTHER, emailAddress: 'spam@example.com' })).status).toBe(404);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('blocks a sender for one mailbox', async () => {
    const res = await send('POST', '', { accountId: MAILBOX, emailAddress: ' Spam@Example.com ' });
    expect(res).toMatchObject({ status: 201, body: { account_id: MAILBOX, email_address: 'spam@example.com' } });
    const [sql] = query.mock.calls.find(([s]) => s.includes('INSERT INTO block_list'));
    expect(sql).toMatch(/ON CONFLICT \(account_id, email_address\) DO NOTHING/);
  });

  it('removes an entry whoever added it', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: '33333333-3333-4333-8333-333333333333' }] });
    expect((await send('DELETE', '/33333333-3333-4333-8333-333333333333')).status).toBe(200);
    expect(query).toHaveBeenCalledWith('DELETE FROM block_list WHERE id = $1 RETURNING id', ['33333333-3333-4333-8333-333333333333']);
  });
});
