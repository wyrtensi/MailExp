import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// The id-token tests sign real JWTs with a locally generated key; only the remote
// JWKS fetch is replaced by a local key set so no network access is needed while the
// real jose issuer/audience/expiry validation still runs.
const joseState = vi.hoisted(() => ({ localJwks: null, remoteUrls: [] }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn((url) => {
      joseState.remoteUrls.push(String(url));
      return (...args) => joseState.localJwks(...args);
    }),
  };
});
vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc(') ? v.slice(4, -1) : v),
}));
vi.mock('./googleApps.js', () => ({ getGoogleAppById: vi.fn() }));

const { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } = await import('jose');
const { query } = await import('../db.js');
const { getGoogleAppById } = await import('./googleApps.js');
const {
  buildGoogleAuthorizationUrl,
  buildGoogleSignInUrl,
  GOOGLE_AUTH_URL,
  exchangeGoogleCode,
  verifyGoogleIdToken,
  refreshGoogleToken,
  hasGoogleMailScope,
  GOOGLE_MAIL_SCOPE,
  revokeGoogleToken,
  GOOGLE_REVOKE_URL,
} = await import('./googleOAuth.js');

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const CLIENT_SECRET = 'very-secret-client-secret';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const APP = { id: 'app-1', client_id: CLIENT_ID, client_secret: `enc(${CLIENT_SECRET})`, status: 'active' };
const jsonRes = (ok, body, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  getGoogleAppById.mockReset();
  getGoogleAppById.mockResolvedValue(APP);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildGoogleAuthorizationUrl', () => {
  it('includes every mandatory authorization parameter and only the PKCE challenge', () => {
    const url = new URL(buildGoogleAuthorizationUrl({
      clientId: CLIENT_ID,
      state: 'state-123', codeChallenge: 'challenge-abc', redirectUri: REDIRECT_URI,
    }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe('openid email profile https://mail.google.com/');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('true');
    expect(p.get('code_challenge')).toBe('challenge-abc');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe('state-123');
    expect(p.has('login_hint')).toBe(false);
    expect(p.has('client_secret')).toBe(false);
    expect(p.has('code_verifier')).toBe(false);
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it('adds login_hint when provided', () => {
    const url = new URL(buildGoogleAuthorizationUrl({
      clientId: CLIENT_ID,
      state: 's', codeChallenge: 'c', redirectUri: REDIRECT_URI, loginHint: 'user@gmail.com',
    }));
    expect(url.searchParams.get('login_hint')).toBe('user@gmail.com');
  });
});

describe('hasGoogleMailScope', () => {
  it('requires the full Gmail scope as a whole token', () => {
    expect(hasGoogleMailScope(`openid ${GOOGLE_MAIL_SCOPE} email`)).toBe(true);
    expect(hasGoogleMailScope('openid email https://www.googleapis.com/auth/gmail.readonly')).toBe(false);
    expect(hasGoogleMailScope('https://mail.google.com/extra')).toBe(false);
    expect(hasGoogleMailScope(undefined)).toBe(false);
  });
});

describe('exchangeGoogleCode', () => {
  it('posts the code with the PKCE verifier and client secret in the body, and normalizes tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(true, {
      access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599,
      scope: `openid ${GOOGLE_MAIL_SCOPE}`, id_token: 'idt', token_type: 'Bearer',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const tokens = await exchangeGoogleCode({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: 'auth-code', codeVerifier: 'verifier', redirectUri: REDIRECT_URI,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(url).not.toContain('auth-code');
    expect(init.method).toBe('POST');
    const body = init.body;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('code_verifier')).toBe('verifier');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);

    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.idToken).toBe('idt');
    expect(tokens.scope).toBe(`openid ${GOOGLE_MAIL_SCOPE}`);
    expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599 * 1000);
  });

  it('throws a stable error without the provider body on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(false, {
      error: 'invalid_grant', error_description: 'Bad Request code=auth-code secret leaked',
    })));
    const err = await exchangeGoogleCode({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: 'auth-code', codeVerifier: 'v', redirectUri: REDIRECT_URI,
    }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
    expect(err.oauthError).toBe('invalid_grant');
    expect(err.message).not.toMatch(/auth-code|secret|Bad Request/);
  });

  it('throws authentication_failed when no access token is returned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(true, { id_token: 'x' })));
    const err = await exchangeGoogleCode({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: 'c', codeVerifier: 'v', redirectUri: REDIRECT_URI,
    }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
  });

  it('fails with not_configured without client credentials and never calls Google', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await exchangeGoogleCode({ clientId: CLIENT_ID, clientSecret: '', code: 'c', codeVerifier: 'v', redirectUri: REDIRECT_URI }).catch(e => e);
    expect(err.code).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('verifyGoogleIdToken', () => {
  let privateKey;
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
    joseState.localJwks = createLocalJWKSet({ keys: [jwk] });
  });

  const sign = (claims, { iss = 'https://accounts.google.com', aud = CLIENT_ID, exp = '1h' } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject('sub-1')
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);

  it('verifies against Google JWKS and returns the identity', async () => {
    const idToken = await sign({ email: 'User@Gmail.com', email_verified: true, name: 'User' });
    const identity = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID });
    expect(identity).toEqual({ email: 'User@Gmail.com', name: 'User', sub: 'sub-1' });
    expect(joseState.remoteUrls).toContain('https://www.googleapis.com/oauth2/v3/certs');
  });

  it('accepts the bare accounts.google.com issuer', async () => {
    const idToken = await sign({ email: 'u@gmail.com', email_verified: true }, { iss: 'accounts.google.com' });
    await expect(verifyGoogleIdToken({ idToken, clientId: CLIENT_ID })).resolves.toMatchObject({ email: 'u@gmail.com' });
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil.example.com' }],
    ['wrong audience', { aud: 'other-client' }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])('rejects a token with %s', async (_label, opts) => {
    const idToken = await sign({ email: 'u@gmail.com', email_verified: true }, opts);
    const err = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
  });

  it('rejects a token signed by an unknown key', async () => {
    const other = await generateKeyPair('RS256');
    const idToken = await new SignJWT({ email: 'u@gmail.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com').setAudience(CLIENT_ID).setExpirationTime('1h')
      .sign(other.privateKey);
    const err = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
  });

  it.each([
    ['false', false],
    ['the string "true"', 'true'],
    ['missing', undefined],
  ])('rejects email_verified %s with email_not_verified', async (_label, value) => {
    const idToken = await sign({ email: 'u@gmail.com', email_verified: value });
    const err = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID }).catch(e => e);
    expect(err.code).toBe('email_not_verified');
  });

  it('rejects a token without an email', async () => {
    const idToken = await sign({ email_verified: true });
    const err = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
  });
});

describe('refreshGoogleToken', () => {
  const account = { id: 'acc-1', oauth_provider: 'google', oauth_app_id: 'app-1', oauth_refresh_token: 'enc(stored-rt)' };

  it('refreshes with the decrypted refresh token and persists encrypted tokens atomically', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(true, {
      access_token: 'new-at', expires_in: 3600, scope: GOOGLE_MAIL_SCOPE,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshGoogleToken(account);

    const body = fetchMock.mock.calls[0][1].body;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('stored-rt');
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(getGoogleAppById).toHaveBeenCalledWith('app-1');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE email_accounts/);
    expect(sql).toMatch(/COALESCE\(\$2, oauth_refresh_token\)/);
    expect(params[0]).toBe('enc(new-at)');
    // No new refresh token from Google: the stored one must be kept.
    expect(params[1]).toBeNull();
    expect(params[3]).toBe('acc-1');

    expect(result.oauth_access_token).toBe('new-at');
    expect(result.oauth_token_expiry).toBeInstanceOf(Date);
  });

  it('stores a rotated refresh token encrypted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(true, {
      access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600,
    })));
    await refreshGoogleToken(account);
    expect(query.mock.calls[0][1][1]).toBe('enc(new-rt)');
  });

  it('hands back the rotated refresh token as stored, so a later compare-and-set finds the row', async () => {
    // mailSendTransport.js flags oauth_reconnect_required with a compare-and-set on the refresh
    // token of the account this returns: the old token would no longer match the stored row.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(true, {
      access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600,
    })));
    const result = await refreshGoogleToken(account);
    expect(result.oauth_refresh_token).toBe(query.mock.calls[0][1][1]);
    expect(result.oauth_refresh_token).not.toBe(account.oauth_refresh_token);
  });

  it('keeps the stored refresh token on the account when Google does not rotate it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(true, { access_token: 'new-at', expires_in: 3600 })));
    const result = await refreshGoogleToken(account);
    expect(result.oauth_refresh_token).toBe(account.oauth_refresh_token);
  });

  it('surfaces invalid_grant as a machine code without the provider body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(false, {
      error: 'invalid_grant', error_description: 'Token has been expired or revoked. stored-rt',
    })));
    const err = await refreshGoogleToken(account).catch(e => e);
    expect(err.oauthError).toBe('invalid_grant');
    expect(err.message).not.toMatch(/stored-rt|revoked/);
    expect(query).not.toHaveBeenCalled();
  });

  it('marks a missing refresh token without calling Google', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await refreshGoogleToken({ ...account, oauth_refresh_token: null }).catch(e => e);
    expect(err.oauthError).toBe('missing_refresh_token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no app is bound', { oauth_app_id: null }, null],
    ['the app was removed', {}, null],
    ['the app is disabled', {}, { ...APP, status: 'disabled' }],
  ])('needs reconnect when %s, without calling Google', async (_label, overrides, app) => {
    getGoogleAppById.mockResolvedValue(app);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await refreshGoogleToken({ ...account, ...overrides }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
    expect(err.oauthError).toBe('app_unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps refreshing through a closed app', async () => {
    getGoogleAppById.mockResolvedValue({ ...APP, status: 'closed' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(true, { access_token: 'new-at', expires_in: 3600 })));
    await expect(refreshGoogleToken(account)).resolves.toMatchObject({ oauth_access_token: 'new-at' });
  });

  it('fails with not_configured when the app secret cannot be decrypted', async () => {
    getGoogleAppById.mockResolvedValue({ ...APP, client_secret: null });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await refreshGoogleToken(account).catch(e => e);
    expect(err.code).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('buildGoogleSignInUrl', () => {
  it('asks only for the identity, with PKCE and an account picker', () => {
    const url = new URL(buildGoogleSignInUrl({
      clientId: 'client-id', state: 'st', codeChallenge: 'ch',
      redirectUri: 'https://direct.example.com/oauth/login/google/callback',
    }));
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-id',
      redirect_uri: 'https://direct.example.com/oauth/login/google/callback',
      response_type: 'code',
      scope: 'openid email',
      prompt: 'select_account',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      state: 'st',
    });
  });
});

describe('revokeGoogleToken', () => {
  let errorSpy;
  beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errorSpy.mockRestore(); vi.unstubAllGlobals(); });

  it('posts the token in the form body, never in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(revokeGoogleToken('tok-123')).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GOOGLE_REVOKE_URL);
    expect(url).not.toContain('tok-123');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('token=tok-123');
  });

  it('returns false and logs only the status when Google refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await expect(revokeGoogleToken('tok-123')).resolves.toBe(false);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('400');
    expect(logged).not.toContain('tok-123');
  });

  it('never throws on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down tok-123')));
    await expect(revokeGoogleToken('tok-123')).resolves.toBe(false);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('tok-123');
  });

  it('does not call Google without a token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(revokeGoogleToken(null)).resolves.toBe(false);
    await expect(revokeGoogleToken('')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
