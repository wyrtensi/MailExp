// The Undo button of the send toast: a transient failure keeps it, a final refusal closes the toast.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const t = (key) => key; export const useTranslation = () => ({ t, i18n: { language: "en" } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const env = code => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: env(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const source = readFileSync(new URL(url), 'utf8');
      if (source.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: env(source) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true },
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const NotificationToasts = (await import('./NotificationToasts.jsx')).default;

const originalApi = { ...api.scheduled };
let root;

beforeEach(async () => {
  useStore.setState({ notifications: [] });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(NotificationToasts)); });
  await React.act(async () => {
    useStore.getState().addNotification({ title: 'Sending', sendUndo: { jobId: 'job-1', dueAt: Date.now() + 60000 } });
  });
});

afterEach(async () => {
  await React.act(async () => { root.unmount(); });
  Object.assign(api.scheduled, originalApi);
  useStore.setState({ notifications: [] });
});

const undoButton = () => document.querySelector('[data-send-undo] button[aria-label="scheduled.undoSend"]');
const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });

test('a transient failure keeps the toast and re-enables Undo', async () => {
  api.scheduled.cancel = async () => { throw Object.assign(new Error('Bad gateway'), { status: 502 }); };
  await React.act(async () => { undoButton().click(); });
  await settle();
  assert.ok(document.querySelector('[data-send-undo]'), 'toast stays');
  assert.equal(undoButton().disabled, false);
});

test('a permanent refusal closes the toast', async () => {
  api.scheduled.cancel = async () => { throw Object.assign(new Error('Not cancellable'), { status: 409, code: 'not_cancellable' }); };
  await React.act(async () => { undoButton().click(); });
  await settle();
  assert.equal(document.querySelector('[data-send-undo]'), null);
});
