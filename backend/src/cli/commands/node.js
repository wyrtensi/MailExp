import { confirm, nodeAction, refusal, unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import { MAIL_NODE_ERRORS } from '../../services/mailNode/errors.js';
import { nodeConfigView, saveNodeConfig } from '../../services/mailNode/settingsActions.js';
import { applyDomainNow } from '../../services/mailNode/domainActions.js';
import { applyNode, applyPrefilter } from '../../services/mailNode/nodeApply.js';

// mailexpert node ...: the mail node settings and applying the panel's settings to the node
// (services/mailNode/settingsActions.js, nodeApply.js; the "Mail node" screen). The API key is read
// from stdin only and never printed.

// The lines of an apply's items: those that changed or failed (the others are in place).
export function applyLines(items = [], prefix = '') {
  return items
    .filter((i) => i.status === 'changed' || i.status === 'failed' || i.status === 'pending')
    .map((i) => `${prefix}${i.item}${i.target ? ` ${i.target}` : ''}: ${i.status}${i.code ? ` (${i.code})` : ''}`);
}

function configLines(view) {
  return keyValues([
    ['configured', view.configured],
    ['mail host', view.mailHost],
    ['api key', view.configured ? 'set' : 'not set'],
    ['quota MB', view.quotaMb],
    ['delete after days', view.deleteAfterDays],
    ['disk ping url', view.diskPingUrl],
    ['panel addresses', view.panelIps],
    ['node address', view.nodeIp],
  ]);
}

const SET_FLAGS = Object.freeze({
  'mail-host': 'string', quota: 'string', 'delete-after-days': 'string', 'disk-ping-url': 'string',
  'panel-ips': 'string', 'node-ip': 'string', 'api-key-stdin': 'boolean',
});

const config = {
  name: 'config',
  summary: 'show the mail node settings, or change them (the API key from stdin only)',
  usage: 'node config show | node config set [--mail-host HOST] [--quota MB] [--delete-after-days N] [--disk-ping-url URL] [--panel-ips LIST] [--node-ip IP] [--api-key-stdin]',
  journal: 'mail_node.config_changed with the changed fields (never the key); mail_node.applied when the node settings change',
  help: [
    'show                       the settings; the API key only as "set" or "not set"',
    'set                        change the options given, keep the others:',
    '  --mail-host HOST         the mailcow host name; another host needs the key again',
    '  --quota MB               the quota of new mailboxes',
    '  --delete-after-days N    days a mailbox keeps working after its deletion is asked for',
    '  --disk-ping-url URL      the Healthchecks URL of the disk check; "" removes it',
    '  --panel-ips LIST         the panel\'s addresses for the node\'s fail2ban whitelist (comma-separated)',
    '  --node-ip IP             the node\'s public IPv4 address (kept with the EOP settings); "" removes it',
    '  --api-key-stdin          read a new mailcow API key from stdin (a file or a pipe; in a terminal,',
    '                           paste it and press Ctrl-D); it is never taken from an argument',
    'The node is asked with the settings before they are saved. A new host, key or panel address',
    'applies the panel\'s settings to the node; the command waits for it and prints what changed.',
  ],
  flags: SET_FLAGS,
  positionals: ['action'],
  async run(ctx) {
    const { action } = ctx.args;
    const given = Object.keys(SET_FLAGS).filter((flag) => ctx.flags[flag] !== undefined);
    if (action === 'show') {
      if (given.length) throw new UsageError(`node config show takes no --${given[0]}`);
      const view = await nodeConfigView();
      return { data: view, lines: configLines(view) };
    }
    if (action !== 'set') throw new UsageError('<action> must be show or set');
    if (!given.length) throw new UsageError('nothing to change: give an option such as --quota, or --api-key-stdin');
    const current = await nodeConfigView();
    const { flags } = ctx;
    let apiKey;
    if (flags['api-key-stdin']) {
      if (ctx.stdinIsTerminal) ctx.note('paste the API key, then press Ctrl-D');
      apiKey = String(await ctx.readStdin()).trim();
      if (!apiKey) throw refusal(MAIL_NODE_ERRORS, 'api_key_required');
    }
    // The whole form, as the screen sends it: what is not given is the stored value.
    const body = {
      mailHost: flags['mail-host'] ?? current.mailHost,
      quotaMb: flags.quota ?? current.quotaMb,
      deleteAfterDays: flags['delete-after-days'] ?? current.deleteAfterDays,
      diskPingUrl: flags['disk-ping-url'] ?? current.diskPingUrl,
      ...(flags['panel-ips'] !== undefined ? { panelIps: flags['panel-ips'] } : {}),
      ...(flags['node-ip'] !== undefined ? { nodeIp: flags['node-ip'] } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    };
    const result = unwrap(await nodeAction(() => saveNodeConfig(body, ctx.actor, { background: false })), MAIL_NODE_ERRORS);
    const lines = ['saved', ...configLines(await nodeConfigView())];
    if (result.applying && result.apply) lines.push('node settings applied', ...applyLines([...result.apply.node, ...result.apply.domains.flatMap((d) => d.items)], '  '));
    else if (result.applying) lines.push('node settings were not applied: run "mailexpert node apply" to see why');
    return { data: result, lines };
  },
};

const apply = {
  name: 'apply',
  summary: 'apply the panel\'s settings to the node, to one domain, or write the spam filing rule',
  usage: 'node apply [--domain DOMAIN [--confirm-dkim-delete]] | node apply --prefilter',
  journal: 'mail_node.applied with what changed or failed (nothing when everything was in place)',
  help: [
    '(no option)            the node and every domain the panel knows: relayhost, TLS policy, DKIM,',
    '                       send limits, fail2ban whitelist; the spam filing rule is only checked',
    '--domain DOMAIN        one domain only',
    '--confirm-dkim-delete  with --domain: let it delete mailcow\'s DKIM key of a domain the tenant',
    '                       signs for',
    '--prefilter            write the spam filing rule (R-11); it restarts Dovecot on the node, which',
    '                       drops every IMAP session, so it asks first',
    'Exit 0 even when an item failed: the failed items are printed (and in --json).',
  ],
  flags: { domain: 'string', prefilter: 'boolean', 'confirm-dkim-delete': 'boolean' },
  async run(ctx) {
    const { domain, prefilter } = ctx.flags;
    if (prefilter && domain !== undefined) throw new UsageError('--prefilter and --domain exclude each other');
    if (ctx.flags['confirm-dkim-delete'] && domain === undefined) throw new UsageError('--confirm-dkim-delete needs --domain');
    const userId = ctx.actor?.userId ?? null;
    if (prefilter) {
      await confirm(ctx, 'Writing the spam filing rule restarts Dovecot on the node and drops every IMAP session. Write it?');
      const item = await nodeAction(() => applyPrefilter({ userId, actor: ctx.actor }));
      const lines = [`prefilter: ${item.status}${item.code ? ` (${item.code})` : ''}`];
      if (item.forwardingHosts) lines.push(`forwarding hosts: ${item.forwardingHosts.status}${item.forwardingHosts.code ? ` (${item.forwardingHosts.code})` : ''}`);
      return { data: item, lines };
    }
    if (domain !== undefined) {
      const result = unwrap(await nodeAction(() => applyDomainNow(domain, ctx.actor, { confirmDkimDelete: !!ctx.flags['confirm-dkim-delete'] })), MAIL_NODE_ERRORS);
      const changed = applyLines(result.items, '  ');
      return { data: result, lines: [`${result.domain}: applied at ${fmtDate(result.at)}`, ...(changed.length ? changed : ['  everything was in place'])] };
    }
    const result = await nodeAction(() => applyNode({ userId, actor: ctx.actor, trigger: 'manual' }));
    const lines = [`applied at ${fmtDate(result.at)}`, ...applyLines(result.node, '  node ')];
    lines.push(...table(result.domains, [
      { header: 'DOMAIN', value: (d) => d.domain },
      { header: 'CHANGED', value: (d) => d.items.filter((i) => i.status === 'changed').length },
      { header: 'FAILED', value: (d) => d.items.filter((i) => i.status === 'failed').map((i) => `${i.item}${i.code ? ` (${i.code})` : ''}`) },
    ], { empty: 'no domains' }));
    return { data: result, lines };
  },
};

export default {
  name: 'node',
  summary: 'the mail node settings and applying them to the node',
  commands: [config, apply],
};
