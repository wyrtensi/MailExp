// The pure rules of the Microsoft tenant part of the EOP screen (stage 7a): mirrors of backend
// services/mailNode/eopSettings.js (the tenant domain), nodeAlerts.js (the tenant alerts and the
// certificate thresholds) and the codes of services/tenant/*.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_KEYS, POLICY_FIELDS, TENANT_STEPS, alertDetail, alertSourceKey, alertTitleKey, mailNodeErrorKey, normalizeEopSettings,
  phishHeld, phishReasonKey, phishStateKey, policyConflictKey, policyFieldKey, tenantCertificateLevel, tenantFailureKey, tenantJobActive, tenantStepKey,
} from './mailNode.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const DAY = 86400000;
const at = (ms) => new Date(ms).toISOString();

describe('the tenant domain', () => {
  it('is the onmicrosoft.com domain, like the server', () => {
    assert.deepEqual(normalizeEopSettings({ tenantDomain: ' Contoso.OnMicrosoft.com ' }), { settings: { tenantDomain: 'contoso.onmicrosoft.com' } });
    assert.deepEqual(normalizeEopSettings({ tenantDomain: 'contoso.com' }), { error: 'tenant_domain_invalid' });
    assert.deepEqual(normalizeEopSettings({ tenantDomain: '' }), { settings: { tenantDomain: null } });
    assert.equal(mailNodeErrorKey('tenant_domain_invalid'), 'admin.eop.errorTenantDomain');
    assert.equal(mailNodeErrorKey('tenant_not_configured'), 'admin.tenant.errorNotConfigured');
  });
});

describe('tenantCertificateLevel', () => {
  it('warns under 30 days and errs under 14 and once expired, as the alert', () => {
    assert.deepEqual(tenantCertificateLevel(at(NOW + 31 * DAY), NOW), { daysLeft: 31, level: null, expired: false });
    assert.deepEqual(tenantCertificateLevel(at(NOW + 29.5 * DAY), NOW), { daysLeft: 29, level: 'warning', expired: false });
    assert.deepEqual(tenantCertificateLevel(at(NOW + 13.5 * DAY), NOW), { daysLeft: 13, level: 'error', expired: false });
    assert.equal(tenantCertificateLevel(at(NOW - DAY), NOW).expired, true);
    assert.equal(tenantCertificateLevel(null, NOW), null);
  });
});

describe('the tenant alerts', () => {
  it('have titles, details and a source name', () => {
    assert.ok(ALERT_KEYS.includes('connector_blocked_tenant'));
    assert.equal(alertTitleKey('tenant_certificate'), 'admin.nodeOps.alertTenantCertificate');
    assert.equal(alertSourceKey('tenant'), 'admin.nodeOps.sourceTenant');
    assert.deepEqual(alertDetail({
      key: 'connector_blocked_tenant',
      details: { count: 2, connectors: [{ connectorName: 'From mail node' }, { connectorId: 'abc' }], checkedAt: '2026-10-03T08:00:00.000Z' },
    }), { key: 'admin.nodeOps.alertDetailConnectorBlockedTenant', values: { count: 2, names: 'From mail node, abc' }, at: '2026-10-03T08:00:00.000Z' });
    assert.deepEqual(alertDetail({ key: 'tenant_certificate', details: { code: 'cert_expiring', daysLeft: 20, notAfter: 'x' } }), {
      key: 'admin.nodeOps.alertDetailTenantCertExpiring', values: { days: 20 }, at: 'x',
    });
    assert.equal(alertDetail({ key: 'tenant_certificate', details: { code: 'cert_expired' } }).key, 'admin.nodeOps.alertDetailTenantCertExpired');
    assert.equal(alertTitleKey('tenant_poll_failing'), 'admin.nodeOps.alertTenantPollFailing');
    assert.deepEqual(alertDetail({ key: 'tenant_poll_failing', details: { failures: 3, lastReadAt: 'x' } }), {
      key: 'admin.nodeOps.alertDetailTenantPollFailing', values: { count: 3 }, at: 'x',
    });
    assert.equal(alertDetail({ key: 'tenant_poll_failing', details: { failures: 0, code: 'tenant_poll_stale' } }).key, 'admin.nodeOps.alertDetailTenantPollStale');
    assert.equal(alertSourceKey('tenant_poll'), 'admin.nodeOps.sourceTenant');
  });
});

describe('the tenant codes', () => {
  it('translate with a fallback', () => {
    assert.deepEqual(TENANT_STEPS, ['certificate', 'graph', 'exo']);
    assert.equal(tenantStepKey('exo'), 'admin.tenant.stepExo');
    assert.equal(tenantFailureKey('certificate_mismatch'), 'admin.tenant.failCertificateMismatch');
    assert.equal(tenantFailureKey('something_new'), 'admin.tenant.failOther');
    assert.equal(policyConflictKey('quarantined'), 'admin.tenant.conflictQuarantined');
    assert.equal(policyConflictKey('x'), 'admin.tenant.conflictUnexpected');
    assert.equal(POLICY_FIELDS.length, 5);
    assert.equal(policyFieldKey('HighConfidencePhishAction'), 'admin.tenant.policyHighPhish');
    assert.equal(tenantJobActive({ status: 'running' }), true);
    assert.equal(tenantJobActive({ status: 'failed' }), false);
    assert.equal(tenantJobActive(null), false);
  });
});

describe('the phishing release (R-42, stage 7c)', () => {
  it('names each state and guard, and what stays held', () => {
    assert.equal(phishStateKey('released'), 'admin.tenant.phishStateReleased');
    assert.equal(phishStateKey('other'), 'admin.tenant.phishStateOther');
    assert.equal(phishReasonKey('foreign_recipients'), 'admin.tenant.phishReasonForeign');
    assert.equal(phishReasonKey('attempts_exhausted'), 'admin.tenant.phishReasonAttempts');
    assert.equal(phishReasonKey('new_reason'), 'admin.tenant.phishReasonOther');
    assert.equal(phishReasonKey(null), null);
    assert.equal(phishHeld({ state: 'skipped', reason: 'outbound' }), true);
    assert.equal(phishHeld({ state: 'skipped', reason: 'gone' }), false);
    assert.equal(phishHeld({ state: 'failed', reason: 'attempts_exhausted' }), true);
    assert.equal(phishHeld({ state: 'failed', reason: null }), false);
    assert.equal(phishHeld({ state: 'released' }), false);
  });

  it('the held alert and the refusals have their words', () => {
    assert.ok(ALERT_KEYS.includes('tenant_phish_held'));
    assert.equal(alertTitleKey('tenant_phish_held'), 'admin.nodeOps.alertTenantPhishHeld');
    assert.deepEqual(alertDetail({ key: 'tenant_phish_held', details: { count: 2, soonestExpiresAt: 'x' } }), {
      key: 'admin.nodeOps.alertDetailTenantPhishHeld', values: { count: 2 }, at: 'x',
    });
    assert.equal(mailNodeErrorKey('phish_release_paused'), 'admin.tenant.phishPausedError');
    assert.equal(mailNodeErrorKey('trace_too_old'), 'message.delivery.eop.tooOld');
  });
});
