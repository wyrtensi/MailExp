import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { recordAudit } from '../services/auditLog.js';
import { MAIL_NODE_ERRORS } from '../services/mailNode/errors.js';
import {
  acknowledgeDomainIdentity, addNodeDomain, adminDomainList, adoptNodeDomain, applyDomainNow, confirmDomainStep,
  markDomainReady, restartDomain, setDomainDnsExpected,
} from '../services/mailNode/domainActions.js';
import {
  eopBudgetNow, eopSettingsView, nodeConfigView, saveEopConfig, saveNodeConfig,
} from '../services/mailNode/settingsActions.js';
import { defaultLimits, listNodeMailboxes, onOtherMailHost, overrideOf } from '../services/mailNode/mailboxActions.js';
import { routeActor } from '../services/actor.js';
import {
  MAX_QUOTA_MB,
  MailNodeError,
  RATE_LIMIT_FRAMES,
  getMailbox,
  getMailNodeConfig,
  listDomains,
  parseHostName,
  parseWholeNumber,
  setMailboxQuota,
  setMailboxRateLimit,
} from '../services/mailNode/mailcow.js';
import {
  bindNodeIdentities,
  canCreateMailboxes,
  listDomainRows,
  mergeDomains,
} from '../services/mailNode/domains.js';
import { checkDomainNow, getNodeDnsCheck, startCheckAll } from '../services/mailNode/dnsCheckJob.js';
import { MAX_SEND_LIMIT_PER_HOUR } from '../services/mailNode/eopSettings.js';
import {
  applyNode,
  applyPrefilter,
  getNodeApplyResult,
} from '../services/mailNode/nodeApply.js';
import {
  QUEUE_ACTIONS,
  deleteQueued,
  flushQueue,
  getQueuedMessageText,
  listQueue,
  parseQueueId,
  queueAction,
} from '../services/mailNode/mailcow.js';
import { parsePostcat, postcatGone, summarizeQueue } from '../services/mailNode/mailQueue.js';
import {
  ALERT_DEFAULTS,
  checkAlertsNow,
  getAlertSettings,
  getAlertState,
  parseAlertSettings,
  saveAlertSettings,
} from '../services/mailNode/nodeAlerts.js';

// The mail node (mailcow) settings, its domains with their onboarding, the EOP settings, applying
// them to the node (services/mailNode/nodeApply.js) and the quotas and send limits of the mailboxes
// MailExpert made there, and the node's operations: its mail queue, its alerts and the tenant's
// external recipient budget. Mounted at /api/mail-node. Everyone signed in may list the domains a
// mailbox can be created on (the add-mailbox form offers them); everything else is for
// administrators.
const router = Router();
router.param('id', uuidParam('id'));

export function refuse(res, code) {
  const [status, error] = MAIL_NODE_ERRORS[code];
  return res.status(status).json({ error, code });
}

// Whether a node mailbox row is on another host than the node the settings name now
// (services/mailNode/mailboxActions.js; routes/accounts.js imports it from here).
export { onOtherMailHost };

// A mailcow failure: 502 (or the status the error carries), the node's own message and a code the
// screens translate.
export function mailNodeFailure(res, err) {
  if (err instanceof MailNodeError) return res.status(err.status ?? 502).json({ error: err.message, code: err.code });
  throw err;
}

router.use(requireAuth);

async function isAdmin(req) {
  const { rows } = await query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
  return !!rows[0]?.is_admin;
}

// A settings change is journaled by the names of the fields that changed, never their values.
function configAudit(req, settings, fields) {
  if (!fields.length) return;
  recordAudit({ actorUserId: req.session.userId, action: 'mail_node.config_changed', details: { settings, fields } });
}

// The node settings (services/mailNode/settingsActions.js, which the panel CLI shares): the API key
// is never sent back, a placeholder stands for it.
router.get('/config', requireAdmin, async (req, res) => {
  res.json(await nodeConfigView());
});

// Saves only settings the node accepts: the key is checked by listing the domains first. Another
// node, key or panel address: the node gets the panel's settings right after the answer, so the save
// never waits for a node that does not answer; the result shows on the next load.
router.put('/config', requireAdmin, async (req, res) => {
  let result;
  try {
    result = await saveNodeConfig(req.body, routeActor(req));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  return result.error ? refuse(res, result.error) : res.json(result);
});

// The node's domains with the panel's onboarding state of each ('unknown' for a domain the panel
// has no record of). An administrator sees them all; everyone else only those a mailbox can be
// created on. When the node cannot be read, an administrator still gets every domain the panel
// knows (onNode: null) and the node's error beside them, never an empty list; everyone else gets
// the error, since no mailbox can be created then anyway. Reading the node never changes a row
// beyond binding an empty node identity.
router.get('/domains', async (req, res) => {
  // Administrators: every domain and its onboarding (services/mailNode/domainActions.js, which the
  // panel CLI shares).
  if (await isAdmin(req)) {
    const result = await adminDomainList();
    return result.error ? refuse(res, result.error) : res.json(result);
  }
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  let onNode;
  try {
    onNode = await listDomains(cfg);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  const domains = mergeDomains(onNode, await bindNodeIdentities(onNode, await listDomainRows()));
  res.json({
    domains: domains
      .filter((d) => d.onNode && d.active && canCreateMailboxes(d.state))
      .map(({ domain, active, state }) => ({ domain, active, state })),
  });
});

// A domain action's answer: its refusal, the node's failure or its result
// (services/mailNode/domainActions.js, which the panel CLI shares).
async function domainAction(res, run) {
  let result;
  try {
    result = await run();
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  return result.error ? refuse(res, result.error) : res.json(result);
}

// Creates the domain on the node and applies its node settings; its onboarding starts at
// node_created. DNS and the EOP connectors stay manual (runbook) and are confirmed step by step.
router.post('/domains', requireAdmin, (req, res) => domainAction(res, () => (
  addNodeDomain({ domain: req.body?.domain, mailboxes: req.body?.mailboxes }, routeActor(req))
)));

// Takes in a domain made on the node by hand that the panel has no row for.
router.post('/domains/:domain/adopt', requireAdmin, (req, res) => domainAction(res, () => (
  adoptNodeDomain(req.params.domain, routeActor(req))
)));

// "Done": a person confirms the domain's next onboarding step.
router.post('/domains/:domain/steps/:step', requireAdmin, (req, res) => domainAction(res, () => (
  confirmDomainStep(req.params.domain, req.params.step, routeActor(req))
)));

// A pilot or a test stand without a tenant: the domain takes mailboxes without the other steps.
router.post('/domains/:domain/ready', requireAdmin, (req, res) => domainAction(res, () => (
  markDomainReady(req.params.domain, routeActor(req))
)));

// "Restart onboarding": the domain goes back to node_created with no confirmed steps and nothing the
// node or the tenant held, keeping the owner's DKIM mode and send limit. Its mailboxes stay as they
// are. Needs no answer from the node to reset the panel's record; then its node settings are
// applied again, as for a new domain. The journal keeps the steps that were confirmed (who and
// when). A domain with nothing to clear is refused.
router.post('/domains/:domain/restart', requireAdmin, async (req, res) => {
  const result = await restartDomain(req.params.domain, routeActor(req));
  return result.error ? refuse(res, result.error) : res.json(result);
});

// "Apply settings" for one domain: its relayhost, DKIM key and the send limits of its mailboxes.
// { confirmDkimDelete: true } lets it delete mailcow's DKIM key of a domain the tenant signs for.
router.post('/domains/:domain/apply', requireAdmin, (req, res) => domainAction(res, () => (
  applyDomainNow(req.params.domain, routeActor(req), { confirmDkimDelete: req.body?.confirmDkimDelete === true })
)));

// The node's last "apply" (each domain's comes with GET /domains).
router.get('/apply', requireAdmin, async (req, res) => {
  res.json({ node: await getNodeApplyResult() });
});

// "Apply settings" for the node and every domain the panel knows. The spam filing rule is only
// checked: it has its own action below.
router.post('/apply', requireAdmin, async (req, res) => {
  try {
    return res.json(await applyNode({ userId: req.session.userId, trigger: 'manual' }));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
});

// The spam filing rule (R-11). Writing it restarts Dovecot on the node, which drops every IMAP
// session, so the screen warns first; an unchanged rule is not written again.
router.post('/apply/prefilter', requireAdmin, async (req, res) => {
  try {
    return res.json(await applyPrefilter({ userId: req.session.userId }));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
});

// The DNS checks (R-14, R-15; services/mailNode/dnsCheckJob.js): the node's last result (each
// domain's comes with GET /domains), "Check now" for the node and every domain the panel knows (it
// runs in the background: the answer comes at once, with started: false when a run was already
// going, and the results show on the next load), and for one domain (at once, never waiting for a
// run of everything). A result only warns: it never changes a domain's onboarding state.
router.get('/dns-check', requireAdmin, async (req, res) => {
  res.json({ node: await getNodeDnsCheck() });
});

router.post('/dns-check', requireAdmin, async (req, res) => {
  if (!(await getMailNodeConfig())) return refuse(res, 'mail_node_not_configured');
  const { started } = startCheckAll({ userId: req.session.userId, trigger: 'manual' });
  return res.status(202).json({ ok: true, started, running: true });
});

router.post('/domains/:domain/dns-check', requireAdmin, async (req, res) => {
  const domain = parseHostName(req.params.domain);
  if (!domain) return refuse(res, 'domain_invalid');
  try {
    return res.json(await checkDomainNow({ domain, userId: req.session.userId, trigger: 'manual' }));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
});

// The values a domain must publish that the panel cannot read until the tenant driver exists: its
// MX, the tenant's verification TXT and the EOP DKIM selector CNAMEs. Journaled by the names of the
// fields that changed; the domain's DNS is checked again right away (a failure stays in the result,
// the save holds).
router.put('/domains/:domain/dns-expected', requireAdmin, (req, res) => domainAction(res, () => (
  setDomainDnsExpected(req.params.domain, req.body, routeActor(req))
)));

// The administrator accepts the creation time the node reports now for a domain whose time differs
// from the one the panel is bound to (the warning in the domain list). The body names the time the
// administrator saw ({ created }); if the node reports another one by now, nothing is accepted. The
// state stays as it is.
router.post('/domains/:domain/acknowledge', requireAdmin, (req, res) => domainAction(res, () => (
  acknowledgeDomainIdentity(req.params.domain, typeof req.body?.created === 'string' ? req.body.created : '', routeActor(req))
)));

// The EOP settings (services/mailNode/settingsActions.js, which the panel CLI shares). tenantDriver:
// the tenant driver the backend runs with ('worker', 'fake' or null), for the "Microsoft tenant"
// part of the screen (routes/mailNodeTenant.js).
router.get('/eop', requireAdmin, async (req, res) => {
  res.json(await eopSettingsView());
});

// Checked and kept; the next hop, its TLS, the DKIM mode and the send limit are applied to the node
// right after the answer, as for the node settings.
router.put('/eop', requireAdmin, async (req, res) => {
  const result = await saveEopConfig(req.body, routeActor(req));
  return result.error ? refuse(res, result.error) : res.json(result);
});

// The node mailboxes MailExpert knows, with quota and usage as the node reports them, and the send
// limit: the node's (rateLimit, null when the mailbox has none of its own), an administrator's
// (rateLimitOverride) and the default the mailbox has without one (rateLimitDefault).
// services/mailNode/mailboxActions.js, shared with the panel CLI.
router.get('/mailboxes', requireAdmin, async (req, res) => {
  let result;
  try {
    result = await listNodeMailboxes();
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  return result.error ? refuse(res, result.error) : res.json(result);
});

router.put('/mailboxes/:id/quota', requireAdmin, async (req, res) => {
  const quotaMb = parseWholeNumber(req.body?.quotaMb, 1, MAX_QUOTA_MB);
  if (!quotaMb) return refuse(res, 'quota_invalid');
  const { rows } = await query(
    'SELECT email_address, imap_host FROM email_accounts WHERE id = $1 AND mail_node = true', [req.params.id]
  );
  if (!rows.length) return refuse(res, 'mailbox_not_found');
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  if (onOtherMailHost(rows[0], cfg)) return refuse(res, 'mail_node_host_mismatch');
  // The quota before the change, read from the node, goes into the journal.
  let before;
  try {
    before = await getMailbox(cfg, rows[0].email_address);
    await setMailboxQuota(cfg, rows[0].email_address, quotaMb);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  recordAudit({
    actorUserId: req.session.userId, accountId: req.params.id, action: 'mailbox.quota_changed',
    details: { quotaMb, from: before?.quotaMb ?? null },
  });
  res.json({ ok: true, quotaMb });
});

// An administrator's send limit for one mailbox, { value, frame } (messages per s, m, h or d), or
// { value: null } to go back to the default. The node takes it first; the panel keeps it after, so
// every later apply keeps it too.
router.put('/mailboxes/:id/rate-limit', requireAdmin, async (req, res) => {
  const clear = req.body?.value === null || req.body?.value === '';
  const value = clear ? null : parseWholeNumber(req.body?.value, 1, MAX_SEND_LIMIT_PER_HOUR);
  const frame = clear ? null : req.body?.frame;
  if (!clear && (!value || !RATE_LIMIT_FRAMES.includes(frame))) return refuse(res, 'rate_limit_invalid');
  const { rows } = await query(
    'SELECT email_address, imap_host, node_rl_value, node_rl_frame FROM email_accounts WHERE id = $1 AND mail_node = true', [req.params.id]
  );
  if (!rows.length) return refuse(res, 'mailbox_not_found');
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  if (onOtherMailHost(rows[0], cfg)) return refuse(res, 'mail_node_host_mismatch');
  const email = rows[0].email_address.toLowerCase();
  const limit = clear ? (await defaultLimits([email]))(email) : { value, frame };
  try {
    const result = await setMailboxRateLimit(cfg, [email], limit);
    if (result.failed.length) throw new MailNodeError('mail_node_refused', `The mail node refused: ${result.reason ?? 'refused'}`);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  // Every row of the address: two rows for one mailcow mailbox share its limit.
  await query(
    'UPDATE email_accounts SET node_rl_value = $2, node_rl_frame = $3 WHERE mail_node = true AND lower(email_address) = $1',
    [email, value, frame],
  );
  recordAudit({
    actorUserId: req.session.userId, accountId: req.params.id, action: 'mailbox.rate_limit_changed',
    details: { ...limit, override: !clear, from: overrideOf(rows[0]) },
  });
  res.json({ ok: true, rateLimit: limit, rateLimitOverride: clear ? null : limit });
});

// --- Node operations: the mail queue (R-16), the alerts (R-18, R-19) and the TERRL budget (R-21) ---

async function nodeConfigOr(res) {
  const cfg = await getMailNodeConfig();
  if (!cfg) refuse(res, 'mail_node_not_configured');
  return cfg;
}

// The node's mail queue: every message with its queue, age, size, sender and recipients (with the
// reason a deferred one waits), counts per queue and the oldest deferred message's age.
router.get('/queue', requireAdmin, async (req, res) => {
  const cfg = await nodeConfigOr(res);
  if (!cfg) return undefined;
  try {
    return res.json(summarizeQueue(await listQueue(cfg)));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
});

// One queued message: its envelope and headers; the body only with ?body=1 (cut at 64 KB), and
// reading the body is journaled (the id and the envelope, never the body). Postcat's dump is read
// up to 2 MB. Gone from the queue -> 404; any other answer that is no dump -> 502.
router.get('/queue/:queueId', requireAdmin, async (req, res) => {
  const queueId = parseQueueId(req.params.queueId);
  if (!queueId) return refuse(res, 'queue_id_invalid');
  const cfg = await nodeConfigOr(res);
  if (!cfg) return undefined;
  let dump;
  try {
    dump = await getQueuedMessageText(cfg, queueId);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  const withBody = req.query.body === '1';
  const message = parsePostcat(dump.text, { withBody, truncated: dump.truncated });
  if (!message) {
    if (postcatGone(dump.text)) return refuse(res, 'queue_item_not_found');
    return mailNodeFailure(res, new MailNodeError('mail_node_failed', 'The mail node did not show the queued message'));
  }
  if (withBody) {
    recordAudit({
      actorUserId: req.session.userId, action: 'mail_node.queue_action',
      details: {
        action: 'view_body', queueId, queue: message.queue,
        sender: message.envelope.sender ?? '', recipients: message.envelope.recipients,
      },
    });
  }
  return res.json(message);
});

// "Retry all now" (postqueue -f). Journaled.
router.post('/queue/flush', requireAdmin, async (req, res) => {
  const cfg = await nodeConfigOr(res);
  if (!cfg) return undefined;
  try {
    await flushQueue(cfg);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  recordAudit({ actorUserId: req.session.userId, action: 'mail_node.queue_action', details: { action: 'flush' } });
  return res.json({ ok: true, action: 'flush' });
});

// hold, unhold, deliver or delete one queued message. Delete needs { confirm: true } (the screen
// asks first); the whole-queue delete of mailcow is never offered. The message must be in the queue
// now; the journal keeps its envelope (sender, recipients, size), so a deleted message stays
// traceable.
router.post('/queue/:queueId/:action', requireAdmin, async (req, res) => {
  const queueId = parseQueueId(req.params.queueId);
  if (!queueId) return refuse(res, 'queue_id_invalid');
  const { action } = req.params;
  if (![...QUEUE_ACTIONS, 'delete'].includes(action)) return refuse(res, 'queue_action_invalid');
  if (action === 'delete' && req.body?.confirm !== true) return refuse(res, 'queue_delete_unconfirmed');
  const cfg = await nodeConfigOr(res);
  if (!cfg) return undefined;
  let item;
  try {
    item = (await listQueue(cfg)).find((entry) => entry.queueId === queueId);
    if (!item) return refuse(res, 'queue_item_not_found');
    // postqueue -i does not release a held message: it is released first, by "Release".
    if (action === 'deliver' && item.queue === 'hold') return refuse(res, 'queue_item_held');
    if (action === 'delete') await deleteQueued(cfg, [queueId]);
    else await queueAction(cfg, [queueId], action);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  recordAudit({
    actorUserId: req.session.userId, action: 'mail_node.queue_action',
    details: {
      action, queueId, queue: item.queue, sender: item.sender, size: item.size,
      recipients: item.recipients.map((r) => r.address),
    },
  });
  return res.json({ ok: true, action, queueId });
});

// The alerts: the last run ({ at, alerts, errors, log, queue }, null before the first) and the
// settings.
router.get('/alerts', requireAdmin, async (req, res) => {
  const [state, settings] = await Promise.all([getAlertState(), getAlertSettings()]);
  res.json({ state, settings, defaults: ALERT_DEFAULTS });
});

// "Check now": a run at once (or the one going), answered with its state.
router.post('/alerts/check', requireAdmin, async (req, res) => {
  if (!(await nodeConfigOr(res))) return undefined;
  const state = await checkAlertsNow({ userId: req.session.userId, trigger: 'manual' });
  if (!state) return refuse(res, 'alert_check_failed');
  return res.json({ state });
});

// The ping URL of the alerts' own check and the queue thresholds. Journaled by field names.
router.put('/alerts/settings', requireAdmin, async (req, res) => {
  const { settings, error } = parseAlertSettings(req.body);
  if (error) return refuse(res, error);
  const current = await getAlertSettings();
  await saveAlertSettings(settings);
  configAudit(req, 'alerts', Object.keys(settings).filter((field) => settings[field] !== current[field]));
  return res.json({ settings: { ...current, ...settings } });
});

// The TERRL budget now (services/mailNode/settingsActions.js eopBudgetNow, which the panel CLI
// shares): unique external recipients of the last 24 hours against the limit.
router.get('/eop/budget', requireAdmin, async (req, res) => {
  res.json(await eopBudgetNow());
});

export default router;
