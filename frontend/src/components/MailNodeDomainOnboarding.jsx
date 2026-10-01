import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  canMarkReady,
  canRestartOnboarding,
  domainStateKey,
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

// One mail node domain's onboarding (GET /api/mail-node/domains row): its state, where it came from
// and the checklist of steps up to "ready". An administrator adopts an unknown domain, confirms the
// next step with "Done", marks the domain ready for a pilot or a stand without a tenant, or starts
// its onboarding over; when the node reports another creation time for the domain, a warning offers
// to accept it. The server journals each. `onChanged` runs after any of them so the lists reload.
// Nothing here ever hides the domain or changes its state on its own.
export default function MailNodeDomainOnboarding({ domain, onChanged }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // null, 'ready' or 'restart': the action waiting for its second confirmation.
  const [confirming, setConfirming] = useState(null);

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
      {errorLine}
    </div>
  );
}
