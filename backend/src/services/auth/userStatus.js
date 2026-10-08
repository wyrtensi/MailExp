// Who keeps the install reachable, and turning users off outside an admin request.

// Whether the user can still reach the admin panel: an admin, not disabled, and — in google
// mode, where sign-in is by email — with an email.
export function countsAsActiveAdmin({ is_admin: isAdmin, disabled_at: disabledAt, email }, googleMode) {
  return !!isAdmin && !disabledAt && (!googleMode || !!email);
}

export async function otherActiveAdminExists(client, userId, googleMode) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS count FROM users
      WHERE is_admin = true AND disabled_at IS NULL AND id <> $1${googleMode ? ' AND email IS NOT NULL' : ''}`,
    [userId],
  );
  return rows[0].count > 0;
}

// Serializes changes that could leave the install without a reachable admin.
export const lockAdminGuard = (client) => client.query("SELECT pg_advisory_xact_lock(hashtext('users-admin-guard'))");

// Disables active users by email inside the caller's transaction, for changes that come from
// outside the admin panel (the Cloudflare Access sync). Bootstrap admins are never touched, and
// an admin stays active when turning them off would leave no active admin.
export async function disableUsersByEmail(client, emails, { googleMode, bootstrapAdminEmails }) {
  await lockAdminGuard(client);
  const disabled = [];
  const keptLastAdmin = [];
  for (const email of emails) {
    if (bootstrapAdminEmails.has(email)) continue;
    const { rows: [current] } = await client.query(
      'SELECT id, email, is_admin, disabled_at FROM users WHERE lower(email) = $1 AND disabled_at IS NULL FOR UPDATE',
      [email],
    );
    if (!current) continue;
    if (countsAsActiveAdmin(current, googleMode) && !(await otherActiveAdminExists(client, current.id, googleMode))) {
      keptLastAdmin.push(email);
      continue;
    }
    const { rows: [row] } = await client.query(
      // disabled_source tells the users screen the email was removed in Cloudflare (migration 0097).
      "UPDATE users SET disabled_at = NOW(), disabled_by = NULL, disabled_source = 'cloudflare_access' WHERE id = $1 RETURNING id, email, is_admin",
      [current.id],
    );
    disabled.push(row);
  }
  return { disabled, keptLastAdmin };
}
