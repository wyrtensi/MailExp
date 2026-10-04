import { safeFetch } from '../safeFetch.js';
import { getTenantDriver, tenantOf } from '../tenant/driver.js';
import { getEopSettings } from './eopSettings.js';

// Where the panel reads Microsoft's message trace for R-43 (letters to the node's domains that EOP
// received while the node was down): a small interface, so the tenant driver of stage 7 (R-22,
// R-30) plugs in without touching the correlation (services/mailNode/outageTrace.js).
//
//   source.list({ start, end, recipientDomains, statuses, maxRequests, cursor })
//     -> { rows, requests, complete, cursor }
//   (an unfinished listing returns a cursor; passed back, the listing goes on from there)
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
// - createFixtureTraceSource({ rows, details }): rows in memory, for tests and the demo;
// - tenantTraceSource(driver, tenant) (stage 7c): the Graph driver with the tenant driver's token.
// resolveTraceSource() picks one, or null: "trace not connected", the outage windows still show.
// getTraceSource() is its synchronous part (a test's source or MAIL_NODE_TRACE_URL only).

export const TRACE_STATUSES = Object.freeze(['gettingStatus', 'pending', 'failed', 'delivered', 'expanded', 'quarantined', 'filteredAsSpam']);
const DAY_MS = 24 * 60 * 60 * 1000;
export const TRACE_MAX_RANGE_MS = 10 * DAY_MS;
export const TRACE_HISTORY_MS = 90 * DAY_MS;
// Graph's largest page: a long window lists the whole tenant's mail (no domain filter), so fewer,
// larger pages spend less of the request budget.
export const TRACE_PAGE_SIZE = 5000;
const TRACE_TIMEOUT_MS = 30000;
// The most a single answer may hold: 5000 rows of a few hundred bytes, with room.
export const TRACE_MAX_BYTES = 16 * 1024 * 1024;

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

// The body of an answer as JSON, read up to max bytes: a larger one is refused rather than read.
export async function readJsonCapped(res, max) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new TraceSourceError('trace_failed', 'The message trace answered too much');
  let text;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new TraceSourceError('trace_failed', 'The message trace answered too much');
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  } else {
    text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
    if (Buffer.byteLength(text) > max) throw new TraceSourceError('trace_failed', 'The message trace answered too much');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TraceSourceError('trace_failed', 'The message trace did not answer with JSON');
  }
}

export function createGraphTraceSource({
  baseUrl, getToken = null, fetchImpl = null, pageSize = TRACE_PAGE_SIZE, allowPrivate = false, now = () => Date.now(),
  onAuthFailure = null,
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
      // A redirect is refused: a next page or a token must not be sent anywhere else.
      res = await doFetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(TRACE_TIMEOUT_MS) });
    } catch (err) {
      throw new TraceSourceError('trace_unreachable', `The message trace is unreachable (${err?.code || err?.name || 'error'})`);
    }
    if (res.status === 429) throw new TraceSourceError('trace_throttled', 'The message trace asked to slow down (HTTP 429)');
    if (res.status === 401 || res.status === 403) {
      // A token refused (401): the next request asks for a new one instead of sending it again. A
      // 403 is a missing right or role, which a new token does not change.
      if (res.status === 401) onAuthFailure?.();
      throw new TraceSourceError('trace_auth', `The message trace refused the request (HTTP ${res.status})`);
    }
    if (!res.ok) throw new TraceSourceError('trace_failed', `The message trace answered HTTP ${res.status}`);
    return readJsonCapped(res, TRACE_MAX_BYTES);
  }

  return {
    kind: 'graph',
    // cursor: { range, next } — the part of [start, end] and the next page an earlier call stopped at.
    async list({ start, end, recipientDomains = null, statuses = null, maxRequests = 20, cursor = null }) {
      const rows = [];
      let requests = 0;
      const ranges = traceRanges(start, end, now());
      const first = cursor && Number.isInteger(cursor.range) && cursor.range < ranges.length ? cursor.range : 0;
      for (let index = first; index < ranges.length; index += 1) {
        const [from, to] = ranges[index];
        const filter = `receivedDateTime ge ${graphTime(from)} and receivedDateTime le ${graphTime(to)}`;
        let url = index === first && cursor?.next ? cursor.next : `${base}/admin/exchange/tracing/messageTraces?$filter=${encodeURIComponent(filter)}&$top=${pageSize}`;
        while (url) {
          if (requests >= maxRequests) {
            return { rows: keepRows(rows, { recipientDomains, statuses }), requests, complete: false, cursor: { range: index, next: url } };
          }
          let body;
          try {
            body = await get(url);
          } catch (err) {
            // The requests this call sent, the failed one included, for the caller's budget.
            err.requests = requests + 1;
            throw err;
          }
          requests += 1;
          for (const item of Array.isArray(body?.value) ? body.value : []) {
            const row = normalizeTraceRow(item);
            if (row) rows.push(row);
          }
          url = typeof body?.['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : null;
        }
      }
      return { rows: keepRows(rows, { recipientDomains, statuses }), requests, complete: true, cursor: null };
    },
    async details(row) {
      const url = `${base}/admin/exchange/tracing/messageTraces/${encodeURIComponent(row.id)}`
        + `/getDetailsByRecipient(recipientAddress='${encodeURIComponent(ODATA_QUOTE(row.recipientAddress))}')`;
      let body;
      try {
        body = await get(url);
      } catch (err) {
        err.requests = 1;
        throw err;
      }
      const events =(Array.isArray(body?.value) ? body.value : []).map(normalizeTraceEvent).filter(Boolean);
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
      return { rows: keepRows(inRange, { recipientDomains, statuses }), requests: 1, complete: true, cursor: null };
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
// panel; with NODE_ENV=production it is refused unless MAIL_NODE_TRACE_STAND=1 says this is a test
// stand, and it is named in the log once.
let warned = false;
export function getTraceSource({ env = process.env, warn = (line) => console.warn(line) } = {}) {
  if (override) return override;
  const url = String(env.MAIL_NODE_TRACE_URL ?? '').trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  const stand = env.MAIL_NODE_TRACE_STAND === '1';
  if (env.NODE_ENV === 'production' && !stand) {
    if (!warned) warn('MAIL_NODE_TRACE_URL is ignored: it is a test stand aid (set MAIL_NODE_TRACE_STAND=1 on a stand)');
    warned = true;
    return null;
  }
  if (!warned) warn('Mail node trace: MAIL_NODE_TRACE_URL is set, the trace of a test stand is read without a token');
  warned = true;
  return createGraphTraceSource({ baseUrl: url, allowPrivate: true });
}

// Tests: the next getTraceSource warns again.
export function resetTraceSourceWarning() {
  warned = false;
}

// Stage 7c: the tenant's own message trace through the tenant driver (R-22): Graph's URL shapes on
// the driver's Graph base (Microsoft's, or the stand's with TENANT_DRIVER_STAND=1), a token from the
// driver's GraphClient (client credentials, the assertion signed by the tenant worker), and the
// driver's fetch (the fake's for TENANT_DRIVER=fake). A 401 or 403 drops the cached token so the
// next pass asks for a new one. Graph rather than Get-MessageTraceV2: the interface already has
// Graph's shapes; whether Graph serves an add-on tenant is experiment 19, and Get-MessageTraceV2
// through the worker is the fallback behind the same interface if it does not.
export function tenantTraceSource(driver, tenant) {
  const session = driver.forTenant(tenant);
  const source = createGraphTraceSource({
    baseUrl: driver.graphUrl,
    getToken: () => session.graph.getToken(),
    fetchImpl: driver.graphFetch ?? null,
    onAuthFailure: () => session.graph.dropToken?.(),
    // HTTPS to a public address only, like the driver's GraphClient (a stand's TENANT_GRAPH_URL too).
  });
  return { ...source, kind: 'tenant' };
}

// The trace a pass or a screen uses now, or null ("not connected"): a source set by a test or the
// demo, else MAIL_NODE_TRACE_URL (a stand), else the tenant driver with a configured tenant (the
// EOP settings are read each time: the tenant may be filled in or cleared at any moment).
export async function resolveTraceSource({ env = process.env, warn } = {}) {
  const set = getTraceSource({ env, ...(warn ? { warn } : {}) });
  if (set) return set;
  const driver = getTenantDriver();
  if (!driver) return null;
  const tenant = tenantOf(await getEopSettings());
  return tenant ? tenantTraceSource(driver, tenant) : null;
}
