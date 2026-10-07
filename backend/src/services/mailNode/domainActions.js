import { recordAudit } from '../auditLog.js';
import { auditOf, jobBy } from '../actor.js';
import {
  DEFAULT_DOMAIN_MAILBOXES, DKIM_KEY_SIZE, MAX_DOMAIN_MAILBOXES, MailNodeError, addDomain, getMailNodeConfig, listDomains,
  parseHostName, parseWholeNumber,
} from './mailcow.js';
import {
  acknowledgeNodeIdentity, adoptDomain, bindNodeIdentities, confirmStep, getDomainRow, listDomainRows, markReady,
  mergeDomains, nodeRefusal, parseExpectedValues, recordCreatedDomain, restartOnboarding, setExpectedValues,
} from './domains.js';
import { getEopSettings, tenantDriverActive } from './eopSettings.js';
import { applyDomain, applyQuietly } from './nodeApply.js';
import { checkDomainNow } from './dnsCheckJob.js';
import { DRIVER_STEPS, kickDomainSync } from '../tenant/tenantDomains.js';

// The administrator's actions on the mail node's domains that routes/mailNode.js and the panel CLI
// (src/cli/mailexpert.js) share. They answer a result or { error: code } (a key of
// services/mailNode/errors.js); a failure of the node itself is a MailNodeError, as everywhere.
// actor: services/actor.js.

// The administrator's list of domains (GET /api/mail-node/domains): the node's domains with the
// panel's onboarding state of each ('unknown' for a domain the panel has no record of). When the
// node cannot be read, every domain the panel knows (onNode: null) and the node's error beside
// them, never an empty list. tenantDriverActive: whether the tenant driver runs the tenant steps
// (stage 7b). Reading the node never changes a row beyond binding an empty node identity.
export async function adminDomainList() {
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  let onNode;
  let nodeError;
  try {
    onNode = await listDomains(cfg);
  } catch (err) {
    if (!(err instanceof MailNodeError)) throw err;
    nodeError = err;
  }
  const driverActive = async () => tenantDriverActive(await getEopSettings());
  if (nodeError) {
    return {
      domains: mergeDomains(null, await listDomainRows()), node: { error: nodeError.message, code: nodeError.code },
      tenantDriverActive: await driverActive(),
    };
  }
  const domains = mergeDomains(onNode, await bindNodeIdentities(onNode, await listDomainRows()));
  return { domains, tenantDriverActive: await driverActive() };
}

// "Restart onboarding": the domain goes back to node_created with no confirmed steps and nothing the
// node or the tenant held, keeping the owner's DKIM mode and send limit. Its mailboxes stay as they
// are. Needs no answer from the node to reset the panel's record; then its node settings are
// applied again, as for a new domain (a failure stays in the answer's apply and never fails the
// action). The journal keeps the steps that were confirmed (who and when). A domain with nothing to
// clear is refused. Answers { ok, domain, state, apply? }.
export async function restartDomain(rawDomain, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  const userId = actor?.userId ?? null;
  const result = await restartOnboarding({ domain, userId });
  if (result.error) return { error: result.error };
  recordAudit(auditOf(actor, {
    action: 'mail_node.domain_state_changed',
    details: { domain, from: result.from, to: result.to, how: 'restarted', ...(result.steps ? { steps: result.steps } : {}) },
  }));
  const apply = await applyQuietly(() => applyDomain({
    domain, userId, ...(actor?.via ? { actor } : {}), trigger: 'onboarding_restarted',
  }));
  // Awaited: the CLI ends its database pool right after the answer, which would lose the job.
  await kickDomainSync(domain, jobBy(actor));
  return { ok: true, domain, state: result.to, ...(apply ? { apply } : {}) };
}

// applyDomain as the route calls it; the CLI's actor goes along so the journal names it.
function applyDomainAs(actor, domain, trigger, extra = {}) {
  return applyDomain({ domain, userId: actor?.userId ?? null, ...(actor?.via ? { actor } : {}), trigger, ...extra });
}

// A domain's node settings applied by themselves after it was added or adopted. The answer carries
// the result; a failure stays in it and never fails the action.
const applyDomainQuietly = (actor, domain, trigger) => applyQuietly(() => applyDomainAs(actor, domain, trigger));

// "Add domain" (POST /api/mail-node/domains): creates the domain on the node, with a DKIM key only
// when mailcow signs (the EOP settings' DKIM mode), and applies its node settings (relayhost, DKIM);
// its onboarding starts at node_created. DNS and the EOP connectors stay manual (runbook) and are
// confirmed step by step. A domain the panel knew already (removed on the node and added again)
// starts over: the journal keeps the state and the confirmed steps it had. With the tenant driver,
// the domain goes into the tenant now (its verification TXT, R-23). A node failure is a
// MailNodeError. Answers { ok, domain, state, apply? }.
export async function addNodeDomain({ domain: rawDomain, mailboxes: rawMailboxes }, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  const mailboxes = parseWholeNumber(rawMailboxes ?? DEFAULT_DOMAIN_MAILBOXES, 1, MAX_DOMAIN_MAILBOXES);
  if (!mailboxes) return { error: 'mailboxes_invalid' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  const { dkimMode } = await getEopSettings();
  await addDomain(cfg, { domain, mailboxes, dkimKeySize: dkimMode === 'mailcow' ? DKIM_KEY_SIZE : 0 });
  const before = await recordCreatedDomain({ domain, userId: actor?.userId ?? null, maxMailboxes: mailboxes });
  recordAudit(auditOf(actor, {
    action: 'mail_node.domain_added',
    details: { domain, mailboxes, ...(before?.from ? { from: before.from, steps: before.steps ?? {} } : {}) },
  }));
  const apply = await applyDomainQuietly(actor, domain, 'domain_added');
  // Awaited: the CLI ends its database pool right after the answer, which would lose the job.
  await kickDomainSync(domain, jobBy(actor));
  return { ok: true, domain, state: 'node_created', ...(apply ? { apply } : {}) };
}

// "Adopt" (POST /domains/:domain/adopt): takes in a domain made on the node by hand that the panel
// has no row for. It starts at node_created like a new one, bound to the node's identity of the
// domain. Answers { ok, domain, state, apply? }.
export async function adoptNodeDomain(rawDomain, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  const onNode = (await listDomains(cfg)).find((d) => d.domain === domain);
  if (!onNode) return { error: 'domain_not_on_node' };
  if (!(await adoptDomain({ domain, userId: actor?.userId ?? null, nodeCreated: onNode.created }))) return { error: 'domain_known' };
  recordAudit(auditOf(actor, {
    action: 'mail_node.domain_adopted', details: { domain, state: 'node_created', origin: 'adopted' },
  }));
  const apply = await applyDomainQuietly(actor, domain, 'domain_adopted');
  await kickDomainSync(domain, jobBy(actor));
  return { ok: true, domain, state: 'node_created', ...(apply ? { apply } : {}) };
}

// The node's record of one domain for an action on a known row: { row, onNode }, or { error } when
// the panel has no row, the node is not set up, or the node does not list the domain (a node that
// cannot be read is a MailNodeError). A refusal never changes the row. A node creation time other
// than the bound one is only a warning and passes.
export async function nodeDomainOf(domain) {
  const row = await getDomainRow(domain);
  if (!row) return { error: 'domain_not_found' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  const onNode = (await listDomains(cfg)).find((d) => d.domain === domain);
  const why = nodeRefusal(onNode);
  if (why) return { error: why };
  return { row, onNode };
}

async function stateChanged(domain, result, how, actor) {
  if (result.error) return { error: result.error };
  recordAudit(auditOf(actor, {
    action: 'mail_node.domain_state_changed',
    details: { domain, from: result.from, to: result.to, how, ...(result.steps ? { steps: result.steps } : {}) },
  }));
  // The tenant driver takes it on from here (verify after dns_ok, the mirror after ready).
  await kickDomainSync(domain, jobBy(actor));
  return { ok: true, domain, state: result.to };
}

// "Done" (POST /domains/:domain/steps/:step): a person confirms the domain's next onboarding step.
// With the tenant driver, its steps are confirmed by what the tenant answers, not by a person: a
// "Done" could skip Set-AcceptedDomain InternalRelay (R-24). Answers { ok, domain, state }.
export async function confirmDomainStep(rawDomain, step, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  if (DRIVER_STEPS.includes(step) && tenantDriverActive(await getEopSettings())) return { error: 'step_by_tenant_driver' };
  const found = await nodeDomainOf(domain);
  if (found.error) return { error: found.error };
  const result = await confirmStep({ domain, step, userId: actor?.userId ?? null });
  return stateChanged(domain, result, 'step_confirmed', actor);
}

// "Mark ready" (POST /domains/:domain/ready): a pilot or a test stand without a tenant; the domain
// takes mailboxes without the other steps. With the tenant driver, "ready" without the tenant steps
// would skip Internal Relay and the connector (I3 of the 7b review). Answers { ok, domain, state }.
export async function markDomainReady(rawDomain, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  if (tenantDriverActive(await getEopSettings())) return { error: 'mark_ready_by_tenant_driver' };
  const found = await nodeDomainOf(domain);
  if (found.error) return { error: found.error };
  const result = await markReady({ domain, userId: actor?.userId ?? null });
  return stateChanged(domain, result, 'marked_ready', actor);
}

// "Apply settings" for one domain (POST /domains/:domain/apply): its relayhost, DKIM key and the
// send limits of its mailboxes. confirmDkimDelete lets it delete mailcow's DKIM key of a domain the
// tenant signs for. Answers the apply's result; a node failure is a MailNodeError.
export async function applyDomainNow(rawDomain, actor, { confirmDkimDelete = false } = {}) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  const found = await nodeDomainOf(domain);
  if (found.error) return { error: found.error };
  return applyDomainAs(actor, domain, 'manual', { confirmDkimDelete: confirmDkimDelete === true });
}

// The values a domain must publish that the panel cannot read until the tenant driver exists
// (PUT /domains/:domain/dns-expected): its MX, the tenant's verification TXT and the EOP DKIM
// selector CNAMEs (body as parseExpectedValues takes it). Journaled by the names of the fields that
// changed; the domain's DNS is checked again right away (a failure stays in the result, the save
// holds). Answers { ok, domain, fields, dns? }.
export async function setDomainDnsExpected(rawDomain, body, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  const { values, error } = parseExpectedValues(body);
  if (error) return { error };
  const result = await setExpectedValues({ domain, values });
  if (result.error) return { error: result.error };
  if (result.fields.length) {
    recordAudit(auditOf(actor, {
      action: 'mail_node.config_changed', details: { settings: 'domain_dns', domain, fields: result.fields },
    }));
  }
  const dns = await checkDomainNow({ domain, userId: actor?.userId ?? null, trigger: 'expected_changed' })
    .catch((err) => {
      console.error('Mail node DNS check after saving the expected values failed:', err?.code || 'error');
      return null;
    });
  return { ok: true, domain, fields: result.fields, ...(dns ? { dns } : {}) };
}

// The administrator accepts the creation time the node reports now for a domain whose time differs
// from the one the panel is bound to (the warning in the domain list; POST
// /domains/:domain/acknowledge). seen: the time the administrator saw; if the node reports another
// one by now, nothing is accepted. The state stays as it is. Answers { ok, domain }.
export async function acknowledgeDomainIdentity(rawDomain, seen, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  if (typeof seen !== 'string' || !seen) return { error: 'node_created_required' };
  const found = await nodeDomainOf(domain);
  if (found.error) return { error: found.error };
  if (!found.onNode.created) return { error: 'domain_not_recreated' };
  if (found.onNode.created !== seen) return { error: 'domain_node_changed' };
  const result = await acknowledgeNodeIdentity({ domain, nodeCreated: found.onNode.created });
  if (result.error) return { error: result.error };
  recordAudit(auditOf(actor, {
    action: 'mail_node.domain_identity_acknowledged', details: { domain, from: result.from, to: result.to },
  }));
  return { ok: true, domain };
}
