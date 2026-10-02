// Rules of the screens for letters delayed or lost while the mail node was down (R-43; backend
// services/mailNode/outages.js and outageTrace.js): the notice in a mailbox and the administrators'
// outage windows. Pure functions, tested in mailNodeOutage.test.js.

const MINUTE_MS = 60000;
// EOP keeps what it could not deliver for 24 hours, then returns it to the sender.
export const EOP_EXPIRY_HOURS = 24;
export const MAX_REASON_LENGTH = 500;
export const MAX_RETENTION_DAYS = 90;
// The order a list shows the outcomes in: what still needs doing first.
export const OUTCOME_ORDER = Object.freeze(['waiting', 'lost', 'delayed', 'other']);

// How long until EOP gives up on a waiting letter: { hours, minutes } or { past: true } once the
// time has gone by (the trace has not said what happened yet); null without a time.
export function timeLeft(expiresAt, now = Date.now()) {
  const at = Date.parse(expiresAt ?? '');
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  if (left <= 0) return { past: true };
  const minutes = Math.ceil(left / MINUTE_MS);
  return { past: false, hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

// The words of a letter's outcome: a key of messageList.outage.
export function outcomeKey(letter) {
  switch (letter?.outcome) {
    case 'waiting': return 'messageList.outage.outcomeWaiting';
    case 'lost': return letter.expired ? 'messageList.outage.outcomeLostExpired' : 'messageList.outage.outcomeLost';
    case 'delayed': return 'messageList.outage.outcomeDelayed';
    default: return 'messageList.outage.outcomeOther';
  }
}

// What the reader should do about it: a key, or null when nothing.
export function adviceKey(letter) {
  if (letter?.outcome === 'lost') return 'messageList.outage.adviceLost';
  if (letter?.outcome === 'waiting') return 'messageList.outage.adviceWaiting';
  return null;
}

const byOutcome = (a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome)
  || Date.parse(b.receivedAt) - Date.parse(a.receivedAt);

// The letters of one mailbox (all mailboxes for the unified inbox: accountId null), waiting and
// lost first, newest first within each.
export function lettersFor(letters, accountId) {
  return (Array.isArray(letters) ? letters : [])
    .filter((letter) => accountId == null || letter.accountId === accountId)
    .sort(byOutcome);
}

// Counts per outcome: { waiting, lost, delayed, total }.
export function letterCounts(letters) {
  const counts = { waiting: 0, lost: 0, delayed: 0, total: 0 };
  for (const letter of letters ?? []) {
    if (counts[letter.outcome] != null) counts[letter.outcome] += 1;
    counts.total += 1;
  }
  return counts;
}

// The line that heads the notice: a key and its values, waiting and lost first.
export function noticeSummary(letters) {
  const counts = letterCounts(letters);
  if (counts.waiting) return { key: 'messageList.outage.summaryWaiting', values: { count: counts.waiting, total: counts.total } };
  if (counts.lost) return { key: 'messageList.outage.summaryLost', values: { count: counts.lost, total: counts.total } };
  return { key: 'messageList.outage.summaryDelayed', values: { count: counts.total } };
}

// How long a window lasted (or lasts, while open): minutes.
export function windowMinutes(window, now = Date.now()) {
  const start = Date.parse(window?.startedAt ?? '');
  const end = window?.endedAt ? Date.parse(window.endedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / MINUTE_MS)) : null;
}

// minutes -> { key, values }: "45 min", "3 h 05 min", "2 d 4 h".
export function durationParts(minutes) {
  if (minutes == null) return { key: 'admin.outages.durationUnknown', values: {} };
  if (minutes < 60) return { key: 'admin.outages.durationMinutes', values: { minutes } };
  if (minutes < 48 * 60) return { key: 'admin.outages.durationHours', values: { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, '0') } };
  return { key: 'admin.outages.durationDays', values: { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60) } };
}

// The value of a datetime-local field for an ISO time, in the browser's zone ('' without one).
export function toLocalInput(iso) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// A datetime-local value as ISO (read in the browser's zone); null when empty or unreadable.
export function fromLocalInput(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

// The first problem of the "mark a window" form, as a key, or null. form: { start, end, reason }
// (datetime-local values and text); requireStart: false for closing, which only takes an end.
export function outageFormError(form, { requireStart = true } = {}) {
  const start = fromLocalInput(form?.start);
  const end = fromLocalInput(form?.end);
  if (requireStart && !start) return 'admin.outages.errorStart';
  if (form?.end && !end) return 'admin.outages.errorEnd';
  if (start && end && Date.parse(end) < Date.parse(start)) return 'admin.outages.errorEndBeforeStart';
  const reason = String(form?.reason ?? '').trim();
  if (!reason) return 'admin.outages.errorReason';
  if (reason.length > MAX_REASON_LENGTH) return 'admin.outages.errorReasonTooLong';
  return null;
}

// How the window came to be: a key of admin.outages.
export function windowSourceKey(window) {
  if (window?.source === 'detected') return 'admin.outages.sourceDetected';
  return window?.planned ? 'admin.outages.sourcePlanned' : 'admin.outages.sourceManual';
}

// What the alert job saw fail, in words: keys of admin.outages with values.
export function causeParts(window) {
  const cause = window?.cause ?? {};
  const parts = [];
  if ((cause.signals ?? []).includes('api_unreachable')) parts.push({ key: 'admin.outages.causeApi', values: {} });
  if ((cause.down ?? []).length) {
    parts.push({ key: 'admin.outages.causeContainers', values: { names: cause.down.map((c) => `${c.name} (${c.state || '?'})`).join(', ') } });
  }
  return parts;
}

// The letters still waiting in EOP's queue over every window: { count, soonest } (soonest: the
// expiry of the first EOP will give up on), from the server's summary.
export function waitingBanner(waiting) {
  if (!waiting?.waiting) return null;
  return { count: waiting.waiting, soonest: waiting.soonestExpiresAt ?? null };
}
