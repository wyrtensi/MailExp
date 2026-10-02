// A general durable job queue (migration 0087, table jobs). Work that runs later, in the background,
// and survives a restart: the first kind is send_message (undo send and send later, see
// services/sendQueue.js); reminders, auto-replies, tenant jobs and delayed mailbox actions are meant
// to follow. docs/architecture/job-queue.md describes how to add a kind.
//
// Life of a job:
//   1. enqueueJob inserts it queued with a run_at. An enqueue that names a dedupe_key already used
//      by a job of the same kind returns that job instead (a double click enqueues once).
//   2. A worker claims due jobs (FOR UPDATE SKIP LOCKED, so several processes never claim the same
//      job): status running, a fresh claim_token and a lease. The lease is renewed while the
//      handler runs; every later write about the claim checks the token, so a worker whose claim
//      was swept away can never finish the job a second time.
//   3. The handler resolves: done. It throws: retried with backoff, failed, or needs_attention
//      (see settle below).
//   4. A worker that died leaves its job running with a lease that runs out. sweepExpiredLeases
//      queues it again, unless the handler had begun its irreversible step (effect_started_at):
//      then the job needs attention and never runs again by itself.
//
// Guarantees: a kind whose handler calls ctx.markEffectStarted() right before its irreversible step
// is at most once (send_message: a letter is never handed to the mail server twice). Every other
// kind is at least once, so its handler must be idempotent.
import { randomUUID } from 'crypto';
import { query, withTransaction } from './db.js';

export const JOB_STATUSES = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled', 'needs_attention']);
export const JOB_POLL_MS = 1000;
export const JOB_LEASE_MS = 60 * 1000;
export const JOB_HEARTBEAT_MS = 20 * 1000;
export const JOB_CONCURRENCY = 4;
export const JOB_DEFAULT_MAX_ATTEMPTS = 5;
export const JOB_RETRY_BASE_MS = 60 * 1000;
export const JOB_RETRY_MAX_MS = 30 * 60 * 1000;
// Done and cancelled jobs are kept this long (an enqueue retried with the same key still finds its
// job), then deleted. Failed jobs and those that need attention stay until someone acts on them.
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const JOB_CLEANUP_MS = 60 * 60 * 1000;
const ERROR_TEXT_MAX = 500;

export function jobRetryDelayMs(attempts) {
  return Math.min(JOB_RETRY_MAX_MS, JOB_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

// A handler throws this to choose what becomes of the job instead of the default (retry, or
// needs_attention once the effect began):
//   retry           queue it again after delayMs (or the backoff); failed once max_attempts is reached
//   fail            give up: status failed
//   needs_attention the outcome is unknown: never run again by itself
// code: a stable code for the client (stored in error_code); the message goes to last_error and
// must hold no secret, subject or body.
export class JobError extends Error {
  constructor(message, { outcome = 'retry', code = null, delayMs = null } = {}) {
    super(message);
    this.name = 'JobError';
    this.jobOutcome = outcome;
    this.code = code;
    this.delayMs = delayMs;
  }
}

// kind -> { handler(job, ctx), maxAttempts, retryDelayMs(attempts), onSettled(job) }
const kinds = new Map();

// handler(job, ctx) does the work. ctx.markEffectStarted() marks the start of its irreversible
// step; ctx.complete(fn) finishes the job as done inside a transaction that also runs fn(tx), so a
// handler can record its outcome together with the job's (returns false when the claim was lost).
// onSettled(job) runs after the job became done, failed or needs_attention (job is the row as
// stored); it is not awaited by the queue and its errors are logged.
export function registerJobKind(kind, { handler, maxAttempts = JOB_DEFAULT_MAX_ATTEMPTS, retryDelayMs = jobRetryDelayMs, onSettled = null }) {
  if (typeof handler !== 'function') throw new Error(`Job kind ${kind} needs a handler`);
  kinds.set(kind, { handler, maxAttempts, retryDelayMs, onSettled });
}

export function unregisterJobKind(kind) {
  kinds.delete(kind);
}

export function jobKind(kind) {
  return kinds.get(kind) || null;
}

function clip(text) {
  const value = String(text ?? '');
  return value.length > ERROR_TEXT_MAX ? `${value.slice(0, ERROR_TEXT_MAX - 1)}…` : value;
}

// Enqueues a job; resolves { job, created }. runAt (a Date) or delayMs (from the database's now)
// sets when it is due; neither means now. db: a transaction client, so the job and what goes with
// it are written together, else the pool.
export async function enqueueJob({
  kind, payload = {}, runAt = null, delayMs = null, createdBy = null, accountId = null,
  dedupeKey = null, maxAttempts = null,
}, db = { query }) {
  if (!kind) throw new Error('kind is required');
  const max = maxAttempts ?? kinds.get(kind)?.maxAttempts ?? JOB_DEFAULT_MAX_ATTEMPTS;
  const { rows: [job] } = await db.query(
    `INSERT INTO jobs (kind, payload, run_at, max_attempts, created_by, account_id, dedupe_key)
     VALUES ($1, $2::jsonb,
             CASE WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz
                  ELSE now() + make_interval(secs => $4::double precision / 1000) END,
             $5, $6, $7, $8)
     ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [kind, JSON.stringify(payload ?? {}), runAt ? new Date(runAt).toISOString() : null, Number(delayMs) || 0,
      max, createdBy, accountId, dedupeKey]
  );
  if (job) {
    wakeAt(job.run_at);
    return { job, created: true };
  }
  const { rows: [existing] } = await db.query('SELECT * FROM jobs WHERE kind = $1 AND dedupe_key = $2', [kind, dedupeKey]);
  return { job: existing, created: false };
}

export async function getJob(id, db = { query }) {
  const { rows: [job] } = await db.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return job || null;
}

// Jobs of a kind, by mailbox (accountIds) and/or author, newest due first.
export async function listJobs({ kind, accountIds = null, createdBy = null, statuses = null, limit = 200 } = {}, db = { query }) {
  const { rows } = await db.query(
    `SELECT * FROM jobs
      WHERE ($1::text IS NULL OR kind = $1)
        AND ($2::uuid[] IS NULL OR account_id = ANY($2::uuid[]))
        AND ($3::uuid IS NULL OR created_by = $3)
        AND ($4::text[] IS NULL OR status = ANY($4::text[]))
      ORDER BY run_at, id
      LIMIT $5`,
    [kind ?? null, accountIds, createdBy, statuses, limit]
  );
  return rows;
}

// Cancels a job while it is in one of `from` (queued by default): atomic, so a job a worker has
// already claimed is never cancelled under it. Resolves the cancelled row, or null.
export async function cancelJob(id, { from = ['queued'] } = {}, db = { query }) {
  const { rows: [job] } = await db.query(
    `UPDATE jobs SET status = 'cancelled', finished_at = now(), updated_at = now(),
                     claim_token = NULL, lease_until = NULL
      WHERE id = $1 AND status = ANY($2::text[])
     RETURNING *`,
    [id, from]
  );
  return job || null;
}

// Moves a job to runAt (a Date) and queues it, while it is in one of `from` (queued by default).
// Passing failed or needs_attention in `from` runs it again: its attempts and error are cleared.
// Resolves the row, or null.
export async function rescheduleJob(id, { runAt, from = ['queued'] }, db = { query }) {
  const { rows: [job] } = await db.query(
    `UPDATE jobs SET run_at = $2::timestamptz, status = 'queued', updated_at = now(),
                     attempts = CASE WHEN status = 'queued' THEN attempts ELSE 0 END,
                     last_error = CASE WHEN status = 'queued' THEN last_error ELSE NULL END,
                     error_code = CASE WHEN status = 'queued' THEN error_code ELSE NULL END,
                     effect_started_at = NULL, claim_token = NULL, lease_until = NULL
      WHERE id = $1 AND status = ANY($3::text[])
     RETURNING *`,
    [id, new Date(runAt).toISOString(), from]
  );
  if (job) wakeAt(job.run_at);
  return job || null;
}

// Claims up to `limit` due jobs of the kinds registered in this process.
export async function claimDueJobs(limit, { leaseMs = JOB_LEASE_MS } = {}) {
  const registered = [...kinds.keys()];
  if (!registered.length || limit < 1) return [];
  const { rows } = await query(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, claim_token = $1 || '-' || id,
                     claimed_at = now(), lease_until = now() + make_interval(secs => $2::double precision / 1000),
                     effect_started_at = NULL, updated_at = now()
      WHERE id IN (SELECT id FROM jobs
                    WHERE status = 'queued' AND run_at <= now() AND kind = ANY($3::text[])
                    ORDER BY run_at, id
                    LIMIT $4
                    FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [randomUUID(), leaseMs, registered, limit]
  );
  return rows;
}

async function renewLease(job, leaseMs = JOB_LEASE_MS) {
  const { rowCount } = await query(
    `UPDATE jobs SET lease_until = now() + make_interval(secs => $3::double precision / 1000), updated_at = now()
      WHERE id = $1 AND status = 'running' AND claim_token = $2`,
    [job.id, job.claim_token, leaseMs]
  );
  return rowCount > 0;
}

function notifySettled(job) {
  const onSettled = kinds.get(job.kind)?.onSettled;
  if (!onSettled) return;
  Promise.resolve()
    .then(() => onSettled(job))
    .catch(err => console.error(`[jobs] onSettled of ${job.kind} job ${job.id} failed:`, err?.message));
}

// What becomes of a job whose handler threw. effectStarted: the handler had begun its irreversible
// step, so without an explicit outcome the job needs attention rather than another run.
function outcomeOf(job, err, effectStarted) {
  let outcome = err?.jobOutcome;
  if (!['retry', 'fail', 'needs_attention'].includes(outcome)) outcome = effectStarted ? 'needs_attention' : 'retry';
  if (outcome === 'retry' && job.attempts >= job.max_attempts) outcome = 'fail';
  return outcome;
}

async function settleFailure(job, err, effectStarted) {
  const kind = kinds.get(job.kind);
  const outcome = outcomeOf(job, err, effectStarted);
  const lastError = clip(err?.message || 'Job failed');
  const code = typeof err?.code === 'string' ? err.code.slice(0, 64) : null;
  let row;
  if (outcome === 'retry') {
    const delay = Number.isFinite(err?.delayMs) ? err.delayMs : (kind?.retryDelayMs ?? jobRetryDelayMs)(job.attempts);
    ({ rows: [row] } = await query(
      `UPDATE jobs SET status = 'queued', run_at = now() + make_interval(secs => $3::double precision / 1000),
                       last_error = $4, error_code = $5, claim_token = NULL, lease_until = NULL,
                       effect_started_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'running' AND claim_token = $2
       RETURNING *`,
      [job.id, job.claim_token, delay, lastError, code]
    ));
    if (row) wakeAt(row.run_at);
    return row || null;
  }
  ({ rows: [row] } = await query(
    `UPDATE jobs SET status = $3, last_error = $4, error_code = $5, claim_token = NULL, lease_until = NULL, updated_at = now()
      WHERE id = $1 AND status = 'running' AND claim_token = $2
     RETURNING *`,
    [job.id, job.claim_token, outcome === 'fail' ? 'failed' : 'needs_attention', lastError, code]
  ));
  if (row) notifySettled(row);
  return row || null;
}

// Runs one claimed job to its end. Never throws.
export async function runJob(job) {
  const kind = kinds.get(job.kind);
  let effectStarted = false;
  let completedRow = null;
  const heartbeat = setInterval(() => {
    renewLease(job).catch(err => console.warn(`[jobs] Renewing the lease of job ${job.id} failed:`, err?.message));
  }, JOB_HEARTBEAT_MS);
  heartbeat.unref?.();
  const ctx = {
    async markEffectStarted() {
      const { rowCount } = await query(
        `UPDATE jobs SET effect_started_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'running' AND claim_token = $2`,
        [job.id, job.claim_token]
      );
      // The claim is gone (swept after a stall): the effect must not begin.
      if (!rowCount) throw new JobError('The job is no longer claimed by this worker', { outcome: 'fail', code: 'claim_lost' });
      effectStarted = true;
    },
    async complete(fn = null) {
      completedRow = await withTransaction(async (tx) => {
        const { rows: [row] } = await tx.query(
          `UPDATE jobs SET status = 'done', finished_at = now(), claim_token = NULL, lease_until = NULL,
                           last_error = NULL, error_code = NULL, updated_at = now()
            WHERE id = $1 AND status = 'running' AND claim_token = $2
           RETURNING *`,
          [job.id, job.claim_token]
        );
        if (row && fn) await fn(tx, row);
        return row || null;
      });
      return !!completedRow;
    },
  };
  try {
    if (!kind) throw new JobError(`No handler for job kind ${job.kind}`, { outcome: 'fail', code: 'unknown_kind' });
    await kind.handler(job, ctx);
    if (!completedRow) await ctx.complete();
    if (completedRow) notifySettled(completedRow);
  } catch (err) {
    if (completedRow) {
      // Done already; whatever the handler did after completing is its own concern.
      console.error(`[jobs] ${job.kind} job ${job.id} threw after completing:`, err?.message);
      notifySettled(completedRow);
    } else if (err?.code === 'claim_lost') {
      console.warn(`[jobs] ${job.kind} job ${job.id} lost its claim before its effect began`);
    } else {
      try {
        await settleFailure(job, err, effectStarted);
      } catch (settleErr) {
        // The lease runs out and the sweep settles the job.
        console.error(`[jobs] Settling ${job.kind} job ${job.id} failed:`, settleErr?.message);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

// Running jobs whose lease ran out (their worker died or stalled): queued again, or failed once
// max_attempts is reached; needs_attention when the handler had begun its irreversible step. The
// lease is renewed every JOB_HEARTBEAT_MS while a handler runs, so only a dead or stalled worker
// lets it run out. Resolves the rows it changed.
export async function sweepExpiredLeases() {
  const { rows } = await query(
    `UPDATE jobs
        SET status = CASE WHEN effect_started_at IS NOT NULL THEN 'needs_attention'
                          WHEN attempts >= max_attempts THEN 'failed'
                          ELSE 'queued' END,
            run_at = CASE WHEN effect_started_at IS NULL THEN now() ELSE run_at END,
            last_error = 'The worker running the job stopped before it finished',
            error_code = 'lease_expired',
            claim_token = NULL, lease_until = NULL, updated_at = now()
      WHERE status = 'running' AND lease_until < now()
     RETURNING *`
  );
  // The run counts as an attempt: a job that crashes its worker every time ends failed, not in a loop.
  for (const row of rows) {
    if (row.status === 'queued') wakeAt(row.run_at);
    else notifySettled(row);
  }
  return rows;
}

// Deletes done and cancelled jobs older than the retention, and any letter content left behind by
// a job that finished.
export async function cleanupFinishedJobs({ retentionMs = JOB_RETENTION_MS } = {}) {
  await query(
    `DELETE FROM outgoing_messages o USING jobs j
      WHERE o.job_id = j.id AND j.status IN ('done', 'cancelled')`
  );
  const { rowCount } = await query(
    `DELETE FROM jobs
      WHERE status IN ('done', 'cancelled')
        AND finished_at < now() - make_interval(secs => $1::double precision / 1000)`,
    [retentionMs]
  );
  return rowCount;
}

// ── The worker ──────────────────────────────────────────────────────────────────────────────
const running = new Set(); // promises of the jobs this process is running
let pollTimer = null;
let cleanupTimer = null;
let wakeTimer = null;
let wakeAtMs = null;
let ticking = false;
let concurrency = JOB_CONCURRENCY;

// Claims as many due jobs as there are free slots and starts them. wait: resolve once they ended
// (tests); the worker's tick does not wait, so a long send never holds up the next claim.
export async function runDueJobs({ wait = false } = {}) {
  const free = concurrency - running.size;
  const jobs = await claimDueJobs(free);
  const started = jobs.map((job) => {
    const p = runJob(job).finally(() => running.delete(p));
    running.add(p);
    return p;
  });
  if (wait) await Promise.all(started);
  return jobs;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await sweepExpiredLeases();
    await runDueJobs();
  } catch (err) {
    console.error('[jobs] Worker tick failed:', err?.message);
  } finally {
    ticking = false;
  }
}

// Runs a tick at the given due time (a Date or string) if it is before the next poll, so a job
// due in five seconds starts on time rather than up to a poll late.
function wakeAt(runAt) {
  if (!pollTimer) return;
  const at = new Date(runAt).getTime();
  if (!Number.isFinite(at)) return;
  if (wakeAtMs != null && wakeAtMs <= at) return;
  clearTimeout(wakeTimer);
  wakeAtMs = at;
  wakeTimer = setTimeout(() => { wakeAtMs = null; tick(); }, Math.max(0, at - Date.now()) + 20);
  wakeTimer.unref?.();
}

export function startJobWorker({ pollMs = JOB_POLL_MS, maxConcurrent = JOB_CONCURRENCY } = {}) {
  if (pollTimer) return;
  concurrency = maxConcurrent;
  pollTimer = setInterval(tick, pollMs);
  pollTimer.unref?.();
  cleanupTimer = setInterval(() => {
    cleanupFinishedJobs().catch(err => console.error('[jobs] Cleanup failed:', err?.message));
  }, JOB_CLEANUP_MS);
  cleanupTimer.unref?.();
  setTimeout(tick, 0).unref?.();
}

// Stops claiming; jobs already running finish (resolves once they did).
export async function stopJobWorker() {
  clearInterval(pollTimer);
  clearInterval(cleanupTimer);
  clearTimeout(wakeTimer);
  pollTimer = cleanupTimer = wakeTimer = null;
  wakeAtMs = null;
  await Promise.allSettled([...running]);
}
