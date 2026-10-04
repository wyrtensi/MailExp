import { query } from './db.js';

// Mutable config read by the rate-limit middleware on every request, so
// admin changes (via reloadAuthSettings) take effect without a restart.
export const authLimiterConfig = { maxRequests: 10, windowMs: 15 * 60 * 1000 };

export async function reloadAuthSettings() {
  try {
    const result = await query(
      "SELECT key, value FROM system_settings WHERE key IN ('auth_max_attempts', 'auth_window_minutes')"
    );
    for (const row of result.rows) {
      if (row.key === 'auth_max_attempts') {
        const val = parseInt(row.value);
        if (Number.isInteger(val) && val >= 1 && val <= 100)
          authLimiterConfig.maxRequests = val;
      } else if (row.key === 'auth_window_minutes') {
        const val = parseInt(row.value);
        if (Number.isInteger(val) && val >= 1 && val <= 1440)
          authLimiterConfig.windowMs = val * 60 * 1000;
      }
    }
  } catch (err) {
    console.error('[auth] Failed to load rate limit settings:', err.message);
  }
}

// --- the sign-in limits ---------------------------------------------------------------------------
//
// Every limited route has its own purpose in its keys (auth:<purpose>-ip:<address>,
// auth:<purpose>-acct:<account>, ...), so the steps never share a counter: many people signing in
// through one office NAT never use up the 2FA step's allowance, a successful 2FA step never clears
// the sign-in counters, and asking for a password reset never locks an account's sign-in.
// req.ip depends on `trust proxy` (utils/trustProxy.js). `max` below is the configured
// auth_max_attempts; the factors give the looser caps.

// The client address, shared by an office NAT, gets this many times the limit wherever an
// account (or a pending sign-in) carries the real one.
export const ADDRESS_LIMIT_FACTOR = 10;
// Sign-in: failures against one account from all addresses together, as a multiple of the limit
// that one address may make against it.
export const ACCOUNT_LIMIT_FACTOR = 10;

// The account a request names, as the limiter keys it: trimmed and lower-cased, or null.
export function limitedIdentity(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized.slice(0, 320) : null;
}

function tooMany(res, retryMs) {
  res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
  return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
}

// Every request counts (2FA steps, registration, password reset links). `identity(req)` names the
// account or pending sign-in the request is about: it then carries the limit, the address a looser
// one. Without one only the address counts, at the limit. `res.locals.resetRateLimit` clears the
// identity's counter (else the address's), never another purpose's.
export function createAuthRateLimit(config, { consume, reset, purpose, identity = () => null }) {
  if (!purpose) throw new Error('createAuthRateLimit needs a purpose');
  return async (req, res, next) => {
    const { maxRequests, windowMs } = config;
    const ipKey = `auth:${purpose}-ip:${req.ip}`;
    const id = identity(req);
    const buckets = id
      ? [[`auth:${purpose}-acct:${id}`, maxRequests], [ipKey, maxRequests * ADDRESS_LIMIT_FACTOR]]
      : [[ipKey, maxRequests]];
    let retryMs = 0;
    for (const [key, max] of buckets) {
      const { limited, resetMs } = await consume(key, max, windowMs);
      if (limited) retryMs = Math.max(retryMs, resetMs);
    }
    if (retryMs) return tooMany(res, retryMs);
    res.locals.resetRateLimit = () => reset(buckets[0][0]);
    next();
  };
}

// Password sign-in: only failed attempts count (the route calls res.locals.recordAuthFailure), so
// the people of one office signing in correctly never use the limit up, and nobody can lock an
// account by merely naming it. Counted per failure:
//   - the account from this address (the limit): what locks out someone guessing from one place;
//   - the account from everywhere (ACCOUNT_LIMIT_FACTOR x the limit): a distributed guess;
//   - the address over all accounts (ADDRESS_LIMIT_FACTOR x the limit): one client spraying.
// Someone who can make an account's failures from many addresses can still hold that account's
// sign-in for a window; a request carrying a trusted-device cookie of that account
// (`isTrustedDevice(req, account)`) is not held by the account limits, only by its address.
// A success clears the account-from-this-address counter only.
export function createLoginLimit(config, { peek, consume, reset, purpose, identity, isTrustedDevice = async () => false }) {
  return async (req, res, next) => {
    const { maxRequests, windowMs } = config;
    const ipKey = `auth:${purpose}-ip:${req.ip}`;
    const account = identity(req);
    const accountBuckets = account
      ? [[`auth:${purpose}-acct-ip:${account}|${req.ip}`, maxRequests], [`auth:${purpose}-acct:${account}`, maxRequests * ACCOUNT_LIMIT_FACTOR]]
      : [];
    const ipBucket = [ipKey, maxRequests * ADDRESS_LIMIT_FACTOR];

    let retryMs = 0;
    const ip = await peek(ipBucket[0], ipBucket[1], windowMs);
    if (ip.limited) retryMs = ip.resetMs;
    let accountRetryMs = 0;
    for (const [key, max] of accountBuckets) {
      const { limited, resetMs } = await peek(key, max, windowMs);
      if (limited) accountRetryMs = Math.max(accountRetryMs, resetMs);
    }
    if (accountRetryMs && !(await isTrustedDevice(req, account))) retryMs = Math.max(retryMs, accountRetryMs);
    if (retryMs) return tooMany(res, retryMs);

    res.locals.recordAuthFailure = () => Promise.all(
      [ipBucket, ...accountBuckets].map(([key, max]) => consume(key, max, windowMs)),
    ).catch(() => {});
    res.locals.resetRateLimit = () => (accountBuckets.length ? reset(accountBuckets[0][0]) : undefined);
    next();
  };
}
