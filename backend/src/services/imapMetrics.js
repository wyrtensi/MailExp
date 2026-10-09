// In-memory IMAP connection metrics for the diagnostics report (measure-first, behavior-neutral).
//
// Counts login attempts per provider host and purpose, background-work skips, and folder status
// cycles, with per-minute buckets for the last hour. The purpose is the fixed connect label
// ("IMAP pool connect", "Backfill connect", ...), never user data. Hosts are kept raw here and
// mapped to a coarse provider name by the report, so a custom-domain host never leaves the
// process. Reset on restart.

const WINDOW_MINUTES = 60;

function minuteOf(t) { return Math.floor(t / 60000); }

function newCounter() {
  return { total: 0, failures: 0, minutes: new Map() }; // minute index -> count
}

function bump(counter, t, failed) {
  counter.total += 1;
  if (failed) counter.failures += 1;
  const m = minuteOf(t);
  counter.minutes.set(m, (counter.minutes.get(m) || 0) + 1);
  for (const key of counter.minutes.keys()) {
    if (key <= m - WINDOW_MINUTES) counter.minutes.delete(key);
  }
}

const logins = new Map();   // "host|purpose" -> counter
const events = new Map();   // "host|event" -> counter
const cycles = new Map();   // "host|mode" -> { count, failures, sumMs, maxMs }

function counterFor(map, key) {
  let c = map.get(key);
  if (!c) map.set(key, c = newCounter());
  return c;
}

// One login attempt (TCP + TLS + authentication). A retry of the same connect counts again,
// because the provider sees it again. The retry suffix is dropped from the purpose.
export function recordImapLogin(host, label, { failed = false, now = Date.now() } = {}) {
  const purpose = String(label || 'unknown').replace(/ (?:token-retry|IPv4-retry)/g, '');
  bump(counterFor(logins, `${String(host || '').toLowerCase()}|${purpose}`), now, failed);
}

// Work that was skipped or refused: 'pool_busy' (any caller that gave up waiting for a pooled
// connection, background or user action), 'pool_refresh_failed' (a reused pooled session that did
// not answer its NOOP and was closed), 'integrity_slot_full', 'refusal'.
export function recordImapEvent(host, event, { now = Date.now() } = {}) {
  bump(counterFor(events, `${String(host || '').toLowerCase()}|${event}`), now, false);
}

// One folder status cycle. mode: 'list-status' (one command for every folder), 'rotation'
// (STATUS for a few folders) or 'not-connected'. queryMs is the folder query with its cache
// counts; ms the whole cycle.
export function recordStatusCycle(host, mode, { ms, queryMs, failed = false } = {}) {
  const key = `${String(host || '').toLowerCase()}|${mode}`;
  const c = cycles.get(key) || { count: 0, failures: 0, sumMs: 0, maxMs: 0, sumQueryMs: 0, maxQueryMs: 0 };
  c.count += 1;
  if (failed) c.failures += 1;
  if (Number.isFinite(ms)) { c.sumMs += ms; c.maxMs = Math.max(c.maxMs, ms); }
  if (Number.isFinite(queryMs)) { c.sumQueryMs += queryMs; c.maxQueryMs = Math.max(c.maxQueryMs, queryMs); }
  cycles.set(key, c);
}

function windowStats(minutes, now) {
  const current = minuteOf(now);
  let lastHour = 0, peakPerMinute = 0;
  for (const [m, n] of minutes) {
    if (m <= current - WINDOW_MINUTES) continue;
    lastHour += n;
    peakPerMinute = Math.max(peakPerMinute, n);
  }
  return { lastHour, peakPerMinute };
}

function mergeMinutes(target, source) {
  for (const [m, n] of source) target.set(m, (target.get(m) || 0) + n);
}

// Aggregates by provider, using the report's host -> provider mapping.
// Sums "host|label" counters into "provider|label" rows (label null: one row per provider).
function byProvider(map, providerFor, keepLabel) {
  const out = new Map();
  for (const [key, c] of map) {
    const [host, label] = key.split('|');
    const provider = providerFor(host);
    const id = keepLabel ? `${provider}|${label}` : provider;
    const e = out.get(id) || { provider, label, total: 0, failures: 0, minutes: new Map() };
    e.total += c.total;
    e.failures += c.failures;
    mergeMinutes(e.minutes, c.minutes);
    out.set(id, e);
  }
  return [...out.values()];
}

const byVolume = (a, b) => (b.lastHour - a.lastHour) || (b.total - a.total);

// Aggregates by provider, using the report's host -> provider mapping.
export function getImapSnapshot(providerFor, now = Date.now()) {
  const cycleRows = new Map();
  for (const [key, c] of cycles) {
    const [host, mode] = key.split('|');
    const provider = providerFor(host);
    const e = cycleRows.get(`${provider}|${mode}`) || { provider, mode, count: 0, failures: 0, sumMs: 0, maxMs: 0, sumQueryMs: 0, maxQueryMs: 0 };
    e.count += c.count; e.failures += c.failures;
    e.sumMs += c.sumMs; e.maxMs = Math.max(e.maxMs, c.maxMs);
    e.sumQueryMs += c.sumQueryMs; e.maxQueryMs = Math.max(e.maxQueryMs, c.maxQueryMs);
    cycleRows.set(`${provider}|${mode}`, e);
  }
  return {
    windowMinutes: WINDOW_MINUTES,
    loginsByProvider: byProvider(logins, providerFor, false)
      .map(e => ({ provider: e.provider, total: e.total, failures: e.failures, ...windowStats(e.minutes, now) })).sort(byVolume),
    logins: byProvider(logins, providerFor, true)
      .map(e => ({ provider: e.provider, purpose: e.label, total: e.total, failures: e.failures, ...windowStats(e.minutes, now) })).sort(byVolume),
    events: byProvider(events, providerFor, true)
      .map(e => ({ provider: e.provider, event: e.label, total: e.total, ...windowStats(e.minutes, now) })).sort(byVolume),
    statusCycles: [...cycleRows.values()].map(e => ({
      provider: e.provider, mode: e.mode, count: e.count, failures: e.failures,
      meanMs: e.count ? Math.round(e.sumMs / e.count) : 0, maxMs: Math.round(e.maxMs),
      meanQueryMs: e.count ? Math.round(e.sumQueryMs / e.count) : 0, maxQueryMs: Math.round(e.maxQueryMs),
    })),
  };
}

export function _resetImapMetrics() {
  logins.clear();
  events.clear();
  cycles.clear();
}
