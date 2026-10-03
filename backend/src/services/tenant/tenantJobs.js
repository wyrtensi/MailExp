import { query } from '../db.js';
import { JobError, enqueueJob, listJobs, registerJobKind } from '../jobQueue.js';
import { recordAudit } from '../auditLog.js';
import { getEopSettings } from '../mailNode/eopSettings.js';
import { SYSTEM_ACTOR } from '../mailNode/domains.js';
import { getTenantDriver, tenantOf } from './driver.js';
import { TenantError, asRows } from './exoRunner.js';
import { policyConflicts, summarizePolicy } from './antispam.js';
import { readConnectors } from './connectors.js';
import { enqueueDueDomainSyncs } from './tenantDomains.js';
import { enqueueReleaseSlot, registerQuarantineReleaseKind } from './quarantineRelease.js';
import { registerMessageTraceKind } from './messageTrace.js';

// The tenant's jobs (stage 7a). They run on the durable job queue (services/jobQueue.js,
// docs/architecture/job-queue.md) instead of a table of their own (R-22 planned `tenant_jobs`):
// the queue already has the claim, the lease, retries and a restart-safe worker. Every kind is
// read only and idempotent (at least once is fine).
//
//   tenant_test_connection  "Test connection": the worker's certificate against the thumbprint in
//                           the settings, a Graph token and GET /domains, EXO whoami
//   tenant_poll             every POLL_INTERVAL_MS while the tenant is configured: the certificate
//                           (its expiry, for the alerts), Get-BlockedConnector (R-27) and the
//                           connectors against their reference (R-25, stage 7b); the anti-spam
//                           policy too when the last read is older than ANTISPAM_MAX_AGE_MS
//
// The domains' tenant steps and the recipient mirror (stage 7b) are jobs of their own, one per
// domain (services/tenant/tenantDomains.js); the poll's timer queues them in the same slot.
//   tenant_antispam_read    Get-HostedContentFilterPolicy -Identity Default (R-28), on demand
//
// Stage 7c adds tenant_quarantine_release (R-42, services/tenant/quarantineRelease.js), queued in
// the same slot, and tenant_message_trace (R-30, services/tenant/messageTrace.js), on request.
//
// What they learn is kept in integration_config 'mail_node_tenant_state', one key per part
// ({ certificate, connection, blockedConnectors, antispam, connectors, connectorReference }), written
// together with the job's end.
// The mail node alerts read it (services/mailNode/nodeAlerts.js, source 'tenant'); nothing on a
// request's path calls the tenant. Errors keep a code and a short message, never a token, an
// assertion or a password.

export const TENANT_STATE_PROVIDER = 'mail_node_tenant_state';
export const TENANT_JOB_KINDS = Object.freeze({
  test: 'tenant_test_connection',
  poll: 'tenant_poll',
  antispam: 'tenant_antispam_read',
});
export const POLL_INTERVAL_MS = 10 * 60 * 1000;
export const ANTISPAM_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Polls failed in a row before the alerts warn that the tenant poll is failing.
export const TENANT_FAILING_POLLS = 3;
const FIRST_POLL_DELAY_MS = 60 * 1000;
const MESSAGE_MAX = 300;

export async function getTenantState(db = { query }) {
  const { rows } = await db.query('SELECT config FROM integration_config WHERE provider = $1', [TENANT_STATE_PROVIDER]);
  return rows[0]?.config ?? {};
}

// Merges the parts given into the stored state (a part replaces its stored value).
export async function saveTenantState(patch, db = { query }) {
  await db.query(`
    INSERT INTO integration_config (provider, config) VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = integration_config.config || EXCLUDED.config, updated_at = NOW()
  `, [TENANT_STATE_PROVIDER, patch]);
}

// A failure as the state keeps it: a stable code and a short message without secrets.
export function failureOf(err) {
  if (err instanceof TenantError) {
    return { code: err.code, message: String(err.message ?? '').slice(0, MESSAGE_MAX), ...(err.retryAfterMs != null ? { retryAfterMs: err.retryAfterMs } : {}) };
  }
  console.error(`Tenant job step failed: ${err?.code || err?.name || 'error'} ${String(err?.message ?? '').slice(0, 200)}`);
  return { code: 'tenant_failed', message: 'The tenant step failed; see the server log' };
}

// The driver and the tenant of the settings, or a JobError that ends the job: a job queued before
// the driver or the settings went away fails at once instead of waiting.
export async function tenantContext() {
  const driver = getTenantDriver();
  if (!driver) throw new JobError('No tenant driver is configured', { outcome: 'fail', code: 'tenant_driver_missing' });
  const settings = await getEopSettings();
  const tenant = tenantOf(settings);
  if (!tenant) throw new JobError('The tenant is not configured', { outcome: 'fail', code: 'tenant_not_configured' });
  return { driver, settings, tenant, session: driver.forTenant(tenant) };
}

function certificatePart(info, at) {
  return {
    at, thumbprint: info.thumbprint ?? null, subject: info.subject ?? null, notBefore: info.notBefore ?? null, notAfter: info.notAfter ?? null,
  };
}

// The connection test, step by step; a failed step stops the steps that depend on it.
export async function testConnection({ driver, tenant, session }, now = Date.now()) {
  const at = new Date(now).toISOString();
  const steps = {};
  let certificate = null;
  try {
    const info = await driver.certificate();
    certificate = certificatePart(info, at);
    const matches = info.thumbprint === tenant.thumbprint;
    steps.certificate = matches
      ? { ok: true, notAfter: info.notAfter }
      : { ok: false, code: 'certificate_mismatch', message: 'The worker holds another certificate than the thumbprint in the settings', workerThumbprint: info.thumbprint };
  } catch (err) {
    steps.certificate = { ok: false, ...failureOf(err) };
  }
  if (steps.certificate.ok) {
    try {
      const answer = await session.graph.request('GET', '/domains?$select=id,isInitial,isVerified');
      const domains = Array.isArray(answer?.value) ? answer.value : [];
      const initial = domains.find((d) => d.isInitial)?.id?.toLowerCase() ?? null;
      steps.graph = initial === tenant.organization
        ? { ok: true, domains: domains.length, initialDomain: initial }
        : { ok: false, code: 'tenant_domain_mismatch', message: 'The tenant\'s initial domain is not the one in the settings', initialDomain: initial };
    } catch (err) {
      steps.graph = { ok: false, ...failureOf(err) };
    }
    try {
      const [org] = asRows(await session.exo.run('whoami'));
      steps.exo = { ok: true, organization: org?.Name ?? null, displayName: org?.DisplayName ?? null };
    } catch (err) {
      steps.exo = { ok: false, ...failureOf(err) };
    }
  }
  const ok = ['certificate', 'graph', 'exo'].every((step) => steps[step]?.ok);
  return { connection: { at, ok, steps }, certificate };
}

// A row without a connector id and name (an empty object) is no connector.
export function blockedConnectorsOf(rows) {
  return asRows(rows).filter((row) => row.ConnectorId || row.ConnectorName).map((row) => ({
    connectorId: row.ConnectorId ? String(row.ConnectorId) : null,
    connectorName: row.ConnectorName ? String(row.ConnectorName) : null,
    reason: row.Reason ? String(row.Reason).slice(0, MESSAGE_MAX) : null,
    createdTime: row.CreatedTime ? String(row.CreatedTime) : null,
  }));
}

export async function readAntispam(session, now = Date.now()) {
  const at = new Date(now).toISOString();
  try {
    const [row] = asRows(await session.exo.run('get_content_filter_policy'));
    const policy = summarizePolicy(row);
    if (!policy) return { at, ok: false, code: 'policy_missing', message: 'The tenant answered no Default policy' };
    return { at, ok: true, policy, conflicts: policyConflicts(policy) };
  } catch (err) {
    return { at, ok: false, ...failureOf(err) };
  }
}

// One poll: the certificate and the blocked connectors, each on its own (one failing keeps the
// other's answer); a failed read keeps the last good list with the error beside it, so the alert
// stays as it was.
export async function poll(context, { previous = {}, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const patch = {};
  try {
    patch.certificate = certificatePart(await context.driver.certificate(), at);
  } catch (err) {
    patch.certificate = { ...(previous.certificate ?? {}), error: failureOf(err), errorAt: at };
  }
  try {
    const items = blockedConnectorsOf(await context.session.exo.run('get_blocked_connector'));
    patch.blockedConnectors = { at, ok: true, items, failures: 0 };
  } catch (err) {
    // failures: polls failed in a row; from TENANT_FAILING_POLLS the alerts warn (nodeAlerts.js).
    const before = previous.blockedConnectors ?? { items: [] };
    patch.blockedConnectors = {
      ...before, ok: false, error: failureOf(err), errorAt: at, failures: (Number(before.failures) || 0) + 1,
    };
  }
  // R-25: a failed read keeps the last good one with the error beside it; the first good read is
  // the reference when there is none yet.
  try {
    patch.connectors = await readConnectors(context.session, at);
    if (!previous.connectorReference) {
      patch.connectorReference = { at, by: null, auto: true, inbound: patch.connectors.inbound, outbound: patch.connectors.outbound };
    }
  } catch (err) {
    patch.connectors = { ...(previous.connectors ?? {}), ok: false, error: failureOf(err), errorAt: at };
  }
  const antispamAt = Date.parse(previous.antispam?.at ?? '');
  if (!Number.isFinite(antispamAt) || now - antispamAt >= ANTISPAM_MAX_AGE_MS) patch.antispam = await readAntispam(context.session, now);
  return patch;
}

export function registerTenantJobKinds() {
  registerJobKind(TENANT_JOB_KINDS.test, {
    maxAttempts: 1,
    handler: async (job, ctx) => {
      const context = await tenantContext();
      const { connection, certificate } = await testConnection(context);
      const antispam = connection.steps.exo?.ok ? await readAntispam(context.session) : null;
      await ctx.complete((tx) => saveTenantState({
        connection: { ...connection, by: job.created_by ?? null },
        ...(certificate ? { certificate } : {}),
        ...(antispam ? { antispam } : {}),
      }, tx));
      recordAudit({
        ...(job.created_by ? { actorUserId: job.created_by } : { actorEmail: SYSTEM_ACTOR }),
        action: 'tenant.connection_tested',
        details: {
          ok: connection.ok,
          failed: Object.entries(connection.steps).filter(([, s]) => !s.ok).map(([step, s]) => `${step}:${s.code}`),
        },
      });
    },
  });
  registerJobKind(TENANT_JOB_KINDS.poll, {
    maxAttempts: 1,
    handler: async (job, ctx) => {
      const context = await tenantContext();
      const patch = await poll(context, { previous: await getTenantState() });
      await ctx.complete((tx) => saveTenantState(patch, tx));
    },
  });
  registerJobKind(TENANT_JOB_KINDS.antispam, {
    maxAttempts: 1,
    handler: async (job, ctx) => {
      const context = await tenantContext();
      const antispam = await readAntispam(context.session);
      await ctx.complete((tx) => saveTenantState({ antispam }, tx));
    },
  });
  // Stage 7c: R-42 (the phishing EOP quarantined, released to the node) and R-30 (a letter's trace).
  registerQuarantineReleaseKind();
  registerMessageTraceKind();
}

// Queues a job of a kind for an administrator's button, or answers the one of that kind still
// queued or running (a double click, two administrators): { job, created }.
export async function enqueueTenantJob(kind, { userId = null } = {}) {
  const [waiting] = await listJobs({ kind, statuses: ['queued', 'running'], limit: 1 });
  if (waiting) return { job: waiting, created: false };
  return enqueueJob({ kind, createdBy: userId });
}

// The poll of the current ten-minute slot, once (the slot is the dedupe key: a restart in the same
// slot, or two processes, queue it once). Nothing without a driver or a configured tenant.
export async function enqueuePoll(now = Date.now()) {
  if (!getTenantDriver()) return null;
  if (!tenantOf(await getEopSettings())) return null;
  // A poll queued or running, or one that ended within half an interval ("Check now" a minute
  // ago), makes this slot's poll unnecessary.
  const { rows: [recent] } = await query(
    `SELECT id FROM jobs WHERE kind = $1
        AND (status IN ('queued', 'running') OR updated_at > to_timestamp($2::double precision / 1000))
      LIMIT 1`,
    [TENANT_JOB_KINDS.poll, now - POLL_INTERVAL_MS / 2],
  );
  if (recent) return null;
  const { job } = await enqueueJob({ kind: TENANT_JOB_KINDS.poll, dedupeKey: `slot-${Math.floor(now / POLL_INTERVAL_MS)}` });
  return job;
}

let firstPoll = null;
let pollTimer = null;

// "Take as the reference" (R-25): the last good read of the connectors becomes the reference.
// Answers { reference } or { error: 'connectors_not_read' }.
export async function takeConnectorReference({ userId = null, now = Date.now() } = {}) {
  const state = await getTenantState();
  if (!state.connectors?.ok || !state.connectors.inbound) return { error: 'connectors_not_read' };
  const reference = {
    at: new Date(now).toISOString(), readAt: state.connectors.at, by: userId, auto: false,
    inbound: state.connectors.inbound, outbound: state.connectors.outbound,
  };
  await saveTenantState({ connectorReference: reference });
  return { reference };
}

export function startTenantPoll() {
  if (pollTimer) return;
  const run = () => {
    enqueuePoll().catch((err) => console.error('Tenant poll could not be queued:', err?.code || err?.message));
    enqueueDueDomainSyncs().catch((err) => console.error('Tenant domain syncs could not be queued:', err?.code || err?.message));
    enqueueReleaseSlot(Date.now(), POLL_INTERVAL_MS).catch((err) => console.error('Tenant phish release could not be queued:', err?.code || err?.message));
  };
  firstPoll = setTimeout(run, FIRST_POLL_DELAY_MS);
  firstPoll.unref?.();
  pollTimer = setInterval(run, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

export function stopTenantPoll() {
  clearTimeout(firstPoll);
  clearInterval(pollTimer);
  firstPoll = null;
  pollTimer = null;
}
