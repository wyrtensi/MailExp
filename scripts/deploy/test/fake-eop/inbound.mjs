// The inbound side of fake-EOP: mail from the internet to the node's domains, which EOP queues when
// the node does not take it (R-43). What Microsoft documents and this imitates:
// - EOP retries every 15 minutes (retrySeconds, small on the stand for tests) for at most 24 hours
//   (expirySeconds; Set-TransportConfig -MessageExpiration only shortens it to 12 hours);
// - while it waits, the trace says pending and the details carry a Defer event with the reason:
//   450 4.4.312 (DNS), 4.4.315 (timed out), 4.4.316 (connection refused), 4.4.317 (cannot
//   connect), 4.4.318 (connection closed), or the node's own 4xx reply;
// - when the time is up the message fails with 550 4.4.7 QUEUE.Expired and the external sender gets
//   a non-delivery report; a 5xx of the node fails it at once, with a report as well;
// - delivered: a Send event, status delivered.
// The exact event words and descriptions of a tenant are Inferred (requirements, section 6).
//
// Files under the data directory: inbound/<id>.json (the item, written last) and <id>.eml (the
// letter as the sender sent it), ndr/<id>.eml and .json (the reports to senders, which go nowhere:
// the senders are on the internet), inbound-config.json ({ retrySeconds, expirySeconds }).
// Only the serve process delivers (its timer); the commands only add items or make them due.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId } from './lib.mjs';

export const INBOUND_DEFAULTS = Object.freeze({ retrySeconds: 900, expirySeconds: 86400 });
// What the trace shows as the address mail came from (an example address, RFC 5737).
export const SENDER_IP = '203.0.113.10';
const EXPIRED_REPLY = '550 4.4.7 QUEUE.Expired; message expired';

const writeAtomic = (file, data) => {
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
};

export function readInboundConfig(file) {
  try {
    return { ...INBOUND_DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ...INBOUND_DEFAULTS };
  }
}

// Validates and stores a change: whole seconds, retry 1..3600, expiry 60..86400 (EOP's ceiling).
export function writeInboundConfig(file, patch) {
  const next = { ...readInboundConfig(file), ...patch };
  const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  if (!whole(next.retrySeconds, 1, 3600)) throw new Error('retry seconds must be a whole number from 1 to 3600');
  if (!whole(next.expirySeconds, 60, 86400)) throw new Error('expiry seconds must be a whole number from 60 to 86400');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// A plain letter from the internet, in CRLF.
export function composeLetter({ from, to, subject, messageId, now = new Date() }) {
  return Buffer.from([
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${subject}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'A letter from outside, queued by fake-EOP while the node may be down.',
    '',
  ].join('\r\n'));
}

// Takes a letter in: { id, traceId, from, to, subject, messageId, size, receivedAt, expiresAt,
// status: 'pending', attempts, nextAttemptAt, events }.
export function receiveInbound(dir, { from, to, subject, messageId, raw, now = new Date(), expirySeconds }) {
  fs.mkdirSync(dir, { recursive: true });
  const id = newId(now);
  const item = {
    id,
    traceId: crypto.randomUUID(),
    from,
    to,
    subject,
    messageId,
    size: raw.length,
    receivedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expirySeconds * 1000).toISOString(),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now.toISOString(),
    events: [{ at: now.toISOString(), event: 'Receive', description: 'Message received by: EOPSTAGE01MB0001.stageprd01.prod.eop.test.local' }],
  };
  writeAtomic(path.join(dir, `${id}.eml`), raw);
  saveInbound(dir, item);
  return item;
}

export function saveInbound(dir, item) {
  writeAtomic(path.join(dir, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
}

export function listInbound(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

export function loadInbound(dir, id) {
  const all = listInbound(dir);
  const item = id === 'latest' ? all.at(-1) : all.find((entry) => entry.id === id);
  if (!item) throw new Error(id === 'latest' ? 'no inbound messages' : `no inbound message ${id}`);
  return { item, raw: fs.readFileSync(path.join(dir, `${item.id}.eml`)) };
}

// The 4.4.x reason EOP logs for a connection that failed: { code, text }.
export function deferReason(error, host) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  const where = `[LastAttemptedServerName=${host}]`;
  if (code === 'ECONNREFUSED') return { code: '4.4.316', text: `450 4.4.316 Connection refused [Message=Socket error code 10061] ${where}` };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: '4.4.312', text: `450 4.4.312 DNS query failed [Message=${code}] ${where}` };
  if (code === 'ETIMEDOUT' || /timeout/i.test(message)) return { code: '4.4.315', text: `450 4.4.315 Connection timed out [Message=Socket error code 10060] ${where}` };
  if (code === 'ECONNRESET' || /closed before the final reply/.test(message)) return { code: '4.4.318', text: `450 4.4.318 Connection closed abruptly ${where}` };
  return { code: '4.4.317', text: `450 4.4.317 Cannot connect to remote server [Message=${code || 'error'}] ${where}` };
}

// The non-delivery report EOP sends the external sender (RFC 3464).
export function ndrMessage({ item, reply, reportingMta = 'eop.test.local', now = new Date() }) {
  const boundary = `ndr-${item.id}`;
  const status = /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(reply)?.[1] ?? '5.0.0';
  return Buffer.from([
    'From: Microsoft Outlook <postmaster@eop.test.local>',
    `To: ${item.from}`,
    `Subject: Undeliverable: ${item.subject}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <ndr-${item.id}@eop.test.local>`,
    `In-Reply-To: ${item.messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    "Your message couldn't be delivered. The receiving server didn't accept it in time.",
    '',
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    `Reporting-MTA: dns;${reportingMta}`,
    `Arrival-Date: ${new Date(item.receivedAt).toUTCString().replace('GMT', '+0000')}`,
    '',
    ...item.to.flatMap((rcpt) => [
      `Final-Recipient: rfc822;${rcpt}`,
      'Action: failed',
      `Status: ${status}`,
      `Diagnostic-Code: smtp;${reply}`,
      '',
    ]),
    `--${boundary}`,
    'Content-Type: text/rfc822-headers',
    '',
    `From: ${item.from}`,
    `To: ${item.to.join(', ')}`,
    `Subject: ${item.subject}`,
    `Message-ID: ${item.messageId}`,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n'));
}

function fail(item, { now, reply, expired, ndrDir }) {
  item.status = 'failed';
  item.expired = expired;
  item.events.push({ at: now.toISOString(), event: 'Fail', description: `Reason: [{LED=${reply}};{FQDN=};{IP=}]` });
  fs.mkdirSync(ndrDir, { recursive: true });
  writeAtomic(path.join(ndrDir, `${item.id}.eml`), ndrMessage({ item, reply, now }));
  writeAtomic(path.join(ndrDir, `${item.id}.json`), `${JSON.stringify({ id: item.id, to: item.from, reply, at: now.toISOString() })}\n`);
}

// One pass: every pending item that is due (all pending with force) expires, or is handed to the
// node with deliver(item, raw) -> { ok, reply } (it throws when the connection fails). Returns
// { tried, delivered, deferred, failed, expired } and logs one line per item.
export async function runInboundPass({
  dir, ndrDir, deliver, host = 'postfix-mailcow', retrySeconds = INBOUND_DEFAULTS.retrySeconds, now = new Date(), force = false, log = () => {},
}) {
  const summary = { tried: 0, delivered: 0, deferred: 0, failed: 0, expired: 0 };
  for (const item of listInbound(dir)) {
    if (item.status !== 'pending') continue;
    if (now.getTime() >= Date.parse(item.expiresAt)) {
      fail(item, { now, reply: EXPIRED_REPLY, expired: true, ndrDir });
      saveInbound(dir, item);
      summary.expired += 1;
      log(`inbound=${item.id} event=fail reply="${EXPIRED_REPLY}" ndr_to=<${item.from}>`);
      continue;
    }
    if (!force && now.getTime() < Date.parse(item.nextAttemptAt)) continue;
    summary.tried += 1;
    item.attempts += 1;
    item.nextAttemptAt = new Date(now.getTime() + retrySeconds * 1000).toISOString();
    const raw = fs.readFileSync(path.join(dir, `${item.id}.eml`));
    let result;
    try {
      result = await deliver(item, raw);
    } catch (error) {
      const reason = deferReason(error, host);
      item.events.push({ at: now.toISOString(), event: 'Defer', description: `The message was deferred. ${reason.text}` });
      summary.deferred += 1;
      log(`inbound=${item.id} event=defer attempt=${item.attempts} reply="${reason.text}"`);
      saveInbound(dir, item);
      continue;
    }
    if (result.ok) {
      item.status = 'delivered';
      item.deliveredAt = now.toISOString();
      item.events.push({ at: now.toISOString(), event: 'Send', description: `The message was sent to ${host}: ${result.reply}` });
      summary.delivered += 1;
      log(`inbound=${item.id} event=send attempt=${item.attempts} reply="${result.reply}"`);
    } else if (/^4/.test(result.reply)) {
      item.events.push({ at: now.toISOString(), event: 'Defer', description: `The message was deferred. Remote server returned '${result.reply}'` });
      summary.deferred += 1;
      log(`inbound=${item.id} event=defer attempt=${item.attempts} reply="${result.reply}"`);
    } else {
      fail(item, { now, reply: result.reply, expired: false, ndrDir });
      summary.failed += 1;
      log(`inbound=${item.id} event=fail reply="${result.reply}" ndr_to=<${item.from}>`);
    }
    saveInbound(dir, item);
  }
  return summary;
}

// --- the trace, in Graph's shapes -----------------------------------------------------------

// One row per recipient: exchangeMessageTrace.
export function traceRows(items) {
  return items.flatMap((item) => item.to.map((rcpt) => ({
    id: item.traceId,
    senderAddress: item.from,
    recipientAddress: rcpt,
    subject: item.subject,
    messageId: item.messageId,
    receivedDateTime: item.receivedAt,
    size: item.size,
    fromIP: SENDER_IP,
    toIP: '',
    status: item.status,
  })));
}

// exchangeMessageTraceDetail of one recipient.
export function traceDetails(item) {
  return item.events.map((event) => ({
    id: item.traceId, messageId: item.messageId, dateTime: event.at, event: event.event, action: '', description: event.description, data: '<root></root>',
  }));
}

// receivedDateTime ge X and receivedDateTime le Y, as Graph takes it; null bounds are open.
export function parseTraceFilter(filter) {
  const text = String(filter ?? '');
  const ge = /receivedDateTime ge (\S+)/.exec(text);
  const le = /receivedDateTime le (\S+)/.exec(text);
  const recipient = /recipientAddress eq '([^']*)'/.exec(text);
  return {
    start: ge ? Date.parse(ge[1]) : null,
    end: le ? Date.parse(le[1]) : null,
    recipient: recipient ? recipient[1].toLowerCase() : null,
  };
}

// The answer to GET <base>/admin/exchange/tracing/messageTraces and getDetailsByRecipient, from
// the inbound queue: { status, body }. url: the request URL (absolute, for nextLink). Without both
// bounds Graph answers the last 48 hours; so does this.
export function traceAnswer(dir, url, now = new Date()) {
  const items = listInbound(dir);
  const detail = /\/admin\/exchange\/tracing\/messageTraces\/([^/]+)\/getDetailsByRecipient\(recipientAddress='(.*)'\)$/.exec(decodeURIComponent(url.pathname));
  if (detail) {
    const [, traceId, rawRecipient] = detail;
    const recipient = rawRecipient.replace(/''/g, "'").toLowerCase();
    const item = items.find((entry) => entry.traceId === traceId && entry.to.some((to) => to.toLowerCase() === recipient));
    if (!item) return { status: 404, body: { error: { code: 'NotFound', message: 'No such message trace' } } };
    return { status: 200, body: { value: traceDetails(item) } };
  }
  if (!/\/admin\/exchange\/tracing\/messageTraces$/.test(url.pathname)) return { status: 404, body: { error: { code: 'NotFound' } } };
  const { start, end, recipient } = parseTraceFilter(url.searchParams.get('$filter'));
  const from = start ?? now.getTime() - 48 * 3600e3;
  const to = end ?? now.getTime();
  const rows = traceRows(items).filter((row) => {
    const at = Date.parse(row.receivedDateTime);
    return at >= from && at <= to && (!recipient || row.recipientAddress.toLowerCase() === recipient);
  });
  const top = Math.min(Math.max(Number(url.searchParams.get('$top')) || 1000, 1), 5000);
  const skip = Math.max(Number(url.searchParams.get('$skiptoken')) || 0, 0);
  const body = { value: rows.slice(skip, skip + top) };
  if (skip + top < rows.length) {
    const next = new URL(url);
    next.searchParams.set('$skiptoken', String(skip + top));
    body['@odata.nextLink'] = next.toString();
  }
  return { status: 200, body };
}
