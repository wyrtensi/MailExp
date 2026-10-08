// Run with: node --test src/utils/adminUsers.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_USER_ERROR_CODES, adminUserErrorKey, adminUserErrorText, accessStateBadge } from './adminUsers.js';

const readLocale = (lang) => JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8'));
const en = readLocale('en');
const ru = readLocale('ru');
const lookup = (dict, key) => key.split('.').reduce((node, part) => node?.[part], dict);
const tFor = (dict) => (key) => {
  const value = lookup(dict, key);
  return typeof value === 'string' ? value : key;
};
const refusal = (message, code) => Object.assign(new Error(message), code ? { code } : {});

describe('adminUserErrorKey', () => {
  it('every mapped code has its text in English and Russian', () => {
    assert.ok(ADMIN_USER_ERROR_CODES.length > 0);
    for (const code of ADMIN_USER_ERROR_CODES) {
      const key = adminUserErrorKey(code);
      for (const [lang, dict] of [['en', en], ['ru', ru]]) {
        assert.equal(typeof lookup(dict, key), 'string', `${code} -> ${key} missing in ${lang}`);
      }
    }
  });

  it('knows nothing of other codes nor of object properties', () => {
    for (const code of [undefined, null, '', 'toString', '__proto__', 'other']) assert.equal(adminUserErrorKey(code), null);
  });
});

describe('adminUserErrorText', () => {
  it('explains the guard refusals in the interface language', () => {
    const lastAdmin = refusal('At least one active admin must remain', 'last_admin');
    assert.match(adminUserErrorText(lastAdmin, tFor(en)), /At least one active administrator must remain/);
    assert.match(adminUserErrorText(lastAdmin, tFor(ru)), /хотя бы один активный администратор/);
    assert.match(adminUserErrorText(refusal('x', 'bootstrap_admin'), tFor(ru)), /BOOTSTRAP_ADMIN_EMAILS/);
  });

  it('uses a code any route answers when the users map has none', () => {
    assert.equal(adminUserErrorText(refusal('Invalid id', 'invalid_id'), tFor(en)), en.common.apiError.invalidId);
  });

  it('keeps the server text for a refusal without a known code', () => {
    assert.equal(adminUserErrorText(refusal('Cannot change your own account this way'), tFor(ru)), 'Cannot change your own account this way');
  });

  it('says the action failed when there is no text at all', () => {
    assert.equal(adminUserErrorText(refusal(''), tFor(ru)), ru.admin.users.errorFailed);
    assert.equal(adminUserErrorText(undefined, tFor(en)), en.admin.users.errorFailed);
  });
});

describe('accessStateBadge', () => {
  it('gives each access state a label and a tone, and nothing else a badge', () => {
    assert.deepEqual(accessStateBadge('in_access'), { key: 'admin.users.accessInAccess', tone: 'ok' });
    assert.deepEqual(accessStateBadge('pending'), { key: 'admin.users.accessPending', tone: 'muted' });
    assert.deepEqual(accessStateBadge('removed_in_cloudflare'), { key: 'admin.users.accessRemovedInCloudflare', tone: 'warn' });
    assert.deepEqual(accessStateBadge('not_synced'), { key: 'admin.users.accessNotSynced', tone: 'muted' });
    assert.equal(accessStateBadge(null), null);
    assert.equal(accessStateBadge('toString'), null);
  });
});
