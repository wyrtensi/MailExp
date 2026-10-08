import { query } from '../db.js';
import { encrypt } from '../encryption.js';
import { sanitizeSignature } from '../emailSanitizer.js';
import { validateHost } from '../hostValidation.js';
import { createKeyedSerializer } from '../../utils/keyedSerializer.js';

// Where a mailbox connects and what it signs in with, shared by the accounts API (routes/
// accounts.js, POST / and PUT /:id) and the panel CLI (services/accounts/manualAccounts.js): the
// fields, the host and port checks of the admin's connection policy, how a value is stored, and
// the reconnect a change asks for.

export const ALLOWED_IMAP_PORTS = new Set([143, 993]);
export const ALLOWED_SMTP_PORTS = new Set([465, 587]);

export function validatePort(port, allowed) {
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

// Server and credential settings: where the mailbox connects and what it signs in with. Their
// change is the audit log's (by name only) and an administrator's alone, since a host, a port or a
// TLS switch decides where the stored password or OAuth token is sent.
export const CONNECTION_FIELDS = [
  'imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify', 'smtp_host', 'smtp_port', 'smtp_tls',
  'auth_user', 'auth_pass', 'smtp_auth_user', 'smtp_auth_pass',
];
const PASSWORD_FIELDS = new Set(['auth_pass', 'smtp_auth_pass']);

// The connection fields the updates change. A form resends every server field on each save, so a
// field counts only when its value differs.
export function changedConnectionFields(stored, updates) {
  return CONNECTION_FIELDS.filter((key) => {
    if (!(key in updates)) return false;
    // Passwords are stored encrypted and never compared: a new one or a cleared one is a change.
    if (PASSWORD_FIELDS.has(key)) return !!updates[key] || !!stored[key];
    return String(stored[key] ?? '') !== String(updates[key] ?? '');
  });
}

// The servers of a new mailbox against the policy: the error text the API answers, or null. A
// port is checked only with its host.
export async function newServersError({ imap_host, imap_port, smtp_host, smtp_port }, policy) {
  if (imap_host) {
    const err = (await validateHost(imap_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(imap_port, ALLOWED_IMAP_PORTS));
    if (err) return `IMAP: ${err}`;
  }
  if (smtp_host) {
    const err = (await validateHost(smtp_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(smtp_port, ALLOWED_SMTP_PORTS));
    if (err) return `SMTP: ${err}`;
  }
  return null;
}

// The server fields a change names against the policy: the error text the API answers, or null.
export async function changedServersError(updates, policy) {
  if ('imap_host' in updates && updates.imap_host) {
    const err = await validateHost(updates.imap_host, { allowPrivate: policy.allowPrivateHosts });
    if (err) return `IMAP: ${err}`;
  }
  if ('imap_port' in updates && updates.imap_port !== undefined && updates.imap_port !== null) {
    if (!policy.allowNonstandardPorts) {
      const err = validatePort(updates.imap_port, ALLOWED_IMAP_PORTS);
      if (err) return `IMAP: ${err}`;
    }
  }
  if ('smtp_host' in updates && updates.smtp_host) {
    const err = await validateHost(updates.smtp_host, { allowPrivate: policy.allowPrivateHosts });
    if (err) return `SMTP: ${err}`;
  }
  if ('smtp_port' in updates && updates.smtp_port !== undefined && updates.smtp_port !== null) {
    if (!policy.allowNonstandardPorts) {
      const err = validatePort(updates.smtp_port, ALLOWED_SMTP_PORTS);
      if (err) return `SMTP: ${err}`;
    }
  }
  return null;
}

// IMAP over TLS is implied by the port: 993 (or x993).
export const impliedImapTls = (port) => Number(port) % 1000 === 993;

// A settings column's value as it is stored: passwords encrypted, an empty SMTP login or password
// as null, the signature sanitized.
export function storedColumnValue(key, value) {
  if ((key === 'auth_pass' || key === 'smtp_auth_pass') && value) return encrypt(value);
  if (key === 'smtp_auth_user' || key === 'smtp_auth_pass') return value || null;
  if (key === 'signature') return sanitizeSignature(value) || null;
  return value;
}

// The fields whose change makes a running mailbox reconnect.
export const RECONNECT_FIELDS = Object.freeze([
  'enabled', 'auth_user', 'auth_pass', 'imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify',
]);

// Serializes an account's reconnect triggers so a rapid settings change (e.g. a gtd_enabled
// double-toggle) can't fire two overlapping disconnect→connect chains — connectAccount's
// in-progress guard would drop the second and leave the GTD sync tick armed inconsistently with
// the final DB value. Queued per account id, in the backend's process.
export const reconnectQueue = createKeyedSerializer();

// Disconnects the mailbox and connects it again from its stored row, through the queue above. New
// credentials or a new host may cure an auth failure or refusal, so the old cooldown is cleared.
// imapManager is the backend's (routes, the admin_effects job). onlyActive: connect only an enabled
// IMAP mailbox (the job, which runs later than the change that asked for it).
export function reconnectAccount(imapManager, id, { onlyActive = false } = {}) {
  return reconnectQueue(id, () => imapManager.disconnectAccount(id)
    .then(() => query('SELECT * FROM email_accounts WHERE id = $1', [id]))
    .then((r) => {
      if (!r.rows.length) return undefined;
      if (onlyActive && (r.rows[0].protocol !== 'imap' || r.rows[0].enabled === false)) return undefined;
      imapManager.clearConnectCooldown(id);
      return imapManager.connectAccount(r.rows[0]);
    }));
}
