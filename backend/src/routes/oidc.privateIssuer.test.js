import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// An OIDC issuer on the LAN, with a valid public certificate, was refused even with the admin's
// "Allow private / local hosts" policy on: the OIDC paths called validateHost without the policy,
// unlike every other validateHost caller (POST /system-email among them). The only way around it
// was allow_insecure, which also turns certificate checks off. These pin that the policy reaches
// the issuer check when a provider is created or updated, and every runtime discovery check.
//
// validateHost is modelled on the real one: a private host is refused unless the caller passes
// { allowPrivate: true }. A call that drops the options object is the bug.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {}, withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../index.js', () => ({
  imapManager: { applySyncSettings: vi.fn(async () => {}), disconnectAccount: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(async (_host, { allowPrivate = false } = {}) =>
    (allowPrivate ? null : 'Host cannot be a private or reserved IP address')),
  resolveForConnection: vi.fn(),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: true })),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));

import express from 'express';
import { query } from '../services/db.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { buildEndSessionUrl } from './oidc.js';
import adminRoutes from './admin.js';

const realFetch = global.fetch;
const issuer = 'https://auth.lan.example.org';
const discoveryDoc = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
  end_session_endpoint: `${issuer}/end-session`,
};

let server;
let base;
beforeAll(async () => {
  process.env.APP_URL = 'https://mail.example.com';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: '00000000-0000-0000-0000-00000000000a', username: 'admin@example.com' };
    next();
  });
  app.use('/api/admin', adminRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  global.fetch = realFetch;
  delete process.env.APP_URL;
});

// The admin requests go through the real fetch; discovery's fetch is stubbed per test.
function stubDiscovery() {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => discoveryDoc }));
}
beforeEach(() => {
  global.fetch = realFetch;
  query.mockReset();
  validateHost.mockClear();
  validateHost.mockImplementation(async (_host, { allowPrivate = false } = {}) =>
    (allowPrivate ? null : 'Host cannot be a private or reserved IP address'));
  getConnectionPolicy.mockReset();
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
});

const provider = { issuer_url: issuer, client_id: 'cid', allow_insecure: false, rp_initiated_logout: true };

describe('OIDC discovery honors the allow-private-hosts policy', () => {
  it('reaches a private issuer with the policy on, and passes it to every host check', async () => {
    stubDiscovery();
    query.mockResolvedValue({ rows: [provider] });

    // buildEndSessionUrl drives the real getDiscovery, where the runtime checks live.
    const url = await buildEndSessionUrl({ providerId: 'p1', idToken: 'tok' });

    expect(url).toMatch(/^https:\/\/auth\.lan\.example\.org\/end-session\?/);
    // The issuer host, then authorization, token and jwks endpoints.
    expect(validateHost.mock.calls.length).toBe(4);
    for (const call of validateHost.mock.calls) expect(call[1]).toEqual({ allowPrivate: true });
  });

  it('with the policy off, a private issuer is still refused and discovery is never fetched', async () => {
    stubDiscovery();
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });
    query.mockResolvedValue({ rows: [provider] });

    // buildEndSessionUrl never throws (logout must succeed locally): a refused host is null.
    expect(await buildEndSessionUrl({ providerId: 'p1', idToken: 'tok' })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('the discovery cache and the policy', () => {
  it('turning the policy off re-checks cached endpoints: a private token endpoint is refused at once', async () => {
    // A public issuer whose token endpoint is on the LAN. Only the endpoint check depends on the
    // policy, and it runs only when the discovery document is fetched, not on a cache hit.
    const publicIssuer = 'https://idp.example.com';
    const doc = {
      issuer: publicIssuer,
      authorization_endpoint: `${publicIssuer}/authorize`,
      token_endpoint: 'https://token.lan.example.org/token',
      jwks_uri: `${publicIssuer}/jwks`,
      end_session_endpoint: `${publicIssuer}/end-session`,
    };
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => doc }));
    validateHost.mockImplementation(async (host, { allowPrivate = false } = {}) =>
      (host.includes('.lan.') && !allowPrivate ? 'Host cannot be a private or reserved IP address' : null));
    query.mockResolvedValue({ rows: [{ ...provider, issuer_url: publicIssuer }] });

    expect(await buildEndSessionUrl({ providerId: 'p2', idToken: 'tok' })).toBeTruthy(); // cached

    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });
    expect(await buildEndSessionUrl({ providerId: 'p2', idToken: 'tok' })).toBeNull();
  });
});

describe('saving an OIDC provider honors the allow-private-hosts policy', () => {
  const body = { name: 'LAN SSO', slug: 'lan', issuer_url: issuer, client_id: 'cid', client_secret: 'secret' };
  const post = (payload) => fetch(`${base}/api/admin/oidc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const patch = (payload) => fetch(`${base}/api/admin/oidc/00000000-0000-4000-8000-000000000001`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });

  it('creates a provider with a private issuer when the policy allows private hosts', async () => {
    query.mockResolvedValue({ rows: [{ id: 'p1', ...body }] });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(validateHost).toHaveBeenCalledWith('auth.lan.example.org', { allowPrivate: true });
  });

  it('refuses the private issuer on create when the policy is off', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });
    query.mockResolvedValue({ rows: [{ id: 'p1', ...body }] });
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Issuer URL: /);
  });

  it('updates a provider to a private issuer when the policy allows private hosts', async () => {
    query.mockResolvedValue({ rows: [{ id: 'p1', allow_insecure: false }] });
    const res = await patch({ issuer_url: issuer });
    expect([res.status, (await res.json()).error]).toEqual([200, undefined]);
    expect(validateHost).toHaveBeenCalledWith('auth.lan.example.org', { allowPrivate: true });
  });

  it('refuses the private issuer on update when the policy is off', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });
    query.mockResolvedValue({ rows: [{ id: 'p1', allow_insecure: false }] });
    const res = await patch({ issuer_url: issuer });
    expect(res.status).toBe(400);
  });
});
