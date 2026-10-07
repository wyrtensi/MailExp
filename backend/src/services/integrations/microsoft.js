import { query } from '../db.js';
import { decrypt, encrypt, isEncrypted } from '../encryption.js';

// The Microsoft OAuth client the panel connects Outlook mailboxes with (integration_config row
// 'microsoft'), shared by the admin API (routes/integrations.js, /api/integrations/microsoft) and
// the panel CLI (cli/commands/integration.js). The client secret is stored encrypted and answered
// only as the placeholder. The OAuth routes read the client from process.env (MS_*), which the
// backend's process sets from the row: the route at once, the CLI through a queued job
// (services/admin/adminEffects.js, reload "microsoft").

export const MICROSOFT_PROVIDER = 'microsoft';
// Placeholder sent instead of a stored client secret; posting it back keeps the stored value.
export const REDACTED_SECRET = '••••••••';

export const MICROSOFT_INTEGRATION_ERRORS = Object.freeze({
  client_secret_redacted: [400, 'Client secret contains the redaction placeholder; enter the full secret'],
});

// A stored config as the API answers it: the secret replaced by the placeholder.
export function redactConfig(config) {
  const cfg = { ...config };
  if (cfg.clientSecret) cfg.clientSecret = REDACTED_SECRET;
  return cfg;
}

// The stored Microsoft client, redacted, with updated_at; null when none is stored.
export async function getMicrosoftIntegration() {
  const { rows } = await query('SELECT config, updated_at FROM integration_config WHERE provider = $1', [MICROSOFT_PROVIDER]);
  if (!rows.length) return null;
  return { ...redactConfig(rows[0].config), updated_at: rows[0].updated_at };
}

// Stores the client (config as the screen sends it: clientId, clientSecret, tenantId,
// redirectUri). The placeholder as the secret keeps the stored one; a secret that merely contains
// the placeholder's bullet was typed into the redacted field and is refused, so junk never
// replaces the real secret. Answers { ok, config } (config as stored, the secret encrypted).
export async function saveMicrosoftIntegration(input) {
  const config = { ...(input || {}) };
  if (typeof config.clientSecret === 'string' && config.clientSecret !== REDACTED_SECRET && config.clientSecret.includes('•')) {
    return { error: 'client_secret_redacted' };
  }
  // If clientSecret is redacted, keep the existing stored value (already encrypted or legacy plaintext)
  if (config.clientSecret === REDACTED_SECRET) {
    const existing = await query('SELECT config FROM integration_config WHERE provider = $1', [MICROSOFT_PROVIDER]);
    if (existing.rows.length) config.clientSecret = existing.rows[0].config.clientSecret;
    else delete config.clientSecret;
  }
  // Encrypt clientSecret at rest — handles both new writes and migration of legacy plaintext values
  if (config.clientSecret && !isEncrypted(config.clientSecret)) {
    config.clientSecret = encrypt(config.clientSecret);
  }
  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = EXCLUDED.config, updated_at = NOW()
  `, [MICROSOFT_PROVIDER, config]);
  return { ok: true, config };
}

export async function removeMicrosoftIntegration() {
  await query('DELETE FROM integration_config WHERE provider = $1', [MICROSOFT_PROVIDER]);
  return { ok: true };
}

// Writes a stored config's plaintext values to process.env, where the OAuth routes read them.
export function applyMicrosoftEnv(config) {
  if (config.clientId) process.env.MS_CLIENT_ID = config.clientId;
  // decrypt() returns value unchanged for plaintext (migration fallback)
  if (config.clientSecret) process.env.MS_CLIENT_SECRET = decrypt(config.clientSecret);
  if (config.tenantId) process.env.MS_TENANT_ID = config.tenantId;
  if (config.redirectUri) process.env.MS_REDIRECT_URI = config.redirectUri;
}

export function clearMicrosoftEnv() {
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;
  delete process.env.MS_TENANT_ID;
  delete process.env.MS_REDIRECT_URI;
}

// Brings process.env in line with the stored row after a change made elsewhere (the CLI): the
// row's values when one is stored (a field the row leaves empty is cleared, not kept from before);
// none when it was removed, as a removal does.
export async function reloadMicrosoftEnv() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [MICROSOFT_PROVIDER]);
  clearMicrosoftEnv();
  if (rows.length) applyMicrosoftEnv(rows[0].config);
}
