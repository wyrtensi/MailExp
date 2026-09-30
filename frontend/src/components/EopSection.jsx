import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import MailNodeDomainOnboarding from './MailNodeDomainOnboarding.jsx';
import {
  DEFAULT_SEND_LIMIT_PER_HOUR,
  MAILBOX_READY_STATES,
  MAX_SEND_LIMIT_PER_HOUR,
  eopSettingsError,
  mailNodeErrorDetail,
  mailNodeErrorKey,
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
const subTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '20px 0 8px' };

const TEXT_FIELDS = ['eopHost', 'certificateHost', 'terrl', 'tenantId', 'appId', 'certThumbprint'];

// The stored settings as the form edits them: every field a string.
function toForm(settings) {
  return {
    ...Object.fromEntries(TEXT_FIELDS.map((field) => [field, settings?.[field] == null ? '' : String(settings[field])])),
    dkimMode: settings?.dkimMode ?? 'mailcow',
    sendLimitPerHour: String(settings?.sendLimitPerHour ?? DEFAULT_SEND_LIMIT_PER_HOUR),
  };
}

// Settings -> Integrations -> "EOP" (admins only), next to the mail node: how the node's mail goes
// through Microsoft EOP. The panel keeps these and does not apply them yet. Until the panel is
// connected to a tenant, the domains' onboarding is done by hand, so this section also lists the
// domains that are not ready with their checklist and the "Done" of each step.
export default function EopSection({ revision = 0, onDomainsChanged }) {
  const { t } = useTranslation();
  const [stored, setStored] = useState(null);
  const [form, setForm] = useState(toForm(null));
  const [domains, setDomains] = useState(null);
  const [domainsError, setDomainsError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

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
      setDomainsError(null);
    } catch (err) {
      setDomainsError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    }
  }, []);

  const showChecklist = !!stored && !stored.tenantConfigured;
  useEffect(() => {
    if (showChecklist) loadDomains();
  }, [showChecklist, loadDomains, revision]);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const formErrorKey = eopSettingsError(form);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.mailNode.saveEopSettings({
        ...Object.fromEntries(TEXT_FIELDS.map((field) => [field, form[field].trim()])),
        dkimMode: form.dkimMode,
        sendLimitPerHour: Number(form.sendLimitPerHour),
      });
      setStored(saved);
      setForm(toForm(saved));
      setNotice('admin.eop.saved');
    } catch (err) {
      setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    } finally {
      setBusy(false);
    }
  };

  // A domain change reloads both sections through `revision` when the panel shares it.
  const domainChanged = () => (onDomainsChanged ? onDomainsChanged() : loadDomains());

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
            <span style={labelStyle}>{t('admin.eop.certificateHostLabel')}</span>
            {textField('certificateHost', { placeholder: t('admin.mailNode.hostPh') })}
            <span style={hintStyle}>{t('admin.eop.certificateHostNote')}</span>
          </label>
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

          <div style={{ ...subTitleStyle, margin: '8px 0 0' }}>{t('admin.eop.tenantTitle')}</div>
          <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.eop.tenantNote')}</span>
          <label>
            <span style={labelStyle}>{t('admin.eop.tenantIdLabel')}</span>
            {textField('tenantId', { placeholder: t('admin.eop.guidPh') })}
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

      {showChecklist && (
        <>
          <div style={subTitleStyle}>{t('admin.eop.checklistTitle')}</div>
          <span style={{ ...hintStyle, marginTop: 0, marginBottom: 10 }}>{t('admin.eop.checklistNote')}</span>
          {domainsError && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t(domainsError.key)}</div>}
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
