import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import {
  EOP_DEFAULTS, TLS_POLICIES, eopSettingsConflict, parseEopSettings, parseTlsParameters, tenantConfigured, tenantDriverActive,
  tlsParametersFit,
} from './eopSettings.js';

const TENANT = '11111111-2222-4333-8444-555555555555';
const APP = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

describe('parseEopSettings', () => {
  it('normalizes every field the form sends', () => {
    expect(parseEopSettings({
      eopHost: ' Contoso-com.mail.protection.outlook.com ',
      certificateHost: 'MAIL.example.com',
      dkimMode: 'eop',
      sendLimitPerHour: '50',
      terrl: 48248,
      tenantId: TENANT,
      appId: APP,
      certThumbprint: 'ab:cd ef01 2345 6789 abcd ef01 2345 6789 abcd ef01',
    })).toEqual({
      settings: {
        eopHost: 'contoso-com.mail.protection.outlook.com',
        certificateHost: 'mail.example.com',
        dkimMode: 'eop',
        sendLimitPerHour: 50,
        terrl: 48248,
        tenantId: TENANT,
        appId: APP.toLowerCase(),
        certThumbprint: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      },
    });
  });

  it('takes the licenses and the tenant creation date of the TERRL budget', () => {
    expect(parseEopSettings({ licenses: '500', tenantCreatedOn: ' 2026-09-14 ' })).toEqual({ settings: { licenses: 500, tenantCreatedOn: '2026-09-14' } });
    expect(parseEopSettings({ licenses: '', tenantCreatedOn: '' })).toEqual({ settings: { licenses: null, tenantCreatedOn: null } });
    expect(parseEopSettings({ licenses: 0 })).toEqual({ error: 'licenses_invalid' });
    expect(parseEopSettings({ licenses: 1000001 })).toEqual({ error: 'licenses_invalid' });
    for (const day of ['2026-02-30', '14.09.2026', '2999-01-01', 20260914]) {
      expect(parseEopSettings({ tenantCreatedOn: day })).toEqual({ error: 'tenant_created_invalid' });
    }
    expect(EOP_DEFAULTS).toMatchObject({ licenses: null, tenantCreatedOn: null });
  });

  it('leaves out the fields not sent and clears optional ones sent empty', () => {
    expect(parseEopSettings({ terrl: '', tenantId: null })).toEqual({ settings: { terrl: null, tenantId: null } });
    expect(parseEopSettings({})).toEqual({ settings: {} });
    expect(parseEopSettings(undefined)).toEqual({ settings: {} });
  });

  it('refuses a bad value with its own code', () => {
    const cases = [
      [{ eopHost: '10.0.0.1' }, 'eop_host_invalid'],
      [{ eopHost: '[eop.example.com]:25' }, 'eop_host_invalid'],
      [{ certificateHost: 'no-dot' }, 'certificate_host_invalid'],
      [{ dkimMode: 'both' }, 'dkim_mode_invalid'],
      [{ dkimMode: '' }, 'dkim_mode_invalid'],
      [{ sendLimitPerHour: 0 }, 'send_limit_invalid'],
      [{ sendLimitPerHour: '' }, 'send_limit_invalid'],
      [{ sendLimitPerHour: 12.5 }, 'send_limit_invalid'],
      [{ sendLimitPerHour: 10001 }, 'send_limit_invalid'],
      [{ terrl: -1 }, 'terrl_invalid'],
      [{ tenantId: 'contoso.onmicrosoft.com' }, 'tenant_id_invalid'],
      [{ appId: '1234' }, 'app_id_invalid'],
      [{ certThumbprint: 'XYZ' }, 'thumbprint_invalid'],
      [{ tlsPolicy: 'none' }, 'tls_policy_invalid'],
      [{ tlsPolicy: 'may' }, 'tls_policy_invalid'],
      [{ tlsPolicy: '' }, 'tls_policy_invalid'],
      [{ tlsPolicyParameters: 'match' }, 'tls_parameters_invalid'],
      [{ tlsPolicyParameters: 'match=a=b x' }, 'tls_parameters_invalid'],
      [{ tlsPolicyParameters: `match=${'A'.repeat(250)}` }, 'tls_parameters_invalid'],
    ];
    for (const [body, code] of cases) expect(parseEopSettings(body), JSON.stringify(body)).toEqual({ error: code });
  });
});

describe('the TLS policy for the next hop', () => {
  it('is secure until an administrator picks another level, never one without TLS', () => {
    expect(EOP_DEFAULTS).toMatchObject({ tlsPolicy: 'secure', tlsPolicyParameters: null });
    expect(TLS_POLICIES).toEqual(['secure', 'dane', 'dane-only', 'verify', 'fingerprint', 'encrypt', 'default']);
    expect(parseEopSettings({ tlsPolicy: 'dane', tlsPolicyParameters: '' })).toEqual({ settings: { tlsPolicy: 'dane', tlsPolicyParameters: null } });
  });

  it('takes Postfix policy attributes as name=value pairs', () => {
    expect(parseTlsParameters('  match=nexthop:dot-nexthop   protocols=>=TLSv1.2 ')).toBe('match=nexthop:dot-nexthop protocols=>=TLSv1.2');
    expect(parseTlsParameters('match=AB:CD:EF')).toBe('match=AB:CD:EF');
    expect(parseTlsParameters('=x')).toBeNull();
    expect(parseTlsParameters(7)).toBeNull();
  });

  it('caps the parameters at 255 characters, as mailcow stores them', () => {
    expect(parseTlsParameters(`match=${'a'.repeat(249)}`)).toHaveLength(255);
    expect(parseTlsParameters(`match=${'a'.repeat(250)}`)).toBeNull();
  });

  const SHA256 = Array.from({ length: 32 }, () => 'E2').join(':');

  it('wants the fingerprint with the fingerprint policy, as hex pairs', () => {
    expect(eopSettingsConflict({ tlsPolicy: 'fingerprint', tlsPolicyParameters: null })).toBe('tls_parameters_invalid');
    expect(eopSettingsConflict({ tlsPolicy: 'fingerprint', tlsPolicyParameters: 'ciphers=high' })).toBe('tls_parameters_invalid');
    expect(eopSettingsConflict({ tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=AB:CD' })).toBe('tls_parameters_invalid');
    expect(eopSettingsConflict({ tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=nexthop' })).toBe('tls_parameters_invalid');
    expect(eopSettingsConflict({ tlsPolicy: 'fingerprint', tlsPolicyParameters: `ciphers=high match=${SHA256}` })).toBeNull();
    expect(tlsParametersFit('fingerprint', `match=${SHA256}|${SHA256.toLowerCase()}`)).toBe(true);
  });

  it('lets secure and verify match by name strategies and host names only', () => {
    for (const policy of ['secure', 'verify']) {
      expect(tlsParametersFit(policy, ''), policy).toBe(true);
      expect(tlsParametersFit(policy, 'match=nexthop:dot-nexthop'), policy).toBe(true);
      expect(tlsParametersFit(policy, 'match=hostname ciphers=high'), policy).toBe(true);
      expect(tlsParametersFit(policy, 'match=.mail.protection.outlook.com:contoso-com.mail.protection.outlook.com'), policy).toBe(true);
      expect(tlsParametersFit(policy, `match=${SHA256}`), policy).toBe(false);
      expect(tlsParametersFit(policy, 'match=whatever!'), policy).toBe(false);
    }
  });

  it('refuses match= with the policies that check no name', () => {
    for (const policy of ['encrypt', 'dane', 'dane-only', 'default']) {
      expect(tlsParametersFit(policy, ''), policy).toBe(true);
      expect(tlsParametersFit(policy, 'protocols=>=TLSv1.2'), policy).toBe(true);
      expect(tlsParametersFit(policy, 'match=nexthop'), policy).toBe(false);
      expect(eopSettingsConflict({ tlsPolicy: policy, tlsPolicyParameters: `match=${SHA256}` }), policy).toBe('tls_parameters_invalid');
    }
    expect(eopSettingsConflict({ tlsPolicy: 'secure', tlsPolicyParameters: null })).toBeNull();
  });
});

describe('tenantDriverActive', () => {
  it('is off in this stage: the panel never talks to the tenant yet', () => {
    expect(tenantDriverActive()).toBe(false);
  });
});

describe('tenantConfigured', () => {
  it('needs the tenant, the application and the certificate', () => {
    expect(tenantConfigured({ tenantId: TENANT, appId: APP, certThumbprint: 'A'.repeat(40) })).toBe(true);
    expect(tenantConfigured({ tenantId: TENANT, appId: APP, certThumbprint: null })).toBe(false);
  });
});
