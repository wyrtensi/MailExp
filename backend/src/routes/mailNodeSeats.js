import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { routeActor } from '../services/actor.js';
import { MAIL_NODE_ERRORS } from '../services/mailNode/errors.js';
import { checkSeatsNow, seatsView, setSeatHold } from '../services/mailNode/seatActions.js';
import { requestSeats } from '../services/mailNode/seatProvider.js';

// EOP seats (EOP seats design, 2026-10-07), mounted at /api/mail-node next to routes/mailNode.js.
// The actions are services/mailNode/seatActions.js and seatProvider.js, which the panel CLI shares.
//   GET  /seats            used, held ("temporarily unavailable", with each held seat and when it is
//                          free) and free, never the purchased number; where the number comes from,
//                          when Microsoft was last asked, whether it lists no EOP_ENTERPRISE
//                          subscription (subscriptionMissing), the hold period, the open seat requests;
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
  res.json(await seatsView());
});

router.post('/seats/check', requireAdmin, async (req, res) => {
  const result = await checkSeatsNow(routeActor(req));
  if (result.error) return refuse(res, result.error);
  return res.status(202).json({ job: { id: String(result.job.id) } });
});

router.post('/seats/requests', async (req, res) => {
  const result = await requestSeats({ seats: req.body?.seats }, routeActor(req));
  if (result.error) return refuse(res, result.error);
  return res.json({ request: result.request });
});

router.put('/seats/settings', requireAdmin, async (req, res) => {
  const result = await setSeatHold(req.body?.holdDays, routeActor(req));
  if (result.error) return refuse(res, result.error);
  return res.json(result);
});

export default router;
