import { query } from '../db.js';

// Emails of users an administrator deleted permanently (migration 0097). While an email is
// tombstoned, the Access sync does not import it from the policy and a Cloudflare Access sign-in
// under it is refused: Cloudflare may still list the email for a while (the sync removes the
// emails MailExpert wrote on its next run), and the person's Access token may still be valid.
// Adding the user again clears the tombstone. Emails are stored lower-cased.

const DEFAULT_DB = { query: (...args) => query(...args) };

// Tombstones an email inside the caller's transaction. actor: { userId, via } (services/actor.js).
export async function addTombstone(db, email, actor) {
  if (!email) return;
  await db.query(
    `INSERT INTO access_tombstones (email, created_by, created_by_name) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET created_at = NOW(), created_by = $2, created_by_name = $3`,
    [email.toLowerCase(), actor?.userId ?? null, actor?.userId ? null : (actor?.via ?? null)],
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

// Every tombstone, newest first, with who made it: { email, createdAt, createdBy (an email or a
// name such as 'cli', or null) }.
export async function listTombstones(db = DEFAULT_DB) {
  const { rows } = await db.query(
    `SELECT t.email, t.created_at, COALESCE(u.email, u.username, t.created_by_name) AS created_by
       FROM access_tombstones t LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.created_at DESC, t.email`,
  );
  return rows.map((row) => ({ email: row.email, createdAt: row.created_at, createdBy: row.created_by ?? null }));
}
