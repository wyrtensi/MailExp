import { enqueueAdminEffects } from '../services/admin/adminEffects.js';

// The admin commands' (user, settings, sso, integration) way to the backend's process: what a
// change still asks of it (sign-outs, the Access sync, the settings it keeps in memory) is queued
// as an admin_effects job, which the backend's job worker applies with the hooks the admin routes
// use (services/admin/adminEffects.js). The CLI never applies them itself.

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

// A secret a command takes, from stdin only: never an argument, never printed.
export async function readSecret(ctx, what) {
  if (ctx.stdinIsTerminal) ctx.note(`paste the ${what}, then press Ctrl-D`);
  return String(await ctx.readStdin()).trim();
}
