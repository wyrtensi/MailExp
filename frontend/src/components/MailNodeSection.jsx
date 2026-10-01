import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import MailNodeDomainOnboarding from './MailNodeDomainOnboarding.jsx';
import {
  DEFAULT_DOMAIN_MAILBOXES,
  DEFAULT_QUOTA_MB,
  MAX_DOMAIN_MAILBOXES,
  MAX_QUOTA_MB,
  domainStateKey,
  mailNodeConfigError,
  mailNodeErrorDetail,
  mailNodeErrorKey,
  parseWholeNumber,
  quotaMbInGb,
  sizeParts,
  usagePercent,
} from '../utils/mailNode.js';

const fieldStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const monoFieldStyle = { ...fieldStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4 };
const hintStyle = { display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 };
const buttonStyle = {
  padding: '7px 12px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };
const subTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '20px 0 8px' };
const cellStyle = { padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', fontSize: 13, textAlign: 'left' };
const headCellStyle = { ...cellStyle, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' };

const EMPTY_FORM = { mailHost: '', apiKey: '', quotaMb: String(DEFAULT_QUOTA_MB), diskPingUrl: '' };

// Settings -> Integrations -> "Mail node" (admins only): the mailcow server MailExpert creates
// domain mailboxes on, its domains with their onboarding, the mail disk and the quota of every
// mailbox made there. The EOP section next to it changes domains too: `revision` goes up after any
// such change, and this section tells it about its own through `onDomainsChanged`.
export default function MailNodeSection({ revision = 0, onDomainsChanged }) {
  const { t } = useTranslation();
  const [stored, setStored] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [domains, setDomains] = useState(null);
  // The node's error when it could not list its domains: the panel's own record is shown anyway.
  const [domainsNodeError, setDomainsNodeError] = useState(null);
  const [overview, setOverview] = useState(null);
  const [newDomain, setNewDomain] = useState({ domain: '', mailboxes: String(DEFAULT_DOMAIN_MAILBOXES) });
  const [quotaEdits, setQuotaEdits] = useState({});
  const [openDomain, setOpenDomain] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const fail = (err) => setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });

  // Each list shows on its own: a failing mailbox listing does not hide the domains, and a node
  // that cannot list its domains leaves the panel's record of them on screen with a warning.
  const loadNode = useCallback(async () => {
    const [d, o] = await Promise.allSettled([api.mailNode.listDomains(), api.mailNode.listMailboxes()]);
    if (d.status === 'fulfilled') {
      setDomains(d.value?.domains ?? []);
      setDomainsNodeError(d.value?.node ?? null);
    }
    if (o.status === 'fulfilled') setOverview(o.value);
    const failed = [d, o].find((r) => r.status === 'rejected');
    if (failed) fail(failed.reason);
  }, []);

  useEffect(() => {
    api.mailNode.getConfig()
      .then((cfg) => {
        setStored(cfg);
        setForm({ mailHost: cfg.mailHost, apiKey: cfg.apiKey, quotaMb: String(cfg.quotaMb), diskPingUrl: cfg.diskPingUrl });
      })
      .catch(fail);
  }, []);

  const configured = !!stored?.configured;
  // A domain change reloads both sections through `revision` when the panel shares it.
  const refreshDomains = () => (onDomainsChanged ? onDomainsChanged() : loadNode());
  useEffect(() => {
    if (configured) loadNode();
  }, [configured, loadNode, revision]);

  const run = async (action, noticeKey) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (noticeKey) setNotice(noticeKey);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const configErrorKey = mailNodeConfigError(form, { hasStoredKey: !!stored?.configured });
  const saveConfig = () => run(async () => {
    await api.mailNode.saveConfig({
      mailHost: form.mailHost.trim(), apiKey: form.apiKey, quotaMb: Number(form.quotaMb), diskPingUrl: form.diskPingUrl.trim(),
    });
    const cfg = await api.mailNode.getConfig();
    setStored(cfg);
    setForm((f) => ({ ...f, apiKey: cfg.apiKey }));
    await refreshDomains();
  }, 'admin.mailNode.saved');

  const domainMailboxes = parseWholeNumber(newDomain.mailboxes, 1, MAX_DOMAIN_MAILBOXES);
  const addDomain = () => run(async () => {
    await api.mailNode.addDomain({ domain: newDomain.domain.trim().toLowerCase(), mailboxes: domainMailboxes });
    setNewDomain({ domain: '', mailboxes: String(DEFAULT_DOMAIN_MAILBOXES) });
    await refreshDomains();
  }, 'admin.mailNode.domainAdded');

  const saveQuota = (accountId) => run(async () => {
    await api.mailNode.setQuota(accountId, Number(quotaEdits[accountId]));
    setQuotaEdits((q) => ({ ...q, [accountId]: undefined }));
    await loadNode();
  }, 'admin.mailNode.quotaSaved');

  const size = (bytes) => {
    const p = sizeParts(bytes);
    return `${p.value} ${t(p.unitKey)}`;
  };

  const disk = overview?.disk;
  const quotaGb = quotaMbInGb(form.quotaMb);

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.mailNode.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 16 }}>
        {t('admin.mailNode.description')}
      </div>

      {!stored && !error && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>}

      {stored && (
        <div style={{ display: 'grid', gap: 12 }}>
          <label>
            <span style={labelStyle}>{t('admin.mailNode.hostLabel')}</span>
            <input value={form.mailHost} onChange={(e) => setForm({ ...form, mailHost: e.target.value })} spellCheck={false} placeholder={t('admin.mailNode.hostPh')} style={monoFieldStyle} />
            <span style={hintStyle}>{t('admin.mailNode.hostNote')}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.mailNode.apiKeyLabel')}</span>
            <input type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} style={monoFieldStyle} />
            <span style={hintStyle}>{t('admin.mailNode.apiKeyNote')}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.mailNode.quotaLabel')}</span>
            <input inputMode="numeric" value={form.quotaMb} onChange={(e) => setForm({ ...form, quotaMb: e.target.value })} style={{ ...fieldStyle, maxWidth: 160 }} />
            <span style={hintStyle}>{t('admin.mailNode.quotaNote', { max: MAX_QUOTA_MB })}</span>
            {quotaGb && <span style={hintStyle}>{t('admin.mailNode.quotaGb', { value: quotaGb })}</span>}
          </label>
          <label>
            <span style={labelStyle}>{t('admin.mailNode.pingLabel')}</span>
            <input value={form.diskPingUrl} onChange={(e) => setForm({ ...form, diskPingUrl: e.target.value })} spellCheck={false} placeholder={t('admin.mailNode.pingPh')} style={monoFieldStyle} />
            <span style={hintStyle}>{t('admin.mailNode.pingNote')}</span>
          </label>
          <div>
            <button type="button" onClick={saveConfig} disabled={busy || !!configErrorKey} style={primaryButtonStyle}>
              {t('admin.mailNode.saveAndCheck')}
            </button>
            {form.mailHost && configErrorKey && <span style={{ ...hintStyle, display: 'inline', marginLeft: 10 }}>{t(configErrorKey)}</span>}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>
          {t(error.key)}{error.detail ? ` (${error.detail})` : ''}
        </div>
      )}
      {notice && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>{t(notice)}</div>}

      {stored?.configured && disk && (
        <>
          <div style={subTitleStyle}>{t('admin.mailNode.diskTitle')}</div>
          {disk.error
            ? <div style={{ fontSize: 13, color: 'var(--red)' }}>{t(mailNodeErrorKey(disk.code))}</div>
            : (
              <div style={{ fontSize: 13, color: disk.warn ? 'var(--red)' : 'var(--text-primary)' }}>
                {t('admin.mailNode.diskUsage', { percent: disk.usedPercent, used: disk.used, total: disk.total })}
                {disk.warn && ` ${t('admin.mailNode.diskWarn')}`}
              </div>
            )}
        </>
      )}

      {stored?.configured && domains && (
        <>
          <div style={subTitleStyle}>{t('admin.mailNode.domainsTitle')}</div>
          {domainsNodeError && (
            <div role="alert" data-domains-node-error={domainsNodeError.code} style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>
              {t('admin.mailNode.domainsNodeUnreachable', { reason: t(mailNodeErrorKey(domainsNodeError.code)) })}
            </div>
          )}
          {domains.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.mailNode.domainsEmpty')}</div>}
          {domains.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>{t('admin.mailNode.domainColumn')}</th>
                  <th style={headCellStyle}>{t('admin.mailNode.mailboxesColumn')}</th>
                  <th style={headCellStyle}>{t('admin.mailNode.stateColumn')}</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <Fragment key={d.domain}>
                    <tr>
                      <td style={cellStyle}>{d.domain}</td>
                      <td style={cellStyle}>
                        {d.onNode == null ? '—' : t('admin.mailNode.mailboxesCount', { used: d.mailboxes, max: d.maxMailboxes })}
                      </td>
                      <td style={cellStyle}>
                        {/* The node's own flag, then how far the panel's onboarding of the domain got. */}
                        {d.onNode === false && <span style={{ color: 'var(--red)' }}>{t('admin.mailNode.notOnNode')}</span>}
                        {d.onNode == null && <span style={{ color: 'var(--red)' }}>{t('admin.mailNode.nodeUnknown')}</span>}
                        {d.onNode === true && (d.active ? t('admin.mailNode.domainActive') : t('admin.mailNode.domainInactive'))}
                        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                          <span data-domain-state={d.state} style={{ color: d.state === 'unknown' ? 'var(--red)' : 'var(--text-primary)' }}>
                            {t(domainStateKey(d.state))}
                          </span>
                          {d.recreated && (
                            <span data-recreated-badge style={{ fontSize: 11, color: 'var(--amber)' }}>{t('admin.mailNode.recreatedBadge')}</span>
                          )}
                          <button
                            type="button"
                            aria-expanded={openDomain === d.domain}
                            onClick={() => setOpenDomain(openDomain === d.domain ? null : d.domain)}
                            style={{ ...buttonStyle, padding: '4px 8px' }}
                          >
                            {openDomain === d.domain ? t('admin.mailNode.hideDetails') : t('admin.mailNode.showDetails')}
                          </button>
                        </span>
                      </td>
                    </tr>
                    {openDomain === d.domain && (
                      <tr>
                        <td colSpan={3} style={{ ...cellStyle, background: 'var(--bg-secondary)' }}>
                          <MailNodeDomainOnboarding domain={d} onChanged={refreshDomains} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ flex: 2, minWidth: 180 }}>
              <span style={labelStyle}>{t('admin.mailNode.newDomainLabel')}</span>
              <input value={newDomain.domain} onChange={(e) => setNewDomain({ ...newDomain, domain: e.target.value })} spellCheck={false} placeholder={t('admin.mailNode.newDomainPh')} style={monoFieldStyle} />
            </label>
            <label style={{ flex: 1, minWidth: 120 }}>
              <span style={labelStyle}>{t('admin.mailNode.newDomainMailboxes')}</span>
              <input inputMode="numeric" value={newDomain.mailboxes} onChange={(e) => setNewDomain({ ...newDomain, mailboxes: e.target.value })} style={fieldStyle} />
            </label>
            <button type="button" onClick={addDomain} disabled={busy || !newDomain.domain.trim() || !domainMailboxes} style={primaryButtonStyle}>
              {t('admin.mailNode.addDomain')}
            </button>
          </div>
          <span style={hintStyle}>{t('admin.mailNode.newDomainNote')}</span>
        </>
      )}

      {stored?.configured && overview?.mailboxes && (
        <>
          <div style={subTitleStyle}>{t('admin.mailNode.mailboxesTitle')}</div>
          {overview.mailboxes.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.mailNode.mailboxesEmpty')}</div>}
          {overview.mailboxes.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>{t('admin.mailNode.addressColumn')}</th>
                  <th style={headCellStyle}>{t('admin.mailNode.usageColumn')}</th>
                  <th style={headCellStyle}>{t('admin.mailNode.quotaColumn')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.mailboxes.map((m) => {
                  const percent = usagePercent(m.usedBytes, m.quotaMb);
                  const edit = quotaEdits[m.accountId];
                  const editValid = parseWholeNumber(edit, 1, MAX_QUOTA_MB) != null;
                  return (
                    <tr key={m.accountId}>
                      <td style={cellStyle}>{m.email}</td>
                      <td style={cellStyle}>
                        {!m.onNode && <span style={{ color: 'var(--red)' }}>{t('admin.mailNode.notOnNode')}</span>}
                        {m.onNode && percent != null && t('admin.mailNode.usage', {
                          used: size(m.usedBytes), quota: size(m.quotaMb * 1048576), percent,
                        })}
                      </td>
                      <td style={cellStyle}>
                        {m.onNode && (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <input
                              aria-label={t('admin.mailNode.quotaColumn')}
                              inputMode="numeric"
                              value={edit ?? String(m.quotaMb ?? '')}
                              onChange={(e) => setQuotaEdits({ ...quotaEdits, [m.accountId]: e.target.value })}
                              style={{ ...fieldStyle, width: 100, padding: '5px 8px' }}
                            />
                            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('admin.mailNode.unitMb')}</span>
                            {edit != null && (
                              <button type="button" onClick={() => saveQuota(m.accountId)} disabled={busy || !editValid} style={buttonStyle}>
                                {t('common.save')}
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
