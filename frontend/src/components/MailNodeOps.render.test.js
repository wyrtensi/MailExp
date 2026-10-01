// Render tests for the node operations (stage 4a of the EOP work): the alerts with their settings
// (R-18, R-19), the mail queue with its actions (R-16) and the TERRL budget in the EOP section
// (R-21). The pure rules are covered by utils/mailNode.test.js.
//
// The harness is the one of MailNodeOnboarding.render.test.js: sucrase for .jsx, react-i18next
// stubbed to return the raw key.

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
const MailNodeOpsSection = (await import('./MailNodeOpsSection.jsx')).default;
const EopSection = (await import('./EopSection.jsx')).default;

const at = '2026-10-01T19:21:42.933Z';
const DEFERRED = {
  queueId: '53A99193F13', queue: 'deferred', arrivedAt: '2026-10-01T19:02:59.000Z', ageSeconds: 600, size: 360, forcedExpire: false,
  sender: 'someone@stage.test',
  recipients: [{ address: 'test@example.com', reason: 'host eop.test.local[172.22.1.13] said: 451 4.7.500 Server busy. (S77) (in reply to RCPT TO command)' }],
};
const HELD = { ...DEFERRED, queueId: '1A2B3C4D5E', queue: 'hold', ageSeconds: 7200, sender: '', recipients: [{ address: 'x@example.org', reason: null }] };
const QUEUE = { items: [HELD, DEFERRED], counts: { active: 0, deferred: 1, hold: 1, incoming: 0, maildrop: 0 }, total: 2, oldestDeferredSeconds: 600 };
const STATE = {
  at, trigger: 'schedule', errors: [{ source: 'containers', code: 'mail_node_unreachable', message: 'unreachable' }],
  alerts: [
    {
      key: 'connector_blocked', severity: 'error', since: at, seenAt: at,
      details: { count: 2, lastAt: '2026-10-01T19:21:37.000Z', samples: [{ at: '2026-10-01T19:21:37.000Z', queueId: 'B053B1A23BF', to: 'test@example.com', relay: 'eop.test.local[172.22.1.13]:25', dsn: '5.7.711' }] },
    },
    { key: 'eop_bypass', severity: 'error', since: at, seenAt: at, details: { count: 1, lastAt: at, relays: ['172.22.1.13'], eopHostSet: true, samples: [] } },
  ],
};
const SETTINGS = { pingUrl: null, deferredCount: 20, deferredMinutes: 60 };
const MESSAGE = {
  queueId: '53A99193F13', queue: 'deferred', envelope: { sender: 'someone@stage.test', recipients: ['test@example.com'], arrival: 'Thu Oct  1 19:02:59 2026' },
  headers: [{ name: 'Received', value: 'by mail.test.local' }, { name: 'Received', value: 'by panel' }, { name: 'Subject', value: 'hello' }],
  bodyBytes: 26, body: null, bodyTruncated: false,
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
    'GET /api/mail-node/alerts': { state: STATE, settings: SETTINGS, defaults: SETTINGS },
    'GET /api/mail-node/queue': QUEUE,
    'GET /api/mail-node/queue/53A99193F13': MESSAGE,
    'GET /api/mail-node/queue/53A99193F13?body=1': { ...MESSAGE, body: 'Sent by stage.sh eop send.' },
    'POST /api/mail-node/queue/53A99193F13/deliver': { ok: true, action: 'deliver', queueId: '53A99193F13' },
    'POST /api/mail-node/queue/53A99193F13/delete': { ok: true, action: 'delete', queueId: '53A99193F13' },
    'POST /api/mail-node/queue/1A2B3C4D5E/unhold': { ok: true, action: 'unhold', queueId: '1A2B3C4D5E' },
    'POST /api/mail-node/queue/flush': { ok: true, action: 'flush' },
    'POST /api/mail-node/alerts/check': { state: { ...STATE, errors: [], alerts: [] } },
    'PUT /api/mail-node/alerts/settings': (opts) => ({ settings: { ...SETTINGS, ...JSON.parse(opts.body) } }),
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

describe('MailNodeOpsSection alerts', () => {
  test('shows each alert with its detail and samples, and a source that could not be read', async () => {
    const root = await mount(React.createElement(MailNodeOpsSection));
    const alerts = [...root.querySelectorAll('[data-alert]')].map((li) => [li.getAttribute('data-alert'), li.getAttribute('data-severity')]);
    assert.deepEqual(alerts, [['connector_blocked', 'error'], ['eop_bypass', 'error']]);
    const first = root.querySelector('[data-alert="connector_blocked"]');
    assert.match(first.textContent, /admin\.nodeOps\.alertConnectorBlocked/);
    assert.match(first.textContent, /admin\.nodeOps\.alertDetailRefusals/);
    assert.match(first.textContent, /B053B1A23BF/);
    assert.match(root.querySelector('[data-alert="eop_bypass"]').textContent, /admin\.nodeOps\.alertDetailBypass/);
    assert.ok(root.querySelector('[data-alert-error="containers"]'));
  });

  test('"Check now" shows the new state', async () => {
    const root = await mount(React.createElement(MailNodeOpsSection));
    await click(buttons(root, 'admin.nodeOps.checkNow')[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/alerts/check'));
    assert.equal(root.querySelectorAll('[data-alert]').length, 0);
    assert.ok(root.querySelector('[data-alerts-none]'));
    assert.equal(root.querySelector('[data-alert-error]'), null);
  });

  test('saves the alert settings and refuses a ping URL that is not https', async () => {
    const root = await mount(React.createElement(MailNodeOpsSection));
    const [ping, count, minutes] = root.querySelectorAll('[data-node-alerts] input');
    await setValue(ping, 'http://hc.example.com/p');
    const save = buttons(root, 'common.save')[0];
    assert.equal(save.disabled, true);
    await setValue(ping, 'https://hc.example.com/p/alerts');
    await setValue(count, '5');
    await setValue(minutes, '30');
    await click(save);
    const put = calls.find((c) => c.method === 'PUT');
    assert.deepEqual(put.body, { pingUrl: 'https://hc.example.com/p/alerts', deferredCount: 5, deferredMinutes: 30 });
  });
});

describe('MailNodeOpsSection queue', () => {
  test('lists the queue with the reason a message waits, and the actions by its queue', async () => {
    const root = await mount(React.createElement(MailNodeOpsSection));
    const rows = [...root.querySelectorAll('[data-queue-item]')].map((tr) => [tr.getAttribute('data-queue-item'), tr.getAttribute('data-queue')]);
    assert.deepEqual(rows, [['1A2B3C4D5E', 'hold'], ['53A99193F13', 'deferred']]);
    assert.match(root.querySelector('[data-queue-reason]').textContent, /451 4\.7\.500/);
    const actions = (id) => [...root.querySelectorAll(`[data-queue-item="${id}"] [data-queue-action]`)].map((b) => b.getAttribute('data-queue-action'));
    assert.deepEqual(actions('1A2B3C4D5E'), ['unhold', 'delete']);
    assert.deepEqual(actions('53A99193F13'), ['hold', 'deliver', 'delete']);
    assert.match(root.querySelector('[data-queue-item="1A2B3C4D5E"]').textContent, /admin\.nodeOps\.nullSender/);
  });

  test('shows the headers without the body until asked', async () => {
    const root = await mount(React.createElement(MailNodeOpsSection));
    await click(root.querySelector('[data-queue-item="53A99193F13"] button[aria-expanded]'));
    const details = root.querySelector('[data-queue-details="53A99193F13"]');
    assert.deepEqual([...details.querySelectorAll('[data-header]')].map((li) => li.getAttribute('data-header')), ['Received', 'Received', 'Subject']);
    assert.equal(details.querySelector('[data-queue-body]'), null);
    await click(buttons(details, 'admin.nodeOps.showBody')[0]);
    assert.equal(root.querySelector('[data-queue-body]').textContent, 'Sent by stage.sh eop send.');
    assert.ok(calls.some((c) => c.path === '/api/mail-node/queue/53A99193F13?body=1'));
  });

  test('tries a message again, releases a held one and retries all', async () => {
    const root = await mount(React.createElement(MailNodeOpsSection));
    await click(root.querySelector('[data-queue-item="53A99193F13"] [data-queue-action="deliver"]'));
    await click(root.querySelector('[data-queue-item="1A2B3C4D5E"] [data-queue-action="unhold"]'));
    await click(buttons(root, 'admin.nodeOps.flush')[0]);
    const posts = calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]);
    assert.deepEqual(posts, [
      ['/api/mail-node/queue/53A99193F13/deliver', undefined],
      ['/api/mail-node/queue/1A2B3C4D5E/unhold', undefined],
      ['/api/mail-node/queue/flush', undefined],
    ]);
  });

  test('deletes only after the confirmation, with confirm: true', async () => {
    const root = await mount(React.createElement(MailNodeOpsSection));
    await click(root.querySelector('[data-queue-item="53A99193F13"] [data-queue-action="delete"]'));
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    const dialog = root.querySelector('[data-delete-confirm]');
    assert.ok(dialog);
    await click(buttons(dialog, 'common.cancel')[0]);
    assert.equal(root.querySelector('[data-delete-confirm]'), null);
    await click(root.querySelector('[data-queue-item="53A99193F13"] [data-queue-action="delete"]'));
    await click(buttons(root.querySelector('[data-delete-confirm]'), 'admin.nodeOps.deleteConfirmButton')[0]);
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]), [['/api/mail-node/queue/53A99193F13/delete', { confirm: true }]]);
  });

  test('shows why the queue could not be read', async () => {
    answers['GET /api/mail-node/queue'] = { status: 502, body: { error: 'The mail node is unreachable', code: 'mail_node_unreachable' } };
    const root = await mount(React.createElement(MailNodeOpsSection));
    assert.match(root.querySelector('[data-queue-error]').textContent, /admin\.mailNode\.errorUnreachable/);
  });
});

describe('EopSection TERRL budget', () => {
  const EOP = {
    eopHost: null, tlsPolicy: 'secure', tlsPolicyParameters: null, certificateHost: null, dkimMode: 'mailcow', sendLimitPerHour: 50,
    terrl: null, licenses: 500, tenantCreatedOn: '2026-09-20', tenantId: null, appId: null, certThumbprint: null, nodeIp: null,
    tenantConfigured: false, tenantDriverActive: true,
  };
  const BUDGET = {
    fullLimit: 48248, limitFrom: 'licenses', ageDays: 11, rampPercent: 10, limit: 4825, used: 4000, percent: 82, warn: true, exceeded: false,
    windowStart: at, log: { read: true, covered: false, oldestAt: '2026-10-01T10:00:00.000Z' },
  };

  test('shows the budget with its ramp and warns at 80 percent', async () => {
    answers['GET /api/mail-node/eop'] = EOP;
    answers['GET /api/mail-node/apply'] = { node: null };
    answers['GET /api/mail-node/eop/budget'] = BUDGET;
    const root = await mount(React.createElement(EopSection));
    const budget = root.querySelector('[data-terrl-budget]');
    assert.equal(budget.getAttribute('data-terrl-level'), 'warn');
    assert.match(budget.textContent, /admin\.eop\.budgetUsed/);
    assert.match(budget.textContent, /admin\.eop\.budgetRamp/);
    assert.match(budget.textContent, /admin\.eop\.budgetLogPartial/);
    assert.ok(budget.querySelector('[role="alert"]'));
  });

  test('sends the licenses and the creation date with the settings', async () => {
    answers['GET /api/mail-node/eop'] = EOP;
    answers['GET /api/mail-node/apply'] = { node: null };
    answers['GET /api/mail-node/eop/budget'] = { ...BUDGET, warn: false, percent: 10, used: 482 };
    answers['PUT /api/mail-node/eop'] = (opts) => ({ ...EOP, ...JSON.parse(opts.body) });
    const root = await mount(React.createElement(EopSection));
    assert.equal(root.querySelector('[data-terrl-budget]').getAttribute('data-terrl-level'), 'ok');
    const date = root.querySelector('input[type="date"]');
    assert.equal(date.value, '2026-09-20');
    await setValue(date, '2026-08-01');
    await click(buttons(root, 'common.save')[0]);
    const put = calls.find((c) => c.method === 'PUT');
    assert.equal(put.body.licenses, '500');
    assert.equal(put.body.tenantCreatedOn, '2026-08-01');
    assert.ok(calls.filter((c) => c.path === '/api/mail-node/eop/budget').length >= 2);
  });
});
