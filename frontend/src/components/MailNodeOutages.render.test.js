// Render tests for the mail node outages (R-43): the administrators' section (windows, banner,
// letters, windows by hand) and the notice in a mailbox. The pure rules are covered by
// utils/mailNodeOutage.test.js.
//
// The harness is the one of MailNodeOps.render.test.js: sucrase for .jsx, react-i18next stubbed to
// return the raw key.

import { test, describe, beforeEach } from 'node:test';
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
const MailNodeOutagesSection = (await import('./MailNodeOutagesSection.jsx')).default;
const { default: MailNodeOutageNotice, forgetOutageLetters } = await import('./MailNodeOutageNotice.jsx');

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000).toISOString();
const OPEN = {
  id: 'w-open', startedAt: hoursFromNow(-2), endedAt: null, open: true, source: 'detected', planned: false, reason: null,
  cause: { signals: ['containers'], down: [{ name: 'postfix-mailcow', state: 'exited' }], startUncertain: false },
  evidence: { lastBefore: hoursFromNow(-2.1), firstAfter: null, during: 0, logFrom: hoursFromNow(-48) },
  trace: { checkedAt: hoursFromNow(-0.1), complete: true, requests: 2, error: null }, counts: { delayed: 0, waiting: 2, lost: 0, other: 0 },
};
const PAST = {
  id: 'w-past', startedAt: hoursFromNow(-80), endedAt: hoursFromNow(-54), open: false, source: 'manual', planned: true, reason: 'Planned mailcow update',
  cause: {}, evidence: null, trace: null, counts: { delayed: 1, waiting: 0, lost: 1, other: 0 },
};
const OUTAGES = {
  windows: [OPEN, PAST], state: { lastCheckAt: hoursFromNow(-0.05), lastResult: 'failed' },
  waiting: { waiting: 2, soonestExpiresAt: hoursFromNow(22) }, settings: { retentionDays: 30 }, defaults: { retentionDays: 30 }, traceConnected: true, expiryHours: 24,
};
const WINDOW_LETTERS = [
  { recipient: 'sales@example.com', sender: 'orders@fabrikam.example', subject: 'PO 7781', receivedAt: hoursFromNow(-1.5), outcome: 'waiting', status: 'pending', expiresAt: hoursFromNow(22.5), statusCode: '4.4.316', detail: '450 4.4.316 Connection refused', nodeLog: 'missing' },
  { recipient: 'ops@example.com', sender: 'prize@lottery.example', subject: 'You won', receivedAt: hoursFromNow(-1), outcome: 'other', status: 'quarantined', expiresAt: null, nodeLog: null },
];
const USER_LETTERS = [
  { outageId: 'w-past', recipient: 'sales@example.com', accountId: 'acc-sales', sender: 'legal@contoso.example', subject: 'Signed contract', receivedAt: hoursFromNow(-79), outcome: 'lost', expired: true, expiresAt: null },
  { outageId: 'w-open', recipient: 'sales@example.com', accountId: 'acc-sales', sender: 'orders@fabrikam.example', subject: 'PO 7781', receivedAt: hoursFromNow(-1.5), outcome: 'waiting', expired: false, expiresAt: hoursFromNow(22.5) },
  { outageId: 'w-past', recipient: 'ops@example.com', accountId: 'acc-ops', sender: 'billing@litware.example', subject: 'Invoice', receivedAt: hoursFromNow(-57), outcome: 'delayed', expired: false, expiresAt: null },
];

let calls;
let answers;
function mockFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = opts.method || 'GET';
    calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : undefined });
    const answer = answers[`${method} ${path}`];
    const value = typeof answer === 'function' ? answer(opts) : answer;
    if (value?.status >= 400) return { ok: false, status: value.status, json: async () => value.body };
    return { ok: true, status: 200, json: async () => value ?? {} };
  };
}

beforeEach(() => {
  calls = [];
  forgetOutageLetters();
  localStorage.clear();
  answers = {
    'GET /api/mail-node/outages': OUTAGES,
    'GET /api/mail-node/outages/w-open/letters': { window: OPEN, letters: WINDOW_LETTERS },
    'POST /api/mail-node/outages': (opts) => ({ window: { ...PAST, id: 'w-new', ...JSON.parse(opts.body) } }),
    'POST /api/mail-node/outages/w-open/close': { window: { ...OPEN, open: false, endedAt: new Date().toISOString() } },
    'DELETE /api/mail-node/outages/w-past': { ok: true },
    'POST /api/mail-node/outages/trace': { connected: true, windows: [] },
    'PUT /api/mail-node/outage-settings': (opts) => ({ settings: JSON.parse(opts.body) }),
    'GET /api/mail-node/outage-letters': { traceConnected: true, node: true, letters: USER_LETTERS },
  };
  mockFetch();
});

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
async function mount(element) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  await React.act(async () => { createRoot(host).render(element); });
  await flush();
  return host;
}
const buttons = (root, text) => [...root.querySelectorAll('button')].filter((b) => b.textContent === text);
async function click(element) {
  await React.act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await flush();
}
async function setValue(element, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await React.act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function submit(form) {
  await React.act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
}

describe('MailNodeOutagesSection', () => {
  test('shows the banner while letters wait, the windows with how they came to be and their counts', async () => {
    const root = await mount(React.createElement(MailNodeOutagesSection));
    const banner = root.querySelector('[data-outage-banner]');
    assert.equal(banner.getAttribute('role'), 'alert');
    assert.match(banner.textContent, /admin\.outages\.bannerWaiting/);
    assert.match(banner.textContent, /admin\.outages\.bannerTimeLeft/);
    assert.match(banner.textContent, /admin\.outages\.bannerAdvice/);
    const open = root.querySelector('[data-outage="w-open"]');
    assert.equal(open.dataset.open, 'true');
    assert.match(open.textContent, /admin\.outages\.ongoing/);
    assert.match(open.textContent, /admin\.outages\.sourceDetected/);
    assert.match(open.textContent, /admin\.outages\.causeContainers/);
    assert.match(open.textContent, /admin\.outages\.counts/);
    const past = root.querySelector('[data-outage="w-past"]');
    assert.match(past.textContent, /admin\.outages\.sourcePlanned/);
    assert.match(past.textContent, /Planned mailcow update/);
    assert.match(past.textContent, /admin\.outages\.notTracedYet/);
    assert.equal(buttons(past, 'admin.outages.close').length, 0);
    assert.equal(root.querySelector('[data-trace-not-connected]'), null);
    assert.ok(root.querySelectorAll('th[scope="col"]').length >= 4);
  });

  test('says when no trace is connected, without the trace button', async () => {
    answers['GET /api/mail-node/outages'] = { ...OUTAGES, traceConnected: false, waiting: { waiting: 0, soonestExpiresAt: null } };
    const root = await mount(React.createElement(MailNodeOutagesSection));
    assert.ok(root.querySelector('[data-trace-not-connected]'));
    assert.equal(root.querySelector('[data-outage-banner]'), null);
    assert.equal(buttons(root, 'admin.outages.traceNow').length, 0);
  });

  test('opens the letters of a window with subjects, outcome, EOP\'s words and the node log', async () => {
    const root = await mount(React.createElement(MailNodeOutagesSection));
    const open = root.querySelector('[data-outage="w-open"]');
    const toggle = buttons(open, 'admin.outages.letters')[0];
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    await click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    const table = root.querySelector('[data-outage-letters]');
    assert.match(table.textContent, /PO 7781/);
    assert.match(table.textContent, /450 4\.4\.316 Connection refused/);
    assert.match(table.textContent, /admin\.outages\.nodeLogMissing/);
    assert.match(table.querySelector('[data-letter-outcome="other"]').textContent, /admin\.outages\.otherNote/);
  });

  test('marks a window by hand only with a start and a reason, then lists again', async () => {
    const root = await mount(React.createElement(MailNodeOutagesSection));
    await click(buttons(root, 'admin.outages.add')[0]);
    const form = root.querySelector('[data-outage-form="add"]');
    assert.match(form.textContent, /admin\.outages\.errorStart/);
    const [start] = form.querySelectorAll('input[type="datetime-local"]');
    await setValue(start, '2026-10-02T10:00');
    assert.match(root.querySelector('[data-form-error]').textContent, /admin\.outages\.errorReason/);
    await setValue(form.querySelector('input:not([type])'), 'Planned maintenance');
    assert.equal(root.querySelector('[data-form-error]'), null);
    await submit(form);
    const posted = calls.find((c) => c.method === 'POST' && c.path === '/api/mail-node/outages');
    assert.equal(posted.body.reason, 'Planned maintenance');
    assert.equal(posted.body.startedAt, new Date('2026-10-02T10:00').toISOString());
    assert.equal(calls.filter((c) => c.path === '/api/mail-node/outages' && c.method === 'GET').length, 2);
    assert.equal(root.querySelector('[data-outage-form]'), null);
  });

  test('closes an open window with a reason, deletes one only with a reason', async () => {
    const root = await mount(React.createElement(MailNodeOutagesSection));
    await click(buttons(root.querySelector('[data-outage="w-open"]'), 'admin.outages.close')[0]);
    const form = root.querySelector('[data-outage-form="close"]');
    await setValue(form.querySelector('input:not([type])'), 'Node back');
    await submit(form);
    assert.deepEqual(calls.find((c) => c.path === '/api/mail-node/outages/w-open/close').body, { reason: 'Node back' });

    await click(buttons(root.querySelector('[data-outage="w-past"]'), 'admin.outages.delete')[0]);
    const dialog = root.querySelector('[role="alertdialog"]');
    assert.equal(dom.window.document.activeElement, dialog.querySelector('input'));
    const confirm = buttons(dialog, 'admin.outages.deleteButton')[0];
    assert.equal(confirm.disabled, true);
    await setValue(dialog.querySelector('input'), 'Marked twice');
    await click(confirm);
    assert.deepEqual(calls.find((c) => c.method === 'DELETE').body, { confirm: true, reason: 'Marked twice' });
  });

  test('checks the trace now and saves the retention within 1 to 90 days', async () => {
    const root = await mount(React.createElement(MailNodeOutagesSection));
    await click(buttons(root, 'admin.outages.traceNow')[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/outages/trace'));
    const input = root.querySelector('input[inputmode="numeric"]');
    await setValue(input, '0');
    assert.equal(buttons(root, 'admin.outages.saveRetention')[0].disabled, true);
    await setValue(input, '14');
    await click(buttons(root, 'admin.outages.saveRetention')[0]);
    assert.deepEqual(calls.find((c) => c.method === 'PUT').body, { retentionDays: 14 });
  });

  test('shows the server\'s refusal in words', async () => {
    answers['POST /api/mail-node/outages/w-open/close'] = { status: 409, body: { error: 'closed', code: 'outage_already_closed' } };
    const root = await mount(React.createElement(MailNodeOutagesSection));
    await click(buttons(root.querySelector('[data-outage="w-open"]'), 'admin.outages.close')[0]);
    const form = root.querySelector('[data-outage-form="close"]');
    await setValue(form.querySelector('input:not([type])'), 'Back');
    await submit(form);
    assert.match(root.querySelector('[role="alert"]:not([data-outage-banner])').textContent, /admin\.outages\.errorAlreadyClosed/);
  });
});

describe('MailNodeOutageNotice', () => {
  test('shows nothing for a mailbox without such letters', async () => {
    const root = await mount(React.createElement(MailNodeOutageNotice, { accountId: 'acc-other' }));
    assert.equal(root.querySelector('[data-outage-notice]'), null);
  });

  test('sums up the mailbox\'s letters, lists them on demand, waiting and lost first, with what to do', async () => {
    const root = await mount(React.createElement(MailNodeOutageNotice, { accountId: 'acc-sales' }));
    const notice = root.querySelector('[data-outage-notice]');
    assert.equal(notice.getAttribute('role'), 'status');
    assert.match(notice.textContent, /messageList\.outage\.summaryWaiting/);
    assert.equal(notice.querySelector('ul'), null);
    const toggle = buttons(notice, 'messageList.outage.show')[0];
    await click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(dom.window.document.getElementById(toggle.getAttribute('aria-controls')).tagName, 'UL');
    const items = [...notice.querySelectorAll('[data-letter-outcome]')];
    assert.deepEqual(items.map((li) => li.dataset.letterOutcome), ['waiting', 'lost']);
    assert.match(items[0].textContent, /PO 7781/);
    assert.match(items[0].textContent, /messageList\.outage\.timeLeft/);
    assert.match(items[1].textContent, /messageList\.outage\.outcomeLostExpired/);
    assert.match(items[1].textContent, /messageList\.outage\.adviceLost/);
    assert.equal(notice.textContent.includes('Invoice'), false);
  });

  test('names the mailbox in the unified inbox, and "Got it" hides it until a new letter comes', async () => {
    const root = await mount(React.createElement(MailNodeOutageNotice, { accountId: null, showRecipient: true }));
    await click(buttons(root, 'messageList.outage.show')[0]);
    assert.equal(root.querySelectorAll('[data-letter-outcome]').length, 3);
    assert.match(root.textContent, /messageList\.outage\.columnTo/);
    await click(buttons(root, 'messageList.outage.dismiss')[0]);
    assert.equal(root.querySelector('[data-outage-notice]'), null);
    forgetOutageLetters();
    answers['GET /api/mail-node/outage-letters'] = {
      traceConnected: true, node: true,
      letters: [...USER_LETTERS, { ...USER_LETTERS[1], subject: 'PO 7782', receivedAt: hoursFromNow(-0.5) }],
    };
    const again = await mount(React.createElement(MailNodeOutageNotice, { accountId: null }));
    assert.ok(again.querySelector('[data-outage-notice]'));
  });

  test('stays away when the letters cannot be read', async () => {
    answers['GET /api/mail-node/outage-letters'] = { status: 500, body: { error: 'down' } };
    const root = await mount(React.createElement(MailNodeOutageNotice, { accountId: 'acc-sales' }));
    assert.equal(root.querySelector('[data-outage-notice]'), null);
  });
});
