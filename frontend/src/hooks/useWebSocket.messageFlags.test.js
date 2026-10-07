import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json')
    ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true }
    : nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

let socket;
class FakeSocket {
  static CLOSED = 3;
  constructor() { socket = this; this.readyState = 1; }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeSocket;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { useWebSocket } = await import('./useWebSocket.js');

function App() { useWebSocket(); return null; }

test('message_flags updates the thread aggregate and asks for category counts and a list reload', async () => {
  api.getUnreadCounts = async () => ({});
  const events = [];
  window.addEventListener('mailexpert:category-counts-stale', () => events.push('categories'));
  window.addEventListener('mailexpert:refresh', () => events.push('refresh'));
  useStore.setState({
    messages: [{ id: 'head', account_id: 'a', thread_id: 't', is_read: false, unread_count: 3, message_count: 4 }],
    threadMessages: {},
  });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => { root.render(React.createElement(App)); });
    await React.act(async () => {
      socket.onmessage({ data: JSON.stringify({ type: 'message_flags', changes: [
        { id: 'head', is_read: true },
        { id: 'child-not-cached', is_read: true },
      ] }) });
    });
    // The head row's aggregate moved by one, not to zero.
    assert.equal(useStore.getState().messages[0].unread_count, 2);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(events.sort(), ['categories', 'refresh']);
  } finally {
    await React.act(async () => root.unmount());
  }
});

async function runFlags(message, { selectedAccountId = null } = {}) {
  api.getUnreadCounts = async () => ({});
  const events = [];
  const onCat = () => events.push('categories');
  const onRefresh = () => events.push('refresh');
  window.addEventListener('mailexpert:category-counts-stale', onCat);
  window.addEventListener('mailexpert:refresh', onRefresh);
  useStore.setState({
    selectedAccountId,
    messages: [{ id: 'head', account_id: 'a', thread_id: 't', is_read: false, unread_count: 3, message_count: 4 }],
    threadMessages: {},
  });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => { root.render(React.createElement(App)); });
    await React.act(async () => { socket.onmessage({ data: JSON.stringify({ type: 'message_flags', ...message }) }); });
    await new Promise(resolve => setTimeout(resolve, 500));
  } finally {
    await React.act(async () => root.unmount());
    window.removeEventListener('mailexpert:category-counts-stale', onCat);
    window.removeEventListener('mailexpert:refresh', onRefresh);
  }
  return events;
}

test('a star-only change does not refresh category counts', async () => {
  assert.deepEqual(await runFlags({ changes: [{ id: 'head', is_starred: true }] }), []);
});

test('an unknown message from another mailbox does not reload the shown list', async () => {
  const events = await runFlags({ accountId: 'b', changes: [{ id: 'elsewhere', is_read: true }] }, { selectedAccountId: 'a' });
  assert.deepEqual(events, ['categories']);
});
