import { query } from '../db.js';
import { relayKind } from './postfixLog.js';

// The tenant's external recipient budget (TERRL, R-21; eop-panel-requirements.md, section 2.9):
// EOP counts the unique external recipients of the whole tenant over a rolling 24 hours, relayed
// mail of the node included, and above the limit stops all external mail of the tenant
// (550 5.7.233). mailcow's own send limit counts messages per login, not recipients, so the panel
// counts them itself and warns at 80 percent, Microsoft's advice.
//
// The limit: the TERRL of the EOP settings (the tenant's full limit as the EAC report or Microsoft
// gives it), else the formula from the number of licenses; then the ramp of a young tenant from its
// creation date (since 2026-09-14: under 31 days 10 percent, 31 to 60 days 25 percent). If the EAC
// report already shows the ramped number, enter it as TERRL and leave the creation date empty.
//
// What is counted, unique addresses, lower case, recipients on the node's own domains left out:
// - the panel's journal (message.sent of a mailbox on a node domain: To, Cc and Bcc as sent) over
//   the full 24 hours: exact times, kept in the database, indexed by time;
// - the node's Postfix log, as far back as it reaches: every recipient a delivery line shows handed
//   to EOP with status=sent. It adds what the journal never sees: messages an inbox rule forwards
//   and notices the node sends itself (bounces, Sieve redirects). The log alone is not enough: the
//   node keeps a few thousand lines, which on a busy node cover hours, not a day.

export const TERRL_WARN_PERCENT = 80;
export const TERRL_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// 500 x licenses^0.7 + 9500, rounded: 100 licenses -> 22 059, 500 -> 48 248.
export function terrlFromLicenses(licenses) {
  if (!Number.isInteger(licenses) || licenses < 1) return null;
  return Math.round(500 * licenses ** 0.7 + 9500);
}

// Whole days since the tenant was created (a YYYY-MM-DD date, UTC), or null without one.
export function tenantAgeDays(createdOn, now = Date.now()) {
  if (typeof createdOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(createdOn)) return null;
  const created = Date.parse(`${createdOn}T00:00:00Z`);
  if (!Number.isFinite(created)) return null;
  return Math.max(0, Math.floor((now - created) / DAY_MS));
}

// The share of the full limit a tenant of that age gets: day 0 to 30 -> 10, 31 to 60 -> 25.
export function rampPercent(ageDays) {
  if (ageDays == null) return 100;
  if (ageDays < 31) return 10;
  if (ageDays <= 60) return 25;
  return 100;
}

// { fullLimit, limitFrom: 'terrl' | 'licenses' | null, ageDays, rampPercent, limit } from the EOP
// settings (terrl, licenses, tenantCreatedOn).
export function terrlLimit({ terrl = null, licenses = null, tenantCreatedOn = null } = {}, now = Date.now()) {
  const fromLicenses = terrlFromLicenses(licenses);
  const own = Number.isInteger(terrl) && terrl > 0;
  const fullLimit = own ? terrl : fromLicenses;
  let limitFrom = null;
  if (own) limitFrom = 'terrl';
  else if (fromLicenses != null) limitFrom = 'licenses';
  const ageDays = tenantAgeDays(tenantCreatedOn, now);
  const percent = rampPercent(ageDays);
  return {
    fullLimit, limitFrom, ageDays, rampPercent: percent,
    limit: fullLimit == null ? null : Math.round((fullLimit * percent) / 100),
  };
}

// The address of "Name <a@b>" or "a@b", lower case; null for anything without an @.
export function recipientAddress(value) {
  const text = String(value ?? '').trim();
  const angle = /<([^<>]*)>\s*$/.exec(text);
  const address = (angle ? angle[1] : text).trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return at > 0 && at < address.length - 1 ? address : null;
}

// The unique external addresses among the journal entries ({ to, cc, bcc }) and the extra
// addresses given (the log's), leaving out those on ownDomains.
export function externalRecipients({ journal = [], addresses = [], ownDomains = [] }) {
  const own = new Set(ownDomains.map((d) => String(d).toLowerCase()));
  const found = new Set();
  const add = (value) => {
    const address = recipientAddress(value);
    if (address && !own.has(address.slice(address.lastIndexOf('@') + 1))) found.add(address);
  };
  for (const entry of journal) {
    for (const list of [entry?.to, entry?.cc, entry?.bcc]) {
      if (Array.isArray(list)) list.forEach(add);
    }
  }
  addresses.forEach(add);
  return found;
}

// The budget: the limit (terrlLimit) with { used, percent (whole, floor), warn (at or above 80
// percent), exceeded }; percent, warn and exceeded are null and false without a limit.
export function terrlBudget({ settings = {}, used = 0, now = Date.now() } = {}) {
  const limit = terrlLimit(settings, now);
  if (limit.limit == null) return { ...limit, used, percent: null, warn: false, exceeded: false };
  return {
    ...limit,
    used,
    percent: Math.floor((used * 100) / limit.limit),
    warn: used * 100 >= limit.limit * TERRL_WARN_PERCENT,
    exceeded: used >= limit.limit,
  };
}

// The journal's sent messages of the node's mailboxes since `since` (a Date): their details.
export async function journalSince(since) {
  const { rows } = await query(`
    SELECT details FROM mailbox_audit_log
     WHERE action = 'message.sent' AND occurred_at >= $1
       AND lower(split_part(account_email, '@', 2)) IN (SELECT domain FROM mail_node_domains)`, [since]);
  return rows.map((row) => row.details ?? {});
}

export async function nodeDomainNames() {
  const { rows } = await query('SELECT domain FROM mail_node_domains');
  return rows.map((row) => row.domain);
}

// The recipients the log shows handed to EOP (status=sent) since `since` (ms).
export function eopRecipientsInLog(lines, { since, eopHost }) {
  return lines
    .filter((line) => line.event === 'sent' && line.epoch != null && line.epoch >= since && line.to)
    .filter((line) => relayKind(line, { eopHost }) === 'eop')
    .map((line) => line.to);
}

// The budget now (terrlBudget) with where the count came from: { ...budget, windowStart, log: {
// read, covered, oldestAt } }. log: the node's Postfix log already read (readPostfixLog) or null
// when it could not be read; the journal alone counts then.
export async function computeTerrlBudget({ eop, log = null, now = Date.now() }) {
  const since = now - TERRL_WINDOW_MS;
  const [journal, ownDomains] = await Promise.all([journalSince(new Date(since)), nodeDomainNames()]);
  const addresses = log ? eopRecipientsInLog(log.lines, { since, eopHost: eop.eopHost }) : [];
  const used = externalRecipients({ journal, addresses, ownDomains }).size;
  return {
    ...terrlBudget({ settings: eop, used, now }),
    windowStart: new Date(since).toISOString(),
    log: log
      ? { read: true, covered: !!log.oldestAt && Date.parse(log.oldestAt) <= since, oldestAt: log.oldestAt }
      : { read: false, covered: false, oldestAt: null },
  };
}
