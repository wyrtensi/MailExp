import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { query } from '../services/db.js';
import { getJob } from '../services/jobQueue.js';
import { getEopSettings } from '../services/mailNode/eopSettings.js';
import { getTenantDriver, tenantOf, tenantProfileWithoutDriver } from '../services/tenant/driver.js';
import { TENANT_JOB_KINDS, enqueueTenantJob, getTenantState } from '../services/tenant/tenantJobs.js';

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
const router = Router();
router.use('/tenant', requireAuth, requireAdmin);

const ERRORS = {
  tenant_driver_missing: [409, 'No tenant worker is configured for the panel (TENANT_WORKER_URL)'],
  tenant_not_configured: [409, 'Fill in the tenant ID, its onmicrosoft.com domain, the application ID and the certificate thumbprint first'],
  tenant_job_not_found: [404, 'No such tenant job'],
};

function refuse(res, code) {
  const [status, error] = ERRORS[code];
  return res.status(status).json({ error, code });
}

const KINDS = new Set(Object.values(TENANT_JOB_KINDS));

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

router.get('/tenant/jobs/:id', async (req, res) => {
  // Job ids are bigserial: digits only.
  if (!/^\d{1,18}$/.test(req.params.id)) return refuse(res, 'tenant_job_not_found');
  const job = await getJob(req.params.id);
  if (!job || !KINDS.has(job.kind)) return refuse(res, 'tenant_job_not_found');
  return res.json({ job: jobAnswer(job) });
});

export default router;
