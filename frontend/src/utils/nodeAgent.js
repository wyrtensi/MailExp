// Pure helpers for the node agent section (components/MailNodeAgentSection.jsx). The state comes
// from GET /api/mail-node/agent (backend services/mailNode/nodeAgent.js).

// Where the setup instructions save the token on the node: root's, 0600.
export const AGENT_TOKEN_FILE = '/root/mailexpert-agent-token';

// The panel's address as the node reaches it: the origin the administrator has open.
export function panelUrl(origin) {
  const url = String(origin ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+$/.test(url) ? url : 'https://<PANEL_HOST>';
}

// The commands that connect the node: the token saved into a 0600 file first (never on a command
// line, where the shell history and the process list would keep it), then setup.sh.
export function agentSetupCommands(origin, tokenFile = AGENT_TOKEN_FILE) {
  return [
    `(umask 077 && cat > ${tokenFile})`,
    `sudo scripts/deploy/mail-node/setup.sh --panel-url ${panelUrl(origin)} --agent-token-file ${tokenFile}`,
    `rm ${tokenFile}`,
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

// The job of a kind still queued or running, or null.
export function activeJob(jobs, kind) {
  return (Array.isArray(jobs) ? jobs : []).find((job) => job?.kind === kind && (job.state === 'queued' || job.state === 'running')) ?? null;
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
});

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
