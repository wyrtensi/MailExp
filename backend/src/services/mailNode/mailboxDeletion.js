import { query } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { redactEmail } from '../../utils/redact.js';
import { MailNodeError, deleteMailbox, getDeleteAfterDays, getMailbox, getMailNodeConfig } from './mailcow.js';
import { SYSTEM_ACTOR } from './domains.js';

// Deleting a mail node mailbox (owner decision 2026-10-01, R-33): anyone signed in may ask for it
// with the mailbox's address typed out; the mailbox keeps working for the days an administrator
// set (DEFAULT_DELETE_AFTER_DAYS), anyone may cancel until then, and then this job deletes it for
// good: on the node with all its mail (delete/mailbox), then the panel row. The rows are the source
// of truth (migration 0081), so a restart loses nothing; the backend runs as one process, so the
// set of deletions in progress lives in memory.

const RUN_INTERVAL_MS = 15 * 60 * 1000;
// Waits after a failed attempt: 15 minutes, doubling, at most a day.
const FIRST_RETRY_SECONDS = 15 * 60;
const MAX_RETRY_SECONDS = 24 * 60 * 60;

const inProgress = new Set();
let running = false;
let timer = null;

// Steps run for a due mailbox before it is deleted on the node, each given (row, cfg); a step that
// throws keeps the mailbox pending and is retried like a node failure. Empty for now: when the
// tenant driver exists, removing the mailbox's recipient (the DBEB mail contact, R-29) from the
// tenant goes here, so EOP rejects the address at the edge before the node forgets it.
export const BEFORE_NODE_DELETE = [];

export function retryDelaySeconds(attempts) {
  return Math.min(FIRST_RETRY_SECONDS * 2 ** Math.max(0, attempts), MAX_RETRY_SECONDS);
}

export function deletionInProgress(accountId) {
  return inProgress.has(accountId);
}

// Deletes the mailbox on the node with its mail. A mailbox the node no longer has (removed by hand,
// or another node) counts as deleted. Returns mailcow's warnings; throws a MailNodeError when the
// node refused or could not be asked.
export async function deleteOnNode(cfg, email) {
  try {
    return await deleteMailbox(cfg, email);
  } catch (err) {
    if (!(err instanceof MailNodeError)) throw err;
    const gone = err.code === 'mail_node_refused' && await getMailbox(cfg, email).then((m) => m === null, () => false);
    if (!gone) throw err;
    return { warnings: [] };
  }
}

// Someone asks to delete a node mailbox, saying why: it is scheduled for deletion after the
// configured days. Answers { deleteAfter, days } or { error }: account_not_found, not_mail_node,
// deletion_already_requested.
export async function requestDeletion({ accountId, userId, reason }) {
  const days = await getDeleteAfterDays();
  const { rows } = await query(`
    UPDATE email_accounts
       SET deletion_requested_at = NOW(), deletion_requested_by = $2,
           deletion_requested_by_email = (SELECT COALESCE(NULLIF(email, ''), username) FROM users WHERE id = $2),
           deletion_reason = $4,
           delete_after = NOW() + make_interval(days => $3::int),
           deletion_attempts = 0, deletion_next_attempt_at = NULL, deletion_last_error = NULL
     WHERE id = $1 AND mail_node AND delete_after IS NULL
    RETURNING delete_after
  `, [accountId, userId, days, reason]);
  if (rows.length) return { deleteAfter: rows[0].delete_after, days };
  const { rows: found } = await query('SELECT mail_node, delete_after FROM email_accounts WHERE id = $1', [accountId]);
  if (!found.length) return { error: 'account_not_found' };
  if (!found[0].mail_node) return { error: 'not_mail_node' };
  return { error: 'deletion_already_requested' };
}

// Someone cancels a pending deletion: the mailbox stays and the request (reason included) is cleared
// from the row; the journal keeps it. Refused while the job is deleting it. Answers { deleteAfter,
// reason } (what was set) or { error }: account_not_found, deletion_not_requested,
// deletion_in_progress.
export async function cancelDeletion({ accountId }) {
  if (deletionInProgress(accountId)) return { error: 'deletion_in_progress' };
  const { rows } = await query(`
    WITH old AS (SELECT id, delete_after, deletion_reason FROM email_accounts WHERE id = $1 FOR UPDATE)
    UPDATE email_accounts a
       SET deletion_requested_at = NULL, deletion_requested_by = NULL, deletion_requested_by_email = NULL,
           deletion_reason = NULL, delete_after = NULL, deletion_attempts = 0, deletion_next_attempt_at = NULL,
           deletion_last_error = NULL
      FROM old
     WHERE a.id = old.id AND old.delete_after IS NOT NULL
    RETURNING old.delete_after AS was, old.deletion_reason AS reason
  `, [accountId]);
  if (rows.length) return { deleteAfter: rows[0].was, reason: rows[0].reason ?? null };
  const { rows: found } = await query('SELECT 1 FROM email_accounts WHERE id = $1', [accountId]);
  return { error: found.length ? 'deletion_not_requested' : 'account_not_found' };
}

async function recordFailure(row, reason) {
  await query(`
    UPDATE email_accounts
       SET deletion_attempts = deletion_attempts + 1,
           deletion_next_attempt_at = NOW() + make_interval(secs => $2::int),
           deletion_last_error = $3
     WHERE id = $1 AND delete_after IS NOT NULL
  `, [row.id, retryDelaySeconds(row.deletion_attempts), reason]);
}

async function deleteDue(row, cfg, disconnect) {
  // The batch was read before this row's turn: a cancel in between (allowed until the row is marked
  // in progress) must win, so the row is read again now that a cancel is refused.
  const { rows: [still] } = await query(
    'SELECT 1 FROM email_accounts WHERE id = $1 AND delete_after IS NOT NULL AND delete_after <= NOW()', [row.id],
  );
  if (!still) return null;
  // A row on another host than the node the settings name: the same address there is another
  // mailbox. It stays pending with the reason shown until the settings or the row are put right.
  if (String(row.imap_host ?? '').trim().toLowerCase() !== cfg.mailHost) {
    console.warn(`Mailbox deletion: ${redactEmail(row.email_address)} is on another host than the mail node, kept`);
    await recordFailure(row, 'mail_node_host_mismatch');
    return false;
  }
  for (const step of BEFORE_NODE_DELETE) await step(row, cfg);
  const { warnings } = await deleteOnNode(cfg, row.email_address);
  if (warnings.length) {
    console.warn(`Mail node deleted ${redactEmail(row.email_address)} with warnings: ${warnings.join('; ')}`);
  }
  // Only a row still due goes: a cancel cannot slip in (it is refused while this runs), and a row
  // whose date moved is left alone.
  const { rowCount } = await query(
    'DELETE FROM email_accounts WHERE id = $1 AND delete_after IS NOT NULL AND delete_after <= NOW()', [row.id],
  );
  if (!rowCount) return false;
  await recordAudit({
    actorEmail: SYSTEM_ACTOR,
    accountEmail: row.email_address,
    action: 'mailbox.deleted',
    details: {
      mailNode: true, pending: true,
      requestedBy: row.deletion_requested_by_email ?? null,
      requestedAt: row.deletion_requested_at,
      reason: row.deletion_reason ?? null,
      ...(warnings.length ? { nodeWarnings: warnings } : {}),
    },
  });
  await Promise.resolve(disconnect(row.id)).catch((err) => console.error(`Disconnect after deleting ${row.id} failed:`, err.message));
  return true;
}

// One run of the deletion job: deletes every node mailbox whose date has come and whose retry wait
// is over. Never touches a row whose delete_after is NULL or in the future. A failure keeps the row
// pending with the reason and a longer wait. Returns { deleted, failed }.
export async function runDueDeletions({ disconnect = async () => {} } = {}) {
  if (running) return { deleted: 0, failed: 0, skipped: 'running' };
  running = true;
  try {
    const { rows } = await query(`
      SELECT id, email_address, imap_host, deletion_requested_at, deletion_requested_by_email, deletion_reason,
             deletion_attempts
        FROM email_accounts
       WHERE mail_node AND delete_after IS NOT NULL AND delete_after <= NOW()
         AND (deletion_next_attempt_at IS NULL OR deletion_next_attempt_at <= NOW())
       ORDER BY delete_after`);
    if (!rows.length) return { deleted: 0, failed: 0 };
    const cfg = await getMailNodeConfig();
    if (!cfg) {
      console.warn(`Mailbox deletion: ${rows.length} mailbox(es) due, but the mail node is not set up`);
      return { deleted: 0, failed: rows.length, skipped: 'mail_node_not_configured' };
    }
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      inProgress.add(row.id);
      try {
        const done = await deleteDue(row, cfg, disconnect);
        // null: cancelled since the batch was read; neither deleted nor failed.
        if (done) deleted += 1;
        else if (done === false) failed += 1;
      } catch (err) {
        failed += 1;
        const reason = err instanceof MailNodeError ? `${err.code}: ${err.message}` : (err?.message || 'error');
        console.error(`Mailbox deletion of ${redactEmail(row.email_address)} failed, retried later: ${reason}`);
        await recordFailure(row, reason).catch((e) => console.error('Mailbox deletion: could not record the failure:', e.message));
      } finally {
        inProgress.delete(row.id);
      }
    }
    return { deleted, failed };
  } finally {
    running = false;
  }
}

export function startMailboxDeletionJob({ disconnect } = {}) {
  if (timer) return;
  const run = () => runDueDeletions({ disconnect }).catch((err) => console.error('Mailbox deletion job failed:', err.message));
  run();
  timer = setInterval(run, RUN_INTERVAL_MS);
  timer.unref?.();
}
