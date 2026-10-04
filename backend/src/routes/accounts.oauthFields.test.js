import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  isAdminRequest: async () => true,
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../index.js', () => ({
  imapManager: {
    providerIdBackfillStates: vi.fn(async () => new Map()),
    threadRecomputeStates: vi.fn(async () => new Map()),
  },
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';

describe('GET /api/accounts OAuth fields', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); });

  it('selects oauth_provider and oauth_reconnect_required but never token columns', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', oauth_provider: 'google', oauth_reconnect_required: true, signature: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await fetch(`${base}/api/accounts`);
    expect(res.status).toBe(200);
    const [account] = await res.json();
    expect(account).toMatchObject({ oauth_provider: 'google', oauth_reconnect_required: true });

    const listSql = query.mock.calls[0][0];
    expect(listSql).toMatch(/\boauth_provider\b/);
    expect(listSql).toMatch(/\boauth_reconnect_required\b/);
    expect(listSql).not.toMatch(/oauth_access_token|oauth_refresh_token|auth_pass|\*/);
  });
});
