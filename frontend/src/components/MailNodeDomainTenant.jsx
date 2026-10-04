import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { mailNodeErrorKey, tenantFailureKey } from '../utils/mailNode.js';

const subTitleStyle = { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', margin: '14px 0 4px' };
const lineStyle = { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 };
const monoStyle = { fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-primary)', wordBreak: 'break-all' };
const noteStyle = { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 };
const buttonStyle = {
  padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const warningStyle = {
  marginTop: 6, padding: 8, borderRadius: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)',
  background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)',
};

const when = (at) => (at ? new Date(at).toLocaleString() : '');
const list = (items) => (items ?? []).join(', ');

// A failed part of the run: the translated reason and the server's short message.
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

// What the tenant driver did for one domain in its last run (stage 7b; backend
// services/tenant/tenantDomains.js, the domain's tenantSync): the domain in the tenant and its
// verification (R-23), the accepted domain type (R-24), the Outbound connector (R-25), EOP DKIM
// when the tenant signs (R-26) and the recipient mirror with what differs between the node, the
// panel and the tenant (R-29). "Run the tenant steps now" queues the domain's job; its result
// shows after it ran (onChanged reloads the list). The hold on Internal Relay (on by default until
// experiment 8) keeps a complete mirror from making the domain Authoritative until an administrator
// turns it off; a domain the tenant already had as Authoritative waits for an administrator to
// approve Internal Relay, after a confirmation. Nothing else here changes the tenant.
export default function MailNodeDomainTenant({ domain, active = false, onChanged }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState(null);
  const [confirmRelay, setConfirmRelay] = useState(false);
  const sync = domain.tenantSync;

  const act = (action, { queues = false } = {}) => async () => {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (queues) setQueued(true);
      setConfirmRelay(false);
      await onChanged?.();
    } catch (err) {
      setError(mailNodeErrorKey(err?.code));
    } finally {
      setBusy(false);
    }
  };
  const run = act(() => api.mailNode.syncTenantDomain(domain.domain), { queues: true });
  const hold = domain.holdInternalRelay !== false;
  const toggleHold = act(() => api.mailNode.setTenantDomainHold(domain.domain, !hold));
  const approveRelay = act(() => api.mailNode.approveTenantInternalRelay(domain.domain), { queues: true });

  const graph = sync?.graph;
  const accepted = sync?.acceptedDomain;
  const connector = sync?.connector;
  const dkim = sync?.dkim;
  const mirror = sync?.mirror;
  return (
    <div data-domain-tenant={domain.domain}>
      <div style={subTitleStyle}>{t('admin.mailNode.tenantTitle')}</div>
      {!sync && <div style={noteStyle}>{t('admin.mailNode.tenantNever')}</div>}
      {sync && (
        <div style={lineStyle}>
          <div style={{ color: 'var(--text-tertiary)' }}>
            {t('admin.mailNode.tenantRunAt', { at: when(sync.at) })}
            {sync.throttled && ` · ${t('admin.mailNode.tenantThrottled')}`}
          </div>
          {graph && (
            <div data-tenant-part="graph">
              {t(graph.verified ? 'admin.mailNode.tenantDomainVerified' : 'admin.mailNode.tenantDomainAdded')}
              {/* Any 400 of verify reads as "not yet"; the message tells a lasting refusal apart. */}
              {graph.verifyError && (
                <span data-tenant-verify-error>
                  {' — '}{t('admin.mailNode.tenantVerifyWaiting')}
                  {graph.verifyError.message && <span style={{ color: 'var(--text-tertiary)' }}>{` (${graph.verifyError.message})`}</span>}
                </span>
              )}
              {!graph.verified && graph.verificationTxt && (
                <div>{t('admin.mailNode.tenantVerificationTxt')}: <span style={monoStyle}>{graph.verificationTxt}</span></div>
              )}
              {graph.verified && graph.mx?.length > 0 && <div>{t('admin.mailNode.tenantMx')}: <span style={monoStyle}>{list(graph.mx)}</span></div>}
              {graph.error && <div><Failure failure={graph.error} /></div>}
            </div>
          )}
          {accepted && (
            <div data-tenant-part="accepted">
              {accepted.visible
                ? t('admin.mailNode.tenantAcceptedType', { type: accepted.type ?? '—' })
                : t('admin.mailNode.tenantAcceptedWaiting', { count: accepted.polls ?? 1 })}
              {accepted.error && <div><Failure failure={accepted.error} /></div>}
              {accepted.code === 'authoritative_in_tenant' && (
                <div role="status" data-tenant-authoritative-decision style={warningStyle}>
                  <div>{t('admin.mailNode.tenantAuthoritativeDecision')}</div>
                  {active && !confirmRelay && (
                    <button type="button" onClick={() => setConfirmRelay(true)} disabled={busy} style={{ ...buttonStyle, marginTop: 6 }}>
                      {t('admin.mailNode.tenantApproveRelay')}
                    </button>
                  )}
                  {confirmRelay && (
                    <div style={{ marginTop: 6 }}>
                      <div>{t('admin.mailNode.tenantApproveRelayConfirm', { domain: domain.domain })}</div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                        <button type="button" onClick={approveRelay} disabled={busy} style={buttonStyle}>{t('admin.mailNode.tenantApproveRelay')}</button>
                        <button type="button" onClick={() => setConfirmRelay(false)} disabled={busy} style={buttonStyle}>{t('common.cancel')}</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {connector && (
            <div data-tenant-part="connector">
              {connector.ok
                ? t('admin.mailNode.tenantConnectorOk', { name: connector.name })
                : <Failure failure={connector.error ?? { code: connector.code, message: connector.names?.length ? list(connector.names) : null }} />}
            </div>
          )}
          {dkim && (
            <div data-tenant-part="dkim">
              {dkim.enabled ? t('admin.mailNode.tenantDkimEnabled') : t('admin.mailNode.tenantDkimWaiting')}
              {dkim.enableError && <span style={{ color: 'var(--text-tertiary)' }}>{` (${dkim.enableError.message ?? dkim.enableError.code})`}</span>}
              {dkim.error && <div><Failure failure={dkim.error} /></div>}
            </div>
          )}
          {mirror && (
            <div data-tenant-part="mirror">
              {mirror.error
                ? <Failure failure={mirror.error} />
                : t('admin.mailNode.tenantMirror', { present: mirror.present ?? 0, desired: mirror.desired ?? 0 })}
              {mirror.complete && <span>{' · '}{t('admin.mailNode.tenantMirrorComplete')}</span>}
              {mirror.retargeted?.length > 0 && <div>{t('admin.mailNode.tenantMirrorRetargeted')}: <span style={monoStyle}>{list(mirror.retargeted)}</span></div>}
              {mirror.left > 0 && <span>{' · '}{t('admin.mailNode.tenantMirrorLeft', { count: mirror.left })}</span>}
              {mirror.missing?.length > 0 && <div>{t('admin.mailNode.tenantMirrorMissing')}: <span style={monoStyle}>{list(mirror.missing)}</span></div>}
              {mirror.failed?.length > 0 && (
                <div data-tenant-mirror-failed>
                  {mirror.failed.map((f) => (
                    <div key={`${f.op}:${f.address}`}><span style={monoStyle}>{f.address}</span>{': '}<Failure failure={f} /></div>
                  ))}
                </div>
              )}
              {mirror.catchAll && (
                <div role="status" data-tenant-catch-all style={warningStyle}>{t('admin.mailNode.tenantCatchAll', { address: mirror.catchAll })}</div>
              )}
              {mirror.suspicious && <div role="status" style={warningStyle}>{t('admin.mailNode.tenantMirrorSuspicious')}</div>}
              {mirror.conflicts?.length > 0 && (
                <div role="status" style={warningStyle}>{t('admin.mailNode.tenantMirrorConflicts', { addresses: list(mirror.conflicts) })}</div>
              )}
              {mirror.nodeOnly?.length > 0 && <div>{t('admin.mailNode.tenantNodeOnly')}: <span style={monoStyle}>{list(mirror.nodeOnly)}</span></div>}
              {/* Section 5.14: aliases made by hand in mailcow are not mirrored; listed with what that means. */}
              {mirror.nodeAliases?.length > 0 && (
                <div role="status" data-tenant-node-aliases style={warningStyle}>
                  {t('admin.mailNode.tenantNodeAliases')}: <span style={monoStyle}>{list(mirror.nodeAliases)}</span>
                  <div>{t('admin.mailNode.tenantNodeAliasesNote')}</div>
                </div>
              )}
              {mirror.panelOnly?.length > 0 && <div>{t('admin.mailNode.tenantPanelOnly')}: <span style={monoStyle}>{list(mirror.panelOnly)}</span></div>}
            </div>
          )}
          {sync.authoritative?.held && (
            <div data-tenant-part="held" role="status" style={warningStyle}>{t('admin.mailNode.tenantHeldComplete')}</div>
          )}
          {sync.authoritative && !sync.authoritative.ok && (
            <div data-tenant-part="authoritative">
              {sync.authoritative.error ? <Failure failure={sync.authoritative.error} /> : <Failure failure={{ code: sync.authoritative.code }} />}
            </div>
          )}
        </div>
      )}
      {domain.state !== 'authoritative' && (
        <div data-tenant-hold={hold ? 'on' : 'off'} style={{ ...noteStyle, marginTop: 8 }}>
          {hold ? t('admin.mailNode.tenantHoldOn') : t('admin.mailNode.tenantHoldOff')}
        </div>
      )}
      {active && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <button type="button" onClick={run} disabled={busy} style={buttonStyle}>{t('admin.mailNode.tenantRunNow')}</button>
          {domain.state !== 'authoritative' && (
            <button type="button" onClick={toggleHold} disabled={busy} style={buttonStyle}>
              {hold ? t('admin.mailNode.tenantHoldRelease') : t('admin.mailNode.tenantHoldSet')}
            </button>
          )}
          {queued && <span style={noteStyle}>{t('admin.mailNode.tenantQueued')}</span>}
        </div>
      )}
      {error && <div role="alert" style={{ marginTop: 6, fontSize: 12, color: 'var(--red)' }}>{t(error)}</div>}
    </div>
  );
}
