// Undo send and send later on the client. A sent letter waits on the server as a job (backend
// services/sendQueue.js): five seconds for the undo, or until its scheduled time. These helpers
// carry the composer's state there and back, and name the outcomes. Pure: no DOM, no store.

// What the server keeps of the composer's own context, handed back on undo or edit so the composer
// reopens as it was (a reply stays a reply in its thread). Must stay under the server's 16 KB.
const CONTEXT_MAX_BYTES = 16 * 1024;
const CONTEXT_KEYS = ['isReply', 'isReplyAll', 'isForward', 'threadId', 'originalFrom', 'quoteMeta', 'quoteLang', 'quoteExtra', 'allRecipients'];

export function composeContext(composeData, forwardedAttachments = []) {
  const context = {};
  for (const key of CONTEXT_KEYS) {
    if (composeData?.[key] !== undefined && composeData?.[key] !== null) context[key] = composeData[key];
  }
  if (forwardedAttachments.length) {
    context.forwardedAttachments = forwardedAttachments.map(a => ({
      messageId: a.messageId, part: a.part, filename: a.filename, size: a.size,
    }));
  }
  // Too big (a reply-all to hundreds): keep what makes it a reply, drop the extras.
  if (new TextEncoder().encode(JSON.stringify(context)).length > CONTEXT_MAX_BYTES) {
    delete context.allRecipients;
    delete context.quoteMeta;
    delete context.quoteExtra;
    if (context.forwardedAttachments) context.forwardedAttachments = context.forwardedAttachments.map(({ messageId, part }) => ({ messageId, part }));
  }
  return context;
}

// The composer's composeData for a letter the server gave back (POST /mail/scheduled/:id/cancel
// with reason undo or edit). restored: it is saved nowhere now, so the composer treats it as unsaved.
export function composeDataFromScheduled(compose) {
  const context = compose?.context || {};
  const forwarded = context.forwardedAttachments?.length
    ? context.forwardedAttachments
    : (compose?.forwardedAttachments || []);
  const data = {
    ...context,
    restored: true,
    accountId: compose.accountId,
    ...(compose.aliasId ? { aliasId: compose.aliasId } : {}),
    to: compose.to || [],
    cc: compose.cc || [],
    bcc: compose.bcc || [],
    subject: compose.subject || '',
    body: compose.body || '',
    ...(compose.quotedBody ? { quotedBody: compose.quotedBody } : {}),
    ...(compose.quotedBodyHtml ? { quotedBodyHtml: compose.quotedBodyHtml } : {}),
    ...(compose.inReplyTo ? { inReplyTo: compose.inReplyTo } : {}),
    ...(compose.references ? { references: compose.references } : {}),
    priority: compose.priority || 'normal',
    forwardedAttachments: forwarded,
    attachments: (compose.attachments || []).map(a => ({
      name: a.filename, size: a.size, type: a.contentType || 'application/octet-stream', data: a.content,
    })),
  };
  // The signature the writer had edited stays the composer's signature until From changes.
  if (typeof compose.editedSignature === 'string' && compose.editedSignature) data.draftSignature = compose.editedSignature;
  return data;
}

// The i18n key of why a letter was not sent (the job's error code), or null for the server's text.
const FAILURE_KEYS = Object.freeze({
  send_uncertain: 'scheduled.failure.uncertain',
  lease_expired: 'scheduled.failure.uncertain',
  smtp_connection_failed: 'scheduled.failure.connection',
  smtp_temporary: 'scheduled.failure.temporary',
  smtp_rejected: 'scheduled.failure.rejected',
  smtp_auth_failed: 'scheduled.failure.auth',
  oauth_reconnect_required: 'scheduled.failure.reconnect',
  oauth_refresh_failed: 'scheduled.failure.temporary',
  gmail_quota_exceeded: 'compose.gmailQuotaExceeded',
  gmail_message_too_large: 'compose.gmailMessageTooLarge',
  gmail_invalid_recipient: 'compose.gmailInvalidRecipient',
  gmail_access_refused: 'compose.gmailAccessRefused',
  gmail_api_auth_failed: 'compose.gmailApiAuthFailed',
  author_disabled: 'scheduled.failure.authorDisabled',
});

export function sendFailureKey(code) {
  return Object.hasOwn(FAILURE_KEYS, code) ? FAILURE_KEYS[code] : null;
}

// The outcome a polled or pushed job status means for the writer: 'waiting' (still queued or
// going out), 'sent', 'failed' (kept, needs someone) or 'cancelled'.
export function sendOutcome(status) {
  if (status === 'done') return 'sent';
  if (status === 'failed' || status === 'needs_attention') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'waiting';
}

export const SCHEDULED_STATUS_LABEL_KEYS = Object.freeze({
  sendingSoon: 'scheduled.status.sendingSoon',
  scheduled: 'scheduled.status.scheduled',
  retrying: 'scheduled.status.retrying',
  sending: 'scheduled.status.sending',
  failed: 'scheduled.status.failed',
  needsAttention: 'scheduled.status.needsAttention',
});

export const SCHEDULED_ACTION_LABEL_KEYS = Object.freeze({
  edit: 'scheduled.actions.edit',
  reschedule: 'scheduled.actions.reschedule',
  cancel: 'scheduled.actions.cancel',
  discard: 'scheduled.actions.discard',
  resend: 'scheduled.actions.resend',
});

// How a listed letter (GET /mail/scheduled) is labelled: a key of SCHEDULED_STATUS_LABEL_KEYS.
export function scheduledStatusKey(letter) {
  switch (letter?.status) {
    case 'running': return 'sending';
    case 'failed': return 'failed';
    case 'needs_attention': return 'needsAttention';
    case 'queued':
      if (letter.errorCode) return 'retrying';
      return letter.scheduled ? 'scheduled' : 'sendingSoon';
    default: return 'scheduled';
  }
}

// What its author (or an administrator) can do with a listed letter, in display order. Everyone
// else only sees it. A letter on its way can no longer be stopped.
export function scheduledActions(letter) {
  if (!letter?.canManage) return [];
  switch (letter.status) {
    case 'queued': return ['edit', 'reschedule', 'cancel'];
    case 'failed':
    case 'needs_attention': return ['resend', 'edit', 'discard'];
    default: return [];
  }
}
