import { query, withTransaction } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { getAuthSettings } from '../auth/authSettings.js';
import { disableUsersByEmail } from '../auth/userStatus.js';
import { CloudflareAccessError, createCloudflareAccessClient } from './cloudflareAccessClient.js';
import { buildInclude, exceedsDisableLimit, removedInCloudflare } from './reconcile.js';
import {
  accessSyncMaxDisables, loadRunConfig, loadState, loadStoredConfig, saveState, withAccessSyncTransaction,
} from './settings.js';

// The name the audit log shows for changes the sync makes on its own.
export const ACCESS_SYNC_ACTOR = 'Cloudflare Access';

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);

// One reconcile of the Access policy with MailExpert's active users (see reconcile.js). Every run
// that reaches Cloudflare leaves its result in state.lastRun for the admin screen.
export async function runAccessSync({
  trigger,
  signOutUser,
  createClient = createCloudflareAccessClient,
  settings = getAuthSettings(),
  env = process.env,
  now = () => new Date(),
  // Test hook: runs inside the state write's transaction, between reading the settings and writing.
  beforeStateWrite = null,
}) {
  if (settings.mode !== 'google') return { outcome: 'not_google_mode' };
  const config = await loadRunConfig();
  if (!config) return { outcome: 'not_configured' };
  const state = await loadState();
  const startedAt = now().toISOString();

  const finish = async (result, statePatch = {}) => {
    const lastRun = {
      trigger, startedAt, finishedAt: now().toISOString(),
      added: 0, removed: 0, disabled: 0, wouldDisable: 0, error: null, ...result,
    };
    // The panel CLI saves the settings from its own process, outside this process's lock, so the
    // check and the write run in one transaction under the sync's advisory lock (settings.js), as
    // every settings save does. When the account, application or policy changed while this run
    // worked, its baseline belongs to the old policy: the save has reset the state for the new
    // one, and only lastRun is added to it.
    await withAccessSyncTransaction(async (db) => {
      const current = await loadStoredConfig(db);
      if (beforeStateWrite) await beforeStateWrite();
      const fresh = await loadState(db);
      const moved = current.accountId !== config.accountId || current.appId !== config.appId || current.policyId !== config.policyId;
      await saveState(moved ? { ...fresh, lastRun } : { ...fresh, ...statePatch, lastRun }, db);
    });
    return lastRun;
  };

  try {
    if (!config.apiToken) return await finish({ outcome: 'failed', error: 'token_unreadable' });
    const client = createClient(config);
    const policy = await client.getPolicy(config.policyId);
    if (policy?.decision !== 'allow') return await finish({ outcome: 'failed', error: 'policy_not_allow' });

    const pinned = settings.bootstrapAdminEmails;
    const { rows } = await query('SELECT email FROM users WHERE disabled_at IS NULL AND email IS NOT NULL');
    const activeEmails = rows.map((row) => row.email.toLowerCase());

    const candidates = removedInCloudflare({ policy, baseline: state.baseline, activeEmails, pinned });
    const maxDisables = accessSyncMaxDisables(env);
    if (exceedsDisableLimit(candidates.length, activeEmails.length, maxDisables)) {
      if (!sameList(state.abortedCandidates, candidates)) {
        recordAudit({
          actorEmail: ACCESS_SYNC_ACTOR, action: 'access.sync_aborted',
          details: { candidates, activeUsers: activeEmails.length, maxDisables },
        });
      }
      return await finish({ outcome: 'aborted', wouldDisable: candidates.length }, { abortedCandidates: candidates });
    }

    const { disabled } = candidates.length
      ? await withTransaction((tx) => disableUsersByEmail(tx, candidates, { googleMode: true, bootstrapAdminEmails: pinned }))
      : { disabled: [] };
    // Journal the disables right after they are committed, before signing anyone out: a throwing
    // signOutUser must not lose audit entries for disables that already happened.
    if (disabled.length) {
      recordAudit(disabled.map((user) => ({
        actorEmail: ACCESS_SYNC_ACTOR, action: 'user.disabled',
        details: { userId: user.id, email: user.email, isAdmin: !!user.is_admin, source: 'cloudflare_access' },
      })));
    }
    for (const user of disabled) await signOutUser(user.id);

    const turnedOff = new Set(disabled.map((user) => user.email.toLowerCase()));
    const desired = [...new Set([...activeEmails.filter((address) => !turnedOff.has(address)), ...pinned])].sort();
    const { include, changed, added, removed } = buildInclude({ policy, baseline: state.baseline, desired });
    if (include.length === 0) {
      return await finish({ outcome: 'empty', disabled: disabled.length }, { abortedCandidates: null });
    }
    if (changed) await client.updatePolicy({ ...policy, include });
    return await finish(
      { outcome: changed ? 'updated' : 'unchanged', added: added.length, removed: removed.length, disabled: disabled.length },
      { baseline: desired, abortedCandidates: null },
    );
  } catch (err) {
    if (err instanceof CloudflareAccessError) {
      const error = err.status === 'not_attached' ? 'policy_not_attached' : err.message;
      return finish({ outcome: 'failed', error });
    }
    console.error('[access-sync] Run failed:', err?.code || err?.name || 'Error');
    return finish({ outcome: 'failed', error: 'internal_error' });
  }
}
