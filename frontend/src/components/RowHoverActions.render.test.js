// Render test for RowHoverActions' #440 configurable action set.
//
// The cluster used to hard-render markRead/star/delete/move; #440 makes membership
// configurable via `actions`, keeping canonical render order. Callers that pass nothing
// (the GTD sidebar rows) must keep the pre-#440 cluster byte-identical — that default is
// the actual regression risk here, so it gets its own pinned test.
//
// The harness mirrors DirectionBadge.render.test.js: node --test cannot parse JSX, so the
// loader hook transforms .jsx with sucrase, and react-i18next is stubbed to return the key.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return {
        format: 'module', shortCircuit: true, source: [
          'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
          'export const initReactI18next = { type: "3rdParty", init: () => {} };',
          'export const Trans = ({ children }) => children ?? null;',
          'export const I18nextProvider = ({ children }) => children ?? null;',
          'export default { useTranslation, initReactI18next };',
        ].join('\n'),
      };
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
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const RowHoverActions = (await import('./RowHoverActions.jsx')).default;

const MESSAGE = { id: 'm1', is_starred: false, is_read: false };

async function mount(props) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  await React.act(async () => {
    createRoot(host).render(React.createElement(RowHoverActions, props));
  });
  return host;
}

// Titles are the plain i18n keys under this harness's stub, so they double as a stable,
// readable fingerprint for which button rendered.
const titlesIn = (host) => [...host.querySelectorAll('button')].map(b => b.getAttribute('title'));

describe('RowHoverActions — default cluster (pre-#440 callers)', () => {
  test('a caller that passes no `actions` keeps the exact pre-#440 four buttons, in order', async () => {
    const host = await mount({
      message: MESSAGE, isRead: false,
      onMarkRead: () => {}, onStar: () => {}, onDelete: () => {}, onMove: () => {},
    });
    assert.deepEqual(titlesIn(host), [
      'contextMenu.markRead', 'contextMenu.star', 'common.delete', 'contextMenu.moveToFolder',
    ]);
  });

  test('a handler the caller omits hides its button even though it is in the default set', async () => {
    // onMove absent: 'move' has no button, matching the pre-#440 `{onMove && <ActionBtn/>}`.
    const host = await mount({
      message: MESSAGE, isRead: false,
      onMarkRead: () => {}, onStar: () => {}, onDelete: () => {},
    });
    assert.deepEqual(titlesIn(host), ['contextMenu.markRead', 'contextMenu.star', 'common.delete']);
  });
});

describe('RowHoverActions — configurable set (#440)', () => {
  test('a custom set renders only its members, in the order the set lists them', async () => {
    // RowHoverActions itself just maps `actions` to buttons in list order — it trusts the
    // caller to have already canonicalized it. That canonicalization is sanitizeHoverActionSet's
    // job (utils/hoverActions.test.js), which is what the store's setHoverActionSet runs on
    // every write, so a real caller's `actions` prop is always canonical order already.
    const host = await mount({
      message: MESSAGE, isRead: false,
      actions: ['archive', 'snooze', 'move'], // already canonical order
      onMarkRead: () => {}, onStar: () => {}, onDelete: () => {}, onMove: () => {},
      onArchive: () => {}, onSnooze: () => {},
    });
    // markRead/star/delete are NOT in the requested set, so only archive, snooze, move show.
    assert.deepEqual(titlesIn(host), [
      'shortcuts.actions.archive.label', 'contextMenu.snooze.label', 'contextMenu.moveToFolder',
    ]);
  });

  test('naming a key with no handler is inert — the button never appears', async () => {
    const host = await mount({
      message: MESSAGE, isRead: false,
      actions: ['snooze', 'delete'],
      onDelete: () => {}, // no onSnooze supplied
    });
    assert.deepEqual(titlesIn(host), ['common.delete']);
  });

  test('an empty set renders no action buttons at all', async () => {
    const host = await mount({
      message: MESSAGE, isRead: false, actions: [],
      onMarkRead: () => {}, onStar: () => {}, onDelete: () => {}, onMove: () => {},
    });
    assert.deepEqual(titlesIn(host), []);
  });
});
