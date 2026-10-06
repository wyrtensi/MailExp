// The demo's mail node agent (backend routes/mailNodeAgent.js): connected, with a status report
// and last night's backup. "Back up mail now" runs a few seconds and finishes; the token routes
// answer as the server does (a token shown once, a rotation, a revocation), with its refusals.

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const START = Date.now();
const at = (offset) => new Date(START + offset).toISOString();
// A demo backup runs this long before it reports done.
const DEMO_BACKUP_MS = 6000;

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
    jobs: jobs.slice(0, 10),
  };
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
    if (kind !== 'backup' && kind !== 'status') throw demoError('Unknown job kind', 'job_kind_invalid');
    if (!agent.configured) throw demoError('The node agent is not connected: issue its token first', 'agent_not_set_up', 409);
    advance();
    if (jobs.some((job) => job.kind === kind && (job.state === 'queued' || job.state === 'running'))) {
      throw demoError('A job of this kind is already waiting or running', 'job_active', 409);
    }
    const now = new Date().toISOString();
    sequence += 1;
    const job = {
      id: String(sequence), kind, params: kind === 'backup' ? { tag: 'manual' } : {}, state: 'running',
      step: kind === 'backup' ? 'dump' : 'status', error: null,
      logTail: kind === 'backup' ? '[mailexpert] dump: mailcow backup_and_restore.sh' : null,
      createdAt: now, startedAt: now, updatedAt: now, finishedAt: null,
    };
    jobs = [job, ...jobs];
    return clone({ job: { ...job, state: 'queued', startedAt: null } });
  }
  return undefined;
}
