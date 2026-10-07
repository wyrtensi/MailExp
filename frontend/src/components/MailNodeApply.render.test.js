// Render tests for applying the node settings (stage 2 of the EOP work): the node result and the
// spam filing rule in the EOP section, the TLS policy fields, each domain's node settings with its
// DKIM record and the confirmed deletion of mailcow's key, and the send limit of each mailbox with the
// panel addresses in the mail node section. The pure rules are covered by utils/mailNode.test.js.
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
const MailNodeSection = (await import('./MailNodeSection.jsx')).default;
const EopSection = (await import('./EopSection.jsx')).default;

const at = '2026-10-01T10:00:00.000Z';
const DKIM = { selector: 'dkim', name: 'dkim._domainkey.ready.example', txt: 'v=DKIM1;k=rsa;t=s;s=email;p=MIIBIjANBg', length: '2048' };
const domainRow = (domain, state, extra = {}) => ({
  domain, active: true, maxMailboxes: 50, mailboxes: 0, onNode: true, state, origin: 'created', addedAt: at,
  addedBy: 'admin@example.com', stateChangedAt: null, steps: {}, nextStep: null, apply: null, ...extra,
});
const READY = domainRow('ready.example', 'ready', {
  apply: {
    at,
    items: [
      { item: 'domain_relayhost', target: 'ready.example', status: 'changed', from: null, to: 3 },
      { item: 'dkim', target: 'ready.example', status: 'ok' },
      { item: 'mailbox_limits', target: 'ready.example', status: 'failed', code: 'mail_node_refused', detail: 'access_denied', counts: { mailboxes: 2, matching: 0, changed: 1, failed: 1, missing: 0 }, mailboxes: ['b@ready.example'] },
    ],
    dkim: DKIM,
  },
});
const TENANT_SIGNS = domainRow('tenant.example', 'dns_ok', {
  nextStep: 'tenant_verified',
  apply: { at, items: [{ item: 'dkim', target: 'tenant.example', status: 'skipped', code: 'dkim_delete_unconfirmed' }], dkim: null },
});
const EOP = {
  eopHost: 'contoso-com.mail.protection.outlook.com', tlsPolicy: 'secure', tlsPolicyParameters: null, certificateHost: 'mail.example.com',
  dkimMode: 'mailcow', sendLimitPerHour: 50, terrl: null, tenantId: null, appId: null, certThumbprint: null,
  tenantConfigured: false, tenantDriverActive: false,
};
const NODE_RESULT = {
  at,
  items: [
    { item: 'tls_policy', target: 'contoso-com.mail.protection.outlook.com', status: 'ok', to: 'secure' },
    { item: 'relayhost', target: 'contoso-com.mail.protection.outlook.com', status: 'ok', to: 3 },
    { item: 'fail2ban', target: null, status: 'skipped', code: 'panel_ips_missing' },
    { item: 'prefilter', target: null, status: 'pending', code: 'prefilter_differs' },
    {
      item: 'forwarding_hosts', target: '2026081400', status: 'skipped', code: 'prefilter_not_applied',
      fwdhosts: { version: '2026081400', wanted: 2, missing: ['40.92.0.0/15', '40.107.0.0/16'], foreign: ['198.51.100.25'], keepSpam: [] },
    },
  ],
};
const LIMIT = { value: 50, frame: 'h' };
const MAILBOXES = [
  { accountId: 'a1', email: 'a@ready.example', onNode: true, active: true, quotaMb: 5120, usedBytes: 0, rateLimit: { value: 9, frame: 'm' }, rateLimitOverride: { value: 9, frame: 'm' }, rateLimitDefault: LIMIT },
  { accountId: 'b1', email: 'b@ready.example', onNode: true, active: true, quotaMb: 5120, usedBytes: 0, rateLimit: null, rateLimitOverride: null, rateLimitDefault: LIMIT },
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
  answers = {
    'GET /api/mail-node/config': { configured: true, mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120, diskPingUrl: '', deleteAfterDays: 5, panelIps: ['203.0.113.10'] },
    'GET /api/mail-node/domains': { domains: [READY, TENANT_SIGNS] },
    'GET /api/mail-node/mailboxes': { disk: { usedPercent: 10, used: '4G', total: '40G', warn: false }, mailboxes: MAILBOXES },
    'GET /api/mail-node/eop': EOP,
    'GET /api/mail-node/apply': { node: NODE_RESULT },
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
  const proto = element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  await React.act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
const items = (root) => [...root.querySelectorAll('[data-apply-item]')].map((li) => [li.getAttribute('data-apply-item'), li.getAttribute('data-apply-status')]);

describe('EopSection — node settings', () => {
  test('shows the node\'s last apply item by item and applies it again on request', async () => {
    const host = await mount(React.createElement(EopSection));
    const block = host.querySelector('[data-node-apply]');
    assert.deepEqual(items(block), [['tls_policy', 'ok'], ['relayhost', 'ok'], ['fail2ban', 'skipped'], ['prefilter', 'pending'], ['forwarding_hosts', 'skipped']]);
    assert.ok(block.textContent.includes('admin.mailNode.applyCodePanelIpsMissing'), 'a skipped item says why');
    // The forwarding hosts wait for the rule and show the ranges missing and the entries left alone.
    const fwd = block.querySelector('[data-apply-item="forwarding_hosts"]');
    assert.ok(fwd.textContent.includes('admin.mailNode.applyCodePrefilterNotApplied'));
    assert.ok(fwd.querySelector('[data-fwdhosts]').textContent.includes('admin.mailNode.fwdhostsRanges'));
    assert.ok(fwd.querySelector('[data-fwdhosts-missing]'));
    assert.ok(fwd.querySelector('[data-fwdhosts-foreign]'));
    assert.equal(fwd.querySelector('[data-fwdhosts-keep-spam]'), null);
    answers['POST /api/mail-node/apply'] = { at, node: NODE_RESULT.items, domains: [] };
    await click(buttons(block, 'admin.mailNode.applyButton')[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/apply'));
    assert.ok(host.textContent.includes('admin.mailNode.applyDone'));
  });

  test('writes the spam filing rule only after the warning about the Dovecot restart', async () => {
    const host = await mount(React.createElement(EopSection));
    const pending = host.querySelector('[data-prefilter-pending]');
    assert.ok(pending.textContent.includes('admin.mailNode.prefilterNote'));
    await click(buttons(pending, 'admin.mailNode.prefilterApply')[0]);
    assert.ok(host.textContent.includes('admin.mailNode.prefilterConfirm'));
    assert.equal(calls.some((c) => c.path === '/api/mail-node/apply/prefilter'), false, 'nothing is written before the confirmation');
    answers['POST /api/mail-node/apply/prefilter'] = {
      item: 'prefilter', target: null, status: 'changed', at, forwardingHosts: { status: 'failed', code: 'fwdhost_keep_spam' },
    };
    answers['GET /api/mail-node/apply'] = {
      node: {
        at,
        items: [
          ...NODE_RESULT.items.slice(0, 3), { item: 'prefilter', target: null, status: 'changed' },
          {
            item: 'forwarding_hosts', target: '2026081400', status: 'failed', code: 'fwdhost_keep_spam', from: null, to: '40.107.0.0/16, 40.92.0.0/15',
            fwdhosts: {
              version: '2026081400', wanted: 2, missing: [], foreign: ['40.92.0.0/15', '40.0.0.0/8'], keepSpam: ['40.0.0.0/8'], filterTurnedOn: ['40.92.0.0/15'],
            },
          },
        ],
      },
    };
    await click(buttons(host, 'admin.mailNode.prefilterApplyConfirm')[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/apply/prefilter'));
    assert.equal(host.querySelector('[data-prefilter-pending]'), null, 'the warning goes once the rule is on the node');
    // The notice says the ranges did not follow, not that they did.
    assert.ok(host.textContent.includes('admin.mailNode.prefilterDoneRangesNot'));
    assert.ok(!host.textContent.includes('admin.mailNode.prefilterDoneWithRanges'));
    // The ranges followed the rule; one listed by someone else with the spam filter off is reported.
    const fwd = host.querySelector('[data-apply-item="forwarding_hosts"]');
    assert.equal(fwd.getAttribute('data-apply-status'), 'failed');
    assert.ok(fwd.textContent.includes('admin.mailNode.applyCodeFwdhostKeepSpam'));
    assert.ok(fwd.querySelector('[data-fwdhosts-keep-spam]'));
    assert.ok(fwd.querySelector('[data-fwdhosts-filter-on]').textContent.includes('admin.mailNode.fwdhostsFilterTurnedOn'));
  });

  test('keeps the TLS policy with its parameters and refuses a fingerprint without one', async () => {
    const host = await mount(React.createElement(EopSection));
    const [policy] = host.querySelectorAll('select');
    await setValue(policy, 'fingerprint');
    assert.ok(host.textContent.includes('admin.eop.errorTlsParameters'));
    assert.equal(buttons(host, 'common.save')[0].disabled, true);
    const parameters = [...host.querySelectorAll('input')].find((input) => input.placeholder === 'admin.eop.tlsParametersPh');
    await setValue(parameters, 'match=AB:CD');
    assert.ok(host.textContent.includes('admin.eop.errorTlsParameters'), 'a fingerprint must be hex pairs');
    await setValue(parameters, 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A');
    assert.equal(buttons(host, 'common.save')[0].disabled, false);
    answers['PUT /api/mail-node/eop'] = {
      ...EOP, tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A', applying: true,
    };
    await click(buttons(host, 'common.save')[0]);
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/mail-node/eop');
    assert.equal(put.body.tlsPolicy, 'fingerprint');
    assert.equal(put.body.tlsPolicyParameters, 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A');
    assert.ok(host.textContent.includes('admin.eop.savedApplying'));
  });

  test('clears the parameters when the policy changes', async () => {
    answers['GET /api/mail-node/eop'] = { ...EOP, tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A' };
    const host = await mount(React.createElement(EopSection));
    const parameters = () => [...host.querySelectorAll('input')].find((input) => input.placeholder === 'admin.eop.tlsParametersPh');
    assert.equal(parameters().value, 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A');
    await setValue(host.querySelectorAll('select')[0], 'secure');
    assert.equal(parameters().value, '');
    assert.equal(buttons(host, 'common.save')[0].disabled, false);
  });
});

describe('MailNodeDomainOnboarding — node settings of a domain', () => {
  test('shows the domain\'s last apply with the DKIM record to publish and applies it again', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    await click(buttons(host, 'admin.mailNode.showDetails')[0]);
    const block = host.querySelector('[data-domain-apply="ready.example"]');
    assert.deepEqual(items(block), [['domain_relayhost', 'changed'], ['dkim', 'ok'], ['mailbox_limits', 'failed']]);
    assert.ok(block.textContent.includes('admin.mailNode.applyFailedMailboxes'));
    const record = block.querySelector('[data-dkim-record="dkim._domainkey.ready.example"]');
    assert.ok(record.textContent.includes('v=DKIM1;k=rsa;t=s;s=email;p=MIIBIjANBg'));
    answers['POST /api/mail-node/domains/ready.example/apply'] = { at, domain: 'ready.example', items: [], dkim: DKIM };
    await click(buttons(block, 'admin.mailNode.applyButton')[0]);
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/api/mail-node/domains/ready.example/apply');
    assert.deepEqual(sent.body, { confirmDkimDelete: false });
  });

  test('deletes mailcow\'s key of a domain the tenant signs only after a confirmation', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    await click(buttons(host, 'admin.mailNode.showDetails')[1]);
    const block = host.querySelector('[data-domain-apply="tenant.example"]');
    const waiting = block.querySelector('[data-dkim-delete-waiting]');
    assert.ok(waiting.textContent.includes('admin.mailNode.dkimDeleteNote'));
    await click(buttons(waiting, 'admin.mailNode.dkimDelete')[0]);
    assert.ok(block.textContent.includes('admin.mailNode.dkimDeleteConfirm'));
    assert.equal(calls.some((c) => c.path.endsWith('/apply')), false);
    answers['POST /api/mail-node/domains/tenant.example/apply'] = { at, domain: 'tenant.example', items: [], dkim: null };
    const confirm = buttons(block, 'admin.mailNode.dkimDelete');
    await click(confirm[confirm.length - 1]);
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/api/mail-node/domains/tenant.example/apply');
    assert.deepEqual(sent.body, { confirmDkimDelete: true });
  });

  test('offers no apply for a domain the node does not list', async () => {
    answers['GET /api/mail-node/domains'] = { domains: [domainRow('gone.example', 'dns_ok', { onNode: false, active: false })] };
    const host = await mount(React.createElement(MailNodeSection));
    await click(buttons(host, 'admin.mailNode.showDetails')[0]);
    const block = host.querySelector('[data-domain-apply="gone.example"]');
    assert.ok(block.textContent.includes('admin.mailNode.applyNever'));
    assert.equal(buttons(block, 'admin.mailNode.applyButton').length, 0);
  });
});

describe('MailNodeSection — send limits and panel addresses', () => {
  test('shows each mailbox\'s limit, sets an administrator\'s one and goes back to the default', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    const states = [...host.querySelectorAll('[data-limit-state]')].map((el) => el.getAttribute('data-limit-state'));
    assert.deepEqual(states, ['own', 'differs']);
    const second = host.querySelector('[data-send-limit="b@ready.example"]');
    assert.ok(second.textContent.includes('admin.mailNode.rateLimitNone'));
    await setValue(second.querySelector('input'), '20');
    await setValue(second.querySelector('select'), 'd');
    answers['PUT /api/mail-node/mailboxes/b1/rate-limit'] = { ok: true, rateLimit: { value: 20, frame: 'd' }, rateLimitOverride: { value: 20, frame: 'd' } };
    await click(buttons(second, 'common.save')[0]);
    assert.deepEqual(calls.find((c) => c.path === '/api/mail-node/mailboxes/b1/rate-limit').body, { value: 20, frame: 'd' });
    assert.ok(host.textContent.includes('admin.mailNode.rateLimitSaved'));
    const first = host.querySelector('[data-send-limit="a@ready.example"]');
    answers['PUT /api/mail-node/mailboxes/a1/rate-limit'] = { ok: true, rateLimit: LIMIT, rateLimitOverride: null };
    await click(buttons(first, 'admin.mailNode.rateLimitUseDefault')[0]);
    assert.deepEqual(calls.find((c) => c.path === '/api/mail-node/mailboxes/a1/rate-limit').body, { value: null });
  });

  test('marks a deactivated mailbox in the mailbox list', async () => {
    answers['GET /api/mail-node/mailboxes'] = {
      disk: { usedPercent: 10, used: '4G', total: '40G', warn: false },
      mailboxes: [{ ...MAILBOXES[0], deactivatedAt: '2026-10-07T10:00:00.000Z' }, { ...MAILBOXES[1], deactivatedAt: null }],
    };
    const host = await mount(React.createElement(MailNodeSection));
    const flagged = [...host.querySelectorAll('[data-mailbox-deactivated]')].map((el) => el.getAttribute('data-mailbox-deactivated'));
    assert.deepEqual(flagged, ['a@ready.example']);
    assert.ok(host.querySelector('[data-mailbox-deactivated]').textContent.includes('admin.accounts.deactivation.badge'));
  });

  test('refuses a bad limit before sending it', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    const second = host.querySelector('[data-send-limit="b@ready.example"]');
    await setValue(second.querySelector('input'), '0');
    assert.equal(buttons(second, 'common.save')[0].disabled, true);
  });

  test('sends the panel addresses with the node settings and refuses a bad one', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    const field = [...host.querySelectorAll('input')].find((input) => input.placeholder === 'admin.mailNode.panelIpsPh');
    assert.equal(field.value, '203.0.113.10');
    await setValue(field, 'everyone');
    assert.ok(host.textContent.includes('admin.mailNode.errorPanelIps'));
    assert.equal(buttons(host, 'admin.mailNode.saveAndCheck')[0].disabled, true);
    await setValue(field, '203.0.113.10, 198.51.100.0/24');
    answers['PUT /api/mail-node/config'] = { ok: true };
    await click(buttons(host, 'admin.mailNode.saveAndCheck')[0]);
    assert.equal(calls.find((c) => c.method === 'PUT' && c.path === '/api/mail-node/config').body.panelIps, '203.0.113.10, 198.51.100.0/24');
  });
});
