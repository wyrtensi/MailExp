import { query } from '../db.js';
import { getJob, listJobs } from '../jobQueue.js';
import { recordAudit } from '../auditLog.js';
import { auditOf, jobBy } from '../actor.js';
import { getEopSettings } from '../mailNode/eopSettings.js';
import { getDomainRow } from '../mailNode/domains.js';
import { parseHostName } from '../mailNode/mailcow.js';
import { getTenantDriver, tenantOf, tenantProfileWithoutDriver } from './driver.js';
import { TENANT_JOB_KINDS, enqueueTenantJob, getTenantState } from './tenantJobs.js';
import { DOMAIN_SYNC_KIND, enqueueDomainSync, kickDomainSync } from './tenantDomains.js';
import { connectorDrift } from './connectors.js';
import {
  QUARANTINE_RELEASE_KIND, getReleaseSettings, heldSummary, listHeld, listReleases, setReleaseEnabled,
} from './quarantineRelease.js';

// The administrator's actions on the Microsoft tenant, shared by routes/mailNodeTenant.js and the
// panel CLI (src/cli/mailexpert.js). Each one answers its result or { error: code }; the code is a
// key of TENANT_ERRORS, which the route answers with its status and the CLI prints. Nothing here
// calls the tenant: the actions queue jobs (services/tenant/tenantJobs.js, tenantDomains.js,
// quarantineRelease.js) that the backend's worker runs. actor: services/actor.js.

export const TENANT_ERRORS = Object.freeze({
  tenant_driver_missing: [409, 'No tenant worker is configured for the panel (TENANT_WORKER_URL)'],
  tenant_not_configured: [409, 'Fill in the tenant ID, its onmicrosoft.com domain, the application ID and the certificate thumbprint first'],
  tenant_job_not_found: [404, 'No such tenant job'],
  domain_invalid: [400, 'Domain must be a domain name such as example.com'],
  domain_not_found: [404, 'The panel does not know this domain'],
  connectors_not_read: [409, 'The connectors have not been read yet: check now first'],
  hold_invalid: [400, 'hold must be true or false'],
  domain_authoritative: [409, 'The domain is Authoritative already: it is not held on Internal Relay'],
  internal_relay_not_needed: [409, 'The domain does not wait for this decision'],
  alias_contacts_not_held: [409, 'The domain holds no alias contacts for a decision'],
  alias_contacts_changed: [409, 'The held alias contacts changed since they were shown: look at them again'],
  enabled_invalid: [400, 'enabled must be true or false'],
  phish_release_paused: [409, 'The release of quarantined phishing is paused'],
});

// The job kinds of the tenant: its buttons, the domains' steps and the quarantine release.
export const TENANT_KINDS = Object.freeze([...Object.values(TENANT_JOB_KINDS), DOMAIN_SYNC_KIND, QUARANTINE_RELEASE_KIND]);
const KINDS = new Set(TENANT_KINDS);

export const jobAnswer = (job) => (job ? {
  id: String(job.id), kind: job.kind, status: job.status, errorCode: job.error_code ?? null, error: job.last_error ?? null,
  createdAt: job.created_at ?? null, updatedAt: job.updated_at ?? null,
} : null);

async function latestJob(kind) {
  const { rows: [job] } = await query('SELECT * FROM jobs WHERE kind = $1 ORDER BY id DESC LIMIT 1', [kind]);
  return jobAnswer(job ?? null);
}

// GET /tenant: { driver, profileWithoutDriver, configured, state, connectorDrift, jobs }.
export async function tenantStatus() {
  const [settings, state] = await Promise.all([getEopSettings(), getTenantState()]);
  const driver = getTenantDriver();
  // The latest job of each button's kind: the screen shows a test still running after a reload.
  const [test, antispam, poll] = await Promise.all([
    latestJob(TENANT_JOB_KINDS.test), latestJob(TENANT_JOB_KINDS.antispam), latestJob(TENANT_JOB_KINDS.poll),
  ]);
  return {
    driver: driver?.kind ?? null,
    // The worker's compose profile is on but the backend has no driver (TENANT_WORKER_URL unset).
    profileWithoutDriver: tenantProfileWithoutDriver(),
    configured: !!tenantOf(settings),
    state,
    // R-25: what changed in the connectors since the reference.
    connectorDrift: connectorDrift(state.connectorReference, state.connectors),
    jobs: { test, antispam, poll },
  };
}

// Precondition of every action that queues tenant work: a driver and a configured tenant.
async function tenantRefusal() {
  if (!getTenantDriver()) return 'tenant_driver_missing';
  if (!tenantOf(await getEopSettings())) return 'tenant_not_configured';
  return null;
}

// "Test connection", "Check now" and "Check and fix" of the anti-spam policy: { job, created }.
export async function enqueueTenantAction(kind, actor) {
  const error = await tenantRefusal();
  if (error) return { error };
  const { job, created } = await enqueueTenantJob(kind, jobBy(actor));
  return { job: jobAnswer(job), created };
}

// "Run the tenant steps now" for one domain: { job, created }.
export async function syncDomainNow(rawDomain, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  const error = await tenantRefusal();
  if (error) return { error };
  if (!(await getDomainRow(domain))) return { error: 'domain_not_found' };
  const { job, created } = await enqueueDomainSync(domain, jobBy(actor));
  return { job: jobAnswer(job), created };
}

// Keep the domain on Internal Relay (hold: true, the default) or let a complete mirror make it
// Authoritative (false): { domain, holdInternalRelay }.
export async function setDomainHold(rawDomain, hold, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  if (typeof hold !== 'boolean') return { error: 'hold_invalid' };
  const { rows: [row] } = await query('SELECT state, hold_internal_relay FROM mail_node_domains WHERE domain = $1', [domain]);
  if (!row) return { error: 'domain_not_found' };
  if (row.state === 'authoritative') return { error: 'domain_authoritative' };
  await query('UPDATE mail_node_domains SET hold_internal_relay = $2, updated_at = NOW() WHERE domain = $1', [domain, hold]);
  if (row.hold_internal_relay !== hold) {
    recordAudit(auditOf(actor, { action: 'tenant.domain_hold_changed', details: { domain, hold } }));
  }
  // Released: the next run may make the domain Authoritative.
  if (!hold) await kickDomainSync(domain, jobBy(actor));
  return { domain, holdInternalRelay: hold };
}

// Approve moving a domain the tenant already had as Authoritative to Internal Relay: { job }.
export async function approveInternalRelay(rawDomain, actor) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  const error = await tenantRefusal();
  if (error) return { error };
  const { rows: [row] } = await query('SELECT tenant_sync FROM mail_node_domains WHERE domain = $1', [domain]);
  if (!row) return { error: 'domain_not_found' };
  if (row.tenant_sync?.acceptedDomain?.code !== 'authoritative_in_tenant') return { error: 'internal_relay_not_needed' };
  await query('UPDATE mail_node_domains SET internal_relay_approved_at = NOW(), updated_at = NOW() WHERE domain = $1', [domain]);
  recordAudit(auditOf(actor, { action: 'tenant.internal_relay_approved', details: { domain } }));
  const { job } = await enqueueDomainSync(domain, jobBy(actor));
  return { job: jobAnswer(job) };
}

// Section 5.14: allow the mirror to remove, on an Authoritative domain, the contacts stage 7b made
// for mailcow aliases made by hand. Mail to those aliases is rejected from the next run on.
// Journaled with the addresses the last run held: { job, addresses }. expected: the addresses the
// caller showed for the decision; when the last run holds others, nothing is approved.
export async function approveAliasContactsRemoval(rawDomain, actor, { expected = null } = {}) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  const error = await tenantRefusal();
  if (error) return { error };
  const { rows: [row] } = await query('SELECT tenant_sync FROM mail_node_domains WHERE domain = $1', [domain]);
  if (!row) return { error: 'domain_not_found' };
  const held = row.tenant_sync?.mirror?.heldAliasContacts ?? [];
  if (!held.length) return { error: 'alias_contacts_not_held' };
  const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  if (expected && !sameSet(expected, held)) return { error: 'alias_contacts_changed' };
  await query('UPDATE mail_node_domains SET alias_contacts_approved_at = NOW(), updated_at = NOW() WHERE domain = $1', [domain]);
  recordAudit(auditOf(actor, { action: 'tenant.alias_contacts_removal_approved', details: { domain, addresses: held } }));
  const { job } = await enqueueDomainSync(domain, jobBy(actor));
  return { job: jobAnswer(job), addresses: held };
}

// The aliases whose contacts wait for that decision, as the last run held them.
export async function heldAliasContactsOf(rawDomain) {
  const domain = parseHostName(rawDomain);
  if (!domain) return { error: 'domain_invalid' };
  const { rows: [row] } = await query('SELECT tenant_sync FROM mail_node_domains WHERE domain = $1', [domain]);
  if (!row) return { error: 'domain_not_found' };
  return { domain, addresses: row.tenant_sync?.mirror?.heldAliasContacts ?? [] };
}

// Stage 7c, R-42: { enabled, changedAt, run, held, releases, job }.
export async function phishReleaseStatus() {
  const [settings, state, releases, held] = await Promise.all([getReleaseSettings(), getTenantState(), listReleases(), heldSummary()]);
  return {
    enabled: settings.enabled, changedAt: settings.changedAt, run: state.phishRelease ?? null, held, releases,
    job: await latestJob(QUARANTINE_RELEASE_KIND),
  };
}

// The messages the panel keeps in the quarantine (heldSummary's rows): { held, messages }.
export async function heldReleases() {
  const [held, messages] = await Promise.all([heldSummary(), listHeld()]);
  return { held, messages };
}

// Pause (false) or resume (true) the releases: { enabled, changedAt }.
export async function setPhishRelease(enabled, actor) {
  if (typeof enabled !== 'boolean') return { error: 'enabled_invalid' };
  const config = await setReleaseEnabled(enabled, { actor });
  return { enabled: config.enabled, changedAt: config.changedAt };
}

// "Release now": a run of the release job now: { job, created }.
export async function runPhishReleaseNow(actor) {
  const error = await tenantRefusal();
  if (error) return { error };
  if (!(await getReleaseSettings()).enabled) return { error: 'phish_release_paused' };
  const { job, created } = await enqueueTenantJob(QUARANTINE_RELEASE_KIND, jobBy(actor));
  return { job: jobAnswer(job), created };
}

// One job of the tenant's kinds: { job }.
export async function getTenantJob(id) {
  // Job ids are bigserial: digits only.
  if (!/^\d{1,18}$/.test(String(id ?? ''))) return { error: 'tenant_job_not_found' };
  const job = await getJob(String(id));
  if (!job || !KINDS.has(job.kind)) return { error: 'tenant_job_not_found' };
  return { job: jobAnswer(job) };
}

// The newest jobs of the tenant's kinds (statuses: a subset of the queue's, null for all), with
// the payload's domain when the job is about one: { jobs }.
export async function listTenantJobs({ statuses = null, kinds = null, limit = 50 } = {}) {
  const wanted = kinds ? kinds.filter((kind) => KINDS.has(kind)) : TENANT_KINDS;
  const rows = await listJobs({ kinds: wanted, statuses, limit, newestFirst: true });
  return { jobs: rows.map((job) => ({ ...jobAnswer(job), domain: job.payload?.domain ?? null })) };
}
