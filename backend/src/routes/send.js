// POST /send builds and checks a letter while the writer waits, then hands it to the durable job
// queue (services/sendQueue.js): it goes out SEND_UNDO_WINDOW_MS later, so the writer can undo it,
// or at the time they chose (send later). services/sendDelivery.js sends it from the job.
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { sanitizeSignature, sanitizeComposeBody } from '../services/emailSanitizer.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { wrapSignatureHtml } from '../utils/signatureWrapper.js';
import { htmlToText } from '../utils/htmlToText.js';
import { buildRawMessage } from '../services/gmailApiSender.js';
import { imapManager } from '../index.js';
import { OAUTH_SEND_FAILURES } from '../services/oauth/constants.js';
import { isDisabledMailbox, isForeignNodeAliasAddress, isReadOnlyNodeMailbox } from '../utils/senderNames.js';
import { ATTACHMENT_LIMIT_ERROR, MAX_ATTACHMENT_BYTES } from '../utils/attachmentLimit.js';
import { smtpFailureIsDefinite, smtpConnectionFailure } from '../services/smtpErrors.js';
import {
  enqueueOutgoingSend, existingSendJob, parseSendAt, pickComposeContext, sendJobResponse, sendRetryConflict,
} from '../services/sendQueue.js';

// Re-exported for send.smtpConnectionFailure.test.js — the logic itself lives in
// services/smtpErrors.js, shared with services/mailSendTransport.js and services/ruleForwarder.js.
export { smtpFailureIsDefinite, smtpConnectionFailure };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The client's own context of a letter (reply or forward, the thread), handed back on undo or edit.
const COMPOSE_CONTEXT_MAX_BYTES = 16 * 1024;

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildSentSnippet(body, bodyIsHtml) {
  return bodyToPlain(body, bodyIsHtml).replace(/\s+/g, ' ').trim().substring(0, 200);
}

// Reject any recipient address that contains newlines, null bytes, or looks
// malformed — these are the classic email header-injection vectors.
function normalizeRecipients(list, fieldName) {
  if (!Array.isArray(list)) throw Object.assign(new Error(`${fieldName} must be an array`), { status: 400 });
  return list.map((addr, i) => {
    if (typeof addr !== 'string' || !addr.trim()) {
      throw Object.assign(new Error(`${fieldName}[${i}] is empty or not a string`), { status: 400 });
    }
    const trimmed = addr.trim();
    if (/[\r\n\0]/.test(trimmed)) {
      throw Object.assign(new Error(`${fieldName}[${i}] contains invalid characters`), { status: 400 });
    }
    const at = trimmed.lastIndexOf('@');
    if (at < 1 || at === trimmed.length - 1) {
      throw Object.assign(new Error(`${fieldName}[${i}] is not a valid email address`), { status: 400 });
    }
    return trimmed;
  });
}

// Strip header-injection characters from single-line header values.
function sanitizeHeaderValue(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\0]/g, '').trim();
}

function textToHtml(text) {
  return '<div style="font-family:sans-serif;font-size:14px;line-height:1.6">' +
    text.split('\n').map(l => `<p style="margin:0">${escapeHtml(l) || '&nbsp;'}</p>`).join('') +
    '</div>';
}

function sigToPlainText(html) {
  return htmlToText(html).trim();
}

function bodyToPlain(body, isHtml) {
  if (!isHtml) return body;
  return htmlToText(body);
}

function bodyToHtml(body, isHtml) {
  if (!isHtml) return textToHtml(body);
  return sanitizeComposeBody(body);
}

const router = Router();
router.use(requireAuth);


router.post('/send', async (req, res) => {
  const { accountId, aliasId, to, cc = [], bcc = [], subject, body, bodyIsHtml = false, quotedBody, quotedBodyHtml, inReplyTo, references, attachments, editedSignature, forwardedAttachments, priority } = req.body;
  const VALID_PRIORITIES = new Set(['high', 'normal', 'low']);
  const emailPriority = VALID_PRIORITIES.has(priority) ? priority : 'normal';
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  // Any one field may carry the recipients: a message addressed only in Bcc is valid.
  if (![to, cc, bcc].some(list => Array.isArray(list) && list.length)) {
    return res.status(400).json({ error: 'At least one recipient is required' });
  }

  // A time that has passed is refused only after the idempotency lookup below: a retried "send
  // later" whose time came meanwhile is the letter it already enqueued, not a new request.
  const parsedSendAt = parseSendAt(req.body.sendAt);
  if (parsedSendAt.error && parsedSendAt.code !== 'send_at_past') {
    return res.status(400).json({ error: parsedSendAt.error, code: parsedSendAt.code });
  }

  let composeContext = null;
  if (req.body.context !== undefined && req.body.context !== null) {
    const serialized = typeof req.body.context === 'object' ? JSON.stringify(req.body.context) : null;
    if (!serialized || Buffer.byteLength(serialized) > COMPOSE_CONTEXT_MAX_BYTES) {
      return res.status(400).json({ error: 'context must be an object under 16 KB' });
    }
    // Only the known keys are kept (services/sendQueue.js COMPOSE_CONTEXT_KEYS): whoever reopens the
    // letter (its author, or an administrator) gets nothing else of the client's object.
    composeContext = pickComposeContext(req.body.context);
  }

  // Idempotency: the client sends a stable X-Idempotency-Key per logical send. A retry (or a
  // second click) with the same key gets the job the first one enqueued; the database's unique
  // (kind, dedupe_key) makes two concurrent submits enqueue one job between them. The same key for a
  // cancelled letter or another time is a different send, and refused.
  const idempotencyKey = typeof req.headers['x-idempotency-key'] === 'string'
    ? req.headers['x-idempotency-key'].slice(0, 128)
    : null;
  const dedupeKey = idempotencyKey ? `${req.session.userId}:${idempotencyKey}` : null;
  if (dedupeKey) {
    const existing = await existingSendJob(dedupeKey);
    if (existing) {
      const conflict = sendRetryConflict(existing, parsedSendAt.sendAt ?? parsedSendAt.requestedAt ?? null);
      if (conflict) return res.status(conflict.status).json({ error: conflict.error, code: conflict.code });
      return res.json(sendJobResponse(existing));
    }
  }
  if (parsedSendAt.error) return res.status(400).json({ error: parsedSendAt.error, code: parsedSendAt.code });
  const { sendAt } = parsedSendAt;

  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) return res.status(400).json({ error: 'attachments must be an array' });
    if (attachments.length > 100) return res.status(400).json({ error: 'Too many attachments (max 100)' });
    const totalBytes = attachments.reduce((sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0);
    if (totalBytes > MAX_ATTACHMENT_BYTES) return res.status(400).json({ error: ATTACHMENT_LIMIT_ERROR });
    for (const [i, a] of attachments.entries()) {
      if (typeof a.filename !== 'string' || !a.filename.trim()) return res.status(400).json({ error: `attachments[${i}].filename is required` });
      if (typeof a.content !== 'string') return res.status(400).json({ error: `attachments[${i}].content must be a base64 string` });
    }
  }

  if (forwardedAttachments !== undefined) {
    if (!Array.isArray(forwardedAttachments)) return res.status(400).json({ error: 'forwardedAttachments must be an array' });
    if (forwardedAttachments.length > 100) return res.status(400).json({ error: 'Too many forwarded attachments (max 100)' });
    for (const [i, fa] of forwardedAttachments.entries()) {
      if (typeof fa.messageId !== 'string' || !UUID_RE.test(fa.messageId)) return res.status(400).json({ error: `forwardedAttachments[${i}].messageId is invalid` });
      if (typeof fa.part !== 'string' || !fa.part.trim()) return res.status(400).json({ error: `forwardedAttachments[${i}].part is required` });
    }
  }

  let normalizedTo, normalizedCc, normalizedBcc;
  try {
    normalizedTo  = normalizeRecipients(to ?? [],  'to');
    normalizedCc  = normalizeRecipients(cc,  'cc');
    normalizedBcc = normalizeRecipients(bcc, 'bcc');
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const normalizedSubject = sanitizeHeaderValue(subject || '');

  const [result, prefResult] = await Promise.all([
    query('SELECT * FROM email_accounts WHERE id = $1', [accountId]),
    query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]),
  ]);
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
  const plaintextEmail = prefResult.rows[0]?.preferences?.plaintextEmail === true;
  const account = result.rows[0];
  // A mailbox whose OAuth grant is gone cannot send: say so now, not after the undo window.
  if (account.oauth_reconnect_required) {
    const failure = OAUTH_SEND_FAILURES.oauth_reconnect_required;
    return res.status(failure.status).json({ error: failure.error, code: 'oauth_reconnect_required' });
  }
  if (isDisabledMailbox(account)) {
    return res.status(409).json({ error: 'This mailbox is disabled: it cannot send.', code: 'mailbox_disabled' });
  }
  // A deactivated mail node mailbox, or one pending deletion, is read-only (EOP seats design): say so
  // now, not after the undo window.
  if (isReadOnlyNodeMailbox(account)) {
    return res.status(409).json({
      error: 'This mailbox is read-only (deactivated or pending deletion): it cannot send.', code: 'mailbox_read_only',
    });
  }

  // Resolve the From identity — account by default, alias if requested
  let fromName = account.sender_name || account.name;
  let fromEmail = account.email_address;
  let fromSignature = account.signature;
  let fromReplyTo = null;

  if (aliasId) {
    const aliasResult = await query(
      'SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2',
      [aliasId, accountId]
    );
    if (aliasResult.rows.length) {
      const alias = aliasResult.rows[0];
      // A mail node mailbox sends only from its own address (D-16); an alias with another address
      // left from before would be refused by the node's SMTP after the undo window, so say it now.
      if (isForeignNodeAliasAddress(account, alias.email)) {
        return res.status(400).json({
          error: 'This sender address is not a mailbox: choose another From. An administrator can make it a separate mailbox.',
          code: 'node_alias_stale',
        });
      }
      fromName = alias.name;
      fromEmail = alias.email;
      fromReplyTo = alias.reply_to || null;
      // null (DB default) means inherit from account; only override when alias has an explicit signature set
      if (alias.signature !== null) fromSignature = alias.signature;
    }
  }

  // Allow the client to override the signature per-send (editedSignature === undefined means use DB value).
  // Sanitize client-supplied HTML to prevent injecting scripts or tracking pixels into sent mail.
  const effectiveSignature = editedSignature !== undefined
    ? (editedSignature ? sanitizeSignature(editedSignature) : null)
    : fromSignature;  // fromSignature from DB is already sanitized on write

  // Fetch forwarded attachment content from IMAP before entering the SMTP try-block so that
  // attachment errors return descriptive messages rather than being sanitized as SMTP errors.
  let resolvedFwdAttachments = [];
  if (forwardedAttachments?.length) {
    try {
      // Resolve every referenced message in a SINGLE query so a large forwardedAttachments
      // array can't fan out into one DB round-trip per entry.
      const distinctMsgIds = [...new Set(forwardedAttachments.map(fa => fa.messageId))];
      const msgRows = await query(
        `SELECT m.id, m.uid, m.folder, m.attachments, m.account_id FROM messages m
         WHERE m.id = ANY($1::uuid[])`,
        [distinctMsgIds]
      );
      const msgById = new Map(msgRows.rows.map(m => [m.id, m]));

      // Build the fetch plan (one entry per requested attachment, order preserved) and sum the
      // DECLARED sizes so an oversized batch is rejected BEFORE any IMAP fetch happens.
      const uploadedBytes = (attachments || []).reduce(
        (sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0
      );
      let declaredFwdBytes = 0;
      const fetchPlan = forwardedAttachments.map((fa) => {
        const msg = msgById.get(fa.messageId);
        if (!msg) throw Object.assign(new Error('Forwarded message not found'), { status: 404 });
        const storedAtts = typeof msg.attachments === 'string'
          ? JSON.parse(msg.attachments || '[]')
          : (msg.attachments || []);
        const att = storedAtts.find(a => a.part === fa.part);
        if (!att) throw Object.assign(new Error('Attachment not found in message'), { status: 404 });
        declaredFwdBytes += Number(att.size) || 0;
        return { msg, att };
      });
      if (uploadedBytes + declaredFwdBytes > MAX_ATTACHMENT_BYTES) {
        return res.status(400).json({ error: ATTACHMENT_LIMIT_ERROR });
      }

      // Load the owning accounts once, then fetch bodies with bounded concurrency so we never
      // open a burst of fresh IMAP connections (fetchAttachment opens a connection per call).
      const distinctAcctIds = [...new Set(fetchPlan.map(p => p.msg.account_id))];
      const acctRows = await query('SELECT * FROM email_accounts WHERE id = ANY($1::uuid[])', [distinctAcctIds]);
      const acctById = new Map(acctRows.rows.map(a => [a.id, a]));

      const FWD_FETCH_CONCURRENCY = 4;
      for (let i = 0; i < fetchPlan.length; i += FWD_FETCH_CONCURRENCY) {
        const batch = fetchPlan.slice(i, i + FWD_FETCH_CONCURRENCY);
        const fetched = await Promise.all(batch.map(async ({ msg, att }) => {
          const acct = acctById.get(msg.account_id);
          if (!acct) throw Object.assign(new Error('Account not found'), { status: 404 });
          // A letter whose move is pending is read at its source (moveQueue.serverLocation).
          const loc = await imapManager.moveQueue.serverLocation(msg, acct);
          if (!loc) throw Object.assign(new Error('The forwarded letter is still being moved; try again in a few seconds'), { status: 409 });
          const buffer = await imapManager.fetchAttachment(acct, loc.uid, loc.folder, att.part);
          if (!buffer) throw Object.assign(new Error(`Could not fetch attachment: ${att.filename}`), { status: 502 });
          return {
            filename: sanitizeHeaderValue(att.filename || 'attachment'),
            content: buffer,
            contentType: att.type || 'application/octet-stream',
          };
        }));
        resolvedFwdAttachments.push(...fetched);
      }

      // Exact backstop: declared sizes can under-report, so re-check against fetched bytes.
      const fwdBytes = resolvedFwdAttachments.reduce((sum, a) => sum + (a.content?.length || 0), 0);
      if (uploadedBytes + fwdBytes > MAX_ATTACHMENT_BYTES) {
        return res.status(400).json({ error: ATTACHMENT_LIMIT_ERROR });
      }
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Failed to fetch forwarded attachments' });
    }
  }

  const domain = fromEmail.split('@')[1] || 'mailexpert.local';
  // A stable Message-ID, chosen now: the undo, the journal and the Sent copy all name the letter by it.
  const mailOptions = {
    messageId: `<${randomBytes(16).toString('hex')}@${domain}>`,
    from: `${fromName} <${fromEmail}>`,
    ...(fromReplyTo ? { replyTo: fromReplyTo } : {}),
    to: normalizedTo.join(', ') || undefined,
    cc: normalizedCc.join(', ') || undefined,
    bcc: normalizedBcc.join(', ') || undefined,
    subject: normalizedSubject,
    ...(emailPriority !== 'normal' ? { priority: emailPriority } : {}),
    text: effectiveSignature
      ? bodyToPlain(body, bodyIsHtml) + '\n\n-- \n' + sigToPlainText(effectiveSignature) + (quotedBody || '')
      : bodyToPlain(body, bodyIsHtml) + (quotedBody || ''),
  };

  let inlineImageAttachments = [];
  if (!plaintextEmail) {
    const rawHtml = bodyToHtml(body, bodyIsHtml) +
      (effectiveSignature
        ? wrapSignatureHtml(effectiveSignature)
        : '') +
      (quotedBodyHtml || (quotedBody ? textToHtml(quotedBody) : ''));
    const embedded = embedInlineDataImages(rawHtml);
    mailOptions.html = embedded.html;
    inlineImageAttachments = embedded.attachments;
  }

  if (inReplyTo) {
    mailOptions.inReplyTo = sanitizeHeaderValue(inReplyTo);
    // Use the full prior references chain if available; fall back to just inReplyTo.
    mailOptions.references = sanitizeHeaderValue(references || inReplyTo);
  }

  const uploadedAttachments = attachments?.length ? attachments.map(a => ({
    filename: sanitizeHeaderValue(a.filename),
    content: Buffer.from(a.content, 'base64'),
    contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
  })) : [];
  const allAttachments = [...inlineImageAttachments, ...uploadedAttachments, ...resolvedFwdAttachments];
  // Final backstop over the whole set. The earlier checks (above, and inside the
  // forwardedAttachments block) run before embedInlineDataImages() decodes any inline data:
  // images in the body into their own attachments, so a message that stays under the cap only
  // by way of its explicit/forwarded attachments but carries large embedded images would
  // otherwise slip through uncounted.
  const totalAttachmentBytes = allAttachments.reduce((sum, a) => sum + (a.content?.length || 0), 0);
  if (totalAttachmentBytes > MAX_ATTACHMENT_BYTES) {
    return res.status(400).json({ error: ATTACHMENT_LIMIT_ERROR });
  }
  if (allAttachments.length) {
    mailOptions.attachments = allAttachments;
  }

  // Compile the letter once now, so a message nodemailer cannot build is refused while the writer
  // waits rather than failing later in the queue. It is compiled again when it is sent, so its
  // Date header is the moment of sending.
  try {
    await buildRawMessage(mailOptions);
  } catch (err) {
    console.error('Send: failed to build the message:', err.message);
    return res.status(400).json({ error: 'Failed to build the message for sending.', code: 'mail_build_failed' });
  }

  // What the composer reopens with on undo or edit (no attachment contents: those are in the
  // letter itself, forwarded ones included, and come back as the writer's own attachments), and a
  // small client context (reply or forward, the thread) it hands back.
  const compose = {
    accountId: account.id,
    aliasId: aliasId || null,
    to: normalizedTo,
    cc: normalizedCc,
    bcc: normalizedBcc,
    subject: normalizedSubject,
    body: typeof body === 'string' ? body : '',
    bodyIsHtml: !!bodyIsHtml,
    quotedBody: typeof quotedBody === 'string' ? quotedBody : null,
    quotedBodyHtml: typeof quotedBodyHtml === 'string' ? quotedBodyHtml : null,
    ...(editedSignature !== undefined ? { editedSignature: editedSignature || null } : {}),
    inReplyTo: inReplyTo ? sanitizeHeaderValue(inReplyTo) : null,
    references: references ? sanitizeHeaderValue(references) : null,
    priority: emailPriority,
    attachments: uploadedAttachments.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.content.length })),
    forwardedAttachments: (forwardedAttachments || []).map(fa => ({ messageId: fa.messageId, part: fa.part })),
    context: composeContext,
  };
  const meta = {
    to: normalizedTo,
    cc: normalizedCc,
    bcc: normalizedBcc,
    subject: normalizedSubject,
    fromName,
    fromEmail,
    snippet: buildSentSnippet(body, bodyIsHtml),
  };
  const uploads = uploadedAttachments.map((_, i) => inlineImageAttachments.length + i);
  const forwarded = resolvedFwdAttachments.map((_, i) => inlineImageAttachments.length + uploadedAttachments.length + i);

  try {
    const { job, created } = await enqueueOutgoingSend({
      userId: req.session.userId,
      accountId: account.id,
      dedupeKey,
      sendAt,
      compose,
      mail: { options: mailOptions, meta, uploads, forwarded },
    });
    const conflict = created ? null : sendRetryConflict(job, sendAt);
    if (conflict) return res.status(conflict.status).json({ error: conflict.error, code: conflict.code });
    res.json(sendJobResponse(job));
  } catch (err) {
    console.error('Send: enqueue failed:', err.message);
    res.status(503).json({ error: 'Sending is temporarily unavailable. Please try again shortly.' });
  }
});

export default router;
