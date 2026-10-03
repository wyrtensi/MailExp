import { readFileSync } from 'node:fs';
import { TenantError, checkExoOp } from './exoRunner.js';

// Fakes of the two transports (R-22, "без EOP: да"): an ExoRunner that answers the recorded JSON of
// fixtures.json, and a fetch for the Microsoft login endpoint and Graph. Tests drive them directly;
// TENANT_DRIVER=fake selects them for the stand and the demo backend (services/tenant/driver.js).
// They check what they are given the way the real ones do: the whitelist and its values, the
// thumbprint against the worker's certificate, the token request's form and the bearer token.

export const TENANT_FIXTURES = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// The real worker always knows its certificate; a test that makes the certificate read fail
// (certificateInfo an Error) does not make every call a mismatch.
const differs = (fake, tenant) => !(fake.certificateInfo instanceof Error) && tenant?.thumbprint !== fake.certificateInfo.thumbprint;
const mismatch = () => new TenantError('certificate_mismatch', 'The thumbprint in the panel is not the worker certificate\'s', { status: 409 });

// answers: { op: result | (args) => result | TenantError } over the recorded ones (tests change
// fake.answers and fake.certificateInfo as they go); calls: the operations that ran.
export function createFakeExoRunner({ answers = {}, certificate = TENANT_FIXTURES.worker.certificate } = {}) {
  const fake = {
    kind: 'fake',
    calls: [],
    answers: { ...answers },
    certificateInfo: { ...certificate },
    async certificate() {
      if (fake.certificateInfo instanceof Error) throw fake.certificateInfo;
      return clone(fake.certificateInfo);
    },
    async assertion(tenant) {
      if (differs(fake, tenant)) throw mismatch();
      return { assertion: `fake.${Buffer.from(JSON.stringify({ aud: tenant.tenantId, iss: tenant.appId })).toString('base64url')}.sig`, expiresAt: null };
    },
    async run(tenant, op, args = {}) {
      const checked = checkExoOp(op, args);
      fake.calls.push({ op, args: checked, organization: tenant?.organization ?? null });
      if (differs(fake, tenant)) throw mismatch();
      const answer = Object.hasOwn(fake.answers, op) ? fake.answers[op] : TENANT_FIXTURES.exo[op];
      const value = typeof answer === 'function' ? await answer(checked) : answer;
      if (value instanceof Error) throw value;
      return clone(value);
    },
  };
  return fake;
}

const json = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

// A fetch for the token endpoint and Graph. graph: { 'GET /domains': body | (url) => Response };
// token: the token answer or a function of the form. requests: what was asked (no secrets kept).
export function createFakeGraphFetch({ graph = {}, token = TENANT_FIXTURES.graph.token } = {}) {
  const requests = [];
  const routes = { 'GET /domains': TENANT_FIXTURES.graph.domains, ...graph };
  const accessToken = () => (typeof token === 'object' && token ? token.access_token : null);
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    const method = options.method ?? 'GET';
    if (/\/oauth2\/v2\.0\/token$/.test(target.pathname)) {
      const form = new URLSearchParams(String(options.body ?? ''));
      requests.push({ kind: 'token', tenant: target.pathname.split('/')[1], clientId: form.get('client_id'), scope: form.get('scope') });
      if (form.get('grant_type') !== 'client_credentials'
        || form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        || !form.get('client_assertion')) {
        return json(400, { error: 'invalid_request', error_description: 'AADSTS900144: The request body must contain client_assertion.' });
      }
      const answer = typeof token === 'function' ? await token(form) : token;
      return answer instanceof Response ? answer : json(200, answer);
    }
    const path = target.pathname.replace(/^\/v1\.0/, '');
    requests.push({ kind: 'graph', method, path, query: target.search });
    if (options.headers?.Authorization !== `Bearer ${accessToken()}` && typeof token === 'object') {
      return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });
    }
    const route = routes[`${method} ${path}`];
    if (route === undefined) return json(404, { error: { code: 'Request_ResourceNotFound', message: 'Not found' } });
    const answer = typeof route === 'function' ? await route(target, options) : route;
    return answer instanceof Response ? answer : json(200, answer);
  };
  return { fetchImpl, requests };
}
