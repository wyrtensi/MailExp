import { readFile } from 'node:fs/promises';
import { CliError, confirm, unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { fmtDate, fmtValue, keyValues, table } from '../output.js';
import { queueEffects } from '../effects.js';
import {
  RULE_ERRORS, createRule, deleteRule, getRule, listRules, rulesRunTargets, updateRule,
} from '../../services/rules/ruleActions.js';
import { ACCOUNT_ERRORS, findAccount } from '../../services/accounts/manualAccounts.js';
import { ADMIN_USER_ERRORS, findUser } from '../../services/admin/users.js';

// mailexpert rule ...: inbox rules (services/rules/ruleActions.js, the panel's "Rules" and
// /api/rules): the same checks and journal. A rule belongs to a mailbox; rules are shared, so
// everyone who can open the mailbox sees and changes its rules, and created_by only says who made
// one. The CLI acts as an operator: the journal names the CLI (or the --as administrator); with
// --user the rule is made in that user's name (its author) and the journal says so
// (details.onBehalfOf). Running the rules on mail already in the inbox needs the backend's IMAP
// connections: the CLI queues it (cli/effects.js).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ruleId = (value) => {
  if (!UUID.test(String(value))) throw new UsageError('<id> must be a rule ID from "rule list"');
  return value;
};

// A rule as the API answers it, back into the body PUT /api/rules/:id takes.
const bodyOf = (rule) => ({
  name: rule.name,
  accountId: rule.account_id,
  conditionLogic: rule.condition_logic,
  conditions: rule.conditions,
  actions: rule.actions,
  enabled: rule.enabled,
  stopProcessing: rule.stop_processing,
});

const conditionText = (c) => `${c.field === 'header' ? `header ${c.headerName}` : c.field} ${c.operator ?? ''} ${c.value ?? ''}`.replace(/\s+/g, ' ').trim();
const actionText = (a) => (a.value ? `${a.type} ${a.value}` : a.type);

function ruleLines(rule) {
  return keyValues([
    ['id', rule.id],
    ['name', rule.name],
    ['mailbox', rule.account_id],
    ['enabled', rule.enabled],
    ['order', rule.priority],
    ['match', rule.condition_logic === 'OR' ? 'any condition' : 'all conditions'],
    ['conditions', (rule.conditions ?? []).map(conditionText)],
    ['actions', (rule.actions ?? []).map(actionText)],
    ['stop processing', rule.stop_processing],
    ['author', rule.created_by_name],
    ['created', fmtDate(rule.created_at)],
  ]);
}

const mailboxId = async (ref) => unwrap(await findAccount(ref), ACCOUNT_ERRORS).account.id;

// The --user of a command: { id, email } of the user the rule is made for.
async function author(ctx) {
  if (ctx.flags.user === undefined) return null;
  const { user } = unwrap(await findUser(ctx.flags.user), ADMIN_USER_ERRORS);
  return { id: user.id, email: user.email ?? user.username };
}

// The rule's body as the API takes it: a JSON file (--file), or stdin (--file - or no --file).
async function readBody(ctx) {
  const path = ctx.flags.file;
  let text;
  if (path === undefined || path === '-') {
    if (ctx.stdinIsTerminal) ctx.note('paste the rule as JSON, then press Ctrl-D');
    text = await ctx.readStdin();
  } else {
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      throw new UsageError(`cannot read ${path}: ${err.code ?? err.message}`);
    }
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UsageError('the rule must be a JSON object, as POST /api/rules takes it');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UsageError('the rule must be a JSON object, as POST /api/rules takes it');
  if (ctx.flags.account !== undefined) body.accountId = await mailboxId(ctx.flags.account);
  return body;
}

const BODY_HELP = [
  'The rule is a JSON object, as the panel sends it to the API:',
  '  {"name": "Invoices", "accountId": "<MAILBOX_ID>", "conditionLogic": "AND",',
  '   "conditions": [{"field": "subject", "operator": "contains", "value": "invoice"}],',
  '   "actions": [{"type": "move", "value": "Invoices"}], "enabled": true, "stopProcessing": false}',
  'Condition fields: from, to, subject, body, header (with headerName), has_attachment,',
  'read_status; operators: contains, not_contains, equals, starts_with, ends_with, regex.',
  'Actions: move (a folder), archive, delete, forward (one address), mark_read, star.',
  '--file PATH          read it from PATH; without --file (or with --file -) from stdin',
  '--account MAILBOX    the rule\'s mailbox by address or ID, in place of accountId',
  '--user EMAIL         make the change in this user\'s name: the rule\'s author on create, and',
  '                     details.onBehalfOf in the journal',
];

const list = {
  name: 'list',
  summary: 'the rules in the order they run, with mailbox, author and actions',
  usage: 'rule list [--account ADDRESS|ID] [--user EMAIL]',
  help: [
    '--account MAILBOX   only the rules of this mailbox',
    '--user EMAIL        only the rules this user made (rules are shared; this is their author)',
  ],
  flags: { account: 'string', user: 'string' },
  async run(ctx) {
    const accountId = ctx.flags.account === undefined ? null : await mailboxId(ctx.flags.account);
    const by = await author(ctx);
    const rules = (await listRules())
      .filter((rule) => !accountId || rule.account_id === accountId)
      .filter((rule) => !by || rule.created_by === by.id);
    const lines = table(rules, [
      { header: 'NAME', value: (r) => r.name || '(unnamed)' },
      { header: 'ENABLED', value: (r) => r.enabled },
      { header: 'MAILBOX', value: (r) => r.account_id },
      { header: 'ACTIONS', value: (r) => (r.actions ?? []).map(actionText) },
      { header: 'AUTHOR', value: (r) => r.created_by_name },
      { header: 'ID', value: (r) => r.id },
    ], { empty: '(no rules)' });
    return { data: rules, lines };
  },
};

const show = {
  name: 'show',
  summary: 'one rule: conditions, actions, order, author',
  usage: 'rule show <id>',
  positionals: ['id'],
  async run(ctx) {
    const { rule } = unwrap(await getRule(ruleId(ctx.args.id)), RULE_ERRORS);
    return { data: rule, lines: ruleLines(rule) };
  },
};

const create = {
  name: 'create',
  summary: 'add a rule at the end of the order, from JSON (a file or stdin)',
  usage: 'rule create [--file PATH] [--account ADDRESS|ID] [--user EMAIL]',
  journal: 'rule.created with the name, the action types and the forward address',
  help: [...BODY_HELP, 'The checks are the API\'s: conditions and actions arrays, a forward to one valid address, a', 'move to a folder the mailbox has.'],
  flags: { file: 'string', account: 'string', user: 'string' },
  async run(ctx) {
    const body = await readBody(ctx);
    const { rule } = unwrap(await createRule(body, ctx.actor, { author: await author(ctx) }), RULE_ERRORS);
    return { data: rule, lines: [`created the rule ${rule.id}`, ...ruleLines(rule)] };
  },
};

const set = {
  name: 'set',
  summary: 'replace a rule with JSON (a file or stdin): the whole rule, as the panel saves it',
  usage: 'rule set <id> [--file PATH] [--account ADDRESS|ID] [--user EMAIL]',
  journal: 'rule.updated with the old forward address',
  help: [
    ...BODY_HELP,
    'The JSON is the whole rule, as PUT /api/rules/:id takes it: a field left out takes the API\'s',
    'default (enabled true, conditionLogic AND, no name), not the old value. "rule show <id> --json"',
    'prints the current rule to start from (account_id, condition_logic, stop_processing there are',
    'accountId, conditionLogic, stopProcessing here).',
  ],
  positionals: ['id'],
  flags: { file: 'string', account: 'string', user: 'string' },
  async run(ctx) {
    const id = ruleId(ctx.args.id);
    const body = await readBody(ctx);
    const { rule } = unwrap(await updateRule(id, body, ctx.actor, { author: await author(ctx) }), RULE_ERRORS);
    return { data: rule, lines: [`updated the rule ${rule.id}`, ...ruleLines(rule)] };
  },
};

function toggle(enabled) {
  return {
    name: enabled ? 'enable' : 'disable',
    summary: enabled ? 'turn a rule on' : 'turn a rule off: it stays, but no longer runs',
    usage: `rule ${enabled ? 'enable' : 'disable'} <id> [--user EMAIL]`,
    journal: 'rule.updated (the panel saves the whole rule with the switch changed)',
    positionals: ['id'],
    flags: { user: 'string' },
    async run(ctx) {
      const { rule: current } = unwrap(await getRule(ruleId(ctx.args.id)), RULE_ERRORS);
      if (current.enabled === enabled) {
        return { data: current, lines: [`the rule ${current.id} is already ${enabled ? 'enabled' : 'disabled'}`] };
      }
      const { rule } = unwrap(await updateRule(current.id, { ...bodyOf(current), enabled }, ctx.actor, { author: await author(ctx) }), RULE_ERRORS);
      return { data: rule, lines: [`${enabled ? 'enabled' : 'disabled'} the rule ${rule.id}${rule.name ? ` (${rule.name})` : ''}`] };
    },
  };
}

const remove = {
  name: 'delete',
  summary: 'delete a rule',
  usage: 'rule delete <id> [--user EMAIL]',
  journal: 'rule.deleted',
  help: ['Asks for confirmation (--yes answers it).'],
  positionals: ['id'],
  flags: { user: 'string' },
  async run(ctx) {
    const { rule } = unwrap(await getRule(ruleId(ctx.args.id)), RULE_ERRORS);
    await confirm(ctx, `Delete the rule ${rule.name ? `"${rule.name}" ` : ''}(${rule.id})?`);
    unwrap(await deleteRule(rule.id, ctx.actor, { author: await author(ctx) }), RULE_ERRORS);
    return { data: { ok: true }, lines: [`deleted the rule ${rule.id}`] };
  },
};

const runRules = {
  name: 'run',
  summary: 'run the enabled rules on the mail already in a mailbox\'s inbox (or every mailbox\'s)',
  usage: 'rule run (--account ADDRESS|ID | --all)',
  journal: 'rule.run per mailbox, with the rules it runs, written by the backend when the run starts',
  help: [
    'As the panel\'s "Run rules on inbox": every enabled rule of the mailbox, not one rule. The',
    'rules move, delete and forward letters already received, so it asks for confirmation (--yes).',
    'The backend runs it in the background (a queued job); a mailbox it is already sweeping is left',
    'to that run. The outcome is in the backend\'s log.',
  ],
  flags: { account: 'string', all: 'boolean' },
  async run(ctx) {
    if (!!ctx.flags.all === (ctx.flags.account !== undefined)) throw new UsageError('give --account MAILBOX or --all');
    const accountId = ctx.flags.all ? null : await mailboxId(ctx.flags.account);
    const { accountIds } = unwrap(await rulesRunTargets(accountId), RULE_ERRORS);
    if (!accountIds.length) throw new CliError('account_not_found', 'There are no mailboxes');
    await confirm(ctx, `Run the enabled rules on the inbox of ${ctx.flags.all ? `all ${accountIds.length} mailboxes` : ctx.flags.account}? They act on mail already received.`);
    // rule.run is journaled by the backend once it claims the mailboxes (not for a mailbox it skips).
    const queued = await queueEffects(ctx, { runRules: accountIds, runRulesAll: !accountId });
    return { data: { ok: true, started: true, job: queued.job }, lines: queued.lines.length ? queued.lines : [fmtValue(queued.job)] };
  },
};

export default {
  name: 'rule',
  summary: 'inbox rules: list, show, create, set, enable, disable, delete, run',
  commands: [list, show, create, set, toggle(true), toggle(false), remove, runRules],
};
