// Render tests for the accounts tab of the settings (AdminPanel.jsx's AccountsTab, exported for
// exactly this): the sidebar's "Account settings" item must land on that account's own settings
// view, not on the general accounts list.
//
// The harness mirrors ThemesTab.render.test.js: node --test cannot parse JSX, so the loader
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
const { AccountsTab } = await import('./AdminPanel.jsx');

const account = (id, name, email) => ({
  id, name, email_address: email, color: '#7c3aed', protocol: 'imap', enabled: true, health: 'healthy',
  imap_host: 'imap.example.invalid', imap_port: 993, smtp_host: 'smtp.example.invalid', smtp_port: 587,
  smtp_tls: 'STARTTLS', aliases: [],
});
const ACCOUNTS = [
  account('a1', 'Sales Team', 'sales@example.invalid'),
  account('a2', 'Operations', 'ops@example.invalid'),
  account('a3', 'Support', 'support@example.invalid'),
];

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('AccountsTab opened for one account (sidebar "Account settings")', () => {
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
  beforeEach(async () => {
    await React.act(async () => root.render(null));
    useStore.setState({
      accounts: ACCOUNTS, accountsReady: true, user: { id: 'u1', isAdmin: true },
      showAdmin: false, adminTab: 'appearance', accountSettingsRequested: null, addAccountRequested: false,
    });
  });

  const showsEditFor = (email) => host.textContent.includes('admin.accounts.editTitle') && host.textContent.includes(email);
  const showsList = () => host.textContent.includes('admin.accounts.addButton');

  test('without a request the tab shows the general accounts list', async () => {
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
    assert.ok(showsList());
    assert.ok(!host.textContent.includes('admin.accounts.editTitle'));
  });

  test('openAccountSettings opens the settings, on the accounts tab, with that account as the target', () => {
    useStore.getState().openAccountSettings('a2');
    const state = useStore.getState();
    assert.equal(state.showAdmin, true);
    assert.equal(state.adminTab, 'accounts');
    assert.equal(state.accountSettingsRequested, 'a2');
  });

  test('a request made before the tab mounted opens that account, not the list', async () => {
    useStore.getState().openAccountSettings('a2');
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();

    assert.ok(showsEditFor('ops@example.invalid'), 'the edit view of the requested account is shown');
    assert.ok(!showsList(), 'the general list is not');
    assert.ok(!host.textContent.includes('sales@example.invalid'), 'no other account is shown');
    assert.equal(useStore.getState().accountSettingsRequested, null, 'the request is consumed');
  });

  test('a request made while the tab is open switches it to that account', async () => {
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
    assert.ok(showsList());

    await React.act(async () => { useStore.getState().openAccountSettings('a3'); });
    await settle();
    assert.ok(showsEditFor('support@example.invalid'));
    assert.ok(!showsList());
  });

  test('a request for an account that is not in the list is dropped, the list stays', async () => {
    useStore.getState().openAccountSettings('gone');
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();

    assert.ok(showsList());
    assert.equal(useStore.getState().accountSettingsRequested, null, 'it does not linger to open a view later');
  });

  test('a request that arrives before the accounts are loaded waits for them', async () => {
    useStore.setState({ accounts: [], accountsReady: false });
    useStore.getState().openAccountSettings('a1');
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
    assert.equal(useStore.getState().accountSettingsRequested, 'a1', 'still pending');

    await React.act(async () => { useStore.getState().setAccounts(ACCOUNTS); });
    await settle();
    assert.ok(showsEditFor('sales@example.invalid'));
    assert.equal(useStore.getState().accountSettingsRequested, null);
  });
});
