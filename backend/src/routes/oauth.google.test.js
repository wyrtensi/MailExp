import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

// oauth.js imports imapManager from ../index.js (heavy load-time side effects).
vi.mock('../index.js', () => ({
  imapManager: {
    connectAccount: vi.fn(async () => true),
    disconnectAccount: vi.fn(async () => {}),
    clearConnectCooldown: vi.fn(),
  },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  decrypt: (v) => v,
}));
// The registry is covered by googleApps.test.js; routes see only the resolved credentials.
const googleApps = vi.hoisted(() => ({ config: null, byId: {} }));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async ({ appId = null } = {}) => (appId ? googleApps.byId[appId] ?? null : googleApps.config)),
  recordGoogleGrant: vi.fn(async () => {}),
}));

// App selection is covered by googleAppSelection.test.js; routes see only its outcome.
const selection = vi.hoisted(() => ({ result: { appId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', reserved: false }, error: null }));
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

// Keep the real URL builder and config checks; replace only the network-bound calls.
vi.mock('../services/oauth/googleOAuth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    exchangeGoogleCode: vi.fn(),
    verifyGoogleIdToken: vi.fn(),
    revokeGoogleToken: vi.fn(async () => true),
  };
});

const launch = vi.hoisted(() => ({ url: null }));
vi.mock('../services/oauth/googleLaunch.js', async (importOriginal) => ({
  ...(await importOriginal()),
  consumeGoogleLaunch: vi.fn(async ({ userId }) => (userId === '11111111-1111-1111-1111-111111111111' ? launch.url : null)),
}));

import express from 'express';
import oauthRoutes from './oauth.js';
import { imapManager } from '../index.js';
import { query, withTransaction } from '../services/db.js';
import { exchangeGoogleCode, verifyGoogleIdToken, revokeGoogleToken, GoogleOAuthError } from '../services/oauth/googleOAuth.js';
import { recordGoogleGrant } from '../services/oauth/googleApps.js';
import { selectGoogleApp, releaseGoogleSeat } from '../services/oauth/googleAppSelection.js';
import { recordAudit } from '../services/auditLog.js';
import { createOAuthState } from '../services/oauth/oauthState.js';

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const APP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLIENT_SECRET = 'client-secret-value';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const MAIL_SCOPE = 'https://mail.google.com/';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
// The id of the seat reservation the start route took for the flow.
const RESERVATION = 'reservation-1';
const PROJECT_NUMBER = '123456789012';

function buildApp() {
  const app = express();
  // Test-only session: the x-test-user header stands in for the session cookie.
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = userId ? { userId } : {};
    if (userId && req.get('x-test-locked')) req.session.locked = true;
    next();
  });
  app.use('/oauth', oauthRoutes);
  return app;
}

let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Transaction client whose SQL is routed by statement type.
const MAILBOX_LOOKUP = /^\s*SELECT id, oauth_provider, oauth_refresh_token, oauth_app_id, oauth_subject\b[\s\S]*?FROM email_accounts/;
let dbState;
function installDb({ existing = null, appStatus = 'active' } = {}) {
  dbState = { existing, appStatus, calls: [] };
  const client = {
    query: vi.fn(async (sql, params) => {
      dbState.calls.push([sql, params]);
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (MAILBOX_LOOKUP.test(sql)) {
        return { rows: dbState.existing ? [dbState.existing] : [] };
      }
      if (/^\s*SELECT status FROM google_oauth_apps/.test(sql)) {
        return { rows: dbState.appStatus ? [{ status: dbState.appStatus }] : [] };
      }
      if (/^\s*INSERT INTO email_accounts/.test(sql)) return { rows: [{ id: 'new-acc' }] };
      if (/^\s*INSERT INTO account_aliases/.test(sql)) return { rows: [{ id: 'alias-1', name: params[1], email: params[2] }] };
      if (/^\s*UPDATE email_accounts/.test(sql)) return { rows: [], rowCount: 1 };
      if (/^\s*SELECT \* FROM email_accounts WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: params[0], email_address: 'user@gmail.com', oauth_provider: 'google' }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  withTransaction.mockImplementation(async (fn) => fn(client));
}
const sqlCall = (re) => dbState.calls.find(([sql]) => re.test(sql));

const get = (path, { user = USER_ID, locked = false } = {}) =>
  fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(locked ? { 'x-test-locked': '1' } : {}) },
  });

async function startFlow(query = '') {
  const res = await get(`/oauth/google${query}`);
  const location = new URL(res.headers.get('location'));
  return { res, location, state: location.searchParams.get('state') };
}

// The add flow starts at POST /api/oauth/google/start (covered by oauthGoogleApi.test.js). Here its
// state is created the way that route creates it, through the real single-use store.
async function seedAddState(email = 'user@gmail.com', names = {}) {
  const { state } = await createOAuthState({
    provider: 'google', userId: USER_ID, loginHint: email, appId: APP_ID, mode: 'add', email, reservation: RESERVATION, ...names,
  });
  return { state };
}

// A reconnect of ACCOUNT_ID started through GET /oauth/google?account=.
function startReconnect(row = {}) {
  query.mockResolvedValueOnce({
    rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID, ...row }],
  });
  return startFlow(`?account=${ACCOUNT_ID}`);
}

// An existing Gmail mailbox as the callback transaction sees it.
const existingMailbox = (extra = {}) => ({
  id: ACCOUNT_ID, oauth_provider: 'google', oauth_refresh_token: 'enc(old-refresh)', oauth_app_id: APP_ID, ...extra,
});

const callback = (params, opts) => get(`/oauth/google/callback?${new URLSearchParams(params)}`, opts);
const errorLocation = (code) => `/?oauth_error=${code}&oauth_provider=google`;

let logSpies;
beforeEach(() => {
  googleApps.config = { appId: APP_ID, projectNumber: PROJECT_NUMBER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI };
  googleApps.byId = { [APP_ID]: googleApps.config };
  recordGoogleGrant.mockClear();
  redisStore.clear();
  exchangeGoogleCode.mockReset();
  verifyGoogleIdToken.mockReset();
  revokeGoogleToken.mockClear();
  withTransaction.mockReset();
  imapManager.connectAccount.mockClear();
  imapManager.disconnectAccount.mockClear();
  imapManager.clearConnectCooldown.mockClear();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  selection.result = { appId: APP_ID, reserved: false };
  selection.error = null;
  selectGoogleApp.mockClear();
  releaseGoogleSeat.mockClear();
  installDb();
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  logSpies.forEach((s) => s.mockRestore());
});
const loggedText = () => JSON.stringify(logSpies.flatMap((s) => s.mock.calls));

function mockSuccessfulGoogle({ refreshToken = 'refresh-tok', scope = `openid email ${MAIL_SCOPE}`, email = 'user@gmail.com' } = {}) {
  exchangeGoogleCode.mockResolvedValue({
    accessToken: 'access-tok',
    refreshToken,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    scope,
    idToken: 'id-tok',
  });
  verifyGoogleIdToken.mockResolvedValue({ email, name: 'User Name', sub: 'sub-1' });
}

describe('GET /oauth/google', () => {
  it('requires an authenticated MailExpert session', async () => {
    const res = await get(`/oauth/google?account=${ACCOUNT_ID}`, { user: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
  });

  it.each([
    ['no parameters', ''],
    ['a login_hint', '?login_hint=user%40gmail.com'],
    ['an empty account', '?account='],
  ])('refuses a start with %s: adding goes through POST /api/oauth/google/start', async (_name, qs) => {
    query.mockResolvedValue({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google' }] });
    const res = await get(`/oauth/google${qs}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=google');
    expect(selectGoogleApp).not.toHaveBeenCalled();
    expect(redisStore.size).toBe(0);
  });

  it('stores state + PKCE verifier server-side and redirects to Google with the challenge only', async () => {
    const { res, location, state } = await startReconnect();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = location.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe(`openid email profile ${MAIL_SCOPE}`);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('true');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('login_hint')).toBe('user@gmail.com');
    expect(p.has('code_verifier')).toBe(false);
    const saved = JSON.parse([...redisStore.values()][0]);
    expect(saved).toMatchObject({ userId: USER_ID, appId: APP_ID, mode: 'reconnect', email: 'user@gmail.com', accountId: ACCOUNT_ID });
    expect(p.get('code_challenge')).toBe(createHash('sha256').update(saved.codeVerifier).digest('base64url'));
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // The screen-lock gate in index.js covers only /api; /oauth is mounted outside it.
  it('refuses to start from a locked session', async () => {
    query.mockResolvedValue({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google' }] });
    const res = await get(`/oauth/google?account=${ACCOUNT_ID}`, { locked: true });
    expect(res.headers.get('location')).toBe('/?oauth_error=locked&oauth_provider=google');
    expect(selectGoogleApp).not.toHaveBeenCalled();
    expect(redisStore.size).toBe(0);
  });

  it('redirects with not_configured when the chosen app is gone', async () => {
    googleApps.byId = {};
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID }] });
    const res = await get(`/oauth/google?account=${ACCOUNT_ID}`);
    expect(res.headers.get('location')).toBe('/?oauth_error=not_configured&oauth_provider=google');
  });
});

describe('GET /oauth/google/launch', () => {
  it('requires a session', async () => {
    const res = await get(`/oauth/google/launch?flow=${'F'.repeat(43)}`, { user: null });
    expect(res.status).toBe(401);
  });

  it('forwards to the stored Google URL', async () => {
    launch.url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}`;
    const res = await get(`/oauth/google/launch?flow=${'F'.repeat(43)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(launch.url);
  });

  it('refuses a launch path minted before the session locked', async () => {
    launch.url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}`;
    const res = await get(`/oauth/google/launch?flow=${'F'.repeat(43)}`, { locked: true });
    expect(res.headers.get('location')).toBe('/?oauth_error=locked&oauth_provider=google');
  });

  it('sends an unknown, used or foreign flow back with invalid_state', async () => {
    launch.url = null;
    const res = await get(`/oauth/google/launch?flow=${'F'.repeat(43)}`);
    expect(res.headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=google');
  });
});

describe('GET /oauth/google/callback', () => {
  // A (re)consent brings fresh tokens, so any auth cooldown from the old grant must be
  // lifted before the connect attempt or the gate in connectAccount would skip it.
  const expectCooldownClearedBeforeConnect = (id) => {
    expect(imapManager.clearConnectCooldown).toHaveBeenCalledWith(id);
    expect(imapManager.clearConnectCooldown.mock.invocationCallOrder[0])
      .toBeLessThan(imapManager.connectAccount.mock.invocationCallOrder[0]);
  };

  it('creates a Gmail account with fixed hosts, encrypted tokens and unified inbox off', async () => {
    mockSuccessfulGoogle();
    const { state } = await seedAddState();
    const saved = JSON.parse([...redisStore.values()][0]);

    const res = await callback({ code: 'auth-code-xyz', state });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=created');
    expect(exchangeGoogleCode).toHaveBeenCalledWith({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: 'auth-code-xyz', codeVerifier: saved.codeVerifier, redirectUri: REDIRECT_URI,
    });
    expect(verifyGoogleIdToken).toHaveBeenCalledWith({ idToken: 'id-tok', clientId: CLIENT_ID });

    const lock = sqlCall(/pg_advisory_xact_lock/);
    expect(lock[0]).toMatch(/hashtext\(\$1\)/);
    expect(lock[1]).toEqual([`oauth-account:user@gmail.com`]);

    const [insertSql, insertParams] = sqlCall(/^\s*INSERT INTO email_accounts/);
    expect(insertSql).toMatch(/'imap\.gmail\.com', 993, true/);
    expect(insertSql).toMatch(/'smtp\.gmail\.com', 465, 'SSL'/);
    expect(insertSql).toMatch(/'google'/);
    expect(insertSql).toMatch(/include_in_unified_inbox,\s*oauth_app_id, oauth_subject, thread_mode/);
    expect(insertSql).toMatch(/false, false, true,\s*\$8, \$9, \$10, \$11\)\s*RETURNING id/);
    expect(insertParams).toContain('enc(access-tok)');
    expect(insertParams).toContain('enc(refresh-tok)');
    expect(insertParams).not.toContain('access-tok');
    expect(insertParams).not.toContain('refresh-tok');
    // No sender name from the form: sender_name stays empty and the mailbox sends under its name.
    expect(insertParams.slice(7)).toEqual([APP_ID, 'sub-1', 'gmail', null]);
    expect(sqlCall(/^\s*INSERT INTO account_aliases/)).toBeUndefined();
    expect(recordGoogleGrant).toHaveBeenCalledWith({ projectNumber: PROJECT_NUMBER, email: 'user@gmail.com', sub: 'sub-1' });

    expect(imapManager.connectAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-acc' }));
    expectCooldownClearedBeforeConnect('new-acc');
  });

  it('sends under the names from the Gmail form: the main one on the row, the second as an alias', async () => {
    mockSuccessfulGoogle();
    const { state } = await seedAddState('user@gmail.com', { senderName: 'Иван Петров', senderNameAlt: 'Ivan Petrov' });

    const res = await callback({ code: 'auth-code-xyz', state });

    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=created');
    const [, insertParams] = sqlCall(/^\s*INSERT INTO email_accounts/);
    expect(insertParams[10]).toBe('Иван Петров');
    const [, aliasParams] = sqlCall(/^\s*INSERT INTO account_aliases/);
    expect(aliasParams).toEqual(['new-acc', 'Ivan Petrov', 'user@gmail.com']);
  });

  it('adds no second name equal to the Google profile name the mailbox sends under', async () => {
    mockSuccessfulGoogle();
    const { state } = await seedAddState('user@gmail.com', { senderNameAlt: 'user name' });

    await callback({ code: 'auth-code-xyz', state });

    expect(sqlCall(/^\s*INSERT INTO account_aliases/)).toBeUndefined();
  });

  it('tells the user when the second name was dropped as equal to the Google profile name', async () => {
    mockSuccessfulGoogle();
    const { state } = await seedAddState('user@gmail.com', { senderNameAlt: 'user name' });

    const res = await callback({ code: 'auth-code-xyz', state });

    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=created&oauth_notice=sender_name_duplicate');
  });

  it('adds no notice when the second name is kept', async () => {
    mockSuccessfulGoogle();
    const { state } = await seedAddState('user@gmail.com', { senderNameAlt: 'Other Name' });

    const res = await callback({ code: 'auth-code-xyz', state });

    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=created');
  });

  it('updates an existing account, keeps the stored refresh token and clears the reconnect flag', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox() });
    mockSuccessfulGoogle({ refreshToken: null, email: 'User@Gmail.com' });

    const res = await callback({ code: 'c', state });

    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=updated');
    const lock = sqlCall(/pg_advisory_xact_lock/);
    expect(lock[1]).toEqual([`oauth-account:user@gmail.com`]);
    expect(sqlCall(MAILBOX_LOOKUP)[0]).toMatch(/lower\(email_address\) = lower\(\$1\)/);
    const [updateSql, updateParams] = sqlCall(/^\s*UPDATE email_accounts/);
    expect(updateSql).toMatch(/oauth_refresh_token = COALESCE\(\$2, oauth_refresh_token\)/);
    expect(updateSql).toMatch(/oauth_reconnect_required = false/);
    expect(updateSql).toMatch(/sync_error = NULL/);
    expect(updateSql).toMatch(/oauth_provider = 'google'/);
    expect(updateParams[0]).toBe('enc(access-tok)');
    expect(updateParams[1]).toBeNull();
    expect(updateSql).toMatch(/oauth_app_id = \$4, oauth_subject = \$5/);
    expect(updateParams.slice(3)).toEqual([APP_ID, 'sub-1', ACCOUNT_ID]);
    // An existing mailbox keeps the threading mode it has; only a new one starts in gmail mode.
    expect(updateSql).not.toMatch(/thread_mode/);
    expect(sqlCall(/^\s*INSERT INTO email_accounts/)).toBeUndefined();
    await vi.waitFor(() => expect(imapManager.connectAccount).toHaveBeenCalled());
    expectCooldownClearedBeforeConnect(ACCOUNT_ID);
  });

  it('rejects a new account when Google returned no refresh token', async () => {
    mockSuccessfulGoogle({ refreshToken: null });
    const { state } = await seedAddState();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('missing_refresh_token'));
    expect(sqlCall(/^\s*INSERT INTO email_accounts/)).toBeUndefined();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('refuses a reconnect without a new refresh token when the stored one is the token that failed', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox({ oauth_reconnect_required: true }) });
    mockSuccessfulGoogle({ refreshToken: null });
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('missing_refresh_token'));
    expect(sqlCall(/^\s*UPDATE email_accounts/)).toBeUndefined();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('accepts a reconnect of a flagged mailbox when Google returned a new refresh token', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox({ oauth_reconnect_required: true }) });
    mockSuccessfulGoogle({ refreshToken: 'fresh-refresh' });
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=updated');
    expect(sqlCall(/^\s*UPDATE email_accounts/)[1][1]).toBe('enc(fresh-refresh)');
  });

  it('does not create a mailbox through an app disabled during the code exchange', async () => {
    const { state } = await seedAddState();
    installDb({ appStatus: 'disabled' });
    mockSuccessfulGoogle();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('not_configured'));
    expect(sqlCall(/^\s*SELECT status FROM google_oauth_apps/)[0]).toMatch(/FOR SHARE/);
    expect(sqlCall(/^\s*INSERT INTO email_accounts/)).toBeUndefined();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
    // No mailbox keeps this grant: the fresh token is revoked.
    expect(revokeGoogleToken).toHaveBeenCalledWith('refresh-tok');
  });

  it('does not clear the reconnect flag through an app disabled during the code exchange', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox({ oauth_reconnect_required: true }), appStatus: 'disabled' });
    mockSuccessfulGoogle();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('not_configured'));
    expect(sqlCall(/^\s*UPDATE email_accounts/)).toBeUndefined();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('does not connect through an app deleted during the code exchange', async () => {
    const { state } = await seedAddState();
    installDb({ appStatus: null });
    mockSuccessfulGoogle();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('not_configured'));
    expect(sqlCall(/^\s*INSERT INTO email_accounts/)).toBeUndefined();
  });

  it('rejects an existing account without any refresh token to keep', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox({ oauth_refresh_token: null }) });
    mockSuccessfulGoogle({ refreshToken: null });
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('missing_refresh_token'));
    expect(sqlCall(/^\s*UPDATE email_accounts/)).toBeUndefined();
  });

  it('maps a user cancellation to access_denied and burns the state', async () => {
    const { state } = await seedAddState();
    const res = await callback({ error: 'access_denied', state });
    expect(res.headers.get('location')).toBe(errorLocation('access_denied'));
    expect(redisStore.size).toBe(0);
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('maps any other provider error to authentication_failed without echoing it', async () => {
    const { state } = await seedAddState();
    const res = await callback({ error: 'server_error<script>', error_description: 'raw google text', state });
    const location = res.headers.get('location');
    expect(location).toBe(errorLocation('authentication_failed'));
    expect(loggedText()).not.toMatch(/raw google text|server_error<script>/);
  });

  it.each([
    ['missing', {}],
    ['unknown', { state: 'A'.repeat(43) }],
    ['malformed', { state: 'nope' }],
  ])('rejects a %s state with invalid_state', async (_label, params) => {
    const res = await callback({ code: 'c', ...params });
    expect(res.headers.get('location')).toBe(errorLocation('invalid_state'));
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('accepts a state only once', async () => {
    mockSuccessfulGoogle();
    const { state } = await seedAddState();
    expect((await callback({ code: 'c', state })).headers.get('location')).toMatch(/oauth_success=google/);
    const replay = await callback({ code: 'c', state });
    expect(replay.headers.get('location')).toBe(errorLocation('invalid_state'));
    expect(exchangeGoogleCode).toHaveBeenCalledTimes(1);
  });

  it('rejects a state issued to a different MailExpert user', async () => {
    const { state } = await seedAddState();
    const res = await callback({ code: 'c', state }, { user: '22222222-2222-2222-2222-222222222222' });
    expect(res.headers.get('location')).toBe(errorLocation('invalid_state'));
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
    expect(releaseGoogleSeat).toHaveBeenCalledWith(APP_ID, 'user@gmail.com', RESERVATION);
    expect(releaseGoogleSeat).toHaveBeenCalledTimes(1);
  });

  it('redirects with not_configured when the integration was removed mid-flow', async () => {
    const { state } = await seedAddState();
    googleApps.byId = {};
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('not_configured'));
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('maps a failed code exchange to authentication_failed without leaking the code', async () => {
    exchangeGoogleCode.mockRejectedValue(new GoogleOAuthError('authentication_failed', { oauthError: 'invalid_grant' }));
    const { state } = await seedAddState();
    const res = await callback({ code: 'secret-auth-code', state });
    expect(res.headers.get('location')).toBe(errorLocation('authentication_failed'));
    expect(loggedText()).not.toMatch(/secret-auth-code|client-secret-value/);
    expect(releaseGoogleSeat).toHaveBeenCalledWith(APP_ID, 'user@gmail.com', RESERVATION);
    expect(releaseGoogleSeat).toHaveBeenCalledTimes(1);
  });

  it('maps an unexpected exception to authentication_failed without logging its message', async () => {
    exchangeGoogleCode.mockRejectedValue(new Error('boom access-tok refresh-tok'));
    const { state } = await seedAddState();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('authentication_failed'));
    expect(loggedText()).not.toMatch(/access-tok|refresh-tok/);
  });

  it('journals the grant but refuses a consent without the full Gmail scope', async () => {
    mockSuccessfulGoogle({ scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' });
    const { state } = await seedAddState();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('scope_missing'));
    expect(recordGoogleGrant).toHaveBeenCalledWith({ projectNumber: PROJECT_NUMBER, email: 'user@gmail.com', sub: 'sub-1' });
    expect(withTransaction).not.toHaveBeenCalled();
    expect(revokeGoogleToken).toHaveBeenCalledWith('refresh-tok');
  });

  it('rejects an unverified Google email', async () => {
    mockSuccessfulGoogle();
    verifyGoogleIdToken.mockRejectedValue(new GoogleOAuthError('email_not_verified'));
    const { state } = await seedAddState();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('email_not_verified'));
    expect(recordGoogleGrant).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('never logs tokens, codes, verifiers or the client secret across the success path', async () => {
    mockSuccessfulGoogle();
    const { state } = await seedAddState();
    const saved = JSON.parse([...redisStore.values()][0]);
    await callback({ code: 'auth-code-xyz', state });
    const logged = loggedText();
    for (const secret of ['auth-code-xyz', 'access-tok', 'refresh-tok', 'id-tok', CLIENT_SECRET, saved.codeVerifier, state]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('finishes through the app chosen at start even when the default app changed', async () => {
    mockSuccessfulGoogle();
    const { state } = await seedAddState();
    googleApps.config = { appId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', clientId: '999-other.apps.googleusercontent.com', clientSecret: 'other', redirectUri: REDIRECT_URI };

    await callback({ code: 'c', state });

    expect(exchangeGoogleCode).toHaveBeenCalledWith(expect.objectContaining({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }));
    expect(verifyGoogleIdToken).toHaveBeenCalledWith({ idToken: 'id-tok', clientId: CLIENT_ID });
  });

  it('refuses to move a mailbox to another app without a new refresh token', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox({ oauth_app_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }) });
    mockSuccessfulGoogle({ refreshToken: null });
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('missing_refresh_token'));
    expect(sqlCall(/^\s*UPDATE email_accounts/)).toBeUndefined();
  });

  it.each([
    ['the removed upsert mode', { mode: 'upsert', email: null }],
    ['no mode (a state from before the modes)', { mode: null, email: null }],
    ['an add without an address', { mode: 'add', email: null }],
  ])('refuses a state with %s as invalid_state before talking to Google', async (_name, extra) => {
    const { state } = await createOAuthState({ provider: 'google', userId: USER_ID, appId: APP_ID, ...extra });
    mockSuccessfulGoogle();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('invalid_state'));
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

describe('Google consent is journaled', () => {
  const OLD_APP_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  beforeEach(() => { recordAudit.mockClear(); });

  it('records a new mailbox as added by the user who started the flow', async () => {
    mockSuccessfulGoogle();
    const { state } = await seedAddState();
    await callback({ code: 'c', state });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: USER_ID, accountId: 'new-acc', action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: 'google' } },
    ]);
  });

  it('records a reconsent through the same app as a reconnect only', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox() });
    mockSuccessfulGoogle({ refreshToken: null });
    await callback({ code: 'c', state });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: USER_ID, accountId: ACCOUNT_ID, action: 'mailbox.reconnected', details: { oauthProvider: 'google' } },
    ]);
  });

  it('records a move to another app as a connection change', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox({ oauth_app_id: OLD_APP_ID }) });
    mockSuccessfulGoogle();
    await callback({ code: 'c', state });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: USER_ID, accountId: ACCOUNT_ID, action: 'mailbox.reconnected', details: { oauthProvider: 'google' } },
      { actorUserId: USER_ID, accountId: ACCOUNT_ID, action: 'mailbox.connection_changed', details: { fields: ['oauth_app_id'] } },
    ]);
  });

  it('records nothing when the consent is refused', async () => {
    mockSuccessfulGoogle({ scope: 'openid email' });
    const { state } = await seedAddState();
    await callback({ code: 'c', state });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe('reconnect by mailbox id', () => {
  it('starts a reconnect for any signed-in user with the mailbox address as login_hint', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'User@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID }] });
    const { location } = await startFlow(`?account=${ACCOUNT_ID}`);
    expect(location.searchParams.get('login_hint')).toBe('user@gmail.com');
    const saved = JSON.parse([...redisStore.values()][0]);
    expect(saved).toMatchObject({ mode: 'reconnect', email: 'user@gmail.com', accountId: ACCOUNT_ID, appId: APP_ID });
    expect(selectGoogleApp).toHaveBeenCalledWith({ email: 'user@gmail.com', account: expect.objectContaining({ id: ACCOUNT_ID }) });
  });

  it.each([
    ['a malformed id', 'nope', null],
    ['a missing mailbox', ACCOUNT_ID, []],
    ['a mailbox that is not Google', ACCOUNT_ID, [{ id: ACCOUNT_ID, email_address: 'x@corp.example', oauth_provider: null }]],
  ])('refuses %s with invalid_state', async (_name, id, rows) => {
    if (rows) query.mockResolvedValueOnce({ rows });
    const res = await get(`/oauth/google?account=${id}`);
    expect(res.headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=google');
  });

  it.each(['no_app_capacity', 'not_configured'])('redirects with %s when no app can take it', async (code) => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: null }] });
    selection.error = code;
    const res = await get(`/oauth/google?account=${ACCOUNT_ID}`);
    expect(res.headers.get('location')).toBe(`/?oauth_error=${code}&oauth_provider=google`);
  });

  it('keeps the reservation of a reconnect moving to another app in its state and releases exactly it', async () => {
    selection.result = { appId: APP_ID, reserved: true, reservation: RESERVATION };
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: null }] });
    const { state } = await startFlow(`?account=${ACCOUNT_ID}`);
    expect(JSON.parse([...redisStore.values()][0])).toMatchObject({ reservation: RESERVATION });
    await callback({ state, error: 'access_denied' });
    expect(releaseGoogleSeat).toHaveBeenCalledWith(APP_ID, 'user@gmail.com', RESERVATION);
  });

  it('frees a reserved seat when the resolved app is not configured', async () => {
    selection.result = { appId: APP_ID, reserved: true, reservation: RESERVATION };
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: null }] });
    googleApps.byId = {};
    const res = await get(`/oauth/google?account=${ACCOUNT_ID}`);
    expect(res.headers.get('location')).toBe('/?oauth_error=not_configured&oauth_provider=google');
    expect(releaseGoogleSeat).toHaveBeenCalledWith(APP_ID, 'user@gmail.com', RESERVATION);
  });

  it('reports invalid_state when the reconnect target mailbox is gone by callback', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID }] });
    const { state } = await startFlow(`?account=${ACCOUNT_ID}`);
    installDb({ existing: null });
    mockSuccessfulGoogle();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('invalid_state'));
  });
});

describe('callback refusals after Google issued tokens', () => {
  it('refuses a different Google account than the one asked for and revokes its new token', async () => {
    const { state } = await seedAddState(); // no mailbox → add
    mockSuccessfulGoogle({ email: 'other@gmail.com' });
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('account_mismatch'));
    expect(recordGoogleGrant).toHaveBeenCalledWith(expect.objectContaining({ email: 'other@gmail.com' }));
    expect(revokeGoogleToken).toHaveBeenCalledWith('refresh-tok');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('does not revoke when that address already has a mailbox on this app', async () => {
    const { state } = await seedAddState();
    mockSuccessfulGoogle({ email: 'other@gmail.com' });
    query.mockImplementation(async (sql) => (/oauth_app_id = \$2/.test(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [] }));
    await callback({ code: 'c', state });
    expect(revokeGoogleToken).not.toHaveBeenCalled();
  });

  it('reports already_connected when the mailbox appeared between start and callback, and does not revoke it', async () => {
    const { state } = await seedAddState(); // add
    installDb({ existing: { id: 'acc-1', oauth_provider: 'google', oauth_refresh_token: 'enc(old)', oauth_app_id: APP_ID, oauth_subject: 'sub-1' } });
    mockSuccessfulGoogle();
    // The address that raced us to `already_connected` has a mailbox on this app: revoking the
    // fresh token would cut that mailbox off too.
    query.mockImplementation(async (sql) => (/oauth_app_id = \$2/.test(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [] }));
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('already_connected'));
    expect(revokeGoogleToken).not.toHaveBeenCalled();
  });

  it('refuses a reconnect signed in as another Google identity of the same address', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID }] });
    const { state } = await startFlow(`?account=${ACCOUNT_ID}`);
    installDb({ existing: { id: ACCOUNT_ID, oauth_provider: 'google', oauth_refresh_token: 'enc(old)', oauth_app_id: APP_ID, oauth_subject: 'sub-OLD' } });
    mockSuccessfulGoogle(); // sub-1
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('account_mismatch'));
  });

  it('releases the reservation once the grant is journaled on success, and still exactly once on a refusal', async () => {
    const { state } = await seedAddState();
    mockSuccessfulGoogle();
    await callback({ code: 'c', state });
    expect(releaseGoogleSeat).toHaveBeenCalledWith(APP_ID, 'user@gmail.com', RESERVATION);
    expect(releaseGoogleSeat).toHaveBeenCalledTimes(1);
    expect(recordGoogleGrant.mock.invocationCallOrder[0]).toBeLessThan(releaseGoogleSeat.mock.invocationCallOrder[0]);

    releaseGoogleSeat.mockClear();
    recordGoogleGrant.mockClear();
    const second = await seedAddState();
    await callback({ state: second.state, error: 'access_denied' });
    expect(releaseGoogleSeat).toHaveBeenCalledWith(APP_ID, 'user@gmail.com', RESERVATION);
    expect(releaseGoogleSeat).toHaveBeenCalledTimes(1);
  });
});

describe('reconnect onto another app', () => {
  it('revokes the old refresh token after the move', async () => {
    const NEW_APP = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    googleApps.byId[NEW_APP] = { ...googleApps.config, appId: NEW_APP };
    selection.result = { appId: NEW_APP, reserved: true, reservation: RESERVATION };
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID }] });
    const { state } = await startFlow(`?account=${ACCOUNT_ID}`);
    installDb({ existing: { id: ACCOUNT_ID, oauth_provider: 'google', oauth_refresh_token: 'old-refresh', oauth_app_id: APP_ID, oauth_subject: 'sub-1' } });
    mockSuccessfulGoogle();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=updated');
    await vi.waitFor(() => expect(revokeGoogleToken).toHaveBeenCalledWith('old-refresh'));
  });
});
