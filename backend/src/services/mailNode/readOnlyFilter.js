import { query } from '../db.js';
import {
  addMailboxFilter, deleteMailboxFilters, editMailboxFilter, listAllMailboxFilters, listMailboxFilters,
} from './mailcow.js';

// The read-only filter of a deactivated mail node mailbox or one pending deletion (EOP seats design):
// mail from another mailbox of the node never passes EOP, so the missing tenant recipient does not
// stop it. A per-mailbox Sieve prefilter through the mailcow API refuses it; IMAP is untouched, so the
// panel still reads the mailbox. Research and its limits: eop-panel-requirements.md section 5.16.
//
// mailcow keeps one active prefilter per mailbox: adding ours deactivates the mailbox's other active
// prefilters. Their ids are written into our filter's description ("mailexpert-read-only
// restore=3,5") in the same call that adds it, so the node itself remembers them: opening
// re-enables exactly those, then deletes ours. Every step is idempotent, so a retry after a crash
// finishes the job. reconcileLocalDelivery makes the node match the rows (the alert run calls it), so
// a failed step, a mailbox that became read-only in a migration or an edit made by hand heal.

export const READ_ONLY_FILTER_DESC = 'mailexpert-read-only';
const READ_ONLY_SCRIPT = 'require ["reject"];\nreject "This mailbox is closed and no longer takes mail.";\n';
const RESTORE = /\brestore=(\d+(?:,\d+)*)/;

const isOurs = (filter) => filter.type === 'prefilter' && filter.desc.startsWith(READ_ONLY_FILTER_DESC);
const restoreOf = (filter) => (RESTORE.exec(filter.desc)?.[1] ?? '').split(',').filter(Boolean).map(Number);

// Makes local delivery refuse mail. Answers at once when our filter is active already.
export async function closeLocalDelivery(cfg, email) {
  const filters = await listMailboxFilters(cfg, email);
  if (filters.some((f) => isOurs(f) && f.active)) return;
  const ours = filters.filter(isOurs);
  // What to give back later: the prefilters active now (the add deactivates them) and those an
  // earlier, inactive copy of ours remembers; only ones that still exist.
  const existing = new Set(filters.filter((f) => f.type === 'prefilter' && !isOurs(f)).map((f) => f.id));
  const restore = [...new Set([
    ...filters.filter((f) => f.type === 'prefilter' && !isOurs(f) && f.active).map((f) => f.id),
    ...ours.flatMap(restoreOf).filter((id) => existing.has(id)),
  ])].sort((a, b) => a - b);
  const desc = restore.length ? `${READ_ONLY_FILTER_DESC} restore=${restore.join(',')}` : READ_ONLY_FILTER_DESC;
  await addMailboxFilter(cfg, { email, type: 'prefilter', desc, script: READ_ONLY_SCRIPT });
  await deleteMailboxFilters(cfg, ours.map((f) => f.id));
}

// Makes local delivery work again: the prefilters ours displaced are re-enabled first (ours becomes
// inactive, mail flows), then ours is deleted.
export async function openLocalDelivery(cfg, email) {
  const filters = await listMailboxFilters(cfg, email);
  const ours = filters.filter((f) => f.desc.startsWith(READ_ONLY_FILTER_DESC));
  if (!ours.length) return;
  const byId = new Map(filters.map((f) => [f.id, f]));
  const wanted = [...new Set(ours.flatMap(restoreOf))].filter((id) => byId.has(id) && !isOurs(byId.get(id)));
  // One active prefilter per mailbox: the latest remembered one wins, as it would have.
  const id = wanted.at(-1);
  if (id !== undefined && !byId.get(id).active) await editMailboxFilter(cfg, id, { active: '1' });
  await deleteMailboxFilters(cfg, ours.map((f) => f.id));
}

// Makes the node's filters match the rows: a read-only mailbox has our filter, a working one has
// none. One read of every filter of the node; only the differences are written. Returns
// { closed, opened, failed }; a node that cannot be asked throws.
export async function reconcileLocalDelivery(cfg) {
  const { rows } = await query(`
    SELECT lower(email_address) AS email,
           (delete_after IS NOT NULL OR deactivated_at IS NOT NULL) AS read_only
      FROM email_accounts
     WHERE mail_node AND lower(imap_host) = $1`, [String(cfg.mailHost).toLowerCase()]);
  // An address held by several rows is read-only only when all of them are.
  const readOnly = new Map();
  for (const row of rows) readOnly.set(row.email, (readOnly.get(row.email) ?? true) && row.read_only);
  const byUser = new Map();
  for (const f of await listAllMailboxFilters(cfg)) {
    if (!byUser.has(f.username)) byUser.set(f.username, []);
    byUser.get(f.username).push(f);
  }
  const result = { closed: 0, opened: 0, failed: 0 };
  for (const [email, closed] of readOnly) {
    const filters = byUser.get(email) ?? [];
    const hasActive = filters.some((f) => isOurs(f) && f.active);
    const hasAny = filters.some((f) => f.desc.startsWith(READ_ONLY_FILTER_DESC));
    try {
      if (closed && !hasActive) {
        await closeLocalDelivery(cfg, email);
        result.closed += 1;
      } else if (!closed && hasAny) {
        await openLocalDelivery(cfg, email);
        result.opened += 1;
      }
    } catch (err) {
      if (err?.code === 'mail_node_unreachable' || err?.code === 'mail_node_auth') throw err;
      console.error(`Read-only filter of a node mailbox not reconciled: ${err?.code || 'error'}`);
      result.failed += 1;
    }
  }
  return result;
}
