import { query } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { safeFetch } from '../safeFetch.js';
import { getContainers, getMailNodeConfig, listQueue, parsePingUrl, parseWholeNumber } from './mailcow.js';
import { getEopSettings } from './eopSettings.js';
import { getNodeDnsCheck } from './dnsCheckJob.js';
import { SYSTEM_ACTOR } from './domains.js';
import { summarizeQueue } from './mailQueue.js';
import { captureFromLog } from '../deliveryStatus.js';
import { matchDeliveryCodes } from './deliveryCodes.js';
import { readPostfixLog, relayKind } from './postfixLog.js';
import { TERRL_WINDOW_MS, aliasDomainsOf, computeTerrlBudget } from './terrl.js';
import { classifyCheck, recordCheck, updateEvidence } from './outages.js';
import { runOutageTrace, waitingSignal, waitingSummary } from './outageTrace.js';
import { getTraceSource, resolveTraceSource } from './traceSource.js';
import { getTenantDriver, tenantOf } from '../tenant/driver.js';
import { POLL_INTERVAL_MS, TENANT_FAILING_POLLS, getTenantState } from '../tenant/tenantJobs.js';
import { connectorDrift } from '../tenant/connectors.js';
import { heldSummary } from '../tenant/quarantineRelease.js';
import { checkSpamRule } from './nodeApply.js';

// The mail node's alerts (R-18): what an administrator must hear about before the employees notice,
// checked every five minutes and shown in the panel, and pinged to a Healthchecks-style check URL
// of its own (the disk has another, services/mailNode/diskWatch.js).
//
// Signals (each from one source; a source that could not be read keeps its alerts as they were):
// - log: in the node's Postfix log of the last hour, a delivery refused with 5.7.711 / AS(2204)
//   (EOP blocked the inbound connector), 5.7.64 (tenant attribution: the node's certificate or its
//   chain), 5.7.233 or 5.7.232 (the tenant's external recipient limit; a trial tenant's), and any
//   status=sent handed neither to EOP (the relay named <EOP_HOST>) nor to local delivery: mail that
//   went around EOP (R-19). Only the name counts: an address inside the EOP ranges under another
//   name is another tenant's MX (a recipient on Microsoft 365), not this tenant's path. Without
//   <EOP_HOST> there is no bypass check, only the note eop_host_missing (information, never /fail);
// - queue: more deferred messages than the threshold, or the oldest deferred older than it;
// - certificate: the last DNS check of the node (services/mailNode/dnsCheckJob.js) found the
//   certificate of <MAIL_HOST> on 587 expiring in under 14 days or expired;
// - containers: a mailcow container that is not running, or reported unhealthy;
// - terrl: the tenant's external recipients of the last 24 hours at 80 percent of the limit or more
//   (services/mailNode/terrl.js). It counts the log too, so when the log could not be read the
//   budget keeps its previous alert instead of falling back to the journal and flapping;
// - trace: letters to the node's domains still waiting in EOP's queue after an outage of the node
//   (R-43, services/mailNode/outageTrace.js), a warning with the time EOP gives up on the first;
// - tenant: with a tenant driver and the tenant configured, what the tenant poll stored
//   (services/tenant/tenantJobs.js, every 10 minutes): a blocked inbound connector in
//   Get-BlockedConnector (R-27, connector_blocked_tenant, error) and the application certificate in
//   the tenant worker expiring (tenant_certificate: a warning from 30 days left, an error from 14
//   and once expired), and the anti-spam actions the panel could not set to MoveToJmf (section
//   5.14, tenant_antispam_not_enforced, warning). The run reads only the stored state, never the tenant. A poll that failed or
//   is older than TENANT_STALE_MS keeps the connector alert as it was (source tenant not read), and
//   from TENANT_FAILING_POLLS failed polls in a row, or no poll for TENANT_STALE_MS, a warning
//   tenant_poll_failing says so. None of this touches the node's ping: a tenant problem (a timeout,
//   throttling, a wrong certificate, the first minutes after it was set up) is shown in the panel
//   and as a warning in the ping's body, never by withholding the ping.
//
// The same run keeps the outage windows of R-43 (services/mailNode/outages.js): the containers'
// answer (or the API not answering at all) is one check, the log read is the windows' evidence,
// and a pass of the message trace starts after the ping, not waited for. A failure there is logged
// and kept with the windows; it never stops the run or its ping (the trace alert then stays as it
// was).
//
// What it keeps: the settings in integration_config 'mail_node_alerts' (ping URL, thresholds), the
// last run in 'mail_node_alert_state' ({ at, alerts, errors, log }). An alert keeps the time it was
// first raised; the journal gets mail_node.alert_raised and mail_node.alert_cleared only when an
// alert comes or goes, never on every run. The ping goes on every run that read every source:
// /fail when an alert of severity error is up, success otherwise, warnings and notes named in its
// body. A run that could not read a source sends none, so the check service notices the silence, as
// for the disk.

export const ALERTS_PROVIDER = 'mail_node_alerts';
export const ALERT_STATE_PROVIDER = 'mail_node_alert_state';
export const ALERT_DEFAULTS = Object.freeze({ pingUrl: null, deferredCount: 20, deferredMinutes: 60 });
export const MAX_DEFERRED_COUNT = 100000;
export const MAX_DEFERRED_MINUTES = 7 * 24 * 60;
// How far back the log signals look: a refusal or a bypass older than this clears.
export const SIGNAL_WINDOW_MS = 60 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90 * 1000;
const PING_TIMEOUT_MS = 10000;
const SAMPLES = 5;

// alert key -> [source, severity]
export const ALERTS = Object.freeze({
  connector_blocked: ['log', 'error'],
  tenant_attribution: ['log', 'error'],
  terrl_exceeded: ['log', 'error'],
  eop_bypass: ['log', 'error'],
  queue_deferred: ['queue', 'warning'],
  certificate: ['certificate', 'warning'],
  containers: ['containers', 'error'],
  terrl_budget: ['terrl', 'warning'],
  spam_rule_outdated: ['spam_rule', 'warning'],
  outage_letters_waiting: ['trace', 'warning'],
  connector_blocked_tenant: ['tenant', 'error'],
  tenant_certificate: ['tenant_certificate', 'warning'],
  tenant_poll_failing: ['tenant_poll', 'warning'],
  tenant_connector_drift: ['tenant_connectors', 'warning'],
  tenant_antispam_not_enforced: ['tenant_antispam', 'warning'],
  tenant_domain_authoritative: ['tenant_domains', 'warning'],
  tenant_phish_held: ['tenant_quarantine', 'warning'],
  tenant_alias_contacts_held: ['tenant_domains', 'warning'],
  eop_host_missing: ['settings', 'info'],
});
export const ALERT_KEYS = Object.freeze(Object.keys(ALERTS));

// The refusal codes of EOP the log signals look for come from the shared code list
// (services/mailNode/deliveryCodes.js, entries with an alert): the dsn= field exactly, or the code
// in the status text standing alone (not part of a longer code or of an address like [5.7.64.12]).
// 5.7.233 and the trial tenant's 5.7.232 both raise terrl_exceeded.
const REFUSAL_KEYS = ['connector_blocked', 'tenant_attribution', 'terrl_exceeded'];
const refused = (line, alert) => matchDeliveryCodes({ code: line.dsn, text: line.statusText ?? '' }).some((entry) => entry.alert === alert);
const FAILED_EVENTS = new Set(['deferred', 'bounced', 'expired', 'undeliverable']);

let timer = null;
let firstRun = null;
let running = null;

const sample = (line) => ({
  at: line.at, queueId: line.queueId, to: line.to, relay: line.relay, dsn: line.dsn, status: line.status,
});

function signal(key, lines, extra = {}) {
  return {
    key,
    severity: ALERTS[key][1],
    details: { count: lines.length, lastAt: lines.at(-1)?.at ?? null, samples: lines.slice(-SAMPLES).map(sample), ...extra },
  };
}

// The log alerts of the lines newer than now - SIGNAL_WINDOW_MS. eopHost: the EOP settings' next
// hop; without it there is no bypass check.
export function logSignals(lines, { now = Date.now(), eopHost = null } = {}) {
  const recent = lines.filter((line) => line.epoch != null && line.epoch >= now - SIGNAL_WINDOW_MS);
  const alerts = [];
  for (const key of REFUSAL_KEYS) {
    const hits = recent.filter((line) => FAILED_EVENTS.has(line.event) && refused(line, key));
    if (hits.length) alerts.push(signal(key, hits));
  }
  if (!eopHost) return alerts;
  const bypass = recent.filter((line) => line.event === 'sent' && relayKind(line, { eopHost }) === 'other');
  if (bypass.length) {
    const relays = [...new Set(bypass.map((line) => line.relayHost || line.relay).filter(Boolean))];
    alerts.push(signal('eop_bypass', bypass, { relays }));
  }
  return alerts;
}

// The note while <EOP_HOST> is not set: nothing tells EOP from any other relay, so there is no
// bypass check. Information only: it never makes the ping fail.
export function eopHostSignal(eopHost) {
  return eopHost ? [] : [{ key: 'eop_host_missing', severity: 'info', details: {} }];
}

// The queue alert: deferred above the count, or the oldest deferred older than the minutes.
export function queueSignal(summary, { deferredCount, deferredMinutes }) {
  const deferred = summary.counts.deferred ?? 0;
  const oldest = summary.oldestDeferredSeconds;
  if (deferred <= deferredCount && (oldest == null || oldest <= deferredMinutes * 60)) return [];
  return [{
    key: 'queue_deferred',
    severity: 'warning',
    details: { deferred, oldestMinutes: oldest == null ? null : Math.floor(oldest / 60), deferredCount, deferredMinutes },
  }];
}

// The certificate alert from the node's last DNS check: its cert_expiry item when not ok.
export function certificateSignal(nodeDns) {
  const item = (nodeDns?.checks ?? []).find((check) => check.check === 'cert_expiry');
  if (!item || item.status === 'ok') return [];
  return [{
    key: 'certificate',
    severity: item.code === 'cert_expired' ? 'error' : 'warning',
    details: { code: item.code ?? null, daysLeft: item.daysLeft ?? null, expiresAt: item.expiresAt ?? null, checkedAt: nodeDns.at ?? null },
  }];
}

// A container is down when it is not running, or running but reported unhealthy (when the node's
// answer carries the health, services/mailNode/mailcow.js getContainers).
export function containerSignal(containers) {
  const down = containers
    .filter((c) => c.state !== 'running' || c.health === 'unhealthy')
    .map(({ name, state, health }) => ({ name, state: state === 'running' && health === 'unhealthy' ? 'unhealthy' : state }));
  return down.length ? [{ key: 'containers', severity: 'error', details: { down } }] : [];
}

// The node holds an older version of the spam rule, or none (section 5.14).
export function spamRuleSignal(rule) {
  if (rule?.state !== 'outdated' && rule?.state !== 'missing') return [];
  return [{ key: 'spam_rule_outdated', severity: 'warning', details: { state: rule.state, checkedAt: rule.at ?? null } }];
}

export function terrlSignal(budget) {
  if (!budget?.warn) return [];
  return [{
    key: 'terrl_budget',
    severity: budget.exceeded ? 'error' : 'warning',
    details: { used: budget.used, limit: budget.limit, percent: budget.percent, rampPercent: budget.rampPercent },
  }];
}

// The tenant poll's answer is stale after three missed polls: the worker or the queue stopped.
export const TENANT_STALE_MS = 3 * POLL_INTERVAL_MS;
export const TENANT_CERT_WARN_DAYS = 30;
export const TENANT_CERT_ERROR_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// The tenant alerts from the stored poll state: { alerts, stale, connectorsStale } (stale: the
// blocked connector list could not be read lately, so its alert stays as it was; connectorsStale:
// the same for the connectors compared with their reference, R-25). Before the first poll nothing
// is stale enough to warn about.
export function tenantSignals(state, now = Date.now()) {
  const alerts = [];
  const blocked = state?.blockedConnectors;
  const readAt = Date.parse(blocked?.at ?? '');
  const stale = !blocked || blocked.ok === false || !Number.isFinite(readAt) || now - readAt > TENANT_STALE_MS;
  const triedAt = Math.max(Number.isFinite(readAt) ? readAt : 0, Date.parse(blocked?.errorAt ?? '') || 0);
  const failures = Number(blocked?.failures) || 0;
  if (blocked && (failures >= TENANT_FAILING_POLLS || now - triedAt > TENANT_STALE_MS)) {
    alerts.push({
      key: 'tenant_poll_failing',
      severity: 'warning',
      details: {
        failures, code: blocked.error?.code ?? (failures ? null : 'tenant_poll_stale'),
        lastReadAt: Number.isFinite(readAt) ? new Date(readAt).toISOString() : null,
        lastTriedAt: triedAt ? new Date(triedAt).toISOString() : null,
      },
    });
  }
  if (!stale && blocked.items?.length) {
    alerts.push({
      key: 'connector_blocked_tenant',
      severity: 'error',
      details: { count: blocked.items.length, connectors: blocked.items.slice(0, SAMPLES), checkedAt: blocked.at },
    });
  }
  const notAfter = Date.parse(state?.certificate?.notAfter ?? '');
  if (Number.isFinite(notAfter)) {
    const daysLeft = Math.floor((notAfter - now) / DAY_MS);
    if (daysLeft < TENANT_CERT_WARN_DAYS) {
      alerts.push({
        key: 'tenant_certificate',
        severity: daysLeft < TENANT_CERT_ERROR_DAYS ? 'error' : 'warning',
        details: {
          code: notAfter <= now ? 'cert_expired' : 'cert_expiring', daysLeft, notAfter: new Date(notAfter).toISOString(),
          thumbprint: state.certificate.thumbprint ?? null,
        },
      });
    }
  }
  // R-25: a connector changed since the reference was taken (stage 7b).
  const connectors = state?.connectors;
  const connectorsAt = Date.parse(connectors?.at ?? '');
  const connectorsStale = !connectors || connectors.ok === false || !Number.isFinite(connectorsAt) || now - connectorsAt > TENANT_STALE_MS;
  if (!connectorsStale) {
    const drift = connectorDrift(state.connectorReference, connectors);
    if (drift.length) {
      alerts.push({
        key: 'tenant_connector_drift',
        severity: 'warning',
        details: { count: drift.length, connectors: drift.slice(0, SAMPLES).map(({ direction, name, kind }) => ({ direction, name, kind })), checkedAt: connectors.at },
      });
    }
  }
  // Section 5.14: the panel could not set the spam, high confidence spam or phishing action of the
  // Default policy to MoveToJmf; such letters may stay in EOP's quarantine (the release job is the
  // fallback). A read that failed before any write keeps the alert as it was (antispamStale).
  const antispam = state?.antispam;
  const antispamStale = !!antispam && antispam.ok === false && !antispam.enforcement;
  const enforcement = antispam?.enforcement;
  if (enforcement && enforcement.ok === false) {
    alerts.push({
      key: 'tenant_antispam_not_enforced',
      severity: 'warning',
      // unconfirmed: the read after the writes failed, so they may have gone through; code
      // unknown_op: the tenant-worker image predates the operation (rebuild it).
      details: {
        fields: enforcement.failed ?? [], code: enforcement.error?.code ?? null, unconfirmed: enforcement.unconfirmed === true,
        checkedAt: enforcement.at ?? antispam.at ?? null,
      },
    });
  }
  return { alerts, stale, connectorsStale, antispamStale };
}

// The alerts of this run (fresh: those the sources that were read gave) merged with the previous
// run's: an alert of a source that could not be read (failed: source names) stays as it was, and
// every alert keeps the time it was first raised (since). Returns { alerts, raised, cleared }
// (raised and cleared: alert keys).
export function mergeAlerts(previous, fresh, failed, now) {
  const before = new Map((previous ?? []).map((alert) => [alert.key, alert]));
  const at = new Date(now).toISOString();
  const alerts = fresh.map((alert) => ({ ...alert, since: before.get(alert.key)?.since ?? at, seenAt: at }));
  for (const alert of before.values()) {
    const source = ALERTS[alert.key]?.[0];
    if (failed.includes(source) && !alerts.some((a) => a.key === alert.key)) alerts.push(alert);
  }
  alerts.sort((a, b) => ALERT_KEYS.indexOf(a.key) - ALERT_KEYS.indexOf(b.key));
  const current = new Set(alerts.map((a) => a.key));
  return {
    alerts,
    raised: [...current].filter((key) => !before.has(key)),
    cleared: [...before.keys()].filter((key) => !current.has(key)),
  };
}

// --- settings and state ----------------------------------------------------------------------

async function readConfig(provider) {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [provider]);
  return rows[0]?.config ?? null;
}

async function writeConfig(provider, config, { merge }) {
  await query(`
    INSERT INTO integration_config (provider, config) VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = ${merge ? 'integration_config.config || EXCLUDED.config' : 'EXCLUDED.config'}, updated_at = NOW()
  `, [provider, config]);
}

export async function getAlertSettings() {
  const stored = (await readConfig(ALERTS_PROVIDER)) ?? {};
  return {
    pingUrl: parsePingUrl(stored.pingUrl ?? '') ?? null,
    deferredCount: parseWholeNumber(stored.deferredCount, 1, MAX_DEFERRED_COUNT) ?? ALERT_DEFAULTS.deferredCount,
    deferredMinutes: parseWholeNumber(stored.deferredMinutes, 1, MAX_DEFERRED_MINUTES) ?? ALERT_DEFAULTS.deferredMinutes,
  };
}

// The fields the body sends, checked: { settings } or { error }. A field left out keeps its value;
// the ping URL sent empty is cleared.
export function parseAlertSettings(body) {
  const settings = {};
  if (body?.pingUrl !== undefined) {
    const raw = typeof body.pingUrl === 'string' ? body.pingUrl.trim() : '';
    if (raw) {
      const url = parsePingUrl(raw);
      if (!url) return { error: 'ping_url_invalid' };
      settings.pingUrl = url;
    } else if (body.pingUrl === null || typeof body.pingUrl === 'string') {
      settings.pingUrl = null;
    } else {
      return { error: 'ping_url_invalid' };
    }
  }
  if (body?.deferredCount !== undefined) {
    const value = parseWholeNumber(body.deferredCount, 1, MAX_DEFERRED_COUNT);
    if (value == null) return { error: 'deferred_count_invalid' };
    settings.deferredCount = value;
  }
  if (body?.deferredMinutes !== undefined) {
    const value = parseWholeNumber(body.deferredMinutes, 1, MAX_DEFERRED_MINUTES);
    if (value == null) return { error: 'deferred_minutes_invalid' };
    settings.deferredMinutes = value;
  }
  return { settings };
}

export async function saveAlertSettings(settings) {
  await writeConfig(ALERTS_PROVIDER, settings, { merge: true });
}

// The last run: { at, trigger, alerts, errors, log }, or null before the first one.
export async function getAlertState() {
  return readConfig(ALERT_STATE_PROVIDER);
}

// --- the run -----------------------------------------------------------------------------------

async function ping(url, fail, body) {
  try {
    await safeFetch(fail ? `${url.replace(/\/+$/, '')}/fail` : url, {
      method: 'POST', body, signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Mail node alert ping failed: ${err?.code || err?.name || 'error'}`);
  }
}

const actor = (userId) => (userId ? { actorUserId: userId } : { actorEmail: SYSTEM_ACTOR });
const errorOf = (source, err) => ({ source, code: err?.code || 'error', message: err?.code ? err.message : 'error' });

// Reads every source, keeps and journals the result, pings: the state kept, or null without a mail
// node. Never throws for a source that fails: its error is kept with the state.
export async function runAlertCheck({ userId = null, trigger = 'schedule', now = Date.now() } = {}) {
  const cfg = await getMailNodeConfig();
  if (!cfg) return null;
  const [settings, eop, previous] = await Promise.all([getAlertSettings(), getEopSettings(), getAlertState()]);
  const errors = [];
  const fresh = [];
  const failed = [];
  const read = async (source, fn) => {
    try {
      return await fn();
    } catch (err) {
      errors.push(errorOf(source, err));
      failed.push(source);
      return null;
    }
  };

  fresh.push(...eopHostSignal(eop.eopHost));
  // The queue before the log: a letter that leaves the queue after this point has its final line in
  // the log read below (or in the next run's), so the delivery details never take a letter still on
  // its way for one that left the queue without a final line.
  const queueItems = await read('queue', () => listQueue(cfg));
  const log = await read('log', () => readPostfixLog(cfg, { since: now - TERRL_WINDOW_MS }));
  if (log) fresh.push(...logSignals(log.lines, { now, eopHost: eop.eopHost }));
  // The delivery details of sent letters (R-17, services/deliveryStatus.js) from the same read. Not
  // an alert source: its failure is logged and changes neither the alerts nor the ping.
  if (log) {
    try {
      const queueIds = queueItems ? new Set(queueItems.map((item) => item.queueId)) : null;
      await captureFromLog({ cfg, log, eopHost: eop.eopHost, now, queueIds });
    } catch (err) {
      console.error(`Mail node delivery details were not captured: ${err?.code || err?.message || 'error'}`);
    }
  }
  const queue = queueItems ? summarizeQueue(queueItems, now) : null;
  if (queue) fresh.push(...queueSignal(queue, settings));
  const nodeDns = await read('certificate', () => getNodeDnsCheck());
  if (!failed.includes('certificate')) fresh.push(...certificateSignal(nodeDns));
  const containers = await read('containers', () => getContainers(cfg));
  if (containers) fresh.push(...containerSignal(containers));
  // Section 5.14: the spam rule on the node, once mail goes through EOP. Until this version is
  // written, spam and phishing released from EOP's quarantine would land in the Inbox, so the
  // release holds them and this alert asks for the rule. An unknown answer keeps the alert as it was.
  if (eop.eopHost) {
    try {
      const rule = await checkSpamRule({ cfg, now });
      if (rule.state === 'unknown') failed.push('spam_rule');
      else fresh.push(...spamRuleSignal(rule));
    } catch (err) {
      console.error(`Mail node spam rule was not read: ${err?.code || err?.message || 'error'}`);
      failed.push('spam_rule');
    }
  }
  const traceSource = await outageStep({
    check: classifyCheck({ containers, errorCode: errors.find((e) => e.source === 'containers')?.code ?? null }),
    log, now, userId, fresh, failed,
  });
  await tenantStep({ eop, now, fresh, failed });
  // The budget counts the log as well: without it the count would drop and the alert flap, so the
  // budget's alert stays as it was until the log reads again.
  if (log) {
    const budget = await read('terrl', async () => computeTerrlBudget({ eop, log, aliasDomains: await aliasDomainsOf(cfg), now }));
    if (budget) fresh.push(...terrlSignal(budget));
  } else {
    failed.push('terrl');
  }

  const merged = mergeAlerts(previous?.alerts, fresh, failed, now);
  const state = {
    at: new Date(now).toISOString(),
    trigger,
    alerts: merged.alerts,
    errors,
    log: log ? { fetched: log.fetched, malformed: log.malformed, oldestAt: log.oldestAt, newestAt: log.newestAt } : null,
    queue: queue ? { counts: queue.counts, total: queue.total, oldestDeferredSeconds: queue.oldestDeferredSeconds } : null,
  };
  await writeConfig(ALERT_STATE_PROVIDER, state, { merge: false });

  const byKey = new Map(merged.alerts.map((alert) => [alert.key, alert]));
  const beforeByKey = new Map((previous?.alerts ?? []).map((alert) => [alert.key, alert]));
  recordAudit([
    ...merged.raised.map((key) => ({
      ...actor(userId), action: 'mail_node.alert_raised',
      details: { alert: key, severity: byKey.get(key).severity, trigger, ...summaryOf(byKey.get(key)) },
    })),
    ...merged.cleared.map((key) => ({
      ...actor(userId), action: 'mail_node.alert_cleared',
      details: { alert: key, trigger, since: beforeByKey.get(key)?.since ?? null },
    })),
  ]);

  if (settings.pingUrl && !errors.length) {
    const { fail, body } = pingOf(merged.alerts);
    await ping(settings.pingUrl, fail, body);
  }
  startOutageTrace({ source: traceSource, now, log });
  return state;
}

// R-43: the check into the outage windows, the log into their evidence, and the alert from the
// letters stored. Each part fails alone (logged): the trace alert then stays as it was. Returns the
// trace source for the pass after the ping.
async function outageStep({ check, log, now, userId, fresh, failed }) {
  try {
    await recordCheck({ check, now, userId });
    if (log) await updateEvidence(log, now);
  } catch (err) {
    console.error(`Mail node outage windows were not updated: ${err?.code || err?.message || 'error'}`);
  }
  // The alert comes from what earlier passes stored (a cheap query); the pass itself runs after the
  // ping (startOutageTrace), so a slow trace never holds up the job or its ping.
  // The trace is the tenant driver's since stage 7c: resolving it reads the EOP settings, and a
  // failed read keeps the alert as it was.
  let source = null;
  try {
    source = await resolveTraceSource();
    if (source) fresh.push(...waitingSignal(await waitingSummary(now)));
  } catch (err) {
    console.error(`Mail node outage letters could not be counted: ${err?.code || err?.message || 'error'}`);
    failed.push('trace');
  }
  return source;
}

// The tenant alerts, without a tenant driver or a configured tenant none (they clear). A stale or
// failed poll keeps the connector alert as it was (source tenant not read); the tenant never adds
// to errors, so it never withholds the node's ping. Reading the stored state itself failing (the
// database) keeps every tenant alert as it was and is logged.
async function tenantStep({ eop, now, fresh, failed }) {
  if (!getTenantDriver() || !tenantOf(eop)) return;
  try {
    const { alerts, stale, connectorsStale, antispamStale } = tenantSignals(await getTenantState(), now);
    fresh.push(...alerts);
    if (stale) failed.push('tenant');
    if (connectorsStale) failed.push('tenant_connectors');
    if (antispamStale) failed.push('tenant_antispam');
  } catch (err) {
    console.error(`Mail node tenant alerts were not read: ${err?.code || err?.message || 'error'}`);
    failed.push('tenant', 'tenant_certificate', 'tenant_poll', 'tenant_connectors', 'tenant_antispam', 'tenant_domains', 'tenant_quarantine');
    return;
  }
  // Stage 7b: a domain the tenant had as Authoritative waits for an administrator's decision. Its
  // own source: a failed read keeps only this alert as it was.
  try {
    const { rows } = await query(`SELECT domain FROM mail_node_domains
      WHERE tenant_sync->'acceptedDomain'->>'code' = 'authoritative_in_tenant' ORDER BY domain`);
    if (rows.length) {
      fresh.push({ key: 'tenant_domain_authoritative', severity: 'warning', details: { count: rows.length, domains: rows.slice(0, 5).map((r) => r.domain) } });
    }
    // Section 5.14: contacts of mailcow aliases the mirror keeps on an Authoritative domain until an
    // administrator allows their removal.
    const { rows: held } = await query(`SELECT domain, tenant_sync->'mirror'->'heldAliasContacts' AS addresses FROM mail_node_domains
      WHERE jsonb_array_length(COALESCE(tenant_sync->'mirror'->'heldAliasContacts', '[]'::jsonb)) > 0 ORDER BY domain`);
    if (held.length) {
      const addresses = held.flatMap((r) => r.addresses ?? []);
      fresh.push({
        key: 'tenant_alias_contacts_held', severity: 'warning',
        details: { count: addresses.length, domains: held.slice(0, 5).map((r) => r.domain), addresses: addresses.slice(0, 5) },
      });
    }
  } catch (err) {
    console.error(`Mail node tenant domain alerts were not read: ${err?.code || err?.message || 'error'}`);
    failed.push('tenant_domains');
  }
  // Stage 7c, R-42: phishing the panel keeps in EOP's quarantine (a guard or a failed release) and
  // that is still there: the recipients do not see it unless an administrator acts.
  try {
    const held = await heldSummary(now);
    if (held.count) fresh.push({ key: 'tenant_phish_held', severity: 'warning', details: held });
  } catch (err) {
    console.error(`Mail node tenant quarantine alerts were not read: ${err?.code || err?.message || 'error'}`);
    failed.push('tenant_quarantine');
  }
}

// A pass of the message trace, not waited for: it has its own single flight and deadline
// (services/mailNode/outageTrace.js). Its failure is logged.
function startOutageTrace({ source, now, log }) {
  if (!source) return;
  runOutageTrace({ source, now, log }).catch((err) => {
    console.error(`Mail node outage trace failed: ${err?.code || err?.message || 'error'}`);
  });
}

// The ping of a run: /fail only for an alert of severity error; every alert up, with its severity,
// in the body.
export function pingOf(alerts) {
  if (!alerts.length) return { fail: false, body: 'mail node: no alerts' };
  return {
    fail: alerts.some((alert) => alert.severity === 'error'),
    body: `mail node alerts: ${alerts.map((alert) => `${alert.key} (${alert.severity})`).join(', ')}`,
  };
}

// What the journal keeps of an alert: counts and names, never message samples.
function summaryOf(alert) {
  const d = alert.details ?? {};
  switch (alert.key) {
    case 'queue_deferred': return { deferred: d.deferred, oldestMinutes: d.oldestMinutes };
    case 'certificate': return { code: d.code, daysLeft: d.daysLeft };
    case 'containers': return { down: (d.down ?? []).map((c) => c.name) };
    case 'terrl_budget': return { used: d.used, limit: d.limit, percent: d.percent };
    case 'eop_bypass': return { count: d.count, relays: d.relays ?? [] };
    case 'eop_host_missing': return {};
    case 'outage_letters_waiting': return { waiting: d.waiting, soonestExpiresAt: d.soonestExpiresAt };
    case 'connector_blocked_tenant': return { count: d.count, connectorIds: (d.connectors ?? []).map((c) => c.connectorId) };
    case 'tenant_certificate': return { code: d.code, daysLeft: d.daysLeft };
    case 'tenant_poll_failing': return { failures: d.failures, code: d.code };
    case 'tenant_phish_held': return { count: d.count, soonestExpiresAt: d.soonestExpiresAt };
    case 'tenant_antispam_not_enforced': return { fields: d.fields ?? [], code: d.code, unconfirmed: d.unconfirmed === true };
    case 'spam_rule_outdated': return { state: d.state };
    case 'tenant_alias_contacts_held': return { count: d.count, domains: d.domains ?? [] };
    default: return { count: d.count };
  }
}

// Starts a run or joins the one going: the promise resolves to the state, or null when the run
// failed (logged).
export function checkAlertsNow(options = {}) {
  if (running) return running;
  running = runAlertCheck(options)
    .catch((err) => {
      console.error('Mail node alert check failed:', err?.code || err?.message || 'error');
      return null;
    })
    .finally(() => { running = null; });
  return running;
}

async function scheduledRun() {
  if (!(await getMailNodeConfig().catch(() => null))) return;
  await checkAlertsNow({ trigger: 'schedule' });
}

// The first run a little after the start (the start never waits for the node), then every five
// minutes.
export function startNodeAlertJob() {
  if (timer) return;
  // Names a stand-only trace setting in the log at start (services/mailNode/traceSource.js).
  getTraceSource();
  firstRun = setTimeout(scheduledRun, FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  timer = setInterval(scheduledRun, INTERVAL_MS);
  timer.unref?.();
}

export function stopNodeAlertJob() {
  clearTimeout(firstRun);
  clearInterval(timer);
  firstRun = null;
  timer = null;
}
