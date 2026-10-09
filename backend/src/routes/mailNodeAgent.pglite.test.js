import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The mail node agent on the real schema: the token (only its hash stored, rotation and
// revocation), the agent's bearer authentication, the long poll, a job's life and the caps on what
// the agent reports, and the administrators' routes.

const dbState = vi.hoisted(() => ({ db: null, hashReads: 0 }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => {
    if (/SELECT token_hash FROM node_agent WHERE id = 1/.test(sql)) dbState.hashReads += 1;
    return dbState.db.query(sql, params);
  },
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
// The limiter in memory, as it falls back without Redis.
const limits = vi.hoisted(() => new Map());
vi.mock('../services/rateLimiter.js', () => ({
  peek: async (key, max) => ({ limited: (limits.get(key) ?? 0) >= max }),
  consume: async (key, max) => {
    limits.set(key, (limits.get(key) ?? 0) + 1);
    return { limited: limits.get(key) > max };
  },
}));
const auth = vi.hoisted(() => ({ admin: true }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: '60000000-0000-4000-8000-000000000001' }; next(); },
  requireAdmin: (_req, res, next) => (auth.admin ? next() : res.status(403).json({ error: 'Admin only' })),
}));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { default: express } = await import('express');
const { default: adminRoutes, agentRouter } = await import('./mailNodeAgent.js');
const { recordAudit } = await import('../services/auditLog.js');
const {
  hashToken, MAX_LOG_TAIL, MAX_STEP, resetExpiryThrottle, queueNodeUpdateIfBehind, getNodeUpdateState,
  RUNNING_TIMEOUT_MS, UPDATE_CEILING_MS, UPDATE_STEP_BOUNDS_MS, pinnedMailcow, resetStoredHashCopy,
} = await import('../services/mailNode/nodeAgent.js');
const { updateNodeAfterPanel } = await import('../services/panelUpdate/reconcile.js');
const { AGENT_AUTH_FAILURES, AGENT_AUTH_GLOBAL_FAILURES, AGENT_AUTH_GLOBAL_KEY } = await import('./mailNodeAgent.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';
// The commit the panel runs (BUILD_SHA) and an older one the node reports.
const PANEL_SHA = 'feedfacefeedfacefeedfacefeedfacefeedface';
const NODE_SHA = '0123456789abcdef0123456789abcdef01234567';
const PANEL_ENV = { BUILD_SHA: PANEL_SHA };

let db;
let server;
let base;
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/node-agent', agentRouter);
  app.use('/api/mail-node', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
}, 120000);
afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await db?.close();
});
beforeEach(async () => {
  auth.admin = true;
  await db.query('DELETE FROM node_agent_jobs');
  await db.query('DELETE FROM node_agent');
  recordAudit.mockClear();
  limits.clear();
  resetExpiryThrottle();
  resetStoredHashCopy();
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const admin = (method, path, body) => call(method, `/mail-node${path}`, body);
const agent = (token, method, path, body) => call(method, `/node-agent${path}`, body, token ? { Authorization: `Bearer ${token}` } : {});
async function issue() {
  const res = await admin('POST', '/agent/token');
  expect(res.status).toBe(201);
  return res.body.token;
}

describe('the token', () => {
  it('is shown once and stored only as its sha256', async () => {
    const res = await admin('POST', '/agent/token');
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.token).toMatch(/^mxna_[A-Za-z0-9_-]{43}$/);
    expect(res.body.rotated).toBe(false);
    const { rows } = await db.query('SELECT * FROM node_agent');
    expect(rows[0].token_hash).toBe(hashToken(res.body.token));
    expect(JSON.stringify(rows)).not.toContain(res.body.token);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mail_node.agent_token_issued', details: { rotated: false } }));
    const state = await admin('GET', '/agent');
    expect(state.body).toMatchObject({ configured: true, connected: false, lastSeenAt: null });
    expect(JSON.stringify(state.body)).not.toContain(res.body.token);
  });

  it('a rotation ends the old token at once', async () => {
    const old = await issue();
    expect((await agent(old, 'GET', '/next?wait=0')).status).toBe(204);
    const res = await admin('POST', '/agent/token');
    expect(res.body.rotated).toBe(true);
    expect((await agent(old, 'GET', '/next?wait=0')).status).toBe(401);
    expect((await agent(res.body.token, 'GET', '/next?wait=0')).status).toBe(204);
  });

  it('a revocation refuses the agent and fails its jobs', async () => {
    const token = await issue();
    await admin('POST', '/agent/jobs', { kind: 'backup' });
    const revoked = await admin('DELETE', '/agent/token');
    expect(revoked.body).toEqual({ revoked: true });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mail_node.agent_token_revoked' }));
    expect((await agent(token, 'GET', '/next?wait=0')).status).toBe(401);
    const { body } = await admin('GET', '/agent/jobs');
    expect(body.jobs[0]).toMatchObject({ state: 'failed', error: 'agent_revoked' });
    expect((await admin('GET', '/agent')).body.configured).toBe(false);
    expect((await admin('DELETE', '/agent/token')).body).toEqual({ revoked: false });
  });
});

describe('the agent authentication', () => {
  it('takes only a valid bearer token, never a session', async () => {
    const token = await issue();
    expect((await agent(null, 'GET', '/next?wait=0')).status).toBe(401);
    expect((await agent(`${token}x`, 'GET', '/next?wait=0')).status).toBe(401);
    expect((await call('GET', '/node-agent/next?wait=0', undefined, { Authorization: `Basic ${token}` })).status).toBe(401);
    expect((await call('GET', '/node-agent/next?wait=0', undefined, { Cookie: 'connect.sid=s%3Aanything' })).status).toBe(401);
    expect((await agent('short', 'POST', '/status', {})).status).toBe(401);
    const refused = await agent(`${token}x`, 'POST', '/status', { scriptsCommit: 'abc' });
    expect(refused.body).toEqual({ error: 'Unauthorized', code: 'agent_unauthorized' });
    expect((await agent(token, 'GET', '/nothing-here')).status).toBe(404);
  });

  it('refuses everything while no token was issued', async () => {
    expect((await agent('mxna_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'GET', '/next?wait=0')).status).toBe(401);
  });

  it('records the agent as seen: connected', async () => {
    const token = await issue();
    await agent(token, 'GET', '/next?wait=0');
    const { body } = await admin('GET', '/agent');
    expect(body.connected).toBe(true);
    expect(body.lastSeenAt).toBeTruthy();
  });
});

describe('jobs', () => {
  it('the long poll answers a job queued while it waits, as running', async () => {
    const token = await issue();
    const poll = agent(token, 'GET', '/next?wait=10');
    await new Promise((r) => setTimeout(r, 200));
    const queued = await admin('POST', '/agent/jobs', { kind: 'backup' });
    expect(queued.status).toBe(202);
    expect(queued.body.job).toMatchObject({ kind: 'backup', state: 'queued', params: { tag: 'manual' } });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mail_node.agent_job_requested', details: { kind: 'backup', jobId: queued.body.job.id } }));
    const started = Date.now();
    const res = await poll;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: queued.body.job.id, kind: 'backup', params: { tag: 'manual' } });
    const { body } = await admin('GET', '/agent/jobs');
    expect(body.jobs[0]).toMatchObject({ state: 'running' });
    expect(body.jobs[0].startedAt).toBeTruthy();
  });

  it('a poll with nothing queued answers 204', async () => {
    const token = await issue();
    expect((await agent(token, 'GET', '/next?wait=0')).status).toBe(204);
    expect((await agent(token, 'GET', '/next?wait=1')).status).toBe(204);
  });

  it('runs a backup from queued to succeeded, and refuses a second one meanwhile', async () => {
    const token = await issue();
    const { body: { job } } = await admin('POST', '/agent/jobs', { kind: 'backup' });
    const again = await admin('POST', '/agent/jobs', { kind: 'backup' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('job_active');
    // Before the agent took it, it takes no report.
    expect((await agent(token, 'POST', `/jobs/${job.id}`, { state: 'running', step: 'x' })).body.code).toBe('job_not_running');
    await agent(token, 'GET', '/next?wait=0');
    expect((await admin('POST', '/agent/jobs', { kind: 'backup' })).status).toBe(409);
    const progress = await agent(token, 'POST', `/jobs/${job.id}`, { state: 'running', step: 'dump', log: 'line 1\nline 2' });
    expect(progress.body).toEqual({ id: job.id, state: 'running' });
    const done = await agent(token, 'POST', `/jobs/${job.id}`, { state: 'succeeded', step: 'done', log: 'line 1\nline 2\nok' });
    expect(done.body.state).toBe('succeeded');
    const { body } = await admin('GET', '/agent/jobs');
    expect(body.jobs[0]).toMatchObject({ state: 'succeeded', step: 'done', logTail: 'line 1\nline 2\nok', error: null });
    expect(body.jobs[0].finishedAt).toBeTruthy();
    // A finished job takes no more reports; a new backup may be asked for.
    expect((await agent(token, 'POST', `/jobs/${job.id}`, { state: 'failed' })).status).toBe(409);
    expect((await admin('POST', '/agent/jobs', { kind: 'backup' })).status).toBe(202);
  });

  it('a failure keeps the reason', async () => {
    const token = await issue();
    const { body: { job } } = await admin('POST', '/agent/jobs', { kind: 'status' });
    await agent(token, 'GET', '/next?wait=0');
    await agent(token, 'POST', `/jobs/${job.id}`, { state: 'failed', step: 'unknown job kind', error: 'unknown_kind' });
    const { body } = await admin('GET', '/agent/jobs');
    expect(body.jobs[0]).toMatchObject({ state: 'failed', error: 'unknown_kind' });
  });

  it('caps the step and the log tail, keeping the end of the log', async () => {
    const token = await issue();
    const { body: { job } } = await admin('POST', '/agent/jobs', { kind: 'backup' });
    await agent(token, 'GET', '/next?wait=0');
    const log = `${'a'.repeat(MAX_LOG_TAIL)}THE END`;
    await agent(token, 'POST', `/jobs/${job.id}`, { state: 'running', step: 's'.repeat(1000), log });
    const { rows } = await db.query('SELECT step, log_tail FROM node_agent_jobs WHERE id = $1', [job.id]);
    expect(rows[0].step).toHaveLength(MAX_STEP);
    expect(rows[0].log_tail).toHaveLength(MAX_LOG_TAIL);
    expect(rows[0].log_tail.endsWith('THE END')).toBe(true);
  });

  it('refuses bad reports', async () => {
    const token = await issue();
    expect((await agent(token, 'POST', '/jobs/999999', { state: 'running' })).status).toBe(404);
    expect((await agent(token, 'POST', '/jobs/abc', { state: 'running' })).status).toBe(404);
    expect((await agent(token, 'POST', '/jobs/1', { state: 'queued' })).status).toBe(400);
    expect((await agent(token, 'POST', '/jobs/1', { state: 'done' })).status).toBe(400);
  });

  it('fails a job stuck past its bound', async () => {
    await issue();
    const { body: { job } } = await admin('POST', '/agent/jobs', { kind: 'backup' });
    await db.query("UPDATE node_agent_jobs SET state = 'running', started_at = now() - interval '7 hours' WHERE id = $1", [job.id]);
    const queued = await admin('POST', '/agent/jobs', { kind: 'status' });
    await db.query("UPDATE node_agent_jobs SET created_at = now() - interval '2 hours' WHERE id = $1", [queued.body.job.id]);
    resetExpiryThrottle();
    const { body } = await admin('GET', '/agent/jobs');
    const byId = Object.fromEntries(body.jobs.map((j) => [j.id, j]));
    expect(byId[job.id]).toMatchObject({ state: 'failed', error: 'timed_out' });
    expect(byId[queued.body.job.id]).toMatchObject({ state: 'failed', error: 'not_picked_up' });
  });

  it('refuses a job without an agent, and an unknown kind', async () => {
    const none = await admin('POST', '/agent/jobs', { kind: 'backup' });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('agent_not_set_up');
    await issue();
    expect((await admin('POST', '/agent/jobs', { kind: 'reboot' })).status).toBe(400);
    expect((await admin('POST', '/agent/jobs', {})).status).toBe(400);
  });
});

describe('restarts, rotations and polls', () => {
  it('a poll fails the job the agent was running before it restarted, so a new backup may start', async () => {
    const token = await issue();
    const { body: { job } } = await admin('POST', '/agent/jobs', { kind: 'backup' });
    await agent(token, 'GET', '/next?wait=0');
    expect((await admin('POST', '/agent/jobs', { kind: 'backup' })).status).toBe(409);
    expect((await agent(token, 'GET', '/next?wait=0')).status).toBe(204);
    const { body } = await admin('GET', '/agent/jobs');
    expect(body.jobs.find((j) => j.id === job.id)).toMatchObject({ state: 'failed', error: 'agent_restarted' });
    expect((await admin('POST', '/agent/jobs', { kind: 'backup' })).status).toBe(202);
  });

  it('a rotation fails the active jobs; a poll already waiting with the old token claims nothing and its reports are refused', async () => {
    const old = await issue();
    const { body: { job } } = await admin('POST', '/agent/jobs', { kind: 'backup' });
    await agent(old, 'GET', '/next?wait=0');
    const first = await admin('POST', '/agent/token');
    expect(first.body.rotated).toBe(true);
    expect((await agent(old, 'POST', `/jobs/${job.id}`, { state: 'succeeded' })).status).toBe(401);
    expect((await admin('GET', '/agent/jobs')).body.jobs[0]).toMatchObject({ id: job.id, state: 'failed', error: 'agent_token_rotated' });
    // A poll waiting with a token that is rotated meanwhile takes no job queued after the rotation.
    const poll = agent(first.body.token, 'GET', '/next?wait=2');
    await new Promise((r) => setTimeout(r, 200));
    const rotated = await admin('POST', '/agent/token');
    const { body: { job: next } } = await admin('POST', '/agent/jobs', { kind: 'backup' });
    expect((await poll).status).toBe(204);
    expect((await admin('GET', '/agent/jobs')).body.jobs[0]).toMatchObject({ id: next.id, state: 'queued' });
    const claimed = await agent(rotated.body.token, 'GET', '/next?wait=0');
    expect(claimed.body.id).toBe(next.id);
  });

  it('a new poll ends the one before', async () => {
    const token = await issue();
    const first = agent(token, 'GET', '/next?wait=10');
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    const second = agent(token, 'GET', '/next?wait=1');
    expect((await first).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await second).status).toBe(204);
  });

  it('HEAD on next is refused and claims nothing', async () => {
    const token = await issue();
    await admin('POST', '/agent/jobs', { kind: 'backup' });
    const res = await fetch(`${base}/node-agent/next?wait=0`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(405);
    const { body } = await admin('GET', '/agent/jobs');
    expect(body.jobs[0].state).toBe('queued');
  });

  it('too many refused tokens from one address answer 429, but never to the valid token', async () => {
    const token = await issue();
    const wrong = 'mxna_wrongwrongwrongwrongwrongwrong';
    for (let i = 0; i < AGENT_AUTH_FAILURES; i += 1) {
      expect((await agent(wrong, 'GET', '/next?wait=0')).status).toBe(401);
    }
    const limited = await agent(wrong, 'GET', '/next?wait=0');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests', code: 'agent_rate_limited' });
    expect((await agent(null, 'GET', '/next?wait=0')).status).toBe(429);
    expect((await agent(token, 'GET', '/next?wait=0')).status).toBe(204);
    expect((await agent(token, 'POST', '/status', {})).status).toBe(200);
    // Still limited for the wrong token after the valid one went through.
    expect((await agent(wrong, 'GET', '/next?wait=0')).status).toBe(429);
  });

  it('counts refusals only, per address and from all addresses', async () => {
    const token = await issue();
    await agent(token, 'GET', '/next?wait=0');
    expect([...limits.values()].every((count) => count === 0)).toBe(true);
    await agent('mxna_wrongwrongwrongwrongwrongwrong', 'GET', '/next?wait=0');
    expect(limits.get(AGENT_AUTH_GLOBAL_KEY)).toBe(1);
    expect([...limits.entries()].filter(([key]) => key.startsWith('node-agent-auth:'))).toEqual([
      [expect.stringMatching(/^node-agent-auth:.+/), 1],
    ]);
  });

  it('the cap on all addresses answers 429 to refusals, not to the valid token', async () => {
    const token = await issue();
    limits.set(AGENT_AUTH_GLOBAL_KEY, AGENT_AUTH_GLOBAL_FAILURES);
    expect((await agent('mxna_wrongwrongwrongwrongwrongwrong', 'GET', '/next?wait=0')).status).toBe(429);
    expect((await agent(token, 'GET', '/next?wait=0')).status).toBe(204);
  });

  it('while limited, refusals read the stored hash at most once a second, and a revoked token stays refused', async () => {
    const token = await issue();
    limits.set(AGENT_AUTH_GLOBAL_KEY, AGENT_AUTH_GLOBAL_FAILURES);
    dbState.hashReads = 0;
    for (let i = 0; i < 10; i += 1) {
      expect((await agent(`mxna_wrong${String(i).padStart(30, 'x')}`, 'GET', '/next?wait=0')).status).toBe(429);
    }
    expect(dbState.hashReads).toBe(1);
    expect((await admin('DELETE', '/agent/token')).status).toBe(200);
    // The copy still holds the revoked hash; authenticateAgent reads it afresh and refuses.
    expect((await agent(token, 'GET', '/next?wait=0')).status).toBe(429);
    resetStoredHashCopy();
    const fresh = await issue();
    expect((await agent(fresh, 'GET', '/next?wait=0')).status).toBe(204);
  });
});

describe('the status report', () => {
  it('keeps known fields only, capped', async () => {
    const token = await issue();
    const res = await agent(token, 'POST', '/status', {
      scriptsCommit: '0123456789abcdef0123456789abcdef01234567',
      mailcowVersion: '2026-09',
      mailcowCommit: 'ca07d8d3331849ae294179aedce95c8126d3050f',
      mailcowTag: '2026-09',
      mailcowPinTag: '2026-09a; rm -rf /',
      mailcowPinCommit: '81f6f7b002f2681b732aed74ae53179377def5e0',
      mailcowUpstreamCommit: 'not a commit',
      mailcowRelation: 'behind',
      containers: { total: 18, running: 17, problems: ['clamd-mailcow: exited', 42, 'x'.repeat(300)] },
      backup: {
        configured: true, ok: false, problem: 'the last backup is 30 hours old',
        last: { finished_at: '2026-10-05T02:41:00Z', tag: 'nightly', seconds: 640, processed_bytes: 5368709120, added_bytes: 1048576, partial: false, verified: true, snapshot: 'abc', secret: 'nope' },
      },
      extra: 'dropped',
    });
    expect(res.status).toBe(200);
    const { body } = await admin('GET', '/agent');
    expect(body.statusAt).toBeTruthy();
    expect(body.status).toEqual({
      scriptsCommit: '0123456789abcdef0123456789abcdef01234567',
      mailcowVersion: '2026-09',
      mailcowCommit: 'ca07d8d3331849ae294179aedce95c8126d3050f',
      mailcowTag: '2026-09',
      mailcowPinTag: null,
      mailcowPinCommit: '81f6f7b002f2681b732aed74ae53179377def5e0',
      mailcowUpstreamCommit: null,
      mailcowRelation: 'behind',
      containers: { total: 18, running: 17, problems: ['clamd-mailcow: exited', 'x'.repeat(100)] },
      backup: {
        configured: true, ok: false, problem: 'the last backup is 30 hours old',
        last: { finishedAt: '2026-10-05T02:41:00.000Z', tag: 'nightly', seconds: 640, dumpBytes: null, processedBytes: 5368709120, addedBytes: 1048576, partial: false, verified: true },
      },
    });
  });

  it('takes a report that is not an object', async () => {
    const token = await issue();
    expect((await agent(token, 'POST', '/status', ['x'])).status).toBe(200);
    const { body } = await admin('GET', '/agent');
    expect(body.status.backup).toEqual({ configured: false, ok: false, problem: null, last: null });
    expect(body.status.mailcowRelation).toBe('unknown');
    // The panel's own pin, from the repository's deploy/mailcow-version.
    expect(body.pinnedMailcow).toEqual(pinnedMailcow());
    expect(body.pinnedMailcow.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('the administrators routes', () => {
  it('are for administrators only', async () => {
    auth.admin = false;
    for (const [method, path, body] of [
      ['GET', '/agent'], ['GET', '/agent/jobs'], ['POST', '/agent/token'], ['DELETE', '/agent/token'],
      ['POST', '/agent/jobs', { kind: 'backup' }], ['POST', '/agent/jobs', { kind: 'update' }],
    ]) {
      expect((await admin(method, path, body)).status).toBe(403);
    }
    expect(recordAudit).not.toHaveBeenCalled();
    const { rows } = await db.query('SELECT * FROM node_agent');
    expect(rows).toHaveLength(0);
  });
});

describe('the node update', () => {
  const previousSha = process.env.BUILD_SHA;
  beforeEach(() => { process.env.BUILD_SHA = PANEL_SHA; });
  afterAll(() => {
    if (previousSha === undefined) delete process.env.BUILD_SHA;
    else process.env.BUILD_SHA = previousSha;
  });

  // A connected agent whose last status report names the given scripts commit.
  async function connectedAgent(scriptsCommit = NODE_SHA) {
    const token = await issue();
    expect((await agent(token, 'POST', '/status', { scriptsCommit })).status).toBe(200);
    return token;
  }
  const updateJobs = async () => (await db.query("SELECT * FROM node_agent_jobs WHERE kind = 'update' ORDER BY id")).rows;

  it('is queued after a panel update when the node runs another commit, once per commit', async () => {
    await connectedAgent();
    const results = [{ action: 'update', state: 'succeeded', target: 'sha-feedfacefeed' }];
    const job = await updateNodeAfterPanel(results, { version: 'sha-feedfacefeed', queue: () => queueNodeUpdateIfBehind({ env: PANEL_ENV }), recordAudit });
    expect(job).toMatchObject({ kind: 'update', state: 'queued', params: { sha: PANEL_SHA, automatic: true } });
    expect(recordAudit).toHaveBeenCalledWith([expect.objectContaining({
      action: 'mail_node.agent_job_requested', actorUserId: null,
      details: { kind: 'update', jobId: job.id, sha: PANEL_SHA, automatic: true },
    })]);
    // The pass every 30 s asks again: no second job, whether the first is waiting or failed.
    expect(await queueNodeUpdateIfBehind({ env: PANEL_ENV })).toBeNull();
    await db.query("UPDATE node_agent_jobs SET state = 'failed', error = 'rolled_back' WHERE id = $1", [job.id]);
    expect(await queueNodeUpdateIfBehind({ env: PANEL_ENV })).toBeNull();
    expect(await updateJobs()).toHaveLength(1);
  });

  it('is not queued when the panel update did not succeed to this version, or nothing differs', async () => {
    await connectedAgent();
    const queue = () => queueNodeUpdateIfBehind({ env: PANEL_ENV });
    expect(await updateNodeAfterPanel([{ state: 'rolled_back', target: 'sha-feedfacefeed' }], { version: 'sha-feedfacefeed', queue, recordAudit })).toBeNull();
    expect(await updateNodeAfterPanel([{ state: 'succeeded', target: 'sha-111111111111' }], { version: 'sha-feedfacefeed', queue, recordAudit })).toBeNull();
    expect(await updateNodeAfterPanel([{ state: 'succeeded', target: 'sha-feedfacefeed' }], { version: null, queue, recordAudit })).toBeNull();
    // Only the newest update counts: an older success to this version (before a rollback) does not.
    expect(await updateNodeAfterPanel([
      { state: 'succeeded', target: 'sha-111111111111' }, { state: 'succeeded', target: 'sha-feedfacefeed' },
    ], { version: 'sha-feedfacefeed', queue, recordAudit })).toBeNull();
    expect(await queueNodeUpdateIfBehind({ env: {} })).toBeNull();
    expect(await updateJobs()).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalledWith([expect.objectContaining({ action: 'mail_node.agent_job_requested' })]);
  });

  it('is not queued when the node already runs the commit, reports none, or the agent is away', async () => {
    const token = await connectedAgent(PANEL_SHA);
    expect(await queueNodeUpdateIfBehind({ env: PANEL_ENV })).toBeNull();
    await agent(token, 'POST', '/status', { scriptsCommit: 'unknown' });
    expect(await queueNodeUpdateIfBehind({ env: PANEL_ENV })).toBeNull();
    await agent(token, 'POST', '/status', { scriptsCommit: NODE_SHA });
    await db.query("UPDATE node_agent SET last_seen_at = now() - interval '10 minutes'");
    expect(await queueNodeUpdateIfBehind({ env: PANEL_ENV })).toBeNull();
    expect(await updateJobs()).toHaveLength(0);
  });

  it('waits while a backup runs and is queued by a later pass', async () => {
    const token = await connectedAgent();
    const { body: { job: backup } } = await admin('POST', '/agent/jobs', { kind: 'backup' });
    expect(await queueNodeUpdateIfBehind({ env: PANEL_ENV })).toBeNull();
    await agent(token, 'GET', '/next?wait=0');
    await agent(token, 'POST', `/jobs/${backup.id}`, { state: 'succeeded' });
    expect(await queueNodeUpdateIfBehind({ env: PANEL_ENV })).toMatchObject({ kind: 'update' });
  });

  it('"Update node now" queues the panel own commit, journaled; refused while a backup or an update is active', async () => {
    const token = await connectedAgent();
    const res = await admin('POST', '/agent/jobs', { kind: 'update', params: { sha: NODE_SHA } });
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ kind: 'update', state: 'queued', params: { sha: PANEL_SHA } });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: ADMIN, action: 'mail_node.agent_job_requested', details: { kind: 'update', jobId: res.body.job.id, sha: PANEL_SHA },
    }));
    for (const kind of ['update', 'backup']) {
      const busy = await admin('POST', '/agent/jobs', { kind });
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('job_active');
    }
    const claimed = await agent(token, 'GET', '/next?wait=0');
    expect(claimed.body).toEqual({ id: res.body.job.id, kind: 'update', params: { sha: PANEL_SHA } });
    await agent(token, 'POST', `/jobs/${res.body.job.id}`, { state: 'failed', error: 'rolled_back' });
    // A failed update is tried again by the button only.
    expect((await admin('POST', '/agent/jobs', { kind: 'update' })).status).toBe(202);
  });

  it('an update is refused while a backup is active', async () => {
    await connectedAgent();
    await admin('POST', '/agent/jobs', { kind: 'backup' });
    const busy = await admin('POST', '/agent/jobs', { kind: 'update' });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('job_active');
  });

  it('"Update node now" is refused on a build that does not know its commit', async () => {
    await connectedAgent();
    process.env.BUILD_SHA = 'dev';
    const res = await admin('POST', '/agent/jobs', { kind: 'update' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('panel_version_unknown');
    expect(await updateJobs()).toHaveLength(0);
  });

  it('a running update that reports survives the agent poll after its restart; a silent one fails', async () => {
    const token = await connectedAgent();
    const { body: { job } } = await admin('POST', '/agent/jobs', { kind: 'update' });
    await agent(token, 'GET', '/next?wait=0');
    await agent(token, 'POST', `/jobs/${job.id}`, { state: 'running', step: 'setup.sh' });
    expect((await agent(token, 'GET', '/next?wait=0')).status).toBe(204);
    expect((await updateJobs())[0]).toMatchObject({ state: 'running', step: 'setup.sh' });
    await db.query("UPDATE node_agent_jobs SET updated_at = now() - interval '6 minutes' WHERE id = $1", [job.id]);
    await agent(token, 'GET', '/next?wait=0');
    expect((await updateJobs())[0]).toMatchObject({ state: 'failed', error: 'agent_restarted' });
  });

  it('an update is judged by its reports: alive after hours, failed when silent or past its ceiling', async () => {
    const token = await connectedAgent();
    const { body: { job } } = await admin('POST', '/agent/jobs', { kind: 'update' });
    await agent(token, 'GET', '/next?wait=0');
    // A long pre-update backup: started 7 hours ago, reported a minute ago.
    await db.query("UPDATE node_agent_jobs SET started_at = now() - interval '7 hours', updated_at = now() - interval '1 minute' WHERE id = $1", [job.id]);
    resetExpiryThrottle();
    await admin('GET', '/agent/jobs');
    expect((await updateJobs())[0]).toMatchObject({ state: 'running' });
    // Busy meanwhile: no backup and no second update.
    expect((await admin('POST', '/agent/jobs', { kind: 'backup' })).status).toBe(409);
    expect((await agent(token, 'POST', `/jobs/${job.id}`, { state: 'running', step: 'still here' })).status).toBe(200);
    // Silent past the heartbeat bound: the node lost it.
    await db.query("UPDATE node_agent_jobs SET updated_at = now() - interval '6 minutes' WHERE id = $1", [job.id]);
    resetExpiryThrottle();
    await admin('GET', '/agent/jobs');
    expect((await updateJobs())[0]).toMatchObject({ state: 'failed', error: 'update_silent' });
  });

  it('an update past its ceiling fails even while it reports', async () => {
    const token = await connectedAgent();
    const { body: { job } } = await admin('POST', '/agent/jobs', { kind: 'update' });
    await agent(token, 'GET', '/next?wait=0');
    expect(UPDATE_CEILING_MS).toBe(Object.values(UPDATE_STEP_BOUNDS_MS).reduce((x, y) => x + y, 0));
    expect(UPDATE_CEILING_MS).toBeGreaterThan(RUNNING_TIMEOUT_MS.backup + 60 * 60 * 1000);
    await db.query(
      "UPDATE node_agent_jobs SET started_at = now() - ($2::double precision * interval '1 millisecond') - interval '1 minute', updated_at = now() WHERE id = $1",
      [job.id, UPDATE_CEILING_MS]
    );
    resetExpiryThrottle();
    await admin('GET', '/agent/jobs');
    expect((await updateJobs())[0]).toMatchObject({ state: 'failed', error: 'timed_out' });
  });

  it('the panel update screen gets the node part', async () => {
    await connectedAgent();
    expect(await getNodeUpdateState({ env: PANEL_ENV })).toEqual({
      configured: true, connected: true, scriptsCommit: NODE_SHA, panelCommit: PANEL_SHA, job: null,
      mailcow: { commit: null, tag: null, relation: 'unknown' }, pinnedMailcow: pinnedMailcow(),
    });
    await admin('POST', '/agent/jobs', { kind: 'update' });
    const state = await getNodeUpdateState({ env: PANEL_ENV });
    expect(state.job).toMatchObject({ kind: 'update', state: 'queued', params: { sha: PANEL_SHA } });
  });
});
