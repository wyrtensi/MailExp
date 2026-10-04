import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// The sign-in limit as the route uses it: only failed passwords count, a right password clears the
// account-from-this-address counter, and a trusted device of the account is not held by it.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, encrypt: (v) => v }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/authLimiter.js', async (importOriginal) => ({ ...(await importOriginal()), authLimiterConfig: { maxRequests: 3, windowMs: 900000 } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ getGlobalCategorizationEnabled: vi.fn(async () => false) }));
vi.mock('../services/redis.js', () => ({ redisClient: { scan: vi.fn(), get: vi.fn(), del: vi.fn() } }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(), peek: vi.fn(), reset: vi.fn() }));

import express from 'express';
import bcrypt from 'bcryptjs';
import authRoutes from './auth.js';
import { query } from '../services/db.js';
import { consume, peek, reset } from '../services/rateLimiter.js';

let hash;
let full;
let trusted;
let server;
let base;
beforeAll(async () => {
  hash = await bcrypt.hash('right-password', 4);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { regenerate: (cb) => cb(), save: (cb) => cb(), destroy: (cb) => cb() };
    next();
  });
  app.use('/api/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  full = new Set();
  trusted = false;
  consume.mockReset().mockResolvedValue({ limited: false, resetMs: 0 });
  reset.mockReset().mockResolvedValue();
  peek.mockReset().mockImplementation(async (key) => ({
    limited: full.has(key.replace(/(?:::ffff:)?127\.0\.0\.1/, 'IP')), resetMs: 60_000,
  }));
  query.mockReset().mockImplementation(async (sql) => {
    if (sql.includes("key = 'internal_auth_disabled'")) return { rows: [] };
    if (sql.startsWith('SELECT * FROM users WHERE username')) {
      return { rows: [{ id: 'u1', username: 'alice', password_hash: hash, totp_enabled: true, is_admin: true }] };
    }
    if (sql.includes('FROM trusted_devices td JOIN users u')) return { rows: trusted ? [{ '?column?': 1 }] : [] };
    if (sql.includes("key IN ('mfa_enforcement', 'mfa_device_trust')")) return { rows: [] };
    return { rows: [] };
  });
});

const login = (password, cookie) => fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify({ username: 'Alice', password }),
});
// req.ip as the test server sees it (127.0.0.1 or ::ffff:127.0.0.1) is replaced by IP.
const consumedKeys = () => consume.mock.calls.map(([key]) => key.replace(/(?:::ffff:)?127\.0\.0\.1/, 'IP')).sort();

describe('POST /api/auth/login limit', () => {
  it('counts a wrong password against the account, the account from this address and the address', async () => {
    expect((await login('wrong')).status).toBe(401);
    expect(consumedKeys()).toEqual(['auth:login-acct-ip:alice|IP', 'auth:login-acct:alice', 'auth:login-ip:IP']);
  });

  it('counts nothing for a right password and clears the account-from-this-address counter', async () => {
    const res = await login('right-password');
    expect(res.status).toBe(200);
    expect((await res.json()).requiresTOTP).toBe(true);
    expect(consume).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledWith(expect.stringMatching(/^auth:login-acct-ip:alice\|(::ffff:)?127\.0\.0\.1$/));
  });

  it('holds an account whose limit is used up, before the password is checked', async () => {
    full.add('auth:login-acct:alice');
    const res = await login('right-password');
    expect(res.status).toBe(429);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('SELECT * FROM users WHERE username'))).toBe(false);
  });

  it('lets a trusted device of the account through its account limit', async () => {
    full.add('auth:login-acct:alice');
    trusted = true;
    expect((await login('right-password', 'mf_td=device-token')).status).toBe(200);
  });

  it('still holds a trusted device behind a used-up address limit', async () => {
    full.add('auth:login-ip:IP');
    trusted = true;
    expect((await login('right-password', 'mf_td=device-token')).status).toBe(429);
  });
});
