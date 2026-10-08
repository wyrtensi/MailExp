import { WAIT_FLAGS, WAIT_HELP, confirm, jobLine, maybeWait, nodeCheckWait, unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import {
  OUTAGE_ERRORS, changeOutage, closeOutage, openOutage, outageLetters, outageSettingsView, outageWindow, outagesView,
  removeOutage, saveOutageSettingsAction,
} from '../../services/mailNode/outageActions.js';
import { NODE_CHECK_ERRORS, enqueueNodeCheck } from '../../services/mailNode/nodeChecks.js';

// mailexpert outage ...: the windows when the mail node was down and the letters delayed or lost in
// them (R-43; services/mailNode/outageActions.js, the "Outages" part of the "Mail node" screen). A
// window is named by its ID (outage list). Times are ISO 8601, such as 2026-10-01T10:00:00Z.

const counts = (w) => Object.entries(w.counts ?? {}).filter(([, n]) => n).map(([outcome, n]) => `${outcome} ${n}`);

function windowLines(w) {
  return keyValues([
    ['id', w.id],
    ['started', fmtDate(w.startedAt)],
    ['ended', w.endedAt ? fmtDate(w.endedAt) : `open${w.stalled ? ' (no check for a while)' : ''}`],
    ['source', `${w.source}${w.planned ? ', planned' : ''}`],
    ['reason', w.reason],
    ['letters', counts(w).length ? counts(w).join(', ') : 'none found'],
  ]);
}

const list = {
  name: 'list',
  summary: 'list the outage windows (newest 50), the letters still waiting in EOP and the settings',
  usage: 'outage list',
  async run() {
    const result = await outagesView();
    const lines = table(result.windows, [
      { header: 'ID', value: (w) => w.id },
      { header: 'STARTED', value: (w) => fmtDate(w.startedAt) },
      { header: 'ENDED', value: (w) => (w.endedAt ? fmtDate(w.endedAt) : 'open') },
      { header: 'SOURCE', value: (w) => `${w.source}${w.planned ? ' (planned)' : ''}` },
      { header: 'LETTERS', value: (w) => counts(w) },
      { header: 'REASON', value: (w) => w.reason },
    ], { empty: 'no outage windows' });
    lines.push('', ...keyValues([
      ['message trace', result.traceConnected ? 'connected' : 'not set up'],
      ['waiting in EOP', result.traceConnected ? `${result.waiting.waiting}${result.waiting.soonestExpiresAt ? `, the first expires ${fmtDate(result.waiting.soonestExpiresAt)}` : ''}` : undefined],
      ['letters kept', `${result.settings.retentionDays} days`],
    ]));
    return { data: result, lines };
  },
};

const show = {
  name: 'show',
  summary: 'show one outage window with its letters\' counts',
  usage: 'outage show <id>',
  positionals: ['id'],
  async run(ctx) {
    const result = unwrap(await outageWindow(ctx.args.id), OUTAGE_ERRORS);
    return { data: result, lines: windowLines(result.window) };
  },
};

const letters = {
  name: 'letters',
  summary: 'every letter of a window: delayed, waiting in EOP, lost and the others',
  usage: 'outage letters <id>',
  positionals: ['id'],
  async run(ctx) {
    const result = unwrap(await outageLetters(ctx.args.id), OUTAGE_ERRORS);
    const lines = table(result.letters, [
      { header: 'RECEIVED', value: (l) => fmtDate(l.receivedAt) },
      { header: 'OUTCOME', value: (l) => `${l.outcome}${l.expired ? ' (expired)' : ''}` },
      { header: 'RECIPIENT', value: (l) => l.recipient },
      { header: 'SENDER', value: (l) => l.sender },
      { header: 'SUBJECT', value: (l) => l.subject },
    ], { empty: 'no letters found for this window' });
    return { data: result, lines };
  },
};

const open = {
  name: 'open',
  journal: 'mail_node.outage_added',
  summary: 'add an outage window by hand',
  usage: 'outage open --start TIME [--end TIME] --reason TEXT [--planned]',
  help: [
    '--start TIME    when the node stopped taking mail (at most a month ahead)',
    '--end TIME      when it took mail again; without it the window stays open',
    '--reason TEXT   why (required, up to 500 characters)',
    '--planned       a planned maintenance',
  ],
  flags: { start: 'string', end: 'string', reason: 'string', planned: 'boolean' },
  async run(ctx) {
    const { start, end, reason, planned } = ctx.flags;
    if (start === undefined) throw new UsageError('--start is required');
    if (reason === undefined) throw new UsageError('--reason is required: say why');
    const result = unwrap(await openOutage({ startedAt: start, endedAt: end, reason, planned: !!planned }, ctx.actor), OUTAGE_ERRORS);
    return { data: result, lines: ['window added', ...windowLines(result.window)] };
  },
};

const update = {
  name: 'update',
  journal: 'mail_node.outage_changed (mail_node.outage_closed when it gets an end) with the changed fields',
  summary: 'change the start, the end or the reason of a window; every change says why',
  usage: 'outage update <id> [--start TIME] [--end TIME] --reason TEXT',
  help: ['New times drop the letters the trace no longer looks at; the next pass lists the window again.'],
  flags: { start: 'string', end: 'string', reason: 'string' },
  positionals: ['id'],
  async run(ctx) {
    const { start, end, reason } = ctx.flags;
    if (reason === undefined) throw new UsageError('--reason is required: say why the window changes');
    const body = { reason, ...(start !== undefined ? { startedAt: start } : {}), ...(end !== undefined ? { endedAt: end } : {}) };
    const result = unwrap(await changeOutage(ctx.args.id, body, ctx.actor), OUTAGE_ERRORS);
    return { data: result, lines: ['window changed', ...windowLines(result.window)] };
  },
};

const close = {
  name: 'close',
  journal: 'mail_node.outage_closed',
  summary: 'close an open window now, or at --end',
  usage: 'outage close <id> [--end TIME] --reason TEXT',
  flags: { end: 'string', reason: 'string' },
  positionals: ['id'],
  async run(ctx) {
    if (ctx.flags.reason === undefined) throw new UsageError('--reason is required: say why the window closes');
    const result = unwrap(await closeOutage(ctx.args.id, { endedAt: ctx.flags.end, reason: ctx.flags.reason }, ctx.actor), OUTAGE_ERRORS);
    return { data: result, lines: ['window closed', ...windowLines(result.window)] };
  },
};

const remove = {
  name: 'delete',
  journal: 'mail_node.outage_deleted with its times and the reason',
  summary: 'delete a window and what the trace found for it',
  usage: 'outage delete <id> --reason TEXT',
  flags: { reason: 'string' },
  positionals: ['id'],
  async run(ctx) {
    if (ctx.flags.reason === undefined) throw new UsageError('--reason is required: say why the window is deleted');
    await confirm(ctx, `Delete the outage window ${ctx.args.id} and the letters the trace found for it?`);
    const result = unwrap(await removeOutage(ctx.args.id, { confirm: true, reason: ctx.flags.reason }, ctx.actor), OUTAGE_ERRORS);
    return { data: result, lines: [`window ${ctx.args.id} deleted`] };
  },
};

const trace = {
  name: 'trace',
  journal: 'none: the trace changes only what the panel knows of the letters',
  summary: 'a pass of the message trace over every followed window now: the backend runs it',
  usage: 'outage trace [--wait] [--timeout SEC]',
  help: [
    'The pass runs in the backend, which keeps the trace\'s request budget; a pass going there is',
    'joined, and a forced pass runs at most once every two minutes (the job then fails with',
    'trace_cooldown). The command queues it.',
    ...WAIT_HELP,
  ],
  flags: WAIT_FLAGS,
  async run(ctx) {
    const queued = unwrap(await enqueueNodeCheck('outage_trace', ctx.actor), NODE_CHECK_ERRORS);
    const job = await maybeWait(ctx, queued.job, nodeCheckWait('outage list'));
    return { data: { job, created: queued.created }, lines: [jobLine(job, queued.created)] };
  },
};

const settings = {
  name: 'settings',
  journal: 'mail_node.config_changed (outages) with the changed fields',
  summary: 'show or change how long the letters of the windows are kept',
  usage: 'outage settings show | outage settings set --retention-days N',
  flags: { 'retention-days': 'string' },
  positionals: ['action'],
  async run(ctx) {
    const days = ctx.flags['retention-days'];
    if (ctx.args.action === 'show') {
      if (days !== undefined) throw new UsageError('outage settings show takes no --retention-days');
      const result = await outageSettingsView();
      return { data: result, lines: [`letters kept: ${result.settings.retentionDays} days`] };
    }
    if (ctx.args.action !== 'set') throw new UsageError('<action> must be show or set');
    if (days === undefined) throw new UsageError('nothing to change: give --retention-days');
    const result = unwrap(await saveOutageSettingsAction({ retentionDays: days }, ctx.actor), OUTAGE_ERRORS);
    return { data: result, lines: [`saved: letters kept ${result.settings.retentionDays} days`] };
  },
};

export default {
  name: 'outage',
  summary: 'the mail node\'s outage windows and their letters: list, open, change, close, trace',
  commands: [list, show, letters, open, update, close, remove, trace, settings],
};
