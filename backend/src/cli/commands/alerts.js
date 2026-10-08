import { WAIT_FLAGS, WAIT_HELP, jobLine, maybeWait, nodeCheckWait, unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import { MAIL_NODE_ERRORS } from '../../services/mailNode/errors.js';
import { alertsView, saveAlertSettingsAction } from '../../services/mailNode/nodeOpsActions.js';
import { getAlertState } from '../../services/mailNode/nodeAlerts.js';
import { NODE_CHECK_ERRORS, enqueueNodeCheck } from '../../services/mailNode/nodeChecks.js';

// mailexpert alerts ...: the mail node's alerts (R-18, R-19; services/mailNode/nodeAlerts.js, the
// "Alerts" part of the "Mail node" screen): the last check, a check now and the settings.

function stateLines(state) {
  if (!state) return ['no check yet'];
  const lines = [`last check: ${fmtDate(state.at)} (${state.trigger ?? '-'})`];
  lines.push(...table(state.alerts ?? [], [
    { header: 'ALERT', value: (a) => a.key },
    { header: 'SEVERITY', value: (a) => a.severity },
    { header: 'SINCE', value: (a) => fmtDate(a.since) },
    { header: 'DETAILS', value: (a) => a.details ?? null },
  ], { empty: 'no alerts' }));
  for (const e of state.errors ?? []) lines.push(`not read: ${e.source} (${e.code})`);
  if (state.queue) lines.push(`queue: ${state.queue.total} messages, ${state.queue.counts?.deferred ?? 0} deferred`);
  return lines;
}

function settingsLines(settings) {
  return keyValues([
    ['ping url', settings.pingUrl],
    ['deferred count', settings.deferredCount],
    ['deferred minutes', settings.deferredMinutes],
  ]);
}

const status = {
  name: 'status',
  summary: 'the last alert check, its alerts and the settings',
  usage: 'alerts status',
  async run() {
    const result = await alertsView();
    return { data: result, lines: [...stateLines(result.state), '', ...settingsLines(result.settings)] };
  },
};

const check = {
  name: 'check',
  journal: 'mail_node.alert_raised and mail_node.alert_cleared for what changed, written by the backend',
  summary: 'check the alerts now (the "Check now" button): the backend runs it',
  usage: 'alerts check [--wait] [--timeout SEC]',
  help: [
    'The check runs in the backend (a check going there is joined), which also pings the',
    'Healthchecks URL and starts the outage trace after it; the command queues it.',
    ...WAIT_HELP,
  ],
  flags: WAIT_FLAGS,
  async run(ctx) {
    const queued = unwrap(await enqueueNodeCheck('alerts', ctx.actor), NODE_CHECK_ERRORS);
    const job = await maybeWait(ctx, queued.job, nodeCheckWait('alerts status'));
    if (!ctx.flags.wait) return { data: { job }, lines: [jobLine(job)] };
    const state = await getAlertState();
    return { data: { job, state }, lines: [jobLine(job), ...stateLines(state)] };
  },
};

const SET_FLAGS = Object.freeze({ 'ping-url': 'pingUrl', 'deferred-count': 'deferredCount', 'deferred-minutes': 'deferredMinutes' });

const set = {
  name: 'set',
  journal: 'mail_node.config_changed (alerts) with the changed fields',
  summary: 'change the alerts\' Healthchecks URL or the queue thresholds',
  usage: 'alerts set [--ping-url URL] [--deferred-count N] [--deferred-minutes N]',
  help: [
    '--ping-url URL        the Healthchecks URL each check pings (/fail with an error); "" removes it',
    '--deferred-count N    alert at this many deferred messages',
    '--deferred-minutes N  or when the oldest deferred message is this many minutes old',
    'The options not given keep their values.',
  ],
  flags: Object.fromEntries(Object.keys(SET_FLAGS).map((flag) => [flag, 'string'])),
  async run(ctx) {
    const body = Object.fromEntries(Object.entries(SET_FLAGS)
      .filter(([flag]) => ctx.flags[flag] !== undefined)
      .map(([flag, field]) => [field, ctx.flags[flag]]));
    if (!Object.keys(body).length) throw new UsageError('nothing to change: give --ping-url, --deferred-count or --deferred-minutes');
    const result = unwrap(await saveAlertSettingsAction(body, ctx.actor), MAIL_NODE_ERRORS);
    return { data: result, lines: ['saved', ...settingsLines(result.settings)] };
  },
};

export default {
  name: 'alerts',
  summary: 'the mail node\'s alerts: status, check now, settings',
  commands: [status, check, set],
};
