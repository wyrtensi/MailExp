// The demo's mail node agent (backend routes/mailNodeAgent.js): connected, with a status report
// and last night's backup, its scripts at an older commit than the panel's. "Back up mail now" and
// "Update node now" run a few seconds and finish; the token routes answer as the server does (a
// token shown once, a rotation, a revocation), with its refusals.

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const START = Date.now();
const at = (offset) => new Date(START + offset).toISOString();
// A demo backup runs this long before it reports done.
const DEMO_BACKUP_MS = 6000;
// The commit the demo panel runs (its /admin/update answer).
export const DEMO_PANEL_COMMIT = 'd'.repeat(40);
const isActive = (job) => job.state === 'queued' || job.state === 'running';

const demoError = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const clone = (value) => JSON.parse(JSON.stringify(value));

let sequence = 40;
let agent = {
  configured: true,
  tokenCreatedAt: at(-30 * 24 * HOUR),
  status: {
    scriptsCommit: '54cdb9e7a1b2c3d4e5f60718293a4b5c6d7e8f90',
    mailcowVersion: '2026-09',
    containers: { total: 18, running: 18, problems: [] },
    backup: {
      configured: true, ok: true, problem: null,
      last: { finishedAt: at(-9 * HOUR), tag: 'nightly', seconds: 412, dumpBytes: 48234496, processedBytes: 6979321856, addedBytes: 73400320, partial: false, verified: false },
    },
  },
  statusAt: at(-4 * MINUTE),
};
let jobs = [
  {
    id: '39', kind: 'backup', params: { tag: 'manual' }, state: 'succeeded', step: 'done', error: null,
    logTail: '[mailexpert] dump: 46 MB in 38s\n[mailexpert] restic: 6.5 GB processed, 70 MB added\n[mailexpert] backup done in 402s',
    createdAt: at(-3 * 24 * HOUR), startedAt: at(-3 * 24 * HOUR + 20000), updatedAt: at(-3 * 24 * HOUR + 422000), finishedAt: at(-3 * 24 * HOUR + 422000),
  },
];

// A running demo backup finishes once its time is up, with the node's report updated.
function advance() {
  const now = Date.now();
  jobs = jobs.map((job) => {
    if (job.state !== 'running' || now - Date.parse(job.startedAt) < DEMO_BACKUP_MS) return job;
    const finishedAt = new Date(now).toISOString();
    if (job.kind === 'backup') agent.status.backup.last = { ...agent.status.backup.last, finishedAt, tag: 'manual', seconds: 6 };
    agent.statusAt = finishedAt;
    if (job.kind === 'update') {
      agent.status.scriptsCommit = job.params.sha;
      agent.status.backup.last = { ...agent.status.backup.last, finishedAt, tag: 'pre-update', seconds: 5 };
      return {
        ...job, state: 'succeeded', step: `the node's scripts are at ${job.params.sha.slice(0, 12)}`, finishedAt, updatedAt: finishedAt,
        logTail: `${job.logTail}\n== setup.sh at ${job.params.sha.slice(0, 12)}\n[mailexpert] nothing to change\n== check: eop-ranges.sh (firewall and ports)`,
      };
    }
    return {
      ...job, state: 'succeeded', step: 'done', finishedAt, updatedAt: finishedAt,
      logTail: `${job.logTail}\n[mailexpert] restic: 6.5 GB processed, 12 MB added\n[mailexpert] backup done in 6s`,
    };
  });
}

function state() {
  advance();
  return {
    configured: agent.configured,
    tokenCreatedAt: agent.configured ? agent.tokenCreatedAt : null,
    connected: agent.configured,
    lastSeenAt: agent.configured ? new Date(Date.now() - 20000).toISOString() : null,
    status: agent.status,
    statusAt: agent.statusAt,
    panelCommit: DEMO_PANEL_COMMIT,
    jobs: jobs.slice(0, 10),
  };
}

// The node's part of a panel update (GET /admin/update -> node).
export function demoNodeUpdateState() {
  advance();
  return clone({
    configured: agent.configured,
    connected: agent.configured,
    scriptsCommit: agent.status.scriptsCommit,
    panelCommit: DEMO_PANEL_COMMIT,
    job: jobs.find((job) => job.kind === 'update') ?? null,
  });
}

export function demoNodeAgentRequest(verb, pathname, body) {
  if (verb === 'GET' && pathname === '/mail-node/agent') return clone(state());
  if (verb === 'POST' && pathname === '/mail-node/agent/token') {
    const rotated = agent.configured;
    agent = { ...agent, configured: true, tokenCreatedAt: new Date().toISOString() };
    // Not a working token: the demo has no node behind it.
    return { token: `mxna_demo${Math.random().toString(36).slice(2).padEnd(12, '0')}notarealtoken0000000000`, createdAt: agent.tokenCreatedAt, rotated };
  }
  if (verb === 'DELETE' && pathname === '/mail-node/agent/token') {
    const revoked = agent.configured;
    agent = { ...agent, configured: false };
    jobs = jobs.map((job) => (job.state === 'queued' || job.state === 'running'
      ? { ...job, state: 'failed', error: 'agent_revoked', finishedAt: new Date().toISOString() } : job));
    return { revoked };
  }
  if (verb === 'POST' && pathname === '/mail-node/agent/jobs') {
    const kind = body?.kind;
    if (kind !== 'backup' && kind !== 'status' && kind !== 'update') throw demoError('Unknown job kind', 'job_kind_invalid');
    if (!agent.configured) throw demoError('The node agent is not connected: issue its token first', 'agent_not_set_up', 409);
    advance();
    const exclusive = kind === 'backup' || kind === 'update' ? ['backup', 'update'] : [kind];
    if (jobs.some((job) => exclusive.includes(job.kind) && isActive(job))) {
      throw demoError('A job of this kind, a backup or an update is already waiting or running', 'job_active', 409);
    }
    const now = new Date().toISOString();
    sequence += 1;
    const params = { backup: { tag: 'manual' }, update: { sha: DEMO_PANEL_COMMIT }, status: {} }[kind];
    const steps = { backup: 'dump', update: 'node-backup.sh --tag pre-update', status: 'status' };
    const logs = {
      backup: '[mailexpert] dump: mailcow backup_and_restore.sh',
      update: '== git fetch origin\n== node-backup.sh --tag pre-update\n[mailexpert] dump: mailcow backup_and_restore.sh',
      status: null,
    };
    const job = {
      id: String(sequence), kind, params, state: 'running', step: steps[kind], error: null, logTail: logs[kind],
      createdAt: now, startedAt: now, updatedAt: now, finishedAt: null,
    };
    jobs = [job, ...jobs];
    return clone({ job: { ...job, state: 'queued', startedAt: null } });
  }
  return undefined;
}
