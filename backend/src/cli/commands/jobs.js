import { unwrap } from '../common.js';
import { UsageError, parseCount } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import { JOB_STATUSES } from '../../services/jobQueue.js';
import { TENANT_ERRORS, TENANT_KINDS, getTenantJob, listTenantJobs } from '../../services/tenant/tenantActions.js';

// mailexpert jobs ...: the jobs of the tenant (its buttons, the domains' tenant steps and the
// quarantine release) in the durable queue (docs/architecture/job-queue.md). Letters waiting to be
// sent are not listed here: they belong to their authors.

const STATUS_HELP = `--status S   one of ${JOB_STATUSES.join(', ')}, or "problems" (failed and needs_attention)`;

function statusesOf(value) {
  if (value === undefined) return null;
  if (value === 'problems') return ['failed', 'needs_attention'];
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = list.find((s) => !JOB_STATUSES.includes(s));
  if (unknown || !list.length) throw new UsageError(`--status must be ${JOB_STATUSES.join(', ')} or problems`);
  return list;
}

function kindsOf(value) {
  if (value === undefined) return null;
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = list.find((k) => !TENANT_KINDS.includes(k));
  if (unknown || !list.length) throw new UsageError(`--kind must be one of ${TENANT_KINDS.join(', ')}`);
  return list;
}

const list = {
  name: 'list',
  summary: 'list the newest tenant jobs',
  usage: 'jobs list [--status S] [--kind K] [--limit N]',
  help: [
    STATUS_HELP,
    `--kind K     one of ${TENANT_KINDS.join(', ')} (comma separated for several)`,
    '--limit N    how many, newest first (default 30, at most 500)',
  ],
  flags: { status: 'string', kind: 'string', limit: 'string' },
  async run(ctx) {
    const statuses = statusesOf(ctx.flags.status);
    const kinds = kindsOf(ctx.flags.kind);
    const limit = parseCount(ctx.flags.limit, { name: 'limit', min: 1, max: 500, fallback: 30 });
    const result = await listTenantJobs({ statuses, kinds, limit });
    const lines = table(result.jobs, [
      { header: 'ID', value: (j) => j.id },
      { header: 'KIND', value: (j) => j.kind },
      { header: 'STATUS', value: (j) => j.status },
      { header: 'DOMAIN', value: (j) => j.domain },
      { header: 'UPDATED', value: (j) => fmtDate(j.updatedAt) },
      { header: 'ERROR', value: (j) => j.errorCode },
    ], { empty: 'no jobs' });
    return { data: result, lines };
  },
};

const show = {
  name: 'show',
  summary: 'show one tenant job',
  usage: 'jobs show <id>',
  positionals: ['id'],
  async run(ctx) {
    const { job } = unwrap(await getTenantJob(ctx.args.id), TENANT_ERRORS);
    const lines = keyValues([
      ['id', job.id],
      ['kind', job.kind],
      ['status', job.status],
      ['created', fmtDate(job.createdAt)],
      ['updated', fmtDate(job.updatedAt)],
      ['error code', job.errorCode],
      ['error', job.error],
    ]);
    return { data: { job }, lines };
  },
};

export default {
  name: 'jobs',
  summary: 'the tenant\'s jobs in the queue: recent, failed, needing attention',
  commands: [list, show],
};
