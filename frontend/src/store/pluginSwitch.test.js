import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// The panel-wide plugin switch in the store: loaded from GET /api/plugins with the preferences for
// every signed-in user (not from their own preferences), changed through the admin-only PATCH.

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return {
        format: 'module',
        source: `export default ${readFileSync(new URL(url), 'utf8')}`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

globalThis.localStorage = (() => {
  let values = {};
  return {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: key => { delete values[key]; },
    clear: () => { values = {}; },
  };
})();

const { api } = await import('../utils/api.js');
const { useStore } = await import('./index.js');
const original = { getPreferences: api.getPreferences, list: api.plugins.list, setEnabled: api.plugins.setEnabled };

const GTD = { id: 'gtd', name: 'Getting Things Done', version: '1.0.0', tier: 1 };

describe('panel-wide plugin switch in the store', () => {
  beforeEach(() => {
    useStore.setState({ user: null, enabledPlugins: [] });
    // A personal enabledPlugins left in the preferences by the old per-user switch is ignored.
    api.getPreferences = async () => ({ enabledPlugins: ['stale'] });
  });

  afterEach(() => {
    api.getPreferences = original.getPreferences;
    api.plugins.list = original.list;
    api.plugins.setEnabled = original.setEnabled;
  });

  it('loads the switched-on plugins with the preferences, for a user who is not an administrator', async () => {
    useStore.getState().setUser({ id: 'user-1', isAdmin: false });
    api.plugins.list = async () => [{ ...GTD, enabled: true }, { id: 'other', enabled: false }];
    await useStore.getState().loadPreferences();
    assert.deepEqual(useStore.getState().enabledPlugins, ['gtd']);
  });

  it('keeps the current set when the list cannot be read', async () => {
    useStore.setState({ enabledPlugins: ['gtd'] });
    useStore.getState().setUser({ id: 'user-1' });
    api.plugins.list = async () => { throw new Error('offline'); };
    await useStore.getState().loadEnabledPlugins();
    assert.deepEqual(useStore.getState().enabledPlugins, ['gtd']);
  });

  it('discards a list that arrives after the signed-in user changed', async () => {
    let resolve;
    useStore.getState().setUser({ id: 'user-1' });
    api.plugins.list = () => new Promise((r) => { resolve = r; });
    const loading = useStore.getState().loadEnabledPlugins();
    useStore.getState().setUser({ id: 'user-2' });
    resolve([{ ...GTD, enabled: true }]);
    await loading;
    assert.deepEqual(useStore.getState().enabledPlugins, []);
  });

  it('switches a plugin through the admin route and updates the set', async () => {
    const calls = [];
    api.plugins.setEnabled = async (id, enabled) => { calls.push([id, enabled]); return { id, enabled }; };
    await useStore.getState().setPluginEnabled('gtd', true);
    assert.deepEqual(useStore.getState().enabledPlugins, ['gtd']);
    await useStore.getState().setPluginEnabled('gtd', false);
    assert.deepEqual(useStore.getState().enabledPlugins, []);
    assert.deepEqual(calls, [['gtd', true], ['gtd', false]]);
  });

  it('leaves the set alone when the server refuses the switch', async () => {
    useStore.setState({ enabledPlugins: ['gtd'] });
    api.plugins.setEnabled = async () => { throw Object.assign(new Error('Admin access required'), { status: 403 }); };
    await assert.rejects(() => useStore.getState().setPluginEnabled('gtd', false));
    assert.deepEqual(useStore.getState().enabledPlugins, ['gtd']);
  });
});
