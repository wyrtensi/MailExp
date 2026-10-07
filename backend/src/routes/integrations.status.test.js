import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

// The /status capability endpoint (#315) must be reachable by any authenticated user,
// NOT just admins: a non-admin needs to learn that Microsoft OAuth is configured so the
// connect buttons enable, without ever seeing the credentials. These tests mount the real
// integrations router with a requireAdmin stub that rejects unless a test explicitly opts in,
// proving /status does not sit behind the admin gate while GET / still does. db/encryption are
// stubbed; the admin config tests at the bottom use them to check redaction and encryption.
import { vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
  isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:'),
}));
// Authenticated, but NOT an admin by default — requireAdmin 403s unless a test opts in.
const authState = vi.hoisted(() => ({ admin: false }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
  requireAdmin: (_req, res, next) => (authState.admin ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
const googleApps = vi.hoisted(() => ({ config: null }));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async () => googleApps.config),
  importLegacyGoogleConfig: vi.fn(async () => null),
}));
const capacity = vi.hoisted(() => ({ value: true }));
vi.mock('../services/oauth/googleAppSelection.js', () => ({
  googleHasCapacity: vi.fn(async () => capacity.value),
}));

import express from 'express';
import integrationsRoutes, { loadIntegrationConfigs } from './integrations.js';
import { query } from '../services/db.js';
import { importLegacyGoogleConfig } from '../services/oauth/googleApps.js';

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const imapManagerStub = { disconnectAccount: vi.fn(async () => {}) };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.set('imapManager', imapManagerStub);
  app.use('/api/integrations', integrationsRoutes);
  app.use((err, _req, res, next) => { void err; void next; res.status(500).json({ error: 'Internal server error' }); });
  return app;
}

let server;
let base;
const GOOGLE_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
const savedEnv = Object.fromEntries(['MS_CLIENT_ID', ...GOOGLE_VARS].map((k) => [k, process.env[k]]));

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterEach(() => {
  delete process.env.MS_CLIENT_ID;
  for (const k of GOOGLE_VARS) delete process.env[k];
  authState.admin = false;
  googleApps.config = null;
  capacity.value = true;
  query.mockReset();
  query.mockImplementation(async () => ({ rows: [] }));
  importLegacyGoogleConfig.mockReset();
  importLegacyGoogleConfig.mockImplementation(async () => null);
  imapManagerStub.disconnectAccount.mockClear();
});

describe('GET /api/integrations/status (non-admin capability check)', () => {
  it('is reachable by a non-admin (not behind requireAdmin) and reports configured=true when MS_CLIENT_ID is set', async () => {
    process.env.MS_CLIENT_ID = 'some-client-id';
    const res = await fetch(`${base}/api/integrations/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ microsoft: { configured: true }, google: { configured: false, available: false }, domainMail: { configured: false } });
  });

  it('reports configured=false when MS_CLIENT_ID is unset', async () => {
    const res = await fetch(`${base}/api/integrations/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ microsoft: { configured: false }, google: { configured: false, available: false }, domainMail: { configured: false } });
  });

  it('never leaks credentials in the response', async () => {
    process.env.MS_CLIENT_ID = 'super-secret-client-id';
    googleApps.config = {
      appId: 'app-1',
      clientId: '123456789012-google-client-id.apps.googleusercontent.com',
      clientSecret: 'google-client-secret',
      redirectUri: 'https://mail.example.com/oauth/google/callback',
    };
    const res = await fetch(`${base}/api/integrations/status`);
    const body = await res.text();
    expect(body).not.toContain('super-secret-client-id');
    expect(body).not.toContain('google-client-id');
    expect(body).not.toContain('google-client-secret');
    expect(body).not.toContain('mail.example.com');
  });

  it('reports google configured when a Google app resolves', async () => {
    let res = await fetch(`${base}/api/integrations/status`);
    expect((await res.json()).google).toEqual({ configured: false, available: false });

    googleApps.config = { appId: 'app-1', clientId: 'x', clientSecret: 'y', redirectUri: 'https://mail.example.com/oauth/google/callback' };
    res = await fetch(`${base}/api/integrations/status`);
    expect((await res.json()).google).toEqual({ configured: true, available: true });
  });

  it('reports whether a new Gmail can be connected, without any credential', async () => {
    googleApps.config = { appId: 'app-1', clientId: CLIENT_ID, clientSecret: 's', redirectUri: REDIRECT_URI };
    capacity.value = false;
    const body = await (await fetch(`${base}/api/integrations/status`)).json();
    expect(body.google).toEqual({ configured: true, available: false });
    expect(JSON.stringify(body)).not.toContain(CLIENT_ID);
  });

  it('reports the mail node as configured without its host or key', async () => {
    query.mockResolvedValueOnce({ rows: [{ config: { mailHost: 'node.example.net', apiKey: 'enc:node-api-key' } }] });
    const body = await (await fetch(`${base}/api/integrations/status`)).json();
    expect(body.domainMail).toEqual({ configured: true });
    expect(JSON.stringify(body)).not.toContain('node.example.net');
    expect(JSON.stringify(body)).not.toContain('node-api-key');
  });

  it('is never available while Google is not configured', async () => {
    googleApps.config = null;
    capacity.value = true;
    const body = await (await fetch(`${base}/api/integrations/status`)).json();
    expect(body.google).toEqual({ configured: false, available: false });
  });

  it('reports available: false, without failing, when googleHasCapacity rejects (Redis down)', async () => {
    process.env.MS_CLIENT_ID = 'some-client-id';
    googleApps.config = { appId: 'app-1', clientId: CLIENT_ID, clientSecret: 's', redirectUri: REDIRECT_URI };
    const { googleHasCapacity } = await import('../services/oauth/googleAppSelection.js');
    googleHasCapacity.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { name: 'AggregateError' }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(`${base}/api/integrations/status`);
    errorSpy.mockRestore();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ microsoft: { configured: true }, google: { configured: true, available: false }, domainMail: { configured: false } });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/ECONNREFUSED/);
  });
});

describe('GET /api/integrations (config read) stays admin-only', () => {
  it('is rejected with 403 for a non-admin', async () => {
    const res = await fetch(`${base}/api/integrations`);
    expect(res.status).toBe(403);
  });
});


describe('Google integration settings (admin, callback URL only)', () => {
  const post = (body) => fetch(`${base}/api/integrations/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('rejects non-admin writes', async () => {
    const res = await post({ redirectUri: REDIRECT_URI });
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('stores only the callback URL and ignores client fields', async () => {
    authState.admin = true;
    const res = await post({ clientId: CLIENT_ID, clientSecret: 'gsecret', redirectUri: ` ${REDIRECT_URI} `, tenantId: 'x' });
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls.find(([q]) => /INSERT INTO integration_config/.test(q));
    expect(sql).toMatch(/ON CONFLICT \(provider\)/);
    expect(params).toEqual(['google', { redirectUri: REDIRECT_URI }]);
    expect(JSON.stringify(query.mock.calls)).not.toMatch(/gsecret|123456789012/);
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(REDIRECT_URI);
    expect(process.env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(process.env.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it.each([
    [''],
    ['   '],
    ['not a url'],
    ['/oauth/google/callback'],
    ['ftp://mail.example.com/oauth/google/callback'],
    ['javascript:alert(1)'],
    ['https://mail.example.com/wrong'],
    ['https://mail.example.com/'],
    ['https://mail.example.com/oauth/google/callback/'],
    ['https://mail.example.com/oauth/google/callback?x=1'],
    ['https://mail.example.com/oauth/google/callback?'],
    ['https://mail.example.com/oauth/google/callback#top'],
  ])('refuses the callback URL %j without touching integration_config', async (redirectUri) => {
    authState.admin = true;
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    const res = await post({ redirectUri });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('redirect_uri_invalid');
    expect(query).not.toHaveBeenCalled();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(REDIRECT_URI);
  });

  it('accepts the callback path on a development host with a port', async () => {
    authState.admin = true;
    const res = await post({ redirectUri: 'http://localhost:5173/oauth/google/callback' });
    expect(res.status).toBe(200);
  });

  it('refuses a body without a callback URL', async () => {
    authState.admin = true;
    const res = await post({ clientId: CLIENT_ID, clientSecret: 's' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('redirect_uri_invalid');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns only the callback URL for google, dropping legacy client fields', async () => {
    authState.admin = true;
    const updatedAt = '2026-09-14T00:00:00.000Z';
    query.mockResolvedValue({ rows: [{ provider: 'google', config: { clientId: 'legacy-id', clientSecret: 'enc:real-secret', redirectUri: 'https://x/cb' }, updated_at: updatedAt }] });
    const res = await fetch(`${base}/api/integrations`);
    const text = await res.text();
    expect(text).not.toMatch(/real-secret|legacy-id|clientId|clientSecret/);
    expect(JSON.parse(text).google).toEqual({ redirectUri: 'https://x/cb', updated_at: updatedAt });
  });

  it('falls back to GOOGLE_REDIRECT_URI when no row is stored', async () => {
    authState.admin = true;
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    const body = await (await fetch(`${base}/api/integrations`)).json();
    expect(body.google).toEqual({ redirectUri: REDIRECT_URI });
  });

  it('has no google entry when no callback URL is known', async () => {
    authState.admin = true;
    const body = await (await fetch(`${base}/api/integrations`)).json();
    expect(body.google).toBeUndefined();
  });

  it('no longer deletes the google settings', async () => {
    authState.admin = true;
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    const res = await fetch(`${base}/api/integrations/google`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown provider' });
    expect(query).not.toHaveBeenCalled();
    expect(imapManagerStub.disconnectAccount).not.toHaveBeenCalled();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(REDIRECT_URI);
  });

  it('still deletes the microsoft settings', async () => {
    authState.admin = true;
    process.env.MS_CLIENT_ID = 'ms-id';
    const res = await fetch(`${base}/api/integrations/microsoft`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(query.mock.calls[0]).toEqual(['DELETE FROM integration_config WHERE provider = $1', ['microsoft']]);
    expect(process.env.MS_CLIENT_ID).toBeUndefined();
  });

  it('rejects a microsoft client secret that mixes the redaction placeholder with other text', async () => {
    authState.admin = true;
    process.env.MS_CLIENT_ID = 'unchanged';
    for (const clientSecret of ['••••••••abc', 'abc••••••••', '•••']) {
      const res = await fetch(`${base}/api/integrations/microsoft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'ms-id', clientSecret, redirectUri: 'https://x/cb' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Client secret contains the redaction placeholder; enter the full secret', code: 'client_secret_redacted' });
    }
    expect(query).not.toHaveBeenCalled();
    expect(process.env.MS_CLIENT_ID).toBe('unchanged');
  });

  it('loads only the callback URL on startup and imports the single-app client', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-client';
    query.mockResolvedValue({ rows: [{ provider: 'google', config: { clientId: CLIENT_ID, clientSecret: 'enc:loaded-secret', redirectUri: 'https://x/cb' } }] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await loadIntegrationConfigs();
    logSpy.mockRestore();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe('https://x/cb');
    expect(process.env.GOOGLE_CLIENT_ID).toBe('env-client');
    expect(process.env.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(importLegacyGoogleConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps starting when the import fails and logs only the error code', async () => {
    importLegacyGoogleConfig.mockRejectedValueOnce(Object.assign(new Error('boom enc:secret-value'), { code: 'import_failed' }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadIntegrationConfigs()).resolves.toBeUndefined();
    const logged = JSON.stringify(errorSpy.mock.calls);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    expect(logged).toMatch(/import_failed/);
    expect(logged).not.toMatch(/boom|secret-value/);
  });
});
