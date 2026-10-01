import { query } from '../db.js';
import { decodeBodyPart, decodeMimeWords } from '../messageParser.js';
import { eopCategory } from '../../utils/antispamReport.js';
import { MAIL_NODE_PROVIDER, getRspamdHistory } from './mailcow.js';

// The mail node's quarantine and rspamd history in the panel (R-20 in
// docs/architecture/mail-node-research/eop-panel-requirements.md): reading a quarantined letter
// for the safe text view, finding a letter in rspamd's history ("why is this letter in Spam"), and
// who besides administrators may see the quarantine. The mailcow calls are in mailcow.js.

// ── A quarantined letter ───────────────────────────────────────────────────────────────────────

// mailcow stores the letter after mb_convert_encoding($raw, 'HTML-ENTITIES', 'UTF-8')
// (rspamd/meta_exporter/pipe.php): every non-ASCII character became &#NNNN;. ASCII was never
// converted, so turning entities of code points from 0x80 up back into characters undoes exactly
// that. An 8-bit part in another charset than UTF-8 was already damaged by mailcow.
export function decodeStoredLetter(text) {
  return String(text ?? '').replace(/&#(\d{3,7});/g, (whole, digits) => {
    const code = Number(digits);
    return code >= 0x80 && code <= 0x10FFFF && (code < 0xD800 || code > 0xDFFF) ? String.fromCodePoint(code) : whole;
  });
}

// Bounds: a letter from the quarantine is read for a screen, never in full when it is huge.
const MAX_DEPTH = 8;
const MAX_PARTS = 100;
// The header block read at most, the header lines read from it, and the lines and the length of
// a value the screen gets.
const MAX_HEAD = 256 * 1024;
const MAX_HEADER_LINES = 1000;
const MAX_HEADERS = 150;
const MAX_HEADER_VALUE = 4000;
const MAX_HTML = 1024 * 1024;
const MAX_TEXT = 512 * 1024;

// Header and body of one MIME entity.
function splitEntity(text) {
  const crlf = text.indexOf('\r\n\r\n');
  const lf = text.indexOf('\n\n');
  let at = -1;
  let gap = 0;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) { at = crlf; gap = 4; } else if (lf >= 0) { at = lf; gap = 2; }
  if (at < 0) return { head: text, body: '' };
  return { head: text.slice(0, at), body: text.slice(at + gap) };
}

// The header lines in their order, unfolded, with mailcow's entities undone (headers are text):
// [{ name, value }] with the name as written. At most MAX_HEAD characters and MAX_HEADER_LINES lines.
function headerLines(head) {
  const out = [];
  for (const line of head.slice(0, MAX_HEAD).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    if (out.length >= MAX_HEADER_LINES) break;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    out.push({ name: line.slice(0, colon).trim(), value: decodeStoredLetter(line.slice(colon + 1).trim()) });
  }
  return out;
}

function headerMap(lines) {
  const map = {};
  for (const { name, value } of lines) {
    const key = name.toLowerCase();
    map[key] = map[key] === undefined ? value : `${map[key]}\n${value}`;
  }
  return map;
}

// RFC 2231 value bytes: %XX is a byte, anything else stands for itself.
function percentBytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '%' && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

// A header value split at the semicolons outside quoted strings (boundary="a;b" stays whole).
function splitParams(raw) {
  const pieces = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted && ch === '\\' && i + 1 < raw.length) {
      current += ch + raw[i + 1];
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
      current += ch;
    } else if (ch === ';' && !quoted) {
      pieces.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  pieces.push(current);
  return pieces;
}

// "text/html; charset=utf-8; name=\"a b.pdf\"" -> { value: 'text/html', params: { charset, name } }.
// RFC 2231 continuations (name*0, name*1) are joined; name*=utf-8''... is decoded.
function headerParams(raw) {
  const [first, ...rest] = splitParams(String(raw ?? ''));
  const params = {};
  const parts = {};
  for (const piece of rest) {
    const eq = piece.indexOf('=');
    if (eq < 1) continue;
    const key = piece.slice(0, eq).trim().toLowerCase();
    let value = piece.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    const star = key.indexOf('*');
    if (star < 0) {
      params[key] = value;
      continue;
    }
    const base = key.slice(0, star);
    (parts[base] ??= []).push({ key, value });
  }
  for (const [base, list] of Object.entries(parts)) {
    const sorted = list.sort((a, b) => (Number(a.key.split('*')[1]) || 0) - (Number(b.key.split('*')[1]) || 0));
    let joined = sorted.map((p) => p.value).join('');
    const encoded = sorted[0].key.endsWith('*');
    if (encoded) {
      const quote = joined.indexOf("'");
      const second = quote >= 0 ? joined.indexOf("'", quote + 1) : -1;
      const charset = quote > 0 ? joined.slice(0, quote) : 'utf-8';
      const encodedText = second >= 0 ? joined.slice(second + 1) : joined;
      try {
        joined = new TextDecoder(charset).decode(percentBytes(encodedText));
      } catch {
        joined = encodedText;
      }
    }
    params[base] = joined;
  }
  return { value: first.trim().toLowerCase(), params };
}

// The parts of a multipart body between its boundary lines.
function multipartParts(body, boundary) {
  const lines = body.split(/\r?\n/);
  const open = `--${boundary}`;
  const close = `--${boundary}--`;
  const parts = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === close) {
      if (current) parts.push(current.join('\r\n'));
      return parts;
    }
    if (trimmed === open) {
      if (current) parts.push(current.join('\r\n'));
      if (parts.length >= MAX_PARTS) return parts;
      current = [];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) parts.push(current.join('\r\n'));
  return parts;
}

// A part's content as text. Base64 and quoted-printable are ASCII, which mailcow left alone: they
// are decoded as bytes in the part's charset, and an entity such as &#8212; in them is the letter's
// own. 7bit, 8bit and binary parts went through mailcow's conversion, which is undone here.
function partText(body, encoding, charset) {
  if (encoding === 'base64' || encoding === 'quoted-printable') {
    return decodeBodyPart(Buffer.from(body, 'latin1'), encoding, charset);
  }
  return decodeStoredLetter(body);
}

function partSize(body, encoding) {
  if (encoding === 'base64') return Math.floor(body.replace(/\s/g, '').length * 3 / 4);
  return Buffer.byteLength(body, 'utf8');
}

function walk(text, depth, out) {
  if (out.parts >= MAX_PARTS) return;
  out.parts += 1;
  const { head, body } = splitEntity(text);
  const headers = headerMap(headerLines(head));
  const type = headerParams(headers['content-type'] || 'text/plain');
  const disposition = headerParams(headers['content-disposition'] || '');
  const encoding = String(headers['content-transfer-encoding'] || '').trim().toLowerCase();
  if (type.value.startsWith('multipart/') && type.params.boundary) {
    if (depth >= MAX_DEPTH) return;
    for (const part of multipartParts(body, type.params.boundary)) walk(part, depth + 1, out);
    return;
  }
  const filename = decodeMimeWords(disposition.params.filename || type.params.name || '').slice(0, MAX_HEADER_VALUE) || null;
  const inline = disposition.value !== 'attachment' && !filename;
  if (inline && type.value === 'text/html' && out.html === null) {
    const html = partText(body, encoding, type.params.charset);
    out.html = html.slice(0, MAX_HTML);
    if (html.length > MAX_HTML) out.truncated = true;
    return;
  }
  if (inline && (type.value === 'text/plain' || type.value === '') && out.text === null) {
    const plain = partText(body, encoding, type.params.charset);
    out.text = plain.slice(0, MAX_TEXT);
    if (plain.length > MAX_TEXT) out.truncated = true;
    return;
  }
  out.attachments.push({
    filename: filename || (type.value === 'message/rfc822' ? 'message.eml' : null),
    type: (type.value || 'application/octet-stream').slice(0, 200),
    size: partSize(body, encoding),
  });
}

// The SFV field of X-Forefront-Antispam-Report (EOP's spam filtering verdict), read like CAT.
function eopVerdict(value) {
  if (!value) return null;
  for (const field of String(value).split(/[;\n]/)) {
    const colon = field.indexOf(':');
    if (colon < 0 || field.slice(0, colon).trim().toUpperCase() !== 'SFV') continue;
    const verdict = field.slice(colon + 1).trim().toUpperCase();
    if (/^[A-Z]{1,8}$/.test(verdict)) return verdict;
  }
  return null;
}

// A quarantined letter for the screen: its first MAX_HEADERS headers in order (unfolded, encoded
// words decoded), the addresses and subject (a header given twice counts once: the first Subject,
// From, Date and Message-ID; To and Cc joined), EOP's verdict and category from
// X-Forefront-Antispam-Report, its HTML and text (the screen shows them only through the safe text
// view, utils/safeView.js) and its attachments by name, type and size (never their content).
export function parseQuarantineLetter(stored) {
  const raw = String(stored ?? '');
  const { head } = splitEntity(raw);
  const lines = headerLines(head);
  const headers = headerMap(lines);
  const out = { parts: 0, html: null, text: null, attachments: [], truncated: false };
  walk(raw, 0, out);
  const cap = (value) => (value ? decodeMimeWords(value).slice(0, MAX_HEADER_VALUE) : null);
  const first = (name) => cap(headers[name]?.split('\n')[0]);
  const all = (name) => cap(headers[name]?.split('\n').join(', '));
  const report = headers['x-forefront-antispam-report'] ?? null;
  return {
    headers: lines.slice(0, MAX_HEADERS).map(({ name, value }) => ({ name: name.slice(0, 200), value: cap(value) ?? '' })),
    headersTruncated: lines.length > MAX_HEADERS,
    from: first('from'),
    to: all('to'),
    cc: all('cc'),
    subject: first('subject'),
    date: first('date'),
    messageId: first('message-id'),
    eop: report ? { verdict: eopVerdict(report), category: eopCategory(report) } : null,
    html: out.html,
    text: out.text,
    attachments: out.attachments,
    truncated: out.truncated,
  };
}

// ── rspamd history ─────────────────────────────────────────────────────────────────────────────

// How far back a lookup reads (mailcow keeps 1000 rows) and how long one read serves every lookup:
// a page of "why" lookups or a quarantine listing costs the node one history read a minute.
export const HISTORY_ROWS = 1000;
export const HISTORY_TTL_MS = 60 * 1000;
let historyCache = null;
let historyRead = null;

// The node's recent rspamd history, cached briefly; lookups during a read share it.
export async function readRspamdHistory(cfg, { now = Date.now() } = {}) {
  if (historyCache && historyCache.host === cfg.mailHost && now - historyCache.at < HISTORY_TTL_MS) return historyCache.rows;
  if (historyRead && historyRead.host === cfg.mailHost) return historyRead.promise;
  const promise = getRspamdHistory(cfg, HISTORY_ROWS)
    .then((rows) => {
      historyCache = { host: cfg.mailHost, at: Date.now(), rows };
      return rows;
    })
    .finally(() => { if (historyRead?.promise === promise) historyRead = null; });
  historyRead = { host: cfg.mailHost, promise };
  return promise;
}

export function clearRspamdHistoryCache() {
  historyCache = null;
  historyRead = null;
}

const bareMessageId = (value) => String(value ?? '').trim().replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase();
const timeOf = (value) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};
const distance = (row, ms) => (ms === null || !row.time ? 0 : Math.abs(Date.parse(row.time) - ms));
const closest = (rows, ms) => [...rows].sort((a, b) => distance(a, ms) - distance(b, ms))[0] ?? null;

// Without a Message-ID the recipient, the subject and a time this close to the letter's date
// decide: the date is the sender's own header and can be off. A letter without a subject either
// needs a time this much closer.
const NO_ID_WINDOW_MS = 30 * 60 * 1000;
const NO_ID_NO_SUBJECT_WINDOW_MS = 2 * 60 * 1000;

const domainOf = (address) => String(address).slice(String(address).lastIndexOf('@') + 1);
const rowRecipients = (row) => [...row.rcptSmtp, ...row.rcptMime];

// The history row of a letter, { row, matchedBy } or null:
// - by its Message-ID with one of the mailbox's addresses among the recipients ('message_id'),
//   the one closest to the letter's date;
// - by its Message-ID on a row for another recipient on one of the node's domains
//   ('message_id_other_rcpt': the letter reached this mailbox through an address the panel does
//   not know, such as a node alias); never a row only for other domains;
// - without a Message-ID, a row for one of its addresses with the same subject within
//   NO_ID_WINDOW_MS, or within NO_ID_NO_SUBJECT_WINDOW_MS when the letter has no subject
//   ('recipient_time').
export function findHistoryEntry(rows, { messageId, recipients = [], date = null, subject = null, nodeDomains = [] }) {
  const wanted = new Set(recipients.map((r) => String(r).toLowerCase()));
  const domains = new Set([...nodeDomains, ...[...wanted].map(domainOf)].map((d) => String(d).toLowerCase()));
  const forMailbox = (row) => rowRecipients(row).some((r) => wanted.has(r));
  const onNode = (row) => rowRecipients(row).some((r) => domains.has(domainOf(r)));
  const ms = timeOf(date);
  const id = bareMessageId(messageId);
  if (id) {
    const same = rows.filter((row) => bareMessageId(row.messageId) === id);
    const own = closest(same.filter(forMailbox), ms);
    if (own) return { row: own, matchedBy: 'message_id' };
    const other = closest(same.filter(onNode), ms);
    return other ? { row: other, matchedBy: 'message_id_other_rcpt' } : null;
  }
  if (ms === null || !wanted.size) return null;
  const title = String(subject ?? '').trim();
  const window = title ? NO_ID_WINDOW_MS : NO_ID_NO_SUBJECT_WINDOW_MS;
  const near = rows.filter((row) => forMailbox(row) && row.time && distance(row, ms) <= window
    && row.subject.trim() === title);
  const row = closest(near, ms);
  return row ? { row, matchedBy: 'recipient_time' } : null;
}

// A promise or null after `ms`: a listing never waits long for a slow history read (the read goes
// on and fills the cache for the next one).
export function withDeadline(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), late]);
}

// Letters rspamd refused or marked as spam for the given mailboxes, as the history shows them: when
// there are some and the quarantine is empty, mailcow's quarantine is probably off (a new mailcow
// keeps nothing until its size and retention are set), unless someone released or deleted them.
const QUARANTINED_ACTIONS = new Set(['reject', 'add header', 'rewrite subject']);
export function spamRowsFor(rows, mailboxes) {
  return rows.filter((row) => QUARANTINED_ACTIONS.has(row.action) && rowRecipients(row).some((r) => mailboxes.has(r))).length;
}

// A quarantine row and the history row of the same scan: the history keeps no queue id, so the
// recipient, the score and a time within QUARANTINE_WINDOW_MS (the quarantine row is written right
// after the scan) decide; the subject too when both have one.
const QUARANTINE_WINDOW_MS = 2 * 60 * 1000;
export function historyForQuarantine(item, rows) {
  const ms = timeOf(item.created);
  if (ms === null || item.score === null) return null;
  const near = rows.filter((row) => row.score !== null && Math.abs(row.score - item.score) < 0.005
    && row.time && distance(row, ms) <= QUARANTINE_WINDOW_MS
    && (row.rcptSmtp.includes(item.rcpt) || row.rcptMime.includes(item.rcpt))
    && (!item.subject || !row.subject || row.subject.trim() === item.subject.trim()));
  return closest(near, ms);
}

// The few symbols that weigh most, for a list.
export function topSymbols(symbols, count = 3) {
  return symbols.filter((s) => s.score > 0).slice(0, count).map(({ name, score }) => ({ name, score }));
}

// ── Who sees the quarantine ────────────────────────────────────────────────────────────────────

// Administrators always. With this setting (kept with the node settings, off by default) every
// signed-in user also sees the entries addressed to the node mailboxes the panel has: mailboxes are
// shared by every user of the install (services/mailAccess.js), so that is the whole of what a
// user can open anyway. Releasing and deleting stay with administrators.
async function nodeConfigRow() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [MAIL_NODE_PROVIDER]);
  return rows[0]?.config ?? {};
}

// Merged into the node settings: the fields of the node form survive, and they survive this.
async function mergeNodeConfig(patch) {
  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = integration_config.config || EXCLUDED.config, updated_at = NOW()
  `, [MAIL_NODE_PROVIDER, patch]);
}

export async function getQuarantineUserView() {
  return (await nodeConfigRow()).quarantineUserView === true;
}

export async function setQuarantineUserView(enabled) {
  await mergeNodeConfig({ quarantineUserView: enabled === true });
}

// When an administrator last had the panel write mailcow's quarantine settings (null: never).
export async function getQuarantineSettingsAppliedAt() {
  const at = (await nodeConfigRow()).quarantineSettingsAppliedAt;
  return typeof at === 'string' ? at : null;
}

export async function markQuarantineSettingsApplied(at = new Date().toISOString()) {
  await mergeNodeConfig({ quarantineSettingsAppliedAt: at });
  return at;
}

// The domains the panel knows on the node.
export async function nodeDomainNames() {
  const { rows } = await query('SELECT domain FROM mail_node_domains');
  return rows.map((row) => String(row.domain).toLowerCase());
}

// The panel's node mailboxes by address: Map(email -> account id).
export async function panelNodeMailboxes() {
  const { rows } = await query('SELECT id, lower(email_address) AS email FROM email_accounts WHERE mail_node = true');
  return new Map(rows.map((row) => [row.email, row.id]));
}
