import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../index.js', () => ({
  imapManager: {
    disconnectAccount: vi.fn(() => Promise.resolve()),
  },
}));
// enc(x) / dec(enc(x)) round-trips so the route's decrypt(...) calls are observable per field.
vi.mock('../services/encryption.js', () => ({
  encrypt: vi.fn((v) => (v ? `enc(${v})` : v)),
  decrypt: vi.fn((v) => (typeof v === 'string' && v.startsWith('enc(') ? v.slice(4, -1) : null)),
}));
vi.mock('../services/oauth/googleOAuth.js', () => ({ revokeGoogleToken: vi.fn(async () => true) }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { revokeGoogleToken } from '../services/oauth/googleOAuth.js';

const ID = '88888888-8888-4888-8888-888888888888';

// Removing a Gmail mailbox must also revoke the panel's grant at Google (best effort), and must
// never touch the google_oauth_grants journal — that table is a lifetime record for the app's
// Google user cap, not a live-grant list (see services/oauth/googleApps.js).
describe('DELETE /api/accounts/:id revokes the Google grant', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use('/api/accounts', accountRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async () => ({ rows: [] }));
  });

  const del = () => fetch(`${base}/api/accounts/${ID}`, { method: 'DELETE' });
  // The revoke runs fire-and-forget after the response; let its microtask/promise chain settle.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('revokes with the decrypted refresh token, after the row is gone', async () => {
    query.mockImplementation(async (sql) => (
      sql.startsWith('SELECT id, email_address, mail_node')
        ? { rows: [{
            id: ID, email_address: 'user@gmail.com', mail_node: false,
            oauth_provider: 'google', oauth_refresh_token: 'enc(refresh-1)', oauth_access_token: 'enc(access-1)',
          }] }
        : { rows: [] }
    ));
    const res = await del();
    expect(res.status).toBe(200);
    await flush();
    expect(revokeGoogleToken).toHaveBeenCalledWith('refresh-1');
    // No write to the grant journal — revoking is best-effort against Google only.
    expect(query.mock.calls.some(([sql]) => /google_oauth_grants/.test(sql))).toBe(false);
  });

  it('falls back to the access token when there is no refresh token', async () => {
    query.mockImplementation(async (sql) => (
      sql.startsWith('SELECT id, email_address, mail_node')
        ? { rows: [{
            id: ID, email_address: 'user@gmail.com', mail_node: false,
            oauth_provider: 'google', oauth_refresh_token: null, oauth_access_token: 'enc(access-1)',
          }] }
        : { rows: [] }
    ));
    await del();
    await flush();
    expect(revokeGoogleToken).toHaveBeenCalledWith('access-1');
  });

  it('does not call Google for a non-Google mailbox', async () => {
    query.mockImplementation(async (sql) => (
      sql.startsWith('SELECT id, email_address, mail_node')
        ? { rows: [{ id: ID, email_address: 'user@outlook.com', mail_node: false, oauth_provider: 'microsoft', oauth_refresh_token: 'enc(x)', oauth_access_token: null }] }
        : { rows: [] }
    ));
    const res = await del();
    expect(res.status).toBe(200);
    await flush();
    expect(revokeGoogleToken).not.toHaveBeenCalled();
  });

  it('does not call Google for a plain IMAP mailbox with no oauth_provider', async () => {
    query.mockImplementation(async (sql) => (
      sql.startsWith('SELECT id, email_address, mail_node')
        ? { rows: [{ id: ID, email_address: 'user@example.com', mail_node: false, oauth_provider: null, oauth_refresh_token: null, oauth_access_token: null }] }
        : { rows: [] }
    ));
    const res = await del();
    expect(res.status).toBe(200);
    await flush();
    expect(revokeGoogleToken).not.toHaveBeenCalled();
  });

  it('still deletes and answers ok when the revoke call fails', async () => {
    // revokeGoogleToken is documented never to throw (it catches internally and reports the
    // outcome as a boolean); the deletion path must not depend on that guarantee either, so the
    // route wraps the fire-and-forget call in its own catch. A reject exercises that guard.
    revokeGoogleToken.mockRejectedValueOnce(new Error('network down'));
    query.mockImplementation(async (sql) => (
      sql.startsWith('SELECT id, email_address, mail_node')
        ? { rows: [{
            id: ID, email_address: 'user@gmail.com', mail_node: false,
            oauth_provider: 'google', oauth_refresh_token: 'enc(refresh-1)', oauth_access_token: null,
          }] }
        : { rows: [] }
    ));
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await flush();
    expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM email_accounts'))).toBe(true);
  });
});
