import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, encrypt: (v) => v }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/authLimiter.js', async (importOriginal) => ({ ...(await importOriginal()), authLimiterConfig: { maxRequests: 10, windowMs: 900000 } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ getGlobalCategorizationEnabled: vi.fn(async () => false) }));
vi.mock('../services/redis.js', () => ({ redisClient: { scan: vi.fn(), get: vi.fn(), del: vi.fn() } }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(async () => ({ limited: false, resetMs: 0 })),
  reset: vi.fn(),
}));

import express from 'express';
import authRoutes from './auth.js';
import { query } from '../services/db.js';
import { buildEndSessionUrl } from './oidc.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = { ...(userId ? { userId } : {}), destroy: (cb) => cb() };
    next();
  });
  app.use('/api/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  buildEndSessionUrl.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const cloudflareEnv = () => {
  vi.stubEnv('AUTH_MODE', 'google');
  vi.stubEnv('CF_ACCESS_ISSUER', 'https://team.cloudflareaccess.com');
  vi.stubEnv('CF_ACCESS_AUDIENCE', 'aud-tag');
};

describe('GET /api/auth/config', () => {
  it('describes local mode', async () => {
    expect(await (await fetch(`${base}/api/auth/config`)).json())
      .toEqual({ mode: 'local', cloudflare: false, googleSignIn: false });
  });

  it('describes google mode without exposing its settings', async () => {
    cloudflareEnv();
    vi.stubEnv('AUTH_GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('AUTH_GOOGLE_CLIENT_SECRET', 'client-secret');
    expect(await (await fetch(`${base}/api/auth/config`)).json())
      .toEqual({ mode: 'google', cloudflare: true, googleSignIn: true });
  });
});

describe('GET /api/auth/me', () => {
  it('returns the email and the sign-in mode', async () => {
    vi.stubEnv('AUTH_MODE', 'google');
    query.mockResolvedValue({ rows: [{
      id: 'u1', username: 'user@example.com', email: 'user@example.com', display_name: null, avatar: null,
      is_admin: false, totp_enabled: false, password_hash: null, lock_pin_hash: null,
    }] });
    const body = await (await fetch(`${base}/api/auth/me`, { headers: { 'x-test-user': 'u1' } })).json();
    expect(body.user).toMatchObject({ id: 'u1', email: 'user@example.com', authMode: 'google', hasPassword: false });
    expect(query.mock.calls[0][0]).toMatch(/SELECT id, username, email,/);
  });
});

describe('POST /api/auth/logout', () => {
  const logout = (headers = {}) => fetch(`${base}/api/auth/logout`, {
    method: 'POST', headers: { 'x-test-user': 'u1', ...headers },
  }).then((res) => res.json());

  it('ends the Cloudflare Access session when the request came through Access', async () => {
    cloudflareEnv();
    expect(await logout({ 'cf-access-jwt-assertion': 'token' })).toEqual({ ok: true, endSessionUrl: '/cdn-cgi/access/logout' });
    expect(await logout()).toEqual({ ok: true, endSessionUrl: null });
    expect(buildEndSessionUrl).not.toHaveBeenCalled();
  });

  it('keeps the OIDC end-session URL in local mode', async () => {
    buildEndSessionUrl.mockResolvedValue('https://idp.example.com/logout');
    expect(await logout()).toEqual({ ok: true, endSessionUrl: 'https://idp.example.com/logout' });
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('never sends the reset mail through a mailbox', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql) => {
      if (/FROM users WHERE recovery_email/.test(sql)) return { rows: [{ id: 'u1', password_hash: 'hash' }] };
      return { rows: [] };
    });
    const res = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(query.mock.calls.some(([sql]) => /email_accounts/.test(sql))).toBe(false);
    expect(error).toHaveBeenCalledWith('forgot-password error:', 'No email transport available');
    error.mockRestore();
  });
});
