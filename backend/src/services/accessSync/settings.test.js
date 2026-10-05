import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../encryption.js', () => ({
  encrypt: vi.fn((value) => `enc:${value}`),
  decrypt: vi.fn((value) => (value.startsWith('enc:') ? value.slice(4) : null)),
}));

import { query, withTransaction } from '../db.js';
import {
  ACCESS_SYNC_CONFIG_KEY, ACCESS_SYNC_STATE_KEY, accessSyncMaxDisables, isAccessSyncEnabled, loadRunConfig, loadState,
  loadStoredConfig, publicConfig, saveConfig, saveState,
} from './settings.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const OTHER_POLICY = '66666666-7777-4888-9999-000000000001';
const full = { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'tok-secret' };

// system_settings as a map, reached only through the two statements the module may use.
let store;
beforeEach(() => {
  store = new Map();
  query.mockReset();
  // A transaction here is the same store; the lock statement is the only extra SQL it sees.
  withTransaction.mockImplementation(async (fn) => fn({ query: (...args) => query(...args) }));
  query.mockImplementation(async (sql, params) => {
    if (sql === "SELECT pg_advisory_xact_lock(hashtext('mailexpert:access_sync'))") return { rows: [] };
    if (/^SELECT value FROM system_settings WHERE key = \$1$/.test(sql)) {
      return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
    }
    if (/^INSERT INTO system_settings \(key, value, updated_at\) VALUES \(\$1, \$2, NOW\(\)\)\s+ON CONFLICT \(key\) DO UPDATE SET value = \$2, updated_at = NOW\(\)$/.test(sql)) {
      store.set(params[0], params[1]);
      return { rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
});
const stored = (key) => JSON.parse(store.get(key));

describe('accessSyncMaxDisables', () => {
  it('reads a non-negative integer and falls back to 10', () => {
    expect(accessSyncMaxDisables({})).toBe(10);
    expect(accessSyncMaxDisables({ ACCESS_SYNC_MAX_DISABLES: ' 3 ' })).toBe(3);
    expect(accessSyncMaxDisables({ ACCESS_SYNC_MAX_DISABLES: '0' })).toBe(0);
    expect(accessSyncMaxDisables({ ACCESS_SYNC_MAX_DISABLES: '-1' })).toBe(10);
    expect(accessSyncMaxDisables({ ACCESS_SYNC_MAX_DISABLES: 'many' })).toBe(10);
  });
});

describe('settings', () => {
  it('starts off, with no token and no state', async () => {
    const config = await loadStoredConfig();
    expect(publicConfig(config)).toEqual({ enabled: false, accountId: '', appId: '', policyId: '', apiTokenSet: false });
    expect(await loadRunConfig()).toBeNull();
    expect(await loadState()).toEqual({ baseline: [], abortedCandidates: null, lastRun: null });
  });

  it('stores the token encrypted and never shows it', async () => {
    await saveConfig({ ...full, accountId: ACCOUNT.toUpperCase() });
    expect(stored(ACCESS_SYNC_CONFIG_KEY)).toEqual({ ...full, apiToken: 'enc:tok-secret' });
    const shown = publicConfig(await loadStoredConfig());
    expect(shown).toEqual({ enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiTokenSet: true });
    expect(JSON.stringify(shown)).not.toContain('tok-secret');
    expect(await loadRunConfig()).toEqual({ accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'tok-secret' });
  });

  it('keeps the stored token when the field is blank and replaces it when a new one is given', async () => {
    await saveConfig(full);
    await saveConfig({ ...full, apiToken: '  ' });
    expect(stored(ACCESS_SYNC_CONFIG_KEY).apiToken).toBe('enc:tok-secret');
    await saveConfig({ ...full, apiToken: 'tok-new' });
    expect(stored(ACCESS_SYNC_CONFIG_KEY).apiToken).toBe('enc:tok-new');
  });

  it('refuses malformed or incomplete settings and saves incomplete ones while off', async () => {
    await expect(saveConfig({ ...full, enabled: 'yes' })).rejects.toMatchObject({ code: 'invalid_field' });
    await expect(saveConfig({ ...full, accountId: 'not-an-id' })).rejects.toMatchObject({ code: 'invalid_id' });
    await expect(saveConfig({ ...full, policyId: '1234' })).rejects.toMatchObject({ code: 'invalid_id' });
    await expect(saveConfig({ ...full, apiToken: '' })).rejects.toMatchObject({ code: 'incomplete' });
    expect(store.size).toBe(0);
    await saveConfig({ enabled: false, accountId: ACCOUNT });
    expect(await loadRunConfig()).toBeNull();
  });

  it('forgets the baseline when the sync points at another policy', async () => {
    await saveConfig(full);
    await saveState({ baseline: ['a@example.com'], abortedCandidates: ['b@example.com'], lastRun: { outcome: 'updated' } });
    await saveConfig({ ...full, apiToken: '' });
    expect(stored(ACCESS_SYNC_STATE_KEY).baseline).toEqual(['a@example.com']);
    await saveConfig({ ...full, apiToken: '', policyId: OTHER_POLICY });
    expect(stored(ACCESS_SYNC_STATE_KEY)).toEqual({ baseline: [], abortedCandidates: null, lastRun: { outcome: 'updated' } });
  });

  it('writes the state key before the config key when retargeting', async () => {
    await saveConfig(full);
    const insertedKeys = [];
    query.mockImplementation(async (sql, params) => {
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/^SELECT value FROM system_settings WHERE key = \$1$/.test(sql)) {
        return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
      }
      if (/^INSERT INTO system_settings/.test(sql)) {
        insertedKeys.push(params[0]);
        store.set(params[0], params[1]);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await saveConfig({ ...full, apiToken: '', policyId: OTHER_POLICY });
    expect(insertedKeys).toEqual([ACCESS_SYNC_STATE_KEY, ACCESS_SYNC_CONFIG_KEY]);
  });

  it('resets the baseline before writing the config, so a failed config write cannot leave a stale baseline', async () => {
    await saveConfig(full);
    await saveState({ baseline: ['a@example.com'], abortedCandidates: ['b@example.com'], lastRun: { outcome: 'updated' } });
    query.mockImplementation(async (sql, params) => {
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/^SELECT value FROM system_settings WHERE key = \$1$/.test(sql)) {
        return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
      }
      if (/^INSERT INTO system_settings/.test(sql)) {
        if (params[0] === ACCESS_SYNC_CONFIG_KEY) throw new Error('config write failed');
        store.set(params[0], params[1]);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(saveConfig({ ...full, apiToken: '', policyId: OTHER_POLICY })).rejects.toThrow('config write failed');
    expect(stored(ACCESS_SYNC_STATE_KEY)).toEqual({ baseline: [], abortedCandidates: null, lastRun: { outcome: 'updated' } });
    expect(stored(ACCESS_SYNC_CONFIG_KEY).policyId).toBe(POLICY);
  });

  it('reports whether the sync is on', async () => {
    expect(await isAccessSyncEnabled()).toBe(false);
    await saveConfig(full);
    expect(await isAccessSyncEnabled()).toBe(true);
    await saveConfig({ ...full, enabled: false, apiToken: '' });
    expect(await isAccessSyncEnabled()).toBe(false);
  });

  it('hands a run a null token it cannot decrypt, and survives a corrupt state', async () => {
    store.set(ACCESS_SYNC_CONFIG_KEY, JSON.stringify({ ...full, apiToken: 'garbage' }));
    expect(await loadRunConfig()).toEqual({ accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: null });
    store.set(ACCESS_SYNC_STATE_KEY, 'not json');
    expect(await loadState()).toEqual({ baseline: [], abortedCandidates: null, lastRun: null });
  });
});
