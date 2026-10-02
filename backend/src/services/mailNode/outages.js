import { query } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { parseWholeNumber } from './mailcow.js';
import { SYSTEM_ACTOR } from './domains.js';

// Windows during which the mail node could not take mail from EOP (R-43; migration 0086). EOP keeps
// what it could not deliver for at most 24 hours, retrying every 15 minutes, then returns it to the
// sender with 550 4.4.7 QUEUE.Expired; the panel cannot make EOP retry, flush or resend (owner's
// option A, D-15: observe and report). What became of the letters of a window is the message
// trace's part (services/mailNode/outageTrace.js).
//
// Detection rides on the alert job (services/mailNode/nodeAlerts.js, every five minutes), from what
// it reads anyway. The panel cannot try port 25 (it is open to the EOP ranges only), so a check is:
// - failed: the mailcow API did not answer at all (mail_node_unreachable), or postfix-mailcow or
//   dovecot-mailcow is not running (get/status/containers);
// - good: the containers were read and both are running;
// - unknown: anything else (the API refused the key, answered an error, a receiving container is
//   missing from the answer): it neither opens nor closes a window.
// A window opens at the first failed check, starting at the last good check before it (to be
// conservative: the outage may have begun right after it), and closes at the first good check.
// Without any earlier good check, or after a long gap without checks (the panel itself was down),
// the start is marked uncertain. The node's Postfix log is evidence, never a trigger (a quiet node
// has long silences): inboundEvidence() notes the last session from EOP before a window, the first
// after it and any during it.
//
// An administrator adds a window by hand (a planned maintenance, a panel-side outage) with a reason,
// changes its times or reason, closes or deletes one; each change is journaled.

export const OUTAGE_SETTINGS_PROVIDER = 'mail_node_outages';
export const OUTAGE_STATE_PROVIDER = 'mail_node_outage_state';
export const OUTAGE_DEFAULTS = Object.freeze({ retentionDays: 30 });
export const MAX_RETENTION_DAYS = 90;
export const MAX_REASON_LENGTH = 500;
// The containers that take mail from EOP: Postfix on port 25 and Dovecot behind it (LMTP).
export const RECEIVING_CONTAINERS = Object.freeze(['postfix-mailcow', 'dovecot-mailcow']);
// The alert job runs every five minutes: a gap of more than three runs since the last good check
// means the panel did not look in between.
export const CHECK_GAP_MS = 15 * 60 * 1000;
// How long evidence and the trace keep following a closed window: EOP's 24 hours and an hour.
export const FOLLOW_MS = 25 * 60 * 60 * 1000;
// A manual window may be marked ahead (a planned maintenance), up to this far.
const MAX_AHEAD_MS = 31 * 24 * 60 * 60 * 1000;
// Mailcow's own container names are "<service>-mailcow"; a compose install may answer
// "mailcowdockerized-<service>-mailcow-1".
const matches = (name, part) => String(name ?? '').toLowerCase().includes(part);

// The result of one check: { result: 'good' | 'failed' | 'unknown', signals, down }. containers:
// getContainers' list, or null when it failed with errorCode.
export function classifyCheck({ containers = null, errorCode = null }) {
  if (!containers) {
    return errorCode === 'mail_node_unreachable'
      ? { result: 'failed', signals: ['api_unreachable'], down: [] }
      : { result: 'unknown', signals: [errorCode || 'containers_unread'], down: [] };
  }
  const down = [];
  for (const part of RECEIVING_CONTAINERS) {
    const found = containers.find((c) => matches(c.name, part));
    if (!found) return { result: 'unknown', signals: ['container_missing'], down: [{ name: part, state: 'missing' }] };
    if (found.state !== 'running') down.push({ name: found.name, state: found.state || 'unknown' });
  }
  return down.length ? { result: 'failed', signals: ['containers'], down } : { result: 'good', signals: [], down: [] };
}

// --- settings and state ------------------------------------------------------------------------

async function readConfig(provider) {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [provider]);
  return rows[0]?.config ?? null;
}

async function writeConfig(provider, config, { merge }) {
  await query(`
    INSERT INTO integration_config (provider, config) VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = ${merge ? 'integration_config.config || EXCLUDED.config' : 'EXCLUDED.config'}, updated_at = NOW()
  `, [provider, config]);
}

export async function getOutageSettings() {
  const stored = (await readConfig(OUTAGE_SETTINGS_PROVIDER)) ?? {};
  return { retentionDays: parseWholeNumber(stored.retentionDays, 1, MAX_RETENTION_DAYS) ?? OUTAGE_DEFAULTS.retentionDays };
}

export function parseOutageSettings(body) {
  const settings = {};
  if (body?.retentionDays !== undefined) {
    const value = parseWholeNumber(body.retentionDays, 1, MAX_RETENTION_DAYS);
    if (value == null) return { error: 'retention_days_invalid' };
    settings.retentionDays = value;
  }
  return { settings };
}

export async function saveOutageSettings(settings) {
  await writeConfig(OUTAGE_SETTINGS_PROVIDER, settings, { merge: true });
}

// The last check: { lastCheckAt, lastResult, signals, lastGoodAt }, or null before the first.
export async function getOutageState() {
  return readConfig(OUTAGE_STATE_PROVIDER);
}

// --- windows -------------------------------------------------------------------------------------

const iso = (value) => (value ? new Date(value).toISOString() : null);
const actor = (userId) => (userId ? { actorUserId: userId } : { actorEmail: SYSTEM_ACTOR });
const minutesBetween = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));

// A window as the screens get it. counts: letters per outcome of the trace (outageTrace.js).
export function presentOutage(row, counts = {}) {
  return {
    id: row.id,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    open: !row.ended_at,
    source: row.source,
    planned: !!row.planned,
    reason: row.reason ?? null,
    cause: row.cause ?? {},
    evidence: row.evidence ?? null,
    trace: row.trace ?? null,
    lastFailedAt: iso(row.last_failed_at),
    counts: { delayed: 0, waiting: 0, lost: 0, other: 0, ...counts },
  };
}

async function openDetected() {
  const { rows } = await query("SELECT * FROM mail_node_outages WHERE source = 'detected' AND ended_at IS NULL LIMIT 1");
  return rows[0] ?? null;
}

// Keeps one check: opens, extends or closes the detected window, and the state. Returns
// { opened, closed } (window rows or null). Journals the opening and the closing.
export async function recordCheck({ check, now = Date.now(), userId = null }) {
  const state = (await getOutageState()) ?? {};
  const at = new Date(now).toISOString();
  const open = await openDetected();
  let opened = null;
  let closed = null;

  if (check.result === 'good') {
    if (open) {
      const { rows } = await query(
        `UPDATE mail_node_outages SET ended_at = GREATEST($2::timestamptz, started_at), updated_at = NOW()
          WHERE id = $1 AND ended_at IS NULL RETURNING *`,
        [open.id, at],
      );
      closed = rows[0] ?? null;
    }
    state.lastGoodAt = at;
  } else if (check.result === 'failed') {
    if (open) {
      const signals = [...new Set([...(open.cause?.signals ?? []), ...check.signals])];
      await query(
        `UPDATE mail_node_outages SET last_failed_at = $2, cause = cause || $3::jsonb, updated_at = NOW() WHERE id = $1`,
        [open.id, at, { signals, down: check.down.length ? check.down : (open.cause?.down ?? []) }],
      );
    } else {
      const lastGood = state.lastGoodAt ? Date.parse(state.lastGoodAt) : null;
      const startUncertain = lastGood == null || now - lastGood > CHECK_GAP_MS;
      const { rows } = await query(
        `INSERT INTO mail_node_outages (started_at, source, cause, last_failed_at)
         VALUES ($1, 'detected', $2, $3)
         ON CONFLICT DO NOTHING RETURNING *`,
        [lastGood != null ? new Date(lastGood).toISOString() : at, { signals: check.signals, down: check.down, firstFailedAt: at, startUncertain }, at],
      );
      opened = rows[0] ?? null;
    }
  }
  await writeConfig(OUTAGE_STATE_PROVIDER, {
    ...state, lastCheckAt: at, lastResult: check.result, signals: check.signals,
  }, { merge: false });

  recordAudit([
    ...(opened ? [{
      ...actor(userId), action: 'mail_node.outage_opened',
      details: { outage: opened.id, source: 'detected', startedAt: iso(opened.started_at), signals: check.signals, down: check.down.map((c) => c.name) },
    }] : []),
    ...(closed ? [{
      ...actor(userId), action: 'mail_node.outage_closed',
      details: { outage: closed.id, source: 'detected', startedAt: iso(closed.started_at), endedAt: iso(closed.ended_at), minutes: minutesBetween(closed.started_at, closed.ended_at) },
    }] : []),
  ]);
  return { opened, closed };
}

const parseTime = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

// The fields of a manual window the body sends, checked: { values } or { error }. partial: a change
// of an existing window (fields left out keep their value; endedAt null reopens nothing and is
// refused, only a window without an end stays open).
export function parseOutageInput(body, { partial = false, now = Date.now() } = {}) {
  const values = {};
  if (!partial || body?.startedAt !== undefined) {
    const start = parseTime(body?.startedAt);
    if (start == null || start > now + MAX_AHEAD_MS) return { error: 'outage_start_invalid' };
    values.startedAt = start;
  }
  if (body?.endedAt !== undefined && body.endedAt !== null && body.endedAt !== '') {
    const end = parseTime(body.endedAt);
    if (end == null || end > now + MAX_AHEAD_MS) return { error: 'outage_end_invalid' };
    values.endedAt = end;
  } else if (partial && body?.endedAt !== undefined) {
    return { error: 'outage_end_invalid' };
  }
  if (values.startedAt != null && values.endedAt != null && values.endedAt < values.startedAt) return { error: 'outage_end_before_start' };
  if (!partial || body?.reason !== undefined) {
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return { error: 'outage_reason_required' };
    if (reason.length > MAX_REASON_LENGTH) return { error: 'outage_reason_too_long' };
    values.reason = reason;
  }
  if (!partial) values.planned = body?.planned === true;
  return { values };
}

export async function getOutage(id) {
  const { rows } = await query('SELECT * FROM mail_node_outages WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function addOutage(values, userId) {
  const { rows } = await query(
    `INSERT INTO mail_node_outages (started_at, ended_at, source, planned, reason, created_by, closed_by)
     VALUES ($1, $2, 'manual', $3, $4, $5, CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE $5::uuid END) RETURNING *`,
    [new Date(values.startedAt).toISOString(), values.endedAt != null ? new Date(values.endedAt).toISOString() : null, values.planned, values.reason, userId],
  );
  const row = rows[0];
  recordAudit({
    actorUserId: userId, action: 'mail_node.outage_added',
    details: { outage: row.id, planned: row.planned, startedAt: iso(row.started_at), endedAt: iso(row.ended_at), reason: row.reason },
  });
  return row;
}

// Changes times or reason of a window (any source); { row } or { error }. A detected window keeps
// its cause; the reason an administrator gives is journaled with the change.
export async function updateOutage(id, values, userId) {
  const current = await getOutage(id);
  if (!current) return { error: 'outage_not_found' };
  const start = values.startedAt ?? Date.parse(current.started_at);
  const end = values.endedAt ?? (current.ended_at ? Date.parse(current.ended_at) : null);
  if (end != null && end < start) return { error: 'outage_end_before_start' };
  const { rows } = await query(
    `UPDATE mail_node_outages SET started_at = $2, ended_at = $3, reason = $4,
            closed_by = CASE WHEN ended_at IS NULL AND $3::timestamptz IS NOT NULL THEN $5::uuid ELSE closed_by END,
            trace = CASE WHEN started_at <> $2 OR ended_at IS DISTINCT FROM $3 THEN NULL ELSE trace END,
            updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, new Date(start).toISOString(), end != null ? new Date(end).toISOString() : null, values.reason ?? current.reason, userId],
  );
  const row = rows[0];
  const fields = [];
  if (iso(current.started_at) !== iso(row.started_at)) fields.push('startedAt');
  if (iso(current.ended_at) !== iso(row.ended_at)) fields.push('endedAt');
  if ((current.reason ?? null) !== (row.reason ?? null)) fields.push('reason');
  if (fields.length) {
    recordAudit({
      actorUserId: userId, action: !current.ended_at && row.ended_at ? 'mail_node.outage_closed' : 'mail_node.outage_changed',
      details: {
        outage: id, source: row.source, fields, startedAt: iso(row.started_at), endedAt: iso(row.ended_at), reason: row.reason ?? null,
        ...(row.ended_at ? { minutes: minutesBetween(row.started_at, row.ended_at) } : {}),
      },
    });
  }
  return { row };
}

// Deletes a window and what the trace found for it; the journal keeps its times and the reason.
export async function deleteOutage(id, { reason }, userId) {
  const { rows } = await query('DELETE FROM mail_node_outages WHERE id = $1 RETURNING *', [id]);
  const row = rows[0];
  if (!row) return { error: 'outage_not_found' };
  recordAudit({
    actorUserId: userId, action: 'mail_node.outage_deleted',
    details: { outage: id, source: row.source, startedAt: iso(row.started_at), endedAt: iso(row.ended_at), reason },
  });
  return { row };
}

// The windows, newest first, with the letters' counts per outcome.
export async function listOutages({ limit = 50 } = {}) {
  const { rows } = await query('SELECT * FROM mail_node_outages ORDER BY started_at DESC LIMIT $1', [limit]);
  if (!rows.length) return [];
  const { rows: counts } = await query(
    `SELECT outage_id, outcome, COUNT(*)::int AS n FROM mail_node_outage_letters
      WHERE outage_id = ANY($1::uuid[]) GROUP BY outage_id, outcome`,
    [rows.map((row) => row.id)],
  );
  const byWindow = new Map();
  for (const c of counts) byWindow.set(c.outage_id, { ...(byWindow.get(c.outage_id) ?? {}), [c.outcome]: c.n });
  return rows.map((row) => presentOutage(row, byWindow.get(row.id)));
}

// --- the node's log as evidence -----------------------------------------------------------------

// A session from EOP on port 25: the smtpd client= line of a queue (submission on 587 is
// postfix/submission/smtpd; port 25 is open to the EOP ranges only).
const inbound = (line) => line.event === 'received' && line.program === 'postfix/smtpd' && line.epoch != null;

// What the log shows around [start, end] (ms; end null while open): { lastBefore, firstAfter,
// during, logFrom }. lastBefore is null when the log has no session before the window, and
// logFrom tells whether it reaches back that far.
export function inboundEvidence(lines, { start, end = null }) {
  let lastBefore = null;
  let firstAfter = null;
  let during = 0;
  let oldest = null;
  for (const line of lines) {
    if (line.epoch != null && (oldest == null || line.epoch < oldest)) oldest = line.epoch;
    if (!inbound(line)) continue;
    if (line.epoch < start) {
      if (lastBefore == null || line.epoch > lastBefore) lastBefore = line.epoch;
    } else if (end == null || line.epoch <= end) {
      during += 1;
    } else if (firstAfter == null || line.epoch < firstAfter) {
      firstAfter = line.epoch;
    }
  }
  return { lastBefore: iso(lastBefore), firstAfter: iso(firstAfter), during, logFrom: iso(oldest) };
}

// Writes the evidence of the windows still followed (open, or closed within FOLLOW_MS) from one
// read of the log. Only rows that change are written.
export async function updateEvidence(log, now = Date.now()) {
  const { rows } = await query(
    `SELECT id, started_at, ended_at, evidence FROM mail_node_outages
      WHERE started_at <= $1 AND (ended_at IS NULL OR ended_at > $2)`,
    [new Date(now).toISOString(), new Date(now - FOLLOW_MS).toISOString()],
  );
  for (const row of rows) {
    const evidence = inboundEvidence(log.lines, { start: Date.parse(row.started_at), end: row.ended_at ? Date.parse(row.ended_at) : null });
    // jsonb keeps its own key order: compare field by field.
    if (row.evidence && Object.keys(evidence).every((key) => evidence[key] === (row.evidence[key] ?? null))) continue;
    await query('UPDATE mail_node_outages SET evidence = $2, updated_at = NOW() WHERE id = $1', [row.id, evidence]);
  }
}
