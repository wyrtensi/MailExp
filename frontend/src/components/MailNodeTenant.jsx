import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  POLICY_FIELDS,
  TENANT_STEPS,
  mailNodeErrorKey,
  policyConflictKey,
  policyFieldKey,
  tenantCertificateLevel,
  tenantFailureKey,
  tenantJobActive,
  tenantStepKey,
} from '../utils/mailNode.js';

const subTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '16px 0 6px' };
const hintStyle = { display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 };
const textStyle = { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 };
const monoStyle = { fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--text-primary)' };
const buttonStyle = {
  padding: '7px 12px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const boxStyle = (level) => ({
  marginTop: 8, padding: 10, borderRadius: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)',
  background: level === 'error' ? 'rgba(220,38,38,0.08)' : 'rgba(245,158,11,0.10)',
  border: `1px solid ${level === 'error' ? 'rgba(220,38,38,0.35)' : 'rgba(245,158,11,0.35)'}`,
});
const SEVERITY_COLORS = { error: 'var(--red)', warning: '#b45309', info: 'var(--text-secondary)' };
const POLL_MS = 1500;
const POLL_LIMIT = 200;

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// One failure line: the translated reason, with the server's short message when it has one.
function Failure({ failure }) {
  const { t } = useTranslation();
  if (!failure) return null;
  return (
    <span style={{ color: 'var(--red)' }}>
      {t(tenantFailureKey(failure.code))}
      {failure.message ? <span style={{ color: 'var(--text-tertiary)' }}>{` (${failure.message})`}</span> : null}
    </span>
  );
}

// Settings -> Integrations -> EOP -> "Microsoft tenant" (stage 7a, admins only): the tenant driver
// the panel runs with, the application certificate the tenant worker holds (thumbprint and expiry;
// the PFX itself never enters the panel, R-35), "Test connection" (a Graph token and EXO whoami
// through the job queue, its result step by step), the blocked inbound connectors the poll found
// (R-27; removing a block stays in the Microsoft portal for now), and the anti-spam policy read
// only, with what does not fit the spam filing layout (R-28). Every button queues a job and the
// section follows it until it ends. `revision` changes when the EOP settings were saved.
export default function MailNodeTenant({ revision = 0 }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // the kind of job a button started and the section follows
  const followed = useRef(0);

  const load = useCallback(async () => {
    try {
      setData(await api.mailNode.getTenant());
      setError(null);
    } catch (err) {
      setError(mailNodeErrorKey(err?.code));
    }
  }, []);
  useEffect(() => { load(); }, [load, revision]);
  useEffect(() => () => { followed.current += 1; }, []);

  // Follows a job until it ends, then reloads what it stored.
  const follow = useCallback(async (job, kind) => {
    const mine = ++followed.current;
    setBusy(kind);
    let current = job;
    for (let i = 0; tenantJobActive(current) && i < POLL_LIMIT; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
      if (mine !== followed.current) return;
      try {
        current = (await api.mailNode.getTenantJob(current.id)).job;
      } catch (err) {
        setError(mailNodeErrorKey(err?.code));
        break;
      }
    }
    if (mine !== followed.current) return;
    setBusy(null);
    await load();
  }, [load]);

  const start = (kind, action) => async () => {
    setError(null);
    try {
      const { job } = await action();
      await follow(job, kind);
    } catch (err) {
      setBusy(null);
      setError(mailNodeErrorKey(err?.code));
    }
  };

  if (!data && !error) return <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>;

  const state = data?.state ?? {};
  const connection = state.connection;
  const certificate = state.certificate;
  const blocked = state.blockedConnectors;
  const antispam = state.antispam;
  const cert = tenantCertificateLevel(certificate?.notAfter);
  const canRun = !!data?.driver && !!data?.configured && !busy;
  const testRunning = busy === 'test' || tenantJobActive(data?.jobs?.test);

  return (
    <div data-tenant>
      <div style={textStyle}>
        {!data?.driver && t('admin.tenant.noDriver')}
        {data?.driver === 'fake' && t('admin.tenant.fakeDriver')}
        {data?.driver === 'worker' && t('admin.tenant.workerDriver')}
        {data?.driver && !data.configured && <div>{t('admin.tenant.notConfigured')}</div>}
        {data?.profileWithoutDriver && (
          <div role="status" data-tenant-profile-warning style={boxStyle('warning')}>{t('admin.tenant.profileWithoutDriver')}</div>
        )}
      </div>

      <div style={subTitleStyle}>{t('admin.tenant.certificateTitle')}</div>
      {certificate?.thumbprint ? (
        <div data-tenant-certificate style={textStyle}>
          <div>{t('admin.tenant.certificateThumbprint')}: <span style={monoStyle}>{certificate.thumbprint}</span></div>
          {certificate.subject && <div>{t('admin.tenant.certificateSubject')}: <span style={monoStyle}>{certificate.subject}</span></div>}
          <div>{t('admin.tenant.certificateValidUntil', { at: when(certificate.notAfter) })}</div>
          {cert?.level && (
            <div role="status" data-tenant-cert-warning={cert.level} style={boxStyle(cert.level)}>
              {cert.expired ? t('admin.tenant.certificateExpired') : t('admin.tenant.certificateExpiring', { days: cert.daysLeft })}
              {' '}{t('admin.tenant.certificateRenewHint')}
            </div>
          )}
          {certificate.error && <div><Failure failure={certificate.error} /></div>}
        </div>
      ) : (
        <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.tenant.certificateUnknown')}</span>
      )}

      <div style={subTitleStyle}>{t('admin.tenant.connectionTitle')}</div>
      {connection ? (
        <div data-tenant-connection style={textStyle}>
          <div style={{ fontWeight: 600, color: connection.ok ? 'var(--green, #16a34a)' : 'var(--red)' }}>
            {connection.ok ? t('admin.tenant.connectionOk') : t('admin.tenant.connectionFailed')}
            <span style={{ fontWeight: 400, color: 'var(--text-tertiary)' }}>{` · ${when(connection.at)}`}</span>
          </div>
          {TENANT_STEPS.map((step) => {
            const s = connection.steps?.[step];
            return (
              <div key={step} data-tenant-step={step}>
                {t(tenantStepKey(step))}:{' '}
                {!s && <span style={{ color: 'var(--text-tertiary)' }}>{t('admin.tenant.stepSkipped')}</span>}
                {s?.ok && step === 'graph' && t('admin.tenant.stepGraphOk', { domain: s.initialDomain, count: s.domains })}
                {s?.ok && step === 'exo' && t('admin.tenant.stepExoOk', { organization: s.displayName || s.organization })}
                {s?.ok && step === 'certificate' && t('admin.tenant.stepCertificateOk')}
                {s && !s.ok && <Failure failure={s} />}
              </div>
            );
          })}
        </div>
      ) : (
        <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.tenant.connectionNever')}</span>
      )}
      <div style={{ marginTop: 8 }}>
        <button type="button" onClick={start('test', api.mailNode.testTenant)} disabled={!canRun || testRunning} style={buttonStyle}>
          {testRunning ? t('admin.tenant.testRunning') : t('admin.tenant.testButton')}
        </button>
      </div>

      <div style={subTitleStyle}>{t('admin.tenant.blockedTitle')}</div>
      <span style={{ ...hintStyle, marginTop: 0, marginBottom: 6 }}>{t('admin.tenant.blockedNote')}</span>
      {!blocked && <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.tenant.blockedNever')}</span>}
      {blocked && (
        <div data-tenant-blocked style={textStyle}>
          {(blocked.items ?? []).length === 0
            ? <div>{t('admin.tenant.blockedNone', { at: when(blocked.at) })}</div>
            : (
              <div role="alert" style={boxStyle('error')}>
                <div style={{ fontWeight: 600 }}>{t('admin.tenant.blockedSome', { count: blocked.items.length })}</div>
                {blocked.items.map((c) => (
                  <div key={c.connectorId ?? c.connectorName}>
                    <span style={monoStyle}>{c.connectorName || c.connectorId}</span>
                    {c.reason ? ` — ${c.reason}` : ''}{c.createdTime ? ` · ${when(c.createdTime)}` : ''}
                  </div>
                ))}
                <div style={{ marginTop: 6 }}>{t('admin.tenant.blockedRemoveHint')}</div>
              </div>
            )}
          {blocked.error && <div><Failure failure={blocked.error} />{` · ${when(blocked.errorAt)}`}</div>}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <button type="button" onClick={start('poll', api.mailNode.pollTenant)} disabled={!canRun} style={buttonStyle}>
          {busy === 'poll' ? t('admin.tenant.checking') : t('admin.tenant.checkNow')}
        </button>
      </div>

      <div style={subTitleStyle}>{t('admin.tenant.policyTitle')}</div>
      <span style={{ ...hintStyle, marginTop: 0, marginBottom: 6 }}>{t('admin.tenant.policyNote')}</span>
      {!antispam && <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.tenant.policyNever')}</span>}
      {antispam && !antispam.ok && <div style={textStyle}><Failure failure={antispam} /></div>}
      {antispam?.ok && (
        <div data-tenant-policy style={textStyle}>
          <div style={{ color: 'var(--text-tertiary)' }}>{t('admin.tenant.policyRead', { name: antispam.policy?.identity ?? 'Default', at: when(antispam.at) })}</div>
          {POLICY_FIELDS.map((field) => (
            <div key={field} data-policy-field={field}>
              {t(policyFieldKey(field))}: <span style={monoStyle}>{antispam.policy?.[field] ?? '—'}</span>
            </div>
          ))}
          {(antispam.conflicts ?? []).length === 0
            ? <div style={{ marginTop: 6 }}>{t('admin.tenant.policyFits')}</div>
            : (antispam.conflicts.map((c) => (
              <div key={c.field} data-policy-conflict={c.field} style={boxStyle(c.severity === 'error' ? 'error' : 'warning')}>
                <span style={{ fontWeight: 600, color: SEVERITY_COLORS[c.severity] ?? 'var(--red)' }}>{t(policyFieldKey(c.field))}: {c.action}</span>
                {' — '}{t(policyConflictKey(c.code), { expected: (c.expected ?? []).join(', ') })}
              </div>
            )))}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <button type="button" onClick={start('antispam', api.mailNode.readTenantAntispam)} disabled={!canRun} style={buttonStyle}>
          {busy === 'antispam' ? t('admin.tenant.checking') : t('admin.tenant.policyRefresh')}
        </button>
      </div>

      {error && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>{t(error)}</div>}
    </div>
  );
}
