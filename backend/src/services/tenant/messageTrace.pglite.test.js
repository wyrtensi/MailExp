import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// R-30 on the real schema and the real queue: "Ask Microsoft's message trace" of a sent letter of a
// node mailbox, through the delivery route, the trace job and the fake tenant's Graph trace (the
// tenant driver's token): which letters can be asked, the window and the Message-ID match, the
// details per recipient, the request budget, throttling and the cooldown.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
const journal = vi.hoisted(() => ({ entries: [] }));
vi.mock('../auditLog.js', async (importActual) => ({
  ...(await importActual()),
  recordAudit: vi.fn(async (entries) => { journal.entries.push(...[entries].flat()); }),
}));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: '60000000-0000-4000-8000-000000000001' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
const node = vi.hoisted(() => ({ cfg: { mailHost: 'mail.test.local', apiKey: 'k' } }));
vi.mock('../mailNode/mailcow.js', async (importActual) => ({
  ...(await importActual()),
  getMailNodeConfig: vi.fn(async () => node.cfg),
  getPostfixLog: vi.fn(async () => []),
}));

const { createRealSchemaDb } = await import('../testing/realSchema.js');
const { default: express } = await import('express');
const { default: routes } = await import('../../routes/delivery.js');
const { claimDueJobs, runJob } = await import('../jobQueue.js');
const { saveEopSettings } = await import('../mailNode/eopSettings.js');
const { createFakeTenantDriver, setTenantDriver } = await import('./driver.js');
const { TENANT_FIXTURES } = await import('./fakes.js');
const {
  AFTER_HANDOFF_MS, BEFORE_MS, MESSAGE_TRACE_KIND, availableTraceRequests, pruneMessageTraces, refundTraceRequests, registerMessageTraceKind,
  reserveTraceRequests, resetMessageTraceBudget, traceWindow,
} = await import('./messageTrace.js');

const USER = '60000000-0000-4000-8000-000000000001';
const NODE_BOX = '50000000-0000-4000-8000-000000000001';
const OTHER_BOX = '50000000-0000-4000-8000-000000000002';
const SENT_ROW = '51000000-0000-4000-8000-000000000001';
const INBOX_ROW = '51000000-0000-4000-8000-000000000002';
const OTHER_ROW = '51000000-0000-4000-8000-000000000003';
const OLD_ROW = '51000000-0000-4000-8000-000000000004';
const MID = '<r30-1@example.com>';
const SETTINGS = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: TENANT_FIXTURES.worker.certificate.thumbprint,
};
const HOUR = 3600 * 1000;

let db;
let server;
let base;
let driver;
let model;
let sentAt;

async function runDue() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}
const ask = (row) => fetch(`${base}/api/mail/messages/${row}/eop-trace`, { method: 'POST' });
const details = (row) => fetch(`${base}/api/mail/messages/${row}/delivery`).then((r) => r.json());
const traceRow = (id, recipient, status, at) => ({
  id, senderAddress: 'info@example.com', recipientAddress: recipient, messageId: MID, receivedDateTime: at,
  subject: 'R-30', size: 1000, fromIP: '192.0.2.10', toIP: '', status,
});

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'u', 'u@example.com', 'x', false)", [USER]);
  registerMessageTraceKind();
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);
afterAll(async () => {
  setTenantDriver(undefined);
  await new Promise((resolve) => server?.close(resolve));
  await db.close();
});

beforeEach(async () => {
  journal.entries = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetMessageTraceBudget();
  await db.exec(`DELETE FROM jobs; DELETE FROM message_eop_traces; DELETE FROM message_delivery_status; DELETE FROM mailbox_audit_log;
    DELETE FROM messages; DELETE FROM email_accounts; DELETE FROM integration_config WHERE provider = 'mail_node_eop';`);
  sentAt = new Date(Date.now() - HOUR).toISOString();
  const old = new Date(Date.now() - 95 * 24 * HOUR).toISOString();
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, imap_host, mail_node, folder_mappings) VALUES
       ($1, 'Node', 'info@example.com', 'mail.test.local', true, '{"sent":"Sent"}'),
       ($2, 'Office', 'office@example.net', 'imap.example.net', false, '{"sent":"Sent"}')`,
    [NODE_BOX, OTHER_BOX],
  );
  await db.query(
    `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, date, from_email) VALUES
       ($1, $5, 1, 'Sent', '${MID}', 'R-30', $7, 'info@example.com'),
       ($2, $5, 2, 'INBOX', '<in@example.org>', 'received', $7, 'partner@example.org'),
       ($3, $6, 1, 'Sent', '<office@example.net>', 'other', $7, 'office@example.net'),
       ($4, $5, 3, 'Sent', '<old@example.com>', 'old', $8, 'info@example.com')`,
    [SENT_ROW, INBOX_ROW, OTHER_ROW, OLD_ROW, NODE_BOX, OTHER_BOX, sentAt, old],
  );
  await saveEopSettings(SETTINGS);
  driver = createFakeTenantDriver();
  model = driver.fake.model;
  setTenantDriver(driver);
  const at = new Date(Date.parse(sentAt) + 60 * 1000).toISOString();
  model.traces = [
    traceRow('t-1', 'partner@example.org', 'delivered', at),
    traceRow('t-2', 'gone@example.net', 'failed', at),
    // Another letter in the same minutes: not this one.
    { ...traceRow('t-3', 'x@example.org', 'delivered', at), messageId: '<other@example.com>' },
  ];
  model.traceDetails = {
    't-1|partner@example.org': TENANT_FIXTURES.graph.messageTraceDetails.value,
    't-2|gone@example.net': [
      { dateTime: at, event: 'Receive', action: '', description: 'Message received', data: '' },
      { dateTime: at, event: 'Fail', action: '', description: '550 5.1.1 RESOLVER.ADR.RecipNotFound; not found', data: '' },
    ],
  };
});

describe('asking the trace (R-30)', () => {
  it('queues the job, matches the letter by its Message-ID and reads each recipient', async () => {
    let shown = await details(SENT_ROW);
    expect(shown.eopTrace).toEqual({ available: true, reason: null, trace: null });

    const res = await ask(SENT_ROW);
    expect(res.status).toBe(202);
    expect((await res.json()).trace).toMatchObject({ state: 'queued', recipients: [] });
    // A second click while it waits: the same request, no second job.
    expect((await ask(SENT_ROW)).status).toBe(200);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs WHERE kind = $1', [MESSAGE_TRACE_KIND])).rows[0].n).toBe(1);
    expect(journal.entries.filter((e) => e.action === 'tenant.message_traced')).toEqual([
      expect.objectContaining({ actorUserId: USER, accountId: NODE_BOX, details: { messageId: MID } }),
    ]);

    await runDue();
    shown = await details(SENT_ROW);
    expect(shown.eopTrace.trace.state).toBe('done');
    expect(shown.eopTrace.trace.recipients).toEqual([
      expect.objectContaining({ recipient: 'gone@example.net', status: 'failed', statusCode: '5.1.1', detailsRead: true }),
      expect.objectContaining({ recipient: 'partner@example.org', status: 'delivered', deliveredAt: expect.any(String), detailsRead: true }),
    ]);
    // One listing with both bounds, then one details request per recipient, all with the tenant's token.
    const graph = driver.fake.graph.requests.filter((r) => r.kind === 'graph');
    expect(graph).toHaveLength(3);
    const filter = new URLSearchParams(graph[0].query).get('$filter');
    expect(filter).toMatch(/^receivedDateTime ge \S+Z and receivedDateTime le \S+Z$/);
    expect(driver.fake.graph.requests.filter((r) => r.kind === 'token')).toHaveLength(1);

    // Within five minutes the stored trace is the answer.
    const again = await ask(SENT_ROW);
    expect(again.status).toBe(200);
    expect((await again.json()).cooldownUntil).toEqual(expect.any(String));
  });

  it('refuses what cannot be traced', async () => {
    const code = async (row) => (await (await ask(row)).json()).code;
    expect(await code(INBOX_ROW)).toBe('trace_not_sent');
    // A letter the mailbox sent (its Sent copy), but the mailbox is not on the node.
    expect(await code(OTHER_ROW)).toBe('trace_not_node');
    expect(await code(OLD_ROW)).toBe('trace_too_old');
    expect((await details(OLD_ROW)).eopTrace).toMatchObject({ available: false, reason: 'trace_too_old' });
    setTenantDriver(null);
    expect(await code(SENT_ROW)).toBe('trace_not_connected');
    expect((await details(SENT_ROW)).eopTrace).toMatchObject({ available: false, reason: 'trace_not_connected' });
  });

  it('a spent budget waits in a new job (no attempt spent); details left over go on in a follow-up job', async () => {
    resetMessageTraceBudget(0);
    await ask(SENT_ROW);
    await runDue();
    const jobs = (await db.query('SELECT * FROM jobs WHERE kind = $1 ORDER BY id', [MESSAGE_TRACE_KIND])).rows;
    expect(jobs.map((j) => j.status)).toEqual(['done', 'queued']);
    expect(jobs[1].attempts).toBe(0);
    expect(Date.parse(jobs[1].run_at) - Date.now()).toBeGreaterThan(5000);
    expect((await details(SENT_ROW)).eopTrace.trace).toMatchObject({ state: 'queued', error: 'trace_budget' });
    expect(driver.fake.graph.requests).toEqual([]);
    let job;

    // One request: the listing; the details wait for the next job.
    resetMessageTraceBudget(1);
    await db.query('UPDATE jobs SET run_at = NOW()');
    await runDue();
    expect((await details(SENT_ROW)).eopTrace.trace).toMatchObject({ state: 'queued' });
    resetMessageTraceBudget();
    await db.query("UPDATE jobs SET run_at = NOW() WHERE status = 'queued'");
    await runDue();
    const trace = (await details(SENT_ROW)).eopTrace.trace;
    expect(trace.state).toBe('done');
    expect(trace.recipients.every((r) => r.detailsRead)).toBe(true);
    // The listing was not asked again.
    expect(driver.fake.graph.requests.filter((r) => r.kind === 'graph' && /messageTraces$/.test(r.path))).toHaveLength(1);
    [job] = (await db.query("SELECT * FROM jobs WHERE kind = $1 AND status = 'queued'", [MESSAGE_TRACE_KIND])).rows;
    expect(job).toBeUndefined();
  });

  it('throttling queues the job again after a minute and keeps the request waiting', async () => {
    const real = model.listTraces;
    model.listTraces = () => ({ status: 429, body: { error: { code: 'TooManyRequests', message: 'Too many requests' } } });
    await ask(SENT_ROW);
    await runDue();
    const [job] = (await db.query('SELECT * FROM jobs WHERE kind = $1', [MESSAGE_TRACE_KIND])).rows;
    expect(job).toMatchObject({ status: 'queued', error_code: 'trace_throttled' });
    expect(Date.parse(job.run_at) - Date.now()).toBeGreaterThan(30 * 1000);
    expect((await details(SENT_ROW)).eopTrace.trace).toMatchObject({ state: 'queued', error: 'trace_throttled' });
    model.listTraces = real;
    await db.query('UPDATE jobs SET run_at = NOW()');
    await runDue();
    expect((await details(SENT_ROW)).eopTrace.trace.state).toBe('done');
  });

  it('a refused token fails the request with its code', async () => {
    driver.fake.graph.requests.length = 0;
    const real = model.listTraces;
    model.listTraces = () => ({ status: 403, body: { error: { code: 'Forbidden', message: 'Missing role' } } });
    await ask(SENT_ROW);
    await runDue();
    expect((await details(SENT_ROW)).eopTrace.trace).toMatchObject({ state: 'failed', error: 'trace_auth' });
    model.listTraces = real;
  });
});

describe('the review round (R-30)', () => {
  it('reserves requests before sending: jobs at once never take more than the bucket', () => {
    resetMessageTraceBudget();
    expect(reserveTraceRequests(10)).toBe(10);
    expect(reserveTraceRequests(10)).toBe(10);
    expect(reserveTraceRequests(10)).toBe(0);
    refundTraceRequests(7);
    expect(reserveTraceRequests(10)).toBe(7);
  });

  it('jobs running together share the 20 requests', async () => {
    // Three letters asked at once; the listing of each is several pages, so each would take 10.
    const pages = [];
    model.listTraces = (target) => {
      pages.push(target.href);
      const next = new URL(target.href);
      next.searchParams.set('$skiptoken', String(pages.length));
      return { status: 200, body: { value: [], '@odata.nextLink': next.href } };
    };
    const ids = ['<a@example.com>', '<b@example.com>', '<c@example.com>'];
    for (const [i, id] of ids.entries()) {
      await db.query(`INSERT INTO messages (id, account_id, uid, folder, message_id, subject, date, from_email)
        VALUES ($1, $2, $3, 'Sent', $4, 's', $5, 'info@example.com')`, [`52000000-0000-4000-8000-00000000000${i}`, NODE_BOX, 10 + i, id, sentAt]);
      await ask(`52000000-0000-4000-8000-00000000000${i}`);
    }
    const claimed = await claimDueJobs(10);
    await Promise.all(claimed.map((job) => runJob(job)));
    expect(pages.length).toBeLessThanOrEqual(20);
    expect(availableTraceRequests()).toBe(0);
  });

  it('counts the requests sent before an error and gives back the rest', async () => {
    resetMessageTraceBudget();
    model.listTraces = () => ({ status: 500, body: { error: { code: 'InternalServerError' } } });
    await ask(SENT_ROW);
    await runDue();
    expect((await details(SENT_ROW)).eopTrace.trace).toMatchObject({ state: 'failed', error: 'trace_failed' });
    expect(availableTraceRequests()).toBe(19);
  });

  it('a queued row whose job is gone is asked again', async () => {
    await db.query(`INSERT INTO message_eop_traces (account_id, message_id, state, sent_at, updated_at)
      VALUES ($1, $2, 'queued', $3, NOW() - interval '1 hour')`, [NODE_BOX, MID, sentAt]);
    const res = await ask(SENT_ROW);
    expect(res.status).toBe(202);
    await runDue();
    expect((await details(SENT_ROW)).eopTrace.trace.state).toBe('done');
  });

  it('a trace that cannot be resolved answers not connected, not a server error', async () => {
    setTenantDriver({ kind: 'fake', graphUrl: 'https://graph.fake.invalid/v1.0', forTenant: () => { throw new Error('broken driver'); } });
    const res = await ask(SENT_ROW);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('trace_not_connected');
  });

  it('old traces are deleted after 45 days', async () => {
    await db.query(`INSERT INTO message_eop_traces (account_id, message_id, state, sent_at, updated_at)
      VALUES ($1, '<old@example.com>', 'done', $2, NOW() - interval '46 days'), ($1, $3, 'done', $2, NOW())`, [NODE_BOX, sentAt, MID]);
    await pruneMessageTraces();
    const { rows } = await db.query('SELECT message_id FROM message_eop_traces');
    expect(rows.map((r) => r.message_id)).toEqual([MID]);
  });
});

describe('traceWindow', () => {
  it('spans the hand-off to EOP, or six hours after sending, never past now or 90 days back', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const sent = '2026-10-04T08:00:00Z';
    expect(traceWindow(sent, [], now)).toEqual({ start: Date.parse(sent) - BEFORE_MS, end: Date.parse('2026-10-04T12:00:00Z') });
    const handoff = Date.parse('2026-10-04T08:30:00Z');
    expect(traceWindow(sent, [handoff], now)).toEqual({ start: Date.parse(sent) - BEFORE_MS, end: handoff + AFTER_HANDOFF_MS });
    expect(traceWindow('2026-10-04T11:00:00Z', [], now).end).toBe(now);
    expect(traceWindow('2026-06-01T00:00:00Z', [], now).start).toBeGreaterThan(now - 90 * 24 * HOUR);
  });
});
