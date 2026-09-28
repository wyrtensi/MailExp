// #508: "как в системе" / "Match system" — a per-user preference that, by default, keeps the
// theme following the OS light/dark setting rather than a hand-picked theme. Exercises the
// store orchestration (setTheme, setThemeFollowsSystem, loadPreferences, the live OS-change
// listener) that themes.test.js's pure-function tests and ThemesTab.render.test.js's checkbox
// render test don't reach.
//
// Real jsdom rather than hand-rolled DOM stubs: setTheme/setThemeFollowsSystem call the real
// applyTheme(), which touches the document (style elements, a data attribute, the favicon link)
// well beyond what a few stubbed methods would cover.

import { afterEach, before, describe, it } from 'node:test';
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

// One MediaQueryList per query, with addEventListener/removeEventListener tracked so the "live
// OS change, cleaned up when turned off" contract is directly testable — not just its outcome.
const _mqlsByQuery = new Map();
function makeMql() {
  const listeners = new Set();
  return {
    matches: false,
    addEventListener(type, fn) { if (type === 'change') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn); },
    listenerCount() { return listeners.size; },
    fireChange(matches) { this.matches = matches; for (const fn of [...listeners]) fn({ matches }); },
  };
}
function fakeMatchMedia(query) {
  if (!_mqlsByQuery.has(query)) _mqlsByQuery.set(query, makeMql());
  return _mqlsByQuery.get(query);
}
dom.window.matchMedia = fakeMatchMedia;

Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  Image: dom.window.Image, CustomEvent: dom.window.CustomEvent,
});

const darkMql = () => fakeMatchMedia('(prefers-color-scheme: dark)');

const { useStore } = await import('./index.js');

describe('themeFollowsSystem store orchestration (#508)', () => {
  before(() => {
    useStore.getState().setUser({ id: 'u1' });
  });

  afterEach(() => {
    // Return to the default (on) state so tests don't leak into each other via the listener.
    if (!useStore.getState().themeFollowsSystem) useStore.getState().setThemeFollowsSystem(true);
  });

  it('is on by default for an unset preference — every existing browser, not just new ones', () => {
    // The module-level import above already ran with a clean localStorage.
    assert.equal(useStore.getState().themeFollowsSystem, true);
    assert.equal(darkMql().listenerCount(), 1, 'the default-on state already watches the OS setting');
  });

  it('picking a theme by hand turns following off and keeps that theme', () => {
    useStore.getState().setTheme('dusk');
    assert.equal(useStore.getState().themeFollowsSystem, false);
    assert.equal(useStore.getState().theme, 'dusk');
    assert.equal(darkMql().listenerCount(), 0, 'the OS listener is torn down once following is off');
    assert.equal(localStorage.getItem('mailexpert_theme_follows_system'), 'false');
  });

  it('turning the checkbox on applies the system-resolved theme at once, without touching the saved hand pick', () => {
    useStore.getState().setTheme('gruvbox'); // an explicit hand pick, following now off
    darkMql().matches = true; // OS is currently dark
    useStore.getState().setThemeFollowsSystem(true);

    assert.equal(document.documentElement.getAttribute('data-mailexpert-theme'), 'dusk', 'dusk applied (OS is dark)');
    assert.equal(useStore.getState().theme, 'gruvbox', 'the last hand pick is preserved while following');
    assert.equal(darkMql().listenerCount(), 1);
  });

  it('turning the checkbox off returns to the last hand-picked theme', () => {
    useStore.getState().setTheme('gruvbox');
    useStore.getState().setThemeFollowsSystem(true);
    useStore.getState().setThemeFollowsSystem(false);

    assert.equal(document.documentElement.getAttribute('data-mailexpert-theme'), 'gruvbox');
    assert.equal(useStore.getState().theme, 'gruvbox');
  });

  it('live-updates when the OS setting changes while following, and stops once turned off', () => {
    useStore.getState().setThemeFollowsSystem(true);

    darkMql().fireChange(true);
    assert.equal(document.documentElement.getAttribute('data-mailexpert-theme'), 'dusk');

    darkMql().fireChange(false);
    assert.equal(document.documentElement.getAttribute('data-mailexpert-theme'), 'daylight');

    useStore.getState().setThemeFollowsSystem(false);
    darkMql().fireChange(true); // no listener left — must not flip the now-manual theme
    assert.notEqual(document.documentElement.getAttribute('data-mailexpert-theme'), 'dusk');
  });

  it('loadPreferences applies the system theme when the server says following is on', async () => {
    const { api } = await import('../utils/api.js');
    const original = api.getPreferences;
    api.getPreferences = async () => ({ theme: 'gruvbox', themeFollowsSystem: true });
    darkMql().matches = true;
    try {
      await useStore.getState().loadPreferences();
      assert.equal(useStore.getState().themeFollowsSystem, true);
      assert.equal(document.documentElement.getAttribute('data-mailexpert-theme'), 'dusk');
    } finally {
      api.getPreferences = original;
    }
  });

  it('loadPreferences honours an explicit server "false" and applies the hand-picked theme', async () => {
    const { api } = await import('../utils/api.js');
    const original = api.getPreferences;
    api.getPreferences = async () => ({ theme: 'gruvbox', themeFollowsSystem: false });
    try {
      await useStore.getState().loadPreferences();
      assert.equal(useStore.getState().themeFollowsSystem, false);
      assert.equal(document.documentElement.getAttribute('data-mailexpert-theme'), 'gruvbox');
    } finally {
      api.getPreferences = original;
    }
  });
});
