// The pure rules of the node operations screens (mirrors of backend services/mailNode/
// {mailQueue,nodeAlerts,terrl}.js and the EOP settings of the TERRL budget).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageParts, alertDetail, alertSettingsError, alertTitleKey, normalizeEopSettings, parseDay, queueItemActions, queueNameKey,
  rampPercent, tenantAgeDays, terrlBudget, terrlFromLicenses,
} from './mailNode.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');

describe('TERRL budget mirror', () => {
  it('computes the limit as the server does: 100 -> 22 059, 500 -> 48 248', () => {
    assert.equal(terrlFromLicenses(100), 22059);
    assert.equal(terrlFromLicenses(500), 48248);
    assert.equal(terrlFromLicenses(0), null);
  });

  it('applies the young tenant ramp: 10 percent to day 30, 25 percent to day 60', () => {
    assert.deepEqual([0, 30, 31, 60, 61, null].map(rampPercent), [10, 10, 25, 25, 100, 100]);
    assert.equal(tenantAgeDays('2026-09-01', NOW), 30);
    const young = terrlBudget({ settings: { licenses: 500, tenantCreatedOn: '2026-09-20' }, used: 3900, now: NOW });
    assert.deepEqual([young.limit, young.rampPercent, young.percent, young.warn], [4825, 10, 80, true]);
    assert.equal(terrlBudget({ settings: { terrl: 1000 }, used: 799, now: NOW }).warn, false);
    assert.equal(terrlBudget({ settings: {}, used: 5, now: NOW }).limit, null);
  });

  it('takes the licenses and the creation date with the EOP settings', () => {
    assert.deepEqual(normalizeEopSettings({ licenses: '500', tenantCreatedOn: '2026-09-14' }), { settings: { licenses: 500, tenantCreatedOn: '2026-09-14' } });
    assert.deepEqual(normalizeEopSettings({ licenses: '0' }), { error: 'licenses_invalid' });
    assert.deepEqual(normalizeEopSettings({ tenantCreatedOn: '2026-02-30' }), { error: 'tenant_created_invalid' });
    assert.equal(parseDay('2999-01-01'), null);
  });

  it('takes the administrator\'s own today', () => {
    const now = new Date(2026, 9, 2, 0, 30).getTime(); // 00:30 local on 2 October
    assert.equal(parseDay('2026-10-02', now), '2026-10-02');
    assert.equal(parseDay('2026-10-03', now), null);
  });
});

describe('queue', () => {
  it('offers release for a held message and hold or try now for the others', () => {
    assert.deepEqual(queueItemActions({ queue: 'hold' }), ['unhold', 'delete']);
    assert.deepEqual(queueItemActions({ queue: 'deferred' }), ['hold', 'deliver', 'delete']);
    assert.equal(queueNameKey('deferred'), 'admin.nodeOps.queueDeferred');
    assert.equal(queueNameKey('corrupt'), 'admin.nodeOps.queueOther');
  });

  it('reads an age in minutes, hours or days', () => {
    assert.deepEqual(ageParts(59), { value: 0, unitKey: 'admin.nodeOps.ageMinutes' });
    assert.deepEqual(ageParts(7199), { value: 1, unitKey: 'admin.nodeOps.ageHours' });
    assert.deepEqual(ageParts(3 * 86400), { value: 3, unitKey: 'admin.nodeOps.ageDays' });
  });
});

describe('alerts', () => {
  it('checks the alert settings form', () => {
    assert.equal(alertSettingsError({ pingUrl: '', deferredCount: '20', deferredMinutes: '60' }), null);
    assert.equal(alertSettingsError({ pingUrl: 'http://x', deferredCount: '20', deferredMinutes: '60' }), 'admin.mailNode.errorPingUrl');
    assert.equal(alertSettingsError({ pingUrl: '', deferredCount: '0', deferredMinutes: '60' }), 'admin.nodeOps.errorDeferredCount');
    assert.equal(alertSettingsError({ pingUrl: '', deferredCount: '1', deferredMinutes: '10081' }), 'admin.nodeOps.errorDeferredMinutes');
  });

  it('describes each alert', () => {
    assert.equal(alertTitleKey('eop_bypass'), 'admin.nodeOps.alertEopBypass');
    assert.equal(alertTitleKey('new_one'), 'admin.nodeOps.alertUnknown');
    assert.deepEqual(alertDetail({ key: 'eop_bypass', details: { count: 2, relays: ['a', 'b'], lastAt: 'x' } }), {
      key: 'admin.nodeOps.alertDetailBypass', values: { count: 2, relays: 'a, b' }, at: 'x',
    });
    assert.equal(alertTitleKey('eop_host_missing'), 'admin.nodeOps.alertEopHostMissing');
    assert.deepEqual(alertDetail({ key: 'eop_host_missing', severity: 'info', details: {} }), { key: 'admin.nodeOps.alertDetailEopHostMissing', values: {} });
    assert.deepEqual(alertDetail({ key: 'containers', details: { down: [{ name: 'dovecot-mailcow', state: 'restarting' }] } }).values, { names: 'dovecot-mailcow (restarting)' });
    assert.equal(alertDetail({ key: 'certificate', details: { code: 'cert_expired', expiresAt: 'y' } }).key, 'admin.nodeOps.alertDetailCertExpired');
    assert.deepEqual(alertDetail({ key: 'queue_deferred', details: { deferred: 21, oldestMinutes: null, deferredCount: 20, deferredMinutes: 60 } }).values, {
      deferred: 21, oldest: '—', count: 20, minutes: 60,
    });
    assert.equal(alertDetail({ key: 'unknown' }), null);
  });
});
