// Run with: node --test src/themes.test.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A settable localStorage + window.matchMedia so resolveSystemTheme/readThemeFollowsSystem can
// be tested without a full jsdom — themes.js reads them as bare globals, same as store/index.js.
let _store = {};
globalThis.localStorage = {
  getItem: k => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: k => { delete _store[k]; },
};
let _prefersDark = false;
globalThis.window = { matchMedia: () => ({ matches: _prefersDark }) };

const { DEFAULT_THEME, THEMES, getInitialTheme, themeCss, resolveSystemTheme, readThemeFollowsSystem, writeThemeFollowsSystem } = await import('./themes.js');

const names = Object.keys(THEMES);

// The canonical CSS-variable contract every theme must satisfy is taken from the
// first theme rather than a hardcoded list — so the check tracks the real set and a
// var added to every theme can never drift out of sync with this test.
const [reference] = names;
const canonicalVars = Object.keys(THEMES[reference].vars);

// One theme (parchment) intentionally carries a var the others don't need
// (--selection-bg, a sepia selection tint that only the light parchment surface
// wants). The invariant we pin is "no theme silently OMITS a canonical var", so
// extras beyond the canonical set are tolerated only from this known list — a *new*
// stray var still trips the guard and has to be justified (added everywhere or listed).
const KNOWN_THEME_EXTRAS = new Set(['--selection-bg']);

describe('THEMES CSS-var contract', () => {
  it('every theme defines all canonical CSS vars (no silent omissions)', () => {
    for (const name of names) {
      const keys = new Set(Object.keys(THEMES[name].vars));
      const missing = canonicalVars.filter(v => !keys.has(v));
      assert.deepEqual(missing, [], `${name} is missing vars: ${missing.join(', ')}`);
    }
  });

  it('no theme introduces an unexpected CSS var beyond the canonical set', () => {
    const canonical = new Set(canonicalVars);
    for (const name of names) {
      const extras = Object.keys(THEMES[name].vars)
        .filter(v => !canonical.has(v) && !KNOWN_THEME_EXTRAS.has(v));
      assert.deepEqual(extras, [], `${name} has unexpected vars: ${extras.join(', ')}`);
    }
  });

  it('every theme preview is an array of the same arity', () => {
    const arity = THEMES[reference].preview.length;
    for (const name of names) {
      assert.ok(Array.isArray(THEMES[name].preview), `${name} preview must be an array`);
      assert.equal(THEMES[name].preview.length, arity, `${name} preview arity differs from ${reference}`);
    }
  });
});

describe('Daylight and Dusk', () => {
  it('lead the picker, and a new browser starts on Daylight', () => {
    assert.deepEqual(names.slice(0, 2), ['daylight', 'dusk']);
    assert.equal(DEFAULT_THEME, 'daylight');
    assert.equal(getInitialTheme(), 'daylight');
  });

  it('Dusk puts the letter cards on light paper, other themes leave them alone', () => {
    const css = themeCss(THEMES.dusk);
    assert.match(css, /^:root \{/);
    assert.match(css, /\.msg-card, \.reading-card \{[^}]*--bg-secondary: #ffffff;/);
    for (const key of Object.keys(THEMES.dusk.cardVars)) {
      assert.ok(canonicalVars.includes(key), `${key} is not a theme variable`);
    }
    assert.doesNotMatch(themeCss(THEMES.daylight), /msg-card/);
  });
});

describe('resolveSystemTheme ("как в системе", #508)', () => {
  it('resolves to dusk when the OS prefers dark', () => {
    _prefersDark = true;
    assert.equal(resolveSystemTheme(), 'dusk');
  });
  it('resolves to daylight when the OS does not prefer dark (light, or no preference)', () => {
    _prefersDark = false;
    assert.equal(resolveSystemTheme(), 'daylight');
  });
  it('falls back to DEFAULT_THEME rather than throwing when matchMedia is unavailable', () => {
    const original = globalThis.window;
    globalThis.window = {};
    try {
      assert.equal(resolveSystemTheme(), DEFAULT_THEME);
    } finally {
      globalThis.window = original;
    }
  });
});

describe('readThemeFollowsSystem / writeThemeFollowsSystem (#508)', () => {
  beforeEach(() => { _store = {}; });

  it('defaults on when nothing was ever saved — every existing browser gets the checkbox on', () => {
    assert.equal(readThemeFollowsSystem(), true);
  });
  it('a saved "false" turns it off', () => {
    writeThemeFollowsSystem(false);
    assert.equal(readThemeFollowsSystem(), false);
  });
  it('a saved "true" round-trips', () => {
    writeThemeFollowsSystem(true);
    assert.equal(readThemeFollowsSystem(), true);
  });
});
