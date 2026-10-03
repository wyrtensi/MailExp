import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { GRAPH_SCOPE, createGraphClient, createLimiter, retryAfterMs } from './graphClient.js';
import { createFakeGraphFetch, TENANT_FIXTURES } from './fakes.js';

// Graph with client credentials and a certificate assertion (R-22): the token request's form, the
// token cache, retries on throttling (Retry-After), the host the token may go to, at most a few
// requests at once (R-38).

const TENANT = {
  tenantId: '11111111-2222-4333-8444-555555555555', appId: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  organization: 'contoso.onmicrosoft.com', thumbprint: 'A'.repeat(40),
};
const GRAPH = 'https://graph.test.invalid/v1.0';
const LOGIN = 'https://login.test.invalid';

// A signer with a key of its own, as a test stands in for the worker.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
async function keySigner(tenant) {
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ aud: `${LOGIN}/${tenant.tenantId}/oauth2/v2.0/token`, iss: tenant.appId, sub: tenant.appId })}`;
  return { assertion: `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}` };
}

function client(options = {}) {
  const fake = createFakeGraphFetch(options.fake);
  const slept = [];
  const graph = createGraphClient({
    tenant: TENANT, signer: keySigner, graphUrl: GRAPH, loginUrl: LOGIN, fetchImpl: options.fetchImpl ?? fake.fetchImpl,
    sleep: async (ms) => { slept.push(ms); }, ...options.client,
  });
  return { graph, fake, slept };
}

describe('the token', () => {
  it('asks the tenant\'s v2.0 endpoint with a client assertion, once', async () => {
    const forms = [];
    const { graph, fake } = client({
      fake: {
        token: (form) => {
          forms.push(Object.fromEntries(form));
          return TENANT_FIXTURES.graph.token;
        },
      },
    });
    const [a, b] = await Promise.all([graph.getToken(), graph.getToken()]);
    expect(a).toBe('fake-graph-access-token');
    expect(b).toBe(a);
    expect(await graph.getToken()).toBe(a);
    expect(fake.requests.filter((r) => r.kind === 'token')).toEqual([
      { kind: 'token', tenant: TENANT.tenantId, clientId: TENANT.appId, scope: GRAPH_SCOPE },
    ]);
    const [form] = forms;
    expect(form.grant_type).toBe('client_credentials');
    expect(form.client_assertion_type).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const [h, c, s] = form.client_assertion.split('.');
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(form.client_secret).toBeUndefined();
  });

  it('a short-lived token is cached for half its life', async () => {
    let now = 0;
    let issued = 0;
    const { graph } = client({ fake: { token: () => ({ access_token: `t${++issued}`, expires_in: 240 }) }, client: { now: () => now } });
    expect(await graph.getToken()).toBe('t1');
    now = 100 * 1000;
    expect(await graph.getToken()).toBe('t1');
    now = 121 * 1000;
    expect(await graph.getToken()).toBe('t2');
  });

  it('is asked again once it is about to end', async () => {
    let now = 0;
    let issued = 0;
    const { graph } = client({
      fake: { token: () => ({ access_token: `t${++issued}`, expires_in: 3600 }) },
      client: { now: () => now },
    });
    expect(await graph.getToken()).toBe('t1');
    now = 54 * 60 * 1000;
    expect(await graph.getToken()).toBe('t1');
    now = 56 * 60 * 1000;
    expect(await graph.getToken()).toBe('t2');
  });

  it('a refusal names the OAuth error and the AADSTS code, never the assertion', async () => {
    const { graph } = client({
      fake: {
        token: () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS700027: Client assertion contains an invalid signature. [Reason - The key was not found.]' }), { status: 401 }),
      },
    });
    const err = await graph.getToken().catch((e) => e);
    expect(err).toMatchObject({ code: 'graph_token_failed', status: 401 });
    expect(err.message).toBe('Graph refused the token request: invalid_client (AADSTS700027)');
  });
});

describe('requests', () => {
  it('reads with the bearer token', async () => {
    const { graph, fake } = client();
    const answer = await graph.request('GET', '/domains?$select=id,isInitial,isVerified');
    expect(answer.value.map((d) => d.id)).toEqual(['contoso.onmicrosoft.com', 'example.com']);
    expect(fake.requests.at(-1)).toMatchObject({ kind: 'graph', method: 'GET', path: '/domains' });
  });

  it('waits what Retry-After says on 429, then answers', async () => {
    let calls = 0;
    const { graph, slept } = client({
      fake: {
        graph: {
          'GET /domains': () => {
            calls += 1;
            return calls < 3 ? new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }) : new Response('{"value":[]}', { status: 200 });
          },
        },
      },
    });
    expect(await graph.request('GET', '/domains')).toEqual({ value: [] });
    expect(slept).toEqual([7000, 7000]);
  });

  it('gives up with graph_throttled and the wait after its retries, or when the wait is too long', async () => {
    const { graph, slept } = client({ fake: { graph: { 'GET /domains': () => new Response('{}', { status: 503 }) } } });
    await expect(graph.request('GET', '/domains')).rejects.toMatchObject({ code: 'graph_throttled', status: 503, retryAfterMs: 8000 });
    expect(slept).toEqual([1000, 2000, 4000]);
    const long = client({ fake: { graph: { 'GET /domains': () => new Response('{}', { status: 429, headers: { 'Retry-After': '600' } }) } } });
    await expect(long.graph.request('GET', '/domains')).rejects.toMatchObject({ code: 'graph_throttled', retryAfterMs: 600000 });
    expect(long.slept).toEqual([]);
  });

  it('a 401 gets one new token and one more try', async () => {
    let calls = 0;
    const { graph, fake } = client({
      fake: { graph: { 'GET /domains': () => (++calls === 1 ? new Response('{}', { status: 401 }) : { value: [] }) } },
    });
    expect(await graph.request('GET', '/domains')).toEqual({ value: [] });
    expect(fake.requests.filter((r) => r.kind === 'token')).toHaveLength(2);
  });

  it('a write that met 503 is not repeated; a throttled one (429) is', async () => {
    let posts = 0;
    const { graph, slept } = client({ fake: { graph: { 'POST /domains': () => { posts += 1; return new Response('{}', { status: 503 }); } } } });
    await expect(graph.request('POST', '/domains', { body: { id: 'example.com' } })).rejects.toMatchObject({ code: 'graph_unavailable', status: 503 });
    expect(posts).toBe(1);
    expect(slept).toEqual([]);
    let throttled = 0;
    const t = client({ fake: { graph: { 'POST /domains': () => (++throttled === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }) : { id: 'example.com' }) } } });
    expect(await t.graph.request('POST', '/domains', { body: { id: 'example.com' } })).toEqual({ id: 'example.com' });
    expect(throttled).toBe(2);
  });

  it('names a refusal', async () => {
    const { graph } = client({
      fake: { graph: { 'GET /domains': () => new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied' } }), { status: 403 }) } },
    });
    await expect(graph.request('GET', '/domains')).rejects.toMatchObject({ code: 'graph_forbidden', message: 'Graph answered HTTP 403 (Authorization_RequestDenied)' });
  });

  it('never sends the token to another host', async () => {
    const { graph, fake } = client();
    await expect(graph.request('GET', 'https://evil.invalid/v1.0/domains')).rejects.toMatchObject({ code: 'graph_failed' });
    expect(fake.requests).toEqual([]);
  });

  it('keeps at most maxConcurrent requests in flight', async () => {
    let active = 0;
    let most = 0;
    const { graph } = client({
      client: { maxConcurrent: 2 },
      fake: {
        graph: {
          'GET /domains': async () => {
            active += 1;
            most = Math.max(most, active);
            await new Promise((r) => { setTimeout(r, 5); });
            active -= 1;
            return { value: [] };
          },
        },
      },
    });
    await Promise.all(Array.from({ length: 6 }, () => graph.request('GET', '/domains')));
    expect(most).toBe(2);
  });
});

describe('helpers', () => {
  it('retryAfterMs reads seconds and dates', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(new Date(10000).toUTCString(), 4000)).toBe(6000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });

  it('createLimiter keeps order and limit', async () => {
    const limit = createLimiter(1);
    const order = [];
    await Promise.all([1, 2, 3].map((n) => limit(async () => { order.push(n); })));
    expect(order).toEqual([1, 2, 3]);
  });
});
