import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { recordAudit } from '../services/auditLog.js';
import { consume as rlConsume, peek as rlPeek } from '../services/rateLimiter.js';
import {
  MAX_POLL_WAIT_MS,
  NodeAgentError,
  authenticateAgent,
  bearerToken,
  enqueueJob,
  enqueueNodeUpdate,
  failOrphanedJobs,
  getAgentState,
  issueToken,
  listJobs,
  panelCommit,
  recordStatus,
  reportJob,
  revokeToken,
  waitForJob,
} from '../services/mailNode/nodeAgent.js';

// The mail node's agent (services/mailNode/nodeAgent.js), two routers:
// - the default export, mounted at /api/mail-node next to routes/mailNode.js, for administrators:
//   the agent's state and last status report, its token (issued or rotated, shown once; revoked),
//   its recent jobs, "Back up mail now" and "Update node now" (the node's scripts to the panel's
//   own commit). Every change is journaled.
// - agentRouter, mounted at /api/node-agent before the session, the identity gate and the CSRF
//   check (index.js): the agent on the node, authenticated only by its bearer token. It long-polls
//   for the next job, reports a job's progress and result, and sends its status report.
const ERRORS = {
  agent_unauthorized: [401, 'Unauthorized'],
  agent_not_set_up: [409, 'The node agent is not connected: issue its token first'],
  job_active: [409, 'A job of this kind, a backup or an update is already waiting or running'],
  panel_version_unknown: [409, 'This panel build does not know its commit: the node cannot be updated to it'],
  job_kind_invalid: [400, 'Unknown job kind'],
  job_state_invalid: [400, 'Invalid job state'],
  job_not_found: [404, 'No such job'],
  job_not_running: [409, 'The job is not running'],
};

function refuse(res, code) {
  const [status, error] = ERRORS[code] ?? [500, 'Node agent error'];
  return res.status(status).json({ error, code });
}

function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof NodeAgentError) return refuse(res, err.code);
      return next(err);
    }
  };
}

const router = Router();
router.use(requireAuth);

router.get('/agent', requireAdmin, handle(async (_req, res) => {
  const [state, jobs] = await Promise.all([getAgentState(), listJobs(10)]);
  // panelCommit: what "Update node now" brings the node's scripts to (null on a build without one).
  res.json({ ...state, panelCommit: panelCommit(), jobs });
}));

router.get('/agent/jobs', requireAdmin, handle(async (req, res) => {
  res.json({ jobs: await listJobs(req.query.limit) });
}));

// The token is in this answer only; the database keeps its hash.
router.post('/agent/token', requireAdmin, handle(async (req, res) => {
  const { token, createdAt, rotated } = await issueToken(req.session.userId);
  recordAudit({ actorUserId: req.session.userId, action: 'mail_node.agent_token_issued', details: { rotated } });
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ token, createdAt, rotated });
}));

router.delete('/agent/token', requireAdmin, handle(async (req, res) => {
  const revoked = await revokeToken();
  if (revoked) recordAudit({ actorUserId: req.session.userId, action: 'mail_node.agent_token_revoked', details: {} });
  res.json({ revoked });
}));

router.post('/agent/jobs', requireAdmin, handle(async (req, res) => {
  const kind = req.body?.kind;
  // An update's commit is the panel's own; nothing of the request reaches the agent's parameters.
  const job = kind === 'update'
    ? await enqueueNodeUpdate({ createdBy: req.session.userId })
    : await enqueueJob({ kind, params: kind === 'backup' ? { tag: 'manual' } : {}, createdBy: req.session.userId });
  const details = { kind, jobId: job.id };
  if (kind === 'update') details.sha = job.params.sha;
  recordAudit({ actorUserId: req.session.userId, action: 'mail_node.agent_job_requested', details });
  res.status(202).json({ job });
}));

export default router;

// --- The agent's side ---------------------------------------------------------------------------

export const agentRouter = Router();

// Refused tokens per client address: this many per window, then 429 until it ends.
export const AGENT_AUTH_FAILURES = 20;
const AGENT_AUTH_WINDOW_MS = 10 * 60 * 1000;

// Only the bearer token counts here: no session, no cookie. A refusal says nothing about why.
agentRouter.use(async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const key = `node-agent-auth:${req.ip}`;
  try {
    if ((await rlPeek(key, AGENT_AUTH_FAILURES, AGENT_AUTH_WINDOW_MS)).limited) {
      return res.status(429).json({ error: 'Too many requests', code: 'agent_rate_limited' });
    }
    const hash = await authenticateAgent(bearerToken(req.get('authorization')));
    if (hash) {
      req.agentTokenHash = hash;
      return next();
    }
    await rlConsume(key, AGENT_AUTH_FAILURES, AGENT_AUTH_WINDOW_MS);
    return res.status(401).json({ error: 'Unauthorized', code: 'agent_unauthorized' });
  } catch (err) {
    return next(err);
  }
});

// One long poll at a time (there is one agent): a new poll ends the one before with 204.
let currentPoll = null;

// The long poll: one queued job (now running), or 204 after up to 50 seconds (?wait=<seconds>).
// GET only: HEAD would claim a job and drop its body.
agentRouter.get('/next', handle(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).set('Allow', 'GET').end();
  const seconds = Number.parseInt(req.query.wait, 10);
  const waitMs = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0) * 1000, MAX_POLL_WAIT_MS) : MAX_POLL_WAIT_MS;
  const controller = new AbortController();
  let gone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      gone = true;
      controller.abort();
    }
  });
  currentPoll?.abort();
  currentPoll = controller;
  try {
    await failOrphanedJobs(req.agentTokenHash);
    const job = await waitForJob({ tokenHash: req.agentTokenHash, waitMs, signal: controller.signal });
    if (gone) return undefined;
    if (!job) return res.status(204).end();
    return res.json({ id: job.id, kind: job.kind, params: job.params });
  } finally {
    if (currentPoll === controller) currentPoll = null;
  }
}));

agentRouter.post('/jobs/:id', handle(async (req, res) => {
  const job = await reportJob(req.params.id, req.body, req.agentTokenHash);
  res.json({ id: job.id, state: job.state });
}));

agentRouter.post('/status', handle(async (req, res) => {
  await recordStatus(req.body, req.agentTokenHash);
  res.json({ ok: true });
}));

// Anything else under /api/node-agent: nothing to find, and not passed on to the user routes.
agentRouter.use((_req, res) => res.status(404).json({ error: 'Not found' }));
