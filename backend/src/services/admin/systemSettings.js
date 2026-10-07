import { query } from '../db.js';
import {
  FOLDER_SYNC_INTERVAL_KEY, SYNC_INTERVAL_KEY, parseFolderSyncIntervalSec, parseSyncIntervalSec,
} from '../syncSettings.js';

// The install-wide settings an administrator changes (system_settings), shared by the admin API
// (routes/admin.js, PATCH /api/admin/settings) and the panel CLI (cli/commands/settings.js): the
// same keys, checks and refusals. What the backend keeps in memory is read again through the
// answer's effects (services/admin/adminEffects.js): the route applies them, the CLI queues them.

// The keys PATCH /api/admin/settings takes, in the order it writes them.
export const SYSTEM_SETTING_KEYS = Object.freeze([
  'registration_open', 'internal_auth_disabled', 'auth_max_attempts', 'auth_window_minutes',
  'allow_private_hosts', 'allow_insecure_tls', 'allow_nonstandard_ports',
  'mfa_enforcement', 'mfa_device_trust', 'custom_css',
  SYNC_INTERVAL_KEY, FOLDER_SYNC_INTERVAL_KEY, 'categorization_enabled',
]);

// How each key's value is given: boolean, integer (a number or its digits) or text.
export const SYSTEM_SETTING_TYPES = Object.freeze({
  registration_open: 'boolean',
  internal_auth_disabled: 'boolean',
  auth_max_attempts: 'integer',
  auth_window_minutes: 'integer',
  allow_private_hosts: 'boolean',
  allow_insecure_tls: 'boolean',
  allow_nonstandard_ports: 'boolean',
  mfa_enforcement: 'text',
  mfa_device_trust: 'text',
  custom_css: 'text',
  [SYNC_INTERVAL_KEY]: 'integer',
  [FOLDER_SYNC_INTERVAL_KEY]: 'integer',
  categorization_enabled: 'boolean',
});

// code -> [HTTP status, message]. CODED: the refusals the route answers with their code; the others
// it has always answered with the message only.
export const SYSTEM_SETTINGS_ERRORS = Object.freeze({
  invalid_field: [400, 'Invalid setting'],
  no_sso_provider: [400, 'Cannot disable password login: no enabled SSO providers are configured.'],
  sso_identity_required: [400, 'Cannot disable password login: link your account to an SSO provider first so you can still sign in.'],
  auth_max_attempts_invalid: [400, 'auth_max_attempts must be between 1 and 100'],
  auth_window_minutes_invalid: [400, 'auth_window_minutes must be between 1 and 1440'],
  mfa_enforcement_invalid: [400, 'mfa_enforcement must be "off" or "required"'],
  mfa_device_trust_invalid: [400, 'mfa_device_trust must be "never", "7d", "30d", or "permanent"'],
  custom_css_invalid: [400, 'custom_css must be a string'],
  custom_css_too_long: [400, 'custom_css must not exceed 50,000 characters'],
});
export const SYSTEM_SETTINGS_CODED = Object.freeze(new Set(['invalid_field']));

const refuse = (code, message) => ({ error: code, ...(message ? { message } : {}) });
const actorLabel = (actor) => actor?.userId ?? actor?.via ?? 'unknown';

const upsert = (key, value) => query(
  `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
   ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
  [key, value],
);

// The stored values of the keys above ({ key: value }, a key never set left out).
export async function getSystemSettings() {
  const { rows } = await query('SELECT key, value FROM system_settings WHERE key = ANY($1::text[])', [[...SYSTEM_SETTING_KEYS]]);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

// Writes the given keys, as PATCH /api/admin/settings always has: each key is checked as it comes,
// so a refusal leaves the keys before it written (the intervals and categorization_enabled are
// checked before anything is). Turning password login off needs an enabled SSO provider and an SSO
// identity of the actor (an administrator; the CLI's --as), so they can still sign in.
// Answers { ok, effects } or { error, message?, effects }.
export async function updateSystemSettings(body, actor) {
  const { registration_open, internal_auth_disabled, auth_max_attempts, auth_window_minutes,
    allow_private_hosts, allow_insecure_tls, allow_nonstandard_ports,
    mfa_enforcement, mfa_device_trust, custom_css,
    sync_interval_sec, folder_sync_interval_sec, categorization_enabled } = body || {};
  // What was reloaded before a refusal is still reloaded: the route always did that much.
  const reload = [];
  const fail = (code, message) => ({ ...refuse(code, message), effects: { reload: [...reload] } });
  const syncIntervalSec = sync_interval_sec === undefined ? null : parseSyncIntervalSec(sync_interval_sec);
  if (sync_interval_sec !== undefined && syncIntervalSec === null) {
    return fail('invalid_field', 'sync_interval_sec must be 15, 30, 60 or 120');
  }
  const folderSyncIntervalSec = folder_sync_interval_sec === undefined ? null : parseFolderSyncIntervalSec(folder_sync_interval_sec);
  if (folder_sync_interval_sec !== undefined && folderSyncIntervalSec === null) {
    return fail('invalid_field', 'folder_sync_interval_sec must be 0, 900, 1800 or 3600');
  }
  if (categorization_enabled !== undefined && typeof categorization_enabled !== 'boolean') {
    return fail('invalid_field', 'categorization_enabled must be a boolean');
  }
  if (typeof registration_open === 'boolean') {
    await upsert('registration_open', registration_open ? 'true' : 'false');
  }
  if (typeof internal_auth_disabled === 'boolean') {
    if (internal_auth_disabled) {
      // Safety: at least one enabled OIDC provider must exist so users have a way to sign in after
      // password login is blocked.
      const provCheck = await query('SELECT COUNT(*) AS count FROM oidc_providers WHERE enabled = true');
      if (parseInt(provCheck.rows[0].count) === 0) return fail('no_sso_provider');
      // Safety: the requesting admin must have a linked SSO identity so they can still sign in
      // after their current session expires.
      const idCheck = await query('SELECT COUNT(*) AS count FROM user_identities WHERE user_id = $1', [actor?.userId ?? null]);
      if (parseInt(idCheck.rows[0].count) === 0) return fail('sso_identity_required');
    }
    await upsert('internal_auth_disabled', internal_auth_disabled ? 'true' : 'false');
    console.log(`[admin] ${actorLabel(actor)} set internal_auth_disabled=${internal_auth_disabled}`);
  }
  if (auth_max_attempts != null) {
    const val = parseInt(auth_max_attempts);
    if (!Number.isInteger(val) || val < 1 || val > 100) return fail('auth_max_attempts_invalid');
    await upsert('auth_max_attempts', String(val));
  }
  if (auth_window_minutes != null) {
    const val = parseInt(auth_window_minutes);
    if (!Number.isInteger(val) || val < 1 || val > 1440) return fail('auth_window_minutes_invalid');
    await upsert('auth_window_minutes', String(val));
  }
  if (auth_max_attempts != null || auth_window_minutes != null) reload.push('auth_limits');
  for (const [key, val] of [
    ['allow_private_hosts', allow_private_hosts],
    ['allow_insecure_tls', allow_insecure_tls],
    ['allow_nonstandard_ports', allow_nonstandard_ports],
  ]) {
    if (typeof val === 'boolean') {
      await upsert(key, val ? 'true' : 'false');
      console.log(`[admin] ${actorLabel(actor)} set ${key}=${val}`);
    }
  }
  if (mfa_enforcement != null) {
    if (!['off', 'required'].includes(mfa_enforcement)) return fail('mfa_enforcement_invalid');
    await upsert('mfa_enforcement', mfa_enforcement);
    console.log(`[admin] ${actorLabel(actor)} set mfa_enforcement=${mfa_enforcement}`);
  }
  if (mfa_device_trust != null) {
    if (!['never', '7d', '30d', 'permanent'].includes(mfa_device_trust)) return fail('mfa_device_trust_invalid');
    await upsert('mfa_device_trust', mfa_device_trust);
    console.log(`[admin] ${actorLabel(actor)} set mfa_device_trust=${mfa_device_trust}`);
  }
  if (custom_css !== undefined) {
    if (typeof custom_css !== 'string') return fail('custom_css_invalid');
    if (custom_css.length > 50000) return fail('custom_css_too_long');
    const sanitized = custom_css.replace(/\0/g, '');
    await upsert('custom_css', sanitized);
    console.log(`[admin] ${actorLabel(actor)} updated custom_css (${sanitized.length} chars)`);
  }
  if (syncIntervalSec !== null || folderSyncIntervalSec !== null) {
    for (const [key, seconds] of [[SYNC_INTERVAL_KEY, syncIntervalSec], [FOLDER_SYNC_INTERVAL_KEY, folderSyncIntervalSec]]) {
      if (seconds === null) continue;
      await upsert(key, String(seconds));
    }
    reload.push('sync_intervals');
    console.log(`[admin] ${actorLabel(actor)} changed mailbox sync intervals`);
  }
  if (typeof categorization_enabled === 'boolean') {
    await upsert('categorization_enabled', categorization_enabled ? 'true' : 'false');
    reload.push('categorization');
    console.log(`[admin] ${actorLabel(actor)} set categorization_enabled=${categorization_enabled}`);
  }
  reload.push('connection_policy');
  return { ok: true, effects: { reload } };
}
