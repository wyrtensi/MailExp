import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The id check of a route guarded per route (requireAdmin, requireAuth) runs after the guard, as it
// does on routers guarded as a whole: an anonymous caller gets 401 and a non-administrator 403
// before anyone is told their id is malformed.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({
  invalidateSocialDomainCache: vi.fn(), backfillCategories: vi.fn(async () => 0), aiClassifyMessage: vi.fn(),
  BUILTIN_SETS: {}, getGlobalCategorizationEnabled: vi.fn(async () => true),
}));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));

import express from 'express';
import { query } from '../services/db.js';
import categoriesRoutes from './categories.js';
import oidcApiRouter from './oidc.js';

let server;
let base;
let isAdmin = false;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = req.get('x-user') ? { userId: req.get('x-user'), destroy: (cb) => cb?.() } : {};
    next();
  });
  app.use('/api/auth/oidc', oidcApiRouter);
  app.use('/api', categoriesRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  isAdmin = false;
  query.mockReset().mockImplementation(async (sql) => {
    if (/SELECT is_admin, disabled_at FROM users/.test(sql)) return { rows: [{ is_admin: isAdmin, disabled_at: null }] };
    if (/SELECT id, disabled_at FROM users/.test(sql)) return { rows: [{ id: 'u', disabled_at: null }] };
    return { rows: [] };
  });
});

const call = (method, path, { user = null, body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

const ADMIN_ROUTES = [
  ['PATCH', '/api/categories/sources/nope', { enabled: true }],
  ['DELETE', '/api/categories/sources/nope'],
  ['POST', '/api/categories/sources/nope/refresh'],
  ['POST', '/api/categories/recategorize/nope'],
];

describe('categories: the admin check comes before the id check', () => {
  it.each(ADMIN_ROUTES)('%s %s: anonymous 401, non-admin 403, admin 400 invalid_id', async (method, path, body) => {
    expect((await call(method, path, { body })).status).toBe(401);
    expect((await call(method, path, { user: 'u', body })).status).toBe(403);
    isAdmin = true;
    expect(await call(method, path, { user: 'u', body })).toMatchObject({ status: 400, body: { code: 'invalid_id' } });
  });
});

describe('oidc identities: the sign-in check comes before the id check', () => {
  it('anonymous 401, signed in 400 invalid_id', async () => {
    expect((await call('DELETE', '/api/auth/oidc/identities/nope')).status).toBe(401);
    expect(await call('DELETE', '/api/auth/oidc/identities/nope', { user: 'u' })).toMatchObject({ status: 400, body: { code: 'invalid_id' } });
  });
});
