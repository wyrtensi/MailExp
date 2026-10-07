// The single entry point every send path (routes/send.js, services/ruleForwarder.js) uses to
// deliver a message. For a Gmail mailbox (OAuth, scope https://mail.google.com/) it sends over
// the Gmail API by default and falls back to SMTP when the API definitely did not accept the
// message; every other account (mailcow, generic IMAP/SMTP, Microsoft, Yahoo) is untouched — this
// resolves straight to createAccountSmtpTransport, byte-for-byte the same object it always
// returned. See services/gmailApiSender.js for the HTTP mechanics and error classification.
import { decrypt } from './encryption.js';
import { createAccountSmtpTransport, oauthRefreshFailureResult } from './smtpTransport.js';
import { ensureFreshOAuthAccount, markReconnectRequired, OAuthTokenError } from './oauth/tokenManager.js';
import { PROVIDER_FETCH_TIMEOUT_MS } from './oauth/constants.js';
import { markGmailApiDisabled, clearGmailApiDisabled } from './oauth/googleApps.js';
import {
  GMAIL_API_TIMEOUT_MS,
  buildRawMessage,
  postGmailApiSend,
  getSentMessageIdHeader,
} from './gmailApiSender.js';

const VALID_TRANSPORTS = new Set(['api', 'smtp']);
let warnedInvalidTransport = false;

// GMAIL_SEND_TRANSPORT=api|smtp, default api. An unrecognized value falls back to api with one
// warning (see the eager call at the bottom of this module, so it lands in the startup log
// rather than only appearing on the first Gmail send).
function gmailSendTransportSetting() {
  const raw = process.env.GMAIL_SEND_TRANSPORT;
  if (raw === undefined || raw === '') return 'api';
  if (VALID_TRANSPORTS.has(raw)) return raw;
  if (!warnedInvalidTransport) {
    warnedInvalidTransport = true;
    console.warn(`GMAIL_SEND_TRANSPORT="${raw}" is not "api" or "smtp"; using "api"`);
  }
  return 'api';
}
// Test-only: the warn-once latch otherwise leaks between test files that both set an invalid value.
export const _resetGmailSendTransportWarningForTests = () => { warnedInvalidTransport = false; };

function shouldUseGmailApi(account) {
  return account?.oauth_provider === 'google' && gmailSendTransportSetting() !== 'smtp';
}

async function attemptGmailApiSend(accessToken, rawMessage, threadId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GMAIL_API_TIMEOUT_MS);
  try {
    return await postGmailApiSend({ accessToken, rawMessage, threadId, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A definite HTTP response in the 4xx range means Google looked at the request and refused it —
// synchronously, before accepting anything. When threadId was part of that request, retrying
// once without it is always safe (nothing was sent either way) and recovers from the one 4xx
// cause that has nothing to do with the message itself: a stale/invalid threadId, which Gmail
// answers with (for example) a 404 "Requested entity was not found" that says nothing about
// "thread" for a pattern match to catch. Applies regardless of kind (terminal, fallback, or
// reconnect) — the retry is free of side effects, so being broad here costs at most one extra
// request in the reconnect/accessNotConfigured/quota cases where it can't help.
function is4xxResponse(err) {
  const status = err?.gmailClassification?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

async function attemptWithThreadFallback(accessToken, rawMessage, threadId) {
  try {
    return await attemptGmailApiSend(accessToken, rawMessage, threadId);
  } catch (err) {
    if (threadId && err?.gmailClassification?.kind !== 'auth_retry' && is4xxResponse(err)) {
      return attemptGmailApiSend(accessToken, rawMessage, null);
    }
    throw err;
  }
}

// Runs the whole Gmail API attempt: the initial send (with one retry without threadId on a
// definite 4xx, see attemptWithThreadFallback), then one retry after a forced token refresh if
// Google rejects the token. Resolves with `{ result, accessToken }` (the token actually used, for
// the caller's post-send Message-ID check) on success; throws a classified error otherwise (see
// gmailApiSender.js) for the caller to act on. A 401 that still fails after the refresh — from
// either attempt, since attemptWithThreadFallback's own no-threadId retry can hit one too — is
// reported as its own 'reconnect' classification, never left to escape unclassified.
async function sendGmailApiMessage(account, rawMessage, threadId) {
  let accessToken = decrypt(account.oauth_access_token);
  try {
    const result = await attemptWithThreadFallback(accessToken, rawMessage, threadId);
    return { result, accessToken };
  } catch (err) {
    if (err?.gmailClassification?.kind !== 'auth_retry') throw err;
    // The token the caller holds was rejected. Force one refresh — same tokenManager.js entry
    // point the SMTP transport uses on an AUTH rejection — and retry exactly once with the new
    // token. A refresh failure (including oauth_reconnect_required) propagates as its
    // OAuthTokenError; send.js already maps that via OAUTH_SEND_FAILURES.
    const refreshed = await ensureFreshOAuthAccount(account, { force: true });
    accessToken = decrypt(refreshed.oauth_access_token);
    try {
      const result = await attemptWithThreadFallback(accessToken, rawMessage, threadId);
      return { result, accessToken };
    } catch (retryErr) {
      // The refresh may have rotated the refresh token: flagging the account must compare against
      // the one now stored, or the compare-and-set misses the row (markReconnectRequired).
      const grant = { rejectedRefreshToken: refreshed.oauth_refresh_token };
      if (retryErr?.gmailClassification?.kind === 'auth_retry') {
        throw Object.assign(new Error('Gmail API rejected the access token after a refresh'), {
          gmailApi: true,
          gmailClassification: { kind: 'reconnect', googleMessage: retryErr.gmailClassification.googleMessage || '', status: 401 },
          ...grant,
        });
      }
      if (retryErr && typeof retryErr === 'object') Object.assign(retryErr, grant);
      throw retryErr;
    }
  }
}

// Builds the raw message once, tries the Gmail API, and falls back to SMTP only for a
// classification of 'fallback' (the request definitely was not accepted — see
// classifyGmailApiResponseError/classifyGmailApiNetworkError). A 'terminal' classification and an
// unclassified network error (uncertain) both propagate unchanged: send.js's existing
// smtpFailureIsDefinite/send_uncertain handling (extended with sendFailureIsDefinite, which also
// honors `.definite`) already does the right thing with them. A 'reconnect' classification flags
// the account through the same tokenManager.js path a failed token refresh uses, then reports it
// as a standard OAuth failure — this also makes it `sendFailureIsDefinite` via the
// OAUTH_SEND_FAILURES codes it now recognizes.
async function sendViaGmailApiWithFallback(account, mailOptions, { threadId = null } = {}) {
  let rawMessage;
  try {
    rawMessage = await buildRawMessage(mailOptions);
  } catch (err) {
    // Never reached the network — always safe to release the send's idempotency reservation and
    // let the user retry. Logged with the real error; reported to the user with a generic one so
    // internal MIME-building details never reach the response.
    console.error(`Gmail API send: failed to build the raw message for account ${account.id}: ${err.message}`);
    throw Object.assign(new Error('Failed to build the message for sending. Please try again.'), {
      definite: true, code: 'mail_build_failed', status: 500,
    });
  }
  try {
    const { result, accessToken } = await sendGmailApiMessage(account, rawMessage, threadId);
    // Best-effort bookkeeping only, past this point: a successful send must never end up
    // reported as failed (or "uncertain") because a cleanup step threw.
    if (account.oauth_app_id) clearGmailApiDisabled(account.oauth_app_id).catch(() => {});
    let messageId = mailOptions.messageId;
    if (result?.id) {
      try {
        const controller = new AbortController();
        // A small metadata GET, not the up-to-35-MB upload — the long GMAIL_API_TIMEOUT_MS budget
        // would only delay reporting a hung request. Reuses the token that actually worked for the
        // send (which may be the one from a mid-flow refresh), not account's possibly-stale one.
        const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
        const headerId = await getSentMessageIdHeader({ accessToken, id: result.id, signal: controller.signal })
          .finally(() => clearTimeout(timer));
        if (headerId) messageId = headerId;
      } catch (err) {
        console.warn(`Gmail API post-send Message-ID verification failed for ${account.id}: ${err.message}`);
      }
    }
    return { via: 'api', messageId };
  } catch (err) {
    const kind = err?.gmailClassification?.kind;
    if (kind === 'reconnect') {
      const rejected = Object.hasOwn(err, 'rejectedRefreshToken') ? err.rejectedRefreshToken : account.oauth_refresh_token;
      await markReconnectRequired(account.id, rejected)
        .catch((e) => console.error(`Flagging oauth_reconnect_required failed for account ${account.id}: ${e.message}`));
      throw new OAuthTokenError('oauth_reconnect_required');
    }
    if (kind !== 'fallback') throw err;
    if (err.gmailClassification.disableApi && account.oauth_app_id) {
      markGmailApiDisabled(account.oauth_app_id).catch((e) => console.error(`Flagging Gmail API disabled failed for app ${account.oauth_app_id}: ${e.message}`));
    }
    console.warn(`Gmail API send falling back to SMTP for ${account.id}: ${err.gmailClassification.reason}`);
    const smtp = await createAccountSmtpTransport(account);
    if (smtp.error) {
      throw Object.assign(new Error(smtp.error), {
        status: smtp.status, code: smtp.code, definite: true, mailSendFallbackSetupFailed: true,
      });
    }
    // Nodemailer resolves a send whose server refused some recipients at RCPT: hand the refusals
    // on, as the plain SMTP transport does (sendDelivery.js refusedRecipients).
    const info = await smtp.transport.sendMail(mailOptions);
    return {
      via: 'smtp', messageId: mailOptions.messageId,
      rejected: info?.rejected ?? [], rejectedErrors: info?.rejectedErrors ?? [],
    };
  }
}

// Same return shape as createAccountSmtpTransport: `{ account, transport }` on success, or
// `{ status, error, code? }` for a failure that must stop the caller before any message is built
// (an OAuth refresh failure, exactly like the SMTP transport's own top-level check). The returned
// transport's sendMail(mailOptions, { threadId }) resolves to `{ via, messageId }` — `messageId`
// is normally mailOptions.messageId unchanged, but may be the id Gmail itself reports if it ever
// differs (see gmailApiSender.js's getSentMessageIdHeader).
export async function createAccountSendTransport(inputAccount) {
  if (!shouldUseGmailApi(inputAccount)) {
    // A Gmail account forced to SMTP by GMAIL_SEND_TRANSPORT=smtp never gets to prove the API
    // works again (it never tries), so an earlier gmail_api_disabled_at would otherwise sit on
    // the admin card forever — clear it, since it is not the app's fault and there's nothing an
    // admin can act on. Only for Gmail; other providers never set the flag.
    if (inputAccount?.oauth_provider === 'google' && inputAccount?.oauth_app_id) {
      clearGmailApiDisabled(inputAccount.oauth_app_id).catch(() => {});
    }
    return createAccountSmtpTransport(inputAccount);
  }

  let account = inputAccount;
  try {
    account = await ensureFreshOAuthAccount(account);
  } catch (err) {
    const result = oauthRefreshFailureResult(err);
    if (result) return result;
    throw err;
  }
  if (!account.oauth_access_token) {
    return { status: 502, error: 'OAuth access token is corrupted — please reconnect your account.' };
  }

  return {
    account,
    transport: {
      sendMail: (mailOptions, options) => sendViaGmailApiWithFallback(account, mailOptions, options),
    },
  };
}

// Eagerly validate GMAIL_SEND_TRANSPORT at import time (routes/send.js pulls this module in at
// backend startup) so a misconfigured value is visible in the boot log, not only on the first
// Gmail send — matches the comment on gmailSendTransportSetting above.
gmailSendTransportSetting();
