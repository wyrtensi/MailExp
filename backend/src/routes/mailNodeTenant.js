import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { recordAudit } from '../services/auditLog.js';
import { routeActor } from '../services/actor.js';
import { TENANT_JOB_KINDS, takeConnectorReference } from '../services/tenant/tenantJobs.js';
import {
  TENANT_ERRORS, approveAliasContactsRemoval, approveInternalRelay, enqueueTenantAction, getTenantJob,
  phishReleaseStatus, runPhishReleaseNow, setDomainHold, setPhishRelease, syncDomainNow, tenantStatus,
} from '../services/tenant/tenantActions.js';

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
//
// The actions live in services/tenant/tenantActions.js, which the panel CLI (src/cli/mailexpert.js)
// calls too; the route only reads the request and answers.
const router = Router();
router.use('/tenant', requireAuth, requireAdmin);

function refuse(res, code) {
  const [status, error] = TENANT_ERRORS[code];
  return res.status(status).json({ error, code });
}

// An action's answer: its refusal, or the result with the status given (200 by default).
const answer = (res, result, status = 200) => (result.error ? refuse(res, result.error) : res.status(status).json(result));

router.get('/tenant', async (req, res) => {
  res.json(await tenantStatus());
});

function enqueueRoute(kind) {
  return async (req, res) => answer(res, await enqueueTenantAction(kind, routeActor(req)), 202);
}

router.post('/tenant/test', enqueueRoute(TENANT_JOB_KINDS.test));
router.post('/tenant/poll', enqueueRoute(TENANT_JOB_KINDS.poll));
router.post('/tenant/antispam', enqueueRoute(TENANT_JOB_KINDS.antispam));

router.post('/tenant/domains/:domain/sync', async (req, res) => (
  answer(res, await syncDomainNow(req.params.domain, routeActor(req)), 202)
));

router.post('/tenant/domains/:domain/hold', async (req, res) => (
  answer(res, await setDomainHold(req.params.domain, req.body?.hold, routeActor(req)))
));

router.post('/tenant/domains/:domain/internal-relay', async (req, res) => (
  answer(res, await approveInternalRelay(req.params.domain, routeActor(req)), 202)
));

// Section 5.14: an administrator allows the mirror to remove, on an Authoritative domain, the
// contacts stage 7b made for mailcow aliases made by hand. Mail to those aliases is rejected from the
// next run on. Journaled with the addresses the last run held.
router.post('/tenant/domains/:domain/alias-contacts/remove', async (req, res) => {
  const result = await approveAliasContactsRemoval(req.params.domain, routeActor(req));
  if (result.error) return refuse(res, result.error);
  return res.status(202).json({ job: result.job });
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
  res.json(await phishReleaseStatus());
});

router.put('/tenant/phish-release', async (req, res) => (
  answer(res, await setPhishRelease(req.body?.enabled, routeActor(req)))
));

router.post('/tenant/phish-release/run', async (req, res) => (
  answer(res, await runPhishReleaseNow(routeActor(req)), 202)
));

router.get('/tenant/jobs/:id', async (req, res) => answer(res, await getTenantJob(req.params.id)));

export default router;
