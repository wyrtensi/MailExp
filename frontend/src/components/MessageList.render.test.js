// Render test for MessageList's drag source (#130).
//
// Drag-to-folder was reported broken in Edge, with message rows selecting text instead of
// dragging. Selecting text is what a browser does when an element is NOT draggable, so the
// first question is whether we render the attribute at all. Every other test of this feature
// is a util test and none of them mount a row, so none could answer that.
//
// The harness mirrors MessagePane.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed because the component only
// needs t() to return something.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// useMobile() reads window.innerWidth first, then subscribes to matchMedia. jsdom defaults
// innerWidth to 1024, which is the desktop case the bug report is about.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// jsdom implements no layout, so Element.scrollIntoView is missing; the list calls it whenever
// the selection changes.
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
globalThis.matchMedia = dom.window.matchMedia;
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
// MessageList loads its own messages on mount and overwrites anything seeded in the store,
// so the fetch stub has to serve the row rather than the store. Only the messages endpoint
// needs a real shape; everything else can be an empty object.
// THREAD_MESSAGES and ARCHIVED serve the two calls a thread-row archive makes after the guard
// is armed: without them the archive fails and the code under test clears the guard again.
let SERVED = [];
let THREAD_MESSAGES = [];
let ARCHIVED = [];
globalThis.fetch = async (url) => {
  const path = String(url);
  let body = {};
  if (path.includes('/mail/messages?')) body = { messages: SERVED, total: SERVED.length };
  else if (path.includes('/mail/thread/')) body = { messages: THREAD_MESSAGES };
  else if (path.includes('/mail/messages/bulk-archive')) body = { archived: ARCHIVED, noArchiveFolder: [] };
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;
const { shortcutBus } = await import('../utils/shortcutBus.js');
const { applyDeleteGuard, clearDeleteGuard, threadDeleteGuardKey } = await import('../utils/pendingDeletes.js');
const { api } = await import('../utils/api.js');

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', color: '#6366f1', include_in_unified_inbox: true };
const ACCOUNT_B = { id: 'acct-2', email_address: 'b@example.com', name: 'B', color: '#22c55e', include_in_unified_inbox: true };
const MESSAGE = {
  id: 'msg-1', account_id: 'acct-1', folder: 'INBOX', uid: 1,
  subject: 'Draggable subject', snippet: 'preview text', message_id: '<m1@example.com>',
  from_name: 'Sender', from_address: 's@example.com', date: new Date().toISOString(),
  is_read: false, is_starred: false, is_deleted: false, has_attachments: false,
};

// A conversation row: threading renders these through ThreadRow instead of MessageRow.
const THREAD = { ...MESSAGE, id: 'msg-2', thread_id: 'thr-1', message_count: 3, unread_count: 2 };

let container, root;

// Mount fresh for each scenario. MessageList refetches on mount and overwrites anything seeded
// in the store, so the fixture is served through fetch rather than set as state.
async function mount({ rows, threadedView, accounts = [ACCOUNT], state = {} }) {
  SERVED = rows;
  if (root) await React.act(async () => root.unmount());
  container = dom.window.document.getElementById('root');
  useStore.setState({
    accounts, accountsReady: true,
    selectedAccountId: 'acct-1', selectedFolder: 'INBOX',
    messages: rows, messagesTotal: rows.length, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', threadedView,
    folders: Object.fromEntries(accounts.map(a => [a.id, [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }]])),
    ...state,
  });
  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(MessageList));
  });
}

const draggableIn = (msgid) => {
  const row = container.querySelector(`[data-msgid="${msgid}"]`);
  assert.ok(row, `expected a row for ${msgid}`);
  return row.querySelector('[draggable]');
};

describe('MessageList — drag source (#130)', () => {
  test('an ordinary message row is draggable', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const el = draggableIn('msg-1');
    assert.ok(el, 'expected a draggable element inside the message row');
    assert.equal(el.getAttribute('draggable'), 'true');
  });

  test('a conversation row is draggable too', async () => {
    // The actual #130 bug. Threading renders rows through ThreadRow, which had no draggable
    // attribute and no onDragStart, so with conversations on nothing could be dragged and the
    // browser fell back to selecting the row's text. Asserting only on the non-threaded row
    // is what let this pass while the feature was broken for anyone using threading.
    await mount({ rows: [THREAD], threadedView: true });
    const el = draggableIn('msg-2');
    assert.ok(el, 'expected a conversation row to be draggable');
    assert.equal(el.getAttribute('draggable'), 'true');
  });
});

// One conversation delivered to two mailboxes is now one thread row per mailbox, so the
// optimistic delete guard the list arms on archive has to name the mailbox. In the unified
// inbox there is no selected account, and a guard keyed only by thread id and folder hid the
// other mailbox's row too — for the guard's whole lifetime, across every refetch.
describe('MessageList — the delete guard names the row mailbox', () => {
  const shared = { thread_id: 'thr-9', message_count: 2, unread_count: 0, is_read: true, folder: 'INBOX' };
  const inA = { ...MESSAGE, ...shared, id: 'a1', account_id: 'acct-1' };
  const inB = { ...MESSAGE, ...shared, id: 'b1', account_id: 'acct-2' };

  // setPendingDelete / setCompletedDelete arm real timers; leaving them would hold the runner.
  after(() => ['a1', 'b1', 'thread:thr-9:folder:INBOX', threadDeleteGuardKey('thr-9', 'INBOX', 'acct-1')]
    .forEach(clearDeleteGuard));

  test('archiving the conversation in one mailbox keeps the other mailbox row', async () => {
    THREAD_MESSAGES = [inA];
    ARCHIVED = ['a1'];
    await mount({
      rows: [inA, inB],
      threadedView: true,
      accounts: [ACCOUNT, ACCOUNT_B],
      state: { selectedAccountId: null, selectedMessageId: 'a1', searchResults: [], threadMessages: {} },
    });

    await React.act(async () => { shortcutBus.emit('archive'); });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

    assert.ok(
      applyDeleteGuard([inA]).length === 0,
      'the archived mailbox row must stay hidden until the refetch catches up',
    );
    assert.deepEqual(
      applyDeleteGuard([inA, inB]).map(message => message.id),
      ['b1'],
      'the same conversation in the other mailbox was never archived and must still show',
    );
  });
});

// #220: a Ctrl/Cmd- or Shift-click on a row OUTSIDE selection mode must enter it directly,
// the way desktop file managers do, instead of needing the avatar or toolbar button first.
describe('MessageList — modifier-click enters multi-select (#220)', () => {
  const M2 = { ...MESSAGE, id: 'msg-b', uid: 2, message_id: '<m2@example.com>', subject: 'Second' };
  const M3 = { ...MESSAGE, id: 'msg-c', uid: 3, message_id: '<m3@example.com>', subject: 'Third' };
  // Checked and unchecked checkboxes draw the same polyline; stroke-width 3 vs 2.5 is what
  // distinguishes a CHECKED row's checkmark (see MessageRow/ThreadRow's avatar-as-checkbox).
  const CHECK = 'svg[stroke-width="3"] polyline[points="20 6 9 17 4 12"]';

  const clickRow = async (msgid, init = {}) => {
    // The click handler sits on the inner draggable element, and DOM events bubble upward,
    // so the dispatch has to start there, not on the [data-msgid] wrapper.
    const row = container.querySelector(`[data-msgid="${msgid}"]`);
    assert.ok(row, `expected a row for ${msgid}`);
    const target = row.querySelector('[draggable]') || row;
    await React.act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    });
  };
  const checkedRows = () => [...container.querySelectorAll('[data-msgid]')]
    .filter(r => r.querySelector(CHECK)).map(r => r.getAttribute('data-msgid'));

  test('ctrl-click seeds {open message, clicked row} and does not open the clicked mail', async () => {
    await mount({ rows: [MESSAGE, M2, M3], threadedView: false });
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });

    await clickRow('msg-c', { ctrlKey: true });

    assert.equal(useStore.getState().selectedMessageId, 'msg-1'); // clicked mail did NOT open
    assert.deepEqual(checkedRows().sort(), ['msg-1', 'msg-c']);   // anchor + clicked selected
  });

  test('shift-click seeds the whole range from the open message', async () => {
    await mount({ rows: [MESSAGE, M2, M3], threadedView: false });
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });

    await clickRow('msg-c', { shiftKey: true });

    assert.deepEqual(checkedRows().sort(), ['msg-1', 'msg-b', 'msg-c']);
  });

  test('a plain click still just opens the message', async () => {
    await mount({ rows: [MESSAGE, M2], threadedView: false });
    await clickRow('msg-b');
    assert.equal(useStore.getState().selectedMessageId, 'msg-b');
    assert.deepEqual(checkedRows(), []); // no selection mode entered
  });

  // Conversations are the shipped default (threadedView: true), so ThreadRow needs the same
  // branch — otherwise ctrl-click opens the conversation on every default install while a
  // test that only exercises MessageRow (threadedView: false) stays green.
  test('ctrl-click on a conversation row enters multi-select too', async () => {
    const T2 = { ...THREAD, id: 'msg-3', thread_id: 'thr-2', message_id: '<m3t@example.com>' };
    await mount({ rows: [THREAD, T2], threadedView: true });
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-2'); });

    await clickRow('msg-3', { ctrlKey: true });

    assert.equal(useStore.getState().selectedMessageId, 'msg-2'); // clicked conversation did NOT open
    assert.deepEqual(checkedRows().sort(), ['msg-2', 'msg-3']);
  });
});

// #449: Ctrl+Z fires the newest still-pending undo — the same onUndo the visible toast button
// runs, so the keyboard can never undo more than the toasts offer.
describe('MessageList — Ctrl+Z undo shortcut (#449)', () => {
  test('undoAction fires the newest pending undo, then the next, then nothing', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const undone = [];
    await React.act(async () => {
      // A prior scenario's own undoable commit can still be pending (real timers, shared
      // store) — start from a clean slate so only this test's two notifications are seen.
      useStore.setState({ notifications: [] });
      useStore.getState().addNotification({ title: 'older', onUndo: () => undone.push('older') });
      useStore.getState().addNotification({ title: 'newer', onUndo: () => undone.push('newer') });
    });

    await React.act(async () => { shortcutBus.emit('undoAction'); });
    assert.deepEqual(undone, ['newer']);
    assert.deepEqual(useStore.getState().notifications.filter(n => n.onUndo).map(n => n.title), ['older']);

    await React.act(async () => { shortcutBus.emit('undoAction'); });
    await React.act(async () => { shortcutBus.emit('undoAction'); }); // nothing left — no throw, no change
    assert.deepEqual(undone, ['newer', 'older']);
  });
});

// #434: a star button in the multi-select bulk-action bar.
describe('MessageList — bulk star in the multi-select bar (#434)', () => {
  const M_STARRED = { ...MESSAGE, id: 'msg-star', uid: 9, message_id: '<star@example.com>', is_starred: true };
  const M_PLAIN   = { ...MESSAGE, id: 'msg-plain', uid: 10, message_id: '<plain@example.com>', is_starred: false };

  const clickRow = async (msgid, init = {}) => {
    const row = container.querySelector(`[data-msgid="${msgid}"]`);
    assert.ok(row, `expected a row for ${msgid}`);
    const target = row.querySelector('[draggable]') || row;
    await React.act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    });
  };

  test('any unstarred message in the selection stars them all, optimistically and via the API', async () => {
    await mount({ rows: [M_STARRED, M_PLAIN], threadedView: false });
    await React.act(async () => { useStore.getState().setSelectedMessage(M_STARRED.id); });
    await clickRow(M_PLAIN.id, { ctrlKey: true }); // enters multi-select with both rows

    const calls = [];
    const originalBulkStar = api.bulkStar;
    api.bulkStar = async (ids, starred) => { calls.push([ids, starred]); return { ok: true }; };
    try {
      const starBtn = [...container.querySelectorAll('button')].find(b => b.getAttribute('title') === 'messageList.starSelected');
      assert.ok(starBtn, 'expected the bulk star button (any unstarred selected -> "Star" label)');
      await React.act(async () => { starBtn.click(); });
      await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0][0].sort(), [M_PLAIN.id, M_STARRED.id].sort());
      assert.equal(calls[0][1], true); // any unstarred in selection -> star them all

      // Optimistic update landed in the store for both rows, including the already-starred one.
      const byId = Object.fromEntries(useStore.getState().messages.map(m => [m.id, m]));
      assert.equal(byId[M_STARRED.id].is_starred, true);
      assert.equal(byId[M_PLAIN.id].is_starred, true);

      // Selection clears after the bulk action (same as bulk mark-read/archive), so the
      // whole bulk-action bar — selectedIds.size > 0 || selectionModeActive — unmounts.
      assert.equal(
        [...container.querySelectorAll('button')].some(b => b.getAttribute('title') === 'messageList.starSelected'),
        false,
      );
    } finally {
      api.bulkStar = originalBulkStar;
    }
  });

  test('a failed request reverts the optimistic star change', async () => {
    await mount({ rows: [M_PLAIN], threadedView: false });
    await React.act(async () => { useStore.getState().setSelectedMessage(M_PLAIN.id); });
    await clickRow(M_PLAIN.id, { ctrlKey: true }); // ctrl-click on the only row still enters selection mode

    const originalBulkStar = api.bulkStar;
    const originalError = console.error;
    console.error = () => {};
    api.bulkStar = async () => { throw new Error('network down'); };
    try {
      const starBtn = [...container.querySelectorAll('button')].find(b => b.getAttribute('title') === 'messageList.starSelected');
      assert.ok(starBtn);
      await React.act(async () => { starBtn.click(); });
      await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

      const msg = useStore.getState().messages.find(m => m.id === M_PLAIN.id);
      assert.equal(msg.is_starred, false, 'reverted back to its original state after the failed request');
    } finally {
      api.bulkStar = originalBulkStar;
      console.error = originalError;
    }
  });
});
