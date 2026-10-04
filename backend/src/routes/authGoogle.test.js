import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
const identity = vi.hoisted(() => ({ result: null }));
vi.mock('../services/auth/userIdentity.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveVerifiedUser: vi.fn(async () => identity.result),
}));
// In-memory Redis so the real single-use state store runs end to end.
const redisStore = vi.hoisted(() => new Map());
vi.mock('../services/redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value) => { redisStore.set(key, value); return 'OK'; }),
    getDel: vi.fn(async (key) => {
      const value = redisStore.get(key) ?? null;
      redisStore.delete(key);
      return value;
    }),
  },
}));
vi.mock('../services/oauth/googleOAuth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  exchangeGoogleCode: vi.fn(),
  verifyGoogleIdToken: vi.fn(),
}));

import express from 'express';
import authGoogleRoutes from './authGoogle.js';
import { logAuthEvent } from '../services/authEvents.js';
import { resolveVerifiedUser } from '../services/auth/userIdentity.js';
import { GoogleOAuthError, exchangeGoogleCode, verifyGoogleIdToken } from '../services/oauth/googleOAuth.js';

const USER = { id: 'u1', username: 'user@example.com', email: 'user@example.com', is_admin: false, disabled_at: null };

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

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = sessionFor(req.get('x-test-session') || 'browser');
    next();
  });
  app.use('/oauth/login/google', authGoogleRoutes);
  app.get('/whoami', (req, res) => res.json({ userId: req.session.userId ?? null, authMethod: req.session.authMethod ?? null }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  sessions.clear();
  redisStore.clear();
  vi.stubEnv('AUTH_MODE', 'google');
  vi.stubEnv('AUTH_GOOGLE_CLIENT_ID', 'client-id');
  vi.stubEnv('AUTH_GOOGLE_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('APP_URL', base);
  vi.stubEnv('APP_ALT_URLS', '');
  identity.result = { user: USER };
  exchangeGoogleCode.mockReset().mockResolvedValue({ accessToken: 'access', idToken: 'id-token', scope: 'openid email' });
  verifyGoogleIdToken.mockReset().mockResolvedValue({ email: 'User@Example.com', sub: 'sub-1', name: null });
  resolveVerifiedUser.mockClear();
  logAuthEvent.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const get = (path, session = 'browser') =>
  fetch(`${base}${path}`, { redirect: 'manual', headers: { 'x-test-session': session } });

async function start(session = 'browser') {
  const res = await get('/oauth/login/google', session);
  const location = new URL(res.headers.get('location'));
  return { res, location, state: location.searchParams.get('state') };
}

describe('GET /oauth/login/google', () => {
  it('is not found outside google mode or without a sign-in client', async () => {
    vi.stubEnv('AUTH_MODE', 'local');
    expect((await get('/oauth/login/google')).status).toBe(404);
    vi.stubEnv('AUTH_MODE', 'google');
    vi.stubEnv('AUTH_GOOGLE_CLIENT_SECRET', '');
    expect((await get('/oauth/login/google/callback?state=x&code=y')).status).toBe(404);
  });

  it('sends the browser to Google for its identity and binds the flow to the session', async () => {
    const { res, location, state } = await start();
    expect(res.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('scope')).toBe('openid email');
    expect(location.searchParams.get('redirect_uri')).toBe(`${base}/oauth/login/google/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('access_type')).toBeNull();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionFor('browser').googleSignInState).toBe(createHash('sha256').update(state).digest('hex'));
  });

  it('refuses a host that is not a public origin', async () => {
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    expect((await get('/oauth/login/google')).headers.get('location')).toBe('/login?auth_error=not_configured');
  });
});

// The screen-lock gate in index.js covers only /api. Signing in again from a locked session
// would swap it for an unlocked one without the PIN.
describe('Google sign-in from a locked session', () => {
  const lock = (id = 'browser') => Object.assign(sessionFor(id), { userId: 'u1', authMethod: 'google', locked: true });

  it('refuses to start', async () => {
    lock();
    const res = await get('/oauth/login/google');
    expect(res.headers.get('location')).toBe('/login?auth_error=locked');
    expect(redisStore.size).toBe(0);
    expect(sessionFor('browser')).toMatchObject({ userId: 'u1', locked: true });
  });

  it('refuses to finish a sign-in started before the lock, and burns its state', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { state } = await start();
    lock();
    const res = await get(`/oauth/login/google/callback?state=${state}&code=c`);
    expect(res.headers.get('location')).toBe('/login?auth_error=locked');
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
    expect(sessionFor('browser').regenerate).not.toHaveBeenCalled();
    expect(sessionFor('browser')).toMatchObject({ userId: 'u1', locked: true });
    expect(sessionFor('browser').googleSignInState).toBeUndefined();
    expect(redisStore.size).toBe(0);
    error.mockRestore();
  });
});

describe('GET /oauth/login/google/callback', () => {
  it('signs the approved user in', async () => {
    const { location, state } = await start();
    const res = await get(`/oauth/login/google/callback?state=${state}&code=auth-code-xyz`);
    expect(res.headers.get('location')).toBe('/');

    const { codeVerifier } = exchangeGoogleCode.mock.calls[0][0];
    expect(createHash('sha256').update(codeVerifier).digest('base64url')).toBe(location.searchParams.get('code_challenge'));
    expect(exchangeGoogleCode).toHaveBeenCalledWith({
      clientId: 'client-id', clientSecret: 'client-secret', code: 'auth-code-xyz',
      codeVerifier, redirectUri: `${base}/oauth/login/google/callback`,
    });
    expect(verifyGoogleIdToken).toHaveBeenCalledWith({ idToken: 'id-token', clientId: 'client-id' });
    expect(resolveVerifiedUser).toHaveBeenCalledWith({
      email: 'User@Example.com', source: 'google', settings: expect.objectContaining({ mode: 'google' }),
    });
    expect(await (await get('/whoami')).json()).toEqual({ userId: 'u1', authMethod: 'google' });
    expect(sessionFor('browser').googleSignInState).toBeUndefined();
    expect(logAuthEvent).toHaveBeenCalledWith('sso_login', expect.objectContaining({ userId: 'u1', success: true }));
  });

  it('refuses a callback finished in another browser and a replayed state', async () => {
    const { state } = await start('browser');
    expect((await get(`/oauth/login/google/callback?state=${state}&code=c`, 'other')).headers.get('location'))
      .toBe('/login?auth_error=invalid_state');
    expect((await get(`/oauth/login/google/callback?state=${state}&code=c`, 'browser')).headers.get('location'))
      .toBe('/login?auth_error=invalid_state');
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('reports a cancelled consent', async () => {
    const { state } = await start();
    expect((await get(`/oauth/login/google/callback?state=${state}&error=access_denied`)).headers.get('location'))
      .toBe('/login?auth_error=access_denied');
  });

  it('does not sign in an address the user list refuses', async () => {
    identity.result = { error: 'not_allowed' };
    const { state } = await start();
    expect((await get(`/oauth/login/google/callback?state=${state}&code=c`)).headers.get('location'))
      .toBe('/login?auth_error=not_allowed');
    expect(await (await get('/whoami')).json()).toEqual({ userId: null, authMethod: null });
  });

  it('keeps Google verification codes and hides every other failure behind a generic code', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    verifyGoogleIdToken.mockRejectedValueOnce(new GoogleOAuthError('email_not_verified'));
    let { state } = await start();
    expect((await get(`/oauth/login/google/callback?state=${state}&code=secret-code-1`)).headers.get('location'))
      .toBe('/login?auth_error=email_not_verified');

    exchangeGoogleCode.mockRejectedValueOnce(new Error('token endpoint rejected secret-code-2'));
    ({ state } = await start());
    expect((await get(`/oauth/login/google/callback?state=${state}&code=secret-code-2`)).headers.get('location'))
      .toBe('/login?auth_error=authentication_failed');
    expect(error.mock.calls.flat().join(' ')).not.toMatch(/secret-code/);
    error.mockRestore();
  });
});
