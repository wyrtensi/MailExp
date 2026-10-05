// Render test for ComposeModal's draft autosave (#413).
//
// The autosave rules are unit-tested in utils/draftAutosave.test.js, but whether a draft counts
// as dirty depends on the live TipTap editor, which rewrites the HTML it loads. That only shows
// up with the real component mounted, so this mounts it the same way the other render tests do.

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
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
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
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

// A draft as Gmail saves it. TipTap loads this as <p> paragraphs, so its getHTML() never
// matches the stored string even when nobody has touched it.
const GMAIL_DRAFT = '<div dir="ltr">Hi Bob,<div><br></div><div>The contract is attached.</div></div>';

const saved = [];

// Autosave also runs when the tab is hidden, without waiting for the idle timer, which makes
// it the deterministic way to ask the composer "would you save now?".
async function hideTab() {
  visibility = 'hidden';
  await React.act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
  await React.act(async () => {});
  visibility = 'visible';
}

// Opens a draft the way MessageList does for a click in the Drafts folder. Returns an unmount.
async function openDraft({ plaintextEmail, body }) {
  saved.length = 0;
  useStore.setState({ plaintextEmail });
  useStore.getState().openCompose({
    accountId: 'acct',
    draftUid: 7,
    draftFolder: 'Drafts',
    to: ['Bob <bob@example.invalid>'],
    cc: [],
    subject: 'Contract',
    body,
    bodyIsHtml: !plaintextEmail,
  });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  // immediatelyRender: false creates the editor in an effect after the first commit.
  await React.act(async () => {});
  return () => React.act(async () => root.unmount());
}

before(() => {
  api.saveDraft = async (payload) => { saved.push(payload); return { uid: 8, folder: 'Drafts' }; };
  useStore.setState({
    user: { id: 'u1' },
    accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
  });
});

describe('reopening a draft saved by another client', () => {
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT }); });
  after(() => close());

  test('mounts the draft into the editor', () => {
    const editor = document.querySelector('.ProseMirror')?.editor;
    assert.ok(editor, 'the rich-text editor mounted');
    assert.match(editor.getHTML(), /The contract is attached\./);
    assert.notEqual(editor.getHTML(), GMAIL_DRAFT, 'precondition: TipTap rewrote the stored HTML');
  });

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });

  test('still autosaves once the body is edited, replacing the same draft', async () => {
    saved.length = 0;
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Thanks.'); });
    await hideTab();
    assert.equal(saved.length, 1, 'a real edit is saved');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].existingFolder, 'Drafts');
    assert.match(saved[0].body, /Thanks\./);
  });
});

describe('reopening a draft in plain-text mode', () => {
  // The editor still mounts in plain-text mode, but the dirty check compares the textarea, so
  // its baseline has to stay the raw body.
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: true, body: 'Hi Bob,\n\nThe contract is attached.' }); });
  after(() => close());

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });
});

describe('editing while a draft save is pending', () => {
  for (const trigger of ['manual', 'autosave']) {
    test(`${trigger} save keeps later editor changes dirty`, async () => {
      const saveDraft = api.saveDraft;
      let finishSave;
      api.saveDraft = async (payload) => {
        saved.push(payload);
        if (saved.length === 1) return new Promise(resolve => { finishSave = resolve; });
        return { uid: 9, folder: 'Drafts' };
      };
      const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>' });
      try {
        const editor = document.querySelector('.ProseMirror').editor;
        await React.act(async () => { editor.commands.insertContent(' First edit.'); });
        if (trigger === 'manual') {
          const saveButton = [...document.querySelectorAll('button')]
            .find(button => button.textContent.trim() === 'compose.saveDraft');
          assert.ok(saveButton);
          await React.act(async () => { saveButton.click(); });
        } else {
          await hideTab();
        }
        assert.equal(saved.length, 1);
        const submittedBody = saved[0].body;
        await React.act(async () => { editor.commands.insertContent(' Later edit.'); });
        const editedBody = editor.getHTML();
        assert.notEqual(editedBody, submittedBody);
        await React.act(async () => { finishSave({ uid: 8, folder: 'Drafts' }); });

        const unload = new window.Event('beforeunload', { cancelable: true });
        window.dispatchEvent(unload);
        assert.equal(unload.defaultPrevented, true, 'the later edit still needs refresh protection');
        await hideTab();
        assert.equal(saved.length, 2, 'the later edit is autosaved');
        assert.equal(saved[1].body, editedBody);
        assert.equal(saved[1].existingUid, 8, 'the second save replaces the first saved copy');
      } finally {
        api.saveDraft = saveDraft;
        await close();
      }
    });
  }

  test('saving an empty rich-text body leaves an unchanged editor clean', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>' });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await React.act(async () => { editor.commands.clearContent(); });
      await hideTab();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].body, '');
      await hideTab();
      assert.equal(saved.length, 1, 'the empty editor is not saved repeatedly');
    } finally {
      await close();
    }
  });
});

// Minimizing used to be local React state inside ComposeModal, invisible to the store — so
// clicking Compose again while minimized just reset composeData to a blank message; the mounted
// instance never noticed. `composeMinimized` now lives in the store (see store/compose.test.js
// for the pure openCompose behavior); this checks the toolbar button and the mounted DOM agree
// with it in both directions.
describe('minimizing and restoring the composer', () => {
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: false, body: 'Hi Bob,\n\nThe contract is attached.' }); });
  after(() => close());

  const minimizeBtn = () => document.querySelector('button[title="compose.toolbar.minimize"]');

  test('the minimize button collapses the composer and updates the store', async () => {
    assert.ok(minimizeBtn(), 'expected the full toolbar, with its minimize button, to be mounted');
    await React.act(async () => { minimizeBtn().click(); });
    assert.equal(useStore.getState().composeMinimized, true);
    assert.equal(minimizeBtn(), null, 'the full toolbar unmounts while minimized');
  });

  test('reopening (the Compose button/shortcut) restores it and keeps the in-progress draft', async () => {
    // Same call MailApp/Sidebar/CommandPalette/the keyboard shortcut all make for "new message" —
    // it must restore the minimized composer rather than discard it for a blank one.
    await React.act(async () => { useStore.getState().openCompose({ accountId: 'acct' }); });
    assert.equal(useStore.getState().composeMinimized, false, 'restored (un-minimized)');
    assert.equal(useStore.getState().composeData.subject, 'Contract', 'the original draft was kept, not replaced');
    assert.ok(minimizeBtn(), 'the full toolbar is mounted again');
  });
});

// The rich quote is a contentEditable filled from composeData once. Minimizing (and crossing the
// mobile/desktop layout) unmounts it; when it comes back it must still hold the quote as the writer
// left it, or a send or autosave after the restore drops the quote as if it had been deleted.
describe('the rich quote across minimize and restore', () => {
  const QUOTE_HTML = '<div>On Mon, Bob wrote:</div><blockquote>The old letter.</blockquote>';

  async function openReply() {
    saved.length = 0;
    useStore.setState({ plaintextEmail: false, composeMinimized: false });
    useStore.getState().openCompose({
      accountId: 'acct', isReply: true, to: ['Bob <bob@example.invalid>'], cc: [], subject: 'Re: Contract',
      body: '', quotedBody: '\n\nOn Mon, Bob wrote:\n> The old letter.', quotedBodyHtml: QUOTE_HTML,
    });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(ComposeModal)); });
    await React.act(async () => {});
    return () => React.act(async () => root.unmount());
  }
  const quoteEl = () => [...document.querySelectorAll('[contenteditable="true"]')]
    .find(el => !el.classList.contains('ProseMirror') && el.querySelector('blockquote'));
  const setMinimized = (value) => React.act(async () => { useStore.getState().setComposeMinimized(value); });
  const typeBody = (text) => React.act(async () => { document.querySelector('.ProseMirror').editor.commands.insertContent(text); });

  test('a kept quote is still in the draft saved after a restore', async () => {
    const close = await openReply();
    try {
      assert.ok(quoteEl(), 'the rich quote is mounted');
      await setMinimized(true);
      assert.equal(quoteEl(), undefined, 'precondition: minimizing unmounts the quote');
      await setMinimized(false);
      assert.match(quoteEl()?.innerHTML ?? '', /The old letter\./, 'the restored quote shows the quote again');
      await typeBody('Thanks.');
      await hideTab();
      assert.equal(saved.length, 1);
      assert.match(saved[0].quotedBodyHtml, /The old letter\./);
      assert.match(saved[0].quotedBody, /The old letter\./);
    } finally {
      await close();
    }
  });

  test('a quote the writer edited stays edited while minimized and after the restore', async () => {
    const close = await openReply();
    try {
      await React.act(async () => { quoteEl().innerHTML = '<blockquote>Only this part.</blockquote>'; });
      await typeBody('Thanks.');
      await setMinimized(true);
      await hideTab();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].quotedBodyHtml, '<blockquote>Only this part.</blockquote>');
      await setMinimized(false);
      assert.equal(quoteEl()?.innerHTML, '<blockquote>Only this part.</blockquote>');
    } finally {
      await close();
    }
  });
});
