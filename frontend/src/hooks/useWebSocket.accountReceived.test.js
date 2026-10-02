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

let socket;
class FakeSocket {
  static CLOSED = 3;
  constructor() { socket = this; this.readyState = 1; }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeSocket;
// The handler refetches counts after an inbox event; nothing here answers.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { useWebSocket } = await import('./useWebSocket.js');

function App() { useWebSocket(); return null; }

// A mailbox that just received mail rises in the sidebar (utils/accountOrder.js) without the
// account list being fetched again: the new_messages event carries the letters' dates.
test('an inbox new_messages event moves that mailbox\'s latest-received date forward', async () => {
  const root = createRoot(document.getElementById('root'));
  try {
    useStore.setState({
      accounts: [
        { id: 'a', name: 'A', email_address: 'a@x.test', last_received_at: '2026-09-10T00:00:00.000Z' },
        { id: 'b', name: 'B', email_address: 'b@x.test', last_received_at: null },
      ],
      accountsReady: true,
    });
    await React.act(async () => { root.render(React.createElement(App)); });
    const emit = (data) => React.act(async () => {
      socket.onmessage({ data: JSON.stringify({ type: 'new_messages', count: 1, ...data }) });
    });
    const receivedAt = (id) => useStore.getState().accounts.find(a => a.id === id).last_received_at;

    await emit({ accountId: 'b', folder: 'INBOX', messages: [{ id: 'm1', date: '2026-09-18T09:30:00.000Z' }] });
    assert.equal(receivedAt('b'), '2026-09-18T09:30:00.000Z');

    // An older letter (a late delivery) does not take the date back.
    await emit({ accountId: 'b', folder: 'INBOX', messages: [{ id: 'm2', date: '2026-09-01T00:00:00.000Z' }] });
    assert.equal(receivedAt('b'), '2026-09-18T09:30:00.000Z');

    // Mail in another folder is not "received" in the inbox.
    await emit({ accountId: 'a', folder: 'Archive', messages: [{ id: 'm3', date: '2026-09-19T00:00:00.000Z' }] });
    assert.equal(receivedAt('a'), '2026-09-10T00:00:00.000Z');

    // An event without a folder is the inbox, as everywhere else in the handler.
    await emit({ accountId: 'a', messages: [{ id: 'm4', date: '2026-09-19T00:00:00.000Z' }] });
    assert.equal(receivedAt('a'), '2026-09-19T00:00:00.000Z');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
