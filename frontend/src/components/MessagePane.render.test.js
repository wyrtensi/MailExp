// Render test for MessagePane.
//
// Mounts the actual component: the Download all confirmation (#459) lives in its state and
// its event handlers, which a unit test of classifyAttachmentRisk cannot reach.
//
// node --test cannot parse JSX, so the loader hook below transforms .jsx with sucrase, which is
// already present via the build toolchain. react-i18next is stubbed because the component only
// needs t() to return something; wiring a real i18n instance would test i18next, not this.

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
      ].join("\n") };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    // import.meta.env is Vite's; Node has no equivalent, so point it at a stub object.
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
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// jsdom implements neither of these, and the component asks the window for both.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const MessagePane = (await import('./MessagePane.jsx')).default;

const MSG_A = { id: 'a1', account_id: 'acct', folder: 'INBOX', uid: 1, subject: 'First', from_email: 'x@y.z', from_name: 'X', date: new Date().toISOString(), is_read: true, to_addresses: [], cc_addresses: [] };
const MSG_B = { ...MSG_A, id: 'b2', uid: 2, subject: 'Second' };

let root;
before(() => {
  useStore.getState().setUser({ id: 'u1' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts([{ id: 'acct', enabled: true, email_address: 'x@y.z', color: '#fff' }]);
  useStore.getState().setMessages?.([MSG_A, MSG_B]);
  root = createRoot(document.getElementById('root'));
});
after(async () => { await React.act(async () => root.unmount()); });

describe('MessagePane renders', () => {
  test('mounts with a message selected without throwing', async () => {
    useStore.getState().setSelectedMessage('a1');
    await React.act(async () => { root.render(React.createElement(MessagePane)); });
    assert.ok(document.getElementById('root').innerHTML.length > 0, 'rendered something');
  });

  test('changing the selected message re-renders without throwing', async () => {
    await React.act(async () => { useStore.getState().setSelectedMessage('b2'); });
    assert.ok(document.getElementById('root').innerHTML.length > 0);
  });
});

describe('Download all asks first when an attachment is risky', () => {
  const MSG_BLOCK = { ...MSG_A, id: 'c3', uid: 3, subject: 'Invoice' };
  const MSG_SAFE = { ...MSG_A, id: 'd4', uid: 4, subject: 'Photos' };
  const MSG_WARN = { ...MSG_A, id: 'e5', uid: 5, subject: 'Login page' };
  const ATTACHMENTS = {
    c3: [
      { filename: 'invoice.pdf', type: 'application/pdf', part: '2', size: 10 },
      { filename: 'invoice.pdf.exe', type: 'application/octet-stream', part: '3', size: 10 },
    ],
    d4: [
      { filename: 'rink-1.jpg', type: 'image/jpeg', part: '2', size: 10 },
      { filename: 'rink-2.jpg', type: 'image/jpeg', part: '3', size: 10 },
    ],
    e5: [
      { filename: 'photo.jpg', type: 'image/jpeg', part: '2', size: 10 },
      { filename: 'account-login.html', type: 'text/html', part: '3', size: 10 },
    ],
  };
  const downloads = [];
  let originalFetch, originalClick;
  before(() => {
    // Rendering a body measures it on the next frame, which jsdom does not provide.
    globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
    dom.window.requestAnimationFrame ??= globalThis.requestAnimationFrame;
    dom.window.cancelAnimationFrame ??= globalThis.cancelAnimationFrame;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const id = /\/messages\/([^/]+)\/body/.exec(String(url))?.[1];
      const json = ATTACHMENTS[id] ? { html: '<p>hi</p>', text: 'hi', attachments: ATTACHMENTS[id] } : {};
      return { ok: true, status: 200, json: async () => json, text: async () => '' };
    };
    // jsdom cannot download. Record the downloads the component starts itself instead.
    originalClick = dom.window.HTMLAnchorElement.prototype.click;
    dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.getAttribute('href')); };
    useStore.getState().setMessages?.([MSG_A, MSG_B, MSG_BLOCK, MSG_SAFE, MSG_WARN]);
  });
  after(() => {
    globalThis.fetch = originalFetch;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  });

  async function open(id) {
    await React.act(async () => {
      useStore.getState().setSelectedMessage(id);
      root.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
  }

  const downloadAllLink = () => {
    const link = [...document.querySelectorAll('a')].find(a => a.textContent.includes('message.downloadAll'));
    assert.ok(link, 'the Download all link is rendered');
    return link;
  };

  async function fire(event) {
    const link = downloadAllLink();
    await React.act(async () => { link.dispatchEvent(event); });
    return downloadAllLink();
  }
  const click = () => fire(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  const armedNote = /message\.attachmentRisk\.confirm/;

  test('with a blocked file, the link has nothing to fetch until a second click downloads', async () => {
    await open('c3');
    // No href means a right-click "Save link as", a middle click or a long press cannot get the zip either.
    assert.equal(downloadAllLink().hasAttribute('href'), false);
    downloads.length = 0;

    const armed = await click();
    assert.match(armed.textContent, armedNote);
    assert.equal(armed.hasAttribute('href'), false, 'arming does not expose the zip');
    assert.deepEqual(downloads, [], 'the first click must not download');

    const done = await click();
    assert.deepEqual(downloads, ['/api/mail/messages/c3/attachments.zip'], 'the second click downloads once');
    assert.doesNotMatch(done.textContent, armedNote, 'and the link asks again next time');
  });

  test('a warn-level file alone is enough to ask, and Enter arms it like a click', async () => {
    await open('e5');
    const link = downloadAllLink();
    assert.equal(link.hasAttribute('href'), false);
    assert.equal(link.getAttribute('role'), 'button');
    downloads.length = 0;
    const armed = await fire(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.match(armed.textContent, armedNote);
    assert.deepEqual(downloads, []);
  });

  test('switching messages drops a half-confirmed Download all', async () => {
    await open('c3');
    assert.match((await click()).textContent, armedNote);
    await open('d4');
    await open('c3');
    assert.doesNotMatch(downloadAllLink().textContent, armedNote);
  });

  test('with only safe attachments, it stays a plain download link', async () => {
    await open('d4');
    const link = downloadAllLink();
    assert.equal(link.getAttribute('href'), '/api/mail/messages/d4/attachments.zip');
    assert.equal(link.hasAttribute('download'), true);
    let cancelled;
    const record = e => { cancelled = e.defaultPrevented; e.preventDefault(); };
    document.addEventListener('click', record);
    const after = await click();
    document.removeEventListener('click', record);
    assert.equal(cancelled, false, 'the first click downloads');
    assert.doesNotMatch(after.textContent, armedNote);
  });
});

describe('Download as .eml from the More menu (#381)', () => {
  // The "More" overflow menu (Print, view headers, download .eml, …) only exists on the
  // mobile layout — desktop lays these out as individual toolbar buttons instead, and #381
  // upstream only wired the download into this same mobile-only menu. useMobile() reads
  // window.innerWidth in a useState initializer, so it must be set before this component's
  // FIRST mount — a fresh root, not a re-render of the desktop-mounted one above.
  //
  // The download itself goes through api.downloadRawEml (fetch + blob), not a bare anchor
  // href, so a server error (413/mailbox_busy/…) is visible to the caller instead of
  // silently failing as a browser-level navigation would (review finding #2 follow-up).
  // Stubbing api.downloadRawEml directly, same technique the bulk-star tests use, keeps
  // this test about the UI wiring rather than re-testing api.js's own fetch/blob plumbing
  // (covered by api.demo.test.js).
  const downloads = [];
  let originalDownloadRawEml, originalInnerWidth, mobileHost, mobileRoot;
  before(async () => {
    originalDownloadRawEml = api.downloadRawEml;
    originalInnerWidth = dom.window.innerWidth;
    dom.window.innerWidth = 400; // useMobile(): window.innerWidth < 768
    mobileHost = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(mobileHost);
    mobileRoot = createRoot(mobileHost);
  });
  after(async () => {
    await React.act(async () => mobileRoot.unmount());
    mobileHost.remove();
    api.downloadRawEml = originalDownloadRawEml;
    dom.window.innerWidth = originalInnerWidth;
  });

  test('the More menu offers an .eml download that fetches the raw source', async () => {
    downloads.length = 0;
    api.downloadRawEml = async (messageId) => {
      downloads.push(messageId);
      return new Blob(['From: a@b.c\r\n\r\nBody'], { type: 'message/rfc822' });
    };
    await React.act(async () => {
      useStore.getState().setSelectedMessage('a1');
      mobileRoot.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    const moreBtn = [...mobileHost.querySelectorAll('button')].find(b => b.getAttribute('title') === 'message.more');
    assert.ok(moreBtn, 'expected the More button');
    await React.act(async () => { moreBtn.click(); });

    const downloadItem = [...mobileHost.querySelectorAll('div')].find(d => d.textContent === 'message.downloadEml');
    assert.ok(downloadItem, 'expected a "download as .eml" menu item');
    await React.act(async () => { downloadItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    assert.deepEqual(downloads, ['a1']);
  });

  test('an oversized message shows a localized error instead of failing silently', async () => {
    api.downloadRawEml = async () => { throw Object.assign(new Error('Download failed'), { code: 'message_too_large' }); };
    await React.act(async () => {
      useStore.setState({ notifications: [] });
      useStore.getState().setSelectedMessage('a1');
      mobileRoot.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    const moreBtn = [...mobileHost.querySelectorAll('button')].find(b => b.getAttribute('title') === 'message.more');
    await React.act(async () => { moreBtn.click(); });
    const downloadItem = [...mobileHost.querySelectorAll('div')].find(d => d.textContent === 'message.downloadEml');
    await React.act(async () => { downloadItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    const notified = useStore.getState().notifications.some(n => n.title === 'message.downloadEmlTooLarge');
    assert.ok(notified, 'expected a "too large" notification');
  });
});

describe('Download as .eml on the desktop toolbar (#381 follow-up)', () => {
  // Desktop has no overflow "More" menu at all — its actions are individual toolbar
  // buttons — so the mobile-only More-menu entry above left desktop with no way to
  // download a message's .eml. This is a direct PaneBtn, not a menu item.
  const downloads = [];
  let originalDownloadRawEml, originalInnerWidth, desktopHost, desktopRoot;
  before(async () => {
    originalDownloadRawEml = api.downloadRawEml;
    originalInnerWidth = dom.window.innerWidth;
    dom.window.innerWidth = 1280; // useMobile(): window.innerWidth < 768 — well above it
    desktopHost = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(desktopHost);
    desktopRoot = createRoot(desktopHost);
  });
  after(async () => {
    await React.act(async () => desktopRoot.unmount());
    desktopHost.remove();
    api.downloadRawEml = originalDownloadRawEml;
    dom.window.innerWidth = originalInnerWidth;
  });

  test('a toolbar button downloads the raw source directly, no menu involved', async () => {
    downloads.length = 0;
    api.downloadRawEml = async (messageId) => {
      downloads.push(messageId);
      return new Blob(['From: a@b.c\r\n\r\nBody'], { type: 'message/rfc822' });
    };
    await React.act(async () => {
      useStore.getState().setSelectedMessage('a1');
      desktopRoot.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // There must be no "More" button on desktop — that overflow menu is mobile-only.
    const moreBtn = [...desktopHost.querySelectorAll('button')].find(b => b.getAttribute('title') === 'message.more');
    assert.equal(moreBtn, undefined, 'desktop has no More button');

    const emlBtn = [...desktopHost.querySelectorAll('button')].find(b => b.getAttribute('title') === 'message.downloadEml');
    assert.ok(emlBtn, 'expected a desktop toolbar button for downloading .eml');
    await React.act(async () => { emlBtn.click(); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    assert.deepEqual(downloads, ['a1']);
  });
});

describe('Move picker favorites show their custom label (#505)', () => {
  let originalGetFolders, originalInnerWidth, host, testRoot;
  before(() => {
    originalGetFolders = api.getFolders;
    originalInnerWidth = dom.window.innerWidth;
    dom.window.innerWidth = 1280; // useMobile(): renders the desktop move-picker dropdown
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    testRoot = createRoot(host);
  });
  after(async () => {
    await React.act(async () => testRoot.unmount());
    host.remove();
    api.getFolders = originalGetFolders;
    dom.window.innerWidth = originalInnerWidth;
    useStore.setState({ favoriteFolders: [], recentFolders: [] });
  });

  test('the favorites section shows the label, not the real folder name — which stays as a tooltip', async () => {
    // A second, non-favorited folder stays in the plain "all folders" list below with its real
    // name — this is only about what the Favorites section itself shows.
    api.getFolders = async () => ([
      { path: 'Personal/Taxes', name: 'Taxes', special_use: null },
      { path: 'Work', name: 'Work', special_use: null },
    ]);
    useStore.setState({
      favoriteFolders: [{ accountId: 'acct', path: 'Personal/Taxes', label: 'Important' }],
      recentFolders: [],
    });

    await React.act(async () => {
      useStore.getState().setSelectedMessage('a1'); // MSG_A: account 'acct', folder 'INBOX'
      testRoot.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    const moveBtn = [...host.querySelectorAll('button')].find(b => b.getAttribute('title') === 'contextMenu.moveToFolder');
    assert.ok(moveBtn, 'expected the Move toolbar button');
    await React.act(async () => { moveBtn.click(); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // FolderPathLabel only sets a title on a row carrying a favoriteLabel, so this scopes
    // straight to the favorites-section instance of the folder (it is listed a second time,
    // unlabeled, further down in the plain "all folders" list — that's expected, not this bug).
    const favLabelSpan = host.querySelector('[title="Taxes"]');
    assert.ok(favLabelSpan, 'the favorite row keeps the real folder name as a tooltip');
    assert.ok(favLabelSpan.textContent.includes('Important'), 'the favorites section shows the custom label');
    assert.ok(!favLabelSpan.textContent.includes('Taxes'), 'the real folder name is not shown as visible text in the favorite row');
  });
});

describe('A plain-text body stays translatable under the translate="no" UI', () => {
  // index.html marks <html> translate="no" so browser translators cannot break React's DOM.
  // A plain-text letter renders in the main document, so without an opt-in the browser could no
  // longer translate a letter written in another language.
  const MSG_TEXT = { ...MSG_A, id: 't9', uid: 9, subject: 'Plain' };
  let originalFetch;
  before(() => {
    globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
    dom.window.requestAnimationFrame ??= globalThis.requestAnimationFrame;
    dom.window.cancelAnimationFrame ??= globalThis.cancelAnimationFrame;
    useStore.getState().setMessages?.([MSG_A, MSG_B, MSG_TEXT]);
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const json = /\/messages\/[^/]+\/body/.test(String(url))
        ? { html: '', text: 'Plain text letter', attachments: [] }
        : {};
      return { ok: true, status: 200, json: async () => json, text: async () => '' };
    };
  });
  after(() => { globalThis.fetch = originalFetch; });

  test('the plain-text body opts back into translation', async () => {
    await React.act(async () => {
      useStore.getState().setSelectedMessage('t9');
      root.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const card = [...document.querySelectorAll('.msg-card')].find(el => /Plain text letter/.test(el.textContent));
    assert.ok(card, 'the plain-text body is rendered');
    assert.equal(card.getAttribute('translate'), 'yes');
  });
});
