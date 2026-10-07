import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { recordAudit } from '../services/auditLog.js';
import { routeActor } from '../services/actor.js';
import { MAIL_NODE_ERRORS } from '../services/mailNode/errors.js';
import { getSeats, parseHoldDays, setHoldDays } from '../services/mailNode/eopSeats.js';
import { requestSeats } from '../services/mailNode/seatProvider.js';
import { TENANT_JOB_KINDS, enqueueTenantJob } from '../services/tenant/tenantJobs.js';

// EOP seats (EOP seats design, 2026-10-07), mounted at /api/mail-node next to routes/mailNode.js.
//   GET  /seats            used, held ("temporarily unavailable", with each held seat and when it is
//                          free) and free, never the purchased number; where the number comes from,
//                          when Microsoft was last asked, the hold period, the open seat requests;
//                          everyone signed in (the add form shows it)
//   POST /seats/check      "Reconcile": queues the Graph read (202 { job }); administrators; refused
//                          (seats_manual) while the number is entered by hand
//   POST /seats/requests   { seats }: asks for more seats (services/mailNode/seatProvider.js); everyone
//   PUT  /seats/settings   { holdDays }: the hold period, 0 to 3650 days; administrators; journaled
//                          with its old and new value; re-dates the seats on hold
const router = Router();
router.use('/seats', requireAuth);

function refuse(res, code) {
  const [status, error] = MAIL_NODE_ERRORS[code];
  return res.status(status).json({ error, code });
}

router.get('/seats', async (req, res) => {
  const seats = await getSeats();
  res.json({
    used: seats.used,
    held: seats.held,
    free: seats.free,
    known: seats.free != null,
    mode: seats.mode,
    source: seats.source,
    checkedAt: seats.at,
    stale: seats.stale,
    notReconciled: seats.notReconciled,
    over: seats.over,
    error: seats.error ? { code: seats.error.code } : null,
    holdDays: seats.holdDays,
    heldSeats: seats.heldSeats.map(({ seat, email, reason, freeFrom }) => ({ seat, email, reason, freeFrom })),
    requests: seats.requests.map(({ id, seats: count, requestedBy, requestedAt }) => ({ id, seats: count, requestedBy, requestedAt })),
  });
});

router.post('/seats/check', requireAdmin, async (req, res) => {
  const { mode } = await getSeats();
  if (mode !== 'graph') return refuse(res, 'seats_manual');
  const { job } = await enqueueTenantJob(TENANT_JOB_KINDS.seats, { userId: req.session.userId });
  return res.status(202).json({ job: { id: String(job.id) } });
});

router.post('/seats/requests', async (req, res) => {
  const result = await requestSeats({ seats: req.body?.seats }, routeActor(req));
  if (result.error) return refuse(res, result.error);
  return res.json({ request: result.request });
});

router.put('/seats/settings', requireAdmin, async (req, res) => {
  const days = parseHoldDays(req.body?.holdDays);
  if (days == null) return refuse(res, 'hold_days_invalid');
  const { from, to } = await setHoldDays(days);
  if (from !== to) recordAudit({ actorUserId: req.session.userId, action: 'mail_node.seat_hold_changed', details: { from, to } });
  return res.json({ holdDays: to });
});

export default router;
