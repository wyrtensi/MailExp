import { query, withTransaction } from '../db.js';
import { encrypt } from '../encryption.js';
import { recordAudit } from '../auditLog.js';
import { auditOf, jobBy } from '../actor.js';
import { createKeyedSerializer } from '../../utils/keyedSerializer.js';
import { SENDER_NAME_MAX, addSecondSenderName, normalizeAddress, parseSenderNames } from '../../utils/senderNames.js';
import {
  createAlias, deleteAlias, hasHeaderInjectionChars, listAliases, updateAlias,
} from '../accountAliases.js';
import { MAIL_NODE_ERRORS } from './errors.js';
import { DISK_WARN_PERCENT } from './diskWatch.js';
import {
  addMailboxFilter, deleteMailbox, deleteMailboxFilters, getDiskStatus, getMailNodeConfig, listDomains, listMailboxFilters,
  listMailboxes, parseHostName, parseLocalPart, provisionMailbox,
} from './mailcow.js';
import { cancelDeletion, requestDeletion } from './mailboxDeletion.js';
import { canCreateMailboxes, getDomainRow } from './domains.js';
import { getEopSettings } from './eopSettings.js';
import {
  confirmSeat, dropPendingSeat, getHoldDays, lockSeats, releaseSeat, reserveSeat, returnSeat, seatSupply,
} from './eopSeats.js';
import { defaultRateLimit, newMailboxRateLimit } from './nodeApply.js';import { MIRRORED_STATES, kickDomainSync } from '../tenant/tenantDomains.js';

// The node mailbox actions that routes/accounts.js, routes/mailNode.js and the panel CLI
// (src/cli/mailexpert.js) share: list, create, ask to delete and cancel. They answer a result or
// { error: code }; the code is a key of MAILBOX_ERRORS (which includes the mail node's own
// refusals, services/mailNode/errors.js). A failure of the node is a MailNodeError, as everywhere.
// actor: services/actor.js. A row is returned without its passwords and tokens.

// The reason someone gives for deleting a node mailbox: required, kept in the journal for good.
export const MAX_DELETION_REASON = 500;

export const MAILBOX_ERRORS = Object.freeze({
  ...MAIL_NODE_ERRORS,
  local_part_invalid: [400, 'The name before @ may hold letters, digits, dot, dash and underscore'],
  name_invalid: [400, 'Name and email address cannot contain control characters'],
  name_required: [400, 'The mailbox name cannot be empty'],
  sender_name_invalid: [400, 'Sender names cannot contain control characters'],
  mailbox_pending_deletion: [409, 'This mailbox is pending deletion: cancel the deletion to keep it'],
  already_deactivated: [409, 'This mailbox is deactivated already'],
  not_deactivated: [409, 'This mailbox is not deactivated'],
  deletion_pending: [409, 'This mailbox is pending deletion: cancel the deletion first'],
  deactivation_reason_required: [400, 'Say why the mailbox is deactivated'],
  deactivation_reason_too_long: [400, `The reason may be at most ${MAX_DELETION_REASON} characters`],
  mailbox_exists: [409, 'This mailbox is already in MailExpert'],
  domain_unknown: [400, 'The mail node has no such active domain'],
  mailbox_create_failed: [500, 'Failed to add account'],
  account_not_found: [404, 'Account not found'],
  not_mail_node: [400, 'Only a mailbox on the mail node waits before it is deleted: remove this one directly'],
  deletion_already_requested: [409, 'Deleting this mailbox was asked for already'],
  deletion_not_requested: [409, 'No deletion of this mailbox is pending'],
  deletion_in_progress: [409, 'The mailbox is being deleted right now'],
  confirmation_mismatch: [400, 'Type the full address of the mailbox to confirm'],
  deletion_reason_required: [400, 'Say why the mailbox is deleted'],
  deletion_reason_too_long: [400, `The reason may be at most ${MAX_DELETION_REASON} characters`],
  admin_required: [403, 'Admin access required'],
  // The panel CLI's own: an address with more than one row, and a second sender name it cannot
  // tell from the others (the panel's alias editor can).
  mailbox_ambiguous: [409, 'More than one mailbox row has this address: name it by its ID'],
  sender_name_alt_ambiguous: [409, 'The mailbox has more than one sender name for its address: change them in the panel'],
  sender_name_alt_same: [400, 'The second sender name must differ from the sender name'],
});

const SECRET_FIELDS = ['auth_pass', 'smtp_auth_pass', 'oauth_access_token', 'oauth_refresh_token', 'oauth_id_token'];

// The row without anything secret, for every answer that carries one.
export function withoutSecrets(row) {
  if (!row) return row;
  const copy = { ...row };
  for (const field of SECRET_FIELDS) delete copy[field];
  return copy;
}

// The node mailboxes MailExpert knows are all on the host the node settings name. A row on another
// host (the settings were pointed at another node since) must not be acted on through this node:
// the same address there is another mailbox.
export function onOtherMailHost(row, cfg) {
  return String(row.imap_host ?? '').trim().toLowerCase() !== cfg.mailHost;
}

// The send limit a mailbox gets when nobody set its own, for each domain of the given addresses.
export async function defaultLimits(emails) {
  const domains = [...new Set(emails.map((email) => email.toLowerCase().split('@')[1]))];
  const [eop, { rows }] = await Promise.all([
    getEopSettings(),
    query('SELECT domain, mailbox_send_limit FROM mail_node_domains WHERE domain = ANY($1::text[])', [domains]),
  ]);
  const own = new Map(rows.map((row) => [row.domain, row.mailbox_send_limit]));
  return (email) => defaultRateLimit(eop, own.get(email.toLowerCase().split('@')[1]) ?? null);
}

export const overrideOf = (row) => (row.node_rl_value ? { value: row.node_rl_value, frame: row.node_rl_frame } : null);

// The node mailboxes MailExpert knows (GET /api/mail-node/mailboxes), with quota and usage as the
// node reports them, and the send limit: the node's (rateLimit, null when the mailbox has none of
// its own), an administrator's (rateLimitOverride) and the default the mailbox has without one
// (rateLimitDefault). details: also the names and the pending deletion of each (the CLI's list).
// Answers { disk, mailboxes } or { error }; a node that cannot list its mailboxes throws.
export async function listNodeMailboxes({ details = false } = {}) {
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  const { rows } = await query(
    `SELECT id, email_address, node_rl_value, node_rl_frame${details ? ', name, sender_name, delete_after, deletion_reason, deletion_requested_by_email' : ''}
       FROM email_accounts WHERE mail_node = true ORDER BY email_address`,
  );
  const defaultFor = await defaultLimits(rows.map((row) => row.email_address));
  const onNode = new Map((await listMailboxes(cfg)).map((m) => [m.email, m]));
  // The disk is read fresh here; the scheduled check alone pings the ping URL.
  const disk = await getDiskStatus(cfg).then(
    (d) => ({ ...d, warn: d.usedPercent >= DISK_WARN_PERCENT }),
    (err) => ({ error: err.message, code: err.code || 'mail_node_failed' }),
  );
  return {
    disk,
    mailboxes: rows.map((row) => {
      const m = onNode.get(row.email_address.toLowerCase());
      return {
        accountId: row.id,
        email: row.email_address,
        onNode: !!m,
        active: m?.active ?? false,
        quotaMb: m?.quotaMb ?? null,
        usedBytes: m?.usedBytes ?? null,
        rateLimit: m?.rateLimit ?? null,
        rateLimitOverride: overrideOf(row),
        rateLimitDefault: defaultFor(row.email_address),
        ...(details ? {
          name: row.name,
          senderName: row.sender_name ?? null,
          deleteAfter: row.delete_after ?? null,
          deletionReason: row.deletion_reason ?? null,
          deletionRequestedBy: row.deletion_requested_by_email ?? null,
        } : {}),
      };
    }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A node mailbox named by its ID or its address: { account } (without secrets) or { error }:
// mailbox_not_found, not_mail_node for the ID of a mailbox that is not on the node (as the deletion
// route answers), or mailbox_ambiguous when two rows have the address (two rows may share one
// mailcow mailbox; the ID tells them apart).
export async function findNodeMailbox(ref) {
  const text = String(ref ?? '').trim();
  if (!text) return { error: 'mailbox_not_found' };
  if (UUID.test(text)) {
    const { rows: [row] } = await query('SELECT * FROM email_accounts WHERE id = $1', [text]);
    if (!row) return { error: 'mailbox_not_found' };
    if (!row.mail_node) return { error: 'not_mail_node' };
    return { account: withoutSecrets(row) };
  }
  const { rows } = await query('SELECT * FROM email_accounts WHERE mail_node = true AND lower(email_address) = ANY($1::text[]) ORDER BY created_at, id',
      [[...new Set([text.toLowerCase(), normalizeAddress(text)])]]);
  if (!rows.length) return { error: 'mailbox_not_found' };
  if (rows.length > 1) return { error: 'mailbox_ambiguous' };
  return { account: withoutSecrets(rows[0]) };
}

// --- create ---------------------------------------------------------------------------------------

// One domain mailbox creation per address at a time: two at once would both provision it, the
// second taking it over with a new password and leaving the first row with a dead one. Shared by
// every caller in this process; the CLI runs in a process of its own, where the address check
// below and the node's own refusal of a second mailbox stand in.
const domainCreateQueue = createKeyedSerializer();

// A mailbox on the mail node: the server picks the host, the ports and a password only MailExpert
// knows, so nothing the caller sends reaches the connection settings. input: { localPart, domain,
// name, senderName, senderNameAlt }. onCreated(account): what the caller does with the new row
// (the backend connects it at once; the CLI leaves it to the backend's health check, which connects
// an enabled mailbox it does not hold within 90 seconds). Answers { account, aliases, tenantPending }.
export async function createNodeMailbox(input, actor, { onCreated = null } = {}) {
  const email = `${parseLocalPart(input?.localPart)}@${parseHostName(input?.domain)}`;
  return domainCreateQueue(email, () => createNodeMailboxNow(input, actor, onCreated));
}

async function createNodeMailboxNow(input, actor, onCreated) {
  const localPart = parseLocalPart(input?.localPart);
  if (!localPart) return { error: 'local_part_invalid' };
  const domain = parseHostName(input?.domain);
  if (!domain) return { error: 'domain_invalid' };
  const email = `${localPart}@${domain}`;
  const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 200) : email;
  if (hasHeaderInjectionChars(name)) return { error: 'name_invalid' };
  // The form asks for the sender name; a caller without one sends under the mailbox name.
  const names = parseSenderNames(input);
  if (names.error) return { error: 'sender_name_invalid' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };

  const taken = await query('SELECT delete_after FROM email_accounts WHERE lower(email_address) = $1 LIMIT 1', [email]);
  if (taken.rows[0]?.delete_after) return { error: 'mailbox_pending_deletion' };
  if (taken.rows.length) return { error: 'mailbox_exists' };
  // Only a domain whose onboarding is done takes mailboxes; an unknown one (no row) never does. A
  // node creation time other than the one the row is bound to is only a warning for administrators
  // (services/mailNode/domains.js isRecreated) and does not stop it.
  const panelDomain = await getDomainRow(domain);
  if (!canCreateMailboxes(panelDomain?.state)) return { error: 'domain_not_ready' };

  const onNode = (await listDomains(cfg)).find((d) => d.domain === domain);
  if (!onNode?.active) return { error: 'domain_unknown' };
  // The send limit a mailbox of the domain gets (R-10): the domain's, else the EOP settings'.
  const rateLimit = await newMailboxRateLimit(domain);
  // An EOP seat (services/mailNode/eopSeats.js), taken under the seats lock before the node is
  // asked, so two creations never share the last one. Every failure below gives it back; the insert
  // confirms it in the same transaction as the row.
  const seat = await reserveSeat(email);
  if (seat.error) return { error: seat.error };
  const giveBack = () => dropPendingSeat(seat.assignmentId)
    .catch((e) => console.error(`EOP seat of ${email} was not given back: ${e.message}`));
  let created;
  try {
    created = await provisionMailbox(cfg, { localPart, domain, name, rateLimit });
  } catch (err) {
    await giveBack();
    throw err;
  }

  let account;
  let secondName;
  try {
    ({ account, secondName } = await withTransaction(async (client) => {
      const result = await client.query(`
        INSERT INTO email_accounts (
          added_by, name, email_address, protocol,
          imap_host, imap_port, imap_tls, imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
          auth_user, auth_pass, mail_node, sender_name
        ) VALUES ($1,$2,$3,'imap',$4,993,true,false,$4,587,'STARTTLS',$3,$5,true,$6)
        RETURNING *
      `, [actor?.userId ?? null, name, email, cfg.mailHost, encrypt(created.password), names.senderName]);
      const row = result.rows[0];
      await confirmSeat(seat.assignmentId, row.id, client);
      return { account: row, secondName: await addSecondSenderName(client, { accountId: row.id, email, senderNameAlt: names.senderNameAlt }) };
    }));
  } catch (err) {
    console.error('Domain mailbox insert error:', err);
    // Nobody else knows the new password. A mailbox made just now is deleted again, so the address
    // can be created later. One taken over stays as it is, active with its letters: disabling it
    // would make every retry refuse it as a disabled mailbox, and taking it over again on a retry
    // sets a new password anyway.
    if (!created.reused) {
      await deleteMailbox(cfg, email).catch((e) => console.error(`Could not undo ${email} on the mail node: ${e.message}`));
    }
    await giveBack();
    return { error: 'mailbox_create_failed' };
  }

  recordAudit(auditOf(actor, {
    accountId: account.id,
    action: 'mailbox.added',
    details: { protocol: 'imap', oauthProvider: null, mailNode: true, reused: created.reused, seat: seat.seat },
  }));
  if (onCreated) onCreated(account);
  // R-32 with DBEB: the tenant gets the mailbox's recipient (services/tenant/tenantDomains.js). In an
  // Authoritative domain EOP rejects the address until then, so the mailbox shows it.
  // Awaited: the CLI ends its database pool right after the answer, which would lose the job.
  if (MIRRORED_STATES.includes(panelDomain.state)) await kickDomainSync(domain, jobBy(actor));
  return {
    account: withoutSecrets(account),
    aliases: secondName ? [secondName] : [],
    tenantPending: panelDomain.state === 'authoritative',
  };
}

// --- names ----------------------------------------------------------------------------------------

// The mailbox's name and its sender names, as the panel CLI sets them: name (the mailbox's name in
// the panel), senderName (the main one, email_accounts.sender_name; '' clears it) and senderNameAlt
// (the second one, an alias with the mailbox's own address, D-16: made when there is none, renamed
// when there is one, removed with ''). A field left undefined stays. Checked as the add form checks
// them (parseSenderNames); a second name equal to the main one (whichever of them changes) is
// refused rather than dropped, which would remove the alias. Everything is written in one
// transaction. Answers { account, aliases }.
export async function setNodeMailboxNames(ref, { name, senderName, senderNameAlt } = {}) {
  const found = await findNodeMailbox(ref);
  if (found.error) return found;
  const { account } = found;
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return { error: 'name_required' };
    if (hasHeaderInjectionChars(name)) return { error: 'name_invalid' };
  }
  const names = parseSenderNames({ senderName, senderNameAlt });
  if (names.error) return { error: 'sender_name_invalid' };
  const own = (await listAliases(account.id))
    .filter((alias) => normalizeAddress(alias.email) === normalizeAddress(account.email_address));
  if (senderNameAlt !== undefined && own.length > 1) return { error: 'sender_name_alt_ambiguous' };
  const clean = (value) => (typeof value === 'string' ? value.trim().slice(0, SENDER_NAME_MAX) : '');
  // The names as they will be: the new ones, else the stored ones.
  const primary = senderName !== undefined ? clean(senderName) : (account.sender_name ?? '');
  const second = senderNameAlt !== undefined ? clean(senderNameAlt) : (own.length === 1 ? own[0].name : '');
  if (primary && second && primary.toLowerCase() === second.toLowerCase()) return { error: 'sender_name_alt_same' };
  const alt = senderNameAlt === undefined ? undefined : (second || null);
  const updates = [];
  if (name !== undefined) updates.push(['name', name.trim().slice(0, 200)]);
  if (senderName !== undefined) updates.push(['sender_name', primary || null]);
  const result = await withTransaction(async (client) => {
    if (updates.length) {
      await client.query(
        `UPDATE email_accounts SET ${updates.map(([column], i) => `${column} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [account.id, ...updates.map(([, value]) => value)],
      );
    }
    // The alias editor's own actions (services/accountAliases.js), with the mailbox's address.
    let changed = {};
    if (alt === null && own.length) changed = await deleteAlias(account.id, own[0].id, client);
    else if (alt && own.length) changed = await updateAlias(account.id, own[0].id, { ...own[0], name: alt, email: account.email_address }, client);
    else if (alt) changed = await createAlias(account.id, { name: alt, email: account.email_address }, client);
    // A refusal rolls the names back too.
    if (changed.error) throw Object.assign(new Error(changed.error), { refusal: changed.error });
    return null;
  }).catch((err) => {
    if (err?.refusal) return { error: err.refusal };
    throw err;
  });
  if (result?.error) return result;
  const { rows: [row] } = await query('SELECT * FROM email_accounts WHERE id = $1', [account.id]);
  const aliases = (await listAliases(account.id)).map(({ id, name: aliasName, email }) => ({ id, name: aliasName, email }));
  return { account: withoutSecrets(row), aliases };
}

// --- read-only filter -----------------------------------------------------------------------------

// A read-only mailbox refuses local delivery too (EOP seats design): mail from another mailbox of the
// node never passes EOP, so the missing tenant recipient does not stop it. A per-mailbox Sieve
// prefilter through the mailcow API refuses it; IMAP is untouched, so the panel still reads the
// mailbox. Research and its limits: eop-panel-requirements.md section 5.16.
export const READ_ONLY_FILTER_DESC = 'mailexpert-read-only';
const READ_ONLY_SCRIPT = 'require ["reject"];\nreject "This mailbox is closed and no longer takes mail.";\n';

export async function closeLocalDelivery(cfg, email) {
  const filters = await listMailboxFilters(cfg, email);
  if (filters.some((f) => f.desc === READ_ONLY_FILTER_DESC && f.type === 'prefilter' && f.active)) return;
  await addMailboxFilter(cfg, { email, type: 'prefilter', desc: READ_ONLY_FILTER_DESC, script: READ_ONLY_SCRIPT });
}

export async function openLocalDelivery(cfg, email) {
  const ids = (await listMailboxFilters(cfg, email)).filter((f) => f.desc === READ_ONLY_FILTER_DESC).map((f) => f.id);
  await deleteMailboxFilters(cfg, ids);
}

// Opens local delivery before a mailbox works again, runs the change, and closes it again when the
// change was refused or failed: the mailbox is still read-only then.
async function openThen(cfg, email, change) {
  await openLocalDelivery(cfg, email);
  let result;
  try {
    result = await change();
  } catch (err) {
    await closeLocalDelivery(cfg, email).catch((e) => console.error(`Read-only filter of ${email} not restored: ${e.message}`));
    throw err;
  }
  if (result.error) {
    await closeLocalDelivery(cfg, email).catch((e) => console.error(`Read-only filter of ${email} not restored: ${e.message}`));
  }
  return result;
}

// --- deletion -------------------------------------------------------------------------------------

// The reason as stored: line breaks made \n, invisible format characters (bidi controls,
// zero-width marks) removed, other control characters turned into spaces, then trimmed.
export function parseDeletionReason(value) {
  if (typeof value !== 'string') return { error: 'deletion_reason_required' };
  const reason = value
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cf}/gu, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim();
  if (!reason) return { error: 'deletion_reason_required' };
  if (reason.length > MAX_DELETION_REASON) return { error: 'deletion_reason_too_long' };
  return { reason };
}

// The tenant recipient follows the mailbox's state (EOP seats design): removed while it is read-only,
// made again when it works again, by the domain's next sync, a tenant job (tenant work never runs on
// a request's path). Awaited: the CLI ends its database pool right after the answer.
async function kickMailboxDomain(email, actor) {
  await kickDomainSync(String(email).toLowerCase().split('@')[1], jobBy(actor));
}

// Asks to delete a mail node mailbox (owner decision D-14 as changed by the EOP seats design,
// 2026-10-07): its seat goes on hold at once and it is read-only until delete_after (now plus the
// days an administrator set): the tenant recipient is removed by the domain sync queued here,
// sending is refused, the panel still reads it. Then the deletion job deletes it on the node with
// all its mail and removes it here (services/mailNode/mailboxDeletion.js); the seat ledger row
// stays. email: the
// mailbox's address as typed in the confirmation; reason: why. Nothing is asked of the node now.
// mayDelete(row): who may (the route's rule for the signed-in user); the CLI acts as an
// administrator. Answers { account }.
export async function requestMailboxDeletion({ accountId, email, reason: rawReason }, actor, { mayDelete = null } = {}) {
  const { rows } = await query('SELECT id, email_address, mail_node, imap_host FROM email_accounts WHERE id = $1', [accountId]);
  if (!rows.length) return { error: 'account_not_found' };
  if (!rows[0].mail_node) return { error: 'not_mail_node' };
  if (mayDelete && !(await mayDelete(rows[0]))) return { error: 'admin_required' };
  // Refused up front what the deletion job could never do: without the node settings, or for a
  // mailbox on another host than the node they name.
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  if (onOtherMailHost(rows[0], cfg)) return { error: 'mail_node_host_mismatch' };
  const typed = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (typed !== String(rows[0].email_address).trim().toLowerCase()) return { error: 'confirmation_mismatch' };
  const { reason, error } = parseDeletionReason(rawReason);
  if (error) return { error };
  const holdDays = await getHoldDays();
  // The node is asked first: when it cannot take the filter (a MailNodeError) nothing changes here.
  await closeLocalDelivery(cfg, rows[0].email_address);
  const result = await requestDeletion({ accountId, userId: actor?.userId ?? null, reason, holdDays });
  if (result.error) return { error: result.error };
  recordAudit(auditOf(actor, {
    accountId, action: 'mailbox.deletion_requested',
    details: { mailNode: true, deleteAfter: result.deleteAfter, days: result.days, reason, seat: result.seat },
  }));
  await kickMailboxDomain(rows[0].email_address, actor);
  const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  return { account: withoutSecrets(account) };
}

// Cancels a pending deletion: the mailbox stays as it is. Anyone signed in may cancel. Answers
// { account }.
export async function cancelMailboxDeletion({ accountId }, actor) {
  // An active mailbox takes its EOP seat back (services/mailNode/eopSeats.js).
  const { purchased } = await seatSupply();
  // A mailbox that is not deactivated works again after the cancel: its read-only filter goes first
  // (a deactivated one stays read-only and keeps it).
  const { rows: [before] } = await query('SELECT email_address, mail_node, imap_host, delete_after, deactivated_at FROM email_accounts WHERE id = $1', [accountId]);
  let result;
  if (before?.mail_node && before.delete_after && !before.deactivated_at) {
    const cfg = await getMailNodeConfig();
    if (!cfg) return { error: 'mail_node_not_configured' };
    if (onOtherMailHost(before, cfg)) return { error: 'mail_node_host_mismatch' };
    result = await openThen(cfg, before.email_address, () => cancelDeletion({ accountId, purchased }));
  } else {
    result = await cancelDeletion({ accountId, purchased });
  }
  if (result.error) return { error: result.error };
  recordAudit(auditOf(actor, {
    accountId, action: 'mailbox.deletion_cancelled',
    details: { mailNode: true, deleteAfter: result.deleteAfter, reason: result.reason, seat: result.seat },
  }));
  const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  await kickMailboxDomain(account.email_address, actor);
  return { account: withoutSecrets(account) };
}

// --- deactivation ----------------------------------------------------------------------------------

// Deactivates a mail node mailbox (EOP seats design, 2026-10-07; administrators): read-only like one
// pending deletion (no sending, no incoming mail: the tenant recipient goes with the domain sync
// queued here), its letters still read over IMAP, the mailcow mailbox untouched; its EOP seat goes on
// hold. reason: why, required, kept on the row and in the journal. Answers { account }.
export async function deactivateNodeMailbox({ accountId, reason: rawReason }, actor) {
  const { rows: [row] } = await query('SELECT id, email_address, mail_node, imap_host FROM email_accounts WHERE id = $1', [accountId]);
  if (!row) return { error: 'account_not_found' };
  if (!row.mail_node) return { error: 'not_mail_node' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  if (onOtherMailHost(row, cfg)) return { error: 'mail_node_host_mismatch' };
  const parsed = parseDeletionReason(rawReason);
  if (parsed.error) return { error: parsed.error === 'deletion_reason_required' ? 'deactivation_reason_required' : 'deactivation_reason_too_long' };
  const holdDays = await getHoldDays();
  // The node is asked first: when it cannot take the filter (a MailNodeError) nothing changes here.
  // A mailbox read-only already (deactivated or pending deletion) keeps its filter whatever the
  // transaction answers, so there is nothing to undo.
  await closeLocalDelivery(cfg, row.email_address);
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`
      UPDATE email_accounts
         SET deactivated_at = NOW(), deactivated_by = $2, deactivation_reason = $3,
             deactivated_by_email = (SELECT COALESCE(NULLIF(email, ''), username) FROM users WHERE id = $2)
       WHERE id = $1 AND deactivated_at IS NULL AND delete_after IS NULL
      RETURNING id`, [accountId, actor?.userId ?? null, parsed.reason]);
    if (!rows.length) {
      const { rows: [now] } = await client.query('SELECT deactivated_at, delete_after FROM email_accounts WHERE id = $1', [accountId]);
      return { error: now?.deactivated_at ? 'already_deactivated' : 'mailbox_pending_deletion' };
    }
    return { seat: await releaseSeat(accountId, 'deactivated', holdDays, client) };
  });
  if (result.error) return result;
  recordAudit(auditOf(actor, {
    accountId, action: 'mailbox.deactivated',
    details: { mailNode: true, reason: parsed.reason, seat: result.seat?.seat ?? null, freeFrom: result.seat?.freeFrom ?? null },
  }));
  await kickMailboxDomain(row.email_address, actor);
  const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  return { account: withoutSecrets(account) };
}

// Activates a deactivated mailbox (administrators): it takes its own seat back while it is on hold,
// else a free one (refused at 0), and works as before; the tenant recipient comes back with the
// domain sync. A mailbox pending deletion is activated by cancelling the deletion first.
export async function activateNodeMailbox({ accountId }, actor) {
  const { purchased } = await seatSupply();
  // Its read-only filter goes first, when it is deactivated and not pending deletion (the only case
  // that can succeed); an error below puts it back.
  const { rows: [before] } = await query('SELECT email_address, mail_node, imap_host, delete_after, deactivated_at FROM email_accounts WHERE id = $1', [accountId]);
  let cfg = null;
  if (before?.mail_node && before.deactivated_at && !before.delete_after) {
    cfg = await getMailNodeConfig();
    if (!cfg) return { error: 'mail_node_not_configured' };
    if (onOtherMailHost(before, cfg)) return { error: 'mail_node_host_mismatch' };
  }
  const activate = () => withTransaction(async (client) => {
    await lockSeats(client);
    const { rows: [row] } = await client.query(
      'SELECT email_address, mail_node, deactivated_at, delete_after FROM email_accounts WHERE id = $1 FOR UPDATE', [accountId],
    );
    if (!row) return { error: 'account_not_found' };
    if (!row.mail_node) return { error: 'not_mail_node' };
    if (!row.deactivated_at) return { error: 'not_deactivated' };
    if (row.delete_after) return { error: 'deletion_pending' };
    const seat = await returnSeat({ accountId, email: row.email_address, purchased }, client);
    if (seat.error) return { error: seat.error };
    await client.query(`
      UPDATE email_accounts SET deactivated_at = NULL, deactivated_by = NULL, deactivated_by_email = NULL, deactivation_reason = NULL
       WHERE id = $1`, [accountId]);
    return { seat, email: row.email_address };
  });
  const result = cfg ? await openThen(cfg, before.email_address, activate) : await activate();
  if (result.error) return result;
  recordAudit(auditOf(actor, {
    accountId, action: 'mailbox.activated', details: { mailNode: true, seat: result.seat.seat, reclaimed: result.seat.reclaimed },
  }));
  await kickMailboxDomain(result.email, actor);
  const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  return { account: withoutSecrets(account) };
}
