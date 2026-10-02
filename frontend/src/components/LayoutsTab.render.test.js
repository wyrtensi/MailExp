// Render test for the "Sort accounts by latest mail" switch in the layout settings (AdminPanel.jsx's
// LayoutsTab, exported for exactly this): it reflects the store and flips the preference.
//
// The harness mirrors ThemesTab.render.test.js: node --test cannot parse JSX, so the loader
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
const { api } = await import('../utils/api.js');
const { LayoutsTab } = await import('./AdminPanel.jsx');

describe('LayoutsTab "Sort accounts by latest mail"', () => {
  let host, root;
  before(() => {
    api.savePreferences = () => Promise.resolve();
    api.savePreferencesOnExit = () => Promise.resolve();
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });

  const checkbox = () => [...host.querySelectorAll('label')]
    .find(label => label.textContent.includes('admin.appearance.sortAccountsByLatest'))
    ?.querySelector('input[type="checkbox"]');

  test('is on by default, shows its hint, and unchecking turns the preference off', async () => {
    assert.equal(useStore.getState().sortAccountsByLatest, true, 'on by default');
    await React.act(async () => { root.render(React.createElement(LayoutsTab)); });
    const box = checkbox();
    assert.ok(box, 'the switch renders');
    assert.equal(box.checked, true);
    assert.ok(host.textContent.includes('admin.appearance.sortAccountsByLatestHint'));

    await React.act(async () => { box.click(); });
    assert.equal(useStore.getState().sortAccountsByLatest, false, 'the real setter ran');
    assert.equal(checkbox().checked, false);

    await React.act(async () => { checkbox().click(); });
    assert.equal(useStore.getState().sortAccountsByLatest, true);
  });
});
