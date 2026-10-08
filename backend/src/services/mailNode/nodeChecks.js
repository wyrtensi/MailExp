import { JobError, enqueueJob, getJob, registerJobKind } from '../jobQueue.js';
import { jobBy } from '../actor.js';
import { getMailNodeConfig } from './mailcow.js';
import { checkAllNow } from './dnsCheckJob.js';
import { checkAlertsNow } from './nodeAlerts.js';
import { traceOutagesNow } from './outageActions.js';
import { jobAnswer } from '../tenant/tenantActions.js';

// The node's checks an administrator runs now from the panel CLI (src/cli/mailexpert.js): the DNS
// check of the node and every domain (R-14, R-15), the alert check (R-18, R-19) and a pass of the
// outage trace (R-43). Each belongs to the backend's process: a run joins the one going there, the
// alert check starts the outage trace after it, and the trace counts its requests against a budget
// that process keeps. The panel's buttons run them in the backend at once (routes/mailNode.js,
// mailNodeOutages.js); the CLI, another process, queues a mail_node_check job instead, which the
// backend's job worker runs with the same functions, journaled with the CLI's actor.

export const NODE_CHECK_JOB_KIND = 'mail_node_check';
export const NODE_CHECKS = Object.freeze(['dns', 'alerts', 'outage_trace']);
// A check that failed is asked for again by hand, not retried.
const MAX_ATTEMPTS = 1;

export const NODE_CHECK_ERRORS = Object.freeze({
  mail_node_not_configured: [409, 'The mail node is not set up'],
  node_check_job_not_found: [404, 'No such node check job'],
});

// Queues the check: { job } (jobAnswer), or { error } without a mail node (the outage trace needs
// none: it reads the message trace and keeps going without the node's log).
export async function enqueueNodeCheck(check, actor) {
  if (!NODE_CHECKS.includes(check)) throw new Error(`Unknown node check: ${check}`);
  if (check !== 'outage_trace' && !(await getMailNodeConfig())) return { error: 'mail_node_not_configured' };
  const { job } = await enqueueJob({
    kind: NODE_CHECK_JOB_KIND,
    payload: { check, ...(actor?.via ? { via: actor.via } : {}) },
    createdBy: actor?.userId ?? null,
    maxAttempts: MAX_ATTEMPTS,
  });
  return { job: jobAnswer(job) };
}

// The job as the CLI follows it: { job } or { error }.
export async function getNodeCheckJob(id) {
  if (!/^\d{1,18}$/.test(String(id ?? ''))) return { error: 'node_check_job_not_found' };
  const job = await getJob(String(id));
  if (!job || job.kind !== NODE_CHECK_JOB_KIND) return { error: 'node_check_job_not_found' };
  return { job: jobAnswer(job) };
}

// Runs one queued check in this process. A run that failed or was refused ends the job failed, with
// the code the panel's button answers.
export async function runNodeCheck(job) {
  const userId = job.created_by ?? null;
  const by = jobBy({ userId, via: job.payload?.via ?? null });
  const actor = by.via ? by : null;
  switch (job.payload?.check) {
    case 'dns':
      if (!(await checkAllNow({ userId, by: actor, trigger: 'manual' }))) {
        throw new JobError('The DNS check failed', { outcome: 'fail', code: 'dns_check_failed' });
      }
      return;
    case 'alerts':
      if (!(await checkAlertsNow({ userId, by: actor, trigger: 'manual' }))) {
        throw new JobError('The alert check failed', { outcome: 'fail', code: 'alert_check_failed' });
      }
      return;
    case 'outage_trace': {
      const result = await traceOutagesNow();
      if (result?.cooldown) {
        throw new JobError(`The trace was checked a moment ago: try again after ${result.retryAt}`, { outcome: 'fail', code: 'trace_cooldown' });
      }
      return;
    }
    default:
      throw new JobError('Unknown node check', { outcome: 'fail', code: 'node_check_unknown' });
  }
}

// The backend's handler (index.js).
export function registerNodeCheckJobKind() {
  registerJobKind(NODE_CHECK_JOB_KIND, { maxAttempts: MAX_ATTEMPTS, handler: runNodeCheck });
}
