// Send later: the preset times the composer offers and the checks on a time picked by hand. Times
// are the writer's local time (the browser's time zone); the server stores them as UTC. The server
// checks the same bounds (backend services/sendQueue.js parseSendAt). Pure: no DOM, no store.

export const LATER_TODAY_HOUR = 18;
export const MORNING_HOUR = 8;
// "Later today" is offered only while it is at least this far ahead.
export const LATER_TODAY_MIN_LEAD_MS = 60 * 60 * 1000;
// How far ahead a letter can be scheduled (the server's SEND_LATER_MAX_MS).
export const SEND_LATER_MAX_MS = 366 * 24 * 60 * 60 * 1000;

export const SEND_LATER_PRESET_LABEL_KEYS = Object.freeze({
  laterToday: 'scheduled.presets.laterToday',
  tomorrowMorning: 'scheduled.presets.tomorrowMorning',
  mondayMorning: 'scheduled.presets.mondayMorning',
});

export const SEND_AT_PROBLEM_KEYS = Object.freeze({
  invalid: 'scheduled.timeProblem.invalid',
  past: 'scheduled.timeProblem.past',
  tooFar: 'scheduled.timeProblem.tooFar',
});

function atHour(now, addDays, hour) {
  const d = new Date(now);
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// [{ key, at }]: later today at 18:00 (while it is an hour or more away), tomorrow morning at 8:00,
// and the coming Monday at 8:00 (left out when tomorrow is that Monday).
export function sendLaterPresets(now = new Date()) {
  const presets = [];
  const laterToday = atHour(now, 0, LATER_TODAY_HOUR);
  if (laterToday.getTime() - now.getTime() >= LATER_TODAY_MIN_LEAD_MS) presets.push({ key: 'laterToday', at: laterToday });
  presets.push({ key: 'tomorrowMorning', at: atHour(now, 1, MORNING_HOUR) });
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;
  if (daysToMonday !== 1) presets.push({ key: 'mondayMorning', at: atHour(now, daysToMonday, MORNING_HOUR) });
  return presets;
}

const pad = (n) => String(n).padStart(2, '0');

// The value of an <input type="datetime-local"> for a Date, in local time.
export function toLocalInputValue(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The Date an <input type="datetime-local"> value names, in local time, or null.
export function fromLocalInputValue(value) {
  const m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return Number.isFinite(d.getTime()) ? d : null;
}

// null when the time can be chosen, else why not: 'invalid', 'past' or 'tooFar'.
export function sendAtProblem(date, now = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return 'invalid';
  if (date.getTime() <= now.getTime()) return 'past';
  if (date.getTime() - now.getTime() > SEND_LATER_MAX_MS) return 'tooFar';
  return null;
}
