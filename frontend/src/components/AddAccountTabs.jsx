import { useTranslation } from 'react-i18next';

// The top of "Add account": the ways to add a mailbox, the chosen way's form under it. The two
// everyday ways (personal Gmail and our mailbox) are large cards side by side so the choice is
// explicit; manual server setup (administrators only) is a small link under them. The options come
// from utils/addAccount.js, which decides what is offered and why an option is inactive; an
// inactive option can still be chosen and says why instead of showing its form. Every choice is a
// plain toggle button (aria-pressed), so Tab and Enter work without a custom keyboard model.
const SECONDARY_KINDS = new Set(['manual']);

export default function AddAccountTabs({ options, active, onSelect, renderForm }) {
  const { t } = useTranslation();
  if (!options.length) return null;
  const current = options.find((option) => option.kind === active) ?? null;
  const primary = options.filter((option) => !SECONDARY_KINDS.has(option.kind));
  const secondary = options.filter((option) => SECONDARY_KINDS.has(option.kind));
  return (
    <div>
      <div role="group" aria-label={t('admin.accounts.addTitle')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
        {primary.map((option) => {
          const selected = option.kind === current?.kind;
          return (
            <button
              key={option.kind}
              id={`add-account-tab-${option.kind}`}
              type="button"
              aria-pressed={selected}
              aria-controls="add-account-panel"
              onClick={() => onSelect(option.kind)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, textAlign: 'left',
                padding: selected ? '11px 13px' : '12px 14px', borderRadius: 8, cursor: 'pointer',
                background: selected ? 'var(--bg-hover)' : 'none',
                border: `${selected ? 2 : 1}px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                opacity: option.enabled ? 1 : 0.6,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t(option.titleKey)}</span>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t(option.descriptionKey)}</span>
            </button>
          );
        })}
      </div>
      {secondary.map((option) => {
        const selected = option.kind === current?.kind;
        return (
          <button
            key={option.kind}
            id={`add-account-tab-${option.kind}`}
            type="button"
            aria-pressed={selected}
            aria-controls="add-account-panel"
            onClick={() => onSelect(option.kind)}
            style={{
              display: 'block', background: 'none', border: 'none', padding: '2px 0', marginBottom: 6, cursor: 'pointer',
              fontSize: 12, color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: selected ? 600 : 400, textDecoration: 'underline',
            }}
          >
            {t(option.titleKey)}
          </button>
        );
      })}
      <div id="add-account-panel" role="region" aria-labelledby={current ? `add-account-tab-${current.kind}` : undefined} style={{ marginTop: 8 }}>
        {current && SECONDARY_KINDS.has(current.kind) && (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>{t(current.descriptionKey)}</div>
        )}
        {current?.enabled
          ? renderForm(current.kind)
          : <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t(current?.hintKey || 'common.loading')}</div>}
      </div>
    </div>
  );
}
