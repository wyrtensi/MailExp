import { query } from '../db.js';
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
// most MAX_REQUESTS_PER_RUN. A run without requests left is queued again for when the bucket has
// one; a listing cut short keeps its cursor and goes on in a follow-up job; throttling queues the
// job again after a minute (the bucket is spent as if all were used). A letter is asked again at
// most once per RECHECK_MS (the request answers the stored trace meanwhile).

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
function spend(count) {
  refill();
  bucket.tokens = Math.max(0, bucket.tokens - count);
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
  if (existing && (existing.state === 'queued' || existing.state === 'running')) return { trace: existing, queued: false };
  const checked = existing?.checked_at ? Date.parse(new Date(existing.checked_at).toISOString()) : null;
  if (existing && checked != null && now - checked < RECHECK_MS) return { trace: existing, queued: false, cooldownUntil: new Date(checked + RECHECK_MS).toISOString() };
  const { rows: [row] } = await query(`
    INSERT INTO message_eop_traces (account_id, message_id, state, sent_at, requested_by, requested_at, cursor, error)
    VALUES ($1, $2, 'queued', $3, $4, $5, NULL, NULL)
    ON CONFLICT (account_id, message_id) DO UPDATE SET
      state = 'queued', sent_at = EXCLUDED.sent_at, requested_by = EXCLUDED.requested_by, requested_at = EXCLUDED.requested_at,
      cursor = NULL, error = NULL, updated_at = NOW()
      WHERE message_eop_traces.state NOT IN ('queued', 'running')
    RETURNING *
  `, [accountId, messageId, sentAt, userId, new Date(now).toISOString()]);
  if (!row) return { trace: await readTrace(accountId, messageId), queued: false };
  const { job } = await enqueueJob({ kind: MESSAGE_TRACE_KIND, payload: { accountId, messageId }, createdBy: userId, accountId });
  await query('UPDATE message_eop_traces SET job_id = $3 WHERE account_id = $1 AND message_id = $2', [accountId, messageId, job.id]);
  return { trace: { ...row, job_id: job.id }, queued: true };
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
  const row = await readTrace(accountId, messageId);
  // The mailbox was deleted (the row went with it) or a newer request took over.
  if (!row || (row.job_id != null && String(row.job_id) !== String(job.id))) return { skipped: 'trace_superseded' };
  const source = await resolveTraceSource();
  if (!source) {
    await save(accountId, messageId, { state: 'failed', error: 'trace_not_connected' });
    return { error: 'trace_not_connected' };
  }
  const allowed = Math.min(MAX_REQUESTS_PER_RUN, availableTraceRequests());
  if (allowed < 1) {
    // No requests left this time: the same job again when the bucket has one.
    throw new JobError('The message trace budget is spent for now', { outcome: 'retry', code: 'trace_budget', delayMs: untilOne() || MINUTE_MS });
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
    const code = err instanceof TraceSourceError || err instanceof TenantError ? err.code : 'trace_failed';
    if (code === 'trace_throttled' || code === 'graph_throttled') {
      // Graph says the tenant's 100 are gone: the bucket is spent and the job waits a minute.
      used = allowed;
      await save(accountId, messageId, { state: 'queued', recipients, error: code });
      throw new JobError('The message trace asked to slow down', { outcome: 'retry', code, delayMs: err.retryAfterMs ?? THROTTLED_MS });
    }
    if (!(err instanceof TraceSourceError || err instanceof TenantError)) console.error(`Message trace failed: ${err?.name || 'error'}`);
    await save(accountId, messageId, { state: 'failed', recipients, error: code, checked_at: new Date(now).toISOString() });
    return { error: code };
  } finally {
    spend(used);
  }
}

async function enqueueFollowUp(accountId, messageId) {
  const { job } = await enqueueJob({ kind: MESSAGE_TRACE_KIND, payload: { accountId, messageId }, accountId, delayMs: FOLLOW_UP_MS });
  await query('UPDATE message_eop_traces SET job_id = $3 WHERE account_id = $1 AND message_id = $2', [accountId, messageId, job.id]);
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
