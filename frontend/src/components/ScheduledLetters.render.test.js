// Exercises the real scheduled edit/undo handoff and store queue, with the server boundary stubbed.
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
const { undoSend, restoreCompose } = await import('../utils/sendTracker.js');
const ScheduledLetters = (await import('./ScheduledLetters.jsx')).default;
const ComposeModal = (await import('./ComposeModal.jsx')).default;

function ComposerShell() {
  const composing = useStore(state => state.composing);
  return React.createElement(React.Fragment, null,
    React.createElement(ScheduledLetters), composing && React.createElement(ComposeModal));
}

const originalApi = { ...api.scheduled };
let root;
let letters;
const sendAt = '2030-01-01T10:00:00.000Z';
const compose = subject => ({
  accountId: 'acct', to: ['recipient@example.com'], cc: [], bcc: [], subject,
  body: `<p>${subject} body</p>`, attachments: [{ filename: `${subject}.txt`, content: 'YWJj' }],
});

beforeEach(async () => {
  useStore.getState().setUser(null);
  useStore.getState().setUser({ id: 'u1' });
  useStore.setState({ accounts: [{ id: 'acct', email_address: 'team@example.com' }], notifications: [] });
  letters = new Map(['A', 'B'].map(id => [id, {
    id, accountId: 'acct', status: 'queued', scheduled: true, canManage: true, subject: id, to: ['recipient@example.com'], sendAt,
  }]));
  api.scheduled.list = async () => ({ letters: [...letters.values()] });
  api.scheduled.cancel = async id => {
    assert.ok(letters.delete(id), `server payload ${id} exists before cancellation`);
    return { compose: compose(id), sendAt };
  };
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ScheduledLetters)); });
});

afterEach(async () => {
  await React.act(async () => { root.unmount(); });
  Object.assign(api.scheduled, originalApi);
  useStore.getState().setUser(null);
});

async function edit(id) {
  await React.act(async () => { useStore.getState().setShowScheduled(true); });
  const button = document.querySelector(`[data-scheduled-letter="${id}"] [data-scheduled-action="edit"]`);
  assert.ok(button, `Edit ${id} is available`);
  await React.act(async () => { button.click(); });
}

async function closeComposer() {
  await React.act(async () => { useStore.getState().closeCompose(); });
}

function current(subject, scheduled = true) {
  const state = useStore.getState();
  assert.equal(state.composing, true);
  assert.equal(state.composeData.subject, subject);
  assert.equal(state.composeData.body, `<p>${subject} body</p>`);
  assert.equal(state.composeMinimized, false);
  if (scheduled) assert.equal(state.composeData.sendAt, sendAt);
}

test('two scheduled edits retain both cancelled payloads and open one per composer close', async () => {
  await React.act(async () => {
    useStore.getState().openCompose(compose('C'));
    useStore.getState().setComposeMinimized(true);
  });
  await edit('A');
  await edit('B');
  assert.equal(letters.size, 0, 'both server payloads have been removed');
  assert.equal(useStore.getState().composeData.subject, 'C');
  assert.equal(useStore.getState().composeMinimized, true);
  await closeComposer();
  current('A');
  assert.deepEqual(useStore.getState().composeData.attachments, [{ name: 'A.txt', size: undefined, type: 'application/octet-stream', data: 'YWJj' }]);
  await closeComposer();
  current('B');
  await closeComposer();
  assert.equal(useStore.getState().composing, false);
});

test('overlapping undo responses queue in arrival order alongside a scheduled edit', async () => {
  await React.act(async () => { useStore.getState().openCompose(compose('C')); });
  await edit('A');
  const pending = new Map();
  api.scheduled.cancel = id => new Promise(resolve => { pending.set(id, resolve); });
  const first = undoSend('undo-1');
  const second = undoSend('undo-2');
  await React.act(async () => {
    pending.get('undo-2')({ compose: compose('Undo B') });
    assert.equal(await second, true);
    pending.get('undo-1')({ compose: compose('Undo A') });
    assert.equal(await first, true);
  });
  await closeComposer();
  current('A');
  await closeComposer();
  current('Undo B', false);
  await closeComposer();
  current('Undo A', false);
  await closeComposer();
  assert.equal(useStore.getState().composing, false);
});

test('an idle composer opens the first restore immediately and retains the next', async () => {
  await React.act(async () => {
    restoreCompose(compose('A'));
    restoreCompose(compose('B'));
  });
  current('A', false);
  await closeComposer();
  current('B', false);
  await closeComposer();
  assert.equal(useStore.getState().composing, false);
});

test('a restore arriving in the same batch as close remounts the composer with the oldest letter', async () => {
  await React.act(async () => { root.render(React.createElement(ComposerShell)); });
  await React.act(async () => { useStore.getState().openCompose(compose('C')); });
  await edit('A');
  await React.act(async () => {
    useStore.getState().closeCompose();
    restoreCompose(compose('B'));
  });
  current('A');
  assert.ok([...document.querySelectorAll('input')].some(input => input.value === 'A'), 'the mounted form shows A, not C');
  await closeComposer();
  current('B', false);
  assert.ok([...document.querySelectorAll('input')].some(input => input.value === 'B'), 'the next mounted form shows B');
});

test('same-user refresh retains restores and identity changes clear the entire queue', async () => {
  await React.act(async () => { useStore.getState().openCompose(compose('C')); });
  await edit('A');
  await edit('B');
  await React.act(async () => { useStore.getState().setUser({ id: 'u1', email: 'user@example.com' }); });
  await closeComposer();
  current('A');
  await React.act(async () => { useStore.getState().setUser({ id: 'u2' }); });
  assert.equal(useStore.getState().composing, false);
  await React.act(async () => {
    useStore.getState().openCompose(compose('C'));
    restoreCompose(compose('D'));
    restoreCompose(compose('E'));
    useStore.getState().setUser(null);
  });
  assert.equal(useStore.getState().composing, false);
  await React.act(async () => { useStore.getState().setUser({ id: 'u1' }); });
  await closeComposer();
  assert.equal(useStore.getState().composing, false);
});

test('a late list response for the previous mailbox filter does not replace the current one', async () => {
  const letter = accountId => ({
    id: `${accountId}-job`, accountId, status: 'queued', scheduled: true, canManage: false,
    subject: `${accountId} letter`, to: ['recipient@example.com'], sendAt,
  });
  let releaseA;
  api.scheduled.list = accountId => (accountId === 'a'
    ? new Promise(resolve => { releaseA = resolve; })
    : Promise.resolve({ letters: [letter(accountId)] }));
  useStore.setState({
    accounts: [{ id: 'a', email_address: 'a@example.com' }, { id: 'b', email_address: 'b@example.com' }],
    selectedAccountId: 'a',
  });
  await React.act(async () => { useStore.getState().setShowScheduled(true); });
  assert.ok(releaseA, 'the list for mailbox A is pending');

  const picker = document.querySelector('[data-scheduled-dialog] select');
  await React.act(async () => {
    picker.value = 'b';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  const shown = () => [...document.querySelectorAll('[data-scheduled-letter]')].map(el => el.dataset.scheduledLetter);
  assert.deepEqual(shown(), ['b-job']);

  await React.act(async () => releaseA({ letters: [letter('a')] }));
  assert.equal(picker.value, 'b');
  assert.deepEqual(shown(), ['b-job'], 'the obsolete mailbox A response must be ignored');
  await React.act(async () => { useStore.getState().setShowScheduled(false); });
});

test('a late list failure for the previous mailbox filter does not hide the current letters', async () => {
  let rejectA;
  api.scheduled.list = accountId => (accountId === 'a'
    ? new Promise((_, reject) => { rejectA = reject; })
    : Promise.resolve({ letters: [{
      id: 'b-job', accountId: 'b', status: 'queued', scheduled: true, canManage: false,
      subject: 'b letter', to: ['recipient@example.com'], sendAt,
    }] }));
  useStore.setState({
    accounts: [{ id: 'a', email_address: 'a@example.com' }, { id: 'b', email_address: 'b@example.com' }],
    selectedAccountId: 'a',
  });
  await React.act(async () => { useStore.getState().setShowScheduled(true); });
  const picker = document.querySelector('[data-scheduled-dialog] select');
  await React.act(async () => {
    picker.value = 'b';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  });

  await React.act(async () => rejectA(new Error('stale list failed')));
  const alert = document.querySelector('[data-scheduled-dialog] [role="alert"]');
  assert.equal(alert?.textContent ?? null, null, 'the obsolete failure must not be shown');
  assert.deepEqual([...document.querySelectorAll('[data-scheduled-letter]')].map(el => el.dataset.scheduledLetter), ['b-job']);
  await React.act(async () => { useStore.getState().setShowScheduled(false); });
});

test('a failed undo request keeps the job retryable; a send that already started does not', async () => {
  const { undoSendOutcome } = await import('../utils/sendTracker.js');
  api.scheduled.cancel = async () => { throw new Error('temporary outage'); };
  assert.equal(await undoSendOutcome('job-1'), 'failed');
  api.scheduled.cancel = async () => { throw Object.assign(new Error('started'), { code: 'send_started' }); };
  assert.equal(await undoSendOutcome('job-1'), 'too_late');
  assert.equal(await undoSend('job-1'), false);
  api.scheduled.cancel = async () => ({ compose: null });
  assert.equal(await undoSendOutcome('job-1'), 'undone');
});

test('only permanent refusals are final for undo', async () => {
  const { isFinalUndoRefusal } = await import('../utils/sendTracker.js');
  const err = (status, code) => Object.assign(new Error('x'), { status, code });
  for (const e of [err(409, 'not_cancellable'), err(404, 'not_found'), err(403, 'not_author'), err(409, 'send_started'), err(409, 'already_sent')]) {
    assert.equal(isFinalUndoRefusal(e), true, `${e.status} ${e.code}`);
  }
  for (const e of [new Error('network'), err(502), err(500, 'internal'), err(429, 'rate_limited'), err(423, 'locked'), err(401, 'session')]) {
    assert.equal(isFinalUndoRefusal(e), false, `${e.status} ${e.code}`);
  }
});
