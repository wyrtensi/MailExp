import { query, withTransaction } from '../db.js';
import { JobError, enqueueJob, registerJobKind } from '../jobQueue.js';
import { insertAuditEntries } from '../auditLog.js';
import { redactEmail } from '../../utils/redact.js';
import { DOMAIN_STATES, SYSTEM_ACTOR, parseCnameTarget } from '../mailNode/domains.js';
import { getEopSettings, tenantDriverActive } from '../mailNode/eopSettings.js';
import { MailNodeError, getMailNodeConfig, listDomainAliases, listMailboxes, parseHostName } from '../mailNode/mailcow.js';
import { getTenantDriver, tenantOf } from './driver.js';
import { TenantError, asRows } from './exoRunner.js';
import { failureOf, tenantContext } from './tenantJobs.js';

// Stage 7b: the tenant driver takes each mail node domain through its tenant steps and keeps the
// DBEB recipient mirror, one job per domain (kind tenant_domain_sync on the durable queue,
// services/jobQueue.js). The job is a reconciler, not a list of steps: every run reads Graph and
// EXO first and writes only what is missing, and the domain's state moves on only after a read
// back confirms the step. A write may meet a 503 that was applied (Graph) or run twice after a
// reconnect (the worker): reading first makes a repeat harmless, and "exists" / "not found"
// answers of a write count as done.
//
// What a run does, in order, each part only once the one before it holds:
//   R-23  the domain in the tenant (Graph POST /domains, from any state, so its verification TXT
//         is known early); once a person confirmed "DNS is right" (dns_ok), POST /verify, then the
//         Email service (PATCH) and the MX of serviceConfigurationRecords: dns_ok -> tenant_verified
//   R-24  Get-AcceptedDomain until the tenant shows the domain (follow-up runs 1, 2, 4 ... 10
//         minutes apart), then Set-AcceptedDomain InternalRelay while the domain is not
//         'authoritative': tenant_verified -> internal_relay. A domain verified in the tenant is
//         kept on Internal Relay whatever the panel's state (a restarted onboarding included). One
//         that was in the tenant before the driver found it and is Authoritative there is left
//         alone with a warning until an administrator approves Internal Relay
//         (internal_relay_approved_at)
//   R-25  the domain in the Outbound connector's RecipientDomains (D-9): internal_relay ->
//         connector_ready. 'ready' stays a person's step: the owner switches the MX first
//   R-26  EOP DKIM when the domain's DKIM mode is 'eop' (D-1): the config made disabled, its
//         selector CNAMEs kept for the DNS check, enabling tried on every run until it succeeds
//   R-29  the recipient mirror in internal_relay and later: a mail contact (D-5) for every address
//         the node takes mail for, at most CONTACT_BATCH writes a run; a run that finds the mirror
//         complete on a 'ready' domain whose connector holds it makes it Authoritative (D-4): ready
//         -> authoritative, unless the domain is held on Internal Relay (hold_internal_relay, on by
//         default until experiment 8 passes)
//
// Throttling (exo_throttled, graph_throttled) keeps what the run did and queues the job again
// later (JobError retry with the wait, the queue's backoff otherwise). Other failures are kept in
// the domain's tenant_sync with their code; the next run (the poll's slot, a button) tries again.

export const DOMAIN_SYNC_KIND = 'tenant_domain_sync';
// The steps the driver confirms itself; a person's "Done" on them is refused while it runs.
export const DRIVER_STEPS = Object.freeze(['tenant_verified', 'internal_relay', 'connector_ready']);
// The states whose domain is an accepted domain the mirror keeps.
export const MIRRORED_STATES = Object.freeze(['internal_relay', 'connector_ready', 'ready', 'authoritative']);
export const CONTACT_BATCH = 25;
const MAX_ATTEMPTS = 6;
const ACCEPTED_FIRST_WAIT_MS = 60 * 1000;
const ACCEPTED_MAX_WAIT_MS = 10 * 60 * 1000;
// A run that wrote contacts on a 'ready' domain looks again this soon: the next one may find the
// mirror complete and make the domain Authoritative.
const SETTLE_MS = 60 * 1000;
// A batch with more left goes on at once.
const NEXT_BATCH_MS = 2000;
// Another run of the same domain still going: this one ends and a new one is queued this much later.
const BUSY_RETRY_MS = 30 * 1000;
// A run's hold on its domain older than this is a run that died.
const LOCK_STALE_MINUTES = 30;
const LIST_MAX = 50;
const THROTTLED = new Set(['exo_throttled', 'graph_throttled']);

const at = (s) => DOMAIN_STATES.indexOf(s);
const reached = (state, step) => at(state) >= at(step);
const lower = (value) => String(value ?? '').trim().toLowerCase();
const smtp = (value) => lower(value).replace(/^smtp:/, '');
const domainOf = (address) => address.slice(address.lastIndexOf('@') + 1);

// A throttled call ends the run: the work done so far is kept and the job is queued again.
class Throttled extends Error {
  constructor(err) {
    super(err.message);
    this.code = err.code;
    this.retryAfterMs = err.retryAfterMs ?? null;
  }
}
function rethrowThrottled(err) {
  if (err instanceof TenantError && THROTTLED.has(err.code)) throw new Throttled(err);
}
const isTenant = (err, ...codes) => err instanceof TenantError && (!codes.length || codes.includes(err.code));
const graphStatus = (err, ...statuses) => err instanceof TenantError && statuses.includes(err.status);

// The wait before the next look at an accepted domain the tenant does not show yet.
export function acceptedWaitMs(polls) {
  return Math.min(ACCEPTED_MAX_WAIT_MS, ACCEPTED_FIRST_WAIT_MS * 2 ** Math.max(0, polls - 1));
}

// --- R-23: the domain in the tenant (Graph) ---------------------------------------------------------

async function graphDomain(graph, domain) {
  try {
    return await graph.request('GET', `/domains/${encodeURIComponent(domain)}`);
  } catch (err) {
    if (graphStatus(err, 404)) return null;
    throw err;
  }
}

const recordsOf = (answer) => (Array.isArray(answer?.value) ? answer.value : []);

// The MX hosts serviceConfigurationRecords gives (both forms: <domain>.mail.protection.outlook.com
// and *.mx.microsoft), lowest preference first.
export function mxOf(answer) {
  return recordsOf(answer)
    .filter((r) => lower(r.recordType) === 'mx')
    .sort((a, b) => (Number(a.preference) || 0) - (Number(b.preference) || 0))
    .map((r) => parseHostName(String(r.mailExchange ?? '').replace(/\.$/, '')))
    .filter((host, i, all) => host && all.indexOf(host) === i);
}

async function syncGraph({ session }, row, out) {
  const { graph } = session;
  const { domain } = row;
  const path = `/domains/${encodeURIComponent(domain)}`;
  const part = { ...(out.previous.graph ?? {}), at: out.at };
  delete part.error;
  delete part.verifyError;
  let found = await graphDomain(graph, domain);
  // A domain the tenant had before this panel's runs knew it (made by hand, another panel, or an
  // onboarding started over): its accepted domain type is not ours to change without approval.
  if (found && !out.previous.graph) part.preexisting = true;
  if (!found) {
    try {
      found = await graph.request('POST', '/domains', { body: { id: domain } });
      part.addedAt = out.at;
    } catch (err) {
      // Added by an earlier run whose answer was lost (a 503 may have been applied), or by hand.
      rethrowThrottled(err);
      if (!graphStatus(err, 400, 409, 503, 504) || !(found = await graphDomain(graph, domain))) throw err;
    }
  }
  part.present = true;
  part.verified = !!found?.isVerified;
  if (!part.verified) {
    const txt = recordsOf(await graph.request('GET', `${path}/verificationDnsRecords`))
      .find((r) => lower(r.recordType) === 'txt' && typeof r.text === 'string' && r.text.trim());
    part.verificationTxt = txt ? txt.text.trim() : null;
    if (part.verificationTxt) out.tenant.verificationTxt = part.verificationTxt;
    if (reached(row.state, 'dns_ok')) {
      try {
        found = await graph.request('POST', `${path}/verify`);
        part.verified = !!found?.isVerified;
      } catch (err) {
        rethrowThrottled(err);
        // The TXT is not visible to Microsoft yet: not a failure, the next run tries again.
        if (!graphStatus(err, 400)) throw err;
        part.verifyError = { code: 'domain_not_verified', message: String(err.message ?? '').slice(0, 300) };
      }
    }
  }
  if (part.verified) {
    part.verifiedAt = part.verifiedAt ?? out.at;
    const services = Array.isArray(found?.supportedServices) ? found.supportedServices : [];
    if (!services.includes('Email')) await graph.request('PATCH', path, { body: { supportedServices: [...services, 'Email'] } });
    part.email = true;
    const mx = mxOf(await graph.request('GET', `${path}/serviceConfigurationRecords`));
    part.mx = mx;
    if (mx.length) out.expectedMx = mx;
    if (row.state === 'dns_ok') out.advance('tenant_verified');
  }
  out.sync.graph = part;
  return part.verified;
}

// --- R-24: the accepted domain's type ----------------------------------------------------------------

async function readAccepted(exo, domain) {
  try {
    return asRows(await exo.run('get_accepted_domain', { domain }))[0] ?? null;
  } catch (err) {
    if (isTenant(err, 'exo_not_found')) return null;
    throw err;
  }
}

async function syncAccepted({ session }, row, out) {
  const { exo } = session;
  const { domain } = row;
  const before = out.previous.acceptedDomain ?? {};
  let found = await readAccepted(exo, domain);
  if (!found) {
    // The delay between Graph and Get-AcceptedDomain is not documented: look again soon.
    const polls = (Number(before.polls) || 0) + 1;
    out.sync.acceptedDomain = { at: out.at, visible: false, polls };
    out.followUp(acceptedWaitMs(polls));
    return null;
  }
  let type = found.DomainType ?? null;
  // A domain the tenant already had as Authoritative is never moved by itself: mail to it may rely
  // on that. It waits, with a warning, for an administrator's approval (Q2 of stage 7b).
  if (type === 'Authoritative' && row.state !== 'authoritative' && out.sync.graph?.preexisting && !row.internal_relay_approved_at) {
    out.sync.acceptedDomain = { at: out.at, visible: true, type, polls: 0, ok: false, code: 'authoritative_in_tenant' };
    out.acceptedType = type;
    return null;
  }
  // Never Authoritative before the mirror is complete (R-24): a domain made Authoritative by
  // default, by hand, or marked ready without the tenant steps goes to Internal Relay.
  if (row.state !== 'authoritative' && type !== 'InternalRelay') {
    await exo.run('set_accepted_domain_internal_relay', { domain });
    found = await readAccepted(exo, domain);
    type = found?.DomainType ?? null;
  }
  out.sync.acceptedDomain = { at: out.at, visible: true, type, polls: 0 };
  if (type === 'InternalRelay' || type === 'Authoritative') out.acceptedType = type;
  if (type === 'InternalRelay' && out.state === 'tenant_verified') out.advance('internal_relay');
  return type;
}

// --- R-25: the Outbound connector ---------------------------------------------------------------------

const listOf = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).map((v) => lower(v)).filter(Boolean);

// The Outbound connector new domains go to: the one the settings name, else the only enabled
// OnPremises one. { connector } or { code }.
export function pickOutboundConnector(rows, name) {
  const all = asRows(rows);
  if (name) {
    const wanted = lower(name);
    const found = all.find((c) => lower(c.Name) === wanted || lower(c.Identity) === wanted);
    return found ? { connector: found } : { code: 'outbound_connector_not_found' };
  }
  const onPremises = all.filter((c) => lower(c.ConnectorType) === 'onpremises' && c.Enabled !== false);
  if (onPremises.length === 1) return { connector: onPremises[0] };
  return { code: onPremises.length ? 'outbound_connector_ambiguous' : 'outbound_connector_missing', names: onPremises.map((c) => String(c.Name)).slice(0, 10) };
}

const connectorHas = (connector, domain) => connector.AllAcceptedDomains === true || listOf(connector.RecipientDomains).includes(domain);
const guidOf = (connector) => {
  const id = lower(connector?.Guid);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
};

async function syncConnector({ session, settings }, row, out) {
  const { exo } = session;
  const { domain } = row;
  const picked = pickOutboundConnector(await exo.run('get_outbound_connectors'), settings.outboundConnector);
  if (!picked.connector) {
    out.sync.connector = { at: out.at, ok: false, code: picked.code, ...(picked.names ? { names: picked.names } : {}) };
    return false;
  }
  let connector = picked.connector;
  const name = String(connector.Name ?? connector.Identity);
  // The worker is given the connector's Guid: its EAC name may hold any character.
  const id = guidOf(connector);
  let added = false;
  if (!connectorHas(connector, domain)) {
    if (!id) {
      out.sync.connector = { at: out.at, ok: false, name, code: 'connector_guid_missing' };
      return false;
    }
    await exo.run('add_outbound_connector_domain', { connector: id, domain });
    added = true;
    connector = asRows(await exo.run('get_outbound_connectors')).find((c) => guidOf(c) === id) ?? connector;
  }
  const ok = connectorHas(connector, domain);
  out.sync.connector = { at: out.at, ok, name, ...(added ? { addedAt: out.at } : {}), ...(ok ? {} : { code: 'connector_domain_missing' }) };
  if (ok && out.state === 'internal_relay') out.advance('connector_ready');
  return ok;
}

// --- R-26: EOP DKIM -----------------------------------------------------------------------------------

async function readDkim(exo, domain) {
  try {
    return asRows(await exo.run('get_dkim_signing_config', { domain }))[0] ?? null;
  } catch (err) {
    if (isTenant(err, 'exo_not_found')) return null;
    throw err;
  }
}

async function syncDkim({ session }, row, out) {
  const { exo } = session;
  const { domain } = row;
  let config = await readDkim(exo, domain);
  if (!config) {
    try {
      await exo.run('new_dkim_signing_config', { domain });
    } catch (err) {
      if (!isTenant(err, 'exo_exists')) throw err;
    }
    config = await readDkim(exo, domain);
  }
  if (!config) {
    out.sync.dkim = { at: out.at, ok: false, code: 'dkim_config_missing' };
    return;
  }
  const selector1Cname = parseCnameTarget(String(config.Selector1CNAME ?? ''));
  const selector2Cname = parseCnameTarget(String(config.Selector2CNAME ?? ''));
  if (selector1Cname) out.tenant.dkimSelector1Cname = selector1Cname;
  if (selector2Cname) out.tenant.dkimSelector2Cname = selector2Cname;
  let enableError = null;
  if (config.Enabled !== true) {
    try {
      // Fails until both CNAMEs are published and seen by Microsoft: tried again on every run.
      await exo.run('enable_dkim_signing_config', { domain });
      config = (await readDkim(exo, domain)) ?? config;
    } catch (err) {
      rethrowThrottled(err);
      if (!isTenant(err)) throw err;
      enableError = failureOf(err);
    }
  }
  out.sync.dkim = {
    // Waiting for the CNAMEs is no failure: enableError says why it is not enabled yet.
    at: out.at, ok: true, enabled: config.Enabled === true, status: config.Status ?? null,
    selector1Cname, selector2Cname, ...(enableError ? { enableError } : {}),
  };
}

// --- R-29: the recipient mirror -----------------------------------------------------------------------

// The SMTP addresses of a recipient: its primary one and its proxy addresses.
function addressesOf(recipient) {
  const all = [smtp(recipient.PrimarySmtpAddress), ...listOf(recipient.EmailAddresses).filter((a) => a.startsWith('smtp:')).map(smtp)];
  return [...new Set(all.filter(Boolean))];
}

// The external address of a contact (D-7): the address itself (variant A) or <local>@<external
// domain> (variant B).
export function externalOf(address, externalDomain) {
  return externalDomain ? `${address.slice(0, address.lastIndexOf('@'))}@${externalDomain}` : address;
}

// What the mirror must change, from what the node takes mail for, the panel's rows and the
// tenant's recipients. Pure, so it is tested on its own.
//   mailboxes: the node's mailboxes of the domain ({ email, state }); aliases: its aliases
//   ({ address, active }); panel: the panel's mailboxes there ({ email, deleting }); recipients:
//   the tenant's (Get-Recipient rows). Returns { desired, create, retarget, remove, hide, present,
//   conflicts, catchAll, nodeAliases, nodeOnly, panelOnly, suspicious }. retarget: contacts of the
//   other D-7 variant, changed in place (Set-MailContact -ExternalEmailAddress), never removed and
//   made again: on an Authoritative domain that would reject the address in between.
//
// Aliases (the owner's decision after stage 7, section 5.14, which undoes the stage 7b
// clarification of D-16): everything goes through the panel, and the mirror covers only addresses
// the panel owns. An alias made by hand in mailcow gets no contact; nodeAliases lists the active
// ones for the administrators (once the domain is Authoritative, EOP rejects mail to them), and a
// contact the 7b mirror made for one is removed like any contact nobody needs.
export function planMirror({ domain, mailboxes, aliases, panel, recipients, externalDomain = null }) {
  const deleting = new Set(panel.filter((p) => p.deleting).map((p) => p.email));
  const desired = new Set();
  // Every mailbox that takes mail (active, or receiving without login), except a mailbox being
  // deleted: its contact goes first (BEFORE_NODE_DELETE).
  for (const m of mailboxes) if (m.state !== 0 && domainOf(m.email) === domain && !deleting.has(m.email)) desired.add(m.email);
  // An active catch-all only: a disabled one takes no mail (D-6).
  const catchAll = aliases.find((a) => a.active && a.address.startsWith('@'))?.address ?? null;
  const nodeAliases = [...new Set(aliases.filter((a) => a.active && !a.address.startsWith('@') && domainOf(a.address) === domain)
    .map((a) => a.address))].sort();
  const contacts = new Map();
  const taken = new Set();
  for (const r of recipients) {
    const own = addressesOf(r).filter((a) => domainOf(a) === domain);
    if (!own.length) continue;
    if (lower(r.RecipientTypeDetails) === 'mailcontact' && domainOf(smtp(r.PrimarySmtpAddress)) === domain) contacts.set(smtp(r.PrimarySmtpAddress), r);
    else own.forEach((a) => taken.add(a));
  }
  const create = [];
  const retarget = [];
  const remove = [];
  const hide = [];
  const present = [];
  for (const address of [...desired].sort()) {
    const contact = contacts.get(address);
    if (!contact) {
      // An address another recipient holds (a cloud mailbox, a group) already takes mail in the
      // tenant: no contact for it, reported.
      if (!taken.has(address)) create.push(address);
      continue;
    }
    if (smtp(contact.ExternalEmailAddress) !== externalOf(address, externalDomain)) {
      // Made for the other variant of D-7: changed in place, it keeps taking mail meanwhile.
      retarget.push(address);
      if (contact.HiddenFromAddressListsEnabled !== true) hide.push(address);
      continue;
    }
    present.push(address);
    if (contact.HiddenFromAddressListsEnabled !== true) hide.push(address);
  }
  for (const address of [...contacts.keys()].sort()) if (!desired.has(address)) remove.push(address);
  const onNode = new Set(mailboxes.map((m) => m.email));
  const inPanel = new Set(panel.map((p) => p.email));
  // The node listed no mailbox while the panel has some there, or the tenant has contacts of the
  // domain: an answer not to remove by (an empty answer would wipe the mirror, and on an
  // Authoritative domain reject every address).
  const suspicious = mailboxes.length === 0 && (panel.some((p) => !p.deleting) || contacts.size > 0);
  return {
    desired: [...desired].sort(),
    create,
    retarget,
    remove: suspicious ? [] : remove,
    hide,
    present,
    conflicts: [...desired].filter((a) => taken.has(a)).sort(),
    catchAll,
    nodeAliases,
    nodeOnly: [...onNode].filter((e) => !inPanel.has(e)).sort(),
    panelOnly: [...inPanel].filter((e) => !onNode.has(e)).sort(),
    suspicious,
  };
}

async function nodeView(domain) {
  const cfg = await getMailNodeConfig();
  if (!cfg) return { code: 'mail_node_not_configured' };
  try {
    const [mailboxes, aliases] = await Promise.all([listMailboxes(cfg, { domain }), listDomainAliases(cfg, domain)]);
    return { mailboxes, aliases };
  } catch (err) {
    if (!(err instanceof MailNodeError)) throw err;
    return { code: err.code, message: String(err.message ?? '').slice(0, 300) };
  }
}

async function panelView(domain) {
  const { rows } = await query(`
    SELECT id, lower(email_address) AS email, deletion_started_at IS NOT NULL AS deleting
      FROM email_accounts
     WHERE mail_node AND split_part(lower(email_address), '@', 2) = $1`, [domain]);
  return rows;
}

async function syncMirror({ session, settings }, row, out) {
  const { exo } = session;
  const { domain } = row;
  const node = await nodeView(domain);
  if (node.code) {
    out.sync.mirror = { at: out.at, ok: false, error: { code: node.code, message: node.message ?? null } };
    return;
  }
  const panel = await panelView(domain);
  const recipients = asRows(await exo.run('get_recipients'));
  const plan = planMirror({
    domain, mailboxes: node.mailboxes, aliases: node.aliases, panel, recipients, externalDomain: settings.dbebExternalDomain ?? null,
  });
  // Section 5.14: on an Authoritative domain a contact stage 7b made for a mailcow alias still on the
  // node is the only thing that lets mail to the alias in: removing it rejects that mail at once.
  // Such contacts stay until an administrator allows their removal (alias_contacts_approved_at,
  // journaled); they are reported (heldAliasContacts) and raise tenant_alias_contacts_held. On an
  // Internal Relay domain they go like any contact nobody needs.
  const authoritative = out.state === 'authoritative' || out.acceptedType === 'Authoritative' || row.accepted_domain_type === 'Authoritative';
  const aliases = new Set(plan.nodeAliases);
  const heldAliasContacts = authoritative && !row.alias_contacts_approved_at ? plan.remove.filter((a) => aliases.has(a)) : [];
  const removals = plan.remove.filter((a) => !heldAliasContacts.includes(a));
  // Complete on a fresh read: nothing to make, move or remove (contacts held for an administrator
  // aside), no active catch-all (D-6), a node answer to trust.
  const complete = !plan.create.length && !plan.retarget.length && !removals.length && !plan.catchAll && !plan.suspicious;
  const external = (address) => externalOf(address, settings.dbebExternalDomain ?? null);
  const created = [];
  const retargeted = [];
  const removed = [];
  const failed = [];
  // Made by New-MailContact that answered "exists": a contact made by a run whose answer was lost,
  // or the address held by a recipient Get-Recipient did not show. A read decides which.
  const unconfirmed = [];
  // The addresses a write was tried for: the rest of a plan is what the budget left for later.
  const attempted = new Set();
  let budget = CONTACT_BATCH;
  const present = new Set(plan.present);
  const write = async (op, address, args, okCodes) => {
    budget -= 1;
    attempted.add(`${op === 'remove_mail_contact' ? 'remove' : 'make'}:${address}`);
    try {
      await exo.run(op, args);
      return 'ok';
    } catch (err) {
      rethrowThrottled(err);
      if (isTenant(err, ...okCodes)) return err.code;
      if (!isTenant(err)) throw err;
      failed.push({ address, op, ...failureOf(err) });
      return null;
    }
  };
  try {
    for (const address of plan.create) {
      if (budget <= 0) break;
      const done = await write('new_mail_contact', address, { address, external: external(address) }, ['exo_exists']);
      if (done === 'exo_exists') {
        unconfirmed.push(address);
        continue;
      }
      if (!done) continue;
      created.push(address);
      present.add(address);
      // Hidden from the address lists right away; a failure here is retried by the next run.
      if (budget > 0) await write('hide_mail_contact', address, { address }, []);
    }
    for (const address of plan.retarget) {
      if (budget <= 0) break;
      if (await write('set_mail_contact_external', address, { address, external: external(address) }, [])) {
        retargeted.push(address);
        present.add(address);
      }
    }
    for (const address of removals) {
      if (budget <= 0) break;
      if (await write('remove_mail_contact', address, { address }, ['exo_not_found'])) removed.push(address);
    }
    for (const address of plan.hide) {
      if (budget <= 0) break;
      await write('hide_mail_contact', address, { address }, []);
    }
    if (unconfirmed.length) {
      const contacts = new Set(asRows(await exo.run('get_recipients'))
        .filter((r) => lower(r.RecipientTypeDetails) === 'mailcontact').map((r) => smtp(r.PrimarySmtpAddress)));
      for (const address of unconfirmed) {
        if (contacts.has(address)) {
          created.push(address);
          present.add(address);
        } else {
          failed.push({ address, op: 'new_mail_contact', code: 'address_taken', message: 'Another recipient of the tenant holds this address' });
        }
      }
    }
  } finally {
    // What was done stays recorded even when throttling ends the run. Left: only what the budget
    // (or throttling) kept for later; a write that failed is not retried at once.
    const left = plan.create.filter((a) => !attempted.has(`make:${a}`)).length
      + plan.retarget.filter((a) => !attempted.has(`make:${a}`)).length
      + removals.filter((a) => !attempted.has(`remove:${a}`)).length;
    out.sync.mirror = {
      at: out.at, ok: !failed.length, complete,
      desired: plan.desired.length, present: present.size,
      created: created.slice(0, LIST_MAX), retargeted: retargeted.slice(0, LIST_MAX), removed: removed.slice(0, LIST_MAX),
      failed: failed.slice(0, LIST_MAX),
      missing: plan.desired.filter((a) => !present.has(a) && !plan.conflicts.includes(a)).slice(0, LIST_MAX),
      extra: removals.filter((a) => !removed.includes(a)).slice(0, LIST_MAX),
      heldAliasContacts: heldAliasContacts.slice(0, LIST_MAX),
      conflicts: plan.conflicts.slice(0, LIST_MAX), catchAll: plan.catchAll, suspicious: plan.suspicious,
      nodeAliases: plan.nodeAliases.slice(0, LIST_MAX),
      nodeOnly: plan.nodeOnly.slice(0, LIST_MAX), panelOnly: plan.panelOnly.slice(0, LIST_MAX),
      variant: settings.dbebExternalDomain ? 'B' : 'A', left,
    };
    // An address another recipient holds takes mail in the tenant: its mailbox does not wait.
    out.presentAddresses = [...present, ...plan.conflicts];
    out.panelAddresses = panel.map((p) => p.email);
    if (created.length || removed.length || retargeted.length) {
      out.audit.push({ action: 'tenant.recipients_synced', details: { domain, created: created.length, removed: removed.length, retargeted: retargeted.length } });
    }
  }
  // More in the plan than the budget took: on at once. A failure waits for the next slot.
  if (out.sync.mirror.left > 0) out.followUp(NEXT_BATCH_MS);
  else if ((created.length || removed.length || retargeted.length) && row.state === 'ready') out.followUp(SETTLE_MS);
  return { complete: complete && !failed.length };
}

// D-4: a 'ready' domain whose mirror a fresh read found complete becomes Authoritative; an
// 'authoritative' domain the tenant shows as Internal Relay again (changed by hand) is put back
// once its mirror is complete, else reported.
async function syncAuthoritative({ session }, row, out, mirror, type) {
  const { exo } = session;
  const { domain } = row;
  // Authoritative only with the whole path in place: the tenant shows the domain and the Outbound
  // connector delivers it to the node, the mirror is complete.
  const pathOk = out.sync.acceptedDomain?.visible === true && out.sync.connector?.ok === true;
  if (!mirror?.complete || out.sync.mirror?.failed?.length || !pathOk) {
    if (out.state === 'authoritative' && type !== 'Authoritative') out.sync.authoritative = { at: out.at, ok: false, code: 'authoritative_lost' };
    return;
  }
  // Held on Internal Relay (on by default until experiment 8): the mirror is complete, the switch
  // waits for an administrator to turn the hold off. An 'authoritative' domain is never held.
  if (out.state === 'ready' && row.hold_internal_relay !== false) {
    out.sync.authoritative = { at: out.at, ok: true, held: true, mirrorComplete: true };
    return;
  }
  if (out.state !== 'ready' && !(out.state === 'authoritative' && type !== 'Authoritative')) return;
  if (type !== 'Authoritative') {
    await exo.run('set_accepted_domain_authoritative', { domain });
    type = (await readAccepted(exo, domain))?.DomainType ?? null;
  }
  out.sync.authoritative = { at: out.at, ok: type === 'Authoritative' };
  if (type === 'Authoritative') {
    out.acceptedType = 'Authoritative';
    if (out.sync.acceptedDomain) out.sync.acceptedDomain.type = 'Authoritative';
    if (out.state === 'ready') out.advance('authoritative');
  }
}

// --- one run ------------------------------------------------------------------------------------------

// One run for a domain row: { sync, from, to, steps, tenant, expectedMx, acceptedType, followUpMs,
// throttled, presentAddresses, panelAddresses, audit }. Writes to the tenant; persists nothing.
export async function syncDomain(context, row, { now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString();
  const previous = row.tenant_sync ?? {};
  const out = {
    at: stamp, previous, state: row.state, from: row.state, steps: {},
    sync: { at: stamp, ok: true }, tenant: {}, expectedMx: null, acceptedType: null, followUpMs: null, throttled: null,
    presentAddresses: null, panelAddresses: null, audit: [],
    advance(to) {
      out.steps[to] = { at: stamp, email: SYSTEM_ACTOR, tenantDriver: true };
      out.state = to;
    },
    followUp(ms) {
      out.followUpMs = out.followUpMs == null ? ms : Math.min(out.followUpMs, ms);
    },
  };
  const live = { ...row };
  const step = async (name, fn) => {
    try {
      live.state = out.state;
      return await fn(context, live, out);
    } catch (err) {
      if (err instanceof Throttled) throw err;
      rethrowThrottled(err);
      out.sync[name] = { ...(out.sync[name] ?? {}), at: stamp, ok: false, error: failureOf(err) };
      out.sync.ok = false;
      return undefined;
    }
  };
  try {
    const verified = await step('graph', syncGraph);
    if (!verified) return out;
    // A domain verified in the tenant is an accepted domain there whatever the panel's state (an
    // onboarding started over keeps it in the tenant): its type is kept on Internal Relay.
    const type = await step('acceptedDomain', syncAccepted);
    if (!type || !reached(out.state, 'tenant_verified')) return out;
    const dkimMode = row.dkim_mode ?? context.settings.dkimMode;
    if (dkimMode === 'eop') await step('dkim', syncDkim);
    if (!reached(out.state, 'internal_relay')) return out;
    await step('connector', syncConnector);
    if (!MIRRORED_STATES.includes(out.state)) return out;
    const mirror = await step('mirror', syncMirror);
    await step('authoritative', (ctx, r, o) => syncAuthoritative(ctx, r, o, mirror, o.acceptedType ?? type));
  } catch (err) {
    if (!(err instanceof Throttled)) throw err;
    out.throttled = { code: err.code, retryAfterMs: err.retryAfterMs };
    out.sync.ok = false;
    out.sync.throttled = out.throttled;
  }
  out.sync.ok = out.sync.ok && Object.values(out.sync).every((part) => !part || typeof part !== 'object' || part.ok !== false);
  return out;
}

// Writes a run's outcome, only while the row is still in the state the run read (an onboarding
// restarted meanwhile is left to the next run). Returns whether it was written.
export async function persistSync(domain, result, db = { query }) {
  const tenantPatch = Object.keys(result.tenant).length ? { ...result.tenant, source: 'tenant' } : null;
  const { rowCount } = await db.query(`
    UPDATE mail_node_domains
       SET tenant_sync = $3::jsonb,
           state = $4,
           steps = steps || $5::jsonb,
           state_changed_at = CASE WHEN $4 <> $2 THEN NOW() ELSE state_changed_at END,
           state_changed_by = CASE WHEN $4 <> $2 THEN NULL ELSE state_changed_by END,
           tenant = CASE WHEN $6::jsonb IS NULL THEN tenant ELSE COALESCE(tenant, '{}'::jsonb) || $6::jsonb END,
           expected_mx = COALESCE($7::jsonb, expected_mx),
           accepted_domain_type = COALESCE($8, accepted_domain_type),
           updated_at = NOW()
     WHERE domain = $1 AND state = $2
  `, [domain, result.from, JSON.stringify(result.sync), result.state, JSON.stringify(result.steps), tenantPatch ? JSON.stringify(tenantPatch) : null,
    result.expectedMx ? JSON.stringify(result.expectedMx) : null, result.acceptedType]);
  if (!rowCount) return false;
  if (result.presentAddresses && result.panelAddresses) {
    // R-32: a mailbox whose recipient the tenant has; the rest wait for it.
    await db.query(`
      UPDATE email_accounts
         SET tenant_recipient_at = CASE WHEN lower(email_address) = ANY($2::text[]) THEN COALESCE(tenant_recipient_at, NOW()) ELSE NULL END
       WHERE mail_node AND split_part(lower(email_address), '@', 2) = $1
    `, [domain, result.presentAddresses]);
  }
  return true;
}

// --- the queue ----------------------------------------------------------------------------------------

// A domain's sync, unless one is queued already (a running one does not count: it may have read the
// node before the change that asks for this one). { job, created }.
export async function enqueueDomainSync(domain, { userId = null, delayMs = 0, dedupeKey = null } = {}, db = { query }) {
  const { rows: [waiting] } = await db.query(
    `SELECT * FROM jobs WHERE kind = $1 AND status = 'queued' AND payload->>'domain' = $2 ORDER BY id LIMIT 1`,
    [DOMAIN_SYNC_KIND, domain],
  );
  if (waiting) return { job: waiting, created: false };
  return enqueueJob({ kind: DOMAIN_SYNC_KIND, payload: { domain }, createdBy: userId, delayMs, dedupeKey }, db);
}

// Queues a domain's sync after something changed it (added, adopted, a step confirmed, a mailbox
// made), when the driver runs the tenant steps; never fails the caller. Resolves the job or null.
export async function kickDomainSync(domain, { userId = null } = {}) {
  try {
    if (!tenantDriverActive(await getEopSettings())) return null;
    return (await enqueueDomainSync(domain, { userId })).job;
  } catch (err) {
    console.error(`Tenant sync of ${domain} could not be queued: ${err?.code || err?.message}`);
    return null;
  }
}

// The poll's slot (services/tenant/tenantJobs.js): every domain with tenant work left is synced each
// slot; a finished one (Authoritative, DKIM done or not the tenant's) once an hour, for the mirror's
// drift. Returns the jobs queued.
export async function enqueueDueDomainSyncs(now = Date.now(), slotMs = 10 * 60 * 1000) {
  const settings = await getEopSettings();
  if (!tenantDriverActive(settings)) return [];
  const { rows } = await query('SELECT domain, state, dkim_mode, tenant_sync FROM mail_node_domains ORDER BY domain');
  const queued = [];
  const hour = Math.floor(now / (60 * 60 * 1000));
  const slot = Math.floor(now / slotMs);
  for (const row of rows) {
    const eopDkim = (row.dkim_mode ?? settings.dkimMode) === 'eop';
    const settled = row.state === 'authoritative' && (!eopDkim || row.tenant_sync?.dkim?.enabled === true) && row.tenant_sync?.ok;
    const key = settled ? `${row.domain}:h${hour}` : `${row.domain}:s${slot}`;
    const { job, created } = await enqueueDomainSync(row.domain, { dedupeKey: key });
    if (created) queued.push(job);
  }
  return queued;
}

async function journal(entries) {
  if (!entries.length) return;
  await withTransaction((tx) => insertAuditEntries(tx, entries)).catch((err) => console.error('Tenant sync journal failed:', err?.message));
}

// Takes the domain for this run, atomically (one run of a domain at a time): the row with what the
// run needs, null when another live run holds it, undefined when the panel has no such domain.
async function lockDomain(domain, jobId) {
  const { rows: [row] } = await query(`
    UPDATE mail_node_domains SET sync_lock_job = $2, sync_locked_at = NOW()
     WHERE domain = $1
       AND (sync_lock_job IS NULL OR sync_lock_job = $2 OR sync_locked_at < NOW() - make_interval(mins => $3::int))
    RETURNING domain, state, dkim_mode, tenant_sync, hold_internal_relay, internal_relay_approved_at, accepted_domain_type,
              alias_contacts_approved_at
  `, [domain, jobId, LOCK_STALE_MINUTES]);
  if (row) return row;
  const { rows: [known] } = await query('SELECT 1 FROM mail_node_domains WHERE domain = $1', [domain]);
  return known ? null : undefined;
}

const unlockDomain = (domain, jobId) => query(
  'UPDATE mail_node_domains SET sync_lock_job = NULL, sync_locked_at = NULL WHERE domain = $1 AND sync_lock_job = $2', [domain, jobId],
).catch((err) => console.error(`Tenant sync of ${domain}: the lock was not released: ${err?.message}`));

export async function handleDomainSync(job, { now = Date.now() } = {}) {
  const domain = parseHostName(job.payload?.domain);
  if (!domain) throw new JobError('The job names no domain', { outcome: 'fail', code: 'domain_invalid' });
  const context = await tenantContext();
  const row = await lockDomain(domain, job.id);
  // A domain the panel no longer knows: nothing to do.
  if (row === undefined) return { skipped: 'domain_not_found' };
  // Another run of this domain is going: this one ends (no attempt spent) and one more is queued.
  if (row === null) {
    await enqueueDomainSync(domain, { delayMs: BUSY_RETRY_MS });
    return { skipped: 'domain_sync_busy' };
  }
  try {
    return await runLocked(context, job, domain, row, now);
  } finally {
    await unlockDomain(domain, job.id);
  }
}

async function runLocked(context, job, domain, row, now) {
  const result = await syncDomain(context, row, { now });
  const written = await persistSync(domain, result);
  if (written) {
    const entries = [];
    let from = result.from;
    for (const to of Object.keys(result.steps)) {
      entries.push({ actorEmail: SYSTEM_ACTOR, action: 'mail_node.domain_state_changed', details: { domain, from, to, how: 'tenant_driver' } });
      from = to;
    }
    for (const entry of result.audit) entries.push({ actorEmail: SYSTEM_ACTOR, ...entry });
    await journal(entries);
    if (result.followUpMs != null && !result.throttled) await enqueueDomainSync(domain, { delayMs: result.followUpMs });
  }
  if (result.throttled) {
    throw new JobError(`The tenant asked to slow down (${result.throttled.code})`, {
      outcome: 'retry', code: result.throttled.code, delayMs: result.throttled.retryAfterMs ?? null,
    });
  }
  return { written, state: result.state };
}

// --- R-29 with R-33: the recipient goes before the node mailbox -----------------------------------------

// A step of the mailbox deletion job (services/mailNode/mailboxDeletion.js BEFORE_NODE_DELETE): the
// mailbox's mail contact is removed from the tenant before the node deletes the mailbox, so EOP
// rejects the address at the edge instead of accepting mail for a mailbox that is gone (finding 9).
// A contact already gone counts as removed. On an Authoritative domain the deletion waits while the
// tenant cannot be reached (deletionCode shown on the row); on an Internal Relay domain the
// contact changes nothing EOP accepts, so the deletion goes on and the mirror removes the contact
// later.
export async function removeRecipientBeforeDelete(row) {
  const address = lower(row.email_address);
  const domain = domainOf(address);
  // By the tenant's facts too: an onboarding started over keeps the domain in the tenant.
  const { rows: [d] } = await query('SELECT state, accepted_domain_type FROM mail_node_domains WHERE domain = $1', [domain]);
  if (!d || !(MIRRORED_STATES.includes(d.state) || d.accepted_domain_type)) return;
  const must = d.state === 'authoritative' || d.accepted_domain_type === 'Authoritative';
  const fail = (code, err) => {
    if (!must) {
      console.warn(`Mailbox deletion: the tenant recipient of ${redactEmail(address)} was not removed (${code}), the mirror removes it later`);
      return;
    }
    const error = new Error(`The tenant recipient was not removed (${code})`);
    error.deletionCode = code === 'tenant_driver_missing' || code === 'tenant_not_configured' ? code : 'tenant_recipient_not_removed';
    error.cause = err;
    throw error;
  };
  const driver = getTenantDriver();
  const tenant = tenantOf(await getEopSettings());
  if (!driver) return fail('tenant_driver_missing');
  if (!tenant) return fail('tenant_not_configured');
  try {
    await driver.forTenant(tenant).exo.run('remove_mail_contact', { address });
  } catch (err) {
    if (isTenant(err, 'exo_not_found')) return undefined;
    return fail(err?.code ?? 'tenant_failed', err);
  }
  return undefined;
}

let registered = false;

export function registerTenantDomainJobKind({ beforeNodeDelete = null } = {}) {
  registerJobKind(DOMAIN_SYNC_KIND, { maxAttempts: MAX_ATTEMPTS, handler: (job) => handleDomainSync(job) });
  if (beforeNodeDelete && !registered) {
    beforeNodeDelete.push(removeRecipientBeforeDelete);
    registered = true;
  }
}
