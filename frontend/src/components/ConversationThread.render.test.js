// Render test for the stacked conversation under an open letter: a stacked letter in Spam, or one
// EOP marked as phishing, malware or a spoofed sender, opens in safe view like the open letter
// (R-41, utils/safeView.js). The harness is MessagePane.render.test.js's: sucrase for .jsx, a
// stubbed react-i18next whose t() answers the key, and import.meta.env pointed at a stub.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
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
  DOMParser: dom.window.DOMParser,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const PHISH_HTML = '<p>Please <a href="https://evil.example/login">verify your account</a></p><img src="https://tracker.example/p.gif">';
const BODIES = {
  phish: { html: PHISH_HTML, text: '', attachments: [], eopCategory: 'HPHISH' },
  junk: { html: '<p>Cheap <a href="https://shop.example/">pills</a></p>', text: '', attachments: [], eopCategory: null },
  plain: { html: '<p>See you at ten</p>', text: 'See you at ten', attachments: [], eopCategory: null },
  attachonly: { html: null, text: null, attachments: [{ filename: 'invoice.zip', part: '2' }], eopCategory: 'MALW' },
  spoofed: { html: '<p>Wire the money</p>', text: '', attachments: [], eopCategory: 'SPOOF' },
};
globalThis.fetch = async (url) => {
  const id = /\/messages\/([^/]+)\/body/.exec(String(url))?.[1];
  return { ok: true, status: 200, json: async () => BODIES[id] || {}, text: async () => '' };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ConversationThread = (await import('./ConversationThread.jsx')).default;

const item = (id, folder = 'INBOX') => ({
  id, folder, subject: id, snippet: id, date: '2026-10-01T10:00:00Z', from_name: id, from_email: `${id}@example.com`,
  to_addresses: [], cc_addresses: [], has_attachments: false, direction: 'in',
});
const CONVERSATION = { threadKey: 't', total: 4, items: [
  item('open'), item('phish'), item('junk', 'Junk'), item('plain'), item('attachonly'), item('spoofed'),
] };

let root;
let host;
before(async () => {
  host = document.getElementById('root');
  root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(ConversationThread, {
      conversation: CONVERSATION, currentId: 'open', onOpen: () => {}, spamFolderPaths: new Set(['Junk']),
    }));
  });
});
after(async () => { await React.act(async () => root.unmount()); });

const card = (id) => [...host.querySelectorAll('article')].find(a => a.textContent.includes(`${id}@example.com`) || a.textContent.includes(id));
async function expand(id) {
  const header = card(id).querySelector('button[aria-expanded]');
  await React.act(async () => { header.click(); });
  await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return card(id);
}
// The stacked letters' bars are not landmarks: only the open letter's bar is a region.
const notice = (el) => el.querySelector('.safe-view-notice');
const showFull = (el) => [...el.querySelectorAll('button')].find(b => b.textContent === 'message.safeView.showFull');

describe('Stacked letters in safe view (R-41)', () => {
  test('a letter EOP marked as phishing opens as text with the link target written out', async () => {
    const el = await expand('phish');
    assert.ok(notice(el), 'the warning bar is shown');
    assert.equal(notice(el).getAttribute('role'), null, 'not a landmark');
    assert.match(notice(el).textContent, /message\.safeView\.title\.phishing/);
    assert.equal(el.querySelector('iframe'), null);
    const body = el.querySelector('[data-safe-view-body]');
    assert.equal(body.getAttribute('translate'), 'yes');
    assert.match(body.textContent, /verify your account message\.safeView\.linkTo evil\.example https:\/\/evil\.example\/login/);
    assert.equal(el.querySelector('a[href]'), null, 'no link');
    assert.equal(el.querySelector('img'), null, 'no image');
  });

  test('Show in full renders it normally and focuses it', async () => {
    await React.act(async () => { showFull(card('phish')).click(); });
    assert.equal(notice(card('phish')), null);
    const frame = card('phish').querySelector('iframe');
    assert.ok(frame, 'the HTML body is rendered');
    assert.equal(document.activeElement, frame.parentElement, 'focus moves to the letter');
  });

  test('a letter with attachments only still shows why it is held back', async () => {
    const el = await expand('attachonly');
    assert.match(notice(el).textContent, /message\.safeView\.title\.malware/);
    assert.ok(showFull(el));
    assert.equal(el.querySelector('[data-safe-view-body]'), null, 'no text to show');
  });

  test('a spoofed sender outside Spam is a warning over the letter shown as usual', async () => {
    const el = await expand('spoofed');
    assert.match(notice(el).textContent, /message\.safeView\.title\.spoof/);
    assert.equal(showFull(el), undefined);
    assert.ok(el.querySelector('iframe'));
  });

  test('a letter in the Spam folder opens in safe view', async () => {
    const el = await expand('junk');
    assert.match(notice(el).textContent, /message\.safeView\.title\.spam/);
    assert.equal(el.querySelector('iframe'), null);
  });

  test('a normal letter renders as before', async () => {
    const el = await expand('plain');
    assert.equal(notice(el), null);
    assert.ok(el.querySelector('iframe'));
  });
});
