import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// The panel-wide plugin switch on the real schema: migration 0092 carries the former per-user
// users.preferences.enabledPlugins over into system_settings, and the switch reads and writes it.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn(tx)),
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { getEnabledPlugins, setPluginEnabled, invalidateEnabledPluginsCache, ENABLED_PLUGINS_KEY } = await import('./activation.js');

const migration = readFileSync(new URL('../../migrations/0092_plugins_panel_wide.sql', import.meta.url), 'utf8');

let db;
let n = 0;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

beforeEach(async () => {
  await db.exec(`DELETE FROM users; DELETE FROM system_settings WHERE key = '${ENABLED_PLUGINS_KEY}';`);
  invalidateEnabledPluginsCache();
});

const addUser = ({ admin = false, disabled = false, preferences = {} } = {}) => {
  n += 1;
  return db.query(
    `INSERT INTO users (username, email, password_hash, is_admin, disabled_at, preferences)
     VALUES ($1, $2, 'x', $3, $4, $5::jsonb)`,
    [`user${n}`, `user${n}@example.test`, admin, disabled ? new Date().toISOString() : null, JSON.stringify(preferences)],
  );
};
const storedList = async () => {
  const { rows } = await db.query('SELECT value FROM system_settings WHERE key = $1', [ENABLED_PLUGINS_KEY]);
  return rows.length ? JSON.parse(rows[0].value) : undefined;
};

describe('migration 0092', () => {
  it('turns a plugin on for the panel when any active user, admin or not, had it on', async () => {
    await addUser({ admin: true, preferences: { enabledPlugins: ['gtd'] } });
    await addUser({ preferences: { enabledPlugins: ['zeta', 'gtd'] } });
    await addUser({ preferences: { theme: 'dark' } });
    await db.exec(migration);
    expect(await storedList()).toEqual(['gtd', 'zeta']);
  });

  it('ignores disabled users, malformed values and non-string ids', async () => {
    await addUser({ disabled: true, preferences: { enabledPlugins: ['gone'] } });
    await addUser({ preferences: { enabledPlugins: { gtd: true } } });
    await addUser({ preferences: { enabledPlugins: [7, null, 'ok'] } });
    await db.exec(migration);
    expect(await storedList()).toEqual(['ok']);
  });

  it('writes an empty list when nobody had a plugin on, so the row always exists', async () => {
    await addUser();
    await db.exec(migration);
    expect(await storedList()).toEqual([]);
  });

  it('keeps the per-user value in place and never overwrites a later choice', async () => {
    await addUser({ preferences: { enabledPlugins: ['gtd'] } });
    await db.exec(migration);
    await setPluginEnabled('gtd', false);
    await db.exec(migration);
    expect(await storedList()).toEqual([]);
    const { rows } = await db.query("SELECT preferences -> 'enabledPlugins' AS list FROM users");
    expect(rows[0].list).toEqual(['gtd']);
  });
});

describe('panel-wide switch on the real schema', () => {
  it('reads nothing enabled before the row exists, then follows an administrator', async () => {
    expect(await getEnabledPlugins()).toEqual(new Set());
    expect(await setPluginEnabled('gtd', true)).toEqual({ enabled: new Set(['gtd']), changed: true });
    expect(await getEnabledPlugins()).toEqual(new Set(['gtd']));
    expect((await setPluginEnabled('gtd', true)).changed).toBe(false);
    await setPluginEnabled('other', true);
    expect(await storedList()).toEqual(['gtd', 'other']);
    await setPluginEnabled('gtd', false);
    expect(await getEnabledPlugins()).toEqual(new Set(['other']));
  });
});
