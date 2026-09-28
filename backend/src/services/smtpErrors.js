// Shared by every send path (routes/send.js, services/ruleForwarder.js, and — via `.definite` on
// a thrown error — services/mailSendTransport.js's Gmail API path): whether a failed send
// certainly delivered nothing, and how to describe a connection/handshake failure to the user
// without exposing server internals.
import { OAUTH_SEND_FAILURES } from './oauth/constants.js';

// Whether a failed sendMail certainly delivered nothing, so the idempotency reservation can be
// released for a retry. A server reply (4xx/5xx) is an explicit rejection, and an unreachable or
// refusing server never got the message. nodemailer tags a connection that closes mid-session as
// CONN as well, so a bare connection error may come after DATA was accepted: that one is unknown.
export function smtpFailureIsDefinite(err) {
  const responseCode = Number(err?.responseCode);
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode < 600) return true;
  // ETLS: nodemailer only ever raises it while upgrading the connection (implicit TLS or
  // STARTTLS) — always before EHLO/AUTH, so nothing was sent yet either.
  if (['EAUTH', 'EDNS', 'ETLS'].includes(err?.code)) return true;
  // Connecting and waiting for the greeting both happen before any message data is sent.
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Connection timeout|Greeting never received/.test(String(err?.message || ''));
}

// Any send path's own "certainly did not deliver" signal: an SMTP-shaped definite failure (above),
// an explicit `.definite === true` a non-SMTP path (the Gmail API sender) attaches to a
// classified, terminal error, an OAuth failure whose code is one of OAUTH_SEND_FAILURES (an
// OAuthTokenError from a forced refresh — AUTH/the API request precedes any delivery either way,
// for both Gmail and Microsoft mailboxes), or nodemailer's own EENVELOPE (no valid recipients —
// never opens a connection) / EMESSAGE (failed to compile the message — never leaves the
// process). Kept separate from smtpFailureIsDefinite itself so that function's existing unit
// tests (pure SMTP error shapes) stay unchanged.
export function sendFailureIsDefinite(err) {
  return smtpFailureIsDefinite(err)
    || err?.definite === true
    || Object.hasOwn(OAUTH_SEND_FAILURES, err?.code)
    || err?.code === 'EENVELOPE'
    || err?.code === 'EMESSAGE';
}

// Connection/handshake-level SMTP failures — nodemailer's SMTPConnection reports these before
// AUTH ever runs (see its _onError/_formatError: the OS-level code like ECONNREFUSED/ENOTFOUND/
// EHOSTUNREACH ends up in err.message, while err.code is overwritten with one of these transport
// codes). EAUTH (a server AUTH rejection) is deliberately excluded — that keeps its existing
// handling below, unchanged.
const SMTP_CONNECTION_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'EDNS', 'ESOCKET', 'ETLS']);

// A short, stable reason for both the log line and the (localized) client message. Never the raw
// error text: that can carry a resolved IP or other transport detail beyond host, port and kind.
function smtpConnectionFailureReason(err) {
  const msg = String(err?.message || '');
  if (/ECONNREFUSED/i.test(msg)) return 'refused';
  if (/ENOTFOUND/i.test(msg)) return 'not_found';
  if (/EHOSTUNREACH/i.test(msg)) return 'unreachable';
  if (err?.code === 'ETLS' || /TLS|handshake/i.test(msg)) return 'tls';
  if (err?.code === 'ETIMEDOUT' || /timeout|timed out|greeting never received/i.test(msg)) return 'timeout';
  return 'unknown';
}

const SMTP_CONNECTION_REASON_TEXT = {
  refused: 'connection refused',
  not_found: 'host not found',
  unreachable: 'host unreachable',
  tls: 'TLS handshake failed',
  timeout: 'timed out',
  unknown: 'could not connect',
};

// nodemailer tags a mid-session close as ECONNECTION with command 'CONN' too — the same command
// a pre-AUTH connect failure gets — so command can't tell the two apart. These messages can only
// happen after the session was already under way (an EHLO reply or a later abrupt close), so a
// send that reaches them may already have been accepted; never describe them as "could not
// connect", that would wrongly promise nothing was delivered.
const SMTP_MIDSESSION_CLOSE_RE = /Connection closed unexpectedly|Server terminates connection|EHLO failed/i;

// Never reached AUTH: describe it with only the account's configured host, port and a generic
// kind. Returns null for anything else (including auth rejections and ambiguous mid-session
// closes, which keep their own handling).
export function smtpConnectionFailure(err, account) {
  const msg = String(err?.message || '');
  if (SMTP_MIDSESSION_CLOSE_RE.test(msg)) return null;
  const isConnectionFailure = SMTP_CONNECTION_ERROR_CODES.has(err?.code)
    || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg);
  if (!isConnectionFailure) return null;
  const reason = smtpConnectionFailureReason(err);
  const host = account?.smtp_host || 'the mail server';
  const target = account?.smtp_port ? `${host}:${account.smtp_port}` : host;
  return {
    code: 'smtp_connection_failed',
    reason,
    host: account?.smtp_host || null,
    port: account?.smtp_port || null,
    error: `Could not connect to ${target} (${SMTP_CONNECTION_REASON_TEXT[reason]}). The server's network may block outgoing mail ports.`,
  };
}
