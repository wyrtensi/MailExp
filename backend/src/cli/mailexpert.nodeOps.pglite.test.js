import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The panel CLI's mail node operations end to end: node settings and apply, EOP settings and
// budget, EOP seats, the node agent, mailbox deactivation and the domain onboarding steps. The real
// services on PGlite with every migration and a mailcow in memory (services/testing/fakeMailcow.js
// behind safeFetch). What the CLI writes must be what the panel's routes write, journal included,
// with the actor "cli" or the --as administrator; no secret is printed but the agent token issued.

const dbState = vi.hoisted(() => ({ db: null, closed: false }));
const fake = vi.hoisted(() => ({ current: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => (dbState.closed
    ? Promise.reject(new Error('Cannot use a pool after calling end on the pool'))
    : dbState.db.query(sql, params)),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => { dbState.closed = true; } },
  // One process here: the cross-process lock of the apply runs is nodeApply.lock.pglite.test.js's.
  withSessionLock: (_name, fn) => fn(),
}));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: (url, options) => fake.current.fetch(url, options) }));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { createFakeMailcow } = await import('../services/testing/fakeMailcow.js');
const { getMailNodeConfig, saveMailNodeConfig } = await import('../services/mailNode/mailcow.js');
const { getEopSettings, saveEopSettings } = await import('../services/mailNode/eopSettings.js');
const { setTenantDriver } = await import('../services/tenant/driver.js');
const { registerTenantJobKinds } = await import('../services/tenant/tenantJobs.js');
const { registerTenantDomainJobKind } = await import('../services/tenant/tenantDomains.js');
const { finish, run } = await import('./mailexpert.js');

const ADMIN = '63000000-0000-4000-8000-000000000001';
let db;
let mc;

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function cli(argv, { interactive = false, answers = [], stdin = '', ask = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, {
    stdout, stderr, interactive, ask: ask ?? (async () => answers.shift() ?? ''),
    stdinIsTerminal: false, readStdin: async () => stdin,
    sleep: async () => {}, now: Date.now, pollMs: 0,
  });
  return { code, out: stdout.text, err: stderr.text, json: () => JSON.parse(stdout.text) };
}

const audit = async () => (await db.query('SELECT actor_user_id, actor_email, account_email, action, details FROM mailbox_audit_log ORDER BY id')).rows;
const account = async (email) => (await db.query('SELECT * FROM email_accounts WHERE lower(email_address) = $1', [email])).rows[0];
const domainRow = async (domain) => (await db.query('SELECT * FROM mail_node_domains WHERE domain = $1', [domain])).rows[0];
// The journal writes in the background (recordAudit is not awaited): wait for it.
async function auditSettled(count) {
  for (let i = 0; i < 50; i += 1) {
    if ((await audit()).length >= count) return audit();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return audit();
}
const entry = async (action, count = 1) => (await auditSettled(count)).find((e) => e.action === action);

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
  registerTenantJobKinds();
  registerTenantDomainJobKind();
}, 120000);
afterAll(async () => {
  setTenantDriver(undefined);
  await db?.close();
});

beforeEach(async () => {
  dbState.closed = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await db.exec(`DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM account_aliases; DELETE FROM email_accounts;
    DELETE FROM mail_node_domains; DELETE FROM mail_node_seat_assignments; DELETE FROM mail_node_seat_requests;
    DELETE FROM node_agent_jobs; DELETE FROM node_agent; DELETE FROM integration_config;`);
  mc = createFakeMailcow({
    domains: { 'example.com': { relayhost: 0 }, 'new.example': { relayhost: 0 } },
  });
  fake.current = mc;
  setTenantDriver(null);
  await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'node-api-key', quotaMb: 5120, deleteAfterDays: 5, panelIps: [] });
  await saveEopSettings({ eopHost: 'eop.example.net', licenses: 10 });
  await db.query("INSERT INTO mail_node_domains (domain, state, origin) VALUES ('example.com', 'ready', 'created'), ('new.example', 'dns_ok', 'created')");
});

describe('mailexpert node', () => {
  it('shows the node settings without the API key', async () => {
    const shown = await cli(['node', 'config', 'show']);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toMatch(/mail host:\s+mail\.example\.com/);
    expect(shown.out).toMatch(/api key:\s+set/);
    const json = await cli(['node', 'config', 'show', '--json']);
    expect(json.json()).toMatchObject({ configured: true, mailHost: 'mail.example.com', quotaMb: 5120, deleteAfterDays: 5 });
    expect(shown.out + json.out).not.toContain('node-api-key');
  });

  it('changes one setting and keeps the others and the stored key, journaled as "cli"', async () => {
    await saveMailNodeConfig({ ...(await getMailNodeConfig()), diskPingUrl: 'https://hc.example.com/p/1' });
    const result = await cli(['node', 'config', 'set', '--quota', '2048', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(result.json()).toEqual({ ok: true });
    expect(await getMailNodeConfig()).toMatchObject({
      mailHost: 'mail.example.com', apiKey: 'node-api-key', quotaMb: 2048, deleteAfterDays: 5, diskPingUrl: 'https://hc.example.com/p/1',
    });
    expect(await entry('mail_node.config_changed')).toMatchObject({
      actor_user_id: null, actor_email: 'cli', details: { settings: 'node', fields: ['quotaMb'], via: 'cli' },
    });
    expect((await cli(['node', 'config', 'set', '--disk-ping-url', '', '--json'])).code).toBe(0);
    expect((await getMailNodeConfig()).diskPingUrl).toBeNull();
  });

  it('takes a new API key from stdin only, never prints it, and applies the node settings before it ends', async () => {
    const result = await cli(['node', 'config', 'set', '--api-key-stdin'], { stdin: '  fresh-node-key\n' });
    expect(result.code, result.err).toBe(0);
    expect((await getMailNodeConfig()).apiKey).toBe('fresh-node-key');
    expect(result.out + result.err).not.toContain('fresh-node-key');
    expect(result.out).toContain('node settings applied');
    // The apply ran before the answer: the node got the relayhost.
    expect(mc.writes.some((w) => w.path === 'add/relayhost')).toBe(true);
    const entries = await auditSettled(2);
    expect(entries.find((e) => e.action === 'mail_node.config_changed').details).toEqual({ settings: 'node', fields: ['apiKey'], via: 'cli' });
    expect(entries.find((e) => e.action === 'mail_node.applied')).toMatchObject({ actor_email: 'cli', details: { scope: 'node', trigger: 'node_settings', via: 'cli' } });
    expect(JSON.stringify(entries)).not.toContain('fresh-node-key');
    expect((await cli(['node', 'config', 'set', '--api-key-stdin'], { stdin: '  ' })).err).toContain('(api_key_required)');
  });

  it('refuses what the panel refuses: a new host without a key, a bad quota; set takes no show flags', async () => {
    const host = await cli(['node', 'config', 'set', '--mail-host', 'other.example.net', '--json']);
    expect(host.code).toBe(1);
    expect(host.json()).toEqual({ error: 'API key is required', code: 'api_key_required' });
    expect((await cli(['node', 'config', 'set', '--quota', '0'])).err).toContain('(quota_invalid)');
    expect((await getMailNodeConfig()).mailHost).toBe('mail.example.com');
    expect((await cli(['node', 'config', 'show', '--quota', '1'])).code).toBe(2);
    expect((await cli(['node', 'config', 'set'])).code).toBe(2);
    expect((await cli(['node', 'config', 'bogus'])).code).toBe(2);
  });

  it('applies the node settings, one domain\'s, or the spam filing rule after confirmation', async () => {
    const all = await cli(['node', 'apply', '--json']);
    expect(all.code, all.err).toBe(0);
    expect(all.json()).toHaveProperty('node');
    expect((await entry('mail_node.applied'))).toMatchObject({ actor_email: 'cli', details: { scope: 'node', trigger: 'manual', via: 'cli' } });
    const one = await cli(['node', 'apply', '--domain', 'example.com', '--json']);
    expect(one.code, one.err).toBe(0);
    expect(one.json()).toMatchObject({ domain: 'example.com' });
    expect((await cli(['node', 'apply', '--domain', 'nowhere.example'])).err).toContain('(domain_not_found)');
    expect((await cli(['node', 'apply', '--prefilter'])).code).toBe(2);
    const rule = await cli(['node', 'apply', '--prefilter', '--yes', '--json']);
    expect(rule.code, rule.err).toBe(0);
    expect(rule.json()).toMatchObject({ item: 'prefilter' });
    expect((await cli(['node', 'apply', '--prefilter', '--domain', 'example.com', '--yes'])).code).toBe(2);
  });
});

describe('mailexpert eop', () => {
  it('shows and sets the EOP settings, "" clears a field, journaled by field names', async () => {
    const shown = await cli(['eop', 'show', '--json']);
    expect(shown.json()).toMatchObject({ eopHost: 'eop.example.net', licenses: 10, tenantDriver: null });
    const set = await cli(['eop', 'set', '--licenses', '25', '--terrl', '', '--tenant-created-on', '2026-01-15', '--json']);
    expect(set.code, set.err).toBe(0);
    expect(await getEopSettings()).toMatchObject({ licenses: 25, terrl: null, tenantCreatedOn: '2026-01-15' });
    expect(await entry('mail_node.config_changed')).toMatchObject({
      actor_email: 'cli', details: { settings: 'eop', fields: ['licenses', 'tenantCreatedOn'], via: 'cli' },
    });
    expect((await cli(['eop', 'set', '--dkim-mode', 'bogus'])).err).toContain('(dkim_mode_invalid)');
    expect((await cli(['eop', 'set'])).code).toBe(2);
  });

  it('applies a next hop change to the node before it ends', async () => {
    const set = await cli(['eop', 'set', '--eop-host', 'contoso-com.mail.protection.outlook.com', '--json']);
    expect(set.code, set.err).toBe(0);
    expect(set.json()).toMatchObject({ applying: true, apply: { node: expect.any(Array) } });
    expect(mc.writes.some((w) => w.path === 'add/relayhost' && w.body.hostname.includes('contoso-com'))).toBe(true);
  });

  it('shows the TERRL budget', async () => {
    const budget = await cli(['eop', 'budget', '--json']);
    expect(budget.code, budget.err).toBe(0);
    expect(budget.json()).toMatchObject({ limitFrom: 'licenses', used: 0, log: { read: expect.any(Boolean) } });
    expect((await cli(['eop', 'budget'])).out).toMatch(/limit:/);
  });
});

describe('mailexpert seats', () => {
  it('shows the seats, sets the hold period and asks for more, journaled as "cli"', async () => {
    const status = await cli(['seats', 'status', '--json']);
    expect(status.code, status.err).toBe(0);
    expect(status.json()).toMatchObject({ used: 0, held: 0, free: 10, mode: 'manual', holdDays: 90, requests: [] });
    expect((await cli(['seats', 'status'])).out).toMatch(/free:\s+10/);

    const hold = await cli(['seats', 'set-hold', '30', '--json']);
    expect(hold.json()).toEqual({ holdDays: 30 });
    expect(await entry('mail_node.seat_hold_changed')).toMatchObject({ actor_email: 'cli', details: { from: 90, to: 30, via: 'cli' } });
    expect((await cli(['seats', 'set-hold', 'x'])).err).toContain('(hold_days_invalid)');

    const asked = await cli(['seats', 'request', '5', '--json']);
    expect(asked.code, asked.err).toBe(0);
    expect(asked.json().request).toMatchObject({ seats: 5 });
    expect((await cli(['seats', 'status', '--json'])).json().requests).toEqual([expect.objectContaining({ seats: 5 })]);
    expect((await cli(['seats', 'request', '0'])).err).toContain('(seat_count_invalid)');
  });

  it('refuses a reconcile while the number is entered by hand', async () => {
    const check = await cli(['seats', 'check', '--json']);
    expect(check.code).toBe(1);
    expect(check.json().code).toBe('seats_manual');
  });
});

describe('mailexpert agent', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mx-agent-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const storedHash = async () => (await db.query('SELECT token_hash FROM node_agent WHERE id = 1')).rows[0]?.token_hash ?? null;
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

  it('issues the token once: printed for the operator, the panel keeps only its hash', async () => {
    expect((await cli(['agent', 'status', '--json'])).json()).toMatchObject({ configured: false, jobs: [] });
    const issued = await cli(['agent', 'token', 'issue', '--json']);
    expect(issued.code, issued.err).toBe(0);
    const { token } = issued.json();
    expect(token).toMatch(/^mxna_/);
    expect(await storedHash()).toBe(sha(token));
    expect(await entry('mail_node.agent_token_issued')).toMatchObject({ actor_email: 'cli', details: { rotated: false, via: 'cli' } });
    expect(JSON.stringify(await audit())).not.toContain(token);
    // A rotation ends the agent's token: it asks first.
    expect((await cli(['agent', 'token', 'issue'])).code).toBe(2);
    expect(await storedHash()).toBe(sha(token));
    const human = await cli(['agent', 'token', 'issue', '--yes']);
    expect(human.code, human.err).toBe(0);
    const [line] = human.out.split('\n');
    expect(await storedHash()).toBe(sha(line.trim()));
  });

  it('writes the token to --out FILE only (0600, never over a file), or alone to stdout with --out -', async () => {
    const file = join(dir, 'agent-token');
    const written = await cli(['agent', 'token', 'issue', '--out', file]);
    expect(written.code, written.err).toBe(0);
    const token = readFileSync(file, 'utf8').trim();
    expect(await storedHash()).toBe(sha(token));
    expect(written.out + written.err).not.toContain(token);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, 'taken'), 'x');
    const taken = await cli(['agent', 'token', 'issue', '--out', join(dir, 'taken'), '--yes']);
    expect(taken.code).toBe(1);
    expect(taken.err).toContain('(out_file_exists)');
    expect(await storedHash()).toBe(sha(token));
    const raw = await cli(['agent', 'token', 'issue', '--out', '-', '--yes']);
    expect(raw.code, raw.err).toBe(0);
    expect(raw.out).toMatch(/^mxna_[A-Za-z0-9_-]+\n$/);
    expect(await storedHash()).toBe(sha(raw.out.trim()));
    expect((await cli(['agent', 'token', 'issue', '--out', '-', '--json', '--yes'])).code).toBe(2);
  });

  it('writes the token through a temporary file: the target is whole or absent, never partial', async () => {
    await cli(['agent', 'token', 'issue', '--out', '-']);
    const file = join(dir, 'agent-token');
    // The target appears while the rotation is confirmed: the issued token cannot go there.
    const late = await cli(['agent', 'token', 'issue', '--out', file], {
      interactive: true, answers: [], ask: async () => { writeFileSync(file, 'someone else\n'); return 'y'; },
    });
    expect(late.code).toBe(3);
    expect(late.err).toContain('(out_file_failed)');
    expect(late.err).toContain('the old token no longer works');
    expect(readFileSync(file, 'utf8')).toBe('someone else\n');
    expect(readdirSync(dir)).toEqual(['agent-token']);
    // A normal run leaves the target alone in the directory, whole.
    rmSync(file);
    expect((await cli(['agent', 'token', 'issue', '--out', file, '--yes'])).code).toBe(0);
    expect(readdirSync(dir)).toEqual(['agent-token']);
    expect(await storedHash()).toBe(sha(readFileSync(file, 'utf8').trim()));
  });

  it('queues jobs for the agent and lists them; revokes the token after confirmation', async () => {
    expect((await cli(['agent', 'run', 'backup'])).err).toContain('(agent_not_set_up)');
    await cli(['agent', 'token', 'issue', '--out', '-']);
    const queued = await cli(['agent', 'run', 'backup', '--json']);
    expect(queued.code, queued.err).toBe(0);
    expect(queued.json().job).toMatchObject({ kind: 'backup', state: 'queued' });
    expect(await entry('mail_node.agent_job_requested', 2)).toMatchObject({ actor_email: 'cli', details: { kind: 'backup', via: 'cli' } });
    expect((await cli(['agent', 'run', 'backup'])).err).toContain('(job_active)');
    expect((await cli(['agent', 'run', 'bogus'])).code).toBe(2);
    const jobs = await cli(['agent', 'jobs', '--json']);
    expect(jobs.json().jobs.map((j) => j.kind)).toEqual(['backup']);
    expect((await cli(['agent', 'jobs'])).out).toMatch(/backup\s+queued/);

    expect((await cli(['agent', 'token', 'revoke'])).code).toBe(2);
    const revoked = await cli(['agent', 'token', 'revoke', '--yes', '--json']);
    expect(revoked.json()).toEqual({ revoked: true });
    expect(await storedHash()).toBeNull();
    expect(await entry('mail_node.agent_token_revoked', 4)).toMatchObject({ actor_email: 'cli', details: { via: 'cli' } });
    // The job the revocation failed: its code is explained under the table, with the next step.
    const failed = await cli(['agent', 'jobs']);
    expect(failed.out).toMatch(/backup\s+failed/);
    expect(failed.out).toMatch(/agent_revoked: .*revoked.*mailexpert agent token issue/);
    expect((await cli(['agent', 'jobs', '--json'])).json().jobs[0]).toMatchObject({ state: 'failed', error: 'agent_revoked' });
  });
});

describe('mailexpert mailbox deactivate and reactivate', () => {
  it('deactivates with a reason after confirmation, then reactivates, journaled as "cli"', async () => {
    expect((await cli(['mailbox', 'create', 'anna@example.com'])).code).toBe(0);
    expect((await cli(['mailbox', 'deactivate', 'anna@example.com', '--yes'])).code).toBe(2);
    expect((await cli(['mailbox', 'deactivate', 'anna@example.com', '--reason', 'On leave'])).code).toBe(2);
    expect((await account('anna@example.com')).deactivated_at).toBeNull();

    const off = await cli(['mailbox', 'deactivate', 'anna@example.com', '--reason', 'On leave', '--yes', '--json']);
    expect(off.code, off.err).toBe(0);
    expect(off.json()).toMatchObject({ email: 'anna@example.com', deactivation: { reason: 'On leave' } });
    expect(await account('anna@example.com')).toMatchObject({ deactivation_reason: 'On leave' });
    expect(await entry('mailbox.deactivated', 2)).toMatchObject({
      actor_email: 'cli', account_email: 'anna@example.com', details: { reason: 'On leave', seat: 1, via: 'cli' },
    });
    expect((await cli(['seats', 'status', '--json'])).json()).toMatchObject({ used: 0, held: 1 });
    expect((await cli(['mailbox', 'deactivate', 'anna@example.com', '--reason', 'x', '--yes'])).err).toContain('(already_deactivated)');

    const on = await cli(['mailbox', 'reactivate', 'anna@example.com']);
    expect(on.code, on.err).toBe(0);
    expect(on.out).toContain('reactivated anna@example.com');
    expect((await account('anna@example.com')).deactivated_at).toBeNull();
    expect(await entry('mailbox.activated', 3)).toMatchObject({ actor_email: 'cli', details: { seat: 1, via: 'cli' } });
    expect((await cli(['mailbox', 'reactivate', 'anna@example.com'])).err).toContain('(not_deactivated)');
  });
});

describe('mailexpert domain onboarding', () => {
  it('adds a domain on the node with its node settings, journaled as "cli"', async () => {
    const added = await cli(['domain', 'add', 'Brand.example', '--mailboxes', '20', '--json']);
    expect(added.code, added.err).toBe(0);
    expect(added.json()).toMatchObject({ ok: true, domain: 'brand.example', state: 'node_created' });
    expect(mc.writes.find((w) => w.path === 'add/domain').body).toMatchObject({ domain: 'brand.example', mailboxes: 20 });
    expect(await domainRow('brand.example')).toMatchObject({ state: 'node_created', origin: 'created', max_mailboxes: 20 });
    const entries = await auditSettled(2);
    expect(entries.find((e) => e.action === 'mail_node.domain_added')).toMatchObject({ actor_email: 'cli', details: { domain: 'brand.example', mailboxes: 20, via: 'cli' } });
    expect(entries.find((e) => e.action === 'mail_node.applied')).toMatchObject({ details: { scope: 'domain', trigger: 'domain_added', via: 'cli' } });
    expect((await cli(['domain', 'add', 'x.example', '--mailboxes', '0'])).err).toContain('(mailboxes_invalid)');
  });

  it('adopts a domain made on the node by hand, once', async () => {
    mc.node.domains['hand.example'] = { relayhost: 0, created: '2026-10-01 09:00:00' };
    const adopted = await cli(['domain', 'adopt', 'hand.example', '--json']);
    expect(adopted.code, adopted.err).toBe(0);
    expect(await domainRow('hand.example')).toMatchObject({ state: 'node_created', origin: 'adopted', node_created: '2026-10-01 09:00:00' });
    expect(await entry('mail_node.domain_adopted')).toMatchObject({ actor_email: 'cli', details: { domain: 'hand.example', via: 'cli' } });
    expect((await cli(['domain', 'adopt', 'hand.example'])).err).toContain('(domain_known)');
    expect((await cli(['domain', 'adopt', 'nowhere.example'])).err).toContain('(domain_not_on_node)');
  });

  it('confirms the next step only, and marks a domain ready after confirmation', async () => {
    const step = await cli(['domain', 'step', 'new.example', 'tenant_verified', '--json']);
    expect(step.code, step.err).toBe(0);
    expect(step.json()).toEqual({ ok: true, domain: 'new.example', state: 'tenant_verified' });
    expect(await entry('mail_node.domain_state_changed')).toMatchObject({
      actor_email: 'cli', details: { domain: 'new.example', from: 'dns_ok', to: 'tenant_verified', how: 'step_confirmed', via: 'cli' },
    });
    expect((await cli(['domain', 'step', 'new.example', 'connector_ready'])).err).toContain('(step_out_of_order)');
    expect((await cli(['domain', 'step', 'new.example', 'bogus'])).err).toContain('(step_invalid)');
    expect((await cli(['domain', 'ready', 'new.example'])).code).toBe(2);
    const ready = await cli(['domain', 'ready', 'new.example', '--yes']);
    expect(ready.code, ready.err).toBe(0);
    expect((await domainRow('new.example')).state).toBe('ready');
    expect((await cli(['domain', 'ready', 'new.example', '--yes'])).err).toContain('(domain_already_ready)');
  });

  it('accepts the creation time the node reports, the one shown or the one given', async () => {
    mc.node.domains['example.com'].created = '2026-10-02 08:00:00';
    await db.query("UPDATE mail_node_domains SET node_created = '2026-09-01 10:00:00' WHERE domain = 'example.com'");
    expect((await cli(['domain', 'ack', 'example.com', '--created', '2026-10-01 00:00:00'])).err).toContain('(domain_node_changed)');
    expect((await cli(['domain', 'ack', 'example.com'])).code).toBe(2);
    const acked = await cli(['domain', 'ack', 'example.com'], { interactive: true, answers: ['y'] });
    expect(acked.code, acked.err).toBe(0);
    expect(acked.err).toContain('2026-10-02 08:00:00');
    expect((await domainRow('example.com')).node_created).toBe('2026-10-02 08:00:00');
    expect(await entry('mail_node.domain_identity_acknowledged')).toMatchObject({
      actor_email: 'cli', details: { domain: 'example.com', from: '2026-09-01 10:00:00', to: '2026-10-02 08:00:00', via: 'cli' },
    });
    expect((await cli(['domain', 'ack', 'example.com', '--created', '2026-10-02 08:00:00'])).err).toContain('(domain_not_recreated)');
  });

  it('saves the expected DNS values by field, "" clears one, journaled by field names', async () => {
    const saved = await cli(['domain', 'dns-expected', 'new.example', '--mx', 'a.mx.example, b.mx.example', '--tenant-txt', 'MS=ms123', '--json']);
    expect(saved.code, saved.err).toBe(0);
    expect(saved.json()).toMatchObject({ ok: true, domain: 'new.example', fields: ['mx', 'tenantTxt'] });
    expect((await domainRow('new.example')).expected_mx).toEqual(['a.mx.example', 'b.mx.example']);
    expect(await entry('mail_node.config_changed')).toMatchObject({ actor_email: 'cli', details: { settings: 'domain_dns', fields: ['mx', 'tenantTxt'], via: 'cli' } });
    const cleared = await cli(['domain', 'dns-expected', 'new.example', '--tenant-txt', '', '--json']);
    expect(cleared.json().fields).toEqual(['tenantTxt']);
    expect((await cli(['domain', 'dns-expected', 'new.example', '--dkim-cname1', 'not a host'])).err).toContain('(dkim_cname_invalid)');
    expect((await cli(['domain', 'dns-expected', 'new.example'])).code).toBe(2);
  });
});

describe('finish', () => {
  it('ends the pool after the journal writes', async () => {
    await finish();
    expect(dbState.closed).toBe(true);
  });
});
