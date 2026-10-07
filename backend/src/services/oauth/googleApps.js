import { query, withTransaction } from '../db.js';
import { encrypt, decrypt } from '../encryption.js';

// Google OAuth apps: one row per Google Cloud project. OAuth clients of one project share
// its unverified-app user cap, so the project number in the client ID identifies an app.
const GOOGLE_CLIENT_ID_PATTERN = /^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export const GOOGLE_APP_STATUSES = Object.freeze(['active', 'closed', 'disabled']);

const APP_COLUMNS = 'id, label, client_id, client_secret, project_number, user_limit, status, gmail_api_disabled_at, created_at';

// Stable, secret-free error for app registry operations.
export class GoogleAppError extends Error {
  constructor(code) {
    super(`Google OAuth app error: ${code}`);
    this.name = 'GoogleAppError';
    this.code = code;
  }
}

export function parseGoogleClientId(clientId) {
  if (typeof clientId !== 'string') return null;
  const match = GOOGLE_CLIENT_ID_PATTERN.exec(clientId.trim());
  return match ? match[1] : null;
}

export async function getGoogleAppById(appId) {
  if (!appId) return null;
  const { rows } = await query(`SELECT ${APP_COLUMNS} FROM google_oauth_apps WHERE id = $1`, [appId]);
  return rows[0] || null;
}

// The oldest app that is not disabled. Used by resolveGoogleConfig() when no appId is given,
// which only the `configured` check of GET /api/integrations/status does: every consent flow
// names the app selectGoogleApp picked.
export async function getDefaultGoogleApp() {
  const { rows } = await query(
    `SELECT ${APP_COLUMNS} FROM google_oauth_apps WHERE status <> 'disabled' ORDER BY created_at, id LIMIT 1`,
  );
  return rows[0] || null;
}

// The callback URL registered for every app. A browser that came through another public
// origin (APP_ALT_URLS) is sent back to that origin, on the same path.
export function getGoogleRedirectUri(origin = null) {
  const configured = process.env.GOOGLE_REDIRECT_URI || null;
  if (!configured || !origin) return configured;
  try {
    return `${origin}${new URL(configured).pathname}`;
  } catch {
    return configured;
  }
}

// The Google callback URL as saved on the Integrations screen, falling back to the environment
// (GOOGLE_REDIRECT_URI, as the process started with it) when nothing is stored yet. Used by the
// client-JSON import warning, from both the server process (routes/integrations.js also mirrors
// the stored value into process.env, so this agrees with it there) and the googleApp.js CLI,
// which runs standalone and never applies that mirroring. Queried directly instead of importing
// routes/integrations.js, which would drag in express and the legacy-config importer.
export async function getEffectiveGoogleRedirectUri() {
  const { rows } = await query("SELECT config FROM integration_config WHERE provider = 'google'");
  const stored = rows[0]?.config?.redirectUri;
  if (typeof stored === 'string' && stored.trim()) return stored.trim();
  return process.env.GOOGLE_REDIRECT_URI || null;
}

// Credentials for one consent flow: the given app, or the default app. Null when the
// callback URL is missing, the app is missing or disabled, or its secret cannot be decrypted.
export async function resolveGoogleConfig({ appId = null, origin = null } = {}) {
  const redirectUri = getGoogleRedirectUri(origin);
  if (!redirectUri) return null;
  const app = appId ? await getGoogleAppById(appId) : await getDefaultGoogleApp();
  if (!app || app.status === 'disabled') return null;
  const clientSecret = decrypt(app.client_secret);
  if (!clientSecret) return null;
  return { appId: app.id, projectNumber: app.project_number, clientId: app.client_id, clientSecret, redirectUri };
}

// Journal the Google account an app issued tokens to. Google counts it against the user cap of
// the app's Cloud project from that moment, so rows are kept when the mailbox is removed, and are
// keyed by the project: they outlive the app row and count again for a client of that project
// added later. Written by the project number the flow resolved at its start, not through the app
// row, so an app deleted during the code exchange does not lose a user Google already counted.
export async function recordGoogleGrant({ projectNumber, email, sub = null }, db = { query }) {
  await db.query(
    `INSERT INTO google_oauth_grants (project_number, email, google_sub) VALUES ($1, lower($2), $3)
     ON CONFLICT (project_number, email) DO UPDATE SET google_sub = COALESCE(google_oauth_grants.google_sub, EXCLUDED.google_sub)`,
    [projectNumber, email, sub],
  );
}

// Change an app's status. Disabling flags its mailboxes for reconnect through another app and
// returns their ids so the caller can drop their IMAP connections.
export async function setGoogleAppStatus(appId, status) {
  if (!GOOGLE_APP_STATUSES.includes(status)) throw new GoogleAppError('app_status_invalid');
  return withTransaction(async (client) => {
    const updated = await client.query(
      'UPDATE google_oauth_apps SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id',
      [appId, status],
    );
    if (!updated.rows.length) throw new GoogleAppError('app_not_found');
    if (status !== 'disabled') return [];
    const flagged = await client.query(
      `UPDATE email_accounts SET oauth_reconnect_required = true, sync_error = 'oauth_reconnect_required'
       WHERE oauth_app_id = $1 RETURNING id`,
      [appId],
    );
    return flagged.rows.map((row) => row.id);
  });
}

// Best-effort journal of a Gmail API send that hit accessNotConfigured/SERVICE_DISABLED, or one
// that succeeded after that — see gmailApiSender.js. Callers swallow the error themselves; these
// must never throw into a send path that already delivered (or is about to fall back).
export async function markGmailApiDisabled(appId) {
  if (!appId) return;
  await query('UPDATE google_oauth_apps SET gmail_api_disabled_at = NOW() WHERE id = $1', [appId]);
}

export async function clearGmailApiDisabled(appId) {
  if (!appId) return;
  await query('UPDATE google_oauth_apps SET gmail_api_disabled_at = NULL WHERE id = $1 AND gmail_api_disabled_at IS NOT NULL', [appId]);
}

const PUBLIC_APP_COLUMNS = 'id, label, client_id, project_number, user_limit, status, gmail_api_disabled_at, created_at';
const LABEL_MAX = 100;

function normalizeLabel(label) {
  const value = typeof label === 'string' ? label.trim() : '';
  if (!value || value.length > LABEL_MAX) throw new GoogleAppError('label_invalid');
  return value;
}

// Postgres' integer column caps at 2147483647 (int32); a larger value would fail the write
// with a 500 instead of a validation error.
const USER_LIMIT_MAX = 2147483647;

function normalizeUserLimit(userLimit) {
  if (!Number.isInteger(userLimit) || userLimit <= 0 || userLimit > USER_LIMIT_MAX) {
    throw new GoogleAppError('user_limit_invalid');
  }
  return userLimit;
}

// Shared by listGoogleApps and getGoogleAppSummary: the seats Google has counted and the
// mailboxes bound to each app. The secret is never selected.
const APPS_WITH_COUNTS_SELECT = `
  SELECT a.id, a.label, a.client_id, a.project_number, a.user_limit, a.status, a.gmail_api_disabled_at, a.created_at,
         (SELECT count(*) FROM google_oauth_grants g WHERE g.project_number = a.project_number)::int AS grants_count,
         (SELECT count(*) FROM email_accounts e WHERE e.oauth_app_id = a.id)::int AS accounts_count
  FROM google_oauth_apps a`;

// Apps for the admin screen, oldest first.
export async function listGoogleApps() {
  const { rows } = await query(`${APPS_WITH_COUNTS_SELECT} ORDER BY a.created_at, a.id`);
  return rows;
}

// One app with the same counted columns as listGoogleApps, for a fresh read after a write.
// Null when the app is missing.
export async function getGoogleAppSummary(appId) {
  const { rows } = await query(`${APPS_WITH_COUNTS_SELECT} WHERE a.id = $1`, [appId]);
  return rows[0] || null;
}

// One app per Google Cloud project: clients of one project share its user cap, so a second
// client of the same project would only pretend to add seats.
export async function createGoogleApp({ label, clientId, clientSecret, userLimit = 100 }) {
  const normalizedLabel = normalizeLabel(label);
  const projectNumber = parseGoogleClientId(clientId);
  if (!projectNumber) throw new GoogleAppError('client_id_invalid');
  if (typeof clientSecret !== 'string' || !clientSecret.trim()) throw new GoogleAppError('client_secret_required');
  const limit = normalizeUserLimit(userLimit);
  const normalizedClientId = clientId.trim();

  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-import'))");
    const same = await client.query('SELECT id FROM google_oauth_apps WHERE client_id = $1', [normalizedClientId]);
    if (same.rows.length) throw new GoogleAppError('app_exists');
    const project = await client.query('SELECT id FROM google_oauth_apps WHERE project_number = $1', [projectNumber]);
    if (project.rows.length) throw new GoogleAppError('app_same_project');
    const inserted = await client.query(
      `INSERT INTO google_oauth_apps (label, client_id, client_secret, project_number, user_limit)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_APP_COLUMNS}`,
      [normalizedLabel, normalizedClientId, encrypt(clientSecret.trim()), projectNumber, limit],
    );
    return inserted.rows[0];
  });
}

// The client ID never changes: another client ID is another app. A missing or empty secret
// keeps the stored one. Status changes go through setGoogleAppStatus.
export async function updateGoogleApp(appId, { label, clientSecret, userLimit } = {}) {
  const newLabel = label === undefined ? null : normalizeLabel(label);
  const newLimit = userLimit === undefined ? null : normalizeUserLimit(userLimit);
  const newSecret = typeof clientSecret === 'string' && clientSecret.trim() ? encrypt(clientSecret.trim()) : null;
  const { rows } = await query(
    `UPDATE google_oauth_apps SET
       label = COALESCE($2, label), client_secret = COALESCE($3, client_secret),
       user_limit = COALESCE($4, user_limit), updated_at = NOW()
     WHERE id = $1 RETURNING ${PUBLIC_APP_COLUMNS}`,
    [appId, newLabel, newSecret, newLimit],
  );
  if (!rows.length) throw new GoogleAppError('app_not_found');
  return rows[0];
}

// Only an app without mailboxes can go: a bound mailbox's refresh token works with no other
// client. Its grant journal stays: it belongs to the Cloud project, whose users Google keeps
// counting, and a client of that project added again finds it.
export async function deleteGoogleApp(appId) {
  await withTransaction(async (client) => {
    const bound = await client.query(
      'SELECT count(*)::int AS n FROM email_accounts WHERE oauth_app_id = $1',
      [appId],
    );
    if (bound.rows[0].n > 0) throw new GoogleAppError('app_in_use');
    const deleted = await client.query('DELETE FROM google_oauth_apps WHERE id = $1', [appId]);
    if (!deleted.rowCount) throw new GoogleAppError('app_not_found');
  });
}

const KNOWN_EMAILS_LIMIT = 8;

// Addresses Google has issued tokens to that no mailbox uses any more, for the "connected
// before" hint of the Gmail form. Addresses only: no apps, no dates. Only projects that still have
// an app: an address of a deleted one would need a new seat.
export async function findKnownGoogleEmails(q) {
  const pattern = String(q).trim().toLowerCase().replace(/[\\%_]/g, '\\$&');
  const { rows } = await query(
    `SELECT DISTINCT g.email FROM google_oauth_grants g
     WHERE g.email LIKE '%' || $1 || '%' ESCAPE '\\'
       AND EXISTS (SELECT 1 FROM google_oauth_apps a WHERE a.project_number = g.project_number)
       AND NOT EXISTS (SELECT 1 FROM email_accounts e WHERE lower(e.email_address) = g.email)
     ORDER BY g.email LIMIT ${KNOWN_EMAILS_LIMIT}`,
    [pattern],
  );
  return rows.map((row) => row.email);
}

// system_settings key recording that the single-app settings were taken over by the app registry.
const LEGACY_IMPORT_DONE_KEY = 'google_oauth_legacy_import_done';

async function markLegacyImportDone(client) {
  await client.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, 'true', NOW())
     ON CONFLICT (key) DO NOTHING`,
    [LEGACY_IMPORT_DONE_KEY],
  );
}

// One-time import of the single-app settings (Settings → Integrations, or the
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment) as the first app. Runs at every
// startup. Once an app exists, or an import ran, it is recorded and never runs again: an app the
// administrator deleted must not come back from environment variables still passed to the backend.
// While no app ever existed and there is nothing to import, nothing is recorded, so a client set
// later is still imported.
export async function importLegacyGoogleConfig() {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-import'))");
    const done = await client.query('SELECT 1 FROM system_settings WHERE key = $1', [LEGACY_IMPORT_DONE_KEY]);
    if (done.rows.length) return null;
    const existing = await client.query('SELECT 1 FROM google_oauth_apps LIMIT 1');
    if (existing.rows.length) {
      await markLegacyImportDone(client);
      return null;
    }

    const stored = await client.query("SELECT config FROM integration_config WHERE provider = 'google'");
    const config = stored.rows[0]?.config || {};
    let source = null;
    if (config.clientId && config.clientSecret) {
      source = { from: 'the stored integration settings', clientId: config.clientId, clientSecret: decrypt(config.clientSecret) };
    } else if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      source = { from: 'the environment', clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
    }
    if (!source) return null;

    const projectNumber = parseGoogleClientId(source.clientId);
    if (!projectNumber) {
      console.error(`Google OAuth: the client ID from ${source.from} is not a Google OAuth client ID; add the app again in Settings → Integrations`);
      return null;
    }
    if (!source.clientSecret) {
      console.error(`Google OAuth: the client secret from ${source.from} cannot be decrypted; add the app again in Settings → Integrations`);
      return null;
    }

    const inserted = await client.query(
      `INSERT INTO google_oauth_apps (label, client_id, client_secret, project_number)
       VALUES ('Google 1', $1, $2, $3) RETURNING id`,
      [source.clientId.trim(), encrypt(source.clientSecret), projectNumber],
    );
    const appId = inserted.rows[0].id;
    await client.query(
      `UPDATE email_accounts SET oauth_app_id = $1 WHERE oauth_provider = 'google' AND oauth_app_id IS NULL`,
      [appId],
    );
    await client.query(
      `INSERT INTO google_oauth_grants (project_number, email)
       SELECT DISTINCT $2::text, lower(email_address) FROM email_accounts WHERE oauth_app_id = $1
       ON CONFLICT (project_number, email) DO NOTHING`,
      [appId, projectNumber],
    );
    if (stored.rows.length) {
      await client.query(
        `UPDATE integration_config
         SET config = jsonb_strip_nulls(jsonb_build_object('redirectUri', config->'redirectUri')), updated_at = NOW()
         WHERE provider = 'google'`,
      );
    }
    await markLegacyImportDone(client);
    console.log(`Google OAuth: imported the client from ${source.from} as app "Google 1"`);
    return appId;
  });
}
