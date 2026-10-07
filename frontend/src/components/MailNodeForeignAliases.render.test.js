// Render tests for D-16 (a mail node mailbox sends only from its own address): the administrator's
// list of aliases with another address left on node mailboxes (MailNodeForeignAliases.jsx), and
// the alias editor of a node mailbox in the accounts tab (AdminPanel.jsx), whose address is fixed.
//
// The harness mirrors MailNodeQuarantine.render.test.js: node --test cannot parse JSX, so the
// loader hook transforms .jsx with sucrase, and react-i18next is stubbed (t returns the key).

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
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  Image: dom.window.Image,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MailNodeForeignAliases = (await import('./MailNodeForeignAliases.jsx')).default;
const { AccountsTab, TAB_GROUPS, TABS, makeSearchIndex } = await import('./AdminPanel.jsx');

const account = (id, email, extra = {}) => ({
  id, name: email, email_address: email, color: '#7c3aed', protocol: 'imap', enabled: true, health: 'healthy',
  imap_host: 'mail.example.com', imap_port: 993, smtp_host: 'mail.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  aliases: [], ...extra,
});
const NODE = account('n1', 'sales@example.com', {
  mail_node: true,
  aliases: [
    { id: 'al-name', account_id: 'n1', name: 'Sales Department', email: 'sales@example.com', reply_to: null, signature: null },
    { id: 'al-old', account_id: 'n1', name: 'Orders desk', email: 'orders@example.com', reply_to: 'desk@example.com', signature: '<p>Orders</p>' },
  ],
});
const GMAIL = account('g1', 'me@gmail.example', {
  oauth_provider: 'google',
  aliases: [{ id: 'al-work', account_id: 'g1', name: 'Work', email: 'work@example.org', reply_to: null, signature: null }],
});

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
    'GET /api/mail-node/domains': { domains: [{ domain: 'example.com', active: true, state: 'ready' }] },
    // A new mailbox needs a free EOP seat (the add form reads the counter).
    'GET /api/mail-node/seats': { used: 1, held: 0, free: 5, known: true, heldSeats: [], requests: [] },
    'POST /api/accounts': account('n2', 'orders@example.com', { mail_node: true }),
    'DELETE /api/accounts/n1/aliases/al-old': { ok: true },
    'PUT /api/accounts/n2': { signature: '<p>Orders</p>' },
    'POST /api/accounts/n2/aliases': { id: 'al-new', account_id: 'n2', name: 'Orders desk', email: 'orders@example.com', reply_to: 'desk@example.com', signature: null },
  };
  mockFetch();
  useStore.setState({ accounts: [NODE, GMAIL], accountsReady: true, user: { id: 'u1', isAdmin: true } });
});

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
async function mount(element) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => { root.render(element); });
  await flush();
  return { host, unmount: () => React.act(async () => { root.unmount(); host.remove(); }) };
}
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);
async function click(element) {
  await React.act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await flush();
}
const lastDialog = () => [...dom.window.document.querySelectorAll('[role="dialog"]')].at(-1);

describe('aliases with another address on node mailboxes (admin list)', () => {
  test('lists only node mailbox aliases with another address', async () => {
    const { host, unmount } = await mount(React.createElement(MailNodeForeignAliases));
    const rows = [...host.querySelectorAll('[data-foreign-alias]')];
    assert.deepEqual(rows.map((r) => r.dataset.foreignAlias), ['al-old']);
    assert.ok(rows[0].textContent.includes('orders@example.com'));
    assert.ok(rows[0].textContent.includes('sales@example.com'));
    await unmount();
  });

  test('shows nothing when there is nothing to do', async () => {
    useStore.setState({ accounts: [GMAIL] });
    const { host, unmount } = await mount(React.createElement(MailNodeForeignAliases));
    assert.equal(host.querySelector('[data-section="node-foreign-aliases"]'), null);
    await unmount();
  });

  test('"Create a separate mailbox" opens the form from the alias, creates it and removes the alias', async () => {
    const { host, unmount } = await mount(React.createElement(MailNodeForeignAliases));
    await click(button(host, 'admin.foreignAliases.create'));

    assert.equal(host.querySelector('#domain-add-local').value, 'orders');
    assert.equal(host.querySelector('#domain-add-sender').value, 'Orders desk');
    assert.equal(host.querySelector('select').value, 'example.com');
    assert.equal(calls.some((c) => c.method !== 'GET'), false, 'nothing is created by opening the form');

    await click(button(host, 'admin.accounts.add.domainNext'));
    await click(button(host, 'admin.accounts.add.domainCreate'));

    const create = calls.find((c) => c.method === 'POST' && c.path === '/api/accounts');
    assert.deepEqual(
      { kind: create.body.kind, localPart: create.body.localPart, domain: create.body.domain, senderName: create.body.senderName },
      { kind: 'domain', localPart: 'orders', domain: 'example.com', senderName: 'Orders desk' },
    );
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/accounts/n1/aliases/al-old'));
    // The alias signature and Reply-To go to the new mailbox.
    assert.deepEqual(calls.find((c) => c.method === 'PUT' && c.path === '/api/accounts/n2').body, { signature: '<p>Orders</p>' });
    assert.deepEqual(calls.find((c) => c.method === 'POST' && c.path === '/api/accounts/n2/aliases').body,
      { name: 'Orders desk', email: 'orders@example.com', reply_to: 'desk@example.com', signature: null });
    const accounts = useStore.getState().accounts;
    const made = accounts.find((a) => a.email_address === 'orders@example.com');
    assert.ok(made, 'the new mailbox is in the list');
    assert.equal(made.signature, '<p>Orders</p>');
    assert.deepEqual(made.aliases.map((a) => a.reply_to), ['desk@example.com']);
    assert.deepEqual(accounts.find((a) => a.id === 'n1').aliases.map((a) => a.id), ['al-name']);
    assert.ok(host.textContent.includes('admin.foreignAliases.created'));
    await unmount();
  });

  test('a domain the node cannot take is not chosen, and the form says why', async () => {
    const legacyOn = (domain) => [account('n3', 'hr@example.com', { mail_node: true, aliases: [{ id: 'x', name: 'Jobs', email: `jobs@${domain}` }] })];

    useStore.setState({ accounts: legacyOn('gmail.example') });
    let mounted = await mount(React.createElement(MailNodeForeignAliases));
    await click(button(mounted.host, 'admin.foreignAliases.create'));
    assert.equal(mounted.host.querySelector('select').value, 'example.com');
    assert.equal(mounted.host.querySelector('[data-prefill-domain]').dataset.prefillDomain, 'notNode');
    await mounted.unmount();

    answers['GET /api/mail-node/domains'] = { domains: [
      { domain: 'example.com', active: true, state: 'ready' }, { domain: 'example.org', active: true, state: 'dns_ok' },
    ] };
    useStore.setState({ accounts: legacyOn('example.org') });
    mounted = await mount(React.createElement(MailNodeForeignAliases));
    await click(button(mounted.host, 'admin.foreignAliases.create'));
    assert.equal(mounted.host.querySelector('[data-prefill-domain]').dataset.prefillDomain, 'notReady');
    await mounted.unmount();
  });

  test('Cancel closes the form and creates nothing', async () => {
    const { host, unmount } = await mount(React.createElement(MailNodeForeignAliases));
    await click(button(host, 'admin.foreignAliases.create'));
    assert.ok(host.querySelector('#domain-add-local'));
    await click(button(host, 'common.cancel'));
    assert.equal(host.querySelector('#domain-add-local'), null);
    assert.equal(calls.some((c) => c.method !== 'GET'), false);
    await unmount();
  });

  test('an alias that could not be removed after the mailbox was made stays, with a message', async () => {
    answers['DELETE /api/accounts/n1/aliases/al-old'] = { status: 500, body: { error: 'Database down' } };
    const { host, unmount } = await mount(React.createElement(MailNodeForeignAliases));
    await click(button(host, 'admin.foreignAliases.create'));
    await click(button(host, 'admin.accounts.add.domainNext'));
    await click(button(host, 'admin.accounts.add.domainCreate'));
    assert.ok(host.querySelector('[role="alert"]').textContent.includes('admin.foreignAliases.createdAliasKept'));
    assert.ok(host.querySelector('[data-foreign-alias="al-old"]'), 'the row stays to be deleted by hand');
    assert.ok(useStore.getState().accounts.some((a) => a.email_address === 'orders@example.com'), 'the mailbox is kept');
    await unmount();
  });

  test('an alias already gone (404) counts as removed', async () => {
    answers['DELETE /api/accounts/n1/aliases/al-old'] = { status: 404, body: { error: 'Alias not found' } };
    const { host, unmount } = await mount(React.createElement(MailNodeForeignAliases));
    await click(button(host, 'admin.foreignAliases.create'));
    await click(button(host, 'admin.accounts.add.domainNext'));
    await click(button(host, 'admin.accounts.add.domainCreate'));
    assert.equal(host.querySelector('[role="alert"]'), null);
    assert.ok(host.textContent.includes('admin.foreignAliases.created'));
    assert.deepEqual(useStore.getState().accounts.find((a) => a.id === 'n1').aliases.map((a) => a.id), ['al-name']);
    await unmount();
  });

  test('an address that is already a mailbox of the panel offers only Delete', async () => {
    useStore.setState({ accounts: [NODE, GMAIL, account('n9', 'Orders@example.com', { mail_node: true })] });
    const { host, unmount } = await mount(React.createElement(MailNodeForeignAliases));
    const row = host.querySelector('[data-foreign-alias="al-old"]');
    assert.ok(row.querySelector('[data-mailbox-exists]'));
    assert.equal(button(row, 'admin.foreignAliases.create'), undefined);
    assert.ok(button(row, 'common.delete'));
    await unmount();
  });

  test('"Delete" removes the alias after confirmation', async () => {
    const { host, unmount } = await mount(React.createElement(MailNodeForeignAliases));
    await click(button(host, 'common.delete'));
    assert.equal(calls.some((c) => c.method === 'DELETE'), false, 'nothing before the confirmation');
    await click(lastDialog().querySelector('[data-confirm-button]'));
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/accounts/n1/aliases/al-old'));
    assert.deepEqual(useStore.getState().accounts.find((a) => a.id === 'n1').aliases.map((a) => a.id), ['al-name']);
    await unmount();
  });
});

describe('alias editor of a node mailbox', () => {
  async function openAliases(host, email) {
    const row = [...host.querySelectorAll('button[title="admin.accounts.aliases"]')]
      .find((b) => b.closest('div[style]')?.parentElement?.textContent.includes(email));
    await click(row);
  }

  test('the address is fixed to the mailbox, with a hint, and another name is easy to add', async () => {
    const { host, unmount } = await mount(React.createElement(AccountsTab));
    await openAliases(host, 'sales@example.com');
    assert.ok(host.textContent.includes('admin.aliases.descriptionNode'));
    assert.equal(host.querySelectorAll('[data-foreign-node-alias]').length, 1, 'the old foreign alias is marked');
    // The old foreign alias offers Delete only (no Edit that would rewrite its address); the name
    // with the mailbox address keeps both.
    assert.equal(host.querySelectorAll('button[title="common.edit"]').length, 1);
    assert.equal(host.querySelectorAll('button[title="common.delete"]').length, 2);
    // The list itself is on the page (as the Mail node tab renders it): the link scrolls to it.
    const list = await mount(React.createElement(MailNodeForeignAliases));
    let scrolled = null;
    list.host.querySelector('[data-section="node-foreign-aliases"]').scrollIntoView = function scrollIntoView() { scrolled = this; };
    await click(button(host, 'admin.aliases.foreignNodeAliasOpen'));
    assert.equal(useStore.getState().adminTab, 'mail-node', 'the marker leads to the list in the Mail node tab');
    await flush();
    assert.equal(scrolled?.getAttribute('data-section'), 'node-foreign-aliases', 'and brings the list into view');
    await list.unmount();

    await click(button(host, 'admin.aliases.addNameButton'));
    const email = host.querySelector('#alias-email');
    assert.equal(email.readOnly, true);
    assert.equal(email.value, 'sales@example.com');
    assert.equal(email.getAttribute('aria-describedby'), 'alias-email-hint');
    assert.equal(host.querySelector('#alias-email-hint').textContent, 'admin.aliases.nodeAddressHint');
    assert.ok(host.querySelector('label[for="alias-email"]'));
    assert.ok(host.querySelector('label[for="alias-reply-to"]'));
    assert.ok(host.querySelector('#alias-reply-to'));
    assert.equal(host.querySelector('[contenteditable]').getAttribute('aria-labelledby'), 'alias-signature-label');
    await unmount();
  });

  test('a Gmail mailbox keeps a free address field', async () => {
    const { host, unmount } = await mount(React.createElement(AccountsTab));
    await openAliases(host, 'me@gmail.example');
    assert.ok(host.textContent.includes('me@gmail.example'));
    assert.ok(!host.textContent.includes('admin.aliases.descriptionNode'));
    await click(button(host, 'admin.aliases.addButton'));
    const email = host.querySelector('#alias-email');
    assert.equal(email.readOnly, false);
    assert.equal(email.value, '');
    await unmount();
  });
});

describe('the mail node tab', () => {
  test('is its own admin-only tab in Administration, not in Integrations', () => {
    const groupOf = (id) => TAB_GROUPS.find((g) => g.tabIds.includes(id))?.id;
    assert.equal(groupOf('mail-node'), 'admin');
    assert.equal(groupOf('integrations'), 'security-integrations');
    const tab = TABS.find((x) => x.id === 'mail-node');
    assert.equal(tab.adminOnly, true);
    assert.equal(tab.labelKey, 'admin.tabs.mailNode');
  });

  test('the settings search finds the node, EOP and the tenant there, for administrators', () => {
    const index = makeSearchIndex((key) => key);
    const inTab = index.filter((item) => item.tab === 'mail-node');
    assert.ok(inTab.length >= 5);
    assert.ok(inTab.every((item) => item.adminOnly === true));
    for (const label of ['admin.mailNode.title', 'admin.eop.title', 'admin.tenant.title', 'admin.quarantine.title']) {
      assert.ok(inTab.some((item) => item.label === label), label);
    }
    // One entry per label: the tab's name and its first section's title are the same words.
    assert.equal(new Set(inTab.map((item) => item.label)).size, inTab.length);
    assert.equal(inTab.some((item) => item.label === 'admin.tabs.mailNode'), false);
    assert.ok(inTab.some((item) => item.keywords.includes('eop')));
    // Google apps and Microsoft 365 stay in Integrations.
    assert.equal(index.find((item) => item.label === 'admin.integrations.googleApps.title').tab, 'integrations');
  });
});
