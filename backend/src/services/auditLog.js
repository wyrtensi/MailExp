import { query } from './db.js';

// Everything a user can do that the journal records (a letter queued, cancelled, moved to another
// time or failed after its author left included), plus the Cloudflare Access sync stopping
// itself, MailExpert restoring a rejected mail node password, taking in the mail node domains
// that already had mailboxes, a scheduled DNS check whose result changed, a mail node alert that
// was raised or cleared, and an administrator releasing, deleting or training a letter of the
// mail node's quarantine or writing its settings, and a mail node outage window opened or closed by
// the alert job or added, changed, closed or deleted by an administrator. Mail sync and inbox rules never write here.
export const AUDIT_ACTIONS = Object.freeze([
  'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
  'mailbox.enabled', 'mailbox.disabled', 'mailbox.threading_changed', 'mailbox.password_restored',
  'mailbox.quota_changed', 'mailbox.rate_limit_changed', 'mailbox.deletion_requested', 'mailbox.deletion_cancelled',
  'message.sent', 'message.deleted', 'message.move_reverted',
  'message.send_queued', 'message.send_cancelled', 'message.send_rescheduled', 'message.send_failed',
  'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
  'access.sync_aborted',
  'mail_node.config_changed', 'mail_node.domain_added', 'mail_node.domain_adopted', 'mail_node.domain_state_changed',
  'mail_node.domain_identity_acknowledged', 'mail_node.applied', 'mail_node.dns_checked',
  'mail_node.queue_action', 'mail_node.alert_raised', 'mail_node.alert_cleared',
  'mail_node.quarantine_released', 'mail_node.quarantine_deleted', 'mail_node.quarantine_learned_spam',
  'mail_node.quarantine_settings_applied',
  'mail_node.outage_opened', 'mail_node.outage_closed', 'mail_node.outage_added', 'mail_node.outage_changed',
  'mail_node.outage_deleted',
]);
const KNOWN_ACTIONS = new Set(AUDIT_ACTIONS);

// Rows per INSERT, so emptying a large folder never builds one huge parameter.
const CHUNK_SIZE = 1000;

// The database fills in both emails: the actor's email (or username when it has none, or the
// name the caller passed for an actor that is not a user) and the mailbox address, falling back
// to the address the caller passed for a mailbox already deleted.
const INSERT_SQL = `
  INSERT INTO mailbox_audit_log (actor_user_id, actor_email, account_id, account_email, action, details)
  SELECT u.id, COALESCE(NULLIF(u.email, ''), u.username, e.actor_email), a.id, COALESCE(a.email_address, e.account_email),
         e.action, COALESCE(e.details, '{}'::jsonb)
    FROM jsonb_to_recordset($1::jsonb)
         AS e(actor_user_id uuid, actor_email text, account_id uuid, account_email text, action text, details jsonb)
    LEFT JOIN users u ON u.id = e.actor_user_id
    LEFT JOIN email_accounts a ON a.id = e.account_id`;

function toRow(entry) {
  return {
    actor_user_id: entry.actorUserId ?? null,
    actor_email: entry.actorEmail ?? null,
    account_id: entry.accountId ?? null,
    account_email: entry.accountEmail ?? null,
    action: entry.action,
    details: entry.details ?? {},
  };
}

// Records journal entries. Callers do not await it: the promise never rejects, so a journal
// failure can never fail the action it describes. Errors are logged by code only, because a
// database message can quote the values being inserted.
export function recordAudit(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter((entry) => {
    if (KNOWN_ACTIONS.has(entry?.action)) return true;
    console.error('[audit] Unknown action:', entry?.action);
    return false;
  });
  if (!list.length) return Promise.resolve();

  const rows = list.map(toRow);
  return (async () => {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      try {
        await query(INSERT_SQL, [JSON.stringify(rows.slice(i, i + CHUNK_SIZE))]);
      } catch (err) {
        console.error('[audit] Failed to record entries:', err?.code || err?.name || 'Error');
      }
    }
  })();
}

// Records journal entries inside the caller's transaction (client: the transaction's client), so
// the entry and the change it describes are written together or not at all. Unlike recordAudit it
// throws: a failure rolls the change back.
export async function insertAuditEntries(client, entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  const unknown = list.find((entry) => !KNOWN_ACTIONS.has(entry?.action));
  if (unknown) throw new Error(`Unknown audit action: ${unknown?.action}`);
  if (!list.length) return;
  await client.query(INSERT_SQL, [JSON.stringify(list.map(toRow))]);
}
