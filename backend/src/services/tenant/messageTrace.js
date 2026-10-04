import { query, withTransaction } from '../db.js';
import { JobError, enqueueJob, registerJobKind } from '../jobQueue.js';
import { TRACE_HISTORY_MS, TraceSourceError, resolveTraceSource } from '../mailNode/traceSource.js';
import { readEvents } from '../mailNode/outageTrace.js';
import { TenantError } from './exoRunner.js';

// R-30: what Microsoft's message trace says about a letter a node mailbox sent, on request ("Ask
// Microsoft" in the letter's delivery details, R-17). The node's log ends where the letter is handed
// to EOP; the trace says what EOP did next (delivered, failed, pending, quarantined, filtered).
//
// The request stores a row in message_eop_traces (migration 0089) and queues the job
// tenant_message_trace: the tenant is never asked on a request's path. The job lists the trace
// (services/mailNode/traceSource.js: the tenant driver's Graph trace, or a stand's or a test's
// source) over the hours around the letter and keeps the rows with its Message-ID, then reads each
// recipient's details (getDetailsByRecipient) for the status code and EOP's words.
//
// Graph's $filter documents receivedDateTime, recipientAddress, id and contains(subject) but not
// messageId, so the job asks by time and matches the Message-ID itself (one request per page of up
// to 5000 rows). The window: from 10 minutes before the letter was sent (or handed to EOP, by the
// node's log, R-17) to 2 hours after the last hand-off, or 6 hours after it was sent when the log
// shows none; never beyond now or 90 days back (Graph's history: an older letter answers
// trace_too_old at the request).
//
// Limits: Graph allows 100 requests per 5 minutes per tenant. R-43 keeps a bucket of 80
// (services/mailNode/outageTrace.js); this one keeps the other 20 (BUCKET_SIZE), and a job takes at
// most MAX_REQUESTS_PER_RUN, reserved before its first request and the unused part given back
// after (requests sent before an error count). A run without requests left ends and queues a new
// job for when the bucket has one (no attempt spent); a listing cut short keeps its cursor and goes
// on in a follow-up job; throttling keeps the whole reservation spent and retries the job after a
// minute. A letter is asked again at most once per RECHECK_MS (the request answers the stored trace
// meanwhile); the row and its job are written in one transaction, and a queued row whose job is
// gone is queued again. Rows are deleted RETENTION_DAYS after their last change.

export const MESSAGE_TRACE_KIND = 'tenant_message_trace';
const MINUTE_MS = 60 * 1000;
export const BUCKET_SIZE = 20;
export const BUCKET_REFILL_MS = 5 * MINUTE_MS;
export const MAX_REQUESTS_PER_RUN = 10;
export const MAX_DETAILS = 10;
export const RECHECK_MS = 5 * MINUTE_MS;
export const BEFORE_MS = 10 * MINUTE_MS;
export const AFTER_HANDOFF_MS = 2 * 60 * MINUTE_MS;
export const AFTER_SENT_MS = 6 * 60 * MINUTE_MS;
const FOLLOW_UP_MS = 15 * 1000;
const THROTTLED_MS = MINUTE_MS;
const MAX_JOB_ATTEMPTS = 6;
export const RETENTION_DAYS = 45;
// A queued or running row whose job is gone (it failed to be queued, or ended without settling the
// row) is stale after this: a new request queues again instead of answering "already asked".
const STALE_MS = 15 * MINUTE_MS;

// --- the request bucket ---------------------------------------------------------------------------

const bucket = { tokens: BUCKET_SIZE, at: Date.now() };
function refill(at = Date.now()) {
  bucket.tokens = Math.min(BUCKET_SIZE, bucket.tokens + ((at - bucket.at) * BUCKET_SIZE) / BUCKET_REFILL_MS);
  bucket.at = at;
}
export function availableTraceRequests() {
  refill();
  return Math.floor(bucket.tokens);
}
// Takes up to max whole requests out of the bucket now; answers how many.
export function reserveTraceRequests(max) {
  refill();
  const taken = Math.max(0, Math.min(max, Math.floor(bucket.tokens)));
  bucket.tokens -= taken;
  return taken;
}
// Puts back what a reservation did not use.
export function refundTraceRequests(count) {
  if (!(count > 0)) return;
  refill();
  bucket.tokens = Math.min(BUCKET_SIZE, bucket.tokens + count);
}
// How long until the bucket holds one request.
function untilOne() {
  refill();
  return bucket.tokens >= 1 ? 0 : Math.ceil(((1 - bucket.tokens) * BUCKET_REFILL_MS) / BUCKET_SIZE);
}
// Tests: a full bucket.
export function resetMessageTraceBudget(tokens = BUCKET_SIZE) {
  bucket.tokens = tokens;
  bucket.at = Date.now();
}

// --- the window and the rows ------------------------------------------------------------------------

// [start, end] in ms for a letter sent at sentAt and handed to EOP at handoffs (ms, maybe none).
export function traceWindow(sentAt, handoffs = [], now = Date.now()) {
  const sent = Date.parse(sentAt);
  const last = handoffs.length ? Math.max(...handoffs) : null;
  const first = handoffs.length ? Math.min(sent, ...handoffs) : sent;
  const start = Math.max(first - BEFORE_MS, now - TRACE_HISTORY_MS + MINUTE_MS);
  const end = Math.min(now, last != null ? last + AFTER_HANDOFF_MS : sent + AFTER_SENT_MS);
  return { start, end };
}

// A Message-ID as messages.message_id stores it: trimmed, with the angle brackets.
export function normalizeMessageId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.startsWith('<') ? text : `<${text}>`;
}

// Whether the letter can be traced at all: { ok } or { ok: false, code }.
export function traceableLetter({ sentAt }, now = Date.now()) {
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent)) return { ok: false, code: 'trace_sent_at_unknown' };
  if (sent < now - TRACE_HISTORY_MS + BEFORE_MS) return { ok: false, code: 'trace_too_old' };
  return { ok: true };
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

export function presentTrace(row) {
  if (!row) return null;
  return {
    state: row.state,
    requestedAt: iso(row.requested_at),
    checkedAt: iso(row.checked_at),
    error: row.error ?? null,
    recipients: (Array.isArray(row.recipients) ? row.recipients : []).map((r) => ({
      recipient: r.recipient,
      status: r.status,
      receivedAt: r.receivedAt ?? null,
      statusCode: r.statusCode ?? null,
      detail: r.detail ?? null,
      eventAt: r.eventAt ?? null,
      deliveredAt: r.deliveredAt ?? null,
      detailsRead: !!r.detailsRead,
    })),
  };
}

export async function readTrace(accountId, messageId) {
  const { rows: [row] } = await query('SELECT * FROM message_eop_traces WHERE account_id = $1 AND message_id = $2', [accountId, messageId]);
  return row ?? null;
}

// The request: answers { trace, queued }. A trace queued or running, or checked less than RECHECK_MS
// ago, is answered as it is; else the row goes back to 'queued' (its last answer kept until the new
// one) and a job is queued.
export async function requestTrace({ accountId, messageId, sentAt, userId = null, now = Date.now() }) {
  const existing = await readTrace(accountId, messageId);
  let stale = false;
  if (existing && (existing.state === 'queued' || existing.state === 'running')) {
    // Answered as it is while its job lives; a row whose job is gone queues again.
    const { rows: [live] } = existing.job_id == null ? { rows: [] } : await query(
      "SELECT 1 FROM jobs WHERE id = $1 AND status IN ('queued', 'running')", [existing.job_id],
    );
    const age = now - Date.parse(new Date(existing.updated_at).toISOString());
    if (live || age < STALE_MS) return { trace: existing, queued: false };
    stale = true;
  }
  const checked = existing?.checked_at ? Date.parse(new Date(existing.checked_at).toISOString()) : null;
  if (!stale && existing && checked != null && now - checked < RECHECK_MS) {
    return { trace: existing, queued: false, cooldownUntil: new Date(checked + RECHECK_MS).toISOString() };
  }
  // The row and its job together: a failed enqueue leaves no "already asked" row behind.
  return withTransaction(async (tx) => {
    const { rows: [row] } = await tx.query(`
      INSERT INTO message_eop_traces (account_id, message_id, state, sent_at, requested_by, requested_at, cursor, error)
      VALUES ($1, $2, 'queued', $3, $4, $5, NULL, NULL)
      ON CONFLICT (account_id, message_id) DO UPDATE SET
        state = 'queued', sent_at = EXCLUDED.sent_at, requested_by = EXCLUDED.requested_by, requested_at = EXCLUDED.requested_at,
        cursor = NULL, error = NULL, updated_at = NOW()
        WHERE message_eop_traces.state NOT IN ('queued', 'running') OR $6::boolean
      RETURNING *
    `, [accountId, messageId, sentAt, userId, new Date(now).toISOString(), stale]);
    if (!row) return { trace: await readTrace(accountId, messageId), queued: false };
    const { job } = await enqueueJob({ kind: MESSAGE_TRACE_KIND, payload: { accountId, messageId }, createdBy: userId, accountId }, tx);
    await tx.query('UPDATE message_eop_traces SET job_id = $3 WHERE account_id = $1 AND message_id = $2', [accountId, messageId, job.id]);
    return { trace: { ...row, job_id: job.id }, queued: true };
  });
}

async function save(accountId, messageId, fields) {
  const sets = Object.keys(fields).map((key, i) => `${key} = $${i + 3}`);
  await query(`UPDATE message_eop_traces SET ${sets.join(', ')}, updated_at = NOW() WHERE account_id = $1 AND message_id = $2`,
    [accountId, messageId, ...Object.values(fields).map((v) => (v != null && typeof v === 'object' ? JSON.stringify(v) : v))]);
}

// When the node's log saw the letter handed to EOP (R-17's stored outcomes), in ms.
async function handoffsOf(accountId, messageId) {
  const { rows } = await query(`SELECT event_at FROM message_delivery_status
    WHERE account_id = $1 AND message_id = $2 AND source = 'log' AND state = 'sent' AND event_at IS NOT NULL`, [accountId, messageId]);
  return rows.map((r) => Date.parse(new Date(r.event_at).toISOString())).filter(Number.isFinite);
}

const merge = (stored, rows) => {
  const byKey = new Map((stored ?? []).map((r) => [`${r.traceId}|${r.recipient}`, r]));
  for (const row of rows) {
    const key = `${row.id}|${row.recipientAddress}`;
    const before = byKey.get(key);
    byKey.set(key, {
      ...(before ?? {}),
      traceId: row.id,
      recipient: row.recipientAddress,
      status: row.status,
      receivedAt: row.receivedDateTime,
      // A status that changed needs its details read again.
      ...(before && before.status !== row.status ? { detailsRead: false } : {}),
    });
  }
  return [...byKey.values()].sort((a, b) => a.recipient.localeCompare(b.recipient) || String(a.receivedAt).localeCompare(String(b.receivedAt)));
};

export async function handleTraceJob(job, { now = Date.now() } = {}) {
  const accountId = job.payload?.accountId;
  const messageId = job.payload?.messageId;
  if (!accountId || !messageId) throw new JobError('The job names no letter', { outcome: 'fail', code: 'trace_letter_invalid' });
  await pruneMessageTraces();
  const row = await readTrace(accountId, messageId);
  // The mailbox was deleted (the row went with it) or a newer request took over.
  if (!row || (row.job_id != null && String(row.job_id) !== String(job.id))) return { skipped: 'trace_superseded' };
  const source = await resolveTraceSource();
  if (!source) {
    await save(accountId, messageId, { state: 'failed', error: 'trace_not_connected' });
    return { error: 'trace_not_connected' };
  }
  // The requests are reserved before the first one is sent (jobs running at once never take more
  // than the bucket holds); what is not used goes back in finally.
  const allowed = reserveTraceRequests(MAX_REQUESTS_PER_RUN);
  if (allowed < 1) {
    // No requests left this time: a new job for when the bucket has one (no attempt spent).
    await save(accountId, messageId, { state: 'queued', error: 'trace_budget' });
    await enqueueFollowUp(accountId, messageId, untilOne() || MINUTE_MS);
    return { waiting: 'trace_budget' };
  }
  await save(accountId, messageId, { state: 'running' });
  let used = 0;
  let recipients = Array.isArray(row.recipients) ? row.recipients : [];
  try {
    const wanted = normalizeMessageId(messageId);
    if (row.cursor?.done !== true) {
      const { start, end } = traceWindow(new Date(row.sent_at).toISOString(), await handoffsOf(accountId, messageId), now);
      const listed = await source.list({ start, end, maxRequests: allowed, cursor: row.cursor?.list ?? null });
      used += listed.requests;
      const mine = listed.rows.filter((r) => normalizeMessageId(r.messageId) === wanted);
      // A new request starts from the stored recipients, so a listing in parts adds up.
      recipients = merge(row.cursor?.list ? recipients : recipients.filter((r) => mine.some((m) => m.id === r.traceId)), mine);
      if (!listed.complete) {
        await save(accountId, messageId, { state: 'queued', recipients, cursor: { list: listed.cursor } });
        await enqueueFollowUp(accountId, messageId);
        return { partial: true };
      }
    }
    // The details of each recipient not read since its status changed, within the budget.
    let left = allowed - used;
    let detailsLeft = false;
    for (const r of recipients.slice(0, MAX_DETAILS)) {
      if (r.detailsRead) continue;
      if (left < 1) {
        detailsLeft = true;
        break;
      }
      const { events, requests } = await source.details({ id: r.traceId, recipientAddress: r.recipient });
      used += requests;
      left -= requests;
      const read = readEvents(events);
      Object.assign(r, {
        statusCode: read.statusCode, detail: read.detail, eventAt: read.eventAt, deliveredAt: read.deliveredAt, detailsRead: true,
      });
    }
    if (detailsLeft) {
      await save(accountId, messageId, { state: 'queued', recipients, cursor: { done: true } });
      await enqueueFollowUp(accountId, messageId);
      return { partial: true };
    }
    await save(accountId, messageId, {
      state: 'done', recipients, cursor: null, error: null, checked_at: new Date(now).toISOString(),
    });
    return { recipients: recipients.length };
  } catch (err) {
    // The requests sent before the error, the failed one included (the source counts them).
    used += Number.isFinite(err?.requests) ? err.requests : 1;
    const code = err instanceof TraceSourceError || err instanceof TenantError ? err.code : 'trace_failed';
    if (code === 'trace_throttled' || code === 'graph_throttled') {
      // Graph says the tenant's 100 are gone: nothing of the reservation goes back, and the job
      // waits a minute.
      used = allowed;
      await save(accountId, messageId, { state: 'queued', recipients, error: code });
      throw new JobError('The message trace asked to slow down', { outcome: 'retry', code, delayMs: err.retryAfterMs ?? THROTTLED_MS });
    }
    if (!(err instanceof TraceSourceError || err instanceof TenantError)) console.error(`Message trace failed: ${err?.name || 'error'}`);
    await save(accountId, messageId, { state: 'failed', recipients, error: code, checked_at: new Date(now).toISOString() });
    return { error: code };
  } finally {
    refundTraceRequests(allowed - Math.min(used, allowed));
  }
}

async function enqueueFollowUp(accountId, messageId, delayMs = FOLLOW_UP_MS) {
  const { job } = await enqueueJob({ kind: MESSAGE_TRACE_KIND, payload: { accountId, messageId }, accountId, delayMs });
  await query('UPDATE message_eop_traces SET job_id = $3 WHERE account_id = $1 AND message_id = $2', [accountId, messageId, job.id]);
}

// Traces older than RETENTION_DAYS (since their last change) go: the poll timer and each job call it.
export async function pruneMessageTraces() {
  await query('DELETE FROM message_eop_traces WHERE updated_at < NOW() - make_interval(days => $1::int)', [RETENTION_DAYS]);
}

// A job that ended without finishing its row (its retries ran out while waiting for the budget or
// throttled): the row says failed with the job's code instead of staying queued.
export async function settleTraceJob(job) {
  if (job?.status === 'done') return;
  const accountId = job?.payload?.accountId;
  const messageId = job?.payload?.messageId;
  if (!accountId || !messageId) return;
  await query(`UPDATE message_eop_traces SET state = 'failed', error = $4, updated_at = NOW()
    WHERE account_id = $1 AND message_id = $2 AND job_id = $3 AND state IN ('queued', 'running')`,
  [accountId, messageId, job.id, job.error_code || 'trace_failed']);
}

export function registerMessageTraceKind() {
  registerJobKind(MESSAGE_TRACE_KIND, {
    maxAttempts: MAX_JOB_ATTEMPTS,
    handler: (job) => handleTraceJob(job),
    onSettled: (job) => settleTraceJob(job).catch((err) => console.error(`Message trace row not settled: ${err?.code || err?.message}`)),
  });
}
