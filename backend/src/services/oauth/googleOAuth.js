import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query } from '../db.js';
import { encrypt, decrypt } from '../encryption.js';
import { PROVIDER_FETCH_TIMEOUT_MS } from './constants.js';
import { getGoogleAppById } from './googleApps.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_MAIL_SCOPE = 'https://mail.google.com/';
export const GOOGLE_SCOPES = `openid email profile ${GOOGLE_MAIL_SCOPE}`;
export const GOOGLE_SIGN_IN_SCOPES = 'openid email';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// Errors carry a stable `code` (safe to show and to put in redirect URLs) and, when the
// provider returned one, its OAuth error code in `oauthError`. The message never includes
// the provider response body, authorization codes or tokens.
export class GoogleOAuthError extends Error {
  constructor(code, { oauthError } = {}) {
    super(`Google OAuth failed: ${code}`);
    this.name = 'GoogleOAuthError';
    this.code = code;
    if (oauthError) this.oauthError = oauthError;
  }
}

// createRemoteJWKSet caches and rotates keys internally; build it once per process.
let googleJwks = null;
function getGoogleJwks() {
  if (!googleJwks) googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return googleJwks;
}

export function hasGoogleMailScope(scope) {
  if (typeof scope !== 'string') return false;
  return scope.split(/\s+/).includes(GOOGLE_MAIL_SCOPE);
}

export function buildGoogleAuthorizationUrl({ clientId, state, codeChallenge, redirectUri, loginHint }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${GOOGLE_AUTH_URL}?${params}`;
}

// Sign-in to MailExpert itself: only the identity, no mailbox access and no refresh token.
export function buildGoogleSignInUrl({ clientId, state, codeChallenge, redirectUri }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SIGN_IN_SCOPES,
    prompt: 'select_account',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

function expiryFrom(expiresIn) {
  const secs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  return new Date(Date.now() + secs * 1000);
}

// POST to the token endpoint. Secrets travel only in the form body, never in the URL.
async function postToken(params) {
  let res;
  let body;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    throw new GoogleOAuthError('authentication_failed');
  }
  if (!res.ok) {
    const oauthError = typeof body?.error === 'string' ? body.error : undefined;
    throw new GoogleOAuthError('authentication_failed', { oauthError });
  }
  return body || {};
}

export async function exchangeGoogleCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  if (!clientId || !clientSecret) throw new GoogleOAuthError('not_configured');

  const tokens = await postToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  }));
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new GoogleOAuthError('authentication_failed');
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null,
    expiresAt: expiryFrom(tokens.expires_in),
    scope: typeof tokens.scope === 'string' ? tokens.scope : '',
    idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
  };
}

export async function verifyGoogleIdToken({ idToken, clientId }) {
  if (!idToken || !clientId) throw new GoogleOAuthError('authentication_failed');

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getGoogleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
    }));
  } catch {
    throw new GoogleOAuthError('authentication_failed');
  }

  if (typeof payload.email !== 'string' || !payload.email.includes('@')) {
    throw new GoogleOAuthError('authentication_failed');
  }
  // Strict boolean check: only a Google-verified address may be bound to a mailbox.
  if (payload.email_verified !== true) throw new GoogleOAuthError('email_not_verified');

  return {
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name : null,
    sub: payload.sub,
  };
}

// Refresh a Google access token through the app that issued it and persist the result. The
// stored refresh token is kept when Google does not return a new one. Returns the account
// with the plaintext access token, matching refreshMicrosoftToken, or the stored row (encrypted
// tokens) when a reconnect replaced the credentials during the provider call.
export async function refreshGoogleToken(account) {
  const app = await getGoogleAppById(account.oauth_app_id);
  // A refresh token only works with its issuing client: without that app the mailbox has
  // to consent again, through another app.
  if (!app || app.status === 'disabled') {
    throw new GoogleOAuthError('authentication_failed', { oauthError: 'app_unavailable' });
  }
  const clientSecret = decrypt(app.client_secret);
  if (!clientSecret) throw new GoogleOAuthError('not_configured');

  const storedRefreshToken = decrypt(account.oauth_refresh_token);
  if (!storedRefreshToken) {
    throw new GoogleOAuthError('authentication_failed', { oauthError: 'missing_refresh_token' });
  }

  const tokens = await postToken(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: storedRefreshToken,
    client_id: app.client_id,
    client_secret: clientSecret,
  }));
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new GoogleOAuthError('authentication_failed');
  }

  const expiry = expiryFrom(tokens.expires_in);
  const newRefreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token
    ? tokens.refresh_token
    : null;
  // Encrypted once: the ciphertext stored is the one handed back below (each encrypt() draws its
  // own IV), so a later compare-and-set on it (tokenManager.markReconnectRequired) finds the row.
  const storedNewRefreshToken = newRefreshToken ? encrypt(newRefreshToken) : null;

  // Compare-and-set on the grant the refresh started from: a reconnect may have committed new
  // tokens, possibly through another app, while the provider call was in flight. The stored
  // refresh token is compared as stored (ciphertext with its own IV), so any rewrite of it
  // counts as a change. A lost race keeps the reconnect's credentials and hands them back.
  const saved = await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3
    WHERE id = $4
      AND oauth_refresh_token IS NOT DISTINCT FROM $5
      AND oauth_app_id IS NOT DISTINCT FROM $6
  `, [
    encrypt(tokens.access_token), storedNewRefreshToken, expiry, account.id,
    account.oauth_refresh_token, account.oauth_app_id ?? null,
  ]);
  if (saved?.rowCount === 0) {
    const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1', [account.id]);
    if (!rows[0]) throw new GoogleOAuthError('authentication_failed');
    return rows[0];
  }

  return {
    ...account,
    oauth_access_token: tokens.access_token,
    oauth_refresh_token: storedNewRefreshToken ?? account.oauth_refresh_token,
    oauth_token_expiry: expiry,
  };
}

// Revoke a token Google issued. Best effort: it never throws, and only the HTTP status or the
// error class is logged, so neither the token nor Google's response ends up in the logs.
export async function revokeGoogleToken(token) {
  if (typeof token !== 'string' || !token) return false;
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`Google token revoke failed: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error(`Google token revoke failed: ${err?.name || 'Error'}`);
    return false;
  }
}
