// Pure helpers for the node agent section (components/MailNodeAgentSection.jsx). The state comes
// from GET /api/mail-node/agent (backend services/mailNode/nodeAgent.js).

// Where the setup instructions save the token on the node: root's, 0600.
export const AGENT_TOKEN_FILE = '/root/mailexpert-agent-token';

// The panel's address as the node reaches it: the origin the administrator has open.
export function panelUrl(origin) {
  const url = String(origin ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+$/.test(url) ? url : 'https://<PANEL_HOST>';
}

// The commands that connect the node, for root or a sudo user: the token saved into a 0600 file
// first (never on a command line, where the shell history and the process list would keep it),
// then setup.sh, then the file removed.
export function agentSetupCommands(origin, tokenFile = AGENT_TOKEN_FILE) {
  return [
    `sudo sh -c 'umask 077 && cat > ${tokenFile}'`,
    `sudo scripts/deploy/mail-node/setup.sh --panel-url ${panelUrl(origin)} --agent-token-file ${tokenFile}`,
    `sudo rm ${tokenFile}`,
  ];
}

// not_set_up: no token issued (or revoked); waiting: a token, but the agent has not called yet
// (or not lately); connected.
export function agentConnection(state) {
  if (!state?.configured) return 'not_set_up';
  return state.connected ? 'connected' : 'waiting';
}

export const AGENT_CONNECTION_KEYS = Object.freeze({
  not_set_up: 'admin.nodeAgent.stateNotSetUp',
  waiting: 'admin.nodeAgent.stateWaiting',
  connected: 'admin.nodeAgent.stateConnected',
});

const isActive = (job) => job?.state === 'queued' || job?.state === 'running';

// The job of a kind still queued or running, or null.
export function activeJob(jobs, kind) {
  return (Array.isArray(jobs) ? jobs : []).find((job) => job?.kind === kind && isActive(job)) ?? null;
}

// A backup or an update still queued or running: the server takes one of them at a time.
export function nodeBusyJob(jobs) {
  return activeJob(jobs, 'update') ?? activeJob(jobs, 'backup');
}

// The newest job of a kind, whatever its state.
export function latestJob(jobs, kind) {
  return (Array.isArray(jobs) ? jobs : []).find((job) => job?.kind === kind) ?? null;
}

export const JOB_STATE_KEYS = Object.freeze({
  queued: 'admin.nodeAgent.jobQueued',
  running: 'admin.nodeAgent.jobRunning',
  succeeded: 'admin.nodeAgent.jobSucceeded',
  failed: 'admin.nodeAgent.jobFailed',
});

export const JOB_ERROR_KEYS = Object.freeze({
  not_picked_up: 'admin.nodeAgent.errorNotPickedUp',
  timed_out: 'admin.nodeAgent.errorTimedOut',
  agent_revoked: 'admin.nodeAgent.errorRevoked',
  agent_token_rotated: 'admin.nodeAgent.errorRotated',
  agent_restarted: 'admin.nodeAgent.errorRestarted',
  agent_stopped: 'admin.nodeAgent.errorStopped',
  // The update job (scripts/deploy/mail-node/node-update.sh); other codes show as they are, next to
  // the node's own step text.
  unknown_kind: 'admin.nodeAgent.errorUnknownKind',
  not_in_main: 'admin.nodeAgent.errorNotInMain',
  backup_not_configured: 'admin.nodeAgent.errorBackupNotConfigured',
  backup_failed: 'admin.nodeAgent.errorBackupFailed',
  rolled_back: 'admin.nodeAgent.errorRolledBack',
  rollback_failed: 'admin.nodeAgent.errorRollbackFailed',
  post_check_failed: 'admin.nodeAgent.errorPostCheckFailed',
  update_interrupted: 'admin.nodeAgent.errorUpdateInterrupted',
  update_silent: 'admin.nodeAgent.errorUpdateSilent',
  node_standby: 'admin.nodeAgent.errorNodeStandby',
  not_newer: 'admin.nodeAgent.errorNotNewer',
  untrusted_origin: 'admin.nodeAgent.errorUntrustedOrigin',
  local_changes: 'admin.nodeAgent.errorLocalChanges',
  mailcow_update_failed: 'admin.nodeAgent.errorMailcowUpdateFailed',
});

// The node's scripts against the panel's commit: unknown (either is not a commit), current, behind
// (the node runs another commit; "Update node now" brings it to the panel's), or newer (the node
// refused the update to the panel's commit as older than its own: not_newer). The panel cannot
// tell older from newer itself; the node's refusal is how it learns.
export function scriptsState(nodeCommit, panelCommit, lastUpdateJob = null) {
  const sha = /^[0-9a-f]{40}$/;
  if (!sha.test(nodeCommit ?? '') || !sha.test(panelCommit ?? '')) return 'unknown';
  if (nodeCommit === panelCommit) return 'current';
  const job = lastUpdateJob;
  if (job?.state === 'failed' && job.error === 'not_newer' && job.params?.sha === panelCommit) return 'newer';
  return 'behind';
}

export const SCRIPTS_STATE_KEYS = Object.freeze({
  unknown: 'admin.nodeAgent.scriptsUnknown',
  current: 'admin.nodeAgent.scriptsCurrent',
  behind: 'admin.nodeAgent.scriptsBehind',
  newer: 'admin.nodeAgent.scriptsNewer',
});

// The node's part of a panel update (GET /api/admin/update -> node): null when no agent is set up
// (the node is updated by hand); otherwise the last update job's state (queued, running,
// succeeded, failed) when it was an update to the panel's commit, or current / behind / newer /
// unknown from the commits when there is no such job (none yet, or one to an earlier commit).
export function nodeUpdatePart(node) {
  if (!node?.configured) return null;
  const job = node.job ?? null;
  if (job && JOB_STATE_KEYS[job.state] && job.params?.sha === node.panelCommit) {
    return { state: job.state, step: job.step ?? null, error: job.error ?? null, at: job.finishedAt ?? job.startedAt ?? job.createdAt ?? null, target: job.params?.sha ?? null };
  }
  return { state: scriptsState(node.scriptsCommit, node.panelCommit, job), step: null, error: null, at: null, target: null };
}

// The node's part is still under way: the panel update view keeps following it.
export function nodeUpdateActive(node) {
  return isActive(node?.job);
}


// The node's last backup as the status report has it: none (no backup recorded), off (no restic
// keys on the node), ok, or old (node-backup.sh --status found it too old, or the node never
// finished one since backups were set up). problem: the node's own words.
export function backupSummary(status) {
  const backup = status?.backup;
  if (!backup) return null;
  const last = backup.last ?? null;
  let state;
  if (!backup.configured) state = 'off';
  else if (!backup.ok) state = 'old';
  else state = last ? 'ok' : 'none';
  return { state, last, problem: backup.problem ?? null };
}

export const BACKUP_STATE_KEYS = Object.freeze({
  off: 'admin.nodeAgent.backupOff',
  none: 'admin.nodeAgent.backupNone',
  ok: 'admin.nodeAgent.backupOk',
  old: 'admin.nodeAgent.backupOld',
});

// A commit as people read it: its first 12 characters.
export function shortCommit(commit) {
  return typeof commit === 'string' && /^[0-9a-f]{12,40}$/.test(commit) ? commit.slice(0, 12) : (commit || null);
}
