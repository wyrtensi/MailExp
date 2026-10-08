import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import {
  MAX_RETENTION_DAYS, OUTAGE_DEFAULTS, addOutage, deleteOutage, getOutage, getOutageSettings, getOutageState, listOutages,
  parseOutageInput, parseOutageSettings, presentOutage, saveOutageSettings, updateOutage,
} from './outages.js';
import { EOP_EXPIRY_MS, forceOutageTrace, waitingSummary, windowLetters } from './outageTrace.js';
import { resolveTraceSource } from './traceSource.js';
import { MailNodeError, getMailNodeConfig } from './mailcow.js';
import { readPostfixLog } from './postfixLog.js';

// The administrator's actions on the outage windows (R-43; services/mailNode/outages.js and
// outageTrace.js) that routes/mailNodeOutages.js and the panel CLI (src/cli/mailexpert.js) share.
// They answer a result or { error: code } (a key of OUTAGE_ERRORS). actor: services/actor.js.

export const OUTAGE_ERRORS = Object.freeze({
  outage_start_invalid: [400, 'Start must be a date and time, at most a month ahead'],
  outage_end_invalid: [400, 'End must be a date and time, at most a month ahead'],
  outage_end_before_start: [400, 'End must not be before the start'],
  outage_reason_required: [400, 'A reason is required'],
  outage_reason_too_long: [400, 'The reason must be at most 500 characters'],
  outage_not_found: [404, 'No such outage window'],
  outage_already_closed: [409, 'The window is closed already'],
  outage_delete_unconfirmed: [400, 'Deleting a window needs { confirm: true } and a reason'],
  trace_cooldown: [429, 'The trace was checked a moment ago: try again in two minutes'],
  retention_days_invalid: [400, `Days to keep letters must be a whole number from 1 to ${MAX_RETENTION_DAYS}`],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A window by its id: the row or null (an id that is no UUID is no window).
async function windowRow(id) {
  return UUID.test(String(id ?? '')) ? getOutage(id) : null;
}

// The windows (newest 50), the last check, the letters waiting in EOP's queue (none without a
// trace: nobody can tell they still wait) and the settings.
export async function outagesView() {
  const traceConnected = !!(await resolveTraceSource());
  const [windows, state, stored, settings] = await Promise.all([listOutages(), getOutageState(), waitingSummary(), getOutageSettings()]);
  const waiting = traceConnected ? stored : { waiting: 0, soonestExpiresAt: null, asOf: null };
  return {
    windows, state, waiting, settings, defaults: OUTAGE_DEFAULTS, traceConnected, expiryHours: EOP_EXPIRY_MS / 3600000,
  };
}

// One window as the list shows it: { window } (the panel's GET /outages/:id/letters carries it
// too).
export async function outageWindow(id) {
  const row = await windowRow(id);
  if (!row) return { error: 'outage_not_found' };
  return { window: presentOutage(row) };
}

// Every letter of a window (EOP's quarantine and spam filtering too): { window, letters }.
export async function outageLetters(id) {
  const row = await windowRow(id);
  if (!row) return { error: 'outage_not_found' };
  return { window: presentOutage(row), letters: await windowLetters(row.id) };
}

// A window by hand: { startedAt, endedAt?, reason, planned }. Answers { window }.
export async function openOutage(body, actor) {
  const { values, error } = parseOutageInput(body);
  if (error) return { error };
  const row = await addOutage(values, actor);
  return { window: presentOutage(row) };
}

// Changes the start, the end or the reason of a window: { startedAt?, endedAt?, reason }. The
// reason is required, so every change says why.
export async function changeOutage(id, body, actor) {
  const { values, error } = parseOutageInput(body, { partial: true });
  if (error) return { error };
  if (values.reason === undefined) return { error: 'outage_reason_required' };
  if (!UUID.test(String(id ?? ''))) return { error: 'outage_not_found' };
  const result = await updateOutage(id, values, actor);
  if (result.error) return result;
  return { window: presentOutage(result.row) };
}

// Closes an open window now (or at endedAt): { endedAt?, reason }.
export async function closeOutage(id, body, actor) {
  const current = await windowRow(id);
  if (!current) return { error: 'outage_not_found' };
  if (current.ended_at) return { error: 'outage_already_closed' };
  const { values, error } = parseOutageInput({ endedAt: body?.endedAt || new Date().toISOString(), reason: body?.reason }, { partial: true });
  if (error) return { error };
  const result = await updateOutage(id, values, actor);
  if (result.error) return result;
  return { window: presentOutage(result.row) };
}

// Deletes a window and what the trace found for it: { confirm: true, reason }. The journal keeps
// its times and the reason.
export async function removeOutage(id, body, actor) {
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (body?.confirm !== true || !reason) return { error: 'outage_delete_unconfirmed' };
  if (reason.length > 500) return { error: 'outage_reason_too_long' };
  if (!UUID.test(String(id ?? ''))) return { error: 'outage_not_found' };
  const result = await deleteOutage(id, { reason }, actor);
  if (result.error) return result;
  return { ok: true };
}

// How long letters are kept: { retentionDays }; a field left out keeps its value. Journaled by the
// names of the fields that changed. Answers { settings }.
export async function saveOutageSettingsAction(body, actor) {
  const { settings, error } = parseOutageSettings(body);
  if (error) return { error };
  const current = await getOutageSettings();
  await saveOutageSettings(settings);
  const fields = Object.keys(settings).filter((field) => settings[field] !== current[field]);
  if (fields.length) recordAudit(auditOf(actor, { action: 'mail_node.config_changed', details: { settings: 'outages', fields } }));
  return { settings: { ...current, ...settings } };
}

export async function outageSettingsView() {
  return { settings: await getOutageSettings(), defaults: OUTAGE_DEFAULTS };
}

// A pass of the trace over every followed window now (or the pass going): { connected, windows },
// or { cooldown: true, retryAt } within two minutes of the last forced pass. Its requests count
// against the same budget as the job's passes, which this process keeps: only the backend runs it
// (the route; the panel CLI queues it, services/mailNode/nodeChecks.js). The node's log (the shared
// cached read) tells delayed letters from those that arrived in time; without it the pass goes on
// and keeps what earlier passes learnt from the log.
export async function traceOutagesNow() {
  const cfg = await getMailNodeConfig();
  const log = cfg
    ? await readPostfixLog(cfg).catch((err) => {
      if (err instanceof MailNodeError) return null;
      throw err;
    })
    : null;
  return forceOutageTrace({ log });
}
