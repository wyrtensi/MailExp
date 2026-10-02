import { decodeBodyPart } from './messageParser.js';
import { recordOutcomes, trimDiagnostic } from './deliveryStatus.js';

// Delivery status notifications (RFC 3464, multipart/report; report-type=delivery-status, and the
// UTF-8 form of RFC 6533) that come back to a mailbox mark the original letter of the same mailbox,
// found by its Message-ID, per recipient (R-17): Action: failed -> "not delivered to <recipient>",
// Action: delayed -> delayed; delivered, relayed and expanded mark nothing. Generic: any reporting
// MTA (the node's Postfix, which mailcow renames X-Postcow-*, Microsoft's non-delivery reports
// after EOP accepted the letter, other providers), only the standard fields are read.
//
// The cheapest reliable point is the sync, which already fetches every letter's BODYSTRUCTURE and
// headers: the structure says whether a letter is a report and which parts hold what, and the
// original Message-ID comes, in this order, from
// - the envelope of the returned letter (message/rfc822 child): IMAP puts it into BODYSTRUCTURE, so
//   it costs nothing (Postfix returns the letter this way);
// - In-Reply-To of the report, else the last References entry (Exchange's reports carry them;
//   Postfix's do not);
// - the Message-ID of a text/rfc822-headers part, fetched only then.
// Only the message/delivery-status part itself (a few hundred bytes) is fetched for every report.

const REPORT_TYPES = new Set(['delivery-status', 'global-delivery-status']);
const STATUS_TYPES = new Set(['message/delivery-status', 'message/global-delivery-status']);
const RETURNED_TYPES = new Set(['message/rfc822', 'message/global']);
const HEADERS_TYPES = new Set(['text/rfc822-headers', 'message/global-headers']);
const ACTIONS = { failed: 'failed', delayed: 'delayed' };
const MESSAGE_ID_RE = /<[^<>\s]+@[^<>\s]+>/;

const lower = (value) => String(value ?? '').toLowerCase();
const param = (node, name) => {
  const params = node?.parameters ?? {};
  const key = Object.keys(params).find((k) => k.toLowerCase() === name);
  return key ? params[key] : null;
};

// A letter's BODYSTRUCTURE (imapflow's form) as a delivery report: { statusPart, statusEncoding,
// statusCharset, headersPart, headersEncoding, returnedMessageId } or null when the letter is not one
// (the top level is not multipart/report with a delivery-status report type, or no status part).
export function deliveryReportOf(structure) {
  if (!structure || lower(structure.type) !== 'multipart/report') return null;
  if (!REPORT_TYPES.has(lower(param(structure, 'report-type')))) return null;
  const children = Array.isArray(structure.childNodes) ? structure.childNodes : [];
  const status = children.find((child) => STATUS_TYPES.has(lower(child.type)));
  if (!status?.part) return null;
  const returned = children.find((child) => RETURNED_TYPES.has(lower(child.type)));
  const headers = children.find((child) => HEADERS_TYPES.has(lower(child.type)));
  const returnedId = returned?.envelope?.messageId;
  return {
    statusPart: status.part,
    statusEncoding: status.encoding ?? null,
    statusCharset: param(status, 'charset'),
    headersPart: headers?.part ?? null,
    headersEncoding: headers?.encoding ?? null,
    returnedMessageId: MESSAGE_ID_RE.test(returnedId ?? '') ? MESSAGE_ID_RE.exec(returnedId)[0] : null,
  };
}

// The Message-ID a header value names: the first <local@domain> in it (In-Reply-To), or the last
// one (References: the letter replied to is the last).
export function messageIdIn(value, { last = false } = {}) {
  const ids = String(value ?? '').match(new RegExp(MESSAGE_ID_RE.source, 'g')) ?? [];
  return (last ? ids.at(-1) : ids[0]) ?? null;
}

// Header blocks (RFC 822 style): unfolded fields, names lower case, the first of each kept.
function fieldsOf(block) {
  const fields = {};
  for (const line of block.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!(name in fields)) fields[name] = line.slice(colon + 1).trim();
  }
  return fields;
}

// The Message-ID field of a returned header block (text/rfc822-headers).
export function messageIdOfHeaders(text) {
  const head = String(text ?? '').split(/\r?\n\r?\n/)[0];
  return messageIdIn(fieldsOf(head)['message-id']);
}

// "rfc822; a@b" -> "a@b", "smtp; 550 ..." -> "550 ...": the value after the type.
const typed = (value) => {
  if (value == null) return null;
  const text = String(value);
  const semi = text.indexOf(';');
  return (semi >= 0 ? text.slice(semi + 1) : text).trim() || null;
};

// The message/delivery-status text: { message: per-message fields, recipients: [{ finalRecipient,
// originalRecipient, action, status, diagnosticCode, remoteMta, lastAttemptDate }] }. Blocks are
// separated by empty lines; the first is the per-message block.
export function parseDeliveryStatus(text) {
  const blocks = String(text ?? '').replace(/\r\n/g, '\n').split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean);
  const [first, ...rest] = blocks.map(fieldsOf);
  const recipients = rest
    .filter((f) => f['final-recipient'] || f['original-recipient'])
    .map((f) => ({
      finalRecipient: typed(f['final-recipient']),
      originalRecipient: typed(f['original-recipient']),
      action: lower(f.action).trim() || null,
      status: /^\s*([245]\.\d{1,3}\.\d{1,3})/.exec(f.status ?? '')?.[1] ?? null,
      diagnosticCode: typed(f['diagnostic-code']),
      remoteMta: typed(f['remote-mta']),
      lastAttemptDate: f['last-attempt-date'] ?? null,
    }));
  return { message: first ?? {}, recipients };
}

// The address of a recipient field, lower case ("<a@b>" and "a@b" alike); null without an @.
function addressOf(value) {
  const text = String(value ?? '').trim().replace(/^<|>$/g, '').toLowerCase();
  return text.includes('@') ? text : null;
}

// The outcomes a report gives (failed and delayed only), per recipient: [{ recipient, state, at,
// statusCode, diagnostic, details: { action, remoteMta, reportingMta } }]. at: when the report
// says it tried last, else when the report was made (the caller's: its Date).
export function reportOutcomes(parsed, { at = null } = {}) {
  const reportingMta = typed(parsed.message?.['reporting-mta']);
  const made = at ? new Date(at) : null;
  const madeAt = made && Number.isFinite(made.getTime()) ? made.toISOString() : null;
  const out = [];
  for (const r of parsed.recipients) {
    const state = ACTIONS[r.action];
    // Final-Recipient first: it is the address the log's to= names, so both sources meet on one row.
    const recipient = addressOf(r.finalRecipient) ?? addressOf(r.originalRecipient);
    if (!state || !recipient) continue;
    const tried = r.lastAttemptDate ? Date.parse(r.lastAttemptDate) : NaN;
    out.push({
      recipient,
      state,
      at: Number.isFinite(tried) ? new Date(tried).toISOString() : madeAt,
      statusCode: r.status,
      diagnostic: trimDiagnostic(r.diagnosticCode),
      details: { action: r.action, remoteMta: r.remoteMta, reportingMta },
    });
  }
  return out;
}

// A fetched part's text: transfer encoding undone, charset applied (UTF-8 by default).
export function partText(buffer, encoding, charset) {
  if (!buffer) return '';
  return decodeBodyPart(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), encoding ?? '7bit', charset ?? 'utf-8');
}

// The original letter a report is about, from what the sync already has: the returned letter's
// envelope, else In-Reply-To, else the last References entry. Null: the returned headers decide.
export function originalFromStructure({ report, inReplyTo = null, references = null }) {
  return report.returnedMessageId ?? messageIdIn(inReplyTo) ?? messageIdIn(references, { last: true });
}

// Marks the original letter of the mailbox from one report already read: { original, changed }
// (original null: the report names no letter; changed: rows written).
export async function recordDeliveryReport({ accountId, report, statusText, headersText = null, inReplyTo = null, references = null, date = null }) {
  const original = originalFromStructure({ report, inReplyTo, references }) ?? messageIdOfHeaders(headersText);
  if (!original) return { original: null, changed: 0 };
  const outcomes = reportOutcomes(parseDeliveryStatus(statusText), { at: date });
  if (!outcomes.length) return { original, changed: 0 };
  return { original, changed: await recordOutcomes(accountId, original, 'dsn', outcomes) };
}

// Reads and records the reports one sync stored, over an IMAP client with their folder selected:
// for each { uid, report, inReplyTo, references, date }, one FETCH of the status part (and of the
// returned headers only when nothing else names the original). A report that cannot be read is
// skipped and logged. Returns how many reports marked a letter.
export async function readDeliveryReports(client, accountId, reports) {
  let marked = 0;
  for (const item of reports) {
    try {
      const { report } = item;
      const needHeaders = !originalFromStructure(item) && report.headersPart;
      const parts = needHeaders ? [report.statusPart, report.headersPart] : [report.statusPart];
      const msg = await client.fetchOne(String(item.uid), { uid: true, bodyParts: parts }, { uid: true });
      const statusText = partText(msg?.bodyParts?.get(report.statusPart), report.statusEncoding, report.statusCharset);
      if (!statusText) continue;
      const headersText = needHeaders ? partText(msg.bodyParts?.get(report.headersPart), report.headersEncoding, 'utf-8') : null;
      const { changed } = await recordDeliveryReport({ accountId, ...item, statusText, headersText });
      if (changed) marked += 1;
    } catch (err) {
      console.warn(`Delivery report ${item.uid} could not be read: ${err?.code || err?.message || 'error'}`);
    }
  }
  return marked;
}
