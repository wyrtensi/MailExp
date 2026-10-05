import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// oauth.js imports imapManager from ../index.js (heavy load-time side effects).
vi.mock('../index.js', () => ({
  imapManager: {
    connectAccount: vi.fn(async () => true),
    disconnectAccount: vi.fn(async () => {}),
    clearConnectCooldown: vi.fn(),
  },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  decrypt: (v) => v,
}));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
// ID-token signature checks are out of scope here; the route only needs the claims.
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(),
}));

import express from 'express';
import { jwtVerify } from 'jose';
import oauthRoutes from './oauth.js';
import { imapManager } from '../index.js';
import { query, withTransaction } from '../services/db.js';
import { recordAudit } from '../services/auditLog.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = 'contoso-tenant';
const TID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBJECT = `${TID}:${OID}`;
const NONCE = 'test-nonce';
const TOKENS = { access_token: 'ms-at', refresh_token: 'ms-rt', expires_in: 3600, id_token: 'ms-id-token' };
// A verified address: email vouched for by xms_edov.
const VERIFIED = { tid: TID, oid: OID, email: 'user@contoso.com', xms_edov: true, name: 'User' };

let claims;
let session;
function buildApp() {
  const app = express();
  app.use(express.json());
  // Test-only session: the x-test-user header stands in for the session cookie. `session` holds
  // what GET /oauth/microsoft would have stored (the nonce and the flow).
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = userId ? Object.assign(session, { userId, save: (cb) => cb() }) : {};
    next();
  });
  app.use('/oauth', oauthRoutes);
  return app;
}

const realFetch = globalThis.fetch;
let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Transaction client. `row` is the mailbox already stored under the signed-in address, if any.
let dbCalls;
let row;
function installDb() {
  dbCalls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      dbCalls.push([sql, params]);
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      // Reconnect: the mailbox named by id. Add: any mailbox with the address.
      if (/^\s*SELECT id, email_address, oauth_provider, oauth_subject, mail_node FROM email_accounts WHERE id = \$1/.test(sql)) {
        return { rows: row && row.id === params[0] ? [row] : [] };
      }
      if (/^\s*SELECT id, email_address, oauth_provider, oauth_subject, mail_node FROM email_accounts\s+WHERE lower\(email_address\)/.test(sql)) {
        return { rows: row && row.email_address === params[0] ? [row] : [] };
      }
      if (/^\s*UPDATE email_accounts/.test(sql)) return { rows: [], rowCount: 1 };
      if (/^\s*INSERT INTO email_accounts/.test(sql)) return { rows: [{ id: 'ms-new' }] };
      if (/^\s*SELECT \* FROM email_accounts WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: params[0], email_address: 'user@contoso.com', oauth_provider: 'microsoft' }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  withTransaction.mockImplementation(async (fn) => fn(client));
}
const updateCall = () => dbCalls.find(([sql]) => /^\s*UPDATE email_accounts/.test(sql));
const insertCall = () => dbCalls.find(([sql]) => /^\s*INSERT INTO email_accounts/.test(sql));
const wroteAccount = () => !!(updateCall() || insertCall());

// The mailbox a reconnect names, as GET /oauth/microsoft?account= and the device start read it.
// `signedInAdmin` is what isAdminRequest reads for the signed-in user.
let target;
let signedInAdmin;
function installQuery() {
  query.mockReset().mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT id, email_address, oauth_provider, mail_node FROM email_accounts')) return { rows: target ? [target] : [] };
    if (sql.startsWith('SELECT is_admin, disabled_at FROM users')) return { rows: [{ is_admin: signedInAdmin, disabled_at: null }] };
    return { rows: [] };
  });
}

// Requests to the test server go through; Microsoft endpoints get canned responses.
function stubMicrosoft(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, init);
    return handler(href, init);
  }));
}
const json = (ok, body) => ({ ok, json: async () => body });

const headers = { 'x-test-user': USER_ID };
const callback = () => fetch(`${base}/oauth/microsoft/callback?code=auth-code&state=${NONCE}`, { redirect: 'manual', headers });
const startReconnect = () => { session = { oauthNonce: NONCE, oauthUserId: USER_ID, oauthMode: 'reconnect', oauthAccountId: ACCOUNT_ID }; };
const startAdd = () => { session = { oauthNonce: NONCE, oauthUserId: USER_ID, oauthMode: 'add', oauthAccountId: null }; };
const MS_ROW = { id: ACCOUNT_ID, email_address: 'user@contoso.com', oauth_provider: 'microsoft', oauth_subject: SUBJECT, mail_node: false };

let logSpies;
beforeEach(() => {
  process.env.MS_CLIENT_ID = 'ms-client';
  process.env.MS_CLIENT_SECRET = 'ms-secret';
  process.env.MS_TENANT_ID = TENANT_ID;
  process.env.MS_REDIRECT_URI = 'https://mail.example.com/oauth/microsoft/callback';
  withTransaction.mockReset();
  imapManager.connectAccount.mockClear();
  imapManager.disconnectAccount.mockClear();
  imapManager.clearConnectCooldown.mockClear();
  recordAudit.mockClear();
  claims = { ...VERIFIED };
  jwtVerify.mockReset().mockImplementation(async () => ({ payload: claims }));
  row = { ...MS_ROW };
  target = { id: ACCOUNT_ID, email_address: 'user@contoso.com', oauth_provider: 'microsoft', mail_node: false };
  signedInAdmin = true;
  installDb();
  installQuery();
  startReconnect();
  stubMicrosoft(() => json(true, TOKENS));
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;
  delete process.env.MS_TENANT_ID;
  delete process.env.MS_REDIRECT_URI;
  logSpies.forEach((s) => s.mockRestore());
});

describe('starting a Microsoft flow', () => {
  const start = (query = '') => fetch(`${base}/oauth/microsoft${query}`, { redirect: 'manual', headers });

  it('adds a mailbox without ?account', async () => {
    session = {};
    const res = await start();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/login\.microsoftonline\.com\/contoso-tenant\/oauth2\/v2\.0\/authorize\?/);
    expect(session).toMatchObject({ oauthMode: 'add', oauthAccountId: null });
  });

  it('reconnects the Microsoft mailbox ?account names, hinting its address', async () => {
    session = {};
    const res = await start(`?account=${ACCOUNT_ID}`);
    expect(new URL(res.headers.get('location')).searchParams.get('login_hint')).toBe('user@contoso.com');
    expect(session).toMatchObject({ oauthMode: 'reconnect', oauthAccountId: ACCOUNT_ID });
  });

  it.each([
    ['a mailbox of another provider', { oauth_provider: 'google' }],
    ['a password mailbox', { oauth_provider: null }],
    ['a mail node mailbox', { mail_node: true }],
  ])('refuses to reconnect %s', async (_label, patch) => {
    session = {};
    target = { ...target, ...patch };
    const res = await start(`?account=${ACCOUNT_ID}`);
    expect(res.headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=microsoft');
    expect(session.oauthNonce).toBeUndefined();
  });

  it('answers a code, not a 500, when only the device-code flow is set up', async () => {
    delete process.env.MS_REDIRECT_URI;
    session = {};
    expect((await start()).headers.get('location')).toBe('/?oauth_error=redirect_not_configured&oauth_provider=microsoft');
    // A reconnect names its mailbox, so the panel can run the device-code flow for it.
    expect((await start(`?account=${ACCOUNT_ID}`)).headers.get('location'))
      .toBe(`/?oauth_error=redirect_not_configured&oauth_provider=microsoft&oauth_account=${ACCOUNT_ID}`);
    expect(session.oauthNonce).toBeUndefined();
  });

  // The screen-lock gate in index.js covers only /api; /oauth is mounted outside it.
  it('refuses to start from a locked session', async () => {
    session = { locked: true };
    const res = await start(`?account=${ACCOUNT_ID}`);
    expect(res.headers.get('location')).toBe('/?oauth_error=locked&oauth_provider=microsoft');
    expect(session.oauthNonce).toBeUndefined();
  });

  it('answers not_configured without a client id', async () => {
    delete process.env.MS_CLIENT_ID;
    expect((await start()).headers.get('location')).toBe('/?oauth_error=not_configured&oauth_provider=microsoft');
  });

  it('refuses a malformed account id', async () => {
    session = {};
    expect((await start('?account=nope')).headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=microsoft');
  });

  // A manual Microsoft connect is an administrator's path: neither a reconnect nor an add starts
  // for anyone else, and nothing is stored for the callback to finish.
  it.each([['a reconnect', `?account=${ACCOUNT_ID}`], ['an add', '']])('refuses %s to a user who is not an administrator', async (_label, qs) => {
    signedInAdmin = false;
    session = {};
    const res = await start(qs);
    expect(res.headers.get('location')).toBe('/?oauth_error=admin_required&oauth_provider=microsoft');
    expect(session.oauthNonce).toBeUndefined();
  });
});

describe('the mailbox address comes only from a verified claim', () => {
  it.each([
    ['email with xms_edov', { email: 'User@Contoso.com', xms_edov: true }, 'user@contoso.com'],
    ['verified_primary_email', { verified_primary_email: ['user@contoso.com'] }, 'user@contoso.com'],
    ['a member UPN', { upn: 'user@contoso.com' }, 'user@contoso.com'],
  ])('accepts %s', async (_label, verifiedClaims, expected) => {
    startAdd();
    row = null;
    claims = { tid: TID, oid: OID, preferred_username: 'someone-else@fabrikam.com', ...verifiedClaims };
    const res = await callback();
    expect(res.headers.get('location')).toBe('/?oauth_success=microsoft');
    expect(insertCall()[1][2]).toBe(expected);
  });

  it.each([
    ['email without xms_edov', { email: 'victim@fabrikam.com' }],
    ['email with xms_edov false', { email: 'victim@fabrikam.com', xms_edov: false }],
    ['preferred_username alone', { preferred_username: 'victim@fabrikam.com' }],
    ['a guest UPN', { upn: 'victim_fabrikam.com#EXT#@contoso.onmicrosoft.com' }],
  ])('refuses %s', async (_label, unverifiedClaims) => {
    claims = { tid: TID, oid: OID, ...unverifiedClaims };
    const res = await callback();
    expect(res.headers.get('location')).toBe('/?oauth_error=email_not_verified&oauth_provider=microsoft');
    expect(withTransaction).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('takes verified_primary_email only when MS_TENANT_ID names one tenant', async () => {
    process.env.MS_TENANT_ID = 'common';
    claims = { tid: TID, oid: OID, iss: `https://login.microsoftonline.com/${TID}/v2.0`, verified_primary_email: ['user@contoso.com'] };
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=email_not_verified&oauth_provider=microsoft');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('refuses a token without its tenant and object ids', async () => {
    claims = { email: 'user@contoso.com', xms_edov: true };
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=authentication_failed&oauth_provider=microsoft');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('refuses tokens without an ID token', async () => {
    stubMicrosoft(() => json(true, { ...TOKENS, id_token: undefined }));
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=authentication_failed&oauth_provider=microsoft');
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

describe('adding a Microsoft mailbox', () => {
  beforeEach(() => { startAdd(); stubMicrosoft(() => json(true, TOKENS)); });

  it('creates it with the Microsoft subject', async () => {
    row = null;
    expect((await callback()).headers.get('location')).toBe('/?oauth_success=microsoft');
    const [sql, params] = insertCall();
    expect(sql).toMatch(/oauth_subject/);
    expect(params).toContain(SUBJECT);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: USER_ID, accountId: 'ms-new', action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: 'microsoft' },
    });
  });

  it.each([
    ['a Microsoft mailbox', MS_ROW],
    ['a password mailbox', { id: 'pw', email_address: 'user@contoso.com', oauth_provider: null, oauth_subject: null, mail_node: false }],
    ['a Gmail mailbox', { id: 'gm', email_address: 'user@contoso.com', oauth_provider: 'google', oauth_subject: 'google-sub', mail_node: false }],
    ['a mail node mailbox', { id: 'node', email_address: 'user@contoso.com', oauth_provider: null, oauth_subject: null, mail_node: true }],
  ])('never overwrites %s with the same address', async (_label, existing) => {
    row = existing;
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=already_connected&oauth_provider=microsoft');
    expect(wroteAccount()).toBe(false);
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });
});

describe('reconnecting a Microsoft mailbox', () => {
  beforeEach(() => { stubMicrosoft(() => json(true, TOKENS)); });

  it('renews the tokens, clears the reconnect flag and the cooldown, and keeps the name', async () => {
    const res = await callback();
    expect(res.headers.get('location')).toBe('/?oauth_success=microsoft');
    const [sql, params] = updateCall();
    expect(sql).toMatch(/oauth_reconnect_required\s*=\s*false/);
    expect(sql).toMatch(/sync_error\s*=\s*NULL/);
    expect(sql).toMatch(/WHERE id = \$6 AND oauth_provider = 'microsoft' AND mail_node IS NOT TRUE\s+AND \(oauth_subject IS NULL OR oauth_subject = \$5\)/);
    expect(sql).not.toMatch(/\bname\s*=/);
    expect(params[4]).toBe(SUBJECT);
    expect(params[5]).toBe(ACCOUNT_ID);
    await vi.waitFor(() => expect(imapManager.connectAccount).toHaveBeenCalled());
    expect(imapManager.clearConnectCooldown.mock.invocationCallOrder[0])
      .toBeLessThan(imapManager.connectAccount.mock.invocationCallOrder[0]);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: USER_ID, accountId: ACCOUNT_ID, action: 'mailbox.reconnected', details: { oauthProvider: 'microsoft' },
    });
  });

  it('refuses another Microsoft user with the same address', async () => {
    claims = { ...VERIFIED, oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=account_mismatch&oauth_provider=microsoft');
    expect(wroteAccount()).toBe(false);
  });

  it('refuses the same object id from another tenant', async () => {
    claims = { ...VERIFIED, tid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=account_mismatch&oauth_provider=microsoft');
    expect(wroteAccount()).toBe(false);
  });

  it('refuses a sign-in to another address than the mailbox being reconnected has', async () => {
    row = { ...MS_ROW, email_address: 'Shared@Contoso.com' };
    claims = { ...VERIFIED, email: 'other@contoso.com' };
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=account_mismatch&oauth_provider=microsoft');
    expect(wroteAccount()).toBe(false);
  });

  it('reads the mailbox to reconnect by its id, not by the address', async () => {
    row = { ...MS_ROW, email_address: 'User@Contoso.com' };
    expect((await callback()).headers.get('location')).toBe('/?oauth_success=microsoft');
    expect(dbCalls.some(([sql, params]) => /WHERE id = \$1/.test(sql) && params[0] === ACCOUNT_ID)).toBe(true);
    expect(dbCalls.some(([sql]) => /lower\(email_address\)/.test(sql))).toBe(false);
  });

  it('refuses a mailbox that is gone', async () => {
    row = null;
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=microsoft');
    expect(wroteAccount()).toBe(false);
  });

  it.each([
    ['a password mailbox', { oauth_provider: null, oauth_subject: null }],
    ['a mail node mailbox', { oauth_provider: 'microsoft', mail_node: true }],
  ])('never touches %s', async (_label, patch) => {
    row = { ...MS_ROW, ...patch };
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=microsoft');
    expect(wroteAccount()).toBe(false);
  });

  it('records nothing when the mailbox changed before the update', async () => {
    installDb();
    const original = withTransaction.getMockImplementation();
    withTransaction.mockImplementation(async (fn) => original(async (client) => {
      const inner = client.query;
      client.query = vi.fn(async (sql, params) => (/^\s*UPDATE email_accounts/.test(sql) ? { rows: [], rowCount: 0 } : inner(sql, params)));
      return fn(client);
    }));
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=microsoft');
    expect(recordAudit).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('binds the subject of a mailbox connected before subjects were stored', async () => {
    row = { ...MS_ROW, oauth_subject: null };
    expect((await callback()).headers.get('location')).toBe('/?oauth_success=microsoft');
    expect(updateCall()[1][4]).toBe(SUBJECT);
  });

  it('refuses a callback whose session names no flow', async () => {
    session = { oauthNonce: NONCE, oauthUserId: USER_ID };
    expect((await callback()).headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=microsoft');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('records nothing when the token exchange fails', async () => {
    stubMicrosoft(() => json(false, { error: 'invalid_grant', error_description: 'AADSTS70000 provider text' }));
    const res = await callback();
    expect(res.headers.get('location')).toBe('/?oauth_error=authentication_failed&oauth_provider=microsoft');
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('never echoes a provider error description', async () => {
    const res = await fetch(`${base}/oauth/microsoft/callback?error=server_error&error_description=AADSTS50000%20text`, { redirect: 'manual', headers });
    expect(res.headers.get('location')).toBe('/?oauth_error=authentication_failed&oauth_provider=microsoft');
  });
});

describe('Microsoft device-code flow', () => {
  const startOk = () => json(true, { device_code: 'dc-secret', user_code: 'UC', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 });
  const startDevice = (body) => fetch(`${base}/oauth/microsoft/device`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const poll = () => fetch(`${base}/oauth/microsoft/device/poll`, { headers });

  it('reconnects the mailbox the start names', async () => {
    stubMicrosoft((href) => (href.endsWith('/devicecode') ? startOk() : json(true, TOKENS)));
    expect((await startDevice({ account: ACCOUNT_ID })).status).toBe(200);
    expect(await (await poll()).json()).toEqual({ status: 'success' });
    expect(updateCall()[0]).toMatch(/oauth_reconnect_required\s*=\s*false/);
    expect(updateCall()[1][3]).toBe(true); // public client
  });

  it('adds without an account, and refuses an existing address', async () => {
    stubMicrosoft((href) => (href.endsWith('/devicecode') ? startOk() : json(true, TOKENS)));
    expect((await startDevice()).status).toBe(200);
    expect(await (await poll()).json()).toEqual({ status: 'error', error: 'Microsoft sign-in refused', code: 'already_connected' });
    expect(wroteAccount()).toBe(false);
  });

  it.each([['a reconnect', { account: ACCOUNT_ID }], ['an add', undefined]])('refuses to start %s for a user who is not an administrator', async (_label, body) => {
    signedInAdmin = false;
    stubMicrosoft(() => startOk());
    const res = await startDevice(body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin access required', code: 'admin_required' });
    // Microsoft was never asked for a device code, and there is no flow for the poll to finish.
    expect(globalThis.fetch.mock.calls.some(([url]) => String(url).endsWith('/devicecode'))).toBe(false);
    expect(await (await poll()).json()).toMatchObject({ status: 'error' });
  });

  it('refuses to start a reconnect of a mailbox that is not a Microsoft one', async () => {
    target = { ...target, oauth_provider: 'google' };
    stubMicrosoft(() => startOk());
    const res = await startDevice({ account: ACCOUNT_ID });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_state');
  });

  it('refuses to start or finish from a locked session, and finishes once unlocked', async () => {
    stubMicrosoft((href) => (href.endsWith('/devicecode') ? startOk() : json(true, TOKENS)));
    session = { locked: true };
    const refused = await startDevice({ account: ACCOUNT_ID });
    expect(refused.status).toBe(423);
    expect(await refused.json()).toEqual({ error: 'Locked', locked: true });
    expect(globalThis.fetch.mock.calls.some(([url]) => String(url).endsWith('/devicecode'))).toBe(false);

    // A flow started before the lock: its poll is refused and kept.
    session = {};
    expect((await startDevice({ account: ACCOUNT_ID })).status).toBe(200);
    session.locked = true;
    expect((await poll()).status).toBe(423);
    expect(wroteAccount()).toBe(false);
    session.locked = false;
    expect(await (await poll()).json()).toEqual({ status: 'success' });
  });

  it('answers an unverified address with a stable code', async () => {
    claims = { tid: TID, oid: OID, email: 'victim@fabrikam.com' };
    stubMicrosoft((href) => (href.endsWith('/devicecode') ? startOk() : json(true, TOKENS)));
    await startDevice({ account: ACCOUNT_ID });
    expect(await (await poll()).json()).toEqual({ status: 'error', error: 'Microsoft sign-in refused', code: 'email_not_verified' });
  });
});

describe('Microsoft device-code errors never echo provider text', () => {
  const PROVIDER_TEXT = 'AADSTS700016: Application with identifier ms-client was not found. Trace ID: abc';
  const loggedText = () => logSpies.flatMap((s) => s.mock.calls.flat()).map(String).join('\n');
  const startOk = () => json(true, { device_code: 'dc-secret', user_code: 'UC', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 });

  it('start returns a stable error when Microsoft rejects the device-code request', async () => {
    stubMicrosoft(() => json(false, { error: 'unauthorized_client', error_description: PROVIDER_TEXT }));
    const res = await fetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to start device code flow', code: 'device_code_start_failed' });
    expect(loggedText()).not.toContain('AADSTS700016');
  });

  it('start returns a stable error when the request throws', async () => {
    stubMicrosoft(() => { throw new Error(`connect ECONNREFUSED ${PROVIDER_TEXT}`); });
    const res = await fetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers });
    expect(await res.json()).toEqual({ error: 'Failed to start device code flow', code: 'device_code_start_failed' });
  });

  it('poll returns a stable error when the token exchange is rejected', async () => {
    stubMicrosoft((href) => (href.endsWith('/devicecode')
      ? startOk()
      : json(false, { error: 'invalid_grant', error_description: PROVIDER_TEXT })));
    expect((await fetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers })).status).toBe(200);
    const res = await fetch(`${base}/oauth/microsoft/device/poll`, { headers });
    expect(await res.json()).toEqual({ status: 'error', error: 'Token exchange failed', code: 'device_code_token_failed' });
    expect(loggedText()).not.toContain('AADSTS700016');
  });

  it('poll returns a stable error when processing the tokens throws', async () => {
    stubMicrosoft((href) => (href.endsWith('/devicecode') ? startOk() : json(true, TOKENS)));
    withTransaction.mockImplementation(async () => { throw new Error(`db exploded ${PROVIDER_TEXT}`); });
    expect((await fetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers })).status).toBe(200);
    const res = await fetch(`${base}/oauth/microsoft/device/poll`, { headers });
    expect(await res.json()).toEqual({ status: 'error', error: 'Token exchange failed', code: 'device_code_token_failed' });
    expect(loggedText()).not.toContain('ms-at');
    expect(loggedText()).not.toContain('dc-secret');
  });
});
