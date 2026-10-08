import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import {
  enqueueJob, enqueueNodeUpdate, getAgentState, issueToken, listJobs, panelCommit, pinnedMailcow, revokeToken,
} from './nodeAgent.js';

// The administrator's actions on the mail node's agent (services/mailNode/nodeAgent.js) that
// routes/mailNodeAgent.js and the panel CLI (src/cli/mailexpert.js) share. A refusal is a
// NodeAgentError with a code of NODE_AGENT_ERRORS. actor: services/actor.js.

// code -> [HTTP status, message], as the routes answer them.
export const NODE_AGENT_ERRORS = Object.freeze({
  agent_unauthorized: [401, 'Unauthorized'],
  agent_not_set_up: [409, 'The node agent is not connected: issue its token first'],
  job_active: [409, 'A job of this kind, a backup or an update is already waiting or running'],
  panel_version_unknown: [409, 'This panel build does not know its commit: the node cannot be updated to it'],
  job_kind_invalid: [400, 'Unknown job kind'],
  job_state_invalid: [400, 'Invalid job state'],
  job_not_found: [404, 'No such job'],
  job_not_running: [409, 'The job is not running'],
});

// GET /api/mail-node/agent: the agent's state and last status report, its recent jobs; panelCommit:
// what "Update node now" brings the node's scripts to (null on a build without one); pinnedMailcow:
// the mailcow version this release is tested with (deploy/mailcow-version).
export async function agentView() {
  const [state, jobs] = await Promise.all([getAgentState(), listJobs(10)]);
  return { ...state, panelCommit: panelCommit(), pinnedMailcow: pinnedMailcow(), jobs };
}

// Issues the agent's token, or rotates it (the old one ends at once, its jobs fail). The token is in
// this answer only; the database keeps its hash. Answers { token, createdAt, rotated }.
export async function issueAgentToken(actor) {
  const { token, createdAt, rotated } = await issueToken(actor?.userId ?? null);
  recordAudit(auditOf(actor, { action: 'mail_node.agent_token_issued', details: { rotated } }));
  return { token, createdAt, rotated };
}

// Revokes the token: the agent is refused from its next request. Answers { revoked } (whether there
// was a token); journaled only when there was one.
export async function revokeAgentToken(actor) {
  const revoked = await revokeToken();
  if (revoked) recordAudit(auditOf(actor, { action: 'mail_node.agent_token_revoked', details: {} }));
  return { revoked };
}

// "Back up mail now", "Update node now" and a status report: queues a job for the agent. An
// update's commit is the panel's own; nothing of the request reaches the agent's parameters.
// Answers { job }.
export async function requestAgentJob(kind, actor) {
  const createdBy = actor?.userId ?? null;
  const job = kind === 'update'
    ? await enqueueNodeUpdate({ createdBy })
    : await enqueueJob({ kind, params: kind === 'backup' ? { tag: 'manual' } : {}, createdBy });
  const details = { kind, jobId: job.id };
  if (kind === 'update') details.sha = job.params.sha;
  recordAudit(auditOf(actor, { action: 'mail_node.agent_job_requested', details }));
  return { job };
}
