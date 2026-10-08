import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareAccessError, cloudflareApiBase, createCloudflareAccessClient, parseRetryAfter,
} from './cloudflareAccessClient.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const BASE = 'https://cf.test/client/v4';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const client = (fetchImpl) => createCloudflareAccessClient({ accountId: ACCOUNT, appId: APP, apiToken: 'tok-secret', apiBase: BASE, fetchImpl });

describe('cloudflareApiBase', () => {
  it('defaults to the public API and trims a trailing slash from an override', () => {
    expect(cloudflareApiBase({})).toBe('https://api.cloudflare.com/client/v4');
    expect(cloudflareApiBase({ CF_API_BASE: ' http://127.0.0.1:4010/ ' })).toBe('http://127.0.0.1:4010');
  });
});

describe('retriable failures', () => {
  it('reads Retry-After on a rate limit and marks network, timeout, 429 and 5xx as retriable', async () => {
    const limited = { ...reply(429, { success: false, errors: [] }), headers: new Headers({ 'retry-after': '120' }) };
    const err = await client(async () => limited).getPolicy(POLICY).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(120);
    expect(err.retriable).toBe(true);
    expect(new CloudflareAccessError('getPolicy', 'network').retriable).toBe(true);
    expect(new CloudflareAccessError('getPolicy', 'timeout').retriable).toBe(true);
    expect(new CloudflareAccessError('getPolicy', 502).retriable).toBe(true);
    expect(new CloudflareAccessError('getPolicy', 403).retriable).toBe(false);
    expect(new CloudflareAccessError('getPolicy', 'not_attached').retriable).toBe(false);
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-10-09T10:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30);
    expect(parseRetryAfter('Fri, 09 Oct 2026 10:02:00 GMT', now)).toBe(120);
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });
});

describe('getPolicy', () => {
  it('reads the policy through the application with the bearer token and a timeout', async () => {
    const policy = { id: POLICY, name: 'Allow', decision: 'allow', include: [] };
    const fetchImpl = vi.fn(async () => reply(200, { success: true, errors: [], result: policy }));
    expect(await client(fetchImpl).getPolicy(POLICY)).toEqual(policy);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/accounts/${ACCOUNT}/access/apps/${APP}/policies/${POLICY}`);
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer tok-secret');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports only the status and error codes, never the response text', async () => {
    const fetchImpl = vi.fn(async () => reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error for person@example.com' }] }));
    const err = await client(fetchImpl).getPolicy(POLICY).catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareAccessError);
    expect(err.message).toBe('Cloudflare getPolicy failed (403): error 10000');
    expect(err.status).toBe(403);
    expect(err.codes).toEqual([10000]);
    expect(err.message).not.toContain('person@example.com');
  });

  it('treats success: false or an unreadable body as a failure', async () => {
    await expect(client(async () => reply(200, { success: false, errors: [] })).getPolicy(POLICY))
      .rejects.toThrow('Cloudflare getPolicy failed (200)');
    await expect(client(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })).getPolicy(POLICY))
      .rejects.toThrow('Cloudflare getPolicy failed (200)');
  });

  it('says a policy exists but is not attached when only the account knows it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(404, { success: false, errors: [{ code: 12130 }] }))
      .mockResolvedValueOnce(reply(200, { success: true, result: { id: POLICY } }));
    const err = await client(fetchImpl).getPolicy(POLICY).catch((e) => e);
    expect(err.status).toBe('not_attached');
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/accounts/${ACCOUNT}/access/policies/${POLICY}`);

    const missing = vi.fn(async () => reply(404, { success: false, errors: [{ code: 12130 }] }));
    const notFound = await client(missing).getPolicy(POLICY).catch((e) => e);
    expect(notFound.status).toBe(404);
  });

  it('reports the probe\'s own failure when the probe itself is not a 404', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(404, { success: false, errors: [{ code: 12130 }] }))
      .mockImplementationOnce(async () => { throw new TypeError('fetch failed'); });
    const err = await client(fetchImpl).getPolicy(POLICY).catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareAccessError);
    expect(err.status).toBe('network');
  });

  it('names network failures and timeouts', async () => {
    const network = await client(async () => { throw new TypeError('fetch failed'); }).getPolicy(POLICY).catch((e) => e);
    expect(network.status).toBe('network');
    const timeout = await client(async () => { throw new DOMException('timed out', 'TimeoutError'); }).getPolicy(POLICY).catch((e) => e);
    expect(timeout.status).toBe('timeout');
  });
});

describe('updatePolicy', () => {
  const stored = {
    id: POLICY, uid: 'u', created_at: 'c', updated_at: 'u', app_count: 1, name: 'Allow', decision: 'allow',
    include: [{ email: { email: 'a@example.com' } }], precedence: 1,
  };

  it('writes an application policy whole, without read-only fields', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { success: true, result: {} }));
    await client(fetchImpl).updatePolicy({ ...stored, reusable: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/accounts/${ACCOUNT}/access/apps/${APP}/policies/${POLICY}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      name: 'Allow', decision: 'allow', include: [{ email: { email: 'a@example.com' } }], precedence: 1, exclude: [], require: [],
    });
  });

  it('writes a reusable policy through the account', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { success: true, result: {} }));
    await client(fetchImpl).updatePolicy({ ...stored, reusable: true, exclude: [{ email: { email: 'x@example.com' } }] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/accounts/${ACCOUNT}/access/policies/${POLICY}`);
    expect(JSON.parse(init.body).exclude).toEqual([{ email: { email: 'x@example.com' } }]);
    expect(JSON.parse(init.body)).not.toHaveProperty('reusable');
  });
});

describe('verifyToken', () => {
  it('asks Cloudflare about a user token and answers its status and expiry', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { success: true, result: { id: 'tid', status: 'active', expires_on: '2027-01-01T00:00:00Z' } }));
    expect(await client(fetchImpl).verifyToken()).toEqual({ status: 'active', expiresOn: '2027-01-01T00:00:00Z', owner: 'user' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/user/tokens/verify`);
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer tok-secret');
  });

  it('falls back to the account endpoint for an account-owned token', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(401, { success: false, errors: [{ code: 1000 }] }))
      .mockResolvedValueOnce(reply(200, { success: true, result: { id: 'tid', status: 'active' } }));
    expect(await client(fetchImpl).verifyToken()).toEqual({ status: 'active', expiresOn: null, owner: 'account' });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/accounts/${ACCOUNT}/tokens/verify`);
  });

  it('reports the user endpoint\'s refusal when the account endpoint refuses the token too', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(401, { success: false, errors: [{ code: 1000 }] }))
      .mockResolvedValueOnce(reply(401, { success: false, errors: [{ code: 1000 }] }));
    const err = await client(fetchImpl).verifyToken().catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareAccessError);
    expect(err.status).toBe(401);
  });

  it('reports the account endpoint\'s 403 or 404: a wrong account ID or a token of another account', async () => {
    for (const [userStatus, accountStatus] of [[401, 403], [401, 404], [403, 404], [400, 403]]) {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(reply(userStatus, { success: false, errors: [{ code: 1000 }] }))
        .mockResolvedValueOnce(reply(accountStatus, { success: false, errors: [{ code: 7003 }] }));
      const err = await client(fetchImpl).verifyToken().catch((e) => e);
      expect(err.status).toBe(accountStatus);
    }
  });

  it('reports the account endpoint\'s own failure when it is not a refusal', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(401, { success: false, errors: [{ code: 1000 }] }))
      .mockResolvedValueOnce(reply(503, { success: false, errors: [] }));
    const err = await client(fetchImpl).verifyToken().catch((e) => e);
    expect(err.status).toBe(503);
  });

  it('does not try the account endpoint after a network failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const err = await client(fetchImpl).verifyToken().catch((e) => e);
    expect(err.status).toBe('network');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('getApp', () => {
  it('reads the application by ID', async () => {
    const app = { id: APP, name: 'MailExpert', aud: 'a'.repeat(64), domain: 'mail.example.com' };
    const fetchImpl = vi.fn(async () => reply(200, { success: true, result: app }));
    expect(await client(fetchImpl).getApp()).toEqual(app);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/accounts/${ACCOUNT}/access/apps/${APP}`);
    expect(init.method).toBe('GET');
  });
});
