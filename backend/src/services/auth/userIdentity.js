import { query, withTransaction } from '../db.js';
import { isAccessSyncEnabled } from '../accessSync/settings.js';

export const USER_COLUMNS = 'id, username, email, is_admin, disabled_at, created_at';
export const SESSION_AUTH_METHODS = new Set(['cloudflare', 'google']);

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export class UserIdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'UserIdentityError';
    this.code = code;
  }
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

export async function loadUserById(userId) {
  if (typeof userId !== 'string' || !userId) return null;
  const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return rows[0] || null;
}

// `email` must already be normalized.
export async function findUserByEmail(email, db = { query }) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1`, [email]);
  return rows[0] || null;
}

// The user approved under this address: the row that already has it, else the oldest legacy
// row whose username is the address and whose email is empty, else a new passwordless row.
// Runs inside the caller's transaction, serialized per address.
export async function claimOrCreateUserByEmail(client, email, { isAdmin = false } = {}) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user-email:${email}`]);

  const existing = await findUserByEmail(email, client);
  if (existing) return { user: existing, created: false, claimed: false };

  const claimed = await client.query(
    `UPDATE users SET email = $1
      WHERE id = (SELECT id FROM users WHERE email IS NULL AND lower(username) = $1 ORDER BY created_at LIMIT 1)
      RETURNING ${USER_COLUMNS}`,
    [email],
  );
  if (claimed.rows[0]) return { user: claimed.rows[0], created: false, claimed: true };

  try {
    const inserted = await client.query(
      `INSERT INTO users (username, email, is_admin) VALUES ($1, $1, $2) RETURNING ${USER_COLUMNS}`,
      [email, isAdmin],
    );
    return { user: inserted.rows[0], created: true, claimed: false };
  } catch (err) {
    // Another user has this address as username and a different email.
    if (err?.code === '23505') throw new UserIdentityError('username_taken');
    throw err;
  }
}

// The account a verified identity signs in as, or { error }. A Cloudflare Access identity is
// already approved by the Access policy and gets an account on first sign-in — unless the Access
// sync is on, in which case MailExpert's user list is the only place users are approved and an
// unknown Cloudflare identity is refused instead (see below). A direct Google sign-in needs an
// approved user, except for bootstrap admins. Bootstrap admins become admins on every sign-in.
export async function resolveVerifiedUser({ email, source, settings }) {
  const address = normalizeEmail(email);
  if (!address) return { error: 'not_allowed' };
  const bootstrap = settings.bootstrapAdminEmails.has(address);

  // Every Cloudflare request lands here, so the common case is a single read.
  const known = await findUserByEmail(address);
  if (known?.disabled_at) return { error: 'user_disabled' };
  if (known && (!bootstrap || known.is_admin)) return { user: known };
  if (!known && source !== 'cloudflare' && !bootstrap) return { error: 'not_allowed' };
  // A deleted user must not come back just because their Cloudflare Access session token is
  // still valid: while the sync is on, it is MailExpert's user list that removed them from the
  // policy, and letting Cloudflare recreate them here would write their email straight back in
  // on the next run. Only read the setting when there is no known user, so the common signed-in
  // path above stays a single read.
  if (!known && source === 'cloudflare' && !bootstrap && await isAccessSyncEnabled()) {
    return { error: 'not_allowed' };
  }

  try {
    return await withTransaction(async (client) => {
      let { user } = await claimOrCreateUserByEmail(client, address, { isAdmin: bootstrap });
      if (user.disabled_at) return { error: 'user_disabled' };
      if (bootstrap && !user.is_admin) {
        ({ rows: [user] } = await client.query(
          `UPDATE users SET is_admin = true WHERE id = $1 RETURNING ${USER_COLUMNS}`,
          [user.id],
        ));
      }
      return { user };
    });
  } catch (err) {
    if (err instanceof UserIdentityError) return { error: 'not_allowed' };
    throw err;
  }
}

// Put a signed-in user into the session. Another user or sign-in method gets a fresh session
// id first, so one session never carries two identities. The same user keeps the screen lock
// (#235) across that: the identity gate runs before the lock gate, so a locked session that
// arrives with a valid Access token for its own user must not come out unlocked.
export async function bindSessionUser(req, user, authMethod) {
  if (req.session.userId !== user.id || req.session.authMethod !== authMethod) {
    const keepLocked = req.session.userId === user.id && !!req.session.locked;
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    if (keepLocked) req.session.locked = true;
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;
  req.session.authMethod = authMethod;
}
