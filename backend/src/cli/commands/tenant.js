import { WAIT_FLAGS, WAIT_HELP, jobLine, maybeWait, unwrap } from '../common.js';
import { fmtDate, keyValues } from '../output.js';
import { TENANT_JOB_KINDS } from '../../services/tenant/tenantJobs.js';
import { TENANT_ERRORS, enqueueTenantAction, tenantStatus } from '../../services/tenant/tenantActions.js';

// mailexpert tenant ...: the Microsoft tenant (services/tenant/tenantActions.js). Nothing here
// calls the tenant or its worker: status reads what the tenant jobs stored, the other commands
// queue the same jobs as the screen's buttons.

// Whether the backend reached the tenant worker, from what the jobs stored: the worker answers the
// certificate in every test and poll, so the newest of those tells. { reachable, at, code, source }.
export function workerReachability(status) {
  if (!status.driver) return { reachable: null, at: null, code: 'tenant_driver_missing', source: null };
  const { state } = status;
  const reads = [];
  if (state.connection?.steps?.certificate) {
    const step = state.connection.steps.certificate;
    // certificate_mismatch: the worker answered, with another certificate.
    reads.push({ at: state.connection.at, reachable: step.ok || step.code === 'certificate_mismatch', code: step.ok ? null : step.code, source: 'test' });
  }
  if (state.certificate?.at) reads.push({ at: state.certificate.at, reachable: true, code: null, source: 'poll' });
  // A poll that could not read the certificate keeps the last good one with the error beside it.
  if (state.certificate?.errorAt) {
    reads.push({ at: state.certificate.errorAt, reachable: false, code: state.certificate.error?.code ?? 'tenant_failed', source: 'poll' });
  }
  if (!reads.length) return { reachable: null, at: null, code: 'not_checked', source: null };
  const time = (r) => Date.parse(r.at ?? '') || 0;
  return reads.reduce((newest, r) => (time(r) > time(newest) ? r : newest));
}

function antispamLines(antispam) {
  if (!antispam) return ['anti-spam policy: not read yet'];
  if (!antispam.ok) return [`anti-spam policy: read failed at ${fmtDate(antispam.at)} (${antispam.code})`];
  const lines = [`anti-spam policy: read at ${fmtDate(antispam.at)}`];
  for (const conflict of antispam.conflicts ?? []) {
    lines.push(`  ${conflict.field}: ${conflict.action}, expected ${conflict.expected.join(' or ')} (${conflict.code}, ${conflict.severity})`);
  }
  if (!(antispam.conflicts ?? []).length) lines.push('  every action is as the panel sets it');
  const e = antispam.enforcement;
  if (e) {
    lines.push(`  last fix at ${fmtDate(e.at)}: ${e.ok ? 'ok' : `not done (${e.error?.code ?? 'failed'})`}${e.changed?.length ? `, changed ${e.changed.map((c) => c.field).join(', ')}` : ''}`);
  }
  return lines;
}

const status = {
  name: 'status',
  summary: 'the tenant driver, whether the worker was reached and the anti-spam policy',
  usage: 'tenant status',
  async run() {
    const result = await tenantStatus();
    const worker = workerReachability(result);
    const { state } = result;
    const data = { ...result, worker };
    const lines = [
      ...keyValues([
        ['driver', result.driver ?? 'none'],
        ['worker profile without driver', result.profileWithoutDriver ? 'yes: TENANT_WORKER_URL is missing or its token too short' : undefined],
        ['tenant configured', result.configured],
        ['worker reached', worker.reachable === null ? `unknown (${worker.code})` : worker.reachable ? `yes, ${fmtDate(worker.at)} (${worker.source})` : `no, ${fmtDate(worker.at)} (${worker.code})`],
        ['connection test', state.connection ? `${state.connection.ok ? 'ok' : 'failed'} at ${fmtDate(state.connection.at)}` : 'never run'],
        ['certificate expires', state.certificate?.notAfter ? fmtDate(state.certificate.notAfter) : undefined],
        ['blocked connectors', state.blockedConnectors ? (state.blockedConnectors.ok === false
          ? `read failed (${state.blockedConnectors.error?.code ?? 'tenant_failed'})` : (state.blockedConnectors.items ?? []).length) : undefined],
        ['connector changes', result.connectorDrift.length ? `${result.connectorDrift.length} since the reference` : 'none'],
        ['latest test job', result.jobs.test ? jobLine(result.jobs.test) : undefined],
        ['latest poll job', result.jobs.poll ? jobLine(result.jobs.poll) : undefined],
        ['latest anti-spam job', result.jobs.antispam ? jobLine(result.jobs.antispam) : undefined],
      ]),
      ...antispamLines(state.antispam),
    ];
    return { data, lines };
  },
};

function enqueueCommand(name, kind, summary, usageExtra = []) {
  return {
    name,
    summary,
    usage: `tenant ${name} [--wait] [--timeout SEC]`,
    help: [...usageExtra, ...WAIT_HELP],
    flags: WAIT_FLAGS,
    mutates: true,
    async run(ctx) {
      const result = unwrap(await enqueueTenantAction(kind, ctx.actor), TENANT_ERRORS);
      const job = await maybeWait(ctx, result.job);
      return { data: { ...result, job }, lines: [jobLine(job, result.created)] };
    },
  };
}

export default {
  name: 'tenant',
  summary: 'the Microsoft tenant: status, connection test, anti-spam policy',
  commands: [
    status,
    enqueueCommand('test', TENANT_JOB_KINDS.test, 'test the connection to the tenant through the worker (the "Test connection" button)'),
    enqueueCommand('antispam', TENANT_JOB_KINDS.antispam, 'check and fix the Default anti-spam policy (the "Check and fix" button)', [
      'Sets the spam, high confidence spam, phishing and bulk actions of the Default policy to',
      'MoveToJmf where they differ (section 5.14); what changed is journaled.',
    ]),
  ],
};
