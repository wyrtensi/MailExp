import { useTranslation } from 'react-i18next';

// The bar's title for each reason safeViewState() gives.
const TITLES = {
  spam: 'message.safeView.title.spam',
  phishing: 'message.safeView.title.phishing',
  malware: 'message.safeView.title.malware',
  spoof: 'message.safeView.title.spoof',
};

// EOP categories in words (Microsoft's "Anti-spam message headers"); the code itself stays in the
// line's tooltip. A code not listed here is shown as it is.
const CATEGORY_LABELS = {
  SPM: 'message.safeView.categories.spam',
  HSPM: 'message.safeView.categories.highSpam',
  BULK: 'message.safeView.categories.bulk',
  OSPM: 'message.safeView.categories.outboundSpam',
  PHSH: 'message.safeView.categories.phishing',
  HPHSH: 'message.safeView.categories.highPhishing',
  HPHISH: 'message.safeView.categories.highPhishing',
  INTOS: 'message.safeView.categories.intraOrgPhishing',
  DIMP: 'message.safeView.categories.domainImpersonation',
  UIMP: 'message.safeView.categories.userImpersonation',
  GIMP: 'message.safeView.categories.mailboxImpersonation',
  BIMP: 'message.safeView.categories.brandImpersonation',
  SPOOF: 'message.safeView.categories.spoof',
  MALW: 'message.safeView.categories.malware',
  AMP: 'message.safeView.categories.antiMalware',
  SAP: 'message.safeView.categories.safeAttachments',
  FTBP: 'message.safeView.categories.fileType',
};

// The bar above a letter in safe view (utils/safeView.js): why it is shown as text, and the button
// that shows it in full for this view only. Without onShowFull it is a warning over a letter shown
// as usual (a spoofed sender outside Spam). The open letter's bar is a region named after the
// letter (label), so a screen reader lists it among the landmarks; the stacked letters' compact
// bars are not, or a long conversation would fill the landmark list. The button is a real button.
export default function SafeViewNotice({ reason, eopCategory = null, onShowFull = null, compact = false, label = null }) {
  const { t } = useTranslation();
  const color = reason === 'spam' ? 'var(--amber)' : 'var(--red)';
  const category = eopCategory ? String(eopCategory).toUpperCase() : null;
  const regionProps = compact ? {} : { role: 'region', 'aria-label': label || t('message.safeView.label') };
  return (
    <div
      {...regionProps}
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
            {onShowFull ? t('message.safeView.explain') : t('message.safeView.explainWarn')}
          </div>
        )}
        {category && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }} title={`CAT:${category}`}>
            {t('message.safeView.category', { category: CATEGORY_LABELS[category] ? t(CATEGORY_LABELS[category]) : category })}
          </div>
        )}
      </div>
      {onShowFull && (
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
      )}
    </div>
  );
}
