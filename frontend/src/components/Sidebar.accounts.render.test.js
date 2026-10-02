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

  const key = (el, k, init = {}) => React.act(async () => {
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
  const navRows = () => [...host.querySelectorAll('[data-nav-row]')];
  const accountRow = (id) => host.querySelector(`[data-nav-row="account:${id}"]`);
  const menuOpen = () => host.querySelector('[role="menu"]') != null;

  describe('the account menu from the keyboard', () => {
    test('the menu is a keyboard menu: items are menu items, the first takes focus, the arrows walk them', async () => {
      await openMenu('a');
      const items = [...host.querySelectorAll('[role="menuitem"]')];
      assert.ok(items.length > 3);
      assert.ok(items.every(el => el.getAttribute('tabindex') === '-1'), 'reachable by the arrows, not by Tab');
      assert.equal(dom.window.document.activeElement, items[0], 'focus moves into the menu');
      await key(items[0], 'ArrowDown');
      assert.equal(dom.window.document.activeElement, items[1]);
      await key(items[1], 'ArrowUp');
      await key(items[0], 'ArrowUp');
      assert.equal(dom.window.document.activeElement, items[items.length - 1], 'wraps round');
      await key(items[items.length - 1], 'Home');
      assert.equal(dom.window.document.activeElement, items[0]);
    });

    test('the header is a label outside the menu, separators are separators', async () => {
      await openMenu('a');
      const menu = host.querySelector('[role="menu"]');
      assert.ok(!menu.textContent.includes('Alpha'), 'the title is not an item of the menu');
      assert.ok(menu.getAttribute('aria-label').includes('Alpha'), 'it names the menu');
      assert.ok(menu.querySelectorAll('[role="separator"]').length >= 1);
      assert.ok([...menu.children].every(el => ['menuitem', 'separator'].includes(el.getAttribute('role'))), 'only items and separators inside');
    });

    test('opened with the mouse, only the item under the pointer is highlighted, not the one that took focus', async () => {
      await openMenu('a');
      const items = [...host.querySelectorAll('[role="menuitem"]')];
      assert.equal(dom.window.document.activeElement, items[0]);
      assert.equal(items[0].style.background, 'transparent', 'the focused first item is not lit by the focus alone');
      assert.ok(items.every(el => el.style.background === 'transparent'), 'nothing is lit until the pointer is over an item');
    });

    test('Escape closes it and focus returns to the row it was opened from', async () => {
      const row = accountRow('b');
      row.focus();
      await key(row, 'F10', { shiftKey: true });
      assert.ok(menuOpen(), 'Shift+F10 on a focused row opens its menu');
      assert.notEqual(dom.window.document.activeElement, row, 'focus is in the menu');
      await key(dom.window.document.activeElement, 'Escape');
      assert.ok(!menuOpen());
      assert.equal(dom.window.document.activeElement, row, 'focus is back on the row');
    });

    test('choosing an item with Enter runs it and focus returns to the row', async () => {
      const row = accountRow('c');
      row.focus();
      await key(row, 'ContextMenu');
      assert.ok(menuOpen(), 'the Menu key opens it too');
      const pin = menuItem('sidebar.accountMenu.pin');
      pin.focus();
      await key(pin, 'Enter');
      assert.deepEqual(useStore.getState().pinnedAccounts, ['c']);
      assert.ok(!menuOpen());
      assert.equal(dom.window.document.activeElement, accountRow('c'), 'the row is still the place focus is');
    });

    test('Tab closes the menu instead of walking out of it, and focus returns to the row', async () => {
      const row = accountRow('a');
      row.focus();
      await key(row, 'F10', { shiftKey: true });
      assert.ok(menuOpen());
      let prevented = false;
      await React.act(async () => {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        dom.window.document.activeElement.dispatchEvent(event);
        prevented = event.defaultPrevented;
      });
      assert.ok(prevented, 'the browser does not move focus on by itself');
      assert.ok(!menuOpen());
      assert.equal(dom.window.document.activeElement, row);
    });

    test('the keys the menu uses do not reach the app\'s global shortcut handler', async () => {
      const seen = [];
      const spy = (e) => seen.push(e.key);
      dom.window.document.addEventListener('keydown', spy);
      try {
        await openMenu('a');
        const first = host.querySelector('[role="menuitem"]');
        await key(first, 'ArrowDown');
        await key(dom.window.document.activeElement, 'Tab');
        assert.deepEqual(seen, [], 'neither the arrows nor Tab got through');
        await openMenu('a');
        await key(dom.window.document.activeElement, 'Escape');
        assert.deepEqual(seen, [], 'nor Escape, which closes the menu and nothing else');
      } finally {
        dom.window.document.removeEventListener('keydown', spy);
      }
    });
  });

  describe('the list as one tab stop', () => {
    test('exactly one row can be tabbed to, the others are reached by the arrows', () => {
      const rows = navRows();
      assert.ok(rows.length >= 4);
      assert.equal(rows.filter(r => r.getAttribute('tabindex') === '0').length, 1);
      assert.equal(rows[0].getAttribute('tabindex'), '0');
    });

    test('the arrow keys move between rows and the stop follows focus', async () => {
      const rows = navRows();
      rows[0].focus();
      await key(rows[0], 'ArrowDown');
      assert.equal(dom.window.document.activeElement, rows[1]);
      assert.equal(rows[1].getAttribute('tabindex'), '0');
      assert.equal(rows[0].getAttribute('tabindex'), '-1');
      await key(rows[1], 'End');
      assert.equal(dom.window.document.activeElement, rows[rows.length - 1]);
      await key(rows[rows.length - 1], 'Home');
      assert.equal(dom.window.document.activeElement, rows[0]);
    });

    test('Enter on a row activates it', async () => {
      const row = accountRow('c');
      row.focus();
      await key(row, 'Enter');
      assert.equal(useStore.getState().selectedAccountId, 'c');
    });

    test('Right and Left open and close an account', async () => {
      const row = accountRow('a');
      row.focus();
      assert.equal(row.getAttribute('aria-expanded'), 'false');
      await key(row, 'ArrowRight');
      assert.equal(useStore.getState().expandedAccounts.a, true);
      await key(accountRow('a'), 'ArrowLeft');
      assert.equal(useStore.getState().expandedAccounts.a, false);
    });

    test('keys typed in a field inside the list are left to the field', async () => {
      const filter = host.querySelector('input');
      assert.ok(filter);
      const event = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      await React.act(async () => { filter.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, false);
    });

    test('the collapsed sidebar has the same one tab stop and its rows open the menu from the keyboard', async () => {
      await React.act(async () => { useStore.setState({ sidebarCollapsed: true }); });
      const rows = navRows();
      assert.equal(rows.filter(r => r.getAttribute('tabindex') === '0').length, 1);
      rows[1].focus();
      await key(rows[1], 'F10', { shiftKey: true });
      assert.ok(menuOpen(), 'it has an account menu now, as the expanded row does');
    });

    test('a right-click on a collapsed row opens the account menu', async () => {
      await React.act(async () => { useStore.setState({ sidebarCollapsed: true }); });
      await React.act(async () => {
        accountRow('b').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      });
      assert.ok(menuOpen());
      assert.ok(menuItem('sidebar.accountMenu.pin'));
    });
  });

  describe('pinned mailboxes can be moved among the pinned ones', () => {
    test('Move up / down show for a pinned mailbox even with the order by latest mail on, and reorder the pins', async () => {
      await React.act(async () => { useStore.getState().setPinnedAccounts(['a', 'b', 'c']); });
      assert.deepEqual(rowOrder(), ['a', 'b', 'c', 'd']);
      await openMenu('b');
      assert.ok(menuItem('sidebar.accountMenu.moveUp'));
      await click(menuItem('sidebar.accountMenu.moveUp'));
      assert.deepEqual(useStore.getState().pinnedAccounts, ['b', 'a', 'c']);
      assert.deepEqual(rowOrder(), ['b', 'a', 'c', 'd']);
    });

    test('the first pin cannot move up and the last cannot move down', async () => {
      await React.act(async () => { useStore.getState().setPinnedAccounts(['a', 'b']); });
      await openMenu('a');
      assert.equal(menuItem('sidebar.accountMenu.moveUp').getAttribute('aria-disabled'), 'true');
      assert.equal(menuItem('sidebar.accountMenu.moveDown').getAttribute('aria-disabled'), null);
    });
  });

  describe('a drag that never reports its end', () => {
    const dragStart = () => React.act(async () => { document.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true })); });

    test('the list is released when the pointer moves with no button down (the source left the page)', async () => {
      await dragStart();
      await React.act(async () => { useStore.getState().noteAccountReceived('d', '2026-09-20T00:00:00.000Z'); });
      assert.deepEqual(rowOrder(), ['c', 'b', 'a', 'd'], 'held while the drag lasts');
      await React.act(async () => { dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { buttons: 0 })); });
      assert.deepEqual(rowOrder(), ['d', 'c', 'b', 'a'], 'released: a cancelled drag does not freeze the list for good');
    });

    test('a pointer move with the button still down does not release it', async () => {
      await dragStart();
      await React.act(async () => { useStore.getState().noteAccountReceived('d', '2026-09-20T00:00:00.000Z'); });
      await React.act(async () => { dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { buttons: 1 })); });
      assert.deepEqual(rowOrder(), ['c', 'b', 'a', 'd']);
      await React.act(async () => { dom.window.dispatchEvent(new dom.window.Event('dragend')); });
      assert.deepEqual(rowOrder(), ['d', 'c', 'b', 'a'], 'a dragend seen anywhere in the window ends it');
    });

    test('a drop anywhere in the window ends it', async () => {
      await dragStart();
      await React.act(async () => { useStore.getState().noteAccountReceived('d', '2026-09-20T00:00:00.000Z'); });
      await React.act(async () => { dom.window.dispatchEvent(new dom.window.Event('drop')); });
      assert.deepEqual(rowOrder(), ['d', 'c', 'b', 'a']);
    });
  });
});
