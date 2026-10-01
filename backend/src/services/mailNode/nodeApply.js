import { query } from '../db.js';
import { recordAudit } from '../auditLog.js';
import {
  MailNodeError,
  addDkim,
  addRelayhost,
  addTlsPolicy,
  deleteDkim,
  deleteTlsPolicy,
  editTlsPolicy,
  enableRelayhost,
  getDkim,
  getDomain,
  getFail2banWhitelist,
  getMailNodeConfig,
  getPrefilter,
  listDomains,
  listMailboxes,
  listRelayhosts,
  listTlsPolicies,
  setDomainRelayhost,
  setMailboxRateLimit,
  setPrefilter,
  whitelistFail2ban,
} from './mailcow.js';
import { getEopSettings } from './eopSettings.js';

// "Apply settings": the panel puts its settings on the mail node through the mailcow API
// (eop-panel-requirements.md, R-07 ... R-11, R-13). Every item is read first and written only when
// the node differs, so applying again changes nothing; each item reports what it found:
// - ok: the node had it already;
// - changed: the panel changed it now (from / to say what);
// - failed: the node refused or could not be asked (code, and the node's own words in detail);
// - skipped: a setting it needs is empty, or the change waits for an administrator (code);
// - pending: the spam filing rule differs and is applied only by its own action, since writing it
//   restarts Dovecot and drops every IMAP session.
//
// The node items: the TLS Policy Map entry and the relayhost for <EOP_HOST>, the fail2ban whitelist
// for the panel's addresses and the check of the spam filing rule. The items of each domain: the
// domain's relayhost, its DKIM key as the DKIM mode wants it and the send limit of each of its
// mailboxes the panel knows. The global relayhost in extra.cf is the host's (runbook): the panel
// sets and reports only the domain's.
//
// It runs when an administrator presses "Apply" (the node with every domain the panel knows, or one
// domain), and by itself after the EOP or node settings change and when a domain is added, adopted
// or starts its onboarding over. A run started by itself never deletes a DKIM key and never writes
// the spam filing rule. Runs never overlap. The last result is kept: the node's in integration_config
// ('mail_node_apply'), each domain's in mail_node_domains.apply_result.

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

// --- The spam filing rule (R-11) -------------------------------------------------------------

// EOP files nothing into Junk for a recipient outside the cloud: it stamps its verdict into
// X-Forefront-Antispam-Report ("NAME:value;" fields, folded over lines at times) and the node files
// the message. SFV is the verdict: SPM spam, SKS marked spam by a mail flow rule, SKB a blocked
// sender; CAT the category: SPM and HSPM spam, PHSH and HPHSH (HPHISH) phishing, BULK bulk mail
// (owner's decision D-11). SFV:SKQ is a message released from quarantine and never goes to Junk.
// Each value must be a whole field: after the start of the header or a ";" (with any blank the
// unfolding left) and before ";" or the end, so "SFV:SPMX" or "XSFV:SPM" match nothing.
export const PREFILTER_SFV = Object.freeze(['SPM', 'SKS', 'SKB']);
export const PREFILTER_CAT = Object.freeze(['SPM', 'HSPM', 'PHSH', 'HPHSH', 'HPHISH', 'BULK']);
const HEADER = 'X-Forefront-Antispam-Report';
const field = (name, values) => {
  const value = values.length === 1 ? values[0] : `(${values.join('|')})`;
  return `(^|;)[[:space:]]*${name}:${value}[[:space:]]*(;|$)`;
};

const REQUIRE_BEGIN = '# BEGIN MailExpert: extensions of the EOP verdict rule (managed by MailExpert, do not edit)';
const REQUIRE_END = '# END MailExpert: extensions';
const RULE_BEGIN = '# BEGIN MailExpert: EOP verdicts to Junk (managed by MailExpert, do not edit)';
const RULE_END = '# END MailExpert: EOP verdicts';

const REQUIRE_BLOCK = [REQUIRE_BEGIN, 'require ["fileinto", "regex"];', REQUIRE_END].join('\n');
// stop: a message filed as spam runs no later script: no mailbox filter forwards it or answers it
// with a vacation reply.
const RULE_BLOCK = [
  RULE_BEGIN,
  'if allof (',
  '  anyof (',
  `    header :regex "${HEADER}" "${field('SFV', PREFILTER_SFV)}",`,
  `    header :regex "${HEADER}" "${field('CAT', PREFILTER_CAT)}"`,
  '  ),',
  `  not header :regex "${HEADER}" "${field('SFV', ['SKQ'])}"`,
  ') {',
  '  fileinto "Junk";',
  '  stop;',
  '}',
  RULE_END,
].join('\n');

function withoutBlock(text, begin, end) {
  const lines = text.split('\n');
  const from = lines.indexOf(begin);
  if (from < 0) return text;
  const to = lines.indexOf(end, from);
  if (to < 0) return text;
  return [...lines.slice(0, from), ...lines.slice(to + 1)].join('\n');
}

// The prefilter with the panel's rule: whatever else it holds stays, between the rule's `require`
// at the top (Sieve wants every require before the first command) and the rule at the end. Built
// from its own output it gives the same text, so an unchanged rule is never written again.
export function buildPrefilter(existing) {
  const text = String(existing ?? '').replace(/\r\n?/g, '\n');
  const rest = withoutBlock(withoutBlock(text, REQUIRE_BEGIN, REQUIRE_END), RULE_BEGIN, RULE_END)
    .replace(/^\s*\n/, '').replace(/\s+$/, '');
  return `${[REQUIRE_BLOCK, rest, RULE_BLOCK].filter(Boolean).join('\n\n')}\n`;
}

// --- One run ---------------------------------------------------------------------------------

// The items of one run (the node's or one domain's), sharing with the rest of the run a node that
// stopped answering: once a call finds it unreachable or refusing the key, the items after it fail
// with the same code without waiting for the node again.
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
        if (err.code === 'mail_node_unreachable' || err.code === 'mail_node_auth') shared.down = err.code;
        const detail = err.code === 'mail_node_refused' ? err.message.replace(/^The mail node refused:\s*/, '') : null;
        items.push({ item, target, status: 'failed', code: err.code, ...(detail ? { detail } : {}) });
        return null;
      }
    },
  };
}

const describePolicy = (policy, parameters) => [policy, parameters].filter(Boolean).join(' ');

// R-07: the entry for <EOP_HOST>, the bare next hop exactly as the relayhost names it.
async function tlsPolicyItem(cfg, { eopHost, tlsPolicy, tlsPolicyParameters }) {
  const parameters = tlsPolicyParameters ?? '';
  const entry = (await listTlsPolicies(cfg)).find((p) => p.dest === eopHost);
  const current = entry ? describePolicy(entry.policy, entry.parameters) : null;
  if (tlsPolicy === 'default') {
    if (!entry) return { status: 'ok', to: 'default' };
    await deleteTlsPolicy(cfg, entry.id);
    return { status: 'changed', from: current, to: 'default' };
  }
  const wanted = describePolicy(tlsPolicy, parameters);
  if (entry && entry.active && entry.policy === tlsPolicy && entry.parameters.trim() === parameters) {
    return { status: 'ok', to: wanted };
  }
  const attr = { dest: eopHost, policy: tlsPolicy, parameters };
  if (entry) await editTlsPolicy(cfg, entry.id, attr);
  else await addTlsPolicy(cfg, attr);
  return { status: 'changed', from: entry ? `${current}${entry.active ? '' : ' (inactive)'}` : null, to: wanted };
}

// R-08: a relayhost entry for <EOP_HOST> without a login (one with a username would turn SASL on).
// Returns its id.
async function ensureRelayhost(cfg, eopHost) {
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
  return { status: 'changed', id: entry.id, from: null, to: eopHost };
}

// R-13: the panel's addresses in the fail2ban whitelist; nothing else of fail2ban changes.
async function fail2banItem(cfg, panelIps) {
  const listed = await getFail2banWhitelist(cfg);
  const missing = panelIps.filter((network) => !listed.includes(network));
  if (!missing.length) return { status: 'ok' };
  await whitelistFail2ban(cfg, missing);
  return { status: 'changed', to: missing.join(', ') };
}

// R-11, the check only: the general apply never writes the rule.
async function prefilterCheck(cfg) {
  const current = await getPrefilter(cfg);
  return buildPrefilter(current) === current ? { status: 'ok' } : { status: 'pending', code: 'prefilter_differs' };
}

async function prefilterItem(cfg) {
  const current = await getPrefilter(cfg);
  const wanted = buildPrefilter(current);
  if (wanted === current) return { status: 'ok' };
  const { restarted } = await setPrefilter(cfg, wanted);
  return { status: 'changed', ...(restarted ? {} : { code: 'dovecot_restart_failed' }) };
}

// R-08: the domain sends through the relayhost of <EOP_HOST>.
async function domainRelayhostItem(cfg, domain, relayhostId) {
  const onNode = await getDomain(cfg, domain);
  if (!onNode) throw new MailNodeError('domain_not_on_node', 'The mail node has no such domain', 404);
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

// R-10: each mailbox of the domain the panel knows gets its own limit, or the default. mailcow
// counts messages per SASL login; a domain limit would be one bucket the whole domain shares.
async function mailboxLimitsItem(cfg, accounts, defaultLimit, nodeMailboxes) {
  const onNode = new Map((await nodeMailboxes()).map((m) => [m.email, m]));
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
async function runDomain(cfg, input, { eopHost, relayhost, nodeMailboxes, confirmDkimDelete, shared }) {
  const list = itemList(shared);
  const found = {};
  if (!eopHost) {
    list.skip('domain_relayhost', input.domain, 'eop_host_missing');
  } else {
    await list.step('domain_relayhost', input.domain, async () => {
      const entry = await relayhost();
      return domainRelayhostItem(cfg, input.domain, entry.id);
    });
  }
  await list.step('dkim', input.domain, () => dkimItem(cfg, input.domain, input.dkimMode, confirmDkimDelete, found));
  await list.step('mailbox_limits', input.domain, () => mailboxLimitsItem(cfg, input.accounts, input.defaultLimit, nodeMailboxes));
  return { domain: input.domain, items: list.items, dkim: found.dkim ?? null };
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
// to run the node items, confirmDkimDelete }. Never touches the panel's database: the stand runs
// it against a mailcow without a panel.
export async function runApply(cfg, { eop, panelIps = [], domains = [], node = true, confirmDkimDelete = false }) {
  const shared = { down: null };
  const eopHost = eop.eopHost || null;
  const relayhost = memo(() => ensureRelayhost(cfg, eopHost));
  const nodeMailboxes = memo(() => listMailboxes(cfg));
  let nodeItems = null;
  if (node) {
    const list = itemList(shared);
    if (!eopHost) {
      list.skip('tls_policy', null, 'eop_host_missing');
      list.skip('relayhost', null, 'eop_host_missing');
    } else {
      await list.step('tls_policy', eopHost, () => tlsPolicyItem(cfg, { ...eop, eopHost }));
      await list.step('relayhost', eopHost, async () => {
        const { id, ...result } = await relayhost();
        return { ...result, to: result.to ?? id };
      });
    }
    if (!panelIps.length) list.skip('fail2ban', null, 'panel_ips_missing');
    else await list.step('fail2ban', panelIps.join(', '), () => fail2banItem(cfg, panelIps));
    await list.step('prefilter', null, () => prefilterCheck(cfg));
    nodeItems = list.items;
  }
  const domainResults = [];
  for (const input of domains) {
    domainResults.push(await runDomain(cfg, input, { eopHost, relayhost, nodeMailboxes, confirmDkimDelete, shared }));
  }
  return { node: nodeItems, domains: domainResults };
}

// The spam filing rule alone (its own action: it restarts Dovecot).
export async function runPrefilterApply(cfg) {
  const list = itemList({ down: null });
  await list.step('prefilter', null, () => prefilterItem(cfg));
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
      accounts: accounts
        .filter((a) => a.email.split('@')[1] === domain && String(a.imap_host ?? '').trim().toLowerCase() === cfg.mailHost)
        .map((a) => ({ email: a.email, override: overrideOf(a) })),
    };
  });
}

export async function getNodeApplyResult() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [APPLY_PROVIDER]);
  return rows[0]?.config ?? null;
}

async function saveNodeResult(result) {
  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
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
function journal({ userId, trigger, scope, domain, items }) {
  const changed = items.filter((i) => i.status === 'changed')
    .map(({ item, target, from, to, counts }) => ({ item, target, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(counts ? { counts } : {}) }));
  const failed = items.filter((i) => i.status === 'failed').map(({ item, target, code }) => ({ item, target, code }));
  if (!changed.length && !failed.length) return;
  recordAudit({
    actorUserId: userId, action: 'mail_node.applied',
    details: { scope, ...(domain ? { domain } : {}), trigger, changed, failed },
  });
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
// items and each domain's result.
export function applyNode({ userId, trigger = 'manual' }) {
  return serialized(async () => {
    const cfg = await getMailNodeConfig();
    if (!cfg) throw notConfigured();
    const eop = await getEopSettings();
    const { rows } = await query('SELECT domain FROM mail_node_domains ORDER BY domain');
    let onNode = [];
    try {
      onNode = (await listDomains(cfg)).map((d) => d.domain);
    } catch (err) {
      if (!(err instanceof MailNodeError)) throw err;
    }
    const known = rows.map((r) => r.domain).filter((d) => onNode.includes(d));
    const result = await runApply(cfg, { eop, panelIps: cfg.panelIps, domains: await domainInputs(cfg, eop, known), node: true });
    const at = new Date().toISOString();
    await saveNodeResult({ at, items: result.node });
    for (const d of result.domains) await saveDomainResult(d, at);
    journal({ userId, trigger, scope: 'node', items: [...result.node, ...result.domains.flatMap((d) => d.items)] });
    return { at, node: result.node, domains: result.domains };
  });
}

// "Apply" for one domain the panel knows. confirmDkimDelete: the administrator confirmed deleting
// mailcow's DKIM key of a domain the tenant signs for.
export function applyDomain({ domain, userId, trigger = 'manual', confirmDkimDelete = false }) {
  return serialized(async () => {
    const cfg = await getMailNodeConfig();
    if (!cfg) throw notConfigured();
    const eop = await getEopSettings();
    const [input] = await domainInputs(cfg, eop, [domain]);
    if (!input) throw new MailNodeError('domain_not_found', 'The panel does not know this domain', 404);
    const result = await runApply(cfg, { eop, domains: [input], node: false, confirmDkimDelete });
    const at = new Date().toISOString();
    const [done] = result.domains;
    await saveDomainResult(done, at);
    journal({ userId, trigger, scope: 'domain', domain, items: done.items });
    return { at, ...done };
  });
}

// The spam filing rule, by its own action. The node's stored result gets the new prefilter item.
export function applyPrefilter({ userId }) {
  return serialized(async () => {
    const cfg = await getMailNodeConfig();
    if (!cfg) throw notConfigured();
    const item = { ...(await runPrefilterApply(cfg)), at: new Date().toISOString() };
    const stored = await getNodeApplyResult();
    const items = [...(stored?.items ?? []).filter((i) => i.item !== 'prefilter'), item];
    await saveNodeResult({ at: stored?.at ?? new Date().toISOString(), items });
    journal({ userId, trigger: 'manual', scope: 'prefilter', items: [item] });
    return item;
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
