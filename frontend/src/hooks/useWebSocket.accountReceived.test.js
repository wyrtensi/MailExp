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

// The sidebar order follows the server's record of arrivals (email_accounts.last_received_at):
// the account_received event carries the new value, also for a letter that arrived already read
// (new_messages carries the unread ones only), and the client derives nothing from new_messages.
test('account_received moves the mailbox\'s latest-received date to the server\'s value, and nothing else does', async () => {
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
    const emit = (data) => React.act(async () => { socket.onmessage({ data: JSON.stringify(data) }); });
    const receivedAt = (id) => useStore.getState().accounts.find(a => a.id === id).last_received_at;

    // A letter that arrived already read: only account_received tells the client.
    await emit({ type: 'account_received', accountId: 'b', lastReceivedAt: '2026-09-18T09:30:00.000Z' });
    assert.equal(receivedAt('b'), '2026-09-18T09:30:00.000Z');

    // An older value (events can cross) does not take the date back.
    await emit({ type: 'account_received', accountId: 'b', lastReceivedAt: '2026-09-01T00:00:00.000Z' });
    assert.equal(receivedAt('b'), '2026-09-18T09:30:00.000Z');

    // new_messages, with letters and dates of its own, changes nothing: the server decides.
    await emit({ type: 'new_messages', count: 1, accountId: 'a', folder: 'INBOX', messages: [{ id: 'm1', date: '2026-09-25T00:00:00.000Z' }] });
    assert.equal(receivedAt('a'), '2026-09-10T00:00:00.000Z');

    // Events for a mailbox the client does not know, or without a value, are ignored.
    const before = useStore.getState().accounts;
    await emit({ type: 'account_received', accountId: 'gone', lastReceivedAt: '2026-09-25T00:00:00.000Z' });
    await emit({ type: 'account_received', accountId: 'a' });
    assert.equal(useStore.getState().accounts, before);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
