import { describe, expect, it } from 'vitest';
import { EXO_OPS, TenantError, checkExoOp, createExoRunner, createMutex, parseConnectorName } from './exoRunner.js';
import { OPS as WORKER_OPS } from '../../../../deploy/tenant-worker/ops.mjs';

// The panel's side of the tenant worker: the whitelist checked before anything is sent (R-36), the
// token, one operation at a time (R-38), and how the worker's answers become errors.

const TENANT = {
  tenantId: '11111111-2222-4333-8444-555555555555', appId: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  organization: 'contoso.onmicrosoft.com', thumbprint: 'A'.repeat(40),
};
const TOKEN = 'k'.repeat(40);

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('checkExoOp (R-36)', () => {
  it('knows the same operations as the worker', () => {
    expect(Object.keys(EXO_OPS).sort()).toEqual(Object.keys(WORKER_OPS).sort());
    for (const [op, spec] of Object.entries(EXO_OPS)) expect(spec.params, op).toEqual(WORKER_OPS[op].params);
  });

  it('checks connector names and addresses of the stage 7b operations', () => {
    expect(checkExoOp('add_outbound_connector_domain', { connector: ' To mail node ', domain: 'Example.com' }))
      .toEqual({ connector: 'To mail node', domain: 'example.com' });
    for (const connector of ["x' -Confirm", 'a;b', 'Node$(x)', 'a'.repeat(65), '', null]) {
      expect(() => checkExoOp('add_outbound_connector_domain', { connector, domain: 'example.com' })).toThrow(TenantError);
      expect(parseConnectorName(connector)).toBeNull();
    }
    expect(checkExoOp('new_mail_contact', { address: 'Info@Example.com', external: 'info@relay.example.net' }))
      .toEqual({ address: 'info@example.com', external: 'info@relay.example.net' });
    expect(() => checkExoOp('new_mail_contact', { address: 'info@example.com' })).toThrow(TenantError);
    expect(() => checkExoOp('remove_mail_contact', { address: "o'brien@example.com" })).toThrow(TenantError);
  });

  it('refuses unknown operations and extra arguments', () => {
    expect(() => checkExoOp('Invoke-Expression')).toThrow(expect.objectContaining({ code: 'exo_op_unknown' }));
    expect(() => checkExoOp('toString')).toThrow(expect.objectContaining({ code: 'exo_op_unknown' }));
    expect(() => checkExoOp('whoami', { x: 1 })).toThrow(expect.objectContaining({ code: 'exo_args_invalid' }));
    expect(() => checkExoOp('whoami', ['a'])).toThrow(expect.objectContaining({ code: 'exo_args_invalid' }));
  });

  it.each([
    'example.com;Remove-MailContact x', '$(Get-Process).example.com', "example.com' -Confirm:$false '", 'example.com"',
    '`whoami`.example.com', 'example.com\nGet-Mailbox', 'exa mple.com', '', null, 42,
  ])('refuses the domain %j before it is sent', (domain) => {
    expect(() => checkExoOp('get_accepted_domain', { domain })).toThrow(TenantError);
  });

  it('normalizes what passes', () => {
    expect(checkExoOp('get_accepted_domain', { domain: ' Example.COM ' })).toEqual({ domain: 'example.com' });
    expect(checkExoOp('whoami')).toEqual({});
  });
});

describe('createExoRunner', () => {
  it('sends the token, the tenant and the checked arguments', async () => {
    const seen = [];
    const runner = createExoRunner({
      url: 'http://tenant-worker:8080/', token: TOKEN,
      fetchImpl: async (url, options) => { seen.push({ url, options }); return json(200, { ok: true, result: [{ DomainType: 'InternalRelay' }] }); },
    });
    expect(await runner.run(TENANT, 'get_accepted_domain', { domain: 'Example.com' })).toEqual([{ DomainType: 'InternalRelay' }]);
    expect(seen[0].url).toBe('http://tenant-worker:8080/ops/get_accepted_domain');
    expect(seen[0].options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen[0].options.body)).toEqual({ tenant: TENANT, args: { domain: 'example.com' } });
  });

  it('sends nothing for a refused value', async () => {
    let calls = 0;
    const runner = createExoRunner({ url: 'http://w', token: TOKEN, fetchImpl: async () => { calls += 1; return json(200, { ok: true }); } });
    await expect(runner.run(TENANT, 'get_accepted_domain', { domain: 'a;b' })).rejects.toMatchObject({ code: 'exo_args_invalid' });
    await expect(runner.run(TENANT, 'remove_everything')).rejects.toMatchObject({ code: 'exo_op_unknown' });
    expect(calls).toBe(0);
  });

  it('runs one operation at a time', async () => {
    let active = 0;
    let most = 0;
    const runner = createExoRunner({
      url: 'http://w', token: TOKEN,
      fetchImpl: async () => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((r) => { setTimeout(r, 5); });
        active -= 1;
        return json(200, { ok: true, result: [] });
      },
    });
    await Promise.all([runner.run(TENANT, 'whoami'), runner.run(TENANT, 'get_blocked_connector'), runner.run(TENANT, 'get_content_filter_policy')]);
    expect(most).toBe(1);
  });

  it('a failed operation does not stop the next', async () => {
    const answers = [json(502, { ok: false, error: { code: 'exo_failed', message: 'boom' } }), json(200, { ok: true, result: [] })];
    const runner = createExoRunner({ url: 'http://w', token: TOKEN, fetchImpl: async () => answers.shift() });
    await expect(runner.run(TENANT, 'whoami')).rejects.toMatchObject({ code: 'exo_failed', message: 'boom', status: 502 });
    await expect(runner.run(TENANT, 'whoami')).resolves.toEqual([]);
  });

  it('names the worker\'s refusals and its absence', async () => {
    const answer = (res) => createExoRunner({ url: 'http://w', token: TOKEN, fetchImpl: async () => res });
    await expect(answer(json(401, { ok: false, error: { code: 'unauthorized' } })).certificate()).rejects.toMatchObject({ code: 'worker_unauthorized' });
    await expect(answer(json(409, { ok: false, error: { code: 'certificate_mismatch', message: 'm' } })).assertion(TENANT)).rejects.toMatchObject({ code: 'certificate_mismatch' });
    await expect(answer(new Response('<html>', { status: 500 })).run(TENANT, 'whoami')).rejects.toMatchObject({ code: 'worker_failed' });
    const down = createExoRunner({ url: 'http://w', token: TOKEN, fetchImpl: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } });
    await expect(down.run(TENANT, 'whoami')).rejects.toMatchObject({ code: 'worker_unreachable' });
    const slow = createExoRunner({ url: 'http://w', token: TOKEN, fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
    await expect(slow.run(TENANT, 'whoami')).rejects.toMatchObject({ code: 'worker_timeout' });
  });

  it('no error carries the token', async () => {
    const runner = createExoRunner({ url: 'http://w', token: TOKEN, fetchImpl: async () => json(502, { ok: false, error: { code: 'exo_failed', message: 'x' } }) });
    const err = await runner.run(TENANT, 'whoami').catch((e) => e);
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(TOKEN);
  });
});

describe('createMutex', () => {
  it('runs in order and survives a failure', async () => {
    const exclusive = createMutex();
    const order = [];
    await Promise.allSettled([
      exclusive(async () => { await new Promise((r) => { setTimeout(r, 5); }); order.push(1); throw new Error('x'); }),
      exclusive(async () => { order.push(2); }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
