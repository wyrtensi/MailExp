import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  DEFAULT_DEFERRED_COUNT,
  DEFAULT_DEFERRED_MINUTES,
  ageParts,
  alertDetail,
  alertSettingsError,
  alertSourceKey,
  alertTitleKey,
  mailNodeErrorDetail,
  mailNodeErrorKey,
  queueActionKey,
  queueItemActions,
  queueNameKey,
  sizeParts,
} from '../utils/mailNode.js';

const fieldStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const monoFieldStyle = { ...fieldStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4 };
const hintStyle = { display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 };
const buttonStyle = {
  padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };
const dangerButtonStyle = { ...buttonStyle, background: '#dc2626', border: 'none', color: 'white' };
const subTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '20px 0 8px' };
const cellStyle = { padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12, textAlign: 'left', verticalAlign: 'top' };
const headCellStyle = { ...cellStyle, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' };
const monoStyle = { fontFamily: 'JetBrains Mono, monospace', fontSize: 11 };
const noteStyle = { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 };
const SEVERITY_COLORS = { error: 'var(--red)', warning: 'var(--amber)' };

const when = (at) => (at ? new Date(at).toLocaleString() : '');

const settingsForm = (settings) => ({
  pingUrl: settings?.pingUrl ?? '',
  deferredCount: String(settings?.deferredCount ?? DEFAULT_DEFERRED_COUNT),
  deferredMinutes: String(settings?.deferredMinutes ?? DEFAULT_DEFERRED_MINUTES),
});

// Settings -> Integrations -> "Node operations" (admins only), under the mail node and EOP
// sections: the node's alerts (R-18: EOP refusals and mail around EOP in the node's log, the
// deferred queue, the node's certificate, its containers, the tenant's TERRL budget), checked by
// the server every five minutes and on "Check now", with the settings of their own Healthchecks
// check; and the node's mail queue (R-16) with what an administrator may do to one message: read
// its envelope and headers (the body only on request), hold or release it, try it again now, or
// delete it after a confirmation; and "Retry all now". Every action is journaled by the server.
export default function MailNodeOpsSection() {
  const { t } = useTranslation();
  const [alerts, setAlerts] = useState(null);
  const [form, setForm] = useState(settingsForm(null));
  const [queue, setQueue] = useState(null);
  const [queueError, setQueueError] = useState(null);
  // The message whose details are open: { queueId, message, body } (message null while loading).
  const [open, setOpen] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const fail = (err) => setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });

  const loadAlerts = useCallback(async () => {
    try {
      const data = await api.mailNode.getAlerts();
      setAlerts(data);
      setForm(settingsForm(data?.settings));
    } catch (err) {
      fail(err);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api.mailNode.getQueue());
      setQueueError(null);
    } catch (err) {
      setQueueError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    }
  }, []);

  useEffect(() => {
    loadAlerts();
    loadQueue();
  }, [loadAlerts, loadQueue]);

  const run = async (action, noticeKey) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (noticeKey) setNotice(noticeKey);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const checkNow = () => run(async () => {
    const { state } = await api.mailNode.checkAlerts();
    setAlerts((current) => ({ ...(current ?? {}), state }));
  }, 'admin.nodeOps.checked');

  const formError = alertSettingsError(form);
  const saveSettings = () => run(async () => {
    const { settings } = await api.mailNode.saveAlertSettings({
      pingUrl: form.pingUrl.trim(), deferredCount: Number(form.deferredCount), deferredMinutes: Number(form.deferredMinutes),
    });
    setAlerts((current) => ({ ...(current ?? {}), settings }));
    setForm(settingsForm(settings));
  }, 'admin.nodeOps.settingsSaved');

  const flush = () => run(async () => {
    await api.mailNode.flushQueue();
    await loadQueue();
  }, 'admin.nodeOps.flushed');

  const act = (queueId, action) => run(async () => {
    await api.mailNode.queueAction(queueId, action, { confirm: action === 'delete' });
    setConfirmDelete(null);
    if (open?.queueId === queueId) setOpen(null);
    await loadQueue();
  }, 'admin.nodeOps.actionDone');

  const showDetails = (queueId, { body = false } = {}) => run(async () => {
    if (!body && open?.queueId === queueId) {
      setOpen(null);
      return;
    }
    setOpen({ queueId, message: body ? open?.message : null, body });
    const message = await api.mailNode.getQueuedMessage(queueId, { body });
    setOpen({ queueId, message, body });
  });

  const age = (seconds) => {
    if (seconds == null) return '—';
    const p = ageParts(seconds);
    return t(p.unitKey, { value: p.value });
  };
  const size = (bytes) => {
    if ((Number(bytes) || 0) < 1024 * 1024) return t('admin.nodeOps.sizeKb', { value: Math.max(1, Math.ceil((Number(bytes) || 0) / 1024)) });
    const p = sizeParts(bytes);
    return `${p.value} ${t(p.unitKey)}`;
  };

  const state = alerts?.state ?? null;
  const items = queue?.items ?? [];

  return (
    <div data-section="node-ops" style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.nodeOps.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 8 }}>{t('admin.nodeOps.description')}</div>

      {error && (
        <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>
          {t(error.key)}{error.detail ? ` (${error.detail})` : ''}
        </div>
      )}
      {notice && <div role="status" style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>{t(notice)}</div>}

      <div data-node-alerts>
        <div style={subTitleStyle}>{t('admin.nodeOps.alertsTitle')}</div>
        <span style={{ ...hintStyle, marginTop: 0, marginBottom: 8 }}>{t('admin.nodeOps.alertsNote')}</span>
        {!state && <div style={noteStyle}>{t('admin.nodeOps.alertsNever')}</div>}
        {state && (
          <>
            <div style={noteStyle}>{t('admin.nodeOps.checkedAt', { at: when(state.at) })}</div>
            {state.alerts?.length === 0 && (
              <div role="status" data-alerts-none style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 6 }}>{t('admin.nodeOps.alertsNone')}</div>
            )}
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 8 }}>
              {(state.alerts ?? []).map((alert) => {
                const detail = alertDetail(alert);
                const samples = alert.details?.samples ?? [];
                return (
                  <li key={alert.key} data-alert={alert.key} data-severity={alert.severity} style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                    <span style={{ fontWeight: 600, color: SEVERITY_COLORS[alert.severity] ?? 'var(--red)' }}>{t(alertTitleKey(alert.key))}</span>
                    {detail && <div>{t(detail.key, { ...detail.values, at: when(detail.at) })}</div>}
                    <div style={noteStyle}>{t('admin.nodeOps.alertSince', { at: when(alert.since) })}</div>
                    {samples.length > 0 && (
                      <ul style={{ listStyle: 'none', margin: '2px 0 0', padding: 0 }}>
                        {samples.map((s) => (
                          <li key={`${s.queueId}:${s.to}:${s.at}`} style={{ ...monoStyle, color: 'var(--text-secondary)' }}>
                            {[when(s.at), s.queueId, s.to, s.relay, s.dsn].filter(Boolean).join('  ')}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            {(state.errors ?? []).map((e) => (
              <div key={e.source} role="alert" data-alert-error={e.source} style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>
                {t('admin.nodeOps.sourceFailed', { source: t(alertSourceKey(e.source)), reason: t(mailNodeErrorKey(e.code)) })}
              </div>
            ))}
          </>
        )}
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={checkNow} disabled={busy} style={buttonStyle}>{t('admin.nodeOps.checkNow')}</button>
        </div>

        <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
          <label>
            <span style={labelStyle}>{t('admin.nodeOps.pingLabel')}</span>
            <input value={form.pingUrl} onChange={(e) => setForm({ ...form, pingUrl: e.target.value })} spellCheck={false} placeholder={t('admin.mailNode.pingPh')} style={monoFieldStyle} />
            <span style={hintStyle}>{t('admin.nodeOps.pingNote')}</span>
          </label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 160 }}>
              <span style={labelStyle}>{t('admin.nodeOps.deferredCountLabel')}</span>
              <input inputMode="numeric" value={form.deferredCount} onChange={(e) => setForm({ ...form, deferredCount: e.target.value })} style={fieldStyle} />
            </label>
            <label style={{ flex: 1, minWidth: 160 }}>
              <span style={labelStyle}>{t('admin.nodeOps.deferredMinutesLabel')}</span>
              <input inputMode="numeric" value={form.deferredMinutes} onChange={(e) => setForm({ ...form, deferredMinutes: e.target.value })} style={fieldStyle} />
            </label>
          </div>
          <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.nodeOps.thresholdsNote')}</span>
          <div>
            <button type="button" onClick={saveSettings} disabled={busy || !!formError} style={primaryButtonStyle}>{t('common.save')}</button>
            {formError && <span style={{ ...hintStyle, display: 'inline', marginLeft: 10 }}>{t(formError)}</span>}
          </div>
        </div>
      </div>

      <div data-node-queue>
        <div style={subTitleStyle}>{t('admin.nodeOps.queueTitle')}</div>
        <span style={{ ...hintStyle, marginTop: 0, marginBottom: 8 }}>{t('admin.nodeOps.queueNote')}</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <button type="button" onClick={() => run(loadQueue)} disabled={busy} style={buttonStyle}>{t('admin.nodeOps.refresh')}</button>
          <button type="button" onClick={flush} disabled={busy || !queue} style={buttonStyle}>{t('admin.nodeOps.flush')}</button>
        </div>
        {queueError && <div role="alert" data-queue-error style={{ fontSize: 12, color: 'var(--red)' }}>{t(queueError.key)}{queueError.detail ? ` (${queueError.detail})` : ''}</div>}
        {!queue && !queueError && <div style={noteStyle}>{t('common.loading')}</div>}
        {queue && (
          <div data-queue-counts style={noteStyle}>
            {t('admin.nodeOps.queueCounts', {
              total: queue.total, deferred: queue.counts?.deferred ?? 0, hold: queue.counts?.hold ?? 0, active: queue.counts?.active ?? 0,
            })}
          </div>
        )}
        {queue && items.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 6 }}>{t('admin.nodeOps.queueEmpty')}</div>}
        {items.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
            <thead>
              <tr>
                <th style={headCellStyle}>{t('admin.nodeOps.columnQueue')}</th>
                <th style={headCellStyle}>{t('admin.nodeOps.columnSender')}</th>
                <th style={headCellStyle}>{t('admin.nodeOps.columnRecipients')}</th>
                <th style={headCellStyle}>{t('admin.nodeOps.columnSize')}</th>
                <th style={headCellStyle}>{t('admin.nodeOps.columnActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <Fragment key={item.queueId}>
                  <tr data-queue-item={item.queueId} data-queue={item.queue}>
                    <td style={cellStyle}>
                      <div style={{ fontWeight: 600, color: item.queue === 'deferred' ? 'var(--amber)' : 'var(--text-primary)' }}>{t(queueNameKey(item.queue))}</div>
                      <div style={noteStyle}>{age(item.ageSeconds)}</div>
                      <div style={{ ...monoStyle, color: 'var(--text-tertiary)' }}>{item.queueId}</div>
                    </td>
                    <td style={{ ...cellStyle, ...monoStyle }}>{item.sender || t('admin.nodeOps.nullSender')}</td>
                    <td style={cellStyle}>
                      {item.recipients.map((r) => (
                        <div key={r.address}>
                          <span style={monoStyle}>{r.address}</span>
                          {r.reason && <div data-queue-reason style={noteStyle}>{r.reason}</div>}
                        </div>
                      ))}
                    </td>
                    <td style={cellStyle}>{size(item.size)}</td>
                    <td style={cellStyle}>
                      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button type="button" aria-expanded={open?.queueId === item.queueId} onClick={() => showDetails(item.queueId)} disabled={busy} style={buttonStyle}>
                          {open?.queueId === item.queueId ? t('admin.mailNode.hideDetails') : t('admin.mailNode.showDetails')}
                        </button>
                        {queueItemActions(item).map((action) => (
                          <button
                            key={action}
                            type="button"
                            data-queue-action={action}
                            onClick={() => (action === 'delete' ? setConfirmDelete(item.queueId) : act(item.queueId, action))}
                            disabled={busy}
                            style={buttonStyle}
                          >
                            {t(queueActionKey(action))}
                          </button>
                        ))}
                      </span>
                      {confirmDelete === item.queueId && (
                        <div role="alertdialog" data-delete-confirm style={{ marginTop: 8, fontSize: 12 }}>
                          <div style={{ fontWeight: 600 }}>{t('admin.nodeOps.deleteConfirm', { id: item.queueId })}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button type="button" onClick={() => act(item.queueId, 'delete')} disabled={busy} style={dangerButtonStyle}>{t('admin.nodeOps.deleteConfirmButton')}</button>
                            <button type="button" onClick={() => setConfirmDelete(null)} disabled={busy} style={buttonStyle}>{t('common.cancel')}</button>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                  {open?.queueId === item.queueId && (
                    <tr>
                      <td colSpan={5} data-queue-details={item.queueId} style={{ ...cellStyle, background: 'var(--bg-secondary)' }}>
                        {!open.message && <div style={noteStyle}>{t('common.loading')}</div>}
                        {open.message && (
                          <>
                            <div style={noteStyle}>
                              {t('admin.nodeOps.envelope', {
                                sender: open.message.envelope?.sender || t('admin.nodeOps.nullSender'),
                                recipients: (open.message.envelope?.recipients ?? []).join(', '),
                                arrival: open.message.envelope?.arrival ?? '—',
                              })}
                            </div>
                            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
                              {open.message.headers.map((h, index) => (
                                // Headers repeat (Received): the position tells them apart.
                                <li key={`${h.name}:${index}`} data-header={h.name} style={{ ...monoStyle, wordBreak: 'break-all' }}>
                                  <span style={{ fontWeight: 600 }}>{h.name}:</span> {h.value}
                                </li>
                              ))}
                            </ul>
                            {!open.body && (
                              <button type="button" onClick={() => showDetails(item.queueId, { body: true })} disabled={busy} style={{ ...buttonStyle, marginTop: 8 }}>
                                {t('admin.nodeOps.showBody', { size: size(open.message.bodyBytes) })}
                              </button>
                            )}
                            {open.body && open.message.body != null && (
                              <>
                                <pre data-queue-body style={{ ...monoStyle, whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 8, maxHeight: 320, overflow: 'auto' }}>{open.message.body}</pre>
                                {open.message.bodyTruncated && <div style={noteStyle}>{t('admin.nodeOps.bodyTruncated')}</div>}
                              </>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
