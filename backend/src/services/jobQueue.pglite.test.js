// The durable job queue (jobQueue.js) against a real (in-process) Postgres engine and the real
// migration: enqueue and dedupe, claim and cancel in either order, retry and give up, the lease
// running out before and after an at-most-once effect began, a restart in the middle, and time.
// PGlite is one connection, so a "race" is the two orders of the competing statements.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from './testing/realSchema.js';

const dbState = { db: null };
vi.mock('./db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));

const jobs = await import('./jobQueue.js');
const {
  enqueueJob, cancelJob, rescheduleJob, getJob, listJobs, claimDueJobs, runJob, runDueJobs,
  sweepExpiredLeases, cleanupFinishedJobs, registerJobKind, unregisterJobKind, JobError,
  failJobsOfDeletedAccount, stopJobWorker, _resumeJobWorkerForTests, _setSettleRetryDelaysForTests,
} = jobs;

const ACCOUNT = '40000000-0000-4000-8000-000000000001';
const USER = '42000000-0000-4000-8000-000000000001';
let db;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  unregisterJobKind('test');
  await db.exec('DELETE FROM outgoing_messages; DELETE FROM jobs; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query("INSERT INTO users (id, username) VALUES ($1, 'anna')", [USER]);
  await db.query("INSERT INTO email_accounts (id, name, email_address) VALUES ($1, 'Office', 'office@example.com')", [ACCOUNT]);
});

const due = (extra = {}) => enqueueJob({ kind: 'test', payload: { n: 1 }, createdBy: USER, accountId: ACCOUNT, ...extra });
const makeDue = (id) => db.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1", [id]);
const expireLease = (id) => db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [id]);

describe('enqueue', () => {
  it('stores a queued job due after the delay, by the database clock', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const { job, created } = await due({ delayMs: 5000 });
    expect(created).toBe(true);
    expect(job).toMatchObject({ kind: 'test', status: 'queued', attempts: 0, payload: { n: 1 }, created_by: USER, account_id: ACCOUNT });
    const { rows: [{ secs }] } = await db.query('SELECT EXTRACT(EPOCH FROM (run_at - now()))::float AS secs FROM jobs WHERE id = $1', [job.id]);
    expect(secs).toBeGreaterThan(4);
    expect(secs).toBeLessThanOrEqual(5);
    // Not due yet: nothing is claimed.
    expect(await claimDueJobs(10)).toEqual([]);
  });

  it('returns the job already there for the same dedupe key instead of a second one', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const first = await due({ dedupeKey: 'u1:k1' });
    const second = await due({ dedupeKey: 'u1:k1' });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    const third = await due({ dedupeKey: 'u1:k2' });
    expect(third.created).toBe(true);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(2);
  });

  it('keeps a job due at a scheduled time until that time', async () => {
    const handler = vi.fn();
    registerJobKind('test', { handler });
    const { job } = await due({ runAt: new Date(Date.now() + 3600 * 1000) });
    await runDueJobs({ wait: true });
    expect(handler).not.toHaveBeenCalled();
    await db.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1", [job.id]);
    await runDueJobs({ wait: true });
    expect(handler).toHaveBeenCalledOnce();
    expect((await getJob(job.id)).status).toBe('done');
  });
});

describe('claim and cancel', () => {
  it('cancels a queued job, and a cancelled job is never claimed', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const { job } = await due();
    const cancelled = await cancelJob(job.id);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(cancelled.finished_at).not.toBeNull();
    expect(await claimDueJobs(10)).toEqual([]);
    // A second cancel finds nothing to cancel.
    expect(await cancelJob(job.id)).toBeNull();
  });

  it('refuses to cancel a job a worker has claimed', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const { job } = await due();
    const [claimed] = await claimDueJobs(10);
    expect(claimed).toMatchObject({ id: job.id, status: 'running', attempts: 1 });
    expect(claimed.claim_token).toBeTruthy();
    expect(await cancelJob(job.id)).toBeNull();
    expect((await getJob(job.id)).status).toBe('running');
  });

  it('claims a job once: a second claim right after finds it taken', async () => {
    registerJobKind('test', { handler: vi.fn() });
    await due();
    await due();
    const first = await claimDueJobs(1);
    const second = await claimDueJobs(10);
    const third = await claimDueJobs(10);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].id).not.toBe(first[0].id);
    expect(third).toEqual([]);
  });

  it('only claims the kinds this process has a handler for', async () => {
    await enqueueJob({ kind: 'other' });
    registerJobKind('test', { handler: vi.fn() });
    expect(await claimDueJobs(10)).toEqual([]);
  });

  it('reschedules a queued job and refuses one that already ran', async () => {
    const handler = vi.fn();
    registerJobKind('test', { handler });
    const { job } = await due({ delayMs: 60000 });
    const later = new Date(Date.now() + 2 * 3600 * 1000);
    const moved = await rescheduleJob(job.id, { runAt: later });
    expect(new Date(moved.run_at).getTime()).toBe(later.getTime());
    await makeDue(job.id);
    await runDueJobs({ wait: true });
    expect(await rescheduleJob(job.id, { runAt: later })).toBeNull();
  });
});

describe('running', () => {
  it('finishes a job whose handler resolves, and records with ctx.complete in the same transaction', async () => {
    registerJobKind('test', {
      handler: async (job, ctx) => {
        await ctx.complete(async (tx) => {
          await tx.query("UPDATE users SET username = 'done' WHERE id = $1", [USER]);
        });
      },
    });
    const { job } = await due();
    await runDueJobs({ wait: true });
    const row = await getJob(job.id);
    expect(row).toMatchObject({ status: 'done', claim_token: null, lease_until: null });
    expect(row.finished_at).not.toBeNull();
    expect((await db.query('SELECT username FROM users WHERE id = $1', [USER])).rows[0].username).toBe('done');
  });

  it('retries a failing job with backoff and gives up after max_attempts', async () => {
    const onSettled = vi.fn();
    registerJobKind('test', { handler: async () => { throw new Error('busy'); }, maxAttempts: 2, onSettled });
    const { job } = await due();
    await runDueJobs({ wait: true });
    let row = await getJob(job.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1, last_error: 'busy' });
    expect(new Date(row.run_at).getTime()).toBeGreaterThan(Date.now() + 30 * 1000);
    await makeDue(job.id);
    await runDueJobs({ wait: true });
    row = await getJob(job.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 2, last_error: 'busy' });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, status: 'failed' })));
  });

  it('honours the outcome and code a handler chooses', async () => {
    registerJobKind('test', { handler: async () => { throw new JobError('rejected', { outcome: 'fail', code: 'rejected' }); } });
    const { job } = await due();
    await runDueJobs({ wait: true });
    expect(await getJob(job.id)).toMatchObject({ status: 'failed', error_code: 'rejected', attempts: 1 });
  });

  // jobs show and the panel's job card read last_error: an error without a message still names
  // what failed, a network failure names its cause, and the server log has the job and its kind.
  it('records a readable reason for an error without a message, and logs the job it came from', async () => {
    registerJobKind('test', { handler: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }); }, maxAttempts: 1 });
    let { job } = await due();
    await runDueJobs({ wait: true });
    expect(await getJob(job.id)).toMatchObject({ status: 'failed', last_error: 'fetch failed (ECONNREFUSED)' });
    expect(console.error.mock.calls.some(([line]) => String(line).includes(`test job ${job.id}`))).toBe(true);

    await db.exec('DELETE FROM jobs');
    registerJobKind('test', { handler: async () => { throw Object.assign(new Error(''), { code: 'ETIMEDOUT' }); }, maxAttempts: 1 });
    ({ job } = await due());
    await runDueJobs({ wait: true });
    expect(await getJob(job.id)).toMatchObject({ status: 'failed', last_error: 'ETIMEDOUT' });

    await db.exec('DELETE FROM jobs');
    registerJobKind('test', { handler: async () => { throw 'plain text'; }, maxAttempts: 1 });
    ({ job } = await due());
    await runDueJobs({ wait: true });
    expect(await getJob(job.id)).toMatchObject({ status: 'failed', last_error: 'plain text' });
  });

  it('never runs again an at-most-once job that failed after its effect began', async () => {
    const handler = vi.fn(async (job, ctx) => {
      await ctx.markEffectStarted();
      throw new Error('connection closed');
    });
    registerJobKind('test', { handler });
    const { job } = await due();
    await runDueJobs({ wait: true });
    expect(await getJob(job.id)).toMatchObject({ status: 'needs_attention', last_error: 'connection closed' });
    await runDueJobs({ wait: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('lets an at-most-once handler retry a failure it knows happened before the effect', async () => {
    registerJobKind('test', {
      handler: async (job, ctx) => {
        await ctx.markEffectStarted();
        throw new JobError('refused', { outcome: 'retry', delayMs: 0 });
      },
    });
    const { job } = await due();
    await runDueJobs({ wait: true });
    expect(await getJob(job.id)).toMatchObject({ status: 'queued', effect_started_at: null, attempts: 1 });
  });
});

describe('lease expiry', () => {
  it('queues again a job whose worker died before its effect began', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const { job } = await due();
    await claimDueJobs(10);
    expect(await sweepExpiredLeases()).toEqual([]); // the lease is still running
    await expireLease(job.id);
    const [swept] = await sweepExpiredLeases();
    expect(swept).toMatchObject({ id: job.id, status: 'queued', error_code: 'lease_expired', claim_token: null });
  });

  it('marks needs_attention, never queued, a job whose worker died after its effect began', async () => {
    const onSettled = vi.fn();
    registerJobKind('test', { handler: vi.fn(), onSettled });
    const { job } = await due();
    const [claimed] = await claimDueJobs(10);
    await db.query('UPDATE jobs SET effect_started_at = now() WHERE id = $1', [claimed.id]);
    await expireLease(job.id);
    const [swept] = await sweepExpiredLeases();
    expect(swept).toMatchObject({ id: job.id, status: 'needs_attention', error_code: 'lease_expired' });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs_attention' })));
    expect(await claimDueJobs(10)).toEqual([]);
  });

  it('fails a job that keeps killing its worker once max_attempts is reached', async () => {
    registerJobKind('test', { handler: vi.fn(), maxAttempts: 1 });
    const { job } = await due();
    await claimDueJobs(10);
    await expireLease(job.id);
    const [swept] = await sweepExpiredLeases();
    expect(swept.status).toBe('failed');
  });

  it('a worker whose claim was swept cannot finish the job or begin its effect', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const effect = vi.fn();
    registerJobKind('test', {
      handler: async (job, ctx) => {
        await gate;
        await ctx.markEffectStarted();
        effect();
      },
    });
    const { job } = await due();
    const [claimed] = await claimDueJobs(10);
    const run = runJob(claimed);
    // The worker stalls past its lease; the sweep queues the job again and another claim takes it.
    await expireLease(job.id);
    await sweepExpiredLeases();
    const [reclaimed] = await claimDueJobs(10);
    expect(reclaimed.claim_token).not.toBe(claimed.claim_token);
    release();
    await run;
    expect(effect).not.toHaveBeenCalled();
    expect(await getJob(job.id)).toMatchObject({ status: 'running', claim_token: reclaimed.claim_token });
  });
});

describe('restart', () => {
  it('runs after a restart the jobs queued and the ones left running before it', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const { job: inFlight } = await due();
    const { job: waiting } = await due();
    await claimDueJobs(1); // the first one, left running by the process that "died"
    // A new process: the kind is registered again, nothing in memory survived.
    unregisterJobKind('test');
    const handler = vi.fn();
    registerJobKind('test', { handler });
    await expireLease(inFlight.id);
    await sweepExpiredLeases();
    await runDueJobs({ wait: true });
    expect(handler).toHaveBeenCalledTimes(2);
    expect((await getJob(waiting.id)).status).toBe('done');
    expect((await getJob(inFlight.id)).status).toBe('done');
  });
});

describe('listing and cleanup', () => {
  it('lists jobs by kind, mailbox, author and status', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const { job: a } = await due();
    const { job: b } = await due({ createdBy: null });
    await cancelJob(b.id);
    expect((await listJobs({ kind: 'test', accountIds: [ACCOUNT] })).map(j => j.id)).toEqual([a.id, b.id]);
    expect((await listJobs({ kind: 'test', createdBy: USER })).map(j => j.id)).toEqual([a.id]);
    expect((await listJobs({ kind: 'test', statuses: ['cancelled'] })).map(j => j.id)).toEqual([b.id]);
  });

  it('deletes finished jobs past the retention, keeps failed ones 30 days, and drops content left by finished jobs', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const { job: old } = await due();
    const { job: recent } = await due();
    const { job: failed } = await due();
    const { job: expired } = await due();
    await cancelJob(old.id);
    await cancelJob(recent.id);
    await db.query("UPDATE jobs SET finished_at = now() - interval '8 days' WHERE id = $1", [old.id]);
    await db.query("UPDATE jobs SET status = 'failed', updated_at = now() - interval '20 days' WHERE id = $1", [failed.id]);
    await db.query("UPDATE jobs SET status = 'needs_attention', updated_at = now() - interval '31 days' WHERE id = $1", [expired.id]);
    await db.query("INSERT INTO outgoing_messages (job_id, compose, mail) VALUES ($1, '{}', '\\x00'), ($2, '{}', '\\x00'), ($3, '{}', '\\x00')", [recent.id, failed.id, expired.id]);
    expect(await cleanupFinishedJobs()).toBe(2);
    expect(await getJob(old.id)).toBeNull();
    expect(await getJob(expired.id)).toBeNull();
    expect(await getJob(recent.id)).not.toBeNull();
    const { rows } = await db.query('SELECT job_id FROM outgoing_messages');
    expect(rows.map(r => String(r.job_id))).toEqual([String(failed.id)]);
  });

  it('fails the jobs of a mailbox about to be deleted, and keeps them once it is gone', async () => {
    const onSettled = vi.fn();
    registerJobKind('test', { handler: vi.fn(), onSettled });
    const { job: waiting } = await due({ delayMs: 60000 });
    const { job: done } = await due();
    await runDueJobs({ wait: true });
    const failed = await failJobsOfDeletedAccount(ACCOUNT);
    expect(failed.map(j => j.id)).toEqual([waiting.id]);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id: waiting.id, status: 'failed', error_code: 'account_missing' })));
    await db.query('DELETE FROM email_accounts WHERE id = $1', [ACCOUNT]);
    expect(await getJob(waiting.id)).toMatchObject({ status: 'failed', account_id: null });
    expect(await getJob(done.id)).toMatchObject({ status: 'done', account_id: null });
  });

  it('a deletion fails only the waiting jobs: kept ones keep their status and code, and are not reported again', async () => {
    const onSettled = vi.fn();
    registerJobKind('test', { handler: vi.fn(), onSettled });
    const { job: waiting } = await due({ delayMs: 60000 });
    const { job: failed } = await due({ delayMs: 60000 });
    const { job: attention } = await due({ delayMs: 60000 });
    const { job: delivered } = await due({ delayMs: 60000 });
    await db.query("UPDATE jobs SET status = 'failed', error_code = 'smtp_rejected' WHERE id = $1", [failed.id]);
    await db.query("UPDATE jobs SET status = 'needs_attention', error_code = 'lease_expired' WHERE id = $1", [attention.id]);
    await db.query("UPDATE jobs SET status = 'needs_attention', error_code = 'delivered_unrecorded' WHERE id = $1", [delivered.id]);
    const changed = await failJobsOfDeletedAccount(ACCOUNT);
    expect(changed.map(j => j.id)).toEqual([waiting.id]);
    expect(changed[0]).toMatchObject({ status: 'failed', error_code: 'account_missing' });
    expect(await getJob(failed.id)).toMatchObject({ status: 'failed', error_code: 'smtp_rejected' });
    expect(await getJob(attention.id)).toMatchObject({ status: 'needs_attention', error_code: 'lease_expired' });
    expect(await getJob(delivered.id)).toMatchObject({ status: 'needs_attention', error_code: 'delivered_unrecorded' });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id: waiting.id })));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it('the sweep labels a job whose effect was marked done with that code, not lease_expired', async () => {
    const onSettled = vi.fn();
    let release;
    registerJobKind('test', {
      onSettled,
      handler: async (_job, ctx) => {
        await ctx.markEffectStarted();
        expect(await ctx.markEffectDone('delivered_unrecorded')).toBe(true);
        await new Promise(resolve => { release = resolve; });
      },
    });
    const { job } = await due();
    const [claimed] = await claimDueJobs(10);
    const running = runJob(claimed);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expireLease(job.id);
    const [swept] = await sweepExpiredLeases();
    expect(swept).toMatchObject({ id: job.id, status: 'needs_attention', error_code: 'delivered_unrecorded' });
    release();
    await running;
    // A job moved to run again forgets the mark.
    const moved = await rescheduleJob(job.id, { runAt: new Date(), from: ['needs_attention'] });
    expect(moved.payload.effectDoneCode).toBeUndefined();
  });

  it('never moves a job whose error code is excluded, in the same statement', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const { job } = await due({ delayMs: 60000 });
    await db.query("UPDATE jobs SET status = 'needs_attention', error_code = 'delivered_unrecorded' WHERE id = $1", [job.id]);
    expect(await rescheduleJob(job.id, { runAt: new Date(), from: ['needs_attention'], exceptErrorCodes: ['delivered_unrecorded'] })).toBeNull();
    expect(await getJob(job.id)).toMatchObject({ status: 'needs_attention', error_code: 'delivered_unrecorded' });
  });

  it('keeps trying to record the outcome of a job whose effect began while the database refuses it', async () => {
    _setSettleRetryDelaysForTests([5, 5, 5, 5]);
    try {
      const onSettled = vi.fn();
      registerJobKind('test', {
        onSettled,
        handler: async (_job, ctx) => {
          await ctx.markEffectStarted();
          throw new JobError('effect unrecorded', { outcome: 'needs_attention', code: 'delivered_unrecorded' });
        },
      });
      const { job } = await due();
      await db.exec(`
        CREATE FUNCTION refuse_settle() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            -- A sequence is not rolled back with the refused statement: the first two tries fail.
            IF nextval('settle_refusals') <= 2 THEN RAISE EXCEPTION 'database unavailable'; END IF;
            RETURN NEW;
          END $$;
        CREATE SEQUENCE settle_refusals;
        CREATE TRIGGER refuse_settle BEFORE UPDATE ON jobs FOR EACH ROW
          WHEN (NEW.status = 'needs_attention') EXECUTE FUNCTION refuse_settle();`);
      try {
        await runDueJobs({ wait: true });
      } finally {
        await db.exec('DROP TRIGGER refuse_settle ON jobs; DROP FUNCTION refuse_settle(); DROP SEQUENCE settle_refusals;');
      }
      expect(await getJob(job.id)).toMatchObject({ status: 'needs_attention', error_code: 'delivered_unrecorded' });
      await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    } finally {
      _setSettleRetryDelaysForTests();
    }
  });

  it('moves a job with a payload change', async () => {
    registerJobKind('test', { handler: vi.fn() });
    const { job } = await due({ delayMs: 60000 });
    const moved = await rescheduleJob(job.id, { runAt: new Date(Date.now() + 3600e3), payloadPatch: { scheduled: true } });
    expect(moved.payload).toEqual({ n: 1, scheduled: true });
  });
});

describe('stopping', () => {
  it('claims nothing once stopping, and waits for running jobs at most the grace', async () => {
    let release;
    const handler = vi.fn(() => new Promise(resolve => { release = resolve; }));
    registerJobKind('test', { handler });
    const { job: first } = await due();
    const started = runDueJobs();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await started;
    const { job: second } = await due();
    try {
      expect(await stopJobWorker({ waitMs: 50 })).toBe(false); // the running one did not end in time
      expect(await runDueJobs({ wait: true })).toEqual([]);
      expect((await getJob(second.id)).status).toBe('queued');
      release();
      expect(await stopJobWorker({ waitMs: 1000 })).toBe(true);
      expect((await getJob(first.id)).status).toBe('done');
    } finally {
      _resumeJobWorkerForTests();
    }
  });
});
