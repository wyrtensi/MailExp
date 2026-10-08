import { query } from '../db.js';
import { encrypt } from '../encryption.js';
import { validateHost } from '../hostValidation.js';
import { getConnectionPolicy } from '../connectionPolicy.js';

// The SSO (OIDC) providers an administrator manages, shared by the admin API (routes/admin.js,
// /api/admin/oidc) and the panel CLI (cli/commands/sso.js): the same checks and refusals. The
// client secret is stored encrypted and never answered.
//
// An action answers its result or { error: code, message? }; the route answers the message only,
// as it always has.

export const OIDC_PROVIDER_ERRORS = Object.freeze({
  fields_required: [400, 'name, slug, issuer_url, client_id and client_secret are required'],
  slug_invalid: [400, 'Slug must contain only lowercase letters, numbers and hyphens'],
  login_match_claim_invalid: [400, 'login_match_claim must be a valid claim name (letters, digits, . _ : -)'],
  issuer_not_https: [400, 'Issuer URL must use HTTPS'],
  issuer_host_refused: [400, 'Issuer URL: the host is not allowed'],
  issuer_invalid: [400, 'Issuer URL is not a valid URL'],
  slug_taken: [409, 'A provider with this slug already exists'],
  not_found: [404, 'Provider not found'],
  last_provider: [400, 'Cannot disable or delete the last enabled SSO provider while password login is off. Re-enable password login first.'],
});

// The client secret's stand-in on the admin screen; sending it back keeps the stored secret.
export const OIDC_REDACTED_SECRET = '••••••••';

const refuse = (code, message) => ({ error: code, ...(message ? { message } : {}) });

const PUBLIC_COLUMNS = `id, name, slug, issuer_url, client_id, scopes, provisioning_mode, allowed_domains, enabled,
  require_email_verified, allow_insecure, admin_group_claim, admin_group_value, rp_initiated_logout, login_match_claim`;

// login_match_claim is the OIDC claim name (from the verified id_token) used to match an SSO
// login to an existing MailExpert account (matched against users.username). Restrict to a safe
// claim-name charset. Returns the trimmed value, or null if it is not a valid claim name.
function validateMatchClaim(v) {
  const c = String(v).trim();
  if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(c)) return null;
  // Reject object-prototype key names: as a claim they can't name a real IdP claim, and
  // `payload["__proto__"]` from JSON.parse is a string own-property that would otherwise slip
  // past resolveLoginMatchValue's type guard. Defense-in-depth (also guarded at the sink).
  if (c === '__proto__' || c === 'constructor' || c === 'prototype') return null;
  return c;
}

const claimGiven = (value) => value !== undefined && value !== null && String(value).trim() !== '';

// The issuer URL's checks: HTTPS unless allow_insecure, and the host allowed by the "Allow private
// / local hosts" policy (as POST /system-email: a LAN issuer with a valid public certificate must
// not need allow_insecure, which also turns certificate checks off). Null when it passes.
async function checkIssuer(issuerUrl, allowInsecure) {
  try {
    const parsed = new URL(issuerUrl.trim());
    if (!allowInsecure && parsed.protocol !== 'https:') return refuse('issuer_not_https');
    if (!allowInsecure) {
      const policy = await getConnectionPolicy();
      const hostErr = await validateHost(parsed.hostname, { allowPrivate: policy.allowPrivateHosts });
      if (hostErr) return refuse('issuer_host_refused', `Issuer URL: ${hostErr}`);
    }
  } catch {
    return refuse('issuer_invalid');
  }
  return null;
}

// Every provider, by name: { providers } (never the client secret).
export async function listOidcProviders() {
  const result = await query(`SELECT ${PUBLIC_COLUMNS}, created_at, updated_at FROM oidc_providers ORDER BY name ASC`);
  return { providers: result.rows };
}

// Adds a provider. Answers { provider }.
export async function createOidcProvider(body) {
  const { name, slug, issuer_url, client_id, client_secret, scopes, provisioning_mode, allowed_domains, enabled, require_email_verified, allow_insecure, admin_group_claim, admin_group_value, rp_initiated_logout, login_match_claim } = body || {};
  if (!name || !slug || !issuer_url || !client_id || !client_secret) return refuse('fields_required');
  if (!/^[a-z0-9-]+$/.test(slug)) return refuse('slug_invalid');
  let loginMatchClaim = 'email';
  if (claimGiven(login_match_claim)) {
    const c = validateMatchClaim(login_match_claim);
    if (!c) return refuse('login_match_claim_invalid');
    loginMatchClaim = c;
  }
  const issuerRefusal = await checkIssuer(issuer_url, allow_insecure);
  if (issuerRefusal) return issuerRefusal;
  try {
    const result = await query(
      `INSERT INTO oidc_providers (name, slug, issuer_url, client_id, client_secret, scopes, provisioning_mode, allowed_domains, enabled, require_email_verified, allow_insecure, admin_group_claim, admin_group_value, rp_initiated_logout, login_match_claim)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        name.trim(), slug.trim(), issuer_url.trim(), client_id.trim(),
        encrypt(client_secret),
        (scopes || 'openid email profile').trim(),
        provisioning_mode || 'login_existing_only',
        allowed_domains?.trim() || null,
        enabled !== false,
        require_email_verified !== false,
        allow_insecure === true,
        admin_group_claim?.trim() || null,
        admin_group_value?.trim() || null,
        rp_initiated_logout === true,
        loginMatchClaim,
      ],
    );
    return { provider: result.rows[0] };
  } catch (err) {
    if (err.code === '23505') return refuse('slug_taken');
    throw err;
  }
}

// Guard against locking everyone out: with password login off, the last enabled provider may be
// neither disabled nor deleted. Answers the refusal or null.
async function wouldLockOut(providerId) {
  const s = await query("SELECT value FROM system_settings WHERE key = 'internal_auth_disabled'");
  if (s.rows[0]?.value !== 'true') return null; // password login still available
  const others = await query(
    'SELECT COUNT(*) AS count FROM oidc_providers WHERE enabled = true AND id <> $1',
    [providerId],
  );
  return parseInt(others.rows[0].count) === 0 ? refuse('last_provider') : null;
}

// Changes a provider: a field not given keeps its value; allowed_domains, admin_group_claim and
// admin_group_value given empty are cleared; a client secret replaces the stored one unless it is
// empty or the screen's placeholder. Answers { provider }.
export async function updateOidcProvider(id, body) {
  const { name, slug, issuer_url, client_id, client_secret, scopes, provisioning_mode, allowed_domains, enabled, require_email_verified, allow_insecure, admin_group_claim, admin_group_value, rp_initiated_logout, login_match_claim } = body || {};

  const existingResult = await query('SELECT allow_insecure FROM oidc_providers WHERE id = $1', [id]);
  if (!existingResult.rows.length) return refuse('not_found');
  const existing = existingResult.rows[0];

  // null = keep existing (column is NOT NULL, so we COALESCE rather than allow a blank reset).
  let loginMatchClaimParam = null;
  if (claimGiven(login_match_claim)) {
    const c = validateMatchClaim(login_match_claim);
    if (!c) return refuse('login_match_claim_invalid');
    loginMatchClaimParam = c;
  }

  // Block disabling the last usable auth method.
  if (enabled === false) {
    const lockout = await wouldLockOut(id);
    if (lockout) return lockout;
  }

  if (slug && !/^[a-z0-9-]+$/.test(slug)) return refuse('slug_invalid');
  if (issuer_url) {
    const effectiveAllowInsecure = allow_insecure !== undefined ? allow_insecure : existing.allow_insecure;
    const issuerRefusal = await checkIssuer(issuer_url, effectiveAllowInsecure);
    if (issuerRefusal) return issuerRefusal;
  }
  // Only encrypt a new secret if one was provided (non-placeholder)
  const secretUpdate = client_secret && client_secret !== OIDC_REDACTED_SECRET
    ? encrypt(client_secret)
    : undefined;
  try {
    const result = await query(
      `UPDATE oidc_providers SET
        name = COALESCE($2, name),
        slug = COALESCE($3, slug),
        issuer_url = COALESCE($4, issuer_url),
        client_id = COALESCE($5, client_id),
        client_secret = COALESCE($6, client_secret),
        scopes = COALESCE($7, scopes),
        provisioning_mode = COALESCE($8, provisioning_mode),
        allowed_domains = CASE WHEN $9::text IS DISTINCT FROM '__keep__' THEN $9::text ELSE allowed_domains END,
        enabled = COALESCE($10, enabled),
        require_email_verified = COALESCE($11, require_email_verified),
        allow_insecure = COALESCE($12, allow_insecure),
        admin_group_claim = CASE WHEN $13::text IS DISTINCT FROM '__keep__' THEN $13::text ELSE admin_group_claim END,
        admin_group_value = CASE WHEN $14::text IS DISTINCT FROM '__keep__' THEN $14::text ELSE admin_group_value END,
        rp_initiated_logout = COALESCE($15, rp_initiated_logout),
        login_match_claim = COALESCE($16, login_match_claim),
        updated_at = NOW()
       WHERE id = $1
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        id,
        name?.trim() || null,
        slug?.trim() || null,
        issuer_url?.trim() || null,
        client_id?.trim() || null,
        secretUpdate || null,
        scopes?.trim() || null,
        provisioning_mode || null,
        allowed_domains !== undefined ? (allowed_domains?.trim() || null) : '__keep__',
        enabled !== undefined ? enabled : null,
        require_email_verified !== undefined ? require_email_verified : null,
        allow_insecure !== undefined ? allow_insecure : null,
        admin_group_claim !== undefined ? (admin_group_claim?.trim() || null) : '__keep__',
        admin_group_value !== undefined ? (admin_group_value?.trim() || null) : '__keep__',
        rp_initiated_logout !== undefined ? rp_initiated_logout : null,
        loginMatchClaimParam,
      ],
    );
    if (!result.rows.length) return refuse('not_found');
    return { provider: result.rows[0] };
  } catch (err) {
    if (err.code === '23505') return refuse('slug_taken');
    throw err;
  }
}

// Deletes a provider (refused for the last enabled one while password login is off). Answers
// { ok }; deleting an id that does not exist is not an error, as the route always answered.
export async function deleteOidcProvider(id) {
  const lockout = await wouldLockOut(id);
  if (lockout) return lockout;
  await query('DELETE FROM oidc_providers WHERE id = $1', [id]);
  return { ok: true };
}
