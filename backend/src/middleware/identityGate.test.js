import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import express from 'express';
import { createIdentityGate, isLocalOnlyPath } from './identityGate.js';

const GOOGLE = {
  mode: 'google',
  cloudflare: { issuer: 'https://team.cloudflareaccess.com', audience: 'aud' },
  googleSignIn: { clientId: 'client-id', clientSecret: 'client-secret' },
  bootstrapAdminEmails: new Set(),
};
const USER = { id: 'u1', username: 'user@example.com', email: 'user@example.com', is_admin: false, disabled_at: null };

// Sessions persist between requests by the x-test-session header and mimic express-session.
const sessions = new Map();
function sessionFor(id) {
  if (!sessions.has(id)) {
    const session = {};
    const clear = () => {
      for (const key of Object.keys(session)) if (typeof session[key] !== 'function') delete session[key];
    };
    session.regenerate = vi.fn((cb) => { clear(); cb(); });
    session.destroy = vi.fn((cb) => { clear(); cb?.(); });
    sessions.set(id, session);
  }
  return sessions.get(id);
}

let state;
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = sessionFor(req.get('x-test-session') || 'default');
    next();
  });
  app.use(['/api', '/oauth', '/auth/oidc'], createIdentityGate({
    getSettings: () => state.settings,
    verifyToken: (...args) => state.verifyToken(...args),
    resolveUser: (...args) => state.resolveUser(...args),
    loadUser: (...args) => state.loadUser(...args),
  }));
  app.use((req, res) => res.json({ userId: req.session.userId ?? null, authMethod: req.session.authMethod ?? null }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  sessions.clear();
  state = {
    settings: GOOGLE,
    verifyToken: vi.fn(async (token) => (token === 'good-token' ? 'user@example.com' : null)),
    resolveUser: vi.fn(async () => ({ user: USER })),
    loadUser: vi.fn(async () => USER),
  };
});

const call = (path, { session = 'default', token } = {}) => fetch(`${base}${path}`, {
  headers: { 'x-test-session': session, ...(token ? { 'cf-access-jwt-assertion': token } : {}) },
});

describe('isLocalOnlyPath', () => {
  it.each([
    '/api/auth/login', '/api/auth/register', '/api/auth/2fa/challenge', '/api/auth/forgot-password',
    '/api/auth/reset-password', '/api/auth/registration-status', '/api/auth/invite/abc',
    '/api/auth/profile/recovery-email', '/api/auth/oidc/providers', '/auth/oidc/corp/start', '/api/totp/setup',
    '/api/admin/invites', '/api/admin/invites/1', '/api/admin/oidc',
    '/api/admin/users/11111111-1111-1111-1111-111111111111/totp/disable',
  ])('marks %s', (path) => {
    expect(isLocalOnlyPath(path)).toBe(true);
  });

  it.each(['/API/Auth/Login', '/api/AUTH/2fa/challenge', '/Auth/OIDC/corp/start', '/api/admin/users/ABC/TOTP/disable'])(
    'marks %s whatever its case', (path) => {
      expect(isLocalOnlyPath(path)).toBe(true);
    },
  );

  it.each(['/api/auth/me', '/api/auth/logout', '/api/auth/lock', '/api/admin/users', '/api/auth/loginx'])('leaves %s', (path) => {
    expect(isLocalOnlyPath(path)).toBe(false);
  });
});

describe('identityGate', () => {
  it('does nothing in local mode', async () => {
    state.settings = { ...GOOGLE, mode: 'local' };
    expect((await call('/api/auth/login')).status).toBe(200);
    expect(state.verifyToken).not.toHaveBeenCalled();
  });

  it('hides local sign-in routes in google mode', async () => {
    for (const path of ['/api/auth/login', '/auth/oidc/corp/start']) {
      expect((await call(path, { token: 'good-token' })).status).toBe(404);
    }
    expect(state.resolveUser).not.toHaveBeenCalled();
  });

  it('hides local sign-in routes in google mode whatever the case of the path', async () => {
    for (const path of ['/api/auth/LOGIN', '/API/Auth/Register', '/auth/OIDC/corp/start']) {
      expect((await call(path, { token: 'good-token' })).status).toBe(404);
    }
    expect(state.resolveUser).not.toHaveBeenCalled();
  });

  it('lets public paths through without an identity', async () => {
    for (const path of ['/api/health', '/api/health/ready', '/api/auth/config', '/api/auth/logout', '/oauth/login/google', '/oauth/login/google/callback?code=x']) {
      expect((await call(path)).status).toBe(200);
    }
  });

  it('asks for sign-in without a token or a session', async () => {
    const res = await call('/api/auth/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_authenticated', code: 'not_authenticated' });
  });

  it('signs a Cloudflare Access identity into the session once', async () => {
    const first = await call('/api/auth/me', { token: 'good-token' });
    expect(await first.json()).toEqual({ userId: 'u1', authMethod: 'cloudflare' });
    expect(state.verifyToken).toHaveBeenCalledWith('good-token', GOOGLE.cloudflare);
    expect(state.resolveUser).toHaveBeenCalledWith({ email: 'user@example.com', source: 'cloudflare', settings: GOOGLE });
    await call('/api/mail/messages', { token: 'good-token' });
    expect(sessionFor('default').regenerate).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid token even for a signed-in session', async () => {
    await call('/api/auth/me', { token: 'good-token' });
    expect((await call('/api/auth/me', { token: 'forged' })).status).toBe(401);
  });

  it('refuses and signs out an identity the user list refuses', async () => {
    await call('/api/auth/me', { token: 'good-token' });
    state.resolveUser.mockResolvedValue({ error: 'user_disabled' });
    const res = await call('/api/auth/me', { token: 'good-token' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'user_disabled', code: 'user_disabled' });
    expect(sessionFor('default').destroy).toHaveBeenCalled();
  });

  it('ignores the Access header when Cloudflare Access is not configured', async () => {
    state.settings = { ...GOOGLE, cloudflare: null };
    expect((await call('/api/auth/me', { token: 'good-token' })).status).toBe(401);
    expect(state.verifyToken).not.toHaveBeenCalled();
  });

  it('accepts a direct Google sign-in session while the user stays active', async () => {
    Object.assign(sessionFor('direct'), { userId: 'u1', authMethod: 'google' });
    expect(await (await call('/api/auth/me', { session: 'direct' })).json()).toEqual({ userId: 'u1', authMethod: 'google' });
    expect(state.loadUser).toHaveBeenCalledWith('u1');

    state.loadUser.mockResolvedValue({ ...USER, disabled_at: new Date().toISOString() });
    expect((await call('/api/auth/me', { session: 'direct' })).status).toBe(403);
    expect(sessionFor('direct').destroy).toHaveBeenCalled();
  });

  it('does not accept an email-less user, a Cloudflare session without its token or a local session', async () => {
    Object.assign(sessionFor('noemail'), { userId: 'u1', authMethod: 'google' });
    state.loadUser.mockResolvedValue({ ...USER, email: null });
    expect((await call('/api/auth/me', { session: 'noemail' })).status).toBe(401);

    Object.assign(sessionFor('edge'), { userId: 'u1', authMethod: 'cloudflare' });
    expect((await call('/api/auth/me', { session: 'edge' })).status).toBe(401);

    Object.assign(sessionFor('legacy'), { userId: 'u1' });
    expect((await call('/api/auth/me', { session: 'legacy' })).status).toBe(401);
  });

  it('passes lookup failures to the error handler', async () => {
    state.resolveUser.mockRejectedValue(new Error('database unavailable'));
    expect((await call('/api/auth/me', { token: 'good-token' })).status).toBe(500);
  });
});
