import { query, withTransaction } from '../db.js';
import { correlateByQueueId } from './postfixLog.js';
import { getTraceSource } from './traceSource.js';
import { FOLLOW_MS, getOutageSettings } from './outages.js';

// What became of the letters EOP received for the node's domains while the node was down (R-43):
// the message trace (services/mailNode/traceSource.js) over each outage window
// (services/mailNode/outages.js), one hour either side, sorted per recipient into
// - delayed: delivered, received during the window itself. Where the node's Postfix log covers the
//   letter, the time its cleanup line logged the Message-ID is when it arrived on the node; a letter
//   that arrived within ON_TIME_MS of EOP receiving it was not held up and gets no row (a window
//   opened because the panel could not reach the node, while the node took mail, then tells nobody
//   their mail was late);
// - waiting: pending, still in EOP's queue, which gives up EOP_EXPIRY_MS after it received it;
// - lost: failed: EOP sent the external sender a non-delivery report; expired when the details say
//   4.4.7 / QUEUE.Expired (the 24-hour limit). A failure received in the hour around the window but
//   not during it counts only when expired (a 5.x.x refusal then is not the outage's);
// - other: quarantined or filtered as spam by EOP during the window: not a loss of the outage,
//   shown to administrators only.
// gettingStatus and expanded rows are left for a later pass.
//
// Rate limits (Graph: 100 requests per 5 minutes per tenant for the list and as many for details):
// a pass asks one ranged list per window that is due (paged), details only for pending and failed
// rows, and at most MAX_REQUESTS_PER_PASS requests in all; a window is asked again every
// RECHECK_MS while it is open or closed less than FOLLOW_MS ago (EOP's 24 hours and an hour; the
// trace lags 5-30 minutes). The alert job runs a pass after each check. Rows are kept for the
// retention of the outage settings (30 days by default), counted from when EOP received the letter.

const MINUTE_MS = 60 * 1000;
export const EOP_EXPIRY_MS = 24 * 60 * MINUTE_MS;
export const TRACE_MARGIN_MS = 60 * MINUTE_MS;
export const RECHECK_MS = 15 * MINUTE_MS;
export const ON_TIME_MS = 10 * MINUTE_MS;
export const MAX_REQUESTS_PER_PASS = 40;
export const DETAIL_MAX = 300;
export const OUTCOMES = Object.freeze(['delayed', 'waiting', 'lost', 'other']);
export const USER_OUTCOMES = Object.freeze(['delayed', 'waiting', 'lost']);

const EXPIRED_RE = /\b4\.4\.7\b|queue\.expired|message expired/i;
const CODE_RE = /(?:^|[^\d.])([245]\.\d{1,3}\.\d{1,3})(?![\d.]*\d)/;

// The outcome of one trace row for a window [start, end] (ms), before its details: one of OUTCOMES
// or null (no row).
export function outcomeOf(row, { start, end }) {
  const at = Date.parse(row.receivedDateTime);
  const inside = at >= start && at <= end;
  switch (row.status) {
    case 'pending': return 'waiting';
    case 'failed': return 'lost';
    // Delivered in the hour around the window: delayed only when the node's log shows it arriving
    // late or an earlier pass saw it waiting (traceWindow).
    case 'delivered': return 'delayed';
    case 'quarantined':
    case 'filteredAsSpam': return inside ? 'other' : null;
    default: return null;
  }
}

const trim = (text) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
};

// What the details of a row say: { expired, statusCode, detail, eventAt, deliveredAt }. detail is
// the description of the last failure, else of the last deferral (trimmed); the data XML is only
// searched for the expiry, never kept.
export function readEvents(events) {
  const byTime = [...events].sort((a, b) => (Date.parse(a.dateTime) || 0) - (Date.parse(b.dateTime) || 0));
  const last = (re) => [...byTime].reverse().find((e) => re.test(e.event));
  const fail = last(/fail/i);
  const defer = last(/defer/i);
  const sent = last(/^(send|deliver)/i);
  const telling = fail ?? defer ?? null;
  const detail = trim(telling?.description);
  return {
    expired: !!fail && (EXPIRED_RE.test(fail.description) || EXPIRED_RE.test(fail.data)),
    statusCode: CODE_RE.exec(telling ? `${telling.description} ${telling.data}` : '')?.[1] ?? null,
    detail,
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

async function nodeDomains() {
  const { rows } = await query('SELECT domain FROM mail_node_domains ORDER BY domain');
  return rows.map((row) => row.domain);
}

const UPSERT_SQL = `
  INSERT INTO mail_node_outage_letters (outage_id, trace_id, recipient, message_id, sender, subject, received_at, status, outcome,
                                        expired, status_code, detail, event_at, node_log, node_seen_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  ON CONFLICT (outage_id, trace_id, recipient) DO UPDATE SET
    message_id = EXCLUDED.message_id, sender = EXCLUDED.sender, subject = EXCLUDED.subject, received_at = EXCLUDED.received_at,
    status = EXCLUDED.status, outcome = EXCLUDED.outcome,
    expired = EXCLUDED.expired OR (mail_node_outage_letters.expired AND EXCLUDED.status = 'failed'),
    status_code = COALESCE(EXCLUDED.status_code, mail_node_outage_letters.status_code),
    detail = COALESCE(EXCLUDED.detail, mail_node_outage_letters.detail),
    event_at = COALESCE(EXCLUDED.event_at, mail_node_outage_letters.event_at),
    node_log = COALESCE(EXCLUDED.node_log, mail_node_outage_letters.node_log),
    node_seen_at = COALESCE(EXCLUDED.node_seen_at, mail_node_outage_letters.node_seen_at),
    updated_at = NOW()`;

// One window: list, sort, details within the budget, store. Returns the trace state kept with the
// window ({ checkedAt, complete, requests, counts, error }).
async function traceWindow(window, { source, domains, now, log, arrivals, budget }) {
  const start = Date.parse(window.started_at);
  const end = window.ended_at ? Date.parse(window.ended_at) : now;
  const listed = await source.list({
    start: start - TRACE_MARGIN_MS, end: Math.min(end + TRACE_MARGIN_MS, now), recipientDomains: domains, maxRequests: budget.left,
  });
  budget.left -= listed.requests;
  let requests = listed.requests;
  let complete = listed.complete;
  const { rows: stored } = await query('SELECT trace_id, recipient, outcome FROM mail_node_outage_letters WHERE outage_id = $1', [window.id]);
  const wasWaiting = new Set(stored.filter((r) => r.outcome === 'waiting').map((r) => `${r.trace_id}|${r.recipient}`));
  const keep = [];
  const drop = [];
  for (const row of listed.rows) {
    const outcome = outcomeOf(row, { start, end });
    if (!outcome) {
      if (row.status === 'quarantined' || row.status === 'filteredAsSpam') drop.push(row);
      continue;
    }
    let events = { expired: false, statusCode: null, detail: null, eventAt: null, deliveredAt: null };
    if (outcome === 'waiting' || outcome === 'lost') {
      if (budget.left > 0) {
        const got = await source.details(row);
        budget.left -= got.requests;
        requests += got.requests;
        events = readEvents(got.events);
      } else {
        complete = false;
      }
    }
    const at = Date.parse(row.receivedDateTime);
    if (outcome === 'lost' && (at < start || at > end) && !events.expired) {
      drop.push(row);
      continue;
    }
    const seen = nodeLogOf(row, log, arrivals);
    if (outcome === 'delayed') {
      const late = seen.nodeLog === 'seen' && Date.parse(seen.nodeSeenAt) - at > ON_TIME_MS;
      const onTime = seen.nodeLog === 'seen' && !late;
      const inside = at >= start && at <= end;
      if (onTime || (!inside && !late && !wasWaiting.has(`${row.id}|${row.recipientAddress}`))) {
        drop.push(row);
        continue;
      }
    }
    keep.push({ row, outcome, events, seen });
  }

  await withTransaction(async (client) => {
    for (const { row, outcome, events, seen } of keep) {
      await client.query(UPSERT_SQL, [
        window.id, row.id, row.recipientAddress, row.messageId, row.senderAddress || null, row.subject, row.receivedDateTime,
        row.status, outcome, events.expired, events.statusCode, events.detail, events.eventAt ?? events.deliveredAt, seen.nodeLog, seen.nodeSeenAt,
      ]);
    }
    for (const row of drop) {
      await client.query('DELETE FROM mail_node_outage_letters WHERE outage_id = $1 AND trace_id = $2 AND recipient = $3', [window.id, row.id, row.recipientAddress]);
    }
  });
  const { rows } = await query(
    'SELECT outcome, COUNT(*)::int AS n FROM mail_node_outage_letters WHERE outage_id = $1 GROUP BY outcome',
    [window.id],
  );
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, rows.find((r) => r.outcome === outcome)?.n ?? 0]));
  return { checkedAt: new Date(now).toISOString(), complete, requests, counts, error: null };
}

let running = null;

// One pass over the windows that are due: { connected, windows: [{ id, trace }] }. log: the alert
// job's read of the node's Postfix log ({ lines, oldestAt }), or null. force: every followed window,
// not only those due (an administrator's "Check the trace now"). Never runs twice at once: a call
// while a pass runs gets that pass.
export function runOutageTrace(options = {}) {
  if (running) return running;
  running = tracePass(options).finally(() => { running = null; });
  return running;
}

async function tracePass({ source = getTraceSource(), now = Date.now(), log = null, force = false } = {}) {
  await pruneOutageLetters(now);
  if (!source) return { connected: false, windows: [] };
  const { rows: windows } = await query(
    `SELECT * FROM mail_node_outages WHERE started_at <= $1 AND (ended_at IS NULL OR ended_at > $2) ORDER BY started_at`,
    [new Date(now).toISOString(), new Date(now - FOLLOW_MS).toISOString()],
  );
  const due = windows.filter((w) => force || !w.trace?.checkedAt || now - Date.parse(w.trace.checkedAt) >= RECHECK_MS);
  if (!due.length) return { connected: true, windows: [] };
  const domains = await nodeDomains();
  const parsedLog = log ? { lines: log.lines, oldest: log.oldestAt ? Date.parse(log.oldestAt) : null } : null;
  const arrivals = parsedLog ? nodeArrivals(parsedLog.lines) : new Map();
  const budget = { left: MAX_REQUESTS_PER_PASS };
  const done = [];
  for (const window of due) {
    let trace;
    if (!domains.length) {
      trace = { ...(window.trace ?? {}), checkedAt: new Date(now).toISOString(), error: 'no_domains' };
    } else if (budget.left <= 0) {
      continue;
    } else {
      try {
        trace = await traceWindow(window, { source, domains, now, log: parsedLog, arrivals, budget });
      } catch (err) {
        if (!err?.code) console.error('Outage trace pass failed:', err?.message || 'error');
        trace = { ...(window.trace ?? {}), checkedAt: new Date(now).toISOString(), error: err?.code || 'trace_failed' };
      }
    }
    await query('UPDATE mail_node_outages SET trace = $2, updated_at = NOW() WHERE id = $1', [window.id, trace]);
    done.push({ id: window.id, trace });
  }
  return { connected: true, windows: done };
}

// Deletes the letters older than the retention (by when EOP received them).
export async function pruneOutageLetters(now = Date.now()) {
  const { retentionDays } = await getOutageSettings();
  await query('DELETE FROM mail_node_outage_letters WHERE received_at < $1', [new Date(now - retentionDays * 24 * 60 * MINUTE_MS).toISOString()]);
}

// The letters still in EOP's queue that it has not given up on: { waiting, soonestExpiresAt }.
export async function waitingSummary(now = Date.now()) {
  const { rows } = await query(
    `SELECT COUNT(DISTINCT (trace_id, recipient))::int AS waiting, MIN(received_at) AS oldest
       FROM mail_node_outage_letters WHERE outcome = 'waiting' AND received_at > $1`,
    [new Date(now - EOP_EXPIRY_MS).toISOString()],
  );
  const oldest = rows[0]?.oldest;
  return {
    waiting: rows[0]?.waiting ?? 0,
    soonestExpiresAt: oldest ? new Date(Date.parse(new Date(oldest).toISOString()) + EOP_EXPIRY_MS).toISOString() : null,
  };
}

// The R-18 alert while letters wait in EOP's queue: a warning (named in the Healthchecks ping's
// body, never /fail): the node is back or not, but EOP gives up on them at soonestExpiresAt.
export function waitingSignal(summary) {
  if (!summary?.waiting) return [];
  return [{ key: 'outage_letters_waiting', severity: 'warning', details: { waiting: summary.waiting, soonestExpiresAt: summary.soonestExpiresAt } }];
}

const isoOf = (value) => (value ? new Date(value).toISOString() : null);

// A stored letter for the screens. withNode: the node log fields (administrators).
export function presentLetter(row, { withNode = false } = {}) {
  const received = isoOf(row.received_at);
  return {
    outageId: row.outage_id,
    recipient: row.recipient,
    sender: row.sender ?? null,
    subject: row.subject ?? null,
    receivedAt: received,
    outcome: row.outcome,
    status: row.status,
    expired: !!row.expired,
    expiresAt: row.outcome === 'waiting' && received ? new Date(Date.parse(received) + EOP_EXPIRY_MS).toISOString() : null,
    statusCode: row.status_code ?? null,
    ...(withNode ? {
      detail: row.detail ?? null, eventAt: isoOf(row.event_at), nodeLog: row.node_log ?? null, nodeSeenAt: isoOf(row.node_seen_at), messageId: row.message_id ?? null,
    } : {}),
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.started_at ? { outageStartedAt: isoOf(row.started_at), outageEndedAt: isoOf(row.ended_at) } : {}),
  };
}

// The letters of one window, every recipient and outcome (administrators).
export async function windowLetters(outageId) {
  const { rows } = await query(
    `SELECT * FROM mail_node_outage_letters WHERE outage_id = $1
      ORDER BY CASE outcome WHEN 'waiting' THEN 0 WHEN 'lost' THEN 1 WHEN 'delayed' THEN 2 ELSE 3 END, received_at`,
    [outageId],
  );
  return rows.map((row) => presentLetter(row, { withNode: true }));
}

// The letters of the panel's mailboxes (every signed-in user may open every mailbox,
// services/mailAccess.js): delayed, waiting or lost, matched by the mailbox's login address. A
// letter found in two windows (a detected one and a manual one over the same time) shows once, with
// its latest word. Recipients without a mailbox in the panel stay with the administrators' view.
export async function mailboxLetters() {
  const { rows } = await query(
    `SELECT DISTINCT ON (l.trace_id, l.recipient, a.id) l.*, a.id AS account_id, o.started_at, o.ended_at
       FROM mail_node_outage_letters l
       JOIN mail_node_outages o ON o.id = l.outage_id
       JOIN email_accounts a ON LOWER(a.email_address) = l.recipient
      WHERE l.outcome = ANY($1::text[])
      ORDER BY l.trace_id, l.recipient, a.id, l.updated_at DESC`,
    [USER_OUTCOMES],
  );
  return rows
    .map((row) => presentLetter(row))
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
}
