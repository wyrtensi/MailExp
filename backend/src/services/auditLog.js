import { query } from './db.js';

// Everything a user can do that the journal records (a letter queued, cancelled, moved to another
// time or failed after its author left included), plus the Cloudflare Access sync stopping
// itself, importing a user from the policy (or a first Access sign-in creating one), an
// administrator clearing a deleted user's tombstone, changing its settings or token or asking for a run, MailExpert restoring a rejected mail node password, taking in the mail node domains
// that already had mailboxes, a scheduled DNS check whose result changed, a mail node alert that
// was raised or cleared, and an administrator releasing, deleting or training a letter of the
// mail node's quarantine or writing its settings, and a mail node outage window opened or closed by
// the alert job or added, changed, closed or deleted by an administrator, and a test of the
// connection to the Microsoft tenant, the DBEB recipients the tenant driver made or removed and an
// administrator taking the connectors as the reference, and (stage 7c) a message the panel released
// from EOP's quarantine, the release paused or resumed, and a letter's message trace asked for.
// Creating, changing or deleting an inbox rule is recorded too (who did it, the rule's actions
// and where it forwards to), since a rule can forward a mailbox's mail outside; mail sync and the
// rules running write only rule.run, when someone starts a run by hand. An administrator asking
// for a panel update from the admin UI is recorded, and so are its start and end as the host's
// updater reports them (services/panelUpdate/reconcile.js), under that administrator. So is an
// administrator switching a plugin on or off for the whole panel (routes/plugins.js), and an administrator
// issuing, rotating or revoking the mail node agent's token or asking it for a job (routes/mailNodeAgent.js).
// An administrator deactivating or activating a mail node mailbox, anyone asking for more EOP seats and an
// administrator changing their hold period (EOP seats: services/mailNode/seatProvider.js, routes/mailNodeSeats.js).
export const AUDIT_ACTIONS = Object.freeze([
  'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
  'mailbox.enabled', 'mailbox.disabled', 'mailbox.threading_changed', 'mailbox.password_restored',
  'mailbox.quota_changed', 'mailbox.rate_limit_changed', 'mailbox.deletion_requested', 'mailbox.deletion_cancelled',
  'mailbox.deactivated', 'mailbox.activated',
  'mailbox.oauth_subject_reset',
  'message.sent', 'message.deleted', 'message.move_reverted',
  'message.send_queued', 'message.send_cancelled', 'message.send_rescheduled', 'message.send_failed',
  'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
  'access.sync_aborted', 'access.config_changed', 'access.sync_requested',
  'access.user_imported', 'access.import_aborted', 'access.tombstone_cleared',
  'mail_node.config_changed', 'mail_node.domain_added', 'mail_node.domain_adopted', 'mail_node.domain_state_changed',
  'mail_node.domain_identity_acknowledged', 'mail_node.applied', 'mail_node.dns_checked',
  'mail_node.queue_action', 'mail_node.alert_raised', 'mail_node.alert_cleared',
  'mail_node.quarantine_released', 'mail_node.quarantine_deleted', 'mail_node.quarantine_learned_spam',
  'mail_node.quarantine_settings_applied',
  'mail_node.outage_opened', 'mail_node.outage_closed', 'mail_node.outage_added', 'mail_node.outage_changed',
  'mail_node.outage_deleted',
  'mail_node.agent_token_issued', 'mail_node.agent_token_revoked', 'mail_node.agent_job_requested',
  'mail_node.seats_requested', 'mail_node.seat_hold_changed',
  'tenant.connection_tested', 'tenant.recipients_synced', 'tenant.connector_reference_taken',
  'tenant.domain_hold_changed', 'tenant.internal_relay_approved',
  'tenant.quarantine_released', 'tenant.phish_release_changed', 'tenant.message_traced',
  // Section 5.14 (the owner's decisions after stage 7).
  'tenant.antispam_enforced', 'tenant.alias_contacts_removal_approved',
  'rule.created', 'rule.updated', 'rule.deleted', 'rule.run',
  'panel.update_requested', 'panel.update_started', 'panel.update_finished', 'panel.update_failed',
  'plugin.enabled', 'plugin.disabled',
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
  const write = (async () => {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      try {
        await query(INSERT_SQL, [JSON.stringify(rows.slice(i, i + CHUNK_SIZE))]);
      } catch (err) {
        console.error('[audit] Failed to record entries:', err?.code || err?.name || 'Error');
      }
    }
  })();
  pending.add(write);
  write.finally(() => pending.delete(write));
  return write;
}

// The writes recordAudit started and that have not ended yet.
const pending = new Set();

// Resolves when every journal write started so far has ended (they never reject). A short-lived
// process (the panel CLI) waits for it before it closes its database pool, or the entries are lost.
export function auditWritesSettled() {
  return Promise.all([...pending]).then(() => undefined);
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
