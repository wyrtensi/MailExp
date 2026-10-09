import { useTranslation } from 'react-i18next';
import LogoMark from './LogoMark.jsx';
import { signInErrorKey } from '../utils/authMode.js';

// Full-page refusal for a user the identity gate turned away (deleted, turned off or not
// approved). There is nothing to retry: the administrator has to change the access.
export default function AccessDeniedPage({ code }) {
  const { t } = useTranslation();
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
        </div>
      </div>
    </div>
  );
}
