import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The tenant jobs on the real schema and the real queue (services/jobQueue.js), with the fake
// tenant driver: "Test connection" step by step, the poll of R-27 and its dedupe by slot, the
// anti-spam read of R-28, the routes that queue them, and that no secret reaches the state.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
const auth = vi.hoisted(() => ({ admin: true }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: '60000000-0000-4000-8000-000000000001' }; next(); },
  requireAdmin: (_req, res, next) => (auth.admin ? next() : res.status(403).json({ error: 'Admin only' })),
}));

const { createRealSchemaDb } = await import('../testing/realSchema.js');
const { default: express } = await import('express');
const { default: routes } = await import('../../routes/mailNodeTenant.js');
const { recordAudit } = await import('../auditLog.js');
const { claimDueJobs, runJob, getJob } = await import('../jobQueue.js');
const { saveEopSettings } = await import('../mailNode/eopSettings.js');
const { createFakeTenantDriver, setTenantDriver } = await import('./driver.js');
const { TenantError } = await import('./exoRunner.js');
const { TENANT_FIXTURES } = await import('./fakes.js');
const {
  TENANT_JOB_KINDS, enqueuePoll, enqueueTenantJob, getTenantState, registerTenantJobKinds, POLL_INTERVAL_MS,
} = await import('./tenantJobs.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';
const SETTINGS = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: TENANT_FIXTURES.worker.certificate.thumbprint,
};

let db;
let server;
let base;
let driver;

// Runs every due job of the queue now, as the worker would.
async function runDue() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
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
  vi.mocked(recordAudit).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  auth.admin = true;
  await db.exec("DELETE FROM jobs; DELETE FROM integration_config WHERE provider IN ('mail_node_eop', 'mail_node_tenant_state', 'mail_node_spam_rule');");
  await saveEopSettings(SETTINGS);
  driver = createFakeTenantDriver();
  setTenantDriver(driver);
});

const post = (path) => fetch(`${base}${path}`, { method: 'POST' });
const get = (path) => fetch(`${base}${path}`).then((r) => r.json());

describe('Test connection', () => {
  it('queues a job, runs every step through the fakes and keeps the result', async () => {
    const res = await post('/tenant/test');
    expect(res.status).toBe(202);
    const { job, created } = await res.json();
    expect(created).toBe(true);
    // A second click while it waits answers the same job.
    expect((await (await post('/tenant/test')).json()).job.id).toBe(job.id);
    await runDue();

    expect((await get(`/tenant/jobs/${job.id}`)).job.status).toBe('done');
    const { state, jobs, driver: kind, configured, spamRule } = await get('/tenant');
    expect(kind).toBe('fake');
    // No run has read the node's spam rule yet (section 5.14).
    expect(spamRule).toBeNull();
    expect(configured).toBe(true);
    expect(jobs.test).toMatchObject({ id: job.id, status: 'done' });
    expect(state.connection.ok).toBe(true);
    expect(state.connection.by).toBe(ADMIN);
    expect(state.connection.steps).toEqual({
      certificate: { ok: true, notAfter: '2027-09-01T00:00:00.000Z' },
      graph: { ok: true, domains: 1, initialDomain: 'contoso.onmicrosoft.com' },
      exo: { ok: true, organization: 'contoso.onmicrosoft.com', displayName: 'Contoso' },
    });
    expect(state.certificate).toMatchObject({ thumbprint: SETTINGS.certThumbprint, notAfter: '2027-09-01T00:00:00.000Z' });
    // The anti-spam policy is read with a working connection.
    expect(state.antispam.ok).toBe(true);
    expect(state.antispam.conflicts.map((c) => c.field)).toEqual(['PhishSpamAction']);
    expect(driver.fake.exo.calls.map((c) => c.op)).toEqual(['whoami', 'get_content_filter_policy']);
    expect(driver.fake.graph.requests.map((r) => r.kind)).toEqual(['token', 'graph']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: ADMIN, action: 'tenant.connection_tested', details: { ok: true, failed: [] },
    }));
  });

  it('answers the spam rule of the node as last read, for the policy and the release alike', async () => {
    await db.query("INSERT INTO integration_config (provider, config) VALUES ('mail_node_spam_rule', $1)", [{ at: '2026-10-05T08:00:00.000Z', state: 'missing' }]);
    expect((await get('/tenant')).spamRule).toEqual({ at: '2026-10-05T08:00:00.000Z', state: 'missing' });
  });

  it('a thumbprint that is not the worker\'s stops at the first step', async () => {
    await saveEopSettings({ certThumbprint: 'B'.repeat(40) });
    await post('/tenant/test');
    await runDue();
    const { state } = await get('/tenant');
    expect(state.connection.ok).toBe(false);
    expect(state.connection.steps.certificate).toMatchObject({ ok: false, code: 'certificate_mismatch', workerThumbprint: SETTINGS.certThumbprint });
    expect(state.connection.steps.graph).toBeUndefined();
    expect(driver.fake.exo.calls).toEqual([]);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { ok: false, failed: ['certificate:certificate_mismatch'] } }));
  });

  it('another tenant\'s initial domain, an EXO failure and a refused token are told apart', async () => {
    await saveEopSettings({ tenantDomain: 'fabrikam.onmicrosoft.com' });
    driver.fake.exo.answers.whoami = new TenantError('exo_connect_failed', 'AADSTS700016: Application not found');
    await post('/tenant/test');
    await runDue();
    let { state } = await get('/tenant');
    expect(state.connection.steps.graph).toMatchObject({ ok: false, code: 'tenant_domain_mismatch', initialDomain: 'contoso.onmicrosoft.com' });
    expect(state.connection.steps.exo).toMatchObject({ ok: false, code: 'exo_connect_failed' });

    setTenantDriver(createFakeTenantDriver({ token: () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }) }));
    await post('/tenant/test');
    await runDue();
    ({ state } = await get('/tenant'));
    expect(state.connection.steps.graph).toMatchObject({ ok: false, code: 'graph_token_failed' });
  });

  it('refuses without a driver or without the four settings', async () => {
    setTenantDriver(null);
    let res = await post('/tenant/test');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('tenant_driver_missing');
    expect((await get('/tenant')).driver).toBeNull();
    setTenantDriver(driver);
    await saveEopSettings({ tenantDomain: null });
    res = await post('/tenant/test');
    expect((await res.json()).code).toBe('tenant_not_configured');
  });

  it('a job queued before the driver went away fails at once', async () => {
    const { job } = await enqueueTenantJob(TENANT_JOB_KINDS.test, { userId: ADMIN });
    setTenantDriver(null);
    await runDue();
    expect(await getJob(job.id)).toMatchObject({ status: 'failed', error_code: 'tenant_driver_missing' });
  });

  it('is for administrators only', async () => {
    auth.admin = false;
    expect((await post('/tenant/test')).status).toBe(403);
    expect((await fetch(`${base}/tenant`)).status).toBe(403);
  });

  it('a job id that is not a tenant job is not found', async () => {
    expect((await fetch(`${base}/tenant/jobs/abc`)).status).toBe(404);
    const { rows: [other] } = await db.query("INSERT INTO jobs (kind) VALUES ('send_message') RETURNING id");
    expect((await fetch(`${base}/tenant/jobs/${other.id}`)).status).toBe(404);
  });
});

describe('the poll (R-27)', () => {
  it('is queued once per slot, not next to another poll, and not without a tenant', async () => {
    const now = Date.now();
    const first = await enqueuePoll(now);
    expect(first.kind).toBe('tenant_poll');
    // Queued already: neither the same slot nor the next queues another.
    expect(await enqueuePoll(now + 60000)).toBeNull();
    expect(await enqueuePoll(now + POLL_INTERVAL_MS)).toBeNull();
    await runDue();
    // Just ended ("Check now" a minute ago counts the same): the slot is skipped.
    expect(await enqueuePoll(now + 60000)).toBeNull();
    // Half an interval later the next slot runs.
    const next = await enqueuePoll(now + POLL_INTERVAL_MS);
    expect(next.id).not.toBe(first.id);
    await db.exec('DELETE FROM jobs');
    await saveEopSettings({ appId: null });
    expect(await enqueuePoll(now)).toBeNull();
    setTenantDriver(null);
    expect(await enqueuePoll(now)).toBeNull();
  });

  it('keeps the blocked connectors and the certificate', async () => {
    driver.fake.exo.answers.get_blocked_connector = TENANT_FIXTURES.exo['get_blocked_connector.blocked'];
    await post('/tenant/poll');
    await runDue();
    const { state } = await get('/tenant');
    expect(state.blockedConnectors.ok).toBe(true);
    expect(state.blockedConnectors.items).toEqual([{
      connectorId: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a', connectorName: 'From mail node',
      reason: 'Suspicious connector activity', createdTime: '2026-10-03T08:15:00.0000000Z',
    }]);
    expect(state.certificate.notAfter).toBe('2027-09-01T00:00:00.000Z');
    // The first poll reads the anti-spam policy too; the next within six hours does not.
    expect(state.antispam.ok).toBe(true);
    driver.fake.exo.calls.length = 0;
    await post('/tenant/poll');
    await runDue();
    expect(driver.fake.exo.calls.map((c) => c.op)).toEqual(['get_blocked_connector', 'get_inbound_connectors', 'get_outbound_connectors']);
  });

  it('a failed read keeps the last list with the error beside it', async () => {
    driver.fake.exo.answers.get_blocked_connector = TENANT_FIXTURES.exo['get_blocked_connector.blocked'];
    await post('/tenant/poll');
    await runDue();
    driver.fake.exo.answers.get_blocked_connector = new TenantError('worker_unreachable', 'The tenant worker is unreachable');
    driver.fake.exo.certificateInfo = new TenantError('worker_unreachable', 'The tenant worker is unreachable');
    await post('/tenant/poll');
    await runDue();
    await post('/tenant/poll');
    await runDue();
    const state = await getTenantState();
    expect(state.blockedConnectors).toMatchObject({ ok: false, error: { code: 'worker_unreachable' }, failures: 2 });
    expect(state.blockedConnectors.items).toHaveLength(1);
    expect(state.certificate).toMatchObject({ notAfter: '2027-09-01T00:00:00.000Z', error: { code: 'worker_unreachable' } });
  });
});

describe('answers that are not arrays (one item unrolled, nothing)', () => {
  it('one object, an empty object and nothing read right', async () => {
    const [one] = TENANT_FIXTURES.exo['get_blocked_connector.blocked'];
    driver.fake.exo.answers.get_blocked_connector = one;
    driver.fake.exo.answers.whoami = TENANT_FIXTURES.exo.whoami[0];
    driver.fake.exo.answers.get_content_filter_policy = { ...TENANT_FIXTURES.exo.get_content_filter_policy[0], RedirectToRecipients: 'spam@example.com' };
    await post('/tenant/poll');
    await runDue();
    await post('/tenant/test');
    await runDue();
    let state = await getTenantState();
    expect(state.blockedConnectors.items.map((c) => c.connectorId)).toEqual([one.ConnectorId]);
    expect(state.connection.steps.exo).toMatchObject({ ok: true, displayName: 'Contoso' });
    expect(state.antispam.policy.RedirectToRecipients).toEqual(['spam@example.com']);
    // What the runner before the fix sent for none: [{}] or null. Neither is a connector.
    for (const answer of [[{}], null, {}]) {
      driver.fake.exo.answers.get_blocked_connector = answer;
      await post('/tenant/poll');
      await runDue();
      state = await getTenantState();
      expect(state.blockedConnectors.items).toEqual([]);
    }
  });
});

describe('the anti-spam policy (R-28, section 5.14)', () => {
  const model = () => driver.fake.model;
  const ops = () => driver.fake.exo.calls.map((c) => c.op);
  const enforcedAudits = () => vi.mocked(recordAudit).mock.calls.map(([entry]) => entry).filter((e) => e.action === 'tenant.antispam_enforced');

  it('sets what differs to MoveToJmf, reads again, journals it, and does nothing the second time', async () => {
    Object.assign(model().policy, { SpamAction: 'Quarantine', PhishSpamAction: 'MoveToJmf' });
    expect((await post('/tenant/antispam')).status).toBe(202);
    await runDue();
    const { state, jobs } = await get('/tenant');
    expect(jobs.antispam.status).toBe('done');
    expect(ops()).toEqual(['get_content_filter_policy', 'set_spam_action_junk', 'get_content_filter_policy']);
    expect(model().policyWrites).toEqual(['SpamAction']);
    expect(state.antispam.policy).toMatchObject({ identity: 'Default', SpamAction: 'MoveToJmf', HighConfidencePhishAction: 'Quarantine' });
    expect(state.antispam.conflicts).toEqual([]);
    expect(state.antispam.enforcement).toMatchObject({ ok: true, changed: [{ field: 'SpamAction', from: 'Quarantine', to: 'MoveToJmf' }], failed: [] });
    expect(enforcedAudits()).toEqual([expect.objectContaining({
      actorUserId: ADMIN, details: { changed: [{ field: 'SpamAction', from: 'Quarantine', to: 'MoveToJmf' }] },
    })]);

    driver.fake.exo.calls.length = 0;
    await post('/tenant/antispam');
    await runDue();
    expect(ops()).toEqual(['get_content_filter_policy']);
    expect((await getTenantState()).antispam.enforcement).toMatchObject({ ok: true, changed: [] });
    expect(enforcedAudits()).toHaveLength(1);
  });

  it('every enforced field at once, bulk included (D-11); high confidence phishing is never written', async () => {
    Object.assign(model().policy, {
      SpamAction: 'Quarantine', HighConfidenceSpamAction: 'Redirect', PhishSpamAction: 'Quarantine', BulkSpamAction: 'Quarantine',
    });
    await post('/tenant/antispam');
    await runDue();
    expect(model().policyWrites).toEqual(['SpamAction', 'HighConfidenceSpamAction', 'PhishSpamAction', 'BulkSpamAction']);
    const { antispam } = await getTenantState();
    expect(antispam.policy).toMatchObject({
      SpamAction: 'MoveToJmf', HighConfidenceSpamAction: 'MoveToJmf', PhishSpamAction: 'MoveToJmf',
      BulkSpamAction: 'MoveToJmf', HighConfidencePhishAction: 'Quarantine',
    });
    expect(antispam.conflicts).toEqual([]);
  });

  it('two runs at once write and journal one change once (M3)', async () => {
    const { syncAntispam } = await import('./tenantJobs.js');
    const session = driver.forTenant({ tenantId: SETTINGS.tenantId, appId: SETTINGS.appId, organization: SETTINGS.tenantDomain, thumbprint: SETTINGS.certThumbprint });
    const [a, b] = await Promise.all([syncAntispam(session), syncAntispam(session)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(model().policyWrites).toEqual(['PhishSpamAction']);
    expect(enforcedAudits()).toHaveLength(1);
    // Freed afterwards: the next run reads and finds nothing to change.
    expect((await syncAntispam(session)).enforcement).toMatchObject({ ok: true, changed: [] });
  });

  it('a re-read that fails after the writes leaves the state unconfirmed (M7)', async () => {
    let reads = 0;
    driver.fake.exo.answers.get_content_filter_policy = () => {
      reads += 1;
      return reads === 1 ? [model().policy] : new TenantError('worker_timeout', 'The tenant worker did not answer in time');
    };
    await post('/tenant/antispam');
    await runDue();
    expect((await getTenantState()).antispam.enforcement).toMatchObject({
      ok: false, unconfirmed: true, failed: ['PhishSpamAction'], error: { code: 'worker_timeout' },
    });
  });

  it('a worker image without the operation says so (unknown_op)', async () => {
    driver.fake.exo.answers.set_phish_spam_action_junk = new TenantError('unknown_op', 'Unknown operation', { status: 404 });
    await post('/tenant/antispam');
    await runDue();
    expect((await getTenantState()).antispam.enforcement).toMatchObject({ ok: false, error: { code: 'unknown_op' } });
  });

  it('a write the tenant did not apply is reported, not journaled as done', async () => {
    model().options.policyWritesIgnored = true;
    await post('/tenant/antispam');
    await runDue();
    const { antispam } = await getTenantState();
    expect(model().policyWrites).toEqual(['PhishSpamAction']);
    expect(antispam.enforcement).toMatchObject({
      ok: false, changed: [], failed: ['PhishSpamAction'], error: { code: 'antispam_not_written' },
    });
    expect(antispam.conflicts.map((c) => c.field)).toEqual(['PhishSpamAction']);
    expect(enforcedAudits()).toEqual([]);
  });

  it('a refused write keeps the code; what went through before it is kept and journaled', async () => {
    Object.assign(model().policy, { SpamAction: 'Quarantine', PhishSpamAction: 'Quarantine' });
    driver.fake.exo.answers.set_phish_spam_action_junk = new TenantError('exo_failed', 'Access denied');
    await post('/tenant/antispam');
    await runDue();
    const { antispam } = await getTenantState();
    expect(antispam.enforcement).toMatchObject({
      ok: false, changed: [{ field: 'SpamAction', from: 'Quarantine', to: 'MoveToJmf' }], failed: ['PhishSpamAction'], error: { code: 'exo_failed' },
    });
    expect(enforcedAudits()).toHaveLength(1);
  });

  it('the connection test only reads; the next poll enforces what it found', async () => {
    await post('/tenant/test');
    await runDue();
    expect(ops()).toEqual(['whoami', 'get_content_filter_policy']);
    expect((await getTenantState()).antispam.enforcement).toBeUndefined();
    driver.fake.exo.calls.length = 0;
    await post('/tenant/poll');
    await runDue();
    expect(ops()).toEqual(expect.arrayContaining(['get_content_filter_policy', 'set_phish_spam_action_junk']));
    expect((await getTenantState()).antispam).toMatchObject({ enforcement: { ok: true }, conflicts: [] });
    expect(enforcedAudits()).toEqual([expect.objectContaining({ actorEmail: expect.any(String) })]);
  });
});

describe('secrets (R-35)', () => {
  it('the stored state holds no token or assertion', async () => {
    await post('/tenant/test');
    await runDue();
    const { rows } = await db.query("SELECT config::text AS text FROM integration_config WHERE provider = 'mail_node_tenant_state'");
    expect(rows[0].text).not.toContain('fake-graph-access-token');
    expect(rows[0].text).not.toContain('fake.');
    const { rows: jobRows } = await db.query('SELECT payload::text AS text FROM jobs');
    for (const row of jobRows) expect(row.text).toBe('{}');
  });
});
