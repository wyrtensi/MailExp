// Render tests for the mail node's quarantine and "why is this letter in Spam" (R-20): the list
// with rspamd's main symbols, an entry opened in the safe text view (a hostile letter shows no
// image, script or clickable link), release and delete behind a confirmation for administrators
// only, the users setting, the section hiding itself from a user it is not shown to, and the
// verdict under a letter in Spam. The pure rules are covered by utils/quarantine.test.js.
//
// The harness is the one of MailNodeDns.render.test.js: sucrase for .jsx, react-i18next stubbed to
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
  localStorage: dom.window.localStorage, DOMParser: dom.window.DOMParser,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const MailNodeQuarantine = (await import('./MailNodeQuarantine.jsx')).default;
const SpamVerdict = (await import('./SpamVerdict.jsx')).default;

const ROW = {
  id: 41, qid: 'Q41', subject: 'Overdue invoice', score: 16.1, sender: 'billing@bad.example', rcpt: 'sales@example.com',
  action: 'reject', created: '2026-09-30T07:12:04.000Z', notified: false, virus: false, accountId: 'acc-1',
  topSymbols: [{ name: 'MIME_BAD_EXTENSION', score: 10.1 }, { name: 'MICROSOFT_SPAM', score: 4 }],
};
const OTHER = { ...ROW, id: 40, subject: 'Partner news', sender: 'news@partner.example', action: 'add header', score: 9.2, topSymbols: null };
const HOSTILE_HTML = '<p>Pay now</p><img src="https://tracker.bad.example/open.gif"><script>alert(1)</script>'
  + '<a href="https://evil.example/login">Open your account</a><iframe src="https://evil.example/frame"></iframe>';
const DETAIL = {
  ...ROW, ip: '198.51.100.7', user: null, created: '2026-09-30 07:12:04', admin: true,
  symbols: [{ name: 'MIME_BAD_EXTENSION', score: 10.1, options: ['exe'], description: null }, { name: 'MIME_GOOD', score: -0.1, options: [], description: null }],
  letter: {
    headers: [{ name: 'From', value: 'Billing <billing@bad.example>' }, { name: 'X-Forefront-Antispam-Report', value: 'SFV:SPM;CAT:SPM;' }],
    from: 'Billing <billing@bad.example>', to: 'sales@example.com', cc: null, subject: 'Overdue invoice', date: 'Wed, 30 Sep 2026 07:12:00 +0000',
    messageId: '<q41@bad.example>', eop: { verdict: 'SPM', category: 'SPM' }, html: HOSTILE_HTML, text: null,
    attachments: [{ filename: 'invoice.exe', type: 'application/octet-stream', size: 48213 }], truncated: false,
  },
};

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
  answers = {
    'GET /api/mail-node/quarantine': { admin: true, total: 2, truncated: false, historyRead: true, items: [ROW, OTHER] },
    'GET /api/mail-node/quarantine/settings': { userView: false, nodeSettingsAppliedAt: null, nodeSettings: { max_size: 10, retention_size: 20, max_age: 365, release_format: 'raw' } },
    'GET /api/mail-node/quarantine/41': DETAIL,
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
// Earlier tests' hosts stay mounted: the dialog of this test is the last one.
const lastDialog = () => [...dom.window.document.querySelectorAll('[role="dialog"]')].at(-1);
const dialogConfirm = () => lastDialog().querySelector('[data-confirm-button]');

describe('MailNodeQuarantine', () => {
  test('lists the entries with score, action and the main symbols', async () => {
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    assert.equal(host.querySelector('[data-quarantine-count]').getAttribute('data-quarantine-count'), '2');
    const row = host.querySelector('[data-quarantine-row="41"]');
    assert.ok(row.textContent.includes('16.1'));
    assert.ok(row.textContent.includes('message.spamVerdict.action.reject'));
    assert.deepEqual([...row.querySelectorAll('[data-symbol]')].map((s) => s.getAttribute('data-symbol')), ['MIME_BAD_EXTENSION', 'MICROSOFT_SPAM']);
    assert.ok(host.querySelector('[data-quarantine-row="40"]').textContent.includes('message.spamVerdict.action.addHeader'));
  });

  test('opens an entry as safe text: no image, script, frame or clickable link, attachments by name only', async () => {
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    await click(buttons(host, 'Overdue invoice')[0]);
    const entry = host.querySelector('[data-quarantine-entry="41"]');
    assert.ok(entry, 'the entry opens');
    const body = entry.querySelector('[data-safe-view-body]');
    assert.equal(body.querySelectorAll('img, script, iframe, a, form').length, 0);
    assert.ok(body.textContent.includes('Open your account'));
    assert.equal(body.querySelector('.safe-view-host').textContent, 'evil.example');
    assert.ok(!body.innerHTML.includes('tracker.bad.example'), 'an image leaves no trace');
    assert.equal(entry.querySelectorAll('a').length, 0, 'nothing in the entry is a link');
    assert.ok(entry.querySelector('[data-quarantine-attachments]').textContent.includes('invoice.exe'));
    assert.ok(entry.querySelector('[data-quarantine-verdict]').textContent.includes('admin.quarantine.scoreAction'));
    assert.deepEqual([...entry.querySelectorAll('[data-symbol]')].map((s) => s.getAttribute('data-symbol')), ['MIME_BAD_EXTENSION', 'MIME_GOOD']);
    assert.ok(entry.querySelector('[data-quarantine-headers]').textContent.includes('X-Forefront-Antispam-Report: SFV:SPM;CAT:SPM;'));
  });

  test('releases after a confirmation that says what releasing a refused letter does', async () => {
    answers['POST /api/mail-node/quarantine/41/release'] = { ok: true, learned: true, warnings: [] };
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    await click(buttons(host, 'Overdue invoice')[0]);
    await click(buttons(host, 'admin.quarantine.release')[0]);
    const dialog = lastDialog();
    assert.ok(dialog.textContent.includes('admin.quarantine.noteRejected'));
    assert.ok(dialog.textContent.includes('admin.quarantine.releaseEopNote'), 'EOP marked it as spam: it lands in Spam again');
    assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing is released before the confirmation');
    await click(dialogConfirm());
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/quarantine/41/release'));
    assert.equal(host.querySelector('[data-quarantine-row="41"]'), null);
    assert.equal(host.querySelector('[data-quarantine-entry]'), null);
    assert.ok(host.textContent.includes('admin.quarantine.released'));
  });

  test('deletes after a confirmation', async () => {
    answers['DELETE /api/mail-node/quarantine/41'] = { ok: true };
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    await click(buttons(host, 'Overdue invoice')[0]);
    await click(buttons(host.querySelector('[data-quarantine-entry]'), 'common.delete')[0]);
    assert.ok(lastDialog().textContent.includes('admin.quarantine.deleteMessage'));
    await click(dialogConfirm());
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/mail-node/quarantine/41'));
    assert.ok(host.textContent.includes('admin.quarantine.deleted'));
  });

  test('saves the users setting', async () => {
    answers['PUT /api/mail-node/quarantine/settings'] = { ok: true, userView: true };
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    const box = host.querySelector('input[type="checkbox"]');
    assert.equal(box.checked, false);
    await click(box);
    assert.deepEqual(calls.find((c) => c.method === 'PUT').body, { userView: true });
    assert.equal(host.querySelector('input[type="checkbox"]').checked, true);
  });

  test('shows a user the entries read-only, and nothing at all without the setting', async () => {
    answers['GET /api/mail-node/quarantine'] = { admin: false, total: 1, truncated: false, historyRead: true, items: [ROW] };
    answers['GET /api/mail-node/quarantine/41'] = { ...DETAIL, admin: false };
    const host = await mount(React.createElement(MailNodeQuarantine, {}));
    assert.equal(host.querySelector('input[type="checkbox"]'), null, 'no setting for a user');
    assert.ok(!calls.some((c) => c.path === '/api/mail-node/quarantine/settings'));
    await click(buttons(host, 'Overdue invoice')[0]);
    assert.ok(host.querySelector('[data-quarantine-entry="41"] [data-safe-view-body]'));
    assert.equal(buttons(host, 'admin.quarantine.release').length, 0);
    assert.equal(buttons(host, 'common.delete').length, 0);

    answers['GET /api/mail-node/quarantine'] = { status: 403, body: { error: 'Only administrators see the quarantine', code: 'quarantine_admin_only' } };
    const hidden = await mount(React.createElement(MailNodeQuarantine, {}));
    assert.equal(hidden.querySelector('[data-mail-node-quarantine]'), null);
  });

  test('says when the node cannot be read', async () => {
    answers['GET /api/mail-node/quarantine'] = { status: 502, body: { error: 'The mail node is unreachable (ECONNREFUSED)', code: 'mail_node_unreachable' } };
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    assert.ok(host.querySelector('[role="alert"]'));
  });
});

describe('SpamVerdict', () => {
  const VERDICT = {
    eopCategory: 'SPM', historyRows: 1000,
    rspamd: {
      matchedBy: 'message_id', time: '2026-10-01T10:00:00.000Z', score: 12.1, spamScore: 8, rejectScore: 15, action: 'add header', skipped: false,
      symbols: [{ name: 'MIME_BAD_EXTENSION', score: 10.1, description: 'Bad extension' }, { name: 'MIME_GOOD', score: -0.1, description: null }],
    },
  };

  test('asks the server only on request, then shows the reasons, score and symbols', async () => {
    answers['GET /api/mail-node/messages/m-1/spam-verdict'] = VERDICT;
    const host = await mount(React.createElement(SpamVerdict, { messageId: 'm-1', eopCategory: 'SPM' }));
    assert.equal(calls.length, 0);
    await click(buttons(host, 'message.spamVerdict.ask')[0]);
    const panel = host.querySelector('[data-spam-verdict]');
    assert.deepEqual([...panel.querySelectorAll('[data-reason]')].map((r) => r.getAttribute('data-reason')), [
      'message.spamVerdict.reasonRspamd', 'message.spamVerdict.reasonEop',
    ]);
    assert.ok(panel.querySelector('[data-rspamd-score]'));
    assert.deepEqual([...panel.querySelectorAll('[data-symbol]')].map((s) => s.getAttribute('data-symbol')), ['MIME_BAD_EXTENSION', 'MIME_GOOD']);
    assert.ok(panel.textContent.includes('message.spamVerdict.eop'));
  });

  test('says when the history has no entry and when the lookup failed', async () => {
    answers['GET /api/mail-node/messages/m-2/spam-verdict'] = { eopCategory: null, historyRows: 1000, rspamd: null };
    const host = await mount(React.createElement(SpamVerdict, { messageId: 'm-2' }));
    await click(buttons(host, 'message.spamVerdict.ask')[0]);
    assert.ok(host.querySelector('[data-rspamd-missing]'));
    assert.equal(host.querySelectorAll('[data-reason]').length, 0);

    answers['GET /api/mail-node/messages/m-3/spam-verdict'] = { status: 502, body: { error: 'The mail node is unreachable', code: 'mail_node_unreachable' } };
    const failed = await mount(React.createElement(SpamVerdict, { messageId: 'm-3' }));
    await click(buttons(failed, 'message.spamVerdict.ask')[0]);
    const alert = failed.querySelector('[role="alert"]');
    assert.ok(alert.textContent.includes('message.spamVerdict.failed'));
    assert.equal(buttons(failed, 'message.spamVerdict.retry').length, 1);
  });

  test('shows a refused letter without the rspamd reason, and says how an unusual row was found', async () => {
    answers['GET /api/mail-node/messages/m-6/spam-verdict'] = {
      eopCategory: null, historyRows: 640,
      rspamd: { ...VERDICT.rspamd, action: 'reject', matchedBy: 'message_id_other_rcpt' },
    };
    const host = await mount(React.createElement(SpamVerdict, { messageId: 'm-6' }));
    await click(buttons(host, 'message.spamVerdict.ask')[0]);
    assert.deepEqual([...host.querySelectorAll('[data-reason]')].map((r) => r.getAttribute('data-reason')), ['message.spamVerdict.reasonOther']);
    assert.equal(host.querySelector('[data-match-note]').getAttribute('data-match-note'), 'message_id_other_rcpt');
    assert.ok(host.textContent.includes('Bad extension'), 'a symbol\'s description is on screen, not only in a tooltip');
  });

  test('drops an answer for a letter no longer shown', async () => {
    let resolve;
    answers['GET /api/mail-node/messages/m-4/spam-verdict'] = () => new Promise((r) => { resolve = r; });
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    await React.act(async () => { root.render(React.createElement(SpamVerdict, { messageId: 'm-4' })); });
    await click(buttons(host, 'message.spamVerdict.ask')[0]);
    await React.act(async () => { root.render(React.createElement(SpamVerdict, { messageId: 'm-5' })); });
    resolve(VERDICT);
    await flush();
    assert.equal(host.querySelector('[data-spam-verdict]'), null);
    assert.equal(buttons(host, 'message.spamVerdict.ask').length, 1);
  });
});

describe('MailNodeQuarantine — node settings and training', () => {
  test('warns when the history shows spam but the quarantine is empty', async () => {
    answers['GET /api/mail-node/quarantine'] = { admin: true, total: 0, truncated: false, historyRead: true, spamInHistory: 4, items: [] };
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    assert.ok(host.querySelector('[data-quarantine-probably-off]'));
    assert.ok(!host.textContent.includes('admin.quarantine.emptyNote'));
  });

  test('writes mailcow\'s quarantine settings only after a warning, then offers to re-apply', async () => {
    answers['POST /api/mail-node/quarantine/node-settings'] = {
      ok: true, userView: false, nodeSettingsAppliedAt: '2026-10-02T10:00:00.000Z', nodeSettings: { max_size: 10, retention_size: 20, max_age: 365, release_format: 'raw' },
    };
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    assert.equal(host.querySelector('[data-quarantine-node-settings]').getAttribute('data-quarantine-node-settings'), 'never');
    await click(buttons(host, 'admin.quarantine.nodeSettingsApply')[0]);
    const dialog = lastDialog();
    assert.ok(dialog.textContent.includes('admin.quarantine.nodeSettingsWarning'));
    assert.ok(dialog.textContent.includes('admin.quarantine.nodeSettingsValues'));
    assert.ok(!calls.some((c) => c.method === 'POST'));
    await click(dialogConfirm());
    assert.deepEqual(calls.find((c) => c.method === 'POST').body, { confirm: true });
    assert.equal(host.querySelector('[data-quarantine-node-settings]').getAttribute('data-quarantine-node-settings'), 'applied');
    await click(buttons(host, 'admin.quarantine.nodeSettingsReapply')[0]);
    assert.ok(lastDialog().textContent.includes('admin.quarantine.nodeSettingsReapplyWarning'));
  });

  test('says releasing cannot be undone, and gives the EOP note only to a refused letter', async () => {
    answers['GET /api/mail-node/quarantine/40'] = { ...DETAIL, id: 40, action: 'add header' };
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    await click(buttons(host, 'Partner news')[0]);
    await click(buttons(host.querySelector('[data-quarantine-entry="40"]'), 'admin.quarantine.release')[0]);
    const dialog = lastDialog();
    assert.ok(dialog.textContent.includes('admin.quarantine.noteDelivered'));
    assert.ok(dialog.textContent.includes('admin.quarantine.releaseTraining'));
    assert.ok(dialog.textContent.includes('admin.quarantine.releaseRawNote'));
    assert.ok(!dialog.textContent.includes('admin.quarantine.releaseEopNote'));
  });

  test('deletes and trains as spam after a confirmation, and writes symbol details out', async () => {
    answers['POST /api/mail-node/quarantine/41/learn-spam'] = { ok: true, learned: false, warnings: ['spam_learn_error already learned'] };
    const host = await mount(React.createElement(MailNodeQuarantine, { admin: true }));
    await click(buttons(host, 'Overdue invoice')[0]);
    const entry = host.querySelector('[data-quarantine-entry="41"]');
    assert.equal(entry.querySelector('[data-symbol="MIME_BAD_EXTENSION"] [data-symbol-details]').textContent, 'exe');
    assert.equal(entry.querySelector('[data-safe-view-body]').getAttribute('tabindex'), '0');
    await click(buttons(entry, 'admin.quarantine.learnSpam')[0]);
    assert.ok(lastDialog().textContent.includes('admin.quarantine.learnSpamMessage'));
    await click(dialogConfirm());
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/quarantine/41/learn-spam'));
    assert.equal(host.querySelector('[data-quarantine-row="41"]'), null);
    assert.ok(host.textContent.includes('admin.quarantine.learnedSpamWarnings'));
  });
});
