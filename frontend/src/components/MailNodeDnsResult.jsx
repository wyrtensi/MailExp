import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

const when = (at) => (at ? new Date(at).toLocaleString() : '');

// One record to publish: its name and type, the value with a button that copies it.
function RecordToPublish({ record }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(record.value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div data-dns-record={`${record.type} ${record.name}`} style={{ marginTop: 6 }}>
      <div style={noteStyle}>{t('admin.mailNode.dnsRecord', { name: record.name, type: record.type })}</div>
      <code style={recordStyle}>{record.value}</code>
      <button type="button" onClick={copy} style={{ ...buttonStyle, marginTop: 4 }}>
        {copied ? t('admin.mailNode.dkimCopied') : t('admin.mailNode.dkimCopy')}
      </button>
    </div>
  );
}

// The last DNS check of a domain or of the node (backend services/mailNode/dnsCheck.js), check by
// check: what is checked, ok / warning / error, why in words with what DNS has, and for a check that
// is not ok the exact record to publish with a copy button. `result`: { at, overall, checks }.
// Nothing here changes anything: the results only warn.
export default function MailNodeDnsResult({ result }) {
  const { t } = useTranslation();
  const checks = result?.checks ?? [];
  return (
    <div data-dns-result data-dns-overall={result?.overall ?? ''}>
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
