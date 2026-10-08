import { CliError, unwrap } from '../common.js';
import { EXIT, UsageError, parseCount } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import { queueEffects } from '../effects.js';
import {
  ACCESS_SYNC_ERRORS, accessSyncSnapshot, accessSyncTombstones, enqueueAccessSync, getAccessSyncJob, journalSyncRequested,
  patchAccessSyncConfig, setAccessSyncToken,
} from '../../services/accessSync/actions.js';
import { ADMIN_USER_ERRORS, allowEmail } from '../../services/admin/users.js';

// mailexpert access ...: the two-way sync of the panel's users with a Cloudflare Access policy
// (services/accessSync/, the admin screen's "Cloudflare Access" section). Settings are saved through
// the same action as the screen; a run is queued for the backend's job worker, which runs it in the
// backend process (it signs disabled users out there). The API token is read from stdin only and
// never printed.

const FINISHED = new Set(['done', 'failed', 'cancelled', 'needs_attention']);

// Outcomes of a run (services/accessSync/runner.js) and the exit code each gives `access sync`.
const OUTCOME_EXIT = Object.freeze({
  updated: EXIT.ok,
  unchanged: EXIT.ok,
  empty: EXIT.ok,
  not_google_mode: EXIT.refused,
  not_configured: EXIT.refused,
  aborted: EXIT.refused,
  failed: EXIT.failed,
});

const OUTCOME_TEXT = Object.freeze({
  updated: 'the policy was updated',
  unchanged: 'the policy already matched the active users',
  empty: 'nothing written: the policy would be left without any address, so it was not changed',
  not_google_mode: 'the panel does not sign in through Google or Cloudflare Access (AUTH_MODE is not google)',
  not_configured: 'the sync is off or its settings are incomplete',
  aborted: 'stopped: the run would disable more users than ACCESS_SYNC_MAX_DISABLES allows (journaled as access.sync_aborted) or import more than ACCESS_SYNC_MAX_IMPORTS allows (access.import_aborted)',
  failed: 'failed',
});

function lastRunLines(run) {
  if (!run) return ['last run: never'];
  return keyValues([
    ['last run', `${run.outcome}${run.error ? ` (${run.error})` : ''}`],
    ['  trigger', run.trigger],
    ['  finished', fmtDate(run.finishedAt)],
    ['  added', run.added],
    ['  removed', run.removed],
    ['  imported', run.imported ?? 0],
    ['  disabled', run.disabled],
    ['  errors', run.errors || undefined],
    ['  would disable', run.wouldDisable || undefined],
    ['  would import', run.wouldImport || undefined],
    ['  next retry', run.nextRetryAt ? `${fmtDate(run.nextRetryAt)} (attempt ${run.retryAttempt})` : undefined],
    ['  retry', run.retriable && !run.nextRetryAt ? 'no more retries: the hourly run tries again' : undefined],
  ]);
}

function configLines(snapshot) {
  const { config } = snapshot;
  return keyValues([
    ['enabled', config.enabled],
    ['account', config.accountId],
    ['application', config.appId],
    ['policy', config.policyId],
    ['api token', config.apiTokenSet ? 'set' : 'not set'],
    ['sign-in mode google', snapshot.googleMode],
    ['max disables per run', snapshot.maxDisables],
    ['max imports per run', snapshot.maxImports],
    ['deleted users (tombstones)', snapshot.tombstones],
  ]);
}

const status = {
  name: 'status',
  summary: 'the sync settings (never the token), the last run with its imports and retry, and the limits',
  usage: 'access status',
  async run() {
    const snapshot = await accessSyncSnapshot();
    return { data: snapshot, lines: [...configLines(snapshot), ...lastRunLines(snapshot.lastRun)] };
  },
};

// After a save that left the sync on, the CLI queues a run, as the screen asks its scheduler for one.
async function savedLines(result) {
  const snapshot = await accessSyncSnapshot();
  const lines = configLines(snapshot);
  if (result.job) lines.push(`sync queued as job ${result.job.id}: follow it with "mailexpert access sync" or the status`);
  return { data: { ...snapshot, job: result.job ? { id: result.job.id, status: result.job.status } : null }, lines };
}

const config = {
  name: 'config',
  summary: 'set the account, application and policy IDs; turn the sync on or off',
  usage: 'access config [--account ID] [--app ID] [--policy ID] [--enable | --disable]',
  journal: 'access.config_changed with the changed fields (never the token)',
  help: [
    '--account ID   the Cloudflare account ID (32 hex characters)',
    '--app ID       the Access application ID (UUID)',
    '--policy ID    the Allow policy ID (UUID) the sync writes the users into',
    '--enable       turn the sync on (needs the three IDs and a token: "access token")',
    '--disable      turn the sync off',
    'Options not given keep their stored value. Pointing the sync at another account, application',
    'or policy forgets what it wrote to the old one. With the sync on, a run is queued.',
  ],
  flags: { account: 'string', app: 'string', policy: 'string', enable: 'boolean', disable: 'boolean' },
  async run(ctx) {
    const { account, app, policy, enable, disable } = ctx.flags;
    if (enable && disable) throw new UsageError('--enable and --disable exclude each other');
    if ([account, app, policy, enable, disable].every((value) => value === undefined)) {
      throw new UsageError('nothing to change: give --account, --app, --policy, --enable or --disable');
    }
    const patch = { accountId: account, appId: app, policyId: policy, enabled: enable ? true : disable ? false : undefined };
    const result = unwrap(await patchAccessSyncConfig(patch, ctx.actor, { onEnabled: () => enqueueAccessSync(ctx.actor) }), ACCESS_SYNC_ERRORS);
    return savedLines(result);
  },
};

const token = {
  name: 'token',
  summary: 'store the Cloudflare API token the sync uses, read from stdin',
  usage: 'access token < file-with-the-token',
  journal: 'access.config_changed with tokenChanged (never the token)',
  help: [
    'The token is read from stdin only (a file or a pipe; in a terminal, paste it and press Ctrl-D),',
    'never from an argument, and never printed. It needs "Access: Apps and Policies" Edit (or Read',
    'and Edit) on the account; see docs/operations/cloudflare.md. With the sync on, a run is queued.',
  ],
  async run(ctx) {
    if (ctx.stdinIsTerminal) ctx.note('paste the token, then press Ctrl-D');
    const value = await ctx.readStdin();
    const result = unwrap(await setAccessSyncToken(value, ctx.actor, { onEnabled: () => enqueueAccessSync(ctx.actor) }), ACCESS_SYNC_ERRORS);
    return savedLines(result);
  },
};

const sync = {
  name: 'sync',
  summary: 'run the sync now in the backend and print the outcome',
  usage: 'access sync [--timeout SEC]',
  journal: 'access.sync_requested; the run itself journals user.disabled and access.sync_aborted as "Cloudflare Access"',
  help: [
    '--timeout SEC   how long to wait for the backend to run it (default 120, at most 3600)',
    'The run is queued for the backend\'s job worker and followed until it ends. Exit 0 when the',
    'policy was updated or already matched, 1 when the sync is off, not configured or stopped by',
    'the disable limit, 3 when Cloudflare refused or the run failed.',
  ],
  flags: { timeout: 'string' },
  async run(ctx) {
    const seconds = parseCount(ctx.flags.timeout, { name: 'timeout', min: 1, max: 3600, fallback: 120 });
    journalSyncRequested(ctx.actor);
    let job = unwrap(await getAccessSyncJob((await enqueueAccessSync(ctx.actor)).id), ACCESS_SYNC_ERRORS).job;
    const deadline = ctx.now() + seconds * 1000;
    while (!FINISHED.has(job.status)) {
      if (ctx.now() >= deadline) {
        throw new CliError('wait_timeout', `Job ${job.id} is still ${job.status} after ${seconds} s: is the backend running? "mailexpert access status" shows the last run`, {
          exit: EXIT.failed, details: { job },
        });
      }
      await ctx.sleep(ctx.pollMs);
      job = unwrap(await getAccessSyncJob(job.id), ACCESS_SYNC_ERRORS).job;
    }
    if (job.status !== 'done' || !job.result) {
      throw new CliError(job.errorCode ?? `job_${job.status}`, job.error ?? `Job ${job.id} ended ${job.status}`, { exit: EXIT.failed, details: { job } });
    }
    const { result } = job;
    const exit = OUTCOME_EXIT[result.outcome] ?? EXIT.failed;
    if (exit !== EXIT.ok) {
      const message = `${OUTCOME_TEXT[result.outcome] ?? result.outcome}${result.error ? `: ${result.error}` : ''}`;
      // runner.js reports its own failures by code and Cloudflare's by a sentence with the status.
      const code = !result.error ? result.outcome : /^[a-z_]+$/.test(result.error) ? result.error : 'cloudflare_error';
      throw new CliError(code, message, { exit, details: { job } });
    }
    return {
      data: { job },
      lines: [`${result.outcome}: ${OUTCOME_TEXT[result.outcome]}`, ...lastRunLines(result).slice(1)],
    };
  },
};

const tombstones = {
  name: 'tombstones',
  summary: 'the emails of deleted users, which the sync does not import again',
  usage: 'access tombstones',
  help: [
    'A deleted user\'s email is not imported from the policy again, and a Cloudflare Access sign-in',
    'under it is refused (user_deleted), until "access allow <email>" or "user create <email>".',
    'IN POLICY: the policy still listed the email at the last successful run.',
  ],
  async run() {
    const list = await accessSyncTombstones();
    return {
      data: { tombstones: list },
      lines: table(list, [
        { header: 'EMAIL', value: (t) => t.email },
        { header: 'DELETED', value: (t) => fmtDate(t.createdAt) },
        { header: 'BY', value: (t) => t.createdBy ?? '' },
        { header: 'IN POLICY', value: (t) => t.inPolicy },
      ], { empty: '(no deleted users)' }),
    };
  },
};

const allow = {
  name: 'allow',
  summary: 'let a deleted user\'s email in again: clear its tombstone and approve it',
  usage: 'access allow <email>',
  journal: 'access.tombstone_cleared, and user.added or user.enabled',
  help: [
    'Clears the tombstone and creates the user (or enables the user who has the email); the',
    'backend\'s next sync writes the email to the policy (a queued job).',
  ],
  positionals: ['email'],
  async run(ctx) {
    const result = unwrap(await allowEmail(ctx.args.email, ctx.actor), ADMIN_USER_ERRORS);
    const queued = await queueEffects(ctx, result.effects);
    const what = result.created ? 'created' : result.enabled ? 'enabled' : 'already active:';
    return {
      data: { user: result.user, created: result.created, enabled: result.enabled, tombstoneCleared: result.tombstoneCleared, job: queued.job },
      lines: [
        `${what} ${result.user.email}${result.tombstoneCleared ? ' (tombstone cleared)' : ''}`,
        ...queued.lines,
      ],
    };
  },
};

export default {
  name: 'access',
  summary: 'the two-way sync of the panel\'s users with a Cloudflare Access policy',
  commands: [status, config, token, sync, tombstones, allow],
};
