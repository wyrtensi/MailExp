import { query } from './db.js';

// Who does an administrator's action, for the actions the HTTP routes and the panel CLI
// (src/cli/mailexpert.js) share: { userId, via }.
//
//   HTTP route     { userId: req.session.userId }
//   panel CLI      { userId: <the --as administrator's id> | null, via: 'cli' }
//
// The journal names a route's actor by the user, exactly as before. The CLI's entries carry
// details.via = 'cli'; without --as there is no user, so the entry's actor is the name 'cli'.
// With --as the journal fills in the administrator's address from the users row (recordAudit
// prefers it), so 'cli' lives only in details.via there.

export const CLI_ACTOR_NAME = 'cli';

export function routeActor(req) {
  return { userId: req.session.userId };
}

// The fields of a journal entry (services/auditLog.js recordAudit) for the actor, with the
// entry's details: { actorUserId, actorEmail?, details }.
export function auditOf(actor, entry) {
  const userId = actor?.userId ?? null;
  const via = actor?.via ?? null;
  return {
    ...entry,
    actorUserId: userId,
    ...(!userId && via ? { actorEmail: via } : {}),
    details: via ? { ...(entry.details ?? {}), via } : (entry.details ?? {}),
  };
}

// Who queues a job, as the queue functions take it: { userId, via? }. The job keeps via in its
// payload, so its own journal entries name the CLI (services/tenant/tenantJobs.js jobAudit).
export function jobBy(actor) {
  return { userId: actor?.userId ?? null, ...(actor?.via ? { via: actor.via } : {}) };
}

// The CLI's actor: --as names an administrator who exists and is not disabled; without it the
// actor is the CLI itself. Answers { actor } or { error: 'admin_not_found' }.
export async function resolveCliActor(asEmail) {
  if (asEmail === undefined || asEmail === null) return { actor: { userId: null, via: CLI_ACTOR_NAME } };
  const email = String(asEmail).trim().toLowerCase();
  if (!email) return { error: 'admin_not_found' };
  const { rows } = await query(
    `SELECT id FROM users
      WHERE (lower(email) = $1 OR lower(username) = $1) AND is_admin AND disabled_at IS NULL
      ORDER BY id LIMIT 2`,
    [email],
  );
  if (rows.length !== 1) return { error: 'admin_not_found' };
  return { actor: { userId: rows[0].id, via: CLI_ACTOR_NAME } };
}
