import { CliError, nodeAction, unwrap } from '../common.js';
import { EXIT, UsageError } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import { getMailbox, getMailNodeConfig, parseHostName } from '../../services/mailNode/mailcow.js';
import {
  MAILBOX_ERRORS, cancelMailboxDeletion, createNodeMailbox, findNodeMailbox, listNodeMailboxes,
  onOtherMailHost, requestMailboxDeletion, setNodeMailboxNames,
} from '../../services/mailNode/mailboxActions.js';
import { listAliases } from '../../services/accountAliases.js';

// mailexpert mailbox ...: the mail node's mailboxes (services/mailNode/mailboxActions.js, the same
// actions as the panel's screens). A mailbox is named by its address or its ID.

const NAME_FLAGS = Object.freeze({
  name: 'string', 'sender-name': 'string', 'second-sender-name': 'string',
});
const NAME_ALIASES = Object.freeze({ ru: 'sender-name', en: 'second-sender-name' });
const NAME_HELP = [
  '--name NAME                 the mailbox\'s name in the panel (defaults to the address on create)',
  '--sender-name NAME          the sender name (alias --ru), for instance in Cyrillic',
  '--second-sender-name NAME   a second sender name with the same address (alias --en), for instance',
  '                            in Latin letters; "" removes it. Another address is always another',
  '                            mailbox (D-16): no command makes an alias with a different address',
];

const MB = 1024 * 1024;

// The account row as the CLI shows it: nothing secret, the names and the pending deletion.
function accountView(account, aliases = []) {
  return {
    id: account.id,
    email: account.email_address,
    name: account.name,
    senderName: account.sender_name ?? null,
    secondSenderNames: aliases.map((alias) => alias.name),
    enabled: account.enabled,
    imapHost: account.imap_host,
    addedAt: account.created_at ?? null,
    deletion: account.delete_after ? {
      deleteAfter: account.delete_after,
      requestedAt: account.deletion_requested_at ?? null,
      requestedBy: account.deletion_requested_by_email ?? null,
      reason: account.deletion_reason ?? null,
      lastError: account.deletion_last_error ?? null,
    } : null,
  };
}

function viewLines(view) {
  return keyValues([
    ['address', view.email],
    ['id', view.id],
    ['name', view.name],
    ['sender name', view.senderName],
    ['second sender names', view.secondSenderNames],
    ['deletion', view.deletion ? `on ${fmtDate(view.deletion.deleteAfter)} (asked by ${view.deletion.requestedBy ?? '-'})` : 'none'],
    ['deletion reason', view.deletion ? view.deletion.reason : undefined],
    ['deletion error', view.deletion?.lastError ? view.deletion.lastError : undefined],
  ]);
}

async function mailboxRef(ref) {
  return unwrap(await findNodeMailbox(ref), MAILBOX_ERRORS).account;
}

const list = {
  name: 'list',
  summary: 'list the node mailboxes, with quota, usage, deactivation and pending deletions',
  usage: 'mailbox list [--domain DOMAIN]',
  flags: { domain: 'string' },
  async run(ctx) {
    let domain = null;
    if (ctx.flags.domain !== undefined) {
      domain = parseHostName(ctx.flags.domain);
      if (!domain) throw new UsageError('--domain must be a domain name such as example.com');
    }
    const result = unwrap(await nodeAction(() => listNodeMailboxes({ details: true })), MAILBOX_ERRORS);
    const mailboxes = domain
      ? result.mailboxes.filter((m) => m.email.toLowerCase().endsWith(`@${domain}`))
      : result.mailboxes;
    const data = { disk: result.disk, mailboxes };
    const lines = table(mailboxes, [
      { header: 'ADDRESS', value: (m) => m.email },
      { header: 'ON NODE', value: (m) => (m.onNode ? (m.active ? 'active' : 'inactive') : 'missing') },
      { header: 'QUOTA MB', value: (m) => m.quotaMb },
      { header: 'USED MB', value: (m) => (m.usedBytes == null ? null : Math.round(m.usedBytes / MB)) },
      { header: 'SEND LIMIT', value: (m) => { const l = m.rateLimitOverride ?? m.rateLimitDefault; return l ? `${l.value}/${l.frame}${m.rateLimitOverride ? ' (own)' : ''}` : null; } },
      { header: 'DEACTIVATED', value: (m) => (m.deactivatedAt ? fmtDate(m.deactivatedAt) : null) },
      { header: 'DELETION', value: (m) => (m.deleteAfter ? fmtDate(m.deleteAfter) : null) },
      { header: 'SENDER NAME', value: (m) => m.senderName },
    ], { empty: domain ? `no node mailboxes on ${domain}` : 'no node mailboxes' });
    if (result.disk?.error) lines.push('', `disk: not read (${result.disk.code})`);
    else if (result.disk) lines.push('', `disk: ${result.disk.usedPercent}% used${result.disk.warn ? ' (warning)' : ''}`);
    return { data, lines };
  },
};

const show = {
  name: 'show',
  summary: 'show one mailbox: names, the node\'s view of it and a pending deletion',
  usage: 'mailbox show <address|id>',
  positionals: ['mailbox'],
  async run(ctx) {
    const account = await mailboxRef(ctx.args.mailbox);
    const view = accountView(account, await listAliases(account.id));
    // The node's view of the mailbox; a node that does not answer is shown, not an error.
    const cfg = await getMailNodeConfig();
    let node;
    if (!cfg) node = { error: 'mail_node_not_configured' };
    else if (onOtherMailHost(account, cfg)) node = { error: 'mail_node_host_mismatch' };
    else {
      node = await getMailbox(cfg, account.email_address).then(
        (m) => (m ? { active: m.active, quotaMb: m.quotaMb, usedBytes: m.usedBytes, rateLimit: m.rateLimit ?? null } : { error: 'mailbox_not_on_node' }),
        (err) => ({ error: err.code || 'mail_node_failed', message: err.message }),
      );
    }
    const data = { ...view, node };
    const lines = [...viewLines(view), ...keyValues([
      ['on node', node.error ? `no (${node.error})` : (node.active ? 'active' : 'inactive')],
      ['quota MB', node.error ? undefined : node.quotaMb],
      ['used MB', node.error || node.usedBytes == null ? undefined : Math.round(node.usedBytes / MB)],
    ])];
    return { data, lines };
  },
};

function namesInput(flags) {
  return { name: flags.name, senderName: flags['sender-name'], senderNameAlt: flags['second-sender-name'] };
}

const create = {
  name: 'create',
  journal: 'mailbox.added, as the panel',
  summary: 'create a mailbox on the node (its domain must have finished onboarding)',
  usage: 'mailbox create <local@domain> [--name NAME] [--sender-name NAME] [--second-sender-name NAME]',
  help: [
    'The panel picks the host, the ports and a password only MailExpert knows. The backend',
    'connects the new mailbox within 90 seconds (its health check).',
    ...NAME_HELP,
  ],
  flags: NAME_FLAGS,
  aliases: NAME_ALIASES,
  positionals: ['address'],
  async run(ctx) {
    const address = String(ctx.args.address);
    const at = address.lastIndexOf('@');
    if (at <= 0 || at === address.length - 1) throw new UsageError('<address> must be a full address such as name@example.com');
    const result = unwrap(await nodeAction(() => createNodeMailbox({
      localPart: address.slice(0, at), domain: address.slice(at + 1), ...namesInput(ctx.flags),
    }, ctx.actor)), MAILBOX_ERRORS);
    const view = { ...accountView(result.account, result.aliases), tenantPending: result.tenantPending };
    const lines = [`created ${view.email}`, ...viewLines(view)];
    if (result.tenantPending) lines.push('note: the domain is Authoritative; EOP accepts mail for the address once the tenant has its recipient');
    return { data: view, lines };
  },
};

const setNames = {
  name: 'set-names',
  journal: 'none: the panel does not journal names either',
  summary: 'rename a mailbox or change its sender names',
  usage: 'mailbox set-names <address|id> [--name NAME] [--sender-name NAME] [--second-sender-name NAME]',
  help: NAME_HELP,
  flags: NAME_FLAGS,
  aliases: NAME_ALIASES,
  positionals: ['mailbox'],
  async run(ctx) {
    const input = namesInput(ctx.flags);
    if (Object.values(input).every((value) => value === undefined)) {
      throw new UsageError('nothing to change: give --name, --sender-name or --second-sender-name');
    }
    const result = unwrap(await setNodeMailboxNames(ctx.args.mailbox, input), MAILBOX_ERRORS);
    const view = accountView(result.account, result.aliases);
    return { data: view, lines: [`updated ${view.email}`, ...viewLines(view)] };
  },
};

const requestDelete = {
  name: 'delete',
  journal: 'mailbox.deletion_requested with the reason',
  summary: 'ask to delete a mailbox with all its mail after the waiting days (D-14)',
  usage: 'mailbox delete <address|id> --reason TEXT [--confirm-address ADDRESS]',
  help: [
    'As in the panel: the mailbox keeps working for the days set in the mail node settings, then',
    'the deletion job deletes it on the node with all its mail. Cancel it before with',
    '"mailbox cancel-deletion". The reason is required and stays in the journal.',
    'The mailbox\'s full address must be typed to confirm: at the prompt in a terminal, or with',
    '--confirm-address. --yes does not replace it.',
  ],
  flags: { reason: 'string', 'confirm-address': 'string' },
  positionals: ['mailbox'],
  async run(ctx) {
    if (ctx.flags.reason === undefined) throw new UsageError('--reason is required: say why the mailbox is deleted');
    const account = await mailboxRef(ctx.args.mailbox);
    let typed = ctx.flags['confirm-address'];
    if (typed === undefined) {
      if (!ctx.interactive) {
        throw new CliError('confirmation_required', 'Type the mailbox\'s address with --confirm-address to confirm', { exit: EXIT.usage });
      }
      typed = await ctx.ask(`The mailbox ${account.email_address} and all its mail will be deleted after the waiting days.\nType its full address to confirm: `);
    }
    const result = unwrap(await nodeAction(() => requestMailboxDeletion({ accountId: account.id, email: typed, reason: ctx.flags.reason }, ctx.actor)), MAILBOX_ERRORS);
    const view = accountView(result.account, await listAliases(account.id));
    return { data: view, lines: [`deletion of ${view.email} asked for: it goes on ${fmtDate(view.deletion?.deleteAfter)}`] };
  },
};

const cancelDelete = {
  name: 'cancel-deletion',
  journal: 'mailbox.deletion_cancelled',
  summary: 'cancel a pending deletion: the mailbox stays as it is',
  usage: 'mailbox cancel-deletion <address|id>',
  positionals: ['mailbox'],
  async run(ctx) {
    const account = await mailboxRef(ctx.args.mailbox);
    const result = unwrap(await nodeAction(() => cancelMailboxDeletion({ accountId: account.id }, ctx.actor)), MAILBOX_ERRORS);
    const view = accountView(result.account, await listAliases(account.id));
    return { data: view, lines: [`deletion of ${view.email} cancelled`] };
  },
};

export default {
  name: 'mailbox',
  summary: 'the mail node\'s mailboxes: list, show, create, names, deletion',
  commands: [list, show, create, setNames, requestDelete, cancelDelete],
};
