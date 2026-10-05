import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn) => fn(client)),
}));
import { query } from '../services/db.js';
import {
  ENABLED_PLUGINS_KEY, getEnabledPlugins, isPluginEnabled, setPluginEnabled, invalidateEnabledPluginsCache,
  parseEnabledPlugins,
} from './activation.js';

// The locked read inside setPluginEnabled answers with `stored`; the INSERT/UPDATE answer empty.
function storedValue(stored) {
  client.query.mockImplementation(async (sql) => (/SELECT value/.test(sql) ? { rows: stored == null ? [] : [{ value: stored }] } : { rows: [] }));
}

describe('panel-wide plugin switch', () => {
  beforeEach(() => {
    query.mockReset();
    client.query.mockReset();
    invalidateEnabledPluginsCache();
  });

  it('reads the enabled set from the system_settings row', async () => {
    query.mockResolvedValueOnce({ rows: [{ value: '["gtd","other"]' }] });
    expect(await getEnabledPlugins()).toEqual(new Set(['gtd', 'other']));
    expect(query.mock.calls[0][0]).toMatch(/FROM system_settings WHERE key = \$1/);
    expect(query.mock.calls[0][1]).toEqual([ENABLED_PLUGINS_KEY]);
  });

  it('treats a missing row as nothing enabled', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getEnabledPlugins()).toEqual(new Set());
  });

  it('treats malformed text, a non-array and non-string ids as nothing enabled', () => {
    expect(parseEnabledPlugins('not json')).toEqual([]);
    expect(parseEnabledPlugins('{"gtd":true}')).toEqual([]);
    expect(parseEnabledPlugins('["gtd",7,null,"gtd"]')).toEqual(['gtd']);
    expect(parseEnabledPlugins(undefined)).toEqual([]);
  });

  it('degrades to empty on a read failure', async () => {
    query.mockRejectedValueOnce(new Error('db boom'));
    expect(await getEnabledPlugins()).toEqual(new Set());
  });

  it('caches until invalidated, and isPluginEnabled answers from the same read', async () => {
    query.mockResolvedValueOnce({ rows: [{ value: '["gtd"]' }] });
    expect(await isPluginEnabled('gtd')).toBe(true);
    expect(await isPluginEnabled('nope')).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    invalidateEnabledPluginsCache();
    query.mockResolvedValueOnce({ rows: [{ value: '[]' }] });
    expect(await isPluginEnabled('gtd')).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('setPluginEnabled locks the row, writes the sorted list and drops the cache', async () => {
    query.mockResolvedValueOnce({ rows: [{ value: '[]' }] });
    await getEnabledPlugins(); // warm the cache with "nothing enabled"

    storedValue('["zeta"]');
    const result = await setPluginEnabled('gtd', true);
    expect(result).toEqual({ enabled: new Set(['zeta', 'gtd']), changed: true });
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toMatch(/INSERT INTO system_settings .* ON CONFLICT \(key\) DO NOTHING/s);
    expect(sqls[1]).toMatch(/FOR UPDATE/);
    const update = client.query.mock.calls.find(([sql]) => /UPDATE system_settings/.test(sql));
    expect(update[1]).toEqual([ENABLED_PLUGINS_KEY, '["gtd","zeta"]']);

    query.mockResolvedValueOnce({ rows: [{ value: '["gtd","zeta"]' }] });
    expect(await isPluginEnabled('gtd')).toBe(true); // re-read, not the stale cache
  });

  it('setPluginEnabled removes an id when disabling', async () => {
    storedValue('["gtd","other"]');
    const result = await setPluginEnabled('gtd', false);
    expect(result).toEqual({ enabled: new Set(['other']), changed: true });
    const update = client.query.mock.calls.find(([sql]) => /UPDATE system_settings/.test(sql));
    expect(update[1]).toEqual([ENABLED_PLUGINS_KEY, '["other"]']);
  });

  it('setPluginEnabled reports no change and writes nothing when the state is already that', async () => {
    storedValue('["gtd"]');
    expect((await setPluginEnabled('gtd', true)).changed).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => /UPDATE system_settings/.test(sql))).toBe(false);
  });
});
