import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// R-42 on the real schema and the real queue with the fake tenant (fakes.js createFakeTenantModel):
// what the release job reads, which guards keep a message, that a message is released once and
// journaled with it, how a claim left behind is resolved, throttling, the attempt limit, the cap of
// a run, the pause switch and the routes.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
const journal = vi.hoisted(() => ({ entries: [] }));
vi.mock('../auditLog.js', () => ({
  recordAudit: vi.fn(async (entries) => { journal.entries.push(...[entries].flat()); }),
  insertAuditEntries: vi.fn(async (_tx, entries) => { journal.entries.push(...entries); }),
}));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: '60000000-0000-4000-8000-000000000001' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));

const { createRealSchemaDb } = await import('../testing/realSchema.js');
const { default: express } = await import('express');
const { default: routes } = await import('../../routes/mailNodeTenant.js');
const { claimDueJobs, runJob, getJob } = await import('../jobQueue.js');
const { saveEopSettings } = await import('../mailNode/eopSettings.js');
const { createFakeTenantDriver, setTenantDriver } = await import('./driver.js');
const { TenantError } = await import('./exoRunner.js');
const { TENANT_FIXTURES } = await import('./fakes.js');
const { getTenantState, registerTenantJobKinds } = await import('./tenantJobs.js');
const {
  MAX_MESSAGES_PER_RUN, MAX_RELEASE_ATTEMPTS, QUARANTINE_RELEASE_KIND, enqueueReleaseSlot, heldSummary, setReleaseEnabled,
} = await import('./quarantineRelease.js');
const { enqueueJob } = await import('../jobQueue.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';
const SETTINGS = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: TENANT_FIXTURES.worker.certificate.thumbprint,
};
const hex = (n, len) => n.toString(16).padStart(len, '0');
// A quarantine Identity, GUID1\GUID2, numbered.
const qid = (n) => [`c14401cf-aa9a-465b-cfd5-${hex(n, 12)}`, `4c2ca98e-94ea-db3a-7eb8-${hex(n, 12)}`].join('\\');
const FUTURE = '2099-01-01T00:00:00.000Z';

let db;
let server;
let base;
let driver;
let model;

async function runDue() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}
const runNow = async () => {
  await enqueueJob({ kind: QUARANTINE_RELEASE_KIND });
  await runDue();
};
const rowOf = async (identity) => (await db.query('SELECT * FROM tenant_quarantine_releases WHERE identity = $1', [identity])).rows[0];
const quarantine = (n, props = {}) => model.addQuarantined({
  Identity: qid(n), RecipientAddress: ['info@example.com'], MessageId: `<m${n}@phish.example.net>`, Expires: FUTURE, ...props,
});
const releases = () => journal.entries.filter((e) => e.action === 'tenant.quarantine_released');
const releaseCalls = () => driver.fake.exo.calls.filter((c) => c.op === 'release_quarantine_message');

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
  journal.entries = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await db.exec(`DELETE FROM jobs; DELETE FROM tenant_quarantine_releases; DELETE FROM mail_node_domains;
    DELETE FROM integration_config WHERE provider IN ('mail_node_eop', 'mail_node_tenant_state', 'mail_node_phish_release');`);
  await db.query("INSERT INTO mail_node_domains (domain, state) VALUES ('example.com', 'ready')");
  await saveEopSettings(SETTINGS);
  driver = createFakeTenantDriver();
  model = driver.fake.model;
  setTenantDriver(driver);
});

describe('the release job (R-42)', () => {
  it('releases inbound high confidence phishing to the node, journals it, and never twice', async () => {
    quarantine(1);
    await runNow();
    expect(model.released).toEqual([qid(1)]);
    const row = await rowOf(qid(1));
    expect(row).toMatchObject({ state: 'released', by_panel: true, attempts: 1, recipients: ['info@example.com'], message_id: '<m1@phish.example.net>' });
    expect(releases()).toEqual([expect.objectContaining({
      actorEmail: expect.any(String),
      details: expect.objectContaining({ identity: qid(1), recipients: ['info@example.com'], messageId: '<m1@phish.example.net>', sender: 'billing@phish.example.net' }),
    })]);
    // The order: read by Identity before the release.
    const ops = driver.fake.exo.calls.map((c) => c.op);
    expect(ops.indexOf('get_quarantine_message')).toBeLessThan(ops.indexOf('release_quarantine_message'));
    expect((await getTenantState()).phishRelease).toMatchObject({ ok: true, counts: { released: 1 }, left: false });

    // Another run: the released message is no longer listed and the row is final.
    await runNow();
    expect(model.released).toEqual([qid(1)]);
    expect(releases()).toHaveLength(1);
  });

  it('keeps a message with a recipient outside the node, says why, and raises it as held', async () => {
    quarantine(2, { RecipientAddress: ['info@example.com', 'ceo@other.example.org'] });
    await runNow();
    expect(model.released).toEqual([]);
    expect(await rowOf(qid(2))).toMatchObject({ state: 'skipped', reason: 'foreign_recipients' });
    expect(await heldSummary()).toEqual({ count: 1, soonestExpiresAt: FUTURE });
    // Final: not read again.
    driver.fake.exo.calls.length = 0;
    await runNow();
    expect(driver.fake.exo.calls.filter((c) => c.op === 'get_quarantine_message')).toEqual([]);
  });

  it('marks as released what someone released first, without a journal entry of the panel', async () => {
    quarantine(3);
    model.exo.get_quarantine_messages = () => [{ Identity: qid(3) }];
    model.quarantine.get(qid(3)).ReleaseStatus = 'RELEASED';
    await runNow();
    expect(releaseCalls()).toEqual([]);
    expect(await rowOf(qid(3))).toMatchObject({ state: 'released', by_panel: false });
    expect(releases()).toEqual([]);
  });

  it('resolves a claim left behind by reading the message back before anything is sent again', async () => {
    // A run stopped after the release went through: the read shows it released.
    quarantine(4);
    model.quarantine.get(qid(4)).ReleaseStatus = 'RELEASED';
    await db.query(`INSERT INTO tenant_quarantine_releases (identity, state, attempts, updated_at)
      VALUES ($1, 'releasing', 1, NOW() - interval '20 minutes')`, [qid(4)]);
    // A run stopped before: still not released, released now with a second attempt.
    quarantine(5);
    await db.query(`INSERT INTO tenant_quarantine_releases (identity, state, attempts, updated_at)
      VALUES ($1, 'releasing', 1, NOW() - interval '20 minutes')`, [qid(5)]);
    await runNow();
    expect(model.released).toEqual([qid(5)]);
    expect(await rowOf(qid(4))).toMatchObject({ state: 'released', by_panel: true, attempts: 1 });
    expect(await rowOf(qid(5))).toMatchObject({ state: 'released', by_panel: true, attempts: 2 });
    expect(releases().map((e) => e.details.identity).sort()).toEqual([qid(4), qid(5)].sort());
  });

  it('leaves a claim another run holds alone', async () => {
    quarantine(6);
    await db.query(`INSERT INTO tenant_quarantine_releases (identity, state, attempts) VALUES ($1, 'releasing', 1)`, [qid(6)]);
    await runNow();
    expect(model.released).toEqual([]);
    expect(await rowOf(qid(6))).toMatchObject({ state: 'releasing', attempts: 1 });
  });

  it('throttling keeps what the run did, gives the attempt back and queues the job again', async () => {
    quarantine(7);
    quarantine(8);
    let calls = 0;
    driver.fake.exo.answers.release_quarantine_message = (args) => {
      calls += 1;
      if (calls === 2) return new TenantError('exo_throttled', 'Micro delay applied', { retryAfterMs: 120000 });
      return model.exo.release_quarantine_message(args);
    };
    await runNow();
    expect(model.released).toHaveLength(1);
    const throttled = (await db.query("SELECT identity FROM tenant_quarantine_releases WHERE state = 'failed'")).rows;
    expect(throttled).toHaveLength(1);
    expect(await rowOf(throttled[0].identity)).toMatchObject({ attempts: 0 });
    const [job] = (await db.query('SELECT * FROM jobs WHERE kind = $1', [QUARANTINE_RELEASE_KIND])).rows;
    expect(job).toMatchObject({ status: 'queued', error_code: 'exo_throttled' });
    expect(Date.parse(job.run_at) - Date.now()).toBeGreaterThan(60000);
    expect((await getTenantState()).phishRelease.throttled).toMatchObject({ code: 'exo_throttled', retryAfterMs: 120000 });

    // The retry releases the other one.
    delete driver.fake.exo.answers.release_quarantine_message;
    await db.query('UPDATE jobs SET run_at = NOW()');
    await runDue();
    expect(model.released).toHaveLength(2);
  });

  it('a lost answer stays a claim; a refusal is tried again up to the limit, then held', async () => {
    quarantine(9);
    driver.fake.exo.answers.release_quarantine_message = new TenantError('worker_timeout', 'The tenant worker did not answer in time');
    await runNow();
    expect(await rowOf(qid(9))).toMatchObject({ state: 'releasing', attempts: 1 });
    expect(releases()).toEqual([]);

    driver.fake.exo.answers.release_quarantine_message = new TenantError('exo_failed', 'Something went wrong');
    await db.query("UPDATE tenant_quarantine_releases SET updated_at = NOW() - interval '20 minutes'");
    for (let i = 0; i < MAX_RELEASE_ATTEMPTS + 1; i += 1) await runNow();
    const row = await rowOf(qid(9));
    expect(row).toMatchObject({ state: 'failed', attempts: MAX_RELEASE_ATTEMPTS, reason: 'attempts_exhausted' });
    expect(releaseCalls()).toHaveLength(MAX_RELEASE_ATTEMPTS);
    expect((await heldSummary()).count).toBe(1);
  });

  it('a run handles at most its cap and queues a follow-up for the rest', async () => {
    for (let n = 100; n < 100 + MAX_MESSAGES_PER_RUN + 5; n += 1) quarantine(n);
    await enqueueJob({ kind: QUARANTINE_RELEASE_KIND });
    await runDue();
    expect(model.released).toHaveLength(MAX_MESSAGES_PER_RUN);
    expect((await getTenantState()).phishRelease.left).toBe(true);
    await db.query('UPDATE jobs SET run_at = NOW()');
    await runDue();
    expect(model.released).toHaveLength(MAX_MESSAGES_PER_RUN + 5);
  });

  it('pausing stops the releases and the slot timer', async () => {
    quarantine(10);
    await setReleaseEnabled(false, { userId: ADMIN });
    expect(await enqueueReleaseSlot()).toBeNull();
    await runNow();
    expect(model.released).toEqual([]);
    expect((await getTenantState()).phishRelease).toMatchObject({ paused: true });
    await setReleaseEnabled(true, { userId: ADMIN });
    const job = await enqueueReleaseSlot();
    expect(job.kind).toBe(QUARANTINE_RELEASE_KIND);
    // The same slot queues once; a run waiting makes the slot's unnecessary.
    expect(await enqueueReleaseSlot()).toBeNull();
    await runDue();
    expect(model.released).toEqual([qid(10)]);
  });

  it('without a domain of the node nothing is released', async () => {
    await db.query('DELETE FROM mail_node_domains');
    quarantine(11);
    await runNow();
    expect(model.released).toEqual([]);
    expect((await getTenantState()).phishRelease).toMatchObject({ noDomains: true });
  });
});

describe('the routes', () => {
  it('show the releases, pause and resume with a journal entry, and run now', async () => {
    quarantine(20);
    quarantine(21, { RecipientAddress: ['a@other.example.org'] });
    let res = await fetch(`${base}/tenant/phish-release/run`, { method: 'POST' });
    expect(res.status).toBe(202);
    const { job } = await res.json();
    await runDue();
    expect((await getJob(job.id)).status).toBe('done');
    const shown = await (await fetch(`${base}/tenant/phish-release`)).json();
    expect(shown).toMatchObject({ enabled: true, held: { count: 1 }, run: { ok: true, counts: { released: 1, skipped: 1 } } });
    expect(shown.releases.map((r) => [r.identity, r.state, r.reason])).toEqual(expect.arrayContaining([
      [qid(20), 'released', null], [qid(21), 'skipped', 'foreign_recipients'],
    ]));

    res = await fetch(`${base}/tenant/phish-release`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'no' }) });
    expect(res.status).toBe(400);
    res = await fetch(`${base}/tenant/phish-release`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(await res.json()).toMatchObject({ enabled: false });
    expect(journal.entries.filter((e) => e.action === 'tenant.phish_release_changed')).toEqual([
      expect.objectContaining({ actorUserId: ADMIN, details: { enabled: false } }),
    ]);
    expect((await fetch(`${base}/tenant/phish-release/run`, { method: 'POST' })).status).toBe(409);
  });
});
