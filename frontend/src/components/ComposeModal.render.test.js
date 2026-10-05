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
const { composeDataFromScheduled } = await import('../utils/scheduledSend.js');

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
async function openDraft({ plaintextEmail, body, ...metadata }) {
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
    ...metadata,
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

describe('restoring a scheduled letter preserves its original format', () => {
  for (const plaintextEmail of [true, false]) {
    for (const bodyIsHtml of [true, false]) {
      test(`restores and autosaves ${bodyIsHtml ? 'HTML' : 'plain text'} with plaintext preference ${plaintextEmail}`, async () => {
        saved.length = 0;
        const body = bodyIsHtml ? '<p>Hello <strong>team</strong></p>' : 'Keep <strong>literal</strong> and <address@example.com>\nSecond line';
        useStore.setState({ plaintextEmail });
        useStore.getState().openCompose(composeDataFromScheduled({
          accountId: 'acct', to: ['recipient@example.com'], subject: 'Scheduled', body, bodyIsHtml,
        }));
        const root = createRoot(document.getElementById('root'));
        try {
          await React.act(async () => { root.render(React.createElement(ComposeModal)); });
          assert.equal(useStore.getState().plaintextEmail, plaintextEmail, 'the global preference is unchanged');
          const textarea = document.querySelector('textarea[placeholder="compose.bodyPh"]');
          if (bodyIsHtml) {
            assert.ok(!textarea, 'HTML is reopened in the rich-text editor');
            assert.match(document.querySelector('.ProseMirror').editor.getHTML(), /<strong>team<\/strong>/);
          } else {
            assert.ok(textarea, 'plain text is reopened in a textarea');
            assert.equal(textarea.value, body, 'angle brackets remain literal text');
          }
          await hideTab();
          assert.equal(saved.length, 1);
          assert.equal(saved[0].bodyIsHtml, bodyIsHtml);
          assert.equal(saved[0].body, body);
        } finally {
          await React.act(async () => { root.unmount(); });
        }
      });
    }
  }
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

async function changeValue(element, value) {
  assert.ok(element);
  await React.act(async () => {
    const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function refreshProtected() {
  const event = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('draft metadata dirty protection', () => {
  for (const field of ['priority', 'sender', 'signature', 'quote', 'plain signature', 'plain quote']) {
    test(`${field}-only edits are protected and become clean after saving`, async () => {
      const plain = field.startsWith('plain');
      const close = await openDraft({ plaintextEmail: plain, body: plain ? 'Original' : '<p>Original</p>',
        priority: 'normal', draftSignature: '<p>Signature</p>', quotedBody: 'Quote', quotedBodyHtml: '<p>Quote</p>' });
      try {
        await hideTab();
        assert.equal(saved.length, 0, 'initial signature/quote defaults stay clean');
        if (field === 'priority') await changeValue(document.querySelector('#compose-priority'), 'low');
        else if (field === 'sender') {
          await React.act(async () => useStore.setState({ accounts: [...useStore.getState().accounts,
            { id: 'other', enabled: true, email_address: 'other@example.invalid', name: 'Other' }] }));
          await changeValue([...document.querySelectorAll('select')].find(el => [...el.options].some(o => o.value === 'account:other')), 'account:other');
        } else if (plain) {
          const textarea = [...document.querySelectorAll('textarea')].find(el => el.value === (field === 'plain signature' ? 'Signature' : 'Quote'));
          await changeValue(textarea, '');
        } else {
          const editable = [...document.querySelectorAll('[contenteditable="true"]')].find(el => el.textContent === (field === 'signature' ? 'Signature' : 'Quote'));
          assert.ok(editable);
          await React.act(async () => { editable.innerHTML = ''; editable.dispatchEvent(new window.Event('input', { bubbles: true })); });
        }
        assert.equal(refreshProtected(), true);
        await hideTab();
        assert.equal(saved.length, 1);
        if (field === 'priority') assert.equal(saved[0].priority, 'low');
        if (field === 'sender') assert.equal(saved[0].accountId, 'other');
        if (field.endsWith('signature')) assert.equal(saved[0].editedSignature, '');
        if (field === 'quote') assert.equal(saved[0].quotedBodyHtml, '');
        if (field === 'plain quote') assert.equal(saved[0].quotedBody, undefined);
        assert.equal(refreshProtected(), false);
        await hideTab();
        assert.equal(saved.length, 1);
      } finally { await close(); useStore.setState({ accounts: useStore.getState().accounts.filter(a => a.id === 'acct') }); }
    });
  }
  test('priority changed during a request remains dirty against the submitted snapshot', async () => {
    const originalSave = api.saveDraft;
    let finish;
    api.saveDraft = payload => { saved.push(payload); return new Promise(resolve => { finish = resolve; }); };
    const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>', priority: 'normal' });
    try {
      await changeValue(document.querySelector('#compose-priority'), 'low');
      await hideTab();
      assert.equal(saved.length, 1);
      await changeValue(document.querySelector('#compose-priority'), 'high');
      await React.act(async () => finish({ uid: 8, folder: 'Drafts' }));
      assert.equal(refreshProtected(), true);
      await hideTab();
      assert.equal(saved.length, 2);
      assert.equal(saved[0].priority, 'low');
      assert.equal(saved[1].priority, 'high');
      await React.act(async () => finish({ uid: 9, folder: 'Drafts' }));
      assert.equal(refreshProtected(), false);
    } finally { api.saveDraft = originalSave; await close(); }
  });
});

describe('draft metadata baselines', () => {
  test('switching back to the same resolved sender stays clean', async () => {
    await React.act(async () => useStore.setState({ accounts: [...useStore.getState().accounts,
      { id: 'other', enabled: true, email_address: 'other@example.invalid', name: 'Other' }] }));
    const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>' });
    try {
      const sender = [...document.querySelectorAll('select')].find(el => [...el.options].some(o => o.value === 'account:other'));
      await changeValue(sender, 'account:other');
      assert.equal(refreshProtected(), true);
      await changeValue(sender, 'account:acct');
      assert.equal(refreshProtected(), false);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); useStore.setState({ accounts: useStore.getState().accounts.filter(a => a.id === 'acct') }); }
  });
  test('a signature loaded after mounting stays clean', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>' });
    try {
      await React.act(async () => useStore.setState({ accounts: useStore.getState().accounts.map(a => ({ ...a, signature: '<p>Default</p>' })) }));
      assert.equal(refreshProtected(), false);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); useStore.setState({ accounts: useStore.getState().accounts.map(a => ({ ...a, signature: null })) }); }
  });
  test('live signature and quote edits during save remain dirty', async () => {
    const originalSave = api.saveDraft;
    let finish;
    api.saveDraft = payload => { saved.push(payload); return new Promise(resolve => { finish = resolve; }); };
    const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>', draftSignature: '<p>Signature</p>', quotedBodyHtml: '<p>Quote</p>' });
    try {
      const signature = [...document.querySelectorAll('[contenteditable="true"]')].find(el => el.textContent === 'Signature');
      const quote = [...document.querySelectorAll('[contenteditable="true"]')].find(el => el.textContent === 'Quote');
      const edit = async (el, html) => React.act(async () => { el.innerHTML = html; el.dispatchEvent(new window.Event('input', { bubbles: true })); });
      await edit(signature, '<p>First</p>');
      await hideTab();
      assert.equal(saved.length, 1);
      await edit(signature, '');
      await edit(quote, '');
      await React.act(async () => finish({ uid: 8, folder: 'Drafts' }));
      assert.equal(refreshProtected(), true);
      await hideTab();
      assert.equal(saved.length, 2);
      assert.equal(saved[0].editedSignature, '<p>First</p>');
      assert.equal(saved[0].quotedBodyHtml, '<p>Quote</p>');
      assert.equal(saved[1].editedSignature, '');
      assert.equal(saved[1].quotedBodyHtml, '');
      await React.act(async () => finish({ uid: 9, folder: 'Drafts' }));
      assert.equal(refreshProtected(), false);
    } finally { api.saveDraft = originalSave; await close(); }
  });
});

test('priority-only edit opens the unsaved changes close dialog', async () => {
  const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>', priority: 'normal' });
  try {
    await changeValue(document.querySelector('#compose-priority'), 'low');
    await React.act(async () => document.querySelector('button[title="compose.toolbar.close"]').click());
    assert.match(document.body.textContent, /compose.closeDraft.title/);
    assert.match(document.body.textContent, /compose.closeDraft.keepEditing/);
  } finally { await close(); }
});

test('alias-only sender change saves the resolved identity and stays clean', async () => {
  await React.act(async () => useStore.setState({ accounts: useStore.getState().accounts.map(a => ({ ...a,
    aliases: [{ id: 'alias1', email: 'alias@example.invalid', name: 'Alias' }] })) }));
  const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>' });
  try {
    const sender = [...document.querySelectorAll('select')].find(el => [...el.options].some(o => o.value === 'alias:alias1:acct'));
    await changeValue(sender, 'alias:alias1:acct');
    assert.equal(refreshProtected(), true);
    await hideTab();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].accountId, 'acct');
    assert.equal(saved[0].aliasId, 'alias1');
    assert.equal(refreshProtected(), false);
    await hideTab();
    assert.equal(saved.length, 1);
  } finally { await close(); useStore.setState({ accounts: useStore.getState().accounts.map(a => ({ ...a, aliases: [] })) }); }
});
