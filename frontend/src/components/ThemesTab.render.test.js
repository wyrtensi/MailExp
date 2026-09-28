// Render test for the "как в системе" / "Match system" checkbox (#508) in the appearance
// settings (AdminPanel.jsx's ThemesTab, exported for exactly this — see the comment there).
//
// The harness mirrors MessagePane.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  // setThemeFollowsSystem/setTheme really call applyTheme(), which rasterises a favicon via
  // Image — jsdom has one, it's just not in globalThis by default.
  Image: dom.window.Image,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { ThemesTab } = await import('./AdminPanel.jsx');

describe('ThemesTab "как в системе" checkbox (#508)', () => {
  let host, root;
  before(() => {
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });

  test('reflects store state and toggling it calls setThemeFollowsSystem', async () => {
    useStore.setState({ themeFollowsSystem: true });
    await React.act(async () => { root.render(React.createElement(ThemesTab)); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    const checkbox = host.querySelector('input[type="checkbox"]');
    assert.ok(checkbox, 'expected the match-system checkbox to render');
    assert.equal(checkbox.checked, true, 'reflects themeFollowsSystem: true from the store');
    assert.ok(host.textContent.includes('admin.appearance.matchSystem'), 'the label is shown');
    assert.ok(host.textContent.includes('admin.appearance.matchSystemHint'), 'the one-line hint is shown');

    await React.act(async () => { checkbox.click(); });
    // The real setThemeFollowsSystem ran (not a spy): the store, not just the DOM node, flips.
    assert.equal(useStore.getState().themeFollowsSystem, false, 'unchecking turns following off in the store');
  });

  test('unchecked when the store says the user is not following the system', async () => {
    useStore.setState({ themeFollowsSystem: false });
    await React.act(async () => { root.render(React.createElement(ThemesTab)); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    const checkbox = host.querySelector('input[type="checkbox"]');
    assert.equal(checkbox.checked, false);
  });
});
