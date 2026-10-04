import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../utils/formatDate.js';
import { api } from '../utils/api.js';
import { mailNodeErrorDetail, mailNodeErrorKey } from '../utils/mailNode.js';
import {
  MAX_RETENTION_DAYS,
  causeParts,
  durationParts,
  fromLocalInput,
  outageFormError,
  outcomeKey,
  timeLeft,
  toLocalInput,
  waitingBanner,
  windowMinutes,
  windowSourceKey,
} from '../utils/mailNodeOutage.js';

const fieldStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
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
const noteStyle = { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 };
const OUTCOME_COLORS = { waiting: 'var(--amber)', lost: 'var(--red)', delayed: 'var(--text-primary)', other: 'var(--text-secondary)' };
const FORM_KEYS = { add: 'admin.outages.formAdd', edit: 'admin.outages.formEdit', close: 'admin.outages.formClose' };
const RESULT_KEYS = { good: 'admin.outages.resultGood', failed: 'admin.outages.resultFailed', unknown: 'admin.outages.resultUnknown' };
const NODE_LOG_KEYS = { seen: 'admin.outages.nodeLogSeen', missing: 'admin.outages.nodeLogMissing', not_covered: 'admin.outages.nodeLogNotCovered' };

// In the interface language ("5 окт. 2026, 08:00"), as the rest of the panel.
const when = (at) => formatDateTime(at);
const emptyForm = () => ({ start: '', end: '', reason: '', planned: false });

// Settings -> Integrations -> "Mail node outages" (admins only), under "Node operations" (R-43):
// the windows during which the node could not take mail from EOP, found by the alert job every
// five minutes or marked by hand (a planned maintenance, a panel-side outage), with what the
// message trace says became of the letters EOP received meanwhile: delayed, still waiting in EOP's
// queue (EOP gives up after 24 hours and returns them to the sender), lost (the sender got a
// non-delivery report) or held by EOP's own filtering. A banner while letters wait. Adding,
// changing, closing and deleting a window needs a reason; the server journals each.
export default function MailNodeOutagesSection() {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // { id, letters } of the window whose letters show
  const [form, setForm] = useState(null); // { mode: 'add' | 'edit' | 'close', id?, ...fields }
  const [confirmDelete, setConfirmDelete] = useState(null); // { id, reason }
  const [retention, setRetention] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const fail = (err) => setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });

  const load = useCallback(async () => {
    try {
      const next = await api.mailNode.getOutages();
      setData(next);
      setRetention(String(next?.settings?.retentionDays ?? ''));
    } catch (err) {
      fail(err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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

  const showLetters = (id) => run(async () => {
    if (open?.id === id) {
      setOpen(null);
      return;
    }
    const { letters } = await api.mailNode.getOutageLetters(id);
    setOpen({ id, letters });
  });

  const traceNow = () => run(async () => {
    await api.mailNode.traceOutages();
    await load();
    if (open) setOpen({ id: open.id, letters: (await api.mailNode.getOutageLetters(open.id)).letters });
  }, 'admin.outages.traced');

  const formError = form ? outageFormError(form, { requireStart: form.mode !== 'close' }) : null;
  const submit = () => run(async () => {
    const reason = form.reason.trim();
    if (form.mode === 'add') {
      await api.mailNode.addOutage({ startedAt: fromLocalInput(form.start), endedAt: fromLocalInput(form.end), reason, planned: form.planned });
    } else if (form.mode === 'close') {
      await api.mailNode.closeOutage(form.id, { endedAt: fromLocalInput(form.end) ?? undefined, reason });
    } else {
      // Only the times the administrator changed: the field holds minutes, so sending an untouched
      // start would move it, journal a change and reset the window's trace.
      const body = { reason };
      if (form.start !== form.initialStart) body.startedAt = fromLocalInput(form.start);
      if (form.end && form.end !== form.initialEnd) body.endedAt = fromLocalInput(form.end);
      await api.mailNode.updateOutage(form.id, body);
    }
    setForm(null);
    await load();
  }, 'admin.outages.saved');

  const remove = () => run(async () => {
    await api.mailNode.deleteOutage(confirmDelete.id, confirmDelete.reason.trim());
    if (open?.id === confirmDelete.id) setOpen(null);
    setConfirmDelete(null);
    await load();
  }, 'admin.outages.deleted');

  const retentionValue = Number(retention);
  const retentionValid = Number.isInteger(retentionValue) && retentionValue >= 1 && retentionValue <= MAX_RETENTION_DAYS;
  const saveRetention = () => run(async () => {
    const { settings } = await api.mailNode.saveOutageSettings({ retentionDays: retentionValue });
    setData((current) => ({ ...(current ?? {}), settings }));
  }, 'admin.outages.settingsSaved');

  // The delete confirmation takes the focus on its reason, so a stray Enter deletes nothing.
  const deleteReasonRef = useRef(null);
  const deletingId = confirmDelete?.id ?? null;
  useEffect(() => {
    if (deletingId) deleteReasonRef.current?.focus();
  }, [deletingId]);

  const windows = data?.windows ?? [];
  const banner = waitingBanner(data?.waiting);
  const left = banner ? timeLeft(banner.soonest) : null;
  const state = data?.state ?? null;

  return (
    <div data-section="node-outages" style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{t('admin.outages.title')}</h3>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 8 }}>{t('admin.outages.description')}</div>

      {banner && (
        <div role="alert" data-outage-banner style={{
          padding: '10px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.12)', border: '1px solid var(--amber)',
          fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5, marginBottom: 8,
        }}>
          <div style={{ fontWeight: 600 }}>{t('admin.outages.bannerWaiting', { count: banner.count })}</div>
          {banner.asOf && <div>{t('admin.outages.asOf', { at: when(banner.asOf) })}</div>}
          {left && !left.past && <div>{t('admin.outages.bannerTimeLeft', { hours: left.hours, minutes: left.minutes, at: when(banner.soonest) })}</div>}
          {left?.past && <div>{t('admin.outages.bannerExpired')}</div>}
          <div>{t('admin.outages.bannerAdvice')}</div>
        </div>
      )}

      {data && !data.traceConnected && (
        <div role="status" data-trace-not-connected style={{ ...noteStyle, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          {t('admin.outages.traceNotConnected')}
        </div>
      )}
      {state && (
        <div style={noteStyle}>
          {t('admin.outages.lastCheck', { at: when(state.lastCheckAt), result: t(RESULT_KEYS[state.lastResult] ?? 'admin.outages.resultUnknown') })}
        </div>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>
          {t(error.key)}{error.detail ? ` (${error.detail})` : ''}
        </div>
      )}
      {notice && <div role="status" style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>{t(notice)}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button type="button" onClick={() => setForm({ mode: 'add', ...emptyForm() })} disabled={busy} style={buttonStyle}>{t('admin.outages.add')}</button>
        {data?.traceConnected && <button type="button" onClick={traceNow} disabled={busy} style={buttonStyle}>{t('admin.outages.traceNow')}</button>}
        <button type="button" onClick={() => run(load)} disabled={busy} style={buttonStyle}>{t('admin.nodeOps.refresh')}</button>
      </div>

      {form && (
        <form
          data-outage-form={form.mode}
          aria-label={t(FORM_KEYS[form.mode])}
          onSubmit={(e) => { e.preventDefault(); if (!formError) submit(); }}
          style={{ display: 'grid', gap: 10, marginTop: 12, padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 8 }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t(FORM_KEYS[form.mode])}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {form.mode !== 'close' && (
              <label style={{ flex: 1, minWidth: 200 }}>
                <span style={labelStyle}>{t('admin.outages.startLabel')}</span>
                <input type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} style={fieldStyle} />
              </label>
            )}
            <label style={{ flex: 1, minWidth: 200 }}>
              <span style={labelStyle}>{t(form.mode === 'close' ? 'admin.outages.endNowLabel' : 'admin.outages.endLabel')}</span>
              <input type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} style={fieldStyle} />
            </label>
          </div>
          <label>
            <span style={labelStyle}>{t('admin.outages.reasonLabel')}</span>
            <input value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={t('admin.outages.reasonPh')} style={fieldStyle} />
          </label>
          {form.mode === 'add' && (
            <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={form.planned} onChange={(e) => setForm({ ...form, planned: e.target.checked })} />
              {t('admin.outages.plannedLabel')}
            </label>
          )}
          <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.outages.formNote')}</span>
          {formError && <div data-form-error style={{ fontSize: 12, color: 'var(--red)' }}>{t(formError)}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy || !!formError} style={primaryButtonStyle}>{t('admin.outages.save')}</button>
            <button type="button" onClick={() => setForm(null)} style={buttonStyle}>{t('common.cancel')}</button>
          </div>
        </form>
      )}

      <h4 style={subTitleStyle}>{t('admin.outages.windowsTitle')}</h4>
      {data && windows.length === 0 && <div role="status" data-outages-none style={{ fontSize: 13 }}>{t('admin.outages.none')}</div>}
      {windows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th scope="col" style={headCellStyle}>{t('admin.outages.columnWindow')}</th>
                <th scope="col" style={headCellStyle}>{t('admin.outages.columnHow')}</th>
                <th scope="col" style={headCellStyle}>{t('admin.outages.columnLetters')}</th>
                <th scope="col" style={headCellStyle}>{t('admin.nodeOps.columnActions')}</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((w) => {
                const duration = durationParts(windowMinutes(w));
                const counts = w.counts ?? {};
                return (
                  <Fragment key={w.id}>
                    <tr data-outage={w.id} data-open={w.open ? 'true' : 'false'}>
                      <td style={cellStyle}>
                        <div>{when(w.startedAt)}{w.cause?.startUncertain ? ` ${t('admin.outages.startUncertain')}` : ''}</div>
                        <div>{w.open ? <strong style={{ color: 'var(--red)' }}>{t('admin.outages.ongoing')}</strong> : when(w.endedAt)}</div>
                        {w.stalled && (
                          <div data-stalled style={{ ...noteStyle, color: 'var(--amber)' }}>{t('admin.outages.stalled', { at: when(w.lastFailedAt || w.startedAt) })}</div>
                        )}
                        <div style={noteStyle}>{t(duration.key, duration.values)}</div>
                      </td>
                      <td style={cellStyle}>
                        <div>{t(windowSourceKey(w))}</div>
                        {causeParts(w).map((part) => <div key={part.key} style={noteStyle}>{t(part.key, part.values)}</div>)}
                        {w.reason && <div style={{ ...noteStyle, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{w.reason}</div>}
                        {w.evidence && (
                          <div style={noteStyle} data-evidence>
                            {t('admin.outages.evidence', {
                              before: when(w.evidence.lastBefore) || '—', after: when(w.evidence.firstAfter) || '—', during: w.evidence.during ?? 0,
                            })}
                          </div>
                        )}
                      </td>
                      <td style={cellStyle}>
                        {w.trace?.checkedAt ? (
                          <>
                            <div>{t('admin.outages.counts', {
                              delayed: counts.delayed ?? 0, waiting: counts.waiting ?? 0, lost: counts.lost ?? 0, other: counts.other ?? 0,
                            })}</div>
                            <div style={noteStyle}>{t('admin.outages.tracedAt', { at: when(w.trace.checkedAt) })}</div>
                            {w.trace.complete === false && <div style={noteStyle}>{t('admin.outages.traceIncomplete')}</div>}
                            {w.trace.error && <div style={{ ...noteStyle, color: 'var(--red)' }}>{t('admin.outages.traceError', { code: w.trace.error })}</div>}
                          </>
                        ) : (
                          <div style={noteStyle}>{t(data?.traceConnected ? 'admin.outages.notTracedYet' : 'admin.outages.noTrace')}</div>
                        )}
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button type="button" onClick={() => showLetters(w.id)} disabled={busy} aria-expanded={open?.id === w.id} style={buttonStyle}>
                            {t('admin.outages.letters')}
                          </button>
                          {w.open && (
                            <button type="button" onClick={() => setForm({ mode: 'close', id: w.id, ...emptyForm() })} disabled={busy} style={buttonStyle}>{t('admin.outages.close')}</button>
                          )}
                          <button type="button" onClick={() => setForm({
                            mode: 'edit', id: w.id, start: toLocalInput(w.startedAt), end: toLocalInput(w.endedAt), reason: '', planned: w.planned,
                            initialStart: toLocalInput(w.startedAt), initialEnd: toLocalInput(w.endedAt),
                          })} disabled={busy} style={buttonStyle}>
                            {t('admin.outages.edit')}
                          </button>
                          <button type="button" onClick={() => setConfirmDelete({ id: w.id, reason: '' })} disabled={busy} style={buttonStyle}>{t('admin.outages.delete')}</button>
                        </div>
                      </td>
                    </tr>
                    {confirmDelete?.id === w.id && (
                      <tr>
                        <td colSpan={4} style={cellStyle}>
                          <div role="alertdialog" aria-label={t('admin.outages.deleteConfirm')} style={{ display: 'grid', gap: 8 }}>
                            <div>{t('admin.outages.deleteConfirm')}</div>
                            <input ref={deleteReasonRef} value={confirmDelete.reason} maxLength={500} aria-label={t('admin.outages.reasonLabel')}
                              onChange={(e) => setConfirmDelete({ ...confirmDelete, reason: e.target.value })} placeholder={t('admin.outages.deleteReasonPh')} style={fieldStyle} />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button type="button" onClick={remove} disabled={busy || !confirmDelete.reason.trim()} style={dangerButtonStyle}>{t('admin.outages.deleteButton')}</button>
                              <button type="button" onClick={() => setConfirmDelete(null)} style={buttonStyle}>{t('common.cancel')}</button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    {open?.id === w.id && (
                      <tr>
                        <td colSpan={4} style={cellStyle}>
                          <OutageLetters letters={open.letters} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 16 }}>
        <label style={{ minWidth: 200 }}>
          <span style={labelStyle}>{t('admin.outages.retentionLabel')}</span>
          <input inputMode="numeric" value={retention} onChange={(e) => setRetention(e.target.value)} style={fieldStyle} aria-invalid={!retentionValid} />
        </label>
        <button type="button" onClick={saveRetention} disabled={busy || !retentionValid} style={buttonStyle}>{t('admin.outages.saveRetention')}</button>
      </div>
      <span style={hintStyle}>{t('admin.outages.retentionNote')}</span>
    </div>
  );
}

// Every letter of one window: recipient, sender, subject, when EOP received it, what became of it,
// the code and words of EOP's details, and whether the node's log shows it arriving.
function OutageLetters({ letters }) {
  const { t } = useTranslation();
  if (!letters?.length) return <div role="status" style={noteStyle}>{t('admin.outages.noLetters')}</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table data-outage-letters style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th scope="col" style={headCellStyle}>{t('admin.outages.columnRecipient')}</th>
            <th scope="col" style={headCellStyle}>{t('messageList.outage.columnFrom')}</th>
            <th scope="col" style={headCellStyle}>{t('messageList.outage.columnSubject')}</th>
            <th scope="col" style={headCellStyle}>{t('messageList.outage.columnReceived')}</th>
            <th scope="col" style={headCellStyle}>{t('messageList.outage.columnStatus')}</th>
          </tr>
        </thead>
        <tbody>
          {letters.map((letter) => {
            const left = letter.outcome === 'waiting' ? timeLeft(letter.expiresAt) : null;
            return (
              <tr key={`${letter.recipient}|${letter.receivedAt}|${letter.messageId ?? letter.sender}`} data-letter-outcome={letter.outcome}>
                <td style={cellStyle}>{letter.recipient}</td>
                <td style={{ ...cellStyle, overflowWrap: 'anywhere' }}>{letter.sender || '—'}</td>
                <td style={{ ...cellStyle, overflowWrap: 'anywhere' }}>{letter.subject || t('messageList.outage.noSubject')}</td>
                <td style={cellStyle}>{when(letter.receivedAt)}</td>
                <td style={cellStyle}>
                  <div style={{ fontWeight: 600, color: OUTCOME_COLORS[letter.outcome] }}>{t(outcomeKey(letter))}</div>
                  {left && !left.past && <div style={noteStyle}>{t('messageList.outage.timeLeft', { hours: left.hours, minutes: left.minutes })}</div>}
                  {(letter.statusCode || letter.detail) && (
                    <div style={{ ...noteStyle, fontFamily: 'JetBrains Mono, monospace', overflowWrap: 'anywhere' }}>{letter.detail || letter.statusCode}</div>
                  )}
                  {letter.nodeLog && (
                    <div style={noteStyle}>{t(NODE_LOG_KEYS[letter.nodeLog], { at: when(letter.nodeSeenAt) })}</div>
                  )}
                  {letter.outcome === 'other' && <div style={noteStyle}>{t('admin.outages.otherNote')}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
