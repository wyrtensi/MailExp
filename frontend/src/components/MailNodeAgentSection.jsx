import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../utils/formatDate.js';
import { api } from '../utils/api.js';
import { sizeParts } from '../utils/mailNode.js';
import {
  AGENT_CONNECTION_KEYS,
  BACKUP_STATE_KEYS,
  JOB_ERROR_KEYS,
  JOB_STATE_KEYS,
  SCRIPTS_STATE_KEYS,
  agentConnection,
  agentSetupCommands,
  backupSummary,
  latestJob,
  nodeBusyJob,
  scriptsState,
  shortCommit,
} from '../utils/nodeAgent.js';

const buttonStyle = {
  padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };
const dangerButtonStyle = { ...buttonStyle, background: '#dc2626', border: 'none', color: 'white' };
const subTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '16px 0 6px' };
const rowStyle = { display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, flexWrap: 'wrap' };
const termStyle = { color: 'var(--text-tertiary)', minWidth: 160 };
const noteStyle = { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, marginTop: 6 };
const codeStyle = {
  display: 'block', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, padding: '8px 10px', marginTop: 6,
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 7, whiteSpace: 'pre-wrap',
  wordBreak: 'break-all', color: 'var(--text-primary)',
};
const STATE_COLORS = { connected: 'var(--green)', waiting: 'var(--amber)', not_set_up: 'var(--text-tertiary)' };
const BACKUP_COLORS = { ok: 'var(--green)', old: 'var(--red)', none: 'var(--amber)', off: 'var(--text-tertiary)' };
const SCRIPTS_COLORS = { current: 'var(--green)', behind: 'var(--amber)', unknown: 'var(--text-tertiary)' };
// While a job runs the section follows it every few seconds.
const FOLLOW_MS = 4000;

const when = (at) => (at ? formatDateTime(at, { seconds: true }) : null);

// A job's state, step, failure and the end of its output (data-<name>-job, data-<name>-log).
function JobDetails({ job, name, t }) {
  return (
    <div {...{ [`data-${name}-job`]: job.state }} style={{ marginTop: 8 }}>
      <div style={rowStyle}>
        <span style={termStyle}>{t('admin.nodeAgent.jobLabel')}</span>
        <span>{t(JOB_STATE_KEYS[job.state] ?? 'admin.nodeAgent.unknown')}</span>
        <span>{when(job.finishedAt ?? job.startedAt ?? job.createdAt)}</span>
      </div>
      {job.step && (
        <div style={rowStyle}>
          <span style={termStyle}>{t('admin.nodeAgent.stepLabel')}</span>
          <span>{job.step}</span>
        </div>
      )}
      {job.state === 'failed' && job.error && (
        <div style={{ ...noteStyle, color: 'var(--red)' }}>
          {JOB_ERROR_KEYS[job.error] ? t(JOB_ERROR_KEYS[job.error]) : job.error}
        </div>
      )}
      {job.logTail && <pre {...{ [`data-${name}-log`]: '' }} style={{ ...codeStyle, maxHeight: 220, overflow: 'auto' }}>{job.logTail}</pre>}
    </div>
  );
}

// Settings -> Mail node -> "Node agent" (admins only): the service on the node host that takes jobs
// from the panel (scripts/deploy/mail-node/node-agent.sh). Its state and last report (scripts
// commit, mailcow version, containers, the node's last backup); connecting it (a token shown once,
// with the setup.sh commands), rotating and revoking the token; "Back up mail now" and "Update node
// now" (the node's scripts to the panel's commit; the panel also asks for it after its own update)
// with the job's progress. The server journals every change.
export default function MailNodeAgentSection() {
  const { t } = useTranslation();
  const [agent, setAgent] = useState(null);
  const [issued, setIssued] = useState(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setAgent(await api.mailNode.getAgent());
    } catch (err) {
      setError(err?.message || t('admin.nodeAgent.errorLoad'));
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const jobs = agent?.jobs ?? [];
  // A backup or an update: one at a time, and the section follows it.
  const running = nodeBusyJob(jobs);
  const runningId = running?.id ?? null;
  useEffect(() => {
    if (!runningId) return undefined;
    const timer = setInterval(load, FOLLOW_MS);
    return () => clearInterval(timer);
  }, [runningId, load]);

  const run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err?.message || t('admin.nodeAgent.errorLoad'));
    } finally {
      setBusy(false);
    }
  };

  const issue = () => run(async () => {
    const result = await api.mailNode.issueAgentToken();
    setIssued(result);
    setConfirmRevoke(false);
  });
  const revoke = () => run(async () => {
    await api.mailNode.revokeAgentToken();
    setIssued(null);
    setConfirmRevoke(false);
  });
  const backupNow = () => run(() => api.mailNode.requestAgentJob('backup'));
  const updateNow = () => run(() => api.mailNode.requestAgentJob('update'));

  const connection = agentConnection(agent);
  const status = agent?.status ?? null;
  const backup = backupSummary(status);
  const lastBackupJob = latestJob(jobs, 'backup');
  const lastUpdateJob = latestJob(jobs, 'update');
  const scripts = scriptsState(status?.scriptsCommit, agent?.panelCommit);
  const size = (bytes) => {
    const p = sizeParts(bytes);
    return `${p.value} ${t(p.unitKey)}`;
  };
  const containers = status?.containers;

  return (
    <div data-section="node-agent" style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.nodeAgent.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 8 }}>{t('admin.nodeAgent.description')}</div>
      {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>{error}</div>}

      {agent && (
        <>
          <div style={rowStyle}>
            <span style={termStyle}>{t('admin.nodeAgent.stateLabel')}</span>
            <span data-agent-state={connection} style={{ color: STATE_COLORS[connection], fontWeight: 600 }}>{t(AGENT_CONNECTION_KEYS[connection])}</span>
          </div>
          {agent.configured && (
            <div style={rowStyle}>
              <span style={termStyle}>{t('admin.nodeAgent.lastSeenLabel')}</span>
              <span>{when(agent.lastSeenAt) ?? t('admin.nodeAgent.never')}</span>
            </div>
          )}
          {status && (
            <>
              <div style={rowStyle}>
                <span style={termStyle}>{t('admin.nodeAgent.scriptsLabel')}</span>
                <code>{shortCommit(status.scriptsCommit) ?? t('admin.nodeAgent.unknown')}</code>
              </div>
              <div style={rowStyle}>
                <span style={termStyle}>{t('admin.nodeAgent.mailcowLabel')}</span>
                <code>{status.mailcowVersion ?? t('admin.nodeAgent.unknown')}</code>
              </div>
              {containers?.total != null && (
                <div style={rowStyle}>
                  <span style={termStyle}>{t('admin.nodeAgent.containersLabel')}</span>
                  <span>{t('admin.nodeAgent.containersRunning', { running: containers.running ?? 0, total: containers.total })}</span>
                  {containers.problems?.length > 0 && <span style={{ color: 'var(--red)' }}>{containers.problems.join(', ')}</span>}
                </div>
              )}
              <div style={noteStyle}>{t('admin.nodeAgent.reportedAt', { at: when(agent.statusAt) })}</div>
            </>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {!agent.configured && (
              <button type="button" style={primaryButtonStyle} disabled={busy} onClick={issue}>{t('admin.nodeAgent.connect')}</button>
            )}
            {agent.configured && (
              <>
                <button type="button" style={buttonStyle} disabled={busy} onClick={issue}>{t('admin.nodeAgent.rotate')}</button>
                {!confirmRevoke && (
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => setConfirmRevoke(true)}>{t('admin.nodeAgent.revoke')}</button>
                )}
                {confirmRevoke && (
                  <>
                    <button type="button" style={dangerButtonStyle} disabled={busy} onClick={revoke}>{t('admin.nodeAgent.revokeConfirm')}</button>
                    <button type="button" style={buttonStyle} disabled={busy} onClick={() => setConfirmRevoke(false)}>{t('admin.nodeAgent.cancel')}</button>
                  </>
                )}
              </>
            )}
          </div>
          {confirmRevoke && <div style={noteStyle}>{t('admin.nodeAgent.revokeNote')}</div>}

          {issued && (
            <div data-agent-token style={{ marginTop: 12 }}>
              <div style={subTitleStyle}>{t(issued.rotated ? 'admin.nodeAgent.tokenRotatedTitle' : 'admin.nodeAgent.tokenTitle')}</div>
              <div style={noteStyle}>{t('admin.nodeAgent.tokenOnce')}</div>
              <code data-agent-token-value style={codeStyle}>{issued.token}</code>
              <div style={noteStyle}>{t('admin.nodeAgent.setupSteps')}</div>
              <code data-agent-setup style={codeStyle}>{agentSetupCommands(window.location.origin).join('\n')}</code>
              <div style={noteStyle}>{t('admin.nodeAgent.cfAccessNote')}</div>
              <button type="button" style={{ ...buttonStyle, marginTop: 8 }} onClick={() => setIssued(null)}>{t('admin.nodeAgent.tokenSaved')}</button>
            </div>
          )}

          <div style={subTitleStyle}>{t('admin.nodeAgent.backupTitle')}</div>
          {!backup && <div style={noteStyle}>{t('admin.nodeAgent.backupUnknown')}</div>}
          {backup && (
            <>
              <div style={rowStyle}>
                <span style={termStyle}>{t('admin.nodeAgent.backupStateLabel')}</span>
                <span data-backup-state={backup.state} style={{ color: BACKUP_COLORS[backup.state], fontWeight: 600 }}>{t(BACKUP_STATE_KEYS[backup.state])}</span>
              </div>
              {backup.last && (
                <>
                  <div style={rowStyle}>
                    <span style={termStyle}>{t('admin.nodeAgent.backupAtLabel')}</span>
                    <span>{when(backup.last.finishedAt)}</span>
                  </div>
                  {backup.last.processedBytes != null && (
                    <div style={rowStyle}>
                      <span style={termStyle}>{t('admin.nodeAgent.backupSizeLabel')}</span>
                      <span>{size(backup.last.processedBytes)}</span>
                    </div>
                  )}
                </>
              )}
              {backup.problem && <div style={{ ...noteStyle, color: 'var(--red)' }}>{backup.problem}</div>}
            </>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy || !!running || connection === 'not_set_up'}
              onClick={backupNow}
            >
              {t('admin.nodeAgent.backupNow')}
            </button>
            {connection === 'waiting' && !running && <span style={noteStyle}>{t('admin.nodeAgent.backupWaitsForAgent')}</span>}
          </div>
          {lastBackupJob && <JobDetails job={lastBackupJob} name="backup" t={t} />}

          <div style={subTitleStyle}>{t('admin.nodeAgent.updateTitle')}</div>
          <div style={rowStyle}>
            <span style={termStyle}>{t('admin.nodeAgent.panelCommitLabel')}</span>
            <code>{shortCommit(agent.panelCommit) ?? t('admin.nodeAgent.unknown')}</code>
          </div>
          <div style={rowStyle}>
            <span style={termStyle}>{t('admin.nodeAgent.scriptsStateLabel')}</span>
            <span data-scripts-state={scripts} style={{ color: SCRIPTS_COLORS[scripts], fontWeight: 600 }}>{t(SCRIPTS_STATE_KEYS[scripts])}</span>
          </div>
          <div style={noteStyle}>{t('admin.nodeAgent.updateNote')}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              style={buttonStyle}
              disabled={busy || !!running || connection === 'not_set_up' || !agent.panelCommit}
              onClick={updateNow}
            >
              {t('admin.nodeAgent.updateNow')}
            </button>
            {running && <span style={noteStyle}>{t('admin.nodeAgent.busyNote')}</span>}
          </div>
          {lastUpdateJob && <JobDetails job={lastUpdateJob} name="update" t={t} />}
        </>
      )}
    </div>
  );
}
