// Panel-wide plugin switch (v3.0 plugin platform).
//
// Registration (loadBundledPlugins) says a plugin EXISTS in this build; the switch says an
// administrator turned it ON for the whole panel. Every user gets an enabled plugin, nobody gets a
// disabled one: mailboxes are shared, so a per-user switch could never mean anything for the
// server-side half of a plugin. A plugin's own per-account config (e.g. GTD's gtd_enabled /
// gtd_folders) is a deeper layer the plugin owns; the effective "is this plugin doing anything for
// this mailbox" is the switch AND the plugin's config (GTD composes this inside getGtdConfig).
// Genuinely personal plugin settings (GTD's pet, collapsed sections) stay in users.preferences.
//
// State lives in system_settings under ENABLED_PLUGINS_KEY: a JSON array of plugin ids, stored as
// text like every other panel-wide setting. Absent or malformed = nothing enabled (default OFF).
// Migration 0092 carried the former per-user users.preferences.enabledPlugins over into it.
// A short-TTL cache keeps the hot paths (getGtdConfig et al.) from hitting the DB on every call;
// setPluginEnabled drops it, so the change takes effect at once in this process.
import { query, withTransaction } from '../services/db.js';

export const ENABLED_PLUGINS_KEY = 'enabled_plugins';

const CACHE_TTL_MS = 5 * 60 * 1000;
// After a failed read the "nothing enabled" answer is kept only this long, so a database blip
// switches plugins off for seconds, not for the whole TTL.
export const ERROR_CACHE_TTL_MS = 5 * 1000;
let cache = null; // { value: Set<pluginId>, expiry }

export function invalidateEnabledPluginsCache() {
  cache = null;
}

// The stored text as a list of plugin ids; anything that is not a JSON array of strings reads as
// nothing enabled.
export function parseEnabledPlugins(text) {
  if (typeof text !== 'string') return [];
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? [...new Set(list.filter((id) => typeof id === 'string'))] : [];
  } catch {
    return [];
  }
}

// The set of plugin ids enabled for the panel. Cached with a short TTL.
export async function getEnabledPlugins() {
  if (cache && cache.expiry > Date.now()) return cache.value;
  let value;
  let ttl = CACHE_TTL_MS;
  try {
    const { rows } = await query('SELECT value FROM system_settings WHERE key = $1', [ENABLED_PLUGINS_KEY]);
    value = new Set(parseEnabledPlugins(rows[0]?.value));
  } catch {
    // A settings read blip degrades to "nothing enabled" rather than throwing on a hot path, and
    // is retried soon: briefly cached so a hot path does not hammer a struggling database.
    value = new Set();
    ttl = ERROR_CACHE_TTL_MS;
  }
  cache = { value, expiry: Date.now() + ttl };
  return value;
}

// Whether a plugin is enabled for the panel: the gate plugins compose with their own config.
export async function isPluginEnabled(pluginId) {
  return (await getEnabledPlugins()).has(pluginId);
}

// Turn a plugin on or off for everyone. The row is locked for the read-modify-write, so two
// administrators switching different plugins at once never lose each other's change. Returns
// { enabled: Set, changed } — changed is false when the plugin was already in that state.
export async function setPluginEnabled(pluginId, enabled) {
  const result = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, '[]', NOW())
       ON CONFLICT (key) DO NOTHING`,
      [ENABLED_PLUGINS_KEY],
    );
    const { rows } = await client.query(
      'SELECT value FROM system_settings WHERE key = $1 FOR UPDATE',
      [ENABLED_PLUGINS_KEY],
    );
    const set = new Set(parseEnabledPlugins(rows[0]?.value));
    const changed = set.has(pluginId) !== enabled;
    if (enabled) set.add(pluginId); else set.delete(pluginId);
    if (changed) {
      await client.query(
        'UPDATE system_settings SET value = $2, updated_at = NOW() WHERE key = $1',
        [ENABLED_PLUGINS_KEY, JSON.stringify([...set].sort())],
      );
    }
    return { enabled: set, changed };
  });
  invalidateEnabledPluginsCache();
  return result;
}
