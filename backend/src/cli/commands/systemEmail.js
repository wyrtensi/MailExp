import { CliError, confirm, unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { keyValues } from '../output.js';
import { readSecret } from '../effects.js';
import {
  SYSTEM_EMAIL_ERRORS, getSystemEmail, removeSystemEmail, saveSystemEmail, testSystemEmail,
} from '../../services/admin/systemEmail.js';

// mailexpert system-email ...: the system SMTP that sends invites, sign-in codes and other system
// mail (services/admin/systemEmail.js, the admin screen's "System Email" and
// /api/admin/system-email): the same checks. The password is read from stdin only, stored
// encrypted and never printed. Not journaled, by the screen or the CLI.

const TLS_MODES = Object.freeze(['STARTTLS', 'SSL', 'none']);

function configLines(config) {
  if (!config) return ['(no system email: invites and system mail are not sent)'];
  return keyValues([
    ['host', config.host],
    ['port', config.port],
    ['tls', config.tls],
    ['user', config.user],
    ['password', config.pass ? 'set' : 'not set'],
    ['from name', config.fromName],
    ['from email', config.fromEmail],
  ]);
}

const show = {
  name: 'show',
  summary: 'the system SMTP: host, port, login, sender; whether a password is set (never its value)',
  usage: 'system-email show',
  async run() {
    const data = await getSystemEmail();
    return { data, lines: configLines(data.config) };
  },
};

const set = {
  name: 'set',
  summary: 'set the system SMTP; the password is read from stdin',
  usage: 'system-email set [--host HOST] [--port N] [--tls STARTTLS|SSL|none] [--user LOGIN] [--from-name NAME] [--from-email ADDRESS] [--password-stdin]',
  help: [
    'Changes the fields given; the others keep their stored values (the first save needs --host,',
    '--user and a password). Defaults as the screen\'s: port 587, tls STARTTLS, sender name',
    'MailExpert, sender address the login.',
    '--password-stdin   read the password from stdin (never an argument, never printed); without',
    '                   it the stored password stays',
    'The host passes the "Allow private / local hosts" policy (host_refused).',
    '"system-email test" checks the saved settings.',
  ],
  flags: {
    host: 'string', port: 'string', tls: 'string', user: 'string', 'from-name': 'string', 'from-email': 'string', 'password-stdin': 'boolean',
  },
  async run(ctx) {
    const { flags } = ctx;
    if (flags.port !== undefined && !/^\d{1,5}$/.test(flags.port)) throw new UsageError('--port must be a port number');
    if (flags.tls !== undefined && !TLS_MODES.includes(flags.tls)) throw new UsageError(`--tls takes ${TLS_MODES.join(', ')}`);
    const given = {
      host: flags.host, port: flags.port, tls: flags.tls, user: flags.user, fromName: flags['from-name'], fromEmail: flags['from-email'],
    };
    if (Object.values(given).every((value) => value === undefined) && !flags['password-stdin']) {
      throw new UsageError('nothing to change: give --host, --port, --tls, --user, --from-name, --from-email or --password-stdin');
    }
    // The screen sends the whole form; the CLI sends the stored config with the fields given.
    const { config: stored } = await getSystemEmail();
    const body = { ...(stored ?? {}), pass: undefined };
    for (const [key, value] of Object.entries(given)) if (value !== undefined) body[key] = value;
    if (flags['password-stdin']) {
      body.pass = await readSecret(ctx, 'SMTP password');
      if (!body.pass) throw new CliError('password_missing', 'No password on stdin');
    }
    unwrap(await saveSystemEmail(body), SYSTEM_EMAIL_ERRORS);
    const data = await getSystemEmail();
    return { data, lines: ['system email saved', ...configLines(data.config)] };
  },
};

const test = {
  name: 'test',
  summary: 'connect to the saved server and sign in, as the screen\'s test does; no letter is sent',
  usage: 'system-email test',
  help: ['Exit 1 with the server\'s answer when it refuses (smtp_failed).'],
  async run() {
    unwrap(await testSystemEmail(), SYSTEM_EMAIL_ERRORS);
    return { data: { ok: true }, lines: ['the SMTP server accepted the login'] };
  },
};

const remove = {
  name: 'remove',
  summary: 'remove the system SMTP: invites and system mail are not sent until it is set again',
  usage: 'system-email remove',
  help: ['Asks for confirmation (--yes answers it).'],
  async run(ctx) {
    await confirm(ctx, 'Remove the system email settings? Invites, sign-in codes and other system mail stop going out.');
    const result = await removeSystemEmail();
    return { data: { ok: true }, lines: [result.removed ? 'system email removed' : 'no system email was set'] };
  },
};

export default {
  name: 'system-email',
  summary: 'the system SMTP for invites and system mail: show, set, test, remove',
  commands: [show, set, test, remove],
};
