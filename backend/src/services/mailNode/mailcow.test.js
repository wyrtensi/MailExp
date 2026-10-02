import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));
vi.mock('../safeFetch.js', () => ({ safeFetch: vi.fn() }));

import { query } from '../db.js';
import { safeFetch } from '../safeFetch.js';
import {
  DEFAULT_QUOTA_MB,
  MAX_QUOTA_MB,
  MailNodeError,
  addDkim,
  addDomain,
  addTlsPolicy,
  deleteDkim,
  deleteMailbox,
  editTlsPolicy,
  getDkim,
  getDomain,
  getFail2banWhitelist,
  getPrefilter,
  joinTxtChunks,
  listRelayhosts,
  listTlsPolicies,
  deleteRelayhost,
  unwhitelistFail2ban,
  parseNetwork,
  parseNetworkList,
  setDomainRelayhost,
  setMailboxRateLimit,
  setPrefilter,
  whitelistFail2ban,
  generateMailboxPassword,
  getMailbox,
  getDiskStatus,
  getMailNodeConfig,
  listAliasesTo,
  listDomains,
  listMailboxes,
  parseHostName,
  parseLocalPart,
  parsePingUrl,
  provisionMailbox,
  saveMailNodeConfig,
  setMailboxPassword,
  setMailboxQuota,
} from './mailcow.js';

const CFG = { mailHost: 'mail.example.com', apiKey: 'api-key-1', quotaMb: 5120 };

// A fetch answer: mailcow's JSON with a status (200 unless given).
function answer(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
const OK = [{ type: 'success', msg: ['done'] }];

function calls() {
  return safeFetch.mock.calls.map(([url, opts, guard]) => ({
    url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined, guard,
  }));
}

beforeEach(() => {
  safeFetch.mockReset();
  query.mockReset();
});

describe('input parsing', () => {
  it('accepts host names only, lowercased', () => {
    expect(parseHostName(' Mail.Example.COM ')).toBe('mail.example.com');
    for (const bad of ['localhost', '10.0.0.1', 'https://mail.example.com', 'mail.example.com/x', '-a.example.com', '', null]) {
      expect(parseHostName(bad)).toBeNull();
    }
  });

  it('accepts a local part of letters, digits, dot, dash and underscore', () => {
    expect(parseLocalPart(' Info.Sales ')).toBe('info.sales');
    expect(parseLocalPart('a')).toBe('a');
    for (const bad of ['.a', 'a.', 'a..b', 'a@b', 'a b', 'a+b', '', 'x'.repeat(65)]) {
      expect(parseLocalPart(bad)).toBeNull();
    }
  });

  it('accepts only https ping URLs', () => {
    expect(parsePingUrl(' https://hc.example.com/ping/abc ')).toBe('https://hc.example.com/ping/abc');
    expect(parsePingUrl('http://hc.example.com/ping/abc')).toBeNull();
    expect(parsePingUrl('not a url')).toBeNull();
  });

  it('generates a long random password with every character class', () => {
    const a = generateMailboxPassword();
    expect(a).not.toBe(generateMailboxPassword());
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/[^A-Za-z0-9]/);
  });
});

describe('stored settings', () => {
  it('is null until a host and a key are saved', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getMailNodeConfig()).toBeNull();
  });

  it('keeps the API key encrypted at rest and decrypts it on read', async () => {
    query.mockResolvedValue({ rows: [] });
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'api-key-1', quotaMb: 2048 });
    const stored = query.mock.calls[0][1][1];
    expect(stored).toEqual({ mailHost: 'mail.example.com', apiKey: 'enc:api-key-1', quotaMb: 2048, diskPingUrl: null });

    query.mockResolvedValueOnce({ rows: [{ config: stored }] });
    expect(await getMailNodeConfig()).toEqual({
      mailHost: 'mail.example.com', apiKey: 'api-key-1', quotaMb: 2048, diskPingUrl: null, deleteAfterDays: 5, panelIps: [],
    });
  });

  it('falls back to the default quota when the stored one is unusable', async () => {
    query.mockResolvedValueOnce({ rows: [{ config: { mailHost: 'mail.example.com', apiKey: 'enc:k', quotaMb: 'x' } }] });
    expect((await getMailNodeConfig()).quotaMb).toBe(DEFAULT_QUOTA_MB);
  });
});

describe('API requests', () => {
  it('calls https://<host>/api/v1 with the key header, allowing a private address', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ domain_name: 'Example.com', active: '1', max_num_mboxes_for_domain: 500, mboxes_in_domain: 3 }]));
    expect(await listDomains(CFG)).toEqual([{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 3, created: null }]);
    const [call] = calls();
    expect(call.url).toBe('https://mail.example.com/api/v1/get/domain/all');
    expect(call.method).toBe('GET');
    expect(call.headers['X-API-Key']).toBe('api-key-1');
    expect(call.guard).toEqual({ allowPrivate: true, requireHttps: true });
  });

  it('keeps when mailcow made each domain', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ domain_name: 'example.com', active: 1, created: '2026-09-30 12:00:00' }]));
    expect((await listDomains(CFG))[0].created).toBe('2026-09-30 12:00:00');
  });

  it('reads an empty object as no domains', async () => {
    safeFetch.mockResolvedValueOnce(answer({}));
    expect(await listDomains(CFG)).toEqual([]);
  });

  it('turns a refusal inside a 200 answer into an error with the node message', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: ['domain_exists', 'example.com'] }]));
    const err = await addDomain(CFG, { domain: 'example.com', mailboxes: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(MailNodeError);
    expect(err.code).toBe('mail_node_refused');
    expect(err.message).toContain('domain_exists example.com');
  });

  it('reports a rejected key, an HTTP failure and an unreachable node separately', async () => {
    safeFetch.mockResolvedValueOnce(answer({}, 401));
    expect((await listDomains(CFG).catch((e) => e)).code).toBe('mail_node_auth');
    safeFetch.mockResolvedValueOnce(answer({}, 500));
    expect((await listDomains(CFG).catch((e) => e)).code).toBe('mail_node_failed');
    safeFetch.mockRejectedValueOnce(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }));
    const err = await listDomains(CFG).catch((e) => e);
    expect(err.code).toBe('mail_node_unreachable');
    expect(err.message).not.toContain('api-key-1');
  });

  it('creates a domain whose total fits every mailbox at the per-mailbox maximum', async () => {
    safeFetch.mockResolvedValueOnce(answer(OK));
    await addDomain(CFG, { domain: 'example.com', mailboxes: 10 });
    const [call] = calls();
    expect(call.url).toBe('https://mail.example.com/api/v1/add/domain');
    expect(call.body).toMatchObject({
      domain: 'example.com', active: 1, mailboxes: 10, defquota: 5120, maxquota: MAX_QUOTA_MB, quota: 10 * MAX_QUOTA_MB,
    });
  });

  it('creates a missing mailbox with the configured quota and a generated password', async () => {
    safeFetch.mockResolvedValueOnce(answer({})).mockResolvedValueOnce(answer(OK));
    const created = await provisionMailbox(CFG, { localPart: 'info', domain: 'example.com', name: 'Info' });
    expect(created.email).toBe('info@example.com');
    expect(created.reused).toBe(false);
    const [lookup, add] = calls();
    expect(lookup.url).toBe('https://mail.example.com/api/v1/get/mailbox/info%40example.com');
    expect(add.url).toBe('https://mail.example.com/api/v1/add/mailbox');
    expect(add.body).toMatchObject({ local_part: 'info', domain: 'example.com', name: 'Info', quota: 5120, active: 1 });
    expect(add.body.password).toBe(created.password);
    expect(add.body.password2).toBe(created.password);
  });

  it('takes over an active mailbox made by hand by enabling it with a new password', async () => {
    for (const active of ['1', '2']) {
      safeFetch.mockReset();
      safeFetch.mockResolvedValueOnce(answer({ username: 'info@example.com', active, quota: 5368709120 })).mockResolvedValueOnce(answer(OK));
      const created = await provisionMailbox(CFG, { localPart: 'info', domain: 'example.com', name: 'Info' });
      expect(created.reused).toBe(true);
      const edit = calls()[1];
      expect(edit.url).toBe('https://mail.example.com/api/v1/edit/mailbox');
      expect(edit.body).toEqual({
        items: ['info@example.com'],
        attr: { active: 1, password: created.password, password2: created.password, force_pw_update: 0 },
      });
    }
  });

  it('never brings back a disabled mailbox with its old letters: it refuses and changes nothing', async () => {
    safeFetch.mockResolvedValueOnce(answer({ username: 'info@example.com', active: '0', active_int: 0, quota: 5368709120 }));
    const err = await provisionMailbox(CFG, { localPart: 'info', domain: 'example.com', name: 'Info' }).catch((e) => e);
    expect(err).toBeInstanceOf(MailNodeError);
    expect(err.code).toBe('mailbox_disabled_on_node');
    expect(err.status).toBe(409);
    expect(calls().map((c) => c.method)).toEqual(['GET']);
  });

  it('names an alias of the node at the address instead of passing the raw refusal on', async () => {
    safeFetch.mockResolvedValueOnce(answer({})).mockResolvedValueOnce(answer([{ type: 'danger', msg: ['is_alias', 'orders@example.com'] }]));
    const err = await provisionMailbox(CFG, { localPart: 'orders', domain: 'example.com', name: 'Orders' }).catch((e) => e);
    expect(err).toBeInstanceOf(MailNodeError);
    expect(err.code).toBe('address_is_node_alias');
    expect(err.status).toBe(409);
  });

  it('passes another refusal of add/mailbox on as it is', async () => {
    safeFetch.mockResolvedValueOnce(answer({})).mockResolvedValueOnce(answer([{ type: 'danger', msg: ['max_mailbox_exceeded', '500'] }]));
    const err = await provisionMailbox(CFG, { localPart: 'orders', domain: 'example.com', name: 'Orders' }).catch((e) => e);
    expect(err.code).toBe('mail_node_refused');
  });

  it('makes a new, empty mailbox at an address deleted before: the node no longer has it', async () => {
    safeFetch
      .mockResolvedValueOnce(answer([{ type: 'success', msg: ['mailbox_removed', 'info@example.com'] }]))
      .mockResolvedValueOnce(answer({}))
      .mockResolvedValueOnce(answer(OK));
    await deleteMailbox(CFG, 'info@example.com');
    const created = await provisionMailbox(CFG, { localPart: 'info', domain: 'example.com', name: 'Info' });
    expect(created.reused).toBe(false);
    expect(calls().map((c) => c.url.replace('https://mail.example.com/api/v1/', ''))).toEqual([
      'delete/mailbox', 'get/mailbox/info%40example.com', 'add/mailbox',
    ]);
  });

  it('deletes a mailbox with delete/mailbox and a JSON array of addresses', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ type: 'success', msg: ['mailbox_removed', 'info@example.com'] }]));
    expect(await deleteMailbox(CFG, 'info@example.com')).toEqual({ warnings: [] });
    const [call] = calls();
    expect(call.url).toBe('https://mail.example.com/api/v1/delete/mailbox');
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body).toEqual(['info@example.com']);
  });

  it('counts a delete whose maildir stayed in place as done and passes the warning on', async () => {
    safeFetch.mockResolvedValueOnce(answer([
      { type: 'warning', msg: 'Could not move maildir to garbage collector: command failed' },
      { type: 'success', msg: ['mailbox_removed', 'info@example.com'] },
    ]));
    expect(await deleteMailbox(CFG, 'info@example.com')).toEqual({
      warnings: ['Could not move maildir to garbage collector: command failed'],
    });
  });

  it('reports a delete without a success as a refusal with the node message', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: 'access_denied' }]));
    let err = await deleteMailbox(CFG, 'gone@example.com').catch((e) => e);
    expect(err).toBeInstanceOf(MailNodeError);
    expect(err.code).toBe('mail_node_refused');
    expect(err.message).toContain('access_denied');
    safeFetch.mockResolvedValueOnce(answer({}));
    err = await deleteMailbox(CFG, 'gone@example.com').catch((e) => e);
    expect(err.code).toBe('mail_node_refused');
    safeFetch.mockRejectedValueOnce(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }));
    expect((await deleteMailbox(CFG, 'info@example.com').catch((e) => e)).code).toBe('mail_node_unreachable');
  });

  it('sets the quota of a mailbox through edit/mailbox', async () => {
    safeFetch.mockResolvedValue(answer(OK));
    await setMailboxQuota(CFG, 'info@example.com', 10240);
    expect(calls().map((c) => c.body)).toEqual([{ items: ['info@example.com'], attr: { quota: 10240 } }]);
  });

  it('lists the aliases that deliver to a mailbox, telling those it is the only target of', async () => {
    safeFetch.mockResolvedValueOnce(answer([
      { address: 'Sales@example.com', goto: 'info@example.com' },
      { address: 'team@example.com', goto: 'desk@example.com,INFO@example.com' },
      { address: 'other@example.com', goto: 'desk@example.com' },
      { address: 'info@example.com', goto: 'info@example.com' },
      { address: '@example.com', goto: 'catchall@example.com' },
    ]));
    expect(await listAliasesTo(CFG, 'info@example.com')).toEqual([
      { address: 'sales@example.com', onlyTarget: true },
      { address: 'team@example.com', onlyTarget: false },
    ]);
    expect(calls()[0].url).toBe('https://mail.example.com/api/v1/get/alias/all');
    safeFetch.mockResolvedValueOnce(answer({}));
    expect(await listAliasesTo(CFG, 'info@example.com')).toEqual([]);
  });

  it('reads what besides the password decides whether a mailbox may sign in', async () => {
    safeFetch.mockResolvedValueOnce(answer({
      username: 'Info@example.com', domain: 'Example.com', active: '2', active_int: 2, authsource: 'keycloak',
      quota: 5368709120, quota_used: 0, attributes: { imap_access: '0', force_pw_update: '1' },
    }));
    expect(await getMailbox(CFG, 'info@example.com')).toEqual({
      email: 'info@example.com', active: false, quotaMb: 5120, usedBytes: 0,
      state: 2, authsource: 'keycloak', imapAccess: false, forcePwUpdate: true, domain: 'example.com',
    });
    // An older mailcow without these fields: the permissive defaults.
    safeFetch.mockResolvedValueOnce(answer({ username: 'info@example.com', active: '1', quota: 0 }));
    expect(await getMailbox(CFG, 'info@example.com')).toMatchObject({
      active: true, state: 1, authsource: 'mailcow', imapAccess: true, forcePwUpdate: false, domain: 'example.com',
    });
    safeFetch.mockResolvedValueOnce(answer({}));
    expect(await getMailbox(CFG, 'gone@example.com')).toBeNull();
  });

  it('sets a new password on a mailbox and changes nothing else', async () => {
    safeFetch.mockResolvedValue(answer(OK));
    const password = await setMailboxPassword(CFG, 'info@example.com');
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(calls()).toHaveLength(1);
    const [edit] = calls();
    expect(edit.url).toBe('https://mail.example.com/api/v1/edit/mailbox');
    expect(edit.method).toBe('POST');
    // Only the password: no active flag (a disabled mailbox stays disabled), no other attribute.
    expect(edit.body).toEqual({ items: ['info@example.com'], attr: { password, password2: password } });
  });

  it('sets the password it is given', async () => {
    safeFetch.mockResolvedValue(answer(OK));
    expect(await setMailboxPassword(CFG, 'info@example.com', 'given-password-1')).toBe('given-password-1');
    expect(calls()[0].body.attr).toEqual({ password: 'given-password-1', password2: 'given-password-1' });
  });

  it('reports a refused password change as a mail node error', async () => {
    safeFetch.mockResolvedValue(answer([{ type: 'danger', msg: ['password_complexity'] }]));
    await expect(setMailboxPassword(CFG, 'info@example.com')).rejects.toMatchObject({ code: 'mail_node_refused' });
  });

  it('lists mailboxes with quota in MB and usage in bytes', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ username: 'Info@example.com', active_int: 1, active: '1', quota: 5368709120, quota_used: 1048576 }]));
    expect(await listMailboxes(CFG)).toEqual([{ email: 'info@example.com', active: true, quotaMb: 5120, usedBytes: 1048576, rateLimit: null }]);
  });

  it('reads the mail disk from status/vmail', async () => {
    safeFetch.mockResolvedValueOnce(answer({ type: 'info', disk: '/dev/sda1', used: '11G', total: '41G', used_percent: '28%' }));
    expect(await getDiskStatus(CFG)).toEqual({ usedPercent: 28, used: '11G', total: '41G' });
    safeFetch.mockResolvedValueOnce(answer({ type: 'info' }));
    expect((await getDiskStatus(CFG).catch((e) => e)).code).toBe('mail_node_failed');
  });
});

describe('node settings requests', () => {
  const path = (call) => call.url.replace('https://mail.example.com/api/v1/', '');

  it('accepts the panel addresses as IPs or networks, never the whole internet', () => {
    expect(parseNetwork(' 203.0.113.10 ')).toBe('203.0.113.10');
    expect(parseNetwork('203.0.113.0/28')).toBe('203.0.113.0/28');
    expect(parseNetwork('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(parseNetwork('2001:DB8::/64')).toBe('2001:db8::/64');
    expect(parseNetwork('2001:db8::/48')).toBe('2001:db8::/48');
    for (const bad of ['0.0.0.0/0', '10.0.0.0/8', '203.0.0.0/23', '::/0', '2001:db8::/47', '203.0.113.10/33', '203.0.113.10/x', 'mail.example.com', '1.2.3.4/24/1', '', null]) {
      expect(parseNetwork(bad), String(bad)).toBeNull();
    }
    expect(parseNetworkList('203.0.113.10, 198.51.100.0/24\n203.0.113.10')).toEqual({ networks: ['203.0.113.10', '198.51.100.0/24'] });
    expect(parseNetworkList(['203.0.113.10'])).toEqual({ networks: ['203.0.113.10'] });
    expect(parseNetworkList('')).toEqual({ networks: [] });
    expect(parseNetworkList('203.0.113.10, nope')).toEqual({ error: 'panel_ips_invalid' });
    expect(parseNetworkList(Array.from({ length: 11 }, (_, i) => `203.0.113.${i}`))).toEqual({ error: 'panel_ips_invalid' });
  });

  it('creates a domain with the DKIM key the mode asks for', async () => {
    safeFetch.mockResolvedValue(answer(OK));
    await addDomain(CFG, { domain: 'a.example', mailboxes: 10, dkimKeySize: 0 });
    await addDomain(CFG, { domain: 'b.example', mailboxes: 10, dkimKeySize: 2048 });
    expect(calls()[0].body).toMatchObject({ key_size: 0, dkim_selector: 'dkim' });
    expect(calls()[1].body).toMatchObject({ key_size: 2048, dkim_selector: 'dkim' });
  });

  it('reads and sets the relayhost of a domain with edit/domain and nothing else', async () => {
    safeFetch.mockResolvedValueOnce(answer({ domain_name: 'a.example', relayhost: '4' })).mockResolvedValueOnce(answer({}));
    expect(await getDomain(CFG, 'a.example')).toEqual({ domain: 'a.example', relayhost: 4 });
    expect(await getDomain(CFG, 'gone.example')).toBeNull();
    safeFetch.mockResolvedValueOnce(answer(OK));
    await setDomainRelayhost(CFG, 'a.example', 4);
    expect(calls().map(path)).toEqual(['get/domain/a.example', 'get/domain/gone.example', 'edit/domain']);
    expect(calls()[2].body).toEqual({ items: ['a.example'], attr: { relayhost: 4 } });
  });

  it('lists TLS policy entries and always sends active when adding or changing one', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ id: 3, dest: 'EOP.example.net', policy: 'Secure', parameters: null, active: '0' }]));
    expect(await listTlsPolicies(CFG)).toEqual([{ id: 3, dest: 'eop.example.net', policy: 'secure', parameters: '', active: false }]);
    safeFetch.mockResolvedValue(answer(OK));
    await addTlsPolicy(CFG, { dest: 'eop.example.net', policy: 'secure', parameters: '' });
    await editTlsPolicy(CFG, 3, { dest: 'eop.example.net', policy: 'encrypt', parameters: '' });
    expect(calls()[1].body).toEqual({ dest: 'eop.example.net', policy: 'secure', parameters: '', active: 1 });
    expect(calls()[2].body).toEqual({ items: [3], attr: { dest: 'eop.example.net', policy: 'encrypt', parameters: '', active: 1 } });
  });

  it('lists relayhosts without their passwords', async () => {
    safeFetch.mockResolvedValueOnce(answer([
      { id: '1', hostname: 'relay.example.net ', username: 'user', password: 'clear-text-secret', active: '1' },
      { id: '2', hostname: 'eop.example.net', username: '', password: '', active: '0' },
    ]));
    const list = await listRelayhosts(CFG);
    expect(list).toEqual([
      { id: 1, hostname: 'relay.example.net', hasLogin: true, active: true, usedByDomains: [], usedByMailboxes: [] },
      { id: 2, hostname: 'eop.example.net', hasLogin: false, active: false, usedByDomains: [], usedByMailboxes: [] },
    ]);
    expect(JSON.stringify(list)).not.toContain('clear-text-secret');
    safeFetch.mockResolvedValueOnce(answer([{ id: 3, hostname: 'eop.example.net', username: '', active: '1', used_by_domains: 'a.example, B.example', used_by_mailboxes: 'x@a.example' }]));
    expect(await listRelayhosts(CFG)).toEqual([
      { id: 3, hostname: 'eop.example.net', hasLogin: false, active: true, usedByDomains: ['a.example', 'b.example'], usedByMailboxes: ['x@a.example'] },
    ]);
    safeFetch.mockResolvedValueOnce(answer(OK));
    await deleteRelayhost(CFG, 3);
    expect(calls().at(-1)).toMatchObject({ url: 'https://mail.example.com/api/v1/delete/relayhost', body: [3] });
  });

  it('reads one domain\'s mailboxes with a longer timeout, and marks a timeout', async () => {
    safeFetch.mockResolvedValueOnce(answer([]));
    await listMailboxes(CFG, { domain: 'a.example' });
    expect(calls()[0].url).toBe('https://mail.example.com/api/v1/get/mailbox/all/a.example');
    safeFetch.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    const slow = await listMailboxes(CFG).catch((e) => e);
    expect(slow).toMatchObject({ code: 'mail_node_unreachable', timeout: true });
    safeFetch.mockRejectedValueOnce(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }));
    expect(await listMailboxes(CFG).catch((e) => e)).toMatchObject({ code: 'mail_node_unreachable', timeout: false });
  });

  it('takes networks out of the fail2ban whitelist with every other field sent back as it was', async () => {
    const f2b = {
      ban_time: 1800, max_ban_time: 10000, ban_time_increment: true, max_attempts: 10, retry_window: 600,
      netban_ipv4: 32, netban_ipv6: 128, manage_external: 0, whitelist: '198.51.100.7\n203.0.113.10', blacklist: '192.0.2.1',
    };
    safeFetch.mockResolvedValueOnce(answer(f2b)).mockResolvedValueOnce(answer([{ type: 'success', msg: 'f2b_modified' }]));
    expect(await unwhitelistFail2ban(CFG, ['203.0.113.10'])).toEqual(['203.0.113.10']);
    expect(calls()[1].body).toEqual({
      items: ['none'],
      attr: {
        ban_time: 1800, max_ban_time: 10000, max_attempts: 10, retry_window: 600, netban_ipv4: 32, netban_ipv6: 128,
        ban_time_increment: '1', manage_external: 0, whitelist: '198.51.100.7', blacklist: '192.0.2.1',
      },
    });
    // Nothing to take out: nothing is written.
    safeFetch.mockReset();
    safeFetch.mockResolvedValueOnce(answer(f2b));
    expect(await unwhitelistFail2ban(CFG, ['192.0.2.50'])).toEqual([]);
    expect(calls()).toHaveLength(1);
  });

  it('joins a DKIM record split in quoted pieces of 255 characters', () => {
    expect(joinTxtChunks('"v=DKIM1;k=rsa;p=AAA" "BBB"')).toBe('v=DKIM1;k=rsa;p=AAABBB');
    expect(joinTxtChunks('v=DKIM1;k=rsa;p=AAA')).toBe('v=DKIM1;k=rsa;p=AAA');
    expect(joinTxtChunks(' "a\\"b" ')).toBe('a"b');
  });

  it('reads the DKIM record of a domain, never the private key, and adds or deletes the key', async () => {
    safeFetch.mockResolvedValueOnce(answer({ pubkey: 'AAA', length: '2048', dkim_txt: '"v=DKIM1;p=AA" "A"', dkim_selector: 'dkim', privkey: 'PRIVATE' }));
    expect(await getDkim(CFG, 'a.example')).toEqual({ selector: 'dkim', name: 'dkim._domainkey.a.example', txt: 'v=DKIM1;p=AAA', length: '2048' });
    safeFetch.mockResolvedValueOnce(answer({}));
    expect(await getDkim(CFG, 'a.example')).toBeNull();
    safeFetch.mockResolvedValue(answer(OK));
    await addDkim(CFG, 'a.example');
    await deleteDkim(CFG, 'a.example');
    expect(calls().slice(2).map((c) => [path(c), c.body])).toEqual([
      ['add/dkim', { domains: 'a.example', dkim_selector: 'dkim', key_size: 2048 }],
      ['delete/dkim', ['a.example']],
    ]);
  });

  it('sets one send limit on several mailboxes and tells the ones the node refused', async () => {
    safeFetch.mockResolvedValueOnce(answer([
      { type: 'success', msg: ['rl_saved', 'a@example.com'] },
      { type: 'danger', msg: 'access_denied' },
    ]));
    expect(await setMailboxRateLimit(CFG, ['a@example.com', 'b@example.com'], { value: 50, frame: 'h' })).toEqual({
      done: ['a@example.com'], failed: ['b@example.com'], reason: 'access_denied',
    });
    expect(calls()[0].body).toEqual({ items: ['a@example.com', 'b@example.com'], attr: { rl_value: '50', rl_frame: 'h' } });
  });

  it('lists the send limit a mailbox has of its own, not the domain\'s', async () => {
    safeFetch.mockResolvedValueOnce(answer([
      { username: 'a@example.com', active: '1', quota: 0, rl: { value: '50', frame: 'h' }, rl_scope: 'mailbox' },
      { username: 'b@example.com', active: '1', quota: 0, rl: { value: '500', frame: 'd' }, rl_scope: 'domain' },
      { username: 'c@example.com', active: '1', quota: 0, rl: false, rl_scope: 'domain' },
    ]));
    expect((await listMailboxes(CFG)).map((m) => m.rateLimit)).toEqual([{ value: 50, frame: 'h' }, null, null]);
  });

  it('gives a taken-over mailbox its send limit too, and a new one in add/mailbox', async () => {
    safeFetch
      .mockResolvedValueOnce(answer({ username: 'info@example.com', active: '1', quota: 0 }))
      .mockResolvedValueOnce(answer(OK))
      .mockResolvedValueOnce(answer([{ type: 'success', msg: ['rl_saved', 'info@example.com'] }]));
    await provisionMailbox(CFG, { localPart: 'info', domain: 'example.com', name: 'Info', rateLimit: { value: 50, frame: 'h' } });
    expect(calls().map(path)).toEqual(['get/mailbox/info%40example.com', 'edit/mailbox', 'edit/rl-mbox']);
    safeFetch.mockReset();
    safeFetch.mockResolvedValueOnce(answer({})).mockResolvedValueOnce(answer(OK));
    await provisionMailbox(CFG, { localPart: 'new', domain: 'example.com', name: 'New', rateLimit: { value: 50, frame: 'h' } });
    expect(calls()[1].body).toMatchObject({ rl_value: '50', rl_frame: 'h' });
  });

  it('reads and writes the prefilter, a failed Dovecot restart being a written rule', async () => {
    safeFetch.mockResolvedValueOnce(answer('# script\n')).mockResolvedValueOnce(answer({}));
    expect(await getPrefilter(CFG)).toBe('# script\n');
    expect(await getPrefilter(CFG)).toBe('');
    safeFetch.mockResolvedValueOnce(answer([{ type: 'success', msg: 'dovecot_restart_success' }, { type: 'success', msg: 'global_filter_written' }]));
    expect(await setPrefilter(CFG, 'keep;\n')).toEqual({ restarted: true });
    expect(calls()[2].body).toEqual({ filter_type: 'prefilter', script_data: 'keep;\n' });
    safeFetch.mockResolvedValueOnce(answer([{ type: 'warning', msg: 'dovecot_restart_failed' }, { type: 'success', msg: 'global_filter_written' }]));
    expect(await setPrefilter(CFG, 'keep;\n')).toEqual({ restarted: false });
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: ['sieve_error', 'line 1'] }]));
    await expect(setPrefilter(CFG, 'bad')).rejects.toMatchObject({ code: 'mail_node_refused', message: 'The mail node refused: sieve_error line 1' });
  });

  it('reads the fail2ban whitelist and adds to it with the whitelist action only', async () => {
    safeFetch.mockResolvedValueOnce(answer({ ban_time: 1800, whitelist: '198.51.100.7\n2001:DB8::/64', blacklist: '' }));
    expect(await getFail2banWhitelist(CFG)).toEqual(['198.51.100.7', '2001:db8::/64']);
    safeFetch.mockResolvedValueOnce(answer([]));
    await expect(getFail2banWhitelist(CFG)).rejects.toMatchObject({ code: 'mail_node_failed' });
    safeFetch.mockResolvedValueOnce(answer([{ type: 'success', msg: ['object_modified', '203.0.113.10'] }]));
    await whitelistFail2ban(CFG, ['203.0.113.10']);
    expect(calls()[2].body).toEqual({ items: ['203.0.113.10'], attr: { action: 'whitelist' } });
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: ['network_host_invalid', 'x'] }]));
    await expect(whitelistFail2ban(CFG, ['x'])).rejects.toMatchObject({ code: 'mail_node_refused' });
  });
});
