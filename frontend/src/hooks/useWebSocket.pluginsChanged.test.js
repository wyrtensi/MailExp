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

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { useWebSocket } = await import('./useWebSocket.js');

function App() { useWebSocket(); return null; }

// An administrator switched a plugin for the whole panel: every signed-in browser gets
// plugins_changed and reads GET /api/plugins again, so the plugin's features appear without a reload.
test('plugins_changed reloads the panel-wide plugin switch', async () => {
  const root = createRoot(document.getElementById('root'));
  const originalList = api.plugins.list;
  let reads = 0;
  api.plugins.list = async () => { reads += 1; return [{ id: 'gtd', enabled: true }]; };
  try {
    useStore.setState({ user: { id: 'u1', isAdmin: false }, enabledPlugins: [] });
    await React.act(async () => { root.render(React.createElement(App)); });
    await React.act(async () => {
      socket.onmessage({ data: JSON.stringify({ type: 'plugins_changed', pluginId: 'gtd', enabled: true }) });
    });
    assert.equal(reads, 1);
    assert.deepEqual(useStore.getState().enabledPlugins, ['gtd']);

    api.plugins.list = async () => { reads += 1; return [{ id: 'gtd', enabled: false }]; };
    await React.act(async () => {
      socket.onmessage({ data: JSON.stringify({ type: 'plugins_changed', pluginId: 'gtd', enabled: false }) });
    });
    assert.equal(reads, 2);
    assert.deepEqual(useStore.getState().enabledPlugins, []);
  } finally {
    api.plugins.list = originalList;
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
