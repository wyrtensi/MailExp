import { confirm, nodeAction, unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import {
  QUARANTINE_ERRORS, adminViewer, applyQuarantineNodeSettings, listNodeQuarantine, quarantineEntryAction,
  quarantineSettingsView, setQuarantineUserViewAction,
} from '../../services/mailNode/quarantineActions.js';

// mailexpert spam-quarantine ...: the mail node's own quarantine, the letters rspamd rejected or
// marked as spam that mailcow keeps (R-20; services/mailNode/quarantineActions.js, the
// "Quarantine" screen of the mail node). EOP's quarantine is the "quarantine" group. An entry is
// named by its mailcow ID (spam-quarantine list).

const list = {
  name: 'list',
  summary: 'list the entries, newest first, with the panel\'s mailbox and the symbols that weighed most',
  usage: 'spam-quarantine list',
  async run() {
    const result = unwrap(await nodeAction(async () => listNodeQuarantine(await adminViewer())), QUARANTINE_ERRORS);
    const lines = table(result.items, [
      { header: 'ID', value: (q) => q.id },
      { header: 'CREATED', value: (q) => fmtDate(q.created) },
      { header: 'ACTION', value: (q) => `${q.action}${q.virus ? ' (virus)' : ''}` },
      { header: 'SCORE', value: (q) => q.score },
      { header: 'RECIPIENT', value: (q) => `${q.rcpt}${q.accountId ? '' : ' (not in the panel)'}` },
      { header: 'SENDER', value: (q) => q.sender },
      { header: 'SUBJECT', value: (q) => q.subject },
    ], { empty: 'the quarantine is empty' });
    if (result.truncated) lines.push(`(the newest ${result.items.length} of ${result.total})`);
    if (result.spamInHistory) lines.push(`rspamd's history shows ${result.spamInHistory} letters refused or marked as spam: is mailcow's quarantine on? ("spam-quarantine node-settings apply")`);
    return { data: result, lines };
  },
};

function entryCommand(name, kind, summary, journal, question = null) {
  return {
    name,
    journal,
    summary,
    usage: `spam-quarantine ${name} <id>`,
    positionals: ['id'],
    async run(ctx) {
      if (question) await confirm(ctx, question(ctx.args.id));
      const result = unwrap(await nodeAction(() => quarantineEntryAction(ctx.args.id, kind, ctx.actor)), QUARANTINE_ERRORS);
      const lines = [`entry ${ctx.args.id}: ${name === 'release' ? 'released' : 'deleted'}${result.learned === undefined ? '' : `, rspamd ${result.learned ? 'trained' : 'not trained'}`}`];
      for (const warning of result.warnings ?? []) lines.push(`node warning: ${warning}`);
      return { data: result, lines };
    },
  };
}

function settingsLines(view) {
  return keyValues([
    ['users see the quarantine', view.userView],
    ['node settings applied', view.nodeSettingsAppliedAt ? fmtDate(view.nodeSettingsAppliedAt) : 'never'],
  ]);
}

const ON_OFF = Object.freeze({ on: true, off: false });

const settings = {
  name: 'settings',
  journal: 'mail_node.config_changed (quarantine) when it changes',
  summary: 'show or set whether every user sees the entries for the panel\'s mailboxes',
  usage: 'spam-quarantine settings show | spam-quarantine settings set --user-view on|off',
  flags: { 'user-view': 'string' },
  positionals: ['action'],
  async run(ctx) {
    const value = ctx.flags['user-view'];
    if (ctx.args.action === 'show') {
      if (value !== undefined) throw new UsageError('spam-quarantine settings show takes no --user-view');
      const view = await quarantineSettingsView();
      return { data: view, lines: settingsLines(view) };
    }
    if (ctx.args.action !== 'set') throw new UsageError('<action> must be show or set');
    if (!Object.hasOwn(ON_OFF, value ?? '')) throw new UsageError('--user-view must be on or off');
    const result = unwrap(await setQuarantineUserViewAction(ON_OFF[value], ctx.actor), QUARANTINE_ERRORS);
    return { data: result, lines: [`users see the quarantine: ${result.userView ? 'yes' : 'no'}`] };
  },
};

const nodeSettings = {
  name: 'node-settings',
  journal: 'mail_node.quarantine_settings_applied',
  summary: 'show the quarantine settings the panel writes to mailcow, or write them',
  usage: 'spam-quarantine node-settings show | spam-quarantine node-settings apply',
  help: [
    'apply   "Enable quarantine on this node": writes every quarantine setting of mailcow (letters',
    '        up to 10 MiB, 20 kept per mailbox, 365 days, released as the original letter). mailcow',
    '        cannot report them and resets whatever it is not given, so it asks first.',
  ],
  positionals: ['action'],
  async run(ctx) {
    if (ctx.args.action === 'show') {
      const view = await quarantineSettingsView();
      return { data: view, lines: [...keyValues([['applied', view.nodeSettingsAppliedAt ? fmtDate(view.nodeSettingsAppliedAt) : 'never']]), ...keyValues(Object.entries(view.nodeSettings))] };
    }
    if (ctx.args.action !== 'apply') throw new UsageError('<action> must be show or apply');
    await confirm(ctx, 'Write every quarantine setting of mailcow? What it holds now is overwritten.');
    const result = unwrap(await nodeAction(() => applyQuarantineNodeSettings({ confirm: true }, ctx.actor)), QUARANTINE_ERRORS);
    return { data: result, lines: [`quarantine settings written at ${fmtDate(result.nodeSettingsAppliedAt)}`] };
  },
};

export default {
  name: 'spam-quarantine',
  summary: 'the mail node\'s rspamd quarantine: list, release, train as spam, delete, settings',
  commands: [
    list,
    entryCommand('release', 'release', 'deliver the letter to its mailbox past rspamd and train rspamd with it as ham',
      'mail_node.quarantine_released with what training did',
      (id) => `Release quarantine entry ${id}? The letter is delivered to its mailbox past the spam filter; this cannot be undone.`),
    entryCommand('learn-spam', 'learn_spam', 'delete the entry and train rspamd with it as spam',
      'mail_node.quarantine_learned_spam with what training did',
      (id) => `Delete quarantine entry ${id} and train the spam filter with it as spam? The letter is gone for good.`),
    entryCommand('delete', 'delete', 'delete the entry: the letter is gone',
      'mail_node.quarantine_deleted', (id) => `Delete quarantine entry ${id}? The letter is gone for good.`),
    settings,
    nodeSettings,
  ],
};
