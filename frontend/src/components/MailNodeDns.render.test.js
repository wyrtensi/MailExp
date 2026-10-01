// Render tests for the DNS checks (stage 3 of the EOP work, R-14 and R-15): the domain's DNS block
// with each check, the record to publish and "Check now"; the values a domain must publish; the
// latest result next to the "DNS is right" step, whose "Done" stays a person's confirmation; the
// node's name and certificate with "Check now"; the badge of a ready domain with DNS errors and the
// summary in the section title. The pure rules are covered by utils/mailNode.test.js.
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
const MailNodeDomainOnboarding = (await import('./MailNodeDomainOnboarding.jsx')).default;

const at = '2026-10-01T10:00:00.000Z';
const MX = 'ready-example.mail.protection.outlook.com';
const check = (name, status, fields = {}) => ({ check: name, status, code: null, found: [], expected: null, records: [], ...fields });
const ERROR_DNS = {
  at, overall: 'error', trigger: 'schedule',
  checks: [
    check('mx', 'error', {
      code: 'mx_extra', found: [MX, 'mail.other.test'], expected: [MX], records: [{ type: 'MX', name: 'ready.example', value: `0 ${MX}` }],
    }),
    check('spf', 'ok', { records: [{ type: 'TXT', name: 'ready.example', value: 'v=spf1 include:spf.protection.outlook.com -all' }] }),
    check('tenant_txt', 'warning', { code: 'tenant_txt_expected_missing', found: ['MS=ms1'] }),
  ],
};
const OK_DNS = { at, overall: 'ok', trigger: 'manual', checks: [check('mx', 'ok')] };
const EXPECTED = { mx: [MX], tenantTxt: null, dkimSelector1Cname: null, dkimSelector2Cname: null };
const domainRow = (domain, state, extra = {}) => ({
  domain, active: true, maxMailboxes: 50, mailboxes: 0, onNode: true, state, origin: 'created', addedAt: at,
  addedBy: 'admin@example.com', stateChangedAt: null, steps: {}, nextStep: null, apply: null, dns: null, expected: EXPECTED, ...extra,
});
const READY = domainRow('ready.example', 'ready', { dns: ERROR_DNS });
const PENDING_ERRORS = domainRow('pending.example', 'node_configured', { nextStep: 'dns_ok', dns: { ...ERROR_DNS } });
const NODE_DNS = {
  at, overall: 'error', trigger: 'schedule',
  checks: [
    check('node_a', 'ok'), check('node_ptr', 'ok'),
    check('node_aaaa', 'warning', { code: 'aaaa_present', found: ['2001:db8::10'] }),
    check('cert_chain', 'error', { code: 'cert_chain_incomplete', detail: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
  ],
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
    'GET /api/mail-node/config': { configured: true, mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120, diskPingUrl: '', deleteAfterDays: 5, panelIps: [] },
    'GET /api/mail-node/domains': { domains: [PENDING_ERRORS, READY] },
    'GET /api/mail-node/mailboxes': { disk: { usedPercent: 10, used: '4G', total: '40G', warn: false }, mailboxes: [] },
    'GET /api/mail-node/dns-check': { node: NODE_DNS },
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
const checks = (root) => [...root.querySelectorAll('[data-dns-check]')].map((li) => [li.getAttribute('data-dns-check'), li.getAttribute('data-dns-status')]);

describe('MailNodeDomainOnboarding — DNS of the domain', () => {
  test('copies a record, says so to screen readers, and says so when copying fails', async () => {
    const host = await mount(React.createElement(MailNodeDomainOnboarding, { domain: READY, onChanged: () => {} }));
    const button = host.querySelector('[data-dns-record] button');
    assert.equal(button.getAttribute('aria-live'), 'polite');
    let copied = null;
    const clipboard = (writeText) => Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText } } });
    clipboard(async (value) => { copied = value; });
    await click(button);
    assert.equal(copied, `0 ${MX}`);
    assert.equal(button.getAttribute('data-copy-state'), 'copied');
    clipboard(async () => { throw new Error('denied'); });
    await click(button);
    assert.equal(button.getAttribute('data-copy-state'), 'failed');
    assert.equal(button.textContent, 'admin.mailNode.copyFailed');
  });

  test('shows each check with why, the record to publish for a check that is not ok, and checks again on request', async () => {
    let changed = 0;
    const host = await mount(React.createElement(MailNodeDomainOnboarding, { domain: READY, onChanged: () => { changed += 1; } }));
    const block = host.querySelector('[data-domain-dns="ready.example"]');
    assert.deepEqual(checks(block), [['mx', 'error'], ['spf', 'ok'], ['tenant_txt', 'warning']]);
    assert.ok(block.textContent.includes('admin.mailNode.dnsCodeMxExtra'));
    assert.ok(block.textContent.includes('admin.mailNode.dnsCodeTenantTxtExpectedMissing'));
    const records = [...block.querySelectorAll('[data-dns-record]')].map((el) => el.getAttribute('data-dns-record'));
    assert.deepEqual(records, ['MX ready.example'], 'only a check that is not ok offers a record');
    assert.ok(block.querySelector('[data-dns-record] code').textContent.includes(`0 ${MX}`));
    answers['POST /api/mail-node/domains/ready.example/dns-check'] = { domain: 'ready.example', ...OK_DNS };
    await click(buttons(block, 'admin.mailNode.dnsCheckNow')[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/domains/ready.example/dns-check'));
    assert.equal(changed, 1, 'the lists reload with the new result');
  });

  test('says when it was never checked', async () => {
    const host = await mount(React.createElement(MailNodeDomainOnboarding, { domain: domainRow('new.example', 'node_created', { nextStep: 'node_configured' }) }));
    assert.ok(host.querySelector('[data-domain-dns]').textContent.includes('admin.mailNode.dnsNever'));
  });

  test('shows the latest result next to "DNS is right" and keeps its "Done" a person\'s confirmation', async () => {
    const host = await mount(React.createElement(MailNodeDomainOnboarding, { domain: PENDING_ERRORS }));
    const step = host.querySelector('[data-step="dns_ok"]');
    assert.equal(step.getAttribute('data-status'), 'next');
    assert.equal(step.querySelector('[data-dns-verdict]').getAttribute('data-dns-verdict'), 'error');
    assert.ok(step.textContent.includes('admin.mailNode.dnsVerdictError'));
    const done = buttons(step, 'admin.mailNode.stepDone')[0];
    assert.equal(done.disabled, false, 'DNS errors only warn: the step can still be confirmed');
    answers['POST /api/mail-node/domains/pending.example/steps/dns_ok'] = { ok: true, domain: 'pending.example', state: 'dns_ok' };
    await click(done);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/domains/pending.example/steps/dns_ok'));
    const passing = await mount(React.createElement(MailNodeDomainOnboarding, { domain: { ...PENDING_ERRORS, dns: OK_DNS } }));
    assert.ok(passing.querySelector('[data-step="dns_ok"]').textContent.includes('admin.mailNode.dnsVerdictOk'));
    const unchecked = await mount(React.createElement(MailNodeDomainOnboarding, { domain: { ...PENDING_ERRORS, dns: null } }));
    assert.equal(unchecked.querySelector('[data-dns-verdict]').getAttribute('data-dns-verdict'), 'none');
  });

  test('edits the values the domain must publish, refusing what the server would refuse', async () => {
    const host = await mount(React.createElement(MailNodeDomainOnboarding, { domain: READY, onChanged: () => {} }));
    await click(buttons(host, 'admin.mailNode.dnsExpectedEdit')[0]);
    const form = host.querySelector('[data-dns-expected-form]');
    const inputs = [...form.querySelectorAll('input')];
    assert.equal(inputs[0].value, MX, 'the form starts from the stored values');
    await setValue(inputs[0], 'not a host');
    assert.ok(form.textContent.includes('admin.mailNode.errorExpectedMx'));
    assert.equal(buttons(form, 'common.save')[0].disabled, true);
    await setValue(inputs[0], `${MX}, ready-example.mx.microsoft`);
    await setValue(inputs[1], 'MS=ms12345678');
    // The selector targets EOP really gives hold "_" in their labels.
    await setValue(inputs[2], 'selector1-ready-example._domainkey.contoso.n-v1.dkim.mail.microsoft');
    assert.equal(buttons(form, 'common.save')[0].disabled, false);
    await setValue(inputs[3], 'selector2_bad');
    assert.ok(form.textContent.includes('admin.mailNode.errorDkimCname'));
    await setValue(inputs[3], 'selector2-ready-example._domainkey.contoso.n-v1.dkim.mail.microsoft');
    answers['PUT /api/mail-node/domains/ready.example/dns-expected'] = { ok: true, domain: 'ready.example', fields: ['mx', 'tenantTxt'], dns: OK_DNS };
    await click(buttons(form, 'common.save')[0]);
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/mail-node/domains/ready.example/dns-expected');
    assert.deepEqual(put.body, {
      expectedMx: `${MX}, ready-example.mx.microsoft`, tenantTxt: 'MS=ms12345678',
      dkimSelector1Cname: 'selector1-ready-example._domainkey.contoso.n-v1.dkim.mail.microsoft',
      dkimSelector2Cname: 'selector2-ready-example._domainkey.contoso.n-v1.dkim.mail.microsoft',
    });
    assert.equal(host.querySelector('[data-dns-expected-form]'), null, 'the form closes once saved');
  });
});

describe('MailNodeSection — node DNS and the warnings of the domain list', () => {
  test('marks only a ready domain with DNS errors, and sums them up next to the title', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    const badges = [...host.querySelectorAll('[data-dns-badge]')].map((el) => el.getAttribute('data-dns-badge'));
    assert.deepEqual(badges, ['ready.example'], 'a domain still onboarding gets no badge');
    const summary = host.querySelector('[data-dns-summary]');
    assert.equal(summary.getAttribute('data-dns-summary'), '1');
    assert.ok(summary.textContent.includes('admin.mailNode.dnsSummaryNode'), 'the node has errors too');
  });

  test('shows no summary when nothing that takes mailboxes has errors', async () => {
    answers['GET /api/mail-node/domains'] = { domains: [PENDING_ERRORS, { ...READY, dns: OK_DNS }] };
    answers['GET /api/mail-node/dns-check'] = { node: OK_DNS };
    const host = await mount(React.createElement(MailNodeSection));
    assert.equal(host.querySelector('[data-dns-summary]'), null);
    assert.equal(host.querySelector('[data-dns-badge]'), null);
  });

  test('shows the node\'s name and certificate checks and starts a check of everything in the background', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    const block = host.querySelector('[data-node-dns]');
    assert.deepEqual(checks(block), [['node_a', 'ok'], ['node_ptr', 'ok'], ['node_aaaa', 'warning'], ['cert_chain', 'error']]);
    assert.ok(block.textContent.includes('admin.mailNode.dnsCodeCertChainIncomplete'));
    answers['POST /api/mail-node/dns-check'] = { ok: true, started: true, running: true };
    await click(buttons(block, 'admin.mailNode.dnsCheckAll')[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/dns-check'));
    assert.ok(host.textContent.includes('admin.mailNode.dnsCheckStarted'), 'the results come on the next load');
    answers['POST /api/mail-node/dns-check'] = { ok: true, started: false, running: true };
    await click(buttons(host.querySelector('[data-node-dns]'), 'admin.mailNode.dnsCheckAll')[0]);
    assert.ok(host.textContent.includes('admin.mailNode.dnsCheckRunning'));
  });

  test('keeps a domain whose last check could not ask DNS out of the warnings, and says why', async () => {
    const lookupFailed = { at, code: 'dns_lookup_failed', detail: 'ETIMEOUT', checks: [{ check: 'mx', name: 'ready.example', detail: 'ETIMEOUT' }] };
    answers['GET /api/mail-node/domains'] = { domains: [{ ...READY, dns: { at: null, overall: null, checks: [], lookupFailed } }] };
    answers['GET /api/mail-node/dns-check'] = { node: OK_DNS };
    const host = await mount(React.createElement(MailNodeSection));
    assert.equal(host.querySelector('[data-dns-badge]'), null);
    assert.equal(host.querySelector('[data-dns-summary]'), null);
    const detail = await mount(React.createElement(MailNodeDomainOnboarding, { domain: { ...READY, dns: { ...ERROR_DNS, lookupFailed } } }));
    const note = detail.querySelector('[data-dns-lookup-failed]');
    assert.equal(note.getAttribute('data-dns-lookup-failed'), 'dns_lookup_failed');
    assert.ok(note.textContent.includes('admin.mailNode.dnsLookupFailedKept'));
    assert.deepEqual(checks(detail), [['mx', 'error'], ['spf', 'ok'], ['tenant_txt', 'warning']], 'the result before stays on screen');
  });

  test('edits the node address next to the node host', async () => {
    answers['GET /api/mail-node/config'] = { ...answers['GET /api/mail-node/config'], nodeIp: '203.0.113.10' };
    const host = await mount(React.createElement(MailNodeSection));
    const input = [...host.querySelectorAll('input')].find((i) => i.placeholder === 'admin.mailNode.nodeIpPh');
    assert.equal(input.value, '203.0.113.10');
    await setValue(input, 'mail.example.com');
    assert.ok(host.textContent.includes('admin.eop.errorNodeIp'));
    await setValue(input, '198.51.100.20');
    answers['PUT /api/mail-node/config'] = { ok: true };
    await click(buttons(host, 'admin.mailNode.saveAndCheck')[0]);
    assert.equal(calls.find((c) => c.method === 'PUT' && c.path === '/api/mail-node/config').body.nodeIp, '198.51.100.20');
  });
});
