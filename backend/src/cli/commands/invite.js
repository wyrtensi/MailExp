import { CliError, confirm, unwrap } from '../common.js';
import { EXIT, UsageError, parseCount } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import { INVITE_ERRORS, createInvite, listInvites, revokeInvite } from '../../services/admin/invites.js';

// mailexpert invite ...: registration invites (services/admin/invites.js, the admin screen's
// invites and /api/admin/invites): the same checks and the same letter through the system SMTP
// ("system-email"). Not journaled, by the screen or the CLI.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function state(invite, now = Date.now()) {
  if (invite.used_at) return `used ${fmtDate(invite.used_at)}${invite.used_by_username ? ` by ${invite.used_by_username}` : ''}`;
  if (new Date(invite.expires_at).getTime() <= now) return 'expired';
  return 'open';
}

const list = {
  name: 'list',
  summary: 'the invites, newest first, with their state',
  usage: 'invite list [--limit N] [--offset N]',
  help: [
    '--limit N    at most N invites (default 100, at most 200)',
    '--offset N   skip the first N',
    'The human list leaves the token out (it is the registration link\'s secret); --json answers',
    'what the API answers, the token included.',
  ],
  flags: { limit: 'string', offset: 'string' },
  async run(ctx) {
    const limit = parseCount(ctx.flags.limit, { name: 'limit', min: 1, max: 200, fallback: 100 });
    const offset = parseCount(ctx.flags.offset, { name: 'offset', min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
    const data = await listInvites({ limit, offset });
    const now = Date.now();
    const lines = table(data.invites, [
      { header: 'EMAIL', value: (i) => i.email },
      { header: 'STATE', value: (i) => state(i, now) },
      { header: 'CREATED', value: (i) => fmtDate(i.created_at) },
      { header: 'EXPIRES', value: (i) => fmtDate(i.expires_at) },
      { header: 'ID', value: (i) => i.id },
    ], { empty: '(no invites)' });
    if (data.total > offset + data.invites.length) lines.push(`(${data.invites.length} of ${data.total}: --offset ${offset + data.invites.length} for more)`);
    return { data, lines };
  },
};

const create = {
  name: 'create',
  summary: 'invite an email: a registration link valid for 7 days, sent through the system SMTP',
  usage: 'invite create <email> --as ADMIN_EMAIL',
  help: [
    'An invite is made by an administrator: --as names them (the panel keeps who invited).',
    'The link is printed; the letter goes out only when the system SMTP is set ("system-email',
    'set"), else "email: not sent" and the link is to be passed on by hand. APP_URL must be set.',
    'Not journaled, as the screen\'s invites are not.',
  ],
  positionals: ['email'],
  async run(ctx) {
    if (!ctx.actor?.userId) {
      throw new CliError('admin_required', 'An invite is made by an administrator: give --as with their email', { exit: EXIT.usage });
    }
    const result = unwrap(await createInvite(ctx.args.email, ctx.actor.userId), INVITE_ERRORS);
    const data = { ok: true, inviteUrl: result.inviteUrl, emailSent: result.emailSent, emailError: result.emailError };
    const email = result.emailSent ? 'sent' : `not sent${result.emailError ? ` (${result.emailError})` : ' (no system SMTP)'}`;
    return { data, lines: [`invited ${String(ctx.args.email).trim().toLowerCase()}`, ...keyValues([['link', result.inviteUrl], ['email', email]])] };
  },
};

const revoke = {
  name: 'revoke',
  summary: 'revoke an invite: its link no longer registers anyone',
  usage: 'invite revoke <id>',
  help: ['Asks for confirmation (--yes answers it). The ID is in "invite list".'],
  positionals: ['id'],
  async run(ctx) {
    if (!UUID.test(String(ctx.args.id))) throw new UsageError('<id> must be an invite ID from "invite list"');
    await confirm(ctx, `Revoke the invite ${ctx.args.id}?`);
    const result = await revokeInvite(ctx.args.id);
    if (!result.deleted) throw new CliError('not_found', INVITE_ERRORS.not_found[1]);
    return { data: { ok: true }, lines: [`revoked the invite ${ctx.args.id}`] };
  },
};

export default {
  name: 'invite',
  summary: 'registration invites: list, create, revoke',
  commands: [list, create, revoke],
};
