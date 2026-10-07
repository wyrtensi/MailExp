import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    const userId = req.get('x-test-user');
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    req.session = { userId };
    next();
  },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
// googleLaunch.js is loaded for real (for GOOGLE_EMAIL_PATTERN); keep it off a real Redis client.
vi.mock('../services/redis.js', () => ({ redisClient: { set: vi.fn(), getDel: vi.fn() } }));
const selection = vi.hoisted(() => ({ result: { appId: 'app-1', reserved: true, reservation: 'res-1' }, error: null }));
vi.mock('../services/oauth/googleAppSelection.js', () => {
  class GoogleAppSelectionError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  return {
    GoogleAppSelectionError,
    selectGoogleApp: vi.fn(async () => {
      if (selection.error) throw new GoogleAppSelectionError(selection.error);
      return selection.result;
    }),
    releaseGoogleSeat: vi.fn(async () => {}),
  };
});
const config = vi.hoisted(() => ({ value: null }));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async () => config.value),
  findKnownGoogleEmails: vi.fn(async () => ['old@gmail.com']),
}));
vi.mock('../services/oauth/oauthState.js', () => ({
  createOAuthState: vi.fn(async () => ({ state: 'S'.repeat(43), codeChallenge: 'C'.repeat(43) })),
}));
vi.mock('../services/oauth/googleLaunch.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createGoogleLaunch: vi.fn(async () => 'F'.repeat(43)),
}));

import express from 'express';
import routes from './oauthGoogleApi.js';
import { query } from '../services/db.js';
import { selectGoogleApp, releaseGoogleSeat } from '../services/oauth/googleAppSelection.js';
import { findKnownGoogleEmails, resolveGoogleConfig } from '../services/oauth/googleApps.js';
import { createOAuthState } from '../services/oauth/oauthState.js';
import { createGoogleLaunch } from '../services/oauth/googleLaunch.js';

const CLIENT_ID = '123456789012-abc.apps.googleusercontent.com';
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/oauth/google', routes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/oauth/google`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  vi.clearAllMocks();
  selection.result = { appId: 'app-1', reserved: true, reservation: 'res-1' };
  selection.error = null;
  config.value = { appId: 'app-1', clientId: CLIENT_ID, clientSecret: 's', redirectUri: 'https://mail.example.com/oauth/google/callback' };
  query.mockResolvedValue({ rows: [] });
});

const start = (email, user = 'u1', names = {}) => fetch(`${base}/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
  body: JSON.stringify({ email, ...names }),
});

describe('POST /api/oauth/google/start', () => {
  it('requires a session', async () => {
    expect((await start('a@gmail.com', null)).status).toBe(401);
  });

  it('answers with a one-time launch path that does not carry the email', async () => {
    const res = await start('A@Gmail.com');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ path: `/oauth/google/launch?flow=${'F'.repeat(43)}` });
    expect(JSON.stringify(body)).not.toMatch(/gmail/i);
    expect(createOAuthState).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'google', userId: 'u1', appId: 'app-1', mode: 'add', email: 'a@gmail.com', loginHint: 'a@gmail.com',
      reservation: 'res-1',
    }));
    const { url } = createGoogleLaunch.mock.calls[0][0];
    const google = new URL(url);
    expect(google.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(google.searchParams.get('login_hint')).toBe('a@gmail.com');
  });

  it('carries the sender names from the form to the callback through the state', async () => {
    const res = await start('a@gmail.com', 'u1', { senderName: ' Иван Петров ', senderNameAlt: 'Ivan Petrov' });
    expect(res.status).toBe(200);
    expect(createOAuthState).toHaveBeenCalledWith(expect.objectContaining({ senderName: 'Иван Петров', senderNameAlt: 'Ivan Petrov' }));
  });

  it('refuses a sender name that would add a header, before selecting an app', async () => {
    const res = await start('a@gmail.com', 'u1', { senderName: 'x\r\nBcc: y@evil.example' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'sender_name_invalid' });
    expect(createOAuthState).not.toHaveBeenCalled();
  });

  it('refuses a malformed email', async () => {
    const res = await start('not an email');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'email_invalid' });
  });

  it('refuses an address that already has a mailbox, without selecting an app', async () => {
    query.mockResolvedValue({ rows: [{ id: 'acc-1' }] });
    const res = await start('a@gmail.com');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'already_connected' });
    expect(selectGoogleApp).not.toHaveBeenCalled();
  });

  it.each(['no_app_capacity', 'not_configured'])('reports %s from selection', async (code) => {
    selection.error = code;
    const res = await start('a@gmail.com');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code });
  });

  it('frees the reserved seat when the selected app cannot be used', async () => {
    config.value = null;
    const res = await start('a@gmail.com');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_configured' });
    expect(releaseGoogleSeat).toHaveBeenCalledWith('app-1', 'a@gmail.com', 'res-1');
  });

  it('frees the reserved seat when reading the app configuration throws', async () => {
    resolveGoogleConfig.mockRejectedValueOnce(new Error('db down'));
    const res = await start('A@Gmail.com');
    expect(res.status).toBe(500);
    expect(releaseGoogleSeat).toHaveBeenCalledWith('app-1', 'a@gmail.com', 'res-1');
  });

  it('frees the reserved seat when createGoogleLaunch fails after the reservation', async () => {
    createGoogleLaunch.mockRejectedValueOnce(new Error('redis down'));
    const res = await start('A@Gmail.com');
    expect(res.status).toBe(500);
    expect(releaseGoogleSeat).toHaveBeenCalledWith('app-1', 'a@gmail.com', 'res-1');
  });
});

describe('GET /api/oauth/google/known-emails', () => {
  const known = (q, user = 'u1') => fetch(`${base}/known-emails?${new URLSearchParams({ q })}`, {
    headers: user ? { 'x-test-user': user } : {},
  });

  it('returns addresses only', async () => {
    const res = await known('ol');
    expect(await res.json()).toEqual({ emails: ['old@gmail.com'] });
    expect(findKnownGoogleEmails).toHaveBeenCalledWith('ol');
  });

  it.each(['a', ' a ', 'x'.repeat(255)])('refuses the query %j', async (q) => {
    const res = await known(q);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'query_invalid' });
  });

  it('requires a session', async () => {
    expect((await known('ol', null)).status).toBe(401);
  });
});
