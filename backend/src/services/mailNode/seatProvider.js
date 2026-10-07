import { query } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { auditOf, jobBy } from '../actor.js';
import { parseWholeNumber } from './mailcow.js';
import { MAX_SEAT_REQUEST, seatSupply } from './eopSeats.js';
import { TENANT_JOB_KINDS, enqueueTenantJob } from '../tenant/tenantJobs.js';

// Asking for more EOP seats (EOP seats design, 2026-10-07): one action, "request N seats". The only
// provider today is 'manual': the request is kept (mail_node_seat_requests, migration 0095) and
// journaled (mail_node.seats_requested), the mail node alerts raise eop_seats_requested, an
// administrator buys the seats from the reseller, and the request closes by itself once the purchased
// number grew by N on top of the requests still open before it (services/mailNode/eopSeats.js
// closeFulfilledRequests). A reseller's API
// (SoftwareOne, Insight; docs/architecture/mail-node-research/eop-license-vendors.md) would be one
// more provider here, chosen by a setting, once the management decides; it would also be asked at
// creation, activation and the cancel of a deletion.

const manual = {
  name: 'manual',
  async request({ seats, purchased, actor }) {
    const { rows: [row] } = await query(`
      INSERT INTO mail_node_seat_requests (provider, seats, purchased_at_request, requested_by, requested_by_email)
      VALUES ('manual', $1, $2, $3, (SELECT COALESCE(NULLIF(email, ''), username) FROM users WHERE id = $3))
      RETURNING id, seats, requested_at`, [seats, purchased, actor?.userId ?? null]);
    return { id: Number(row.id), seats: row.seats, requestedAt: row.requested_at };
  },
};

export const SEAT_PROVIDERS = Object.freeze({ manual });

export function getSeatProvider() {
  return manual;
}

// Anyone signed in may ask (the add form is open to everyone). Answers { request } or { error:
// 'seat_count_invalid' }. With the tenant giving the number, Graph is read again at once.
export async function requestSeats({ seats }, actor) {
  const count = parseWholeNumber(seats, 1, MAX_SEAT_REQUEST);
  if (count == null) return { error: 'seat_count_invalid' };
  const supply = await seatSupply();
  const provider = getSeatProvider();
  const request = await provider.request({ seats: count, purchased: supply.purchased, actor });
  recordAudit(auditOf(actor, {
    action: 'mail_node.seats_requested', details: { seats: count, provider: provider.name, purchased: supply.purchased },
  }));
  if (supply.mode === 'graph') {
    await enqueueTenantJob(TENANT_JOB_KINDS.seats, jobBy(actor))
      .catch((err) => console.error(`EOP seats read could not be queued: ${err?.code || err?.message}`));
  }
  return { request };
}
