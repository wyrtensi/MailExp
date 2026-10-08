import { query } from '../db.js';
import { AUDIT_ACTIONS } from '../auditLog.js';
import { UUID_RE } from '../../utils/uuid.js';

// Reading the journal (mailbox_audit_log), shared by the admin API (routes/admin.js,
// /api/admin/audit) and the panel CLI (cli/commands/audit.js): the same filters and the same
// answer. The sign-in events are services/authEvents.js's (listAuthEvents).

export const AUDIT_QUERY_ERRORS = Object.freeze({
  invalid_filter: [400, 'Invalid audit filter'],
});

// The page the screen reads; the CLI may ask for fewer.
export const AUDIT_PAGE_SIZE = 100;
const AUDIT_ACTION_SET = new Set(AUDIT_ACTIONS);
// The cursor is produced by the database with microsecond precision, which a JS Date would lose.
const AUDIT_CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_(\d{1,19})$/;

class AuditFilterError extends Error {}

function parseAuditTime(value) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) throw new AuditFilterError();
  return date.toISOString();
}

// Journal entries, newest first. filters: { account (id), user (the actor's id), action, from
// (inclusive), to (exclusive), before (the nextCursor of the previous page) }, each optional.
// Answers { entries, nextCursor } or { error: 'invalid_filter' }.
export async function listAuditEntries(filters = {}, { limit = AUDIT_PAGE_SIZE } = {}) {
  const { account, user, action, from, to, before } = filters;
  const where = [];
  const params = [];
  const add = (clause, ...values) => {
    const placeholders = values.map((value) => { params.push(value); return `$${params.length}`; });
    where.push(clause(...placeholders));
  };

  try {
    if (account !== undefined) {
      if (typeof account !== 'string' || !UUID_RE.test(account)) throw new AuditFilterError();
      add((p) => `account_id = ${p}`, account);
    }
    if (user !== undefined) {
      if (typeof user !== 'string' || !UUID_RE.test(user)) throw new AuditFilterError();
      add((p) => `actor_user_id = ${p}`, user);
    }
    if (action !== undefined) {
      if (!AUDIT_ACTION_SET.has(action)) throw new AuditFilterError();
      add((p) => `action = ${p}`, action);
    }
    if (from !== undefined) add((p) => `occurred_at >= ${p}`, parseAuditTime(from));
    if (to !== undefined) add((p) => `occurred_at < ${p}`, parseAuditTime(to));
    if (before !== undefined) {
      const match = typeof before === 'string' ? AUDIT_CURSOR_RE.exec(before) : null;
      if (!match) throw new AuditFilterError();
      add((at, id) => `(occurred_at, id) < (${at}::timestamptz, ${id}::bigint)`, match[1], match[2]);
    }
  } catch (err) {
    if (!(err instanceof AuditFilterError)) throw err;
    return { error: 'invalid_filter' };
  }

  params.push(limit + 1);
  const { rows } = await query(
    `SELECT id::text AS id, occurred_at,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
            actor_user_id, actor_email, account_id, account_email, action, details
       FROM mailbox_audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    entries: page.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email,
      accountId: r.account_id,
      accountEmail: r.account_email,
      action: r.action,
      details: r.details,
    })),
    nextCursor: rows.length > limit ? `${last.cursor_at}_${last.id}` : null,
  };
}
