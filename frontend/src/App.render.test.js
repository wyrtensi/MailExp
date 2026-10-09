// Render tests for the no-access screen's way out (audit of PR #223): the refusal clears once the
// user loads, "Try again" re-checks the session, and a still-refused user stays on the screen.
//
// Same harness as components/LockScreen.render.test.js (sucrase for .jsx, react-i18next stubbed to
// return the raw key); the heavy screens are replaced by one-line stubs.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const STUBS = {
  '/components/MailApp.jsx': 'mail-app',
  '/components/LoginPage.jsx': 'login-form',
  '/components/GoogleLoginPage.jsx': 'google-login-form',
};

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
    const stub = Object.keys(STUBS).find((s) => url.endsWith(s));
    if (stub) {
      return {
        format: 'module', shortCircuit: true,
        source: `export default () => globalThis.__REACT__.createElement('div', { 'data-screen': '${STUBS[stub]}' });`,
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

const ORIGIN = 'https://mail.example.invalid';
const dom = new JSDOM('<div id="root"></div>', { url: `${ORIGIN}/`, pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.Image = dom.window.Image; // the theme code rasterises the favicon
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

// /auth/me answers come from this queue (the last one repeats); other calls get {}.
let meAnswers = [];
let meCalls = 0;
const requested = [];
const jsonResponse = (status, body) => ({
  ok: status < 400, status, headers: { get: () => 'application/json' },
  json: async () => body, text: async () => JSON.stringify(body),
});
globalThis.fetch = async (url) => {
  const path = String(url);
  requested.push(path);
  if (path.endsWith('/auth/me')) {
    meCalls += 1;
    const answer = meAnswers[Math.min(meCalls - 1, meAnswers.length - 1)];
    return jsonResponse(answer.status, answer.body);
  }
  if (path.endsWith('/auth/config')) return jsonResponse(200, { mode: 'google', googleSignIn: true });
  if (path.endsWith('/auth/logout')) return jsonResponse(200, { ok: true, endSessionUrl: `${ORIGIN}/#signed-out` });
  return jsonResponse(200, {});
};

const React = await import('react');
globalThis.__REACT__ = React;
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { useStore } = await import('./store/index.js');
const App = (await import('./App.jsx')).default;

const ALLOWED = { status: 200, body: { user: { id: 'u1', username: 'alice', locked: false } } };
const REFUSED = (code) => ({ status: 403, body: { error: 'No access', code } });
const UNAUTH = { status: 401, body: { error: 'Unauthorized' } };

const doc = dom.window.document;
const screen = () => doc.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null;
const hasDeniedScreen = () => [...doc.querySelectorAll('h2')].some((h) => h.textContent === 'login.google.noAccessTitle');
const button = (key) => [...doc.querySelectorAll('button')].find((b) => b.textContent === key);
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const click = (key) => React.act(async () => {
  const b = button(key);
  assert.ok(b, `expected the ${key} button`);
  b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
});

let root;
async function mountApp(answers) {
  if (root) await React.act(async () => root.unmount());
  meAnswers = answers;
  meCalls = 0;
  requested.length = 0;
  useStore.setState({ user: null, isLocked: false });
  dom.window.location.hash = '';
  await React.act(async () => {
    root = createRoot(doc.getElementById('root'));
    root.render(React.createElement(MemoryRouter, { initialEntries: ['/'] }, React.createElement(App)));
  });
  await settle();
}

describe('App - no-access screen recovery', () => {
  beforeEach(() => { localStorage.clear(); });

  test('a refused start shows the screen with both actions', async () => {
    await mountApp([REFUSED('not_allowed')]);
    assert.ok(hasDeniedScreen());
    assert.ok(button('login.google.retry'));
    assert.ok(button('login.google.switchAccount'));
  });

  test('"Try again" opens the app once access is restored', async () => {
    await mountApp([REFUSED('user_disabled'), ALLOWED]);
    assert.ok(hasDeniedScreen());
    await click('login.google.retry');
    assert.equal(hasDeniedScreen(), false);
    assert.equal(screen(), 'mail-app');
    assert.equal(useStore.getState().user?.id, 'u1');
  });

  test('"Try again" keeps the screen while the user is still refused', async () => {
    await mountApp([REFUSED('not_allowed'), REFUSED('user_deleted')]);
    await click('login.google.retry');
    assert.equal(meCalls, 2);
    assert.ok(hasDeniedScreen());
    assert.equal(useStore.getState().user, null);
    assert.ok(button('login.google.retry'), 'the actions stay available for another attempt');
  });

  test('"Try again" shows the sign-in form when there is no session any more', async () => {
    await mountApp([REFUSED('not_allowed'), UNAUTH]);
    await click('login.google.retry');
    assert.equal(hasDeniedScreen(), false);
    assert.equal(screen(), 'google-login-form');
  });

  test('a user loaded by any other path clears the refusal', async () => {
    await mountApp([REFUSED('not_allowed')]);
    assert.ok(hasDeniedScreen());
    await React.act(async () => { useStore.getState().setUser({ id: 'u2', username: 'bob' }); });
    assert.equal(hasDeniedScreen(), false);
    assert.equal(screen(), 'mail-app');
  });

  test('a refusal event during a session shows the screen, and a later user clears it', async () => {
    await mountApp([ALLOWED]);
    assert.equal(screen(), 'mail-app');
    await React.act(async () => {
      dom.window.dispatchEvent(new dom.window.CustomEvent('mailexpert:access_denied', { detail: { code: 'user_deleted' } }));
    });
    assert.ok(hasDeniedScreen());
    await React.act(async () => { useStore.getState().setUser({ id: 'u1', username: 'alice' }); });
    assert.equal(hasDeniedScreen(), false);
  });

  test('"Sign out and use another account" runs the regular sign-out and follows its URL', async () => {
    await mountApp([REFUSED('not_allowed')]);
    await click('login.google.switchAccount');
    assert.ok(requested.some((u) => u.endsWith('/auth/logout')));
    assert.equal(dom.window.location.hash, '#signed-out');
  });
});
