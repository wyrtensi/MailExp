import { query } from '../db.js';
import { encrypt } from '../encryption.js';
import { sanitizeSignature } from '../emailSanitizer.js';
import { getConnectionPolicy } from '../connectionPolicy.js';
import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import { computeAccountHealth } from '../accountHealth.js';
import { hasHeaderInjectionChars } from '../accountAliases.js';
import {
  CONNECTION_FIELDS, RECONNECT_FIELDS, changedConnectionFields, changedServersError, impliedImapTls, newServersError,
  storedColumnValue,
} from './connection.js';

// An administrator's actions on mailboxes set up by hand (IMAP/SMTP) and on OAuth ones, shared by
// the accounts API (routes/accounts.js: POST / without kind 'domain', POST /:id/oauth-subject/
// reset) and the panel CLI (cli/commands/account.js, cli/commands/mailbox.js): the same checks,
// the same journal. A mailbox on the mail node has its own actions (services/mailNode/
// mailboxActions.js). Connecting a mailbox is the backend's (imapManager): the route connects at
// once, the CLI queues it (services/admin/adminEffects.js, reconnect).

// code -> [HTTP status, message]. A refusal may carry its own message (servers_refused).
export const ACCOUNT_ERRORS = Object.freeze({
  name_email_required: [400, 'Name and email required'],
  name_email_control_chars: [400, 'Name and email address cannot contain control characters'],
  sender_name_control_chars: [400, 'Sender name cannot contain control characters'],
  servers_refused: [400, 'Server refused'],
  account_not_found: [404, 'Account not found'],
  account_ambiguous: [409, 'More than one mailbox has this address: name it by its ID'],
  mail_node_connection_locked: [400, 'The server settings of a mail node mailbox cannot be changed'],
  no_fields: [400, 'No valid fields to update'],
  oauth_mailbox_not_found: [404, 'OAuth mailbox not found'],
});

// Fields safe to return to the client — matches the GET list, excludes credentials and tokens.
export const SAFE_FIELDS = [
  'id', 'name', 'sender_name', 'email_address', 'color', 'protocol',
  'imap_host', 'imap_port', 'imap_skip_tls_verify',
  'smtp_host', 'smtp_port', 'smtp_tls',
  'auth_user', 'smtp_auth_user', 'oauth_provider', 'oauth_reconnect_required', 'enabled',
  'include_in_unified_inbox', 'mail_node',
  'last_sync', 'sync_error', 'sort_order', 'folder_mappings',
  'signature', 'created_at', 'categorization_enabled', 'thread_mode',
  // A mail node mailbox someone asked to delete (migration 0081): when, by whom, when it goes for
  // good, and why the deletion job could not delete it yet.
  'deletion_requested_at', 'deletion_requested_by_email', 'deletion_reason', 'delete_after', 'deletion_last_error',
  // A deactivated mail node mailbox (migration 0095): read-only, its seat on hold.
  'deactivated_at', 'deactivated_by_email', 'deactivation_reason',
  // Stage 7b (R-32): the mailbox's domain is Authoritative and the tenant has no recipient for it
  // yet, so EOP still rejects mail to it; computed by GET /.
  'tenant_pending',
];

export function safeAccount(row) {
  const obj = Object.fromEntries(SAFE_FIELDS.map((k) => [k, row[k]]));
  // Sanitize on read so legacy values stored before the write-time sanitizer are safe
  if (obj.signature) obj.signature = sanitizeSignature(obj.signature);
  return obj;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Any mailbox an operator names (the CLI): by its ID, or by its address, case-insensitively.
// Answers { account } (the stored row: never answer it as is, it holds the secrets) or { error }.
export async function findAccount(ref) {
  const text = String(ref ?? '').trim();
  if (!text) return { error: 'account_not_found' };
  if (UUID.test(text)) {
    const { rows: [row] } = await query('SELECT * FROM email_accounts WHERE id = $1', [text]);
    return row ? { account: row } : { error: 'account_not_found' };
  }
  const { rows } = await query('SELECT * FROM email_accounts WHERE lower(email_address) = $1 ORDER BY created_at, id', [text.toLowerCase()]);
  if (!rows.length) return { error: 'account_not_found' };
  if (rows.length > 1) return { error: 'account_ambiguous' };
  return { account: rows[0] };
}

// Every mailbox, as the panel's list orders them (safeAccount, the health code, who added it), or
// only those a user added: { accounts }.
export async function listAccounts({ addedBy = null } = {}) {
  const { rows } = await query(
    `SELECT a.*, COALESCE(NULLIF(u.email, ''), u.username) AS added_by_name
       FROM email_accounts a LEFT JOIN users u ON u.id = a.added_by
      ${addedBy ? 'WHERE a.added_by = $1' : ''}
      ORDER BY a.sort_order, a.created_at`,
    addedBy ? [addedBy] : [],
  );
  const now = Date.now();
  return {
    accounts: rows.map((row) => ({
      ...safeAccount(row),
      added_by: row.added_by ?? null,
      added_by_name: row.added_by_name ?? null,
      health: computeAccountHealth(row, now),
    })),
  };
}

// Adds a mailbox set up by hand (an administrator's task: an ordinary user adds Gmail through the
// Google flow or a mailbox on the mail node). The servers pass the admin's connection policy
// (private hosts, nonstandard ports). Answers { account } (the stored row) or { error, message? };
// the caller connects it (imapManager).
export async function createManualAccount(body, actor) {
  const {
    name, sender_name = null, email_address, color = '#6366f1', protocol = 'imap',
    imap_host, imap_port = 993, imap_skip_tls_verify = false,
    smtp_host, smtp_port = 587, smtp_tls = 'STARTTLS',
    auth_user, auth_pass, smtp_auth_user = null, smtp_auth_pass = null,
    oauth_provider, oauth_access_token, oauth_refresh_token,
    signature = null,
  } = body || {};

  if (!name || !email_address) return { error: 'name_email_required' };
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email_address)) return { error: 'name_email_control_chars' };
  if (sender_name && hasHeaderInjectionChars(sender_name)) return { error: 'sender_name_control_chars' };

  const policy = await getConnectionPolicy();
  const serversError = await newServersError({ imap_host, imap_port, smtp_host, smtp_port }, policy);
  if (serversError) return { error: 'servers_refused', message: serversError };

  const result = await query(`
      INSERT INTO email_accounts (
        added_by, name, sender_name, email_address, color, protocol,
        imap_host, imap_port, imap_tls, imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
        auth_user, auth_pass, smtp_auth_user, smtp_auth_pass, oauth_provider, oauth_access_token, oauth_refresh_token,
        signature
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *
    `, [
    actor?.userId ?? null, name, sender_name || null, email_address, color, protocol,
    imap_host, imap_port, impliedImapTls(imap_port), !!imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
    auth_user, encrypt(auth_pass), smtp_auth_user || null, encrypt(smtp_auth_pass) || null,
    oauth_provider, encrypt(oauth_access_token), encrypt(oauth_refresh_token),
    sanitizeSignature(signature) || null,
  ]);

  const account = result.rows[0];
  recordAudit(auditOf(actor, {
    accountId: account.id,
    action: 'mailbox.added',
    details: { protocol: account.protocol, oauthProvider: account.oauth_provider ?? null },
  }));
  return { account };
}

// Changes where a mailbox connects and what it signs in with (CONNECTION_FIELDS only), as an
// administrator's PUT /:id does: the same refusals (a node mailbox's servers belong to the node
// settings) and policy checks, the port deciding IMAP TLS, mailbox.connection_changed with the
// changed field names. Answers { account, fields, reconnect } — reconnect: the running mailbox has
// to reconnect for the change (the caller asks the backend) — or { error, message? }.
export async function updateAccountConnection(id, updates, actor) {
  const given = Object.fromEntries(Object.entries(updates || {}).filter(([key]) => CONNECTION_FIELDS.includes(key)));
  if (!Object.keys(given).length) return { error: 'no_fields' };
  const { rows: [stored] } = await query('SELECT * FROM email_accounts WHERE id = $1', [id]);
  if (!stored) return { error: 'account_not_found' };
  if (stored.mail_node && changedConnectionFields(stored, given).length) return { error: 'mail_node_connection_locked' };

  const policy = await getConnectionPolicy();
  const serversError = await changedServersError(given, policy);
  if (serversError) return { error: 'servers_refused', message: serversError };
  if ('imap_port' in given) given.imap_tls = impliedImapTls(given.imap_port);

  const keys = CONNECTION_FIELDS.filter((key) => key in given);
  const { rows: [account] } = await query(
    `UPDATE email_accounts SET ${keys.map((key, i) => `${key} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((key) => storedColumnValue(key, given[key])), id],
  );
  const fields = changedConnectionFields(stored, given);
  if (fields.length) {
    recordAudit(auditOf(actor, { accountId: id, action: 'mailbox.connection_changed', details: { fields } }));
  }
  const reconnect = account.protocol === 'imap' && account.enabled !== false && keys.some((key) => RECONNECT_FIELDS.includes(key));
  return { account, fields, reconnect };
}

// Forgets which Google or Microsoft account an OAuth mailbox is bound to (oauth_subject): its next
// reconnect binds whoever signs in with the mailbox's verified address. Not for a node mailbox.
// Answers { ok, oauthProvider } or { error: 'oauth_mailbox_not_found' }.
export async function resetOAuthSubject(id, actor) {
  const { rows } = await query(
    `UPDATE email_accounts SET oauth_subject = NULL
      WHERE id = $1 AND oauth_provider IN ('google', 'microsoft') AND mail_node IS NOT TRUE
      RETURNING id, oauth_provider`,
    [id],
  );
  if (!rows.length) return { error: 'oauth_mailbox_not_found' };
  recordAudit(auditOf(actor, {
    accountId: rows[0].id, action: 'mailbox.oauth_subject_reset',
    details: { oauthProvider: rows[0].oauth_provider },
  }));
  return { ok: true, oauthProvider: rows[0].oauth_provider };
}
