import { getPostfixLog } from './mailcow.js';
import { isEopAddress } from './eopRanges.js';

// The node's Postfix log as the mailcow API gives it (get/logs/postfix/<lines>), parsed line by line
// and tied together by queue id. The alerts (services/mailNode/nodeAlerts.js: EOP refusal codes and
// the EOP bypass check, R-18 and R-19) read it, and so will the per-letter delivery details and the
// bounce marking of a later stage (R-17): this module only reads and parses, it keeps nothing.
//
// Where the lines come from: syslog-ng in postfix-mailcow pushes every line to the Redis list
// POSTFIX_MAILLOG as JSON { time: "<unix seconds>", program: "postfix/smtp", priority: "info",
// message: "<the line after program[pid]: >" }, newest first. mailcow trims the list to LOG_LINES of
// mailcow.conf (9999 by default) every few minutes; the API without a count answers $LOG_LINES of
// the web settings (1000), so the reader always asks for an explicit count. How far back the lines
// reach depends on how busy the node is: callers that need a time window check `covered`.
//
// One parsed line (parsePostfixEntry):
// {
//   at: ISO time | null, epoch: ms | null, program: 'postfix/smtp', service: 'smtp',
//   queueId: '53A99193F13' | null, event: one of LOG_EVENTS,
//   to, origTo, from: addresses without <> (from may be '' for the null sender) | null,
//   relay: the relay= value as written | null, relayHost, relayIp, relayPort: its parts | null,
//   dsn: '4.7.500' | null, status: sent|deferred|bounced|expired|undeliverable|deliverable | null,
//   statusText: the text in parentheses after status= (the remote reply) | null,
//   delay: seconds | null, messageId: '<id@host>' | null, size, nrcpt: numbers | null,
//   notificationQueueId: the queue id of the bounce or delay notice a bounce line names | null,
//   message: the line as logged (folded to one line),
// }

// mailcow keeps LOG_LINES + 1 lines (10000 with the default LOG_LINES=9999); asking more returns
// what is there. The reader asks for all of it unless told otherwise: some 2-3 MB of JSON.
export const MAX_LOG_LINES = 10000;
export const DEFAULT_LOG_LINES = MAX_LOG_LINES;

// What a line says about a queued message:
// - sent, deferred, bounced, undeliverable, deliverable: a delivery attempt to one recipient
//   (smtp, lmtp, local, virtual, pipe, error) with its status=;
// - expired: qmgr gave up on a message that stayed in the queue too long (status=expired);
// - received: the message entered the queue (smtpd client=, pickup uid=);
// - message_id: cleanup logged its Message-ID;
// - queued: qmgr took it in (from=, size=, nrcpt=);
// - notification: bounce made a notice (non-delivery, delay or success) with a new queue id;
// - removed: qmgr is done with the message;
// - rejected: cleanup or a milter refused it, or smtpd refused a command (NOQUEUE has no queue id);
// - other: anything else (connections, TLS, warnings).
export const LOG_EVENTS = Object.freeze([
  'sent', 'deferred', 'bounced', 'expired', 'undeliverable', 'deliverable',
  'received', 'message_id', 'queued', 'notification', 'removed', 'rejected', 'other',
]);
const DELIVERY_STATUSES = new Set(['sent', 'deferred', 'bounced', 'undeliverable', 'deliverable']);
// Postfix's default short queue ids are upper-case hex; long ids (enable_long_queue_ids) use a
// base 52 alphabet without vowels, with "z" separating the time from the inode number. mailcow's
// queue actions take only hex ids; the reader reads both.
const LONG_ID_CHARS = '0-9B-DF-HJ-NP-TV-Zb-df-hj-np-tv-y';
const QUEUE_ID_RE = new RegExp(`^(?:[0-9A-F]{6,20}|(?=.{12,24}$)[${LONG_ID_CHARS}]+z[${LONG_ID_CHARS}]+)$`);
const LOCAL_SERVICES = new Set(['lmtp', 'local', 'virtual', 'pipe']);

// The text of the outermost parentheses that start right after `status=<word> `, up to the matching
// closing one (the remote reply quotes parentheses of its own, e.g. "(S77) (in reply to ...)").
function statusText(message, from) {
  const open = message.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < message.length; i += 1) {
    if (message[i] === '(') depth += 1;
    else if (message[i] === ')') {
      depth -= 1;
      if (depth === 0) return message.slice(open + 1, i);
    }
  }
  // A line cut off before its closing parenthesis keeps what is there.
  return message.slice(open + 1);
}

// relay=host[address]:port, relay=host[address], relay=none, relay=local.
export function parseRelay(relay) {
  if (!relay) return { relayHost: null, relayIp: null, relayPort: null };
  const match = /^([^[\]]*)\[([^\]]*)\](?::(\d+))?$/.exec(relay);
  if (!match) return { relayHost: relay.toLowerCase(), relayIp: null, relayPort: null };
  return {
    relayHost: match[1].toLowerCase() || null,
    relayIp: match[2].replace(/^ipv6:/i, '') || null,
    relayPort: match[3] ? Number(match[3]) : null,
  };
}

const field = (message, name) => {
  const match = new RegExp(`(?:^|[\\s,])${name}=([^,\\s]*)`).exec(message);
  return match ? match[1] : null;
};
const address = (message, name) => {
  const match = new RegExp(`(?:^|[\\s,])${name}=<([^>]*)>`).exec(message);
  return match ? match[1].toLowerCase() : null;
};
const numberOr = (value) => {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) ? n : null;
};

function eventOf(service, rest, status) {
  if (status === 'expired') return 'expired';
  if (status && DELIVERY_STATUSES.has(status)) return status;
  if (/^message-id=/.test(rest)) return 'message_id';
  if (service === 'qmgr' && rest === 'removed') return 'removed';
  if (service === 'qmgr' && /^from=<[^>]*>, size=/.test(rest)) return 'queued';
  if (/^client=/.test(rest) || (service === 'pickup' && /^uid=/.test(rest))) return 'received';
  if (service === 'bounce' && /notification: /.test(rest)) return 'notification';
  if (/^(milter-)?(reject|discard|hold)\b/.test(rest) || /^reject:/.test(rest)) return 'rejected';
  return 'other';
}

// One entry of the API answer, parsed; null for an entry that is no log line (not an object, no
// message). A message spread over several lines is folded into one.
export function parsePostfixEntry(entry) {
  let item = entry;
  if (typeof item === 'string') {
    try {
      item = JSON.parse(item);
    } catch {
      return null;
    }
  }
  if (!item || typeof item !== 'object' || typeof item.message !== 'string') return null;
  const message = item.message.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!message) return null;
  const seconds = Number(item.time);
  const epoch = item.time != null && item.time !== '' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  const program = typeof item.program === 'string' ? item.program : '';
  const service = program.split('/').pop() || null;

  let queueId = null;
  let rest = message;
  const head = /^([0-9A-Za-z]+): (.*)$/.exec(message);
  if (head && QUEUE_ID_RE.test(head[1])) {
    queueId = head[1];
    rest = head[2];
  } else if (/^NOQUEUE: /.test(message)) {
    rest = message.slice('NOQUEUE: '.length);
  }

  const statusMatch = /(?:^|[\s,])status=([a-z]+)/.exec(rest);
  const status = statusMatch ? statusMatch[1] : null;
  const relay = field(rest, 'relay');
  const notice = service === 'bounce' ? /notification: ([0-9A-Za-z]+)\s*$/.exec(rest) : null;
  const messageIdMatch = /^message-id=(\S*)/.exec(rest);
  return {
    at: epoch ? new Date(epoch).toISOString() : null,
    epoch,
    program,
    service,
    queueId,
    event: eventOf(service, rest, status),
    to: address(rest, 'to'),
    origTo: address(rest, 'orig_to'),
    from: address(rest, 'from'),
    relay,
    ...parseRelay(relay),
    dsn: field(rest, 'dsn'),
    status,
    statusText: statusMatch ? statusText(rest, statusMatch.index + statusMatch[0].length) : null,
    delay: numberOr(field(rest, 'delay')),
    messageId: messageIdMatch ? messageIdMatch[1] || null : null,
    size: numberOr(field(rest, 'size')),
    nrcpt: numberOr(field(rest, 'nrcpt')),
    notificationQueueId: notice ? notice[1] : null,
    message,
  };
}

// The answer of get/logs/postfix (newest first) as parsed lines, oldest first; lines of the same
// second keep the order Postfix wrote them in. Returns { lines, malformed }.
export function parsePostfixLog(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const lines = [];
  let malformed = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const line = parsePostfixEntry(list[i]);
    if (line) lines.push(line);
    else malformed += 1;
  }
  // Array.prototype.sort is stable: equal times stay in the order above.
  lines.sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0));
  return { lines, malformed };
}

// The lines tied together by queue id: a Map of queueId -> { queueId, messageId, from, size, nrcpt,
// firstAt, lastAt, deliveries (the delivery and expired lines, in order), notifications (queue ids of
// the notices bounce made for it), removed, lines }. Lines without a queue id are left out.
export function correlateByQueueId(lines) {
  const messages = new Map();
  for (const line of lines) {
    if (!line.queueId) continue;
    let message = messages.get(line.queueId);
    if (!message) {
      message = {
        queueId: line.queueId, messageId: null, from: null, size: null, nrcpt: null,
        firstAt: line.at, lastAt: line.at, deliveries: [], notifications: [], removed: false, lines: [],
      };
      messages.set(line.queueId, message);
    }
    message.lines.push(line);
    message.lastAt = line.at ?? message.lastAt;
    if (line.messageId) message.messageId = line.messageId;
    if (line.event === 'queued' || line.event === 'received') {
      if (line.from != null) message.from = line.from;
      if (line.size != null) message.size = line.size;
      if (line.nrcpt != null) message.nrcpt = line.nrcpt;
    }
    if (DELIVERY_STATUSES.has(line.event) || line.event === 'expired') message.deliveries.push(line);
    if (line.event === 'notification' && line.notificationQueueId) message.notifications.push(line.notificationQueueId);
    if (line.event === 'removed') message.removed = true;
  }
  return messages;
}

// Reads the last `lines` lines of the node's Postfix log: { lines (parsed, oldest first), fetched,
// malformed, oldestAt, newestAt, covered }. covered: with `since` (ms), whether the oldest line read
// is at or before it, so nothing between `since` and now is missing; without, null. A node failure
// is thrown (MailNodeError).
export async function readPostfixLog(cfg, { lines = DEFAULT_LOG_LINES, since = null } = {}) {
  const count = Math.min(Math.max(1, Math.trunc(lines) || DEFAULT_LOG_LINES), MAX_LOG_LINES);
  const entries = await getPostfixLog(cfg, count);
  const parsed = parsePostfixLog(entries);
  const timed = parsed.lines.filter((line) => line.epoch != null);
  const oldest = timed[0]?.epoch ?? null;
  const newest = timed.at(-1)?.epoch ?? null;
  return {
    lines: parsed.lines,
    fetched: entries.length,
    malformed: parsed.malformed,
    oldestAt: oldest ? new Date(oldest).toISOString() : null,
    newestAt: newest ? new Date(newest).toISOString() : null,
    covered: since == null ? null : oldest != null && oldest <= since,
  };
}

// Where a delivery line handed the message: 'local' (Dovecot over LMTP, or Postfix's local,
// virtual or pipe delivery), 'eop' (relay named <EOP_HOST>, or an address in the EOP ranges), or
// 'other'. eopHost: the EOP settings' next hop, lowercase; ranges: a test's own EOP ranges.
export function relayKind(line, { eopHost = null, ranges = null } = {}) {
  if (LOCAL_SERVICES.has(line.service)) return 'local';
  if (line.relayHost === 'local' || line.relayHost === 'virtual') return 'local';
  const host = String(line.relayHost ?? '').replace(/\.$/, '');
  if (eopHost && host && host === String(eopHost).toLowerCase().replace(/\.$/, '')) return 'eop';
  if (line.relayIp && isEopAddress(line.relayIp, ranges)) return 'eop';
  return 'other';
}
