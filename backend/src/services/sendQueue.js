// Undo send and send later: every letter goes out through a send_message job of the durable job
// queue (services/jobQueue.js). routes/send.js builds and checks the letter while the writer waits,
// then enqueues it here due SEND_UNDO_WINDOW_MS later (undo) or at the time the writer chose (send
// later). The job's letter lives in outgoing_messages until it is sent or cancelled.
//
// Sending is at most once: the handler marks the job right before the letter goes to the mail
// server, so a worker that dies after that point leaves the job needs_attention, never sent twice.
// A failure that certainly delivered nothing is retried (a temporary one) or fails the job; either
// way the letter is kept, listed with its error under Scheduled, and its author is told.
import { query, withTransaction } from './db.js';
import { recordAudit } from './auditLog.js';
import {
  JOB_KEPT_FAILED_MS, cancelJob, enqueueJob, getJob, registerJobKind, rescheduleJob, JobError,
} from './jobQueue.js';
import { deliverOutgoingMessage } from './sendDelivery.js';
import { fromHeaderAddress, isForeignNodeAliasAddress } from '../utils/senderNames.js';

export const SEND_JOB_KIND = 'send_message';
// The undo window after Send: fixed by the owner at five seconds.
export const SEND_UNDO_WINDOW_MS = 5000;
// How far ahead a letter can be scheduled.
export const SEND_LATER_MAX_MS = 366 * 24 * 60 * 60 * 1000;
export const SEND_MAX_ATTEMPTS = 5;
// Statuses a letter is listed under Scheduled in: waiting, going out, or kept after a failure.
export const LISTED_STATUSES = Object.freeze(['queued', 'running', 'failed', 'needs_attention']);
// A cancel or edit may take a letter from these: waiting, or kept after a failure.
export const CANCELLABLE_STATUSES = Object.freeze(['queued', 'failed', 'needs_attention']);
// The error code of a letter the mail server accepted but whose job could not be recorded done: it
// needs attention (its content is kept), and is never sent again.
export const DELIVERED_UNRECORDED = 'delivered_unrecorded';
// Error codes of a kept letter that is never sent again (nor moved to another time).
const NO_RESEND_CODES = Object.freeze([DELIVERED_UNRECORDED]);

let broadcast = () => {};

// ── The letter as stored (outgoing_messages.mail) ───────────────────────────────────────────

// mail: { options, meta } with Buffer attachment contents, plus uploads: the indexes of the
// attachments the writer added (the rest are inline images and forwarded attachments, which the
// composer gets back another way). Stored as JSON with the contents in base64.
export function serializeMail({ options, meta, uploads = [] }) {
  const attachments = (options.attachments || []).map(a => ({
    ...a,
    content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content ?? '')).toString('base64'),
    encoding: 'base64',
  }));
  return Buffer.from(JSON.stringify({
    options: { ...options, ...(attachments.length ? { attachments } : {}) },
    meta,
    uploads,
  }));
}

export function deserializeMail(buffer) {
  const stored = JSON.parse(Buffer.from(buffer).toString('utf8'));
  const attachments = (stored.options.attachments || []).map(a => {
    const rest = { ...a, content: Buffer.from(a.content, 'base64') };
    delete rest.encoding;
    return rest;
  });
  return {
    options: { ...stored.options, ...(attachments.length ? { attachments } : {}) },
    meta: stored.meta,
    uploads: stored.uploads || [],
  };
}

// sendAt from the client: absent for a send with the undo window, else an ISO time with an explicit
// offset or Z (stored as UTC), in the future and no further than SEND_LATER_MAX_MS. Returns
// { sendAt } or { error, code }; a time that has passed also carries it as requestedAt, so a
// retried request can still be matched to the letter it enqueued while the time was ahead.
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i;
export function parseSendAt(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return { sendAt: null };
  const at = typeof value === 'string' && ISO_WITH_OFFSET_RE.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return { error: 'sendAt must be an ISO date and time with a time zone offset', code: 'send_at_invalid' };
  if (at <= now) return { error: 'The scheduled time has already passed.', code: 'send_at_past', requestedAt: new Date(at) };
  if (at - now > SEND_LATER_MAX_MS) return { error: 'A letter can be scheduled at most a year ahead.', code: 'send_at_too_far' };
  return { sendAt: new Date(at) };
}

// What the client keeps of its composer context (backend routes/send.js filters to these): the
// reply or forward it is, its thread and quote. Nothing else of a client's object is stored.
export const COMPOSE_CONTEXT_KEYS = Object.freeze([
  'isReply', 'isReplyAll', 'isForward', 'threadId', 'originalFrom', 'quoteMeta', 'quoteLang', 'quoteExtra',
  'allRecipients', 'forwardedAttachments',
]);

export function pickComposeContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const picked = {};
  for (const key of COMPOSE_CONTEXT_KEYS) if (context[key] !== undefined) picked[key] = context[key];
  return picked;
}

// ── Enqueue ─────────────────────────────────────────────────────────────────────────────────

// What the client gets back for a send job: enough to show the undo toast or the scheduled time.
// dueInMs: how long until it is due by the database's clock, so the client counts the undo window
// from when it got the answer and never mixes its clock with the server's.
export function sendJobResponse(job) {
  return {
    ok: true,
    jobId: String(job.id),
    status: job.status,
    sendAt: new Date(job.run_at).toISOString(),
    dueInMs: Math.max(0, Math.round(Number(job.due_in_ms) || 0)),
    scheduled: !!job.payload?.scheduled,
  };
}

// The job already enqueued for this writer's idempotency key, or null.
export async function existingSendJob(dedupeKey) {
  if (!dedupeKey) return null;
  const { rows: [job] } = await query(
    'SELECT *, (EXTRACT(EPOCH FROM (run_at - now())) * 1000)::float8 AS due_in_ms FROM jobs WHERE kind = $1 AND dedupe_key = $2',
    [SEND_JOB_KIND, dedupeKey]
  );
  return job || null;
}

// Whether a repeated request (same idempotency key) is the same send as the job it found: a
// cancelled letter or another time is a different send, refused rather than answered with the old
// job. Returns null when it is the same, else { status, error, code }.
export function sendRetryConflict(job, sendAt) {
  if (job.status === 'cancelled') {
    return { status: 409, error: 'This letter was cancelled. Send it again from the composer.', code: 'send_cancelled' };
  }
  // A job enqueued before requestedAt was stored is compared with its run_at, as before.
  const requested = job.payload && Object.hasOwn(job.payload, 'requestedAt')
    ? job.payload.requestedAt
    : (job.payload?.scheduled ? new Date(job.run_at).toISOString() : null);
  const sameTime = sendAt
    ? !!requested && Date.parse(requested) === sendAt.getTime()
    : !requested;
  if (!sameTime) return { status: 409, error: 'This request repeats another send with a different time.', code: 'idempotency_conflict' };
  return null;
}

// A change everyone's Scheduled list shows: a scheduled letter, or one that did not go out. A
// letter in its undo window passes unnoticed by the other tabs.
function listedChange(job) {
  return !!job.payload?.scheduled || job.status === 'failed' || job.status === 'needs_attention';
}

// What the list of waiting letters shows: kept apart from the body (outgoing_messages.summary).
function composeSummary(compose) {
  return {
    subject: compose.subject ?? '',
    to: compose.to || [],
    cc: compose.cc || [],
    bcc: compose.bcc || [],
    attachmentCount: (compose.attachments || []).length + (compose.forwardedAttachments || []).length,
  };
}

// Enqueues a built letter. sendAt: the chosen time (a Date) for send later, else the undo window.
// Resolves { job, created }.
export async function enqueueOutgoingSend({ userId, accountId, dedupeKey = null, sendAt = null, compose, mail }) {
  const result = await withTransaction(async (tx) => {
    const enqueued = await enqueueJob({
      kind: SEND_JOB_KIND,
      // requestedAt: the time the writer asked for (null: the undo window), which a retried request
      // is compared with; run_at moves (a retry's backoff, a reschedule).
      payload: { scheduled: !!sendAt, messageId: mail.options.messageId, requestedAt: sendAt ? sendAt.toISOString() : null },
      runAt: sendAt,
      delayMs: sendAt ? null : SEND_UNDO_WINDOW_MS,
      createdBy: userId,
      accountId,
      dedupeKey,
      maxAttempts: SEND_MAX_ATTEMPTS,
    }, tx);
    if (enqueued.created) {
      await tx.query('INSERT INTO outgoing_messages (job_id, compose, summary, mail) VALUES ($1, $2::jsonb, $3::jsonb, $4)',
        [enqueued.job.id, JSON.stringify(compose), JSON.stringify(composeSummary(compose)), serializeMail(mail)]);
    }
    return enqueued;
  });
  if (result.created) {
    recordAudit({
      actorUserId: userId,
      accountId,
      action: 'message.send_queued',
      details: {
        jobId: String(result.job.id),
        messageId: mail.options.messageId,
        sendAt: new Date(result.job.run_at).toISOString(),
        scheduled: !!sendAt,
      },
    });
    if (listedChange(result.job)) broadcast({ type: 'scheduled_changed', accountId });
  }
  return result;
}

// ── Listing and managing ────────────────────────────────────────────────────────────────────

// Mailboxes are shared: everyone sees that a letter is waiting in a mailbox (its recipients,
// subject and time, as they will see its Sent copy). Its author and administrators manage it,
// and only they see its Bcc. A letter that did not go out is kept JOB_KEPT_FAILED_MS after its
// last change (keptUntil).
function summarize(row, { userId, isAdmin }) {
  const canManage = isAdmin || (!!row.created_by && row.created_by === userId);
  const summary = row.summary || {};
  const unsent = row.status === 'failed' || row.status === 'needs_attention';
  return {
    id: String(row.id),
    accountId: row.account_id,
    status: row.status,
    sendAt: new Date(row.run_at).toISOString(),
    scheduled: !!row.payload?.scheduled,
    subject: summary.subject ?? '',
    to: summary.to || [],
    cc: summary.cc || [],
    ...(canManage ? { bcc: summary.bcc || [] } : {}),
    attachmentCount: summary.attachmentCount || 0,
    author: row.created_by ? { id: row.created_by, email: row.author_email || null } : null,
    canManage,
    errorCode: row.error_code || null,
    error: unsent || row.status === 'queued' ? (row.last_error || null) : null,
    ...(unsent ? { keptUntil: new Date(new Date(row.updated_at).getTime() + JOB_KEPT_FAILED_MS).toISOString() } : {}),
    attempts: row.attempts,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// The list reads the small summary column only, never the letter's compose or mail.
const SUMMARY_SQL = `
  SELECT j.*, o.summary, COALESCE(NULLIF(u.email, ''), u.username) AS author_email
    FROM jobs j
    LEFT JOIN outgoing_messages o ON o.job_id = j.id
    LEFT JOIN users u ON u.id = j.created_by`;

export async function listScheduled({ accountId = null, userId, isAdmin }) {
  const { rows } = await query(
    `${SUMMARY_SQL}
      WHERE j.kind = $1 AND j.status = ANY($2::text[]) AND ($3::uuid IS NULL OR j.account_id = $3)
      ORDER BY j.run_at, j.id
      LIMIT 500`,
    [SEND_JOB_KIND, LISTED_STATUSES, accountId]
  );
  return rows.map(row => summarize(row, { userId, isAdmin }));
}

export async function getScheduled(id, { userId, isAdmin }) {
  const { rows: [row] } = await query(`${SUMMARY_SQL} WHERE j.kind = $1 AND j.id = $2`, [SEND_JOB_KIND, id]);
  return row ? summarize(row, { userId, isAdmin }) : null;
}

function refusal(status, error, code) {
  return Object.assign(new Error(error), { status, code });
}

async function managedJob(id, { userId, isAdmin }) {
  const job = await getJob(id);
  if (!job || job.kind !== SEND_JOB_KIND) throw refusal(404, 'Scheduled letter not found', 'not_found');
  if (!isAdmin && job.created_by !== userId) {
    throw refusal(403, 'Only the author of this letter or an administrator can change it.', 'not_author');
  }
  return job;
}

function notCancellable(job) {
  if (job.status === 'running') return refusal(409, 'The letter is being sent and can no longer be stopped.', 'send_started');
  if (job.status === 'done') return refusal(409, 'The letter has been sent already.', 'already_sent');
  return refusal(409, 'The letter is no longer waiting to be sent.', 'not_cancellable');
}

// Cancels the letter while it waits (or after it failed) and gives back what the writer composed,
// so the composer reopens with it: undo (reason 'undo'), edit ('edit') or discard ('discard',
// which gives nothing back). An edited letter that was scheduled comes back with its time
// (sendAt), which the composer keeps. Atomic: a letter a worker has claimed is refused (send_started).
export async function cancelScheduled(id, { userId, isAdmin, reason = 'discard' }) {
  const job = await managedJob(id, { userId, isAdmin });
  const out = await withTransaction(async (tx) => {
    const cancelled = await cancelJob(job.id, { from: CANCELLABLE_STATUSES }, tx);
    if (!cancelled) return null;
    const { rows: [content] } = await tx.query('DELETE FROM outgoing_messages WHERE job_id = $1 RETURNING compose, mail', [job.id]);
    return { cancelled, content };
  });
  if (!out) throw notCancellable(await getJob(job.id) || job);
  // A letter the server accepted is only dismissed: never given back to send again (by the row
  // cancelled, so a relabel between the read and the cancel counts).
  const outcome = NO_RESEND_CODES.includes(out.cancelled.error_code) ? 'discard' : reason;
  recordAudit({
    actorUserId: userId,
    accountId: job.account_id,
    action: 'message.send_cancelled',
    details: { jobId: String(job.id), messageId: job.payload?.messageId ?? null, reason: outcome },
  });
  if (listedChange(job)) broadcast({ type: 'scheduled_changed', accountId: job.account_id });
  if (outcome === 'discard' || !out.content) return { ok: true };
  const keepsTime = job.status === 'queued' && !!job.payload?.scheduled && new Date(job.run_at).getTime() > Date.now();
  return {
    ok: true,
    compose: restoredCompose(out.content),
    ...(keepsTime ? { sendAt: new Date(job.run_at).toISOString(), scheduled: true } : {}),
  };
}

// The composer's fields back, with the attachments the writer added (their contents from the
// stored letter). Inline images are still data: URIs in the body; forwarded attachments are
// references the next send resolves again.
function restoredCompose({ compose, mail }) {
  const stored = deserializeMail(mail);
  const attachments = stored.uploads
    .map(index => stored.options.attachments?.[index])
    .filter(Boolean)
    .map(a => ({ filename: a.filename, contentType: a.contentType, size: a.content.length, content: a.content.toString('base64') }));
  return { ...compose, attachments };
}

// Moves a waiting letter to another time (it is a scheduled letter from then on, even one moved
// out of its undo window), or sends again one that failed (resend: true, needed for a failed
// letter or one that needs attention, so it is never re-sent by accident).
export async function rescheduleScheduled(id, { userId, isAdmin, sendAt, resend = false }) {
  const job = await managedJob(id, { userId, isAdmin });
  const from = resend ? CANCELLABLE_STATUSES : ['queued'];
  const moved = await rescheduleJob(job.id, {
    runAt: sendAt, from, payloadPatch: resend ? null : { scheduled: true }, exceptErrorCodes: NO_RESEND_CODES,
  });
  if (!moved) {
    const current = await getJob(job.id) || job;
    if (current.status !== 'queued' && NO_RESEND_CODES.includes(current.error_code)) {
      throw refusal(409, 'The mail server accepted this letter already: it is not sent again.', 'already_delivered');
    }
    if (!resend && (current.status === 'failed' || current.status === 'needs_attention')) {
      throw refusal(409, 'The letter was not sent. Confirm sending it again.', 'resend_required');
    }
    throw notCancellable(current);
  }
  recordAudit({
    actorUserId: userId,
    accountId: job.account_id,
    action: 'message.send_rescheduled',
    details: { jobId: String(job.id), messageId: job.payload?.messageId ?? null, sendAt: new Date(moved.run_at).toISOString(), resend: !!resend },
  });
  broadcast({ type: 'scheduled_changed', accountId: job.account_id });
  return moved;
}

// ── The handler ─────────────────────────────────────────────────────────────────────────────

// A delivered letter whose lease the sweep took meanwhile (the worker stalled): the sweep marked it
// needs_attention (lease_expired, or delivered_unrecorded when the delivery was marked in time), but
// the server did take it. It is done, and its content goes, so a resend never
// sends it twice. Resolves the row, or null.
async function settleSweptDelivery(jobId) {
  return withTransaction(async (tx) => {
    const { rows: [row] } = await tx.query(
      `UPDATE jobs SET status = 'done', finished_at = now(), error_code = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'needs_attention' AND error_code IN ('lease_expired', $2)
       RETURNING *`,
      [jobId, DELIVERED_UNRECORDED]
    );
    if (row) await tx.query('DELETE FROM outgoing_messages WHERE job_id = $1', [jobId]);
    return row || null;
  });
}

// Resolves { messageId, postSend, completed, settledRow }: completed when the queue finished the job
// (and will report it), settledRow when it was finished here because its claim was gone (see
// settleSweptDelivery).
async function handleSendJob(job, ctx, imapManager) {
  const { rows: [content] } = await query('SELECT mail FROM outgoing_messages WHERE job_id = $1', [job.id]);
  if (!content) throw new JobError('The letter of this job is gone.', { outcome: 'fail', code: 'letter_missing' });
  // A letter goes out on behalf of its author: not once the author was disabled or deleted.
  const { rows: [author] } = job.created_by
    ? await query('SELECT disabled_at FROM users WHERE id = $1', [job.created_by])
    : { rows: [] };
  if (!author || author.disabled_at) {
    throw new JobError('The author of this letter can no longer send mail.', { outcome: 'fail', code: 'author_disabled' });
  }
  // account_id is NULL once the mailbox was deleted (the deletion fails waiting letters first; this
  // catches one that was already running).
  const { rows: [account] } = job.account_id
    ? await query('SELECT * FROM email_accounts WHERE id = $1', [job.account_id])
    : { rows: [] };
  if (!account) throw new JobError('The mailbox of this letter was deleted.', { outcome: 'fail', code: 'account_missing' });
  // A mail node mailbox sends only from its own address (D-16). The route refuses such an alias, but a
  // letter queued before (scheduled, or sent again after a failure) carries its From already: the
  // node's SMTP would refuse it, so it fails here, before SMTP.
  const mail = deserializeMail(content.mail);
  if (isForeignNodeAliasAddress(account, fromHeaderAddress(mail?.options?.from))) {
    throw new JobError('This sender address is not a mailbox: choose another From. An administrator can make it a separate mailbox.', {
      outcome: 'fail', code: 'node_alias_stale',
    });
  }

  let settledRow = null;
  let completed = false;
  let delivered = false;
  // Sent: the job is done and the letter's content goes, in one transaction.
  const complete = () => ctx.complete(async (tx) => {
    await tx.query('DELETE FROM outgoing_messages WHERE job_id = $1', [job.id]);
  });
  const sent = await deliverOutgoingMessage({
    account,
    mail,
    actorUserId: job.created_by,
    imapManager,
    detachPostSend: true,
    markEffectStarted: () => ctx.markEffectStarted(),
    onDelivered: async () => {
      delivered = true;
      // Recorded first, apart from the job's completion: should the worker stop before the job is
      // done, the sweep labels it delivered_unrecorded, never an uncertain send to offer again.
      await ctx.markEffectDone(DELIVERED_UNRECORDED);
      completed = await complete();
      if (!completed) settledRow = await settleSweptDelivery(job.id);
    },
  });
  // The server took the letter but recording it failed (deliverOutgoingMessage logged why): one
  // more try, then the job is settled as delivered-unrecorded rather than an uncertain send, so
  // nobody is offered to send a delivered letter again.
  if (delivered && !completed && !settledRow) {
    try {
      completed = await complete();
      if (!completed) settledRow = await settleSweptDelivery(job.id);
    } catch (err) {
      console.error(`[send] Recording delivered job ${job.id} failed again:`, err?.message);
      throw new JobError('The mail server accepted the letter, but recording it as sent failed. Do not send it again.', {
        outcome: 'needs_attention', code: DELIVERED_UNRECORDED,
      });
    }
  }
  return { ...sent, completed, settledRow };
}

// Tells the author (their open tabs) how the letter ended, and the tabs to refresh their list. A
// sent letter is reported once its Sent copy is handled (postSend); a failure names the letter's
// subject to its author only, so they know which one it was. Every failure is journaled, a letter
// whose author is gone included.
async function onSendSettled(job, postSend = null) {
  if (listedChange(job)) broadcast({ type: 'scheduled_changed', accountId: job.account_id });
  if (job.status === 'done') {
    if (!job.created_by) return;
    const copy = postSend ? await postSend : {};
    broadcast({
      type: 'send_done', jobId: String(job.id), accountId: job.account_id,
      sentFolder: copy.sentFolder ?? null, sentCopySaved: copy.sentCopySaved ?? null,
    }, job.created_by);
    return;
  }
  recordAudit({
    actorUserId: job.created_by,
    accountId: job.account_id,
    action: 'message.send_failed',
    details: { jobId: String(job.id), messageId: job.payload?.messageId ?? null, status: job.status, code: job.error_code ?? null },
  });
  if (!job.created_by) return;
  const { rows: [letter] } = await query("SELECT summary->>'subject' AS subject FROM outgoing_messages WHERE job_id = $1", [job.id]);
  broadcast({
    type: 'send_failed', jobId: String(job.id), accountId: job.account_id,
    status: job.status, code: job.error_code ?? null, error: job.last_error ?? null, subject: letter?.subject ?? null,
  }, job.created_by);
}

// Registers the send_message kind. imapManager: the mail engine (Sent copy, sync, broadcast).
export function registerSendJobKind({ imapManager }) {
  broadcast = (data, userId = null) => {
    try { imapManager.broadcast(data, userId); } catch (err) { console.error('[send] Broadcast failed:', err.message); }
  };
  // The Sent copy work of a job the queue is about to report done (onSettled follows the handler).
  const postSends = new Map();
  registerJobKind(SEND_JOB_KIND, {
    maxAttempts: SEND_MAX_ATTEMPTS,
    handler: async (job, ctx) => {
      const { postSend, completed, settledRow } = await handleSendJob(job, ctx, imapManager);
      // Finished here, not by the queue (its claim was swept): reported here too. Kept for onSettled
      // only when the queue will call it.
      if (settledRow) onSendSettled(settledRow, postSend).catch(err => console.error('[send] Reporting a send failed:', err?.message));
      else if (completed) postSends.set(String(job.id), postSend);
    },
    onSettled: (row) => {
      const postSend = postSends.get(String(row.id)) || null;
      postSends.delete(String(row.id));
      return onSendSettled(row, postSend);
    },
  });
}
