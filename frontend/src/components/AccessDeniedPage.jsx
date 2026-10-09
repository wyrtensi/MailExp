import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import LogoMark from './LogoMark.jsx';
import { signInErrorKey } from '../utils/authMode.js';

// Full-page refusal for a user the identity gate turned away (deleted, turned off or not
// approved). The administrator may have restored the access since, or the person has another
// allowed account, so it offers a re-check and a sign-out to come back as someone else.
export default function AccessDeniedPage({ code, retrying = false, onRetry, onSwitchAccount }) {
  const { t } = useTranslation();
  const [switching, setSwitching] = useState(false);
  const busy = retrying || switching;
  const buttonStyle = {
    width: '100%', padding: '10px 16px', borderRadius: 8, fontSize: 14, fontWeight: 500,
    cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
  };
  return (
    <div style={{
      minHeight: 'var(--app-height, 100svh)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'var(--bg-primary)', padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 380, textAlign: 'center' }}>
        <div style={{ marginBottom: 32 }}>
          <LogoMark size={44} />
        </div>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 16, padding: 32 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 500, color: 'var(--text-primary)' }}>
            {t('login.google.noAccessTitle')}
          </h2>
          <p role="alert" style={{ margin: 0, fontSize: 14, color: 'var(--red)' }}>
            {t(signInErrorKey(code))}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 24 }}>
            {onRetry && (
              <button type="button" disabled={busy} onClick={onRetry}
                style={{ ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' }}>
                {retrying ? t('login.google.retrying') : t('login.google.retry')}
              </button>
            )}
            {onSwitchAccount && (
              <button type="button" disabled={busy}
                onClick={async () => { setSwitching(true); try { await onSwitchAccount(); } finally { setSwitching(false); } }}
                style={{ ...buttonStyle, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                {t('login.google.switchAccount')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
