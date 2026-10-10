// Render tests for the "update available" item of the sidebar's user menu (/api/update, a newer
// GitHub release than the running version): administrators only, and it opens Administration ->
// "Panel update" instead of the releases page.
//
// The harness mirrors Sidebar.accounts.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const interp = (k, o) => (o && typeof o === "object" ? k + " " + Object.values(o).join(" ") : k);',
        'export const useTranslation = () => ({ t: (k, o) => interp(k, o), i18n: { language: "en", changeLanguage: () => {} } });',
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
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ([]), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { default: Sidebar } = await import('./Sidebar.jsx');

const UPDATE = { current: '1.0.0', latest: '1.0.1', url: 'https://github.com/example/releases/tag/v1.0.1', updateAvailable: true, disabled: false };

describe('Sidebar update item', () => {
  let host, root, updateCalls, opened;
  before(() => {
    api.savePreferences = () => Promise.resolve();
    api.savePreferencesOnExit = () => Promise.resolve();
    api.getFolders = () => Promise.resolve([]);
    api.get = (path) => {
      if (path === '/update') { updateCalls += 1; return Promise.resolve(UPDATE); }
      return Promise.resolve([]);
    };
    dom.window.open = (...args) => { opened.push(args); return null; };
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });

  const render = async (user) => {
    await React.act(async () => root.render(null));
    updateCalls = 0;
    opened = [];
    useStore.setState({
      accounts: [], accountsReady: true, user, sidebarCollapsed: false, selectedAccountId: null,
      selectedFolder: 'INBOX', showAdmin: false, adminTab: 'accounts', expandedAccounts: {},
    });
    await React.act(async () => { root.render(React.createElement(Sidebar)); });
  };
  const openUserMenu = () => React.act(async () => {
    host.querySelector('[aria-label="sidebar.userMenu"]').click();
  });
  const updateItem = () => [...host.querySelectorAll('[role="menuitem"]')]
    .find(el => el.textContent.includes('sidebar.updateAvailable'));

  beforeEach(() => localStorage.clear());

  test('an administrator sees the newer version in the user menu', async () => {
    await render({ id: 'u1', isAdmin: true });
    await openUserMenu();
    const item = updateItem();
    assert.ok(item, 'the update item is offered');
    assert.ok(item.textContent.includes('sidebar.updateAvailable 1.0.1'), 'it names the newer version');
  });

  test('choosing it opens Administration -> Panel update, not the releases page', async () => {
    await render({ id: 'u1', isAdmin: true });
    await openUserMenu();
    await React.act(async () => { updateItem().click(); });
    const state = useStore.getState();
    assert.equal(state.showAdmin, true);
    assert.equal(state.adminTab, 'panel-update');
    assert.deepEqual(opened, [], 'no window is opened');
    assert.ok(!updateItem(), 'the menu has closed');
  });

  test('a user who is not an administrator sees no update item, and the panel does not ask', async () => {
    await render({ id: 'u2', isAdmin: false });
    await openUserMenu();
    assert.ok(host.querySelector('[role="menuitem"]'), 'the user menu is open');
    assert.ok(!updateItem(), 'no update item');
    assert.equal(updateCalls, 0, 'no /api/update request for a user');
  });
});
