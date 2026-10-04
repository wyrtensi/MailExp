import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../utils/formatDate.js';
import {
  DNS_STATUS_COLORS,
  dnsCheckKey,
  dnsCodeKey,
  dnsCodeValues,
  dnsStatusKey,
} from '../utils/mailNode.js';

const noteStyle = { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 };
const recordStyle = {
  display: 'block', marginTop: 4, padding: '6px 8px', borderRadius: 6, background: 'var(--bg-tertiary)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, wordBreak: 'break-all', userSelect: 'all', color: 'var(--text-primary)',
};
const buttonStyle = {
  padding: '3px 8px', borderRadius: 7, fontSize: 11, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const warningBoxStyle = {
  marginTop: 6, padding: 8, borderRadius: 8, fontSize: 11, lineHeight: 1.5, color: 'var(--text-primary)',
  background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)',
};
// How long "Copied" or the failure stays before the button reads "Copy" again.
const COPY_FEEDBACK_MS = 3000;

// In the interface language ("5 окт. 2026, 08:00"), as the rest of the panel.
const when = (at) => formatDateTime(at);

// A button that copies a value, and says (to screen readers too) whether it worked; the word goes
// back to "Copy" after a few seconds.
export function CopyButton({ value, style }) {
  const { t } = useTranslation();
  // null, 'copied' or 'failed'.
  const [state, setState] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    let next = 'copied';
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      next = 'failed';
    }
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), COPY_FEEDBACK_MS);
  };
  let label = t('admin.mailNode.dkimCopy');
  if (state === 'copied') label = t('admin.mailNode.dkimCopied');
  if (state === 'failed') label = t('admin.mailNode.copyFailed');
  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      data-copy-state={state ?? 'idle'}
      style={{ ...buttonStyle, ...(state === 'failed' ? { color: 'var(--red)' } : {}), ...style }}
    >
      {label}
    </button>
  );
}

// One record to publish: its name and type, the value with a button that copies it.
function RecordToPublish({ record }) {
  const { t } = useTranslation();
  return (
    <div data-dns-record={`${record.type} ${record.name}`} style={{ marginTop: 6 }}>
      <div style={noteStyle}>{t('admin.mailNode.dnsRecord', { name: record.name, type: record.type })}</div>
      <code style={recordStyle}>{record.value}</code>
      <CopyButton value={record.value} style={{ marginTop: 4 }} />
    </div>
  );
}

// The last DNS check of a domain or of the node (backend services/mailNode/dnsCheck.js), check by
// check: what is checked, ok / warning / error, why in words with what DNS has, and for a check that
// is not ok the exact record to publish with a copy button. When the latest check could not ask DNS
// (lookupFailed), a note says so and the result shown is the one before. `result`: { at, overall,
// checks, lookupFailed }. Nothing here changes anything: the results only warn.
export default function MailNodeDnsResult({ result }) {
  const { t } = useTranslation();
  const checks = result?.checks ?? [];
  const failed = result?.lookupFailed;
  return (
    <div data-dns-result data-dns-overall={result?.overall ?? ''}>
      {failed && (
        <div role="status" data-dns-lookup-failed={failed.code} style={warningBoxStyle}>
          {t(result.overall ? 'admin.mailNode.dnsLookupFailedKept' : 'admin.mailNode.dnsLookupFailedNone', {
            at: when(failed.at), reason: t(dnsCodeKey(failed.code), dnsCodeValues({ ...failed, name: failed.checks?.[0]?.name ?? '' })),
          })}
        </div>
      )}
      {result?.at && (
        <div style={noteStyle}>
          {t('admin.mailNode.dnsCheckedAt', { at: when(result.at) })}
          {' '}
          <span style={{ fontWeight: 600, color: DNS_STATUS_COLORS[result.overall] ?? 'var(--red)' }}>{t(dnsStatusKey(result.overall))}</span>
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 6 }}>
        {checks.map((check) => (
          <li key={check.check} data-dns-check={check.check} data-dns-status={check.status} style={{ fontSize: 12, color: 'var(--text-primary)' }}>
            <span>{t(dnsCheckKey(check.check))}</span>
            <span style={{ marginLeft: 8, fontWeight: 600, color: DNS_STATUS_COLORS[check.status] ?? 'var(--red)' }}>{t(dnsStatusKey(check.status))}</span>
            {check.code && <div style={noteStyle}>{t(dnsCodeKey(check.code), dnsCodeValues(check))}</div>}
            {check.inheritedFrom && <div style={noteStyle}>{t('admin.mailNode.dnsDmarcInherited', { domain: check.inheritedFrom })}</div>}
            {check.keyFromLastApply && <div style={noteStyle}>{t('admin.mailNode.dnsKeyFromLastApply')}</div>}
            {check.status !== 'ok' && (check.records ?? []).map((record) => (
              <RecordToPublish key={`${record.type} ${record.name} ${record.value}`} record={record} />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
