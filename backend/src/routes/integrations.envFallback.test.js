import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// integrations.js remembers GOOGLE_REDIRECT_URI once, when the module loads. Every test sets the
// environment the process "started" with and then loads a fresh copy of the module. Stub state
// lives in vi.hoisted objects so it is shared by every fresh copy of the mocked modules.
const db = vi.hoisted(() => ({ rows: [] }));
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: db.rows })) }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
  isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:'),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async () => null),
  importLegacyGoogleConfig: vi.fn(async () => null),
}));
vi.mock('../services/oauth/googleAppSelection.js', () => ({
  googleHasCapacity: vi.fn(async () => true),
}));

import express from 'express';

const ENV_URI = 'https://env.example.com/oauth/google/callback';
const STORED_URI = 'https://stored.example.com/oauth/google/callback';
// A google row written before PR 8a: client fields, no callback URL.
const LEGACY_ROW = { provider: 'google', config: { clientId: 'legacy-client', clientSecret: 'enc:legacy' }, updated_at: '2026-09-01T00:00:00.000Z' };

let savedEnv;
let logSpy;

beforeAll(() => { savedEnv = process.env.GOOGLE_REDIRECT_URI; });
afterAll(() => {
  if (savedEnv === undefined) delete process.env.GOOGLE_REDIRECT_URI;
  else process.env.GOOGLE_REDIRECT_URI = savedEnv;
});
afterEach(() => {
  db.rows = [];
  logSpy?.mockRestore();
});

async function loadModule(startEnv) {
  vi.resetModules();
  if (startEnv === undefined) delete process.env.GOOGLE_REDIRECT_URI;
  else process.env.GOOGLE_REDIRECT_URI = startEnv;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return import('./integrations.js');
}

async function withApp(router, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GOOGLE_REDIRECT_URI as the fallback callback URL', () => {
  it('keeps the startup value when the stored google row has no callback URL', async () => {
    const { loadIntegrationConfigs } = await loadModule(ENV_URI);
    db.rows = [LEGACY_ROW];
    await loadIntegrationConfigs();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(ENV_URI);
  });

  it('lets a stored callback URL override the startup value', async () => {
    const { loadIntegrationConfigs } = await loadModule(ENV_URI);
    db.rows = [{ provider: 'google', config: { redirectUri: STORED_URI } }];
    await loadIntegrationConfigs();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(STORED_URI);
  });

  it('returns to the startup value once the stored row carries no callback URL', async () => {
    const { default: router, loadIntegrationConfigs } = await loadModule(ENV_URI);
    await withApp(router, async (base) => {
      const res = await fetch(`${base}/api/integrations/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUri: STORED_URI }),
      });
      expect(res.status).toBe(200);
    });
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(STORED_URI);

    db.rows = [LEGACY_ROW];
    await loadIntegrationConfigs();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(ENV_URI);
  });

  it('shows the startup value on the settings screen when the row has no callback URL', async () => {
    const { default: router, loadIntegrationConfigs } = await loadModule(ENV_URI);
    db.rows = [LEGACY_ROW];
    await loadIntegrationConfigs();
    await withApp(router, async (base) => {
      const body = await (await fetch(`${base}/api/integrations`)).json();
      expect(body.google).toEqual({ redirectUri: ENV_URI, updated_at: LEGACY_ROW.updated_at });
    });
  });

  it('leaves the mail node rows out of the settings screen, encrypted key and EOP settings alike', async () => {
    const { default: router } = await loadModule(ENV_URI);
    db.rows = [
      { provider: 'microsoft', config: { clientId: 'ms-client', clientSecret: 'enc:ms' }, updated_at: 't' },
      { provider: 'mail_node', config: { mailHost: 'mail.example.com', apiKey: 'enc:node-key' }, updated_at: 't' },
      { provider: 'mail_node_eop', config: { eopHost: 'contoso-com.mail.protection.outlook.com' }, updated_at: 't' },
    ];
    await withApp(router, async (base) => {
      const body = await (await fetch(`${base}/api/integrations`)).json();
      expect(Object.keys(body).sort()).toEqual(['google', 'microsoft']);
      expect(body.microsoft.clientSecret).toBe('••••••••');
      expect(JSON.stringify(body)).not.toContain('node-key');
    });
  });

  it('still clears the variable when the process started without one', async () => {
    const { loadIntegrationConfigs } = await loadModule(undefined);
    process.env.GOOGLE_REDIRECT_URI = STORED_URI; // left by an earlier save in this process
    db.rows = [LEGACY_ROW];
    await loadIntegrationConfigs();
    expect(process.env.GOOGLE_REDIRECT_URI).toBeUndefined();
  });
});
