// Render test for #505: the "Move to" folder picker in the right-click context menu (used for
// both single messages and MessageList's bulk move) must show a favorited folder's custom label,
// not its real name — the sidebar already gets this right, the picker didn't.
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
const ContextMenu = (await import('./ContextMenu.jsx')).default;

const MESSAGE = {
  id: 'm1', account_id: 'acct', folder: 'INBOX', uid: 1,
  subject: 'Hi', from_email: 'x@y.z', from_name: 'X', date: new Date().toISOString(),
  is_read: true, to_addresses: [], cc_addresses: [],
};

describe('ContextMenu move-to picker favorites show their custom label (#505)', () => {
  let originalGetFolders, host, root;
  before(() => {
    useStore.getState().setUser({ id: 'u1' });
    useStore.getState().setLocked(false);
    useStore.getState().setAccounts([{ id: 'acct', enabled: true, email_address: 'x@y.z', color: '#fff' }]);
    originalGetFolders = api.getFolders;
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
    api.getFolders = originalGetFolders;
    useStore.setState({ favoriteFolders: [], recentFolders: [] });
  });

  test('the favorites section shows the label, not the real folder name — which stays as a tooltip', async () => {
    // A second, non-favorited folder stays in the plain "all folders" list below with its real
    // name — this is only about what the Favorites section itself shows.
    api.getFolders = async () => ([
      { path: 'Personal/Taxes', name: 'Taxes', special_use: null },
      { path: 'Work', name: 'Work', special_use: null },
    ]);
    useStore.setState({
      favoriteFolders: [{ accountId: 'acct', path: 'Personal/Taxes', label: 'Important' }],
      recentFolders: [],
    });

    await React.act(async () => {
      root.render(React.createElement(ContextMenu, {
        x: 10, y: 10, message: MESSAGE, onClose: () => {}, onAction: () => {}, defaultMoveView: true,
      }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // FolderPathLabel only sets a title on a row carrying a favoriteLabel, so this scopes
    // straight to the favorites-section instance of the folder (it is listed a second time,
    // unlabeled, further down in the plain "all folders" list — that's expected, not this bug).
    const favLabelSpan = host.querySelector('[title="Taxes"]');
    assert.ok(favLabelSpan, 'the favorite row keeps the real folder name as a tooltip');
    assert.ok(favLabelSpan.textContent.includes('Important'), 'the favorites section shows the custom label');
    assert.ok(!favLabelSpan.textContent.includes('Taxes'), 'the real folder name is not shown as visible text in the favorite row');
  });
});
