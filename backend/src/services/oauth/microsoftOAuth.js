import { query } from '../db.js';
import { encrypt, decrypt } from '../encryption.js';
import { PROVIDER_FETCH_TIMEOUT_MS } from './constants.js';

export const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com';

export function getMsConfig() {
  return {
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    tenantId: process.env.MS_TENANT_ID || 'common',
    redirectUri: process.env.MS_REDIRECT_URI,
  };
}

// --- who signed in -----------------------------------------------------------------------------
//
// The mailbox address must come from a claim Microsoft vouches for. `email` alone is not one: it
// "isn't guaranteed to be correct, and is mutable over time - never use it for authorization", and
// `preferred_username` is display text a tenant administrator controls; with the `common` tenant
// any tenant's token verifies, so either could name someone else's mailbox (the nOAuth class).
//   https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
//   https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation
// Accepted, in this order:
//   1. `email` when `xms_edov` is true: the email domain's owner was verified by the user's own
//      tenant (or the account is a Microsoft account). Both are optional claims of the app
//      registration (token configuration: email, xms_edov). For personal Microsoft accounts the
//      documentation does not say when xms_edov is sent: check it with a live sign-in before
//      relying on personal accounts.
//   2. `upn` (optional claim) of a member user: Entra only lets a UPN carry a domain the tenant
//      verified, else it rewrites it to the tenant's own <name>.onmicrosoft.com
//      (https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/plan-connect-userprincipalname).
//      A guest's UPN (with #EXT#) names the resource tenant, not the user, and is refused.
//   3. `verified_primary_email` (optional, "sourced from the user's PrimaryAuthoritativeEmail") only
//      when MS_TENANT_ID names one tenant: the documentation gives no domain-ownership guarantee
//      for it, so it is trusted only from the organisation's own tenant.
// None of them: the sign-in is refused (email_not_verified) rather than guessed.
//
// The user is identified by `tid` + `oid`, "immutable claim values ... as a combined key"
// (claims-validation), stored as the mailbox's oauth_subject.

const ADDRESS_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

function cleanAddress(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return ADDRESS_RE.test(address) && address.length <= 320 ? address : null;
}

// The verified mailbox address of an ID token's claims, or null. `singleTenant`: MS_TENANT_ID
// names one tenant (not common/organizations/consumers), whose issuer the token was checked against.
export function verifiedMicrosoftAddress(claims, { singleTenant = false } = {}) {
  const c = claims ?? {};
  if (c.xms_edov === true || c.xms_edov === 'true' || c.xms_edov === 1 || c.xms_edov === '1') {
    const email = cleanAddress(c.email);
    if (email) return email;
  }
  if (typeof c.upn === 'string' && !c.upn.includes('#')) {
    const upn = cleanAddress(c.upn);
    if (upn) return upn;
  }
  if (singleTenant) {
    const verified = Array.isArray(c.verified_primary_email) ? c.verified_primary_email : [c.verified_primary_email];
    for (const value of verified) {
      const address = cleanAddress(value);
      if (address) return address;
    }
  }
  return null;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "<tid>:<oid>" of an ID token's claims, or null when either is missing.
export function microsoftSubject(claims) {
  const tid = typeof claims?.tid === 'string' ? claims.tid.toLowerCase() : '';
  const oid = typeof claims?.oid === 'string' ? claims.oid.toLowerCase() : '';
  return GUID_RE.test(tid) && GUID_RE.test(oid) ? `${tid}:${oid}` : null;
}

// Serialize refreshes per account so concurrent callers share one token-endpoint
// call — AAD rotates the refresh token on each refresh, and two racing refreshes
// would strand a superseded refresh token and lock the account out.
const inFlightMsRefresh = new Map(); // accountId -> Promise
export function refreshMicrosoftToken(account) {
  const existing = inFlightMsRefresh.get(account.id);
  if (existing) return existing;
  const p = doRefreshMicrosoftToken(account).finally(() => inFlightMsRefresh.delete(account.id));
  inFlightMsRefresh.set(account.id, p);
  return p;
}

// Refresh an expired Microsoft token
async function doRefreshMicrosoftToken(account) {
  const { clientId, clientSecret, tenantId } = getMsConfig();

  const storedRefreshToken = decrypt(account.oauth_refresh_token);
  if (!storedRefreshToken) {
    const err = new Error('OAuth refresh token is missing or corrupted — please reconnect your account');
    // Machine-readable marker: without a refresh token only a new consent helps.
    err.oauthError = 'missing_refresh_token';
    throw err;
  }

  // Public clients (device-code flow — personal Outlook.com/Hotmail) must NOT send a
  // client_secret on refresh: Microsoft rejects it with AADSTS90023 ("Public clients
  // can't send a client secret"). Confidential clients (auth-code flow) must send it.
  // Key this on the account's recorded flow, not on whether a secret is configured
  // globally, since one instance can host both kinds. (#216)
  const tokenUrl = `${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`;
  const postRefresh = (withSecret) => {
    const params = new URLSearchParams({
      client_id: clientId,
      refresh_token: storedRefreshToken,
      grant_type: 'refresh_token',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
    });
    if (withSecret) params.set('client_secret', clientSecret);
    return fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
  };

  const sendSecret = !!clientSecret && !account.oauth_public_client;
  let tokenRes = await postRefresh(sendSecret);
  let tokens = await tokenRes.json();
  let becamePublic = false;

  // Self-heal accounts predating the oauth_public_client column: if we sent a secret
  // and Microsoft says a public client can't (AADSTS90023), this is really a public
  // (device-code) client — retry without the secret and record it so future refreshes
  // skip the secret straight away.
  if (!tokenRes.ok && sendSecret && /AADSTS90023/i.test(tokens.error_description || tokens.error || '')) {
    tokenRes = await postRefresh(false);
    tokens = await tokenRes.json();
    becamePublic = tokenRes.ok;
  }

  if (!tokenRes.ok) {
    const err = new Error(tokens.error_description || 'Token refresh failed');
    // Keep the provider's OAuth error code (e.g. invalid_grant) so the token manager
    // can classify the failure without parsing the human-readable description.
    if (typeof tokens.error === 'string') err.oauthError = tokens.error;
    throw err;
  }

  const { access_token, refresh_token, expires_in } = tokens;
  const refreshExpiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + refreshExpiresInSecs * 1000);
  const isPublic = !!account.oauth_public_client || becamePublic;
  // Encrypted once: the ciphertext stored is the one handed back below (each encrypt() draws its
  // own IV), so a later compare-and-set on it (tokenManager.markReconnectRequired) finds the row.
  const storedNewRefreshToken = refresh_token ? encrypt(refresh_token) : null;

  // Compare-and-set on the grant and flow the refresh started from: a reconnect (auth-code or
  // device-code) may have committed new tokens while the provider call was in flight. The stored
  // refresh token is compared as stored (ciphertext with its own IV), so any rewrite of it
  // counts as a change. A lost race keeps the reconnect's credentials and hands them back.
  const saved = await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3,
      oauth_public_client = $4
    WHERE id = $5
      AND oauth_refresh_token IS NOT DISTINCT FROM $6
      AND oauth_public_client = $7
  `, [
    encrypt(access_token), storedNewRefreshToken, expiry, isPublic, account.id,
    account.oauth_refresh_token, !!account.oauth_public_client,
  ]);
  if (saved?.rowCount === 0) {
    const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1', [account.id]);
    if (!rows[0]) {
      const err = new Error('OAuth account no longer exists');
      err.code = 'account_not_found';
      throw err;
    }
    return rows[0];
  }

  // Return plaintext tokens so callers can use them immediately without decrypting (the stored
  // row returned above after a lost race carries encrypted ones; decrypt() handles both). The refresh
  // token stays as stored (ciphertext, like the row): callers compare it with the row.
  return {
    ...account,
    oauth_access_token: access_token,
    oauth_refresh_token: storedNewRefreshToken ?? account.oauth_refresh_token,
    oauth_token_expiry: expiry,
    oauth_public_client: isPublic,
  };
}
