import { query } from '../db.js';
import { recordAudit } from '../auditLog.js';
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
} from './dnsCheck.js';

// Runs the DNS checks (services/mailNode/dnsCheck.js, R-14 and R-15) for the node and the domains the
// panel knows, keeps the last result of each and journals what an administrator should know:
// - the node's result in integration_config ('mail_node_dns_check'), each domain's in
//   mail_node_domains.dns_check / dns_checked_at (cleared by "Restart onboarding");
// - mail_node.dns_checked: every check an administrator started, and a result of a scheduled or
//   automatic check only when its overall status differs from the one before (a first result is
//   no change), so the schedule does not fill the journal.
// A result never changes a domain's onboarding state: DNS problems only warn, the administrator
// confirms "DNS is right" by hand and may restart the onboarding (owner's decision 2026-10-01).
// Checks run one at a time, every six hours after a first run shortly after the start, and on
// "Check now".

export const DNS_CHECK_PROVIDER = 'mail_node_dns_check';
// Why a check ran: an administrator's "Check now", the schedule, or saving the values a domain must
// publish.
export const DNS_CHECK_TRIGGERS = Object.freeze(['manual', 'schedule', 'expected_changed']);
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

let timer = null;
let firstRun = null;

// Checks never overlap: a scheduled run and "Check now" would only repeat each other.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// The values a domain must publish that are entered by hand until the tenant driver reads them
// (stored in mail_node_domains.tenant, cleared by "Restart onboarding").
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

// A result that holds only why no lookup could run (the resolver setting is not an address).
const resolverFailure = (err) => {
  const checks = [{ check: 'resolver', status: 'error', code: err.code, found: [], expected: null, records: [], detail: err.message }];
  return { checks, overall: 'error' };
};

function resolverOrFailure() {
  try {
    return { resolver: createResolver() };
  } catch (err) {
    if (err instanceof DnsCheckError) return { failure: resolverFailure(err) };
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

// Stores the domain's result; returns the overall status of the result before, or null.
async function saveDomainResult(domain, result) {
  const { rows } = await query(`
    WITH old AS (SELECT domain, dns_check FROM mail_node_domains WHERE domain = $1 FOR UPDATE)
    UPDATE mail_node_domains d SET dns_check = $2, dns_checked_at = $3
      FROM old WHERE d.domain = old.domain
    RETURNING old.dns_check->>'overall' AS before
  `, [domain, result, result.at]);
  return rows[0]?.before ?? null;
}

export async function getNodeDnsCheck() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [DNS_CHECK_PROVIDER]);
  return rows[0]?.config ?? null;
}

async function saveNodeResult(result) {
  const before = (await getNodeDnsCheck())?.overall ?? null;
  await query(`
    INSERT INTO integration_config (provider, config) VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  `, [DNS_CHECK_PROVIDER, result]);
  return before;
}

const namesWith = (checks, status) => checks.filter((c) => c.status === status).map((c) => c.check);

// The journal entry of one result: always for an administrator's check, otherwise only when the
// overall status changed from a previous one.
function journal({ userId, trigger, scope, domain, result, before }) {
  if (trigger !== 'manual' && (before === null || before === result.overall)) return;
  recordAudit({
    ...(userId ? { actorUserId: userId } : { actorEmail: SYSTEM_ACTOR }),
    action: 'mail_node.dns_checked',
    details: {
      scope, ...(domain ? { domain } : {}), trigger, overall: result.overall, from: before,
      errors: namesWith(result.checks, 'error'), warnings: namesWith(result.checks, 'warning'),
    },
  });
}

const notConfigured = () => new MailNodeError('mail_node_not_configured', 'The mail node is not set up', 409);

async function domainRows(domain) {
  const { rows } = await query(`
    SELECT domain, dkim_mode, expected_mx, tenant, apply_result FROM mail_node_domains
     WHERE ($1::text IS NULL OR domain = $1) ORDER BY domain`, [domain ?? null]);
  return rows;
}

// One domain the panel knows: { domain, at, overall, checks }. trigger: 'manual' or
// 'expected_changed'.
export function checkDomainNow({ domain, userId = null, trigger = 'manual' }) {
  return serialized(async () => {
    const cfg = await getMailNodeConfig();
    if (!cfg) throw notConfigured();
    const [row] = await domainRows(domain);
    if (!row) throw new MailNodeError('domain_not_found', 'The panel does not know this domain', 404);
    const eop = await getEopSettings();
    const { resolver, failure } = resolverOrFailure();
    const at = new Date().toISOString();
    const result = { at, trigger, ...(failure ?? await checkOneDomain(cfg, eop, row, resolver)) };
    const before = await saveDomainResult(row.domain, result);
    journal({ userId, trigger, scope: 'domain', domain: row.domain, result, before });
    return { domain: row.domain, ...result };
  });
}

// The node and every domain the panel knows. An administrator's run is journaled once, with the
// node's status and how many domains ended in each; a scheduled one per scope whose status changed.
export function checkAllNow({ userId = null, trigger = 'manual' }) {
  return serialized(async () => {
    const cfg = await getMailNodeConfig();
    if (!cfg) throw notConfigured();
    const eop = await getEopSettings();
    const { resolver, failure } = resolverOrFailure();
    const at = new Date().toISOString();
    const node = { at, trigger, ...(failure ?? await checkNode(cfg, eop, resolver)) };
    const nodeBefore = await saveNodeResult(node);
    const domains = [];
    const before = new Map();
    for (const row of await domainRows(null)) {
      const result = { at, trigger, ...(failure ?? await checkOneDomain(cfg, eop, row, resolver)) };
      before.set(row.domain, await saveDomainResult(row.domain, result));
      domains.push({ domain: row.domain, ...result });
    }
    if (trigger === 'manual') {
      const counts = { ok: 0, warning: 0, error: 0 };
      for (const d of domains) counts[d.overall] += 1;
      recordAudit({
        actorUserId: userId, action: 'mail_node.dns_checked',
        details: {
          scope: 'all', trigger, overall: node.overall, from: nodeBefore, counts,
          errorDomains: domains.filter((d) => d.overall === 'error').map((d) => d.domain),
        },
      });
    } else {
      journal({ trigger, scope: 'node', result: node, before: nodeBefore });
      for (const d of domains) journal({ trigger, scope: 'domain', domain: d.domain, result: d, before: before.get(d.domain) });
    }
    return { at, node, domains };
  });
}

// The scheduled run: nothing without a mail node; a failure is logged and the next run tries again.
async function scheduledRun() {
  try {
    if (!(await getMailNodeConfig())) return;
    await checkAllNow({ trigger: 'schedule' });
  } catch (err) {
    console.error('Mail node DNS check failed:', err?.code || err?.message || 'error');
  }
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
