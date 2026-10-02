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
  addOutage, classifyCheck, deleteOutage, getOutageState, inboundEvidence, listOutages, mergeEvidence, parseOutageInput, recordCheck,
  updateEvidence, updateOutage,
} = await import('./outages.js');
const {
  EOP_EXPIRY_MS, MAX_REQUESTS_PER_PASS, forceOutageTrace, isDue, mailboxLetters, nodeArrivals, readEvents, resetTraceBudget,
  runOutageTrace, verdictOf, waitingSignal, waitingSummary, windowLetters,
} = await import('./outageTrace.js');
const { createFixtureTraceSource } = await import('./traceSource.js');
const { OUTAGE, TRACE_DETAILS, TRACE_ROWS } = await import('./traceSource.fixtures.js');
const { parsePostfixLog } = await import('./postfixLog.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';
const ANNA_BOX = '61000000-0000-4000-8000-000000000001';
const MIN = 60000;
const HOUR = 60 * MIN;
const START = Date.parse(OUTAGE.start);
const END = Date.parse(OUTAGE.end);
const good = { result: 'good', signals: [], down: [] };
const failed = { result: 'failed', signals: ['containers'], down: [{ name: 'postfix-mailcow', state: 'exited' }] };
const unreachable = { result: 'failed', signals: ['api_unreachable'], down: [] };
const unknown = { result: 'unknown', signals: ['mail_node_auth'], down: [] };

const entry = (iso, program, message) => ({ time: String(Date.parse(iso) / 1000), program, priority: 'info', message });
// A log of the node from 08:00: nothing of the fixture's letters arrived on port 25.
const COVERING_LOG = { lines: parsePostfixLog([entry('2026-10-01T08:00:00Z', 'postfix/qmgr', 'F6F6F6F6F6F: removed')]).lines, oldestAt: '2026-10-01T08:00:00Z' };
// The node took the delivered fixture letter at `at` (an smtpd queue with its cleanup line).
const arrivalLog = (messageId, at, oldestAt = '2026-10-01T08:00:00Z') => ({
  lines: parsePostfixLog([
    entry(at, 'postfix/cleanup', `E5E5E5E5E5E: message-id=${messageId}`),
    entry(at, 'postfix/smtpd', 'E5E5E5E5E5E: client=eop.test.local[172.22.1.7]'),
    entry(oldestAt, 'postfix/qmgr', 'F6F6F6F6F6F: removed'),
  ]).lines,
  oldestAt,
});
// A log that begins long after the letters (it scrolled).
const SCROLLED_LOG = { lines: parsePostfixLog([entry('2026-10-02T09:00:00Z', 'postfix/qmgr', 'A1A1A1A1A1A: removed')]).lines, oldestAt: '2026-10-02T09:00:00Z' };

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
  resetTraceBudget();
});

const actions = () => recordAudit.mock.calls.flatMap(([entries]) => (Array.isArray(entries) ? entries : [entries])).map((e) => e.action);
const outcomes = async (id) => (await windowLetters(id)).map((l) => [l.recipient, l.outcome]);
const allRows = async () => (await db.query('SELECT trace_id, outcome, node_log, node_seen_at, expired FROM mail_node_outage_letters ORDER BY trace_id')).rows;

describe('classifyCheck', () => {
  it('fails on an unreachable API or Postfix not running; Dovecot down is no outage; unknown for anything unclear', () => {
    expect(classifyCheck({ errorCode: 'mail_node_unreachable' })).toMatchObject({ result: 'failed', signals: ['api_unreachable'] });
    expect(classifyCheck({ errorCode: 'mail_node_auth' }).result).toBe('unknown');
    const up = [{ name: 'postfix-mailcow', state: 'running' }, { name: 'dovecot-mailcow', state: 'exited' }];
    expect(classifyCheck({ containers: up }).result).toBe('good');
    expect(classifyCheck({ containers: [{ name: 'mailcowdockerized-postfix-mailcow-1', state: 'exited' }] }))
      .toMatchObject({ result: 'failed', down: [{ name: 'mailcowdockerized-postfix-mailcow-1', state: 'exited' }] });
    expect(classifyCheck({ containers: [up[1]] }).result).toBe('unknown');
  });
});

describe('recordCheck', () => {
  it('opens at the last good check, keeps one window while failing, closes at the first good check', async () => {
    await recordCheck({ check: good, now: START - 5 * MIN });
    const { opened } = await recordCheck({ check: failed, now: START });
    expect(opened.started_at.toISOString()).toBe(new Date(START - 5 * MIN).toISOString());
    expect(opened.cause).toMatchObject({ startUncertain: false, signals: ['containers'] });
    expect((await recordCheck({ check: unreachable, now: START + 5 * MIN })).opened).toBeNull();
    expect((await recordCheck({ check: unknown, now: START + 10 * MIN })).closed).toBeNull();
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

  it('counts an unanswered API only on the second failed check in a row, from the last good check', async () => {
    await recordCheck({ check: good, now: START - 5 * MIN });
    expect((await recordCheck({ check: unreachable, now: START })).opened).toBeNull();
    expect((await recordCheck({ check: good, now: START + 5 * MIN })).closed).toBeNull();
    expect(await listOutages()).toEqual([]);
    // A blip, then an unknown check in between: no outage either.
    await recordCheck({ check: unreachable, now: START + 10 * MIN });
    await recordCheck({ check: unknown, now: START + 15 * MIN });
    expect((await recordCheck({ check: unreachable, now: START + 20 * MIN })).opened).toBeNull();
    const { opened } = await recordCheck({ check: unreachable, now: START + 25 * MIN });
    expect(opened.started_at.toISOString()).toBe(new Date(START + 5 * MIN).toISOString());
    expect(opened.cause.firstFailedAt).toBe(new Date(START + 20 * MIN).toISOString());
  });

  it('opens again a window the job closed less than 15 minutes ago (a restart loop)', async () => {
    await recordCheck({ check: good, now: START - 5 * MIN });
    const { opened } = await recordCheck({ check: failed, now: START });
    await recordCheck({ check: good, now: START + 5 * MIN });
    const again = await recordCheck({ check: failed, now: START + 10 * MIN });
    expect(again.opened.id).toBe(opened.id);
    expect(again.opened.ended_at).toBeNull();
    expect(again.opened.cause.reopened).toBe(1);
    await recordCheck({ check: good, now: START + 15 * MIN });
    const later = await recordCheck({ check: failed, now: START + 60 * MIN });
    expect(later.opened.id).not.toBe(opened.id);
    expect(await listOutages()).toHaveLength(2);
  });

  it('starts after a window an administrator closed while the node was still down, never overlapping it', async () => {
    await recordCheck({ check: good, now: START - 5 * MIN });
    const { opened } = await recordCheck({ check: failed, now: START });
    await updateOutage(opened.id, { endedAt: START + 10 * MIN, reason: 'Thought it was back' }, ADMIN);
    const next = await recordCheck({ check: failed, now: START + 15 * MIN });
    expect(next.opened.id).not.toBe(opened.id);
    expect(next.opened.started_at.toISOString()).toBe(new Date(START + 10 * MIN).toISOString());
    const windows = await listOutages();
    expect(windows.filter((w) => w.open)).toHaveLength(1);
  });

  it('marks an open window stalled when no check failed it for 30 minutes', async () => {
    await recordCheck({ check: good, now: START - 5 * MIN });
    await recordCheck({ check: failed, now: START });
    await recordCheck({ check: unknown, now: START + 20 * MIN });
    const { rows: [row] } = await db.query('SELECT * FROM mail_node_outages');
    const { presentOutage } = await import('./outages.js');
    expect(presentOutage(row, {}, START + 20 * MIN).stalled).toBe(false);
    expect(presentOutage(row, {}, START + 31 * MIN).stalled).toBe(true);
    // The trace of a stalled window stops at its last failed check, not now.
    const { windowEnd } = await import('./outageTrace.js');
    expect(windowEnd(row, START + 31 * MIN)).toBe(START);
    expect(windowEnd(row, START + 20 * MIN)).toBe(START + 20 * MIN);
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

  it('narrowing a window drops the letters outside it, so a stale waiting letter stops counting', async () => {
    const row = await addOutage({ startedAt: START, endedAt: END, reason: 'Postfix down', planned: false }, ADMIN);
    await runOutageTrace({ source: createFixtureTraceSource({ rows: TRACE_ROWS, details: TRACE_DETAILS }), now: END + HOUR, log: COVERING_LOG });
    expect((await waitingSummary(END + HOUR)).waiting).toBe(1);
    // The waiting letter came at 13:30: a window that ends at 12:00 looks up to 13:00.
    await updateOutage(row.id, { endedAt: START + 2 * HOUR, reason: 'It ended earlier' }, ADMIN);
    expect(await outcomes(row.id)).toEqual([['anna@stage.test', 'lost'], ['anna@stage.test', 'delayed'], ['boris@stage.test', 'other']]);
    expect((await waitingSummary(END + HOUR)).waiting).toBe(0);
    expect((await listOutages())[0].trace).toBeNull();
  });
});

describe('the node log as evidence', () => {
  // Port 25 sessions (smtpd client=) at 09:50 and 14:20, one submission at 12:00 that is no
  // session from EOP.
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

  it('writes it to the followed windows only when it changed, and a scrolled log keeps what was seen', async () => {
    const row = await addOutage({ startedAt: START, endedAt: END, reason: 'r', planned: false }, ADMIN);
    await updateEvidence({ lines }, END + 30 * MIN);
    const [window] = await listOutages();
    expect(window.evidence).toMatchObject({ firstAfter: '2026-10-01T14:20:00.000Z', lastBefore: '2026-10-01T09:50:00.000Z' });
    const spy = vi.spyOn(dbState.db, 'query');
    await updateEvidence({ lines }, END + 31 * MIN);
    expect(spy.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    spy.mockRestore();
    // The log scrolled past the window: the earlier sessions stay.
    await updateEvidence({ lines: parsePostfixLog([entry('2026-10-01T15:00:00Z', 'postfix/qmgr', 'E1E1E1E1E1E: removed')]).lines }, END + 2 * HOUR);
    expect((await listOutages())[0].evidence).toEqual(window.evidence);
    expect(mergeEvidence(null, { lastBefore: null, firstAfter: null, during: 0, logFrom: 'x' })).toMatchObject({ logFrom: 'x' });
    expect(row.id).toBe(window.id);
  });
});

describe('the trace over a window', () => {
  const source = () => createFixtureTraceSource({ rows: TRACE_ROWS, details: TRACE_DETAILS });
  const window = () => addOutage({ startedAt: START, endedAt: END, reason: 'Postfix down', planned: false }, ADMIN);
  const DELIVERED = TRACE_ROWS[0];

  it('reads what the details say', () => {
    const lost = readEvents(TRACE_DETAILS['b7c1f4d2-9a6e-4c3b-8f2d-1e0a6c5b4d3f|anna@stage.test']);
    expect(lost).toMatchObject({ expired: true, deferred: true, statusCode: '4.4.7', eventAt: '2026-10-02T11:00:12Z' });
    const waiting = readEvents(TRACE_DETAILS['c1d2e3f4-5678-49ab-9cde-0123456789ab|boris@stage.test']);
    expect(waiting).toMatchObject({ expired: false, deferred: true, statusCode: '4.4.316' });
    expect(waiting.detail).toContain('Connection refused');
    expect(readEvents([{ dateTime: null, event: 'FAIL', description: '550 5.1.10 RESOLVER', data: '' }])).toMatchObject({ expired: false, deferred: false, statusCode: '5.1.10' });
    // 4.4.7 inside an address is no expiry.
    expect(readEvents([{ dateTime: null, event: 'Fail', description: 'Refused by [10.4.4.7]', data: '' }]).expired).toBe(false);
  });

  it('sorts the letters per recipient and stores them with the counts', async () => {
    const row = await window();
    const result = await runOutageTrace({ source: source(), now: END + 2 * HOUR, log: COVERING_LOG });
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
    expect(letters[2].nodeLog).toBe('missing');
    expect(JSON.stringify(letters)).not.toContain('<root>');
    // The refusal in the hour before the window is kept hidden (unaffected), not shown.
    expect((await allRows()).find((r) => r.trace_id === '1f2e3d4c-5b6a-7980-9a0b-1c2d3e4f5a6b').outcome).toBe('unaffected');
  });

  it('a failure in the window that never waited is not lost but other', () => {
    const row = { ...TRACE_ROWS[1], receivedDateTime: OUTAGE.start, status: 'failed' };
    const events = readEvents([{ dateTime: null, event: 'Fail', description: '550 5.7.1 Rejected', data: '' }]);
    expect(verdictOf(row, { start: START, end: END, stored: undefined, events, seen: { nodeLog: null } })).toEqual({ outcome: 'other', seen: null });
    // Details not read and nothing stored: wait.
    expect(verdictOf(row, { start: START, end: END, stored: undefined, events: null, seen: { nodeLog: null } })).toBeNull();
    // Details skipped: what is stored stays (an expired letter stays lost even outside the window).
    expect(verdictOf({ ...row, receivedDateTime: '2026-10-01T09:30:00Z' }, { start: START, end: END, stored: { outcome: 'lost', expired: true }, events: null, seen: { nodeLog: null } }))
      .toEqual({ outcome: 'lost', seen: null });
  });

  it('keeps a letter the log showed arriving in time hidden, even once the log scrolled', async () => {
    const row = await window();
    await runOutageTrace({ source: source(), now: END + HOUR, log: arrivalLog(DELIVERED.messageId, '2026-10-01T10:31:00Z') });
    expect(nodeArrivals(arrivalLog(DELIVERED.messageId, '2026-10-01T10:31:00Z').lines).get(DELIVERED.messageId)).toBe(Date.parse('2026-10-01T10:31:00Z'));
    expect((await outcomes(row.id)).map((o) => o[1])).toEqual(['waiting', 'lost', 'other']);
    await runOutageTrace({ source: source(), now: END + HOUR + 20 * MIN, log: SCROLLED_LOG, force: true });
    await runOutageTrace({ source: source(), now: END + HOUR + 40 * MIN, log: null, force: true });
    expect((await outcomes(row.id)).map((o) => o[1])).toEqual(['waiting', 'lost', 'other']);
    expect((await allRows()).find((r) => r.trace_id === DELIVERED.id)).toMatchObject({ outcome: 'unaffected', node_log: 'seen' });
  });

  it('stores no in-window delayed letter before a log could tell, then keeps its node log when the log sees less', async () => {
    const row = await window();
    await runOutageTrace({ source: source(), now: END + HOUR, log: null });
    expect((await outcomes(row.id)).map((o) => o[1])).toEqual(['waiting', 'lost', 'other']);
    await runOutageTrace({ source: source(), now: END + HOUR + 20 * MIN, log: arrivalLog(DELIVERED.messageId, '2026-10-01T14:31:00Z') });
    let stored = (await allRows()).find((r) => r.trace_id === DELIVERED.id);
    expect(stored).toMatchObject({ outcome: 'delayed', node_log: 'seen' });
    const seenAt = stored.node_seen_at.toISOString();
    await runOutageTrace({ source: source(), now: END + 2 * HOUR, log: SCROLLED_LOG, force: true });
    await runOutageTrace({ source: source(), now: END + 3 * HOUR, log: null, force: true });
    stored = (await allRows()).find((r) => r.trace_id === DELIVERED.id);
    expect(stored).toMatchObject({ outcome: 'delayed', node_log: 'seen' });
    expect(stored.node_seen_at.toISOString()).toBe(seenAt);
  });

  it('keeps a letter delivered after waiting or stored delayed in the hour around the window', async () => {
    const row = await window();
    const early = { ...TRACE_ROWS[0], id: 'early', receivedDateTime: '2026-10-01T09:40:00Z', status: 'pending' };
    await runOutageTrace({ source: createFixtureTraceSource({ rows: [early] }), now: END, log: COVERING_LOG });
    await runOutageTrace({ source: createFixtureTraceSource({ rows: [{ ...early, status: 'delivered' }] }), now: END + 20 * MIN, log: SCROLLED_LOG });
    expect(await outcomes(row.id)).toEqual([['anna@stage.test', 'delayed']]);
    // A later pass without anything new keeps it: stored delayed counts like stored waiting.
    await runOutageTrace({ source: createFixtureTraceSource({ rows: [{ ...early, status: 'delivered' }] }), now: END + 40 * MIN, log: null, force: true });
    expect(await outcomes(row.id)).toEqual([['anna@stage.test', 'delayed']]);
  });

  it('reads details once for a final failure, and goes on in the next pass when the budget runs out', async () => {
    const row = await window();
    const failures = Array.from({ length: MAX_REQUESTS_PER_PASS + 5 }, (_, i) => ({
      ...TRACE_ROWS[1], id: `fail-${String(i).padStart(2, '0')}`, receivedDateTime: new Date(START + i * MIN).toISOString(),
    }));
    const details = Object.fromEntries(failures.map((f) => [`${f.id}|anna@stage.test`, TRACE_DETAILS['b7c1f4d2-9a6e-4c3b-8f2d-1e0a6c5b4d3f|anna@stage.test']]));
    const counted = createFixtureTraceSource({ rows: failures, details });
    const detailsSpy = vi.spyOn(counted, 'details');
    const first = await runOutageTrace({ source: counted, now: END + HOUR, log: COVERING_LOG });
    expect(first.windows[0].trace.complete).toBe(false);
    expect(detailsSpy).toHaveBeenCalledTimes(MAX_REQUESTS_PER_PASS - 1);
    expect((await windowLetters(row.id)).length).toBe(MAX_REQUESTS_PER_PASS - 1);
    const [stored] = await db.query('SELECT trace FROM mail_node_outages').then((r) => r.rows);
    expect(isDue({ trace: stored.trace, ended_at: new Date(END).toISOString() }, END + HOUR + MIN)).toBe(true);
    detailsSpy.mockClear();
    const second = await runOutageTrace({ source: counted, now: END + HOUR + 5 * MIN, log: COVERING_LOG });
    expect(second.windows[0].trace.complete).toBe(true);
    expect(detailsSpy).toHaveBeenCalledTimes(6);
    const letters = await windowLetters(row.id);
    expect(letters).toHaveLength(MAX_REQUESTS_PER_PASS + 5);
    expect(letters.every((l) => l.outcome === 'lost' && l.expired)).toBe(true);
    // Nothing changed: no details are read again.
    detailsSpy.mockClear();
    await runOutageTrace({ source: counted, now: END + 2 * HOUR, log: COVERING_LOG, force: true });
    expect(detailsSpy).not.toHaveBeenCalled();
  });

  it('asks a window again every 15 minutes and twice after it closed, and stops 25 hours after', async () => {
    await window();
    const counted = source();
    const list = vi.spyOn(counted, 'list');
    await runOutageTrace({ source: counted, now: END + 3 * MIN, log: COVERING_LOG });
    await runOutageTrace({ source: counted, now: END + 8 * MIN, log: COVERING_LOG });
    expect(list).toHaveBeenCalledTimes(1);
    await runOutageTrace({ source: counted, now: END + 20 * MIN, log: COVERING_LOG }); // 20 min after closing
    await runOutageTrace({ source: counted, now: END + 25 * MIN, log: COVERING_LOG });
    await runOutageTrace({ source: counted, now: END + 35 * MIN, log: COVERING_LOG }); // 35 min after closing
    await runOutageTrace({ source: counted, now: END + 26 * HOUR, log: COVERING_LOG });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('a forced pass waits two minutes after the last one', async () => {
    await window();
    const first = await forceOutageTrace({ log: null });
    expect(first.connected).toBe(false); // no trace configured in this test
    expect(await forceOutageTrace({ log: null })).toMatchObject({ cooldown: true });
  });

  it('keeps the error of a trace that failed with the window', async () => {
    await window();
    const broken = { kind: 'fixture', list: async () => { throw Object.assign(new Error('x'), { code: 'trace_unreachable' }); }, details: async () => ({ events: [], requests: 1 }) };
    const result = await runOutageTrace({ source: broken, now: END + HOUR });
    expect(result.windows[0].trace.error).toBe('trace_unreachable');
    expect(await runOutageTrace({ source: null, now: END })).toEqual({ connected: false, windows: [] });
  });

  it('counts the letters still waiting, as of the pass that saw them, and raises the warning until EOP gives up', async () => {
    await window();
    await runOutageTrace({ source: source(), now: END + HOUR, log: COVERING_LOG });
    const summary = await waitingSummary(END + HOUR);
    expect(summary).toEqual({ waiting: 1, soonestExpiresAt: '2026-10-02T13:30:00.000Z', asOf: new Date(END + HOUR).toISOString() });
    expect(waitingSignal(summary)).toEqual([{ key: 'outage_letters_waiting', severity: 'warning', details: { waiting: 1, soonestExpiresAt: summary.soonestExpiresAt, asOf: summary.asOf } }]);
    expect(await waitingSummary(Date.parse('2026-10-02T13:31:00Z'))).toEqual({ waiting: 0, soonestExpiresAt: null, asOf: null });
    expect(waitingSignal({ waiting: 0 })).toEqual([]);
  });

  it('lists the letters of the panel\'s mailboxes, once each, without EOP\'s filtering or codes', async () => {
    await db.query(
      "INSERT INTO email_accounts (id, name, email_address, imap_host, mail_node) VALUES ($1, 'Anna', 'Anna@stage.test', 'mail.test.local', true)",
      [ANNA_BOX],
    );
    await window();
    await addOutage({ startedAt: START, endedAt: END, reason: 'Marked by hand too', planned: false }, ADMIN);
    await runOutageTrace({ source: source(), now: END + HOUR, log: COVERING_LOG });
    const { letters, truncated } = await mailboxLetters();
    expect(truncated).toBe(false);
    expect(letters.map((l) => [l.accountId, l.recipient, l.outcome, l.subject, l.key])).toEqual([
      [ANNA_BOX, 'anna@stage.test', 'lost', 'Monthly report', 'b7c1f4d2-9a6e-4c3b-8f2d-1e0a6c5b4d3f|anna@stage.test'],
      [ANNA_BOX, 'anna@stage.test', 'delayed', 'Quarterly Report', '4451a062-48cb-e80d-e8c0-196330437ae6|anna@stage.test'],
    ]);
    for (const letter of letters) {
      expect(letter).not.toHaveProperty('detail');
      expect(letter).not.toHaveProperty('statusCode');
      expect(letter).not.toHaveProperty('status');
    }
    expect((await mailboxLetters({ limit: 1 })).truncated).toBe(true);
  });

  it('deletes letters past the retention', async () => {
    const row = await window();
    await runOutageTrace({ source: source(), now: END + HOUR, log: COVERING_LOG });
    await runOutageTrace({ source: createFixtureTraceSource(), now: END + 31 * 24 * HOUR });
    expect(await windowLetters(row.id)).toEqual([]);
  });
});
