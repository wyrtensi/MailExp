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

// The recipients of an item with their own state: { [address]: { status, expired, at } }. An item
// written before per-recipient state shares the item's status.
export function recipientsOf(item) {
  return Object.fromEntries(item.to.map((rcpt) => [rcpt, item.recipients?.[rcpt] ?? { status: item.status, expired: !!item.expired }]));
}

// The item's own status from its recipients: pending while one waits, delivered when all arrived,
// else failed.
function settle(item) {
  const states = Object.values(item.recipients).map((r) => r.status);
  item.status = states.includes('pending') ? 'pending' : states.every((s) => s === 'delivered') ? 'delivered' : 'failed';
  item.expired = Object.values(item.recipients).some((r) => r.expired);
}

function fail(item, rcpts, { now, reply, expired, ndrDir }) {
  for (const rcpt of rcpts) item.recipients[rcpt] = { status: 'failed', expired, at: now.toISOString() };
  item.events.push({ at: now.toISOString(), event: 'Fail', rcpts, description: `Reason: [{LED=${reply}};{FQDN=};{IP=}]` });
  fs.mkdirSync(ndrDir, { recursive: true });
  const name = `${item.id}-${(item.ndrCount = (item.ndrCount ?? 0) + 1)}`;
  writeAtomic(path.join(ndrDir, `${name}.eml`), ndrMessage({ item: { ...item, to: rcpts }, reply, now }));
  writeAtomic(path.join(ndrDir, `${name}.json`), `${JSON.stringify({ id: name, to: item.from, rcpts, reply, at: now.toISOString() })}\n`);
}

// A lock directory beside the queue, so the serve timer and a command (retry, clear) never write
// over each other's change. Held only around a read-modify-write, never across a delivery; a lock
// older than LOCK_STALE_MS (a process that died holding it) is taken over.
const LOCK_STALE_MS = 30000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function withQueueLock(dir, fn) {
  const lock = `${dir}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let tries = 0; ; tries += 1) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // Gone meanwhile: try again.
      }
      if (tries > 200) throw new Error('the inbound queue is locked');
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

const readItem = (dir, id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
};

// One pass: every pending item that is due (all pending with force) expires, or each of its
// pending recipients is handed to the node with deliver(item, raw, [rcpt]) -> { ok, reply } (it
// throws when the connection fails), so one refused recipient does not hold the others. Returns
// { tried, delivered, deferred, failed, expired } (recipients) and logs one line per recipient.
export async function runInboundPass({
  dir, ndrDir, deliver, host = 'postfix-mailcow', retrySeconds = INBOUND_DEFAULTS.retrySeconds, now = new Date(), force = false, log = () => {},
}) {
  const summary = { tried: 0, delivered: 0, deferred: 0, failed: 0, expired: 0 };
  for (const { id } of listInbound(dir)) {
    // Claim the attempt under the lock: expire, or move the next attempt on.
    const claimed = withQueueLock(dir, () => {
      const item = readItem(dir, id);
      if (!item || item.status !== 'pending') return null;
      item.recipients = recipientsOf(item);
      const pending = Object.keys(item.recipients).filter((rcpt) => item.recipients[rcpt].status === 'pending');
      if (now.getTime() >= Date.parse(item.expiresAt)) {
        fail(item, pending, { now, reply: EXPIRED_REPLY, expired: true, ndrDir });
        settle(item);
        saveInbound(dir, item);
        summary.expired += pending.length;
        log(`inbound=${item.id} event=fail rcpt=${pending.join(',')} reply="${EXPIRED_REPLY}" ndr_to=<${item.from}>`);
        return null;
      }
      if (!force && now.getTime() < Date.parse(item.nextAttemptAt)) return null;
      item.attempts += 1;
      item.nextAttemptAt = new Date(now.getTime() + retrySeconds * 1000).toISOString();
      saveInbound(dir, item);
      return { item, pending };
    });
    if (!claimed) continue;
    const { item, pending } = claimed;
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, `${item.id}.eml`));
    } catch {
      continue; // cleared meanwhile
    }
    const results = [];
    for (const rcpt of pending) {
      summary.tried += 1;
      try {
        results.push({ rcpt, result: await deliver(item, raw, [rcpt]) });
      } catch (error) {
        results.push({ rcpt, error });
      }
    }
    // Apply the results to the item as it is now (a command may have cleared it meanwhile).
    withQueueLock(dir, () => {
      const current = readItem(dir, item.id);
      if (!current) return;
      current.recipients = recipientsOf(current);
      for (const { rcpt, result, error } of results) {
        if (error) {
          const reason = deferReason(error, host);
          current.events.push({ at: now.toISOString(), event: 'Defer', rcpts: [rcpt], description: `The message was deferred. ${reason.text}` });
          summary.deferred += 1;
          log(`inbound=${item.id} event=defer rcpt=${rcpt} attempt=${current.attempts} reply="${reason.text}"`);
        } else if (result.ok) {
          current.recipients[rcpt] = { status: 'delivered', expired: false, at: now.toISOString() };
          current.events.push({ at: now.toISOString(), event: 'Send', rcpts: [rcpt], description: `The message was sent to ${host}: ${result.reply}` });
          summary.delivered += 1;
          log(`inbound=${item.id} event=send rcpt=${rcpt} attempt=${current.attempts} reply="${result.reply}"`);
        } else if (/^4/.test(result.reply)) {
          current.events.push({ at: now.toISOString(), event: 'Defer', rcpts: [rcpt], description: `The message was deferred. Remote server returned '${result.reply}'` });
          summary.deferred += 1;
          log(`inbound=${item.id} event=defer rcpt=${rcpt} attempt=${current.attempts} reply="${result.reply}"`);
        } else {
          fail(current, [rcpt], { now, reply: result.reply, expired: false, ndrDir });
          summary.failed += 1;
          log(`inbound=${item.id} event=fail rcpt=${rcpt} reply="${result.reply}" ndr_to=<${item.from}>`);
        }
      }
      settle(current);
      if (current.status === 'delivered') current.deliveredAt = now.toISOString();
      saveInbound(dir, current);
    });
  }
  return summary;
}

// Makes every pending letter due now; under the queue lock. Returns how many.
export function retryInbound(dir, now = new Date()) {
  return withQueueLock(dir, () => {
    let due = 0;
    for (const item of listInbound(dir)) {
      if (item.status !== 'pending') continue;
      item.nextAttemptAt = now.toISOString();
      saveInbound(dir, item);
      due += 1;
    }
    return due;
  });
}

// Empties the queue; under the queue lock, so a pass in flight finds nothing to write back to.
export function clearInbound(dir) {
  withQueueLock(dir, () => fs.rmSync(dir, { recursive: true, force: true }));
}

// --- the trace, in Graph's shapes -----------------------------------------------------------

// One row per recipient, with that recipient's status: exchangeMessageTrace.
export function traceRows(items) {
  return items.flatMap((item) => {
    const recipients = recipientsOf(item);
    return item.to.map((rcpt) => ({
      id: item.traceId,
      senderAddress: item.from,
      recipientAddress: rcpt,
      subject: item.subject,
      messageId: item.messageId,
      receivedDateTime: item.receivedAt,
      size: item.size,
      fromIP: SENDER_IP,
      toIP: '',
      status: recipients[rcpt].status,
    }));
  });
}

// exchangeMessageTraceDetail of one recipient: the events of the whole letter and its own.
export function traceDetails(item, rcpt = null) {
  const wanted = rcpt?.toLowerCase();
  return item.events
    .filter((event) => !event.rcpts || !wanted || event.rcpts.some((r) => r.toLowerCase() === wanted))
    .map((event) => ({
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
    return { status: 200, body: { value: traceDetails(item, recipient) } };
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
