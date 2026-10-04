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

// On a route that names an account (login, forgot-password), the account carries the real limit
// and the client address only a looser one: people behind one office NAT share an address, and
// ten mistyped passwords there must not lock all of them out. The address bucket still caps one
// client trying many accounts.
export const ADDRESS_LIMIT_FACTOR = 10;

// The account a request names, as the limiter keys it: trimmed and lower-cased, or null.
export function limitedIdentity(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized.slice(0, 320) : null;
}

// Express middleware for the sign-in routes. `identity(req)` names the account the request is
// about (null on routes that name none); without one only the client address counts, at the
// configured limit. `res.locals.resetRateLimit` clears what a success should clear: the account's
// counter when there is one (so a successful sign-in cannot reset the address cap for others),
// else the address's. req.ip depends on `trust proxy` (utils/trustProxy.js).
export function createAuthRateLimit(config, { consume, reset, identity = () => null }) {
  return async (req, res, next) => {
    const { maxRequests, windowMs } = config;
    const ipKey = `auth:${req.ip}`;
    const account = identity(req);
    const buckets = account
      ? [[`auth:user:${account}`, maxRequests], [ipKey, maxRequests * ADDRESS_LIMIT_FACTOR]]
      : [[ipKey, maxRequests]];
    let retryMs = 0;
    for (const [key, max] of buckets) {
      const { limited, resetMs } = await consume(key, max, windowMs);
      if (limited) retryMs = Math.max(retryMs, resetMs);
    }
    if (retryMs) {
      res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    res.locals.resetRateLimit = () => reset(buckets[0][0]);
    next();
  };
}
