import { safeFetch } from '../safeFetch.js';

// Where the panel reads Microsoft's message trace for R-43 (letters to the node's domains that EOP
// received while the node was down): a small interface, so the tenant driver of stage 7 (R-22,
// R-30) plugs in without touching the correlation (services/mailNode/outageTrace.js).
//
//   source.list({ start, end, recipientDomains, statuses, maxRequests })
//     -> { rows, requests, complete }
//   source.details(row) -> { events, requests }
//
// Rows have the shape of Graph's exchangeMessageTrace (GET /admin/exchange/tracing/messageTraces):
// { id, senderAddress, recipientAddress, subject, messageId, receivedDateTime, size, fromIP, toIP,
// status }, one per recipient, status one of TRACE_STATUSES. Events have the shape of
// exchangeMessageTraceDetail (getDetailsByRecipient): { id, messageId, dateTime, event, action,
// description, data }; event is a word such as Receive, Defer, Send, Deliver, Fail (Learn shows
// them in title case, the PowerShell cmdlets in upper case: compare without case).
//
// Graph's $filter documents receivedDateTime ge/le, recipientAddress eq, id eq and contains(subject)
// but no domain wildcard, so the Graph-shaped driver asks once per time range (both bounds always:
// without them Graph answers the last 48 hours) and keeps the rows of the given recipient domains
// itself. A range longer than 10 days is asked in parts; pages follow @odata.nextLink on the same
// origin only. Graph allows 100 requests per 5 minutes per tenant for the list and as many again for
// the details: callers pass maxRequests and count what each call reports.
//
// Drivers:
// - createGraphTraceSource({ baseUrl, getToken }): the Graph URL shapes. Stage 7 gives it a token
//   provider (client credentials with the tenant app's certificate); without one it sends no
//   Authorization header, which only the stand's fake-EOP answers (MAIL_NODE_TRACE_URL, below);
// - createFixtureTraceSource({ rows, details }): rows in memory, for tests and the demo.
// getTraceSource() picks one, or null: "trace not connected", the outage windows still show.

export const TRACE_STATUSES = Object.freeze(['gettingStatus', 'pending', 'failed', 'delivered', 'expanded', 'quarantined', 'filteredAsSpam']);
const DAY_MS = 24 * 60 * 60 * 1000;
export const TRACE_MAX_RANGE_MS = 10 * DAY_MS;
export const TRACE_HISTORY_MS = 90 * DAY_MS;
export const TRACE_PAGE_SIZE = 1000;
const TRACE_TIMEOUT_MS = 30000;

export class TraceSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TraceSourceError';
    this.code = code;
  }
}

const lower = (value) => String(value ?? '').trim().toLowerCase();

// The domain of an address, lower case; '' without one.
export function domainOf(address) {
  const text = lower(address);
  const at = text.lastIndexOf('@');
  return at < 0 ? '' : text.slice(at + 1);
}

// One trace row with addresses in lower case and the time as ISO; null for a row without id,
// recipient or a readable receivedDateTime.
export function normalizeTraceRow(row) {
  if (!row || typeof row !== 'object') return null;
  const received = Date.parse(row.receivedDateTime);
  const recipient = lower(row.recipientAddress);
  if (!row.id || !recipient || !Number.isFinite(received)) return null;
  return {
    id: String(row.id),
    senderAddress: lower(row.senderAddress),
    recipientAddress: recipient,
    subject: row.subject == null ? null : String(row.subject),
    messageId: row.messageId ? String(row.messageId) : null,
    receivedDateTime: new Date(received).toISOString(),
    size: Number.isFinite(Number(row.size)) ? Number(row.size) : null,
    fromIP: row.fromIP ? String(row.fromIP) : null,
    toIP: row.toIP ? String(row.toIP) : null,
    status: String(row.status ?? ''),
  };
}

export function normalizeTraceEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const at = Date.parse(event.dateTime);
  return {
    dateTime: Number.isFinite(at) ? new Date(at).toISOString() : null,
    event: String(event.event ?? ''),
    action: String(event.action ?? ''),
    description: String(event.description ?? ''),
    data: String(event.data ?? ''),
  };
}

// Keeps the rows of the recipient domains (all when none are given) and statuses (all when none).
export function keepRows(rows, { recipientDomains = null, statuses = null } = {}) {
  const domains = recipientDomains?.length ? new Set(recipientDomains.map(lower)) : null;
  const wanted = statuses?.length ? new Set(statuses) : null;
  return rows.filter((row) => (!domains || domains.has(domainOf(row.recipientAddress))) && (!wanted || wanted.has(row.status)));
}

// Graph takes ISO 8601 without fractions: YYYY-MM-DDThh:mm:ssZ.
export function graphTime(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

// [start, end] cut to what Graph serves (at most 90 days back, not after now) and into parts of
// at most 10 days.
export function traceRanges(start, end, now = Date.now()) {
  const from = Math.max(start, now - TRACE_HISTORY_MS + 60 * 1000);
  const to = Math.min(end, now);
  const ranges = [];
  for (let at = from; at < to; at += TRACE_MAX_RANGE_MS) ranges.push([at, Math.min(at + TRACE_MAX_RANGE_MS, to)]);
  return ranges;
}

const ODATA_QUOTE = (value) => String(value).replace(/'/g, "''");

export function createGraphTraceSource({
  baseUrl, getToken = null, fetchImpl = null, pageSize = TRACE_PAGE_SIZE, allowPrivate = false, now = () => Date.now(),
}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const doFetch = fetchImpl ?? ((url, options) => safeFetch(url, options, { allowPrivate, requireHttps: !allowPrivate }));

  async function get(url) {
    if (new URL(url).origin !== origin) throw new TraceSourceError('trace_failed', 'The trace answered a next page on another host');
    const headers = { Accept: 'application/json' };
    if (getToken) headers.Authorization = `Bearer ${await getToken()}`;
    let res;
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(TRACE_TIMEOUT_MS) });
    } catch (err) {
      throw new TraceSourceError('trace_unreachable', `The message trace is unreachable (${err?.code || err?.name || 'error'})`);
    }
    if (res.status === 429) throw new TraceSourceError('trace_throttled', 'The message trace asked to slow down (HTTP 429)');
    if (res.status === 401 || res.status === 403) throw new TraceSourceError('trace_auth', `The message trace refused the request (HTTP ${res.status})`);
    if (!res.ok) throw new TraceSourceError('trace_failed', `The message trace answered HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new TraceSourceError('trace_failed', 'The message trace did not answer with JSON');
    }
  }

  return {
    kind: 'graph',
    async list({ start, end, recipientDomains = null, statuses = null, maxRequests = 20 }) {
      const rows = [];
      let requests = 0;
      for (const [from, to] of traceRanges(start, end, now())) {
        const filter = `receivedDateTime ge ${graphTime(from)} and receivedDateTime le ${graphTime(to)}`;
        let url = `${base}/admin/exchange/tracing/messageTraces?$filter=${encodeURIComponent(filter)}&$top=${pageSize}`;
        while (url) {
          if (requests >= maxRequests) return { rows: keepRows(rows, { recipientDomains, statuses }), requests, complete: false };
          const body = await get(url);
          requests += 1;
          for (const item of Array.isArray(body?.value) ? body.value : []) {
            const row = normalizeTraceRow(item);
            if (row) rows.push(row);
          }
          url = typeof body?.['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : null;
        }
      }
      return { rows: keepRows(rows, { recipientDomains, statuses }), requests, complete: true };
    },
    async details(row) {
      const url = `${base}/admin/exchange/tracing/messageTraces/${encodeURIComponent(row.id)}`
        + `/getDetailsByRecipient(recipientAddress='${encodeURIComponent(ODATA_QUOTE(row.recipientAddress))}')`;
      const body = await get(url);
      const events = (Array.isArray(body?.value) ? body.value : []).map(normalizeTraceEvent).filter(Boolean);
      return { events, requests: 1 };
    },
  };
}

// rows: Graph-shaped rows; details: { '<id>|<recipient>': [events] }. Counts one request per list
// call and per details call, like the Graph driver without paging.
export function createFixtureTraceSource({ rows = [], details = {} } = {}) {
  return {
    kind: 'fixture',
    async list({ start, end, recipientDomains = null, statuses = null }) {
      const inRange = rows.map(normalizeTraceRow).filter(Boolean).filter((row) => {
        const at = Date.parse(row.receivedDateTime);
        return at >= start && at <= end;
      });
      return { rows: keepRows(inRange, { recipientDomains, statuses }), requests: 1, complete: true };
    },
    async details(row) {
      const events = (details[`${row.id}|${lower(row.recipientAddress)}`] ?? []).map(normalizeTraceEvent).filter(Boolean);
      return { events, requests: 1 };
    },
  };
}

let override = null;

// Tests and the demo set a source of their own; null puts the configured one back.
export function setTraceSource(source) {
  override = source;
}

// The configured trace, or null when none is: the tenant driver of stage 7 goes here. Until then
// only MAIL_NODE_TRACE_URL connects one: the Graph URL shapes without a token, for the stand's
// fake-EOP (scripts/deploy/test/fake-eop, `trace` endpoint), on a private address over plain HTTP.
// It is a test aid set in the backend's environment by whoever runs the backend, never from the
// panel.
export function getTraceSource({ env = process.env } = {}) {
  if (override) return override;
  const url = String(env.MAIL_NODE_TRACE_URL ?? '').trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return createGraphTraceSource({ baseUrl: url, allowPrivate: true });
}
