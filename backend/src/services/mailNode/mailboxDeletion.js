import { query, withTransaction } from '../db.js';
import { insertAuditEntries, recordAudit } from '../auditLog.js';
import { redactEmail } from '../../utils/redact.js';
import { MailNodeError, deleteMailbox, getDeleteAfterDays, getMailbox, getMailNodeConfig } from './mailcow.js';
import { SYSTEM_ACTOR } from './domains.js';

// Deleting a mail node mailbox (owner decision 2026-10-01, R-33): anyone signed in may ask for it
// with the mailbox's address typed out and a reason; the mailbox keeps working for the days an
// administrator set (DEFAULT_DELETE_AFTER_DAYS), anyone may cancel until then, and then this job
// deletes it for good: on the node with all its mail (delete/mailbox), then the panel row. The rows
// are the source of truth (migration 0081): the job claims a row (deletion_started_at) before it
// touches the node, a cancel is refused once a row is claimed, and a restart loses nothing.

const RUN_INTERVAL_MS = 5 * 60 * 1000;
// Waits after a failed attempt: 15 minutes, doubling, at most a day. A run every 5 minutes keeps a
// wait close to what it says.
const FIRST_RETRY_SECONDS = 15 * 60;
const MAX_RETRY_SECONDS = 24 * 60 * 60;
// A claim older than this is left from a run that stopped (a crash, a restart mid-deletion): the
// next run takes the row again. A cancel stays refused while any claim exists, since the node
// mailbox may be gone already.
const STALE_CLAIM_MINUTES = 10;

// What deletion_last_error holds: a code the screens translate; the details go to the server log.
const STEP_FAILED = 'deletion_step_failed';
const ROW_KEPT = 'node_deleted_row_kept';

let running = false;
let timer = null;

// Steps run for a due mailbox before it is deleted on the node, each given (row, cfg); a step that
// throws keeps the mailbox pending and is retried like a node failure, so every step must be
// idempotent (a retry, or a stale claim taken again after a crash, runs it again). Empty for now:
// when the tenant driver exists, removing the mailbox's recipient (the DBEB mail contact, R-29)
// from the tenant goes here, so EOP rejects the address at the edge before the node forgets it.
export const BEFORE_NODE_DELETE = [];

export function retryDelaySeconds(attempts) {
  return Math.min(FIRST_RETRY_SECONDS * 2 ** Math.max(0, attempts), MAX_RETRY_SECONDS);
}

// Deletes the mailbox on the node with its mail. A mailbox the node no longer has (removed by hand,
// or another node) counts as deleted (alreadyAbsent). Returns { warnings, alreadyAbsent }; throws a
// MailNodeError when the node refused or could not be asked.
export async function deleteOnNode(cfg, email) {
  try {
    const { warnings } = await deleteMailbox(cfg, email);
    return { warnings, alreadyAbsent: false };
  } catch (err) {
    if (!(err instanceof MailNodeError)) throw err;
    const gone = err.code === 'mail_node_refused' && await getMailbox(cfg, email).then((m) => m === null, () => false);
    if (!gone) throw err;
    return { warnings: [], alreadyAbsent: true };
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
           deletion_attempts = 0, deletion_next_attempt_at = NULL, deletion_last_error = NULL,
           deletion_started_at = NULL
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
// from the row; the journal keeps it. Refused once the job has claimed the row (deletion_started_at),
// stale claim included: the node mailbox may be gone already. Answers { deleteAfter, reason } (what
// was set) or { error }: account_not_found, deletion_not_requested, deletion_in_progress.
export async function cancelDeletion({ accountId }) {
  const { rows } = await query(`
    WITH old AS (
      SELECT id, delete_after, deletion_reason, deletion_started_at FROM email_accounts WHERE id = $1 FOR UPDATE
    )
    UPDATE email_accounts a
       SET deletion_requested_at = NULL, deletion_requested_by = NULL, deletion_requested_by_email = NULL,
           deletion_reason = NULL, delete_after = NULL, deletion_attempts = 0, deletion_next_attempt_at = NULL,
           deletion_last_error = NULL
      FROM old
     WHERE a.id = old.id AND old.delete_after IS NOT NULL AND old.deletion_started_at IS NULL
    RETURNING old.delete_after AS was, old.deletion_reason AS reason
  `, [accountId]);
  if (rows.length) return { deleteAfter: rows[0].was, reason: rows[0].reason ?? null };
  const { rows: found } = await query('SELECT delete_after, deletion_started_at FROM email_accounts WHERE id = $1', [accountId]);
  if (!found.length) return { error: 'account_not_found' };
  if (found[0].delete_after && found[0].deletion_started_at) return { error: 'deletion_in_progress' };
  return { error: 'deletion_not_requested' };
}

// A failed attempt: the row stays pending, its claim (when it has one) is released, the reason code
// is shown and the next attempt waits longer.
async function recordFailure(row, code) {
  await query(`
    UPDATE email_accounts
       SET deletion_attempts = deletion_attempts + 1,
           deletion_next_attempt_at = NOW() + make_interval(secs => $2::int),
           deletion_last_error = $3,
           deletion_started_at = NULL
     WHERE id = $1 AND delete_after IS NOT NULL AND deletion_started_at IS NOT DISTINCT FROM $4::timestamptz
  `, [row.id, retryDelaySeconds(row.deletion_attempts), code, row.deletion_started_at ?? null]);
}

// Claims a due row for this run, or answers null when it is no longer due (cancelled since the batch
// was read), or claimed by a run that has not gone stale. The claim is kept to the millisecond so
// the value read back matches the stored one exactly in the later conditions on it.
async function claim(id) {
  const { rows } = await query(`
    UPDATE email_accounts
       SET deletion_started_at = date_trunc('milliseconds', NOW())
     WHERE id = $1 AND mail_node AND delete_after IS NOT NULL AND delete_after <= NOW()
       AND (deletion_started_at IS NULL OR deletion_started_at < NOW() - make_interval(mins => $2::int))
    RETURNING id, email_address, imap_host, deletion_requested_at, deletion_requested_by_email, deletion_reason,
              deletion_attempts, deletion_started_at
  `, [id, STALE_CLAIM_MINUTES]);
  return rows[0] ?? null;
}

async function deleteDue(id, cfg, disconnect) {
  const row = await claim(id);
  if (!row) return null;
  // A row on another host than the node the settings name: the same address there is another
  // mailbox. It stays pending with the reason shown until the settings or the row are put right.
  if (String(row.imap_host ?? '').trim().toLowerCase() !== cfg.mailHost) {
    console.warn(`Mailbox deletion: ${redactEmail(row.email_address)} is on another host than the mail node, kept`);
    await recordFailure(row, 'mail_node_host_mismatch');
    return false;
  }
  let node;
  try {
    for (const step of BEFORE_NODE_DELETE) await step(row, cfg);
    node = await deleteOnNode(cfg, row.email_address);
  } catch (err) {
    const code = err instanceof MailNodeError ? err.code : STEP_FAILED;
    console.error(`Mailbox deletion of ${redactEmail(row.email_address)} failed, retried later: ${err?.code || ''} ${err?.message || 'error'}`);
    await recordFailure(row, code).catch((e) => console.error('Mailbox deletion: could not record the failure:', e.message));
    return false;
  }
  if (node.warnings.length) {
    console.warn(`Mail node deleted ${redactEmail(row.email_address)} with warnings: ${node.warnings.join('; ')}`);
  }
  const details = {
    mailNode: true, pending: true,
    requestedBy: row.deletion_requested_by_email ?? null,
    requestedAt: row.deletion_requested_at,
    reason: row.deletion_reason ?? null,
    ...(node.alreadyAbsent ? { alreadyAbsent: true } : {}),
    ...(node.warnings.length ? { nodeWarnings: node.warnings } : {}),
  };
  // The row goes only under this run's claim, and its journal entry with it, in one transaction.
  const removed = await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'DELETE FROM email_accounts WHERE id = $1 AND deletion_started_at = $2::timestamptz', [row.id, row.deletion_started_at],
    );
    if (!rowCount) return false;
    await insertAuditEntries(client, {
      actorEmail: SYSTEM_ACTOR, accountEmail: row.email_address, action: 'mailbox.deleted', details,
    });
    return true;
  });
  if (!removed) {
    // The node mailbox is gone but the row changed under the claim: never silent.
    console.error(`Mailbox deletion: ${redactEmail(row.email_address)} was deleted on the node, but its panel row was not removed`);
    await recordAudit({
      actorEmail: SYSTEM_ACTOR, accountEmail: row.email_address, action: 'mailbox.deleted',
      details: { ...details, panelRowKept: true },
    });
    await query('UPDATE email_accounts SET deletion_last_error = $2 WHERE id = $1', [row.id, ROW_KEPT])
      .catch((e) => console.error('Mailbox deletion: could not mark the kept row:', e.message));
    return false;
  }
  // Like the manual removal: the IMAP session is closed without holding up the run.
  Promise.resolve()
    .then(() => disconnect(row.id))
    .catch((err) => console.error(`Disconnect after deleting ${row.id} failed:`, err?.message));
  return true;
}

// One run of the deletion job: deletes every node mailbox whose date has come and whose retry wait
// is over. Never touches a row whose delete_after is NULL or in the future. A failure keeps the row
// pending with a reason code and a longer wait. Returns { deleted, failed }.
export async function runDueDeletions({ disconnect = async () => {} } = {}) {
  if (running) return { deleted: 0, failed: 0, skipped: 'running' };
  running = true;
  try {
    const { rows } = await query(`
      SELECT id, deletion_attempts, deletion_started_at
        FROM email_accounts
       WHERE mail_node AND delete_after IS NOT NULL AND delete_after <= NOW()
         AND (deletion_next_attempt_at IS NULL OR deletion_next_attempt_at <= NOW())
         AND (deletion_started_at IS NULL OR deletion_started_at < NOW() - make_interval(mins => $1::int))
       ORDER BY delete_after`, [STALE_CLAIM_MINUTES]);
    if (!rows.length) return { deleted: 0, failed: 0 };
    const cfg = await getMailNodeConfig();
    if (!cfg) {
      // Kept pending with the reason shown and the usual wait, instead of a log line every run.
      for (const row of rows) {
        await recordFailure(row, 'mail_node_not_configured')
          .catch((e) => console.error('Mailbox deletion: could not record the failure:', e.message));
      }
      return { deleted: 0, failed: rows.length, skipped: 'mail_node_not_configured' };
    }
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const done = await deleteDue(row.id, cfg, disconnect);
        // null: cancelled or claimed elsewhere since the batch was read; neither deleted nor failed.
        if (done) deleted += 1;
        else if (done === false) failed += 1;
      } catch (err) {
        failed += 1;
        console.error(`Mailbox deletion of account ${row.id} failed:`, err?.message);
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
