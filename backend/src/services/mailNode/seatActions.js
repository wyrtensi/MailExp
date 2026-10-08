import { recordAudit } from '../auditLog.js';
import { auditOf, jobBy } from '../actor.js';
import { getSeats, parseHoldDays, setHoldDays } from './eopSeats.js';
import { TENANT_JOB_KINDS, enqueueTenantJob } from '../tenant/tenantJobs.js';

// The EOP seats' actions that routes/mailNodeSeats.js and the panel CLI (src/cli/mailexpert.js)
// share (EOP seats design, 2026-10-07). They answer a result or { error: code } (a key of
// services/mailNode/errors.js). actor: services/actor.js. Asking for more seats is
// services/mailNode/seatProvider.js requestSeats.

// GET /api/mail-node/seats: used, held ("temporarily unavailable", with each held seat and when it is
// free) and free, never the purchased number; where the number comes from, when Microsoft was last
// asked, whether it lists no EOP_ENTERPRISE subscription, the hold period, the open seat requests.
export async function seatsView() {
  const seats = await getSeats();
  return {
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
    subscriptionMissing: seats.subscriptionMissing,
    error: seats.error ? { code: seats.error.code } : null,
    holdDays: seats.holdDays,
    heldSeats: seats.heldSeats.map(({ seat, accountId, email, reason, freeFrom }) => ({ seat, accountId, email, reason, freeFrom })),
    requests: seats.requests.map(({ id, seats: count, requestedBy, requestedAt }) => ({ id, seats: count, requestedBy, requestedAt })),
  };
}

// "Reconcile" (POST /seats/check): queues the Graph read of the purchased number. Refused
// (seats_manual) while the number is entered by hand. Answers { job } (the tenant job's row).
export async function checkSeatsNow(actor) {
  const { mode } = await getSeats();
  if (mode !== 'graph') return { error: 'seats_manual' };
  const { job } = await enqueueTenantJob(TENANT_JOB_KINDS.seats, jobBy(actor));
  return { job };
}

// The hold period (PUT /seats/settings { holdDays }), 0 to 3650 days; journaled with its old and new
// value when it changes; re-dates the seats on hold. Answers { holdDays }.
export async function setSeatHold(value, actor) {
  const days = parseHoldDays(value);
  if (days == null) return { error: 'hold_days_invalid' };
  const { from, to } = await setHoldDays(days);
  if (from !== to) recordAudit(auditOf(actor, { action: 'mail_node.seat_hold_changed', details: { from, to } }));
  return { holdDays: to };
}
