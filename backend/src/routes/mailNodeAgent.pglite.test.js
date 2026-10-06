import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The mail node agent on the real schema: the token (only its hash stored, rotation and
// revocation), the agent's bearer authentication, the long poll, a job's life and the caps on what
// the agent reports, and the administrators' routes.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
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
const { hashToken, MAX_LOG_TAIL, MAX_STEP } = await import('../services/mailNode/nodeAgent.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';

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
    expect((await admin('POST', '/agent/jobs', { kind: 'update' })).status).toBe(400);
    expect((await admin('POST', '/agent/jobs', {})).status).toBe(400);
  });
});

describe('the status report', () => {
  it('keeps known fields only, capped', async () => {
    const token = await issue();
    const res = await agent(token, 'POST', '/status', {
      scriptsCommit: '0123456789abcdef0123456789abcdef01234567',
      mailcowVersion: '2026-09',
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
  });
});

describe('the administrators routes', () => {
  it('are for administrators only', async () => {
    auth.admin = false;
    for (const [method, path, body] of [
      ['GET', '/agent'], ['GET', '/agent/jobs'], ['POST', '/agent/token'], ['DELETE', '/agent/token'],
      ['POST', '/agent/jobs', { kind: 'backup' }],
    ]) {
      expect((await admin(method, path, body)).status).toBe(403);
    }
    expect(recordAudit).not.toHaveBeenCalled();
    const { rows } = await db.query('SELECT * FROM node_agent');
    expect(rows).toHaveLength(0);
  });
});
