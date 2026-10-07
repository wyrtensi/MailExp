import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The seats routes, the manual seat request, the hold setting and the Graph read on the real schema
// and queue, with the fake tenant driver made to look like a real one (kind 'worker'): purchased from
// subscribedSkus, a failed read keeps the last number, a request closes once purchased covers it, the
// hold change is journaled, and the purchased number never leaves the server.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}), insertAuditEntries: vi.fn(async () => {}) }));
const auth = vi.hoisted(() => ({ admin: true }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: '60000000-0000-4000-8000-000000000001' }; next(); },
  requireAdmin: (_req, res, next) => (auth.admin ? next() : res.status(403).json({ error: 'Admin access required' })),
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { default: express } = await import('express');
const { default: routes } = await import('./mailNodeSeats.js');
const { recordAudit } = await import('../services/auditLog.js');
const { claimDueJobs, runJob } = await import('../services/jobQueue.js');
const { saveEopSettings } = await import('../services/mailNode/eopSettings.js');
const { getSeatRead } = await import('../services/mailNode/eopSeats.js');
const { createFakeTenantDriver, setTenantDriver } = await import('../services/tenant/driver.js');
const { TENANT_FIXTURES } = await import('../services/tenant/fakes.js');
const { registerTenantJobKinds } = await import('../services/tenant/tenantJobs.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';
const TENANT = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: TENANT_FIXTURES.worker.certificate.thumbprint,
};
let db;
let server;
let base;
let driver;

async function runDue() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}
const get = async () => (await fetch(`${base}/seats`)).json();
const send = (method, path, body) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const graphMode = () => {
  driver = createFakeTenantDriver();
  driver.kind = 'worker';
  setTenantDriver(driver);
};

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, is_admin) VALUES ($1, 'admin', 'admin@example.com', true)", [ADMIN]);
  registerTenantJobKinds();
  const app = express();
  app.use(express.json());
  app.use('/api/mail-node', routes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/mail-node`;
}, 120000);
afterAll(async () => {
  setTenantDriver(undefined);
  await new Promise((resolve) => server?.close(resolve));
  await db.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  auth.admin = true;
  setTenantDriver(null);
  await db.exec('DELETE FROM jobs; DELETE FROM mail_node_seat_assignments; DELETE FROM mail_node_seat_requests; DELETE FROM integration_config;');
});

describe('GET /seats', () => {
  it('answers used, held and free with the held seats, without the purchased number, to any signed-in user', async () => {
    auth.admin = false;
    await saveEopSettings({ licenses: 4 });
    await db.query(`INSERT INTO mail_node_seat_assignments (seat_no, email) VALUES (1, 'a@example.com')`);
    await db.query(`INSERT INTO mail_node_seat_assignments (seat_no, account_id, email, released_at, release_reason, free_from)
      VALUES (2, '80000000-0000-4000-8000-00000000000b', 'b@example.com', NOW(), 'deactivated', NOW() + interval '90 days')`);
    const seats = await get();
    expect(seats).toMatchObject({ used: 1, held: 1, free: 2, known: true, mode: 'manual', source: 'manual', over: false, holdDays: 90, requests: [] });
    expect(seats.heldSeats).toEqual([expect.objectContaining({ seat: 2, accountId: '80000000-0000-4000-8000-00000000000b', email: 'b@example.com', reason: 'deactivated' })]);
    expect(seats).not.toHaveProperty('purchased');
  });
});

describe('PUT /seats/settings', () => {
  it('changes the hold for administrators, journals old and new, re-dates the held seats', async () => {
    await saveEopSettings({ licenses: 4 });
    await db.query(`INSERT INTO mail_node_seat_assignments (seat_no, email, released_at, release_reason, free_from)
      VALUES (1, 'b@example.com', NOW(), 'deactivated', NOW() + interval '90 days')`);
    const res = await send('PUT', '/seats/settings', { holdDays: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ holdDays: 0 });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mail_node.seat_hold_changed', details: { from: 90, to: 0 } }));
    expect(await get()).toMatchObject({ held: 0, free: 4, holdDays: 0 });
    expect((await send('PUT', '/seats/settings', { holdDays: -1 })).status).toBe(400);
    auth.admin = false;
    expect((await send('PUT', '/seats/settings', { holdDays: 30 })).status).toBe(403);
  });
});

describe('POST /seats/requests (manual provider)', () => {
  it('records the request, journals it and closes it once purchased grows by N', async () => {
    auth.admin = false;
    await saveEopSettings({ licenses: 4 });
    const res = await send('POST', '/seats/requests', { seats: 2 });
    expect(res.status).toBe(200);
    expect((await res.json()).request).toMatchObject({ seats: 2 });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'mail_node.seats_requested', actorUserId: ADMIN, details: { seats: 2, provider: 'manual', purchased: 4 },
    }));
    expect((await get()).requests).toEqual([expect.objectContaining({ seats: 2, requestedBy: 'admin@example.com' })]);
    expect((await send('POST', '/seats/requests', { seats: 0 })).status).toBe(400);
    expect((await send('POST', '/seats/requests', { seats: 1001 })).status).toBe(400);
  });
});

describe('the Graph read', () => {
  it('"Reconcile" reads subscribedSkus and closes the requests it covers', async () => {
    graphMode();
    await saveEopSettings(TENANT);
    await db.query("INSERT INTO mail_node_seat_requests (provider, seats, purchased_at_request) VALUES ('manual', 2, 8)");
    expect((await send('POST', '/seats/check')).status).toBe(202);
    await runDue();
    expect(await getSeatRead()).toMatchObject({ ok: true, purchased: 10, found: true });
    expect(await get()).toMatchObject({ free: 10, mode: 'graph', source: 'graph', stale: false, requests: [] });
  });

  it('tells a tenant without an EOP_ENTERPRISE subscription from one with no free seat', async () => {
    graphMode();
    await saveEopSettings(TENANT);
    driver.fake.model.subscribedSkus = { value: [] };
    await send('POST', '/seats/check');
    await runDue();
    expect(await get()).toMatchObject({ free: 0, source: 'graph', subscriptionMissing: true });
    driver.fake.model.subscribedSkus = structuredClone(TENANT_FIXTURES.graph.subscribedSkus);
    await send('POST', '/seats/check');
    await runDue();
    expect(await get()).toMatchObject({ free: 10, subscriptionMissing: false });
  });

  it('keeps the last number with the error beside it when Graph refuses', async () => {
    graphMode();
    await saveEopSettings(TENANT);
    await send('POST', '/seats/check');
    await runDue();
    driver.fake.model.subscribedSkus = null;
    await send('POST', '/seats/check');
    await runDue();
    expect(await getSeatRead()).toMatchObject({ ok: false, purchased: 10, error: { code: 'graph_failed' } });
    expect(await get()).toMatchObject({ free: 10, source: 'graph', error: { code: 'graph_failed' } });
  });

  it('remembers when Graph first failed while it never answered, and forgets it after a good read', async () => {
    graphMode();
    await saveEopSettings({ ...TENANT, licenses: 2 });
    driver.fake.model.subscribedSkus = null;
    await send('POST', '/seats/check');
    await runDue();
    const first = (await getSeatRead()).firstErrorAt;
    expect(first).toEqual(expect.any(String));
    await db.exec('DELETE FROM jobs');
    await send('POST', '/seats/check');
    await runDue();
    expect((await getSeatRead()).firstErrorAt).toBe(first);
    expect(await get()).toMatchObject({ notReconciled: true, stale: false });
    driver.fake.model.subscribedSkus = structuredClone(TENANT_FIXTURES.graph.subscribedSkus);
    driver.fake.model.subscribedSkus.value[0].prepaidUnits = { enabled: 4, warning: 2, suspended: 0, lockedOut: 0 };
    await db.exec('DELETE FROM jobs');
    await send('POST', '/seats/check');
    await runDue();
    expect(await getSeatRead()).toMatchObject({ ok: true, purchased: 6, warning: 2 });
    expect((await getSeatRead()).firstErrorAt).toBeUndefined();
    expect(await get()).toMatchObject({ free: 6 });
  });

  it('a seat request asks Graph again', async () => {
    graphMode();
    await saveEopSettings(TENANT);
    await send('POST', '/seats/requests', { seats: 1 });
    await runDue();
    expect(await getSeatRead()).toMatchObject({ purchased: 10 });
  });

  it('"Reconcile" is refused in manual mode and to anyone but administrators', async () => {
    expect((await send('POST', '/seats/check')).status).toBe(409);
    auth.admin = false;
    expect((await send('POST', '/seats/check')).status).toBe(403);
  });
});
