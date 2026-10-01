import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import MailNodeApplyResult from './MailNodeApplyResult.jsx';
import MailNodeDnsResult from './MailNodeDnsResult.jsx';
import {
  DNS_STATUS_COLORS,
  canMarkReady,
  canRestartOnboarding,
  dkimDeleteWaiting,
  dnsVerdictKey,
  domainStateKey,
  expectedForm,
  expectedValuesError,
  mailNodeErrorDetail,
  mailNodeErrorKey,
  onboardingSteps,
} from '../utils/mailNode.js';

const buttonStyle = {
  padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };
const dangerButtonStyle = { ...buttonStyle, background: '#dc2626', border: 'none', color: 'white' };
const noteStyle = { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 };
const confirmBoxStyle = { marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--bg-tertiary)' };
const warningBoxStyle = {
  marginTop: 8, padding: 10, borderRadius: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)',
  background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)',
};
const STATUS_COLORS = {
  confirmed: 'var(--text-primary)', skipped: 'var(--text-tertiary)', next: 'var(--text-primary)', pending: 'var(--text-tertiary)',
};
// Spelled out literally so the i18n coverage test finds them.
const STATUS_KEYS = {
  confirmed: 'admin.mailNode.stepStatusConfirmed',
  skipped: 'admin.mailNode.stepStatusSkipped',
  next: 'admin.mailNode.stepStatusNext',
  pending: 'admin.mailNode.stepStatusPending',
};
const ORIGIN_KEYS = {
  created: 'admin.mailNode.originCreated',
  adopted: 'admin.mailNode.originAdopted',
  existing_mailboxes: 'admin.mailNode.originExistingMailboxes',
};

const when = (at) => (at ? new Date(at).toLocaleString() : '');
const subTitleStyle = { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', margin: '14px 0 4px' };
const fieldStyle = {
  width: '100%', padding: '6px 9px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 7,
  color: 'var(--text-primary)', fontSize: 12, outline: 'none', boxSizing: 'border-box', fontFamily: 'JetBrains Mono, monospace',
};
const labelStyle = { display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 3 };
// The fields of the values a domain must publish, with their labels and placeholders.
const EXPECTED_FIELDS = [
  ['expectedMx', 'admin.mailNode.dnsExpectedMxLabel', 'admin.mailNode.dnsExpectedMxPh'],
  ['tenantTxt', 'admin.mailNode.dnsExpectedTenantTxtLabel', 'admin.mailNode.dnsExpectedTenantTxtPh'],
  ['dkimSelector1Cname', 'admin.mailNode.dnsExpectedSelector1Label', 'admin.mailNode.dnsExpectedSelectorPh'],
  ['dkimSelector2Cname', 'admin.mailNode.dnsExpectedSelector2Label', 'admin.mailNode.dnsExpectedSelectorPh'],
];
const recordStyle = {
  display: 'block', marginTop: 4, padding: '6px 8px', borderRadius: 6, background: 'var(--bg-tertiary)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, wordBreak: 'break-all', userSelect: 'all', color: 'var(--text-primary)',
};

// The DKIM record mailcow signs the domain's mail with, as DNS must publish it (one string: the
// server joins mailcow's 255-character pieces), with a button that copies the value.
function DkimRecord({ dkim }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(dkim.txt);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div data-dkim-record={dkim.name} style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('admin.mailNode.dkimRecord', { name: dkim.name })}</div>
      <code style={recordStyle}>{dkim.txt}</code>
      <button type="button" onClick={copy} style={{ ...buttonStyle, marginTop: 6 }}>
        {copied ? t('admin.mailNode.dkimCopied') : t('admin.mailNode.dkimCopy')}
      </button>
    </div>
  );
}

// One mail node domain's onboarding (GET /api/mail-node/domains row): its state, where it came from
// and the checklist of steps up to "ready". An administrator adopts an unknown domain, confirms the
// next step with "Done", marks the domain ready for a pilot or a stand without a tenant, or starts
// its onboarding over; when the node reports another creation time for the domain, a warning offers
// to accept it. Below, the domain's DNS: the last check (R-14) item by item with the records to
// publish, "Check now", and the values the domain must publish that the panel cannot read yet (its
// MX, the tenant's verification TXT, the EOP DKIM selector CNAMEs); the "DNS is right" step shows
// the latest result next to its "Done", which stays a person's confirmation. Then the domain's node
// settings: the last apply (relayhost, DKIM, the send limits of its mailboxes) with the DKIM record
// to publish, "Apply settings", and, when the tenant signs and mailcow still has a key, deleting
// that key after a confirmation. The server journals each. `onChanged` runs after any of them so
// the lists reload. Nothing here ever hides the domain or changes its state on its own.
export default function MailNodeDomainOnboarding({ domain, onChanged }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // null, 'ready', 'restart' or 'dkim': the action waiting for its second confirmation.
  const [confirming, setConfirming] = useState(null);
  // The values the domain must publish while an administrator edits them; null when not editing.
  const [expected, setExpected] = useState(null);

  const run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirming(null);
      await onChanged?.();
    } catch (err) {
      setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    } finally {
      setBusy(false);
    }
  };

  const errorLine = error && (
    <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>
      {t(error.key)}{error.detail ? ` (${error.detail})` : ''}
    </div>
  );

  if (domain.state === 'unknown') {
    return (
      <div data-domain-onboarding={domain.domain}>
        <div style={noteStyle}>{t('admin.mailNode.unknownNote')}</div>
        <button type="button" onClick={() => run(() => api.mailNode.adoptDomain(domain.domain))} disabled={busy} style={{ ...primaryButtonStyle, marginTop: 8 }}>
          {t('admin.mailNode.adopt')}
        </button>
        {errorLine}
      </div>
    );
  }

  const steps = onboardingSteps(domain);
  // A row whose domain the node does not list (onNode false), or that the node could not be asked
  // about (null), only shows its history: the server refuses to move it then.
  const actionable = domain.onNode === true;
  const originKey = ORIGIN_KEYS[domain.origin];
  return (
    <div data-domain-onboarding={domain.domain}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        {t('admin.mailNode.stateNow', { state: t(domainStateKey(domain.state)) })}
        {originKey && ` ${t(originKey, { by: domain.addedBy || t('admin.mailNode.someone'), at: when(domain.addedAt) })}`}
      </div>
      {domain.onNode === false && <div style={{ ...noteStyle, color: 'var(--red)', marginTop: 4 }}>{t('admin.mailNode.domainNotOnNode')}</div>}
      {domain.onNode == null && <div style={{ ...noteStyle, color: 'var(--red)', marginTop: 4 }}>{t('admin.mailNode.nodeUnreachableNote')}</div>}
      {domain.recreated && (
        <div role="status" data-domain-recreated={domain.domain} style={warningBoxStyle}>
          <div>{t('admin.mailNode.recreatedNote', { was: domain.nodeCreated ?? '', now: domain.created ?? '' })}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" onClick={() => run(() => api.mailNode.acknowledgeDomainNode(domain.domain, domain.created))} disabled={busy} style={buttonStyle}>
              {t('admin.mailNode.acknowledge')}
            </button>
            <span style={noteStyle}>{t('admin.mailNode.acknowledgeNote')}</span>
          </div>
        </div>
      )}
      <ol style={{ margin: '10px 0 0', paddingLeft: 20, display: 'grid', gap: 6 }}>
        {steps.map((step) => (
          <li key={step.state} data-step={step.state} data-status={step.status} style={{ fontSize: 13, color: STATUS_COLORS[step.status] }}>
            <span style={{ fontWeight: step.status === 'next' ? 600 : 400 }}>{t(step.labelKey)}</span>
            {' '}
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {step.status === 'confirmed' && step.by
                ? t(step.markedReady ? 'admin.mailNode.stepMarkedReadyBy' : 'admin.mailNode.stepConfirmedBy', { by: step.by, at: when(step.at) })
                : t(STATUS_KEYS[step.status])}
            </span>
            {step.status === 'next' && step.state === 'dns_ok' && (
              <span data-dns-verdict={domain.dns?.overall ?? 'none'} style={{ fontSize: 11, marginLeft: 8, color: DNS_STATUS_COLORS[domain.dns?.overall] ?? 'var(--text-tertiary)' }}>
                {t(dnsVerdictKey(domain), { at: when(domain.dns?.at) })}
              </span>
            )}
            {step.status === 'next' && actionable && (
              <button type="button" onClick={() => run(() => api.mailNode.confirmDomainStep(domain.domain, step.state))} disabled={busy} style={{ ...buttonStyle, marginLeft: 8 }}>
                {t('admin.mailNode.stepDone')}
              </button>
            )}
          </li>
        ))}
      </ol>
      {domain.state === 'authoritative' && <div style={{ ...noteStyle, marginTop: 8 }}>{t('admin.mailNode.authoritativeNote')}</div>}
      {actionable && canMarkReady(domain) && confirming !== 'ready' && (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => setConfirming('ready')} disabled={busy} style={buttonStyle}>
            {t('admin.mailNode.markReady')}
          </button>
          <span style={{ ...noteStyle, marginLeft: 8 }}>{t('admin.mailNode.markReadyNote')}</span>
        </div>
      )}
      {confirming === 'ready' && (
        <div style={confirmBoxStyle}>
          <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{t('admin.mailNode.markReadyConfirm', { domain: domain.domain })}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" onClick={() => run(() => api.mailNode.markDomainReady(domain.domain))} disabled={busy} style={primaryButtonStyle}>
              {t('admin.mailNode.markReady')}
            </button>
            <button type="button" onClick={() => setConfirming(null)} disabled={busy} style={buttonStyle}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      {canRestartOnboarding(domain) && confirming !== 'restart' && (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => setConfirming('restart')} disabled={busy} style={buttonStyle}>
            {t('admin.mailNode.restart')}
          </button>
          <span style={{ ...noteStyle, marginLeft: 8 }}>{t('admin.mailNode.restartNote')}</span>
        </div>
      )}
      {confirming === 'restart' && (
        <div style={confirmBoxStyle}>
          <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{t('admin.mailNode.restartConfirm', { domain: domain.domain })}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" onClick={() => run(() => api.mailNode.restartDomainOnboarding(domain.domain))} disabled={busy} style={dangerButtonStyle}>
              {t('admin.mailNode.restart')}
            </button>
            <button type="button" onClick={() => setConfirming(null)} disabled={busy} style={buttonStyle}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      <div data-domain-dns={domain.domain}>
        <div style={subTitleStyle}>{t('admin.mailNode.dnsTitle')}</div>
        {domain.dns
          ? <MailNodeDnsResult result={domain.dns} />
          : <div style={noteStyle}>{t('admin.mailNode.dnsNever')}</div>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <button type="button" onClick={() => run(() => api.mailNode.checkDomainDns(domain.domain))} disabled={busy} style={buttonStyle}>
            {t('admin.mailNode.dnsCheckNow')}
          </button>
          {expected === null && (
            <button type="button" onClick={() => setExpected(expectedForm(domain.expected))} disabled={busy} style={buttonStyle}>
              {t('admin.mailNode.dnsExpectedEdit')}
            </button>
          )}
        </div>
        {expected !== null && (
          <div data-dns-expected-form style={confirmBoxStyle}>
            <div style={{ ...noteStyle, marginBottom: 8 }}>{t('admin.mailNode.dnsExpectedNote')}</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {EXPECTED_FIELDS.map(([field, labelKey, placeholderKey]) => (
                <label key={field}>
                  <span style={labelStyle}>{t(labelKey)}</span>
                  <input
                    value={expected[field]}
                    onChange={(e) => setExpected({ ...expected, [field]: e.target.value })}
                    spellCheck={false}
                    placeholder={t(placeholderKey)}
                    style={fieldStyle}
                  />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
              <button
                type="button"
                onClick={() => run(async () => {
                  await api.mailNode.setDnsExpected(domain.domain, expected);
                  setExpected(null);
                })}
                disabled={busy || !!expectedValuesError(expected)}
                style={primaryButtonStyle}
              >
                {t('common.save')}
              </button>
              <button type="button" onClick={() => setExpected(null)} disabled={busy} style={buttonStyle}>
                {t('common.cancel')}
              </button>
              {expectedValuesError(expected) && <span style={noteStyle}>{t(expectedValuesError(expected))}</span>}
            </div>
          </div>
        )}
      </div>
      <div data-domain-apply={domain.domain}>
        <div style={subTitleStyle}>{t('admin.mailNode.domainApplyTitle')}</div>
        {domain.apply
          ? <MailNodeApplyResult result={domain.apply} />
          : <div style={noteStyle}>{t('admin.mailNode.applyNever')}</div>}
        {domain.apply?.dkim && <DkimRecord dkim={domain.apply.dkim} />}
        {actionable && (
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => run(() => api.mailNode.applyDomain(domain.domain))} disabled={busy} style={buttonStyle}>
              {t('admin.mailNode.applyButton')}
            </button>
          </div>
        )}
        {actionable && dkimDeleteWaiting(domain) && confirming !== 'dkim' && (
          <div role="status" data-dkim-delete-waiting style={warningBoxStyle}>
            <div>{t('admin.mailNode.dkimDeleteNote')}</div>
            <button type="button" onClick={() => setConfirming('dkim')} disabled={busy} style={{ ...buttonStyle, marginTop: 8 }}>
              {t('admin.mailNode.dkimDelete')}
            </button>
          </div>
        )}
        {confirming === 'dkim' && (
          <div style={confirmBoxStyle}>
            <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{t('admin.mailNode.dkimDeleteConfirm', { domain: domain.domain })}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                onClick={() => run(() => api.mailNode.applyDomain(domain.domain, { confirmDkimDelete: true }))}
                disabled={busy}
                style={dangerButtonStyle}
              >
                {t('admin.mailNode.dkimDelete')}
              </button>
              <button type="button" onClick={() => setConfirming(null)} disabled={busy} style={buttonStyle}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
      {errorLine}
    </div>
  );
}
