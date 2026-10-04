// The demo's fixtures are written as of DEMO_WRITTEN_AT and moved forward to today by whole days
// when the demo loads, so they keep their age (and their time of day): a letter written as sent
// two days before stays two days old, and nothing ages out of a limit counted from now (the node's
// log, Microsoft's 90-day message trace) however long after the demo was written it runs.
const DAY_MS = 24 * 60 * 60 * 1000;
// Every fixture is dated before this.
export const DEMO_WRITTEN_AT = Date.parse('2026-10-01T00:00:00.000Z');
export const DEMO_SHIFT_MS = Math.floor((Date.now() - DEMO_WRITTEN_AT) / DAY_MS) * DAY_MS;

// A fixture's time (an ISO string), moved to today: an ISO string again.
export function demoTime(iso) {
  return new Date(Date.parse(iso) + DEMO_SHIFT_MS).toISOString();
}

// A fixture's time in the mail node's own format ('YYYY-MM-DD HH:MM:SS', UTC), moved to today.
export function demoNodeTime(value) {
  return demoTime(`${value.replace(' ', 'T')}Z`).replace('T', ' ').slice(0, 19);
}
