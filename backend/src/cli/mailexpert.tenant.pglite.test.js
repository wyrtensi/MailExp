import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel CLI's tenant, quarantine and jobs commands end to end: the real services and job
// queue on PGlite with every migration and the fake tenant driver (TENANT_DRIVER=fake, the
// panel's demo/stand mode). The CLI queues the jobs; the test runs the backend's worker for them.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => {} },
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { saveEopSettings } = await import('../services/mailNode/eopSettings.js');
const { createFakeTenantDriver, setTenantDriver } = await import('../services/tenant/driver.js');
const { TENANT_FIXTURES } = await import('../services/tenant/fakes.js');
const { claimDueJobs, enqueueJob, runJob } = await import('../services/jobQueue.js');
const { TENANT_JOB_KINDS, registerTenantJobKinds } = await import('../services/tenant/tenantJobs.js');
const { QUARANTINE_RELEASE_KIND } = await import('../services/tenant/quarantineRelease.js');
const { run } = await import('./mailexpert.js');

const ADMIN = '63000000-0000-4000-8000-000000000001';
const TENANT = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: TENANT_FIXTURES.worker.certificate.thumbprint,
};
let db;

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
    sleep: runDue, now: Date.now, pollMs: 0,
  });
  return { code, out: stdout.text, err: stderr.text, json: () => JSON.parse(stdout.text) };
}

const audit = async () => (await db.query('SELECT actor_user_id, actor_email, action, details FROM mailbox_audit_log ORDER BY id')).rows;
async function auditSettled(count) {
  for (let i = 0; i < 50; i += 1) {
    if ((await audit()).length >= count) return audit();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return audit();
}

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
  registerTenantJobKinds();
}, 120000);
afterAll(async () => {
  setTenantDriver(undefined);
  await db?.close();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await db.exec('DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM integration_config; DELETE FROM tenant_quarantine_releases;');
  setTenantDriver(createFakeTenantDriver());
  await saveEopSettings(TENANT);
});

describe('mailexpert tenant', () => {
  it('says there is no driver and that the worker is unknown when the panel has none', async () => {
    setTenantDriver(null);
    const result = await cli(['tenant', 'status', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(result.json()).toMatchObject({ driver: null, configured: true, worker: { reachable: null, code: 'tenant_driver_missing' } });
    expect((await cli(['tenant', 'test'])).err).toContain('(tenant_driver_missing)');
  });

  it('tests the connection through the queue, then reports the worker reached and the anti-spam policy read', async () => {
    const before = await cli(['tenant', 'status', '--json']);
    expect(before.json()).toMatchObject({ driver: 'fake', worker: { reachable: null, code: 'not_checked' } });

    const tested = await cli(['tenant', 'test', '--wait', '--json']);
    expect(tested.code, tested.err).toBe(0);
    expect(tested.json().job).toMatchObject({ kind: TENANT_JOB_KINDS.test, status: 'done' });

    const after = await cli(['tenant', 'status']);
    expect(after.code).toBe(0);
    expect(after.out).toMatch(/worker reached:\s+yes/);
    expect(after.out).toMatch(/connection test:\s+ok/);
    expect(after.out).toContain('anti-spam policy: read at');
    const [entry] = (await auditSettled(1)).filter((e) => e.action === 'tenant.connection_tested');
    // The job's own journal entry names the CLI that queued it (payload.via), not MailExpert.
    expect(entry).toMatchObject({ actor_user_id: null, actor_email: 'cli', details: { ok: true, via: 'cli' } });
  });

  it('checks and fixes the anti-spam policy as the --as administrator', async () => {
    const result = await cli(['tenant', 'antispam', '--wait', '--as', 'admin@example.com', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(result.json().job).toMatchObject({ kind: TENANT_JOB_KINDS.antispam, status: 'done' });
    const { rows: [job] } = await db.query('SELECT created_by FROM jobs WHERE kind = $1', [TENANT_JOB_KINDS.antispam]);
    expect(job.created_by).toBe(ADMIN);
    const status = await cli(['tenant', 'status', '--json']);
    expect(status.json().state.antispam).toMatchObject({ ok: true });
    expect(status.json().state.antispam.enforcement).toBeTruthy();
    // What the job changed is journaled as the --as administrator, through the CLI.
    for (const entry of (await audit()).filter((e) => e.action === 'tenant.antispam_enforced')) {
      expect(entry).toMatchObject({ actor_user_id: ADMIN, actor_email: 'admin@example.com', details: { via: 'cli' } });
    }
  });

  it('answers the job already queued instead of a second one', async () => {
    const first = (await cli(['tenant', 'test', '--json'])).json();
    const second = (await cli(['tenant', 'test', '--json'])).json();
    expect(second).toMatchObject({ created: false, job: { id: first.job.id } });
  });
});

describe('mailexpert quarantine', () => {
  async function addRelease(identity, state, reason, { expiresInDays = 10 } = {}) {
    await db.query(
      `INSERT INTO tenant_quarantine_releases (identity, state, reason, sender, subject, recipients, expires_at, quarantine_type)
       VALUES ($1, $2, $3, 'spam@bad.example', 'Hello', ARRAY['anna@example.com'], NOW() + make_interval(days => $4::int), 'Phish')`,
      [identity, state, reason, expiresInDays],
    );
  }

  it('lists the held messages only', async () => {
    await addRelease('q1', 'skipped', 'foreign_recipients');
    await addRelease('q2', 'released', null);
    await addRelease('q3', 'skipped', 'gone');
    await addRelease('q4', 'skipped', 'type_not_allowed', { expiresInDays: -1 });
    const result = await cli(['quarantine', 'list', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(result.json().held.count).toBe(1);
    expect(result.json().messages.map((m) => [m.identity, m.reason])).toEqual([['q1', 'foreign_recipients']]);
    const human = await cli(['quarantine', 'list']);
    expect(human.out).toMatch(/spam@bad\.example/);
    const status = await cli(['quarantine', 'status']);
    expect(status.out).toMatch(/automatic release:\s+on/);
    expect(status.out).toMatch(/held messages:\s+1/);
  });

  it('pauses and resumes the release, journaled, and refuses a release pass while paused', async () => {
    const paused = await cli(['quarantine', 'pause', '--yes', '--json']);
    expect(paused.code, paused.err).toBe(0);
    expect(paused.json().enabled).toBe(false);
    expect((await cli(['quarantine', 'release', '--json'])).json().code).toBe('phish_release_paused');
    expect((await cli(['quarantine', 'resume'])).code).toBe(0);
    const released = await cli(['quarantine', 'release', '--json']);
    expect(released.code, released.err).toBe(0);
    expect(released.json()).toMatchObject({ created: true, job: { kind: QUARANTINE_RELEASE_KIND, status: 'queued' } });
    const entries = (await auditSettled(2)).filter((e) => e.action === 'tenant.phish_release_changed');
    expect(entries.map((e) => [e.details.enabled, e.actor_email, e.details.via])).toEqual([[false, 'cli', 'cli'], [true, 'cli', 'cli']]);
  });
});

describe('mailexpert jobs', () => {
  it('lists the tenant\'s jobs, newest first, by status and kind, and shows one', async () => {
    const { job: done } = await enqueueJob({ kind: TENANT_JOB_KINDS.poll });
    await db.query("UPDATE jobs SET status = 'done' WHERE id = $1", [done.id]);
    const { job: failed } = await enqueueJob({ kind: QUARANTINE_RELEASE_KIND });
    await db.query("UPDATE jobs SET status = 'failed', error_code = 'tenant_failed', last_error = 'x' WHERE id = $1", [failed.id]);
    const { job: attention } = await enqueueJob({ kind: 'tenant_domain_sync', payload: { domain: 'example.com' } });
    await db.query("UPDATE jobs SET status = 'needs_attention' WHERE id = $1", [attention.id]);
    // Letters waiting to be sent are not the tenant's: never listed here.
    await enqueueJob({ kind: 'send_message' });

    const all = (await cli(['jobs', 'list', '--json'])).json().jobs;
    expect(all.map((j) => j.id)).toEqual([String(attention.id), String(failed.id), String(done.id)]);
    expect(all[0]).toMatchObject({ kind: 'tenant_domain_sync', domain: 'example.com', status: 'needs_attention' });
    const problems = (await cli(['jobs', 'list', '--status', 'problems', '--json'])).json().jobs;
    expect(problems.map((j) => j.status)).toEqual(['needs_attention', 'failed']);
    const kinds = (await cli(['jobs', 'list', '--kind', TENANT_JOB_KINDS.poll, '--json'])).json().jobs;
    expect(kinds.map((j) => j.id)).toEqual([String(done.id)]);
    expect((await cli(['jobs', 'list', '--limit', '1', '--json'])).json().jobs).toHaveLength(1);

    const shown = await cli(['jobs', 'show', String(failed.id)]);
    expect(shown.code).toBe(0);
    expect(shown.out).toMatch(/error code:\s+tenant_failed/);
    const { rows: [send] } = await db.query("SELECT id FROM jobs WHERE kind = 'send_message'");
    expect((await cli(['jobs', 'show', String(send.id)])).err).toContain('(tenant_job_not_found)');
    expect((await cli(['jobs', 'show', 'abc'])).code).toBe(1);
  });
});
