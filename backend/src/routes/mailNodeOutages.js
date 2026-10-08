import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { routeActor } from '../services/actor.js';
import { mailboxLetters } from '../services/mailNode/outageTrace.js';
import { resolveTraceSource } from '../services/mailNode/traceSource.js';
import { getMailNodeConfig } from '../services/mailNode/mailcow.js';
import {
  OUTAGE_ERRORS, changeOutage, closeOutage, openOutage, outageLetters, outagesView, removeOutage, saveOutageSettingsAction,
  traceOutagesNow,
} from '../services/mailNode/outageActions.js';

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

function refuse(res, code) {
  const [status, error] = OUTAGE_ERRORS[code];
  return res.status(status).json({ error, code });
}

// An action's answer: its refusal, or the result with the status given (200 by default).
const answer = (res, result, status = 200) => (result.error ? refuse(res, result.error) : res.status(status).json(result));

// The letters of the panel's mailboxes, for the notice in each mailbox (the newest 500; truncated
// says there were more). traceConnected false: no message trace is set up, so nothing new can be
// known and no letter shows as still waiting.
router.get('/outage-letters', async (req, res) => {
  const traceConnected = !!(await resolveTraceSource());
  const [{ letters, truncated }, cfg] = await Promise.all([mailboxLetters({ withWaiting: traceConnected }), getMailNodeConfig()]);
  res.json({ traceConnected, node: !!cfg, letters, truncated });
});

// The administrator's actions (services/mailNode/outageActions.js, which the panel CLI shares).

// The windows (newest 50), the last check, the letters waiting in EOP's queue (none without a
// trace: nobody can tell they still wait) and the settings.
router.get('/outages', requireAdmin, async (req, res) => {
  res.json(await outagesView());
});

router.get('/outages/:id/letters', requireAdmin, async (req, res) => answer(res, await outageLetters(req.params.id)));

// A window by hand: { startedAt, endedAt?, reason, planned }.
router.post('/outages', requireAdmin, async (req, res) => answer(res, await openOutage(req.body, routeActor(req)), 201));

// Changes the start, the end or the reason of a window: { startedAt?, endedAt?, reason }. The
// reason is required, so every change says why.
router.put('/outages/:id', requireAdmin, async (req, res) => answer(res, await changeOutage(req.params.id, req.body, routeActor(req))));

// Closes an open window now (or at endedAt): { endedAt?, reason }.
router.post('/outages/:id/close', requireAdmin, async (req, res) => answer(res, await closeOutage(req.params.id, req.body, routeActor(req))));

router.delete('/outages/:id', requireAdmin, async (req, res) => answer(res, await removeOutage(req.params.id, req.body, routeActor(req))));

// A pass of the trace over every followed window now (or the pass going): { connected, windows };
// at most once every two minutes (429 trace_cooldown with retryAt), its requests counted against
// the same budget as the job's passes.
router.post('/outages/trace', requireAdmin, async (req, res) => {
  const result = await traceOutagesNow();
  if (result.cooldown) return res.status(429).json({ error: OUTAGE_ERRORS.trace_cooldown[1], code: 'trace_cooldown', retryAt: result.retryAt });
  return res.json(result);
});

router.put('/outage-settings', requireAdmin, async (req, res) => answer(res, await saveOutageSettingsAction(req.body, routeActor(req))));

export default router;
