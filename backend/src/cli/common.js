import { EXIT, UsageError, parseCount } from './args.js';
import { MailNodeError } from '../services/mailNode/mailcow.js';
import { TENANT_ERRORS, getTenantJob } from '../services/tenant/tenantActions.js';

// What the panel CLI's commands share: the error an action answers, confirmation and waiting for a
// queued job.

// An error the CLI reports: the code and message the HTTP API answers for the same refusal, and
// the exit code (EXIT).
export class CliError extends Error {
  constructor(code, message, { exit = EXIT.refused, status = null, details = null } = {}) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.status = status;
    this.details = details;
  }
}

// The exit code of a refusal by its HTTP status: a 5xx is a failure (3), anything else a refusal (1).
const exitOf = (status) => (status >= 500 ? EXIT.failed : EXIT.refused);

// A refusal from an action's catalog (code -> [status, message]); an action may give the refusal
// its own message (the catalog's then only names the status).
export function refusal(catalog, code, ownMessage = null) {
  const [status, message] = catalog[code] ?? [500, code];
  return new CliError(code, ownMessage ?? message, { exit: exitOf(status), status });
}

// The action's answer, or its refusal thrown.
export function unwrap(result, catalog) {
  if (result?.error) throw refusal(catalog, result.error, result.message ?? null);
  return result;
}

// Runs an action that reads or writes the mail node: the node's failure (MailNodeError) becomes the
// CLI's, with the node's code and message, as the API answers it (502 by default).
export async function nodeAction(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MailNodeError) {
      const status = err.status ?? 502;
      throw new CliError(err.code, err.message, { exit: exitOf(status), status });
    }
    throw err;
  }
}

// Asks before an action that cannot be taken back. --yes answers yes; without a terminal (a pipe,
// docker compose exec -T, --json) the CLI never waits for an answer and refuses instead.
export async function confirm(ctx, question) {
  if (ctx.flags.yes) return;
  if (!ctx.interactive) {
    throw new CliError('confirmation_required', 'This action asks for confirmation: run it in a terminal or add --yes', { exit: EXIT.usage });
  }
  const answer = (await ctx.ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') throw new CliError('cancelled', 'Cancelled: nothing was changed', { exit: EXIT.refused });
}

const FINISHED = new Set(['done', 'failed', 'cancelled', 'needs_attention']);

// The flags of a command that queues a job: --wait follows it until it ends (the backend's job
// worker runs it; the CLI never does), --timeout bounds the wait in seconds.
export const WAIT_FLAGS = Object.freeze({ wait: 'boolean', timeout: 'string' });
export const WAIT_HELP = [
  '--wait          wait until the backend has run the job, and exit 3 if it failed',
  '--timeout SEC   how long --wait waits (default 120, at most 3600)',
];

// Follows the job (an answer of jobAnswer) until it ends, when --wait is given: the job's final
// answer, or the queued one without --wait. A job that failed or needs attention is exit 3.
export async function maybeWait(ctx, job) {
  if (!ctx.flags.wait || !job) return job;
  const seconds = parseCount(ctx.flags.timeout, { name: 'timeout', min: 1, max: 3600, fallback: 120 });
  const deadline = ctx.now() + seconds * 1000;
  let current = job;
  while (!FINISHED.has(current.status)) {
    if (ctx.now() >= deadline) {
      throw new CliError('wait_timeout', `Job ${current.id} is still ${current.status} after ${seconds} s: follow it with "jobs show ${current.id}"`, {
        exit: EXIT.failed, details: { job: current },
      });
    }
    await ctx.sleep(ctx.pollMs);
    current = unwrap(await getTenantJob(current.id), TENANT_ERRORS).job;
  }
  if (current.status !== 'done') {
    throw new CliError(current.errorCode ?? `job_${current.status}`, current.error ?? `Job ${current.id} ended ${current.status}`, {
      exit: EXIT.failed, details: { job: current },
    });
  }
  return current;
}

// One line about a queued job, for the human output.
export function jobLine(job, created) {
  if (!job) return 'nothing was queued';
  const what = created === false ? 'already queued' : 'queued';
  return `job ${job.id} (${job.kind}) ${job.status === 'queued' ? what : job.status}${job.errorCode ? `: ${job.errorCode}` : ''}`;
}

export { UsageError };
