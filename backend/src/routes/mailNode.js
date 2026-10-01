import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { recordAudit } from '../services/auditLog.js';
import { DISK_WARN_PERCENT, checkMailNodeDisk } from '../services/mailNode/diskWatch.js';
import {
  DEFAULT_DOMAIN_MAILBOXES,
  DEFAULT_QUOTA_MB,
  MAX_DOMAIN_MAILBOXES,
  MAX_QUOTA_MB,
  MailNodeError,
  addDomain,
  getDiskStatus,
  getMailbox,
  getMailNodeConfig,
  listDomains,
  listMailboxes,
  parseHostName,
  parsePingUrl,
  parseWholeNumber,
  saveMailNodeConfig,
  setMailboxQuota,
} from '../services/mailNode/mailcow.js';
import {
  adoptDomain,
  bindNodeIdentities,
  canCreateMailboxes,
  confirmStep,
  getDomainRow,
  listDomainRows,
  markReady,
  mergeDomains,
  nodeRefusal,
  recordCreatedDomain,
} from '../services/mailNode/domains.js';
import {
  EOP_FIELDS,
  MAX_SEND_LIMIT_PER_HOUR,
  MAX_TERRL,
  getEopSettings,
  parseEopSettings,
  saveEopSettings,
  tenantConfigured,
  tenantDriverActive,
} from '../services/mailNode/eopSettings.js';

// The mail node (mailcow) settings, its domains with their onboarding, the EOP settings and the
// quotas of the mailboxes MailExpert made there. Mounted at /api/mail-node. Everyone signed in may
// list the domains a mailbox can be created on (the add-mailbox form offers them); everything else
// is for administrators.
const router = Router();
router.param('id', uuidParam('id'));

// Sent instead of the stored API key; posting it back keeps the stored key.
const REDACTED_SECRET = '••••••••';

const ERRORS = {
  mail_host_invalid: [400, 'Mail host must be a host name such as mail.example.com'],
  api_key_required: [400, 'API key is required'],
  quota_invalid: [400, `Quota must be a whole number of MB from 1 to ${MAX_QUOTA_MB}`],
  domain_invalid: [400, 'Domain must be a domain name such as example.com'],
  ping_url_invalid: [400, 'Ping URL must be an https address'],
  mailboxes_invalid: [400, `Mailbox limit must be a whole number from 1 to ${MAX_DOMAIN_MAILBOXES}`],
  mail_node_not_configured: [409, 'The mail node is not set up'],
  mailbox_not_found: [404, 'Mail node mailbox not found'],
  domain_not_ready: [400, 'Mailboxes can be created only on a domain that finished its onboarding'],
  domain_not_on_node: [404, 'The mail node has no such domain'],
  domain_not_found: [404, 'The panel does not know this domain'],
  domain_known: [409, 'The panel knows this domain already'],
  domain_already_ready: [409, 'The domain is ready already'],
  domain_recreated: [409, 'The node has another domain of this name now, made again by hand: adopt it again'],
  step_invalid: [400, 'No such onboarding step'],
  step_out_of_order: [409, 'Only the next onboarding step can be confirmed'],
  eop_host_invalid: [400, 'EOP host must be a host name such as contoso-com.mail.protection.outlook.com'],
  certificate_host_invalid: [400, 'Certificate host must be a host name such as mail.example.com'],
  dkim_mode_invalid: [400, 'DKIM mode must be mailcow or eop'],
  send_limit_invalid: [400, `Send limit must be a whole number of messages per hour from 1 to ${MAX_SEND_LIMIT_PER_HOUR}`],
  terrl_invalid: [400, `TERRL must be a whole number of recipients from 1 to ${MAX_TERRL}`],
  tenant_id_invalid: [400, 'Tenant ID must be a GUID'],
  app_id_invalid: [400, 'Application ID must be a GUID'],
  thumbprint_invalid: [400, 'Certificate thumbprint must be 40 hexadecimal characters'],
};

export function refuse(res, code) {
  const [status, error] = ERRORS[code];
  return res.status(status).json({ error, code });
}

// A mailcow failure: 502, the node's own message and a code the screens translate.
export function mailNodeFailure(res, err) {
  if (err instanceof MailNodeError) return res.status(502).json({ error: err.message, code: err.code });
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

router.get('/config', requireAdmin, async (req, res) => {
  const cfg = await getMailNodeConfig();
  res.json({
    configured: !!cfg,
    mailHost: cfg?.mailHost ?? '',
    apiKey: cfg ? REDACTED_SECRET : '',
    quotaMb: cfg?.quotaMb ?? DEFAULT_QUOTA_MB,
    diskPingUrl: cfg?.diskPingUrl ?? '',
  });
});

// Saves only settings the node accepts: the key is checked by listing the domains first.
router.put('/config', requireAdmin, async (req, res) => {
  const mailHost = parseHostName(req.body?.mailHost);
  if (!mailHost) return refuse(res, 'mail_host_invalid');
  const quotaMb = parseWholeNumber(req.body?.quotaMb ?? DEFAULT_QUOTA_MB, 1, MAX_QUOTA_MB);
  if (!quotaMb) return refuse(res, 'quota_invalid');
  const rawPing = typeof req.body?.diskPingUrl === 'string' ? req.body.diskPingUrl.trim() : '';
  const diskPingUrl = rawPing ? parsePingUrl(rawPing) : null;
  if (rawPing && !diskPingUrl) return refuse(res, 'ping_url_invalid');
  const sent = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const current = await getMailNodeConfig();
  let apiKey = sent;
  if (!sent || sent === REDACTED_SECRET) {
    // The stored key goes only to the host it was entered for: a new host needs the key again.
    if (!current?.apiKey || current.mailHost !== mailHost) return refuse(res, 'api_key_required');
    apiKey = current.apiKey;
  }
  const cfg = { mailHost, apiKey, quotaMb, diskPingUrl };
  try {
    await listDomains(cfg);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  await saveMailNodeConfig(cfg);
  configAudit(req, 'node', Object.keys(cfg).filter((field) => current?.[field] !== cfg[field]));
  // Read the disk (and ping) right away instead of at the next scheduled run.
  checkMailNodeDisk().catch((err) => console.error('Mail node disk check failed:', err.message));
  res.json({ ok: true });
});

// The node's domains with the panel's onboarding state of each ('unknown' for a domain the panel
// has no record of). An administrator sees them all; everyone else only those a mailbox can be
// created on.
router.get('/domains', async (req, res) => {
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  let onNode;
  try {
    onNode = await listDomains(cfg);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  const domains = mergeDomains(onNode, await bindNodeIdentities(onNode, await listDomainRows()));
  if (await isAdmin(req)) return res.json({ domains });
  res.json({
    domains: domains
      .filter((d) => d.onNode && d.active && canCreateMailboxes(d.state))
      .map(({ domain, active, state }) => ({ domain, active, state })),
  });
});

// Creates the domain on the node; its onboarding starts at node_created. DNS, the EOP connectors
// and DKIM stay manual (runbook) and are confirmed step by step.
router.post('/domains', requireAdmin, async (req, res) => {
  const domain = parseHostName(req.body?.domain);
  if (!domain) return refuse(res, 'domain_invalid');
  const mailboxes = parseWholeNumber(req.body?.mailboxes ?? DEFAULT_DOMAIN_MAILBOXES, 1, MAX_DOMAIN_MAILBOXES);
  if (!mailboxes) return refuse(res, 'mailboxes_invalid');
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  try {
    await addDomain(cfg, { domain, mailboxes });
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  await recordCreatedDomain({ domain, userId: req.session.userId, maxMailboxes: mailboxes });
  recordAudit({ actorUserId: req.session.userId, action: 'mail_node.domain_added', details: { domain, mailboxes } });
  res.json({ ok: true, domain, state: 'node_created' });
});

// Takes in a domain made on the node by hand, or one made again there after the panel onboarded
// it: it starts at node_created like a new one, bound to the node's identity of the domain.
router.post('/domains/:domain/adopt', requireAdmin, async (req, res) => {
  const domain = parseHostName(req.params.domain);
  if (!domain) return refuse(res, 'domain_invalid');
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  let onNode;
  try {
    onNode = (await listDomains(cfg)).find((d) => d.domain === domain);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  if (!onNode) return refuse(res, 'domain_not_on_node');
  if (!(await adoptDomain({ domain, userId: req.session.userId, nodeCreated: onNode.created }))) return refuse(res, 'domain_known');
  recordAudit({
    actorUserId: req.session.userId, action: 'mail_node.domain_adopted',
    details: { domain, state: 'node_created', origin: 'adopted' },
  });
  res.json({ ok: true, domain, state: 'node_created' });
});

// Answers the refusal and returns true when the row may not move: the panel has no row, the node
// no longer has the domain, or has another one of that name. A stale row only changes by adoption.
async function refusedByNode(res, domain) {
  const row = await getDomainRow(domain);
  if (!row) {
    refuse(res, 'domain_not_found');
    return true;
  }
  const cfg = await getMailNodeConfig();
  if (!cfg) {
    refuse(res, 'mail_node_not_configured');
    return true;
  }
  let onNode;
  try {
    onNode = (await listDomains(cfg)).find((d) => d.domain === domain);
  } catch (err) {
    mailNodeFailure(res, err);
    return true;
  }
  const why = nodeRefusal(row, onNode);
  if (why) refuse(res, why);
  return !!why;
}

function stateChanged(req, res, domain, result, how) {
  if (result.error) return refuse(res, result.error);
  recordAudit({
    actorUserId: req.session.userId, action: 'mail_node.domain_state_changed',
    details: { domain, from: result.from, to: result.to, how },
  });
  return res.json({ ok: true, domain, state: result.to });
}

// "Done": a person confirms the domain's next onboarding step.
router.post('/domains/:domain/steps/:step', requireAdmin, async (req, res) => {
  const domain = parseHostName(req.params.domain);
  if (!domain) return refuse(res, 'domain_invalid');
  if (await refusedByNode(res, domain)) return undefined;
  const result = await confirmStep({ domain, step: req.params.step, userId: req.session.userId });
  return stateChanged(req, res, domain, result, 'step_confirmed');
});

// A pilot or a test stand without a tenant: the domain takes mailboxes without the other steps.
router.post('/domains/:domain/ready', requireAdmin, async (req, res) => {
  const domain = parseHostName(req.params.domain);
  if (!domain) return refuse(res, 'domain_invalid');
  if (await refusedByNode(res, domain)) return undefined;
  const result = await markReady({ domain, userId: req.session.userId });
  return stateChanged(req, res, domain, result, 'marked_ready');
});

function eopAnswer(settings) {
  return { ...settings, tenantConfigured: tenantConfigured(settings), tenantDriverActive: tenantDriverActive() };
}

router.get('/eop', requireAdmin, async (req, res) => {
  res.json(eopAnswer(await getEopSettings()));
});

// Only checked and kept for now: later stages apply them to the node and the tenant.
router.put('/eop', requireAdmin, async (req, res) => {
  const { settings, error } = parseEopSettings(req.body);
  if (error) return refuse(res, error);
  const current = await getEopSettings();
  await saveEopSettings(settings);
  configAudit(req, 'eop', EOP_FIELDS.filter((field) => field in settings && settings[field] !== current[field]));
  res.json(eopAnswer({ ...current, ...settings }));
});

// The node mailboxes MailExpert knows, with quota and usage as the node reports them.
router.get('/mailboxes', requireAdmin, async (req, res) => {
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  const { rows } = await query(
    'SELECT id, email_address FROM email_accounts WHERE mail_node = true ORDER BY email_address'
  );
  let onNode;
  try {
    onNode = new Map((await listMailboxes(cfg)).map((m) => [m.email, m]));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  // The disk is read fresh here; the scheduled check alone pings the ping URL.
  const disk = await getDiskStatus(cfg).then(
    (d) => ({ ...d, warn: d.usedPercent >= DISK_WARN_PERCENT }),
    (err) => ({ error: err.message, code: err.code || 'mail_node_failed' }),
  );
  res.json({
    disk,
    mailboxes: rows.map((row) => {
      const m = onNode.get(row.email_address.toLowerCase());
      return {
        accountId: row.id,
        email: row.email_address,
        onNode: !!m,
        active: m?.active ?? false,
        quotaMb: m?.quotaMb ?? null,
        usedBytes: m?.usedBytes ?? null,
      };
    }),
  });
});

router.put('/mailboxes/:id/quota', requireAdmin, async (req, res) => {
  const quotaMb = parseWholeNumber(req.body?.quotaMb, 1, MAX_QUOTA_MB);
  if (!quotaMb) return refuse(res, 'quota_invalid');
  const { rows } = await query(
    'SELECT email_address FROM email_accounts WHERE id = $1 AND mail_node = true', [req.params.id]
  );
  if (!rows.length) return refuse(res, 'mailbox_not_found');
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
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

export default router;
