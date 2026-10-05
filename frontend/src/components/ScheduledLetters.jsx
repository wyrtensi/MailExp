import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useMobile } from '../hooks/useMobile.js';
import { accountLabel } from '../utils/accountLabel.js';
import { formatDateTime } from '../utils/formatDate.js';
import {
  DELIVERED_UNRECORDED, SCHEDULED_ACTION_LABEL_KEYS, SCHEDULED_STATUS_LABEL_KEYS, scheduledActions, scheduledStatusKey,
} from '../utils/scheduledSend.js';
import { refreshScheduledSummary, restoreCompose, sendFailureText } from '../utils/sendTracker.js';
import ConfirmOverlay from './ConfirmOverlay.jsx';
import SendLaterMenu from './SendLaterMenu.jsx';

// Letters waiting to be sent (backend routes/scheduled.js): the sidebar's count, the Scheduled
// dialog, and a letter given back by an undo or edit while another composer was open (it opens
// once that composer closes). On start, the user hears of their letters that were not sent while
// they were away.
export default function ScheduledLetters() {
  const { t } = useTranslation();
  const showScheduled = useStore(s => s.showScheduled);
  const composing = useStore(s => s.composing);
  const queuedComposes = useStore(s => s.queuedComposes);
  // The letters not sent while the user was away are announced once per page load.
  const announcedRef = useRef(false);

  useEffect(() => {
    let timer = null;
    const run = async () => {
      const result = await refreshScheduledSummary();
      if (!result) return;
      const first = !announcedRef.current;
      announcedRef.current = true;
      if (first && result.failed) {
        const { addNotification, setShowScheduled } = useStore.getState();
        addNotification({
          type: 'error',
          title: t('scheduled.failedOnStartTitle', { count: result.failed }),
          body: t('scheduled.failedOnStartBody'),
          persistent: true,
          allowWrap: true,
          onAction: () => setShowScheduled(true),
          actionLabel: t('scheduled.view'),
        });
      }
    };
    run();
    const onChange = () => {
      clearTimeout(timer);
      // Many tabs hear the same change: spread their refreshes.
      timer = setTimeout(run, 1500 + Math.random() * 1500);
    };
    window.addEventListener('mailexpert:scheduled_changed', onChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mailexpert:scheduled_changed', onChange);
    };
  }, [t]);

  useEffect(() => {
    if (composing || !queuedComposes.length) return;
    useStore.getState().openNextQueuedCompose();
  }, [composing, queuedComposes]);

  return showScheduled ? <ScheduledDialog /> : null;
}

function recipientsText(letter) {
  const all = [...(letter.to || []), ...(letter.cc || []), ...(letter.bcc || [])];
  if (!all.length) return '';
  return all.length > 2 ? `${all.slice(0, 2).join(', ')} +${all.length - 2}` : all.join(', ');
}

function ScheduledDialog() {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const titleId = useId();
  const filterId = useId();
  const accounts = useStore(s => s.accounts);
  const user = useStore(s => s.user);
  const setShowScheduled = useStore(s => s.setShowScheduled);
  const [accountId, setAccountId] = useState(() => useStore.getState().selectedAccountId || '');
  const [letters, setLetters] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState('');
  const [rescheduling, setRescheduling] = useState(null); // { letter, anchor }
  const [confirm, setConfirm] = useState(null);

  const close = useCallback(() => setShowScheduled(false), [setShowScheduled]);

  const load = useCallback(async () => {
    try {
      const data = await api.scheduled.list(accountId || undefined);
      setLetters(data.letters || []);
      setLoadError('');
    } catch (err) {
      setLoadError(err?.message || t('scheduled.loadFailed'));
    }
  }, [accountId, t]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    window.addEventListener('mailexpert:scheduled_changed', load);
    return () => window.removeEventListener('mailexpert:scheduled_changed', load);
  }, [load]);
  useEffect(() => {
    if (rescheduling || confirm) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rescheduling, confirm, close]);

  const changed = () => {
    window.dispatchEvent(new CustomEvent('mailexpert:scheduled_changed'));
    return load();
  };

  const run = async (letter, action) => {
    setBusyId(letter.id);
    setActionError('');
    try {
      await action();
    } catch (err) {
      setActionError(err?.code === 'send_started' ? t('scheduled.undoTooLate') : (err?.message || t('scheduled.failure.generic')));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const edit = (letter) => run(letter, async () => {
    const { compose, sendAt } = await api.scheduled.cancel(letter.id, 'edit');
    close();
    window.dispatchEvent(new CustomEvent('mailexpert:scheduled_changed'));
    if (compose) restoreCompose(compose, { sendAt });
  });

  // A letter the server accepted (delivered_unrecorded) went out: only its entry is removed.
  const discardKeys = (letter) => {
    if (letter.status === 'queued') return ['scheduled.cancelTitle', 'scheduled.cancelBody'];
    return letter.errorCode === DELIVERED_UNRECORDED
      ? ['scheduled.discardDeliveredTitle', 'scheduled.discardDeliveredBody']
      : ['scheduled.discardTitle', 'scheduled.discardBody'];
  };
  const discard = (letter) => setConfirm({
    title: t(discardKeys(letter)[0]),
    message: t(discardKeys(letter)[1]),
    confirmLabel: t(letter.status === 'queued' ? 'scheduled.actions.cancel' : 'scheduled.actions.discard'),
    onConfirm: async () => {
      await api.scheduled.cancel(letter.id, 'discard');
      await changed();
    },
  });

  const resend = (letter) => {
    const send = () => run(letter, async () => { await api.scheduled.resend(letter.id); await changed(); });
    if (letter.status !== 'needs_attention') return send();
    setConfirm({
      title: t('scheduled.resendTitle'),
      message: t('scheduled.resendUncertainBody'),
      confirmLabel: t('scheduled.actions.resend'),
      onConfirm: async () => {
        await api.scheduled.resend(letter.id);
        await changed();
      },
    });
    return undefined;
  };

  const reschedule = (letter, at) => run(letter, async () => {
    setRescheduling(null);
    await api.scheduled.reschedule(letter.id, at.toISOString());
    await changed();
  });

  const actionButton = (letter, action) => {
    const handlers = {
      edit: () => edit(letter),
      reschedule: (e) => setRescheduling({ letter, anchor: e.currentTarget.getBoundingClientRect() }),
      cancel: () => discard(letter),
      discard: () => discard(letter),
      resend: () => resend(letter),
    };
    const danger = action === 'cancel' || action === 'discard';
    return (
      <button
        key={action}
        type="button"
        data-scheduled-action={action}
        disabled={busyId === letter.id}
        onClick={handlers[action]}
        style={{
          padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
          border: '1px solid var(--border)', background: 'var(--bg-tertiary)',
          color: danger ? 'var(--red)' : 'var(--text-secondary)',
          cursor: busyId === letter.id ? 'default' : 'pointer', opacity: busyId === letter.id ? 0.6 : 1,
        }}
      >
        {t(SCHEDULED_ACTION_LABEL_KEYS[action])}
      </button>
    );
  };

  const statusColor = (key) => (key === 'failed' || key === 'needsAttention' ? 'var(--red)' : key === 'retrying' ? '#d97706' : 'var(--accent)');

  return (
    <div
      onClick={close}
      style={{
        position: 'fixed', inset: 0, zIndex: 2050, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        padding: isMobile ? 0 : 24,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-scheduled-dialog
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-secondary)', border: isMobile ? 'none' : '1px solid var(--border-subtle)',
          borderRadius: isMobile ? 0 : 12, width: isMobile ? '100%' : 640, maxWidth: '100%',
          maxHeight: isMobile ? '100%' : '80vh', display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--shadow-modal)', paddingTop: isMobile ? 'var(--sat)' : 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
            {t('scheduled.title')}
          </h2>
          <label htmlFor={filterId} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {t('scheduled.mailbox')}
          </label>
          <select
            id={filterId}
            value={accountId}
            onChange={e => setAccountId(e.target.value)}
            style={{
              maxWidth: 220, padding: '5px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text-primary)', fontSize: 12,
            }}
          >
            <option value="">{t('scheduled.allMailboxes')}</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.email_address}</option>)}
          </select>
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close')}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 4, display: 'flex' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '6px 0' }}>
          {actionError && (
            <div role="alert" style={{ margin: '8px 18px', padding: '8px 10px', borderRadius: 7, fontSize: 12, color: 'var(--red)', background: 'rgba(248,113,113,0.1)' }}>
              {actionError}
            </div>
          )}
          {loadError && <div role="alert" style={{ padding: '18px', fontSize: 13, color: 'var(--red)' }}>{loadError}</div>}
          {!loadError && letters === null && <div style={{ padding: 18, fontSize: 13, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>}
          {!loadError && letters?.length === 0 && (
            <div style={{ padding: '28px 18px', fontSize: 13, color: 'var(--text-tertiary)', textAlign: 'center' }}>{t('scheduled.empty')}</div>
          )}
          {letters?.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {letters.map(letter => {
                const statusKey = scheduledStatusKey(letter);
                const actions = scheduledActions(letter);
                const byOther = letter.author && letter.author.id !== user?.id;
                return (
                  <li key={letter.id} data-scheduled-letter={letter.id} style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: statusColor(statusKey), textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {t(SCHEDULED_STATUS_LABEL_KEYS[statusKey])}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{formatDateTime(letter.sendAt)}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{accountLabel(accounts, letter.accountId)}</span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {letter.subject || t('common.noSubject')}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t('scheduled.to', { recipients: recipientsText(letter) })}
                      {letter.attachmentCount > 0 ? ` · ${t('scheduled.attachments', { count: letter.attachmentCount })}` : ''}
                      {byOther ? ` · ${t('scheduled.by', { author: letter.author.email || '' })}` : ''}
                    </div>
                    {(statusKey === 'failed' || statusKey === 'needsAttention' || statusKey === 'retrying' || statusKey === 'delivered') && (
                      <div style={{ fontSize: 12, color: statusKey === 'retrying' || statusKey === 'delivered' ? 'var(--text-secondary)' : 'var(--red)', marginTop: 6, lineHeight: 1.4 }}>
                        {statusKey === 'needsAttention' ? t('scheduled.needsAttentionHint') : sendFailureText(letter.errorCode, letter.error)}
                      </div>
                    )}
                    {letter.keptUntil && (
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                        {t('scheduled.keptUntil', { date: formatDateTime(letter.keptUntil) })}
                      </div>
                    )}
                    {actions.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        {actions.map(action => actionButton(letter, action))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {rescheduling && (
        <div onClick={e => e.stopPropagation()}>
          <SendLaterMenu
            anchorRect={rescheduling.anchor}
            isMobile={isMobile}
            title={t('scheduled.actions.reschedule')}
            initial={new Date(rescheduling.letter.sendAt)}
            onClose={() => setRescheduling(null)}
            onPick={(at) => reschedule(rescheduling.letter, at)}
          />
        </div>
      )}
      <div onClick={e => e.stopPropagation()}>
        <ConfirmOverlay dialog={confirm} onClose={() => setConfirm(null)} />
      </div>
    </div>
  );
}
