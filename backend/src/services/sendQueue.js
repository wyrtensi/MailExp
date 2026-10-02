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
import { cancelJob, enqueueJob, getJob, registerJobKind, rescheduleJob, JobError } from './jobQueue.js';
import { deliverOutgoingMessage } from './sendDelivery.js';

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

// sendAt from the client: absent for a send with the undo window, else an ISO time in the future
// (stored as UTC) no further than SEND_LATER_MAX_MS. Returns { sendAt } or { error, code }.
export function parseSendAt(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return { sendAt: null };
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return { error: 'sendAt must be an ISO date and time', code: 'send_at_invalid' };
  if (at <= now) return { error: 'The scheduled time has already passed.', code: 'send_at_past' };
  if (at - now > SEND_LATER_MAX_MS) return { error: 'A letter can be scheduled at most a year ahead.', code: 'send_at_too_far' };
  return { sendAt: new Date(at) };
}

// ── Enqueue ─────────────────────────────────────────────────────────────────────────────────

// What the client gets back for a send job: enough to show the undo toast or the scheduled time.
export function sendJobResponse(job) {
  return {
    ok: true,
    jobId: String(job.id),
    status: job.status,
    sendAt: new Date(job.run_at).toISOString(),
    scheduled: !!job.payload?.scheduled,
  };
}

// The job already enqueued for this writer's idempotency key, or null.
export async function existingSendJob(dedupeKey) {
  if (!dedupeKey) return null;
  const { rows: [job] } = await query('SELECT * FROM jobs WHERE kind = $1 AND dedupe_key = $2', [SEND_JOB_KIND, dedupeKey]);
  return job || null;
}

// Enqueues a built letter. sendAt: the chosen time (a Date) for send later, else the undo window.
// Resolves { job, created }.
export async function enqueueOutgoingSend({ userId, accountId, dedupeKey = null, sendAt = null, compose, mail }) {
  const result = await withTransaction(async (tx) => {
    const enqueued = await enqueueJob({
      kind: SEND_JOB_KIND,
      payload: { scheduled: !!sendAt, messageId: mail.options.messageId },
      runAt: sendAt,
      delayMs: sendAt ? null : SEND_UNDO_WINDOW_MS,
      createdBy: userId,
      accountId,
      dedupeKey,
      maxAttempts: SEND_MAX_ATTEMPTS,
    }, tx);
    if (enqueued.created) {
      await tx.query('INSERT INTO outgoing_messages (job_id, compose, mail) VALUES ($1, $2::jsonb, $3)',
        [enqueued.job.id, JSON.stringify(compose), serializeMail(mail)]);
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
    broadcast({ type: 'scheduled_changed', accountId });
  }
  return result;
}

// ── Listing and managing ────────────────────────────────────────────────────────────────────

// Mailboxes are shared: everyone sees that a letter is waiting in a mailbox (its recipients,
// subject and time, as they will see its Sent copy). Its author and administrators manage it,
// and only they see its Bcc.
function summarize(row, { userId, isAdmin }) {
  const canManage = isAdmin || (!!row.created_by && row.created_by === userId);
  const compose = row.compose || {};
  return {
    id: String(row.id),
    accountId: row.account_id,
    status: row.status,
    sendAt: new Date(row.run_at).toISOString(),
    scheduled: !!row.payload?.scheduled,
    subject: compose.subject ?? '',
    to: compose.to || [],
    cc: compose.cc || [],
    ...(canManage ? { bcc: compose.bcc || [] } : {}),
    attachmentCount: (compose.attachments || []).length + (compose.forwardedAttachments || []).length,
    author: row.created_by ? { id: row.created_by, email: row.author_email || null } : null,
    canManage,
    errorCode: row.error_code || null,
    error: row.status === 'failed' || row.status === 'needs_attention' || row.status === 'queued' ? (row.last_error || null) : null,
    attempts: row.attempts,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SUMMARY_SQL = `
  SELECT j.*, o.compose - 'body' - 'quotedBody' - 'quotedBodyHtml' - 'editedSignature' - 'context' AS compose,
         COALESCE(NULLIF(u.email, ''), u.username) AS author_email
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
// which gives nothing back). Atomic: a letter a worker has claimed is refused (send_started).
export async function cancelScheduled(id, { userId, isAdmin, reason = 'discard' }) {
  const job = await managedJob(id, { userId, isAdmin });
  const out = await withTransaction(async (tx) => {
    const cancelled = await cancelJob(job.id, { from: CANCELLABLE_STATUSES }, tx);
    if (!cancelled) return null;
    const { rows: [content] } = await tx.query('DELETE FROM outgoing_messages WHERE job_id = $1 RETURNING compose, mail', [job.id]);
    return { cancelled, content };
  });
  if (!out) throw notCancellable(await getJob(job.id) || job);
  recordAudit({
    actorUserId: userId,
    accountId: job.account_id,
    action: 'message.send_cancelled',
    details: { jobId: String(job.id), messageId: job.payload?.messageId ?? null, reason },
  });
  broadcast({ type: 'scheduled_changed', accountId: job.account_id });
  if (reason === 'discard' || !out.content) return { ok: true };
  return { ok: true, compose: restoredCompose(out.content) };
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

// Moves a waiting letter to another time, or sends again one that failed (resend: true, needed for
// a failed letter or one that needs attention, so it is never re-sent by accident).
export async function rescheduleScheduled(id, { userId, isAdmin, sendAt, resend = false }) {
  const job = await managedJob(id, { userId, isAdmin });
  const from = resend ? CANCELLABLE_STATUSES : ['queued'];
  const moved = await rescheduleJob(job.id, { runAt: sendAt, from });
  if (!moved) {
    const current = await getJob(job.id) || job;
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
  const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [job.account_id]);
  if (!account) throw new JobError('The mailbox of this letter is gone.', { outcome: 'fail', code: 'account_missing' });

  return deliverOutgoingMessage({
    account,
    mail: deserializeMail(content.mail),
    actorUserId: job.created_by,
    imapManager,
    markEffectStarted: () => ctx.markEffectStarted(),
    // Sent: the job is done and the letter's content goes, in one transaction.
    onDelivered: () => ctx.complete(async (tx) => {
      await tx.query('DELETE FROM outgoing_messages WHERE job_id = $1', [job.id]);
    }),
  });
}

// Tells the author (their open tabs) how the letter ended, and every tab to refresh its list.
function onSendSettled(job) {
  broadcast({ type: 'scheduled_changed', accountId: job.account_id });
  if (!job.created_by) return;
  if (job.status === 'done') {
    broadcast({
      type: 'send_done', jobId: String(job.id), accountId: job.account_id,
      sentFolder: job.result?.sentFolder ?? null, sentCopySaved: job.result?.sentCopySaved ?? null,
    }, job.created_by);
    return;
  }
  recordAudit({
    actorUserId: job.created_by,
    accountId: job.account_id,
    action: 'message.send_failed',
    details: { jobId: String(job.id), messageId: job.payload?.messageId ?? null, status: job.status, code: job.error_code ?? null },
  });
  broadcast({
    type: 'send_failed', jobId: String(job.id), accountId: job.account_id,
    status: job.status, code: job.error_code ?? null, error: job.last_error ?? null,
  }, job.created_by);
}

// Registers the send_message kind. imapManager: the mail engine (Sent copy, sync, broadcast).
export function registerSendJobKind({ imapManager }) {
  broadcast = (data, userId = null) => {
    try { imapManager.broadcast(data, userId); } catch (err) { console.error('[send] Broadcast failed:', err.message); }
  };
  const results = new Map();
  registerJobKind(SEND_JOB_KIND, {
    maxAttempts: SEND_MAX_ATTEMPTS,
    handler: async (job, ctx) => {
      results.set(String(job.id), await handleSendJob(job, ctx, imapManager));
    },
    onSettled: (row) => {
      const result = results.get(String(row.id));
      results.delete(String(row.id));
      onSendSettled({ ...row, result });
    },
  });
}
