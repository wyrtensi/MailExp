import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A malformed id in the path used to reach a uuid-typed SQL comparison, whose cast error surfaced
// as a 500. Each router guards its uuid params (utils/uuid.js uuidParam): a 400 with a stable code,
// and no query runs.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { ...(req.session || {}), userId: 'user-1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../services/addressBooks.js', () => ({ defaultAddressBookId: vi.fn(async () => 'shared-book') }));
vi.mock('../services/categorizer.js', () => ({
  invalidateSocialDomainCache: vi.fn(), backfillCategories: vi.fn(async () => 0), aiClassifyMessage: vi.fn(),
  BUILTIN_SETS: {}, getGlobalCategorizationEnabled: vi.fn(async () => true),
}));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, encrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));

import express from 'express';
import { query } from '../services/db.js';
import blockListRoutes from './blockList.js';
import rulesRoutes from './rules.js';
import contactRoutes from './contacts.js';
import categoriesRoutes from './categories.js';
import oidcApiRouter from './oidc.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: 'user-1' }; next(); });
  app.use('/api/block-list', blockListRoutes);
  app.use('/api/rules', rulesRoutes);
  app.use('/api/contacts', contactRoutes);
  app.use('/api/auth/oidc', oidcApiRouter);
  app.use('/api', categoriesRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [] }); });

const send = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

describe('malformed ids in the path', () => {
  it.each([
    ['DELETE', '/api/block-list/entry-1'],
    ['PUT', '/api/rules/rule-1', { accountId: 'a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7', conditions: [], actions: [] }],
    ['DELETE', '/api/rules/rule-1'],
    ['GET', '/api/contacts/c1'],
    ['GET', '/api/contacts/c1/letters'],
    ['PATCH', '/api/contacts/c1', { displayName: 'Dana' }],
    ['DELETE', '/api/contacts/c1'],
    ['PATCH', '/api/categories/sources/nope', { enabled: true }],
    ['DELETE', '/api/categories/sources/nope'],
    ['POST', '/api/categories/sources/nope/refresh'],
    ['POST', '/api/categories/recategorize/nope'],
    ['DELETE', '/api/auth/oidc/identities/nope'],
  ])('%s %s answers 400 invalid_id without a query', async (method, path, body) => {
    const res = await send(method, path, body);
    expect(res).toMatchObject({ status: 400, body: { code: 'invalid_id' } });
    expect(typeof res.body.error).toBe('string');
    expect(query).not.toHaveBeenCalled();
  });

  it('a reorder with a malformed id answers 400 invalid_id', async () => {
    const res = await send('PATCH', '/api/rules/reorder', { ids: ['a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7', 'x'] });
    expect(res).toMatchObject({ status: 400, body: { code: 'invalid_id' } });
    expect(query).not.toHaveBeenCalled();
  });
});
