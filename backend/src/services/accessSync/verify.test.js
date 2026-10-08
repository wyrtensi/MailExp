import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => {
    if (!v.startsWith('enc:')) throw new Error('bad key');
    return v.slice(4);
  },
}));

import { AccessSyncVerifyError, failureCode, resolveVerifyConfig, verifyAccessSyncConfig } from './verify.js';
import { CloudflareAccessError } from './cloudflareAccessClient.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const AUD = 'a'.repeat(64);
const TOKEN = 'cf-token-AbCdEf0123456789xyzXYZ_-0123';
const STORED = { enabled: false, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: `enc:${TOKEN}` };
const load = (stored = STORED) => async () => stored;

const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
const fail = (status, code = 10000) => new Response(JSON.stringify({ success: false, errors: [{ code }] }), { status });

// A fake Cloudflare: routes answer by URL suffix; anything not routed is a 404.
function cloudflare(routes) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init.method, authorization: init.headers.authorization });
    const hit = Object.entries(routes).find(([suffix]) => String(url).endsWith(suffix));
    return hit ? hit[1]() : fail(404, 7003);
  });
  return { fetchImpl, calls };
}

const healthy = () => ({
  '/user/tokens/verify': () => ok({ id: 't', status: 'active', expires_on: null }),
  [`/access/apps/${APP}`]: () => ok({ id: APP, name: 'MailExpert', aud: AUD }),
  [`/access/apps/${APP}/policies/${POLICY}`]: () => ok({ id: POLICY, decision: 'allow', include: [] }),
});

describe('resolveVerifyConfig', () => {
  it('uses the stored settings and decrypts the stored token', async () => {
    expect(await resolveVerifyConfig({}, { load: load() })).toEqual({
      accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: TOKEN, tokenFromForm: false,
    });
  });

  it('takes the form\'s unsaved values in place of the stored ones', async () => {
    const other = '99999999-2222-4333-8444-555555555555';
    const config = await resolveVerifyConfig({ appId: other.toUpperCase(), apiToken: ` ${TOKEN}x ` }, { load: load() });
    expect(config).toMatchObject({ appId: other, apiToken: `${TOKEN}x`, tokenFromForm: true });
  });

  it('refuses malformed IDs and tokens, and needs an account and a token', async () => {
    const codeOf = (input, stored) => resolveVerifyConfig(input, { load: load(stored) }).catch((err) => err);
    expect((await codeOf({ accountId: 'nope' })).code).toBe('invalid_id');
    expect((await codeOf({ policyId: 'nope' })).code).toBe('invalid_id');
    expect((await codeOf({ apiToken: 'has spaces in it but long enough' })).code).toBe('token_invalid');
    expect((await codeOf({}, { ...STORED, apiToken: null })).code).toBe('verify_incomplete');
    expect((await codeOf({}, { ...STORED, accountId: '' })).code).toBe('verify_incomplete');
    const undecryptable = await codeOf({}, { ...STORED, apiToken: 'garbage' });
    expect(undecryptable).toBeInstanceOf(AccessSyncVerifyError);
    expect(undecryptable.code).toBe('token_undecryptable');
  });
});

describe('verifyAccessSyncConfig', () => {
  const config = { accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: TOKEN };

  it('passes every check with a working token, the right application and an Allow policy', async () => {
    const { fetchImpl, calls } = cloudflare(healthy());
    const result = await verifyAccessSyncConfig(config, { fetchImpl, audience: AUD });
    expect(result).toEqual({
      ok: true,
      checks: [
        { id: 'token', status: 'ok', code: 'active', expiresOn: null, owner: 'user' },
        { id: 'app', status: 'ok', code: 'found', name: 'MailExpert' },
        { id: 'audience', status: 'ok', code: 'match' },
        { id: 'policy', status: 'ok', code: 'found', reusable: false },
      ],
    });
    // Reads only, every one with the token as a bearer.
    expect(calls.every((call) => call.method === 'GET' && call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('names a token without the Access permission and a wrong aud tag, and never passes on the token', async () => {
    const forbidden = cloudflare({ ...healthy(), [`/access/apps/${APP}`]: () => fail(403), [`/access/apps/${APP}/policies/${POLICY}`]: () => fail(403) });
    const result = await verifyAccessSyncConfig(config, { fetchImpl: forbidden.fetchImpl, audience: AUD });
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => [check.id, check.status, check.code])).toEqual([
      ['token', 'ok', 'active'], ['app', 'failed', 'forbidden'], ['audience', 'skipped', 'no_app'], ['policy', 'failed', 'forbidden'],
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    const mismatch = cloudflare(healthy());
    const other = await verifyAccessSyncConfig(config, { fetchImpl: mismatch.fetchImpl, audience: 'b'.repeat(64) });
    expect(other.checks[2]).toEqual({ id: 'audience', status: 'failed', code: 'mismatch' });
  });

  it('reports a revoked token, an unattached policy and a policy that is not Allow', async () => {
    const revoked = cloudflare({ '/tokens/verify': () => fail(401, 1000) });
    const result = await verifyAccessSyncConfig(config, { fetchImpl: revoked.fetchImpl, audience: AUD });
    expect(result.checks[0]).toEqual({ id: 'token', status: 'failed', code: 'refused' });

    const unattached = cloudflare({
      ...healthy(),
      [`/access/apps/${APP}/policies/${POLICY}`]: () => fail(404),
      [`/access/policies/${POLICY}`]: () => ok({ id: POLICY }),
    });
    expect((await verifyAccessSyncConfig(config, { fetchImpl: unattached.fetchImpl, audience: AUD })).checks[3])
      .toEqual({ id: 'policy', status: 'failed', code: 'not_attached' });

    const block = cloudflare({ ...healthy(), [`/access/apps/${APP}/policies/${POLICY}`]: () => ok({ id: POLICY, decision: 'deny' }) });
    expect((await verifyAccessSyncConfig(config, { fetchImpl: block.fetchImpl, audience: AUD })).checks[3])
      .toEqual({ id: 'policy', status: 'failed', code: 'not_allow' });
  });

  it('reports an expired token by its status', async () => {
    const expired = cloudflare({ ...healthy(), '/user/tokens/verify': () => ok({ status: 'expired', expires_on: '2026-01-01T00:00:00Z' }) });
    const result = await verifyAccessSyncConfig(config, { fetchImpl: expired.fetchImpl, audience: AUD });
    expect(result.checks[0]).toEqual({ id: 'token', status: 'failed', code: 'token_expired', expiresOn: '2026-01-01T00:00:00Z' });
  });

  it('skips what it was not given: no application, no policy, no CF_ACCESS_AUDIENCE', async () => {
    const { fetchImpl } = cloudflare(healthy());
    const tokenOnly = await verifyAccessSyncConfig({ accountId: ACCOUNT, appId: '', policyId: '', apiToken: TOKEN }, { fetchImpl, audience: null });
    expect(tokenOnly.ok).toBe(true);
    expect(tokenOnly.checks.slice(1)).toEqual([
      { id: 'app', status: 'skipped', code: 'no_app_id' },
      { id: 'audience', status: 'skipped', code: 'no_app' },
      { id: 'policy', status: 'skipped', code: 'no_app_id' },
    ]);
    const noAudience = await verifyAccessSyncConfig({ ...config, policyId: '' }, { fetchImpl, audience: null });
    expect(noAudience.checks.slice(2)).toEqual([
      { id: 'audience', status: 'skipped', code: 'not_configured' },
      { id: 'policy', status: 'skipped', code: 'no_policy_id' },
    ]);
  });
});

describe('failureCode', () => {
  it('turns statuses into codes the screen can explain', () => {
    expect(failureCode(new CloudflareAccessError('x', 'timeout'))).toBe('unreachable');
    expect(failureCode(new CloudflareAccessError('x', 401))).toBe('refused');
    expect(failureCode(new CloudflareAccessError('x', 403))).toBe('forbidden');
    expect(failureCode(new CloudflareAccessError('x', 404))).toBe('not_found');
    expect(failureCode(new CloudflareAccessError('x', 429))).toBe('unavailable');
    expect(failureCode(new Error('boom'))).toBe('unexpected');
  });
});
