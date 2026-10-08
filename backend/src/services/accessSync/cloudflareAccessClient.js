// Reads and writes one Cloudflare Access policy. Errors carry the HTTP status and Cloudflare
// error codes only: response texts can quote emails or other account details.
const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 10_000;
const READ_ONLY_FIELDS = new Set(['id', 'uid', 'created_at', 'updated_at', 'reusable', 'app_count']);
// Statuses with which a token-verify endpoint refuses a token it does not own.
const REFUSED = new Set([400, 401, 403]);

export class CloudflareAccessError extends Error {
  // retryAfter: the seconds of a Retry-After header (a 429 or a 5xx), or null.
  constructor(action, status, codes = [], { retryAfter = null } = {}) {
    super(`Cloudflare ${action} failed (${status})${codes.length ? `: error ${codes.join(', ')}` : ''}`);
    this.name = 'CloudflareAccessError';
    this.status = status;
    this.codes = codes;
    this.retryAfter = retryAfter;
  }

  // A failure that may pass on its own: the network, a timeout, Cloudflare's own trouble (5xx) or
  // its rate limit (429). Authentication, permissions and a wrong ID (4xx) wait for an operator.
  get retriable() {
    return this.status === 'network' || this.status === 'timeout' || this.status === 429
      || (Number.isInteger(this.status) && this.status >= 500);
  }
}

// Retry-After in seconds: a number of seconds or an HTTP date; null when absent or unreadable.
export function parseRetryAfter(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

// CF_API_BASE points the client at a test server; production uses the public API.
export function cloudflareApiBase(env = process.env) {
  return String(env.CF_API_BASE ?? '').trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
}

export function createCloudflareAccessClient({
  accountId, appId, apiToken, apiBase = cloudflareApiBase(), fetchImpl = fetch,
}) {
  const accessUrl = `${apiBase}/accounts/${accountId}/access`;

  async function call(action, method, url, body) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new CloudflareAccessError(action, err?.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.success === false) {
      const codes = (Array.isArray(payload?.errors) ? payload.errors : [])
        .map((error) => error?.code)
        .filter(Number.isInteger);
      throw new CloudflareAccessError(action, res.status, codes, { retryAfter: parseRetryAfter(res.headers?.get?.('retry-after')) });
    }
    return payload.result;
  }

  return {
    // Whether Cloudflare takes the token at all, and its status and expiry. A user token answers
    // on /user/tokens/verify; an account-owned token is refused there and answers on the account's
    // own endpoint. When both refuse, the user endpoint's refusal is the one reported; a failure
    // of the account endpoint that is not a refusal (its 5xx, the network) is reported as is.
    async verifyToken() {
      const answer = (result, owner) => ({
        status: typeof result?.status === 'string' ? result.status : 'unknown',
        expiresOn: typeof result?.expires_on === 'string' ? result.expires_on : null,
        owner,
      });
      try {
        return answer(await call('verifyToken', 'GET', `${apiBase}/user/tokens/verify`), 'user');
      } catch (err) {
        if (!REFUSED.has(err.status)) throw err;
        try {
          return answer(await call('verifyToken', 'GET', `${apiBase}/accounts/${accountId}/tokens/verify`), 'account');
        } catch (accountErr) {
          throw REFUSED.has(accountErr.status) || accountErr.status === 404 ? err : accountErr;
        }
      }
    },

    // The Access application, with its aud tag; needs "Access: Apps and Policies" Read.
    getApp() {
      return call('getApp', 'GET', `${accessUrl}/apps/${appId}`);
    },

    async getPolicy(policyId) {
      try {
        return await call('getPolicy', 'GET', `${accessUrl}/apps/${appId}/policies/${policyId}`);
      } catch (err) {
        if (err.status !== 404) throw err;
        // Reusable policies are readable through the application they are attached to, so a 404
        // there with the policy present on the account means it is not attached to this app. The
        // probe's own failure is only meaningful when it is itself a 404 (policy missing
        // everywhere, so the original error stands): a network error, a timeout or any other
        // status means the probe could not tell either way, so that failure is reported instead
        // of guessing "not on account" from it.
        try {
          await call('getPolicy', 'GET', `${accessUrl}/policies/${policyId}`);
        } catch (probeErr) {
          throw probeErr.status === 404 ? err : probeErr;
        }
        throw new CloudflareAccessError('getPolicy', 'not_attached');
      }
    },

    // PUT replaces the whole policy, so every field read is written back except read-only ones.
    updatePolicy(policy) {
      const body = Object.fromEntries(Object.entries(policy).filter(([key]) => !READ_ONLY_FIELDS.has(key)));
      body.exclude = policy.exclude ?? [];
      body.require = policy.require ?? [];
      const url = policy.reusable === true
        ? `${accessUrl}/policies/${policy.id}`
        : `${accessUrl}/apps/${appId}/policies/${policy.id}`;
      return call('updatePolicy', 'PUT', url, body);
    },
  };
}
