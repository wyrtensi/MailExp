import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deleteConfirmationMatches } from '../utils/mailNode.js';

// Shared confirm overlay (replaces window.confirm everywhere). A dialog with `requireTyped` (a mail
// node mailbox's address) also asks for that text typed out in full, like deleting a repository on
// GitHub: the confirm button stays disabled until it matches, ignoring case and outer spaces.
// `typedLabel` is the line above that field.
export default function ConfirmOverlay({ dialog, onClose }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');

  // Clear transient state whenever a different dialog is opened, so a previous
  // failure or typed text never leaks into the next confirmation.
  useEffect(() => { setBusy(false); setError(''); setTyped(''); }, [dialog]);

  if (!dialog) return null;
  const typedOk = !dialog.requireTyped || deleteConfirmationMatches(typed, dialog.requireTyped);

  // Await the action rather than firing it into the void. This previously closed the
  // overlay and then called onConfirm() unawaited with no catch, so a rejected request
  // left no trace at all: the dialog was already gone and the rejection was unhandled.
  // Every destructive action here (delete account, delete alias, delete user, disable
  // a user's 2FA, delete an SSO provider, unlink an identity) therefore looked like it
  // had succeeded while the server had refused it. Keep the dialog open on failure so
  // the error is shown where the user is already looking; close only on success.
  const runConfirm = async () => {
    if (!typedOk) return;
    setError('');
    setBusy(true);
    try {
      await dialog.onConfirm();
      onClose();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9100,
      background: 'rgba(0,0,0,0.55)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
      animation: 'backdrop-enter var(--motion-fast) var(--ease-standard) both',
    }} onClick={busy ? undefined : onClose}>
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 12, padding: '24px 24px 20px', maxWidth: 360, width: '100%',
        boxShadow: 'var(--shadow-modal)',
        animation: 'modal-enter var(--motion-normal) var(--ease-emphasized) both',
      }} onClick={e => e.stopPropagation()}>
        <p style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          {dialog.title}
        </p>
        <p style={{ margin: dialog.requireTyped ? '0 0 14px' : '0 0 20px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {dialog.message}
        </p>
        {dialog.requireTyped && (
          <label style={{ display: 'block', marginBottom: 16 }}>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              {dialog.typedLabel}
            </span>
            <input
              data-confirm-typed
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && typedOk && !busy) runConfirm(); }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy}
              style={{
                width: '100%', padding: '8px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
          </label>
        )}
        {error && (
          <div style={{
            marginBottom: 14, padding: '8px 10px',
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
            borderRadius: 7, color: 'var(--red)', fontSize: 12,
          }}>{t('common.error', { message: error })}</div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={busy} className="btn-press" style={{
            padding: '7px 16px', borderRadius: 7, border: '1px solid var(--border-subtle)',
            background: 'transparent', color: 'var(--text-secondary)',
            cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, fontSize: 13,
          }}>{t('common.cancel')}</button>
          <button onClick={runConfirm} disabled={busy || !typedOk} data-confirm-button className="btn-press" style={{
            padding: '7px 16px', borderRadius: 7, border: 'none',
            background: '#dc2626', color: 'white',
            cursor: busy || !typedOk ? 'default' : 'pointer', opacity: busy ? 0.7 : (typedOk ? 1 : 0.45), fontSize: 13, fontWeight: 500,
          }}>{busy ? t('common.loading') : (dialog.confirmLabel || t('common.delete'))}</button>
        </div>
      </div>
    </div>
  );
}
