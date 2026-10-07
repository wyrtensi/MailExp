import { confirm, unwrap } from '../common.js';
import { UsageError, parseCount } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import { queueEffects } from '../effects.js';
import { mergeEffects } from '../../services/admin/adminEffects.js';
import {
  ADMIN_USER_ERRORS, createUser, deleteUser, disableUserTotp, findUser, listUsers, updateUser,
} from '../../services/admin/users.js';

// mailexpert user ...: the panel's users (services/admin/users.js, the admin screen's "Users" and
// /api/admin/users): the same checks (the last active admin stays, bootstrap admins are not
// changed here, an email is never taken twice) and the same journal. A user is named by email (or
// username). Signing a user out of their sessions and live sockets, the Access sync and the
// plugins' clean-up run in the backend: the CLI queues them (cli/effects.js).

const SIGN_OUT_NOTE = [
  'A user who loses their way in (disabled, or whose email is replaced) is signed out of every',
  'session and live socket by the backend (a queued job).',
];

function userLines(user) {
  return keyValues([
    ['id', user.id],
    ['username', user.username],
    ['email', user.email],
    ['admin', user.isAdmin],
    ['bootstrap admin', user.isBootstrapAdmin],
    ['2fa', user.totpEnabled],
    ['disabled', user.disabledAt ? fmtDate(user.disabledAt) : false],
    ['created', fmtDate(user.created_at)],
  ]);
}

const named = async (login) => unwrap(await findUser(login), ADMIN_USER_ERRORS).user;

const list = {
  name: 'list',
  summary: 'the users, oldest first',
  usage: 'user list [--limit N] [--offset N]',
  help: ['--limit N    at most N users (default 100, at most 200)', '--offset N   skip the first N'],
  flags: { limit: 'string', offset: 'string' },
  async run(ctx) {
    const limit = parseCount(ctx.flags.limit, { name: 'limit', min: 1, max: 200, fallback: 100 });
    const offset = parseCount(ctx.flags.offset, { name: 'offset', min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
    const data = await listUsers({ limit, offset });
    const lines = table(data.users, [
      { header: 'EMAIL', value: (u) => u.email },
      { header: 'USERNAME', value: (u) => u.username },
      { header: 'ADMIN', value: (u) => (u.isBootstrapAdmin ? 'bootstrap' : u.isAdmin) },
      { header: '2FA', value: (u) => u.totpEnabled },
      { header: 'DISABLED', value: (u) => (u.disabledAt ? fmtDate(u.disabledAt) : '') },
      { header: 'CREATED', value: (u) => fmtDate(u.created_at) },
    ], { empty: '(no users)' });
    if (data.total > offset + data.users.length) lines.push(`(${data.users.length} of ${data.total}: --offset ${offset + data.users.length} for more)`);
    return { data, lines };
  },
};

const show = {
  name: 'show',
  summary: 'one user',
  usage: 'user show <email>',
  positionals: ['email'],
  async run(ctx) {
    const user = await named(ctx.args.email);
    return { data: { user }, lines: userLines(user) };
  },
};

const create = {
  name: 'create',
  summary: 'approve an email: a new user, or the user whose username it is',
  usage: 'user create <email> [--admin]',
  journal: 'user.added, and user.admin_changed with --admin',
  help: [
    '--admin   make the user an administrator as well',
    'With AUTH_MODE=google, an approved email is what lets a person sign in.',
  ],
  positionals: ['email'],
  flags: { admin: 'boolean' },
  async run(ctx) {
    const created = unwrap(await createUser(ctx.args.email, ctx.actor), ADMIN_USER_ERRORS);
    let { user } = created;
    let { effects } = created;
    if (ctx.flags.admin) {
      const updated = unwrap(await updateUser(user.id, { isAdmin: true }, ctx.actor), ADMIN_USER_ERRORS);
      user = updated.user;
      effects = mergeEffects(effects, updated.effects);
    }
    const queued = await queueEffects(ctx, effects);
    return {
      data: { user, created: created.created, job: queued.job },
      lines: [`${created.created ? 'created' : 'approved the existing user'} ${user.email}`, ...userLines(user), ...queued.lines],
    };
  },
};

const set = {
  name: 'set',
  summary: 'make or unmake an administrator, disable or enable, replace the email',
  usage: 'user set <email> [--admin | --no-admin] [--disable | --enable] [--email NEW]',
  journal: 'user.admin_changed, user.disabled, user.enabled (what changed)',
  help: [
    '--admin, --no-admin     make the user an administrator, or not',
    '--disable, --enable     turn the user off (they cannot sign in), or on again',
    '--email NEW             replace the email; --email "" clears it',
    'Refused when it would leave no active administrator (last_admin), for an address from',
    'BOOTSTRAP_ADMIN_EMAILS (bootstrap_admin), and for the --as administrator\'s own admin status',
    'or account (self_change).',
    ...SIGN_OUT_NOTE,
  ],
  positionals: ['email'],
  flags: { admin: 'boolean', 'no-admin': 'boolean', disable: 'boolean', enable: 'boolean', email: 'string' },
  async run(ctx) {
    const { flags } = ctx;
    if (flags.admin && flags['no-admin']) throw new UsageError('--admin and --no-admin exclude each other');
    if (flags.disable && flags.enable) throw new UsageError('--disable and --enable exclude each other');
    const patch = {};
    if (flags.admin || flags['no-admin']) patch.isAdmin = !!flags.admin;
    if (flags.disable || flags.enable) patch.disabled = !!flags.disable;
    if (flags.email !== undefined) patch.email = flags.email;
    if (!Object.keys(patch).length) throw new UsageError('nothing to change: give --admin, --no-admin, --disable, --enable or --email');
    const current = await named(ctx.args.email);
    const result = unwrap(await updateUser(current.id, patch, ctx.actor), ADMIN_USER_ERRORS);
    const queued = await queueEffects(ctx, result.effects);
    return { data: { user: result.user, job: queued.job }, lines: [...userLines(result.user), ...queued.lines] };
  },
};

const remove = {
  name: 'delete',
  summary: 'delete a user and what is theirs',
  usage: 'user delete <email>',
  journal: 'user.deleted',
  help: [
    'Asks for confirmation (--yes answers it). Refused for the last active administrator, a',
    'bootstrap admin and the --as administrator. The backend then signs the user out and lets the',
    'plugins remove their data (a queued job).',
  ],
  positionals: ['email'],
  async run(ctx) {
    const user = await named(ctx.args.email);
    await confirm(ctx, `Delete the user ${user.email ?? user.username} and everything that is theirs?`);
    const result = unwrap(await deleteUser(user.id, ctx.actor), ADMIN_USER_ERRORS);
    const queued = await queueEffects(ctx, result.effects);
    return { data: { ok: true, job: queued.job }, lines: [`deleted ${user.email ?? user.username}`, ...queued.lines] };
  },
};

const totpReset = {
  name: 'totp-reset',
  summary: 'turn a user\'s 2FA off, for one who lost their device',
  usage: 'user totp-reset <email>',
  help: [
    'Asks for confirmation (--yes answers it). The user signs in with the password alone and',
    'enrols again where 2FA is required. Not for the --as administrator\'s own account. Not',
    'journaled, as the screen\'s button is not.',
  ],
  positionals: ['email'],
  async run(ctx) {
    const user = await named(ctx.args.email);
    await confirm(ctx, `Turn off 2FA for ${user.email ?? user.username}?`);
    unwrap(await disableUserTotp(user.id, ctx.actor), ADMIN_USER_ERRORS);
    return { data: { ok: true }, lines: [`2FA turned off for ${user.email ?? user.username}`] };
  },
};

export default {
  name: 'user',
  summary: 'the panel\'s users: list, approve, change, delete, reset 2FA',
  commands: [list, show, create, set, remove, totpReset],
};
