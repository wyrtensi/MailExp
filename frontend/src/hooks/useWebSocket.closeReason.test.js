import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.json')
      ? {
          format: 'module',
          source: `export default ${readFileSync(new URL(url), 'utf8')}`,
          shortCircuit: true,
        }
      : nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const sockets = [];
class FakeSocket {
  static CLOSED = 3;

  static CLOSING = 2;

  static OPEN = 1;

  constructor() {
    sockets.push(this);
    this.readyState = 1;
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}
globalThis.WebSocket = FakeSocket;

// The confirming API call of a signed-out close answers 401, as it does for an ended session.
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  return { ok: false, status: 401, json: async () => ({ error: 'Not authenticated' }) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useWebSocket } = await import('./useWebSocket.js');

function App() {
  useWebSocket(true);
  return null;
}

async function withMountedHook(run) {
  sockets.length = 0;
  fetchCalls.length = 0;
  const root = createRoot(document.getElementById('root'));
  const seen = [];
  const record = (event) => seen.push(event.type);
  window.addEventListener('mailexpert:locked', record);
  window.addEventListener('mailexpert:session_expired', record);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    assert.equal(sockets.length, 1);
    await run(sockets[0], seen);
  } finally {
    window.removeEventListener('mailexpert:locked', record);
    window.removeEventListener('mailexpert:session_expired', record);
    await React.act(async () => root.unmount());
  }
}

test('a socket closed as Locked shows the lock screen at once and does not reconnect', async () => {
  await withMountedHook(async (ws, seen) => {
    await React.act(async () => ws.onclose({ code: 1008, reason: 'Locked' }));
    assert.deepEqual(seen, ['mailexpert:locked']);
    assert.equal(fetchCalls.length, 0);
  });
});

test('a socket closed as Session ended confirms with the server and goes to sign-in', async () => {
  await withMountedHook(async (ws, seen) => {
    await React.act(async () => ws.onclose({ code: 1008, reason: 'Session ended' }));
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0], /\/mail\/unread-counts$/);
    assert.deepEqual(seen, ['mailexpert:session_expired']);
  });
});

test.after(() => dom.window.close());
