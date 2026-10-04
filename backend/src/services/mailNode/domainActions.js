import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import { MailNodeError, getMailNodeConfig, listDomains, parseHostName } from './mailcow.js';
import { bindNodeIdentities, listDomainRows, mergeDomains, restartOnboarding } from './domains.js';
import { getEopSettings, tenantDriverActive } from './eopSettings.js';
import { applyDomain, applyQuietly } from './nodeApply.js';
import { kickDomainSync } from '../tenant/tenantDomains.js';

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
  kickDomainSync(domain, { userId });
  return { ok: true, domain, state: result.to, ...(apply ? { apply } : {}) };
}
