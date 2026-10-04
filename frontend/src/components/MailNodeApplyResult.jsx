import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../utils/formatDate.js';
import {
  APPLY_STATUS_COLORS,
  applyItemKey,
  applyStatusKey,
  mailNodeErrorKey,
} from '../utils/mailNode.js';

const noteStyle = { fontSize: 11, color: 'var(--text-tertiary)' };
const monoStyle = { fontFamily: 'JetBrains Mono, monospace', fontSize: 11 };

// In the interface language ("5 окт. 2026, 08:00"), as the rest of the panel.
const when = (at) => formatDateTime(at);
const shown = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));

// The forwarding hosts item's detail (R-12): how many EOP ranges of the panel's list are on the node,
// which are missing, entries of others with the spam filter off overlapping a range, the ranges
// whose filter the panel turned on, and the entries the panel did not add (left alone).
function ForwardingHosts({ fwdhosts }) {
  const { t } = useTranslation();
  const missing = fwdhosts.missing ?? [];
  const foreign = fwdhosts.foreign ?? [];
  const keepSpam = fwdhosts.keepSpam ?? [];
  const lineStyle = { ...noteStyle, ...monoStyle };
  return (
    <div data-fwdhosts>
      <div style={noteStyle}>
        {t('admin.mailNode.fwdhostsRanges', { version: fwdhosts.version, present: fwdhosts.wanted - missing.length, wanted: fwdhosts.wanted })}
      </div>
      {missing.length > 0 && <div data-fwdhosts-missing style={lineStyle}>{t('admin.mailNode.fwdhostsMissing', { list: missing.join(', ') })}</div>}
      {keepSpam.length > 0 && (
        <div data-fwdhosts-keep-spam style={{ ...lineStyle, color: 'var(--red)' }}>{t('admin.mailNode.fwdhostsKeepSpam', { list: keepSpam.join(', ') })}</div>
      )}
      {fwdhosts.filterTurnedOn?.length > 0 && (
        <div data-fwdhosts-filter-on style={lineStyle}>{t('admin.mailNode.fwdhostsFilterTurnedOn', { list: fwdhosts.filterTurnedOn.join(', ') })}</div>
      )}
      {foreign.length > 0 && <div data-fwdhosts-foreign style={lineStyle}>{t('admin.mailNode.fwdhostsForeign', { list: foreign.join(', ') })}</div>}
    </div>
  );
}

// The last "apply" of the node settings, item by item (backend services/mailNode/nodeApply.js):
// what each item is and for what, what the panel found (in place, changed, failed, skipped, or
// waiting for its own action) and why, with what changed from what. `result`: { at, items }.
export default function MailNodeApplyResult({ result }) {
  const { t } = useTranslation();
  const items = result?.items ?? [];
  return (
    <div data-apply-result>
      {result?.at && <div style={noteStyle}>{t('admin.mailNode.applyAt', { at: when(result.at) })}</div>}
      <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 4 }}>
        {items.map((item) => (
          <li key={`${item.item}:${item.target ?? ''}`} data-apply-item={item.item} data-apply-status={item.status} style={{ fontSize: 12, color: 'var(--text-primary)' }}>
            <span>{t(applyItemKey(item.item))}</span>
            {item.target && <span style={{ ...monoStyle, color: 'var(--text-secondary)', marginLeft: 6 }}>{item.target}</span>}
            <span style={{ marginLeft: 8, fontWeight: 600, color: APPLY_STATUS_COLORS[item.status] ?? 'var(--red)' }}>{t(applyStatusKey(item.status))}</span>
            {item.code && (
              <span style={{ ...noteStyle, marginLeft: 8 }}>
                {t(mailNodeErrorKey(item.code))}{item.detail ? ` (${item.detail})` : ''}
              </span>
            )}
            {item.status === 'changed' && (item.from !== undefined || item.to !== undefined) && !item.counts && (
              <span style={{ ...noteStyle, marginLeft: 8 }}>{t('admin.mailNode.applyFromTo', { from: shown(item.from), to: shown(item.to) })}</span>
            )}
            {item.current && (
              <span style={{ ...noteStyle, marginLeft: 8 }}>{t('admin.mailNode.applyCurrent', { current: item.current })}</span>
            )}
            {item.counts && (
              <span style={{ ...noteStyle, marginLeft: 8 }}>{t('admin.mailNode.applyCounts', item.counts)}</span>
            )}
            {item.mailboxes?.length > 0 && (
              <div style={{ ...noteStyle, ...monoStyle }}>{t('admin.mailNode.applyFailedMailboxes', { list: item.mailboxes.join(', ') })}</div>
            )}
            {item.fwdhosts && <ForwardingHosts fwdhosts={item.fwdhosts} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
