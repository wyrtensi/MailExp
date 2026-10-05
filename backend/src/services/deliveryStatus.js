import { query, withTransaction } from './db.js';
import { correlateByQueueId, relayKind } from './mailNode/postfixLog.js';
import { explainDeliveryCode } from './mailNode/deliveryCodes.js';

// What became of a sent letter, per recipient (R-17): the table message_delivery_status (migration
// 0084) and the two ways it is filled. Only letters the mailbox itself sent are ever looked up or
// marked (sentLetterOf): one the panel's journal shows sent from it (message.sent), or a copy in
// its Sent folder from its own login address. A received letter, a letter of another mailbox or
// one a user only claims through an alias gets nothing.
// - The node's Postfix log, for letters of mailboxes on the mail node: the alert job's shared read
//   of the log (services/mailNode/nodeAlerts.js, every five minutes) passes through the letters the
//   journal shows sent over the last LOG_CAPTURE_DAYS, and opening a letter's details looks once
//   more through the same cached read. A letter is found by its Message-ID (the cleanup line
//   message-id=) in a queue entry the mailbox itself queued (ownEntries: the login it submitted with,
//   sasl_username, else the envelope sender equal to its login address; aliases of the panel are not
//   trusted, anyone can add one). A letter that stays deferred keeps its queue id, so its later lines
//   are found by the queue id once the cleanup line has left the log (Postfix re-logs from= on each
//   attempt, so the sender is checked again). Its delivery lines give the state, the relay, the
//   remote reply, the TLS of the connection and EOP's acceptance id.
// - Delivery status notifications that come back to the mailbox (services/deliveryReport.js), for
//   any mailbox.
// - The mailbox's own outgoing server refusing a recipient at RCPT while it took the letter for the
//   others (services/sendDelivery.js, source 'submission'), for any mailbox: failed, with the
//   server's reply. The letter never left for that recipient, so this is the last word.
// The outcome stays when the log no longer covers the letter or the report is deleted. A delay with
// no news for DELAY_STALE_MS (Postfix's queue lifetime of five days plus a day) is no longer marked
// in the list and reads "outcome unknown"; a deferred letter whose queue entry left the queue
// without a final line (an administrator deleted it) reads the same.

export const LOG_CAPTURE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DELAY_STALE_MS = 6 * DAY_MS;
const PID_TLS_WINDOW_MS = 300 * 1000;
// How far apart the clocks of a remote reporting server and the node may be for "the report is the
// later word" (only between two outcomes that are not failures).
const CLOCK_SKEW_MS = 2 * 60 * 1000;
// Long enough for a sentence of a remote server, short enough that a report quoting a whole
// letter does not end up in the table.
export const DIAGNOSTIC_MAX = 300;

// unknown: the letter left the node's queue while deferred and the log shows no final line.
export const DELIVERY_STATES = Object.freeze(['sent', 'deferred', 'bounced', 'expired', 'failed', 'delayed', 'unknown']);
// Not delivered: the log's bounced and expired, a report's failed. Delayed: the log's deferred, a
// report's delayed. sent means handed over to the next server (EOP), not read by the recipient.
export const FAILED_STATES = Object.freeze(['bounced', 'expired', 'failed']);
export const DELAYED_STATES = Object.freeze(['deferred', 'delayed']);
const LOG_STATES = new Set(['sent', 'deferred', 'bounced']);

// Whether a messages row (alias m, its account a) is in the mailbox's Sent folder: the folder
// mapping, else the folder IMAP marks \Sent (frontend utils/mailboxBanner.js isSentFolder).
export function sentCopyCondition(m = 'm', a = 'a') {
  return `(${m}.folder = ${a}.folder_mappings->>'sent'
      OR (COALESCE(${a}.folder_mappings->>'sent', '') = ''
          AND EXISTS (SELECT 1 FROM folders sf WHERE sf.account_id = ${m}.account_id AND sf.path = ${m}.folder AND sf.special_use = '\\Sent')))`;
}

// The per-letter mark of a list row: 'failed' when any recipient was not delivered, 'delayed' when
// any is delayed and there was news of it within DELAY_STALE_MS, else null. Only the copy in the
// Sent folder is marked (a letter sent to the mailbox itself also lies in its Inbox). A scalar
// subquery on the table's primary key; m: the messages alias, a: the email_accounts alias.
export function deliveryStateColumn(m = 'm', a = 'a') {
  return `(CASE WHEN ${sentCopyCondition(m, a)} THEN (SELECT CASE
             WHEN bool_or(ds.state IN ('bounced', 'expired', 'failed')) THEN 'failed'
             WHEN bool_or(ds.state IN ('deferred', 'delayed')
                          AND COALESCE(ds.event_at, ds.updated_at) > NOW() - interval '${DELAY_STALE_MS / DAY_MS} days') THEN 'delayed'
           END
      FROM message_delivery_status ds
     WHERE ds.account_id = ${m}.account_id AND ds.message_id = ${m}.message_id) END)`;
}

// Whitespace folded, cut to DIAGNOSTIC_MAX characters.
export function trimDiagnostic(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > DIAGNOSTIC_MAX ? `${flat.slice(0, DIAGNOSTIC_MAX - 1)}…` : flat;
}

// The address of "Name <a@b>" or "a@b", lower case; null without an @.
export function addressOf(value) {
  const text = String(value ?? '').trim();
  const angle = /<([^<>]*)>\s*$/.exec(text);
  const address = (angle ? angle[1] : text).trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return at > 0 && at < address.length - 1 ? address : null;
}

// EOP's acceptance in a 250 reply: "250 2.6.0 <message-id> [InternalId=<n>, Hostname=<server>] ...
// Queued mail for delivery" -> { messageId, internalId, hostname }; the stand's older fake-EOP
// answered without Hostname. Null for any other reply.
export function acceptanceOf(text) {
  const match = /(?:^|\s)250[ -]2\.6\.0 (<[^<>\s]+>)? ?\[InternalId=(\d+)(?:, Hostname=([^\]\s,]+))?[^\]]*\]/.exec(String(text ?? ''));
  if (!match) return null;
  return { messageId: match[1] ?? null, internalId: match[2], hostname: match[3] ?? null };
}

const tlsOf = (tls, matchedBy) => ({ level: tls.level, protocol: tls.protocol, cipher: tls.cipher, bits: tls.bits, matchedBy });

// The TLS line of the connection a delivery line went over, from the log's smtp client lines:
// { level, protocol, cipher, bits, matchedBy } or null ("not in the log").
// - matchedBy 'pid': the same smtp process, the nearest TLS line before the delivery to the same
//   host[ip]:port (only when the log carries process ids);
// - matchedBy 'time': mailcow's log has no process ids, so the TLS line to the same host[ip]:port
//   within the time the delivery itself spent setting up the connection and sending (delays= c + d,
//   rounded up, plus a second for the log's whole seconds), and only when exactly one such line is
//   in that window: every letter goes to the same EOP host, so two connections at once could be
//   told apart only by guessing, and a connection that fell back to plain text must never borrow
//   another's TLS. A delivery over a connection Postfix reused has no TLS line of its own: null,
//   never a guess from the TLS policy.
// lines: the parsed log (oldest first); at: the delivery line's index in it.
export function tlsForDelivery(lines, at) {
  const delivery = lines[at];
  if (!delivery?.relayHost || delivery.epoch == null) return null;
  const spent = (delivery.delays?.[2] ?? 0) + (delivery.delays?.[3] ?? 0);
  // With a process id the TLS line may be older (a connection the same process kept open), but
  // never older than Postfix keeps a connection for reuse (smtp_connection_reuse_time_limit).
  const from = delivery.epoch - (delivery.pid != null ? PID_TLS_WINDOW_MS : (Math.ceil(spent) + 1) * 1000);
  const found = [];
  for (let i = at - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.epoch != null && line.epoch < from) break;
    const tls = line.tls;
    if (!tls || tls.host !== delivery.relayHost || tls.ip !== delivery.relayIp || tls.port !== delivery.relayPort) continue;
    if (delivery.pid != null) {
      if (line.pid === delivery.pid) return tlsOf(tls, 'pid');
      continue;
    }
    found.push(tls);
  }
  return found.length === 1 ? tlsOf(found[0], 'time') : null;
}

// The outcomes the log shows for one queued letter (an entry of correlateByQueueId), per recipient,
// the last delivery line winning: [{ recipient, state, at, statusCode, diagnostic, details }].
// recipient: the address as the sender wrote it (orig_to when Postfix logged one, else to=).
// details: { queueId, sender, finalRecipient, relayHost, relayIp, relayPort, relayKind (eop, local,
// discard or other), reply, tls, acceptance, leftQueue }. An expired line (qmgr gave up; it names
// no recipient) turns every recipient still deferred into expired; a letter removed from the queue
// (an administrator deleted it) with a recipient still deferred turns it into unknown.
// seed: recipient -> the stored deferred outcome, for a letter found by its stored queue id whose
// earlier lines have left the log. indexOf: line -> its index in lines; eopHost: for relayKind.
export function logOutcomes(entry, lines, indexOf, { eopHost = null, seed = null } = {}) {
  const byRecipient = new Map();
  const seeded = (recipient) => {
    const stored = seed?.get(recipient);
    if (!stored?.log) return null;
    const { state, at, statusCode, diagnostic, ...details } = stored.log;
    return { recipient, state, at, statusCode, diagnostic, details, seeded: true };
  };
  for (const recipient of seed?.keys() ?? []) byRecipient.set(recipient, seeded(recipient));
  const removedLine = entry.lines.find((line) => line.event === 'removed' || line.event === 'deleted');
  for (const line of entry.deliveries) {
    if (line.event === 'expired') {
      for (const outcome of byRecipient.values()) {
        if (!outcome || outcome.state !== 'deferred') continue;
        outcome.state = 'expired';
        outcome.at = line.at ?? outcome.at;
        outcome.seeded = false;
      }
      continue;
    }
    if (!LOG_STATES.has(line.event) || !line.to) continue;
    const text = line.reply ?? line.statusText;
    const recipient = line.origTo || line.to;
    byRecipient.set(recipient, {
      recipient,
      state: line.event,
      at: line.at,
      statusCode: line.dsn,
      diagnostic: line.event === 'sent' ? null : trimDiagnostic(text),
      details: {
        queueId: entry.queueId,
        sender: entry.from,
        finalRecipient: line.to !== recipient ? line.to : null,
        relayHost: line.relayHost,
        relayIp: line.relayIp,
        relayPort: line.relayPort,
        relayKind: line.service === 'discard' ? 'discard' : relayKind(line, { eopHost }),
        reply: trimDiagnostic(text),
        tls: indexOf.has(line) ? tlsForDelivery(lines, indexOf.get(line)) : null,
        acceptance: line.event === 'sent' ? acceptanceOf(line.statusText) : null,
      },
    });
  }
  if (removedLine) {
    for (const outcome of byRecipient.values()) {
      if (!outcome || outcome.state !== 'deferred') continue;
      // The deferred time itself, never the removal time: a final line found later still wins.
      outcome.state = 'unknown';
      outcome.details = { ...outcome.details, leftQueue: true };
      outcome.seeded = false;
    }
  }
  return [...byRecipient.values()].filter((outcome) => outcome && !outcome.seeded).map((outcome) => {
    const copy = { ...outcome };
    delete copy.seeded;
    return copy;
  });
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

const isFailed = (o) => FAILED_STATES.includes(o.state);

// The row's field that keeps each source's own details.
const FIELD_OF_SOURCE = Object.freeze({ log: 'log', dsn: 'report', submission: 'submission' });
const SOURCE_OF_FIELD = Object.freeze({ log: 'log', report: 'dsn', submission: 'submission' });

// Which source's outcome a row shows: a refusal at submission whenever there is one (the letter
// never left for that recipient, so nothing later can be about it); else a failure wins over what is not one (a non-delivery report
// Microsoft sends after accepting the letter beats the log's "sent", whatever the two clocks say;
// the node's own bounce wins over a report's delay); between two failures the log (it has the
// relay and the reply); otherwise the later, the report winning unless it is clearly older than the
// log line (clock skew) and a report without a time counting as the latest word.
function winnerOf(log, report, submission = null) {
  if (submission) return 'submission';
  if (!log) return 'report';
  if (!report) return 'log';
  if (isFailed(log) !== isFailed(report)) return isFailed(report) ? 'report' : 'log';
  if (isFailed(log)) return 'log';
  if (!report.at) return 'report';
  return time(report.at) >= time(log.at) - CLOCK_SKEW_MS ? 'report' : 'log';
}

// One recipient's row after an outcome of one source (pure): { row, changed }. row: the table's
// fields { state, source, statusCode, diagnostic, eventAt, log, report, submission }; existing: the
// row before (null for none); incoming: { source: 'log' | 'dsn' | 'submission', state, at,
// statusCode, diagnostic, details }. Each source keeps its latest outcome: an older log line is
// ignored (one clock); a report or a refusal at submission replaces an older one, and one without a
// time replaces any. For the same log line seen again, the TLS
// and the acceptance already found are kept when this read no longer shows them.
export function mergeOutcome(existing, incoming) {
  let own = {
    state: incoming.state, at: incoming.at ?? null, statusCode: incoming.statusCode ?? null,
    diagnostic: incoming.diagnostic ?? null, ...(incoming.details ?? {}),
  };
  const field = FIELD_OF_SOURCE[incoming.source] ?? 'report';
  const before = existing?.[field] ?? null;
  if (before) {
    const older = field === 'log' ? time(before.at) > time(own.at) : !!(own.at && before.at && time(before.at) > time(own.at));
    if (older) return { row: existing, changed: false };
    if (before.at && before.at === own.at) {
      own = { ...own };
      if (own.tls == null && before.tls != null) own.tls = before.tls;
      if (own.acceptance == null && before.acceptance != null) own.acceptance = before.acceptance;
    }
    if (stable(before) === stable(own)) return { row: existing, changed: false };
  }
  const next = {
    log: existing?.log ?? null, report: existing?.report ?? null, submission: existing?.submission ?? null, [field]: own,
  };
  const winner = winnerOf(next.log, next.report, next.submission);
  const won = next[winner];
  return {
    row: {
      state: won.state,
      source: SOURCE_OF_FIELD[winner],
      statusCode: won.statusCode ?? null,
      diagnostic: won.diagnostic ?? null,
      eventAt: won.at ?? null,
      log: next.log,
      report: next.report,
      ...(next.submission ? { submission: next.submission } : {}),
    },
    changed: true,
  };
}

const fromRow = (row) => ({
  recipient: row.recipient, state: row.state, source: row.source, statusCode: row.status_code,
  diagnostic: row.diagnostic, eventAt: row.event_at ? new Date(row.event_at).toISOString() : null,
  log: row.log, report: row.report, ...(row.submission ? { submission: row.submission } : {}),
});

const normalized = (outcome) => ({ ...outcome, recipient: String(outcome.recipient ?? '').trim().toLowerCase() });

// Whether any of the outcomes would change the stored rows (existing: recipient -> row).
export function wouldChange(existing, source, outcomes) {
  return outcomes.map(normalized).some((outcome) => outcome.recipient && DELIVERY_STATES.includes(outcome.state)
    && mergeOutcome(existing.get(outcome.recipient) ?? null, { ...outcome, source }).changed);
}

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
    for (const outcome of outcomes.map(normalized)) {
      const { recipient } = outcome;
      if (!recipient || !DELIVERY_STATES.includes(outcome.state)) continue;
      const merged = mergeOutcome(existing.get(recipient) ?? null, { ...outcome, source });
      if (!merged.changed) continue;
      const r = merged.row;
      await client.query(`
        INSERT INTO message_delivery_status
          (account_id, message_id, recipient, state, source, status_code, diagnostic, event_at, log, report, submission)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (account_id, message_id, recipient) DO UPDATE SET
          state = EXCLUDED.state, source = EXCLUDED.source, status_code = EXCLUDED.status_code,
          diagnostic = EXCLUDED.diagnostic, event_at = EXCLUDED.event_at, log = EXCLUDED.log,
          report = EXCLUDED.report, submission = EXCLUDED.submission, updated_at = NOW()`,
      [accountId, messageId, recipient, r.state, r.source, r.statusCode, r.diagnostic, r.eventAt,
        r.log ? JSON.stringify(r.log) : null, r.report ? JSON.stringify(r.report) : null,
        r.submission ? JSON.stringify(r.submission) : null]);
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

// The stored rows of several letters at once: Map "account|message-id" -> Map recipient -> row.
async function readOutcomesOf(letters) {
  const out = new Map();
  if (!letters.length) return out;
  const { rows } = await query(`
    SELECT ds.* FROM message_delivery_status ds
      JOIN unnest($1::uuid[], $2::text[]) AS l(account_id, message_id)
        ON ds.account_id = l.account_id AND ds.message_id = l.message_id`,
  [letters.map((l) => l.account_id), letters.map((l) => l.message_id)]);
  for (const row of rows) {
    const key = `${row.account_id}|${row.message_id}`;
    if (!out.has(key)) out.set(key, new Map());
    out.get(key).set(row.recipient, fromRow(row));
  }
  return out;
}

// Whether the mailbox sent this letter: { owned, sentAt, recipients, bccOnly, authorId }. owned: the panel's journal
// shows it sent from the mailbox (message.sent with this Message-ID), or a copy lies in the
// mailbox's Sent folder from its own login address. recipients: the journal's To, Cc and Bcc (a
// Set of addresses), null when only a Sent copy says so (a copy made outside the panel has no Bcc).
// sentAt: the journal's time, else the copy's date. bccOnly: the journal's addresses that were in
// Bcc and not in To or Cc (a Set, empty without the journal); authorId: who sent it (the journal's
// actor), null without the journal.
export async function sentLetterOf(accountId, messageId) {
  const none = { owned: false, sentAt: null, recipients: null, bccOnly: new Set(), authorId: null };
  if (!accountId || !messageId) return none;
  const { rows: journal } = await query(`
    SELECT details, occurred_at, actor_user_id FROM mailbox_audit_log
     WHERE action = 'message.sent' AND account_id = $1 AND details->>'messageId' = $2
     ORDER BY occurred_at LIMIT 1`, [accountId, messageId]);
  if (journal.length) {
    const d = journal[0].details ?? {};
    const lists = [d.to, d.cc, d.bcc].filter(Array.isArray);
    const recipients = lists.length ? new Set(lists.flat().map(addressOf).filter(Boolean)) : null;
    const open = new Set([d.to, d.cc].filter(Array.isArray).flat().map(addressOf).filter(Boolean));
    const bccOnly = new Set((Array.isArray(d.bcc) ? d.bcc : []).map(addressOf).filter((a) => a && !open.has(a)));
    return {
      owned: true, sentAt: new Date(journal[0].occurred_at).toISOString(), recipients, bccOnly,
      authorId: journal[0].actor_user_id ?? null,
    };
  }
  const { rows: copies } = await query(`
    SELECT m.date FROM messages m JOIN email_accounts a ON a.id = m.account_id
     WHERE m.account_id = $1 AND m.message_id = $2 AND m.is_deleted = false
       AND lower(btrim(m.from_email)) = lower(btrim(a.email_address))
       AND ${sentCopyCondition('m', 'a')}
     ORDER BY m.date LIMIT 1`, [accountId, messageId]);
  if (!copies.length) return none;
  return { ...none, owned: true, sentAt: copies[0].date ? new Date(copies[0].date).toISOString() : null };
}

// The log, prepared once per read for any number of letters: queued letters by Message-ID and by
// queue id, and each line's index (for the TLS lines before a delivery). Kept with the read itself
// (the same lines array serves every caller of the cached read).
const indexCache = new WeakMap();
export function indexLog(lines) {
  const cached = indexCache.get(lines);
  if (cached) return cached;
  const byQueueId = correlateByQueueId(lines);
  const byMessageId = new Map();
  for (const entry of byQueueId.values()) {
    if (!entry.messageId) continue;
    if (!byMessageId.has(entry.messageId)) byMessageId.set(entry.messageId, []);
    byMessageId.get(entry.messageId).push(entry);
  }
  const index = { lines, byMessageId, byQueueId, indexOf: new Map(lines.map((line, i) => [line, i])) };
  indexCache.set(lines, index);
  return index;
}

// The queue entries of a Message-ID the mailbox itself queued: those submitted with its login
// (sasl_username) when the log shows any; else, with no login logged at all, those whose envelope
// sender is its login address. Never by the panel's aliases: anyone can add one. A copy a Sieve rule
// redirected keeps the Message-ID and the original sender but has no login, so it is left out when
// the submission is in the log.
export function ownEntries(entries, login) {
  const bySasl = entries.filter((entry) => entry.saslUsername === login);
  if (bySasl.length) return bySasl;
  return entries.filter((entry) => !entry.saslUsername && entry.from === login);
}

// The log's outcomes of one letter of a mailbox: the entries ownEntries finds by its Message-ID,
// and those of the queue ids its stored rows still wait on (a deferred letter whose cleanup line has
// left the log): such an entry must name no other Message-ID and have the same envelope sender as
// before. stored: recipient -> stored row (or empty).
export function letterOutcomes(index, messageId, login, { eopHost = null, stored = new Map() } = {}) {
  const entries = ownEntries(index.byMessageId.get(messageId) ?? [], login);
  const seen = new Set(entries.map((entry) => entry.queueId));
  const waiting = new Map();
  for (const [recipient, row] of stored) {
    if (row.state !== 'deferred' || row.source !== 'log' || !row.log?.queueId) continue;
    if (!waiting.has(row.log.queueId)) waiting.set(row.log.queueId, new Map());
    waiting.get(row.log.queueId).set(recipient, row);
  }
  const outcomes = entries.flatMap((entry) => logOutcomes(entry, index.lines, index.indexOf, { eopHost, seed: waiting.get(entry.queueId) }));
  for (const [queueId, seed] of waiting) {
    if (seen.has(queueId)) continue;
    const entry = index.byQueueId.get(queueId);
    const sender = [...seed.values()][0].log.sender;
    if (!entry || (entry.messageId && entry.messageId !== messageId) || !sender || entry.from !== sender) continue;
    outcomes.push(...logOutcomes(entry, index.lines, index.indexOf, { eopHost, seed }));
  }
  return outcomes;
}

// Deferred rows whose queue entry is no longer in the node's queue and that this pass found no
// final line for: "left the queue, outcome unknown", at the time of the deferral (so a final line
// found by a later read still wins). queueIds: the queue ids now in the queue.
export function leftQueueOutcomes(stored, queueIds, resolved) {
  const out = [];
  for (const [recipient, row] of stored) {
    if (row.state !== 'deferred' || row.source !== 'log' || !row.log?.queueId) continue;
    if (queueIds.has(row.log.queueId) || resolved.has(recipient)) continue;
    const details = { ...row.log, leftQueue: true };
    for (const key of ['state', 'at', 'statusCode', 'diagnostic']) delete details[key];
    out.push({ recipient, state: 'unknown', at: row.log.at, statusCode: row.log.statusCode, diagnostic: row.log.diagnostic, details });
  }
  return out;
}

// The alert job's pass (services/mailNode/nodeAlerts.js): the letters the journal shows sent by
// mailboxes on this node over the last LOG_CAPTURE_DAYS, looked up in the log already read. One
// read of the stored rows for all of them; a letter is written only when something changed.
// queueIds: the queue ids in the node's queue (read before the log), or null when the queue could
// not be read: then no deferred letter is taken for gone. Returns { letters (with outcomes),
// changed (rows written) }.
export async function captureFromLog({ cfg, log, eopHost = null, now = Date.now(), queueIds = null }) {
  const { rows: sent } = await query(`
    SELECT DISTINCT l.account_id, l.details->>'messageId' AS message_id, lower(btrim(a.email_address)) AS login
      FROM mailbox_audit_log l
      JOIN email_accounts a ON a.id = l.account_id
     WHERE l.action = 'message.sent' AND l.occurred_at >= $1
       AND a.mail_node AND lower(btrim(a.imap_host)) = $2
       AND l.details->>'messageId' IS NOT NULL`, [new Date(now - LOG_CAPTURE_DAYS * DAY_MS), cfg.mailHost]);
  if (!sent.length) return { letters: 0, changed: 0 };
  const index = indexLog(log.lines);
  const stored = await readOutcomesOf(sent);
  let letters = 0;
  let changed = 0;
  for (const row of sent) {
    const existing = stored.get(`${row.account_id}|${row.message_id}`) ?? new Map();
    const outcomes = letterOutcomes(index, row.message_id, row.login, { eopHost, stored: existing });
    if (queueIds) {
      const resolved = new Set(outcomes.map((o) => normalized(o).recipient));
      outcomes.push(...leftQueueOutcomes(existing, queueIds, resolved));
    }
    if (!outcomes.length) continue;
    letters += 1;
    if (wouldChange(existing, 'log', outcomes)) changed += await recordOutcomes(row.account_id, row.message_id, 'log', outcomes);
  }
  return { letters, changed };
}

// Looks one letter of the mailbox (login: its address) up in the log already read and records what
// it shows: { found }. The caller has checked that the mailbox sent it (sentLetterOf).
export async function captureLetter({ accountId, login, messageId, log, eopHost = null }) {
  const existing = new Map((await readOutcomes(accountId, messageId)).map((row) => [row.recipient, row]));
  const outcomes = letterOutcomes(indexLog(log.lines), messageId, String(login ?? '').trim().toLowerCase(), { eopHost, stored: existing });
  if (outcomes.length && wouldChange(existing, 'log', outcomes)) await recordOutcomes(accountId, messageId, 'log', outcomes);
  return { found: outcomes.length > 0 };
}

// What the screens get for one recipient: the stored row with the code explained. A delay with no
// news for DELAY_STALE_MS reads unknown (stale: the state it had).
export function presentOutcome(row, { now = Date.now() } = {}) {
  const text = row.diagnostic ?? row.submission?.reply ?? row.report?.diagnostic ?? row.log?.reply ?? '';
  const stale = DELAYED_STATES.includes(row.state) && row.eventAt && now - Date.parse(row.eventAt) > DELAY_STALE_MS;
  return {
    recipient: row.recipient,
    state: stale ? 'unknown' : row.state,
    stale: stale ? row.state : null,
    source: row.source,
    at: row.eventAt,
    statusCode: row.statusCode,
    diagnostic: row.diagnostic,
    explanation: ['sent', 'unknown'].includes(row.state) || stale ? null : explainDeliveryCode({ code: row.statusCode, text }),
    log: row.log,
    report: row.report,
    submission: row.submission ?? null,
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
