import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Same mock surface as admin.users.test.js so importing admin.js is side-effect free.
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({
  imapManager: { disconnectAccount: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', async (importOriginal) => ({ ...(await importOriginal()), createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({})),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));

import express from 'express';
import adminRoutes from './admin.js';
import { query } from '../services/db.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const row = (id, cursorAt) => ({
  id: String(id), occurred_at: new Date('2026-09-17T10:00:00.000Z'), cursor_at: cursorAt,
  actor_user_id: USER_ID, actor_email: 'user@example.com', account_id: ACCOUNT_ID, account_email: 'team@example.com',
  action: 'message.sent', details: { messageId: `<${id}@example.com>`, to: ['a@example.com'], cc: [], bcc: [] },
});

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: USER_ID }; next(); });
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { query.mockReset(); });

const get = async (qs = '') => {
  const res = await fetch(`${base}/api/admin/audit${qs}`);
  return { status: res.status, body: await res.json() };
};

describe('GET /api/admin/audit', () => {
  it('returns the newest 100 entries and a cursor when more remain', async () => {
    query.mockResolvedValue({ rows: Array.from({ length: 101 }, (_, i) => row(500 - i, `2026-09-17T10:00:00.${String(999999 - i).padStart(6, '0')}Z`)) });

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.entries).toHaveLength(100);
    expect(body.entries[0]).toEqual({
      id: '500', occurredAt: '2026-09-17T10:00:00.000Z', actorUserId: USER_ID, actorEmail: 'user@example.com',
      accountId: ACCOUNT_ID, accountEmail: 'team@example.com', action: 'message.sent',
      details: { messageId: '<500@example.com>', to: ['a@example.com'], cc: [], bcc: [] },
    });
    expect(body.nextCursor).toBe('2026-09-17T10:00:00.999900Z_401');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM mailbox_audit_log\s+ORDER BY occurred_at DESC, id DESC\s+LIMIT \$1/);
    expect(sql).toMatch(/to_char\(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS cursor_at/);
    expect(params).toEqual([101]);
  });

  it('returns no cursor on the last page', async () => {
    query.mockResolvedValue({ rows: [row(1, '2026-09-17T10:00:00.000001Z')] });
    expect((await get()).body.nextCursor).toBeNull();
  });

  it('applies every filter and the cursor', async () => {
    query.mockResolvedValue({ rows: [] });
    const qs = new URLSearchParams({
      account: ACCOUNT_ID, user: USER_ID, action: 'message.deleted',
      from: '2026-09-01T00:00:00Z', to: '2026-09-18T00:00:00Z', before: '2026-09-17T10:00:00.123456Z_42',
    });

    expect((await get(`?${qs}`)).status).toBe(200);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE account_id = \$1 AND actor_user_id = \$2 AND action = \$3 AND occurred_at >= \$4 AND occurred_at < \$5 AND \(occurred_at, id\) < \(\$6::timestamptz, \$7::bigint\)/);
    expect(params).toEqual([
      ACCOUNT_ID, USER_ID, 'message.deleted', '2026-09-01T00:00:00.000Z', '2026-09-18T00:00:00.000Z',
      '2026-09-17T10:00:00.123456Z', '42', 101,
    ]);
  });

  it.each([
    ['account', 'not-a-uuid'],
    ['user', 'nope'],
    ['action', 'message.read'],
    ['from', 'yesterday'],
    ['to', '2026-13-45'],
    ['before', '42'],
  ])('rejects an invalid %s filter', async (name, value) => {
    const { status, body } = await get(`?${new URLSearchParams({ [name]: value })}`);
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_filter');
    expect(query).not.toHaveBeenCalled();
  });
});
