// The sidebar account order preferences in the store: pinned accounts and "sort accounts by
// latest mail" are saved with the other per-user preferences (so they follow the user across
// devices), mirrored in localStorage, hydrated by loadPreferences, and the latest-received date
// of a mailbox only moves forward when a new_messages event notes it.

import { afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  Image: dom.window.Image, CustomEvent: dom.window.CustomEvent,
});

const ACCOUNTS = [
  { id: 'a', name: 'A', email_address: 'a@example.com', enabled: true, last_received_at: '2026-09-10T00:00:00.000Z' },
  { id: 'b', name: 'B', email_address: 'b@example.com', enabled: true, last_received_at: null },
  { id: 'c', name: 'C', email_address: 'c@example.com', enabled: true },
];

describe('account order preferences', () => {
  let useStore;
  let api;
  let saved;

  before(async () => {
    ({ useStore } = await import('./index.js'));
    ({ api } = await import('../utils/api.js'));
    // The queue flushes through savePreferencesOnExit when the page goes away: that is how the
    // tests see what was queued, without waiting out the debounce.
    api.savePreferencesOnExit = (prefs) => { saved.push(prefs); return Promise.resolve(); };
    api.savePreferences = (prefs) => { saved.push(prefs); return Promise.resolve(); };
  });

  const flush = () => {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  };

  beforeEach(() => {
    saved = [];
    localStorage.clear();
    useStore.setState({ pinnedAccounts: [], sortAccountsByLatest: true, accounts: ACCOUNTS, accountsReady: true });
  });
  // Whatever a test queued and did not flush must not leak into the next one (or keep a timer alive).
  afterEach(() => { flush(); saved = []; });

  it('sorts by latest mail unless it was switched off', () => {
    assert.equal(useStore.getState().sortAccountsByLatest, true);
  });

  it('pinning appends to the pins in order, keeps them in localStorage and tells the server each change at once', () => {
    useStore.getState().pinAccount('c');
    useStore.getState().pinAccount('a');
    assert.deepEqual(useStore.getState().pinnedAccounts, ['c', 'a']);
    assert.equal(localStorage.getItem('mailexpert_pinned_accounts'), JSON.stringify(['c', 'a']));
    // Two quick pins are two operations; the preference queue would have kept only the last.
    assert.deepEqual(saved, [{ pinAccount: 'c' }, { pinAccount: 'a' }]);
  });

  it('a pin the server refused is taken back, other pins stay, and the person is told', async () => {
    const realSave = api.savePreferences;
    useStore.setState({ notifications: [] });
    useStore.getState().pinAccount('c');
    api.savePreferences = (prefs) => { saved.push(prefs); return Promise.reject(new Error('offline')); };
    try {
      useStore.getState().pinAccount('a');
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      api.savePreferences = realSave;
    }
    assert.deepEqual(useStore.getState().pinnedAccounts, ['c']);
    const [note] = useStore.getState().notifications;
    assert.equal(note?.type, 'error');
    assert.equal(note?.title, 'Setting not saved');
  });

  it('unpinning sends the one removal, never the whole list', () => {
    useStore.getState().setPinnedAccounts(['a', 'b']);
    useStore.getState().unpinAccount('a');
    assert.deepEqual(saved, [{ unpinAccount: 'a' }]);
  });

  it('reordering the pins sends the whole new order, queued like other preferences', () => {
    useStore.getState().setPinnedAccounts(['a', 'b', 'c']);
    useStore.getState().reorderPinnedAccounts(['b', 'a', 'c']);
    assert.deepEqual(useStore.getState().pinnedAccounts, ['b', 'a', 'c']);
    assert.deepEqual(saved, []);
    flush();
    assert.deepEqual(saved, [{ pinnedAccounts: ['b', 'a', 'c'] }]);
  });

  it('setPinnedAccounts alone changes nothing on the server', () => {
    useStore.getState().setPinnedAccounts(['a']);
    flush();
    assert.deepEqual(saved, []);
  });

  it('pinning twice is a no-op, unpinning removes just that one', () => {
    useStore.getState().pinAccount('a');
    useStore.getState().pinAccount('a');
    useStore.getState().pinAccount('b');
    assert.deepEqual(useStore.getState().pinnedAccounts, ['a', 'b']);
    useStore.getState().unpinAccount('a');
    assert.deepEqual(useStore.getState().pinnedAccounts, ['b']);
  });

  it('drops the pins of deleted mailboxes when the list is rewritten', () => {
    useStore.setState({ pinnedAccounts: ['gone', 'a'] });
    useStore.getState().pinAccount('b');
    assert.deepEqual(useStore.getState().pinnedAccounts, ['a', 'b']);
    useStore.setState({ pinnedAccounts: ['a', 'gone2'] });
    useStore.getState().unpinAccount('b');
    assert.deepEqual(useStore.getState().pinnedAccounts, ['a']);
  });

  it('does not wipe the pins while the account list is not loaded yet', () => {
    useStore.setState({ pinnedAccounts: ['a', 'b'], accounts: [], accountsReady: false });
    useStore.getState().pinAccount('c');
    assert.deepEqual(useStore.getState().pinnedAccounts, ['a', 'b', 'c']);
  });

  it('the sort switch is stored, mirrored in localStorage and queued as a preference', () => {
    useStore.getState().setSortAccountsByLatest(false);
    assert.equal(useStore.getState().sortAccountsByLatest, false);
    assert.equal(localStorage.getItem('mailexpert_sort_accounts_by_latest'), 'false');
    flush();
    assert.deepEqual(saved, [{ sortAccountsByLatest: false }]);
  });

  it('loadPreferences brings both from the server', async () => {
    useStore.getState().setUser({ id: 'u1' });
    useStore.setState({ accounts: ACCOUNTS, accountsReady: true });
    api.getPreferences = async () => ({ pinnedAccounts: ['c', 'a', 7], sortAccountsByLatest: false, theme: 'daylight' });
    await useStore.getState().loadPreferences();
    assert.deepEqual(useStore.getState().pinnedAccounts, ['c', 'a']);
    assert.equal(useStore.getState().sortAccountsByLatest, false);
    assert.equal(localStorage.getItem('mailexpert_sort_accounts_by_latest'), 'false');
  });

  it('loadPreferences treats a missing key as no pins and the default order, not as what a previous user left', async () => {
    useStore.getState().setUser({ id: 'u1' });
    useStore.setState({ pinnedAccounts: ['a'], sortAccountsByLatest: false, accounts: ACCOUNTS, accountsReady: true });
    localStorage.setItem('mailexpert_pinned_accounts', JSON.stringify(['a']));
    api.getPreferences = async () => ({ theme: 'daylight' });
    await useStore.getState().loadPreferences();
    assert.deepEqual(useStore.getState().pinnedAccounts, []);
    assert.equal(useStore.getState().sortAccountsByLatest, true);
    assert.equal(localStorage.getItem('mailexpert_pinned_accounts'), '[]');
  });

  describe('another person signing in on the same tab', () => {
    it('does not inherit the previous user\'s pins, order switch or expanded mailboxes', () => {
      useStore.getState().setUser({ id: 'u1' });
      useStore.setState({ pinnedAccounts: ['a', 'b'], sortAccountsByLatest: false, expandedAccounts: { a: true } });
      localStorage.setItem('mailexpert_pinned_accounts', '["a","b"]');
      localStorage.setItem('mailexpert_sort_accounts_by_latest', 'false');
      localStorage.setItem('mailexpert_expanded_accounts', '{"a":true}');

      useStore.getState().setUser({ id: 'u2' });

      assert.deepEqual(useStore.getState().pinnedAccounts, []);
      assert.equal(useStore.getState().sortAccountsByLatest, true);
      assert.deepEqual(useStore.getState().expandedAccounts, {});
      for (const key of ['mailexpert_pinned_accounts', 'mailexpert_sort_accounts_by_latest', 'mailexpert_expanded_accounts']) {
        assert.equal(localStorage.getItem(key), null, key);
      }
    });

    it('also not after signing out', () => {
      useStore.getState().setUser({ id: 'u1' });
      useStore.setState({ pinnedAccounts: ['a'] });
      useStore.getState().setUser(null);
      assert.deepEqual(useStore.getState().pinnedAccounts, []);
    });

    it('but the first sign-in of a page load keeps what this browser cached for that user', () => {
      useStore.getState().setUser(null);
      useStore.setState({ pinnedAccounts: ['a'] });
      useStore.getState().setUser({ id: 'u1' });
      assert.deepEqual(useStore.getState().pinnedAccounts, ['a']);
    });
  });

  describe('noteAccountReceived', () => {
    it('moves the latest-received date forward', () => {
      useStore.getState().noteAccountReceived('a', '2026-09-12T00:00:00.000Z');
      assert.equal(useStore.getState().accounts.find(a => a.id === 'a').last_received_at, '2026-09-12T00:00:00.000Z');
      useStore.getState().noteAccountReceived('b', '2026-09-11T00:00:00.000Z');
      assert.equal(useStore.getState().accounts.find(a => a.id === 'b').last_received_at, '2026-09-11T00:00:00.000Z');
    });

    it('never moves it back, and leaves the list as it was when nothing changes', () => {
      const before = useStore.getState().accounts;
      useStore.getState().noteAccountReceived('a', '2026-09-01T00:00:00.000Z');
      useStore.getState().noteAccountReceived('a', '2026-09-10T00:00:00.000Z');
      useStore.getState().noteAccountReceived('gone', '2026-09-12T00:00:00.000Z');
      useStore.getState().noteAccountReceived('a', 'garbage');
      assert.equal(useStore.getState().accounts, before, 'the same array: no re-render for a no-op');
    });

    it('saves nothing: it is data from the server, not a preference', () => {
      useStore.getState().noteAccountReceived('a', '2026-09-12T00:00:00.000Z');
      flush();
      assert.deepEqual(saved, []);
    });
  });
});
