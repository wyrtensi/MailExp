import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { routeActor } from '../services/actor.js';
import { consume as rlConsume, peek as rlPeek } from '../services/rateLimiter.js';
import {
  MAX_POLL_WAIT_MS,
  NodeAgentError,
  authenticateAgent,
  bearerToken,
  failOrphanedJobs,
  listJobs,
  mayBeAgentToken,
  recordStatus,
  reportJob,
  waitForJob,
} from '../services/mailNode/nodeAgent.js';
import {
  NODE_AGENT_ERRORS, agentView, issueAgentToken, requestAgentJob, revokeAgentToken,
} from '../services/mailNode/agentActions.js';

// The mail node's agent (services/mailNode/nodeAgent.js), two routers:
// - the default export, mounted at /api/mail-node next to routes/mailNode.js, for administrators:
//   the agent's state and last status report, its token (issued or rotated, shown once; revoked),
//   its recent jobs, "Back up mail now" and "Update node now" (the node's scripts to the panel's
//   own commit). Every change is journaled (services/mailNode/agentActions.js, which the panel CLI
//   shares).
// - agentRouter, mounted at /api/node-agent before the session, the identity gate and the CSRF
//   check (index.js): the agent on the node, authenticated only by its bearer token. It long-polls
//   for the next job, reports a job's progress and result, and sends its status report.
function refuse(res, code) {
  const [status, error] = NODE_AGENT_ERRORS[code] ?? [500, 'Node agent error'];
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
  res.json(await agentView());
}));

router.get('/agent/jobs', requireAdmin, handle(async (req, res) => {
  res.json({ jobs: await listJobs(req.query.limit) });
}));

// The token is in this answer only; the database keeps its hash.
router.post('/agent/token', requireAdmin, handle(async (req, res) => {
  const issued = await issueAgentToken(routeActor(req));
  res.set('Cache-Control', 'no-store');
  res.status(201).json(issued);
}));

router.delete('/agent/token', requireAdmin, handle(async (req, res) => {
  res.json(await revokeAgentToken(routeActor(req)));
}));

router.post('/agent/jobs', requireAdmin, handle(async (req, res) => {
  res.status(202).json(await requestAgentJob(req.body?.kind, routeActor(req)));
}));

export default router;

// --- The agent's side ---------------------------------------------------------------------------

export const agentRouter = Router();

// Refused tokens: this many per client address per window, and ten times as many from all
// addresses, then refusals answer 429 until the window ends. Only refusals count, and the limit
// never refuses the agent's own token: a client address may be shared (a NAT, or a proxy chain that
// TRUST_PROXY does not match, utils/trustProxy.js), and someone else's wrong tokens must not lock
// the agent out. While the limit holds, a refused token costs no database read
// (mayBeAgentToken); the cap on all addresses bounds those reads when the refusals come from many.
export const AGENT_AUTH_FAILURES = 20;
export const AGENT_AUTH_GLOBAL_FAILURES = 10 * AGENT_AUTH_FAILURES;
const AGENT_AUTH_WINDOW_MS = 10 * 60 * 1000;
export const AGENT_AUTH_GLOBAL_KEY = 'node-agent-auth-all';

// Only the bearer token counts here: no session, no cookie. A refusal says nothing about why.
agentRouter.use(async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const key = `node-agent-auth:${req.ip}`;
  try {
    const token = bearerToken(req.get('authorization'));
    const peeks = await Promise.all([
      rlPeek(key, AGENT_AUTH_FAILURES, AGENT_AUTH_WINDOW_MS),
      rlPeek(AGENT_AUTH_GLOBAL_KEY, AGENT_AUTH_GLOBAL_FAILURES, AGENT_AUTH_WINDOW_MS),
    ]);
    const limited = peeks.some((peek) => peek.limited);
    const hash = !limited || await mayBeAgentToken(token) ? await authenticateAgent(token) : null;
    if (hash) {
      req.agentTokenHash = hash;
      return next();
    }
    if (limited) return res.status(429).json({ error: 'Too many requests', code: 'agent_rate_limited' });
    await rlConsume(key, AGENT_AUTH_FAILURES, AGENT_AUTH_WINDOW_MS);
    await rlConsume(AGENT_AUTH_GLOBAL_KEY, AGENT_AUTH_GLOBAL_FAILURES, AGENT_AUTH_WINDOW_MS);
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
