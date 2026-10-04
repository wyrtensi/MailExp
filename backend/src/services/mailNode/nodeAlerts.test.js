import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ configs: {} }));
vi.mock('../db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.startsWith('SELECT config')) return { rows: db.configs[params[0]] ? [{ config: db.configs[params[0]] }] : [] };
    if (sql.includes('FROM mail_node_domains')) return { rows: db.waitingDomains ?? [] };
    if (sql.includes('FROM tenant_quarantine_releases')) {
      if (db.held instanceof Error) throw db.held;
      return { rows: [db.held ?? { count: 0, soonest: null }] };
    }
    if (sql.includes('INSERT INTO integration_config')) {
      const [provider, config] = params;
      db.configs[provider] = sql.includes('integration_config.config ||') ? { ...(db.configs[provider] ?? {}), ...config } : config;
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }),
}));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../safeFetch.js', () => ({ safeFetch: vi.fn(async () => ({ ok: true, status: 200 })) }));
const node = vi.hoisted(() => ({ cfg: null, log: [], queue: [], containers: [], nodeDns: null, budget: null, eop: {} }));
const fail = (value) => {
  if (value instanceof Error) throw value;
  return value;
};
vi.mock('./mailcow.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    getMailNodeConfig: vi.fn(async () => node.cfg),
    // As the real one: an answer that is no list of lines is a failure.
    getPostfixLog: vi.fn(async () => {
      const log = fail(node.log);
      if (!Array.isArray(log) || !log.length) throw new actual.MailNodeError('mail_node_failed', 'The mail node returned no Postfix log');
      return log;
    }),
    listQueue: vi.fn(async () => fail(node.queue)),
    getContainers: vi.fn(async () => fail(node.containers)),
    listAliasDomains: vi.fn(async () => []),
  };
});
vi.mock('./eopSettings.js', () => ({ getEopSettings: vi.fn(async () => node.eop) }));
vi.mock('./dnsCheckJob.js', () => ({ getNodeDnsCheck: vi.fn(async () => fail(node.nodeDns)) }));
vi.mock('./terrl.js', async (importActual) => ({
  ...(await importActual()),
  computeTerrlBudget: vi.fn(async () => fail(node.budget)),
}));
const capture = vi.hoisted(() => ({ result: { letters: 0, changed: 0 } }));
vi.mock('../deliveryStatus.js', () => ({ captureFromLog: vi.fn(async () => fail(capture.result)) }));
// R-43: the windows and the trace have their own tests (outages.pglite.test.js); here only what
// the run hands them and what comes back.
const outage = vi.hoisted(() => ({ record: null, trace: { connected: true, windows: [] }, waiting: { waiting: 0, soonestExpiresAt: null }, source: null }));
vi.mock('./outages.js', async (importActual) => ({
  ...(await importActual()),
  recordCheck: vi.fn(async () => fail(outage.record ?? { opened: null, closed: null })),
  updateEvidence: vi.fn(async () => {}),
}));
vi.mock('./outageTrace.js', async (importActual) => ({
  ...(await importActual()),
  runOutageTrace: vi.fn(async () => fail(outage.trace)),
  waitingSummary: vi.fn(async () => fail(outage.waiting)),
}));
vi.mock('./traceSource.js', async (importActual) => ({
  ...(await importActual()),
  getTraceSource: vi.fn(() => outage.source),
  resolveTraceSource: vi.fn(async () => outage.source),
}));

import { recordAudit } from '../auditLog.js';
import { captureFromLog } from '../deliveryStatus.js';
import { recordCheck, updateEvidence } from './outages.js';
import { runOutageTrace } from './outageTrace.js';
import { safeFetch } from '../safeFetch.js';
import { MailNodeError, getMailNodeConfig } from './mailcow.js';
import { clearPostfixLogCache, parsePostfixLog } from './postfixLog.js';
import { clearAliasDomainCache, computeTerrlBudget } from './terrl.js';
import {
  BYPASS_SENT, SENT_TO_RECIPIENT_M365_MX, STAND_LOG, STAND_SENT_LOCAL, STAND_SENT_VIA_EOP,
} from './postfixLog.fixtures.js';
import {
  ALERTS_PROVIDER, ALERT_STATE_PROVIDER, certificateSignal, containerSignal, eopHostSignal, getAlertSettings, logSignals,
  mergeAlerts, parseAlertSettings, pingOf, queueSignal, runAlertCheck, startNodeAlertJob, stopNodeAlertJob, terrlSignal,
  TENANT_STALE_MS, tenantSignals,
} from './nodeAlerts.js';
import { createFakeTenantDriver, setTenantDriver } from '../tenant/driver.js';

// The stand's lines happened at 19:02:59-19:03:11 on 2026-10-01; "now" is a few minutes later.
const NOW = Date.parse('2026-10-01T19:10:00Z');
const PING = 'https://hc.example.com/ping/alerts';
const lines = (entries) => parsePostfixLog(entries).lines;
const keys = (alerts) => alerts.map((a) => a.key);

beforeEach(() => {
  db.configs = {};
  node.cfg = { mailHost: 'mail.example.com', apiKey: 'k' };
  // A quiet log: one local delivery long before the window.
  node.log = [STAND_SENT_LOCAL];
  clearPostfixLogCache();
  clearAliasDomainCache();
  computeTerrlBudget.mockClear();
  node.queue = [];
  node.containers = [{ name: 'postfix-mailcow', state: 'running' }];
  node.nodeDns = null;
  node.budget = { warn: false, used: 0, limit: null };
  node.eop = { eopHost: 'eop.test.local' };
  recordAudit.mockClear();
  safeFetch.mockClear();
  outage.record = null;
  outage.trace = { connected: true, windows: [] };
  outage.waiting = { waiting: 0, soonestExpiresAt: null };
  outage.source = null;
  recordCheck.mockClear();
  updateEvidence.mockClear();
  runOutageTrace.mockClear();
});

describe('logSignals', () => {
  it('finds the EOP refusals of the last hour in the reply and the DSN', () => {
    const alerts = logSignals(lines(STAND_LOG), { now: NOW, eopHost: 'eop.test.local' });
    expect(keys(alerts)).toEqual(['connector_blocked', 'terrl_exceeded']);
    expect(alerts[0].details).toMatchObject({ count: 1, lastAt: '2026-10-01T19:03:10.000Z' });
    expect(alerts[0].details.samples[0]).toMatchObject({ queueId: '53A99193F13', to: 'test@example.com', dsn: '5.7.711' });
  });

  it('forgets a refusal older than an hour', () => {
    expect(logSignals(lines(STAND_LOG), { now: NOW + 2 * 3600000, eopHost: 'eop.test.local' })).toEqual([]);
  });

  it('finds 5.7.64 and the trial limit 5.7.232', () => {
    const entry = (dsn, text) => ({ time: '1790881390', program: 'postfix/smtp', message: `AB12CD34EF5: to=<a@example.org>, relay=eop.test.local[172.22.1.13]:25, dsn=${dsn}, status=bounced (host eop.test.local[172.22.1.13] said: 550 ${dsn} ${text} (in reply to end of DATA command))` });
    expect(keys(logSignals(lines([entry('5.7.64', 'TenantAttribution; Relay Access Denied')]), { now: NOW }))).toEqual(['tenant_attribution']);
    expect(keys(logSignals(lines([entry('5.7.232', 'trial tenant limit')]), { now: NOW }))).toEqual(['terrl_exceeded']);
    expect(keys(logSignals(lines([entry('5.7.640', 'not this one')]), { now: NOW }))).toEqual([]);
  });

  it('raises the bypass for a delivery neither to EOP nor local (R-19)', () => {
    // "Now" 18:45: the EOP (17:56) and local (17:50) lines are within the hour, the bypass line
    // (19:05) is not older than it either.
    const alerts = logSignals(lines([BYPASS_SENT, STAND_SENT_VIA_EOP, STAND_SENT_LOCAL]), { now: Date.parse('2026-10-01T18:45:00Z'), eopHost: 'eop.test.local' });
    expect(keys(alerts)).toEqual(['eop_bypass']);
    expect(alerts[0].details).toMatchObject({ count: 1, relays: ['mx.example.org'] });
  });

  it('counts mail to a recipient\'s Microsoft 365 MX as a bypass: only the name of <EOP_HOST> is EOP', () => {
    const alerts = logSignals(lines([SENT_TO_RECIPIENT_M365_MX]), { now: NOW, eopHost: 'contoso-com.mail.protection.outlook.com' });
    expect(keys(alerts)).toEqual(['eop_bypass']);
    expect(alerts[0].details.relays).toEqual(['m365cust-com.mail.protection.outlook.com']);
  });

  it('checks no bypass while <EOP_HOST> is not set, and notes it instead', () => {
    expect(logSignals(lines([STAND_SENT_VIA_EOP, BYPASS_SENT]), { now: Date.parse('2026-10-01T18:00:00Z') })).toEqual([]);
    expect(eopHostSignal(null)).toEqual([{ key: 'eop_host_missing', severity: 'info', details: {} }]);
    expect(eopHostSignal('eop.test.local')).toEqual([]);
  });

  it('takes a refusal code only as the DSN or standing alone, not inside an address', () => {
    const entry = (dsn, text) => ({ time: '1790881390', program: 'postfix/smtp', message: `AB12CD34EF5: to=<a@example.org>, relay=eop.test.local[172.22.1.13]:25, dsn=${dsn}, status=deferred (host eop.test.local[172.22.1.13] said: ${text} (in reply to RCPT TO command))` });
    expect(logSignals(lines([entry('4.4.2', '421 try later from [5.7.64.12]')]), { now: NOW })).toEqual([]);
    expect(logSignals(lines([entry('4.4.2', '421 see 15.7.711.3 and 5.7.2330')]), { now: NOW })).toEqual([]);
    expect(keys(logSignals(lines([entry('5.7.64', 'TenantAttribution')]), { now: NOW }))).toEqual(['tenant_attribution']);
    expect(keys(logSignals(lines([entry('5.0.0', '550 5.7.711 Access denied')]), { now: NOW }))).toEqual(['connector_blocked']);
  });
});

describe('the other signals', () => {
  const thresholds = { deferredCount: 20, deferredMinutes: 60 };
  const summary = (deferred, oldestDeferredSeconds) => ({ counts: { deferred }, oldestDeferredSeconds });

  it('raises the queue alert above the count or past the age', () => {
    expect(queueSignal(summary(20, 3600), thresholds)).toEqual([]);
    expect(queueSignal(summary(21, 60), thresholds)[0]).toMatchObject({ key: 'queue_deferred', details: { deferred: 21, oldestMinutes: 1 } });
    expect(queueSignal(summary(1, 3601), thresholds)[0].details.oldestMinutes).toBe(60);
    expect(queueSignal(summary(0, null), thresholds)).toEqual([]);
  });

  it('raises the certificate alert from the last node check', () => {
    expect(certificateSignal(null)).toEqual([]);
    expect(certificateSignal({ checks: [{ check: 'cert_expiry', status: 'ok' }] })).toEqual([]);
    expect(certificateSignal({ at: 'x', checks: [{ check: 'cert_expiry', status: 'warning', code: 'cert_expiring', daysLeft: 9 }] })[0])
      .toMatchObject({ severity: 'warning', details: { code: 'cert_expiring', daysLeft: 9, checkedAt: 'x' } });
    expect(certificateSignal({ checks: [{ check: 'cert_expiry', status: 'error', code: 'cert_expired' }] })[0].severity).toBe('error');
  });

  it('names the containers that are not running', () => {
    expect(containerSignal([{ name: 'a', state: 'running' }])).toEqual([]);
    expect(containerSignal([{ name: 'a', state: 'running' }, { name: 'b', state: 'exited' }])[0].details.down).toEqual([{ name: 'b', state: 'exited' }]);
  });

  it('counts a running but unhealthy container as down', () => {
    expect(containerSignal([{ name: 'a', state: 'running', health: 'unhealthy' }, { name: 'b', state: 'running', health: 'healthy' }])[0].details.down)
      .toEqual([{ name: 'a', state: 'unhealthy' }]);
  });

  it('fails the ping only for an error, naming warnings and notes in the body', () => {
    expect(pingOf([])).toEqual({ fail: false, body: 'mail node: no alerts' });
    expect(pingOf([{ key: 'queue_deferred', severity: 'warning' }, { key: 'eop_host_missing', severity: 'info' }]))
      .toEqual({ fail: false, body: 'mail node alerts: queue_deferred (warning), eop_host_missing (info)' });
    expect(pingOf([{ key: 'queue_deferred', severity: 'warning' }, { key: 'containers', severity: 'error' }]).fail).toBe(true);
  });

  it('raises the budget alert at 80 percent, as an error once exceeded', () => {
    expect(terrlSignal({ warn: false })).toEqual([]);
    expect(terrlSignal({ warn: true, exceeded: false, used: 800, limit: 1000, percent: 80 })[0].severity).toBe('warning');
    expect(terrlSignal({ warn: true, exceeded: true, used: 1000, limit: 1000, percent: 100 })[0].severity).toBe('error');
  });
});

describe('mergeAlerts', () => {
  const alert = (key, extra = {}) => ({ key, severity: 'error', details: {}, ...extra });

  it('keeps the first time an alert was raised and reports what came and went', () => {
    const first = mergeAlerts(null, [alert('containers')], [], 1000);
    expect(first.raised).toEqual(['containers']);
    const second = mergeAlerts(first.alerts, [alert('containers'), alert('connector_blocked')], [], 2000);
    expect(second.alerts.map((a) => [a.key, a.since])).toEqual([['connector_blocked', new Date(2000).toISOString()], ['containers', new Date(1000).toISOString()]]);
    expect(second).toMatchObject({ raised: ['connector_blocked'], cleared: [] });
    expect(mergeAlerts(second.alerts, [], [], 3000)).toMatchObject({ alerts: [], cleared: ['connector_blocked', 'containers'] });
  });

  it('keeps the alerts of a source that could not be read', () => {
    const before = mergeAlerts(null, [alert('connector_blocked'), alert('containers')], [], 1000).alerts;
    const after = mergeAlerts(before, [], ['log'], 2000);
    expect(after).toMatchObject({ raised: [], cleared: ['containers'] });
    expect(keys(after.alerts)).toEqual(['connector_blocked']);
  });
});

describe('alert settings', () => {
  it('checks what an administrator sends', () => {
    expect(parseAlertSettings({ pingUrl: ' https://hc.example.com/p ', deferredCount: '5', deferredMinutes: 30 }))
      .toEqual({ settings: { pingUrl: 'https://hc.example.com/p', deferredCount: 5, deferredMinutes: 30 } });
    expect(parseAlertSettings({ pingUrl: '' })).toEqual({ settings: { pingUrl: null } });
    expect(parseAlertSettings({ pingUrl: 'http://hc.example.com' })).toEqual({ error: 'ping_url_invalid' });
    expect(parseAlertSettings({ deferredCount: 0 })).toEqual({ error: 'deferred_count_invalid' });
    expect(parseAlertSettings({ deferredMinutes: 10081 })).toEqual({ error: 'deferred_minutes_invalid' });
    expect(parseAlertSettings({})).toEqual({ settings: {} });
  });

  it('has sane defaults', async () => {
    expect(await getAlertSettings()).toEqual({ pingUrl: null, deferredCount: 20, deferredMinutes: 60 });
  });
});

describe('runAlertCheck', () => {
  const journaled = () => recordAudit.mock.calls.flatMap(([entries]) => entries);

  it('does nothing without a mail node', async () => {
    node.cfg = null;
    expect(await runAlertCheck({ now: NOW })).toBeNull();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('keeps the state, journals a raised alert once, and pings /fail on every run', async () => {
    db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
    node.log = STAND_LOG;
    const state = await runAlertCheck({ now: NOW });
    expect(keys(state.alerts)).toEqual(['connector_blocked', 'terrl_exceeded']);
    expect(db.configs[ALERT_STATE_PROVIDER]).toMatchObject({ at: new Date(NOW).toISOString(), errors: [] });
    expect(journaled().map((e) => [e.action, e.details.alert])).toEqual([
      ['mail_node.alert_raised', 'connector_blocked'], ['mail_node.alert_raised', 'terrl_exceeded'],
    ]);
    expect(journaled()[0]).toMatchObject({ actorEmail: 'MailExpert', details: { severity: 'error', count: 1 } });
    expect(safeFetch.mock.calls[0][0]).toBe(`${PING}/fail`);
    expect(safeFetch.mock.calls[0][1].body).toBe('mail node alerts: connector_blocked (error), terrl_exceeded (error)');

    recordAudit.mockClear();
    await runAlertCheck({ now: NOW + 60000 });
    expect(journaled()).toEqual([]);
    expect(safeFetch).toHaveBeenCalledTimes(2);

    // An hour later the refusals are out of the window: cleared, journaled once, ping success.
    await runAlertCheck({ now: NOW + 2 * 3600000, userId: 'admin-1', trigger: 'manual' });
    expect(journaled().map((e) => [e.action, e.details.alert, e.actorUserId])).toEqual([
      ['mail_node.alert_cleared', 'connector_blocked', 'admin-1'], ['mail_node.alert_cleared', 'terrl_exceeded', 'admin-1'],
    ]);
    expect(safeFetch.mock.calls[2][0]).toBe(PING);
  });

  it('hands the same log read to the delivery details, and their failure changes neither alerts nor ping (R-17)', async () => {
    db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
    node.log = STAND_LOG;
    capture.result = new Error('database gone');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = await runAlertCheck({ now: NOW });
    expect(captureFromLog).toHaveBeenCalledTimes(1);
    const [{ cfg, log, eopHost, now }] = captureFromLog.mock.calls[0];
    expect({ cfg, eopHost, now, lines: log.lines.length }).toEqual({ cfg: node.cfg, eopHost: 'eop.test.local', now: NOW, lines: STAND_LOG.length });
    expect(state.errors).toEqual([]);
    expect(safeFetch.mock.calls[0][0]).toBe(`${PING}/fail`);
    expect(errorLog).toHaveBeenCalledWith('Mail node delivery details were not captured: database gone');
    errorLog.mockRestore();
    capture.result = { letters: 0, changed: 0 };

    // No log, no capture.
    captureFromLog.mockClear();
    clearPostfixLogCache();
    node.log = new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ECONNREFUSED)');
    await runAlertCheck({ now: NOW + 60000 });
    expect(captureFromLog).not.toHaveBeenCalled();
  });

  it('sends no ping when a source could not be read and keeps that source\'s alerts', async () => {
    db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
    node.containers = [{ name: 'dovecot-mailcow', state: 'restarting' }];
    await runAlertCheck({ now: NOW });
    safeFetch.mockClear();
    recordAudit.mockClear();
    node.containers = new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ECONNREFUSED)');
    node.queue = new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ECONNREFUSED)');
    const state = await runAlertCheck({ now: NOW + 60000 });
    expect(keys(state.alerts)).toEqual(['containers']);
    expect(state.errors.map((e) => [e.source, e.code])).toEqual([['queue', 'mail_node_unreachable'], ['containers', 'mail_node_unreachable']]);
    expect(journaled()).toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('raises the queue, certificate and budget alerts from their sources', async () => {
    db.configs[ALERTS_PROVIDER] = { deferredCount: 1 };
    node.queue = [1, 2].map((n) => ({ queueId: `ABCDEF${n}`, queue: 'deferred', arrivedAt: new Date(NOW - 60000).toISOString(), recipients: [] }));
    node.nodeDns = { at: '2026-10-01T18:00:00.000Z', checks: [{ check: 'cert_expiry', status: 'warning', code: 'cert_expiring', daysLeft: 10 }] };
    node.budget = { warn: true, exceeded: false, used: 900, limit: 1000, percent: 90, rampPercent: 100 };
    const state = await runAlertCheck({ now: NOW });
    expect(keys(state.alerts)).toEqual(['queue_deferred', 'certificate', 'terrl_budget']);
    expect(state.queue).toMatchObject({ total: 2, counts: { deferred: 2 } });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('pings success with warnings only, naming them in the body', async () => {
    db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
    node.budget = { warn: true, exceeded: false, used: 900, limit: 1000, percent: 90, rampPercent: 100 };
    await runAlertCheck({ now: NOW });
    expect(safeFetch.mock.calls[0][0]).toBe(PING);
    expect(safeFetch.mock.calls[0][1].body).toBe('mail node alerts: terrl_budget (warning)');
  });

  it('notes a missing <EOP_HOST> without a bypass alert and without failing the ping', async () => {
    db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
    node.eop = { eopHost: null };
    node.log = [{ ...BYPASS_SENT, time: String(NOW / 1000 - 60) }];
    const state = await runAlertCheck({ now: NOW });
    expect(state.alerts.map((a) => [a.key, a.severity])).toEqual([['eop_host_missing', 'info']]);
    expect(safeFetch.mock.calls[0][0]).toBe(PING);
  });

  it('keeps the log and budget alerts when the log answers nothing, and sends no ping', async () => {
    db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
    node.log = STAND_LOG;
    node.budget = { warn: true, exceeded: false, used: 900, limit: 1000, percent: 90, rampPercent: 100 };
    await runAlertCheck({ now: NOW });
    safeFetch.mockClear();
    recordAudit.mockClear();
    computeTerrlBudget.mockClear();
    clearPostfixLogCache();
    for (const empty of [{}, [], 'nothing']) {
      node.log = empty;
      node.budget = { warn: false, used: 10, limit: 1000, percent: 1 };
      const state = await runAlertCheck({ now: NOW + 60000 });
      expect(keys(state.alerts)).toEqual(['connector_blocked', 'terrl_exceeded', 'terrl_budget']);
      expect(state.errors).toEqual([{ source: 'log', code: 'mail_node_failed', message: 'The mail node returned no Postfix log' }]);
    }
    expect(computeTerrlBudget).not.toHaveBeenCalled();
    expect(journaled()).toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe('runAlertCheck and the outage windows (R-43)', () => {
  it("hands the containers' answer as a check, the log as evidence, then runs the trace", async () => {
    node.containers = [{ name: 'postfix-mailcow', state: 'exited' }, { name: 'dovecot-mailcow', state: 'running' }];
    await runAlertCheck({ now: NOW, userId: 'admin-1' });
    expect(recordCheck).toHaveBeenCalledWith({
      check: { result: 'failed', signals: ['containers'], down: [{ name: 'postfix-mailcow', state: 'exited' }] }, now: NOW, userId: 'admin-1',
    });
    expect(updateEvidence).toHaveBeenCalledTimes(1);
    // No trace connected: no pass.
    expect(runOutageTrace).not.toHaveBeenCalled();
  });

  it('starts the trace pass after the ping and does not wait for it', async () => {
    db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
    outage.source = { kind: 'fixture' };
    let finish;
    runOutageTrace.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const state = await runAlertCheck({ now: NOW });
    expect(state).toBeTruthy();
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(runOutageTrace).toHaveBeenCalledTimes(1);
    expect(runOutageTrace.mock.calls[0][0]).toMatchObject({ now: NOW, source: outage.source });
    expect(safeFetch.mock.invocationCallOrder[0]).toBeLessThan(runOutageTrace.mock.invocationCallOrder[0]);
    finish({ connected: true, windows: [] });
  });

  it('logs a trace pass that fails, without touching the run', async () => {
    outage.source = { kind: 'fixture' };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    runOutageTrace.mockImplementationOnce(async () => { throw new Error('graph down'); });
    const state = await runAlertCheck({ now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.errors).toEqual([]);
    expect(errorLog.mock.calls.some(([line]) => /outage trace failed/.test(line))).toBe(true);
    errorLog.mockRestore();
  });

  it('counts an API that does not answer as a failed check', async () => {
    node.containers = new MailNodeError('mail_node_unreachable', 'unreachable');
    node.log = new MailNodeError('mail_node_unreachable', 'unreachable');
    node.queue = new MailNodeError('mail_node_unreachable', 'unreachable');
    await runAlertCheck({ now: NOW });
    expect(recordCheck.mock.calls[0][0].check).toEqual({ result: 'failed', signals: ['api_unreachable'], down: [] });
    expect(updateEvidence).not.toHaveBeenCalled();
  });

  it("warns while letters wait in EOP's queue, named in the ping without /fail", async () => {
    db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
    outage.source = { kind: 'fixture' };
    outage.waiting = { waiting: 3, soonestExpiresAt: '2026-10-02T10:00:00.000Z' };
    const state = await runAlertCheck({ now: NOW });
    expect(state.alerts.find((a) => a.key === 'outage_letters_waiting')).toMatchObject({
      severity: 'warning', details: { waiting: 3, soonestExpiresAt: '2026-10-02T10:00:00.000Z' },
    });
    expect(safeFetch.mock.calls[0]).toEqual([PING, expect.objectContaining({ body: 'mail node alerts: outage_letters_waiting (warning)' })]);
    expect(recordAudit.mock.calls.flatMap(([e]) => e).find((e) => e.details.alert === 'outage_letters_waiting').details)
      .toMatchObject({ waiting: 3, soonestExpiresAt: '2026-10-02T10:00:00.000Z' });
  });

  it('keeps the trace alert and the ping when the outage step fails', async () => {
    db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
    outage.source = { kind: 'fixture' };
    outage.waiting = { waiting: 1, soonestExpiresAt: '2026-10-02T10:00:00.000Z' };
    await runAlertCheck({ now: NOW });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    outage.record = new Error('database gone');
    outage.trace = new Error('database gone');
    const state = await runAlertCheck({ now: NOW + 60000 });
    errorLog.mockRestore();
    expect(keys(state.alerts)).toEqual(['outage_letters_waiting']);
    expect(state.errors).toEqual([]);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });
});

describe('startNodeAlertJob', () => {
  it('runs first after 90 seconds, then every five minutes, without holding the process', async () => {
    vi.useFakeTimers();
    try {
      node.cfg = null;
      getMailNodeConfig.mockClear();
      startNodeAlertJob();
      startNodeAlertJob();
      await vi.advanceTimersByTimeAsync(89 * 1000);
      expect(getMailNodeConfig).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(getMailNodeConfig).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 90 * 1000);
      expect(getMailNodeConfig).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(getMailNodeConfig).toHaveBeenCalledTimes(3);
      stopNodeAlertJob();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(getMailNodeConfig).toHaveBeenCalledTimes(3);
    } finally {
      stopNodeAlertJob();
      vi.useRealTimers();
    }
  });
});

describe('the tenant alerts (R-27, the application certificate)', () => {
  const TENANT = {
    tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
    appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: 'A'.repeat(40),
  };
  const DAY = 24 * 3600000;
  const at = (ms) => new Date(ms).toISOString();
  const pollState = ({ items = [], ok = true, readAt = NOW - 60000, notAfter = NOW + 200 * DAY } = {}) => ({
    blockedConnectors: { at: at(readAt), ok, items },
    certificate: { thumbprint: TENANT.certThumbprint, notAfter: at(notAfter) },
  });
  const BLOCKED = [{ connectorId: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a', connectorName: 'From mail node', reason: 'Suspicious', createdTime: null }];

  it('tenantSignals: a blocked connector, and the certificate at 30 and 14 days', () => {
    expect(tenantSignals(pollState(), NOW)).toEqual({ alerts: [], stale: false, connectorsStale: true, antispamStale: false });
    const blocked = tenantSignals(pollState({ items: BLOCKED }), NOW);
    expect(blocked.alerts).toEqual([{
      key: 'connector_blocked_tenant', severity: 'error', details: { count: 1, connectors: BLOCKED, checkedAt: at(NOW - 60000) },
    }]);
    expect(tenantSignals(pollState({ notAfter: NOW + 31 * DAY }), NOW).alerts).toEqual([]);
    expect(tenantSignals(pollState({ notAfter: NOW + 29.5 * DAY }), NOW).alerts).toEqual([expect.objectContaining({
      key: 'tenant_certificate', severity: 'warning', details: expect.objectContaining({ code: 'cert_expiring', daysLeft: 29 }),
    })]);
    expect(tenantSignals(pollState({ notAfter: NOW + 13.5 * DAY }), NOW).alerts[0]).toMatchObject({ severity: 'error', details: { daysLeft: 13 } });
    expect(tenantSignals(pollState({ notAfter: NOW - DAY }), NOW).alerts[0]).toMatchObject({ severity: 'error', details: { code: 'cert_expired' } });
  });

  it('tenantSignals: a failed or old poll is stale and raises no connector alert of its own', () => {
    expect(tenantSignals(pollState({ items: BLOCKED, ok: false }), NOW)).toEqual({ alerts: [], stale: true, connectorsStale: true, antispamStale: false });
    const old = tenantSignals(pollState({ readAt: NOW - TENANT_STALE_MS - 1000 }), NOW);
    expect(old.stale).toBe(true);
    expect(old.alerts.map((a) => a.key)).toEqual(['tenant_poll_failing']);
    expect(tenantSignals({}, NOW)).toEqual({ alerts: [], stale: true, connectorsStale: true, antispamStale: false });
  });

  it('tenantSignals: a connector changed since its reference warns (R-25, stage 7b)', () => {
    const connector = (tls) => ({ name: 'To mail node', properties: { TlsSettings: tls, SmartHosts: ['mail.example.com'] } });
    const reference = { at: at(NOW - DAY), inbound: [], outbound: [connector('domainvalidation')] };
    const read = (tls, { ok = true, readAt = NOW - 60000 } = {}) => ({
      ...pollState(), connectorReference: reference, connectors: { at: at(readAt), ok, inbound: [], outbound: [connector(tls)] },
    });
    expect(tenantSignals(read('domainvalidation'), NOW)).toEqual({ alerts: [], stale: false, connectorsStale: false, antispamStale: false });
    expect(tenantSignals(read('encryptiononly'), NOW).alerts).toEqual([{
      key: 'tenant_connector_drift', severity: 'warning',
      details: { count: 1, connectors: [{ direction: 'outbound', name: 'To mail node', kind: 'changed' }], checkedAt: at(NOW - 60000) },
    }]);
    // A failed or old read of the connectors keeps the alert as it was (the source is not read).
    expect(tenantSignals(read('encryptiononly', { ok: false }), NOW)).toMatchObject({ alerts: [], connectorsStale: true });
    expect(tenantSignals(read('encryptiononly', { readAt: NOW - TENANT_STALE_MS - 1000 }), NOW).connectorsStale).toBe(true);
  });

  it('tenantSignals: the anti-spam actions the panel could not set warn (section 5.14)', () => {
    const withAntispam = (antispam) => ({ ...pollState(), antispam });
    expect(tenantSignals(withAntispam({ at: at(NOW), ok: true, enforcement: { at: at(NOW), ok: true, changed: [], failed: [] } }), NOW))
      .toMatchObject({ alerts: [], antispamStale: false });
    expect(tenantSignals(withAntispam({
      at: at(NOW), ok: true, enforcement: { at: at(NOW), ok: false, changed: [], failed: ['PhishSpamAction'], error: { code: 'antispam_not_written' } },
    }), NOW).alerts).toEqual([{
      key: 'tenant_antispam_not_enforced', severity: 'warning',
      details: { fields: ['PhishSpamAction'], code: 'antispam_not_written', checkedAt: at(NOW) },
    }]);
    // A read that failed before any write keeps the alert as it was.
    expect(tenantSignals(withAntispam({ at: at(NOW), ok: false, code: 'worker_unreachable' }), NOW)).toMatchObject({ alerts: [], antispamStale: true });
  });

  describe('in the run', () => {
    beforeEach(() => {
      setTenantDriver(createFakeTenantDriver());
      node.eop = { eopHost: 'eop.test.local', ...TENANT };
    });
    afterEach(() => { setTenantDriver(undefined); });

    it('raises, journals and pings /fail for a blocked connector; a failed poll keeps it and still pings', async () => {
      db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
      db.configs.mail_node_tenant_state = pollState({ items: BLOCKED });
      let state = await runAlertCheck({ now: NOW });
      expect(keys(state.alerts)).toEqual(['connector_blocked_tenant']);
      expect(recordAudit.mock.calls.flatMap(([e]) => e)[0]).toMatchObject({
        action: 'mail_node.alert_raised', details: { alert: 'connector_blocked_tenant', severity: 'error', count: 1, connectorIds: [BLOCKED[0].connectorId] },
      });
      expect(safeFetch.mock.calls[0][0]).toBe(`${PING}/fail`);

      // One failed poll: the alert stays, the node's ping is not withheld, no warning yet.
      db.configs.mail_node_tenant_state = { ...pollState({ items: [], ok: false }), blockedConnectors: { ...pollState().blockedConnectors, ok: false, failures: 1, errorAt: at(NOW) } };
      state = await runAlertCheck({ now: NOW + 60000 });
      expect(keys(state.alerts)).toEqual(['connector_blocked_tenant']);
      expect(state.errors).toEqual([]);
      expect(safeFetch).toHaveBeenCalledTimes(2);

      db.configs.mail_node_tenant_state = pollState({ readAt: NOW + 120000 });
      state = await runAlertCheck({ now: NOW + 180000 });
      expect(keys(state.alerts)).toEqual([]);
      expect(safeFetch.mock.calls[2][0]).toBe(PING);
    });

    it('warns after three failed polls, or when no poll ran lately, and still pings success', async () => {
      db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
      db.configs.mail_node_tenant_state = {
        ...pollState(), blockedConnectors: { ...pollState().blockedConnectors, ok: false, failures: 3, errorAt: at(NOW), error: { code: 'exo_timeout' } },
      };
      let state = await runAlertCheck({ now: NOW });
      expect(state.alerts.map((a) => [a.key, a.severity])).toEqual([['tenant_poll_failing', 'warning']]);
      expect(state.alerts[0].details).toMatchObject({ failures: 3, code: 'exo_timeout' });
      expect(state.errors).toEqual([]);
      expect(safeFetch.mock.calls[0][0]).toBe(PING);
      expect(safeFetch.mock.calls[0][1].body).toBe('mail node alerts: tenant_poll_failing (warning)');

      db.configs.mail_node_tenant_state = pollState({ readAt: NOW - TENANT_STALE_MS - 60000 });
      state = await runAlertCheck({ now: NOW });
      expect(state.alerts[0]).toMatchObject({ key: 'tenant_poll_failing', details: { failures: 0, code: 'tenant_poll_stale' } });
    });

    it('before the first poll: nothing raised, the ping goes', async () => {
      db.configs[ALERTS_PROVIDER] = { pingUrl: PING };
      const state = await runAlertCheck({ now: NOW });
      expect(state.alerts).toEqual([]);
      expect(state.errors).toEqual([]);
      expect(safeFetch).toHaveBeenCalledTimes(1);
    });

    it('warns while phishing the panel keeps in the quarantine is still there (R-42); a failed read keeps it', async () => {
      db.configs.mail_node_tenant_state = pollState();
      db.held = { count: 2, soonest: '2026-11-01T00:00:00.000Z' };
      try {
        let state = await runAlertCheck({ now: NOW });
        expect(state.alerts.find((a) => a.key === 'tenant_phish_held')).toMatchObject({
          severity: 'warning', details: { count: 2, soonestExpiresAt: '2026-11-01T00:00:00.000Z' },
        });
        expect(recordAudit.mock.calls.flatMap(([e]) => e).find((e) => e.details?.alert === 'tenant_phish_held').details)
          .toMatchObject({ count: 2, soonestExpiresAt: '2026-11-01T00:00:00.000Z' });
        db.held = new Error('database gone');
        state = await runAlertCheck({ now: NOW + 60000 });
        expect(keys(state.alerts)).toContain('tenant_phish_held');
        db.held = { count: 0, soonest: null };
        state = await runAlertCheck({ now: NOW + 120000 });
        expect(keys(state.alerts)).not.toContain('tenant_phish_held');
      } finally {
        db.held = undefined;
      }
    });

    it('nothing without a driver or a configured tenant', async () => {
      db.configs.mail_node_tenant_state = pollState({ items: BLOCKED });
      setTenantDriver(null);
      expect(keys((await runAlertCheck({ now: NOW })).alerts)).toEqual([]);
      setTenantDriver(createFakeTenantDriver());
      node.eop = { eopHost: 'eop.test.local' };
      const state = await runAlertCheck({ now: NOW });
      expect(keys(state.alerts)).toEqual([]);
      expect(state.errors).toEqual([]);
    });
  });
});
