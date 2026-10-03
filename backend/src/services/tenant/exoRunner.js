import { safeFetch } from '../safeFetch.js';
import { parseHostName, parseLocalPart } from '../mailNode/mailcow.js';

// ExoRunner (R-22): the panel's client of the tenant worker (deploy/tenant-worker), the container
// that holds the Exchange Online PowerShell session and the application certificate. It runs only
// the worker's whitelisted operations (R-36): the same table as deploy/tenant-worker/ops.mjs, checked
// here as well, so a value that would be refused never leaves the panel. Values are checked with the
// panel's own rules (parseHostName, parseLocalPart) and sent as JSON; the worker splats them as
// parameters.
//
//   runner.run(tenant, op, args)  -> the operation's result (JSON)
//   runner.certificate()          -> { thumbprint, thumbprintSha256, subject, notBefore, notAfter }
//   runner.assertion(tenant)      -> { assertion, expiresAt }: a client assertion for Graph, signed
//                                    by the worker (the private key never leaves it, R-35)
//
// tenant: { tenantId, appId, organization, thumbprint } from the EOP settings. One operation at a
// time per worker (R-38): calls of this process wait for each other here, and the worker queues
// what other processes send. The certificate and the assertion do not touch pwsh and do not wait.

export class TenantError extends Error {
  constructor(code, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'TenantError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const parseAddress = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at < 1) return null;
  const local = parseLocalPart(text.slice(0, at));
  const domain = parseHostName(text.slice(at + 1));
  return local && domain ? `${local}@${domain}` : null;
};
const KINDS = { domain: parseHostName, address: parseAddress };

// The operations of the worker, by stage. 7b and 7c add theirs to both tables.
export const EXO_OPS = Object.freeze({
  whoami: { params: {} },
  get_blocked_connector: { params: {} },
  get_content_filter_policy: { params: {} },
  get_accepted_domain: { params: { domain: 'domain' } },
});

// The checked arguments of an operation; throws a TenantError (exo_op_unknown, exo_args_invalid).
export function checkExoOp(op, args = {}) {
  if (typeof op !== 'string' || !Object.hasOwn(EXO_OPS, op)) throw new TenantError('exo_op_unknown', 'Unknown tenant operation');
  const spec = EXO_OPS[op].params;
  const given = args ?? {};
  if (typeof given !== 'object' || Array.isArray(given) || Object.keys(given).some((name) => !Object.hasOwn(spec, name))) {
    throw new TenantError('exo_args_invalid', `Invalid arguments for ${op}`);
  }
  const checked = {};
  for (const [name, kind] of Object.entries(spec)) {
    const value = KINDS[kind](given[name]);
    if (value == null) throw new TenantError('exo_args_invalid', `Argument ${name} of ${op} is not a valid ${kind}`);
    checked[name] = value;
  }
  return checked;
}

// What a list operation answered, always as an array: the worker sends arrays, but a single object
// (one item unrolled by PowerShell) or nothing must not be read as something else.
export function asRows(value) {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object');
  if (value && typeof value === 'object') return [value];
  return [];
}

export const WORKER_TIMEOUT_MS = 150000;
const QUICK_TIMEOUT_MS = 15000;

// A promise chain: fn runs after every call queued before it.
export function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

export function createExoRunner({ url, token, fetchImpl = null, timeoutMs = WORKER_TIMEOUT_MS }) {
  const base = String(url).replace(/\/+$/, '');
  // The worker lives on the panel's internal Docker network: a private address over HTTP.
  const doFetch = fetchImpl ?? ((target, options) => safeFetch(target, options, { allowPrivate: true, requireHttps: false }));
  const exclusive = createMutex();

  async function call(method, route, body, ms) {
    let res;
    try {
      res = await doFetch(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new TenantError(timedOut ? 'worker_timeout' : 'worker_unreachable', `The tenant worker ${timedOut ? 'did not answer in time' : 'is unreachable'}`);
    }
    const answer = await res.json().catch(() => null);
    if (res.ok && answer?.ok) return answer.result;
    if (res.status === 401) throw new TenantError('worker_unauthorized', 'The tenant worker refused the panel\'s token', { status: 401 });
    const code = typeof answer?.error?.code === 'string' ? answer.error.code.slice(0, 64) : 'worker_failed';
    const message = typeof answer?.error?.message === 'string' ? answer.error.message.slice(0, 300) : `The tenant worker answered HTTP ${res.status}`;
    throw new TenantError(code, message, { status: res.status });
  }

  return {
    kind: 'worker',
    certificate: () => call('GET', '/certificate', null, QUICK_TIMEOUT_MS),
    assertion: (tenant) => call('POST', '/assertion', { tenant }, QUICK_TIMEOUT_MS),
    async run(tenant, op, args = {}) {
      const checked = checkExoOp(op, args);
      return exclusive(() => call('POST', `/ops/${op}`, { tenant, args: checked }, timeoutMs));
    },
  };
}
