import { enqueueAdminEffects } from '../services/admin/adminEffects.js';

// The admin commands' (user, settings, sso, integration, account, rule) way to the backend's
// process: what a change still asks of it (sign-outs, the Access sync, the settings it keeps in
// memory) is queued as an admin_effects job, which the backend's job worker applies with the hooks
// the admin routes use (services/admin/adminEffects.js); so are connecting a mailbox and running
// rules on the inbox, which need the backend's IMAP connections. The CLI never applies them itself.

const NAMES = Object.freeze({
  auth_limits: 'sign-in limits reloaded',
  sync_intervals: 'mailbox sync intervals applied',
  categorization: 'categorization reloaded',
  connection_policy: 'connection policy reloaded',
  microsoft: 'Microsoft client reloaded',
});

export function describeEffects(effects) {
  const parts = [];
  if (effects.signOut?.length) parts.push('signed out of every session');
  if (effects.userDeleted?.length) parts.push('plugin data removed');
  for (const name of effects.reload ?? []) parts.push(NAMES[name] ?? name);
  if (effects.accessSync) parts.push('Cloudflare Access sync asked for');
  if (effects.reconnect?.length) parts.push(`${effects.reconnect.length === 1 ? 'mailbox' : `${effects.reconnect.length} mailboxes`} (re)connected`);
  if (effects.runRules?.length) parts.push(`rules run on the inbox of ${effects.runRules.length === 1 ? 'the mailbox' : `${effects.runRules.length} mailboxes`}`);
  return parts.join(', ');
}

// Queues the effects: { job: { id, status } | null, lines } for the command's answer.
export async function queueEffects(ctx, effects) {
  const job = await enqueueAdminEffects(effects, ctx.actor);
  if (!job) return { job: null, lines: [] };
  return {
    job: { id: job.id, kind: job.kind, status: job.status },
    lines: [`backend: job ${job.id} queued (${describeEffects(effects)})`],
  };
}

// A secret a command takes, from stdin only: never an argument, never printed. Keys and tokens
// are trimmed; a password (exact: true) keeps its spaces and loses only one line end, which a file
// or echo adds.
export async function readSecret(ctx, what, { exact = false } = {}) {
  if (ctx.stdinIsTerminal) ctx.note(`paste the ${what}, then press Ctrl-D`);
  const text = String(await ctx.readStdin());
  return exact ? text.replace(/\r?\n$/, '') : text.trim();
}
