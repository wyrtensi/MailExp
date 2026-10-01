import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ configs: {} }));
vi.mock('../db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.startsWith('SELECT config')) return { rows: db.configs[params[0]] ? [{ config: db.configs[params[0]] }] : [] };
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
vi.mock('./mailcow.js', async (importActual) => ({
  ...(await importActual()),
  getMailNodeConfig: vi.fn(async () => node.cfg),
  getPostfixLog: vi.fn(async () => fail(node.log)),
  listQueue: vi.fn(async () => fail(node.queue)),
  getContainers: vi.fn(async () => fail(node.containers)),
}));
vi.mock('./eopSettings.js', () => ({ getEopSettings: vi.fn(async () => node.eop) }));
vi.mock('./dnsCheckJob.js', () => ({ getNodeDnsCheck: vi.fn(async () => fail(node.nodeDns)) }));
vi.mock('./terrl.js', async (importActual) => ({
  ...(await importActual()),
  computeTerrlBudget: vi.fn(async () => fail(node.budget)),
}));

import { recordAudit } from '../auditLog.js';
import { safeFetch } from '../safeFetch.js';
import { MailNodeError } from './mailcow.js';
import { parsePostfixLog } from './postfixLog.js';
import { BYPASS_SENT, STAND_LOG, STAND_SENT_LOCAL, STAND_SENT_VIA_EOP } from './postfixLog.fixtures.js';
import {
  ALERTS_PROVIDER, ALERT_STATE_PROVIDER, certificateSignal, containerSignal, getAlertSettings, logSignals, mergeAlerts,
  parseAlertSettings, queueSignal, runAlertCheck, terrlSignal,
} from './nodeAlerts.js';

// The stand's lines happened at 19:02:59-19:03:11 on 2026-10-01; "now" is a few minutes later.
const NOW = Date.parse('2026-10-01T19:10:00Z');
const PING = 'https://hc.example.com/ping/alerts';
const lines = (entries) => parsePostfixLog(entries).lines;
const keys = (alerts) => alerts.map((a) => a.key);

beforeEach(() => {
  db.configs = {};
  node.cfg = { mailHost: 'mail.example.com', apiKey: 'k' };
  node.log = [];
  node.queue = [];
  node.containers = [{ name: 'postfix-mailcow', state: 'running' }];
  node.nodeDns = null;
  node.budget = { warn: false, used: 0, limit: null };
  node.eop = { eopHost: 'eop.test.local' };
  recordAudit.mockClear();
  safeFetch.mockClear();
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
    expect(alerts[0].details).toMatchObject({ count: 1, relays: ['mx.example.org'], eopHostSet: true });
  });

  it('counts every outbound delivery as a bypass while <EOP_HOST> is not set and the address is no EOP one', () => {
    const alerts = logSignals(lines([STAND_SENT_VIA_EOP]), { now: Date.parse('2026-10-01T18:00:00Z') });
    expect(alerts[0].details).toMatchObject({ relays: ['eop.test.local'], eopHostSet: false });
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
    expect(safeFetch.mock.calls[0][1].body).toBe('mail node alerts: connector_blocked, terrl_exceeded');

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
});
