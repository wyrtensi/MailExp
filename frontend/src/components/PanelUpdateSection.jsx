import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import ConfirmOverlay from './ConfirmOverlay.jsx';
import {
  POLL_GRACE_MS, POLL_INTERVAL_MS,
  canCheck, checkErrorKey, isRestartingError, isRolledBack, logTail, migrationsInfo, needsAutoCheck, needsPolling, needsRunbook,
  requestErrorKey, rollbackCommand, rollbackInfo, safeGithubUrl, shouldOfferReload, stateInfo, textList,
  updateBlockReason, updateStatus, updateTarget,
} from '../utils/panelUpdate.js';

export const RUNBOOK_DOCS_URL = 'https://github.com/wyrtensi/MailExpert/blob/main/docs/operations/README.md';

const cardStyle = { border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 };
const buttonStyle = {
  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };
const noteStyle = { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 };
const rowStyle = { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 13, marginBottom: 4 };
const labelStyle = { fontSize: 12, color: 'var(--text-tertiary)', minWidth: 130 };
const monoStyle = { fontFamily: 'JetBrains Mono, monospace', fontSize: 12 };
const subTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' };
const listStyle = { margin: '2px 0 8px', paddingLeft: 18, fontSize: 12, lineHeight: 1.5 };
const TONE_COLORS = {
  good: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', neutral: 'var(--text-primary)',
};
const BLOCK_HINT_KEYS = {
  busy: 'admin.panelUpdate.blockedBusy',
  no_update: 'admin.panelUpdate.blockedNoUpdate',
  blocked: 'admin.panelUpdate.blockedByCheck',
};
const STATUS_KEYS = {
  ahead: 'admin.panelUpdate.statusAhead',
  current: 'admin.panelUpdate.statusCurrent',
  diverged: 'admin.panelUpdate.statusDiverged',
  disabled: 'admin.panelUpdate.statusDisabled',
  unknown: 'admin.panelUpdate.statusUnknown',
};
const STATUS_TONES = { ahead: 'warn', current: 'good', diverged: 'warn', disabled: 'neutral', unknown: 'neutral' };

const when = (at) => (at ? formatDateTime(at) : '');

function List({ title, items, tone }) {
  if (!items.length) return null;
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: TONE_COLORS[tone] ?? TONE_COLORS.neutral }}>{title}</div>
      <ul style={listStyle}>
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    </div>
  );
}

// Text the administrator copies into a shell: selectable in one click, never a link.
function Copyable({ children, ...rest }) {
  return <code {...rest} style={{ ...monoStyle, userSelect: 'all', wordBreak: 'break-all' }}>{children}</code>;
}

// The newest preflight (status.sh --target) of the promoted version, as the host wrote it.
function CheckResult({ check, target, t }) {
  const info = check ? stateInfo(check.state) : null;
  const preflight = check?.preflight ?? null;
  const migrations = migrationsInfo(preflight);
  const rollback = rollbackInfo(check);
  return (
    <div data-panel-update-check={check?.state ?? 'none'} style={{ marginTop: 12 }}>
      <h4 style={subTitleStyle}>{t('admin.panelUpdate.checkTitle', { target })}</h4>
      {!check && <div style={noteStyle}>{t('admin.panelUpdate.checkNone')}</div>}
      {check && (
        <>
          <div style={{ ...rowStyle, marginBottom: 6 }}>
            <strong data-check-state style={{ color: TONE_COLORS[info.tone] }}>{t(info.key)}</strong>
            {check.finishedAt && <span style={noteStyle}>{when(check.finishedAt)}</span>}
          </div>
          {check.terminal && check.state !== 'ready' && check.message && (
            <div data-check-message style={{ fontSize: 12, marginBottom: 6 }}>{check.message}</div>
          )}
          {preflight && (
            <>
              <List title={t('admin.panelUpdate.problems')} items={textList(preflight.problems)} tone="bad" />
              <List title={t('admin.panelUpdate.warnings')} items={textList(preflight.warnings)} tone="warn" />
              <List title={t('admin.panelUpdate.nextSteps')} items={textList(check.next).concat(textList(preflight.next))} tone="neutral" />
              <div data-migrations={migrations.kind} style={{ fontSize: 12, marginBottom: 4 }}>
                {migrations.kind === 'none' && t('admin.panelUpdate.migrationsNone')}
                {migrations.kind === 'unknown' && t('admin.panelUpdate.migrationsUnknown')}
                {migrations.kind === 'pending' && t('admin.panelUpdate.migrationsPending', { count: migrations.list.length })}
              </div>
              {migrations.kind === 'pending' && (
                <ul style={listStyle}>
                  {migrations.list.map((name) => <li key={name}><Copyable>{name}</Copyable></li>)}
                </ul>
              )}
              <div data-rollback={rollback} style={{ fontSize: 12 }}>
                {rollback === 'auto' && t('admin.panelUpdate.rollbackAuto')}
                {rollback === 'manual' && t('admin.panelUpdate.rollbackManual')}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// The newest update run: where it is, what the host said, its log, and what to do after a failure.
function RunResult({ run, t }) {
  const info = stateInfo(run.state);
  const log = logTail(run.log);
  const next = textList(run.next);
  const command = needsRunbook(run) ? rollbackCommand(run) : null;
  const runbook = needsRunbook(run) ? safeGithubUrl(run.links?.runbook) : null;
  return (
    <div data-panel-update-run={run.state} style={{ ...cardStyle, marginTop: 12 }}>
      <h4 style={subTitleStyle}>{t('admin.panelUpdate.runTitle')}</h4>
      <div style={rowStyle}>
        <strong data-run-state style={{ color: TONE_COLORS[info.tone] }}>{t(info.key)}</strong>
        {run.from && run.target && <span style={noteStyle}>{t('admin.panelUpdate.runFromTo', { from: run.from, target: run.target })}</span>}
      </div>
      {(run.startedAt || run.finishedAt) && (
        <div style={noteStyle}>
          {run.startedAt && t('admin.panelUpdate.runStarted', { at: when(run.startedAt) })}
          {run.startedAt && run.finishedAt ? ' · ' : ''}
          {run.finishedAt && t('admin.panelUpdate.runFinished', { at: when(run.finishedAt) })}
        </div>
      )}
      {run.message && (
        <div data-run-message style={{ fontSize: 12, marginTop: 6 }}>
          <span style={noteStyle}>{t('admin.panelUpdate.runMessage')}</span>
          {' '}
          {run.message}
        </div>
      )}
      {run.exitCode != null && (
        <div data-run-exit style={{ fontSize: 12, marginTop: 4 }}>{t('admin.panelUpdate.runExitCode', { code: run.exitCode })}</div>
      )}
      <List title={t('admin.panelUpdate.nextSteps')} items={next} tone="neutral" />
      {log.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t('admin.panelUpdate.runLog')}</div>
          <pre data-run-log tabIndex={0} style={{
            ...monoStyle, margin: '4px 0 0', padding: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap',
            wordBreak: 'break-all', background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 7,
          }}>{log.join('\n')}</pre>
        </div>
      )}
      {(run.logFile || run.journal) && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <div style={noteStyle}>{t('admin.panelUpdate.runLogsWhere')}</div>
          {run.logFile && <div data-run-log-file><Copyable>{run.logFile}</Copyable></div>}
          {run.journal && <div data-run-journal><Copyable>{run.journal}</Copyable></div>}
        </div>
      )}
      {needsRunbook(run) && (
        <div data-run-recovery style={{ marginTop: 10, fontSize: 12 }}>
          <div style={{ fontWeight: 600, color: 'var(--red)' }}>{t(run.state === 'rollback_failed' ? 'admin.panelUpdate.recoveryRollbackFailed' : 'admin.panelUpdate.recoveryFailed')}</div>
          {command && (
            <>
              <div style={noteStyle}>{t('admin.panelUpdate.recoveryCommand')}</div>
              <div data-run-rollback-command><Copyable>{command}</Copyable></div>
            </>
          )}
          {runbook && (
            <div style={{ marginTop: 4 }}>
              <a data-run-runbook href={runbook} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)' }}>
                {t('admin.panelUpdate.runbookLink')}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Settings -> Panel update (admins only): the panel's version against the promoted `latest`, the
// preflight of that target, and the update itself. The browser never runs anything: it asks the
// backend, which hands a request to the host's updater through a spool directory; the host checks
// it again, backs up, replaces the containers (the panel restarts) and writes the result this
// screen polls every three seconds, riding out the gaps while the backend is down.
export default function PanelUpdateSection() {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [tick, setTick] = useState(0);
  const hasData = useRef(false);
  const graceUntil = useRef(0);
  const autoChecked = useRef(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await api.admin.getPanelUpdate();
      if (!alive.current) return;
      hasData.current = true;
      setData(next);
      setLoadError(null);
      setRestarting(false);
    } catch (err) {
      if (!alive.current) return;
      // The backend is replaced while an update runs: once the screen has seen it, a gap is a restart.
      if (hasData.current && isRestartingError(err)) setRestarting(true);
      else setLoadError(err?.message || 'error');
    } finally {
      if (alive.current) setTick((n) => n + 1);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!data) return undefined;
    const wanted = restarting || needsPolling(data) || Date.now() < graceUntil.current;
    if (!wanted) return undefined;
    const timer = setTimeout(load, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [data, restarting, tick, load]);

  const fail = (err) => setActionError({ key: requestErrorKey(err), message: err?.message || '' });

  const sendRequest = useCallback(async (call) => {
    setActionError(null);
    setStarting(true);
    try {
      await call();
      graceUntil.current = Date.now() + POLL_GRACE_MS;
    } catch (err) {
      fail(err);
    } finally {
      await load();
      if (alive.current) setStarting(false);
    }
  }, [load]);

  const runCheck = useCallback((target) => sendRequest(() => api.admin.checkPanelUpdate(target)), [sendRequest]);

  // The first look at an available update comes with its check, so the administrator sees whether
  // it can start without asking; once per target.
  useEffect(() => {
    if (!needsAutoCheck(data) || starting) return;
    const target = updateTarget(data);
    if (autoChecked.current === target) return;
    autoChecked.current = target;
    runCheck(target);
  }, [data, starting, runCheck]);

  const target = updateTarget(data);
  const status = updateStatus(data);
  const blockReason = updateBlockReason(data, { starting });
  const installed = !!data?.updater?.installed;
  const check = data?.check ?? null;
  const run = data?.run ?? null;
  const migrations = migrationsInfo(check?.preflight);
  const rollback = rollbackInfo(check);
  const compareUrl = safeGithubUrl(data?.compare?.url);
  const aheadBy = data?.compare?.aheadBy;

  const confirmUpdate = () => {
    if (!target) return;
    const noteKey = rollback === 'auto' ? 'admin.panelUpdate.confirmNoteAuto'
      : migrations.kind === 'pending' ? 'admin.panelUpdate.confirmNotePending'
        : migrations.kind === 'none' ? 'admin.panelUpdate.confirmNoteManual'
          : 'admin.panelUpdate.confirmNoteUnknown';
    setDialog({
      title: t('admin.panelUpdate.confirmTitle', { target }),
      message: t('admin.panelUpdate.confirmMessage', { from: data.current?.version ?? '—', target }),
      note: migrations.kind === 'pending'
        ? `${t(noteKey)} ${migrations.list.join(', ')}`
        : t(noteKey),
      confirmLabel: t('admin.panelUpdate.confirmButton'),
      onConfirm: async () => {
        await sendRequest(() => api.admin.startPanelUpdate(target));
      },
    });
  };

  const info = status === 'error' ? null : { key: STATUS_KEYS[status], tone: STATUS_TONES[status] };

  return (
    <div data-section="panel-update" style={cardStyle}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{t('admin.panelUpdate.title')}</h3>
      <div style={{ ...noteStyle, fontSize: 12, marginTop: 2, marginBottom: 10 }}>{t('admin.panelUpdate.description')}</div>

      {loadError && !data && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{t('admin.panelUpdate.loadFailed', { message: loadError })}</div>}
      {!data && !loadError && <div role="status" style={noteStyle}>{t('common.loading')}</div>}

      {restarting && (
        <div role="status" data-panel-restarting style={{
          padding: '10px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.12)', border: '1px solid var(--amber)',
          fontSize: 12, lineHeight: 1.5, marginBottom: 10,
        }}>
          {t('admin.panelUpdate.restarting')}
        </div>
      )}

      {data && (
        <>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('admin.panelUpdate.currentVersion')}</span>
            <Copyable data-current-version>{data.current?.version ?? t('admin.panelUpdate.versionUnknown')}</Copyable>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('admin.panelUpdate.latestVersion')}</span>
            <Copyable data-latest-version>{data.latest?.version ?? t('admin.panelUpdate.versionUnknown')}</Copyable>
            {data.latest?.checkedAt && <span style={noteStyle}>{t('admin.panelUpdate.latestChecked', { at: when(data.latest.checkedAt) })}</span>}
          </div>

          <div data-panel-update-status={status} style={{ ...rowStyle, marginTop: 8 }}>
            {info && <strong style={{ color: TONE_COLORS[info.tone] }}>{t(info.key)}</strong>}
            {status === 'error' && <strong style={{ color: 'var(--red)' }}>{t(checkErrorKey(data.checkError))}</strong>}
            {status === 'ahead' && aheadBy != null && <span>{t('admin.panelUpdate.aheadBy', { count: aheadBy })}</span>}
            {compareUrl && (
              <a data-compare-link href={compareUrl} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)', fontSize: 12 }}>
                {t('admin.panelUpdate.compareLink')}
              </a>
            )}
          </div>

          {!installed && (
            <div role="status" data-updater-not-installed style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12, lineHeight: 1.5,
            }}>
              <div style={{ fontWeight: 600 }}>{t('admin.panelUpdate.notInstalledTitle')}</div>
              <div>{t('admin.panelUpdate.notInstalledHint')}</div>
              <a data-docs-link href={RUNBOOK_DOCS_URL} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)' }}>
                {t('admin.panelUpdate.notInstalledDocs')}
              </a>
            </div>
          )}

          {installed && isRolledBack(data) && (
            <div role="status" data-rolled-back style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.12)', border: '1px solid var(--amber)',
              fontSize: 12, lineHeight: 1.5,
            }}>
              {t('admin.panelUpdate.rolledBack', { version: data.updater.rolledBack })}
            </div>
          )}

          {data.updateAvailable && target && !isRolledBack(data) && <CheckResult check={check} target={target} t={t} />}

          {actionError && (
            <div role="alert" data-panel-update-error style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>
              {actionError.key ? t(actionError.key) : t('admin.panelUpdate.errorGeneric', { message: actionError.message })}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button
              type="button"
              data-panel-update-check-button
              onClick={() => runCheck(target)}
              disabled={!canCheck(data, { starting })}
              style={buttonStyle}
            >{t('admin.panelUpdate.checkButton')}</button>
            <button
              type="button"
              data-panel-update-button
              onClick={confirmUpdate}
              disabled={blockReason !== null}
              style={{ ...primaryButtonStyle, opacity: blockReason !== null ? 0.5 : 1, cursor: blockReason !== null ? 'default' : 'pointer' }}
            >{t('admin.panelUpdate.updateButton')}</button>
          </div>
          {blockReason && BLOCK_HINT_KEYS[blockReason] && installed && (
            <div data-update-block={blockReason} style={{ ...noteStyle, marginTop: 6 }}>{t(BLOCK_HINT_KEYS[blockReason])}</div>
          )}

          {run && <RunResult run={{ ...run, links: data.links }} t={t} />}
          {shouldOfferReload(run) && (
            <div data-panel-update-reload role="status" style={{ marginTop: 8, fontSize: 12 }}>
              <div>{t('admin.panelUpdate.reloadHint')}</div>
              <button type="button" onClick={() => window.location.reload()} style={{ ...primaryButtonStyle, marginTop: 6 }}>
                {t('admin.panelUpdate.reloadButton')}
              </button>
            </div>
          )}
        </>
      )}

      <ConfirmOverlay dialog={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}
