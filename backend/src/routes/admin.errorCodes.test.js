// Every refusal of the admin routes carries its stable code next to the text (the screens translate
// the code); the status and the text stay as they were.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({
  imapManager: { disconnectAccount: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({})),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));
vi.mock('../services/auditLog.js', () => ({ AUDIT_ACTIONS: [], recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/accessSync/index.js', () => ({
  requestAccessSync: vi.fn(), runAccessSyncNow: vi.fn(), withAccessSyncLock: vi.fn((op) => op()),
}));

import express from 'express';
import adminRoutes from './admin.js';
import { query } from '../services/db.js';

const ADMIN_ID = '00000000-0000-0000-0000-00000000000a';
const USER_ID = '00000000-0000-0000-0000-00000000000b';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: ADMIN_ID, username: 'admin@example.com' };
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
});

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
});

const call = (method, path, body) => fetch(`${base}/api/admin${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => ({ status: res.status, body: await res.json() }));

describe('admin refusal codes', () => {
  it.each([
    ['auth_max_attempts_invalid', { auth_max_attempts: 0 }],
    ['auth_window_minutes_invalid', { auth_window_minutes: 0 }],
    ['mfa_enforcement_invalid', { mfa_enforcement: 'sometimes' }],
    ['mfa_device_trust_invalid', { mfa_device_trust: 'forever' }],
    ['custom_css_invalid', { custom_css: 5 }],
    ['custom_css_too_long', { custom_css: 'a'.repeat(50001) }],
  ])('PATCH /settings answers %s', async (code, body) => {
    const res = await call('PATCH', '/settings', body);
    expect(res).toMatchObject({ status: 400, body: { code } });
    expect(typeof res.body.error).toBe('string');
  });

  it('PATCH /settings turning password login off without an SSO provider answers no_sso_provider', async () => {
    query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ count: '0' }] } : { rows: [] }));
    expect(await call('PATCH', '/settings', { internal_auth_disabled: true })).toMatchObject({ status: 400, body: { code: 'no_sso_provider' } });
  });

  it('PATCH /settings turning password login off without an SSO identity answers sso_identity_required', async () => {
    query.mockImplementation(async (sql) => {
      if (/COUNT\(\*\) AS count FROM oidc_providers/.test(sql)) return { rows: [{ count: '1' }] };
      if (/COUNT\(\*\) AS count FROM user_identities/.test(sql)) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
    expect(await call('PATCH', '/settings', { internal_auth_disabled: true })).toMatchObject({ status: 400, body: { code: 'sso_identity_required' } });
  });

  it('POST /users/:id/totp/disable answers not_found and self_change', async () => {
    expect(await call('POST', `/users/${USER_ID}/totp/disable`)).toEqual({ status: 404, body: { error: 'User not found', code: 'not_found' } });
    expect(await call('POST', `/users/${ADMIN_ID}/totp/disable`)).toMatchObject({ status: 400, body: { code: 'self_change' } });
  });

  it('DELETE /users/:id of the own account answers self_change', async () => {
    expect(await call('DELETE', `/users/${ADMIN_ID}`)).toEqual({ status: 400, body: { error: 'Cannot delete your own account', code: 'self_change' } });
  });

  it('POST /invites with a bad address answers email_invalid', async () => {
    expect(await call('POST', '/invites', { email: 'nope' })).toEqual({ status: 400, body: { error: 'Valid email address required', code: 'email_invalid' } });
  });

  it('the OIDC provider routes answer their codes', async () => {
    expect(await call('POST', '/oidc', {})).toMatchObject({ status: 400, body: { code: 'fields_required' } });
    expect(await call('POST', '/oidc', {
      name: 'X', slug: 'Bad Slug', issuer_url: 'https://idp.example.com', client_id: 'c', client_secret: 's',
    })).toMatchObject({ status: 400, body: { code: 'slug_invalid' } });
    expect(await call('PATCH', `/oidc/${USER_ID}`, { name: 'Y' })).toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('the system email routes answer their codes', async () => {
    expect(await call('POST', '/system-email', {})).toMatchObject({ status: 400, body: { code: 'fields_required' } });
  });
});
