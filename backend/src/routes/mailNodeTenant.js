import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { query } from '../services/db.js';
import { getJob } from '../services/jobQueue.js';
import { getEopSettings } from '../services/mailNode/eopSettings.js';
import { getDomainRow } from '../services/mailNode/domains.js';
import { parseHostName } from '../services/mailNode/mailcow.js';
import { recordAudit } from '../services/auditLog.js';
import { getTenantDriver, tenantOf, tenantProfileWithoutDriver } from '../services/tenant/driver.js';
import { TENANT_JOB_KINDS, enqueueTenantJob, getTenantState, takeConnectorReference } from '../services/tenant/tenantJobs.js';
import { DOMAIN_SYNC_KIND, enqueueDomainSync, kickDomainSync } from '../services/tenant/tenantDomains.js';
import { connectorDrift } from '../services/tenant/connectors.js';
import {
  QUARANTINE_RELEASE_KIND, getReleaseSettings, heldSummary, listReleases, setReleaseEnabled,
} from '../services/tenant/quarantineRelease.js';

// The Microsoft tenant (stage 7a: R-22, R-27, R-28), mounted at /api/mail-node next to
// routes/mailNode.js, administrators only. Reads answer what the tenant jobs stored
// (services/tenant/tenantJobs.js); the buttons queue a job and answer at once with its id
// (202), and the screen follows it through GET /tenant/jobs/:id. Nothing here calls the tenant on
// the request's path.
//
//   GET  /tenant              { driver, profileWithoutDriver, configured, state, jobs }: driver
//                             'worker' | 'fake' | null
//   POST /tenant/test         "Test connection"
//   POST /tenant/poll         "Check now" of the blocked connectors and the certificate
//   POST /tenant/antispam     read the anti-spam policy again
//   GET  /tenant/jobs/:id     { id, kind, status, errorCode, error }
//
// Stage 7b (R-23 ... R-26, R-29):
//   POST /tenant/domains/:domain/sync    "Run the tenant steps now" for one domain (its result
//                                        comes with GET /api/mail-node/domains, tenantSync)
//   POST /tenant/connectors/reference    the last read of the connectors becomes the reference
//                                        (R-25); GET /tenant answers the drift from it
//   POST /tenant/domains/:domain/hold    { hold: true | false }: keep the domain on Internal Relay
//                                        (default) or let a complete mirror make it Authoritative
//   POST /tenant/domains/:domain/internal-relay   approve moving a domain the tenant already had as
//                                        Authoritative to Internal Relay
const router = Router();
router.use('/tenant', requireAuth, requireAdmin);

const ERRORS = {
  tenant_driver_missing: [409, 'No tenant worker is configured for the panel (TENANT_WORKER_URL)'],
  tenant_not_configured: [409, 'Fill in the tenant ID, its onmicrosoft.com domain, the application ID and the certificate thumbprint first'],
  tenant_job_not_found: [404, 'No such tenant job'],
  domain_invalid: [400, 'Domain must be a domain name such as example.com'],
  domain_not_found: [404, 'The panel does not know this domain'],
  connectors_not_read: [409, 'The connectors have not been read yet: check now first'],
  hold_invalid: [400, 'hold must be true or false'],
  domain_authoritative: [409, 'The domain is Authoritative already: it is not held on Internal Relay'],
  internal_relay_not_needed: [409, 'The domain does not wait for this decision'],
  enabled_invalid: [400, 'enabled must be true or false'],
  phish_release_paused: [409, 'The release of quarantined phishing is paused'],
};

function refuse(res, code) {
  const [status, error] = ERRORS[code];
  return res.status(status).json({ error, code });
}

const KINDS = new Set([...Object.values(TENANT_JOB_KINDS), DOMAIN_SYNC_KIND, QUARANTINE_RELEASE_KIND]);

const jobAnswer = (job) => (job ? {
  id: String(job.id), kind: job.kind, status: job.status, errorCode: job.error_code ?? null, error: job.last_error ?? null,
  createdAt: job.created_at ?? null, updatedAt: job.updated_at ?? null,
} : null);

router.get('/tenant', async (req, res) => {
  const [settings, state] = await Promise.all([getEopSettings(), getTenantState()]);
  const driver = getTenantDriver();
  // The latest job of each button's kind: the screen shows a test still running after a reload.
  const latest = async (kind) => {
    const { rows: [job] } = await query('SELECT * FROM jobs WHERE kind = $1 ORDER BY id DESC LIMIT 1', [kind]);
    return jobAnswer(job ?? null);
  };
  const [test, antispam, poll] = await Promise.all([
    latest(TENANT_JOB_KINDS.test), latest(TENANT_JOB_KINDS.antispam), latest(TENANT_JOB_KINDS.poll),
  ]);
  res.json({
    driver: driver?.kind ?? null,
    // The worker's compose profile is on but the backend has no driver (TENANT_WORKER_URL unset).
    profileWithoutDriver: tenantProfileWithoutDriver(),
    configured: !!tenantOf(settings),
    state,
    // R-25: what changed in the connectors since the reference.
    connectorDrift: connectorDrift(state.connectorReference, state.connectors),
    jobs: { test, antispam, poll },
  });
});

function enqueueRoute(kind) {
  return async (req, res) => {
    if (!getTenantDriver()) return refuse(res, 'tenant_driver_missing');
    if (!tenantOf(await getEopSettings())) return refuse(res, 'tenant_not_configured');
    const { job, created } = await enqueueTenantJob(kind, { userId: req.session.userId });
    return res.status(202).json({ job: jobAnswer(job), created });
  };
}

router.post('/tenant/test', enqueueRoute(TENANT_JOB_KINDS.test));
router.post('/tenant/poll', enqueueRoute(TENANT_JOB_KINDS.poll));
router.post('/tenant/antispam', enqueueRoute(TENANT_JOB_KINDS.antispam));

// Precondition of the buttons: a driver and a configured tenant.
async function tenantRefusal(res) {
  if (!getTenantDriver()) return refuse(res, 'tenant_driver_missing');
  if (!tenantOf(await getEopSettings())) return refuse(res, 'tenant_not_configured');
  return null;
}

router.post('/tenant/domains/:domain/sync', async (req, res) => {
  const domain = parseHostName(req.params.domain);
  if (!domain) return refuse(res, 'domain_invalid');
  if (await tenantRefusal(res)) return undefined;
  if (!(await getDomainRow(domain))) return refuse(res, 'domain_not_found');
  const { job, created } = await enqueueDomainSync(domain, { userId: req.session.userId });
  return res.status(202).json({ job: jobAnswer(job), created });
});

router.post('/tenant/domains/:domain/hold', async (req, res) => {
  const domain = parseHostName(req.params.domain);
  if (!domain) return refuse(res, 'domain_invalid');
  if (typeof req.body?.hold !== 'boolean') return refuse(res, 'hold_invalid');
  const { rows: [row] } = await query('SELECT state, hold_internal_relay FROM mail_node_domains WHERE domain = $1', [domain]);
  if (!row) return refuse(res, 'domain_not_found');
  if (row.state === 'authoritative') return refuse(res, 'domain_authoritative');
  await query('UPDATE mail_node_domains SET hold_internal_relay = $2, updated_at = NOW() WHERE domain = $1', [domain, req.body.hold]);
  if (row.hold_internal_relay !== req.body.hold) {
    recordAudit({ actorUserId: req.session.userId, action: 'tenant.domain_hold_changed', details: { domain, hold: req.body.hold } });
  }
  // Released: the next run may make the domain Authoritative.
  if (!req.body.hold) await kickDomainSync(domain, { userId: req.session.userId });
  return res.json({ domain, holdInternalRelay: req.body.hold });
});

router.post('/tenant/domains/:domain/internal-relay', async (req, res) => {
  const domain = parseHostName(req.params.domain);
  if (!domain) return refuse(res, 'domain_invalid');
  if (await tenantRefusal(res)) return undefined;
  const { rows: [row] } = await query('SELECT tenant_sync FROM mail_node_domains WHERE domain = $1', [domain]);
  if (!row) return refuse(res, 'domain_not_found');
  if (row.tenant_sync?.acceptedDomain?.code !== 'authoritative_in_tenant') return refuse(res, 'internal_relay_not_needed');
  await query('UPDATE mail_node_domains SET internal_relay_approved_at = NOW(), updated_at = NOW() WHERE domain = $1', [domain]);
  recordAudit({ actorUserId: req.session.userId, action: 'tenant.internal_relay_approved', details: { domain } });
  const { job } = await enqueueDomainSync(domain, { userId: req.session.userId });
  return res.status(202).json({ job: jobAnswer(job) });
});

router.post('/tenant/connectors/reference', async (req, res) => {
  const result = await takeConnectorReference({ userId: req.session.userId });
  if (result.error) return refuse(res, result.error);
  recordAudit({
    actorUserId: req.session.userId, action: 'tenant.connector_reference_taken',
    details: { inbound: result.reference.inbound.map((c) => c.name), outbound: result.reference.outbound.map((c) => c.name) },
  });
  return res.json({ reference: result.reference });
});

// Stage 7c, R-42: the high confidence phishing the panel releases from EOP's quarantine.
//   GET  /tenant/phish-release        { enabled, changedAt, run, held, releases, job }
//   PUT  /tenant/phish-release        { enabled: true | false }: pause or resume the releases
//   POST /tenant/phish-release/run    "Release now": a run of the job now (202)
router.get('/tenant/phish-release', async (req, res) => {
  const [settings, state, releases, held] = await Promise.all([getReleaseSettings(), getTenantState(), listReleases(), heldSummary()]);
  const { rows: [job] } = await query('SELECT * FROM jobs WHERE kind = $1 ORDER BY id DESC LIMIT 1', [QUARANTINE_RELEASE_KIND]);
  res.json({
    enabled: settings.enabled, changedAt: settings.changedAt, run: state.phishRelease ?? null, held, releases, job: jobAnswer(job ?? null),
  });
});

router.put('/tenant/phish-release', async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return refuse(res, 'enabled_invalid');
  const config = await setReleaseEnabled(req.body.enabled, { userId: req.session.userId });
  return res.json({ enabled: config.enabled, changedAt: config.changedAt });
});

router.post('/tenant/phish-release/run', async (req, res) => {
  if (await tenantRefusal(res)) return undefined;
  if (!(await getReleaseSettings()).enabled) return refuse(res, 'phish_release_paused');
  const { job, created } = await enqueueTenantJob(QUARANTINE_RELEASE_KIND, { userId: req.session.userId });
  return res.status(202).json({ job: jobAnswer(job), created });
});

router.get('/tenant/jobs/:id', async (req, res) => {
  // Job ids are bigserial: digits only.
  if (!/^\d{1,18}$/.test(req.params.id)) return refuse(res, 'tenant_job_not_found');
  const job = await getJob(req.params.id);
  if (!job || !KINDS.has(job.kind)) return refuse(res, 'tenant_job_not_found');
  return res.json({ job: jobAnswer(job) });
});

export default router;
