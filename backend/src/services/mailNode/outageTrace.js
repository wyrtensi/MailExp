import { query, withTransaction } from '../db.js';
import { correlateByQueueId } from './postfixLog.js';
import { resolveTraceSource } from './traceSource.js';
import { FOLLOW_MS, TRACE_MARGIN_MS, getOutageSettings, isStalled } from './outages.js';

export { TRACE_MARGIN_MS };

// What became of the letters EOP received for the node's domains while the node was down (R-43):
// the message trace (services/mailNode/traceSource.js) over each outage window
// (services/mailNode/outages.js), one hour either side, sorted per recipient into
// - delayed: delivered, and held up: received during the window, or in the hour around it when the
//   node's log shows it arriving late or an earlier pass saw it waiting or delayed;
// - unaffected: delivered, and the node's log (the cleanup line of a queue that came in on port 25)
//   shows it arriving within ON_TIME_MS of EOP receiving it. Kept hidden, so that a later pass with
//   a log that no longer reaches back (the log is the last 10000 lines, the trace follows a window
//   for 25 hours) cannot bring it back as delayed. A window opened because the panel could not
//   reach the node while the node took mail then tells nobody their mail was late. A failure in the
//   hour around the window that did not expire is unaffected too (its details are read once);
// - waiting: pending, still in EOP's queue, which gives up EOP_EXPIRY_MS after it received it;
// - lost: failed after waiting (the details show a deferral) or expired (4.4.7 / QUEUE.Expired, the
//   24-hour limit): EOP sent the external sender a non-delivery report. In the hour around the
//   window only an expired failure counts;
// - other: quarantined or filtered as spam by EOP, or refused without ever waiting, during the
//   window: not a loss of the outage, shown to administrators only.
// gettingStatus and expanded rows are left for a later pass.
//
// Verdicts stick: a log that sees less than an earlier one (not covering the letter, or not read at
// all) keeps the stored outcome and node log; an in-window delivered letter is not stored as delayed
// before a pass with a log could tell; a failure whose details could not be read keeps what is
// stored, or waits.
//
// Rate limits (Graph: 100 requests per 5 minutes per tenant for the list and as many for details,
// shared with R-30): the panel keeps a bucket of BUCKET_SIZE requests refilled over 5 minutes, and a
// pass takes at most MAX_REQUESTS_PER_PASS of them and PASS_DEADLINE_MS of time. A window is listed
// again every RECHECK_MS while it is open or closed less than FOLLOW_MS ago, and AFTER_CLOSE_MS after
// it closed (EOP retries every 15 minutes, the trace lags 5-30); a listing cut short keeps its cursor
// and the next pass goes on from there. Details are read only for a letter new to the store or whose
// status changed (and, while waiting, every PENDING_DETAILS_MS); a final failure is read once. An
// administrator's pass now waits FORCE_COOLDOWN_MS after the last one. The alert job starts a pass
// after its ping, without waiting for it. Rows are kept for the retention of the outage settings
// (30 days by default), counted from when EOP received the letter.

const MINUTE_MS = 60 * 1000;
export const EOP_EXPIRY_MS = 24 * 60 * MINUTE_MS;
export const RECHECK_MS = 15 * MINUTE_MS;
export const AFTER_CLOSE_MS = Object.freeze([20 * MINUTE_MS, 35 * MINUTE_MS]);
export const ON_TIME_MS = 10 * MINUTE_MS;
export const PENDING_DETAILS_MS = 2 * 60 * MINUTE_MS;
export const MAX_REQUESTS_PER_PASS = 40;
export const PASS_DEADLINE_MS = 4 * MINUTE_MS;
export const FORCE_COOLDOWN_MS = 2 * MINUTE_MS;
export const BUCKET_SIZE = 80;
export const BUCKET_REFILL_MS = 5 * MINUTE_MS;
// A request may take up to the trace's timeout: a pass asks no more than its time left allows.
const REQUEST_TIME_MS = 30 * 1000;
export const DETAIL_MAX = 300;
export const OUTCOMES = Object.freeze(['delayed', 'waiting', 'lost', 'other']);
export const USER_OUTCOMES = Object.freeze(['delayed', 'waiting', 'lost']);
export const MAX_MAILBOX_LETTERS = 500;

// A code standing alone (not inside an address such as 10.4.4.7 or a longer code).
const CODE_RE = /(?:^|[^\d.])([245]\.\d{1,3}\.\d{1,3})(?![\d.]*\d)/;
const EXPIRED_RE = /(?:^|[^\d.])4\.4\.7(?![\d.]*\d)|queue\.expired|message expired/i;

// --- the request bucket ------------------------------------------------------------------------

const bucket = { tokens: BUCKET_SIZE, at: Date.now() };
function refill(at = Date.now()) {
  bucket.tokens = Math.min(BUCKET_SIZE, bucket.tokens + ((at - bucket.at) * BUCKET_SIZE) / BUCKET_REFILL_MS);
  bucket.at = at;
}
export function availableRequests() {
  refill();
  return Math.floor(bucket.tokens);
}
function spendRequests(count) {
  refill();
  bucket.tokens = Math.max(0, bucket.tokens - count);
}
// Tests: a full bucket and no cooldown.
export function resetTraceBudget() {
  bucket.tokens = BUCKET_SIZE;
  bucket.at = Date.now();
  lastForcedAt = 0;
}

// --- reading a row --------------------------------------------------------------------------------

const trim = (text) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
};

// What the details of a row say: { expired, deferred, statusCode, detail, eventAt, deliveredAt }.
// detail is the description of the last failure, else of the last deferral (trimmed); the data XML
// is only searched for the expiry, never kept.
export function readEvents(events) {
  const byTime = [...events].sort((a, b) => (Date.parse(a.dateTime) || 0) - (Date.parse(b.dateTime) || 0));
  const last = (re) => [...byTime].reverse().find((e) => re.test(e.event));
  const fail = last(/fail/i);
  const defer = last(/defer/i);
  const sent = last(/^(send|deliver)/i);
  const telling = fail ?? defer ?? null;
  return {
    expired: !!fail && (EXPIRED_RE.test(fail.description) || EXPIRED_RE.test(fail.data)),
    deferred: !!defer,
    statusCode: CODE_RE.exec(telling ? `${telling.description} ${telling.data}` : '')?.[1] ?? null,
    detail: trim(telling?.description),
    eventAt: (telling ?? byTime.at(-1))?.dateTime ?? null,
    deliveredAt: sent?.dateTime ?? null,
  };
}

// When the node took each letter from EOP, by Message-ID: the cleanup line of a queue that came in
// on port 25 (an smtpd client= line, not submission). Map '<id>' -> ms.
export function nodeArrivals(lines) {
  const arrivals = new Map();
  for (const message of correlateByQueueId(lines).values()) {
    if (!message.messageId) continue;
    if (!message.lines.some((line) => line.event === 'received' && line.program === 'postfix/smtpd')) continue;
    const at = message.lines.find((line) => line.event === 'message_id')?.epoch ?? null;
    if (at == null) continue;
    const before = arrivals.get(message.messageId);
    if (before == null || at < before) arrivals.set(message.messageId, at);
  }
  return arrivals;
}

// Whether the node's log shows the letter: { nodeLog: 'seen' | 'missing' | 'not_covered' | null,
// nodeSeenAt }. log: { lines, oldest (ms) } of one read, or null when none was read.
export function nodeLogOf(row, log, arrivals) {
  if (!log) return { nodeLog: null, nodeSeenAt: null };
  const seen = row.messageId ? arrivals.get(row.messageId) : undefined;
  if (seen != null) return { nodeLog: 'seen', nodeSeenAt: new Date(seen).toISOString() };
  const received = Date.parse(row.receivedDateTime);
  return { nodeLog: log.oldest != null && log.oldest <= received ? 'missing' : 'not_covered', nodeSeenAt: null };
}

// Whether a row's details are worth a request: a letter new to the store, one whose status changed,
// one still waiting whose details are older than PENDING_DETAILS_MS. A failure read once is final.
export function needsDetails(row, stored, now) {
  if (row.status !== 'pending' && row.status !== 'failed') return false;
  if (!stored || stored.details_status !== row.status) return true;
  if (row.status === 'failed') return false;
  return !stored.details_at || now - Date.parse(stored.details_at) >= PENDING_DETAILS_MS;
}

// The verdict on one row for a window [start, end] (ms): { outcome, seen } to store (seen null: keep
// the stored node log), or null to leave the store as it is. events: what its details say this pass
// (null: not read). stored: the stored row or undefined.
export function verdictOf(row, { start, end, stored, events, seen }) {
  const at = Date.parse(row.receivedDateTime);
  const inside = at >= start && at <= end;
  switch (row.status) {
    case 'pending':
      return { outcome: 'waiting', seen: null };
    case 'failed': {
      const expired = events ? events.expired : stored?.expired ?? null;
      const waited = events ? events.deferred : stored ? ['waiting', 'lost', 'delayed'].includes(stored.outcome) || stored.expired : null;
      if (expired == null && waited == null) return null; // details not read yet: wait for them
      if (expired) return { outcome: 'lost', seen: null };
      if (inside) return { outcome: waited ? 'lost' : 'other', seen: null };
      // Refused in the hour around the window without expiring: not the outage's. A letter an
      // earlier pass stored (it was waiting) shows as other; one never stored stays hidden, so its
      // details are not read again.
      if (stored && stored.outcome !== 'unaffected') return { outcome: 'other', seen: null };
      return { outcome: 'unaffected', seen: null };
    }
    case 'delivered': {
      if (stored?.outcome === 'unaffected') return null;
      if (seen.nodeLog === 'seen') {
        const late = Date.parse(seen.nodeSeenAt) - at > ON_TIME_MS;
        return { outcome: late ? 'delayed' : 'unaffected', seen };
      }
      // The log does not show it (or was not read): what is stored stays, else an in-window letter
      // is delayed once a log could have said otherwise.
      if (stored) return { outcome: stored.outcome === 'other' && !inside ? 'other' : 'delayed', seen: seen.nodeLog === 'missing' ? seen : null };
      if (!inside || seen.nodeLog == null) return null;
      return { outcome: 'delayed', seen };
    }
    case 'quarantined':
    case 'filteredAsSpam':
      return inside ? { outcome: 'other', seen: null } : null;
    default:
      return null;
  }
}

async function nodeDomains() {
  const { rows } = await query('SELECT domain FROM mail_node_domains ORDER BY domain');
  return rows.map((row) => row.domain);
}

// expired ($10) and the details' fields ($11-$13, $16-$17) are null when the details were not read
// this pass: the stored values stay. The node log never goes back from 'seen', and a read that sees
// less ($14 not_covered or null) keeps what is stored.
const UPSERT_SQL = `
  INSERT INTO mail_node_outage_letters (outage_id, trace_id, recipient, message_id, sender, subject, received_at, status, outcome,
                                        expired, status_code, detail, event_at, node_log, node_seen_at, details_status, details_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::boolean, false), $11, $12, $13, $14, $15, $16, $17)
  ON CONFLICT (outage_id, trace_id, recipient) DO UPDATE SET
    message_id = EXCLUDED.message_id, sender = EXCLUDED.sender, subject = EXCLUDED.subject, received_at = EXCLUDED.received_at,
    status = EXCLUDED.status, outcome = EXCLUDED.outcome,
    expired = CASE WHEN $10::boolean IS NULL THEN mail_node_outage_letters.expired ELSE $10::boolean END,
    status_code = COALESCE(EXCLUDED.status_code, mail_node_outage_letters.status_code),
    detail = COALESCE(EXCLUDED.detail, mail_node_outage_letters.detail),
    event_at = COALESCE(EXCLUDED.event_at, mail_node_outage_letters.event_at),
    node_log = CASE
      WHEN mail_node_outage_letters.node_log = 'seen' THEN 'seen'
      WHEN EXCLUDED.node_log IN ('seen', 'missing') THEN EXCLUDED.node_log
      ELSE COALESCE(mail_node_outage_letters.node_log, EXCLUDED.node_log) END,
    node_seen_at = CASE
      WHEN mail_node_outage_letters.node_log = 'seen' THEN mail_node_outage_letters.node_seen_at
      ELSE COALESCE(EXCLUDED.node_seen_at, mail_node_outage_letters.node_seen_at) END,
    details_status = COALESCE(EXCLUDED.details_status, mail_node_outage_letters.details_status),
    details_at = COALESCE(EXCLUDED.details_at, mail_node_outage_letters.details_at),
    updated_at = NOW()`;

// The end the trace looks up to for a window: its end, else now, else (stalled) its last failed check.
export function windowEnd(window, now) {
  if (window.ended_at) return Date.parse(window.ended_at);
  if (isStalled(window, now)) return Date.parse(window.last_failed_at ?? window.started_at);
  return now;
}

// One window: list (going on from an earlier cursor), sort, details within the budget, store.
// Returns the trace state kept with the window ({ checkedAt, complete, requests, counts, error,
// cursor }).
async function traceWindow(window, { source, domains, now, log, arrivals, budget, deadline }) {
  const start = Date.parse(window.started_at);
  const end = windowEnd(window, now);
  const from = start - TRACE_MARGIN_MS;
  const previous = window.trace?.cursor?.from === from ? window.trace.cursor : null;
  const timeLeft = () => Math.max(0, Math.floor((deadline - Date.now()) / REQUEST_TIME_MS));
  const listed = await source.list({
    start: from, end: Math.min(end + TRACE_MARGIN_MS, now), recipientDomains: domains,
    maxRequests: Math.max(1, Math.min(budget.left, timeLeft())), cursor: previous,
  });
  budget.left -= listed.requests;
  let requests = listed.requests;
  let complete = listed.complete;
  const { rows: storedRows } = await query('SELECT * FROM mail_node_outage_letters WHERE outage_id = $1', [window.id]);
  const stored = new Map(storedRows.map((r) => [`${r.trace_id}|${r.recipient}`, r]));
  const keep = [];
  for (const row of listed.rows) {
    const old = stored.get(`${row.id}|${row.recipientAddress}`);
    let events = null;
    if (needsDetails(row, old, now)) {
      if (budget.left > 0 && timeLeft() > 0) {
        const got = await source.details(row);
        budget.left -= got.requests;
        requests += got.requests;
        events = readEvents(got.events);
      } else {
        complete = false;
      }
    }
    const verdict = verdictOf(row, { start, end, stored: old, events, seen: nodeLogOf(row, log, arrivals) });
    if (verdict) keep.push({ row, ...verdict, events });
  }

  await withTransaction(async (client) => {
    for (const { row, outcome, seen, events } of keep) {
      await client.query(UPSERT_SQL, [
        window.id, row.id, row.recipientAddress, row.messageId, row.senderAddress || null, row.subject, row.receivedDateTime,
        row.status, outcome, events ? events.expired : null, events?.statusCode ?? null, events?.detail ?? null,
        events ? events.eventAt ?? events.deliveredAt : null, seen?.nodeLog ?? null, seen?.nodeSeenAt ?? null,
        events ? row.status : null, events ? new Date(now).toISOString() : null,
      ]);
    }
  });
  const { rows } = await query(
    "SELECT outcome, COUNT(*)::int AS n FROM mail_node_outage_letters WHERE outage_id = $1 AND outcome <> 'unaffected' GROUP BY outcome",
    [window.id],
  );
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, rows.find((r) => r.outcome === outcome)?.n ?? 0]));
  return {
    checkedAt: new Date(now).toISOString(), complete, requests, counts, error: null,
    cursor: listed.cursor ? { ...listed.cursor, from } : null,
  };
}

// Whether a followed window is due: never listed, a listing to go on with or details left unread,
// RECHECK_MS since the last pass, or one of the passes AFTER_CLOSE_MS after it closed.
export function isDue(window, now) {
  const checked = window.trace?.checkedAt ? Date.parse(window.trace.checkedAt) : null;
  if (checked == null || window.trace?.cursor || window.trace?.complete === false) return true;
  if (now - checked >= RECHECK_MS) return true;
  if (!window.ended_at) return false;
  const ended = Date.parse(window.ended_at);
  return AFTER_CLOSE_MS.some((after) => now >= ended + after && checked < ended + after);
}

let running = null;
let lastForcedAt = 0;

// One pass over the windows that are due: { connected, windows: [{ id, trace }] }. log: the alert
// job's read of the node's Postfix log ({ lines, oldestAt }), or null. force: every followed window,
// not only those due. Never runs twice at once: a call while a pass runs gets that pass.
export function runOutageTrace(options = {}) {
  if (running) return running;
  running = tracePass(options).finally(() => { running = null; });
  return running;
}

// An administrator's "Check the trace now": a forced pass, at most once per FORCE_COOLDOWN_MS.
// Returns the pass, or { cooldown: true, retryAt }.
export function forceOutageTrace({ log = null } = {}) {
  const at = Date.now();
  if (lastForcedAt && at - lastForcedAt < FORCE_COOLDOWN_MS) {
    return Promise.resolve({ cooldown: true, retryAt: new Date(lastForcedAt + FORCE_COOLDOWN_MS).toISOString() });
  }
  lastForcedAt = at;
  return runOutageTrace({ force: true, log });
}

async function tracePass({
  source: given, now = Date.now(), log = null, force = false, deadline = Date.now() + PASS_DEADLINE_MS,
} = {}) {
  await pruneOutageLetters(now);
  // undefined: the configured one (a test's, the stand's, or the tenant driver's); null: none.
  const source = given === undefined ? await resolveTraceSource() : given;
  if (!source) return { connected: false, windows: [] };
  const { rows: windows } = await query(
    `SELECT * FROM mail_node_outages WHERE started_at <= $1 AND (ended_at IS NULL OR ended_at > $2) ORDER BY started_at`,
    [new Date(now).toISOString(), new Date(now - FOLLOW_MS).toISOString()],
  );
  const due = windows.filter((w) => force || isDue(w, now));
  if (!due.length) return { connected: true, windows: [] };
  const domains = await nodeDomains();
  const parsedLog = log ? { lines: log.lines, oldest: log.oldestAt ? Date.parse(log.oldestAt) : null } : null;
  const arrivals = parsedLog ? nodeArrivals(parsedLog.lines) : new Map();
  const allowed = Math.min(MAX_REQUESTS_PER_PASS, availableRequests());
  const budget = { left: allowed };
  const done = [];
  try {
    for (const window of due) {
      let trace;
      if (!domains.length) {
        trace = { ...(window.trace ?? {}), checkedAt: new Date(now).toISOString(), error: 'no_domains' };
      } else if (budget.left <= 0 || Date.now() >= deadline) {
        // Out of requests or time: the window stays due for the next pass.
        continue;
      } else {
        try {
          trace = await traceWindow(window, { source, domains, now, log: parsedLog, arrivals, budget, deadline });
        } catch (err) {
          if (!err?.code) console.error('Outage trace pass failed:', err?.message || 'error');
          trace = { ...(window.trace ?? {}), checkedAt: new Date(now).toISOString(), error: err?.code || 'trace_failed' };
        }
      }
      await query('UPDATE mail_node_outages SET trace = $2, updated_at = NOW() WHERE id = $1', [window.id, trace]);
      done.push({ id: window.id, trace: { ...trace, cursor: undefined } });
    }
  } finally {
    spendRequests(allowed - Math.max(0, budget.left));
  }
  return { connected: true, windows: done };
}

// Deletes the letters older than the retention (by when EOP received them).
export async function pruneOutageLetters(now = Date.now()) {
  const { retentionDays } = await getOutageSettings();
  await query('DELETE FROM mail_node_outage_letters WHERE received_at < $1', [new Date(now - retentionDays * 24 * 60 * MINUTE_MS).toISOString()]);
}

// The letters still in EOP's queue that it has not given up on: { waiting, soonestExpiresAt, asOf }
// (asOf: the last pass of the trace that saw them, the count is as old as that).
export async function waitingSummary(now = Date.now()) {
  const { rows } = await query(
    `SELECT COUNT(DISTINCT (l.trace_id, l.recipient))::int AS waiting, MIN(l.received_at) AS oldest,
            MAX(o.trace->>'checkedAt') AS as_of
       FROM mail_node_outage_letters l JOIN mail_node_outages o ON o.id = l.outage_id
      WHERE l.outcome = 'waiting' AND l.received_at > $1`,
    [new Date(now - EOP_EXPIRY_MS).toISOString()],
  );
  const oldest = rows[0]?.oldest;
  const waiting = rows[0]?.waiting ?? 0;
  return {
    waiting,
    soonestExpiresAt: oldest ? new Date(Date.parse(new Date(oldest).toISOString()) + EOP_EXPIRY_MS).toISOString() : null,
    asOf: waiting && rows[0]?.as_of ? new Date(rows[0].as_of).toISOString() : null,
  };
}

// The R-18 alert while letters wait in EOP's queue: a warning (named in the Healthchecks ping's
// body, never /fail): the node is back or not, but EOP gives up on them at soonestExpiresAt.
export function waitingSignal(summary) {
  if (!summary?.waiting) return [];
  return [{
    key: 'outage_letters_waiting', severity: 'warning',
    details: { waiting: summary.waiting, soonestExpiresAt: summary.soonestExpiresAt, asOf: summary.asOf ?? null },
  }];
}

const isoOf = (value) => (value ? new Date(value).toISOString() : null);

// A stored letter for the screens. key: the same letter in every pass and window (trace id and
// recipient). withNode (administrators): the trace status, EOP's code and words, the node log.
export function presentLetter(row, { withNode = false } = {}) {
  const received = isoOf(row.received_at);
  return {
    key: `${row.trace_id}|${row.recipient}`,
    outageId: row.outage_id,
    recipient: row.recipient,
    sender: row.sender ?? null,
    subject: row.subject ?? null,
    receivedAt: received,
    outcome: row.outcome,
    expired: !!row.expired,
    expiresAt: row.outcome === 'waiting' && received ? new Date(Date.parse(received) + EOP_EXPIRY_MS).toISOString() : null,
    ...(withNode ? {
      status: row.status,
      statusCode: row.status_code ?? null,
      detail: row.detail ?? null,
      eventAt: isoOf(row.event_at),
      nodeLog: row.node_log ?? null,
      nodeSeenAt: isoOf(row.node_seen_at),
      messageId: row.message_id ?? null,
    } : {}),
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.started_at ? { outageStartedAt: isoOf(row.started_at), outageEndedAt: isoOf(row.ended_at) } : {}),
  };
}

// The letters of one window, every recipient and outcome but the hidden unaffected (administrators).
export async function windowLetters(outageId) {
  const { rows } = await query(
    `SELECT * FROM mail_node_outage_letters WHERE outage_id = $1 AND outcome <> 'unaffected'
      ORDER BY CASE outcome WHEN 'waiting' THEN 0 WHEN 'lost' THEN 1 WHEN 'delayed' THEN 2 ELSE 3 END, received_at`,
    [outageId],
  );
  return rows.map((row) => presentLetter(row, { withNode: true }));
}

// The letters of the panel's mailboxes (every signed-in user may open every mailbox,
// services/mailAccess.js): delayed, waiting or lost (waiting only while a trace is connected: else
// nobody can tell they still wait), matched by the mailbox's login address (an index on
// lower(email_address) serves the join), newest first, at most MAX_MAILBOX_LETTERS. A letter found
// in two windows (a detected one and a manual one over the same time) shows once, with its latest
// word. Recipients without a mailbox in the panel stay with the administrators' view. Returns
// { letters, truncated }.
export async function mailboxLetters({ withWaiting = true, limit = MAX_MAILBOX_LETTERS } = {}) {
  const outcomes = withWaiting ? USER_OUTCOMES : USER_OUTCOMES.filter((o) => o !== 'waiting');
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (l.trace_id, l.recipient, a.id) l.*, a.id AS account_id, o.started_at, o.ended_at
         FROM mail_node_outage_letters l
         JOIN mail_node_outages o ON o.id = l.outage_id
         JOIN email_accounts a ON LOWER(a.email_address) = l.recipient
        WHERE l.outcome = ANY($1::text[])
        ORDER BY l.trace_id, l.recipient, a.id, l.updated_at DESC
     ) letters
     ORDER BY received_at DESC
     LIMIT $2`,
    [outcomes, limit + 1],
  );
  return { letters: rows.slice(0, limit).map((row) => presentLetter(row)), truncated: rows.length > limit };
}
