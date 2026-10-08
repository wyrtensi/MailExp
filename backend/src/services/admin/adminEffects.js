import { enqueueJob, registerJobKind } from '../jobQueue.js';

// What an administrator's change still asks of the backend's own process once the database holds
// it: signing a user out of their sessions and live sockets, the plugins' clean-up of a deleted
// user, the Cloudflare Access sync, and the settings the process keeps in memory (the sign-in
// limits, the mailbox sync cadence, the categorization and connection-policy caches, the Microsoft
// OAuth client in process.env).
//
// The admin routes run in that process and apply the effects at once (applyAdminEffects). The panel
// CLI runs in another process, which reaches neither the sockets nor that memory: it queues an
// admin_effects job, which the backend's job worker applies with the same hooks.
//
// effects: {
//   signOut:     [userId]  users who lost their way in (disabled, email replaced, deleted)
//   userDeleted: [userId]  deleted users, for the plugins' onUserDelete hook
//   accessSync:  trigger   asks the Access sync for a run (google mode only, as requestAccessSync)
//   reload:      [name]    RELOADS: process state to read again from the database
//   reconnect:   [accountId] mailboxes to (re)connect from their stored row (a new or changed
//                          connection: services/accounts/connection.js reconnectAccount)
//   runRules:    [accountId] mailboxes whose enabled rules to run on the inbox, in the background
//                          (services/rules/ruleActions.js; a mailbox being swept is skipped)
//   runRulesAll: boolean   the run was asked for every mailbox (its rule.run entries say so)
// }

export const ADMIN_EFFECTS_JOB_KIND = 'admin_effects';
// Every hook is safe to run again; a failed attempt is retried a few times.
export const ADMIN_EFFECTS_MAX_ATTEMPTS = 3;

export const RELOADS = Object.freeze([
  'auth_limits', 'sync_intervals', 'categorization', 'connection_policy', 'microsoft',
]);

const uniq = (list) => [...new Set(list)];

// One effects object from several (null entries are skipped).
export function mergeEffects(...list) {
  const merged = { signOut: [], userDeleted: [], accessSync: null, reload: [], reconnect: [], runRules: [], runRulesAll: false };
  for (const effects of list) {
    if (!effects) continue;
    merged.signOut.push(...(effects.signOut ?? []));
    merged.userDeleted.push(...(effects.userDeleted ?? []));
    merged.reload.push(...(effects.reload ?? []));
    merged.reconnect.push(...(effects.reconnect ?? []));
    merged.runRules.push(...(effects.runRules ?? []));
    if (effects.accessSync) merged.accessSync = effects.accessSync;
    if (effects.runRulesAll) merged.runRulesAll = true;
  }
  return {
    ...merged, signOut: uniq(merged.signOut), userDeleted: uniq(merged.userDeleted), reload: uniq(merged.reload),
    reconnect: uniq(merged.reconnect), runRules: uniq(merged.runRules),
  };
}

export function hasEffects(effects) {
  return !!effects && (!!effects.signOut?.length || !!effects.userDeleted?.length || !!effects.accessSync || !!effects.reload?.length
    || !!effects.reconnect?.length || !!effects.runRules?.length);
}

// Applies the effects in this process. hooks: { signOutUser(id), onUserDelete(id),
// requestAccessSync(trigger), reload: { name: fn }, reconnectAccount(id), runRules([id],
// { allMailboxes, actor }) }; a hook not given is skipped. Sign-outs come first, then the reloads,
// the plugins' clean-up and the Access sync, as the routes always did; the mailbox reconnects and
// the rules run last. context.actor: who asked for the effects (the job's creator and via), for the
// journal entries a hook writes.
export async function applyAdminEffects(effects, hooks, context = {}) {
  if (!hasEffects(effects)) return;
  for (const userId of effects.signOut ?? []) await hooks.signOutUser?.(userId);
  for (const name of effects.reload ?? []) await hooks.reload?.[name]?.();
  for (const userId of effects.userDeleted ?? []) await hooks.onUserDelete?.(userId);
  if (effects.accessSync) hooks.requestAccessSync?.(effects.accessSync);
  for (const accountId of effects.reconnect ?? []) await hooks.reconnectAccount?.(accountId);
  if (effects.runRules?.length) {
    await hooks.runRules?.(effects.runRules, { allMailboxes: !!effects.runRulesAll, actor: context.actor ?? null });
  }
}

// Queues the effects for the backend (the CLI). Answers the job row, or null when there is nothing
// to apply.
export async function enqueueAdminEffects(effects, actor) {
  if (!hasEffects(effects)) return null;
  const { job } = await enqueueJob({
    kind: ADMIN_EFFECTS_JOB_KIND,
    payload: { effects: mergeEffects(effects), ...(actor?.via ? { via: actor.via } : {}) },
    createdBy: actor?.userId ?? null,
    maxAttempts: ADMIN_EFFECTS_MAX_ATTEMPTS,
  });
  return job;
}

// The backend's handler (index.js), with the same hooks the admin routes use.
export function registerAdminEffectsJobKind(hooks) {
  registerJobKind(ADMIN_EFFECTS_JOB_KIND, {
    maxAttempts: ADMIN_EFFECTS_MAX_ATTEMPTS,
    async handler(job) {
      const actor = { userId: job.created_by ?? null, ...(job.payload?.via ? { via: job.payload.via } : {}) };
      await applyAdminEffects(job.payload?.effects ?? {}, hooks, { actor });
    },
  });
}
