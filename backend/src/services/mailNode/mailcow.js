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
// success). textLimit: the answer as text of at most that many bytes ({ text, truncated }), for
// the few calls that print instead of answering JSON (get/postcat).
async function request(cfg, method, path, body, { judge = true, timeoutMs = REQUEST_TIMEOUT_MS, textLimit = 0 } = {}) {
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
  if (textLimit) return textCapped(res, textLimit);
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

// mailcow's forwarding hosts (get/fwdhost/all, Redis WHITELISTED_FWD_HOST): addresses and networks
// rspamd treats as a relay in front of the node (eop-panel-requirements.md, section 2.5): no
// greylisting, reject lowered to add header, no positive weights from the rbl, policies and hfilter
// groups. host: as mailcow keeps it (a name given to add/fwdhost becomes its addresses, with the name
// in source). keepSpam: mailcow's keep_spam "yes", the entry was added without filter_spam, and rspamd
// accepts its mail without checking it at all.
export async function listForwardingHosts(cfg) {
  return asList(await request(cfg, 'GET', 'get/fwdhost/all')).map((h) => ({
    host: String(h.host ?? '').trim(),
    source: String(h.source ?? ''),
    keepSpam: String(h.keep_spam ?? '').toLowerCase() === 'yes',
  })).filter((h) => h.host);
}

// Always with filter_spam: 1, never anything else: without it mailcow sets KEEP_SPAM for the host
// and rspamd stops checking its mail (functions.fwdhost.inc.php, rspamd.local.lua). Adding a host
// that is listed already replaces it and clears its KEEP_SPAM.
export async function addForwardingHost(cfg, cidr) {
  await request(cfg, 'POST', 'add/fwdhost', { hostname: cidr, filter_spam: 1 });
}

// delete/fwdhost takes the hosts exactly as get/fwdhost/all lists them.
export async function deleteForwardingHosts(cfg, hosts) {
  await request(cfg, 'POST', 'delete/fwdhost', hosts);
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
    try {
      await request(cfg, 'POST', 'add/mailbox', {
        local_part: localPart, domain, name, password, password2: password,
        quota: cfg.quotaMb, active: 1, force_pw_update: 0,
        ...(rateLimit ? { rl_value: String(rateLimit.value), rl_frame: rateLimit.frame } : {}),
      });
    } catch (err) {
      // mailcow keeps one address either a mailbox or an alias ([danger is_alias <address>]). The
      // panel never makes node aliases (D-16), so this one was made by hand: an administrator
      // removes it in mailcow, and mail to the address then goes to the new mailbox.
      if (err instanceof MailNodeError && err.code === 'mail_node_refused' && /\bis_alias\b/.test(err.message)) {
        throw new MailNodeError('address_is_node_alias', 'The mail node has an alias with this address: remove it in mailcow first', 409);
      }
      throw err;
    }
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

// --- Node operations: the mail queue (R-16), the Postfix log and the containers (R-18) -----------
// mailcow runs each queue call as a command in postfix-mailcow through its dockerapi: get/mailq/all
// is `postqueue -j` (at most 10000 entries), get/postcat/<id> is `postcat -q <id>` printed as text,
// edit/mailq hold/unhold/deliver are `postsuper -h/-H` and `postqueue -i` per id, flush is
// `postqueue -f`, delete/mailq is `postsuper -d` per id. Its super_delete (`postsuper -d ALL`) is
// never called from the panel. All of them need an administrator's API key.

const QUEUE_LIST_TIMEOUT_MS = 30000;
const LOG_TIMEOUT_MS = 30000;
// The queues postqueue -j names.
export const QUEUE_NAMES = Object.freeze(['active', 'deferred', 'hold', 'incoming', 'maildrop']);
// What the panel lets an administrator do with one queued message besides deleting it.
export const QUEUE_ACTIONS = Object.freeze(['hold', 'unhold', 'deliver']);

// A queue id as mailcow's dockerapi takes it (hex only; it drops anything else silently): upper
// case, or null.
export function parseQueueId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[0-9A-Fa-f]{6,20}$/.test(id) ? id.toUpperCase() : null;
}

// mailcow rewrites each recipient of postqueue -j into "address (delay reason)" when Postfix gave a
// reason, and keeps the bare address otherwise.
function queueRecipient(value) {
  if (value && typeof value === 'object') {
    return { address: String(value.address ?? '').toLowerCase(), reason: value.delay_reason ? String(value.delay_reason) : null };
  }
  const text = String(value ?? '').trim();
  const match = /^(\S+) \(([\s\S]*)\)$/.exec(text);
  return match ? { address: match[1].toLowerCase(), reason: match[2] } : { address: text.toLowerCase(), reason: null };
}

// The node's mail queue: [{ queueId, queue, arrivedAt (ISO), size (bytes), forcedExpire, sender
// ('' for the null sender of a bounce), recipients: [{ address, reason }] }].
export async function listQueue(cfg) {
  const data = await request(cfg, 'GET', 'get/mailq/all', undefined, { timeoutMs: QUEUE_LIST_TIMEOUT_MS });
  return (Array.isArray(data) ? data : asList(data))
    .filter((item) => item && typeof item === 'object' && parseQueueId(String(item.queue_id ?? '')))
    .map((item) => {
      const arrival = Number(item.arrival_time);
      return {
        queueId: parseQueueId(String(item.queue_id)),
        queue: String(item.queue_name ?? ''),
        arrivedAt: Number.isFinite(arrival) && arrival > 0 ? new Date(arrival * 1000).toISOString() : null,
        size: Number(item.message_size ?? 0) || 0,
        forcedExpire: item.forced_expire === true,
        sender: String(item.sender ?? '').toLowerCase(),
        recipients: (Array.isArray(item.recipients) ? item.recipients : []).map(queueRecipient).filter((r) => r.address),
      };
    });
}

// A queued message can be up to Postfix's message_size_limit; the panel reads at most this much of
// its postcat dump (the envelope and the headers come first).
export const MAX_POSTCAT_BYTES = 2 * 1024 * 1024;

// An answer as text, stopping after maxBytes: { text, truncated }.
async function textCapped(res, maxBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - size;
      if (value.byteLength > room) {
        chunks.push(Buffer.from(value.subarray(0, room)));
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } else {
    const whole = Buffer.from(await res.text());
    truncated = whole.length > maxBytes;
    chunks.push(truncated ? whole.subarray(0, maxBytes) : whole);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

// The queued message as `postcat -q` prints it (envelope records, the message, extracted headers),
// or what postcat said instead when the message is gone: { text, truncated } (cut at
// MAX_POSTCAT_BYTES).
export async function getQueuedMessageText(cfg, queueId) {
  return request(cfg, 'GET', `get/postcat/${encodeURIComponent(queueId)}`, undefined, {
    textLimit: MAX_POSTCAT_BYTES, timeoutMs: QUEUE_LIST_TIMEOUT_MS,
  });
}

// hold, unhold or deliver for the given queue ids. deliver answers success whatever postqueue did.
export async function queueAction(cfg, queueIds, action) {
  if (!QUEUE_ACTIONS.includes(action)) throw new MailNodeError('queue_action_invalid', 'No such queue action', 400);
  await request(cfg, 'POST', 'edit/mailq', { items: queueIds, attr: { action } });
}

// Tries every deferred message again now.
export async function flushQueue(cfg) {
  await request(cfg, 'POST', 'edit/mailq', { items: [], attr: { action: 'flush' } });
}

export async function deleteQueued(cfg, queueIds) {
  await request(cfg, 'POST', 'delete/mailq', queueIds);
}

// The last `lines` lines of the Postfix log, newest first, as mailcow keeps them:
// [{ time: "<unix seconds>", program, priority, message }]. Parsed by services/mailNode/postfixLog.js.
// mailcow answers {} when Redis has no lines; Postfix logs all the time, so that, an empty list or
// anything else that is no list of lines is a failure (mail_node_failed), never "nothing happened".
export async function getPostfixLog(cfg, lines) {
  const data = await request(cfg, 'GET', `get/logs/postfix/${lines}`, undefined, { timeoutMs: LOG_TIMEOUT_MS });
  if (!Array.isArray(data) || !data.length) {
    throw new MailNodeError('mail_node_failed', 'The mail node returned no Postfix log');
  }
  return data;
}

// The node's alias domains (get/alias-domain/all), lower case: mail to them is the node's own.
export async function listAliasDomains(cfg) {
  return asList(await request(cfg, 'GET', 'get/alias-domain/all'))
    .map((d) => String(d.alias_domain ?? '').trim().toLowerCase())
    .filter(Boolean);
}

// The node's containers: [{ name, state ('running', 'exited', 'restarting', ...), health, startedAt,
// image }]. mailcow answers an object keyed by container name. health: Docker's health status
// ('healthy', 'unhealthy', 'starting') when the answer carries it, else null; mailcow 2026-09 sends
// only the state (json_api.php status/containers), so an unhealthy but running container shows only
// with a mailcow that adds it.
export async function getContainers(cfg) {
  const data = await request(cfg, 'GET', 'get/status/containers');
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new MailNodeError('mail_node_failed', 'The mail node did not report its containers');
  }
  return Object.entries(data)
    .filter(([, c]) => c && typeof c === 'object')
    .map(([key, c]) => ({
      name: String(c.container ?? key),
      state: String(c.state ?? '').toLowerCase(),
      health: (() => {
        const health = c.health ?? c.health_status ?? c.State?.Health?.Status;
        return health ? String(health).toLowerCase() : null;
      })(),
      startedAt: c.started_at ? String(c.started_at) : null,
      image: c.image ? String(c.image) : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Quarantine and rspamd history (R-20)───────────────────────────────────────────────────────
// mailcow keeps a copy of every letter rspamd rejected or marked as spam ("reject", "add header",
// "rewrite subject"; data/conf/rspamd/local.d/metadata_exporter.conf) in its quarantine table, one
// row per final mailbox. The panel lists, shows, releases and deletes those rows; what it reads of
// a letter reaches the screen only through the panel's safe text view (services/mailNode/quarantine.js).
// The quarantine settings (edit/quarantine) are left alone: the API has no call to read them, and
// edit/quarantine writes every setting from the body, resetting the ones left out (retention,
// excluded domains, notification sender and template; functions.quarantine.inc.php, 'settings').

// mailcow's symbols come in two shapes: a quarantine row keeps rspamd's list [{ name, score,
// options }] as a JSON string, the history a map { NAME: { name, score, options, description } }.
// One list of { name, score, options, description }, the order mailcow's own screens use: positive
// scores highest first, then negative ones, zero last.
export function normalizeSymbols(value) {
  let data = value;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return []; }
  }
  if (!data || typeof data !== 'object') return [];
  const entries = Array.isArray(data)
    ? data.map((s) => [s?.name, s])
    : Object.entries(data).map(([name, s]) => [s?.name ?? name, s]);
  return entries
    .filter(([name, s]) => typeof name === 'string' && name && s && typeof s === 'object')
    .map(([name, s]) => ({
      name,
      score: Number.isFinite(Number(s.score)) ? Number(s.score) : 0,
      options: Array.isArray(s.options) ? s.options.slice(0, 20).map(String) : [],
      description: typeof s.description === 'string' ? s.description : null,
    }))
    .sort((a, b) => (a.score === 0) - (b.score === 0) || b.score - a.score);
}

const finiteOrNull = (value) => (
  value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
);

// The quarantine without the letters (get/quarantine/all; [] when empty), newest first, with
// `created` as an ISO time (mailcow sends seconds since the epoch here). virus: rspamd found one.
export async function listQuarantine(cfg) {
  return asList(await request(cfg, 'GET', 'get/quarantine/all'))
    .filter((q) => q && Number.isInteger(Number(q.id)))
    .map((q) => ({
      id: Number(q.id),
      qid: String(q.qid ?? ''),
      subject: String(q.subject ?? ''),
      score: finiteOrNull(q.score),
      sender: String(q.sender ?? ''),
      rcpt: String(q.rcpt ?? '').toLowerCase(),
      action: String(q.action ?? ''),
      created: Number(q.created) > 0 ? new Date(Number(q.created) * 1000).toISOString() : null,
      notified: Number(q.notified) === 1,
      virus: Number(q.virus_flag) > 0,
    }))
    .sort((a, b) => b.id - a.id);
}

// One quarantine row with its letter (get/quarantine/<id>), or null when there is none. `msg` is the
// letter as mailcow stored it; `created` is mailcow's own DATETIME text, in the node's time zone.
export async function getQuarantineItem(cfg, id) {
  const data = await request(cfg, 'GET', `get/quarantine/${encodeURIComponent(id)}`);
  const item = Array.isArray(data) ? data[0] : data;
  if (!item || typeof item !== 'object' || !Number.isInteger(Number(item.id))) return null;
  return {
    id: Number(item.id),
    qid: String(item.qid ?? ''),
    subject: String(item.subject ?? ''),
    score: finiteOrNull(item.score),
    ip: item.ip && item.ip !== 'unknown' ? String(item.ip) : null,
    action: String(item.action ?? ''),
    symbols: normalizeSymbols(item.symbols),
    sender: String(item.sender ?? ''),
    rcpt: String(item.rcpt ?? '').toLowerCase(),
    user: item.user && item.user !== 'unknown' ? String(item.user) : null,
    created: item.created ? String(item.created) : null,
    msg: typeof item.msg === 'string' ? item.msg : '',
  };
}

// Release: mailcow hands the letter to Postfix on its port 590 (past rspamd) for the mailbox,
// deletes the row and then trains rspamd with it as ham. The API's "learnham" runs the same code,
// so the panel offers the one action. The answer has a success per step; training that fails after
// the letter went out is a warning, not a failure. Returns { learned, warnings }.
export async function releaseQuarantineItem(cfg, id) {
  const items = asList(await request(cfg, 'POST', 'edit/qitem', { items: [id], attr: { action: 'release' } }, { judge: false }))
    .filter((item) => item && typeof item === 'object');
  const said = (word) => items.some((item) => item.type === 'success' && Array.isArray(item.msg) && item.msg[0] === word);
  if (!said('item_released')) {
    throw new MailNodeError('mail_node_refused', `The mail node refused: ${refusal(items) ?? 'refused'}`);
  }
  return {
    learned: said('learned_ham'),
    warnings: items.filter((item) => item.type !== 'success').map((item) => messageOf(item) || item.type),
  };
}

// "Delete and train as spam" (edit/qitem learnspam): mailcow deletes the row first, then trains
// rspamd with the letter as spam and adds its fuzzy hash. A failed training comes back as a danger
// item after the row is gone, so it is a warning here; only a row that was not touched (no such
// entry, access_denied) is a refusal. Returns { learned, warnings }.
const LEARN_SPAM_AFTER_DELETE = new Set(['qlearn_spam', 'spam_learn_error', 'fuzzy_learn_error']);
export async function learnSpamQuarantineItem(cfg, id) {
  const items = asList(await request(cfg, 'POST', 'edit/qitem', { items: [id], attr: { action: 'learnspam' } }, { judge: false }))
    .filter((item) => item && typeof item === 'object');
  const word = (item) => (Array.isArray(item.msg) ? item.msg[0] : item.msg);
  if (!items.some((item) => LEARN_SPAM_AFTER_DELETE.has(word(item)))) {
    throw new MailNodeError('mail_node_refused', `The mail node refused: ${refusal(items) ?? 'refused'}`);
  }
  return {
    learned: items.some((item) => item.type === 'success' && word(item) === 'qlearn_spam'),
    warnings: items.filter((item) => item.type !== 'success').map((item) => messageOf(item) || item.type),
  };
}

// The quarantine settings the panel writes when an administrator asks it to (edit/quarantine
// 'settings'). That call writes every setting from the body and resets the ones left out, and the
// API cannot read them back, so the panel always sends all of them: letters up to 10 MiB, 20 kept
// per mailbox, 365 days, no excluded domains, release as the original letter ("raw": the panel's
// texts about releasing assume it), and empty notification fields, for which mailcow falls back to
// its own defaults (quarantine_notify.py: sender quarantine@localhost, its subject and template,
// no score limit for notifications).
export const QUARANTINE_NODE_SETTINGS = Object.freeze({
  max_size: 10,
  retention_size: 20,
  max_age: 365,
  max_score: '',
  exclude_domains: [],
  release_format: 'raw',
  sender: '',
  subject: '',
  bcc: '',
  redirect: '',
  html_tmpl: '',
});

export async function writeQuarantineSettings(cfg) {
  const items = asList(await request(cfg, 'POST', 'edit/quarantine', {
    items: ['none'], attr: { action: 'settings', ...QUARANTINE_NODE_SETTINGS },
  }, { judge: false })).filter((item) => item && typeof item === 'object');
  if (!items.some((item) => item.type === 'success' && messageOf(item) === 'saved_settings')) {
    throw new MailNodeError('mail_node_refused', `The mail node refused: ${refusal(items) ?? 'refused'}`);
  }
}

// delete/qitem answers success for an id it has no row for, too.
export async function deleteQuarantineItem(cfg, id) {
  const items = asList(await request(cfg, 'POST', 'delete/qitem', [id], { judge: false }))
    .filter((item) => item && typeof item === 'object');
  if (!items.some((item) => item.type === 'success')) {
    throw new MailNodeError('mail_node_refused', `The mail node refused: ${refusal(items) ?? 'refused'}`);
  }
}

// rspamd's history of the last `rows` letters it checked (get/logs/rspamd-history/<rows>; mailcow
// keeps 1000, local.d/history_redis.conf), newest first, with `time` as an ISO time. A history row
// carries no queue id: it is matched to a letter by Message-ID, recipient and time.
// Symbols keep their name, score and description only: a symbol's options (URLs, addresses) are
// not needed for a verdict and would make the cached history large.
const lowerList = (value) => (Array.isArray(value) ? value.map((v) => String(v).toLowerCase()) : []);
const HISTORY_TIMEOUT_MS = 20000;
export async function getRspamdHistory(cfg, rows) {
  const data = await request(cfg, 'GET', `get/logs/rspamd-history/${rows}`, undefined, { timeoutMs: HISTORY_TIMEOUT_MS });
  return asList(data)
    .filter((r) => r && typeof r === 'object' && !Array.isArray(r))
    .map((r) => ({
      messageId: r['message-id'] ? String(r['message-id']) : null,
      time: Number(r.unix_time) > 0 ? new Date(Number(r.unix_time) * 1000).toISOString() : null,
      score: finiteOrNull(r.score),
      requiredScore: finiteOrNull(r.required_score),
      // The scores from which rspamd marks a letter as spam and rejects it ({ "add header": 8,
      // reject: 15, greylist: 7 } on mailcow).
      spamScore: finiteOrNull(r.thresholds?.['add header'] ?? r.thresholds?.['rewrite subject']),
      rejectScore: finiteOrNull(r.thresholds?.reject ?? r.required_score),
      action: String(r.action ?? ''),
      skipped: r.is_skipped === true,
      symbols: normalizeSymbols(r.symbols).map(({ name, score, description }) => ({ name, score, description })),
      ip: r.ip ? String(r.ip) : null,
      senderSmtp: String(r.sender_smtp ?? '').toLowerCase(),
      senderMime: String(r.sender_mime ?? '').toLowerCase(),
      rcptSmtp: lowerList(r.rcpt_smtp),
      rcptMime: lowerList(r.rcpt_mime),
      subject: String(r.subject ?? ''),
    }));
}
