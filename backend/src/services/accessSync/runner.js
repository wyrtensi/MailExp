import { query, withTransaction } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { getAuthSettings } from '../auth/authSettings.js';
import { UserIdentityError, claimOrCreateUserByEmail, normalizeEmail } from '../auth/userIdentity.js';
import { disableUsersByEmail } from '../auth/userStatus.js';
import { CloudflareAccessError, createCloudflareAccessClient } from './cloudflareAccessClient.js';
import {
  buildInclude, exceedsDisableLimit, exceedsImportLimit, importCandidates, listedEmails, removedInCloudflare,
} from './reconcile.js';
import {
  accessSyncMaxDisables, accessSyncMaxImports, loadRunConfig, loadState, loadStoredConfig, saveState, withAccessSyncTransaction,
} from './settings.js';
import { isTombstoned, lockAddress, tombstonedAmong } from './tombstones.js';
import { ACCESS_LOGIN_SOURCE } from './accessState.js';

// The name the audit log shows for changes the sync makes on its own.
export const ACCESS_SYNC_ACTOR = 'Cloudflare Access';

// A run that failed for a reason that may pass on its own (CloudflareAccessError.retriable) is
// retried after these delays, one after another; a Retry-After from Cloudflare that asks for
// longer wins. A retry later than the hourly run is left to the hourly run.
export const RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000]);
export const RETRY_CAP_MS = 60 * 60_000;

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);

// When to retry a failed run, or null: attempt is this retry's number (1 for the first).
export function retryDelayMs(attempt, retryAfterSeconds) {
  const backoff = RETRY_DELAYS_MS[attempt - 1];
  if (backoff === undefined) return null;
  const delay = Math.max(backoff, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0);
  return delay > RETRY_CAP_MS ? null : delay;
}

const importedEntry = (user) => ({
  actorEmail: ACCESS_SYNC_ACTOR, action: 'access.user_imported',
  details: { userId: user.id, email: user.email, source: 'cloudflare_access' },
});

// Creates the users for emails someone added to the policy in Cloudflare. Each in its own
// transaction, the tombstone checked again under the per-address lock: an administrator may have
// deleted the user since the run read the tombstones. Every user created is journaled, also when
// a later one fails and the run stops. Answers { imported, errors }.
async function importUsers(emails) {
  const imported = [];
  let errors = 0;
  try {
    for (const email of emails) {
      try {
        const user = await withTransaction(async (client) => {
          await lockAddress(client, email);
          if (await isTombstoned(email, client)) return null;
          const result = await claimOrCreateUserByEmail(client, email);
          return (result.created || result.claimed) && !result.user.disabled_at ? result.user : null;
        });
        if (user) imported.push(user);
      } catch (err) {
        if (!(err instanceof UserIdentityError)) throw err;
        errors += 1;
      }
    }
  } finally {
    if (imported.length) recordAudit(imported.map(importedEntry));
  }
  return { imported, errors };
}

// One two-way reconcile of the Access policy with MailExpert's users (see reconcile.js): emails
// added in Cloudflare become users, emails MailExpert wrote and Cloudflare no longer lists disable
// their users, and the policy then lists every active user. Every run that reaches Cloudflare
// leaves its result in state.lastRun for the admin screen; a retriable failure carries the time
// of the next retry (lastRun.nextRetryAt), which the scheduler keeps.
export async function runAccessSync({
  trigger,
  signOutUser,
  createClient = createCloudflareAccessClient,
  settings = getAuthSettings(),
  env = process.env,
  now = () => new Date(),
  // Test hook: runs inside the state write's transaction, between reading the settings and writing.
  beforeStateWrite = null,
  // Whether a retriable failure gets a retry: only the scheduler (scheduler.js) runs one, so only
  // its runs answer nextRetryAt.
  canRetry = false,
}) {
  if (settings.mode !== 'google') return { outcome: 'not_google_mode' };
  const config = await loadRunConfig();
  if (!config) return { outcome: 'not_configured' };
  const state = await loadState();
  const startedAt = now().toISOString();

  const finish = async (result, statePatch = {}) => {
    const lastRun = {
      trigger, startedAt, finishedAt: now().toISOString(),
      added: 0, removed: 0, imported: 0, disabled: 0, wouldDisable: 0, wouldImport: 0, errors: 0,
      error: null, retriable: false, retryAttempt: 0, nextRetryAt: null, ...result,
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
      const retry = { retryAttempt: lastRun.retryAttempt };
      await saveState(moved ? { ...fresh, lastRun } : { ...fresh, ...statePatch, ...retry, lastRun }, db);
    });
    return lastRun;
  };

  const fail = (error, cause = null) => {
    if (!cause?.retriable) return finish({ outcome: 'failed', error });
    const attempt = trigger === 'retry' ? state.retryAttempt + 1 : 1;
    const delay = canRetry ? retryDelayMs(attempt, cause.retryAfter) : null;
    return finish({
      outcome: 'failed', error, retriable: true,
      retryAttempt: delay === null ? 0 : attempt,
      nextRetryAt: delay === null ? null : new Date(now().getTime() + delay).toISOString(),
    });
  };

  try {
    if (!config.apiToken) return await fail('token_unreadable');
    const client = createClient(config);
    const policy = await client.getPolicy(config.policyId);
    if (policy?.decision !== 'allow') return await fail('policy_not_allow');

    const pinned = settings.bootstrapAdminEmails;
    const { rows } = await query('SELECT email, disabled_at, access_source FROM users WHERE email IS NOT NULL');
    const known = new Set(rows.map((row) => row.email.toLowerCase()));
    const activeRows = rows.filter((row) => !row.disabled_at);
    const activeEmails = activeRows.map((row) => row.email.toLowerCase());
    // Users a domain or group rule admitted at sign-in (userIdentity.js): not written into the
    // policy, unless the policy now lists them by address, which makes them the sync's own.
    const listed = new Set(listedEmails(policy.include));
    const byRule = activeRows.filter((row) => row.access_source === ACCESS_LOGIN_SOURCE).map((row) => row.email.toLowerCase());
    const adopt = byRule.filter((email) => listed.has(email));
    const unpinned = new Set(byRule.filter((email) => !listed.has(email)));

    // Both checks run before anything changes: a run either does all of it or nothing.
    const proposed = importCandidates({ policy, baseline: state.baseline, pinned });
    const invalid = proposed.filter((email) => normalizeEmail(email) !== email);
    const fresh = proposed.filter((email) => normalizeEmail(email) === email && !known.has(email));
    const tombstoned = await tombstonedAmong(new Set(fresh));
    const toImport = fresh.filter((email) => !tombstoned.has(email));
    const candidates = removedInCloudflare({ policy, baseline: state.baseline, activeEmails, pinned });

    const maxDisables = accessSyncMaxDisables(env);
    const maxImports = accessSyncMaxImports(env);
    const disablesStopped = exceedsDisableLimit(candidates.length, activeEmails.length, maxDisables);
    const importsStopped = exceedsImportLimit(toImport.length, maxImports);
    if (disablesStopped || importsStopped) {
      const audits = [];
      if (disablesStopped && !sameList(state.abortedCandidates, candidates)) {
        audits.push({
          actorEmail: ACCESS_SYNC_ACTOR, action: 'access.sync_aborted',
          details: { candidates, activeUsers: activeEmails.length, maxDisables },
        });
      }
      if (importsStopped && !sameList(state.abortedImports, toImport)) {
        audits.push({
          actorEmail: ACCESS_SYNC_ACTOR, action: 'access.import_aborted',
          details: { candidates: toImport, maxImports },
        });
      }
      if (audits.length) recordAudit(audits.length === 1 ? audits[0] : audits);
      return await finish(
        {
          outcome: 'aborted',
          wouldDisable: disablesStopped ? candidates.length : 0,
          wouldImport: importsStopped ? toImport.length : 0,
        },
        { abortedCandidates: disablesStopped ? candidates : null, abortedImports: importsStopped ? toImport : null },
      );
    }

    const { imported, errors } = toImport.length ? await importUsers(toImport) : { imported: [], errors: 0 };
    if (adopt.length) {
      await query("UPDATE users SET access_source = NULL WHERE lower(email) = ANY($1::text[]) AND access_source = 'login'", [adopt]);
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
    const desired = [...new Set([
      ...activeEmails.filter((address) => !turnedOff.has(address) && !unpinned.has(address)),
      ...imported.map((user) => user.email.toLowerCase()),
      ...pinned,
    ])].sort();
    const { include, changed, added, removed } = buildInclude({ policy, baseline: state.baseline, desired });
    const counts = { imported: imported.length, disabled: disabled.length, errors: errors + invalid.length };
    if (include.length === 0) {
      return await finish(
        { outcome: 'empty', ...counts },
        { policyEmails: listedEmails(policy.include), abortedCandidates: null, abortedImports: null },
      );
    }
    if (changed) await client.updatePolicy({ ...policy, include });
    return await finish(
      { outcome: changed ? 'updated' : 'unchanged', added: added.length, removed: removed.length, ...counts },
      { baseline: desired, policyEmails: listedEmails(include), abortedCandidates: null, abortedImports: null },
    );
  } catch (err) {
    if (err instanceof CloudflareAccessError) {
      return fail(err.status === 'not_attached' ? 'policy_not_attached' : err.message, err);
    }
    console.error('[access-sync] Run failed:', err?.code || err?.name || 'Error');
    return fail('internal_error');
  }
}
