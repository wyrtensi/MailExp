import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The outage routes (R-43) on the real schema: who sees which letters, the windows by hand with
// their checks and journal, the trace pass and the retention setting.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
const auth = vi.hoisted(() => ({ admin: true }));
const node = vi.hoisted(() => ({ cfg: null }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: '60000000-0000-4000-8000-000000000001' }; next(); },
  requireAdmin: (_req, res, next) => (auth.admin ? next() : res.status(403).json({ error: 'Admin only' })),
}));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/mailNode/mailcow.js', async (importActual) => ({
  ...(await importActual()),
  getMailNodeConfig: vi.fn(async () => node.cfg),
}));
// The node log the forced pass reads: from 08:00, without the fixture letters arriving.
vi.mock('../services/mailNode/postfixLog.js', async (importActual) => ({
  ...(await importActual()),
  readPostfixLog: vi.fn(async () => ({ lines: [], oldestAt: '2026-10-01T08:00:00.000Z' })),
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { default: express } = await import('express');
const { default: routes } = await import('./mailNodeOutages.js');
const { recordAudit } = await import('../services/auditLog.js');
const { createFixtureTraceSource, setTraceSource } = await import('../services/mailNode/traceSource.js');
const { resetTraceBudget } = await import('../services/mailNode/outageTrace.js');
const { OUTAGE, TRACE_DETAILS, TRACE_ROWS } = await import('../services/mailNode/traceSource.fixtures.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';
const ANNA_BOX = '61000000-0000-4000-8000-000000000001';
const BORIS_BOX = '61000000-0000-4000-8000-000000000002';

let db;
let server;
let base;
beforeAll(async () => {
  // The trace follows a window 25 hours after it closed: "now" is two hours after the fixture's.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-01T16:00:00Z') });
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
  await db.query("INSERT INTO email_accounts (id, name, email_address, imap_host, mail_node) VALUES ($1, 'Anna', 'anna@stage.test', 'mail.test.local', true)", [ANNA_BOX]);
  await db.query("INSERT INTO mail_node_domains (domain, state) VALUES ('stage.test', 'ready')");
  const app = express();
  app.use(express.json());
  app.use('/api/mail-node', routes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/mail-node`;
}, 120000);
afterAll(async () => {
  vi.useRealTimers();
  setTraceSource(null);
  await new Promise((resolve) => server?.close(resolve));
  await db?.close();
});
beforeEach(async () => {
  auth.admin = true;
  node.cfg = { mailHost: 'mail.test.local', apiKey: 'k' };
  resetTraceBudget();
  setTraceSource(null);
  await db.query('DELETE FROM mail_node_outages');
  recordAudit.mockClear();
});

const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const addWindow = () => call('POST', '/outages', { startedAt: OUTAGE.start, endedAt: OUTAGE.end, reason: 'Postfix down for an upgrade', planned: true });

describe('windows by hand', () => {
  it('adds, changes, closes and deletes, refusing bad input', async () => {
    expect((await call('POST', '/outages', { startedAt: OUTAGE.start })).body.code).toBe('outage_reason_required');
    expect((await call('POST', '/outages', { startedAt: 'yesterday', reason: 'x' })).body.code).toBe('outage_start_invalid');
    const open = await call('POST', '/outages', { startedAt: OUTAGE.start, reason: 'Node moved to a new host', planned: true });
    expect(open.status).toBe(201);
    expect(open.body.window).toMatchObject({ open: true, source: 'manual', planned: true });
    const { id } = open.body.window;
    expect((await call('PUT', `/outages/${id}`, { startedAt: OUTAGE.start })).body.code).toBe('outage_reason_required');
    expect((await call('PUT', `/outages/${id}`, { startedAt: '2026-10-01T09:55:00Z', reason: 'Began earlier' })).body.window.startedAt).toBe('2026-10-01T09:55:00.000Z');
    const closed = await call('POST', `/outages/${id}/close`, { endedAt: OUTAGE.end, reason: 'Back' });
    expect(closed.body.window).toMatchObject({ open: false, endedAt: '2026-10-01T14:00:00.000Z' });
    expect((await call('POST', `/outages/${id}/close`, { reason: 'Again' })).status).toBe(409);
    expect((await call('DELETE', `/outages/${id}`, { reason: 'Duplicate' })).body.code).toBe('outage_delete_unconfirmed');
    expect((await call('DELETE', `/outages/${id}`, { confirm: true, reason: 'Duplicate' })).body).toEqual({ ok: true });
    expect((await call('GET', `/outages/${id}/letters`)).status).toBe(404);
    expect((await call('GET', '/outages/not-a-uuid/letters')).status).toBe(400);
    const actions = recordAudit.mock.calls.map(([entry]) => entry.action);
    expect(actions).toEqual(['mail_node.outage_added', 'mail_node.outage_changed', 'mail_node.outage_closed', 'mail_node.outage_deleted']);
  });

  it('is for administrators only', async () => {
    auth.admin = false;
    expect((await call('GET', '/outages')).status).toBe(403);
    expect((await addWindow()).status).toBe(403);
    expect((await call('POST', '/outages/trace')).status).toBe(403);
  });
});

describe('the letters', () => {
  it('without a trace: the windows show, the trace is not connected', async () => {
    await addWindow();
    const admin = await call('GET', '/outages');
    expect(admin.body).toMatchObject({ traceConnected: false, waiting: { waiting: 0 }, settings: { retentionDays: 30 }, expiryHours: 24 });
    expect(admin.body.windows).toHaveLength(1);
    expect((await call('POST', '/outages/trace')).body).toEqual({ connected: false, windows: [] });
    expect((await call('GET', '/outage-letters')).body).toEqual({ traceConnected: false, node: true, letters: [], truncated: false });
  });

  it('checks the trace now at most once every two minutes', async () => {
    expect((await call('POST', '/outages/trace')).status).toBe(200);
    const again = await call('POST', '/outages/trace');
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('trace_cooldown');
    expect(Date.parse(again.body.retryAt)).toBeGreaterThan(Date.now());
  });

  it('administrators get every letter of a window, users those of the panel\'s mailboxes', async () => {
    setTraceSource(createFixtureTraceSource({ rows: TRACE_ROWS, details: TRACE_DETAILS }));
    const { body: { window } } = await addWindow();
    const pass = await call('POST', '/outages/trace');
    expect(pass.body.windows[0].trace.counts).toEqual({ delayed: 1, waiting: 1, lost: 1, other: 1 });
    const all = await call('GET', `/outages/${window.id}/letters`);
    expect(all.body.letters.map((l) => l.recipient)).toEqual(['boris@stage.test', 'anna@stage.test', 'anna@stage.test', 'boris@stage.test']);
    expect(all.body.letters[0]).toMatchObject({ statusCode: '4.4.316', status: 'pending' });
    expect(all.body.letters[2]).toMatchObject({ outcome: 'delayed', nodeLog: 'missing' });
    auth.admin = false;
    const mine = await call('GET', '/outage-letters');
    expect(mine.body.traceConnected).toBe(true);
    expect(mine.body.letters.map((l) => [l.accountId, l.outcome, l.sender, l.expired])).toEqual([
      [ANNA_BOX, 'lost', 'partner@fabrikam.com', true],
      [ANNA_BOX, 'delayed', 'sender@contoso.com', false],
    ]);
    // Users get no EOP codes, trace statuses, details or node log.
    for (const letter of mine.body.letters) {
      for (const field of ['statusCode', 'status', 'detail', 'nodeLog', 'nodeSeenAt', 'messageId']) expect(letter).not.toHaveProperty(field);
    }
  });

  it('shows no letter as still waiting once no trace is connected', async () => {
    await db.query("INSERT INTO email_accounts (id, name, email_address, imap_host, mail_node) VALUES ($1, 'Boris', 'boris@stage.test', 'mail.test.local', true)", [BORIS_BOX]);
    setTraceSource(createFixtureTraceSource({ rows: TRACE_ROWS, details: TRACE_DETAILS }));
    await addWindow();
    await call('POST', '/outages/trace');
    expect((await call('GET', '/outages')).body.waiting.waiting).toBe(1);
    expect((await call('GET', '/outage-letters')).body.letters.some((l) => l.outcome === 'waiting')).toBe(true);
    setTraceSource(null);
    expect((await call('GET', '/outages')).body.waiting).toEqual({ waiting: 0, soonestExpiresAt: null, asOf: null });
    expect((await call('GET', '/outage-letters')).body.letters.some((l) => l.outcome === 'waiting')).toBe(false);
    await db.query('DELETE FROM email_accounts WHERE id = $1', [BORIS_BOX]);
  });
});

describe('settings', () => {
  it('keeps letters 1 to 90 days and journals the change by name', async () => {
    expect((await call('PUT', '/outage-settings', { retentionDays: 0 })).body.code).toBe('retention_days_invalid');
    expect((await call('PUT', '/outage-settings', { retentionDays: 14 })).body.settings).toEqual({ retentionDays: 14 });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mail_node.config_changed', details: { settings: 'outages', fields: ['retentionDays'] } }));
    await call('PUT', '/outage-settings', { retentionDays: 30 });
  });
});
