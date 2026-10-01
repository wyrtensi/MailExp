import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import MailNodeDomainOnboarding from './MailNodeDomainOnboarding.jsx';
import MailNodeDnsResult from './MailNodeDnsResult.jsx';
import {
  DEFAULT_DELETE_AFTER_DAYS,
  DEFAULT_DOMAIN_MAILBOXES,
  DEFAULT_QUOTA_MB,
  MAX_DELETE_AFTER_DAYS,
  MAX_DOMAIN_MAILBOXES,
  MAX_QUOTA_MB,
  RATE_LIMIT_FRAMES,
  dnsSummary,
  domainStateKey,
  hasDnsErrors,
  mailNodeConfigError,
  mailNodeErrorDetail,
  mailNodeErrorKey,
  parseWholeNumber,
  quotaMbInGb,
  rateFrameKey,
  rateLimitError,
  rateLimitState,
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
const badgeStyle = (color, background) => ({
  fontSize: 11, fontWeight: 500, color: 'var(--text-primary)', padding: '1px 7px', borderRadius: 20,
  border: `1px solid ${color}`, background,
});
const dnsBadgeStyle = badgeStyle('var(--red)', 'rgba(239,68,68,0.12)');

const EMPTY_FORM = {
  mailHost: '', apiKey: '', quotaMb: String(DEFAULT_QUOTA_MB), diskPingUrl: '', deleteAfterDays: String(DEFAULT_DELETE_AFTER_DAYS),
  panelIps: '', nodeIp: '',
};
// Spelled out literally so the i18n coverage test finds them.
const RATE_STATE_KEYS = {
  own: 'admin.mailNode.rateLimitOwn',
  default: 'admin.mailNode.rateLimitDefault',
  differs: 'admin.mailNode.rateLimitDiffers',
};

// Settings -> Integrations -> "Mail node" (admins only): the mailcow server MailExpert creates
// domain mailboxes on, the panel's own addresses for the node's fail2ban whitelist, its domains with
// their onboarding, the mail disk, the node's DNS and certificate check (R-15) with "Check now" for
// the node and every domain, and the quota and send limit of every mailbox made there. A domain
// that takes mailboxes while its last DNS check found errors carries a badge in the list, and the
// title a summary of them; the checks only warn and never change a domain's state. The EOP section
// next to it changes domains too: `revision` goes up after any such change, and this section tells
// it about its own through `onDomainsChanged`.
export default function MailNodeSection({ revision = 0, onDomainsChanged }) {
  const { t } = useTranslation();
  const [stored, setStored] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [domains, setDomains] = useState(null);
  // The node's error when it could not list its domains: the panel's own record is shown anyway.
  const [domainsNodeError, setDomainsNodeError] = useState(null);
  const [overview, setOverview] = useState(null);
  // The node's last DNS check: { at, overall, checks }, or null before the first one.
  const [nodeDns, setNodeDns] = useState(null);
  const [newDomain, setNewDomain] = useState({ domain: '', mailboxes: String(DEFAULT_DOMAIN_MAILBOXES) });
  const [quotaEdits, setQuotaEdits] = useState({});
  // A send limit being edited per mailbox: { value, frame }.
  const [limitEdits, setLimitEdits] = useState({});
  const [openDomain, setOpenDomain] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const fail = (err) => setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });

  // Each list shows on its own: a failing mailbox listing does not hide the domains, and a node
  // that cannot list its domains leaves the panel's record of them on screen with a warning.
  const loadNode = useCallback(async () => {
    const [d, o, n] = await Promise.allSettled([api.mailNode.listDomains(), api.mailNode.listMailboxes(), api.mailNode.getDnsCheck()]);
    if (d.status === 'fulfilled') {
      setDomains(d.value?.domains ?? []);
      setDomainsNodeError(d.value?.node ?? null);
    } else {
      setDomainsNodeError(null);
    }
    if (o.status === 'fulfilled') setOverview(o.value);
    if (n.status === 'fulfilled') setNodeDns(n.value?.node ?? null);
    const failed = [d, o, n].find((r) => r.status === 'rejected');
    if (failed) fail(failed.reason);
  }, []);

  useEffect(() => {
    api.mailNode.getConfig()
      .then((cfg) => {
        setStored(cfg);
        setForm({
          mailHost: cfg.mailHost, apiKey: cfg.apiKey, quotaMb: String(cfg.quotaMb), diskPingUrl: cfg.diskPingUrl,
          deleteAfterDays: String(cfg.deleteAfterDays ?? DEFAULT_DELETE_AFTER_DAYS),
          panelIps: (cfg.panelIps ?? []).join(', '),
          nodeIp: cfg.nodeIp ?? '',
        });
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
      if (noticeKey) setNotice((current) => current ?? noticeKey);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const configErrorKey = mailNodeConfigError(form, { hasStoredKey: !!stored?.configured });
  const saveConfig = () => run(async () => {
    const saved = await api.mailNode.saveConfig({
      mailHost: form.mailHost.trim(), apiKey: form.apiKey, quotaMb: Number(form.quotaMb), diskPingUrl: form.diskPingUrl.trim(),
      deleteAfterDays: Number(form.deleteAfterDays),
      panelIps: form.panelIps,
      nodeIp: form.nodeIp.trim(),
    });
    const cfg = await api.mailNode.getConfig();
    setStored(cfg);
    setForm((f) => ({ ...f, apiKey: cfg.apiKey }));
    await refreshDomains();
    // Another node, key or panel address is applied to the node after the answer.
    if (saved?.applying) setNotice('admin.mailNode.savedApplying');
  }, 'admin.mailNode.saved');

  const domainMailboxes = parseWholeNumber(newDomain.mailboxes, 1, MAX_DOMAIN_MAILBOXES);
  const addDomain = () => run(async () => {
    await api.mailNode.addDomain({ domain: newDomain.domain.trim().toLowerCase(), mailboxes: domainMailboxes });
    setNewDomain({ domain: '', mailboxes: String(DEFAULT_DOMAIN_MAILBOXES) });
    await refreshDomains();
  }, 'admin.mailNode.domainAdded');

  // An administrator's send limit, or { value: null } to go back to the default.
  const saveLimit = (accountId, limit) => run(async () => {
    await api.mailNode.setRateLimit(accountId, limit);
    setLimitEdits((l) => ({ ...l, [accountId]: undefined }));
    await loadNode();
  }, 'admin.mailNode.rateLimitSaved');

  const limitText = (limit) => (limit
    ? t('admin.mailNode.rateLimitValue', { value: limit.value, frame: t(rateFrameKey(limit.frame)) })
    : t('admin.mailNode.rateLimitNone'));

  const saveQuota = (accountId) => run(async () => {
    await api.mailNode.setQuota(accountId, Number(quotaEdits[accountId]));
    setQuotaEdits((q) => ({ ...q, [accountId]: undefined }));
    await loadNode();
  }, 'admin.mailNode.quotaSaved');

  const size = (bytes) => {
    const p = sizeParts(bytes);
    return `${p.value} ${t(p.unitKey)}`;
  };

  // "Check now": the node and every domain the panel knows, in the background on the server; the
  // results show on the next load.
  const checkDns = () => run(async () => {
    const answer = await api.mailNode.checkDns();
    setNotice(answer?.started === false ? 'admin.mailNode.dnsCheckRunning' : 'admin.mailNode.dnsCheckStarted');
  });

  const disk = overview?.disk;
  const quotaGb = quotaMbInGb(form.quotaMb);
  const dnsProblems = dnsSummary(domains, nodeDns);

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.mailNode.title')}</span>
        {stored?.configured && (dnsProblems.domains.length > 0 || dnsProblems.node) && (
          <span role="status" data-dns-summary={dnsProblems.domains.length} style={dnsBadgeStyle}>
            {dnsProblems.node
              ? t('admin.mailNode.dnsSummaryNode', { number: dnsProblems.domains.length })
              : t('admin.mailNode.dnsSummary', { number: dnsProblems.domains.length })}
          </span>
        )}
      </div>
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
            <span style={labelStyle}>{t('admin.mailNode.nodeIpLabel')}</span>
            <input value={form.nodeIp} onChange={(e) => setForm({ ...form, nodeIp: e.target.value })} spellCheck={false} placeholder={t('admin.mailNode.nodeIpPh')} style={{ ...monoFieldStyle, maxWidth: 240 }} />
            <span style={hintStyle}>{t('admin.mailNode.nodeIpNote')}</span>
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
          <label>
            <span style={labelStyle}>{t('admin.mailNode.deleteAfterLabel')}</span>
            <input inputMode="numeric" value={form.deleteAfterDays} onChange={(e) => setForm({ ...form, deleteAfterDays: e.target.value })} style={{ ...fieldStyle, maxWidth: 160 }} />
            <span style={hintStyle}>{t('admin.mailNode.deleteAfterNote', { max: MAX_DELETE_AFTER_DAYS })}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.mailNode.panelIpsLabel')}</span>
            <input value={form.panelIps} onChange={(e) => setForm({ ...form, panelIps: e.target.value })} spellCheck={false} placeholder={t('admin.mailNode.panelIpsPh')} style={monoFieldStyle} />
            <span style={hintStyle}>{t('admin.mailNode.panelIpsNote')}</span>
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

      {stored?.configured && (
        <div data-node-dns>
          <div style={subTitleStyle}>{t('admin.mailNode.nodeDnsTitle')}</div>
          <span style={{ ...hintStyle, marginTop: 0, marginBottom: 8 }}>{t('admin.mailNode.nodeDnsNote')}</span>
          {nodeDns ? <MailNodeDnsResult result={nodeDns} /> : <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('admin.mailNode.dnsNever')}</div>}
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={checkDns} disabled={busy} style={buttonStyle}>{t('admin.mailNode.dnsCheckAll')}</button>
          </div>
        </div>
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
                            <span data-recreated-badge style={badgeStyle('var(--amber)', 'rgba(251,191,36,0.14)')}>
                              {t('admin.mailNode.recreatedBadge')}
                            </span>
                          )}
                          {hasDnsErrors(d) && (
                            <span data-dns-badge={d.domain} style={dnsBadgeStyle}>
                              {t('admin.mailNode.dnsBadge')}
                            </span>
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
                  <th style={headCellStyle}>{t('admin.mailNode.sendLimitColumn')}</th>
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
                      <td style={cellStyle} data-send-limit={m.email}>
                        {m.onNode && (() => {
                          const state = rateLimitState(m);
                          const limitEdit = limitEdits[m.accountId];
                          const current = m.rateLimitOverride ?? m.rateLimitDefault ?? { value: '', frame: 'h' };
                          const draft = limitEdit ?? { value: String(current.value ?? ''), frame: current.frame ?? 'h' };
                          return (
                            <span style={{ display: 'grid', gap: 4 }}>
                              <span data-limit-state={state} style={{ fontSize: 12, color: state === 'differs' ? 'var(--amber)' : 'var(--text-primary)' }}>
                                {limitText(m.rateLimit)}{' '}
                                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                                  {t(RATE_STATE_KEYS[state], { limit: limitText(m.rateLimitOverride ?? m.rateLimitDefault) })}
                                </span>
                              </span>
                              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                <input
                                  aria-label={t('admin.mailNode.sendLimitColumn')}
                                  inputMode="numeric"
                                  value={draft.value}
                                  onChange={(e) => setLimitEdits({ ...limitEdits, [m.accountId]: { ...draft, value: e.target.value } })}
                                  style={{ ...fieldStyle, width: 70, padding: '5px 8px' }}
                                />
                                <select
                                  aria-label={t('admin.mailNode.rateFrameLabel')}
                                  value={draft.frame}
                                  onChange={(e) => setLimitEdits({ ...limitEdits, [m.accountId]: { ...draft, frame: e.target.value } })}
                                  style={{ ...fieldStyle, width: 'auto', padding: '5px 8px' }}
                                >
                                  {RATE_LIMIT_FRAMES.map((frame) => <option key={frame} value={frame}>{t(rateFrameKey(frame))}</option>)}
                                </select>
                                {limitEdit != null && (
                                  <button
                                    type="button"
                                    onClick={() => saveLimit(m.accountId, { value: Number(draft.value), frame: draft.frame })}
                                    disabled={busy || !!rateLimitError(draft)}
                                    style={buttonStyle}
                                  >
                                    {t('common.save')}
                                  </button>
                                )}
                                {m.rateLimitOverride && limitEdit == null && (
                                  <button type="button" onClick={() => saveLimit(m.accountId, { value: null })} disabled={busy} style={buttonStyle}>
                                    {t('admin.mailNode.rateLimitUseDefault')}
                                  </button>
                                )}
                              </span>
                            </span>
                          );
                        })()}
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
