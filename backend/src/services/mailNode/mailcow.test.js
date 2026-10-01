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
  addDomain,
  deleteMailbox,
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
    expect(await getMailNodeConfig()).toEqual({ mailHost: 'mail.example.com', apiKey: 'api-key-1', quotaMb: 2048, diskPingUrl: null });
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
    expect(await listMailboxes(CFG)).toEqual([{ email: 'info@example.com', active: true, quotaMb: 5120, usedBytes: 1048576 }]);
  });

  it('reads the mail disk from status/vmail', async () => {
    safeFetch.mockResolvedValueOnce(answer({ type: 'info', disk: '/dev/sda1', used: '11G', total: '41G', used_percent: '28%' }));
    expect(await getDiskStatus(CFG)).toEqual({ usedPercent: 28, used: '11G', total: '41G' });
    safeFetch.mockResolvedValueOnce(answer({ type: 'info' }));
    expect((await getDiskStatus(CFG).catch((e) => e)).code).toBe('mail_node_failed');
  });
});
