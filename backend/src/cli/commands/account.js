import { CliError, unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import { queueEffects, readSecret } from '../effects.js';
import {
  ACCOUNT_ERRORS, createManualAccount, findAccount, listAccounts, safeAccount, updateAccountConnection,
} from '../../services/accounts/manualAccounts.js';
import { ADMIN_USER_ERRORS, findUser } from '../../services/admin/users.js';

// mailexpert account ...: every mailbox of the panel, and the ones an administrator sets up by hand
// over IMAP/SMTP (services/accounts/manualAccounts.js, POST /api/accounts without kind 'domain' and
// the server fields of PUT /api/accounts/:id): the same checks of the admin's connection policy
// (private hosts, nonstandard ports), the same journal. A mailbox on the mail node is created with
// "mailbox create"; its servers belong to the node settings. Passwords are read from stdin only.
// Connecting the mailbox is the backend's: the CLI queues it (cli/effects.js), and the backend's
// health check reports a mailbox that cannot connect (its sync error in "account list").

const TLS_MODES = Object.freeze(['STARTTLS', 'SSL', 'none']);

function kind(account) {
  if (account.mail_node) return 'node';
  if (account.oauth_provider) return account.oauth_provider;
  return account.protocol ?? 'imap';
}

function accountLines(account) {
  return keyValues([
    ['address', account.email_address],
    ['id', account.id],
    ['name', account.name],
    ['kind', kind(account)],
    ['enabled', account.enabled !== false],
    ['imap', account.imap_host ? `${account.imap_host}:${account.imap_port}${account.imap_skip_tls_verify ? ' (certificate not checked)' : ''}` : null],
    ['smtp', account.smtp_host ? `${account.smtp_host}:${account.smtp_port} ${account.smtp_tls ?? ''}`.trim() : null],
    ['login', account.auth_user],
    ['smtp login', account.smtp_auth_user ?? undefined],
  ]);
}

function port(name, value) {
  if (value === undefined) return undefined;
  if (!/^\d{1,5}$/.test(value)) throw new UsageError(`--${name} must be a port number`);
  return Number(value);
}

function tlsMode(value) {
  if (value === undefined) return undefined;
  if (!TLS_MODES.includes(value)) throw new UsageError(`--smtp-tls takes ${TLS_MODES.join(', ')}`);
  return value;
}

const list = {
  name: 'list',
  summary: 'the mailboxes: kind (manual, OAuth, node), servers, state, who added them',
  usage: 'account list [--user EMAIL]',
  help: [
    '--user EMAIL   only the mailboxes this user added. Mailboxes are shared by the team: who',
    '               added one is all that ties it to a user.',
  ],
  flags: { user: 'string' },
  async run(ctx) {
    const addedBy = ctx.flags.user === undefined ? null : unwrap(await findUser(ctx.flags.user), ADMIN_USER_ERRORS).user.id;
    const data = await listAccounts({ addedBy });
    const lines = table(data.accounts, [
      { header: 'ADDRESS', value: (a) => a.email_address },
      { header: 'KIND', value: kind },
      { header: 'ENABLED', value: (a) => a.enabled !== false },
      { header: 'HEALTH', value: (a) => a.health },
      { header: 'IMAP', value: (a) => (a.imap_host ? `${a.imap_host}:${a.imap_port}` : null) },
      { header: 'LAST SYNC', value: (a) => fmtDate(a.last_sync) },
      { header: 'ADDED BY', value: (a) => a.added_by_name },
      { header: 'ID', value: (a) => a.id },
    ], { empty: '(no mailboxes)' });
    return { data, lines };
  },
};

const SERVER_HELP = [
  '--imap-host HOST, --imap-port N     the IMAP server (port 993 or 143; 993 means TLS)',
  '--smtp-host HOST, --smtp-port N     the SMTP server (port 587 or 465)',
  '--smtp-tls STARTTLS|SSL|none        how SMTP is secured',
  '--login LOGIN                       the IMAP (and, without --smtp-login, SMTP) login',
  '--smtp-login LOGIN                  a separate SMTP login',
  '--skip-tls-verify                   do not check the IMAP certificate (only honoured while the',
  '                                    "allow insecure TLS" setting is on)',
  'Hosts pass the "allow private hosts" setting and ports the "allow nonstandard ports" one, as',
  'in the panel (servers_refused, with the API\'s message).',
];

const create = {
  name: 'create',
  summary: 'add a mailbox set up by hand over IMAP/SMTP; the password is read from stdin',
  usage: 'account create <address> --imap-host HOST --smtp-host HOST [--imap-port N] [--smtp-port N] [--smtp-tls MODE] [--login LOGIN] [--name NAME] [--sender-name NAME] [--skip-tls-verify] < password-file',
  journal: 'mailbox.added',
  help: [
    'The IMAP password is read from stdin only (a file or a pipe; in a terminal, paste it and press',
    'Ctrl-D) and stored encrypted, spaces kept and one final line end dropped; SMTP signs in with',
    'the same password. A separate SMTP password:',
    '"account set-connection <address> --smtp-login LOGIN --smtp-password-stdin" afterwards.',
    'Defaults as the panel\'s form: ports 993 and 587, STARTTLS, name and login the address.',
    ...SERVER_HELP,
    'The panel does not test the connection on save: the backend connects the mailbox (a queued',
    'job) and "account list" shows its health and sync error.',
  ],
  positionals: ['address'],
  flags: {
    'imap-host': 'string', 'imap-port': 'string', 'smtp-host': 'string', 'smtp-port': 'string', 'smtp-tls': 'string',
    login: 'string', name: 'string', 'sender-name': 'string', 'skip-tls-verify': 'boolean',
  },
  async run(ctx) {
    const { flags } = ctx;
    const address = String(ctx.args.address).trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new UsageError('<address> must be a full address such as team@example.com');
    if (!flags['imap-host'] || !flags['smtp-host']) throw new UsageError('--imap-host and --smtp-host are required');
    const body = {
      name: flags.name ?? address,
      sender_name: flags['sender-name'] ?? null,
      email_address: address,
      protocol: 'imap',
      imap_host: flags['imap-host'],
      imap_port: port('imap-port', flags['imap-port']) ?? 993,
      imap_skip_tls_verify: !!flags['skip-tls-verify'],
      smtp_host: flags['smtp-host'],
      smtp_port: port('smtp-port', flags['smtp-port']) ?? 587,
      smtp_tls: tlsMode(flags['smtp-tls']) ?? 'STARTTLS',
      auth_user: flags.login ?? address,
    };
    body.auth_pass = await readSecret(ctx, 'IMAP password', { exact: true });
    if (!body.auth_pass) throw new CliError('password_missing', 'No password on stdin');
    const { account } = unwrap(await createManualAccount(body, ctx.actor), ACCOUNT_ERRORS);
    const queued = await queueEffects(ctx, { reconnect: [account.id] });
    return {
      data: { account: safeAccount(account), job: queued.job },
      lines: [`added ${account.email_address}`, ...accountLines(account), ...queued.lines],
    };
  },
};

const setConnection = {
  name: 'set-connection',
  summary: 'change where a mailbox connects and what it signs in with',
  usage: 'account set-connection <address|id> [--imap-host HOST] [--imap-port N] [--smtp-host HOST] [--smtp-port N] [--smtp-tls MODE] [--login LOGIN] [--smtp-login LOGIN] [--skip-tls-verify | --verify-tls] [--password-stdin | --smtp-password-stdin]',
  journal: 'mailbox.connection_changed with the names of the fields that changed (never values)',
  help: [
    'Changes the fields given, as an administrator\'s save of the mailbox\'s server settings.',
    ...SERVER_HELP,
    '--verify-tls                        check the IMAP certificate again',
    '--smtp-login ""                     SMTP signs in with the IMAP login again',
    '--password-stdin                    a new IMAP password from stdin',
    '--smtp-password-stdin               a new SMTP password from stdin (one of the two per run)',
    'Refused for a mailbox on the mail node (mail_node_connection_locked). A change of the IMAP',
    'side reconnects the running mailbox (a queued job); an SMTP change is used by the next send.',
  ],
  positionals: ['mailbox'],
  flags: {
    'imap-host': 'string', 'imap-port': 'string', 'smtp-host': 'string', 'smtp-port': 'string', 'smtp-tls': 'string',
    login: 'string', 'smtp-login': 'string', 'skip-tls-verify': 'boolean', 'verify-tls': 'boolean',
    'password-stdin': 'boolean', 'smtp-password-stdin': 'boolean',
  },
  async run(ctx) {
    const { flags } = ctx;
    if (flags['skip-tls-verify'] && flags['verify-tls']) throw new UsageError('--skip-tls-verify and --verify-tls exclude each other');
    if (flags['password-stdin'] && flags['smtp-password-stdin']) {
      throw new UsageError('stdin holds one password: give --password-stdin or --smtp-password-stdin, and run again for the other');
    }
    const updates = {
      imap_host: flags['imap-host'],
      imap_port: port('imap-port', flags['imap-port']),
      smtp_host: flags['smtp-host'],
      smtp_port: port('smtp-port', flags['smtp-port']),
      smtp_tls: tlsMode(flags['smtp-tls']),
      auth_user: flags.login,
      smtp_auth_user: flags['smtp-login'],
      imap_skip_tls_verify: flags['skip-tls-verify'] ? true : (flags['verify-tls'] ? false : undefined),
    };
    for (const key of Object.keys(updates)) if (updates[key] === undefined) delete updates[key];
    if (!Object.keys(updates).length && !flags['password-stdin'] && !flags['smtp-password-stdin']) {
      throw new UsageError('nothing to change: give a server, a port, a login or a password flag');
    }
    const { account: current } = unwrap(await findAccount(ctx.args.mailbox), ACCOUNT_ERRORS);
    if (flags['password-stdin'] || flags['smtp-password-stdin']) {
      const secret = await readSecret(ctx, flags['password-stdin'] ? 'IMAP password' : 'SMTP password', { exact: true });
      if (!secret) throw new CliError('password_missing', 'No password on stdin');
      updates[flags['password-stdin'] ? 'auth_pass' : 'smtp_auth_pass'] = secret;
    }
    const result = unwrap(await updateAccountConnection(current.id, updates, ctx.actor), ACCOUNT_ERRORS);
    const queued = await queueEffects(ctx, result.reconnect ? { reconnect: [current.id] } : {});
    return {
      data: { account: safeAccount(result.account), fields: result.fields, job: queued.job },
      lines: [
        result.fields.length ? `changed ${result.fields.join(', ')} of ${result.account.email_address}` : `nothing changed for ${result.account.email_address}`,
        ...accountLines(result.account), ...queued.lines,
      ],
    };
  },
};

export default {
  name: 'account',
  summary: 'the panel\'s mailboxes; manual IMAP/SMTP ones: list, create, set-connection',
  commands: [list, create, setConnection],
};
