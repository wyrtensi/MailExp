import { publicFolderCounts } from '../services/folderStatus.js';
import { Router } from 'express';
import { query } from '../services/db.js';
import { isAdminRequest, requireAuth, requireAdmin } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { providerProfile } from '../services/imapManager.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { revokeGoogleToken } from '../services/oauth/googleOAuth.js';
import { redactEmail } from '../utils/redact.js';
import { sanitizeSignature } from '../services/emailSanitizer.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { computeAccountHealth } from '../services/accountHealth.js';
import { pluginRegistry } from '../plugins/registry.js';
import { recordAudit } from '../services/auditLog.js';
import { createKeyedSerializer } from '../utils/keyedSerializer.js';
import { uuidParam } from '../utils/uuid.js';
import {
  ALIAS_ERRORS, createAlias, deleteAlias, hasHeaderInjectionChars, listAliases, updateAlias,
} from '../services/accountAliases.js';
import { THREAD_MODE_GMAIL, THREAD_MODE_RFC } from '../services/threading/threadId.js';
import { previewRecompute } from '../services/threading/recompute.js';
import { providerThreadIndexState } from '../services/threading/providerThreadIndex.js';
import { getMailNodeConfig, listAliasesTo } from '../services/mailNode/mailcow.js';
import {
  MAILBOX_ERRORS, activateNodeMailbox, cancelMailboxDeletion, createNodeMailbox, deactivateNodeMailbox, requestMailboxDeletion,
} from '../services/mailNode/mailboxActions.js';
import { routeActor } from '../services/actor.js';
import { mailNodeFailure, onOtherMailHost, refuse as refuseMailNode } from './mailNode.js';
import { failJobsOfDeletedAccount } from '../services/jobQueue.js';

const THREAD_MODES = new Set([THREAD_MODE_RFC, THREAD_MODE_GMAIL]);

// Serialize an account's reconnect triggers so a rapid settings change (e.g. a
// gtd_enabled double-toggle) can't fire two overlapping disconnect→connect chains —
// connectAccount's in-progress guard would drop the second and leave the GTD sync
// tick armed inconsistently with the final DB value. Queued per account id.
const reconnectQueue = createKeyedSerializer();

const ALLOWED_IMAP_PORTS = new Set([143, 993]);
const ALLOWED_SMTP_PORTS = new Set([465, 587]);

function validatePort(port, allowed) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return `Port ${port} is not a valid port number`;
  }
  // When private/local hosts are explicitly allowed (e.g. Proton Mail Bridge on 1143/1025),
  // skip the whitelist — the operator has already opted into unrestricted host access.
  if (process.env.ALLOW_PRIVATE_IMAP_HOSTS === 'true') return null;
  if (!allowed.has(n)) {
    return `Port ${port} is not allowed. Allowed: ${[...allowed].join(', ')}`;
  }
  return null;
}

const router = Router();
router.use(requireAuth);
// Reject malformed UUID path params with a 400 before they reach a uuid-typed query (else the
// Postgres cast error surfaces as a 500). Every :id/:aliasId in this router is a UUID.
router.param('id', uuidParam('id'));
router.param('aliasId', uuidParam('aliasId'));

// Fields safe to return to the client — matches the GET list, excludes credentials and tokens
const SAFE_FIELDS = [
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
function safeAccount(row) {
  const obj = Object.fromEntries(SAFE_FIELDS.map(k => [k, row[k]]));
  // Sanitize on read so legacy values stored before the write-time sanitizer are safe
  if (obj.signature) obj.signature = sanitizeSignature(obj.signature);
  return obj;
}

router.get('/', async (req, res) => {
  const result = await query(
    `SELECT id, name, sender_name, email_address, color, protocol, imap_host, imap_port, imap_tls, imap_skip_tls_verify,
            smtp_host, smtp_port, smtp_tls, auth_user, smtp_auth_user, oauth_provider, oauth_reconnect_required, enabled,
            include_in_unified_inbox,
            last_sync, sync_error, sort_order, folder_mappings, signature, created_at,
            categorization_enabled, thread_mode, mail_node,
            deletion_requested_at, deletion_requested_by_email, deletion_reason, delete_after, deletion_last_error,
            deactivated_at, deactivated_by_email, deactivation_reason,
            last_received_at,
            (mail_node AND delete_after IS NULL AND deactivated_at IS NULL AND tenant_recipient_at IS NULL AND EXISTS (
              SELECT 1 FROM mail_node_domains d
               WHERE d.domain = split_part(lower(email_address), '@', 2) AND d.state = 'authoritative')) AS tenant_pending
     FROM email_accounts
     ORDER BY sort_order, created_at`
  );

  // Attach aliases to each account in one query
  const accountIds = result.rows.map(a => a.id);
  let aliasMap = {};
  if (accountIds.length) {
    const aliasResult = await query(
      `SELECT id, account_id, name, email, reply_to, signature, created_at
       FROM account_aliases WHERE account_id = ANY($1) ORDER BY created_at`,
      [accountIds]
    );
    for (const alias of aliasResult.rows) {
      if (!aliasMap[alias.account_id]) aliasMap[alias.account_id] = [];
      aliasMap[alias.account_id].push(alias);
    }
  }

  // Gmail id backfill state (threading/providerIdBackfill.js); absent for other providers.
  const providerIdStates = await imapManager.providerIdBackfillStates(result.rows);
  // Thread recompute progress (services/threading/recompute.js); applies to every mailbox, not
  // just Gmail ones, since the rfc target is also a legitimate switch for a non-Gmail mailbox.
  const recomputeStates = await imapManager.threadRecomputeStates(result.rows);

  // One clock for the whole list so every account's stale check uses the same instant.
  const now = Date.now();

  // Let plugins re-attach their own account-scoped fields (GTD: gtd_enabled/gtd_folders, no longer
  // columns) so the client sees them as before. Each enrichAccount handler returns a field patch.
  const enriched = await Promise.all(result.rows.map(async (a) => {
    const patches = await pluginRegistry.collectHook('enrichAccount', { account: a });
    return {
      ...a,
      ...Object.assign({}, ...patches),
      signature: a.signature ? sanitizeSignature(a.signature) : a.signature,
      // Stable code only (see services/accountHealth.js); sync_error stays the sole error text.
      health: computeAccountHealth(a, now),
      provider_ids_backfill: providerIdStates.get(a.id) ?? null,
      thread_recompute: recomputeStates.get(a.id) ?? null,
      aliases: (aliasMap[a.id] || []).map(alias => ({
        ...alias,
        signature: alias.signature ? sanitizeSignature(alias.signature) : alias.signature,
      })),
    };
  }));
  res.json(enriched);
});

// Server and credential settings: where the mailbox connects and what it signs in with. Their
// change is the audit log's (by name only) and an administrator's alone, since a host, a port or a
// TLS switch decides where the stored password or OAuth token is sent. The settings form sends
// every server field on each save, so a field counts only when its value differs. Nothing else
// writes these columns from a request: a new manual mailbox is admin-only (POST /), the OAuth
// callbacks set their provider's fixed servers, a node mailbox takes the node's.
const CONNECTION_FIELDS = [
  'imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify', 'smtp_host', 'smtp_port', 'smtp_tls',
  'auth_user', 'auth_pass', 'smtp_auth_user', 'smtp_auth_pass',
];
const PASSWORD_FIELDS = new Set(['auth_pass', 'smtp_auth_pass']);

function changedConnectionFields(stored, updates) {
  return CONNECTION_FIELDS.filter((key) => {
    if (!(key in updates)) return false;
    // Passwords are stored encrypted and never compared: a new one or a cleared one is a change.
    if (PASSWORD_FIELDS.has(key)) return !!updates[key] || !!stored[key];
    return String(stored[key] ?? '') !== String(updates[key] ?? '');
  });
}

// A mailbox on the mail node, open to everyone signed in: the server picks the host, the ports and
// a password only MailExpert knows, so nothing from the body reaches the connection settings
// (services/mailNode/mailboxActions.js, shared with the panel CLI).
async function createDomainMailbox(req, res) {
  let result;
  try {
    result = await createNodeMailbox(req.body ?? {}, routeActor(req), {
      onCreated: (account) => { imapManager.connectAccount(account).catch(console.error); },
    });
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  if (result.error) return refuseMailbox(res, result.error);
  // The store takes this row as is, so the second name is on it for compose's From list.
  return res.json({ ...safeAccount({ ...result.account, tenant_pending: result.tenantPending }), aliases: result.aliases });
}

function refuseMailbox(res, code) {
  const [status, error] = MAILBOX_ERRORS[code];
  return res.status(status).json({ error, code });
}

// Manual server setup is an admin task: an ordinary user adds Gmail through the Google flow or a
// mailbox on the mail node (`kind: 'domain'`).
router.post('/', (req, res, next) => (
  req.body?.kind === 'domain' ? createDomainMailbox(req, res) : next()
), requireAdmin, async (req, res) => {
  const {
    name, sender_name = null, email_address, color = '#6366f1', protocol = 'imap',
    imap_host, imap_port = 993, imap_skip_tls_verify = false,
    smtp_host, smtp_port = 587, smtp_tls = 'STARTTLS',
    auth_user, auth_pass, smtp_auth_user = null, smtp_auth_pass = null,
    oauth_provider, oauth_access_token, oauth_refresh_token,
    signature = null
  } = req.body;

  if (!name || !email_address) return res.status(400).json({ error: 'Name and email required' });
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email_address)) {
    return res.status(400).json({ error: 'Name and email address cannot contain control characters' });
  }
  if (sender_name && hasHeaderInjectionChars(sender_name)) {
    return res.status(400).json({ error: 'Sender name cannot contain control characters' });
  }

  const policy = await getConnectionPolicy();

  if (imap_host) {
    const err = (await validateHost(imap_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(imap_port, ALLOWED_IMAP_PORTS));
    if (err) return res.status(400).json({ error: `IMAP: ${err}` });
  }
  if (smtp_host) {
    const err = (await validateHost(smtp_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(smtp_port, ALLOWED_SMTP_PORTS));
    if (err) return res.status(400).json({ error: `SMTP: ${err}` });
  }

  try {
    const result = await query(`
      INSERT INTO email_accounts (
        added_by, name, sender_name, email_address, color, protocol,
        imap_host, imap_port, imap_tls, imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
        auth_user, auth_pass, smtp_auth_user, smtp_auth_pass, oauth_provider, oauth_access_token, oauth_refresh_token,
        signature
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *
    `, [
      req.session.userId, name, sender_name || null, email_address, color, protocol,
      imap_host, imap_port, Number(imap_port) % 1000 === 993, !!imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
      auth_user, encrypt(auth_pass), smtp_auth_user || null, encrypt(smtp_auth_pass) || null,
      oauth_provider, encrypt(oauth_access_token), encrypt(oauth_refresh_token),
      sanitizeSignature(signature) || null
    ]);

    const account = result.rows[0];
    recordAudit({
      actorUserId: req.session.userId,
      accountId: account.id,
      action: 'mailbox.added',
      details: { protocol: account.protocol, oauthProvider: account.oauth_provider ?? null },
    });

    // Immediately try to connect — needs full credentials from DB row
    if (protocol === 'imap') {
      imapManager.connectAccount(account).catch(console.error);
    }

    res.json(safeAccount(account));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add account' });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  // The mailbox must exist. The stored row tells the audit log what actually changed.
  const storedResult = await query('SELECT * FROM email_accounts WHERE id = $1', [id]);
  if (!storedResult.rows.length) return res.status(404).json({ error: 'Account not found' });
  const stored = storedResult.rows[0];

  // The server and the password of a mail node mailbox belong to the node settings: pointing it at
  // another host would hand the generated password to that host. The form resends unchanged
  // values, so only a real change is refused.
  if (stored.mail_node && changedConnectionFields(stored, updates).length) {
    return res.status(400).json({ error: 'The server settings of a mail node mailbox cannot be changed', code: 'mail_node_connection_locked' });
  }
  // A mail node mailbox has no panel pause: it is deactivated (POST /:id/deactivation, EOP seats
  // design) or deleted. Only turning one off is refused, so a form resending the value and a mailbox
  // paused before this rule (which may be resumed) still go through.
  if (stored.mail_node && 'enabled' in updates && !updates.enabled && stored.enabled !== false) {
    return res.status(400).json({ error: 'A mail node mailbox cannot be paused: deactivate it instead', code: 'mail_node_disable_unsupported' });
  }

  // Everyone may rename a mailbox, recolour it, edit its signature or folder mappings; only an
  // administrator may point it at another server or change how it signs in. The unchanged values a
  // stale form resends are dropped so they cannot start a reconnect either.
  if (!(await isAdminRequest(req))) {
    if (changedConnectionFields(stored, updates).length) {
      return res.status(403).json({ error: 'Only an administrator can change the server settings of a mailbox', code: 'connection_admin_only' });
    }
    for (const key of CONNECTION_FIELDS) delete updates[key];
  }

  if ('name' in updates && hasHeaderInjectionChars(updates.name)) {
    return res.status(400).json({ error: 'Name cannot contain control characters' });
  }
  if ('sender_name' in updates && updates.sender_name && hasHeaderInjectionChars(updates.sender_name)) {
    return res.status(400).json({ error: 'Sender name cannot contain control characters' });
  }
  const policy = await getConnectionPolicy();

  if ('imap_host' in updates && updates.imap_host) {
    const err = await validateHost(updates.imap_host, { allowPrivate: policy.allowPrivateHosts });
    if (err) return res.status(400).json({ error: `IMAP: ${err}` });
  }
  if ('imap_port' in updates && updates.imap_port !== undefined && updates.imap_port !== null) {
    if (!policy.allowNonstandardPorts) {
      const err = validatePort(updates.imap_port, ALLOWED_IMAP_PORTS);
      if (err) return res.status(400).json({ error: `IMAP: ${err}` });
    }
  }
  if ('smtp_host' in updates && updates.smtp_host) {
    const err = await validateHost(updates.smtp_host, { allowPrivate: policy.allowPrivateHosts });
    if (err) return res.status(400).json({ error: `SMTP: ${err}` });
  }
  if ('smtp_port' in updates && updates.smtp_port !== undefined && updates.smtp_port !== null) {
    if (!policy.allowNonstandardPorts) {
      const err = validatePort(updates.smtp_port, ALLOWED_SMTP_PORTS);
      if (err) return res.status(400).json({ error: `SMTP: ${err}` });
    }
  }

  if ('imap_port' in updates) updates.imap_tls = Number(updates.imap_port) % 1000 === 993;

  // Let plugins validate the settings fields they own (GTD owns gtd_enabled/gtd_folders) before we
  // touch anything. A plugin may hard-reject the change (return an error response), report per-field
  // sub-values it reset to defaults, and flag whether its change requires a reconnect. The actual
  // write of a plugin's fields happens in persistAccountSettings below (into the plugin's own store,
  // not a column). This is the generic account-scoped settings surface; core knows nothing
  // GTD-specific here.
  // Plugins see a frozen copy: a hook cannot add a field (a host, say) past the checks above.
  const pluginUpdates = Object.freeze({ ...updates });
  const settingsResults = await pluginRegistry.collectHook('validateAccountSettings', {
    updates: pluginUpdates, accountId: id,
  });
  const rejectedByField = {};
  let pluginRequiresReconnect = false;
  for (const r of settingsResults) {
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (r.rejected) Object.assign(rejectedByField, r.rejected);
    if (r.requiresReconnect) pluginRequiresReconnect = true;
  }

  const allowed = ['name', 'sender_name', 'color', 'enabled', 'auth_user', 'auth_pass', 'sort_order', 'imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify', 'smtp_host', 'smtp_port', 'smtp_tls', 'smtp_auth_user', 'smtp_auth_pass', 'folder_mappings', 'signature', 'categorization_enabled'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = $${i++}`);
      const value = ((key === 'auth_pass' || key === 'smtp_auth_pass') && updates[key]) ? encrypt(updates[key])
        : (key === 'smtp_auth_user' || key === 'smtp_auth_pass') ? (updates[key] || null)
        : (key === 'signature') ? sanitizeSignature(updates[key]) || null
        : updates[key];
      values.push(value);
    }
  }

  // Write the core columns (if any changed), then let plugins persist their own owned fields into
  // their stores (GTD: gtd_enabled/gtd_folders → plugin_account_config). A request may touch ONLY
  // plugin fields (e.g. the GTD enable toggle), in which case there are no core columns to write —
  // re-read the row for the response base instead of running an empty UPDATE.
  let updated;
  if (sets.length) {
    values.push(id);
    const result = await query(
      `UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    updated = result.rows[0];
  } else {
    const reread = await query('SELECT * FROM email_accounts WHERE id = $1', [id]);
    updated = reread.rows[0];
  }

  // Persist plugin-owned fields into their own stores; each returns { patch } (the saved values) to
  // echo back on the response so the client sees them as if they were columns.
  const persistResults = await pluginRegistry.collectHook('persistAccountSettings', {
    accountId: id, updates: pluginUpdates,
  });
  const pluginPatch = {};
  let pluginPersisted = false;
  for (const r of persistResults) {
    if (r?.patch) { Object.assign(pluginPatch, r.patch); pluginPersisted = true; }
  }

  if (!sets.length && !pluginPersisted) return res.status(400).json({ error: 'No valid fields to update' });

  if (sets.length) {
    const auditEntries = [];
    const fields = changedConnectionFields(stored, updates);
    if (fields.length) {
      auditEntries.push({ actorUserId: req.session.userId, accountId: id, action: 'mailbox.connection_changed', details: { fields } });
    }
    if ('enabled' in updates && !!updates.enabled !== !!stored.enabled) {
      auditEntries.push({ actorUserId: req.session.userId, accountId: id, action: updates.enabled ? 'mailbox.enabled' : 'mailbox.disabled', details: {} });
    }
    if (auditEntries.length) recordAudit(auditEntries);
  }

  const payload = { ...safeAccount(updated), ...pluginPatch };
  // Surface any plugin-rejected field sub-values (e.g. GTD folder paths reset to defaults) so the
  // settings form can flag them. Keyed by field name as the client expects.
  if (rejectedByField.gtd_folders) payload.gtd_folders_rejected = rejectedByField.gtd_folders;
  res.json(payload);

  // Sync live IMAP state after DB update (fire-and-forget, non-fatal). Core reconnect triggers
  // are the connection/credential/host fields; a plugin can also require a reconnect for its own
  // field change (GTD: a gtd_enabled toggle re-arms the tick, a folder remap backfills the newly
  // designated folder) via validateAccountSettings' requiresReconnect.
  const isDisabling = 'enabled' in updates && !updates.enabled;
  const needsReconnect = !isDisabling && (
    'enabled' in updates ||
    'auth_user' in updates ||
    'auth_pass' in updates ||
    'imap_host' in updates ||
    'imap_port' in updates ||
    'imap_tls' in updates ||
    'imap_skip_tls_verify' in updates ||
    pluginRequiresReconnect
  );

  // Both branches queue through the per-account serializer so overlapping settings
  // changes (e.g. a rapid gtd_enabled double-toggle) apply their connection-state
  // effects in order, never as two overlapping chains.
  if (isDisabling) {
    reconnectQueue(id, () => imapManager.disconnectAccount(id))
      .catch(err => console.error(`Failed to disconnect account ${id} after disable:`, err.message));
  } else if (needsReconnect && updated.protocol === 'imap' && updated.enabled) {
    reconnectQueue(id, () =>
      imapManager.disconnectAccount(id)
        .then(() => query('SELECT * FROM email_accounts WHERE id = $1', [id]))
        .then(r => {
          if (!r.rows.length) return;
          // New credentials/host may cure an auth failure or refusal — don't let the old
          // cooldown silently swallow this reconnect.
          imapManager.clearConnectCooldown(id);
          return imapManager.connectAccount(r.rows[0]);
        })
    ).catch(err => console.error(`Failed to reconnect account ${id} after update:`, err.message));
  }
});

// Whether only administrators may delete a mail node mailbox, which takes its mail with it. Off:
// everyone signed in may delete any mailbox, one on the mail node too (accounts.shared.test.js).
// The owner is deciding (R-04); switching it on is this flag together with the one of the same name
// in the frontend (utils/mailNode.js), which hides the delete button.
const NODE_MAILBOX_DELETE_ADMIN_ONLY = false;

// Who may delete a mailbox (and see what deleting a node mailbox would take with it).
async function mayDeleteAccount(req, row) {
  if (!row.mail_node || !NODE_MAILBOX_DELETE_ADMIN_ONLY) return true;
  const { rows } = await query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
  return !!rows[0]?.is_admin;
}

// The node mailboxes MailExpert knows are all on the host the node settings name. A row on another
// host (the settings were pointed at another node since) must not be acted on through this node:
// the same address there is another mailbox.
function refusedOtherHost(res, row, cfg) {
  if (!onOtherMailHost(row, cfg)) return false;
  refuseMailNode(res, 'mail_node_host_mismatch');
  return true;
}

// What deleting a node mailbox would take with it, for the confirmation: the node's aliases that
// deliver to it (those delivering only to it are deleted with it, the others lose it as a target)
// and the days it keeps working before it goes. Open to whoever may delete the mailbox.
router.get('/:id/node-aliases', async (req, res) => {
  const { rows } = await query('SELECT id, email_address, mail_node, imap_host FROM email_accounts WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });
  if (!rows[0].mail_node) return refuseMailNode(res, 'mailbox_not_found');
  if (!(await mayDeleteAccount(req, rows[0]))) return res.status(403).json({ error: 'Admin access required' });
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuseMailNode(res, 'mail_node_not_configured');
  if (refusedOtherHost(res, rows[0], cfg)) return undefined;
  try {
    return res.json({ aliases: await listAliasesTo(cfg, rows[0].email_address), deleteAfterDays: cfg.deleteAfterDays });
  } catch (err) {
    return mailNodeFailure(res, err);
  }
});

// Asks to delete a mail node mailbox (owner decision 2026-10-01): it keeps working until
// delete_after (now plus the days an administrator set), then the deletion job deletes it on the
// node with all its mail and removes it here (services/mailNode/mailboxDeletion.js). The body
// repeats the mailbox's address, as typed in the confirmation, and says why ({ email, reason }).
// Nothing is asked of the node now. services/mailNode/mailboxActions.js, shared with the panel CLI.
router.post('/:id/deletion', async (req, res) => {
  let result;
  try {
    result = await requestMailboxDeletion(
      { accountId: req.params.id, email: req.body?.email, reason: req.body?.reason },
      routeActor(req),
      { mayDelete: (row) => mayDeleteAccount(req, row) },
    );
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  if (result.error === 'admin_required') return res.status(403).json({ error: 'Admin access required' });
  if (result.error) return refuseMailbox(res, result.error);
  return res.json(safeAccount(result.account));
});

// Cancels a pending deletion: the mailbox stays as it is. Anyone signed in may cancel.
router.delete('/:id/deletion', async (req, res) => {
  let result;
  try {
    result = await cancelMailboxDeletion({ accountId: req.params.id }, routeActor(req));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  if (result.error) return refuseMailbox(res, result.error);
  return res.json(safeAccount(result.account));
});

// Deactivates a mail node mailbox (EOP seats design; administrators): read-only, its EOP seat on
// hold; the body says why ({ reason }). services/mailNode/mailboxActions.js.
router.post('/:id/deactivation', requireAdmin, async (req, res) => {
  let result;
  try {
    result = await deactivateNodeMailbox({ accountId: req.params.id, reason: req.body?.reason }, routeActor(req));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  if (result.error) return refuseMailbox(res, result.error);
  return res.json(safeAccount(result.account));
});

// Activates it again: its own seat while on hold, else a free one (refused at 0).
router.delete('/:id/deactivation', requireAdmin, async (req, res) => {
  let result;
  try {
    result = await activateNodeMailbox({ accountId: req.params.id }, routeActor(req));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  if (result.error) return refuseMailbox(res, result.error);
  return res.json(safeAccount(result.account));
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const check = await query(
      'SELECT id, email_address, mail_node, imap_host, oauth_provider, oauth_refresh_token, oauth_access_token FROM email_accounts WHERE id = $1',
      [id]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });
    if (!(await mayDeleteAccount(req, check.rows[0]))) return res.status(403).json({ error: 'Admin access required' });

    // A mail node mailbox is never removed at once: its deletion is asked for (POST /:id/deletion)
    // and the deletion job deletes it on the node with all its mail when its date comes.
    if (check.rows[0].mail_node) {
      return res.status(409).json({
        error: 'A mail node mailbox is deleted by asking for its deletion, which takes effect after a waiting time',
        code: 'mail_node_deletion_request_required',
      });
    }

    // The panel's own access token/grant at Google, read while the row (and its encrypted
    // tokens) still exists. Refresh token first — it is what a revoke call actually needs to
    // kill the whole grant; the access token is a fallback for a mailbox that never got one
    // (e.g. added before offline access, or already refresh-token-less for another reason).
    // decrypt() is documented to return null rather than throw on a corrupted value, but a
    // removal must never be blocked by the revoke step regardless — wrap the read so a bad
    // auth tag (or any other decrypt failure) skips the revoke instead of failing the delete.
    let googleRevokeToken = null;
    if (check.rows[0].oauth_provider === 'google') {
      try {
        googleRevokeToken = decrypt(check.rows[0].oauth_refresh_token) || decrypt(check.rows[0].oauth_access_token) || null;
      } catch (err) {
        console.error(`Could not read the Google token to revoke for removed mailbox ${redactEmail(check.rows[0].email_address)}: ${err?.name || 'Error'}`);
      }
    }

    // Delete from DB first (cascades to messages and folders immediately).
    // Disconnect IMAP afterward — fire-and-forget so a slow server logout
    // doesn't block the response.
    // Letters waiting to be sent from it fail first, so their authors hear of them (jobQueue.js).
    await failJobsOfDeletedAccount(id);
    // Revoked before the row goes, and awaited: Google revokes the person's access to the whole
    // project, so a revoke answered after the row is gone could also cut a grant the same address
    // got by being added again meanwhile. While the row exists, adding the address is refused
    // (already_connected). revokeGoogleToken never throws and times out on its own
    // (PROVIDER_FETCH_TIMEOUT_MS), so the deletion waits at most that long and never fails on it.
    // The grant journal (google_oauth_grants) is left untouched, same as every other revoke path
    // in this codebase — it is a lifetime record for the app's Google user cap, not a list of live
    // grants, and a revoked user still counts against that cap.
    if (googleRevokeToken) {
      const revoked = await revokeGoogleToken(googleRevokeToken).catch(() => false);
      console.log(`Google OAuth grant ${revoked ? 'revoked' : 'revoke failed'} for removed mailbox ${redactEmail(check.rows[0].email_address)}`);
    }
    await query('DELETE FROM email_accounts WHERE id = $1', [id]);
    // The row is gone, so the entry names the mailbox by the address read above.
    recordAudit({
      actorUserId: req.session.userId,
      accountEmail: check.rows[0].email_address,
      action: 'mailbox.deleted',
      details: { mailNode: false },
    });
    imapManager.disconnectAccount(id).catch(err =>
      console.error(`Disconnect error after delete for ${id}:`, err.message)
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Account delete error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

router.post('/:id/reconnect', async (req, res) => {
  const { id } = req.params;
  const result = await query('SELECT * FROM email_accounts WHERE id = $1', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
  // A turned-off mailbox stays off until it is enabled again (PUT /:id enabled: true).
  if (result.rows[0].enabled === false) {
    return res.status(409).json({ error: 'This mailbox is disabled: enable it to connect.', code: 'mailbox_disabled' });
  }

  // A second press while this mailbox is still connecting starts nothing.
  if (imapManager.isConnecting(id)) return res.json({ ok: true, skipped: true });
  // An explicit user request overrides any refusal/auth cooldown for one attempt.
  imapManager.clearConnectCooldown(id);
  imapManager.connectAccount(result.rows[0]).catch(console.error);
  res.json({ ok: true });
});

// Forgets which Google or Microsoft account an OAuth mailbox is bound to (oauth_subject): its next
// reconnect binds whoever signs in with the mailbox's verified address. For a mailbox whose owner's
// provider account was recreated, or one bound to the wrong account. Admin-only, journaled.
router.post('/:id/oauth-subject/reset', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `UPDATE email_accounts SET oauth_subject = NULL
      WHERE id = $1 AND oauth_provider IN ('google', 'microsoft') AND mail_node IS NOT TRUE
      RETURNING id, oauth_provider`,
    [req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'OAuth mailbox not found', code: 'oauth_mailbox_not_found' });
  recordAudit({
    actorUserId: req.session.userId, accountId: rows[0].id, action: 'mailbox.oauth_subject_reset',
    details: { oauthProvider: rows[0].oauth_provider },
  });
  res.json({ ok: true });
});

// ── Alias CRUD ─────────────────────────────────────────────────────────────

// The aliases live in services/accountAliases.js (shared with the panel CLI): a node mailbox's
// alias is another sender name for its own address (D-16), any other address is refused.
function refuseAlias(res, code) {
  const [status, error] = ALIAS_ERRORS[code];
  // The refusals the screens knew before the move had no code, except the node address one.
  return res.status(status).json(code === 'node_alias_address_mismatch' ? { error, code } : { error });
}

const identityChanged = (accountId) => pluginRegistry.runHook('onAccountIdentityChanged', { accountId })
  .catch(err => console.warn('onAccountIdentityChanged hook failed:', err.message));

router.get('/:id/aliases', async (req, res) => {
  const { id } = req.params;
  const check = await query('SELECT id FROM email_accounts WHERE id = $1', [id]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });
  res.json(await listAliases(id));
});

router.post('/:id/aliases', async (req, res) => {
  const { id } = req.params;
  const result = await createAlias(id, req.body ?? {});
  if (result.error) return refuseAlias(res, result.error);
  identityChanged(id);
  res.json(result.alias);
});

router.put('/:id/aliases/:aliasId', async (req, res) => {
  const { id, aliasId } = req.params;
  const result = await updateAlias(id, aliasId, req.body ?? {});
  if (result.error) return refuseAlias(res, result.error);
  identityChanged(result.accountId);
  res.json(result.alias);
});

router.delete('/:id/aliases/:aliasId', async (req, res) => {
  const { id, aliasId } = req.params;
  const result = await deleteAlias(id, aliasId);
  if (result.error) return refuseAlias(res, result.error);
  identityChanged(result.accountId);
  res.json({ ok: true });
});

router.get('/:id/folders', async (req, res) => {
  const { id } = req.params;
  const check = await query('SELECT id FROM email_accounts WHERE id = $1', [id]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  const result = await query(
    'SELECT * FROM folders WHERE account_id = $1 ORDER BY path',
    [id]
  );
  // Freshness depends on how long this account's rotation takes, so every row needs the count.
  const selectableFolders = result.rows.filter(row => !row.no_select).length;
  res.json(result.rows.map(row => publicFolderCounts(row, Date.now(), { selectableFolders })));
});

router.post('/:id/reindex', async (req, res) => {
  try {
    const result = await query(
      "SELECT * FROM email_accounts WHERE id = $1 AND enabled = true AND protocol = 'imap'",
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });

    const account = result.rows[0];
    const alreadyRunning = imapManager.backfillAllRunning.has(account.id);
    if (!alreadyRunning) {
      imapManager.backfillAllFolders(account).catch(err =>
        console.error(`Manual reindex error for ${account.email_address}:`, err.message)
      );
    }
    res.json({ ok: true, alreadyRunning });
  } catch (err) {
    console.error('POST /accounts/:id/reindex error:', err.message);
    res.status(500).json({ error: 'Failed to start reindex' });
  }
});

// ── Threading mode (PR C2) ──────────────────────────────────────────────────

// Both threading routes are admin-only, per route: the router as a whole runs behind requireAuth,
// but switching a shared mailbox's mode rewrites every stored row and the preview is a full-table
// aggregate. Administrative and expensive, so they carry requireAdmin the way routes/ai.js does.
router.post('/:id/threading/preview', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { mode } = req.body;
  if (!THREAD_MODES.has(mode)) return res.status(400).json({ error: 'Invalid mode' });

  const check = await query('SELECT id FROM email_accounts WHERE id = $1', [id]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  const preview = await previewRecompute(query, id, mode);
  res.json(preview);
});

router.post('/:id/threading/mode', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { mode } = req.body;
  if (!THREAD_MODES.has(mode)) return res.status(400).json({ error: 'Invalid mode' });

  const result = await query('SELECT * FROM email_accounts WHERE id = $1', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
  const row = result.rows[0];
  const from = row.thread_mode;

  // Switching to gmail needs the mailbox's provider ids in place; rfc is always allowed — it is
  // the rollback, and it also splits threads the old subject grouping merged, even for a mailbox
  // that was never in gmail mode.
  if (mode === THREAD_MODE_GMAIL) {
    if (!providerProfile(row).gmailThreadIds) {
      return res.status(409).json({ error: 'threading_switch_blocked', reason: 'not_gmail' });
    }
    const indexState = await providerThreadIndexState(query);
    if (indexState !== 'valid') {
      return res.status(409).json({ error: 'threading_switch_blocked', reason: 'index_invalid' });
    }
    const missing = await query(
      `SELECT count(*)::bigint AS missing FROM messages
        WHERE account_id = $1 AND is_deleted = false AND provider_thread_id IS NULL`,
      [id]
    );
    const missingCount = Number(missing.rows[0].missing);
    if (missingCount > 0) {
      return res.status(409).json({ error: 'threading_switch_blocked', reason: 'ids_missing', count: missingCount });
    }
  }

  await query('UPDATE email_accounts SET thread_mode = $1 WHERE id = $2', [mode, id]);
  recordAudit({
    actorUserId: req.session.userId,
    accountId: id,
    action: 'mailbox.threading_changed',
    details: { from, to: mode },
  });

  // The engine holds the mailbox row in memory, so the new mode only takes effect once it
  // reconnects — same reconnect chain the settings PATCH uses, guarded the same way (only a
  // connected-or-connectable mailbox needs it; a disabled or non-IMAP one has nothing to reconnect).
  if (row.protocol === 'imap' && row.enabled) {
    reconnectQueue(id, () =>
      imapManager.disconnectAccount(id)
        .then(() => query('SELECT * FROM email_accounts WHERE id = $1', [id]))
        .then(r => {
          if (!r.rows.length) return;
          imapManager.clearConnectCooldown(id);
          return imapManager.connectAccount(r.rows[0]);
        })
    ).catch(err => console.error(`Failed to reconnect account ${id} after threading mode change:`, err.message));
  }

  // New mail arriving during the pass already threads under the new mode; the pass rekeys what's
  // already stored. Not awaited — this can run for a while on a large mailbox.
  imapManager.startThreadRecompute(row, mode);

  res.json({ ok: true, mode });
});

export default router;
