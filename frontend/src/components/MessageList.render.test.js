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
let SEARCH_CALLS = [];
// A per-path override, [status, body], consulted before the generic routing below — used to
// script a single message's /body, /bcc and /headers responses (reopening a draft).
let ROUTES = {};
globalThis.fetch = async (url) => {
  const path = String(url);
  const routed = Object.entries(ROUTES).find(([p]) => path.endsWith(p));
  if (routed) {
    const [status, body] = routed[1];
    return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  }
  let body = {};
  if (path.includes('/search?')) { SEARCH_CALLS.push(path); body = { messages: [] }; }
  else if (path.includes('/mail/messages?')) body = { messages: SERVED, total: SERVED.length };
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
    // Undo the pending archive: its delayed commit would otherwise run during a later test,
    // against that test's fixtures, and restore 'a1' into the shared store.
    await React.act(async () => { shortcutBus.emit('undoAction'); });
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

describe('MessageList — bulk flags resolve collapsed threads', () => {
  const head = { ...THREAD, id: 'bulk-head', message_count: 2, unread_count: 2, category: 'primary' };
  const child = { ...MESSAGE, id: 'bulk-child', uid: 2, message_id: '<bulk-child@example.com>', thread_id: head.thread_id, category: 'primary' };
  const select = async (id) => {
    await React.act(async () => {
      const row = container.querySelector(`[data-msgid="${id}"]`);
      assert.ok(row);
      (row.querySelector('[draggable]') || row).dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
  };
  for (const flag of ['read', 'star']) {
    for (const scenario of ['thread', 'overlap', 'plain', 'resolve failure', 'write failure']) {
      test(`${flag}: ${scenario}`, async () => {
        const rows = scenario === 'overlap' ? [head, { ...child, thread_id: 'thr-2', message_count: 2, unread_count: 2 }] : [head];
        const threadedView = scenario !== 'plain';
        const cache = [head, child];
        await mount({ rows, threadedView, state: { selectedMessageId: null, expandedThreadId: null, unreadOnly: false, activeCategory: null, threadMessages: { 'acct-1:thr-1': cache }, categoryCounts: { primary: 5 }, pendingCounts: {} } });
        await React.act(async () => { useStore.setState({ categoryCounts: { primary: 5 }, pendingCounts: {}, serverUnreadCounts: { total: 5, byAccount: { 'acct-1': 5 }, snapshots: {} } }); });
        for (const row of rows) await select(row.id);
        const method = flag === 'read' ? 'bulkRead' : 'bulkStar';
        const original = api[method], originalThread = api.getThread, originalError = console.error;
        const calls = [], fetches = [];
        api.getThread = async (...args) => {
          fetches.push(args);
          if (scenario === 'resolve failure') throw new Error('Unavailable');
          return { messages: [head, child] };
        };
        api[method] = async (...args) => {
          calls.push(args);
          if (scenario === 'write failure') throw new Error('Unavailable');
          return {};
        };
        console.error = () => {};
        try {
          const title = flag === 'read' ? 'messageList.markReadSelected' : 'messageList.starSelected';
          const button = [...container.querySelectorAll('button')].find(b => b.title === title);
          assert.ok(button);
          await React.act(async () => { button.click(); });
          const state = useStore.getState();
          if (scenario === 'resolve failure') {
            assert.equal(calls.length, 0);
          } else {
            assert.deepEqual(calls, [[threadedView ? [head.id, child.id] : [head.id], true]]);
          }
          const failed = scenario.endsWith('failure');
          assert.equal(state.messages[0][flag === 'read' ? 'is_read' : 'is_starred'], !failed);
          if (flag === 'read') {
            assert.equal(state.messages[0].unread_count, failed ? 2 : 0);
            assert.equal(state.categoryCounts.primary, failed ? 5 : threadedView ? 3 : 4);
            assert.equal(state.pendingCounts['acct-1']?.delta || 0, failed ? 0 : threadedView ? -2 : -1);
          }
          if (threadedView && !failed) {
            assert.deepEqual(fetches, rows.map(row => [row.thread_id, 'INBOX', false, 'acct-1']));
            assert.ok(state.threadMessages['acct-1:thr-1'].every(m => m[flag === 'read' ? 'is_read' : 'is_starred']));
          } else if (failed) assert.deepEqual(state.threadMessages['acct-1:thr-1'], cache);
        } finally {
          api[method] = original;
          api.getThread = originalThread;
          console.error = originalError;
        }
      });
    }
  }
  after(async () => { if (root) { await React.act(async () => root.unmount()); root = null; } });
});

// A search issued while standing IN Trash or Junk must stay scoped to that folder even with
// "search all folders" on — the server excludes both from an ordinary all-folder search (so
// freshly-deleted mail and spam don't resurface by default), which would otherwise silently
// return nothing for a search the user issued while looking straight at that folder.
describe('MessageList — search stays scoped to Trash/Junk despite "search all folders"', () => {
  const FOLDERS_WITH_TRASH = [
    { path: 'INBOX', name: 'INBOX', special_use: null },
    { path: 'Trash', name: 'Trash', special_use: '\\Trash' },
    { path: 'Junk', name: 'Junk', special_use: '\\Junk' },
  ];

  const search = async (query) => {
    await React.act(async () => { useStore.setState({ searchQuery: query }); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 350)); }); // 300ms debounce
  };

  test('typing a search while in Trash sends folder=Trash despite searchAllFolders: true', async () => {
    SEARCH_CALLS = [];
    await mount({
      rows: [MESSAGE], threadedView: false,
      state: {
        selectedFolder: 'Trash', searchAllFolders: true,
        folders: { 'acct-1': FOLDERS_WITH_TRASH },
      },
    });
    await search('invoice');

    assert.equal(SEARCH_CALLS.length, 1);
    assert.match(SEARCH_CALLS[0], /[?&]folder=Trash(&|$)/);
  });

  test('typing a search while in Junk sends folder=Junk despite searchAllFolders: true', async () => {
    SEARCH_CALLS = [];
    await mount({
      rows: [MESSAGE], threadedView: false,
      state: {
        selectedFolder: 'Junk', searchAllFolders: true,
        folders: { 'acct-1': FOLDERS_WITH_TRASH },
      },
    });
    await search('invoice');

    assert.equal(SEARCH_CALLS.length, 1);
    assert.match(SEARCH_CALLS[0], /[?&]folder=Junk(&|$)/);
  });

  test('an ordinary folder still searches everywhere when searchAllFolders is on', async () => {
    SEARCH_CALLS = [];
    await mount({
      rows: [MESSAGE], threadedView: false,
      state: {
        selectedFolder: 'INBOX', searchAllFolders: true,
        folders: { 'acct-1': FOLDERS_WITH_TRASH },
      },
    });
    await search('invoice');

    assert.equal(SEARCH_CALLS.length, 1);
    assert.doesNotMatch(SEARCH_CALLS[0], /[?&]folder=/);
  });

  test('Trash still scopes the search when searchAllFolders is off (the pre-existing behavior)', async () => {
    SEARCH_CALLS = [];
    await mount({
      rows: [MESSAGE], threadedView: false,
      state: {
        selectedFolder: 'Trash', searchAllFolders: false,
        folders: { 'acct-1': FOLDERS_WITH_TRASH },
      },
    });
    await search('invoice');

    assert.equal(SEARCH_CALLS.length, 1);
    assert.match(SEARCH_CALLS[0], /[?&]folder=Trash(&|$)/);
  });
});

// upstream #499: a draft's Bcc lives only in its own copy on the server, and saving a reopened
// draft replaces that copy. Compose used to open with whatever /body happened to report (nothing,
// for a draft bcc_addresses never learned), so the next save silently erased the recipients.
describe('MessageList — reopening a saved draft keeps its Bcc (#499)', () => {
  const DRAFT = { ...MESSAGE, id: 'draft-1', folder: 'Drafts', uid: 7, is_read: true, subject: 'Draft subject' };
  const DRAFTS_FOLDERS = [{ path: 'INBOX', name: 'INBOX' }, { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' }];

  const clickRow = async (msgid) => {
    const row = container.querySelector(`[data-msgid="${msgid}"]`);
    assert.ok(row, `expected a row for ${msgid}`);
    const target = row.querySelector('[draggable]') || row;
    await React.act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    // handleSelect awaits its fetches before calling openCompose / setSelectedMessage.
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };

  // bccRoute: the [status, body] GET /mail/messages/draft-1/bcc answers with.
  const openDraft = async (bccRoute, headers = '', metadata = {}, bodyMetadata = {}, accounts = [ACCOUNT], aliasRoute = [200, []]) => {
    ROUTES = {
      '/accounts/acct-1/aliases': aliasRoute,
      '/mail/messages/draft-1/body': [200, { html: '<p>hello</p>', text: 'hello', ...bodyMetadata }],
      '/mail/messages/draft-1/headers': headers === null ? [502, { error: 'Headers unavailable' }] : [200, { headers }],
      '/mail/messages/draft-1/bcc': bccRoute,
    };
    const opened = [];
    await mount({
      rows: [{ ...DRAFT, ...metadata }], threadedView: false, accounts,
      state: {
        selectedFolder: 'Drafts', folders: { 'acct-1': DRAFTS_FOLDERS },
        openCompose: d => opened.push(d), notifications: [],
      },
    });
    await clickRow('draft-1');
    ROUTES = {};
    return opened;
  };

  const alias = { id: 'alias-1', account_id: 'acct-1', name: 'Alias', email: 'alias@example.com' };
  for (const source of ['header', 'cache', 'unloaded']) {
    test(`restores the draft alias from ${source}`, async () => {
      const account = { ...ACCOUNT, ...(source === 'unloaded' ? {} : { aliases: [alias] }) };
      const opened = await openDraft([200, { bcc: [] }], source === 'cache' ? null : 'From: Alias <ALIAS@example.com>\r\n',
        { from_email: source === 'cache' ? 'ALIAS@example.com' : ACCOUNT.email_address }, {}, [account], [200, [alias]]);
      assert.equal(opened[0].aliasId, alias.id);
      if (source === 'unloaded') assert.deepEqual(useStore.getState().accounts[0].aliases, [alias]);
    });
  }
  for (const from of ['"Alias <Sales>" <alias@example.com>', '"Alias <Sales>" <alias@example.com> (legacy <primary@example.com>)', '(legacy <primary@example.com>) "Alias \\"<Sales>\\"" <alias@example.com>']) {
    test(`restores alias from quoted display names and comments: ${from}`, async () => {
      const opened = await openDraft([200, { bcc: [] }], `From: ${from}\r\n`, { from_email: ACCOUNT.email_address }, {}, [{ ...ACCOUNT, aliases: [alias] }]);
      assert.equal(opened[0].aliasId, alias.id);
    });
  }
  for (const address of [ACCOUNT.email_address, 'removed@example.com']) {
    test(`keeps primary fallback for ${address}`, async () => {
      const opened = await openDraft([200, { bcc: [] }], `From: <${address}>\r\n`, {}, {}, [{ ...ACCOUNT, aliases: [alias] }]);
      assert.equal(opened[0].aliasId, undefined);
      assert.equal(opened[0].accountId, ACCOUNT.id);
    });
  }
  test('opens read-only when unloaded aliases cannot be fetched', async () => {
    const opened = await openDraft([200, { bcc: [] }], 'From: <alias@example.com>\r\n', {}, {}, [ACCOUNT], [502, { error: 'Unavailable' }]);
    assert.equal(opened.length, 0);
    assert.equal(useStore.getState().selectedMessageId, 'draft-1');
  });

  for (const source of ['headers', 'body after failed headers']) {
    test(`restores reply conversation metadata from ${source}`, async () => {
      const inReplyTo = '<parent@example.com>';
      const references = '<root@example.com> <parent@example.com>';
      const headers = source === 'headers' ? 'in-reply-to: <parent@example.com>\r\nReferences: <root@example.com>\r\n <parent@example.com>\r\n' : null;
      // Real list rows carry in_reply_to, but omit thread_references. The successful body
      // response supplies the cached references when the independent headers request fails.
      const opened = await openDraft([200, { bcc: [] }], headers, { in_reply_to: inReplyTo }, headers === null ? { inReplyTo, references } : {});
      assert.equal(opened[0].inReplyTo, inReplyTo);
      assert.equal(opened[0].references, references);
    });
  }

  test('opens the composer with the Bcc, as recipients rather than text to re-split', async () => {
    // { name, email } objects, not formatted strings: compose must quote a display name that
    // contains a comma instead of splitting it into two recipients (#224).
    const bcc = [{ name: 'Doe, Jane', email: 'jane@example.com' }];
    const opened = await openDraft([200, { bcc }]);
    assert.equal(opened.length, 1, 'expected the composer to open');
    assert.deepEqual(opened[0].bcc, bcc);
  });

  test('opens the composer with an empty Bcc when the draft is known to have none', async () => {
    const opened = await openDraft([200, { bcc: [] }]);
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].bcc, []);
    assert.equal(opened[0].inReplyTo, undefined);
    assert.equal(opened[0].references, undefined);
  });

  test('opens read-only with an error notification when the Bcc cannot be read, instead of an editable composer', async () => {
    const opened = await openDraft([502, { error: 'Could not read this draft\'s Bcc recipients from the mail server.' }]);
    assert.equal(opened.length, 0, 'no composer must open — its next save would erase the Bcc');
    assert.equal(useStore.getState().selectedMessageId, 'draft-1');
    const errors = useStore.getState().notifications.filter(n => n.type === 'error');
    assert.equal(errors.length, 1);
  });
});

// A draft used to open in the composer only when the currently SELECTED folder was the
// account's Drafts folder — a message-level property re-derived from view state instead of
// from the message. That missed every way a draft can reach the list some other way: a Gmail
// conversation's representative row can be a non-draft message of the thread (Gmail threads
// span folders), a unified view has no single selected folder, and the keyboard "open" shortcut
// bypassed the draft check entirely. isDraftMessage/pickThreadDraft (utils/isDraftMessage.js)
// now decide per message; these scenarios exercise the entry points that used to fall through
// to the reading pane.
describe('MessageList — a draft opens in the composer regardless of how it was reached', () => {
  const clickRow = async (msgid) => {
    const row = container.querySelector(`[data-msgid="${msgid}"]`);
    assert.ok(row, `expected a row for ${msgid}`);
    const target = row.querySelector('[draggable]') || row;
    await React.act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  const draftRoutes = (id) => ({
    [`/mail/messages/${id}/body`]: [200, { html: '<p>hi</p>', text: 'hi' }],
    [`/mail/messages/${id}/headers`]: [200, { headers: '' }],
    [`/mail/messages/${id}/bcc`]: [200, { bcc: [] }],
  });

  test('a thread row whose representative message is not the draft opens the thread\'s own draft instead', async () => {
    // The collapsed row's representative (what handleThreadClick receives) is a received
    // message; the actual draft is a different message of the same conversation, already
    // cached from a previous expansion.
    const received = { ...MESSAGE, id: 'thr-rep', thread_id: 'thr-5', message_count: 2, folder: 'INBOX' };
    const draftChild = {
      ...MESSAGE, id: 'draft-child-1', uid: 42, thread_id: 'thr-5', account_id: 'acct-1',
      folder: 'Drafts', date: new Date(Date.now() + 60000).toISOString(), subject: 'Reply draft',
    };
    ROUTES = draftRoutes('draft-child-1');
    const opened = [];
    await mount({
      rows: [received], threadedView: true,
      state: {
        selectedFolder: 'Drafts',
        folders: { 'acct-1': [{ path: 'INBOX' }, { path: 'Drafts', special_use: '\\Drafts' }] },
        threadMessages: { [`acct-1:thr-5`]: [received, draftChild] },
        openCompose: d => opened.push(d), notifications: [],
      },
    });

    await clickRow('thr-rep');
    ROUTES = {};

    assert.equal(opened.length, 1, 'expected the composer to open');
    assert.equal(opened[0].draftUid, 42, 'expected the thread\'s draft, not the clicked representative');
    assert.equal(opened[0].draftFolder, 'Drafts');
  });

  test('a draft opens the composer from the unified inbox, where no single folder is "selected"', async () => {
    const draft = { ...MESSAGE, id: 'draft-unified', account_id: 'acct-1', folder: 'Drafts' };
    ROUTES = draftRoutes('draft-unified');
    const opened = [];
    await mount({
      rows: [draft], threadedView: false,
      state: {
        selectedAccountId: null, selectedFolder: 'INBOX',
        folders: { 'acct-1': [{ path: 'INBOX' }, { path: 'Drafts', special_use: '\\Drafts' }] },
        openCompose: d => opened.push(d), notifications: [],
      },
    });

    await clickRow('draft-unified');
    ROUTES = {};

    assert.equal(opened.length, 1, 'a draft must open the composer even with no selected account/folder');
  });

  test('the "open" keyboard shortcut opens a draft in the composer instead of the reading pane', async () => {
    const draft = { ...MESSAGE, id: 'draft-kbd', account_id: 'acct-1', folder: 'Drafts' };
    ROUTES = draftRoutes('draft-kbd');
    const opened = [];
    await mount({
      rows: [draft], threadedView: false,
      state: {
        selectedFolder: 'Drafts', selectedMessageId: null,
        folders: { 'acct-1': [{ path: 'INBOX' }, { path: 'Drafts', special_use: '\\Drafts' }] },
        openCompose: d => opened.push(d), notifications: [],
      },
    });

    await React.act(async () => { shortcutBus.emit('openMessage'); });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    ROUTES = {};

    assert.equal(opened.length, 1, 'the keyboard open shortcut must route a draft through the composer too');
    assert.equal(useStore.getState().selectedMessageId, null, 'must not also fall through to selecting it for the reading pane');
  });
});

// The owner's exact report: a Gmail conversation row sits in the Drafts folder, its
// representative message is not itself a draft (a received/sent copy of the thread), and the
// thread was never expanded — so there is nothing cached to find the real draft in. Only then
// does resolveDraftForRow fetch the thread fresh through GET /thread/:id and look again there.
describe('MessageList — an uncached thread row fetches the thread to look for its draft', () => {
  const clickRow = async (msgid) => {
    const row = container.querySelector(`[data-msgid="${msgid}"]`);
    assert.ok(row, `expected a row for ${msgid}`);
    const target = row.querySelector('[draggable]') || row;
    await React.act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  const draftRoutes = (id) => ({
    [`/mail/messages/${id}/body`]: [200, { html: '<p>hi</p>', text: 'hi' }],
    [`/mail/messages/${id}/headers`]: [200, { headers: '' }],
    [`/mail/messages/${id}/bcc`]: [200, { bcc: [] }],
  });
  // The row currently being browsed IS the account's Drafts folder (matching the folder list's
  // special_use below) — the "plausibly holds a draft" gate that gets the fetch to fire at all.
  const draftsState = {
    selectedFolder: 'Drafts',
    folders: { 'acct-1': [{ path: 'INBOX' }, { path: 'Drafts', special_use: '\\Drafts' }] },
    threadMessages: {}, // nothing cached — the thread was never expanded
  };

  test('fetch-and-open: finds the draft in the freshly fetched thread and opens it', async () => {
    const received = { ...MESSAGE, id: 'unc-rep-1', thread_id: 'thr-unc-1', message_count: 2, folder: 'INBOX' };
    const draftChild = {
      ...MESSAGE, id: 'unc-draft-1', uid: 77, thread_id: 'thr-unc-1', account_id: 'acct-1',
      folder: 'Drafts', date: new Date(Date.now() + 60000).toISOString(), subject: 'Fetched draft',
    };
    THREAD_MESSAGES = [received, draftChild];
    ROUTES = draftRoutes('unc-draft-1');
    const opened = [];
    await mount({
      rows: [received], threadedView: true,
      state: { ...draftsState, openCompose: d => opened.push(d), notifications: [] },
    });

    await clickRow('unc-rep-1');
    ROUTES = {};

    assert.equal(opened.length, 1, 'expected the composer to open with the fetched draft');
    assert.equal(opened[0].draftUid, 77);
    assert.equal(opened[0].draftFolder, 'Drafts');
  });

  test('fetch finds nothing: falls back to the reading pane when the fetched thread has no draft', async () => {
    const received = { ...MESSAGE, id: 'unc-rep-2', thread_id: 'thr-unc-2', message_count: 2, folder: 'INBOX' };
    const otherCopy = { ...MESSAGE, id: 'unc-other-2', thread_id: 'thr-unc-2', account_id: 'acct-1', folder: 'Sent' };
    THREAD_MESSAGES = [received, otherCopy]; // neither message is a draft
    const opened = [];
    await mount({
      rows: [received], threadedView: true,
      state: { ...draftsState, openCompose: d => opened.push(d), notifications: [] },
    });

    await clickRow('unc-rep-2');

    assert.equal(opened.length, 0, 'no draft was found — the composer must not open');
    assert.equal(useStore.getState().selectedMessageId, 'unc-rep-2', 'falls back to opening it in the reading pane');
  });

  test('fetch fails: falls back to the reading pane instead of throwing', async () => {
    const received = { ...MESSAGE, id: 'unc-rep-3', thread_id: 'thr-unc-3', message_count: 2, folder: 'INBOX' };
    const opened = [];
    await mount({
      rows: [received], threadedView: true,
      state: { ...draftsState, openCompose: d => opened.push(d), notifications: [] },
    });

    const originalGetThread = api.getThread;
    const originalError = console.error;
    console.error = () => {};
    api.getThread = async () => { throw new Error('network down'); };
    try {
      await clickRow('unc-rep-3');

      assert.equal(opened.length, 0, 'a failed thread fetch must not open the composer');
      assert.equal(useStore.getState().selectedMessageId, 'unc-rep-3', 'falls back to the reading pane');
    } finally {
      api.getThread = originalGetThread;
      console.error = originalError;
    }
  });
});

describe('MessageList — a late "load more" response from a previous folder is dropped', () => {
  // The first page already ignores a response for a folder the user has left. The next-page
  // request did not: it appended the old folder's rows to the new one and overwrote its
  // offset and hasMore, so INBOX mail showed up (and could be acted on) inside Archive.
  test('switching folders while the next page is in flight keeps only the new folder', async () => {
    const row = (id, folder) => ({ ...MESSAGE, id, folder, uid: id, message_id: `<${id}@example.com>` });
    let release;
    const pendingPage = new Promise(resolve => { release = resolve; });
    const originalGetMessages = api.getMessages;
    api.getMessages = async (params) => {
      if (params.folder === 'Archive') return { messages: [row('archive-1', 'Archive')], total: 1 };
      if (params.offset > 0) return pendingPage;
      return { messages: [row('inbox-1', 'INBOX'), row('inbox-2', 'INBOX')], total: 4 };
    };
    try {
      await mount({ rows: [], threadedView: false, state: { pageSize: 2, scrollMode: 'infinite', messagesOffset: 0 } });
      const loadMore = [...container.querySelectorAll('button')].find(b => b.textContent === 'messageList.loadMore');
      assert.ok(loadMore, 'the first INBOX page must offer "load more"');
      await React.act(async () => loadMore.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));

      await React.act(async () => useStore.getState().setSelectedAccount('acct-1', 'Archive'));
      assert.deepEqual(useStore.getState().messages.map(m => m.id), ['archive-1']);

      await React.act(async () => release({ messages: [row('inbox-3', 'INBOX'), row('inbox-4', 'INBOX')], total: 4 }));

      const state = useStore.getState();
      assert.deepEqual(state.messages.map(m => m.id), ['archive-1'], 'the old INBOX page must not be appended to Archive');
      assert.equal(state.messagesOffset, 1, 'the old response must not overwrite the Archive offset');
      assert.equal(state.hasMoreMessages, false);
      assert.equal(state.loadingMessages, false);
    } finally {
      api.getMessages = originalGetMessages;
    }
  });

  test('a stale next page that fails does not end the new folder\'s first-page load early', async () => {
    // Clearing the flag here let the old INBOX rows, still on screen with hasMore=true, offer
    // "load more" while Archive was loading.
    const row = (id, folder) => ({ ...MESSAGE, id, folder, uid: id, message_id: `<${id}@example.com>` });
    let rejectPage, releaseArchive;
    const pendingPage = new Promise((_, reject) => { rejectPage = reject; });
    const pendingArchive = new Promise(resolve => { releaseArchive = resolve; });
    const originalGetMessages = api.getMessages;
    const originalError = console.error;
    console.error = () => {};
    api.getMessages = async (params) => {
      if (params.folder === 'Archive') return pendingArchive;
      if (params.offset > 0) return pendingPage;
      return { messages: [row('inbox-1', 'INBOX'), row('inbox-2', 'INBOX')], total: 4 };
    };
    try {
      await mount({ rows: [], threadedView: false, state: { pageSize: 2, scrollMode: 'infinite', messagesOffset: 0 } });
      const loadMore = [...container.querySelectorAll('button')].find(b => b.textContent === 'messageList.loadMore');
      await React.act(async () => loadMore.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
      await React.act(async () => useStore.getState().setSelectedAccount('acct-1', 'Archive'));

      await React.act(async () => rejectPage(new Error('network down')));
      assert.equal(useStore.getState().loadingMessages, true, 'Archive is still loading its first page');

      await React.act(async () => releaseArchive({ messages: [row('archive-1', 'Archive')], total: 1 }));
      const state = useStore.getState();
      assert.deepEqual(state.messages.map(m => m.id), ['archive-1']);
      assert.equal(state.loadingMessages, false);
    } finally {
      api.getMessages = originalGetMessages;
      console.error = originalError;
    }
  });

  test('archiving a row while the next page loads does not leave the list stuck loading', async () => {
    // Archive invalidates in-flight list responses. The next page may be dropped then, but with
    // no newer load to clear it the loading flag stayed set: a permanent spinner, no
    // "load more", and background refreshes ignored.
    const row = (id, folder) => ({ ...MESSAGE, id, folder, uid: id, message_id: `<${id}@example.com>` });
    let release;
    const pendingPage = new Promise(resolve => { release = resolve; });
    const originalGetMessages = api.getMessages;
    api.getMessages = async (params) => {
      if (params.offset > 0) return pendingPage;
      return { messages: [row('inbox-1', 'INBOX'), row('inbox-2', 'INBOX')], total: 4 };
    };
    ARCHIVED = ['inbox-1'];
    try {
      await mount({ rows: [], threadedView: false, state: { pageSize: 2, scrollMode: 'infinite', messagesOffset: 0, selectedMessageId: 'inbox-1', notifications: [] } });
      const loadMore = [...container.querySelectorAll('button')].find(b => b.textContent === 'messageList.loadMore');
      await React.act(async () => loadMore.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
      await React.act(async () => { shortcutBus.emit('archive'); });

      await React.act(async () => release({ messages: [row('inbox-3', 'INBOX'), row('inbox-4', 'INBOX')], total: 4 }));
      assert.equal(useStore.getState().loadingMessages, false);
    } finally {
      // Undo the pending archive so its delayed commit cannot outlive the test.
      await React.act(async () => { shortcutBus.emit('undoAction'); });
      api.getMessages = originalGetMessages;
      ARCHIVED = [];
      clearDeleteGuard('inbox-1');
    }
  });
});
