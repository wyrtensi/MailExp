import { describe, expect, it, vi } from 'vitest';

// The pure parts of the seat count and that taking a seat locks first. The ledger against the real
// schema is eopSeats.pglite.test.js.
vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../tenant/driver.js', () => ({ getTenantDriver: vi.fn(() => null) }));
vi.mock('./eopSettings.js', async (importActual) => ({
  ...(await importActual()),
  getEopSettings: vi.fn(async () => ({ licenses: 3 })),
}));

const { withTransaction } = await import('../db.js');
const { TENANT_FIXTURES } = await import('../tenant/fakes.js');
const {
  SEATS_STALE_MS, parseHoldDays, parseSubscribedSkus, purchasedSeats, reserveSeat, seatSource,
} = await import('./eopSeats.js');

const TENANT = { tenantId: 't', tenantDomain: 'contoso.onmicrosoft.com', appId: 'a', certThumbprint: 'c' };
const NOW = Date.parse('2026-10-07T12:00:00Z');

describe('parseSubscribedSkus', () => {
  it('takes prepaidUnits.enabled of EOP_ENTERPRISE only', () => {
    const parsed = parseSubscribedSkus(TENANT_FIXTURES.graph.subscribedSkus);
    expect(parsed.found).toBe(true);
    expect(parsed.purchased).toBe(10);
    expect(parsed.skus).toEqual([{
      skuId: '45a2423b-e884-448d-a831-d9e139c52d2f', appliesTo: 'User', capabilityStatus: 'Enabled',
      enabled: 10, suspended: 0, warning: 0, consumedUnits: 0,
    }]);
  });

  it('adds up two EOP subscriptions and answers 0 without one', () => {
    const one = TENANT_FIXTURES.graph.subscribedSkus.value[0];
    expect(parseSubscribedSkus({ value: [one, { ...one, prepaidUnits: { enabled: 5 } }] }).purchased).toBe(15);
    expect(parseSubscribedSkus({ value: [TENANT_FIXTURES.graph.subscribedSkus.value[1]] })).toEqual({ found: false, purchased: 0, skus: [] });
    expect(parseSubscribedSkus(null)).toEqual({ found: false, purchased: 0, skus: [] });
  });
});

describe('seatSource', () => {
  it('reads Graph only with a real driver and the tenant configured', () => {
    expect(seatSource(TENANT, { kind: 'worker' })).toBe('graph');
    expect(seatSource(TENANT, { kind: 'fake' })).toBe('manual');
    expect(seatSource(TENANT, null)).toBe('manual');
    expect(seatSource({ ...TENANT, appId: null }, { kind: 'worker' })).toBe('manual');
  });
});

describe('purchasedSeats', () => {
  it('takes the manual number in manual mode', () => {
    expect(purchasedSeats({ eop: { licenses: 4 }, read: null, source: 'manual', now: NOW })).toEqual({
      purchased: 4, mode: 'manual', source: 'manual', at: null, stale: false, notReconciled: false, error: null,
    });
    expect(purchasedSeats({ eop: { licenses: null }, read: null, source: 'manual', now: NOW }).purchased).toBeNull();
  });

  it('takes the last Graph read, stale after 3 days, with the last error beside it', () => {
    const at = new Date(NOW - SEATS_STALE_MS - 1000).toISOString();
    const read = { at, ok: false, purchased: 7, error: { code: 'graph_forbidden', message: 'x' } };
    expect(purchasedSeats({ eop: { licenses: 99 }, read, source: 'graph', now: NOW })).toEqual({
      purchased: 7, mode: 'graph', source: 'graph', at, stale: true, notReconciled: false, error: { code: 'graph_forbidden', message: 'x' },
    });
    const fresh = { at: new Date(NOW - 1000).toISOString(), ok: true, purchased: 7 };
    expect(purchasedSeats({ eop: {}, read: fresh, source: 'graph', now: NOW }).stale).toBe(false);
  });

  it('falls back to the manual number until Graph answered once', () => {
    expect(purchasedSeats({ eop: { licenses: 2 }, read: null, source: 'graph', now: NOW })).toEqual({
      purchased: 2, mode: 'graph', source: 'manual', at: null, stale: false, notReconciled: true, error: null,
    });
  });
});

describe('parseHoldDays', () => {
  it('takes 0 to 3650 whole days', () => {
    expect(parseHoldDays('90')).toBe(90);
    expect(parseHoldDays(0)).toBe(0);
    expect(parseHoldDays(-1)).toBeNull();
    expect(parseHoldDays(3651)).toBeNull();
    expect(parseHoldDays('x')).toBeNull();
  });
});

describe('reserveSeat', () => {
  it('takes the seats lock before it counts', async () => {
    const calls = [];
    withTransaction.mockImplementation(async (fn) => fn({
      query: async (sql) => {
        calls.push(sql);
        if (sql.includes('AS used')) return { rows: [{ used: 0, held: 0 }] };
        if (sql.includes('generate_series')) return { rows: [{ n: 1 }] };
        if (sql.includes('INSERT INTO mail_node_seat_assignments')) return { rows: [{ id: '5' }] };
        return { rows: [] };
      },
    }));
    expect(await reserveSeat('a@example.com')).toEqual({ assignmentId: 5, seat: 1 });
    expect(calls[0]).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  });
});
