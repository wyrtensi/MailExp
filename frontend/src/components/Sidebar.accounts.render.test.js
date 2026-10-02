// Render tests for the account list of the sidebar: the order (pinned first, then latest received
// mail), the pin indicator and its label, the Pin / Unpin and Account settings items of the account
// context menu, and the list holding still while a menu is open.
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

const account = (id, name, receivedAt) => ({
  id, name, email_address: `${id}@example.invalid`, color: '#7c3aed', protocol: 'imap', enabled: true,
  health: 'healthy', last_received_at: receivedAt, aliases: [],
});
// By latest mail: c (newest), b, a; d has none.
const ACCOUNTS = [
  account('a', 'Alpha', '2026-09-10T00:00:00.000Z'),
  account('b', 'Bravo', '2026-09-11T00:00:00.000Z'),
  account('c', 'Charlie', '2026-09-12T00:00:00.000Z'),
  account('d', 'Delta', null),
];

describe('Sidebar account list', () => {
  let host, root;
  before(() => {
    // Pins are saved through the preference queue; nothing here talks to a server.
    api.savePreferences = () => Promise.resolve();
    api.savePreferencesOnExit = () => Promise.resolve();
    api.getFolders = () => Promise.resolve([]);
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
    localStorage.clear();
    useStore.setState({
      accounts: ACCOUNTS, accountsReady: true, user: { id: 'u1', isAdmin: true },
      pinnedAccounts: [], sortAccountsByLatest: true, accountFilter: '',
      sidebarCollapsed: false, selectedAccountId: null, selectedFolder: 'INBOX',
      showAdmin: false, accountSettingsRequested: null, expandedAccounts: {},
    });
    await React.act(async () => { root.render(React.createElement(Sidebar)); });
  });

  // Rows are the elements that carry the account's address.
  const rowOrder = () => ACCOUNTS
    .map(a => ({ id: a.id, at: host.textContent.indexOf(`${a.id}@example.invalid`) }))
    .filter(row => row.at !== -1)
    .sort((x, y) => x.at - y.at)
    .map(row => row.id);
  // The row is the element that carries the address in its title (the expanded row's tooltip is
  // only set while collapsed, so walk up from the address text to the row and dispatch there:
  // the contextmenu event bubbles to the row's handler either way).
  const rowFor = (id) => {
    const email = `${id}@example.invalid`;
    return [...host.querySelectorAll('div')].find(el => el.children.length === 0 && el.textContent === email);
  };
  const openMenu = async (id) => {
    await React.act(async () => {
      rowFor(id).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    });
  };
  const menuItem = (label) => [...host.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes(label));
  const click = (el) => React.act(async () => { el.click(); });

  test('lists the mailbox that received mail last first, mailboxes without mail at the end', () => {
    assert.deepEqual(rowOrder(), ['c', 'b', 'a', 'd']);
  });

  test('pinned mailboxes go on top in pin order, with a labelled pin icon', async () => {
    await React.act(async () => { useStore.getState().setPinnedAccounts(['d', 'a']); });
    assert.deepEqual(rowOrder(), ['d', 'a', 'c', 'b']);
    const pins = [...host.querySelectorAll('[role="img"]')].filter(el => el.getAttribute('aria-label') === 'sidebar.pinned');
    assert.equal(pins.length, 2, 'one labelled pin per pinned mailbox');
  });

  test('with "sort by latest mail" off the others keep their own order, pins still on top', async () => {
    await React.act(async () => { useStore.setState({ sortAccountsByLatest: false, pinnedAccounts: ['c'] }); });
    assert.deepEqual(rowOrder(), ['c', 'a', 'b', 'd']);
  });

  test('the account menu offers Pin, and choosing it pins the mailbox', async () => {
    await openMenu('a');
    assert.ok(menuItem('sidebar.accountMenu.pin'), 'Pin is offered');
    assert.ok(!menuItem('sidebar.accountMenu.unpin'));
    await click(menuItem('sidebar.accountMenu.pin'));
    assert.deepEqual(useStore.getState().pinnedAccounts, ['a']);
    assert.deepEqual(rowOrder(), ['a', 'c', 'b', 'd'], 'it moves to the top once the menu has closed');
  });

  test('the account menu offers Unpin for a pinned mailbox', async () => {
    await React.act(async () => { useStore.getState().setPinnedAccounts(['b']); });
    await openMenu('b');
    assert.ok(menuItem('sidebar.accountMenu.unpin'));
    await click(menuItem('sidebar.accountMenu.unpin'));
    assert.deepEqual(useStore.getState().pinnedAccounts, []);
    assert.deepEqual(rowOrder(), ['c', 'b', 'a', 'd']);
  });

  test('"Account settings" opens the settings for that mailbox', async () => {
    await openMenu('c');
    await click(menuItem('sidebar.accountMenu.settings'));
    const state = useStore.getState();
    assert.equal(state.showAdmin, true);
    assert.equal(state.adminTab, 'accounts');
    assert.equal(state.accountSettingsRequested, 'c');
  });

  test('the list holds still while a menu is open, even when mail arrives', async () => {
    await openMenu('a');
    await React.act(async () => { useStore.getState().noteAccountReceived('a', '2026-09-20T00:00:00.000Z'); });
    assert.deepEqual(rowOrder(), ['c', 'b', 'a', 'd'], 'a must not jump under the open menu');
    await React.act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.deepEqual(rowOrder(), ['a', 'c', 'b', 'd'], 'it rises once the menu is closed');
  });

  test('the list holds still while something is being dragged', async () => {
    await React.act(async () => { document.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true })); });
    await React.act(async () => { useStore.getState().noteAccountReceived('d', '2026-09-20T00:00:00.000Z'); });
    assert.deepEqual(rowOrder(), ['c', 'b', 'a', 'd']);
    await React.act(async () => { document.dispatchEvent(new dom.window.Event('dragend', { bubbles: true })); });
    assert.deepEqual(rowOrder(), ['d', 'c', 'b', 'a']);
  });

  test('moving by hand is offered only with "sort by latest mail" off, and not for pinned mailboxes', async () => {
    await openMenu('b');
    assert.ok(!menuItem('sidebar.accountMenu.moveUp'), 'hidden while the list is ordered by latest mail');
    await React.act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

    await React.act(async () => { useStore.setState({ sortAccountsByLatest: false, pinnedAccounts: ['d'] }); });
    await openMenu('b');
    assert.ok(menuItem('sidebar.accountMenu.moveUp'), 'offered with the switch off');
    await React.act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

    await openMenu('d');
    assert.ok(!menuItem('sidebar.accountMenu.moveUp'), 'a pinned mailbox is ordered by its pin');
  });

  test('the collapsed sidebar uses the same order and says which mailboxes are pinned', async () => {
    await React.act(async () => { useStore.setState({ sidebarCollapsed: true, pinnedAccounts: ['d'] }); });
    const rows = [...host.querySelectorAll('[role="button"][aria-label*="@example.invalid"]')];
    assert.deepEqual(rows.map(el => el.getAttribute('aria-label').split('@')[0]), ['d', 'c', 'b', 'a']);
    assert.ok(rows[0].getAttribute('aria-label').includes('sidebar.pinned'), 'the pin is in the row\'s accessible name');
    assert.ok(!rows[1].getAttribute('aria-label').includes('sidebar.pinned'));
  });

  test('the menu is a keyboard menu: items are focusable menu items and the first takes focus', async () => {
    await openMenu('a');
    const items = [...host.querySelectorAll('[role="menuitem"]')];
    assert.ok(items.length > 3);
    assert.ok(items.every(el => el.hasAttribute('tabindex')));
    assert.equal(dom.window.document.activeElement, items[0], 'focus moves into the menu');
    await React.act(async () => { items[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    assert.equal(dom.window.document.activeElement, items[1], 'the arrow keys walk the items');
  });
});
