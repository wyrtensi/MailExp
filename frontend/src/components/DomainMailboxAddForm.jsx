import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  domainMailboxFormError,
  domainMailboxTaken,
  mailNodeErrorDetail,
  mailNodeErrorKey,
  normalizeLocalPart,
  selectableDomains,
  senderNameError,
  senderNamesPayload,
} from '../utils/mailNode.js';

const inputStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 };
const hintStyle = { marginTop: 5, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 };
const buttonStyle = (primary, enabled = true) => ({
  padding: '9px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: enabled ? 'pointer' : 'default',
  opacity: enabled ? 1 : 0.5,
  ...(primary
    ? { border: 'none', background: 'var(--accent)', color: 'var(--accent-text)' }
    : { border: '1px solid var(--border)', background: 'none', color: 'var(--text-secondary)' }),
});

// "Add account -> Our mailbox": the name before @, a domain of the mail node, the name recipients
// read in From (required) and a second one to choose when writing (for instance in Latin letters),
// and the name the mailbox shows under in MailExpert. An address that is already a mailbox of the
// install is refused while it is typed; the rest is confirmed on a second step before anything is
// created. The server creates the mailbox (or enables it again) with a password only MailExpert
// knows and connects it; `onCreated` gets the new account row, with the second name as its alias.
export default function DomainMailboxAddForm({ accounts = [], onCreated }) {
  const { t } = useTranslation();
  const [domains, setDomains] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderNameAlt, setSenderNameAlt] = useState('');
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.mailNode.listDomains()
      .then((data) => {
        if (!live) return;
        // An administrator gets the domains even when the node cannot list them, with the node's
        // error beside them: no mailbox can be created then, so the form says why.
        if (data?.node) {
          setLoadError({ key: mailNodeErrorKey(data.node.code), detail: '' });
          return;
        }
        const list = selectableDomains(data?.domains);
        setDomains(list);
        setDomain((current) => current || list[0] || '');
      })
      .catch((err) => { if (live) setLoadError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) }); });
    return () => { live = false; };
  }, []);

  const taken = domainMailboxTaken({ localPart, domain }, accounts);
  const addressError = domainMailboxFormError({ localPart, domain }) ?? (taken ? 'admin.accounts.add.domainErrorExists' : null);
  const formError = addressError ?? senderNameError(senderName);
  const canContinue = !busy && !formError;
  const email = `${normalizeLocalPart(localPart)}@${domain}`;
  const names = senderNamesPayload({ senderName, senderNameAlt });
  // The mailbox list shows the sender name unless another name is given.
  const listName = name.trim() || names.senderName || email;

  const edit = (setter) => (e) => { setter(e.target.value); setError(null); };

  const review = (e) => {
    e.preventDefault();
    if (canContinue) setConfirming(true);
  };

  const create = async () => {
    if (!canContinue) return;
    setBusy(true);
    setError(null);
    try {
      const account = await api.addDomainMailbox({ localPart: normalizeLocalPart(localPart), domain, name: listName, ...names });
      onCreated(account);
    } catch (err) {
      setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const errorLine = (err) => (
    <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>
      {t(err.key)}{err.detail ? ` (${err.detail})` : ''}
    </div>
  );

  if (loadError) return errorLine(loadError);
  if (!domains) return <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>;
  if (!domains.length) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.accounts.add.domainNoDomains')}</div>;

  if (confirming) {
    const row = (labelKey, value, strong = false) => (
      <>
        <dt style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t(labelKey)}</dt>
        <dd style={{ margin: '2px 0 10px', color: 'var(--text-primary)', fontWeight: strong ? 500 : 400 }}>{value}</dd>
      </>
    );
    return (
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
          {t('admin.accounts.add.domainConfirmTitle')}
        </div>
        <dl style={{ margin: 0, padding: '12px 14px 2px', borderRadius: 8, background: 'var(--bg-tertiary)', fontSize: 13 }}>
          {row('admin.accounts.add.domainAddressLabel', email, true)}
          {row('admin.accounts.add.domainConfirmSender', `${names.senderName} <${email}>`)}
          {names.senderNameAlt && row('admin.accounts.add.domainConfirmSenderAlt', `${names.senderNameAlt} <${email}>`)}
          {row('admin.accounts.add.domainConfirmName', listName)}
        </dl>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
          {t('admin.accounts.add.domainNote')}
        </div>
        {/* The account list can change while this step is open: say why Create went inactive. */}
        {formError && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>{t(formError)}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={create} disabled={!canContinue} style={buttonStyle(true, canContinue)}>
            {busy ? t('admin.accounts.add.domainCreating') : t('admin.accounts.add.domainCreate')}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} style={buttonStyle(false, !busy)}>
            {t('admin.accounts.add.domainChange')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={review}>
      <label htmlFor="domain-add-local" style={labelStyle}>{t('admin.accounts.add.domainAddressLabel')}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          id="domain-add-local"
          autoComplete="off"
          value={localPart}
          placeholder={t('admin.accounts.add.domainLocalPartPh')}
          aria-invalid={!!(localPart && addressError)}
          onChange={edit(setLocalPart)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>@</span>
        <select
          aria-label={t('admin.accounts.add.domainDomainLabel')}
          value={domain}
          onChange={edit(setDomain)}
          style={{ ...inputStyle, flex: 1 }}
        >
          {domains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {localPart && addressError && (
        <div style={{ marginTop: 6, fontSize: 11, color: taken ? 'var(--red)' : 'var(--text-tertiary)' }}>{t(addressError)}</div>
      )}

      <label htmlFor="domain-add-sender" style={{ ...labelStyle, marginTop: 14 }}>{t('admin.accounts.add.senderNameLabel')}</label>
      <input
        id="domain-add-sender"
        required
        value={senderName}
        maxLength={200}
        placeholder={t('admin.accounts.add.senderNamePh')}
        onChange={edit(setSenderName)}
        style={inputStyle}
      />
      <div style={hintStyle}>{t('admin.accounts.add.senderNameHint')}</div>

      <label htmlFor="domain-add-sender-alt" style={{ ...labelStyle, marginTop: 14 }}>{t('admin.accounts.add.senderNameAltLabel')}</label>
      <input
        id="domain-add-sender-alt"
        value={senderNameAlt}
        maxLength={200}
        placeholder={t('admin.accounts.add.senderNameAltPh')}
        onChange={edit(setSenderNameAlt)}
        style={inputStyle}
      />
      <div style={hintStyle}>{t('admin.accounts.add.senderNameAltHint')}</div>

      <label htmlFor="domain-add-name" style={{ ...labelStyle, marginTop: 14 }}>{t('admin.accounts.add.domainNameLabel')}</label>
      <input
        id="domain-add-name"
        value={name}
        placeholder={t('admin.accounts.add.domainNamePh')}
        onChange={edit(setName)}
        style={inputStyle}
      />

      <button type="submit" disabled={!canContinue} style={{ ...buttonStyle(true, canContinue), marginTop: 16 }}>
        {t('admin.accounts.add.domainNext')}
      </button>
      {error && errorLine(error)}
    </form>
  );
}
