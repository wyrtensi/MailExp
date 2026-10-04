// Render tests for the Microsoft tenant part of the EOP section (stage 7a): the certificate with its
// expiry warning, "Test connection" step by step through a queued job, the blocked connectors
// (R-27) and the anti-spam policy with its conflicts (R-28). The pure rules are covered by
// utils/mailNode.test.js.
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
const MailNodeTenant = (await import('./MailNodeTenant.jsx')).default;

const DAY = 86400000;
const CERT = { at: '2026-10-03T08:00:00.000Z', thumbprint: 'A'.repeat(40), subject: 'CN=mailexpert-tenant', notAfter: new Date(Date.now() + 20 * DAY).toISOString() };
const STATE = {
  certificate: CERT,
  connection: {
    at: '2026-10-03T08:00:00.000Z', ok: false,
    steps: {
      certificate: { ok: true, notAfter: CERT.notAfter },
      graph: { ok: true, domains: 2, initialDomain: 'contoso.onmicrosoft.com' },
      exo: { ok: false, code: 'exo_connect_failed', message: 'AADSTS700016' },
    },
  },
  blockedConnectors: {
    at: '2026-10-03T08:10:00.000Z', ok: true,
    items: [{ connectorId: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a', connectorName: 'From mail node', reason: 'Suspicious connector activity', createdTime: null }],
  },
  antispam: {
    at: '2026-10-03T08:00:00.000Z', ok: true,
    policy: { identity: 'Default', SpamAction: 'Quarantine', HighConfidenceSpamAction: 'MoveToJmf', BulkSpamAction: 'MoveToJmf', PhishSpamAction: 'MoveToJmf', HighConfidencePhishAction: 'Quarantine' },
    conflicts: [{ field: 'SpamAction', action: 'Quarantine', expected: ['MoveToJmf', 'AddXHeader'], code: 'quarantined', severity: 'warning' }],
  },
};
const DONE_STATE = {
  ...STATE,
  connection: { ...STATE.connection, ok: true, steps: { ...STATE.connection.steps, exo: { ok: true, organization: 'contoso.onmicrosoft.com', displayName: 'Contoso' } } },
};

let calls;
let answers;
function mockFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = opts.method || 'GET';
    calls.push({ method, path });
    const answer = answers[`${method} ${path}`];
    const value = typeof answer === 'function' ? answer(opts) : answer;
    if (value?.status >= 400) return { ok: false, status: value.status, json: async () => value.body };
    return { ok: true, status: 200, json: async () => value ?? {} };
  };
}

beforeEach(() => {
  calls = [];
  answers = { 'GET /api/mail-node/tenant': { driver: 'worker', configured: true, state: STATE, jobs: { test: null, antispam: null, poll: null } } };
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

describe('MailNodeTenant — the anti-spam actions MailExpert sets (section 5.14)', () => {
  test('shows what it set, and what it could not with the reason', async () => {
    answers['GET /api/mail-node/tenant/phish-release'] = { enabled: true, releases: [], held: { count: 0 } };
    answers['GET /api/mail-node/tenant'] = {
      driver: 'worker', configured: true, jobs: {},
      state: {
        ...STATE,
        antispam: {
          ...STATE.antispam,
          enforcement: {
            at: '2026-10-03T08:00:00.000Z', ok: false, changed: [{ field: 'HighConfidenceSpamAction', from: 'Quarantine', to: 'MoveToJmf' }],
            failed: ['SpamAction'], error: { code: 'antispam_not_written', message: 'still Quarantine' },
          },
        },
      },
    };
    const root = await mount(React.createElement(MailNodeTenant));
    assert.match(root.querySelector('[data-policy-enforced]').textContent, /admin\.tenant\.policyEnforced/);
    const failed = root.querySelector('[data-policy-not-enforced]');
    assert.match(failed.textContent, /admin\.tenant\.policyNotEnforced/);
    assert.match(failed.textContent, /admin\.tenant\.failAntispamNotWritten/);
  });
});

describe('MailNodeTenant — the policy and the spam rule of the node (section 5.14)', () => {
  const FITTING = { ...STATE, antispam: { ...STATE.antispam, conflicts: [] } };
  const fits = async (extra) => {
    answers['GET /api/mail-node/tenant'] = { driver: 'worker', configured: false, state: FITTING, jobs: {}, ...extra };
    const root = await mount(React.createElement(MailNodeTenant));
    const line = root.querySelector('[data-policy-fits]');
    return { state: line.getAttribute('data-policy-fits'), text: line.textContent };
  };

  test('says the actions fit only when the node holds the rule', async () => {
    assert.deepEqual(await fits({ spamRule: { at: '2026-10-05T08:00:00.000Z', state: 'ok' } }), { state: 'ok', text: 'admin.tenant.policyFits' });
    assert.deepEqual(await fits({}), { state: 'policy', text: 'admin.tenant.policyFits' });
  });

  test('says the rule is missing, outdated, unread or never read instead of that they fit', async () => {
    assert.deepEqual(await fits({ spamRule: { state: 'missing' } }), { state: 'missing', text: 'admin.tenant.policyFitsRuleMissing' });
    assert.deepEqual(await fits({ spamRule: { state: 'outdated' } }), { state: 'outdated', text: 'admin.tenant.policyFitsRuleOutdated' });
    assert.deepEqual(await fits({ spamRule: { state: 'unknown', code: 'mail_node_unreachable' } }), { state: 'unknown', text: 'admin.tenant.policyFitsRuleUnreadable' });
    assert.deepEqual(await fits({ spamRule: null }), { state: 'never', text: 'admin.tenant.policyFitsRuleUnknown' });
  });

  test('the policy and the release read the same rule: both wait while it is missing', async () => {
    answers['GET /api/mail-node/tenant'] = { driver: 'worker', configured: true, state: FITTING, jobs: {}, spamRule: { state: 'missing' } };
    answers['GET /api/mail-node/tenant/phish-release'] = {
      enabled: true, releases: [], held: { count: 0 },
      // The last run still saw the rule in place; the server's newer read says it is gone.
      run: { at: '2026-10-05T08:00:00.000Z', ok: true, counts: { released: 0, skipped: 0, failed: 0, ruleWaiting: 2 }, left: false, rule: { state: 'ok' } },
    };
    const root = await mount(React.createElement(MailNodeTenant));
    assert.equal(root.querySelector('[data-policy-fits]').getAttribute('data-policy-fits'), 'missing');
    assert.equal(root.querySelector('[data-phish-rule-waiting]').getAttribute('data-phish-rule-waiting'), 'missing');
  });
});

describe('MailNodeTenant — the phishing release (R-42, stage 7c)', () => {
  const QID = ['c14401cf-aa9a-465b-cfd5-08d0f0ca37c5', '4c2ca98e-94ea-db3a-7eb8-3b63657d4db7'].join('\\');
  const RELEASE = {
    enabled: true, changedAt: null,
    run: { at: '2026-10-03T08:00:00.000Z', ok: true, counts: { released: 1, skipped: 1, failed: 0 }, left: false },
    held: { count: 1, soonestExpiresAt: null },
    releases: [
      { identity: QID, type: 'Spam', state: 'released', reason: null, sender: 'billing@phish.example.net', recipients: ['info@example.com'], subject: 'Invoice', receivedAt: '2026-10-03T07:40:00.000Z' },
      { identity: `${QID}x`, type: 'Malware', state: 'skipped', reason: 'foreign_recipients', sender: 'x@phish.example.net', recipients: ['info@example.com', 'a@other.example.org'], subject: 'Reset', receivedAt: null },
      {
        identity: `${QID}y`, state: 'failed', reason: 'read_failed', error: 'exo_failed: Something went wrong', errorCode: 'exo_failed',
        sender: null, recipients: [], subject: null, receivedAt: null,
      },
    ],
    job: null,
  };

  test('shows the last run, the rows with their reason and what stays held; pauses and runs now', async () => {
    answers['GET /api/mail-node/tenant/phish-release'] = RELEASE;
    answers['PUT /api/mail-node/tenant/phish-release'] = (opts) => ({ enabled: JSON.parse(opts.body).enabled, changedAt: '2026-10-03T09:00:00.000Z' });
    answers['POST /api/mail-node/tenant/phish-release/run'] = { job: { id: '77', kind: 'tenant_quarantine_release', status: 'done' }, created: true };
    const root = await mount(React.createElement(MailNodeTenant));
    assert.match(root.querySelector('[data-phish-run]').textContent, /admin\.tenant\.phishRunCounts/);
    assert.match(root.querySelector('[data-phish-held]').textContent, /admin\.tenant\.phishHeld/);
    const rows = [...root.querySelectorAll('[data-phish-row]')];
    assert.deepEqual(rows.map((r) => r.getAttribute('data-phish-row')), ['released', 'skipped', 'failed']);
    // EXO's words are a detail under a translated reason, not the message itself.
    const failure = rows[2].querySelector('[data-phish-error]');
    assert.equal(failure.getAttribute('data-phish-error'), 'exo_failed');
    assert.ok(failure.textContent.startsWith('admin.tenant.failExo'));
    assert.match(rows[2].textContent, /admin\.tenant\.phishReasonReadFailed/);
    assert.match(rows[1].textContent, /admin\.tenant\.phishReasonForeign/);
    assert.equal(rows[1].getAttribute('data-phish-held-row'), 'true');
    assert.match(rows[1].textContent, /a@other\.example\.org/);
    // Section 5.14: the type, in words for the four the panel releases, as EOP wrote it otherwise.
    const types = rows.map((r) => r.querySelector('[data-phish-type]').textContent);
    assert.deepEqual(types, ['admin.tenant.qtypeSpam', 'Malware', '—']);

    await click(buttons(root, 'admin.tenant.phishRunNow')[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/tenant/phish-release/run'));

    answers['GET /api/mail-node/tenant/phish-release'] = { ...RELEASE, enabled: false };
    const box = root.querySelector('[data-phish-release] input[type="checkbox"]');
    await React.act(async () => { box.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush();
    assert.ok(calls.some((c) => c.method === 'PUT' && c.path === '/api/mail-node/tenant/phish-release'));
    assert.match(root.querySelector('[data-phish-paused]').textContent, /admin\.tenant\.phishPaused/);
    assert.equal(buttons(root, 'admin.tenant.phishRunNow')[0].disabled, true);
  });

  test('says spam, phishing and bulk wait for the node\'s spam rule (section 5.14)', async () => {
    answers['GET /api/mail-node/tenant/phish-release'] = {
      ...RELEASE, run: { ...RELEASE.run, counts: { ...RELEASE.run.counts, ruleWaiting: 4 }, rule: { state: 'outdated' } },
    };
    const root = await mount(React.createElement(MailNodeTenant));
    const box = root.querySelector('[data-phish-rule-waiting]');
    assert.equal(box.getAttribute('data-phish-rule-waiting'), 'outdated');
    assert.match(box.textContent, /admin\.tenant\.phishRuleWaiting/);
    answers['GET /api/mail-node/tenant/phish-release'] = { ...RELEASE, run: { ...RELEASE.run, rule: { state: 'ok' } } };
    const again = await mount(React.createElement(MailNodeTenant));
    assert.equal(again.querySelector('[data-phish-rule-waiting]'), null);
  });

  // React.StrictMode (main.jsx, every dev build and the demo) mounts, unmounts and mounts again: a
  // load must still land after the second mount, not be dropped as if the section had gone.
  test('shows the switch, the last run and the rows under StrictMode', async () => {
    answers['GET /api/mail-node/tenant/phish-release'] = RELEASE;
    const root = await mount(React.createElement(React.StrictMode, null, React.createElement(MailNodeTenant)));
    assert.ok(root.querySelector('[data-phish-release] input[type="checkbox"]'));
    assert.match(root.querySelector('[data-phish-run]').textContent, /admin\.tenant\.phishRunCounts/);
    assert.equal(root.querySelectorAll('[data-phish-row]').length, 3);
    assert.equal(buttons(root, 'admin.tenant.phishRunNow').length, 1);
  });

  test('is not shown without a driver or a configured tenant', async () => {
    answers['GET /api/mail-node/tenant'] = { driver: 'worker', configured: false, state: {}, jobs: {} };
    const root = await mount(React.createElement(MailNodeTenant));
    assert.equal(root.querySelector('[data-phish-release]'), null);
    assert.ok(!calls.some((c) => c.path.includes('/phish-release')));
  });
});

describe('MailNodeTenant — the connectors (R-25, stage 7b)', () => {
  const connectors = { at: '2026-10-03T08:10:00.000Z', ok: true, inbound: [{ name: 'From mail node', properties: {} }], outbound: [{ name: 'To mail node', properties: {} }] };
  test('shows what changed since the reference and takes the connectors as the reference again', async () => {
    answers['GET /api/mail-node/tenant'] = {
      driver: 'worker', configured: true, jobs: {},
      state: { ...STATE, connectors, connectorReference: { at: '2026-10-01T08:00:00.000Z', auto: true } },
      connectorDrift: [{ direction: 'outbound', name: 'To mail node', kind: 'changed', changes: [{ property: 'TlsSettings', was: 'domainvalidation', now: 'encryptiononly' }] }],
    };
    answers['POST /api/mail-node/tenant/connectors/reference'] = { reference: { at: '2026-10-03T09:00:00.000Z', auto: false } };
    const root = await mount(React.createElement(MailNodeTenant));
    assert.match(root.querySelector('[data-tenant-connectors]').textContent, /From mail node, To mail node/);
    assert.match(root.querySelector('[data-tenant-drift]').textContent, /TlsSettings: "domainvalidation" → "encryptiononly"/);
    await click(buttons(root, 'admin.tenant.referenceTake')[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/tenant/connectors/reference'));
  });
});

describe('MailNodeTenant', () => {
  test('shows the certificate with its warning, the steps, the blocked connector and the policy conflict', async () => {
    const root = await mount(React.createElement(MailNodeTenant));
    assert.match(root.querySelector('[data-tenant-certificate]').textContent, /AAAAAAAAAA/);
    assert.equal(root.querySelector('[data-tenant-cert-warning]').getAttribute('data-tenant-cert-warning'), 'warning');
    assert.match(root.querySelector('[data-tenant-step="graph"]').textContent, /admin\.tenant\.stepGraphOk/);
    assert.match(root.querySelector('[data-tenant-step="exo"]').textContent, /admin\.tenant\.failExoConnect.*AADSTS700016/);
    assert.match(root.querySelector('[data-tenant-blocked]').textContent, /From mail node/);
    assert.match(root.querySelector('[data-tenant-blocked]').textContent, /admin\.tenant\.blockedRemoveHint/);
    assert.match(root.querySelector('[data-policy-conflict="SpamAction"]').textContent, /admin\.tenant\.conflictQuarantined/);
    assert.equal(root.querySelectorAll('[data-policy-field]').length, 5);
  });

  test('"Test connection" queues a job, follows it and shows the new result', async () => {
    answers['POST /api/mail-node/tenant/test'] = { job: { id: '42', kind: 'tenant_test_connection', status: 'queued' }, created: true };
    answers['GET /api/mail-node/tenant/jobs/42'] = { job: { id: '42', kind: 'tenant_test_connection', status: 'done' } };
    const root = await mount(React.createElement(MailNodeTenant));
    answers['GET /api/mail-node/tenant'] = { driver: 'worker', configured: true, state: DONE_STATE, jobs: { test: { id: '42', status: 'done' } } };
    await click(buttons(root, 'admin.tenant.testButton')[0]);
    assert.equal(buttons(root, 'admin.tenant.testRunning').length, 1);
    await React.act(async () => { await new Promise((r) => setTimeout(r, 1700)); });
    await flush();
    // The phishing release (stage 7c) reads its own part once; the button asks only for its job.
    assert.deepEqual(calls.filter((c) => c.path.includes('/tenant/') && !c.path.includes('/phish-release')).map((c) => `${c.method} ${c.path}`), [
      'POST /api/mail-node/tenant/test', 'GET /api/mail-node/tenant/jobs/42',
    ]);
    assert.match(root.querySelector('[data-tenant-connection]').textContent, /admin\.tenant\.connectionOk/);
    assert.match(root.querySelector('[data-tenant-step="exo"]').textContent, /admin\.tenant\.stepExoOk/);
  });

  test('without a driver the buttons are off and the section says why', async () => {
    answers['GET /api/mail-node/tenant'] = { driver: null, configured: true, state: {}, jobs: {} };
    const root = await mount(React.createElement(MailNodeTenant));
    assert.match(root.textContent, /admin\.tenant\.noDriver/);
    assert.equal(buttons(root, 'admin.tenant.testButton')[0].disabled, true);
    assert.equal(buttons(root, 'admin.tenant.checkNow')[0].disabled, true);
    assert.match(root.textContent, /admin\.tenant\.certificateUnknown/);
    assert.match(root.textContent, /admin\.tenant\.connectionNever/);
    assert.equal(root.querySelector('[data-tenant-profile-warning]'), null);
  });

  test('the worker profile on without a driver is told', async () => {
    answers['GET /api/mail-node/tenant'] = { driver: null, profileWithoutDriver: true, configured: true, state: {}, jobs: {} };
    const root = await mount(React.createElement(MailNodeTenant));
    assert.match(root.querySelector('[data-tenant-profile-warning]').textContent, /admin\.tenant\.profileWithoutDriver/);
  });

  test('a refusal of a button is shown', async () => {
    answers['POST /api/mail-node/tenant/antispam'] = { status: 409, body: { error: 'x', code: 'tenant_not_configured' } };
    const root = await mount(React.createElement(MailNodeTenant));
    await click(buttons(root, 'admin.tenant.policyRefresh')[0]);
    const alerts = [...root.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    assert.ok(alerts.includes('admin.tenant.errorNotConfigured'));
  });
});
