import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel CLI's mail node operations of the node screens end to end: the DNS check, quotas and
// send limits, the mail queue, the alerts, the outage windows and the node's (rspamd) quarantine.
// The real services on PGlite with every migration and a mailcow in memory
// (services/testing/fakeMailcow.js behind safeFetch). What the CLI writes must be what the panel's
// routes write, journal included, with the actor "cli" or the --as administrator. The checks that
// belong to the backend's process are queued as mail_node_check jobs; the test runs the backend's
// worker for them.

const dbState = vi.hoisted(() => ({ db: null, closed: false }));
const fake = vi.hoisted(() => ({ current: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => (dbState.closed
    ? Promise.reject(new Error('Cannot use a pool after calling end on the pool'))
    : dbState.db.query(sql, params)),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => { dbState.closed = true; } },
  withSessionLock: (_name, fn) => fn(),
}));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: (url, options) => fake.current.fetch(url, options) }));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { createFakeMailcow } = await import('../services/testing/fakeMailcow.js');
const { saveMailNodeConfig } = await import('../services/mailNode/mailcow.js');
const { saveEopSettings } = await import('../services/mailNode/eopSettings.js');
const { getAlertSettings } = await import('../services/mailNode/nodeAlerts.js');
const { getOutageSettings } = await import('../services/mailNode/outages.js');
const { getQuarantineUserView } = await import('../services/mailNode/quarantine.js');
const { NODE_CHECK_JOB_KIND, registerNodeCheckJobKind } = await import('../services/mailNode/nodeChecks.js');
const { setTenantDriver } = await import('../services/tenant/driver.js');
const { claimDueJobs, runJob } = await import('../services/jobQueue.js');
const { run } = await import('./mailexpert.js');

const ADMIN = '63000000-0000-4000-8000-000000000001';
const ACCOUNT = '63000000-0000-4000-8000-0000000000a1';
let db;
let mc;

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function runDue() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}

async function cli(argv, { interactive = false, answers = [] } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, {
    stdout, stderr, interactive, ask: async () => answers.shift() ?? '',
    stdinIsTerminal: false, readStdin: async () => '',
    sleep: runDue, now: Date.now, pollMs: 0,
  });
  return { code, out: stdout.text, err: stderr.text, json: () => JSON.parse(stdout.text) };
}

const audit = async () => (await db.query('SELECT actor_user_id, actor_email, account_id, account_email, action, details FROM mailbox_audit_log ORDER BY id')).rows;
async function auditSettled(count) {
  for (let i = 0; i < 50; i += 1) {
    if ((await audit()).length >= count) return audit();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return audit();
}
const entry = async (action, count = 1) => (await auditSettled(count)).find((e) => e.action === action);
const jobs = async () => (await db.query('SELECT kind, status, payload, created_by, error_code FROM jobs ORDER BY id')).rows;

const QUEUED = {
  queue_id: '53A99193F13', queue_name: 'deferred', arrival_time: Math.floor(Date.now() / 1000) - 600, message_size: 360,
  sender: 'someone@stage.test', recipients: ['anna@example.com (451 4.7.500 Server busy)'],
};
const POSTCAT = [
  '*** ENVELOPE RECORDS deferred/5/53A99193F13 ***', 'sender: someone@stage.test', 'recipient: anna@example.com',
  '*** MESSAGE CONTENTS deferred/5/53A99193F13 ***', 'Subject: hello', 'From: someone@stage.test', '', 'Body text.',
  '*** HEADER EXTRACTED deferred/5/53A99193F13 ***', '*** MESSAGE FILE END deferred/5/53A99193F13 ***',
].join('\n');
const QITEM = {
  id: 7, qid: 'QID7', subject: 'Cheap watches', score: 12.5, sender: 'spam@bad.test', rcpt: 'anna@example.com', action: 'reject',
  created: Math.floor(Date.now() / 1000) - 60, notified: 0, virus_flag: 0, symbols: '[]', msg: 'Subject: Cheap watches\r\n\r\nBuy now',
};

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
  registerNodeCheckJobKind();
  // No DNS lookups from the tests: a resolver setting that is no address makes every check a
  // lookup failure, which is journaled like any manual check.
  process.env.DNS_CHECK_RESOLVER = 'not-an-address';
}, 120000);
afterAll(async () => {
  delete process.env.DNS_CHECK_RESOLVER;
  setTenantDriver(undefined);
  await db?.close();
});

beforeEach(async () => {
  dbState.closed = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await db.exec(`DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM email_accounts; DELETE FROM mail_node_domains;
    DELETE FROM mail_node_outage_letters; DELETE FROM mail_node_outages; DELETE FROM integration_config;`);
  mc = createFakeMailcow({
    domains: { 'example.com': { relayhost: 0 } },
    mailboxes: [{ username: 'anna@example.com', rl: null }],
    queue: [{ ...QUEUED }],
    postcat: { '53A99193F13': POSTCAT },
    quarantine: [{ ...QITEM }],
  });
  fake.current = mc;
  setTenantDriver(null);
  await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'node-api-key', quotaMb: 5120, deleteAfterDays: 5, panelIps: [] });
  await saveEopSettings({ eopHost: 'eop.example.net', licenses: 10 });
  await db.query("INSERT INTO mail_node_domains (domain, state, origin) VALUES ('example.com', 'ready', 'created')");
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, imap_host, imap_port, smtp_host, smtp_port, auth_user, auth_pass, mail_node)
     VALUES ($1, 'Anna', 'anna@example.com', 'mail.example.com', 993, 'mail.example.com', 465, 'anna@example.com', 'enc:x', true)`,
    [ACCOUNT],
  );
});

describe('mailexpert domain dns-check', () => {
  it('checks one domain at once, journaled as "cli"', async () => {
    const result = await cli(['domain', 'dns-check', 'example.com', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(result.json()).toMatchObject({ domain: 'example.com', lookupFailed: { code: 'dns_resolver_invalid' } });
    expect(await entry('mail_node.dns_checked')).toMatchObject({
      actor_user_id: null, actor_email: 'cli', details: { scope: 'domain', domain: 'example.com', lookupFailed: true, via: 'cli' },
    });
    expect((await cli(['domain', 'dns-check', 'nowhere.example'])).err).toContain('(domain_not_found)');
    expect((await cli(['domain', 'dns-check', 'not a domain'])).code).toBe(2);
    expect((await cli(['domain', 'dns-check', 'example.com', '--wait'])).code).toBe(2);
  });

  it('queues the check of the node and every domain for the backend, which journals it with the CLI\'s actor', async () => {
    const queued = await cli(['domain', 'dns-check', '--json']);
    expect(queued.code, queued.err).toBe(0);
    expect(queued.json()).toMatchObject({ job: { kind: NODE_CHECK_JOB_KIND, status: 'queued' } });
    expect(await jobs()).toEqual([expect.objectContaining({ kind: NODE_CHECK_JOB_KIND, payload: { check: 'dns', via: 'cli' }, created_by: null })]);
    await db.exec('DELETE FROM jobs');
    const waited = await cli(['domain', 'dns-check', '--wait', '--as', 'admin@example.com']);
    expect(waited.code, waited.err).toBe(0);
    expect(waited.out).toMatch(/node: lookup failed \(dns_resolver_invalid\)/);
    expect(await entry('mail_node.dns_checked')).toMatchObject({ actor_user_id: ADMIN, details: { scope: 'all', via: 'cli' } });
  });

  it('refuses without a mail node', async () => {
    await db.exec("DELETE FROM integration_config WHERE provider = 'mail_node'");
    expect((await cli(['domain', 'dns-check'])).err).toContain('(mail_node_not_configured)');
  });
});

describe('mailexpert mailbox set-quota and set-rate-limit', () => {
  it('sets the quota on the node and journals it with the quota before', async () => {
    const result = await cli(['mailbox', 'set-quota', 'anna@example.com', '2048', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(result.json()).toEqual({ ok: true, quotaMb: 2048 });
    expect(mc.node.mailboxes[0].quota).toBe(2048 * 1024 * 1024);
    expect(await entry('mailbox.quota_changed')).toMatchObject({
      account_id: ACCOUNT, actor_email: 'cli', details: { quotaMb: 2048, from: 5120, via: 'cli' },
    });
    expect((await cli(['mailbox', 'set-quota', 'anna@example.com', '0'])).err).toContain('(quota_invalid)');
    expect((await cli(['mailbox', 'set-quota', 'nobody@example.com', '10'])).err).toContain('(mailbox_not_found)');
  });

  it('sets an own send limit, and "default" goes back to the default', async () => {
    const own = await cli(['mailbox', 'set-rate-limit', 'anna@example.com', '50/h', '--json']);
    expect(own.code, own.err).toBe(0);
    expect(own.json()).toEqual({ ok: true, rateLimit: { value: 50, frame: 'h' }, rateLimitOverride: { value: 50, frame: 'h' } });
    expect(mc.node.mailboxes[0].rl).toEqual({ value: '50', frame: 'h' });
    expect((await db.query('SELECT node_rl_value, node_rl_frame FROM email_accounts WHERE id = $1', [ACCOUNT])).rows[0])
      .toEqual({ node_rl_value: 50, node_rl_frame: 'h' });
    expect(await entry('mailbox.rate_limit_changed')).toMatchObject({
      account_id: ACCOUNT, actor_email: 'cli', details: { value: 50, frame: 'h', override: true, from: null, via: 'cli' },
    });
    const back = await cli(['mailbox', 'set-rate-limit', ACCOUNT, 'default']);
    expect(back.code, back.err).toBe(0);
    expect(back.out).toMatch(/send limit \d+\/[smhd] \(default\)/);
    expect((await db.query('SELECT node_rl_value FROM email_accounts WHERE id = $1', [ACCOUNT])).rows[0].node_rl_value).toBeNull();
    expect((await cli(['mailbox', 'set-rate-limit', 'anna@example.com', '50/w'])).code).toBe(2);
    expect((await cli(['mailbox', 'set-rate-limit', 'anna@example.com', '0/h'])).err).toContain('(rate_limit_invalid)');
  });
});

describe('mailexpert queue', () => {
  it('lists the queue and shows a message, journaling only a body read', async () => {
    const list = await cli(['queue', 'list']);
    expect(list.code, list.err).toBe(0);
    expect(list.out).toMatch(/53A99193F13\s+deferred/);
    expect(list.out).toContain('451 4.7.500 Server busy');
    expect((await cli(['queue', 'list', '--json'])).json()).toMatchObject({ total: 1, counts: { deferred: 1 } });
    const shown = await cli(['queue', 'show', '53a99193f13']);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain('Subject: hello');
    expect(shown.out).not.toContain('Body text.');
    expect(await audit()).toEqual([]);
    const body = await cli(['queue', 'show', '53A99193F13', '--body', '--json']);
    expect(body.json().body).toBe('Body text.');
    expect(await entry('mail_node.queue_action')).toMatchObject({ actor_email: 'cli', details: { action: 'view_body', queueId: '53A99193F13', via: 'cli' } });
    expect((await cli(['queue', 'show', 'ABCDEF1234'])).err).toContain('(queue_item_not_found)');
    expect((await cli(['queue', 'show', 'ALL'])).err).toContain('(queue_id_invalid)');
  });

  it('holds, releases and delivers a message, journaled with its envelope', async () => {
    expect((await cli(['queue', 'hold', '53A99193F13'])).code).toBe(0);
    expect(mc.node.queue[0].queue_name).toBe('hold');
    expect((await cli(['queue', 'deliver', '53A99193F13'])).err).toContain('(queue_item_held)');
    expect((await cli(['queue', 'release', '53A99193F13'])).code).toBe(0);
    expect(mc.node.queue[0].queue_name).toBe('deferred');
    expect((await cli(['queue', 'deliver', '53A99193F13'])).code).toBe(0);
    const entries = (await auditSettled(3)).filter((e) => e.action === 'mail_node.queue_action');
    expect(entries.map((e) => e.details.action)).toEqual(['hold', 'unhold', 'deliver']);
    expect(entries[0].details).toMatchObject({ queueId: '53A99193F13', sender: 'someone@stage.test', recipients: ['anna@example.com'], via: 'cli' });
  });

  it('asks before flushing and deleting', async () => {
    expect((await cli(['queue', 'flush'])).code).toBe(2);
    expect((await cli(['queue', 'delete', '53A99193F13'])).code).toBe(2);
    expect((await cli(['queue', 'delete', '53A99193F13'], { interactive: true, answers: ['n'] })).code).toBe(1);
    expect(mc.node.queue).toHaveLength(1);
    expect((await cli(['queue', 'flush', '--yes'])).code).toBe(0);
    expect(mc.node.flushed).toBe(1);
    expect((await cli(['queue', 'delete', '53A99193F13', '--yes'])).code).toBe(0);
    expect(mc.node.queue).toEqual([]);
    const entries = (await auditSettled(2)).filter((e) => e.action === 'mail_node.queue_action');
    expect(entries.map((e) => e.details.action)).toEqual(['flush', 'delete']);
  });
});

describe('mailexpert alerts', () => {
  it('shows the alerts and their settings, and changes the settings journaled by field names', async () => {
    const status = await cli(['alerts', 'status', '--json']);
    expect(status.code, status.err).toBe(0);
    expect(status.json()).toMatchObject({ state: null, settings: { deferredCount: 20 }, defaults: { deferredCount: 20 } });
    expect((await cli(['alerts', 'status'])).out).toContain('no check yet');
    const set = await cli(['alerts', 'set', '--deferred-count', '5', '--ping-url', 'https://hc.example.com/p/alerts', '--json']);
    expect(set.code, set.err).toBe(0);
    expect(await getAlertSettings()).toMatchObject({ deferredCount: 5, pingUrl: 'https://hc.example.com/p/alerts' });
    expect(await entry('mail_node.config_changed')).toMatchObject({
      actor_email: 'cli', details: { settings: 'alerts', fields: ['pingUrl', 'deferredCount'], via: 'cli' },
    });
    expect((await cli(['alerts', 'set', '--ping-url', 'http://insecure'])).err).toContain('(ping_url_invalid)');
    expect((await cli(['alerts', 'set'])).code).toBe(2);
  });

  it('queues a check for the backend and, with --wait, prints the run', async () => {
    const result = await cli(['alerts', 'check', '--wait', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(result.json()).toMatchObject({ job: { kind: NODE_CHECK_JOB_KIND, status: 'done' }, state: { trigger: 'manual' } });
    expect((await jobs())[0]).toMatchObject({ payload: { check: 'alerts', via: 'cli' }, status: 'done' });
  });
});

describe('mailexpert outage', () => {
  it('opens, changes, closes and deletes a window, each journaled as "cli"', async () => {
    const opened = await cli(['outage', 'open', '--start', '2026-10-01T10:00:00Z', '--reason', 'Disk replacement', '--planned', '--json']);
    expect(opened.code, opened.err).toBe(0);
    const { id } = opened.json().window;
    expect(opened.json().window).toMatchObject({ open: true, planned: true, reason: 'Disk replacement', source: 'manual' });
    const list = await cli(['outage', 'list']);
    expect(list.out).toContain(id);
    expect((await cli(['outage', 'show', id, '--json'])).json()).toMatchObject({ window: { id, open: true } });
    const changed = await cli(['outage', 'update', id, '--start', '2026-10-01T09:50:00Z', '--reason', 'Started early', '--json']);
    expect(changed.json().window.startedAt).toBe('2026-10-01T09:50:00.000Z');
    expect((await cli(['outage', 'update', id, '--start', '2026-10-01T09:00:00Z'])).code).toBe(2);
    const closed = await cli(['outage', 'close', id, '--end', '2026-10-01T11:00:00Z', '--reason', 'Done', '--json']);
    expect(closed.json().window).toMatchObject({ open: false, endedAt: '2026-10-01T11:00:00.000Z' });
    expect((await cli(['outage', 'close', id, '--reason', 'again'])).err).toContain('(outage_already_closed)');
    expect((await cli(['outage', 'letters', id, '--json'])).json()).toMatchObject({ window: { id }, letters: [] });
    expect((await cli(['outage', 'delete', id, '--reason', 'Marked twice'])).code).toBe(2);
    expect((await cli(['outage', 'delete', id, '--reason', 'Marked twice', '--yes'])).code).toBe(0);
    expect((await cli(['outage', 'show', id])).err).toContain('(outage_not_found)');
    const actions = (await auditSettled(4)).map((e) => [e.action, e.actor_email, e.details.via]);
    expect(actions).toEqual([
      ['mail_node.outage_added', 'cli', 'cli'], ['mail_node.outage_changed', 'cli', 'cli'],
      ['mail_node.outage_closed', 'cli', 'cli'], ['mail_node.outage_deleted', 'cli', 'cli'],
    ]);
    expect((await cli(['outage', 'open', '--start', 'yesterday', '--reason', 'x'])).err).toContain('(outage_start_invalid)');
    expect((await cli(['outage', 'show', 'not-an-id'])).err).toContain('(outage_not_found)');
  });

  it('shows and sets how long letters are kept', async () => {
    expect((await cli(['outage', 'settings', 'show', '--json'])).json()).toMatchObject({ settings: { retentionDays: 30 } });
    const set = await cli(['outage', 'settings', 'set', '--retention-days', '14', '--json']);
    expect(set.code, set.err).toBe(0);
    expect(await getOutageSettings()).toEqual({ retentionDays: 14 });
    expect(await entry('mail_node.config_changed')).toMatchObject({ details: { settings: 'outages', fields: ['retentionDays'], via: 'cli' } });
    expect((await cli(['outage', 'settings', 'set', '--retention-days', '0'])).err).toContain('(retention_days_invalid)');
    expect((await cli(['outage', 'settings', 'set'])).code).toBe(2);
  });

  it('queues a pass of the trace for the backend', async () => {
    const result = await cli(['outage', 'trace', '--wait', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(result.json()).toMatchObject({ job: { kind: NODE_CHECK_JOB_KIND, status: 'done' } });
    expect((await jobs())[0].payload).toEqual({ check: 'outage_trace', via: 'cli' });
  });
});

describe('mailexpert spam-quarantine', () => {
  it('lists the node\'s quarantine with the panel\'s mailbox', async () => {
    const list = await cli(['spam-quarantine', 'list']);
    expect(list.code, list.err).toBe(0);
    expect(list.out).toMatch(/7\s+.*anna@example\.com/);
    expect(list.out).toContain('Cheap watches');
    expect((await cli(['spam-quarantine', 'list', '--json'])).json()).toMatchObject({ total: 1, items: [{ id: 7, accountId: ACCOUNT }] });
  });

  it('releases, trains as spam and, after confirmation, deletes an entry, journaled as the panel does', async () => {
    expect((await cli(['spam-quarantine', 'release', '7', '--json'])).json()).toEqual({ ok: true, learned: true, warnings: [] });
    expect(await entry('mail_node.quarantine_released')).toMatchObject({
      account_id: ACCOUNT, actor_email: 'cli', details: { id: 7, qid: 'QID7', learned: true, via: 'cli' },
    });
    expect((await cli(['spam-quarantine', 'release', '7'])).err).toContain('(quarantine_item_not_found)');
    mc.node.quarantine = [{ ...QITEM, id: 8 }, { ...QITEM, id: 9, rcpt: 'stranger@example.com' }];
    expect((await cli(['spam-quarantine', 'learn-spam', '8'])).code).toBe(0);
    expect((await cli(['spam-quarantine', 'delete', '9'])).code).toBe(2);
    expect((await cli(['spam-quarantine', 'delete', '9', '--yes'])).code).toBe(0);
    expect(mc.node.quarantine).toEqual([]);
    const deleted = await entry('mail_node.quarantine_deleted', 3);
    expect(deleted).toMatchObject({ account_id: null, account_email: 'stranger@example.com', details: { id: 9, via: 'cli' } });
    expect((await cli(['spam-quarantine', 'release', 'x'])).err).toContain('(quarantine_item_invalid)');
  });

  it('shows and sets whether users see the quarantine, and writes mailcow\'s settings after confirmation', async () => {
    expect((await cli(['spam-quarantine', 'settings', 'show', '--json'])).json()).toMatchObject({ userView: false, nodeSettingsAppliedAt: null });
    expect((await cli(['spam-quarantine', 'settings', 'set', '--user-view', 'on'])).code).toBe(0);
    expect(await getQuarantineUserView()).toBe(true);
    expect(await entry('mail_node.config_changed')).toMatchObject({ details: { settings: 'quarantine', fields: ['userView'], via: 'cli' } });
    expect((await cli(['spam-quarantine', 'settings', 'set', '--user-view', 'maybe'])).code).toBe(2);
    expect((await cli(['spam-quarantine', 'node-settings', 'apply'])).code).toBe(2);
    expect(mc.node.quarantineSettings).toBeUndefined();
    const applied = await cli(['spam-quarantine', 'node-settings', 'apply', '--yes', '--json']);
    expect(applied.code, applied.err).toBe(0);
    expect(applied.json()).toMatchObject({ ok: true, nodeSettingsAppliedAt: expect.any(String) });
    expect(mc.node.quarantineSettings).toMatchObject({ action: 'settings', max_size: 10, release_format: 'raw' });
    expect(await entry('mail_node.quarantine_settings_applied', 2)).toMatchObject({ actor_email: 'cli', details: { reapplied: false, via: 'cli' } });
    expect((await cli(['spam-quarantine', 'node-settings', 'show'])).out).toMatch(/applied:\s+\d{4}-/);
  });
});
