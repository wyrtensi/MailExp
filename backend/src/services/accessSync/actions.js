import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import { getAuthSettings } from '../auth/authSettings.js';
import { enqueueJob, getJob, registerJobKind } from '../jobQueue.js';
import { requestAccessSync, runAccessSyncNow, withAccessSyncLock } from './index.js';
import {
  AccessSyncConfigError, accessSyncMaxDisables, accessSyncMaxImports, loadState, loadStoredConfig, publicConfig, updateConfig,
} from './settings.js';
import { listTombstones } from './tombstones.js';

// The Cloudflare Access sync's administrator actions, shared by the admin API (routes/accessSync.js)
// and the panel CLI (cli/commands/access.js): the same checks, refusal codes and journal.
//
// A run needs the backend's own process: it signs disabled users out of their sessions and live
// sockets, and it is serialised with the hourly runs and with settings saved from the screen. The
// CLI therefore never runs the sync itself; it queues an access_sync job, which the backend's job
// worker runs through the process-wide scheduler (services/accessSync/index.js).

export const ACCESS_SYNC_JOB_KIND = 'access_sync';
// A run never throws (runner.js reports a failure in its outcome), so there is nothing to retry.
export const ACCESS_SYNC_JOB_MAX_ATTEMPTS = 1;

const INVALID = 'Invalid Cloudflare Access settings';

// code -> [HTTP status, message]. The first three are AccessSyncConfigError's codes; the route
// answers them with the same text it always did.
export const ACCESS_SYNC_ERRORS = Object.freeze({
  invalid_field: [400, INVALID],
  invalid_id: [400, INVALID],
  incomplete: [400, INVALID],
  token_invalid: [400, 'The API token must be one line of 20 to 512 characters without spaces'],
  job_not_found: [404, 'Job not found'],
});

const CONFIG_FIELDS = Object.freeze(['enabled', 'accountId', 'appId', 'policyId']);
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,512}$/;

// What the admin screen and `mailexpert access status` show: the settings without the token, the
// last run (with its imports, errors and the next retry), the limits, how many emails are
// tombstoned and whether the panel signs in through Google/Access at all.
export async function accessSyncSnapshot() {
  const [stored, state, tombstones] = await Promise.all([loadStoredConfig(), loadState(), listTombstones()]);
  return {
    config: publicConfig(stored),
    lastRun: state.lastRun,
    maxDisables: accessSyncMaxDisables(),
    maxImports: accessSyncMaxImports(),
    tombstones: tombstones.length,
    googleMode: getAuthSettings().mode === 'google',
  };
}

// The tombstoned emails (users an administrator deleted), newest first, each with whether the
// policy still listed it at the last successful run: { email, createdAt, createdBy, inPolicy }.
export async function accessSyncTombstones() {
  const [tombstones, state] = await Promise.all([listTombstones(), loadState()]);
  const listed = new Set(state.policyEmails);
  return tombstones.map((entry) => ({ ...entry, inPolicy: listed.has(entry.email) }));
}

// Saves the settings (settings.js updateConfig: a blank token keeps the stored one; one transaction
// under the advisory lock shared with runs and other processes) under the in-process sync lock
// and journals what changed: access.config_changed with the changed fields and whether the
// token was replaced, never the token. When the sync is on, onEnabled asks for a run (the screen:
// the in-process scheduler; the CLI: a queued job). Answers { saved } or { error: code }.
export function saveAccessSyncConfig(input, actor, options) {
  return applyAccessSyncConfig(() => input, actor, options);
}

// The CLI changes one thing at a time: the given fields replace the stored ones, the rest stay.
// The merge happens inside the settings transaction (settings.js updateConfig), so a save made
// meanwhile by the screen or another CLI call is never overwritten with what was read before it.
export function patchAccessSyncConfig(patch, actor, options) {
  const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  return applyAccessSyncConfig((stored) => ({
    enabled: stored.enabled === true,
    accountId: stored.accountId,
    appId: stored.appId,
    policyId: stored.policyId,
    ...given,
  }), actor, options);
}

async function applyAccessSyncConfig(build, actor, { onEnabled = () => requestAccessSync('config'), afterRead } = {}) {
  let before;
  let saved;
  try {
    ({ before, saved } = await withAccessSyncLock(() => updateConfig(build, { afterRead })));
  } catch (err) {
    if (err instanceof AccessSyncConfigError) return { error: err.code };
    throw err;
  }
  const changed = CONFIG_FIELDS.filter((field) => before[field] !== saved[field]);
  const tokenChanged = before.apiToken !== saved.apiToken;
  if (changed.length || tokenChanged) {
    recordAudit(auditOf(actor, {
      action: 'access.config_changed',
      details: { changed, tokenChanged, enabled: saved.enabled, accountId: saved.accountId, appId: saved.appId, policyId: saved.policyId },
    }));
  }
  const job = saved.enabled ? await onEnabled() : null;
  return { saved, job: job ?? null };
}

// Stores a new API token, keeping the other settings. The token is checked for shape only; the
// next run tells whether Cloudflare accepts it.
export async function setAccessSyncToken(token, actor, options) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!TOKEN_RE.test(value)) return { error: 'token_invalid' };
  return patchAccessSyncConfig({ apiToken: value }, actor, options);
}

// Journals that an administrator asked for a run now (the screen's button or the CLI).
export function journalSyncRequested(actor) {
  recordAudit(auditOf(actor, { action: 'access.sync_requested', details: {} }));
}

// Queues a run for the backend's job worker. Answers the job row.
export async function enqueueAccessSync(actor) {
  const { job } = await enqueueJob({
    kind: ACCESS_SYNC_JOB_KIND,
    payload: actor?.via ? { via: actor.via } : {},
    createdBy: actor?.userId ?? null,
    maxAttempts: ACCESS_SYNC_JOB_MAX_ATTEMPTS,
  });
  return job;
}

// A queued run as the CLI follows it: { id, status, result (the run's outcome once done),
// errorCode, error }, or { error: 'job_not_found' } for an id that is not an access_sync job.
export async function getAccessSyncJob(id) {
  const job = await getJob(id).catch(() => null);
  if (!job || job.kind !== ACCESS_SYNC_JOB_KIND) return { error: 'job_not_found' };
  return {
    job: {
      id: job.id,
      status: job.status,
      result: job.payload?.result ?? null,
      errorCode: job.error_code ?? null,
      error: job.last_error ?? null,
    },
  };
}

// The backend's handler: one run through the process-wide scheduler (so it waits for a run or a
// settings save in progress and signs disabled users out), its outcome kept in the job's payload.
export function registerAccessSyncJobKind({ runNow = runAccessSyncNow } = {}) {
  registerJobKind(ACCESS_SYNC_JOB_KIND, {
    maxAttempts: ACCESS_SYNC_JOB_MAX_ATTEMPTS,
    async handler(_job, ctx) {
      const result = await runNow();
      await ctx.complete((tx, row) => tx.query(
        "UPDATE jobs SET payload = payload || jsonb_build_object('result', $2::jsonb) WHERE id = $1",
        [row.id, JSON.stringify(result ?? null)],
      ));
    },
  });
}
