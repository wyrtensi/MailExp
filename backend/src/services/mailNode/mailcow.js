import { randomBytes } from 'node:crypto';
import { query } from '../db.js';
import { encrypt, decrypt } from '../encryption.js';
import { safeFetch } from '../safeFetch.js';

// The mail node: a mailcow server that MailExpert creates and deletes mailboxes on.
// MailExpert stores only its host name (<MAIL_HOST>), never an IP: IMAP and SMTP of every mailbox
// and the API at https://<MAIL_HOST>/api/v1 all go by that name, so moving the node is a DNS change.

export const MAIL_NODE_PROVIDER = 'mail_node';
// Quota of a new mailbox in MiB (mailcow's unit). A quota only caps a mailbox, it reserves no disk.
export const DEFAULT_QUOTA_MB = 5120;
// Highest quota an administrator can give one mailbox; also the domain's per-mailbox maximum.
export const MAX_QUOTA_MB = 102400;
export const DEFAULT_DOMAIN_MAILBOXES = 500;
// Days a mail node mailbox keeps working after someone asked to delete it, before the deletion
// job deletes it for good (services/mailNode/mailboxDeletion.js). An administrator sets it.
export const DEFAULT_DELETE_AFTER_DAYS = 5;
export const MAX_DELETE_AFTER_DAYS = 90;
export const MAX_DOMAIN_MAILBOXES = 10000;
const REQUEST_TIMEOUT_MS = 15000;

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

// status: the HTTP status the panel answers with; a failure of the node itself is 502.
export class MailNodeError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'MailNodeError';
    this.code = code;
    this.status = status;
  }
}

// A lowercase DNS name with at least one dot; null for anything else.
export function parseHostName(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  return HOST_RE.test(host) ? host : null;
}

// The part before @: letters, digits, dot, dash, underscore, not starting or ending with a symbol.
export function parseLocalPart(value) {
  if (typeof value !== 'string') return null;
  const local = value.trim().toLowerCase();
  return LOCAL_PART_RE.test(local) && !local.includes('..') ? local : null;
}

export function parseWholeNumber(value, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Random, never shown to anyone. The fixed tail satisfies mailcow password policies that ask for
// upper and lower case, a digit and a symbol.
export function generateMailboxPassword() {
  return `${randomBytes(24).toString('base64url')}aA1!`;
}

// The stored node settings with the API key decrypted, or null until an administrator saves them.
export async function getMailNodeConfig() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [MAIL_NODE_PROVIDER]);
  const cfg = rows[0]?.config;
  if (!cfg?.mailHost || !cfg?.apiKey) return null;
  return {
    mailHost: cfg.mailHost,
    apiKey: decrypt(cfg.apiKey),
    quotaMb: parseWholeNumber(cfg.quotaMb, 1, MAX_QUOTA_MB) ?? DEFAULT_QUOTA_MB,
    diskPingUrl: cfg.diskPingUrl || null,
    deleteAfterDays: storedDeleteAfterDays(cfg),
  };
}

function storedDeleteAfterDays(cfg) {
  return parseWholeNumber(cfg?.deleteAfterDays, 1, MAX_DELETE_AFTER_DAYS) ?? DEFAULT_DELETE_AFTER_DAYS;
}

// The days a mailbox asked to be deleted keeps working, also before the node is set up.
export async function getDeleteAfterDays() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [MAIL_NODE_PROVIDER]);
  return storedDeleteAfterDays(rows[0]?.config);
}

// An https URL for the disk check pings (a Healthchecks-style service); null for anything else.
export function parsePingUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

// Merges into the stored settings: a field this form does not send (a later stage's) survives a
// save, while each field it sends, a cleared ping URL (null) too, replaces the stored one.
export async function saveMailNodeConfig({ mailHost, apiKey, quotaMb, diskPingUrl = null, deleteAfterDays }) {
  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = integration_config.config || EXCLUDED.config, updated_at = NOW()
  `, [MAIL_NODE_PROVIDER, {
    mailHost, apiKey: encrypt(apiKey), quotaMb, diskPingUrl, ...(deleteAfterDays ? { deleteAfterDays } : {}),
  }]);
}

const messageOf = (item) => (Array.isArray(item.msg) ? item.msg.join(' ') : String(item.msg ?? ''));

// mailcow answers 200 even when it refuses: a write returns [{ type: 'success' | 'warning' |
// 'danger' | 'error', msg }], so the body decides. The message names the refusal (e.g.
// 'object_exists').
function refusal(body) {
  const items = Array.isArray(body) ? body : [body];
  const failed = items.find((item) => item && typeof item === 'object' && item.type && item.type !== 'success');
  if (!failed) return null;
  return messageOf(failed) || 'refused';
}

// judge: false leaves the answer of a POST to the caller (delete/mailbox mixes warnings with its
// success).
async function request(cfg, method, path, body, { judge = true } = {}) {
  let res;
  try {
    // allowPrivate: on a one-server install <MAIL_HOST> resolves to this host's own address.
    res = await safeFetch(`https://${cfg.mailHost}/api/v1/${path}`, {
      method,
      headers: {
        'X-API-Key': cfg.apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { allowPrivate: true, requireHttps: true });
  } catch (err) {
    throw new MailNodeError('mail_node_unreachable', `The mail node is unreachable (${err?.code || err?.name || 'error'})`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new MailNodeError('mail_node_auth', 'The mail node refused the API key');
  }
  if (!res.ok) throw new MailNodeError('mail_node_failed', `The mail node answered HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new MailNodeError('mail_node_failed', 'The mail node did not answer with JSON');
  }
  const refused = method === 'POST' && judge ? refusal(data) : null;
  if (refused) throw new MailNodeError('mail_node_refused', `The mail node refused: ${refused}`);
  return data;
}

// get/<type>/all answers {} when there is nothing and an array otherwise.
function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Object.keys(data).length) return [data];
  return [];
}

// created: when mailcow made the domain, as it prints it ("2026-09-30 12:00:00"), or null from a
// mailcow that does not send it. A domain deleted and made again by hand gets a new one, so the
// panel tells it apart from the domain it onboarded (services/mailNode/domains.js).
export async function listDomains(cfg) {
  return asList(await request(cfg, 'GET', 'get/domain/all')).map((d) => ({
    domain: String(d.domain_name ?? d.domain ?? '').toLowerCase(),
    active: Number(d.active_int ?? d.active) === 1,
    maxMailboxes: Number(d.max_num_mboxes_for_domain ?? d.mailboxes ?? 0),
    mailboxes: Number(d.mboxes_in_domain ?? 0),
    created: d.created ? String(d.created) : null,
  })).filter((d) => d.domain);
}

// Every mailbox the domain may hold counts at the per-mailbox maximum in the domain total, so
// mailcow's "sum of mailbox quotas <= domain quota" rule never refuses a mailbox or a quota raise.
// The total is only a number: like any quota it reserves no disk.
export async function addDomain(cfg, { domain, mailboxes }) {
  await request(cfg, 'POST', 'add/domain', {
    domain,
    description: 'Added by MailExpert',
    active: 1,
    mailboxes,
    aliases: 400,
    defquota: cfg.quotaMb,
    maxquota: MAX_QUOTA_MB,
    quota: mailboxes * MAX_QUOTA_MB,
    backupmx: 0,
    relay_all_recipients: 0,
  });
}

function mailboxInfo(m) {
  return {
    email: String(m.username ?? '').toLowerCase(),
    active: Number(m.active_int ?? m.active) === 1,
    quotaMb: Math.round(Number(m.quota ?? 0) / 1048576),
    usedBytes: Number(m.quota_used ?? 0),
  };
}

// One mailbox with what decides whether it may sign in, besides its password:
// - state: mailcow's active, 1 (active), 0 (disabled) or 2 (receives mail, login disallowed);
// - authsource: 'mailcow', or an external identity provider (then mailcow never changes the password);
// - imapAccess and forcePwUpdate: from its attributes (mailcow sends them as "1" / "0");
// - domain: the mailbox's domain, whose own active flag the mailbox listing does not carry.
// A field an older mailcow does not send reads as the permissive default.
export async function getMailbox(cfg, email) {
  const data = await request(cfg, 'GET', `get/mailbox/${encodeURIComponent(email)}`);
  const item = Array.isArray(data) ? data[0] : data;
  if (!item || !item.username) return null;
  const info = mailboxInfo(item);
  const attributes = item.attributes && typeof item.attributes === 'object' ? item.attributes : {};
  return {
    ...info,
    state: Number(item.active_int ?? item.active),
    authsource: String(item.authsource ?? 'mailcow').toLowerCase(),
    imapAccess: attributes.imap_access === undefined ? true : String(attributes.imap_access) === '1',
    forcePwUpdate: String(attributes.force_pw_update ?? '0') === '1',
    domain: String(item.domain ?? info.email.split('@')[1] ?? '').toLowerCase(),
  };
}

export async function listMailboxes(cfg) {
  return asList(await request(cfg, 'GET', 'get/mailbox/all')).filter((m) => m.username).map(mailboxInfo);
}

function editMailbox(cfg, email, attr) {
  return request(cfg, 'POST', 'edit/mailbox', { items: [email], attr });
}

// Creates the mailbox, or takes over an active one made by hand in mailcow: it is enabled with a
// new password only MailExpert knows and keeps its letters. A mailbox deleted in MailExpert is gone
// from the node (deleteMailbox), so creating the address again makes a new, empty one. A disabled
// mailbox on the node is refused instead of taken over: an older MailExpert only disabled the
// mailboxes it deleted, so its old letters would come back with it, and one disabled by hand may
// hold letters nobody here owns. An administrator deletes it in mailcow, or enables it there to
// have it taken over.
export async function provisionMailbox(cfg, { localPart, domain, name }) {
  const email = `${localPart}@${domain}`;
  const password = generateMailboxPassword();
  const existing = await getMailbox(cfg, email);
  if (existing?.state === 0) {
    throw new MailNodeError('mailbox_disabled_on_node', 'The mail node has a disabled mailbox with this address: delete it in mailcow first', 409);
  }
  if (existing) {
    await editMailbox(cfg, email, { active: 1, password, password2: password, force_pw_update: 0 });
  } else {
    await request(cfg, 'POST', 'add/mailbox', {
      local_part: localPart, domain, name, password, password2: password,
      quota: cfg.quotaMb, active: 1, force_pw_update: 0,
    });
  }
  return { email, password, reused: !!existing };
}

// A new random password for a mailbox that already exists, and nothing else: the attributes sent
// hold only the password, so mailcow keeps the mailbox's active state, quota and every other
// setting (provisionMailbox would enable a mailbox an administrator disabled). Returns the password:
// the one passed in (the restore stores it before asking the node), or a new random one.
export async function setMailboxPassword(cfg, email, password = generateMailboxPassword()) {
  await editMailbox(cfg, email, { password, password2: password });
  return password;
}

// The node's aliases that deliver to the mailbox, which delete/mailbox changes too: an alias whose
// only target is the mailbox is deleted with it (onlyTarget), the mailbox is taken out of the
// targets of any other. Sorted by address.
export async function listAliasesTo(cfg, email) {
  const target = String(email).toLowerCase();
  return asList(await request(cfg, 'GET', 'get/alias/all'))
    .map((a) => ({
      address: String(a.address ?? '').toLowerCase(),
      targets: String(a.goto ?? '').toLowerCase().split(',').map((t) => t.trim()).filter(Boolean),
    }))
    .filter((a) => a.address && a.address !== target && a.targets.includes(target))
    .map((a) => ({ address: a.address, onlyTarget: a.targets.length === 1 }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

// Deletes the mailbox on the node with its mail. delete/mailbox takes a JSON array of addresses;
// mailcow drops the mailbox and everything tied to it from its database (aliases that deliver only
// to it, its place in other aliases' targets, its send-as rights, sync jobs and filters) and moves
// the maildir to /var/vmail/_garbage, where it is purged once older than MAILDIR_GC_TIME minutes.
// It answers
// [success] once the mailbox is gone, with a warning before it when the maildir could not be moved
// (the mailbox is deleted all the same and its mail stays where it was, so a mailbox made again
// at the address would show it), and [danger access_denied] for an address it has no mailbox for.
// Returns the warnings; throws a refusal when no success came back.
export async function deleteMailbox(cfg, email) {
  const items = asList(await request(cfg, 'POST', 'delete/mailbox', [email], { judge: false }))
    .filter((item) => item && typeof item === 'object');
  if (!items.some((item) => item.type === 'success')) {
    throw new MailNodeError('mail_node_refused', `The mail node refused: ${refusal(items) ?? 'refused'}`);
  }
  return { warnings: items.filter((item) => item.type === 'warning').map((item) => messageOf(item) || 'warning') };
}

export async function setMailboxQuota(cfg, email, quotaMb) {
  await editMailbox(cfg, email, { quota: quotaMb });
}

// The disk that holds the mail: mailcow reports sizes as df prints them ("41G") and the share
// used as "28%".
export async function getDiskStatus(cfg) {
  const data = await request(cfg, 'GET', 'get/status/vmail');
  const usedPercent = Number.parseInt(String(data?.used_percent ?? ''), 10);
  if (!Number.isFinite(usedPercent)) throw new MailNodeError('mail_node_failed', 'The mail node did not report its disk');
  return { usedPercent, used: String(data.used ?? ''), total: String(data.total ?? '') };
}
