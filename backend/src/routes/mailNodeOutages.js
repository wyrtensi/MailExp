import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { recordAudit } from '../services/auditLog.js';
import {
  MAX_RETENTION_DAYS,
  OUTAGE_DEFAULTS,
  addOutage,
  deleteOutage,
  getOutage,
  getOutageSettings,
  getOutageState,
  listOutages,
  parseOutageInput,
  parseOutageSettings,
  presentOutage,
  saveOutageSettings,
  updateOutage,
} from '../services/mailNode/outages.js';
import {
  EOP_EXPIRY_MS, forceOutageTrace, mailboxLetters, waitingSummary, windowLetters,
} from '../services/mailNode/outageTrace.js';
import { getTraceSource } from '../services/mailNode/traceSource.js';
import { MailNodeError, getMailNodeConfig } from '../services/mailNode/mailcow.js';
import { readPostfixLog } from '../services/mailNode/postfixLog.js';

// Letters delayed or lost while the mail node was down (R-43; services/mailNode/outages.js and
// outageTrace.js), mounted at /api/mail-node next to routes/mailNode.js:
// - every signed-in user: the letters of the panel's mailboxes (every mailbox is shared by all
//   users of the install, services/mailAccess.js) that the message trace found delayed, still
//   waiting in EOP's queue or lost, with sender, subject and time; letters to addresses without a
//   mailbox in the panel stay with the administrators;
// - administrators: the outage windows with their counts and evidence, every letter of a window
//   (EOP's quarantine and spam filtering too), adding, changing, closing and deleting a window by
//   hand (journaled), a pass of the trace now, and how long letters are kept.
const router = Router();
router.param('id', uuidParam('id'));
router.use(requireAuth);

const ERRORS = {
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
};

function refuse(res, code) {
  const [status, error] = ERRORS[code];
  return res.status(status).json({ error, code });
}

// The letters of the panel's mailboxes, for the notice in each mailbox (the newest 500; truncated
// says there were more). traceConnected false: no message trace is set up, so nothing new can be
// known and no letter shows as still waiting.
router.get('/outage-letters', async (req, res) => {
  const traceConnected = !!getTraceSource();
  const [{ letters, truncated }, cfg] = await Promise.all([mailboxLetters({ withWaiting: traceConnected }), getMailNodeConfig()]);
  res.json({ traceConnected, node: !!cfg, letters, truncated });
});

// The windows (newest 50), the last check, the letters waiting in EOP's queue (none without a
// trace: nobody can tell they still wait) and the settings.
router.get('/outages', requireAdmin, async (req, res) => {
  const traceConnected = !!getTraceSource();
  const [windows, state, stored, settings] = await Promise.all([listOutages(), getOutageState(), waitingSummary(), getOutageSettings()]);
  const waiting = traceConnected ? stored : { waiting: 0, soonestExpiresAt: null, asOf: null };
  res.json({
    windows, state, waiting, settings, defaults: OUTAGE_DEFAULTS, traceConnected, expiryHours: EOP_EXPIRY_MS / 3600000,
  });
});

router.get('/outages/:id/letters', requireAdmin, async (req, res) => {
  const row = await getOutage(req.params.id);
  if (!row) return refuse(res, 'outage_not_found');
  return res.json({ window: presentOutage(row), letters: await windowLetters(row.id) });
});

// A window by hand: { startedAt, endedAt?, reason, planned }.
router.post('/outages', requireAdmin, async (req, res) => {
  const { values, error } = parseOutageInput(req.body);
  if (error) return refuse(res, error);
  const row = await addOutage(values, req.session.userId);
  return res.status(201).json({ window: presentOutage(row) });
});

// Changes the start, the end or the reason of a window: { startedAt?, endedAt?, reason }. The
// reason is required, so every change says why.
router.put('/outages/:id', requireAdmin, async (req, res) => {
  const { values, error } = parseOutageInput(req.body, { partial: true });
  if (error) return refuse(res, error);
  if (values.reason === undefined) return refuse(res, 'outage_reason_required');
  const result = await updateOutage(req.params.id, values, req.session.userId);
  if (result.error) return refuse(res, result.error);
  return res.json({ window: presentOutage(result.row) });
});

// Closes an open window now (or at endedAt): { endedAt?, reason }.
router.post('/outages/:id/close', requireAdmin, async (req, res) => {
  const current = await getOutage(req.params.id);
  if (!current) return refuse(res, 'outage_not_found');
  if (current.ended_at) return refuse(res, 'outage_already_closed');
  const { values, error } = parseOutageInput({ endedAt: req.body?.endedAt || new Date().toISOString(), reason: req.body?.reason }, { partial: true });
  if (error) return refuse(res, error);
  const result = await updateOutage(req.params.id, values, req.session.userId);
  if (result.error) return refuse(res, result.error);
  return res.json({ window: presentOutage(result.row) });
});

router.delete('/outages/:id', requireAdmin, async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (req.body?.confirm !== true || !reason) return refuse(res, 'outage_delete_unconfirmed');
  if (reason.length > 500) return refuse(res, 'outage_reason_too_long');
  const result = await deleteOutage(req.params.id, { reason }, req.session.userId);
  if (result.error) return refuse(res, result.error);
  return res.json({ ok: true });
});

// A pass of the trace over every followed window now (or the pass going): { connected, windows };
// at most once every two minutes (429 trace_cooldown with retryAt), its requests counted against
// the same budget as the job's passes.
// The node's log (the shared cached read) tells delayed letters from those that arrived in time;
// without it the pass goes on and keeps what earlier passes learnt from the log.
router.post('/outages/trace', requireAdmin, async (req, res) => {
  const cfg = await getMailNodeConfig();
  const log = cfg
    ? await readPostfixLog(cfg).catch((err) => {
      if (err instanceof MailNodeError) return null;
      throw err;
    })
    : null;
  const result = await forceOutageTrace({ log });
  if (result.cooldown) return res.status(429).json({ error: ERRORS.trace_cooldown[1], code: 'trace_cooldown', retryAt: result.retryAt });
  return res.json(result);
});

router.put('/outage-settings', requireAdmin, async (req, res) => {
  const { settings, error } = parseOutageSettings(req.body);
  if (error) return refuse(res, error);
  const current = await getOutageSettings();
  await saveOutageSettings(settings);
  const fields = Object.keys(settings).filter((field) => settings[field] !== current[field]);
  if (fields.length) recordAudit({ actorUserId: req.session.userId, action: 'mail_node.config_changed', details: { settings: 'outages', fields } });
  return res.json({ settings: { ...current, ...settings } });
});

export default router;
