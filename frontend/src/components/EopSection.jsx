import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import MailNodeApplyResult from './MailNodeApplyResult.jsx';
import MailNodeDomainOnboarding from './MailNodeDomainOnboarding.jsx';
import MailNodeTerrlBudget from './MailNodeTerrlBudget.jsx';
import MailNodeTenant from './MailNodeTenant.jsx';
import {
  DEFAULT_SEND_LIMIT_PER_HOUR,
  MAILBOX_READY_STATES,
  MAX_SEND_LIMIT_PER_HOUR,
  eopSettingsError,
  mailNodeErrorDetail,
  mailNodeErrorKey,
  prefilterDoneKey,
  prefilterPending,
  spamRuleState,
} from '../utils/mailNode.js';

const fieldStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const monoFieldStyle = { ...fieldStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4 };
const hintStyle = { display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 };
const primaryButtonStyle = {
  padding: '7px 12px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: 'none',
  background: 'var(--accent)', color: 'var(--accent-text)', cursor: 'pointer',
};
const buttonStyle = { ...primaryButtonStyle, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)' };
const dangerButtonStyle = { ...primaryButtonStyle, background: '#dc2626', color: 'white' };
const warningBoxStyle = {
  marginTop: 10, padding: 10, borderRadius: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)',
  background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)',
};
// Spelled out literally so the i18n coverage test finds them.
const TLS_POLICY_KEYS = {
  secure: 'admin.eop.tlsPolicySecure',
  dane: 'admin.eop.tlsPolicyDane',
  'dane-only': 'admin.eop.tlsPolicyDaneOnly',
  verify: 'admin.eop.tlsPolicyVerify',
  fingerprint: 'admin.eop.tlsPolicyFingerprint',
  encrypt: 'admin.eop.tlsPolicyEncrypt',
  default: 'admin.eop.tlsPolicyDefault',
};
const subTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '20px 0 8px' };

// Why the domains' checklist is done by hand (shown only while the tenant driver does not run the
// tenant steps, tenantDriverActive false): no worker, or the tenant fields not filled in yet. A
// driver with a filled tenant that still is not active is the demo's (its domains keep the manual
// onboarding): no cause is claimed then.
function checklistNoteKey(stored) {
  if (!stored?.tenantDriver) return 'admin.eop.checklistNoteNoDriver';
  if (!stored.tenantConfigured) return 'admin.eop.checklistNoteNotConfigured';
  return 'admin.eop.checklistNoteManual';
}

// What the TERRL limit is made of: a save that changes one of them recounts the budget.
const BUDGET_FIELDS = ['terrl', 'licenses', 'tenantCreatedOn'];
const TEXT_FIELDS = [
  'eopHost', 'tlsPolicyParameters', 'certificateHost', 'terrl', 'licenses', 'tenantCreatedOn', 'tenantId', 'tenantDomain', 'appId', 'certThumbprint',
  'outboundConnector', 'dbebExternalDomain',
];

// The stored settings as the form edits them: every field a string.
function toForm(settings) {
  return {
    ...Object.fromEntries(TEXT_FIELDS.map((field) => [field, settings?.[field] == null ? '' : String(settings[field])])),
    tlsPolicy: settings?.tlsPolicy ?? 'secure',
    dkimMode: settings?.dkimMode ?? 'mailcow',
    sendLimitPerHour: String(settings?.sendLimitPerHour ?? DEFAULT_SEND_LIMIT_PER_HOUR),
  };
}

// Settings -> Mail node -> "EOP" (admins only), next to the mail node: how the node's mail goes
// through Microsoft EOP. The next hop with its TLS policy, the DKIM mode and the send limit are
// applied to the node through the mailcow API (saving them starts an apply after the answer, shown
// on the next load; "Apply settings" does it again for the node and every domain and waits for it),
// and the last result is shown item by item. The spam filing
// rule is written only by its own button, after a warning: it restarts Dovecot on the node. While
// the panel does not run the tenant steps itself (the server's tenantDriverActive: no tenant driver,
// or the tenant fields not filled in), the domains' onboarding is done by hand, so this section also
// lists the domains that are not ready with their checklist and the "Done" of each step. Next to the TERRL it shows the tenant's external recipient budget of
// the last 24 hours (R-21), from the licenses and the tenant's creation date when no TERRL is set.
export default function EopSection({ revision = 0, onDomainsChanged }) {
  const { t } = useTranslation();
  const [stored, setStored] = useState(null);
  const [form, setForm] = useState(toForm(null));
  const [domains, setDomains] = useState(null);
  const [domainsError, setDomainsError] = useState(null);
  const [domainsNodeError, setDomainsNodeError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // The node's last apply ({ at, items }) and whether the spam rule waits for its confirmation.
  const [applied, setApplied] = useState(null);
  const [confirmPrefilter, setConfirmPrefilter] = useState(false);
  // The TERRL budget now (R-21); null while it loads or when it could not be read.
  const [budget, setBudget] = useState(null);
  // Bumped by every save, so the tenant part reads what the new settings allow.
  const [saves, setSaves] = useState(0);

  const loadBudget = useCallback(async () => {
    try {
      setBudget(await api.mailNode.getTerrlBudget());
    } catch {
      setBudget(null);
    }
  }, []);
  // Once when the section opens (the server shares one read of the node log a minute), and again
  // only when a save changed what the limit is made of; never on every domain change (revision).
  useEffect(() => { loadBudget(); }, [loadBudget]);

  const loadApplied = useCallback(async () => {
    try {
      setApplied((await api.mailNode.getApplyResult())?.node ?? null);
    } catch {
      setApplied(null);
    }
  }, []);
  useEffect(() => { loadApplied(); }, [loadApplied, revision]);

  useEffect(() => {
    api.mailNode.getEopSettings()
      .then((settings) => {
        setStored(settings);
        setForm(toForm(settings));
      })
      .catch((err) => setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) }));
  }, []);

  const loadDomains = useCallback(async () => {
    try {
      const data = await api.mailNode.listDomains();
      setDomains(data?.domains ?? []);
      setDomainsNodeError(data?.node ?? null);
      setDomainsError(null);
    } catch (err) {
      setDomainsNodeError(null);
      setDomainsError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    }
  }, []);

  const showChecklist = !!stored && !stored.tenantDriverActive;
  useEffect(() => {
    if (showChecklist) loadDomains();
  }, [showChecklist, loadDomains, revision]);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  // Parameters belong to a policy (a fingerprint, a name to match): another policy starts without them.
  const setPolicy = (e) => setForm({ ...form, tlsPolicy: e.target.value, tlsPolicyParameters: '' });
  const formErrorKey = eopSettingsError(form);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { applying, ...saved } = await api.mailNode.saveEopSettings({
        ...Object.fromEntries(TEXT_FIELDS.map((field) => [field, form[field].trim()])),
        tlsPolicy: form.tlsPolicy,
        dkimMode: form.dkimMode,
        sendLimitPerHour: Number(form.sendLimitPerHour),
      });
      setStored(saved);
      setForm(toForm(saved));
      setSaves((n) => n + 1);
      if (BUDGET_FIELDS.some((field) => saved[field] !== stored?.[field])) loadBudget();
      // A change the node gets is applied after the answer: its result shows on the next load.
      setNotice(applying ? 'admin.eop.savedApplying' : 'admin.eop.saved');
    } catch (err) {
      setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    } finally {
      setBusy(false);
    }
  };

  // A domain change reloads both sections through `revision` when the panel shares it.
  function domainChanged() {
    return onDomainsChanged ? onDomainsChanged() : loadDomains();
  }

  // noticeKey: a key, or a function of the action's answer that gives one.
  const runApply = async (action, noticeKey) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const answer = await action();
      await loadApplied();
      setNotice(typeof noticeKey === 'function' ? noticeKey(answer) : noticeKey);
      domainChanged();
    } catch (err) {
      setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    } finally {
      setBusy(false);
      setConfirmPrefilter(false);
    }
  };
  const applyNode = () => runApply(() => api.mailNode.applyNode(), 'admin.mailNode.applyDone');
  const applyPrefilter = () => runApply(() => api.mailNode.applyPrefilter(), prefilterDoneKey);

  const pending = (domains ?? []).filter((d) => !MAILBOX_READY_STATES.includes(d.state));

  const textField = (field, { mono = true, placeholder, inputMode } = {}) => (
    <input
      value={form[field]}
      onChange={set(field)}
      spellCheck={false}
      placeholder={placeholder}
      inputMode={inputMode}
      style={mono ? monoFieldStyle : fieldStyle}
    />
  );

  return (
    <div data-section="eop" style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.eop.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 16 }}>
        {t('admin.eop.description')}
        {stored && ` ${t(stored.tenantDriver ? 'admin.eop.descriptionDriver' : 'admin.eop.descriptionNoDriver')}`}
      </div>

      {!stored && !error && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>}

      {stored && (
        <div style={{ display: 'grid', gap: 12 }}>
          <label>
            <span style={labelStyle}>{t('admin.eop.eopHostLabel')}</span>
            {textField('eopHost', { placeholder: t('admin.eop.eopHostPh') })}
            <span style={hintStyle}>{t('admin.eop.eopHostNote')}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.tlsPolicyLabel')}</span>
            <select value={form.tlsPolicy} onChange={setPolicy} style={{ ...fieldStyle, maxWidth: 420 }}>
              {Object.entries(TLS_POLICY_KEYS).map(([policy, key]) => <option key={policy} value={policy}>{t(key)}</option>)}
            </select>
            <span style={hintStyle}>{t('admin.eop.tlsPolicyNote')}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.tlsParametersLabel')}</span>
            {textField('tlsPolicyParameters', { placeholder: t('admin.eop.tlsParametersPh') })}
            <span style={hintStyle}>{t('admin.eop.tlsParametersNote')}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.certificateHostLabel')}</span>
            {textField('certificateHost', { placeholder: t('admin.mailNode.hostPh') })}
            <span style={hintStyle}>{t('admin.eop.certificateHostNote')}</span>
          </label>
          {/* The node's address is kept here but edited next to the node's name in "Mail node", so moving
              the node changes both in one place. */}
          <div data-eop-node-ip>
            <span style={labelStyle}>{t('admin.mailNode.nodeIpLabel')}</span>
            <span style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace' }}>
              {stored.nodeIp || t('admin.eop.nodeIpNotSet')}
            </span>
            <span style={hintStyle}>{t('admin.eop.nodeIpReadOnlyNote')}</span>
          </div>
          <label>
            <span style={labelStyle}>{t('admin.eop.dkimModeLabel')}</span>
            <select value={form.dkimMode} onChange={set('dkimMode')} style={{ ...fieldStyle, maxWidth: 320 }}>
              <option value="mailcow">{t('admin.eop.dkimModeMailcow')}</option>
              <option value="eop">{t('admin.eop.dkimModeEop')}</option>
            </select>
            <span style={hintStyle}>{t('admin.eop.dkimModeNote')}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.sendLimitLabel')}</span>
            <input inputMode="numeric" value={form.sendLimitPerHour} onChange={set('sendLimitPerHour')} style={{ ...fieldStyle, maxWidth: 160 }} />
            <span style={hintStyle}>{t('admin.eop.sendLimitNote', { max: MAX_SEND_LIMIT_PER_HOUR })}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.terrlLabel')}</span>
            <input inputMode="numeric" value={form.terrl} onChange={set('terrl')} style={{ ...fieldStyle, maxWidth: 160 }} />
            <span style={hintStyle}>{t('admin.eop.terrlNote')}</span>
          </label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ minWidth: 160 }}>
              <span style={labelStyle}>{t('admin.eop.licensesLabel')}</span>
              <input inputMode="numeric" value={form.licenses} onChange={set('licenses')} style={{ ...fieldStyle, maxWidth: 160 }} />
            </label>
            <label style={{ minWidth: 160 }}>
              <span style={labelStyle}>{t('admin.eop.tenantCreatedLabel')}</span>
              <input type="date" value={form.tenantCreatedOn} onChange={set('tenantCreatedOn')} style={{ ...fieldStyle, maxWidth: 180 }} />
            </label>
          </div>
          <span style={{ ...hintStyle, marginTop: -6 }}>{t('admin.eop.budgetSettingsNote')}</span>
          <div data-eop-budget>
            <span style={labelStyle}>{t('admin.eop.budgetTitle')}</span>
            {budget ? <MailNodeTerrlBudget budget={budget} /> : <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.eop.budgetUnavailable')}</span>}
          </div>

          <div style={{ ...subTitleStyle, margin: '8px 0 0' }}>{t('admin.eop.tenantTitle')}</div>
          <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.eop.tenantNote')}</span>
          <label>
            <span style={labelStyle}>{t('admin.eop.tenantIdLabel')}</span>
            {textField('tenantId', { placeholder: t('admin.eop.guidPh') })}
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.tenantDomainLabel')}</span>
            {textField('tenantDomain', { placeholder: t('admin.eop.tenantDomainPh') })}
            <span style={hintStyle}>{t('admin.eop.tenantDomainNote')}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.appIdLabel')}</span>
            {textField('appId', { placeholder: t('admin.eop.guidPh') })}
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.thumbprintLabel')}</span>
            {textField('certThumbprint')}
            <span style={hintStyle}>{t('admin.eop.thumbprintNote')}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.outboundConnectorLabel')}</span>
            {textField('outboundConnector', { placeholder: t('admin.eop.outboundConnectorPh') })}
            <span style={hintStyle}>{t('admin.eop.outboundConnectorNote')}</span>
          </label>
          <label>
            <span style={labelStyle}>{t('admin.eop.dbebExternalDomainLabel')}</span>
            {textField('dbebExternalDomain', { placeholder: t('admin.eop.dbebExternalDomainPh') })}
            <span style={hintStyle}>{t('admin.eop.dbebExternalDomainNote')}</span>
          </label>
          <div>
            <button type="button" onClick={save} disabled={busy || !!formErrorKey} style={primaryButtonStyle}>
              {t('common.save')}
            </button>
            {formErrorKey && <span style={{ ...hintStyle, display: 'inline', marginLeft: 10 }}>{t(formErrorKey)}</span>}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>
          {t(error.key)}{error.detail ? ` (${error.detail})` : ''}
        </div>
      )}
      {notice && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>{t(notice)}</div>}

      {stored && (
        <div data-eop-tenant>
          <div style={subTitleStyle}>{t('admin.tenant.title')}</div>
          <MailNodeTenant revision={saves} spamRule={spamRuleState(applied)} />
        </div>
      )}

      {stored && (
        <div data-node-apply>
          <div style={subTitleStyle}>{t('admin.mailNode.applyTitle')}</div>
          <span style={{ ...hintStyle, marginTop: 0, marginBottom: 8 }}>{t('admin.mailNode.applyNote')}</span>
          {applied ? <MailNodeApplyResult result={applied} /> : <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('admin.mailNode.applyNever')}</div>}
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={applyNode} disabled={busy} style={buttonStyle}>{t('admin.mailNode.applyButton')}</button>
          </div>
          {prefilterPending(applied) && (
            <div role="status" data-prefilter-pending style={warningBoxStyle}>
              <div>{t('admin.mailNode.prefilterNote')}</div>
              {!confirmPrefilter && (
                <button type="button" onClick={() => setConfirmPrefilter(true)} disabled={busy} style={{ ...buttonStyle, marginTop: 8 }}>
                  {t('admin.mailNode.prefilterApply')}
                </button>
              )}
              {confirmPrefilter && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: 600 }}>{t('admin.mailNode.prefilterConfirm')}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button type="button" onClick={applyPrefilter} disabled={busy} style={dangerButtonStyle}>{t('admin.mailNode.prefilterApplyConfirm')}</button>
                    <button type="button" onClick={() => setConfirmPrefilter(false)} disabled={busy} style={buttonStyle}>{t('common.cancel')}</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showChecklist && (
        <>
          <div style={subTitleStyle}>{t('admin.eop.checklistTitle')}</div>
          <span style={{ ...hintStyle, marginTop: 0, marginBottom: 10 }}>{t(checklistNoteKey(stored))}</span>
          {domainsError && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t(domainsError.key)}</div>}
          {domainsNodeError && (
            <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>
              {t('admin.mailNode.domainsNodeUnreachable', { reason: t(mailNodeErrorKey(domainsNodeError.code)) })}
            </div>
          )}
          {!domainsError && !domains && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>}
          {domains && pending.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.eop.checklistEmpty')}</div>}
          {pending.map((d) => (
            <div key={d.domain} style={{ borderTop: '1px solid var(--border-subtle)', padding: '10px 0' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{d.domain}</div>
              <MailNodeDomainOnboarding domain={d} onChanged={domainChanged} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
