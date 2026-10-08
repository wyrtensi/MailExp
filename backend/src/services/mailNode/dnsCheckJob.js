import { query } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import { MailNodeError, getDkim, getMailNodeConfig } from './mailcow.js';
import { getEopSettings } from './eopSettings.js';
import { SYSTEM_ACTOR } from './domains.js';
import {
  DnsCheckError,
  checkDomainDns,
  checkNodeDns,
  checkSubmissionCertificate,
  createResolver,
  overallStatus,
  probeResolver,
} from './dnsCheck.js';

// Runs the DNS checks (services/mailNode/dnsCheck.js, R-14 and R-15) for the node and the domains the
// panel knows, keeps the last result of each and journals what an administrator should know:
// - the node's result in integration_config ('mail_node_dns_check'), each domain's in
//   mail_node_domains.dns_check / dns_checked_at (cleared by "Restart onboarding");
// - mail_node.dns_checked: every check an administrator started, and a result of a scheduled or
//   automatic check only when its overall status differs from the one before (a first result is
//   no change), so the schedule does not fill the journal.
// A check that could not ask DNS (a lookup that failed instead of finding nothing, a resolver
// setting that is no address, a resolver that does not answer, an exception) is no result: the
// previous result stays, with lookupFailed { at, code, detail, checks } next to it, and it neither
// counts as a change nor shows as DNS errors.
// A result never changes a domain's onboarding state: DNS problems only warn, the administrator
// confirms "DNS is right" by hand and may restart the onboarding (owner's decision 2026-10-01).
//
// "Check everything" (the node and every domain) runs in the background: at most one at a time (a
// second request joins the running one), first a probe of the resolver that ends the run as a
// lookup failure when it does not answer, then the domains eight at a time until a deadline, each
// on its own so one failure does not stop the rest. It runs every six hours after a first run
// shortly after the start, and on "Check now". A check of one domain runs on its own, never
// waiting for a run of everything.

export const DNS_CHECK_PROVIDER = 'mail_node_dns_check';
// Why a check ran: an administrator's "Check now", the schedule, or saving the values a domain must
// publish.
export const DNS_CHECK_TRIGGERS = Object.freeze(['manual', 'schedule', 'expected_changed']);
export const DOMAIN_CONCURRENCY = 8;
export const RUN_DEADLINE_MS = 10 * 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
// What makes a check no result: DNS could not be asked.
const NO_ANSWER_CODES = new Set(['dns_lookup_failed', 'dns_resolver_invalid']);

let timer = null;
let firstRun = null;
let running = null;
// Why the last run failed ({ code, message }), for the job that waited on it (nodeChecks.js).
let lastError = null;

// The values a domain must publish that are entered by hand until the tenant driver reads them
// (stored in mail_node_domains.tenant).
function expectedOf(row) {
  const tenant = row.tenant ?? {};
  const cnames = tenant.dkimSelector1Cname || tenant.dkimSelector2Cname
    ? { selector1: tenant.dkimSelector1Cname ?? null, selector2: tenant.dkimSelector2Cname ?? null }
    : null;
  return { expectedMx: row.expected_mx ?? [], tenantTxt: tenant.verificationTxt ?? null, dkimCnames: cnames };
}

// The key mailcow signs the domain with, read from the node; when the node does not answer, the one
// the last apply saw (said so in the result).
async function dkimKeyFor(cfg, row) {
  try {
    return await getDkim(cfg, row.domain);
  } catch (err) {
    if (!(err instanceof MailNodeError)) throw err;
    const stored = row.apply_result?.dkim;
    return stored?.txt ? { ...stored, fromLastApply: true } : null;
  }
}

// Why a run could ask no DNS at all, as the failure every result of it records.
const noAnswer = (code, detail) => ({ code, detail, checks: [] });

// The lookup failure of a result, or null for a result: the checks that could not ask DNS.
function failureOf(result) {
  const failed = result.checks.filter((c) => NO_ANSWER_CODES.has(c.code));
  if (!failed.length) return null;
  return {
    code: failed[0].code, detail: failed[0].detail ?? null,
    checks: failed.map(({ check, name, detail }) => ({ check, name: name ?? null, detail: detail ?? null })),
  };
}

function resolverOrFailure() {
  try {
    return { resolver: createResolver() };
  } catch (err) {
    if (err instanceof DnsCheckError) return { failure: noAnswer(err.code, err.message) };
    throw err;
  }
}

async function checkOneDomain(cfg, eop, row, resolver) {
  const dkimMode = row.dkim_mode ?? eop.dkimMode;
  return checkDomainDns({
    domain: row.domain, ...expectedOf(row), dkimMode,
    dkimKey: dkimMode === 'mailcow' ? await dkimKeyFor(cfg, row) : null,
    nodeIp: eop.nodeIp, resolver,
  });
}

async function checkNode(cfg, eop, resolver) {
  const dns = await checkNodeDns({ mailHost: cfg.mailHost, nodeIp: eop.nodeIp, resolver });
  const names = [...new Set([cfg.mailHost, eop.certificateHost].filter(Boolean))];
  const cert = await checkSubmissionCertificate({ host: cfg.mailHost, names });
  const checks = [...dns.checks, ...cert];
  return { checks, overall: overallStatus(checks) };
}

// One check's outcome as it is kept: a result replaces the one before; a lookup failure keeps it
// (or a result with no checks and no status, when there was none) and records the failure next to
// it. Returns { kept, before, failed }: what is stored now, the overall status of the result before
// (null when there was none) and whether DNS could not be asked.
function outcome(previous, { at, trigger, checks, overall, failure }) {
  const before = previous?.overall ?? null;
  if (failure) {
    const kept = { at: null, overall: null, trigger: null, checks: [], ...(previous ?? {}), lookupFailed: { at, trigger, ...failure } };
    return { kept, before, failed: true };
  }
  return { kept: { at, overall, trigger, checks }, before, failed: false };
}

async function saveDomainOutcome(domain, run) {
  const { rows } = await query('SELECT dns_check FROM mail_node_domains WHERE domain = $1', [domain]);
  const result = outcome(rows[0]?.dns_check ?? null, run);
  await query(`
    UPDATE mail_node_domains SET dns_check = $2, dns_checked_at = CASE WHEN $3 THEN dns_checked_at ELSE $4::timestamptz END
     WHERE domain = $1
  `, [domain, result.kept, result.failed, run.at]);
  return result;
}

export async function getNodeDnsCheck() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [DNS_CHECK_PROVIDER]);
  return rows[0]?.config ?? null;
}

async function saveNodeOutcome(run) {
  const result = outcome(await getNodeDnsCheck(), run);
  await query(`
    INSERT INTO integration_config (provider, config) VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  `, [DNS_CHECK_PROVIDER, result.kept]);
  return result;
}

const namesWith = (checks, status) => checks.filter((c) => c.status === status).map((c) => c.check);
const actor = (userId) => (userId ? { actorUserId: userId } : { actorEmail: SYSTEM_ACTOR });
// A journal entry of a check. by: who asked, as services/actor.js names them, when the panel CLI
// asked (the entry then carries details.via); without it the user or the system.
const entryOf = (userId, by, entry) => (by ? auditOf(by, entry) : { ...actor(userId), ...entry });

// The journal entry of one check: always for an administrator's check (a lookup failure says so),
// otherwise only for a result whose overall status changed from a previous one.
function journal({ userId, by = null, trigger, scope, domain, saved }) {
  const manual = trigger === 'manual';
  if (saved.failed) {
    if (!manual) return;
    recordAudit(entryOf(userId, by, {
      action: 'mail_node.dns_checked',
      details: {
        scope, ...(domain ? { domain } : {}), trigger, lookupFailed: true,
        code: saved.kept.lookupFailed.code, detail: saved.kept.lookupFailed.detail,
      },
    }));
    return;
  }
  if (!manual && (saved.before === null || saved.before === saved.kept.overall)) return;
  recordAudit(entryOf(userId, by, {
    action: 'mail_node.dns_checked',
    details: {
      scope, ...(domain ? { domain } : {}), trigger, overall: saved.kept.overall, from: saved.before,
      errors: namesWith(saved.kept.checks, 'error'), warnings: namesWith(saved.kept.checks, 'warning'),
    },
  }));
}

const notConfigured = () => new MailNodeError('mail_node_not_configured', 'The mail node is not set up', 409);

async function domainRows(domain) {
  const { rows } = await query(`
    SELECT domain, dkim_mode, expected_mx, tenant, apply_result FROM mail_node_domains
     WHERE ($1::text IS NULL OR domain = $1) ORDER BY domain`, [domain ?? null]);
  return rows;
}

// One check of one domain, never thrown: an exception is a failure of this domain alone.
async function runDomain(cfg, eop, row, resolver, failure) {
  if (failure) return { failure };
  try {
    const result = await checkOneDomain(cfg, eop, row, resolver);
    return { ...result, failure: failureOf(result) };
  } catch (err) {
    console.error(`Mail node DNS check of ${row.domain} failed: ${err?.code || err?.name || 'error'}: ${String(err?.message ?? '').slice(0, 300)}`);
    return { failure: noAnswer('check_failed', err?.code || err?.name || 'error') };
  }
}

// The answer of a check of one domain: the result kept, with the domain's name.
const answerOf = (domain, saved) => ({ domain, ...saved.kept });

// One domain the panel knows, at once and on its own: { domain, at, overall, trigger, checks,
// lookupFailed? }. trigger: 'manual' or 'expected_changed'. by: the panel CLI's actor (journal).
export async function checkDomainNow({ domain, userId = null, by = null, trigger = 'manual' }) {
  const cfg = await getMailNodeConfig();
  if (!cfg) throw notConfigured();
  const [row] = await domainRows(domain);
  if (!row) throw new MailNodeError('domain_not_found', 'The panel does not know this domain', 404);
  const eop = await getEopSettings();
  const { resolver, failure } = resolverOrFailure();
  const at = new Date().toISOString();
  const result = await runDomain(cfg, eop, row, resolver, failure);
  const saved = await saveDomainOutcome(row.domain, { at, trigger, ...result });
  journal({ userId, by, trigger, scope: 'domain', domain: row.domain, saved });
  return answerOf(row.domain, saved);
}

// Runs fn over the items, at most `limit` at once.
async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function runAll({ userId, by = null, trigger, deadlineMs = RUN_DEADLINE_MS }) {
  const cfg = await getMailNodeConfig();
  if (!cfg) throw notConfigured();
  const eop = await getEopSettings();
  const ends = Date.now() + deadlineMs;
  const made = resolverOrFailure();
  const { resolver } = made;
  let { failure } = made;
  if (!failure) {
    const probe = await probeResolver(resolver, cfg.mailHost);
    if (probe) failure = noAnswer('dns_lookup_failed', probe);
  }
  const at = new Date().toISOString();
  let node;
  try {
    node = failure ? { failure } : await checkNode(cfg, eop, resolver);
    if (!node.failure) node.failure = failureOf(node);
  } catch (err) {
    console.error(`Mail node DNS check of the node failed: ${err?.code || err?.name || 'error'}: ${String(err?.message ?? '').slice(0, 300)}`);
    node = { failure: noAnswer('check_failed', err?.code || err?.name || 'error') };
  }
  const nodeSaved = await saveNodeOutcome({ at, trigger, ...node });
  const domains = [];
  const skipped = [];
  await eachLimited(await domainRows(null), DOMAIN_CONCURRENCY, async (row) => {
    if (Date.now() > ends) {
      skipped.push(row.domain);
      return;
    }
    const result = await runDomain(cfg, eop, row, resolver, failure);
    const saved = await saveDomainOutcome(row.domain, { at, trigger, ...result });
    domains.push({ domain: row.domain, saved });
  });
  domains.sort((a, b) => a.domain.localeCompare(b.domain));
  if (skipped.length) console.error(`Mail node DNS check stopped at its deadline: ${skipped.length} domain(s) not checked`);
  if (trigger === 'manual') {
    const counts = { ok: 0, warning: 0, error: 0, lookupFailed: 0 };
    for (const d of domains) counts[d.saved.failed ? 'lookupFailed' : d.saved.kept.overall] += 1;
    recordAudit(entryOf(userId, by, {
      action: 'mail_node.dns_checked',
      details: {
        scope: 'all', trigger, overall: nodeSaved.failed ? null : nodeSaved.kept.overall, from: nodeSaved.before,
        ...(nodeSaved.failed ? { lookupFailed: true, code: nodeSaved.kept.lookupFailed.code } : {}),
        counts, errorDomains: domains.filter((d) => !d.saved.failed && d.saved.kept.overall === 'error').map((d) => d.domain),
        ...(skipped.length ? { skipped: skipped.length } : {}),
      },
    }));
  } else {
    journal({ trigger, scope: 'node', saved: nodeSaved });
    for (const d of domains) journal({ trigger, scope: 'domain', domain: d.domain, saved: d.saved });
  }
  return { at, node: nodeSaved.kept, domains: domains.map((d) => answerOf(d.domain, d.saved)), skipped };
}

// Starts a check of the node and every domain, or joins the one running: { started, promise }.
// The promise never rejects (a failure is logged): the caller answers before the run ends. by: the
// panel CLI's actor, whose check the backend runs (services/mailNode/nodeChecks.js).
export function startCheckAll({ userId = null, by = null, trigger = 'manual', deadlineMs } = {}) {
  if (running) return { started: false, promise: running };
  lastError = null;
  running = runAll({ userId, by, trigger, deadlineMs })
    .catch((err) => {
      lastError = runFailureOf(err);
      console.error(`Mail node DNS check (${trigger}) failed: ${[lastError.code, lastError.message].filter(Boolean).join(': ')}`);
      return null;
    })
    .finally(() => { running = null; });
  return { started: true, promise: running };
}

// The same, waited for: the run's answer, or null when it failed.
// The reason the last run failed, or null when it did not.
export function lastCheckAllError() {
  return lastError;
}

function runFailureOf(err) {
  const code = typeof err?.code === 'string' ? err.code : null;
  return { code, message: String(err?.message || err?.name || 'error').slice(0, 300) };
}

export function checkAllNow(options = {}) {
  return startCheckAll(options).promise;
}

// The scheduled run: nothing without a mail node; a failure is logged and the next run tries again.
async function scheduledRun() {
  if (!(await getMailNodeConfig().catch(() => null))) return;
  await checkAllNow({ trigger: 'schedule' });
}

// The first run waits a little, so the start never waits for DNS; then one every six hours.
export function startDnsCheckJob() {
  if (timer) return;
  firstRun = setTimeout(scheduledRun, FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  timer = setInterval(scheduledRun, INTERVAL_MS);
  timer.unref?.();
}

export function stopDnsCheckJob() {
  clearTimeout(firstRun);
  clearInterval(timer);
  firstRun = null;
  timer = null;
}
