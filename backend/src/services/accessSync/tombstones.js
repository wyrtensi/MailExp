import { query } from '../db.js';

// Addresses that must not come back on their own (migration 0097): the email of a user an
// administrator deleted (reason 'deleted') and the address a user had before an administrator
// changed or cleared it (reason 'email_changed'). While an address is tombstoned, the Access sync
// does not import it from the policy and a Cloudflare Access sign-in under it is refused:
// Cloudflare may still list it for a while (the sync removes the emails MailExpert wrote on its
// next run), and the person's Access token may still be valid. Approving the address again
// clears the tombstone. Emails are stored lower-cased.
export const TOMBSTONE_REASONS = Object.freeze(['deleted', 'email_changed']);

const DEFAULT_DB = { query: (...args) => query(...args) };

// Tombstones an address inside the caller's transaction. actor: { userId, via } (services/actor.js).
export async function addTombstone(db, email, actor, reason = 'deleted') {
  if (!email) return;
  await db.query(
    `INSERT INTO access_tombstones (email, created_by, created_by_name, reason) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET created_at = NOW(), created_by = $2, created_by_name = $3, reason = $4`,
    [email.toLowerCase(), actor?.userId ?? null, actor?.userId ? null : (actor?.via ?? null), reason],
  );
}

// Clears a tombstone; answers whether there was one.
export async function clearTombstone(db, email) {
  const { rowCount } = await db.query('DELETE FROM access_tombstones WHERE email = $1', [String(email).toLowerCase()]);
  return rowCount > 0;
}

export async function isTombstoned(email, db = DEFAULT_DB) {
  const { rows } = await db.query('SELECT 1 FROM access_tombstones WHERE email = $1', [String(email).toLowerCase()]);
  return rows.length > 0;
}

// The tombstoned emails among `emails` (a Set).
export async function tombstonedAmong(emails, db = DEFAULT_DB) {
  const list = [...emails];
  if (!list.length) return new Set();
  const { rows } = await db.query('SELECT email FROM access_tombstones WHERE email = ANY($1::text[])', [list]);
  return new Set(rows.map((row) => row.email));
}

// Every tombstone, newest first, with who made it and why: { email, createdAt, createdBy (an
// email or a name such as 'cli', or null), reason ('deleted' | 'email_changed') }.
export async function listTombstones(db = DEFAULT_DB) {
  const { rows } = await db.query(
    `SELECT t.email, t.created_at, t.reason, COALESCE(u.email, u.username, t.created_by_name) AS created_by
       FROM access_tombstones t LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.created_at DESC, t.email`,
  );
  return rows.map((row) => ({
    email: row.email, createdAt: row.created_at, createdBy: row.created_by ?? null, reason: row.reason,
  }));
}

// Takes the per-address lock (re-entrant) that sign-in, the sync's import and the user actions
// share, so a tombstone and a new user for the same address never interleave. Lock order: the
// address first, then the admin guard, then user rows.
export function lockAddress(db, email) {
  return db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user-email:${String(email).toLowerCase()}`]);
}
