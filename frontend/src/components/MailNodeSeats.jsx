import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import {
  heldSeatsTitle, holdDaysError, mailNodeErrorDetail, mailNodeErrorKey, seatRequestError, seatsView,
} from '../utils/mailNode.js';

const noteStyle = { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 };
const warnStyle = { ...noteStyle, color: 'var(--amber)' };
const buttonStyle = {
  padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const inputStyle = {
  width: 70, padding: '5px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--text-primary)', fontSize: 12,
};

// The EOP seats counter (EOP seats design, 2026-10-07): used, temporarily unavailable (seats on hold
// after a deactivation or a deletion request; hovering lists each with the date it becomes free) and
// free; never the purchased number. Also when Microsoft was last asked, "Reconcile" (administrators,
// while the tenant gives the number), the hold period (administrators), "Request seats" and the open
// requests. compact: the one line the add form and the notices show, with "Request seats" only when
// no seat is free. seats: GET /api/mail-node/seats, loaded by the caller; onChanged() reloads it.
export default function MailNodeSeats({ seats, compact = false, isAdmin = false, onChanged = () => {} }) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [count, setCount] = useState('1');
  const [hold, setHold] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const view = seatsView(seats);
  if (!view) return null;

  const run = async (fn, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      onChanged();
    } catch (err) {
      setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    } finally {
      setBusy(false);
    }
  };
  const sendRequest = () => {
    const problem = seatRequestError(count);
    if (problem) {
      setError({ key: problem, detail: '' });
      return;
    }
    run(async () => {
      await api.mailNode.requestSeats(Number(count));
      setAsking(false);
    }, 'admin.mailNode.seats.requestSent');
  };
  const reconcile = () => run(() => api.mailNode.checkSeats(), 'admin.mailNode.seats.checkQueued');
  const holdValue = hold ?? String(seats.holdDays ?? '');
  const saveHold = () => {
    const problem = holdDaysError(holdValue);
    if (problem) {
      setError({ key: problem, detail: '' });
      return;
    }
    run(async () => {
      await api.mailNode.saveSeatSettings({ holdDays: Number(holdValue) });
      setHold(null);
    }, 'admin.mailNode.seats.holdSaved');
  };

  const none = view.known && view.free === 0;
  const showRequest = !compact || !view.canTake;
  const canReconcile = !compact && isAdmin && seats.mode === 'graph';
  return (
    <div data-eop-seats data-seats-free={view.known ? String(view.free) : 'unknown'} style={{ marginTop: compact ? 8 : 0 }}>
      <div style={{ fontSize: compact ? 12 : 13, fontWeight: 600, color: none ? 'var(--red)' : 'var(--text-primary)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {view.known ? (
          <>
            <span>{t('admin.mailNode.seats.used', { used: view.used })}</span>
            <span data-seats-held title={heldSeatsTitle(seats, { t, formatDate: formatDateTime })} style={{ textDecoration: view.held ? 'underline dotted' : 'none', cursor: view.held ? 'help' : 'default' }}>
              {t('admin.mailNode.seats.held', { held: view.held })}
            </span>
            <span>{t('admin.mailNode.seats.free', { free: view.free })}</span>
          </>
        ) : t('admin.mailNode.seats.unknown')}
      </div>
      {!compact && seats.source === 'graph' && seats.checkedAt && (
        <div style={noteStyle}>{t('admin.mailNode.seats.checkedAt', { at: formatDateTime(seats.checkedAt) })}</div>
      )}
      {!compact && seats.mode === 'manual' && <div style={noteStyle}>{t('admin.mailNode.seats.manual')}</div>}
      {!compact && seats.notReconciled && <div style={noteStyle}>{t('admin.mailNode.seats.notReconciled')}</div>}
      {!compact && seats.stale && (
        <div role="alert" style={warnStyle}>{t('admin.mailNode.seats.stale', { at: formatDateTime(seats.checkedAt) })}</div>
      )}
      {!compact && seats.over && <div role="alert" style={warnStyle}>{t('admin.mailNode.seats.over')}</div>}
      {!compact && seats.requests?.length > 0 && (
        <div data-seat-requests style={noteStyle}>
          {t('admin.mailNode.seats.openRequests')}
          <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
            {seats.requests.map((r) => (
              <li key={r.id}>
                {t('admin.mailNode.seats.openRequest', {
                  seats: r.seats, by: r.requestedBy || t('admin.mailNode.someone'), at: formatDateTime(r.requestedAt),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!compact && isAdmin && (
        <div data-seat-hold style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={noteStyle}>
            {t('admin.mailNode.seats.holdLabel')}{' '}
            <input inputMode="numeric" value={holdValue} onChange={(e) => setHold(e.target.value)} style={inputStyle} />
          </label>
          <button type="button" onClick={saveHold} disabled={busy || hold == null} style={buttonStyle}>{t('common.save')}</button>
          <span style={noteStyle}>{t('admin.mailNode.seats.holdHint')}</span>
        </div>
      )}
      {(showRequest || canReconcile) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {canReconcile && (
            <button type="button" onClick={reconcile} disabled={busy} style={buttonStyle}>
              {busy ? t('admin.mailNode.seats.checking') : t('admin.mailNode.seats.check')}
            </button>
          )}
          {showRequest && !asking && (
            <button type="button" onClick={() => setAsking(true)} disabled={busy} style={buttonStyle}>
              {t('admin.mailNode.seats.request')}
            </button>
          )}
          {asking && (
            <>
              <label style={noteStyle}>
                {t('admin.mailNode.seats.requestCount')}{' '}
                <input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} style={inputStyle} />
              </label>
              <button type="button" onClick={sendRequest} disabled={busy} style={buttonStyle}>{t('admin.mailNode.seats.requestSend')}</button>
              <button type="button" onClick={() => setAsking(false)} disabled={busy} style={buttonStyle}>{t('common.cancel')}</button>
            </>
          )}
        </div>
      )}
      {notice && <div role="status" style={noteStyle}>{t(notice)}</div>}
      {error && <div role="alert" style={{ ...noteStyle, color: 'var(--red)' }}>{t(error.key)}{error.detail ? ` (${error.detail})` : ''}</div>}
    </div>
  );
}
