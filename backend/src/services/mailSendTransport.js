// The single entry point every send path (routes/send.js, services/ruleForwarder.js) uses to
// deliver a message. For a Gmail mailbox (OAuth, scope https://mail.google.com/) it sends over
// the Gmail API by default and falls back to SMTP when the API definitely did not accept the
// message; every other account (mailcow, generic IMAP/SMTP, Microsoft, Yahoo) is untouched — this
// resolves straight to createAccountSmtpTransport, byte-for-byte the same object it always
// returned. See services/gmailApiSender.js for the HTTP mechanics and error classification.
import { decrypt } from './encryption.js';
import { createAccountSmtpTransport, oauthRefreshFailureResult } from './smtpTransport.js';
import { ensureFreshOAuthAccount } from './oauth/tokenManager.js';
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
// startup-time warning rather than silently misbehaving or crashing the process.
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

// Runs the whole Gmail API attempt: the initial send, one retry after a forced token refresh if
// Google rejects the token, and one retry without threadId if Google refused only the threading
// metadata (a 400 whose own message names the thread — the message itself was never a problem).
// Resolves with the Message resource on success; throws a classified error otherwise (see
// gmailApiSender.js) for the caller to act on.
async function sendGmailApiMessage(account, rawMessage, threadId) {
  let accessToken = decrypt(account.oauth_access_token);
  try {
    return await attemptGmailApiSend(accessToken, rawMessage, threadId);
  } catch (err) {
    if (err?.gmailClassification?.kind !== 'auth_retry') {
      // Only a threadId-shaped definite refusal gets the no-threadId retry; anything else
      // (fallback, uncertain, or a terminal rejection unrelated to threading) propagates as-is.
      if (threadId && err?.gmailClassification?.kind === 'terminal' && /thread/i.test(err.gmailClassification.googleMessage || '')) {
        return attemptGmailApiSend(accessToken, rawMessage, null);
      }
      throw err;
    }
    // The token the caller holds was rejected. Force one refresh — same tokenManager.js entry
    // point the SMTP transport uses on an AUTH rejection — and retry exactly once with the new
    // token. A refresh failure (including oauth_reconnect_required) propagates as its
    // OAuthTokenError; send.js already maps that via OAUTH_SEND_FAILURES.
    const refreshed = await ensureFreshOAuthAccount(account, { force: true });
    accessToken = decrypt(refreshed.oauth_access_token);
    try {
      return await attemptGmailApiSend(accessToken, rawMessage, threadId);
    } catch (retryErr) {
      if (retryErr?.gmailClassification?.kind === 'auth_retry') {
        throw Object.assign(new Error('Gmail API rejected the access token after a refresh — please reconnect your account.'), {
          gmailApi: true, code: 'gmail_api_auth_failed', status: 502, definite: true,
        });
      }
      throw retryErr;
    }
  }
}

// Builds the raw message once, tries the Gmail API, and falls back to SMTP only for a
// classification of 'fallback' (the request definitely was not accepted — see
// classifyGmailApiResponseError/classifyGmailApiNetworkError). A 'terminal' classification and an
// unclassified network error (uncertain) both propagate unchanged: send.js's existing
// smtpFailureIsDefinite/send_uncertain handling (extended with sendFailureIsDefinite, which also
// honors `.definite`) already does the right thing with them.
async function sendViaGmailApiWithFallback(account, mailOptions, { threadId = null } = {}) {
  const rawMessage = await buildRawMessage(mailOptions);
  try {
    const result = await sendGmailApiMessage(account, rawMessage, threadId);
    // Best-effort bookkeeping only, past this point: a successful send must never end up
    // reported as failed (or "uncertain") because a cleanup step threw.
    if (account.oauth_app_id) clearGmailApiDisabled(account.oauth_app_id).catch(() => {});
    let messageId = mailOptions.messageId;
    if (result?.id) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), GMAIL_API_TIMEOUT_MS);
        const headerId = await getSentMessageIdHeader({ accessToken: decrypt(account.oauth_access_token), id: result.id, signal: controller.signal })
          .finally(() => clearTimeout(timer));
        if (headerId) messageId = headerId;
      } catch (err) {
        console.warn(`Gmail API post-send Message-ID verification failed for ${account.id}: ${err.message}`);
      }
    }
    return { via: 'api', messageId };
  } catch (err) {
    if (err?.gmailClassification?.kind !== 'fallback') throw err;
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
    await smtp.transport.sendMail(mailOptions);
    return { via: 'smtp', messageId: mailOptions.messageId };
  }
}

// Same return shape as createAccountSmtpTransport: `{ account, transport }` on success, or
// `{ status, error, code? }` for a failure that must stop the caller before any message is built
// (an OAuth refresh failure, exactly like the SMTP transport's own top-level check). The returned
// transport's sendMail(mailOptions, { threadId }) resolves to `{ via, messageId }` — `messageId`
// is normally mailOptions.messageId unchanged, but may be the id Gmail itself reports if it ever
// differs (see gmailApiSender.js's getSentMessageIdHeader).
export async function createAccountSendTransport(inputAccount) {
  if (!shouldUseGmailApi(inputAccount)) return createAccountSmtpTransport(inputAccount);

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
