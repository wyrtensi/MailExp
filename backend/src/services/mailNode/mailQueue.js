import { QUEUE_NAMES } from './mailcow.js';

// The node's mail queue as the panel shows it (R-16): the list with counts per queue, and one
// message read with `postcat` split into its envelope, its headers and (only when asked) its body.

// The body of a queued message is shown only on request and cut at this size.
export const MAX_BODY_BYTES = 64 * 1024;
const SECTION_RE = /^\*\*\* (ENVELOPE RECORDS|MESSAGE CONTENTS|HEADER EXTRACTED|MESSAGE FILE END) (\S+) \*\*\*$/;

// The queue list with what the screen and the alerts need: items oldest first with their age in
// seconds, counts per queue, and the oldest deferred message's age.
export function summarizeQueue(items, now = Date.now()) {
  const counts = Object.fromEntries(QUEUE_NAMES.map((name) => [name, 0]));
  let oldestDeferred = null;
  const list = items.map((item) => {
    const arrived = item.arrivedAt ? Date.parse(item.arrivedAt) : NaN;
    const ageSeconds = Number.isFinite(arrived) ? Math.max(0, Math.floor((now - arrived) / 1000)) : null;
    counts[item.queue] = (counts[item.queue] ?? 0) + 1;
    if (item.queue === 'deferred' && ageSeconds != null && (oldestDeferred == null || ageSeconds > oldestDeferred)) {
      oldestDeferred = ageSeconds;
    }
    return { ...item, ageSeconds };
  }).sort((a, b) => (b.ageSeconds ?? 0) - (a.ageSeconds ?? 0));
  return { items: list, counts, total: list.length, oldestDeferredSeconds: oldestDeferred };
}

// Header lines into { name, value } with folded lines joined.
function parseHeaders(lines) {
  const headers = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && headers.length) {
      headers[headers.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

// Whether postcat's answer says the message is no longer in the queue ("fatal: open queue file
// <id>: No such file or directory"), rather than failing some other way.
export function postcatGone(text) {
  return typeof text === 'string' && /No such file or directory/i.test(text) && !text.includes('*** ENVELOPE RECORDS');
}

// `postcat -q` output: null when it is not a queue file dump (the message left the queue, postcat
// failed); otherwise { queueId, queue, envelope: { sender, recipients, doneRecipients, arrival },
// headers, bodyBytes, body (only with withBody, cut at MAX_BODY_BYTES), bodyTruncated, dumpTruncated }.
// truncated: the dump itself was cut (mailcow.js MAX_POSTCAT_BYTES): bodyBytes is then what was read.
export function parsePostcat(text, { withBody = false, truncated = false } = {}) {
  if (typeof text !== 'string' || !text.includes('*** ENVELOPE RECORDS')) return null;
  const sections = {};
  let current = null;
  let where = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = SECTION_RE.exec(line);
    if (match) {
      current = match[1];
      where = where ?? match[2];
      sections[current] = sections[current] ?? [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  // deferred/5/53A99193F13 (hashed queues) or active/53A99193F13.
  const parts = String(where ?? '').split('/');
  const queue = parts.length > 1 ? parts[0] : null;
  const queueId = parts.at(-1);
  // Recipients sit in the envelope records, and those Postfix took from the headers (sendmail -t)
  // in the extracted records after the message. done_recipient: one Postfix delivered already.
  const envelope = { sender: null, recipients: [], doneRecipients: [], arrival: null };
  const add = (list, value) => {
    const address = value.trim().toLowerCase();
    if (address && !list.includes(address)) list.push(address);
  };
  for (const line of [...(sections['ENVELOPE RECORDS'] ?? []), ...(sections['HEADER EXTRACTED'] ?? [])]) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'sender' && envelope.sender == null) envelope.sender = match[2].toLowerCase();
    if (match[1] === 'recipient') add(envelope.recipients, match[2]);
    if (match[1] === 'done_recipient') add(envelope.doneRecipients, match[2]);
    if (match[1] === 'message_arrival_time') envelope.arrival = match[2];
  }
  envelope.recipients = envelope.recipients.filter((address) => !envelope.doneRecipients.includes(address));
  const content = sections['MESSAGE CONTENTS'] ?? [];
  const blank = content.findIndex((line) => line === '');
  const headerLines = blank < 0 ? content : content.slice(0, blank);
  const bodyText = blank < 0 ? '' : content.slice(blank + 1).join('\n');
  const bodyBytes = Buffer.byteLength(bodyText);
  const result = {
    queueId: queueId || null,
    queue: queue || null,
    envelope,
    headers: parseHeaders(headerLines),
    bodyBytes,
    body: null,
    bodyTruncated: false,
    dumpTruncated: truncated,
  };
  if (withBody) {
    const cut = bodyBytes > MAX_BODY_BYTES;
    result.body = cut ? Buffer.from(bodyText).subarray(0, MAX_BODY_BYTES).toString('utf8') : bodyText;
    result.bodyTruncated = cut || truncated;
  }
  return result;
}
