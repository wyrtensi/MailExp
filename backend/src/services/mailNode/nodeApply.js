import { query } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import {
  MailNodeError,
  addDkim,
  addForwardingHost,
  addRelayhost,
  addTlsPolicy,
  deleteDkim,
  deleteForwardingHosts,
  deleteRelayhost,
  deleteTlsPolicy,
  editTlsPolicy,
  enableRelayhost,
  getDkim,
  getDomain,
  getFail2banWhitelist,
  getMailNodeConfig,
  getPrefilter,
  listDomains,
  listForwardingHosts,
  listMailboxes,
  listRelayhosts,
  listTlsPolicies,
  setDomainRelayhost,
  setMailboxRateLimit,
  setPrefilter,
  unwhitelistFail2ban,
  whitelistFail2ban,
} from './mailcow.js';
import { getEopSettings } from './eopSettings.js';
import { EOP_RANGES, eopRangeList, networksOverlap } from './eopRanges.js';

// "Apply settings": the panel puts its settings on the mail node through the mailcow API
// (eop-panel-requirements.md, R-07 ... R-11, R-13). Every item is read first and written only when
// the node differs, so applying again changes nothing; each item reports what it found:
// - ok: the node had it already;
// - changed: the panel changed it now (from / to say what);
// - failed: the node refused or could not be asked (code, and the node's own words in detail);
// - skipped: a setting it needs is empty, or the change waits for an administrator (code; with
//   the node's current state in `current` where there is one to show);
// - pending: the spam filing rule differs and is applied only by its own action, since writing it
//   restarts Dovecot and drops every IMAP session.
//
// The node items: the TLS Policy Map entry and the relayhost for <EOP_HOST>, the fail2ban whitelist
// for the panel's addresses, the check of the spam filing rule and, once that rule is in place, the
// EOP ranges as forwarding hosts (R-12); after <EOP_HOST> changed, the TLS entry and the relayhost
// the panel made for the previous host are removed (the relayhost only once nothing sends through
// it). The items of each domain: the domain's relayhost, its DKIM key as the
// DKIM mode wants it and the send limit of each of its mailboxes the panel knows. The global
// relayhost in extra.cf is the host's (runbook): the panel sets and reports only the domain's.
//
// It runs when an administrator presses "Apply" (the node with every domain the panel knows, or one
// domain), and by itself after the EOP or node settings change and when a domain is added, adopted
// or starts its onboarding over. A run started by itself never deletes a DKIM key and never writes
// the spam filing rule. Runs never overlap. The last result is kept: the node's in integration_config
// ('mail_node_apply', with what the panel itself made on the node), each domain's in
// mail_node_domains.apply_result.

export const APPLY_PROVIDER = 'mail_node_apply';
export const APPLY_STATUSES = Object.freeze(['ok', 'changed', 'failed', 'skipped', 'pending']);
// Why a run started, for the journal.
export const APPLY_TRIGGERS = Object.freeze([
  'manual', 'eop_settings', 'node_settings', 'domain_added', 'domain_adopted', 'onboarding_restarted',
]);
// Addresses named in a failed mailbox item; the counts cover the rest.
const MAX_LISTED_MAILBOXES = 20;
// Mailboxes per edit/rl-mbox call.
const RATE_LIMIT_BATCH = 100;
// Timeouts in one run after which the node counts as not answering: one slow answer (a big domain's
// mailbox list) does not stop the run, a second one does.
const TIMEOUTS_UNTIL_DOWN = 2;

// --- The spam filing rule (R-11) -------------------------------------------------------------

// EOP files nothing into Junk for a recipient outside the cloud: it stamps its verdict into
// X-Forefront-Antispam-Report ("NAME:value;" fields, folded over lines at times) and the node files
// the message. SFV is the verdict: SPM spam, SKS marked spam by a mail flow rule, SKB a blocked
// sender; CAT the category. By the owner's decisions D-2 and D-11 (R-42) and those after stage 7
// (section 5.14 of eop-panel-requirements.md):
// - every category EOP marks as unwanted (CAT PHSH, HPHSH, HPHISH, MALW, SPM, HSPM, SPOOF, BULK)
//   always goes to Junk, also when EOP released it from quarantine (SFV:SKQ): the panel releases
//   high confidence phishing, phishing, spam, high confidence spam and bulk itself (a spoof
//   quarantined as phishing among them) and shows them in Junk in safe mode;
// - the spam verdicts (SFV SPM/SKS/SKB) go to Junk unless released from quarantine (SFV:SKQ).
// That a released message keeps its CAT is an assumption for tenant experiment 17.
// Each value must be a whole field: after the start of the header or a ";" (with any blank the
// unfolding left) and before ";" or the end, so "SFV:SPMX" or "XSFV:SPM" match nothing.
export const PREFILTER_SFV = Object.freeze(['SPM', 'SKS', 'SKB']);
export const PREFILTER_ALWAYS_CAT = Object.freeze(['PHSH', 'HPHSH', 'HPHISH', 'MALW', 'SPM', 'HSPM', 'SPOOF', 'BULK']);
const HEADER = 'X-Forefront-Antispam-Report';
const field = (name, values) => {
  const value = values.length === 1 ? values[0] : `(${values.join('|')})`;
  return `(^|;)[[:space:]]*${name}:${value}[[:space:]]*(;|$)`;
};
const test = (regex) => `header :regex "${HEADER}" "${regex}"`;

const REQUIRE_BEGIN = '# BEGIN MailExpert: extensions of the EOP verdict rule (managed by MailExpert, do not edit)';
const REQUIRE_END = '# END MailExpert: extensions';
const RULE_BEGIN = '# BEGIN MailExpert: EOP verdicts to Junk (managed by MailExpert, do not edit)';
const RULE_END = '# END MailExpert: EOP verdicts';

const REQUIRE_BLOCK = [REQUIRE_BEGIN, 'require ["fileinto", "regex"];', REQUIRE_END].join('\n');
// stop: a message filed as spam runs no later script: no mailbox filter forwards it or answers it
// with a vacation reply.
const RULE_BLOCK = [
  RULE_BEGIN,
  'if anyof (',
  `  ${test(field('CAT', PREFILTER_ALWAYS_CAT))},`,
  '  allof (',
  `    not ${test(field('SFV', ['SKQ']))},`,
  `    ${test(field('SFV', PREFILTER_SFV))}`,
  '  )',
  ') {',
  '  fileinto "Junk";',
  '  stop;',
  '}',
  RULE_END,
].join('\n');

const markersBroken = () => new MailNodeError(
  'prefilter_markers_broken', 'The prefilter on the node holds a MailExpert block without its end marker', 409,
);

// The text without every block between the markers (a block written twice goes in one pass). A
// begin marker without its end, or an end marker without its begin, is refused: what belongs to the
// panel cannot be told apart from what does not.
function withoutBlocks(text, begin, end) {
  let lines = text.split('\n');
  for (let from = lines.indexOf(begin); from >= 0; from = lines.indexOf(begin)) {
    const to = lines.indexOf(end, from);
    if (to < 0 || lines.slice(from + 1, to).includes(begin)) throw markersBroken();
    lines = [...lines.slice(0, from), ...lines.slice(to + 1)];
  }
  if (lines.includes(end)) throw markersBroken();
  return lines.join('\n');
}

// The prefilter with the panel's rule: whatever else it holds stays, between the rule's `require`
// at the top (Sieve wants every require before the first command) and the rule at the end. Built
// from its own output it gives the same text, so an unchanged rule is never written again. Throws
// prefilter_markers_broken for a prefilter whose markers do not pair up.
export function buildPrefilter(existing) {
  const text = String(existing ?? '').replace(/\r\n?/g, '\n');
  const rest = withoutBlocks(withoutBlocks(text, REQUIRE_BEGIN, REQUIRE_END), RULE_BEGIN, RULE_END)
    .replace(/^\s*\n/, '').replace(/\s+$/, '');
  return `${[REQUIRE_BLOCK, rest, RULE_BLOCK].filter(Boolean).join('\n\n')}\n`;
}

// --- The rule on the node, as the release from EOP's quarantine and the alerts need it ----------

// Section 5.14: the release of spam and phishing from EOP's quarantine (services/tenant/
// quarantineRelease.js) relies on the node filing released spam into Junk, which only this version
// of the rule does (earlier versions filed SFV:SKQ with CAT SPM, HSPM, SPOOF or BULK into the
// Inbox). A node keeps its old rule until an administrator writes the new one by its own action
// (it restarts Dovecot), so the state is read from the node itself:
//   ok        the prefilter holds this version of the rule
//   outdated  it holds a MailExpert rule of another version
//   missing   it holds no MailExpert rule
//   unknown   no node, the node did not answer, or the panel's markers are broken (code)
// The last state is kept in integration_config SPAM_RULE_PROVIDER for the screens.
export const SPAM_RULE_PROVIDER = 'mail_node_spam_rule';
export function spamRuleStateOf(current) {
  // The same comparison as the "Apply" check (prefilterCheck).
  const text = String(current ?? '');
  try {
    if (buildPrefilter(text) === text) return { state: 'ok' };
  } catch (err) {
    if (err instanceof MailNodeError) return { state: 'unknown', code: err.code };
    throw err;
  }
  return { state: text.replace(/\r\n?/g, '\n').split('\n').includes(RULE_BEGIN) ? 'outdated' : 'missing' };
}

export async function saveSpamRuleState(found, now = Date.now()) {
  const value = { at: new Date(now).toISOString(), state: found.state, ...(found.code ? { code: found.code } : {}) };
  await query(`
    INSERT INTO integration_config (provider, config) VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  `, [SPAM_RULE_PROVIDER, value]);
  return value;
}

export async function getSpamRuleState() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [SPAM_RULE_PROVIDER]);
  return rows[0]?.config ?? null;
}

// Reads the rule on the node now and keeps the answer: { at, state, code? }.
export async function checkSpamRule({ cfg = undefined, now = Date.now() } = {}) {
  const config = cfg === undefined ? await getMailNodeConfig() : cfg;
  let found;
  if (!config) {
    found = { state: 'unknown', code: 'mail_node_not_configured' };
  } else {
    try {
      found = spamRuleStateOf(await getPrefilter(config));
    } catch (err) {
      if (!(err instanceof MailNodeError)) throw err;
      found = { state: 'unknown', code: err.code };
    }
  }
  return saveSpamRuleState(found, now);
}

// --- One run ---------------------------------------------------------------------------------

// The items of one run (the node's or one domain's), sharing with the rest of the run a node that
// stopped answering: once a call finds it unreachable (or timing out again) or refusing the key, the
// items after it fail with the same code without waiting for the node again.
function itemList(shared) {
  const items = [];
  return {
    items,
    skip(item, target, code, extra = {}) {
      items.push({ item, target, status: 'skipped', code, ...extra });
    },
    async step(item, target, fn) {
      if (shared.down) {
        items.push({ item, target, status: 'failed', code: shared.down });
        return null;
      }
      try {
        const result = await fn();
        items.push({ item, target, ...result });
        return result;
      } catch (err) {
        if (!(err instanceof MailNodeError)) throw err;
        if (err.timeout) {
          shared.timeouts = (shared.timeouts ?? 0) + 1;
          if (shared.timeouts >= TIMEOUTS_UNTIL_DOWN) shared.down = err.code;
        } else if (err.code === 'mail_node_unreachable' || err.code === 'mail_node_auth') {
          shared.down = err.code;
        }
        let detail = null;
        if (err.code === 'mail_node_refused') detail = err.message.replace(/^The mail node refused:\s*/, '');
        else if (err.timeout) detail = 'timeout';
        // err.change: what the item had changed before it failed (from / to).
        items.push({ item, target, status: 'failed', code: err.code, ...(detail ? { detail } : {}), ...(err.change ?? {}) });
        return null;
      }
    },
  };
}

const describePolicy = (policy, parameters) => [policy, parameters].filter(Boolean).join(' ');
const describeRelayhost = (r) => `${r.hostname} (${r.id})`;

// What the panel made on the node, so it can take it away again: TLS entries (owned.tls, { id, dest }),
// relayhosts (owned.relayhosts, { id, hostname }), fail2ban addresses (owned.fail2ban) and forwarding
// hosts (owned.fwdhosts, the CIDRs as the panel added them).
const EMPTY_OWNED = Object.freeze({ tls: [], relayhosts: [], fail2ban: [], fwdhosts: [] });
const remember = (list, entry) => [...list.filter((e) => e.id !== entry.id), entry];

// R-07: the entry for <EOP_HOST>, the bare next hop exactly as the relayhost names it. An entry the
// panel adds is recorded in owned.tls, so it can go when the host changes.
async function tlsPolicyItem(cfg, { eopHost, tlsPolicy, tlsPolicyParameters }, owned) {
  const parameters = tlsPolicyParameters ?? '';
  const entry = (await listTlsPolicies(cfg)).find((p) => p.dest === eopHost);
  const current = entry ? describePolicy(entry.policy, entry.parameters) : null;
  if (tlsPolicy === 'default') {
    if (!entry) return { status: 'ok', to: 'default' };
    await deleteTlsPolicy(cfg, entry.id);
    owned.tls = owned.tls.filter((e) => e.id !== entry.id);
    return { status: 'changed', from: current, to: 'default' };
  }
  const wanted = describePolicy(tlsPolicy, parameters);
  if (entry && entry.active && entry.policy === tlsPolicy && entry.parameters.trim() === parameters) {
    return { status: 'ok', to: wanted };
  }
  const attr = { dest: eopHost, policy: tlsPolicy, parameters };
  if (entry) {
    await editTlsPolicy(cfg, entry.id, attr);
  } else {
    await addTlsPolicy(cfg, attr);
    const made = (await listTlsPolicies(cfg)).find((p) => p.dest === eopHost);
    if (made) owned.tls = remember(owned.tls, { id: made.id, dest: eopHost });
  }
  return { status: 'changed', from: entry ? `${current}${entry.active ? '' : ' (inactive)'}` : null, to: wanted };
}

// R-08: a relayhost entry for <EOP_HOST> without a login (one with a username would turn SASL on).
// Returns its id; an entry the panel adds is recorded in owned.relayhosts.
async function ensureRelayhost(cfg, eopHost, owned) {
  const ours = (list) => list.filter((r) => r.hostname === eopHost && !r.hasLogin).sort((a, b) => b.active - a.active)[0];
  let entry = ours(await listRelayhosts(cfg));
  if (entry?.active) return { status: 'ok', id: entry.id };
  if (entry) {
    await enableRelayhost(cfg, entry.id);
    return { status: 'changed', id: entry.id, from: 'inactive', to: 'active' };
  }
  await addRelayhost(cfg, eopHost);
  entry = ours(await listRelayhosts(cfg));
  if (!entry) throw new MailNodeError('mail_node_failed', 'The mail node did not list the relayhost it added');
  owned.relayhosts = remember(owned.relayhosts, { id: entry.id, hostname: eopHost });
  return { status: 'changed', id: entry.id, from: null, to: eopHost };
}

// Without <EOP_HOST> nothing is set or removed: the node items show what the panel made before.
async function currentTls(cfg, owned) {
  if (!owned.tls.length) return {};
  const entries = (await listTlsPolicies(cfg)).filter((p) => owned.tls.some((e) => e.id === p.id && e.dest === p.dest));
  return entries.length ? { current: entries.map((e) => `${e.dest}: ${describePolicy(e.policy, e.parameters)}`).join(', ') } : {};
}

async function currentRelayhost(cfg, owned) {
  if (!owned.relayhosts.length) return {};
  const entries = (await listRelayhosts(cfg)).filter((r) => owned.relayhosts.some((e) => e.id === r.id));
  return entries.length ? { current: entries.map(describeRelayhost).join(', ') } : {};
}

// R-13: the panel's addresses in the fail2ban whitelist. The ones the panel added are recorded in
// owned.fail2ban; an address taken out of the setting is removed from the whitelist only when the
// panel added it, never one an administrator listed there.
async function fail2banItem(cfg, panelIps, owned) {
  const listed = await getFail2banWhitelist(cfg);
  const missing = panelIps.filter((network) => !listed.includes(network));
  const former = (owned.fail2ban ?? []).filter((network) => !panelIps.includes(network));
  const toRemove = former.filter((network) => listed.includes(network));
  if (missing.length) await whitelistFail2ban(cfg, missing);
  const removed = toRemove.length ? await unwhitelistFail2ban(cfg, toRemove) : [];
  owned.fail2ban = [...new Set([...(owned.fail2ban ?? []).filter((n) => !former.includes(n)), ...missing])];
  if (!missing.length && !removed.length) return { status: 'ok' };
  return {
    status: 'changed',
    ...(removed.length ? { from: removed.join(', ') } : {}),
    ...(missing.length ? { to: missing.join(', ') } : {}),
  };
}

// R-11, the check only: the general apply never writes the rule.
async function prefilterCheck(cfg) {
  const current = await getPrefilter(cfg);
  if (buildPrefilter(current) === current) return { status: 'ok' };
  // rule: outdated or missing, kept for the release of spam from EOP's quarantine (section 5.14).
  return { status: 'pending', code: 'prefilter_differs', rule: spamRuleStateOf(current).state };
}

// The rule written, then read back: mailcow answers "written" without writing when the file is
// missing in its container.
async function prefilterItem(cfg) {
  const current = await getPrefilter(cfg);
  const wanted = buildPrefilter(current);
  if (wanted === current) return { status: 'ok' };
  const { restarted } = await setPrefilter(cfg, wanted);
  if ((await getPrefilter(cfg)) !== wanted) {
    throw new MailNodeError('prefilter_not_written', 'The mail node reported the rule written but does not hold it');
  }
  return { status: 'changed', ...(restarted ? {} : { code: 'dovecot_restart_failed' }) };
}

// R-12 by the owner's decision D-3: the EOP ranges as mailcow forwarding hosts, so rspamd stops
// judging the sender's SPF by EOP's address (eop-panel-requirements.md, section 2.5). The price: for
// these addresses rspamd also drops MICROSOFT_SPAM (EOP's verdict) and SPOOFED_UNAUTH, so EOP's
// verdict reaches Junk only through the spam filing rule (R-11). Hence the gate: nothing is added
// until the rule is in place, and a rule that stops matching later (a new panel version wants a new
// one) adds nothing more but takes nothing away either: removing the ranges would bring back the SPF
// rejects the forwarding hosts prevent.
//
// The list is the panel's static copy (eopRanges.js), shown by its version; the item applies only a
// list that has a version, an IPv4 range and nothing malformed or too wide. Every add carries
// filter_spam: 1. Only entries the panel added (owned.fwdhosts) are ever deleted. An entry somebody
// else made for a range counts as in place; if rspamd does not check it (keep_spam, "Filter spam"
// off), the panel adds it again with the filter on (add/fwdhost on an existing host clears its
// KEEP_SPAM, functions.fwdhost.inc.php) and reports that, but it stays somebody else's: the panel
// never deletes it. Any other entry with keep_spam whose network shares an address with a range is
// reported as a failure: rspamd looks KEEP_SPAM up for every network around the client address
// (/8 to /32, rspamd.local.lua), so such an entry turns the check off for that part of the range.
// Every other entry is left alone and listed as foreign.
const cidrKey = (host) => host.toLowerCase();

function fwdhostSummary(list, wanted, version, owned, filterTurnedOn = []) {
  const byKey = new Map(list.map((h) => [cidrKey(h.host), h]));
  const mine = new Set(owned.fwdhosts.map(cidrKey));
  return {
    version,
    wanted: wanted.length,
    missing: wanted.filter((c) => !byKey.has(c) || byKey.get(c).keepSpam),
    foreign: list.filter((h) => !mine.has(cidrKey(h.host))).map((h) => h.host),
    keepSpam: list.filter((h) => h.keepSpam && wanted.some((c) => networksOverlap(h.host, c))).map((h) => h.host),
    ...(filterTurnedOn.length ? { filterTurnedOn } : {}),
  };
}

// What a failed item had changed before it failed, so the result and the journal still say so.
const withChange = (err, change) => Object.assign(err, { change });
const describeChange = (added, removed) => ({
  ...(removed.length ? { from: removed.join(', ') } : {}),
  ...(added.length ? { to: added.join(', '), ...(removed.length ? {} : { from: null }) } : {}),
});

// rule: the status of the spam filing rule's item in this run.
async function forwardingHostsItem(cfg, { cidrs: wanted, version }, owned, { rule }) {
  const before = await listForwardingHosts(cfg);
  if (rule !== 'ok') {
    const present = owned.fwdhosts.filter((c) => before.some((h) => cidrKey(h.host) === c));
    return {
      status: 'skipped', code: rule === 'failed' ? 'prefilter_check_failed' : 'prefilter_not_applied',
      ...(present.length ? { current: present.join(', ') } : {}),
      fwdhosts: fwdhostSummary(before, wanted, version, owned),
    };
  }
  const byKey = new Map(before.map((h) => [cidrKey(h.host), h]));
  const mine = new Set(owned.fwdhosts);
  const toAdd = wanted.filter((c) => !byKey.has(c) || byKey.get(c).keepSpam);
  const toRemove = owned.fwdhosts.filter((c) => !wanted.includes(c) && byKey.has(c));
  const added = [];
  const turnedOn = [];
  const removed = [];
  try {
    for (const cidr of toAdd) {
      await addForwardingHost(cfg, cidr);
      if (byKey.get(cidr)?.keepSpam && !mine.has(cidr)) {
        turnedOn.push(cidr);
      } else {
        added.push(cidr);
        owned.fwdhosts = [...new Set([...owned.fwdhosts, cidr])];
      }
    }
    if (toRemove.length) {
      await deleteForwardingHosts(cfg, toRemove.map((c) => byKey.get(c).host));
      removed.push(...toRemove);
    }
  } catch (err) {
    throw withChange(err, describeChange([...added, ...turnedOn], removed));
  }
  const after = await listForwardingHosts(cfg);
  const afterKeys = new Set(after.map((h) => cidrKey(h.host)));
  // A deletion the node did not do stays the panel's, to try again.
  const notDeleted = removed.filter((c) => afterKeys.has(c));
  owned.fwdhosts = owned.fwdhosts.filter((c) => wanted.includes(c) || notDeleted.includes(c));
  const fwdhosts = fwdhostSummary(after, wanted, version, owned, turnedOn);
  const change = describeChange([...added, ...turnedOn], removed.filter((c) => !notDeleted.includes(c)));
  const lost = [...added, ...turnedOn].filter((c) => fwdhosts.missing.includes(c));
  if (lost.length) {
    throw withChange(new MailNodeError('fwdhost_not_written', `The mail node did not list the forwarding hosts it added: ${lost.join(', ')}`), change);
  }
  if (notDeleted.length) {
    throw withChange(new MailNodeError('fwdhost_not_deleted', `The mail node still lists the forwarding hosts it deleted: ${notDeleted.join(', ')}`), change);
  }
  if (fwdhosts.keepSpam.length) return { status: 'failed', code: 'fwdhost_keep_spam', ...change, fwdhosts };
  if (!added.length && !turnedOn.length && !removed.length) return { status: 'ok', fwdhosts };
  return { status: 'changed', ...(turnedOn.length ? { code: 'fwdhost_filter_turned_on' } : {}), ...change, fwdhosts };
}

// R-08: the domain sends through the relayhost of <EOP_HOST>. Without <EOP_HOST> the item says what
// the domain sends through now and changes nothing (domains are never unbound by themselves).
async function domainRelayhostItem(cfg, domain, relayhostId, relayhosts) {
  const onNode = await getDomain(cfg, domain);
  if (!onNode) throw new MailNodeError('domain_not_on_node', 'The mail node has no such domain', 404);
  if (relayhostId === null) {
    const bound = onNode.relayhost ? (await relayhosts()).find((r) => r.id === onNode.relayhost) : null;
    let current = 'none';
    if (onNode.relayhost) current = bound ? describeRelayhost(bound) : String(onNode.relayhost);
    return { status: 'skipped', code: 'eop_host_missing', current };
  }
  if (onNode.relayhost === relayhostId) return { status: 'ok', to: relayhostId };
  await setDomainRelayhost(cfg, domain, relayhostId);
  return { status: 'changed', from: onNode.relayhost || null, to: relayhostId };
}

// R-09 by the owner's decision D-1: in 'mailcow' mode the domain has a key and DNS publishes it; in
// 'eop' mode the tenant signs and mailcow keeps no key. Deleting a key is done only when the
// administrator confirmed it: mail the node signs now would go unsigned until EOP signs it.
async function dkimItem(cfg, domain, mode, confirmDelete, found) {
  const key = await getDkim(cfg, domain);
  if (mode === 'mailcow') {
    if (key) {
      found.dkim = key;
      return { status: 'ok' };
    }
    await addDkim(cfg, domain);
    const made = await getDkim(cfg, domain);
    if (!made) throw new MailNodeError('mail_node_failed', 'The mail node did not show the DKIM key it made');
    found.dkim = made;
    return { status: 'changed', from: null, to: made.selector };
  }
  if (!key) return { status: 'ok' };
  if (!confirmDelete) {
    found.dkim = key;
    return { status: 'skipped', code: 'dkim_delete_unconfirmed' };
  }
  await deleteDkim(cfg, domain);
  return { status: 'changed', from: key.selector, to: null };
}

const sameLimit = (a, b) => !!a && !!b && a.value === b.value && a.frame === b.frame;
const noMailboxes = { mailboxes: 0, matching: 0, changed: 0, failed: 0, missing: 0 };

// R-10: each mailbox of the domain the panel knows gets its own limit, or the default. mailcow
// counts messages per SASL login; a domain limit would be one bucket the whole domain shares. Only
// this domain's mailboxes are read (with a longer timeout), and none when the panel has none there.
async function mailboxLimitsItem(cfg, domain, accounts, defaultLimit) {
  if (!accounts.length) return { status: 'ok', counts: noMailboxes };
  const onNode = new Map((await listMailboxes(cfg, { domain })).map((m) => [m.email, m]));
  const groups = new Map();
  let missing = 0;
  let matching = 0;
  for (const account of accounts) {
    const mailbox = onNode.get(account.email);
    if (!mailbox) {
      missing += 1;
      continue;
    }
    const wanted = account.override ?? defaultLimit;
    if (sameLimit(mailbox.rateLimit, wanted)) {
      matching += 1;
      continue;
    }
    const key = `${wanted.value}/${wanted.frame}`;
    if (!groups.has(key)) groups.set(key, { limit: wanted, emails: [] });
    groups.get(key).emails.push(account.email);
  }
  let changed = 0;
  const failed = [];
  let reason = null;
  for (const { limit, emails } of groups.values()) {
    for (let i = 0; i < emails.length; i += RATE_LIMIT_BATCH) {
      const result = await setMailboxRateLimit(cfg, emails.slice(i, i + RATE_LIMIT_BATCH), limit);
      changed += result.done.length;
      failed.push(...result.failed);
      reason ??= result.reason;
    }
  }
  const counts = { mailboxes: accounts.length - missing, matching, changed, failed: failed.length, missing };
  if (failed.length) {
    return { status: 'failed', code: 'mail_node_refused', ...(reason ? { detail: reason } : {}), counts, mailboxes: failed.slice(0, MAX_LISTED_MAILBOXES) };
  }
  return { status: changed ? 'changed' : 'ok', counts };
}

// What one domain's run needs: { domain, dkimMode, defaultLimit, accounts: [{ email, override }] }.
async function runDomain(cfg, input, { eopHost, relayhost, relayhosts, confirmDkimDelete, shared }) {
  const list = itemList(shared);
  const found = {};
  await list.step('domain_relayhost', input.domain, async () => {
    const id = eopHost ? (await relayhost()).id : null;
    return domainRelayhostItem(cfg, input.domain, id, relayhosts);
  });
  await list.step('dkim', input.domain, () => dkimItem(cfg, input.domain, input.dkimMode, confirmDkimDelete, found));
  await list.step('mailbox_limits', input.domain, () => mailboxLimitsItem(cfg, input.domain, input.accounts, input.defaultLimit));
  return { domain: input.domain, items: list.items, dkim: found.dkim ?? null };
}

// After <EOP_HOST> changed: the TLS entry the panel made for the previous host goes; its relayhost
// goes only once no domain and no mailbox sends through it (the domains of this run were moved to the
// new one already; the panel never moves a domain it does not know).
async function previousHostItems(cfg, list, eopHost, owned) {
  for (const old of owned.tls.filter((e) => e.dest !== eopHost)) {
    await list.step('previous_tls_policy', old.dest, async () => {
      const entry = (await listTlsPolicies(cfg)).find((p) => p.id === old.id && p.dest === old.dest);
      if (entry) await deleteTlsPolicy(cfg, entry.id);
      owned.tls = owned.tls.filter((e) => e.id !== old.id);
      return entry ? { status: 'changed', from: describePolicy(entry.policy, entry.parameters), to: null } : { status: 'ok' };
    });
  }
  for (const old of owned.relayhosts.filter((e) => e.hostname !== eopHost)) {
    await list.step('previous_relayhost', old.hostname, async () => {
      const entry = (await listRelayhosts(cfg)).find((r) => r.id === old.id);
      if (!entry) {
        owned.relayhosts = owned.relayhosts.filter((e) => e.id !== old.id);
        return { status: 'ok' };
      }
      if (entry.usedByDomains.length || entry.usedByMailboxes.length) {
        return {
          status: 'skipped', code: 'relayhost_in_use',
          current: [...entry.usedByDomains, ...(entry.usedByMailboxes.length ? [`${entry.usedByMailboxes.length} mailboxes`] : [])].join(', '),
        };
      }
      await deleteRelayhost(cfg, entry.id);
      owned.relayhosts = owned.relayhosts.filter((e) => e.id !== old.id);
      return { status: 'changed', from: describeRelayhost(entry), to: null };
    });
  }
}

function memo(fn) {
  let promise = null;
  return () => {
    promise ??= fn().catch((err) => {
      promise = null;
      throw err;
    });
    return promise;
  };
}

// One run over the node, the given domains, or both. input: { eop, panelIps, domains, node: whether
// to run the node items, confirmDkimDelete, owned: what the panel made on the node before (TLS
// entry, relayhost, fail2ban addresses, forwarding hosts), ranges: the EOP ranges for the forwarding
// hosts (the static list unless a test gives others) }. Answers the items and the updated `owned` to
// keep. Never touches the panel's database: the stand runs it against a mailcow without a panel.
export async function runApply(cfg, {
  eop, panelIps = [], domains = [], node = true, confirmDkimDelete = false, owned: ownedBefore = {}, ranges = EOP_RANGES,
}) {
  const owned = { ...EMPTY_OWNED, ...ownedBefore };
  const shared = { down: null, timeouts: 0 };
  const eopHost = eop.eopHost || null;
  const relayhost = memo(() => ensureRelayhost(cfg, eopHost, owned));
  const relayhosts = memo(() => listRelayhosts(cfg));
  let nodeItems = null;
  const list = itemList(shared);
  if (node) {
    if (!eopHost) {
      await list.step('tls_policy', null, async () => ({ status: 'skipped', code: 'eop_host_missing', ...(await currentTls(cfg, owned)) }));
      await list.step('relayhost', null, async () => ({ status: 'skipped', code: 'eop_host_missing', ...(await currentRelayhost(cfg, owned)) }));
    } else {
      await list.step('tls_policy', eopHost, () => tlsPolicyItem(cfg, { ...eop, eopHost }, owned));
      await list.step('relayhost', eopHost, async () => {
        const { id, ...result } = await relayhost();
        return { ...result, to: result.to ?? id };
      });
    }
    if (!panelIps.length && !owned.fail2ban.length) list.skip('fail2ban', null, 'panel_ips_missing');
    else await list.step('fail2ban', panelIps.join(', ') || null, () => fail2banItem(cfg, panelIps, owned));
    await list.step('prefilter', null, () => prefilterCheck(cfg));
    const rule = list.items.at(-1).status;
    const rangeList = eopRangeList(ranges);
    if (!rangeList) list.skip('forwarding_hosts', null, 'eop_ranges_invalid');
    else await list.step('forwarding_hosts', rangeList.version, () => forwardingHostsItem(cfg, rangeList, owned, { rule }));
    nodeItems = list.items;
  }
  const domainResults = [];
  for (const input of domains) {
    domainResults.push(await runDomain(cfg, input, { eopHost, relayhost, relayhosts, confirmDkimDelete, shared }));
  }
  if (node && eopHost) await previousHostItems(cfg, list, eopHost, owned);
  return { node: nodeItems, domains: domainResults, owned };
}

// The spam filing rule alone (its own action: it restarts Dovecot).
export async function runPrefilterApply(cfg) {
  const list = itemList({ down: null });
  await list.step('prefilter', null, () => prefilterItem(cfg));
  return list.items[0];
}

// The forwarding hosts alone, right after the spam filing rule was put in place by its own action:
// they waited for it. `owned` is updated in place.
async function runForwardingHostsApply(cfg, owned, ranges) {
  const list = itemList({ down: null });
  const rangeList = eopRangeList(ranges);
  if (!rangeList) list.skip('forwarding_hosts', null, 'eop_ranges_invalid');
  else await list.step('forwarding_hosts', rangeList.version, () => forwardingHostsItem(cfg, rangeList, owned, { rule: 'ok' }));
  return list.items[0];
}

// --- The panel's side: inputs, results, journal ------------------------------------------------

// The send limit a mailbox gets when nobody set its own: the domain's, else the EOP settings',
// messages per hour.
export function defaultRateLimit(eop, domainLimit) {
  return { value: domainLimit ?? eop.sendLimitPerHour, frame: 'h' };
}

// The limit a new mailbox of the domain gets.
export async function newMailboxRateLimit(domain) {
  const [eop, { rows }] = await Promise.all([
    getEopSettings(),
    query('SELECT mailbox_send_limit FROM mail_node_domains WHERE domain = $1', [domain]),
  ]);
  return defaultRateLimit(eop, rows[0]?.mailbox_send_limit ?? null);
}

const overrideOf = (row) => (row.node_rl_value ? { value: row.node_rl_value, frame: row.node_rl_frame } : null);

// The panel's mailboxes on this node, one per address: an address the panel holds twice (two rows
// for one mailcow mailbox) takes the administrator's limit if one of the rows has it.
function uniqueAccounts(rows, cfg) {
  const byEmail = new Map();
  for (const row of rows) {
    if (String(row.imap_host ?? '').trim().toLowerCase() !== cfg.mailHost) continue;
    const seen = byEmail.get(row.email);
    if (!seen || (!seen.override && overrideOf(row))) byEmail.set(row.email, { email: row.email, override: overrideOf(row) });
  }
  return [...byEmail.values()];
}

// Each domain's run input from the panel's rows: its DKIM mode and default limit, and the panel's
// mailboxes on it that live on this node.
async function domainInputs(cfg, eop, domains) {
  if (!domains.length) return [];
  const [{ rows }, { rows: accounts }] = await Promise.all([
    query('SELECT domain, dkim_mode, mailbox_send_limit FROM mail_node_domains WHERE domain = ANY($1::text[])', [domains]),
    query(`SELECT lower(email_address) AS email, imap_host, node_rl_value, node_rl_frame
             FROM email_accounts WHERE mail_node = true ORDER BY lower(email_address)`),
  ]);
  const byDomain = new Map(rows.map((row) => [row.domain, row]));
  return domains.filter((domain) => byDomain.has(domain)).map((domain) => {
    const row = byDomain.get(domain);
    return {
      domain,
      dkimMode: row.dkim_mode ?? eop.dkimMode,
      defaultLimit: defaultRateLimit(eop, row.mailbox_send_limit),
      accounts: uniqueAccounts(accounts.filter((a) => a.email.split('@')[1] === domain), cfg),
    };
  });
}

// The node's last result: { at, items }, and `owned`, what the panel itself made on the node.
export async function getNodeApplyResult() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [APPLY_PROVIDER]);
  return rows[0]?.config ?? null;
}

// Merged into the stored row: a result without `owned` keeps the stored one.
async function saveNodeResult(result) {
  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = integration_config.config || EXCLUDED.config, updated_at = NOW()
  `, [APPLY_PROVIDER, result]);
}

async function saveDomainResult({ domain, items, dkim }, at) {
  const bound = items.find((i) => i.item === 'domain_relayhost' && (i.status === 'ok' || i.status === 'changed'));
  await query(`
    UPDATE mail_node_domains
       SET apply_result = $2, applied_at = $3, relayhost_id = COALESCE($4, relayhost_id), updated_at = NOW()
     WHERE domain = $1
  `, [domain, { items, dkim }, at, bound ? bound.to : null]);
}

// The journal entry of a run that changed or failed something: which items, with what they were
// and became (none of it secret: hosts, policies, selectors, counts). Nothing for a run that found
// everything in place.
// actor (services/actor.js) names who asked when it is not a route's user (the panel CLI).
function journal({ userId, actor = null, trigger, scope, domain, items }) {
  const changed = items.filter((i) => i.status === 'changed')
    .map(({ item, target, from, to, counts }) => ({ item, target, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(counts ? { counts } : {}) }));
  // A failed item that changed something first (forwarding hosts added before a refusal) says what.
  const failed = items.filter((i) => i.status === 'failed')
    .map(({ item, target, code, from, to }) => ({ item, target, code, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }));
  if (!changed.length && !failed.length) return;
  recordAudit(auditOf(actor ?? { userId }, {
    action: 'mail_node.applied',
    details: { scope, ...(domain ? { domain } : {}), trigger, changed, failed },
  }));
}

// The rule's state as a run's prefilter item shows it (a failed item tells nothing new).
async function keepSpamRuleState(item) {
  if (!item) return;
  if (item.status === 'ok' || item.status === 'changed') await saveSpamRuleState({ state: 'ok' });
  else if (item.status === 'pending' && item.rule) await saveSpamRuleState({ state: item.rule });
}

// Runs never overlap: two at once could each add the relayhost.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const notConfigured = () => new MailNodeError('mail_node_not_configured', 'The mail node is not set up', 409);

// "Apply" for the node and every domain the panel knows that the node lists. Answers the node's
// items and each domain's result. actor: as for applyDomain.
export function applyNode({ userId, actor = null, trigger = 'manual' }) {
  return serialized(async () => {
    const cfg = await getMailNodeConfig();
    if (!cfg) throw notConfigured();
    const eop = await getEopSettings();
    const stored = await getNodeApplyResult();
    const { rows } = await query('SELECT domain FROM mail_node_domains ORDER BY domain');
    let onNode = [];
    try {
      onNode = (await listDomains(cfg)).map((d) => d.domain);
    } catch (err) {
      if (!(err instanceof MailNodeError)) throw err;
    }
    const known = rows.map((r) => r.domain).filter((d) => onNode.includes(d));
    const result = await runApply(cfg, {
      eop, panelIps: cfg.panelIps, domains: await domainInputs(cfg, eop, known), node: true, owned: stored?.owned ?? {},
    });
    const at = new Date().toISOString();
    await saveNodeResult({ at, items: result.node, owned: result.owned });
    await keepSpamRuleState(result.node.find((i) => i.item === 'prefilter'));
    for (const d of result.domains) await saveDomainResult(d, at);
    journal({ userId, actor, trigger, scope: 'node', items: [...result.node, ...result.domains.flatMap((d) => d.items)] });
    return { at, node: result.node, domains: result.domains };
  });
}

// "Apply" for one domain the panel knows. confirmDkimDelete: the administrator confirmed deleting
// mailcow's DKIM key of a domain the tenant signs for. A relayhost it has to add is recorded as the
// panel's, like a node run's.
export function applyDomain({ domain, userId, actor = null, trigger = 'manual', confirmDkimDelete = false }) {
  return serialized(async () => {
    const cfg = await getMailNodeConfig();
    if (!cfg) throw notConfigured();
    const eop = await getEopSettings();
    const [input] = await domainInputs(cfg, eop, [domain]);
    if (!input) throw new MailNodeError('domain_not_found', 'The panel does not know this domain', 404);
    const stored = await getNodeApplyResult();
    const result = await runApply(cfg, { eop, domains: [input], node: false, confirmDkimDelete, owned: stored?.owned ?? {} });
    const at = new Date().toISOString();
    const [done] = result.domains;
    if (JSON.stringify(result.owned) !== JSON.stringify({ ...EMPTY_OWNED, ...(stored?.owned ?? {}) })) {
      await saveNodeResult({ owned: result.owned });
    }
    await saveDomainResult(done, at);
    journal({ userId, actor, trigger, scope: 'domain', domain, items: done.items });
    return { at, ...done };
  });
}

// The node's stored items with the fresh ones in place of the same items (in their places), the
// others kept.
function replaceItems(stored, fresh) {
  const names = new Set(fresh.map((i) => i.item));
  const kept = stored.map((i) => (names.has(i.item) ? fresh.find((f) => f.item === i.item) : i));
  return [...kept, ...fresh.filter((f) => !stored.some((i) => i.item === f.item))];
}

// The spam filing rule, by its own action. Once it is in place the forwarding hosts that waited for
// it follow (R-12). The node's stored result gets the new items. Answers the prefilter item, with
// the forwarding hosts item's status and code in `forwardingHosts` (null when they did not run).
// actor: as for applyDomain.
export function applyPrefilter({ userId, actor = null, ranges = EOP_RANGES }) {
  return serialized(async () => {
    const cfg = await getMailNodeConfig();
    if (!cfg) throw notConfigured();
    const at = new Date().toISOString();
    const item = { ...(await runPrefilterApply(cfg)), at };
    const stored = await getNodeApplyResult();
    const owned = { ...EMPTY_OWNED, ...(stored?.owned ?? {}) };
    const fresh = [item];
    if (item.status === 'ok' || item.status === 'changed') fresh.push(await runForwardingHostsApply(cfg, owned, ranges));
    const items = replaceItems(stored?.items ?? [], fresh);
    await saveNodeResult({ at: stored?.at ?? at, items, owned });
    await keepSpamRuleState(item);
    journal({ userId, actor, trigger: 'manual', scope: 'prefilter', items: fresh });
    const fwd = fresh[1];
    return { ...item, forwardingHosts: fwd ? { status: fwd.status, ...(fwd.code ? { code: fwd.code } : {}) } : null };
  });
}

// A run started by itself, after a change elsewhere: its failures stay in the stored result and the
// journal, and never fail the change that started it.
export async function applyQuietly(run) {
  try {
    return await run();
  } catch (err) {
    console.error('Applying the mail node settings failed:', err?.code || err?.name || 'error');
    return null;
  }
}

// The same, started after the answer is sent: a save never waits for a node that does not answer.
// The result shows on the next load of the screen. Returns the run's promise (for tests).
export function applyInBackground(run) {
  return new Promise((resolve) => {
    setImmediate(() => { applyQuietly(run).then(resolve); });
  });
}
