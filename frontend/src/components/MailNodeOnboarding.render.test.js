// Render tests for the mail node domain onboarding (stage 1 of the EOP work): the onboarding
// column and domain details of MailNodeSection, the EOP settings section with its checklist of
// manual steps, and the add-mailbox form offering only ready domains. The pure rules behind them
// (state keys, the checklist, the settings check) are covered by utils/mailNode.test.js; this mounts
// the real components against a fetched domain list and checks what they render and send.
//
// The harness mirrors GoogleAppsSection.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed to return the raw key (so a
// rendered key string doubles as a readable, stable assertion target).

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
const DomainMailboxAddForm = (await import('./DomainMailboxAddForm.jsx')).default;

const at = '2026-10-01T10:00:00.000Z';
const domainRow = (domain, state, extra = {}) => ({
  domain, active: true, maxMailboxes: 50, mailboxes: 0, onNode: true, state,
  origin: state === 'unknown' ? null : 'created', addedAt: state === 'unknown' ? null : at,
  addedBy: state === 'unknown' ? null : 'admin@example.com', stateChangedAt: null, steps: {}, nextStep: null, ...extra,
});
const DOMAINS = [
  domainRow('ready.example', 'ready', { origin: 'existing_mailboxes', addedBy: null }),
  domainRow('pending.example', 'dns_ok', {
    nextStep: 'tenant_verified',
    steps: { node_configured: { at, email: 'admin@example.com' }, dns_ok: { at, email: 'ops@example.com' } },
  }),
  domainRow('manual.example', 'unknown'),
];
const EOP = {
  eopHost: 'contoso-com.mail.protection.outlook.com', certificateHost: 'mail.example.com', dkimMode: 'mailcow',
  sendLimitPerHour: 50, terrl: null, tenantId: null, appId: null, certThumbprint: null, tenantConfigured: false,
  tenantDriverActive: false,
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
    'GET /api/mail-node/config': { configured: true, mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120, diskPingUrl: '' },
    'GET /api/mail-node/domains': { domains: DOMAINS },
    'GET /api/mail-node/mailboxes': { disk: { usedPercent: 10, used: '4G', total: '40G', warn: false }, mailboxes: [] },
    'GET /api/mail-node/eop': EOP,
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
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await React.act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

describe('MailNodeSection — domain onboarding', () => {
  test('shows each domain\'s onboarding state, unknown ones marked', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    const states = [...host.querySelectorAll('[data-domain-state]')].map((el) => [el.getAttribute('data-domain-state'), el.textContent]);
    assert.deepEqual(states, [
      ['ready', 'admin.mailNode.stateReady'],
      ['dns_ok', 'admin.mailNode.stateDnsOk'],
      ['unknown', 'admin.mailNode.stateUnknown'],
    ]);
  });

  test('opens a domain\'s checklist and confirms its next step with Done', async () => {
    let changed = 0;
    const host = await mount(React.createElement(MailNodeSection, { onDomainsChanged: () => { changed += 1; } }));
    await click(buttons(host, 'admin.mailNode.showDetails')[1]);
    const detail = host.querySelector('[data-domain-onboarding="pending.example"]');
    assert.ok(detail, 'the details of pending.example open');
    const statuses = [...detail.querySelectorAll('[data-step]')].map((li) => [li.getAttribute('data-step'), li.getAttribute('data-status')]);
    assert.deepEqual(statuses, [
      ['node_configured', 'confirmed'], ['dns_ok', 'confirmed'], ['tenant_verified', 'next'],
      ['internal_relay', 'pending'], ['connector_ready', 'pending'], ['ready', 'pending'],
    ]);
    assert.ok(detail.textContent.includes('admin.mailNode.stepConfirmedBy'));
    const done = buttons(detail, 'admin.mailNode.stepDone');
    assert.equal(done.length, 1, 'only the next step has a Done button');
    answers['POST /api/mail-node/domains/pending.example/steps/tenant_verified'] = { ok: true, state: 'tenant_verified' };
    await click(done[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/domains/pending.example/steps/tenant_verified'));
    assert.equal(changed, 1, 'the other section is told to reload');
  });

  test('marks a domain ready only after a second confirmation', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    await click(buttons(host, 'admin.mailNode.showDetails')[1]);
    await click(buttons(host, 'admin.mailNode.markReady')[0]);
    assert.ok(host.textContent.includes('admin.mailNode.markReadyConfirm'));
    assert.equal(calls.some((c) => c.path.endsWith('/ready')), false);
    answers['POST /api/mail-node/domains/pending.example/ready'] = { ok: true, state: 'ready' };
    const confirm = buttons(host, 'admin.mailNode.markReady');
    await click(confirm[confirm.length - 1]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/domains/pending.example/ready'));
  });

  test('adopts an unknown domain and shows a refusal', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    await click(buttons(host, 'admin.mailNode.showDetails')[2]);
    const detail = host.querySelector('[data-domain-onboarding="manual.example"]');
    assert.ok(detail.textContent.includes('admin.mailNode.unknownNote'));
    answers['POST /api/mail-node/domains/manual.example/adopt'] = { status: 409, body: { error: 'known', code: 'domain_known' } };
    await click(buttons(detail, 'admin.mailNode.adopt')[0]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/domains/manual.example/adopt'));
    assert.ok(host.querySelector('[data-domain-onboarding="manual.example"]').textContent.includes('admin.mailNode.errorDomainKnown'));
  });
});

describe('MailNodeDomainOnboarding — node trouble never hides or resets a domain', () => {
  test('a domain whose node creation time differs keeps its state, warns, and the warning can be accepted', async () => {
    answers['GET /api/mail-node/domains'] = {
      domains: [
        domainRow('remade.example', 'dns_ok', {
          nextStep: 'tenant_verified', recreated: true, nodeCreated: '2026-09-01 10:00:00', created: '2026-09-30 12:00:00',
        }),
        domainRow('gone.example', 'dns_ok', { onNode: false, active: false, nextStep: 'tenant_verified' }),
      ],
    };
    const host = await mount(React.createElement(EopSection));
    const remade = host.querySelector('[data-domain-onboarding="remade.example"]');
    assert.ok(remade.textContent.includes('admin.mailNode.stateNow'), 'the domain shows its own state');
    assert.ok(remade.querySelector('[data-domain-recreated="remade.example"]').textContent.includes('admin.mailNode.recreatedNote'));
    assert.equal(buttons(remade, 'admin.mailNode.adopt').length, 0);
    assert.equal(buttons(remade, 'admin.mailNode.stepDone').length, 1, 'Done still works on it');
    answers['POST /api/mail-node/domains/remade.example/acknowledge'] = { ok: true, domain: 'remade.example' };
    await click(buttons(remade, 'admin.mailNode.acknowledge')[0]);
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/api/mail-node/domains/remade.example/acknowledge');
    assert.deepEqual(sent.body, { created: '2026-09-30 12:00:00' }, 'the time the administrator saw goes with it');
    const gone = host.querySelector('[data-domain-onboarding="gone.example"]');
    assert.ok(gone.textContent.includes('admin.mailNode.domainNotOnNode'));
    assert.equal(buttons(gone, 'admin.mailNode.stepDone').length, 0);
    assert.equal(buttons(gone, 'admin.mailNode.markReady').length, 0);
  });

  test('the domain list marks the warning in the state column', async () => {
    answers['GET /api/mail-node/domains'] = {
      domains: [domainRow('remade.example', 'ready', { recreated: true, nodeCreated: 'a', created: 'b' }), DOMAINS[0]],
    };
    const host = await mount(React.createElement(MailNodeSection));
    const badges = [...host.querySelectorAll('[data-recreated-badge]')];
    assert.equal(badges.length, 1);
    assert.equal(badges[0].textContent, 'admin.mailNode.recreatedBadge');
    assert.equal(host.querySelector('[data-domain-state]').getAttribute('data-domain-state'), 'ready');
  });

  test('with the node unreachable the domains stay listed with the node error, and no step can be confirmed', async () => {
    answers['GET /api/mail-node/domains'] = {
      domains: DOMAINS.filter((d) => d.state !== 'unknown').map((d) => ({ ...d, onNode: null, active: null, mailboxes: null })),
      node: { error: 'The mail node is unreachable (ETIMEDOUT)', code: 'mail_node_unreachable' },
    };
    const host = await mount(React.createElement(MailNodeSection));
    const alert = host.querySelector('[data-domains-node-error]');
    assert.ok(alert, 'the node error is shown');
    assert.ok(alert.textContent.includes('admin.mailNode.domainsNodeUnreachable'));
    const states = [...host.querySelectorAll('[data-domain-state]')].map((el) => el.getAttribute('data-domain-state'));
    assert.deepEqual(states, ['ready', 'dns_ok']);
    assert.ok(host.textContent.includes('admin.mailNode.nodeUnknown'));
    assert.equal(host.textContent.includes('admin.mailNode.domainsEmpty'), false);
    await click(buttons(host, 'admin.mailNode.showDetails')[1]);
    const detail = host.querySelector('[data-domain-onboarding="pending.example"]');
    assert.ok(detail.textContent.includes('admin.mailNode.nodeUnreachableNote'));
    assert.equal(buttons(detail, 'admin.mailNode.stepDone').length, 0);
    assert.equal(buttons(detail, 'admin.mailNode.restart').length, 1, 'restart needs no answer from the node');
  });

  test('the EOP checklist keeps its domains and says the node is unreachable', async () => {
    answers['GET /api/mail-node/domains'] = {
      domains: [domainRow('pending.example', 'dns_ok', { onNode: null, active: null, nextStep: 'tenant_verified' })],
      node: { error: 'The mail node answered HTTP 500', code: 'mail_node_failed' },
    };
    const host = await mount(React.createElement(EopSection));
    assert.ok(host.textContent.includes('admin.mailNode.domainsNodeUnreachable'));
    assert.ok(host.querySelector('[data-domain-onboarding="pending.example"]'));
  });
});

describe('MailNodeDomainOnboarding — restart onboarding', () => {
  test('restarts a domain only after a second confirmation', async () => {
    let changed = 0;
    const host = await mount(React.createElement(MailNodeSection, { onDomainsChanged: () => { changed += 1; } }));
    await click(buttons(host, 'admin.mailNode.showDetails')[0]);
    const detail = host.querySelector('[data-domain-onboarding="ready.example"]');
    await click(buttons(detail, 'admin.mailNode.restart')[0]);
    assert.ok(detail.textContent.includes('admin.mailNode.restartConfirm'));
    assert.equal(calls.some((c) => c.path.endsWith('/restart')), false, 'nothing is sent before the confirmation');
    await click(buttons(detail, 'common.cancel')[0]);
    assert.equal(detail.textContent.includes('admin.mailNode.restartConfirm'), false);
    await click(buttons(detail, 'admin.mailNode.restart')[0]);
    answers['POST /api/mail-node/domains/ready.example/restart'] = { ok: true, domain: 'ready.example', state: 'node_created' };
    const confirm = buttons(detail, 'admin.mailNode.restart');
    await click(confirm[confirm.length - 1]);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/domains/ready.example/restart'));
    assert.equal(changed, 1);
  });

  test('offers no restart for a domain the panel does not know, or one with nothing to clear', async () => {
    answers['GET /api/mail-node/domains'] = {
      domains: [...DOMAINS, domainRow('fresh.example', 'node_created', { nextStep: 'node_configured' })],
    };
    const host = await mount(React.createElement(MailNodeSection));
    await click(buttons(host, 'admin.mailNode.showDetails')[2]);
    const detail = host.querySelector('[data-domain-onboarding="manual.example"]');
    assert.equal(buttons(detail, 'admin.mailNode.restart').length, 0);
    // The open row's button now reads "hide": the fresh domain is the third "show" button.
    await click(buttons(host, 'admin.mailNode.showDetails')[2]);
    const fresh = host.querySelector('[data-domain-onboarding="fresh.example"]');
    assert.ok(fresh, 'the fresh domain opens');
    assert.equal(buttons(fresh, 'admin.mailNode.restart').length, 0);
  });
});

describe('EopSection', () => {
  test('shows the stored settings and, without a tenant, the domains that are not ready', async () => {
    const host = await mount(React.createElement(EopSection));
    const values = [...host.querySelectorAll('input')].map((input) => input.value);
    assert.ok(values.includes('contoso-com.mail.protection.outlook.com'));
    assert.ok(values.includes('50'));
    assert.equal(host.querySelector('select').value, 'mailcow');
    assert.ok(host.textContent.includes('admin.eop.checklistTitle'));
    const listed = [...host.querySelectorAll('[data-domain-onboarding]')].map((el) => el.getAttribute('data-domain-onboarding'));
    assert.deepEqual(listed, ['pending.example', 'manual.example']);
  });

  test('saves the settings it checked, and keeps a bad value from being sent', async () => {
    const host = await mount(React.createElement(EopSection));
    const thumbprint = [...host.querySelectorAll('input')].at(-1);
    await type(thumbprint, 'not-hex');
    assert.ok(host.textContent.includes('admin.eop.errorThumbprint'));
    assert.equal(buttons(host, 'common.save')[0].disabled, true);
    await type(thumbprint, 'AB'.repeat(20));
    answers['PUT /api/mail-node/eop'] = { ...EOP, certThumbprint: 'AB'.repeat(20) };
    await click(buttons(host, 'common.save')[0]);
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/mail-node/eop');
    assert.equal(put.body.certThumbprint, 'AB'.repeat(20));
    assert.equal(put.body.sendLimitPerHour, 50);
    assert.equal(put.body.dkimMode, 'mailcow');
    assert.ok(host.textContent.includes('admin.eop.saved'));
  });

  test('keeps the checklist when the tenant ids are filled in: the panel does not talk to the tenant yet', async () => {
    answers['GET /api/mail-node/eop'] = { ...EOP, tenantConfigured: true };
    const host = await mount(React.createElement(EopSection));
    assert.ok(host.textContent.includes('admin.eop.checklistTitle'));
    assert.ok(host.querySelector('[data-domain-onboarding="pending.example"]'));
  });

  test('leaves the checklist out once the tenant driver works with the tenant', async () => {
    answers['GET /api/mail-node/eop'] = { ...EOP, tenantConfigured: true, tenantDriverActive: true };
    const host = await mount(React.createElement(EopSection));
    assert.equal(host.textContent.includes('admin.eop.checklistTitle'), false);
    assert.equal(calls.some((c) => c.path === '/api/mail-node/domains'), false);
  });
});

describe('DomainMailboxAddForm', () => {
  test('offers only the domains whose onboarding is done', async () => {
    const host = await mount(React.createElement(DomainMailboxAddForm, { accounts: [], onCreated: () => {} }));
    const options = [...host.querySelectorAll('option')].map((o) => o.value);
    assert.deepEqual(options, ['ready.example']);
  });

  test('says the node is unreachable, not that there is no domain, when an administrator gets the node error', async () => {
    answers['GET /api/mail-node/domains'] = {
      domains: DOMAINS.filter((d) => d.state !== 'unknown').map((d) => ({ ...d, onNode: null, active: null })),
      node: { error: 'The mail node is unreachable (ETIMEDOUT)', code: 'mail_node_unreachable' },
    };
    const host = await mount(React.createElement(DomainMailboxAddForm, { accounts: [], onCreated: () => {} }));
    assert.ok(host.textContent.includes('admin.mailNode.errorUnreachable'));
    assert.equal(host.textContent.includes('admin.accounts.add.domainNoDomains'), false);
  });

  test('says there is no ready domain when none is', async () => {
    answers['GET /api/mail-node/domains'] = { domains: DOMAINS.filter((d) => d.state !== 'ready') };
    const host = await mount(React.createElement(DomainMailboxAddForm, { accounts: [], onCreated: () => {} }));
    assert.ok(host.textContent.includes('admin.accounts.add.domainNoDomains'));
  });
});
