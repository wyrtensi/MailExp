import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  POLICY_FIELDS,
  TENANT_STEPS,
  mailNodeErrorKey,
  phishHeld,
  phishReasonKey,
  phishStateKey,
  policyConflictKey,
  policyFieldKey,
  quarantineTypeKey,
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
// only, with what does not fit the spam filing layout (R-28), and (stage 7b, R-25) the connectors
// compared with their reference, with "Take as the reference" after a deliberate change. Every
// job button queues a job and the section follows it until it ends. `revision` changes when the
// EOP settings were saved.
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
  const connectors = state.connectors;
  const reference = state.connectorReference;
  const drift = data?.connectorDrift ?? [];
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
          {antispam.enforcement?.changed?.length > 0 && (
            <div role="status" data-policy-enforced style={{ marginTop: 6 }}>
              {t('admin.tenant.policyEnforced', {
                at: when(antispam.enforcement.at),
                fields: antispam.enforcement.changed.map((c) => `${t(policyFieldKey(c.field))} (${c.from} → ${c.to})`).join(', '),
              })}
            </div>
          )}
          {antispam.enforcement && !antispam.enforcement.ok && (
            <div role="alert" data-policy-not-enforced style={boxStyle('warning')}>
              {t(antispam.enforcement.unconfirmed ? 'admin.tenant.policyUnconfirmed' : 'admin.tenant.policyNotEnforced', {
                fields: (antispam.enforcement.failed ?? []).map((f) => t(policyFieldKey(f))).join(', ') || '—',
              })}
              {antispam.enforcement.error && <div><Failure failure={antispam.enforcement.error} /></div>}
            </div>
          )}
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

      <div style={subTitleStyle}>{t('admin.tenant.connectorsTitle')}</div>
      <span style={{ ...hintStyle, marginTop: 0, marginBottom: 6 }}>{t('admin.tenant.connectorsNote')}</span>
      {!connectors && <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.tenant.connectorsNever')}</span>}
      {connectors && (
        <div data-tenant-connectors style={textStyle}>
          {connectors.ok !== false && (
            <div>
              {t('admin.tenant.connectorsRead', { at: when(connectors.at) })}
              {': '}
              <span style={monoStyle}>{[...(connectors.inbound ?? []), ...(connectors.outbound ?? [])].map((c) => c.name).join(', ') || '—'}</span>
            </div>
          )}
          {connectors.error && <div><Failure failure={connectors.error} />{` · ${when(connectors.errorAt)}`}</div>}
          {reference && (
            <div style={{ color: 'var(--text-tertiary)' }}>
              {reference.auto ? t('admin.tenant.referenceAuto', { at: when(reference.at) }) : t('admin.tenant.referenceTaken', { at: when(reference.at) })}
            </div>
          )}
          {drift.length === 0 && reference && connectors.ok !== false && <div>{t('admin.tenant.driftNone')}</div>}
          {drift.length > 0 && (
            <div role="status" data-tenant-drift style={boxStyle('warning')}>
              <div style={{ fontWeight: 600 }}>{t('admin.tenant.driftSome', { count: drift.length })}</div>
              {drift.map((d) => (
                <div key={`${d.direction}:${d.name}:${d.kind}`} data-drift={d.kind}>
                  <span style={monoStyle}>{d.name}</span>{' — '}
                  {d.kind === 'missing' && t('admin.tenant.driftMissing')}
                  {d.kind === 'added' && t('admin.tenant.driftAdded')}
                  {d.kind === 'changed' && (d.changes ?? []).map((c) => `${c.property}: ${JSON.stringify(c.was)} → ${JSON.stringify(c.now)}`).join('; ')}
                </div>
              ))}
              <div style={{ marginTop: 6 }}>{t('admin.tenant.driftHint')}</div>
            </div>
          )}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          onClick={async () => {
            setError(null);
            try {
              await api.mailNode.takeTenantConnectorReference();
              await load();
            } catch (err) {
              setError(mailNodeErrorKey(err?.code));
            }
          }}
          disabled={!canRun || !connectors?.ok}
          style={buttonStyle}
        >
          {t('admin.tenant.referenceTake')}
        </button>
      </div>

      {error && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>{t(error)}</div>}

      {data?.driver && data?.configured && <PhishRelease canRun revision={revision} />}
    </div>
  );
}

const cellStyle = { padding: '4px 6px', borderTop: '1px solid var(--border)', verticalAlign: 'top', wordBreak: 'break-word' };

// Stage 7c, R-42 (decision D-2), widened in section 5.14: high confidence phishing, phishing, spam and
// high confidence spam EOP quarantined, released by MailExpert to the node's mailboxes, where they
// land in Junk and open in the safe view; malware and other types are never released. The switch (on
// by default since section 5.14), "Release now", the last run, the messages kept in the quarantine
// (a guard: a type not released, a recipient outside the node, an outbound message, a release
// denied; or a release that kept failing) and the latest rows. R-31 (a release by hand, the Tenant
// Allow/Block List) is not offered.
function PhishRelease({ canRun, revision }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Set again on every mount: React.StrictMode mounts, unmounts and mounts once more, and a flag
  // only ever cleared would drop every answer after that (the section showed its title alone).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await api.mailNode.getPhishRelease();
      if (alive.current) {
        setData(next);
        setError(null);
      }
    } catch (err) {
      if (alive.current) setError(mailNodeErrorKey(err?.code));
    }
  }, []);
  useEffect(() => { load(); }, [load, revision]);

  const act = async (action) => {
    setBusy(true);
    setError(null);
    try {
      const answer = await action();
      let job = answer?.job ?? null;
      for (let i = 0; job && tenantJobActive(job) && i < POLL_LIMIT && alive.current; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
        job = (await api.mailNode.getTenantJob(job.id)).job;
      }
      await load();
    } catch (err) {
      if (alive.current) setError(mailNodeErrorKey(err?.code));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const run = data?.run;
  const held = data?.held?.count ?? 0;
  const rows = data?.releases ?? [];
  return (
    <div data-phish-release>
      <div style={subTitleStyle}>{t('admin.tenant.phishTitle')}</div>
      <span style={{ ...hintStyle, marginTop: 0, marginBottom: 6 }}>{t('admin.tenant.phishNote')}</span>
      {data && (
        <div style={textStyle}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={!!data.enabled}
              disabled={busy}
              onChange={(e) => act(() => api.mailNode.setPhishRelease(e.target.checked))}
              aria-describedby="phish-release-switch-hint"
            />
            {t('admin.tenant.phishEnabled')}
          </label>
          <span id="phish-release-switch-hint" style={hintStyle}>{t('admin.tenant.phishEnabledHint')}</span>
          {!data.enabled && <div role="status" data-phish-paused style={boxStyle('warning')}>{t('admin.tenant.phishPaused')}</div>}
          {run && (
            <div data-phish-run style={{ marginTop: 6 }}>
              {run.paused && t('admin.tenant.phishRunPaused', { at: when(run.at) })}
              {run.noDomains && t('admin.tenant.phishRunNoDomains', { at: when(run.at) })}
              {!run.paused && !run.noDomains && run.counts && t('admin.tenant.phishRunCounts', {
                at: when(run.at), released: run.counts.released ?? 0, skipped: run.counts.skipped ?? 0, failed: run.counts.failed ?? 0,
              })}
              {run.left && <div>{t('admin.tenant.phishRunLeft')}</div>}
              {/* Section 5.14: spam, phishing and bulk wait for this version of the spam rule on the node. */}
              {run.rule && run.rule.state !== 'ok' && !run.paused && !run.noDomains && (
                <div role="status" data-phish-rule-waiting={run.rule.state} style={boxStyle('warning')}>
                  {t('admin.tenant.phishRuleWaiting', { count: run.counts?.ruleWaiting ?? 0 })}
                </div>
              )}
              {run.throttled && <div><Failure failure={{ code: run.throttled.code }} /></div>}
              {run.error && <div><Failure failure={run.error} /></div>}
            </div>
          )}
          {!run && <span style={{ ...hintStyle, marginTop: 0 }}>{t('admin.tenant.phishNever')}</span>}
          {held > 0 && (
            <div role="status" data-phish-held style={boxStyle('warning')}>{t('admin.tenant.phishHeld', { count: held })}</div>
          )}
          {rows.length > 0 && (
            <table data-phish-rows style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, fontSize: 11 }}>
              <caption style={{ textAlign: 'left', fontWeight: 600, color: 'var(--text-primary)', paddingBottom: 4 }}>{t('admin.tenant.phishRowsTitle')}</caption>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th scope="col" style={cellStyle}>{t('admin.tenant.phishColState')}</th>
                  <th scope="col" style={cellStyle}>{t('admin.tenant.phishColType')}</th>
                  <th scope="col" style={cellStyle}>{t('admin.tenant.phishColReceived')}</th>
                  <th scope="col" style={cellStyle}>{t('admin.tenant.phishColSender')}</th>
                  <th scope="col" style={cellStyle}>{t('admin.tenant.phishColRecipients')}</th>
                  <th scope="col" style={cellStyle}>{t('admin.tenant.phishColSubject')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const reason = phishReasonKey(row.reason);
                  const typeKey = quarantineTypeKey(row.type);
                  return (
                    <tr key={row.identity} data-phish-row={row.state} data-phish-held-row={phishHeld(row) ? 'true' : undefined}>
                      <td style={cellStyle}>
                        {t(phishStateKey(row.state))}
                        {reason && <div style={{ color: 'var(--text-tertiary)' }}>{t(reason)}</div>}
                        {row.error && row.state !== 'released' && (
                          <div data-phish-error={row.errorCode ?? 'other'} style={{ color: 'var(--text-tertiary)' }}>
                            {t(tenantFailureKey(row.errorCode))}
                            <div title={row.error} style={{ fontSize: 10, wordBreak: 'break-word' }}>{row.error}</div>
                          </div>
                        )}
                      </td>
                      <td style={cellStyle} data-phish-type={row.type ?? ''}>{typeKey ? t(typeKey) : (row.type ?? '—')}</td>
                      <td style={cellStyle}>{when(row.receivedAt)}</td>
                      <td style={{ ...cellStyle, ...monoStyle, fontSize: 11 }}>{row.sender ?? '—'}</td>
                      <td style={{ ...cellStyle, ...monoStyle, fontSize: 11 }}>{(row.recipients ?? []).join(', ') || '—'}</td>
                      <td style={cellStyle}>{row.subject ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => act(api.mailNode.runPhishRelease)} disabled={!canRun || busy || !data.enabled} style={buttonStyle}>
              {busy ? t('admin.tenant.checking') : t('admin.tenant.phishRunNow')}
            </button>
          </div>
        </div>
      )}
      {error && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>{t(error)}</div>}
    </div>
  );
}
