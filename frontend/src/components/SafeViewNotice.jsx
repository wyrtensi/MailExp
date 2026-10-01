import { useTranslation } from 'react-i18next';

// The bar's title for each reason safeViewReason() gives.
const TITLES = {
  spam: 'message.safeView.title.spam',
  phishing: 'message.safeView.title.phishing',
  malware: 'message.safeView.title.malware',
  spoof: 'message.safeView.title.spoof',
};

// The bar above a letter shown in safe view (utils/safeView.js): why it is shown as text, and the
// button that shows it in full for this view only. A region with its own name, so a screen reader
// lists it among the landmarks; the button is a real button, reachable by Tab and Enter.
// compact: the shorter bar of a letter stacked in the conversation under the open one.
export default function SafeViewNotice({ reason, eopCategory = null, onShowFull, compact = false }) {
  const { t } = useTranslation();
  const color = reason === 'spam' ? 'var(--amber)' : 'var(--red)';
  return (
    <div
      role="region"
      aria-label={t('message.safeView.label')}
      className="msg-notice safe-view-notice"
      style={{
        marginBottom: compact ? 8 : 12,
        padding: compact ? '8px 12px' : '11px 14px',
        background: `color-mix(in srgb, ${color} 12%, var(--bg-secondary))`,
        border: `1px solid color-mix(in srgb, ${color} 40%, var(--border))`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}
    >
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" style={{ flexShrink: 0 }}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t(TITLES[reason] || TITLES.spam)}
        </div>
        {!compact && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
            {t('message.safeView.explain')}
          </div>
        )}
        {eopCategory && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            {t('message.safeView.category', { category: eopCategory })}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onShowFull}
        style={{
          background: 'var(--bg-primary)', color: 'var(--text-primary)',
          border: `1px solid ${color}`, borderRadius: 6,
          padding: compact ? '4px 10px' : '6px 12px',
          fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
        }}
      >
        {t('message.safeView.showFull')}
      </button>
    </div>
  );
}
