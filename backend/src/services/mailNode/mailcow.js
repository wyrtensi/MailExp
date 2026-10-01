import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { query } from '../db.js';
import { encrypt, decrypt } from '../encryption.js';
import { safeFetch } from '../safeFetch.js';
import { joinTxtChunks } from './txtRecord.js';

// The mail node: a mailcow server that MailExpert creates and deletes mailboxes on.
// MailExpert connects to it only by its host name (<MAIL_HOST>), never an IP: IMAP and SMTP of every
// mailbox and the API at https://<MAIL_HOST>/api/v1 all go by that name, so moving the node is a DNS
// change. The node's address in the EOP settings (nodeIp) only serves the DNS check.

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
// Addresses of the panel the node's fail2ban must never ban (services/mailNode/nodeApply.js).
export const MAX_PANEL_IPS = 10;
const REQUEST_TIMEOUT_MS = 15000;
// Listing a domain's mailboxes with their send limits: mailcow reads each mailbox's details one by
// one, which takes long on a domain with hundreds of mailboxes.
const MAILBOX_LIST_TIMEOUT_MS = 60000;

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

// status: the HTTP status the panel answers with; a failure of the node itself is 502. timeout: the
// node did not answer in time (code mail_node_unreachable all the same: a write may have been done).
export class MailNodeError extends Error {
  constructor(code, message, status = 502, { timeout = false } = {}) {
    super(message);
    this.name = 'MailNodeError';
    this.code = code;
    this.status = status;
    this.timeout = timeout;
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

// One address or network the panel connects to the node from, as mailcow's fail2ban takes it: an
// IPv4 or IPv6 address, or one with a prefix (/24 to /32 for IPv4, /48 to /128 for IPv6, so a
// mistake cannot exempt the whole internet). Lowercased; null for anything else.
export function parseNetwork(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const [address, prefix, extra] = text.split('/');
  if (extra !== undefined) return null;
  const family = isIP(address);
  if (!family) return null;
  if (prefix === undefined) return address;
  if (!/^\d{1,3}$/.test(prefix)) return null;
  const bits = Number(prefix);
  const [min, max] = family === 4 ? [24, 32] : [48, 128];
  return bits >= min && bits <= max ? `${address}/${bits}` : null;
}

// The panel's addresses as an administrator types them (separated by commas, spaces or new lines,
// or as an array): { networks } without repeats, or { error } with the refusal code.
export function parseNetworkList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  const networks = [];
  for (const part of parts) {
    if (typeof part === 'string' && !part.trim()) continue;
    const network = parseNetwork(part);
    if (!network) return { error: 'panel_ips_invalid' };
    if (!networks.includes(network)) networks.push(network);
  }
  return networks.length > MAX_PANEL_IPS ? { error: 'panel_ips_invalid' } : { networks };
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
    panelIps: parseNetworkList(cfg.panelIps ?? []).networks ?? [],
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
export async function saveMailNodeConfig({ mailHost, apiKey, quotaMb, diskPingUrl = null, deleteAfterDays, panelIps }) {
  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = integration_config.config || EXCLUDED.config, updated_at = NOW()
  `, [MAIL_NODE_PROVIDER, {
    mailHost, apiKey: encrypt(apiKey), quotaMb, diskPingUrl, ...(deleteAfterDays ? { deleteAfterDays } : {}),
    ...(panelIps ? { panelIps } : {}),
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
async function request(cfg, method, path, body, { judge = true, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
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
      signal: AbortSignal.timeout(timeoutMs),
    }, { allowPrivate: true, requireHttps: true });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError';
    throw new MailNodeError('mail_node_unreachable', `The mail node is unreachable (${err?.code || err?.name || 'error'})`, 502, { timeout });
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
// dkimKeySize: the DKIM key mailcow makes with the domain (selector "dkim"), or 0 for none (the
// tenant signs, services/mailNode/nodeApply.js). Left out, mailcow's domain template decides.
export async function addDomain(cfg, { domain, mailboxes, dkimKeySize }) {
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
    ...(dkimKeySize === undefined ? {} : { key_size: dkimKeySize, dkim_selector: DKIM_SELECTOR }),
  });
}

// The node's own record of one domain: the relayhost it sends through (mailcow's id, 0 for none).
// Null when the node has no such domain.
export async function getDomain(cfg, domain) {
  const data = await request(cfg, 'GET', `get/domain/${encodeURIComponent(domain)}`);
  const item = Array.isArray(data) ? data[0] : data;
  if (!item || !(item.domain_name ?? item.domain)) return null;
  return { domain: String(item.domain_name ?? item.domain).toLowerCase(), relayhost: Number(item.relayhost ?? 0) || 0 };
}

// edit/domain takes the attributes it is given and keeps every other one as it is.
export async function setDomainRelayhost(cfg, domain, relayhostId) {
  await request(cfg, 'POST', 'edit/domain', { items: [domain], attr: { relayhost: relayhostId } });
}

// mailcow's TLS Policy Map (get/tls-policy-map/all): the TLS a next hop gets, keyed by the next hop
// exactly as Postfix spells it. mailcow keeps the policy as typed; the panel compares it lowercased.
export async function listTlsPolicies(cfg) {
  return asList(await request(cfg, 'GET', 'get/tls-policy-map/all')).map((p) => ({
    id: Number(p.id),
    dest: String(p.dest ?? '').toLowerCase(),
    policy: String(p.policy ?? '').toLowerCase(),
    parameters: String(p.parameters ?? ''),
    active: Number(p.active) === 1,
  })).filter((p) => p.dest && Number.isInteger(p.id));
}

// add/tls-policy-map makes a disabled entry unless active is sent.
export async function addTlsPolicy(cfg, { dest, policy, parameters }) {
  await request(cfg, 'POST', 'add/tls-policy-map', { dest, policy, parameters, active: 1 });
}

export async function editTlsPolicy(cfg, id, { dest, policy, parameters }) {
  await request(cfg, 'POST', 'edit/tls-policy-map', { items: [id], attr: { dest, policy, parameters, active: 1 } });
}

export async function deleteTlsPolicy(cfg, id) {
  await request(cfg, 'POST', 'delete/tls-policy-map', [id]);
}

// mailcow's relayhosts ("sender-dependent transports"), without their passwords: get/relayhost/all
// sends them in clear text, and the panel never keeps, shows or logs them. hasLogin: the entry
// authenticates with SASL (a username is set).
// usedByDomains, usedByMailboxes: what sends through the entry (mailcow lists them comma-separated).
const usedBy = (value) => String(value ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
export async function listRelayhosts(cfg) {
  return asList(await request(cfg, 'GET', 'get/relayhost/all')).map((r) => ({
    id: Number(r.id),
    hostname: String(r.hostname ?? '').trim().toLowerCase(),
    hasLogin: String(r.username ?? '').trim() !== '',
    active: Number(r.active) === 1,
    usedByDomains: usedBy(r.used_by_domains),
    usedByMailboxes: usedBy(r.used_by_mailboxes),
  })).filter((r) => r.hostname && Number.isInteger(r.id));
}

// delete/relayhost also sets every domain that used it back to no relayhost: the panel deletes only
// an entry nothing uses (services/mailNode/nodeApply.js).
export async function deleteRelayhost(cfg, id) {
  await request(cfg, 'POST', 'delete/relayhost', [id]);
}

// Without a username mailcow turns no SASL on for the entry; mailcow sets it active itself.
export async function addRelayhost(cfg, hostname) {
  await request(cfg, 'POST', 'add/relayhost', { hostname });
}

export async function enableRelayhost(cfg, id) {
  await request(cfg, 'POST', 'edit/relayhost', { items: [id], attr: { active: 1 } });
}

// DKIM: mailcow keeps one key and one selector per domain. The selector the panel makes keys with.
export const DKIM_SELECTOR = 'dkim';
export const DKIM_KEY_SIZE = 2048;

// The TXT value of a DKIM record as one string (SPLIT_DKIM_255 pieces joined).
export { joinTxtChunks };

// The domain's DKIM key as DNS must publish it: { selector, name, txt, length }, or null when
// mailcow has no key for it. The private key is never read.
export async function getDkim(cfg, domain) {
  const data = await request(cfg, 'GET', `get/dkim/${encodeURIComponent(domain)}`);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.dkim_txt) return null;
  const selector = String(data.dkim_selector || DKIM_SELECTOR);
  return {
    selector,
    name: `${selector}._domainkey.${domain}`,
    txt: joinTxtChunks(data.dkim_txt),
    length: data.length ? String(data.length) : null,
  };
}

export async function addDkim(cfg, domain) {
  await request(cfg, 'POST', 'add/dkim', { domains: domain, dkim_selector: DKIM_SELECTOR, key_size: DKIM_KEY_SIZE });
}

export async function deleteDkim(cfg, domain) {
  await request(cfg, 'POST', 'delete/dkim', [domain]);
}

export const RATE_LIMIT_FRAMES = Object.freeze(['s', 'm', 'h', 'd']);

// Sets one send limit on several mailboxes: edit/rl-mbox answers one entry per mailbox and goes on
// past a refusal, so the answer is read per mailbox. Returns { done, failed } (addresses), with the
// node's words for the refusals in `reason`.
export async function setMailboxRateLimit(cfg, emails, { value, frame }) {
  const items = asList(await request(cfg, 'POST', 'edit/rl-mbox', {
    items: emails, attr: { rl_value: String(value), rl_frame: frame },
  }, { judge: false })).filter((item) => item && typeof item === 'object');
  const saved = new Set(items
    .filter((item) => item.type === 'success' && Array.isArray(item.msg))
    .map((item) => String(item.msg[1] ?? '').toLowerCase()));
  const done = emails.filter((email) => saved.has(email.toLowerCase()));
  const failed = emails.filter((email) => !saved.has(email.toLowerCase()));
  return { done, failed, reason: failed.length ? (refusal(items) ?? 'refused') : null };
}

// The global Sieve filter mailcow runs before every mailbox's own ("prefilter", the file
// global_sieve_before), as text: '' when it is empty.
export async function getPrefilter(cfg) {
  const data = await request(cfg, 'GET', 'get/global_filters/prefilter');
  return typeof data === 'string' ? data : '';
}

// Writes the whole prefilter and restarts dovecot-mailcow, which drops every IMAP session. mailcow
// writes the file first: a failed restart comes back as a warning next to the success, and the
// script takes effect at Dovecot's next start. Returns { restarted }; throws a refusal (an invalid
// script, an unwritable file) when no success came back.
export async function setPrefilter(cfg, script) {
  const items = asList(await request(cfg, 'POST', 'add/global-filter', {
    filter_type: 'prefilter', script_data: script,
  }, { judge: false })).filter((item) => item && typeof item === 'object');
  if (!items.some((item) => item.type === 'success' && messageOf(item) === 'global_filter_written')) {
    throw new MailNodeError('mail_node_refused', `The mail node refused: ${refusal(items) ?? 'refused'}`);
  }
  return { restarted: !items.some((item) => item.type !== 'success') };
}

// The networks fail2ban on the node never bans (get/fail2ban "whitelist", one per line).
export async function getFail2banWhitelist(cfg) {
  const data = await request(cfg, 'GET', 'get/fail2ban');
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new MailNodeError('mail_node_failed', 'The mail node did not report its fail2ban settings');
  }
  return String(data.whitelist ?? '').split(/[\s,;]+/).map((n) => n.trim().toLowerCase()).filter(Boolean);
}

// Adds networks to the whitelist and changes nothing else. edit/fail2ban with action "whitelist"
// adds each network it is given (and lifts a ban on it); the plain edit/fail2ban instead replaces the
// whole whitelist and resets ban_time_increment and manage_external when they are left out.
export async function whitelistFail2ban(cfg, networks) {
  await request(cfg, 'POST', 'edit/fail2ban', { items: networks, attr: { action: 'whitelist' } });
}

// Takes networks out of the whitelist. mailcow has no action for that (its actions add to the
// whitelist or the blacklist, or unban), so this is the plain edit/fail2ban with every field read
// back from get/fail2ban first: it replaces the whole whitelist and blacklist and resets
// ban_time_increment and manage_external unless they are sent. Returns the networks removed.
export async function unwhitelistFail2ban(cfg, networks) {
  const now = await request(cfg, 'GET', 'get/fail2ban');
  if (!now || typeof now !== 'object' || Array.isArray(now)) {
    throw new MailNodeError('mail_node_failed', 'The mail node did not report its fail2ban settings');
  }
  const drop = new Set(networks.map((n) => n.toLowerCase()));
  const listed = String(now.whitelist ?? '').split(/[\s,;]+/).filter(Boolean);
  const kept = listed.filter((n) => !drop.has(n.toLowerCase()));
  if (kept.length === listed.length) return [];
  await request(cfg, 'POST', 'edit/fail2ban', {
    items: ['none'],
    attr: {
      ban_time: now.ban_time, max_ban_time: now.max_ban_time, max_attempts: now.max_attempts,
      retry_window: now.retry_window, netban_ipv4: now.netban_ipv4, netban_ipv6: now.netban_ipv6,
      ban_time_increment: now.ban_time_increment === true || String(now.ban_time_increment) === '1' ? '1' : '0',
      manage_external: Number(now.manage_external) > 0 ? 1 : 0,
      whitelist: kept.join('\n'),
      blacklist: String(now.blacklist ?? ''),
    },
  });
  return listed.filter((n) => drop.has(n.toLowerCase()));
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

// The mailbox's own send limit as mailcow keeps it for its SASL login, { value, frame }, or null.
// A limit mailcow reports from the domain (rl_scope 'domain') is one bucket the whole domain shares,
// not the mailbox's.
function mailboxRateLimit(m) {
  if (m.rl_scope !== 'mailbox' || !m.rl || typeof m.rl !== 'object') return null;
  const value = Number(m.rl.value);
  const frame = String(m.rl.frame ?? '');
  return Number.isInteger(value) && value > 0 && RATE_LIMIT_FRAMES.includes(frame) ? { value, frame } : null;
}

// domain: only that domain's mailboxes (get/mailbox/all/<domain>), read with a longer timeout.
export async function listMailboxes(cfg, { domain } = {}) {
  const path = domain ? `get/mailbox/all/${encodeURIComponent(domain)}` : 'get/mailbox/all';
  return asList(await request(cfg, 'GET', path, undefined, domain ? { timeoutMs: MAILBOX_LIST_TIMEOUT_MS } : {}))
    .filter((m) => m.username)
    .map((m) => ({ ...mailboxInfo(m), rateLimit: mailboxRateLimit(m) }));
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
// rateLimit: the mailbox's send limit, { value, frame } (services/mailNode/nodeApply.js); a
// mailbox taken over gets it too.
export async function provisionMailbox(cfg, { localPart, domain, name, rateLimit = null }) {
  const email = `${localPart}@${domain}`;
  const password = generateMailboxPassword();
  const existing = await getMailbox(cfg, email);
  if (existing?.state === 0) {
    throw new MailNodeError('mailbox_disabled_on_node', 'The mail node has a disabled mailbox with this address: delete it in mailcow first', 409);
  }
  if (existing) {
    await editMailbox(cfg, email, { active: 1, password, password2: password, force_pw_update: 0 });
    // The mailbox is taken over already: a limit the node did not take is set again by the next
    // "apply" of the domain's settings, so it does not undo the takeover.
    if (rateLimit) {
      await setMailboxRateLimit(cfg, [email], rateLimit)
        .then(({ failed }) => failed.length && console.error('Mail node kept no send limit for a mailbox it took over'))
        .catch((err) => console.error(`Mail node send limit for a mailbox it took over failed: ${err.code}`));
    }
  } else {
    await request(cfg, 'POST', 'add/mailbox', {
      local_part: localPart, domain, name, password, password2: password,
      quota: cfg.quotaMb, active: 1, force_pw_update: 0,
      ...(rateLimit ? { rl_value: String(rateLimit.value), rl_frame: rateLimit.frame } : {}),
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
