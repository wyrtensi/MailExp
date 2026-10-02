// The panel's side of applying the node settings, against PGlite with every real migration and a
// mailcow in memory: what a run reads from the panel (domains, their DKIM mode and send limit, the
// mailboxes with an administrator's limit), what it keeps (the node's and each domain's last
// result, the domain's relayhost) and what it journals.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';
import { createFakeMailcow } from '../testing/fakeMailcow.js';

const dbState = { db: null };
const fake = vi.hoisted(() => ({ current: null }));
vi.mock('../db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));
vi.mock('../safeFetch.js', () => ({ safeFetch: (url, options) => fake.current.fetch(url, options) }));

const { applyDomain, applyNode, applyPrefilter, applyQuietly, getNodeApplyResult, newMailboxRateLimit } = await import('./nodeApply.js');
const { saveMailNodeConfig } = await import('./mailcow.js');
const { saveEopSettings } = await import('./eopSettings.js');
const { listDomainRows, restartOnboarding } = await import('./domains.js');

const ADMIN = '61000000-0000-4000-8000-000000000001';
let db;
let mc;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, is_admin) VALUES ($1, 'admin', 'admin@example.com', true)", [ADMIN]);
});
afterAll(async () => { await db?.close(); });

async function addAccount(email, { host = 'mail.example.com', limit = null } = {}) {
  await db.query(
    `INSERT INTO email_accounts (added_by, name, email_address, mail_node, imap_host, node_rl_value, node_rl_frame)
     VALUES ($1, $2, $2, true, $3, $4, $5)`,
    [ADMIN, email, host, limit?.value ?? null, limit?.frame ?? null],
  );
}

beforeEach(async () => {
  for (const table of ['mail_node_domains', 'mailbox_audit_log', 'email_accounts', 'integration_config']) await db.query(`DELETE FROM ${table}`);
  mc = createFakeMailcow({
    domains: { 'a.example': { relayhost: 0 }, 'b.example': { relayhost: 0 }, 'hand.example': { relayhost: 0 } },
    dkim: { 'a.example': { pub: 'PUBA', selector: 'dkim' } },
    mailboxes: [{ username: 'one@a.example' }, { username: 'two@a.example' }, { username: 'three@b.example' }],
  });
  fake.current = mc;
  await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, panelIps: ['203.0.113.10'] });
  await saveEopSettings({ eopHost: 'eop.example.net' });
  await db.query("INSERT INTO mail_node_domains (domain, state) VALUES ('a.example', 'node_created'), ('b.example', 'ready'), ('gone.example', 'ready')");
  await db.query("UPDATE mail_node_domains SET dkim_mode = 'eop', mailbox_send_limit = 20 WHERE domain = 'b.example'");
  mc.node.dkim['b.example'] = { pub: 'PUBB', selector: 'dkim' };
  await addAccount('one@a.example', { limit: { value: 300, frame: 'd' } });
  await addAccount('Two@a.example');
  await addAccount('three@b.example');
  await addAccount('moved@a.example', { host: 'old-node.example.com' });
});

const audit = async () => (await db.query('SELECT actor_user_id, action, details FROM mailbox_audit_log ORDER BY id')).rows;
const domainRow = async (domain) => (await db.query('SELECT apply_result, applied_at, relayhost_id FROM mail_node_domains WHERE domain = $1', [domain])).rows[0];

describe('the columns (migration 0082)', () => {
  it('takes a mailbox limit only as a positive value with a frame, or none', async () => {
    await expect(db.query("UPDATE email_accounts SET node_rl_value = 0, node_rl_frame = 'h'")).rejects.toThrow();
    await expect(db.query("UPDATE email_accounts SET node_rl_value = 5, node_rl_frame = 'w'")).rejects.toThrow();
    await expect(db.query('UPDATE email_accounts SET node_rl_value = 5, node_rl_frame = NULL')).rejects.toThrow();
    await db.query("UPDATE email_accounts SET node_rl_value = 5, node_rl_frame = 's'");
    await db.query('UPDATE email_accounts SET node_rl_value = NULL, node_rl_frame = NULL');
  });
});

describe('applyNode', () => {
  it('applies the node and every domain the panel knows and the node lists, keeps the results and journals the changes', async () => {
    const result = await applyNode({ userId: ADMIN });
    expect(result.node.map((i) => [i.item, i.status])).toEqual([
      ['tls_policy', 'changed'], ['relayhost', 'changed'], ['fail2ban', 'changed'], ['prefilter', 'pending'],
      ['forwarding_hosts', 'skipped'],
    ]);
    // gone.example is not on the node; hand.example has no row: neither is touched.
    expect(result.domains.map((d) => d.domain)).toEqual(['a.example', 'b.example']);
    expect(mc.node.domains['hand.example'].relayhost).toBe(0);

    // Mailboxes on this node only, by the panel's limit or the domain's default.
    expect(mc.node.mailboxes.map((m) => [m.username, m.rl])).toEqual([
      ['one@a.example', { value: '300', frame: 'd' }],
      ['two@a.example', { value: '50', frame: 'h' }],
      ['three@b.example', { value: '20', frame: 'h' }],
    ]);
    // b.example has the tenant sign: its key waits for the administrator.
    const b = result.domains[1];
    expect(b.items.find((i) => i.item === 'dkim')).toMatchObject({ status: 'skipped', code: 'dkim_delete_unconfirmed' });
    expect(mc.node.dkim['b.example']).toBeDefined();

    // With what the panel itself made on the node, to take it away when the EOP host changes.
    expect(await getNodeApplyResult()).toEqual({
      at: result.at, items: result.node,
      owned: { tls: [{ id: 1, dest: 'eop.example.net' }], relayhosts: [{ id: 2, hostname: 'eop.example.net' }], fail2ban: ['203.0.113.10'], fwdhosts: [] },
    });
    const a = await domainRow('a.example');
    expect(a.relayhost_id).toBe(mc.node.relayhosts[0].id);
    expect(a.apply_result.items.map((i) => i.status)).toEqual(['changed', 'ok', 'changed']);
    expect(a.apply_result.dkim).toMatchObject({ name: 'dkim._domainkey.a.example', txt: 'v=DKIM1;k=rsa;t=s;s=email;p=PUBA' });
    expect(new Date(a.applied_at).toISOString()).toBe(result.at);
    const [row] = (await listDomainRows()).filter((d) => d.domain === 'a.example');
    expect(row.apply).toEqual({ at: a.applied_at, items: a.apply_result.items, dkim: a.apply_result.dkim });

    const [entry] = await audit();
    expect(entry.action).toBe('mail_node.applied');
    expect(entry.actor_user_id).toBe(ADMIN);
    expect(entry.details).toMatchObject({ scope: 'node', trigger: 'manual', failed: [] });
    expect(entry.details.changed.map((c) => [c.item, c.target])).toEqual([
      ['tls_policy', 'eop.example.net'], ['relayhost', 'eop.example.net'], ['fail2ban', '203.0.113.10'],
      ['domain_relayhost', 'a.example'], ['mailbox_limits', 'a.example'], ['domain_relayhost', 'b.example'], ['mailbox_limits', 'b.example'],
    ]);
    expect(entry.details.changed.find((c) => c.item === 'mailbox_limits').counts).toMatchObject({ changed: 2 });
    expect(JSON.stringify(entry.details)).not.toContain('apiKey');

    // Again: nothing to change, nothing journaled.
    mc.writes.length = 0;
    const again = await applyNode({ userId: ADMIN, trigger: 'eop_settings' });
    expect(again.node.map((i) => i.status)).toEqual(['ok', 'ok', 'ok', 'pending', 'skipped']);
    expect(mc.writes).toEqual([]);
    expect(await audit()).toHaveLength(1);
  });

  it('journals a run that failed, keeps the result and answers it', async () => {
    mc.node.down = true;
    const result = await applyNode({ userId: ADMIN, trigger: 'eop_settings' });
    expect(result.node.every((i) => i.status === 'failed' && i.code === 'mail_node_unreachable')).toBe(true);
    // The node could not list its domains: no domain is touched.
    expect(result.domains).toEqual([]);
    const [entry] = await audit();
    expect(entry.details).toMatchObject({ scope: 'node', trigger: 'eop_settings', changed: [] });
    expect(entry.details.failed).toHaveLength(5);
  });

  it('refuses before the node is set up; a run started by itself never fails what started it', async () => {
    await db.query('DELETE FROM integration_config');
    await expect(applyNode({ userId: ADMIN })).rejects.toMatchObject({ code: 'mail_node_not_configured' });
    expect(await applyQuietly(() => applyNode({ userId: ADMIN }))).toBeNull();
  });

  it('removes what it made for the previous EOP host on the next run, keeping the record across runs', async () => {
    await applyNode({ userId: ADMIN });
    await saveEopSettings({ eopHost: 'new.example.net' });
    const moved = await applyNode({ userId: ADMIN, trigger: 'eop_settings' });
    expect(moved.node.filter((i) => i.item.startsWith('previous_')).map((i) => [i.item, i.status])).toEqual([
      ['previous_tls_policy', 'changed'], ['previous_relayhost', 'changed'],
    ]);
    expect(mc.node.tls.map((t) => t.dest)).toEqual(['new.example.net']);
    expect(mc.node.relayhosts.map((r) => r.hostname)).toEqual(['new.example.net']);
    // A domain run keeps the record a node run made.
    await applyDomain({ domain: 'a.example', userId: ADMIN });
    expect((await getNodeApplyResult()).owned.relayhosts).toEqual([{ id: 4, hostname: 'new.example.net' }]);
  });

  it('applies one limit per address when the panel holds a mailbox twice, the administrator\'s first', async () => {
    await addAccount('two@a.example', { limit: { value: 7, frame: 'm' } });
    await applyDomain({ domain: 'a.example', userId: ADMIN });
    expect(mc.node.mailboxes.find((m) => m.username === 'two@a.example').rl).toEqual({ value: '7', frame: 'm' });
    expect(mc.writes.filter((w) => w.path === 'edit/rl-mbox').flatMap((w) => w.body.items).filter((e) => e === 'two@a.example')).toHaveLength(1);
  });

  it('never runs twice at once: the relayhost is added once', async () => {
    await Promise.all([applyNode({ userId: ADMIN }), applyNode({ userId: ADMIN }), applyDomain({ domain: 'a.example', userId: ADMIN })]);
    expect(mc.node.relayhosts).toHaveLength(1);
    expect(mc.writes.filter((w) => w.path === 'add/relayhost')).toHaveLength(1);
  });
});

describe('applyDomain', () => {
  it('applies one domain, and deletes the key of a domain the tenant signs once confirmed', async () => {
    let result = await applyDomain({ domain: 'b.example', userId: ADMIN, trigger: 'domain_adopted' });
    expect(result.items.map((i) => [i.item, i.status])).toEqual([['domain_relayhost', 'changed'], ['dkim', 'skipped'], ['mailbox_limits', 'changed']]);
    // A domain run does not report the node items, though it adds the relayhost it needs.
    expect(mc.node.relayhosts).toHaveLength(1);
    expect(mc.node.tls).toEqual([]);
    result = await applyDomain({ domain: 'b.example', userId: ADMIN, confirmDkimDelete: true });
    expect(result.items.find((i) => i.item === 'dkim')).toMatchObject({ status: 'changed', from: 'dkim', to: null });
    expect(mc.node.dkim['b.example']).toBeUndefined();
    const entries = await audit();
    expect(entries.map((e) => [e.details.scope, e.details.domain, e.details.trigger])).toEqual([
      ['domain', 'b.example', 'domain_adopted'], ['domain', 'b.example', 'manual'],
    ]);
    expect(entries[1].details.changed).toEqual([{ item: 'dkim', target: 'b.example', from: 'dkim', to: null }]);
    await expect(applyDomain({ domain: 'hand.example', userId: ADMIN })).rejects.toMatchObject({ code: 'domain_not_found' });
  });

  it('loses its result when the onboarding starts over', async () => {
    await applyDomain({ domain: 'a.example', userId: ADMIN });
    await db.query("UPDATE mail_node_domains SET state = 'dns_ok' WHERE domain = 'a.example'");
    await restartOnboarding({ domain: 'a.example', userId: ADMIN });
    expect(await domainRow('a.example')).toEqual({ apply_result: null, applied_at: null, relayhost_id: null });
  });
});

describe('applyPrefilter', () => {
  it('writes the rule, then the forwarding hosts that waited for it, keeps both with the node result and journals them', async () => {
    await applyNode({ userId: ADMIN });
    const ranges = { version: '2026081400', ipv4: ['40.92.0.0/15'], ipv6: [] };
    const item = await applyPrefilter({ userId: ADMIN, ranges });
    expect(item).toMatchObject({ item: 'prefilter', status: 'changed' });
    const stored = await getNodeApplyResult();
    expect(stored.items.map((i) => [i.item, i.status])).toEqual([
      ['tls_policy', 'changed'], ['relayhost', 'changed'], ['fail2ban', 'changed'], ['prefilter', 'changed'],
      ['forwarding_hosts', 'changed'],
    ]);
    expect(stored.owned.fwdhosts).toEqual(['40.92.0.0/15']);
    expect(mc.node.fwdhosts).toEqual([{ host: '40.92.0.0/15', source: '40.92.0.0/15', keepSpam: false }]);
    expect((await applyPrefilter({ userId: ADMIN, ranges })).status).toBe('ok');
    expect(mc.writes.filter((w) => w.path === 'add/global-filter')).toHaveLength(1);
    expect(mc.writes.filter((w) => w.path === 'add/fwdhost')).toHaveLength(1);
    const entries = (await audit()).filter((e) => e.details.scope === 'prefilter');
    expect(entries).toHaveLength(1);
    expect(entries[0].details.changed).toEqual([
      { item: 'prefilter', target: null },
      { item: 'forwarding_hosts', target: '2026081400', from: null, to: '40.92.0.0/15' },
    ]);
    // The next run of everything takes the static list: it adds the other ranges and keeps this one.
    const again = await applyNode({ userId: ADMIN });
    expect(again.node.find((i) => i.item === 'forwarding_hosts')).toMatchObject({ status: 'changed', fwdhosts: { wanted: 6, missing: [] } });
    expect((await getNodeApplyResult()).owned.fwdhosts).toHaveLength(6);
  });

  it('answers how the forwarding hosts went, and journals ranges added before a refusal', async () => {
    const fetch = mc.fetch;
    let adds = 0;
    fake.current = {
      ...mc,
      fetch: (url, options) => (url.endsWith('add/fwdhost') && ++adds === 2
        ? Promise.resolve({ status: 200, ok: true, json: async () => [{ type: 'danger', msg: 'redis_error' }] })
        : fetch(url, options)),
    };
    const item = await applyPrefilter({ userId: ADMIN, ranges: { version: '2026081400', ipv4: ['40.92.0.0/15', '40.107.0.0/16'], ipv6: [] } });
    expect(item.forwardingHosts).toEqual({ status: 'failed', code: 'mail_node_refused' });
    const [entry] = (await audit()).filter((e) => e.details.scope === 'prefilter');
    expect(entry.details.failed).toEqual([{ item: 'forwarding_hosts', target: '2026081400', code: 'mail_node_refused', from: null, to: '40.92.0.0/15' }]);
    expect((await getNodeApplyResult()).owned.fwdhosts).toEqual(['40.92.0.0/15']);
  });

  it('adds no forwarding hosts when the rule could not be written', async () => {
    mc.node.refuse['add/global-filter'] = 'sieve_error';
    expect(await applyPrefilter({ userId: ADMIN })).toMatchObject({ status: 'failed', forwardingHosts: null });
    expect(mc.writes.filter((w) => w.path === 'add/fwdhost')).toEqual([]);
  });
});

describe('newMailboxRateLimit', () => {
  it('gives a new mailbox the domain\'s limit, else the EOP settings\' one, per hour', async () => {
    expect(await newMailboxRateLimit('b.example')).toEqual({ value: 20, frame: 'h' });
    expect(await newMailboxRateLimit('a.example')).toEqual({ value: 50, frame: 'h' });
    await saveEopSettings({ sendLimitPerHour: 80 });
    expect(await newMailboxRateLimit('unknown.example')).toEqual({ value: 80, frame: 'h' });
  });
});
