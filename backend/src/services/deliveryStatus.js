import { query, withTransaction } from './db.js';
import { correlateByQueueId, relayKind } from './mailNode/postfixLog.js';
import { explainDeliveryCode } from './mailNode/deliveryCodes.js';

// What became of a sent letter, per recipient (R-17): the table message_delivery_status (migration
// 0084) and the two ways it is filled.
// - The node's Postfix log, for letters of mailboxes on the mail node: the alert job's shared read
//   of the log (services/mailNode/nodeAlerts.js, every five minutes) passes through the letters the
//   journal shows sent (message.sent) over the last LOG_CAPTURE_DAYS, and opening a letter's
//   details looks once more through the same cached read. A letter is found by its Message-ID (the
//   cleanup line message-id=), and only in a queue entry whose envelope sender is the mailbox or one
//   of its aliases, so no other letter's lines are ever taken; its delivery lines give the state,
//   the relay, the remote reply, the TLS of the connection and EOP's acceptance id.
// - Delivery status notifications that come back to the mailbox (services/deliveryReport.js), for
//   any mailbox.
// The outcome stays when the log no longer covers the letter or the report is deleted.

export const LOG_CAPTURE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const PID_TLS_WINDOW_MS = 300 * 1000;
// Long enough for a sentence of a remote server, short enough that a report quoting a whole
// letter does not end up in the table.
export const DIAGNOSTIC_MAX = 300;

export const DELIVERY_STATES = Object.freeze(['sent', 'deferred', 'bounced', 'expired', 'failed', 'delayed']);
// Not delivered: the log's bounced and expired, a report's failed. Delayed: the log's deferred, a
// report's delayed. sent means handed over to the next server (EOP), not read by the recipient.
export const FAILED_STATES = Object.freeze(['bounced', 'expired', 'failed']);
export const DELAYED_STATES = Object.freeze(['deferred', 'delayed']);
const LOG_STATES = new Set(['sent', 'deferred', 'bounced']);

// The per-letter mark of a list row: 'failed' when any recipient was not delivered, 'delayed' when
// any is delayed, else null. A scalar subquery on the table's primary key; alias: the messages
// table's alias in the caller's query.
export function deliveryStateColumn(alias = 'm') {
  return `(SELECT CASE
             WHEN bool_or(ds.state IN ('bounced', 'expired', 'failed')) THEN 'failed'
             WHEN bool_or(ds.state IN ('deferred', 'delayed')) THEN 'delayed'
           END
      FROM message_delivery_status ds
     WHERE ds.account_id = ${alias}.account_id AND ds.message_id = ${alias}.message_id)`;
}

// Whitespace folded, cut to DIAGNOSTIC_MAX characters.
export function trimDiagnostic(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > DIAGNOSTIC_MAX ? `${flat.slice(0, DIAGNOSTIC_MAX - 1)}…` : flat;
}

// EOP's acceptance in a 250 reply: "250 2.6.0 <message-id> [InternalId=<n>, Hostname=<server>] ...
// Queued mail for delivery" -> { messageId, internalId, hostname }; the stand's older fake-EOP
// answered without Hostname. Null for any other reply.
export function acceptanceOf(text) {
  const match = /(?:^|\s)250[ -]2\.6\.0 (<[^<>\s]+>)? ?\[InternalId=(\d+)(?:, Hostname=([^\]\s,]+))?[^\]]*\]/.exec(String(text ?? ''));
  if (!match) return null;
  return { messageId: match[1] ?? null, internalId: match[2], hostname: match[3] ?? null };
}

// The TLS line of the connection a delivery line went over, from the log's smtp client lines:
// { level, protocol, cipher, bits, matchedBy } or null ("not in the log").
// - matchedBy 'pid': the same smtp process, the nearest TLS line before the delivery to the same
//   host[ip]:port (only when the log carries process ids);
// - matchedBy 'time': mailcow's log has no process ids, so the nearest TLS line before the delivery
//   to the same host[ip]:port within the time the delivery itself spent setting up the connection
//   and sending (delays= c + d, rounded up, plus a second for the log's whole seconds). A delivery
//   over a connection Postfix reused has no TLS line of its own in that window: null, never a
//   guess from the TLS policy.
// lines: the parsed log (oldest first); at: the delivery line's index in it.
export function tlsForDelivery(lines, at) {
  const delivery = lines[at];
  if (!delivery?.relayHost || delivery.epoch == null) return null;
  const spent = (delivery.delays?.[2] ?? 0) + (delivery.delays?.[3] ?? 0);
  // With a process id the TLS line may be older (a connection the same process kept open), but
  // never older than Postfix keeps a connection for reuse (smtp_connection_reuse_time_limit).
  const from = delivery.epoch - (delivery.pid != null ? PID_TLS_WINDOW_MS : (Math.ceil(spent) + 1) * 1000);
  for (let i = at - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.epoch != null && line.epoch < from) break;
    const tls = line.tls;
    if (!tls || tls.host !== delivery.relayHost || tls.ip !== delivery.relayIp || tls.port !== delivery.relayPort) continue;
    if (delivery.pid != null) {
      if (line.pid !== delivery.pid) continue;
      return { level: tls.level, protocol: tls.protocol, cipher: tls.cipher, bits: tls.bits, matchedBy: 'pid' };
    }
    return { level: tls.level, protocol: tls.protocol, cipher: tls.cipher, bits: tls.bits, matchedBy: 'time' };
  }
  return null;
}

// The outcomes the log shows for one queued letter (an entry of correlateByQueueId), per recipient,
// the last delivery line winning: [{ recipient, state, at, statusCode, diagnostic, details }].
// details: { queueId, relayHost, relayIp, relayPort, relayKind, reply, tls, acceptance }. An
// expired line (qmgr gave up; it names no recipient) turns every recipient still deferred into
// expired. indexOf: line -> its index in lines; eopHost: for relayKind.
export function logOutcomes(entry, lines, indexOf, { eopHost = null } = {}) {
  const byRecipient = new Map();
  for (const line of entry.deliveries) {
    if (line.event === 'expired') {
      for (const outcome of byRecipient.values()) {
        if (outcome.state !== 'deferred') continue;
        outcome.state = 'expired';
        outcome.at = line.at ?? outcome.at;
      }
      continue;
    }
    if (!LOG_STATES.has(line.event) || !line.to) continue;
    const text = line.reply ?? line.statusText;
    byRecipient.set(line.to, {
      recipient: line.to,
      state: line.event,
      at: line.at,
      statusCode: line.dsn,
      diagnostic: line.event === 'sent' ? null : trimDiagnostic(text),
      details: {
        queueId: entry.queueId,
        relayHost: line.relayHost,
        relayIp: line.relayIp,
        relayPort: line.relayPort,
        relayKind: relayKind(line, { eopHost }),
        reply: trimDiagnostic(text),
        tls: indexOf.has(line) ? tlsForDelivery(lines, indexOf.get(line)) : null,
        acceptance: line.event === 'sent' ? acceptanceOf(line.statusText) : null,
      },
    });
  }
  return [...byRecipient.values()];
}

const time = (value) => (value ? Date.parse(value) : Number.NEGATIVE_INFINITY);

// JSON with object keys sorted: jsonb hands keys back in its own order, and an unchanged outcome
// must compare equal to what was stored.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// One recipient's row after an outcome of one source (pure): { row, changed }. row: the table's
// fields { state, source, statusCode, diagnostic, eventAt, log, report }; existing: the row before
// (null for none); incoming: { source: 'log' | 'dsn', state, at, statusCode, diagnostic, details }.
// Each source keeps its latest outcome (an older one of the same source is ignored); the winner is
// the later of the two, a failure winning a tie, else the log.
export function mergeOutcome(existing, incoming) {
  const own = {
    state: incoming.state, at: incoming.at ?? null, statusCode: incoming.statusCode ?? null,
    diagnostic: incoming.diagnostic ?? null, ...(incoming.details ?? {}),
  };
  const field = incoming.source === 'log' ? 'log' : 'report';
  const before = existing?.[field] ?? null;
  if (before && time(before.at) > time(own.at)) return { row: existing, changed: false };
  const next = { log: existing?.log ?? null, report: existing?.report ?? null, [field]: own };
  if (before && stable(before) === stable(own)) return { row: existing, changed: false };
  const failed = (o) => FAILED_STATES.includes(o.state);
  let winner = next.log ? 'log' : 'report';
  if (next.log && next.report) {
    const logAt = time(next.log.at);
    const reportAt = time(next.report.at);
    if (reportAt > logAt || (reportAt === logAt && failed(next.report) && !failed(next.log))) winner = 'report';
  }
  const won = next[winner];
  return {
    row: {
      state: won.state,
      source: winner === 'log' ? 'log' : 'dsn',
      statusCode: won.statusCode ?? null,
      diagnostic: won.diagnostic ?? null,
      eventAt: won.at ?? null,
      log: next.log,
      report: next.report,
    },
    changed: true,
  };
}

const fromRow = (row) => ({
  recipient: row.recipient, state: row.state, source: row.source, statusCode: row.status_code,
  diagnostic: row.diagnostic, eventAt: row.event_at ? new Date(row.event_at).toISOString() : null,
  log: row.log, report: row.report,
});

// Writes the outcomes of one letter of one mailbox; returns how many rows changed. One transaction
// under an advisory lock on the letter, so the alert job and an opened letter never merge over each
// other's write.
export async function recordOutcomes(accountId, messageId, source, outcomes) {
  if (!accountId || !messageId || !outcomes.length) return 0;
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delivery:${accountId}:${messageId}`]);
    const { rows } = await client.query(
      'SELECT * FROM message_delivery_status WHERE account_id = $1 AND message_id = $2', [accountId, messageId],
    );
    const existing = new Map(rows.map((row) => [row.recipient, fromRow(row)]));
    let changed = 0;
    for (const outcome of outcomes) {
      const recipient = String(outcome.recipient ?? '').trim().toLowerCase();
      if (!recipient || !DELIVERY_STATES.includes(outcome.state)) continue;
      const merged = mergeOutcome(existing.get(recipient) ?? null, { ...outcome, source });
      if (!merged.changed) continue;
      const r = merged.row;
      await client.query(`
        INSERT INTO message_delivery_status
          (account_id, message_id, recipient, state, source, status_code, diagnostic, event_at, log, report)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (account_id, message_id, recipient) DO UPDATE SET
          state = EXCLUDED.state, source = EXCLUDED.source, status_code = EXCLUDED.status_code,
          diagnostic = EXCLUDED.diagnostic, event_at = EXCLUDED.event_at, log = EXCLUDED.log,
          report = EXCLUDED.report, updated_at = NOW()`,
      [accountId, messageId, recipient, r.state, r.source, r.statusCode, r.diagnostic, r.eventAt,
        r.log ? JSON.stringify(r.log) : null, r.report ? JSON.stringify(r.report) : null]);
      existing.set(recipient, { recipient, ...r });
      changed += 1;
    }
    return changed;
  });
}

export async function readOutcomes(accountId, messageId) {
  const { rows } = await query(
    'SELECT * FROM message_delivery_status WHERE account_id = $1 AND message_id = $2 ORDER BY recipient',
    [accountId, messageId],
  );
  return rows.map(fromRow);
}

// A mailbox's own addresses (login and aliases), lower case.
async function addressesOf(accountIds) {
  const { rows } = await query(`
    SELECT id AS account_id, lower(btrim(email_address)) AS address FROM email_accounts WHERE id = ANY($1::uuid[])
    UNION SELECT account_id, lower(btrim(email)) FROM account_aliases WHERE account_id = ANY($1::uuid[])`, [accountIds]);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.account_id)) map.set(row.account_id, new Set());
    map.get(row.account_id).add(row.address);
  }
  return map;
}

// The log, prepared once for any number of letters: queued letters by Message-ID, and each line's
// index (for the TLS lines before a delivery).
export function indexLog(lines) {
  const byMessageId = new Map();
  for (const entry of correlateByQueueId(lines).values()) {
    if (!entry.messageId) continue;
    if (!byMessageId.has(entry.messageId)) byMessageId.set(entry.messageId, []);
    byMessageId.get(entry.messageId).push(entry);
  }
  const indexOf = new Map(lines.map((line, i) => [line, i]));
  return { lines, byMessageId, indexOf };
}

// The log's outcomes of one letter of a mailbox: every queue entry with its Message-ID whose
// envelope sender is one of the mailbox's addresses.
export function letterOutcomes(index, messageId, addresses, { eopHost = null } = {}) {
  const entries = (index.byMessageId.get(messageId) ?? []).filter((entry) => entry.from && addresses.has(entry.from));
  return entries.flatMap((entry) => logOutcomes(entry, index.lines, index.indexOf, { eopHost }));
}

// The alert job's pass (services/mailNode/nodeAlerts.js): the letters the journal shows sent by
// mailboxes on this node over the last LOG_CAPTURE_DAYS, looked up in the log already read.
// Returns { letters (found in the log), changed (rows written) }.
export async function captureFromLog({ cfg, log, eopHost = null, now = Date.now() }) {
  const { rows: sent } = await query(`
    SELECT DISTINCT l.account_id, l.details->>'messageId' AS message_id
      FROM mailbox_audit_log l
      JOIN email_accounts a ON a.id = l.account_id
     WHERE l.action = 'message.sent' AND l.occurred_at >= $1
       AND a.mail_node AND lower(btrim(a.imap_host)) = $2
       AND l.details->>'messageId' IS NOT NULL`, [new Date(now - LOG_CAPTURE_DAYS * DAY_MS), cfg.mailHost]);
  const index = indexLog(log.lines);
  const inLog = sent.filter((row) => index.byMessageId.has(row.message_id));
  if (!inLog.length) return { letters: 0, changed: 0 };
  const addresses = await addressesOf([...new Set(inLog.map((row) => row.account_id))]);
  let letters = 0;
  let changed = 0;
  for (const row of inLog) {
    const outcomes = letterOutcomes(index, row.message_id, addresses.get(row.account_id) ?? new Set(), { eopHost });
    if (!outcomes.length) continue;
    letters += 1;
    changed += await recordOutcomes(row.account_id, row.message_id, 'log', outcomes);
  }
  return { letters, changed };
}

// Looks one letter up in the log already read and records what it shows: { found }.
export async function captureLetter({ accountId, messageId, log, eopHost = null }) {
  const addresses = (await addressesOf([accountId])).get(accountId) ?? new Set();
  const outcomes = letterOutcomes(indexLog(log.lines), messageId, addresses, { eopHost });
  if (outcomes.length) await recordOutcomes(accountId, messageId, 'log', outcomes);
  return { found: outcomes.length > 0 };
}

// When the letter was sent, for "does the log still cover it": the journal's first message.sent
// of it in the mailbox, else the letter's own date.
export async function sentAtOf(accountId, messageId, fallback = null) {
  const { rows } = await query(`
    SELECT MIN(occurred_at) AS at FROM mailbox_audit_log
     WHERE action = 'message.sent' AND account_id = $1 AND details->>'messageId' = $2`, [accountId, messageId]);
  const at = rows[0]?.at ?? fallback;
  return at ? new Date(at).toISOString() : null;
}

// What the screens get for one recipient: the stored row with the code explained.
export function presentOutcome(row) {
  const text = row.diagnostic ?? row.report?.diagnostic ?? row.log?.reply ?? '';
  return {
    recipient: row.recipient,
    state: row.state,
    source: row.source,
    at: row.eventAt,
    statusCode: row.statusCode,
    diagnostic: row.diagnostic,
    explanation: row.state === 'sent' ? null : explainDeliveryCode({ code: row.statusCode, text }),
    log: row.log,
    report: row.report,
  };
}

// The log's coverage of one letter: 'found' (this read shows it), 'stored' (an earlier read did;
// the log no longer shows it), 'gone' (never seen, and the log no longer reaches back to when it
// was sent), 'not_found' (the log reaches back that far but shows nothing of it).
export function logCoverage({ found, stored, sentAt, oldestAt }) {
  if (found) return 'found';
  if (stored) return 'stored';
  if (sentAt && oldestAt && Date.parse(sentAt) < Date.parse(oldestAt)) return 'gone';
  return 'not_found';
}
