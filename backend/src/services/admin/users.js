import { query, withTransaction } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import { getAuthSettings } from '../auth/authSettings.js';
import { UserIdentityError, claimOrCreateUserByEmail, normalizeEmail } from '../auth/userIdentity.js';
import { countsAsActiveAdmin, lockAdminGuard, otherActiveAdminExists } from '../auth/userStatus.js';

// The administrator's actions on users, shared by the admin API (routes/admin.js, /api/admin/users)
// and the panel CLI (cli/commands/user.js): the same checks, refusal codes and journal.
//
// An action answers { error: code, message? } or its result with `effects` (services/admin/
// adminEffects.js): what the backend's process still has to do (sign the user out, the Access
// sync, the plugins' clean-up). The route applies them at once; the CLI queues them.

// code -> [HTTP status, message]. A refusal may carry its own message instead (invalid_field).
export const ADMIN_USER_ERRORS = Object.freeze({
  email_invalid: [400, 'A valid email address is required'],
  user_exists: [409, 'A user with this email already exists'],
  username_taken: [409, 'Another user already has this address as a username'],
  invalid_field: [400, 'Invalid field'],
  no_fields: [400, 'No valid fields to update'],
  self_change: [400, 'Cannot change your own account this way'],
  not_found: [404, 'User not found'],
  bootstrap_admin: [409, 'Admins from BOOTSTRAP_ADMIN_EMAILS cannot be changed here'],
  last_admin: [409, 'At least one active admin must remain'],
  email_taken: [409, 'Another user already has this email'],
});

const refuse = (code, message) => ({ error: code, ...(message ? { message } : {}) });

class AdminUserError extends Error {
  constructor(code, message) {
    super(message ?? ADMIN_USER_ERRORS[code]?.[1] ?? code);
    this.code = code;
  }
}

export const USER_LIST_COLUMNS = 'id, username, email, is_admin, totp_enabled, disabled_at, created_at';

// A user as the API answers it.
export function publicUser(row, bootstrapAdminEmails = getAuthSettings().bootstrapAdminEmails) {
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? null,
    isAdmin: row.is_admin,
    totpEnabled: !!row.totp_enabled,
    disabledAt: row.disabled_at ?? null,
    created_at: row.created_at,
    isBootstrapAdmin: !!row.email && bootstrapAdminEmails.has(row.email.toLowerCase()),
  };
}

const lockTargetUser = async (client, id) => {
  const { rows } = await client.query('SELECT id, email, is_admin, disabled_at FROM users WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new AdminUserError('not_found');
  return rows[0];
};

const isBootstrapEmail = (settings, email) => !!email && settings.bootstrapAdminEmails.has(email.toLowerCase());

// Journal entry for an admin action on a user. The id is kept because service users may have no
// email to name them by.
const userAuditEntry = (actor, action, user) => auditOf(actor, {
  action,
  details: { userId: user.id, email: user.email ?? null, isAdmin: !!user.is_admin },
});

// A page of users, oldest first: { users, total }.
export async function listUsers({ limit = 100, offset = 0 } = {}) {
  const [result, countResult] = await Promise.all([
    query(`SELECT ${USER_LIST_COLUMNS} FROM users ORDER BY created_at ASC LIMIT $1 OFFSET $2`, [limit, offset]),
    query('SELECT COUNT(*) AS total FROM users'),
  ]);
  const { bootstrapAdminEmails } = getAuthSettings();
  return {
    users: result.rows.map((row) => publicUser(row, bootstrapAdminEmails)),
    total: parseInt(countResult.rows[0].total),
  };
}

// The user an operator names (the CLI): by email, else by username, case-insensitively.
// Answers { user } (publicUser) or { error: 'not_found' }.
export async function findUser(login) {
  const name = String(login ?? '').trim().toLowerCase();
  if (!name) return refuse('not_found');
  const { rows } = await query(
    `SELECT ${USER_LIST_COLUMNS} FROM users
      WHERE lower(email) = $1 OR lower(username) = $1
      ORDER BY (lower(email) = $1) DESC NULLS LAST, created_at ASC LIMIT 1`,
    [name],
  );
  return rows[0] ? { user: publicUser(rows[0]) } : refuse('not_found');
}

// Approves an email (what lets a person sign in when AUTH_MODE=google): a new user, or the
// existing user whose username is this address. Answers { user, created, effects }.
export async function createUser(rawEmail, actor) {
  const email = normalizeEmail(rawEmail);
  if (!email) return refuse('email_invalid');
  try {
    const { user, created, claimed } = await withTransaction((client) => claimOrCreateUserByEmail(client, email));
    if (!created && !claimed) return refuse('user_exists');
    recordAudit([userAuditEntry(actor, 'user.added', user)]);
    return { user: publicUser(user), created, effects: { accessSync: 'user_added' } };
  } catch (err) {
    if (err instanceof UserIdentityError) return refuse(err.code);
    throw err;
  }
}

// Changes a user: patch { isAdmin?, disabled?, email? } (email null or '' clears it). Every check
// runs under the admin-guard lock, so the install never loses its last active admin. Answers
// { user, effects }: a user who lost their way in (disabled, or the email the sessions were opened
// for replaced) is signed out everywhere.
export async function updateUser(id, patch, actor) {
  const body = patch || {};
  const { isAdmin, disabled } = body;
  const emailGiven = Object.hasOwn(body, 'email');
  const clearingEmail = emailGiven && (body.email === null || body.email === '');
  const email = emailGiven && !clearingEmail ? normalizeEmail(body.email) : null;
  const actorId = actor?.userId ?? null;

  if (isAdmin !== undefined && typeof isAdmin !== 'boolean') return refuse('invalid_field', 'isAdmin must be a boolean');
  if (disabled !== undefined && typeof disabled !== 'boolean') return refuse('invalid_field', 'disabled must be a boolean');
  if (emailGiven && !clearingEmail && !email) return refuse('email_invalid');
  if (isAdmin === undefined && disabled === undefined && !emailGiven) return refuse('no_fields');
  if (actorId && id === actorId && isAdmin === false) return refuse('self_change', 'Cannot remove your own admin status');
  if (actorId && id === actorId && disabled === true) return refuse('self_change', 'Cannot disable your own account');

  const settings = getAuthSettings();
  const googleMode = settings.mode === 'google';
  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      await lockAdminGuard(client);
      const current = await lockTargetUser(client, id);
      const after = {
        is_admin: isAdmin ?? current.is_admin,
        disabled_at: disabled === undefined ? current.disabled_at : (disabled ? (current.disabled_at ?? new Date()) : null),
        email: emailGiven ? email : current.email,
      };

      if (isBootstrapEmail(settings, current.email)
        && (!after.is_admin || after.disabled_at || after.email !== current.email)) {
        throw new AdminUserError('bootstrap_admin');
      }
      if (countsAsActiveAdmin(current, googleMode) && !countsAsActiveAdmin(after, googleMode)
        && !(await otherActiveAdminExists(client, id, googleMode))) {
        throw new AdminUserError('last_admin');
      }
      if (email && email !== current.email) {
        const { rows: taken } = await client.query('SELECT id FROM users WHERE lower(email) = $1 AND id <> $2', [email, id]);
        if (taken.length) throw new AdminUserError('email_taken');
      }

      const { rows: [updated] } = await client.query(
        `UPDATE users
            SET is_admin = $2, email = $3, disabled_at = $4,
                disabled_by = CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE COALESCE(disabled_by, $5::uuid) END
          WHERE id = $1
          RETURNING ${USER_LIST_COLUMNS}`,
        [id, after.is_admin, after.email, after.disabled_at, actorId],
      );
      // Losing the way in: turned off, or left without the email the sessions were opened for.
      // A replaced address counts too: the row may now stand for another person, and a session
      // opened under the old address must not carry the row's access over to them.
      const lost = (!current.disabled_at && !!after.disabled_at) || (!!current.email && after.email !== current.email);
      return { row: updated, lostAccess: lost, previous: current };
    });
  } catch (err) {
    if (err instanceof AdminUserError) return refuse(err.code);
    throw err;
  }

  const { row, lostAccess, previous } = outcome;
  const auditEntries = [];
  if (!!previous.disabled_at !== !!row.disabled_at) {
    auditEntries.push(userAuditEntry(actor, row.disabled_at ? 'user.disabled' : 'user.enabled', row));
  }
  if (!!previous.is_admin !== !!row.is_admin) auditEntries.push(userAuditEntry(actor, 'user.admin_changed', row));
  if (auditEntries.length) recordAudit(auditEntries);
  return {
    user: publicUser(row, settings.bootstrapAdminEmails),
    effects: {
      signOut: lostAccess ? [id] : [],
      // Who may sign in changed: the Access policy follows.
      accessSync: (!!previous.disabled_at !== !!row.disabled_at || previous.email !== row.email) ? 'user_changed' : null,
    },
  };
}

// Deletes a user. The delete runs while the admin-guard lock is held: two admins deleting each
// other at once would otherwise both pass the last-admin check and leave no active admin.
// Answers { ok, effects }.
export async function deleteUser(id, actor) {
  if (actor?.userId && id === actor.userId) return refuse('self_change', 'Cannot delete your own account');
  const settings = getAuthSettings();
  const googleMode = settings.mode === 'google';
  let deleted;
  try {
    deleted = await withTransaction(async (client) => {
      await lockAdminGuard(client);
      const current = await lockTargetUser(client, id);
      if (isBootstrapEmail(settings, current.email)) {
        throw new AdminUserError('bootstrap_admin', 'Admins from BOOTSTRAP_ADMIN_EMAILS cannot be deleted here');
      }
      if (countsAsActiveAdmin(current, googleMode) && !(await otherActiveAdminExists(client, id, googleMode))) {
        throw new AdminUserError('last_admin');
      }
      await client.query('DELETE FROM users WHERE id = $1', [id]);
      return current;
    });
  } catch (err) {
    if (err instanceof AdminUserError) return refuse(err.code, err.message);
    throw err;
  }
  recordAudit([userAuditEntry(actor, 'user.deleted', deleted)]);
  // The plugins' clean-up runs after the delete: the row is already gone, so a hook failure must
  // not misreport a completed delete.
  return { ok: true, effects: { signOut: [id], userDeleted: [id], accessSync: 'user_deleted' } };
}

// Turns a user's 2FA off (they enrol again at their next sign-in if the panel requires it). Not
// for the actor's own account: that goes through their account settings. Answers { ok, user }.
export async function disableUserTotp(id, actor) {
  if (actor?.userId && id === actor.userId) return refuse('self_change', 'Use your account settings to manage your own 2FA.');
  const target = await query('SELECT username FROM users WHERE id = $1', [id]);
  if (!target.rows.length) return refuse('not_found');
  await query('UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [id]);
  return { ok: true, username: target.rows[0].username };
}
