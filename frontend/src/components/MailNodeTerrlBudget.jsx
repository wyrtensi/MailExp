import { useTranslation } from 'react-i18next';
import { TERRL_WARN_PERCENT } from '../utils/mailNode.js';

const noteStyle = { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 };
const when = (at) => (at ? new Date(at).toLocaleString() : '');

// The tenant's external recipient budget (R-21, backend services/mailNode/terrl.js): unique
// external recipients of the last 24 hours against the limit, the limit's origin and the young
// tenant's ramp, and whether the node's log reached back over the whole day. Amber at 80 percent
// (the alert's threshold), red once used up. `budget`: GET /api/mail-node/eop/budget.
export default function MailNodeTerrlBudget({ budget }) {
  const { t } = useTranslation();
  if (!budget) return null;
  let color = 'var(--text-primary)';
  if (budget.exceeded) color = 'var(--red)';
  else if (budget.warn) color = 'var(--amber)';
  return (
    <div data-terrl-budget data-terrl-level={budget.limit == null ? 'none' : (budget.exceeded && 'exceeded') || (budget.warn && 'warn') || 'ok'}>
      <div style={{ fontSize: 13, fontWeight: 600, color }}>
        {budget.limit == null
          ? t('admin.eop.budgetNoLimit', { used: budget.used })
          : t('admin.eop.budgetUsed', { used: budget.used, limit: budget.limit, percent: budget.percent })}
      </div>
      {budget.limit != null && (
        <div style={noteStyle}>
          {budget.limitFrom === 'licenses'
            ? t('admin.eop.budgetFromLicenses', { full: budget.fullLimit })
            : t('admin.eop.budgetFromTerrl', { full: budget.fullLimit })}
          {budget.rampPercent < 100 && ` ${t('admin.eop.budgetRamp', { percent: budget.rampPercent, days: budget.ageDays })}`}
        </div>
      )}
      {budget.warn && <div role="alert" style={{ ...noteStyle, color }}>{t('admin.eop.budgetWarn', { percent: TERRL_WARN_PERCENT })}</div>}
      <div style={noteStyle}>
        {budget.log?.read
          ? (budget.log.covered ? t('admin.eop.budgetLogCovered') : t('admin.eop.budgetLogPartial', { at: when(budget.log.oldestAt) }))
          : t('admin.eop.budgetLogUnread')}
      </div>
    </div>
  );
}
