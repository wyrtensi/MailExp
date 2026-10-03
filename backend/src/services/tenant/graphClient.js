import { safeFetch } from '../safeFetch.js';
import { TenantError } from './exoRunner.js';

// GraphClient (R-22): Microsoft Graph with the application's own identity, client credentials with
// a certificate. The token request carries a client assertion (an RS256 JWT signed by the
// certificate's private key); the key never leaves the tenant worker (R-35), so the assertion comes
// from a signer: signer(tenant) -> { assertion }. Production signs in the worker (ExoRunner
// .assertion); tests and fakes sign with a key of their own.
//
//   graph.getToken()                     -> an access token, cached until 5 minutes before it ends
//   graph.request(method, path, { body }) -> the answer's JSON (null for 204)
//
// Stage 7b calls request() for the domains of R-23; stage 7c hands getToken to the message trace
// (services/mailNode/traceSource.js createGraphTraceSource({ baseUrl, getToken })).
//
// Throttling (429) is retried here up to maxRetries times, waiting what Retry-After says (at most
// MAX_RETRY_AFTER_MS) or 1, 2, 4 seconds; short outages (503, 504) the same, but only for GET: a
// POST, PATCH or DELETE that met a 503 may have been applied, so it is never repeated by itself
// (stage 7b writes domains and must check before it repeats). Then a TenantError graph_throttled
// with retryAfterMs: the tenant jobs keep it in their result and do not retry by themselves (one
// attempt each); the next poll or a click asks again. A 401 asks for a new token once and repeats
// the request. At most maxConcurrent requests of this process are in flight (R-38).

export const GRAPH_URL = 'https://graph.microsoft.com/v1.0';
export const LOGIN_URL = 'https://login.microsoftonline.com';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const TOKEN_EARLY_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRY_AFTER_MS = 60000;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

// At most `max` functions at once; the rest wait in order.
export function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active += 1;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  const limit = (fn) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    next();
  });
  limit.active = () => active;
  return limit;
}

// Retry-After in seconds or as an HTTP date; null when absent or unreadable.
export function retryAfterMs(header, now = Date.now()) {
  if (header == null || header === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const RETRIED = new Set([429, 503, 504]);
const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// What a failed token request says, without the assertion: the OAuth error and the AADSTS code.
function tokenFailure(status, body) {
  const error = typeof body?.error === 'string' ? body.error.slice(0, 64) : `HTTP ${status}`;
  const aadsts = /AADSTS\d+/.exec(String(body?.error_description ?? ''))?.[0] ?? null;
  return new TenantError('graph_token_failed', `Graph refused the token request: ${error}${aadsts ? ` (${aadsts})` : ''}`, { status });
}

export function createGraphClient({
  tenant, signer, graphUrl = GRAPH_URL, loginUrl = LOGIN_URL, fetchImpl = null, maxConcurrent = 4, maxRetries = 3,
  sleep = sleepMs, now = () => Date.now(),
}) {
  const graphBase = String(graphUrl).replace(/\/+$/, '');
  const graphOrigin = new URL(graphBase).origin;
  const loginBase = String(loginUrl).replace(/\/+$/, '');
  const doFetch = fetchImpl ?? ((url, options) => safeFetch(url, options));
  const limit = createLimiter(maxConcurrent);
  let cached = null; // { token, until }
  let pending = null;

  async function fetchToken() {
    const { assertion } = await signer(tenant);
    const form = new URLSearchParams({
      client_id: tenant.appId,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    });
    let res;
    try {
      res = await doFetch(`${loginBase}/${encodeURIComponent(tenant.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TenantError('graph_unreachable', `The Microsoft login endpoint is unreachable (${err?.code || err?.name || 'error'})`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || typeof body?.access_token !== 'string') throw tokenFailure(res.status, body);
    const lifetime = Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 3600 * 1000;
    // Renewed 5 minutes before the end, or at half its life when it lives less than 10 minutes.
    cached = { token: body.access_token, until: now() + Math.max(lifetime - TOKEN_EARLY_MS, lifetime / 2) };
    return cached.token;
  }

  async function getToken() {
    if (cached && cached.until > now()) return cached.token;
    // One token request at a time: concurrent callers share it.
    if (!pending) pending = fetchToken().finally(() => { pending = null; });
    return pending;
  }

  async function once(method, url, body) {
    const token = await getToken();
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TenantError('graph_unreachable', `Graph is unreachable (${err?.code || err?.name || 'error'})`);
    }
    return res;
  }

  async function request(method, path, { body } = {}) {
    const url = /^https?:\/\//i.test(path) ? path : `${graphBase}${path.startsWith('/') ? '' : '/'}${path}`;
    // A next page or any absolute URL must stay on Graph: the token is never sent anywhere else.
    if (new URL(url).origin !== graphOrigin) throw new TenantError('graph_failed', 'Refused a Graph URL on another host');
    return limit(async () => {
      let renewed = false;
      for (let attempt = 0; ; attempt += 1) {
        const res = await once(method, url, body);
        if (res.status === 401 && !renewed) {
          // A token revoked or expired early: one new token, one more try.
          renewed = true;
          cached = null;
          continue;
        }
        if (res.status === 429 || (RETRIED.has(res.status) && method === 'GET')) {
          const wait = retryAfterMs(res.headers?.get?.('retry-after'), now()) ?? 1000 * 2 ** attempt;
          if (attempt < maxRetries && wait <= MAX_RETRY_AFTER_MS) {
            await sleep(wait);
            continue;
          }
          throw new TenantError('graph_throttled', `Graph asked to slow down (HTTP ${res.status})`, { status: res.status, retryAfterMs: wait });
        }
        if (res.status === 401) cached = null;
        if (RETRIED.has(res.status)) {
          throw new TenantError('graph_unavailable', `Graph answered HTTP ${res.status}; the request may have been applied, not repeated`, { status: res.status });
        }
        if (res.status === 204) return null;
        const text = await res.text();
        if (Buffer.byteLength(text) > MAX_ANSWER_BYTES) throw new TenantError('graph_failed', 'Graph answered too much');
        let json;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (res.ok) return json;
        const code = typeof json?.error?.code === 'string' ? json.error.code.slice(0, 64) : null;
        throw new TenantError(res.status === 401 || res.status === 403 ? 'graph_forbidden' : 'graph_failed',
          `Graph answered HTTP ${res.status}${code ? ` (${code})` : ''}`, { status: res.status });
      }
    });
  }

  return { getToken, request, limit };
}
