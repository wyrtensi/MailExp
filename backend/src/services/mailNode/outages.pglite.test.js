// Outage windows and the letters of the message trace (R-43) on the real schema: detection from
// the alert job's checks, windows by hand, the node log as evidence, the correlation with a trace in
// Graph's shapes, the mailboxes' list and the retention.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const { createRealSchemaDb } = await import('../testing/realSchema.js');
const { recordAudit } = await import('../auditLog.js');
const {
  addOutage, classifyCheck, deleteOutage, getOutageState, inboundEvidence, listOutages, parseOutageInput, recordCheck,
  updateEvidence, updateOutage,
} = await import('./outages.js');
const {
  EOP_EXPIRY_MS, mailboxLetters, nodeArrivals, outcomeOf, readEvents, runOutageTrace, waitingSignal, waitingSummary, windowLetters,
} = await import('./outageTrace.js');
const { createFixtureTraceSource } = await import('./traceSource.js');
const { OUTAGE, TRACE_DETAILS, TRACE_ROWS } = await import('./traceSource.fixtures.js');
const { parsePostfixLog } = await import('./postfixLog.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';
const ANNA_BOX = '61000000-0000-4000-8000-000000000001';
const MIN = 60000;
const START = Date.parse(OUTAGE.start);
const END = Date.parse(OUTAGE.end);
const good = { result: 'good', signals: [], down: [] };
const failed = { result: 'failed', signals: ['containers'], down: [{ name: 'postfix-mailcow', state: 'exited' }] };

let db;
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
}, 120000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.query('DELETE FROM mail_node_outages');
  await db.query("DELETE FROM integration_config WHERE provider LIKE 'mail_node_outage%'");
  await db.query('DELETE FROM mail_node_domains');
  await db.query("INSERT INTO mail_node_domains (domain, state) VALUES ('stage.test', 'ready')");
  await db.query('DELETE FROM email_accounts');
  recordAudit.mockClear();
});

const actions = () => recordAudit.mock.calls.flatMap(([entries]) => (Array.isArray(entries) ? entries : [entries])).map((e) => e.action);

describe('classifyCheck', () => {
  it('fails on an unreachable API or a receiving container not running; unknown for anything unclear', () => {
    expect(classifyCheck({ errorCode: 'mail_node_unreachable' })).toMatchObject({ result: 'failed', signals: ['api_unreachable'] });
    expect(classifyCheck({ errorCode: 'mail_node_auth' }).result).toBe('unknown');
    const up = [{ name: 'postfix-mailcow', state: 'running' }, { name: 'dovecot-mailcow', state: 'running' }, { name: 'sogo-mailcow', state: 'exited' }];
    expect(classifyCheck({ containers: up }).result).toBe('good');
    expect(classifyCheck({ containers: [{ name: 'mailcowdockerized-postfix-mailcow-1', state: 'exited' }, up[1]] }))
      .toMatchObject({ result: 'failed', down: [{ name: 'mailcowdockerized-postfix-mailcow-1', state: 'exited' }] });
    expect(classifyCheck({ containers: [up[0]] }).result).toBe('unknown');
  });
});

describe('recordCheck', () => {
  it('opens at the last good check, keeps one window while failing, closes at the first good check', async () => {
    await recordCheck({ check: good, now: START - 5 * MIN });
    const { opened } = await recordCheck({ check: failed, now: START });
    expect(opened.started_at.toISOString()).toBe(new Date(START - 5 * MIN).toISOString());
    expect(opened.cause).toMatchObject({ startUncertain: false, signals: ['containers'] });
    expect((await recordCheck({ check: { result: 'failed', signals: ['api_unreachable'], down: [] }, now: START + 5 * MIN })).opened).toBeNull();
    expect((await recordCheck({ check: { result: 'unknown', signals: ['mail_node_auth'], down: [] }, now: START + 10 * MIN })).closed).toBeNull();
    const { closed } = await recordCheck({ check: good, now: START + 15 * MIN });
    expect(closed.ended_at.toISOString()).toBe(new Date(START + 15 * MIN).toISOString());
    const [window] = await listOutages();
    expect(window).toMatchObject({ source: 'detected', open: false });
    expect(window.cause.signals).toEqual(['containers', 'api_unreachable']);
    expect(actions()).toEqual(['mail_node.outage_opened', 'mail_node.outage_closed']);
    expect(await getOutageState()).toMatchObject({ lastResult: 'good', lastGoodAt: new Date(START + 15 * MIN).toISOString() });
  });

  it('marks the start uncertain without a recent good check', async () => {
    const { opened } = await recordCheck({ check: failed, now: START });
    expect(opened.started_at.toISOString()).toBe(new Date(START).toISOString());
    expect(opened.cause.startUncertain).toBe(true);
  });
});

describe('windows by hand', () => {
  it('checks the input', () => {
    const now = START;
    expect(parseOutageInput({ startedAt: 'x', reason: 'r' }, { now }).error).toBe('outage_start_invalid');
    expect(parseOutageInput({ startedAt: OUTAGE.start, reason: ' ' }, { now }).error).toBe('outage_reason_required');
    expect(parseOutageInput({ startedAt: OUTAGE.end, endedAt: OUTAGE.start, reason: 'r' }, { now }).error).toBe('outage_end_before_start');
    expect(parseOutageInput({ startedAt: OUTAGE.start, reason: 'x'.repeat(501) }, { now }).error).toBe('outage_reason_too_long');
    expect(parseOutageInput({ startedAt: OUTAGE.start, reason: 'Maintenance', planned: true }, { now }).values).toMatchObject({ startedAt: START, reason: 'Maintenance', planned: true });
    expect(parseOutageInput({ endedAt: null, reason: 'r' }, { partial: true, now }).error).toBe('outage_end_invalid');
  });

  it('adds, changes, closes and deletes a window, journaling each step', async () => {
    const row = await addOutage({ startedAt: START, endedAt: null, reason: 'Disk replacement', planned: true }, ADMIN);
    expect(row).toMatchObject({ source: 'manual', planned: true, reason: 'Disk replacement' });
    const changed = await updateOutage(row.id, { startedAt: START - 10 * MIN, reason: 'Disk replacement, started early' }, ADMIN);
    expect(changed.row.started_at.toISOString()).toBe(new Date(START - 10 * MIN).toISOString());
    const closed = await updateOutage(row.id, { endedAt: END, reason: 'Done' }, ADMIN);
    expect(closed.row.closed_by).toBe(ADMIN);
    expect((await updateOutage(row.id, { endedAt: START - 60 * MIN, reason: 'x' }, ADMIN)).error).toBe('outage_end_before_start');
    expect((await deleteOutage(row.id, { reason: 'Marked twice' }, ADMIN)).row.id).toBe(row.id);
    expect((await deleteOutage(row.id, { reason: 'again' }, ADMIN)).error).toBe('outage_not_found');
    expect(actions()).toEqual(['mail_node.outage_added', 'mail_node.outage_changed', 'mail_node.outage_closed', 'mail_node.outage_deleted']);
  });
});

describe('the node log as evidence', () => {
  // Port 25 sessions (smtpd client=) at 09:50 and 14:20, one submission at 12:00 that is no
  // session from EOP.
  const entry = (iso, program, message) => ({ time: String(Date.parse(iso) / 1000), program, priority: 'info', message });
  const LOG = [
    entry('2026-10-01T14:20:00Z', 'postfix/smtpd', 'B1B1B1B1B1B: client=eop.test.local[172.22.1.7]'),
    entry('2026-10-01T12:00:00Z', 'postfix/submission/smtpd', 'C2C2C2C2C2C: client=unknown[172.22.1.1], sasl_method=PLAIN, sasl_username=anna@stage.test'),
    entry('2026-10-01T09:50:00Z', 'postfix/smtpd', 'A0A0A0A0A0A: client=eop.test.local[172.22.1.7]'),
    entry('2026-10-01T09:00:00Z', 'postfix/qmgr', 'D3D3D3D3D3D: removed'),
  ];
  const lines = parsePostfixLog(LOG).lines;

  it('notes the last session before, the first after and those during', () => {
    expect(inboundEvidence(lines, { start: START, end: END })).toEqual({
      lastBefore: '2026-10-01T09:50:00.000Z', firstAfter: '2026-10-01T14:20:00.000Z', during: 0, logFrom: '2026-10-01T09:00:00.000Z',
    });
    expect(inboundEvidence(lines, { start: START, end: null }).during).toBe(1);
  });

  it('writes it to the followed windows only when it changed', async () => {
    const row = await addOutage({ startedAt: START, endedAt: END, reason: 'r', planned: false }, ADMIN);
    await updateEvidence({ lines }, END + 30 * MIN);
    const [window] = await listOutages();
    expect(window.evidence).toMatchObject({ firstAfter: '2026-10-01T14:20:00.000Z' });
    const spy = vi.spyOn(dbState.db, 'query');
    await updateEvidence({ lines }, END + 31 * MIN);
    expect(spy.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    spy.mockRestore();
    expect(row.id).toBe(window.id);
  });
});

describe('the trace over a window', () => {
  const source = () => createFixtureTraceSource({ rows: TRACE_ROWS, details: TRACE_DETAILS });
  const window = () => addOutage({ startedAt: START, endedAt: END, reason: 'Postfix down', planned: false }, ADMIN);

  it('reads what the details say', () => {
    const lost = readEvents(TRACE_DETAILS['b7c1f4d2-9a6e-4c3b-8f2d-1e0a6c5b4d3f|anna@stage.test']);
    expect(lost).toMatchObject({ expired: true, statusCode: '4.4.7', eventAt: '2026-10-02T11:00:12Z' });
    const waiting = readEvents(TRACE_DETAILS['c1d2e3f4-5678-49ab-9cde-0123456789ab|boris@stage.test']);
    expect(waiting).toMatchObject({ expired: false, statusCode: '4.4.316' });
    expect(waiting.detail).toContain('Connection refused');
    expect(readEvents([{ dateTime: null, event: 'FAIL', description: '550 5.1.10 RESOLVER', data: '' }])).toMatchObject({ expired: false, statusCode: '5.1.10' });
    expect(outcomeOf({ status: 'expanded', receivedDateTime: OUTAGE.start }, { start: START, end: END })).toBeNull();
  });

  it('sorts the letters per recipient and stores them with the counts', async () => {
    const row = await window();
    const result = await runOutageTrace({ source: source(), now: END + 2 * 3600000 });
    expect(result.windows[0].trace).toMatchObject({ complete: true, counts: { delayed: 1, waiting: 1, lost: 1, other: 1 }, error: null });
    const letters = await windowLetters(row.id);
    expect(letters.map((l) => [l.recipient, l.outcome, l.expired, l.statusCode])).toEqual([
      ['boris@stage.test', 'waiting', false, '4.4.316'],
      ['anna@stage.test', 'lost', true, '4.4.7'],
      ['anna@stage.test', 'delayed', false, null],
      ['boris@stage.test', 'other', false, null],
    ]);
    expect(letters[0].expiresAt).toBe(new Date(Date.parse('2026-10-01T13:30:00Z') + EOP_EXPIRY_MS).toISOString());
    expect(letters[1].detail).toContain('QUEUE.Expired');
    expect(JSON.stringify(letters)).not.toContain('<root>');
  });

  it('drops a delivered letter the node log shows arriving in time, notes one it does not show', async () => {
    const row = await window();
    const entry = (iso, program, message) => ({ time: String(Date.parse(iso) / 1000), program, priority: 'info', message });
    const log = parsePostfixLog([
      entry('2026-10-01T10:31:00Z', 'postfix/cleanup', 'E5E5E5E5E5E: message-id=<4451a062-48cb-e80d-e8c0-196330437ae6@contoso.com>'),
      entry('2026-10-01T10:31:00Z', 'postfix/smtpd', 'E5E5E5E5E5E: client=eop.test.local[172.22.1.7]'),
      entry('2026-10-01T08:00:00Z', 'postfix/qmgr', 'F6F6F6F6F6F: removed'),
    ]);
    expect(nodeArrivals(log.lines).get('<4451a062-48cb-e80d-e8c0-196330437ae6@contoso.com>')).toBe(Date.parse('2026-10-01T10:31:00Z'));
    await runOutageTrace({ source: source(), now: END + 2 * 3600000, log: { lines: log.lines, oldestAt: '2026-10-01T08:00:00Z' } });
    expect((await windowLetters(row.id)).map((l) => l.outcome)).toEqual(['waiting', 'lost', 'other']);
  });

  it('keeps a letter delivered after waiting even in the hour around the window', async () => {
    const row = await window();
    const early = { ...TRACE_ROWS[0], id: 'early', receivedDateTime: '2026-10-01T09:40:00Z', status: 'pending' };
    await runOutageTrace({ source: createFixtureTraceSource({ rows: [early] }), now: END });
    await runOutageTrace({ source: createFixtureTraceSource({ rows: [{ ...early, status: 'delivered' }] }), now: END + 20 * MIN });
    expect((await windowLetters(row.id)).map((l) => l.outcome)).toEqual(['delayed']);
  });

  it('asks a window again only every 15 minutes and stops following it 25 hours after it closed', async () => {
    await window();
    const counted = source();
    const list = vi.spyOn(counted, 'list');
    await runOutageTrace({ source: counted, now: END + 3600000 });
    await runOutageTrace({ source: counted, now: END + 3600000 + 5 * MIN });
    await runOutageTrace({ source: counted, now: END + 3600000 + 15 * MIN });
    await runOutageTrace({ source: counted, now: END + 26 * 3600000 });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('keeps the error of a trace that failed with the window', async () => {
    await window();
    const broken = { kind: 'fixture', list: async () => { throw Object.assign(new Error('x'), { code: 'trace_unreachable' }); }, details: async () => ({ events: [], requests: 1 }) };
    const result = await runOutageTrace({ source: broken, now: END + 3600000 });
    expect(result.windows[0].trace.error).toBe('trace_unreachable');
    expect(await runOutageTrace({ source: null, now: END })).toEqual({ connected: false, windows: [] });
  });

  it('counts the letters still waiting and raises the warning until EOP gives up', async () => {
    await window();
    await runOutageTrace({ source: source(), now: END + 3600000 });
    const summary = await waitingSummary(END + 3600000);
    expect(summary).toEqual({ waiting: 1, soonestExpiresAt: '2026-10-02T13:30:00.000Z' });
    expect(waitingSignal(summary)).toEqual([{ key: 'outage_letters_waiting', severity: 'warning', details: summary }]);
    expect(await waitingSummary(Date.parse('2026-10-02T13:31:00Z'))).toEqual({ waiting: 0, soonestExpiresAt: null });
    expect(waitingSignal({ waiting: 0 })).toEqual([]);
  });

  it('lists the letters of the panel\'s mailboxes, once each, without EOP\'s filtering', async () => {
    await db.query(
      "INSERT INTO email_accounts (id, name, email_address, imap_host, mail_node) VALUES ($1, 'Anna', 'Anna@stage.test', 'mail.test.local', true)",
      [ANNA_BOX],
    );
    await window();
    await addOutage({ startedAt: START, endedAt: END, reason: 'Marked by hand too', planned: false }, ADMIN);
    await runOutageTrace({ source: source(), now: END + 3600000 });
    const letters = await mailboxLetters();
    expect(letters.map((l) => [l.accountId, l.recipient, l.outcome, l.subject])).toEqual([
      [ANNA_BOX, 'anna@stage.test', 'lost', 'Monthly report'],
      [ANNA_BOX, 'anna@stage.test', 'delayed', 'Quarterly Report'],
    ]);
    expect(letters[0]).not.toHaveProperty('detail');
  });

  it('deletes letters past the retention', async () => {
    const row = await window();
    await runOutageTrace({ source: source(), now: END + 3600000 });
    await runOutageTrace({ source: createFixtureTraceSource(), now: END + 31 * 24 * 3600000 });
    expect(await windowLetters(row.id)).toEqual([]);
  });
});
