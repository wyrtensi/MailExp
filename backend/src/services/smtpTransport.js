import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { decrypt } from './encryption.js';
import { currentAuthPass } from './mailNode/currentPassword.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection } from './hostValidation.js';
import { ensureFreshOAuthAccount } from './oauth/tokenManager.js';
import { OAUTH_SEND_FAILURES, isOAuthAccount } from './oauth/constants.js';

const SMTP_ATTEMPT_TIMEOUT_MS = 10_000;
const SMTP_FAILOVER_BUDGET_MS = 45_000;

// The name we give in EHLO/HELO. Without one nodemailer uses os.hostname(), and when that is not
// an FQDN (any Docker container with a default hostname) it sends `EHLO [127.0.0.1]`, a loopback
// HELO from a remote address that spam filters read as forgery (upstream #492, Bluehost discarded
// the mail). The panel does not name itself either: not its hostname, not its product name. It
// introduces itself with the domain of the address the letter is sent from, which the receiving
// side already sees in MAIL FROM and the From header, so it tells nobody anything new. With no
// usable sender domain (verify(), a malformed or IP-literal address) it says "localhost".
export const NEUTRAL_EHLO_NAME = 'localhost';

function senderAddress(from) {
  const first = [].concat(from ?? [])[0];
  if (!first) return '';
  if (typeof first === 'object') return first.address || '';
  const parsed = addressparser(String(first))[0];
  return parsed?.address || parsed?.group?.[0]?.address || '';
}

// Pure; exported for tests.
export function smtpClientName(from) {
  const address = senderAddress(from);
  const at = address.lastIndexOf('@');
  if (at < 0) return NEUTRAL_EHLO_NAME;
  const domain = domainToASCII(address.slice(at + 1).trim().replace(/\.$/, '')).toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || isIP(domain)) return NEUTRAL_EHLO_NAME;
  return domain;
}

export function isPreDeliveryConnectionError(err) {
  return err?.command === 'CONN';
}

async function runWithAddressFallback({
  resolved,
  transportOptions,
  operation,
  createTransport = nodemailer.createTransport,
  now = Date.now,
}) {
  const candidates = [...new Set(
    resolved.addresses?.length ? resolved.addresses : [resolved.host]
  )];
  const startedAt = now();
  let lastError;

  for (let i = 0; i < candidates.length; i++) {
    const remaining = SMTP_FAILOVER_BUDGET_MS - (now() - startedAt);
    if (remaining < 2000 && lastError) throw lastError;
    const attemptTimeout = Math.max(1000, Math.min(SMTP_ATTEMPT_TIMEOUT_MS, Math.floor(remaining / 2)));
    const transport = createTransport({
      ...transportOptions,
      host: candidates[i],
      connectionTimeout: attemptTimeout,
      greetingTimeout: attemptTimeout,
    });

    try {
      return await operation(transport);
    } catch (err) {
      lastError = err;
      if (!isPreDeliveryConnectionError(err) || i === candidates.length - 1) throw err;
      console.warn('SMTP connection failed; retrying another validated address:', err.message);
    } finally {
      transport.close?.();
    }
  }

  throw lastError;
}

// Every SMTP transport in the app (account send, rule forwards, system email) is built here, so
// the EHLO name is set here for all of them: after the spread, so nothing falls back to
// nodemailer's os.hostname().
export function createSmtpTransport(resolved, transportOptions, createTransport = nodemailer.createTransport) {
  return {
    sendMail: mailOptions => runWithAddressFallback({
      resolved,
      transportOptions: { ...transportOptions, name: smtpClientName(mailOptions?.envelope?.from || mailOptions?.from) },
      operation: transport => transport.sendMail(mailOptions),
      createTransport,
    }),
    verify: () => runWithAddressFallback({
      resolved,
      transportOptions: { ...transportOptions, name: NEUTRAL_EHLO_NAME },
      operation: transport => transport.verify(),
      createTransport,
    }),
  };
}

// A server rejection of the AUTH exchange. Nodemailer tags it EAUTH with the AUTH command;
// EAUTH with command 'API' is a client-side credential problem that no refresh fixes.
// AUTH runs before MAIL FROM, so a message rejected here was never accepted for delivery.
export function isSmtpAuthRejection(err) {
  return err?.code === 'EAUTH' && /^AUTH\b/i.test(String(err?.command || ''));
}

// Stable, secret-free results for token-manager failures before a transport exists.
function oauthRefreshFailureResult(err) {
  const failure = Object.hasOwn(OAUTH_SEND_FAILURES, err?.code) ? OAUTH_SEND_FAILURES[err.code] : null;
  return failure ? { status: failure.status, code: err.code, error: failure.error } : null;
}

function oauthAuth(account) {
  const accessToken = decrypt(account.oauth_access_token);
  return accessToken ? { type: 'OAuth2', user: account.auth_user || account.email_address, accessToken } : null;
}

// OAuth transport: when the server rejects the token at AUTH (e.g. revoked early or clock
// skew), force one refresh and repeat the operation once with the new token. A failure of
// the forced refresh (including oauth_reconnect_required) propagates as the OAuthTokenError.
function createOAuthSmtpTransport(account, resolved, transportOptions) {
  const run = async (operation) => {
    try {
      return await operation(createSmtpTransport(resolved, transportOptions));
    } catch (err) {
      if (!isSmtpAuthRejection(err)) throw err;
      const refreshed = await ensureFreshOAuthAccount(account, { force: true });
      const auth = oauthAuth(refreshed);
      if (!auth) throw err;
      return await operation(createSmtpTransport(resolved, { ...transportOptions, auth }));
    }
  };
  return {
    sendMail: mailOptions => run(transport => transport.sendMail(mailOptions)),
    verify: () => run(transport => transport.verify()),
  };
}

export async function createAccountSmtpTransport(inputAccount) {
  let account = inputAccount;
  const isOAuth = isOAuthAccount(account);
  if (isOAuth) {
    // Single entry point for every provider: refreshes an expired token (with cross-process
    // dedup) and returns the row whose token the transport must use.
    try {
      account = await ensureFreshOAuthAccount(account);
    } catch (err) {
      const result = oauthRefreshFailureResult(err);
      if (result) return result;
      throw err;
    }
  }

  let auth;
  if (isOAuth && account.oauth_access_token) {
    auth = oauthAuth(account);
    if (!auth) {
      return {
        status: 502,
        error: 'OAuth access token is corrupted — please reconnect your account.',
      };
    }
  } else {
    // Separate SMTP credentials (issue #353): if the account has its own SMTP
    // username/password, use them; otherwise fall back to the IMAP login. Each
    // side falls back independently, so a different-username/same-password (or the
    // reverse) config also works. Empty/NULL columns are falsy and fall through.
    // The IMAP password comes from the same source as the IMAP login (currentAuthPass): a mail node
    // row read before a password restore (a rule forward on the live sync's row) sends with the new one.
    const pass = decrypt(account.smtp_auth_pass || currentAuthPass(account));
    if (!pass) {
      return {
        status: 502,
        error: 'SMTP password is corrupted or missing — please re-enter your account password in Settings.',
      };
    }
    auth = { user: account.smtp_auth_user || account.auth_user, pass };
  }

  const policy = await getConnectionPolicy();
  const resolved = await resolveForConnection(account.smtp_host, {
    allowPrivate: policy.allowPrivateHosts,
  });
  const plain = account.smtp_tls !== 'STARTTLS' && account.smtp_tls !== 'SSL';
  if (!policy.allowInsecureTls && plain) {
    return {
      status: 403,
      error: 'Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"',
    };
  }

  const tls = {
    rejectUnauthorized: !(policy.allowInsecureTls && account.imap_skip_tls_verify),
  };
  if (resolved.servername) tls.servername = resolved.servername;
  const secure = account.smtp_tls === 'SSL'
    || (account.smtp_tls !== 'none' && account.smtp_port === 465);
  const transportOptions = {
    port: account.smtp_port,
    secure,
    ...(account.smtp_tls === 'none' ? { ignoreTLS: true } : {}),
    // Without requireTLS nodemailer sends in plaintext when the server does not offer STARTTLS,
    // so anyone able to strip that capability from the greeting would read the credentials.
    ...(account.smtp_tls === 'STARTTLS' && !secure ? { requireTLS: true } : {}),
    auth,
    tls,
  };
  const transport = isOAuth
    ? createOAuthSmtpTransport(account, resolved, transportOptions)
    : createSmtpTransport(resolved, transportOptions);
  return { account, transport };
}
