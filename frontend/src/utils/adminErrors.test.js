// Run with: node --test src/utils/adminErrors.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INVITE_ERROR_KEYS, OIDC_ERROR_KEYS, SETTINGS_ERROR_KEYS, SYSTEM_EMAIL_ERROR_KEYS,
} from './adminErrors.js';
import { apiErrorText } from './apiErrors.js';
import { adminUserErrorText } from './adminUsers.js';

const readLocale = (lang) => JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8'));
const en = readLocale('en');
const ru = readLocale('ru');
const lookup = (dict, key) => key.split('.').reduce((node, part) => node?.[part], dict);
// A translate function over a real locale with i18next's {{value}} interpolation.
const tFor = (dict) => (key, values = {}) => {
  const text = lookup(dict, key);
  return typeof text === 'string' ? text.replace(/\{\{(\w+)\}\}/g, (_, name) => values[name] ?? '') : key;
};
const refusal = (message, code) => Object.assign(new Error(message), code ? { code } : {});

const SCREENS = {
  settings: SETTINGS_ERROR_KEYS,
  invites: INVITE_ERROR_KEYS,
  oidc: OIDC_ERROR_KEYS,
  systemEmail: SYSTEM_EMAIL_ERROR_KEYS,
};

describe('admin screen error keys', () => {
  it('every mapped code of every screen has its text in English and Russian', () => {
    for (const [screen, keys] of Object.entries(SCREENS)) {
      assert.ok(Object.keys(keys).length > 0, screen);
      for (const [code, key] of Object.entries(keys)) {
        for (const [lang, dict] of [['en', en], ['ru', ru]]) {
          assert.equal(typeof lookup(dict, key), 'string', `${screen}: ${code} -> ${key} missing in ${lang}`);
        }
      }
    }
  });

  it('covers the refusals each admin route answers (backend PR #210)', () => {
    assert.deepEqual(Object.keys(SETTINGS_ERROR_KEYS).sort(), [
      'auth_max_attempts_invalid', 'auth_window_minutes_invalid', 'custom_css_invalid', 'custom_css_too_long',
      'invalid_field', 'mfa_device_trust_invalid', 'mfa_enforcement_invalid', 'no_sso_provider', 'sso_identity_required',
    ]);
    assert.deepEqual(Object.keys(INVITE_ERROR_KEYS).sort(), ['app_url_missing', 'email_invalid', 'not_found']);
    assert.deepEqual(Object.keys(OIDC_ERROR_KEYS).sort(), [
      'fields_required', 'issuer_host_refused', 'issuer_invalid', 'issuer_not_https', 'last_provider',
      'login_match_claim_invalid', 'not_found', 'slug_invalid', 'slug_taken',
    ]);
    assert.deepEqual(Object.keys(SYSTEM_EMAIL_ERROR_KEYS).sort(), [
      'config_corrupted', 'fields_required', 'host_refused', 'not_configured', 'password_missing', 'smtp_failed',
    ]);
  });
});

describe('admin refusals as the screens show them', () => {
  it('a shared code means what its screen means', () => {
    const notFound = refusal('Not found', 'not_found');
    assert.match(apiErrorText(notFound, tFor(en), { keys: OIDC_ERROR_KEYS }), /provider/i);
    assert.match(apiErrorText(notFound, tFor(en), { keys: INVITE_ERROR_KEYS }), /invite/i);
    assert.match(adminUserErrorText(notFound, tFor(en)), /user/i);
    const fields = refusal('required', 'fields_required');
    assert.match(apiErrorText(fields, tFor(en), { keys: OIDC_ERROR_KEYS }), /issuer/i);
    assert.match(apiErrorText(fields, tFor(en), { keys: SYSTEM_EMAIL_ERROR_KEYS }), /SMTP/);
  });

  it('turning password login off without SSO is explained in both languages', () => {
    const err = refusal('Cannot disable password login: no enabled SSO providers are configured.', 'no_sso_provider');
    assert.match(apiErrorText(err, tFor(en), { keys: SETTINGS_ERROR_KEYS }), /SSO provider/);
    assert.match(apiErrorText(err, tFor(ru), { keys: SETTINGS_ERROR_KEYS }), /SSO/);
    assert.doesNotMatch(apiErrorText(err, tFor(ru), { keys: SETTINGS_ERROR_KEYS }), /Cannot disable/);
  });

  it('keeps the server detail where it is the useful part (the SMTP answer, the refused host)', () => {
    const smtp = refusal('535 5.7.8 Authentication credentials invalid', 'smtp_failed');
    const ruText = apiErrorText(smtp, tFor(ru), { keys: SYSTEM_EMAIL_ERROR_KEYS });
    assert.match(ruText, /SMTP/);
    assert.match(ruText, /535 5\.7\.8/);
    const host = refusal('private addresses are not allowed', 'host_refused');
    assert.match(apiErrorText(host, tFor(en), { keys: SYSTEM_EMAIL_ERROR_KEYS }), /SMTP host is not allowed: private addresses are not allowed/);
  });

  it('deleting or un-2FA-ing your own account is explained', () => {
    assert.match(adminUserErrorText(refusal('Cannot change your own account this way', 'self_change'), tFor(ru)), /Свою учётную запись/);
  });

  it('falls back to the server text when there is no code (an older backend)', () => {
    assert.equal(apiErrorText(refusal('Provider not found'), tFor(ru), { keys: OIDC_ERROR_KEYS }), 'Provider not found');
    assert.equal(apiErrorText(refusal('Odd', 'brand_new'), tFor(en), { keys: SETTINGS_ERROR_KEYS }), 'Odd');
  });
});
