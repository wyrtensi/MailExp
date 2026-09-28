import { randomBytes } from 'crypto';
import MailComposer from 'nodemailer/lib/mail-composer';

// Low-level Gmail API "send" mechanics: building the raw RFC 822 message, the HTTP request, and
// classifying what Google's response means for the caller (services/mailSendTransport.js, which
// owns the SMTP-fallback and retry decisions). Nothing here talks to the database or to
// smtpTransport.js, so it can be unit-tested against a mocked `fetch` alone.

// The "upload" variant of users.messages.send, needed (rather than the plain resource endpoint)
// for two reasons: it accepts a raw message up to 35 MB (our own attachment cap is 25 MB, so we
// always fit), and — using uploadType=multipart — it lets a JSON metadata part (threadId) travel
// alongside the message/rfc822 part in one request. The plain JSON {raw: base64} endpoint cannot
// carry attachments anywhere near our size cap without risking request-size limits, and the
// single-part media upload (uploadType=media) has no room for threadId at all.
export const GMAIL_API_UPLOAD_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send';
export const GMAIL_API_MESSAGE_URL = (id) => `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`;

// A 35 MB upload over a slow link needs far more than the 10s used for plain token calls
// elsewhere; too short a budget would turn ordinary large-attachment sends into "uncertain"
// failures (see classifyGmailApiNetworkError) instead of successes.
export const GMAIL_API_TIMEOUT_MS = 90_000;

// Build the raw RFC 822 message from the same mailOptions send.js/ruleForwarder.js already build
// for nodemailer. keepBcc is required — MailComposer strips the Bcc header by default (it assumes
// an SMTP transport, where the envelope carries Bcc instead), but the Gmail API only sees what is
// in the raw message, and Gmail itself strips Bcc before delivery/storage. Without this a Bcc
// recipient would silently not receive the message.
//
// keepBcc is NOT a MailComposer/mailOptions field — despite appearing in its TypeScript types,
// MailComposer#compile() never reads `this.mail.keepBcc`. Every built-in transport that keeps Bcc
// (nodemailer's stream/sendmail/json transports) does it the same way: set it on the *compiled*
// MimeNode instance, after compile() and before build(). Verified against
// node_modules/nodemailer/dist/cjs/mime-node/index.js (the Bcc case in buildHeaders reads
// `this.keepBcc`, set from the MimeNode constructor's own `options.keepBcc` — compile() never
// forwards mail.keepBcc there) and .../stream-transport/index.js (`mail.message.keepBcc = true`).
export function buildRawMessage(mailOptions) {
  return new Promise((resolve, reject) => {
    const message = new MailComposer(mailOptions).compile();
    message.keepBcc = true;
    message.build((err, raw) => {
      if (err) reject(err);
      else resolve(raw);
    });
  });
}

// X-GM-THRID (stored as messages.provider_thread_id, a decimal string — see
// services/threading/providerIds.js) and the Gmail API's `threadId` are the same unsigned 64-bit
// id in two textual forms: IMAP's FETCH reports it in decimal, the API in hex. Returns null for
// anything that is not a plain decimal id (including null/undefined).
export function gmailThreadIdFromProviderThreadId(decimalId) {
  if (typeof decimalId !== 'string' || !/^\d{1,20}$/.test(decimalId)) return null;
  try {
    return BigInt(decimalId).toString(16);
  } catch {
    return null;
  }
}

function buildMultipartBody(rawMessage, metadata) {
  const boundary = `mailexpert_${randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: message/rfc822\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  return { body: Buffer.concat([head, rawMessage, tail]), contentType: `multipart/related; boundary=${boundary}` };
}

// A definite classification never falls back to SMTP and is shown to the user as-is (see
// send.js's mailSendFailure branch). A fallback classification means the request was not
// accepted — safe to retry over SMTP. `googleMessage` is always the raw text Google returned (or
// ''), kept separately from any user-facing message so callers can pattern-match on it (e.g. the
// threadId retry in mailSendTransport.js) without depending on our own wording.
function terminal(code, status, message, googleMessage) {
  return { kind: 'terminal', code, status, message, googleMessage };
}
function fallback(reason, { disableApi = false, googleMessage = '' } = {}) {
  return { kind: 'fallback', reason, disableApi, googleMessage };
}

// Classifies an HTTP response Google returned (status >= 400). Never called for 401 — the caller
// intercepts that first to force a token refresh and retry once (see mailSendTransport.js);
// if it still fails after the retry, the caller reports gmail_api_auth_failed itself and this
// function is not consulted for that code either.
export function classifyGmailApiResponseError(status, body) {
  const apiError = body?.error || {};
  const reasons = [
    ...(Array.isArray(apiError.errors) ? apiError.errors.map((e) => e?.reason) : []),
    ...(Array.isArray(apiError.details) ? apiError.details.map((d) => d?.reason) : []),
  ].filter(Boolean);
  const googleMessage = typeof apiError.message === 'string' ? apiError.message : '';
  const haystack = `${googleMessage} ${reasons.join(' ')}`;

  if (status === 401) {
    return terminal('gmail_api_auth_failed', 502, 'Gmail refused the access token.', googleMessage);
  }
  // The Google Cloud project has Gmail API disabled (APIs & Services -> Library). Distinct from
  // every other 403, which are per-message refusals, not a project-wide configuration problem.
  if (status === 403 && (reasons.includes('accessNotConfigured') || /SERVICE_DISABLED|has not been used in project|it is disabled/i.test(haystack))) {
    return fallback('accessNotConfigured', { disableApi: true, googleMessage });
  }
  // Gmail's per-mailbox sending limit (500/day for consumer accounts, higher for Workspace) is
  // enforced by Gmail's delivery system itself, not by the API — SMTP would hit the exact same
  // wall, so this is terminal rather than a fallback trigger.
  if (/dailyLimitExceeded/i.test(haystack) || (status === 403 && /sending limit|quota/i.test(haystack))) {
    return terminal('gmail_quota_exceeded', 429, 'Gmail daily sending limit reached for this account.', googleMessage);
  }
  // Plain API request throttling (calls/second), unrelated to the mailbox's own sending limit —
  // SMTP is a different quota entirely, so falling back can succeed.
  if (status === 429 || reasons.some((r) => /rateLimitExceeded|userRateLimitExceeded/i.test(r))) {
    return fallback('rate_limited', { googleMessage });
  }
  if (status >= 500) {
    return fallback(`http_${status}`, { googleMessage });
  }
  if (status === 413 || /message too large|exceeds the maximum permitted size/i.test(haystack)) {
    return terminal('gmail_message_too_large', 413, 'This message is too large to send.', googleMessage);
  }
  if (/invalid.*(to|recipient|address)|recipient address is not valid/i.test(haystack)) {
    return terminal('gmail_invalid_recipient', 400, 'One of the recipient addresses was rejected.', googleMessage);
  }
  if (status >= 400 && status < 500) {
    // Any other client-side refusal we did not anticipate (malformed request, a threading
    // precondition, a policy refusal): definite either way — retrying the same bytes, over
    // SMTP or the API, would not help.
    return terminal('gmail_access_refused', 502, 'Gmail refused to send this message.', googleMessage);
  }
  return fallback(`http_${status}`, { googleMessage });
}

// A fetch()-level throw, meaning the request never got an HTTP response at all. Only a subset of
// these are provably pre-send (DNS/connect failures happen before any bytes go out); everything
// else — our own AbortController timeout included — cannot be told apart from "the server
// accepted the message and then the connection broke", so it must not fall back (that could send
// the message twice). `kind: 'uncertain'` is deliberately left for the caller to just rethrow:
// send.js's existing smtpFailureIsDefinite/send_uncertain handling already does the right thing
// for an error with no `.definite` flag.
const PRE_SEND_NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);
export function classifyGmailApiNetworkError(err) {
  if (err?.name === 'AbortError') return { kind: 'uncertain' };
  const causeCode = err?.cause?.code || err?.code;
  if (PRE_SEND_NETWORK_CODES.has(causeCode)) return fallback(causeCode);
  return { kind: 'uncertain' };
}

function gmailSendError(classification) {
  const err = new Error(classification.message || classification.googleMessage || `Gmail API send failed (${classification.kind})`);
  err.gmailApi = true;
  err.gmailClassification = classification;
  if (classification.kind === 'terminal') {
    err.code = classification.code;
    err.status = classification.status;
    err.definite = true;
  }
  return err;
}

// POSTs the raw message. Resolves with the Message resource {id, threadId, labelIds} on success.
// Throws a classified error otherwise — see gmailSendError/classifyGmailApiResponseError/
// classifyGmailApiNetworkError. A 401 is reported as its own classification kind ('auth_retry')
// rather than 'terminal' so the caller can force one token refresh before giving up.
export async function postGmailApiSend({ accessToken, rawMessage, threadId, signal }) {
  const { body, contentType } = buildMultipartBody(rawMessage, threadId ? { threadId } : {});
  let res;
  try {
    res = await fetch(`${GMAIL_API_UPLOAD_URL}?uploadType=multipart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': contentType },
      body,
      signal,
    });
  } catch (err) {
    throw gmailSendError(classifyGmailApiNetworkError(err));
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON body (e.g. an HTML error page) */ }
  if (res.ok) return payload || {};
  if (res.status === 401) throw gmailSendError({ kind: 'auth_retry', googleMessage: payload?.error?.message || '' });
  throw gmailSendError(classifyGmailApiResponseError(res.status, payload));
}

// Best-effort verification that Gmail kept the Message-ID we set (design point 3). Returns the
// header value Gmail stored, or null on any failure (network, non-2xx, missing header) — callers
// treat null as "keep using our own id" and must not let this throw past a successful send.
export async function getSentMessageIdHeader({ accessToken, id, signal }) {
  const url = `${GMAIL_API_MESSAGE_URL(id)}?format=metadata&metadataHeaders=Message-ID`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const header = (body?.payload?.headers || []).find((h) => typeof h?.name === 'string' && h.name.toLowerCase() === 'message-id');
  const value = typeof header?.value === 'string' ? header.value.trim() : '';
  return value || null;
}
