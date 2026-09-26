// Claims of a permanent delete (migration 0077). Deleting a letter forever is server-first: the
// letter goes on the mail server before its row goes, or a failed expunge would leave a letter the
// server still has and the panel does not. The server delete can take minutes on a slow server, so
// no transaction or row lock is held across it. Instead the rows are claimed first, in one short
// statement: a claimed row is not moved by the move queue (moveQueue.enqueue skips it) and not
// claimed by another permanent delete. After the server delete, the rows the server deleted are
// removed (only while still claimed by this token and still at the folder and uid claimed) and the
// claim on the rest is released. A claim left by a process that stopped mid-delete is released by
// the move queue's sweep once older than the lease, and at startup.
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

// Longer than the longest server delete: a pooled session wait and a pooled operation, twice
// (bulkPermanentDelete's verification pass), about 270 s.
export const EXPUNGE_CLAIM_LEASE_MS = 10 * 60 * 1000;

// Claim `rows` (id, uid as the route read them), all in `folder`. Only a row still at that folder
// and uid and not claimed by anyone is claimed. Returns { token, claimed: Map<id, { is_read }> }.
export async function claimForExpunge(folder, rows) {
  const token = randomUUID();
  const { rows: claimed } = await query(
    `UPDATE messages m SET expunge_claim = $1, expunge_claimed_at = now()
       FROM unnest($2::uuid[], $3::bigint[]) AS r(id, uid)
      WHERE m.id = r.id AND m.uid = r.uid AND m.folder = $4 AND m.expunge_claim IS NULL
     RETURNING m.id, m.is_read`,
    [token, rows.map(r => r.id), rows.map(r => Number(r.uid)), folder]
  );
  return { token, claimed: new Map(claimed.map(r => [r.id, { is_read: r.is_read }])) };
}

// Remove the claimed rows whose letters the server deleted. A row the claim no longer holds (swept
// after the lease) or that left the folder and uid claimed stays. Returns Map<id, { is_read }>.
export async function finishExpunge(token, folder, rows) {
  if (!rows.length) return new Map();
  const { rows: removed } = await query(
    `DELETE FROM messages m
      USING unnest($2::uuid[], $3::bigint[]) AS r(id, uid)
      WHERE m.id = r.id AND m.uid = r.uid AND m.folder = $4 AND m.expunge_claim = $1
     RETURNING m.id, m.is_read`,
    [token, rows.map(r => r.id), rows.map(r => Number(r.uid)), folder]
  );
  return new Map(removed.map(r => [r.id, { is_read: r.is_read }]));
}

// Release this token's claim on `ids` (the rows the server did not delete, or all of them when the
// server delete failed).
export async function releaseExpungeClaim(token, ids) {
  if (!ids.length) return;
  await query(
    'UPDATE messages SET expunge_claim = NULL, expunge_claimed_at = NULL WHERE id = ANY($1::uuid[]) AND expunge_claim = $2',
    [ids, token]
  );
}

// Release claims older than leaseMs (0: every claim, at startup). Returns how many.
export async function releaseStaleExpungeClaims(leaseMs = EXPUNGE_CLAIM_LEASE_MS) {
  const { rowCount } = await query(
    `UPDATE messages SET expunge_claim = NULL, expunge_claimed_at = NULL
      WHERE expunge_claim IS NOT NULL
        AND expunge_claimed_at <= now() - ($1::int * interval '1 millisecond')`,
    [leaseMs]
  );
  return rowCount ?? 0;
}
