import { afterEach, describe, expect, it } from 'vitest';
import { createFakeTenantDriver, getTenantDriver, resetTenantDriver, setTenantDriver, tenantOf } from './driver.js';
import { TENANT_FIXTURES } from './fakes.js';

// Which tenant driver the panel runs with, and the tenant of the settings.

const SETTINGS = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: TENANT_FIXTURES.worker.certificate.thumbprint,
};
const warnings = [];
const pick = (env) => getTenantDriver({ env, warn: (line) => warnings.push(line) });

afterEach(() => {
  resetTenantDriver();
  warnings.length = 0;
});

describe('getTenantDriver', () => {
  it('none without configuration', () => {
    expect(pick({})).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('the worker with its URL and a long enough token', () => {
    expect(pick({ TENANT_WORKER_URL: 'http://tenant-worker:8080', TENANT_WORKER_TOKEN: 'x'.repeat(32) }).kind).toBe('worker');
    resetTenantDriver();
    expect(pick({ TENANT_WORKER_URL: 'http://tenant-worker:8080', TENANT_WORKER_TOKEN: 'tok-123' })).toBeNull();
    expect(warnings[0]).toMatch(/TENANT_WORKER_TOKEN/);
    expect(warnings.join()).not.toContain('tok-123');
  });

  it('the fakes for tests and the stand, refused in production unless it is a stand', () => {
    expect(pick({ TENANT_DRIVER: 'fake' }).kind).toBe('fake');
    resetTenantDriver();
    expect(pick({ TENANT_DRIVER: 'fake', NODE_ENV: 'production' })).toBeNull();
    expect(warnings.at(-1)).toMatch(/ignored/);
    resetTenantDriver();
    expect(pick({ TENANT_DRIVER: 'fake', NODE_ENV: 'production', TENANT_DRIVER_STAND: '1' }).kind).toBe('fake');
  });

  it('an override wins and undefined puts the configured one back', () => {
    const fake = createFakeTenantDriver();
    setTenantDriver(fake);
    expect(pick({})).toBe(fake);
    setTenantDriver(null);
    expect(pick({ TENANT_DRIVER: 'fake' })).toBeNull();
    setTenantDriver(undefined);
    expect(pick({})).toBeNull();
  });
});

describe('the fake driver', () => {
  it('keeps one Graph client (one token) per tenant', async () => {
    const driver = createFakeTenantDriver();
    const tenant = tenantOf(SETTINGS);
    const a = driver.forTenant(tenant);
    expect(driver.forTenant({ ...tenant }).graph).toBe(a.graph);
    await a.graph.request('GET', '/domains');
    await a.graph.request('GET', '/domains');
    expect(driver.fake.graph.requests.filter((r) => r.kind === 'token')).toHaveLength(1);
    expect(driver.forTenant({ ...tenant, appId: '77777777-7777-4888-9999-aaaaaaaaaaaa' }).graph).not.toBe(a.graph);
    expect(await a.exo.run('get_accepted_domain', { domain: 'example.com' })).toEqual(TENANT_FIXTURES.exo.get_accepted_domain);
    expect(await driver.certificate()).toEqual(TENANT_FIXTURES.worker.certificate);
  });
});

describe('tenantOf', () => {
  it('needs all four fields', () => {
    expect(tenantOf(SETTINGS)).toEqual({
      tenantId: SETTINGS.tenantId, appId: SETTINGS.appId, organization: 'contoso.onmicrosoft.com', thumbprint: SETTINGS.certThumbprint,
    });
    for (const field of Object.keys(SETTINGS)) expect(tenantOf({ ...SETTINGS, [field]: null })).toBeNull();
    expect(tenantOf(null)).toBeNull();
  });
});
