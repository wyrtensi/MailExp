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
// The node's spam rule (section 5.14): this version unless a test says otherwise.
const spamRule = vi.hoisted(() => ({ state: 'ok' }));
vi.mock('../mailNode/nodeApply.js', async (importActual) => ({
  ...(await importActual()),
  checkSpamRule: vi.fn(async () => {
    if (spamRule.throws) throw spamRule.throws;
    return { at: new Date().toISOString(), state: spamRule.state };
  }),
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
  MAX_MESSAGES_PER_RUN, MAX_RELEASE_ATTEMPTS, QUARANTINE_RELEASE_KIND, RUN_LOCK_PROVIDER, enqueueReleaseSlot, getReleaseSettings,
  KEPT_FAILED_RELEASE_JOBS, handleReleaseJob, heldSummary, markReleased, runRelease, setReleaseEnabled,
} = await import('./quarantineRelease.js');
const { tenantContext } = await import('./tenantJobs.js');
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
    DELETE FROM integration_config WHERE provider IN ('mail_node_eop', 'mail_node_tenant_state', 'mail_node_phish_release', 'mail_node_phish_release_run');`);
  await db.query("INSERT INTO mail_node_domains (domain, state) VALUES ('example.com', 'ready')");
  await saveEopSettings(SETTINGS);
  driver = createFakeTenantDriver();
  model = driver.fake.model;
  setTenantDriver(driver);
  // On by default (section 5.14): no switch row at the start of a test.
  journal.entries = [];
  spamRule.state = 'ok';
  spamRule.throws = null;
  await db.query("DELETE FROM integration_config WHERE provider = 'mail_node_phish_release_cursor'");
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

  it('releases phishing, spam and high confidence spam the same way, and keeps malware (section 5.14)', async () => {
    quarantine(70, { QuarantineTypes: 'Phish', Type: 'Phish' });
    quarantine(71, { QuarantineTypes: 'Spam', Type: 'Spam' });
    quarantine(72, { QuarantineTypes: 'Spam', Type: 'High Confidence Spam' });
    quarantine(73, { QuarantineTypes: 'Malware', Type: 'Malware' });
    await runNow();
    expect(model.released.sort()).toEqual([qid(70), qid(71), qid(72)].sort());
    expect(await rowOf(qid(70))).toMatchObject({ state: 'released', by_panel: true, quarantine_type: 'Phish' });
    expect(await rowOf(qid(71))).toMatchObject({ state: 'released', quarantine_type: 'Spam' });
    expect(await rowOf(qid(72))).toMatchObject({ state: 'released', quarantine_type: 'HighConfSpam' });
    // The worker never lists malware; it is not even read.
    expect(await rowOf(qid(73))).toBeUndefined();
    expect(releases().map((e) => e.details.type).sort()).toEqual(['HighConfSpam', 'Phish', 'Spam']);
    const shown = await (await fetch(`${base}/tenant/phish-release`)).json();
    expect(shown.releases.find((r) => r.identity === qid(72))).toMatchObject({ type: 'HighConfSpam', state: 'released' });
  });

  it('holds spam, phishing and bulk while the node keeps an older spam rule; high confidence phishing goes (section 5.14)', async () => {
    spamRule.state = 'outdated';
    quarantine(80, { QuarantineTypes: 'Spam', Type: 'Spam' });
    quarantine(81, { QuarantineTypes: 'Bulk', Type: 'Bulk' });
    quarantine(82);
    await runNow();
    expect(model.released).toEqual([qid(82)]);
    // Not read, not stored: nothing final about them.
    expect(await rowOf(qid(80))).toBeUndefined();
    expect(await rowOf(qid(81))).toBeUndefined();
    expect((await getTenantState()).phishRelease).toMatchObject({ rule: { state: 'outdated' }, counts: { ruleWaiting: 2, released: 1 } });
    // A row left behind (a failed attempt) is read and waits too.
    quarantine(83, { QuarantineTypes: 'Phish', Type: 'Phish' });
    await db.query("INSERT INTO tenant_quarantine_releases (identity, state, attempts) VALUES ($1, 'failed', 1)", [qid(83)]);
    await runNow();
    expect(model.released).toEqual([qid(82)]);
    expect(await rowOf(qid(83))).toMatchObject({ state: 'failed', attempts: 1 });
    // The rule written: they go.
    spamRule.state = 'ok';
    await runNow();
    expect(model.released.sort()).toEqual([qid(80), qid(81), qid(82), qid(83)].sort());
  });

  it('a Type spelling the panel does not know neither blocks a known QuarantineTypes nor ends a message (I1)', async () => {
    quarantine(84, { QuarantineTypes: 'HighConfPhish', Type: 'High Confidence Phishing' });
    quarantine(85, { QuarantineTypes: 'Phish', Type: 'Phishing' });
    quarantine(86, { QuarantineTypes: 'Phish', Type: 'Something new' });
    await runNow();
    expect(model.released.sort()).toEqual([qid(84), qid(85), qid(86)].sort());
    // An unknown QuarantineTypes value waits (no row), and a known forbidden word in Type is final.
    quarantine(87, { QuarantineTypes: 'NewKind', Type: 'Phish' });
    quarantine(88, { QuarantineTypes: 'Phish', Type: 'Phish, Malware' });
    model.exo.get_quarantine_messages = () => [{ Identity: qid(87) }, { Identity: qid(88) }];
    await runNow();
    expect(await rowOf(qid(87))).toBeUndefined();
    expect((await getTenantState()).phishRelease.counts).toMatchObject({ waiting: 1 });
    expect(await rowOf(qid(88))).toMatchObject({ state: 'skipped', reason: 'type_not_allowed' });
  });

  it('reaches mail behind 500 kept messages: the window walks the pages over runs (I2)', async () => {
    // 520 messages kept for good (a recipient off the node), then one to release.
    for (let n = 1000; n < 1520; n += 1) {
      quarantine(n, { RecipientAddress: ['x@other.example.org'] });
      await db.query("INSERT INTO tenant_quarantine_releases (identity, state, reason) VALUES ($1, 'skipped', 'foreign_recipients')", [qid(n)]);
    }
    quarantine(1520);
    let runs = 0;
    while (!model.released.includes(qid(1520)) && runs < 4) {
      await runNow();
      runs += 1;
    }
    expect(model.released).toEqual([qid(1520)]);
    expect(runs).toBe(2);
    // The next walk starts over from the second page.
    const { rows: [cursor] } = await db.query("SELECT config FROM integration_config WHERE provider = 'mail_node_phish_release_cursor'");
    expect(cursor.config.page).toBe(2);
  });

  it('keeps malware or a mixed type that reaches it all the same, with the reason', async () => {
    quarantine(74, { QuarantineTypes: 'Malware', Type: 'Malware' });
    quarantine(75, { QuarantineTypes: ['Phish', 'Malware'], Type: 'Phish' });
    model.exo.get_quarantine_messages = () => [{ Identity: qid(74) }, { Identity: qid(75) }];
    await runNow();
    expect(model.released).toEqual([]);
    expect(releaseCalls()).toEqual([]);
    expect(await rowOf(qid(74))).toMatchObject({ state: 'skipped', reason: 'type_not_allowed', quarantine_type: 'Malware' });
    expect(await rowOf(qid(75))).toMatchObject({ state: 'skipped', reason: 'type_not_allowed' });
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

describe('the review round (R-42)', () => {
  const runDirect = async (options = {}) => runRelease(await tenantContext(), options);

  it('is on by default (section 5.14); turning it off and on again is journaled and kept', async () => {
    expect((await getReleaseSettings()).enabled).toBe(true);
    expect(await enqueueReleaseSlot(Date.now())).not.toBeNull();
    await db.exec('DELETE FROM jobs');
    await setReleaseEnabled(false, { userId: ADMIN });
    expect((await getReleaseSettings()).enabled).toBe(false);
    expect(await enqueueReleaseSlot(Date.now())).toBeNull();
    quarantine(30);
    await runNow();
    expect(model.released).toEqual([]);
    expect((await getTenantState()).phishRelease).toMatchObject({ paused: true });
    await setReleaseEnabled(true, { userId: ADMIN });
    expect(journal.entries.filter((e) => e.action === 'tenant.phish_release_changed').map((e) => e.details)).toEqual([
      { enabled: false }, { enabled: true },
    ]);
  });

  it('failed reads cost attempts: the queue moves on, later messages are reached, and the follow-ups stop', async () => {
    for (let n = 200; n < 200 + MAX_MESSAGES_PER_RUN + 5; n += 1) quarantine(n);
    driver.fake.exo.answers.get_quarantine_message = new TenantError('exo_failed', 'Something went wrong');
    let runs = 0;
    for (; runs < 30; runs += 1) {
      const { rows } = await db.query("SELECT id FROM jobs WHERE kind = $1 AND status = 'queued'", [QUARANTINE_RELEASE_KIND]);
      if (runs > 0 && !rows.length) break;
      if (!rows.length) await enqueueJob({ kind: QUARANTINE_RELEASE_KIND });
      await db.query('UPDATE jobs SET run_at = NOW()');
      await runDue();
    }
    expect(runs).toBeLessThan(30);
    const { rows } = await db.query('SELECT state, reason, attempts FROM tenant_quarantine_releases');
    expect(rows).toHaveLength(MAX_MESSAGES_PER_RUN + 5);
    expect(rows.every((r) => r.state === 'failed' && r.reason === 'attempts_exhausted' && r.attempts === MAX_RELEASE_ATTEMPTS)).toBe(true);
    expect(model.released).toEqual([]);
  });

  it('a pause in the middle of a pass stops the releases before the next claim', async () => {
    quarantine(40);
    quarantine(41);
    quarantine(42);
    driver.fake.exo.answers.release_quarantine_message = async (args) => {
      const answer = model.exo.release_quarantine_message(args);
      await setReleaseEnabled(false, { userId: ADMIN });
      return answer;
    };
    const result = await runDirect({ releaseCheckMs: 0 });
    expect(model.released).toHaveLength(1);
    expect(result).toMatchObject({ paused: true, left: false, counts: { released: 1 } });
  });

  it('marks a release once: a second run reaching it journals nothing', async () => {
    const f = { messageId: '<m@x>', sender: 's@x', subject: null, recipients: ['info@example.com'], receivedAt: null, expiresAt: null };
    const [a, b] = await Promise.all([markReleased(qid(50), f, { byPanel: true, now: Date.now() }), markReleased(qid(50), f, { byPanel: true, now: Date.now() })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(releases()).toHaveLength(1);
    expect(await markReleased(qid(50), f, { byPanel: true, now: Date.now() })).toBe(false);
    expect(releases()).toHaveLength(1);
  });

  it('one run at a time: a second job ends at once while the first holds the lock', async () => {
    quarantine(51);
    await db.query(`INSERT INTO integration_config (provider, config) VALUES ($1, '{"job":"other"}')`, [RUN_LOCK_PROVIDER]);
    expect(await handleReleaseJob({ id: 999 }, null)).toEqual({ skipped: 'phish_release_busy' });
    expect(model.released).toEqual([]);
    // A lock of a run that died long ago is taken over.
    await db.query(`UPDATE integration_config SET updated_at = NOW() - interval '2 hours' WHERE provider = $1`, [RUN_LOCK_PROVIDER]);
    await handleReleaseJob({ id: 1000 }, null);
    expect(model.released).toEqual([qid(51)]);
    expect((await db.query('SELECT config FROM integration_config WHERE provider = $1', [RUN_LOCK_PROVIDER])).rows[0].config).toEqual({});
  });

  it('releases only to domains that receive mail through EOP', async () => {
    await db.query("UPDATE mail_node_domains SET state = 'dns_ok'");
    quarantine(52);
    await runNow();
    expect(model.released).toEqual([]);
    expect((await getTenantState()).phishRelease).toMatchObject({ noDomains: true });
    await db.query("INSERT INTO mail_node_domains (domain, state) VALUES ('other.example.org', 'connector_ready')");
    quarantine(53, { RecipientAddress: ['info@example.com'] });
    await runNow();
    // example.com is still onboarding: its recipients are not on a releasing domain.
    expect(model.released).toEqual([]);
    expect(await rowOf(qid(53))).toMatchObject({ state: 'skipped', reason: 'foreign_recipients' });
  });

  it('a message the quarantine does not know is gone only after a second read', async () => {
    model.exo.get_quarantine_messages = () => [{ Identity: qid(54) }];
    await runNow();
    expect(await rowOf(qid(54))).toMatchObject({ state: 'failed', reason: 'not_found', attempts: 1 });
    await runNow();
    expect(await rowOf(qid(54))).toMatchObject({ state: 'skipped', reason: 'gone' });
  });

  it('re-reads a message whose attempts ran out and settles it when it was released after all', async () => {
    quarantine(55);
    model.quarantine.get(qid(55)).ReleaseStatus = 'RELEASED';
    await db.query(`INSERT INTO tenant_quarantine_releases (identity, state, reason, attempts, expires_at, updated_at)
      VALUES ($1, 'failed', 'attempts_exhausted', $2, $3, NOW() - interval '7 hours')`, [qid(55), MAX_RELEASE_ATTEMPTS, FUTURE]);
    expect((await heldSummary()).count).toBe(1);
    await runNow();
    expect(await rowOf(qid(55))).toMatchObject({ state: 'released' });
    expect((await heldSummary()).count).toBe(0);
    expect(releaseCalls()).toEqual([]);
  });

  it('an exhausted message still in the quarantine stays held, read again only after hours', async () => {
    quarantine(56);
    await db.query(`INSERT INTO tenant_quarantine_releases (identity, state, reason, attempts, expires_at, updated_at)
      VALUES ($1, 'failed', 'attempts_exhausted', $2, $3, NOW() - interval '1 hour')`, [qid(56), MAX_RELEASE_ATTEMPTS, FUTURE]);
    model.exo.get_quarantine_messages = () => [];
    await runNow();
    expect(driver.fake.exo.calls.filter((c) => c.op === 'get_quarantine_message')).toEqual([]);
    await db.query("UPDATE tenant_quarantine_releases SET updated_at = NOW() - interval '7 hours'");
    await runNow();
    expect(await rowOf(qid(56))).toMatchObject({ state: 'failed', reason: 'attempts_exhausted' });
    expect(releaseCalls()).toEqual([]);
  });

  it('waits while a release is being prepared', async () => {
    quarantine(57);
    model.exo.get_quarantine_messages = () => [{ Identity: qid(57) }];
    model.quarantine.get(qid(57)).ReleaseStatus = 'PREPARINGTORELEASE';
    await runNow();
    expect(await rowOf(qid(57))).toBeUndefined();
    expect((await getTenantState()).phishRelease.counts).toMatchObject({ waiting: 1 });
    expect(releaseCalls()).toEqual([]);
  });

  it('a message the worker refuses to release stays in the quarantine with the reason', async () => {
    quarantine(58);
    driver.fake.exo.answers.release_quarantine_message = new TenantError('quarantine_not_allowed', 'Only inbound high confidence phishing is released');
    await runNow();
    expect(await rowOf(qid(58))).toMatchObject({ state: 'skipped', reason: 'worker_refused' });
    expect(releases()).toEqual([]);
  });
});

// A run that fails ends its job failed with the reason, so `jobs show` and the panel's job card say
// so, instead of a done job next to a failed run in the tenant state.
describe('a failed release run', () => {
  const runJobNow = async () => {
    const { job } = await enqueueJob({ kind: QUARANTINE_RELEASE_KIND });
    await runDue();
    return getJob(job.id);
  };

  it('a tenant refusal: the job fails with its code and text', async () => {
    quarantine(60);
    spamRule.throws = new TenantError('tenant_unreachable', 'The tenant did not answer');
    const job = await runJobNow();
    expect(job).toMatchObject({ status: 'failed', error_code: 'tenant_unreachable', last_error: 'The tenant did not answer' });
    expect((await getTenantState()).phishRelease).toMatchObject({ ok: false, error: { code: 'tenant_unreachable' } });
  });

  // A run every 10 minutes through a day-long outage would keep ~144 failed jobs for the failed
  // jobs' retention: only the newest few stay, the latest one always among them.
  it('keeps only the newest failed release jobs', async () => {
    expect(KEPT_FAILED_RELEASE_JOBS).toBe(5);
    spamRule.throws = new TenantError('tenant_unreachable', 'The tenant did not answer');
    const ids = [];
    for (let i = 0; i < KEPT_FAILED_RELEASE_JOBS + 3; i += 1) {
      quarantine(70 + i);
      ids.push((await runJobNow()).id);
    }
    const { rows } = await db.query("SELECT id, status FROM jobs WHERE kind = $1 ORDER BY id", [QUARANTINE_RELEASE_KIND]);
    expect(rows.map((r) => r.id)).toEqual(ids.slice(-KEPT_FAILED_RELEASE_JOBS));
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
  });

  it('any other error: the job fails as tenant_failed, the detail stays in the log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    quarantine(61);
    spamRule.throws = new Error('relation "x" does not exist');
    const job = await runJobNow();
    expect(job).toMatchObject({ status: 'failed', error_code: 'tenant_failed' });
    expect(job.last_error).not.toContain('relation');
    expect(spy.mock.calls.some(([line]) => String(line).includes(`job ${job.id}`) && String(line).includes('relation'))).toBe(true);
    spy.mockRestore();
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
