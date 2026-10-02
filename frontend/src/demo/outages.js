// The demo's mail node outages (R-43; backend routes/mailNodeOutages.js): a past outage of 26 hours
// in which the first letters waited past EOP's 24 hours and were returned to their senders while
// the rest arrived late, one going on now with letters still in EOP's queue, and a planned
// maintenance without letters. Times are relative to the demo's start, so they read the same on
// every visit. The routes answer as the server does, with its refusals.

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const EXPIRY = 24 * HOUR;
const START = Date.now();
const at = (offset) => new Date(START + offset).toISOString();
const NODE_DOWN = { signals: ['containers'], down: [{ name: 'postfix-mailcow', state: 'exited' }], startUncertain: false };

const demoError = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const clone = (value) => JSON.parse(JSON.stringify(value));

let sequence = 0;
const nextId = () => `demo-outage-${(sequence += 1)}`;

let windows = [
  {
    id: nextId(), startedAt: at(-95 * MINUTE), endedAt: null, source: 'detected', planned: false, reason: null,
    cause: { signals: ['api_unreachable'], down: [], startUncertain: false },
    evidence: { lastBefore: at(-97 * MINUTE), firstAfter: null, during: 0, logFrom: at(-5 * 24 * HOUR) },
    trace: { checkedAt: at(-4 * MINUTE), complete: true, requests: 3, error: null },
  },
  {
    id: nextId(), startedAt: at(-80 * HOUR), endedAt: at(-54 * HOUR), source: 'detected', planned: false, reason: null,
    cause: NODE_DOWN,
    evidence: { lastBefore: at(-80 * HOUR - 6 * MINUTE), firstAfter: at(-54 * HOUR + 9 * MINUTE), during: 0, logFrom: at(-6 * 24 * HOUR) },
    trace: { checkedAt: at(-53 * HOUR), complete: true, requests: 5, error: null },
  },
  {
    id: nextId(), startedAt: at(-10 * 24 * HOUR), endedAt: at(-10 * 24 * HOUR + 30 * MINUTE), source: 'manual', planned: true,
    reason: 'Planned mailcow update', cause: {}, evidence: null,
    trace: { checkedAt: at(-9 * 24 * HOUR), complete: true, requests: 1, error: null },
  },
];
const [NOW_WINDOW, PAST_WINDOW] = windows;

const letter = (window, fields) => ({
  outageId: window.id, status: 'pending', outcome: 'waiting', expired: false, statusCode: null, detail: null, eventAt: null, nodeLog: null, nodeSeenAt: null,
  ...fields,
  expiresAt: fields.outcome === 'waiting' || !fields.outcome ? new Date(Date.parse(fields.receivedAt) + EXPIRY).toISOString() : null,
});
const DEFER = 'The message was deferred. 450 4.4.316 Connection refused [Message=Socket error code 10061] [LastAttemptedServerName=mail.demo.mailexpert.local]';
const EXPIRED = 'Reason: [{LED=550 4.4.7 QUEUE.Expired; message expired};{FQDN=mail.demo.mailexpert.local};{IP=203.0.113.25}]';

let letters = [
  letter(NOW_WINDOW, {
    recipient: 'sales@demo.mailexpert.local', sender: 'orders@fabrikam.example', subject: 'Purchase order 7781', receivedAt: at(-70 * MINUTE),
    statusCode: '4.4.316', detail: DEFER, eventAt: at(-10 * MINUTE), messageId: '<po-7781@fabrikam.example>',
  }),
  letter(NOW_WINDOW, {
    recipient: 'ops@demo.mailexpert.local', sender: 'alerts@tailspin.example', subject: 'Maintenance window next Tuesday', receivedAt: at(-40 * MINUTE),
    statusCode: '4.4.316', detail: DEFER, eventAt: at(-10 * MINUTE), messageId: '<mw-tue@tailspin.example>',
  }),
  letter(PAST_WINDOW, {
    recipient: 'sales@demo.mailexpert.local', sender: 'legal@contoso.example', subject: 'Signed contract, please countersign', receivedAt: at(-79 * HOUR),
    status: 'failed', outcome: 'lost', expired: true, statusCode: '4.4.7', detail: EXPIRED, eventAt: at(-55 * HOUR), nodeLog: 'missing', messageId: '<contract-19@contoso.example>',
  }),
  letter(PAST_WINDOW, {
    recipient: 'sales@demo.mailexpert.local', sender: 'anna.berg@northwind.example', subject: 'Re: Quarterly price list', receivedAt: at(-60 * HOUR),
    status: 'delivered', outcome: 'delayed', statusCode: '4.4.316', detail: DEFER, eventAt: at(-54 * HOUR + 9 * MINUTE), nodeLog: 'seen', nodeSeenAt: at(-54 * HOUR + 9 * MINUTE), messageId: '<pl-re@northwind.example>',
  }),
  letter(PAST_WINDOW, {
    recipient: 'ops@demo.mailexpert.local', sender: 'billing@litware.example', subject: 'Invoice 2026-0912', receivedAt: at(-57 * HOUR),
    status: 'delivered', outcome: 'delayed', statusCode: '4.4.316', detail: DEFER, eventAt: at(-54 * HOUR + 12 * MINUTE), nodeLog: 'seen', nodeSeenAt: at(-54 * HOUR + 12 * MINUTE), messageId: '<inv-0912@litware.example>',
  }),
  letter(PAST_WINDOW, {
    recipient: 'ops@demo.mailexpert.local', sender: 'prize@lottery-winner.example', subject: 'You have won', receivedAt: at(-70 * HOUR),
    status: 'quarantined', outcome: 'other', messageId: '<win@lottery-winner.example>',
  }),
];
let retentionDays = 30;
const panelBoxes = new Set(['sales@demo.mailexpert.local', 'ops@demo.mailexpert.local']);
const accountOf = { 'sales@demo.mailexpert.local': 'demo-sales', 'ops@demo.mailexpert.local': 'demo-ops' };

function countsOf(id) {
  const counts = { delayed: 0, waiting: 0, lost: 0, other: 0 };
  for (const l of letters) if (l.outageId === id) counts[l.outcome] += 1;
  return counts;
}

const present = (w) => ({ ...w, open: !w.endedAt, lastFailedAt: w.endedAt ? null : at(-4 * MINUTE), counts: countsOf(w.id), trace: w.trace ? { ...w.trace, counts: countsOf(w.id) } : null });

// The letters still waiting in EOP's queue, for the alert of the demo's check too.
export function demoOutageWaiting() {
  const now = Date.now();
  const waiting = letters.filter((l) => l.outcome === 'waiting' && Date.parse(l.receivedAt) + EXPIRY > now);
  const oldest = waiting.map((l) => Date.parse(l.receivedAt)).sort((a, b) => a - b)[0];
  return { waiting: waiting.length, soonestExpiresAt: oldest ? new Date(oldest + EXPIRY).toISOString() : null, asOf: waiting.length ? NOW_WINDOW.trace.checkedAt : null };
}

const parseTime = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

// The server's checks (backend outages.js parseOutageInput).
function parseInput(body, { partial = false } = {}) {
  const values = {};
  const ahead = Date.now() + 31 * 24 * HOUR;
  if (!partial || body?.startedAt !== undefined) {
    const start = parseTime(body?.startedAt);
    if (start == null || start > ahead) throw demoError('Start must be a date and time, at most a month ahead', 'outage_start_invalid');
    values.startedAt = new Date(start).toISOString();
  }
  if (body?.endedAt) {
    const end = parseTime(body.endedAt);
    if (end == null || end > ahead) throw demoError('End must be a date and time, at most a month ahead', 'outage_end_invalid');
    values.endedAt = new Date(end).toISOString();
  }
  if (values.startedAt && values.endedAt && values.endedAt < values.startedAt) throw demoError('End must not be before the start', 'outage_end_before_start');
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw demoError('A reason is required', 'outage_reason_required');
  if (reason.length > 500) throw demoError('The reason must be at most 500 characters', 'outage_reason_too_long');
  values.reason = reason;
  return values;
}

const find = (id) => {
  const w = windows.find((entry) => entry.id === id);
  if (!w) throw demoError('No such outage window', 'outage_not_found', 404);
  return w;
};

// The answer to an outage route, or undefined for another path.
export function demoOutageRequest(verb, pathname, body) {
  if (verb === 'GET' && pathname === '/mail-node/outage-letters') {
    return clone({
      traceConnected: true, node: true, truncated: false,
      letters: letters
        .filter((l) => panelBoxes.has(l.recipient) && l.outcome !== 'other')
        // What the server gives users: no EOP details or node log fields.
        .map((l) => {
          const w = windows.find((entry) => entry.id === l.outageId);
          return {
            key: `${l.messageId}|${l.recipient}`,
            outageId: l.outageId, recipient: l.recipient, sender: l.sender, subject: l.subject, receivedAt: l.receivedAt, outcome: l.outcome,
            expired: l.expired, expiresAt: l.expiresAt, accountId: accountOf[l.recipient],
            outageStartedAt: w?.startedAt ?? null, outageEndedAt: w?.endedAt ?? null,
          };
        })
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)),
    });
  }
  if (verb === 'GET' && pathname === '/mail-node/outages') {
    return clone({
      windows: [...windows].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).map(present),
      state: { lastCheckAt: at(-4 * MINUTE), lastResult: 'failed', signals: ['api_unreachable'], lastGoodAt: NOW_WINDOW.startedAt },
      waiting: demoOutageWaiting(), settings: { retentionDays }, defaults: { retentionDays: 30 }, traceConnected: true, expiryHours: 24,
    });
  }
  if (verb === 'POST' && pathname === '/mail-node/outages/trace') {
    const checkedAt = new Date().toISOString();
    windows = windows.map((w) => (w.endedAt && Date.parse(w.endedAt) < Date.now() - 25 * HOUR ? w : { ...w, trace: { ...(w.trace ?? {}), checkedAt, error: null, complete: true } }));
    return clone({ connected: true, windows: windows.filter((w) => w.trace?.checkedAt === checkedAt).map((w) => ({ id: w.id, trace: present(w).trace })) });
  }
  if (verb === 'POST' && pathname === '/mail-node/outages') {
    const values = parseInput(body);
    const w = {
      id: nextId(), startedAt: values.startedAt, endedAt: values.endedAt ?? null, source: 'manual', planned: body?.planned === true,
      reason: values.reason, cause: {}, evidence: null, trace: null,
    };
    windows = [w, ...windows];
    return clone({ window: present(w) });
  }
  if (verb === 'PUT' && pathname === '/mail-node/outage-settings') {
    const days = Number(body?.retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw demoError('Days to keep letters must be a whole number from 1 to 90', 'retention_days_invalid');
    retentionDays = days;
    return { settings: { retentionDays } };
  }
  const match = /^\/mail-node\/outages\/([^/]+)(?:\/(letters|close))?$/.exec(pathname);
  if (!match) return undefined;
  const [, id, sub] = match;
  if (verb === 'GET' && sub === 'letters') {
    const w = find(id);
    return clone({ window: present(w), letters: letters.filter((l) => l.outageId === id).map((l) => ({ ...l, key: `${l.messageId}|${l.recipient}` })) });
  }
  if (verb === 'POST' && sub === 'close') {
    const w = find(id);
    if (w.endedAt) throw demoError('The window is closed already', 'outage_already_closed', 409);
    const values = parseInput({ endedAt: body?.endedAt || new Date().toISOString(), reason: body?.reason }, { partial: true });
    if (values.endedAt < w.startedAt) throw demoError('End must not be before the start', 'outage_end_before_start');
    Object.assign(w, { endedAt: values.endedAt, reason: values.reason });
    return clone({ window: present(w) });
  }
  if (verb === 'PUT' && !sub) {
    const w = find(id);
    const values = parseInput(body, { partial: true });
    const startedAt = values.startedAt ?? w.startedAt;
    const endedAt = values.endedAt ?? w.endedAt;
    if (endedAt && endedAt < startedAt) throw demoError('End must not be before the start', 'outage_end_before_start');
    Object.assign(w, { startedAt, endedAt, reason: values.reason });
    return clone({ window: present(w) });
  }
  if (verb === 'DELETE' && !sub) {
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (body?.confirm !== true || !reason) throw demoError('Deleting a window needs { confirm: true } and a reason', 'outage_delete_unconfirmed');
    find(id);
    windows = windows.filter((w) => w.id !== id);
    letters = letters.filter((l) => l.outageId !== id);
    return { ok: true };
  }
  return undefined;
}
