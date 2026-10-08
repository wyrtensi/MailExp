import { unwrap } from '../common.js';
import { UsageError, parseCount } from '../args.js';
import { fmtDate, fmtValue, table } from '../output.js';
import { AUDIT_ACTIONS } from '../../services/auditLog.js';
import { AUDIT_PAGE_SIZE, AUDIT_QUERY_ERRORS, listAuditEntries } from '../../services/admin/auditQuery.js';
import { listAuthEvents } from '../../services/authEvents.js';
import { ADMIN_USER_ERRORS, findUser } from '../../services/admin/users.js';
import { ACCOUNT_ERRORS, findAccount } from '../../services/accounts/manualAccounts.js';

// mailexpert audit ...: the journal and the sign-in events (services/admin/auditQuery.js, the
// admin screen's "Audit" and /api/admin/audit, /api/admin/auth-events): the same filters. Reading
// them is not journaled.

const RELATIVE = /^(\d{1,6})([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

// A time flag: an ISO date or time, or how long ago (30m, 24h, 7d).
function parseTime(name, value) {
  if (value === undefined) return undefined;
  const relative = RELATIVE.exec(value);
  if (relative) return new Date(Date.now() - Number(relative[1]) * UNIT_MS[relative[2]]).toISOString();
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(date.getTime())) {
    throw new UsageError(`--${name} takes an ISO time (2026-10-01 or 2026-10-01T10:00:00Z) or an age (30m, 24h, 7d)`);
  }
  return date.toISOString();
}

const list = {
  name: 'list',
  summary: 'journal entries, newest first, filtered as the admin screen filters them',
  usage: 'audit list [--action A] [--since T] [--until T] [--account ADDRESS|ID] [--user EMAIL] [--before CURSOR] [--limit N]',
  help: [
    '--action A         one action (mailbox.added, rule.updated, user.disabled, ...)',
    '--since T          from this time on (an ISO time, or an age: 30m, 24h, 7d)',
    '--until T          before this time',
    '--account MAILBOX  entries about one mailbox (its address or ID)',
    '--user EMAIL       entries whose actor is this user (entries of the CLI without --as name',
    '                   the actor "cli" and have no user)',
    '--before CURSOR    the page after the one that printed this cursor',
    `--limit N          at most N entries (default and at most ${AUDIT_PAGE_SIZE}, the screen's page)`,
  ],
  flags: { action: 'string', since: 'string', until: 'string', account: 'string', user: 'string', before: 'string', limit: 'string' },
  async run(ctx) {
    const { flags } = ctx;
    if (flags.action !== undefined && !AUDIT_ACTIONS.includes(flags.action)) {
      throw new UsageError(`unknown action: ${flags.action} (one of ${AUDIT_ACTIONS.join(', ')})`);
    }
    const limit = parseCount(flags.limit, { name: 'limit', min: 1, max: AUDIT_PAGE_SIZE, fallback: AUDIT_PAGE_SIZE });
    const filters = {
      action: flags.action,
      from: parseTime('since', flags.since),
      to: parseTime('until', flags.until),
      before: flags.before,
    };
    if (flags.account !== undefined) filters.account = unwrap(await findAccount(flags.account), ACCOUNT_ERRORS).account.id;
    if (flags.user !== undefined) filters.user = unwrap(await findUser(flags.user), ADMIN_USER_ERRORS).user.id;
    for (const key of Object.keys(filters)) if (filters[key] === undefined) delete filters[key];
    const data = unwrap(await listAuditEntries(filters, { limit }), AUDIT_QUERY_ERRORS);
    const lines = table(data.entries, [
      { header: 'TIME', value: (e) => fmtDate(e.occurredAt) },
      { header: 'ACTION', value: (e) => e.action },
      { header: 'ACTOR', value: (e) => e.actorEmail ?? e.actorUserId },
      { header: 'MAILBOX', value: (e) => e.accountEmail ?? e.accountId },
      { header: 'DETAILS', value: (e) => (e.details && Object.keys(e.details).length ? fmtValue(e.details) : null) },
    ], { empty: '(no entries)' });
    if (data.nextCursor) lines.push(`(more: --before ${data.nextCursor})`);
    return { data, lines };
  },
};

const authEvents = {
  name: 'auth-events',
  summary: 'sign-in events, newest first: who, from where, whether it worked',
  usage: 'audit auth-events [--limit N] [--offset N]',
  help: ['--limit N    at most N events (default 100, at most 500)', '--offset N   skip the first N'],
  flags: { limit: 'string', offset: 'string' },
  async run(ctx) {
    const limit = parseCount(ctx.flags.limit, { name: 'limit', min: 1, max: 500, fallback: 100 });
    const offset = parseCount(ctx.flags.offset, { name: 'offset', min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
    const data = await listAuthEvents({ limit, offset });
    const lines = table(data.events, [
      { header: 'TIME', value: (e) => fmtDate(e.created_at) },
      { header: 'EVENT', value: (e) => e.event_type },
      { header: 'USER', value: (e) => e.username },
      { header: 'IP', value: (e) => e.ip },
      { header: 'OK', value: (e) => e.success },
    ], { empty: '(no events)' });
    if (data.total > offset + data.events.length) lines.push(`(${data.events.length} of ${data.total}: --offset ${offset + data.events.length} for more)`);
    return { data, lines };
  },
};

export default {
  name: 'audit',
  summary: 'the journal and the sign-in events',
  commands: [list, authEvents],
};
