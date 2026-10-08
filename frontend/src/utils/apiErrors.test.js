// Run with: node --test src/utils/apiErrors.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API_ERROR_CODES, apiErrorKey, apiErrorText } from './apiErrors.js';

const readLocale = (lang) => JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8'));
const en = readLocale('en');
const ru = readLocale('ru');
const lookup = (dict, key) => key.split('.').reduce((node, part) => node?.[part], dict);
// A translate function over a real locale, as i18next would answer (no interpolation needed here).
const tFor = (dict) => (key) => {
  const value = lookup(dict, key);
  return typeof value === 'string' ? value : key;
};
const refusal = (message, code) => Object.assign(new Error(message), code ? { code } : {});

describe('apiErrorKey', () => {
  it('every mapped code has its text in English and Russian', () => {
    assert.ok(API_ERROR_CODES.length > 0);
    for (const code of API_ERROR_CODES) {
      const key = apiErrorKey(code);
      for (const [lang, dict] of [['en', en], ['ru', ru]]) {
        assert.equal(typeof lookup(dict, key), 'string', `${code} -> ${key} missing in ${lang}`);
      }
    }
  });

  it('knows nothing of codes it was not given, nor of object properties', () => {
    for (const code of [undefined, null, '', 'toString', '__proto__', 'constructor', 'other']) {
      assert.equal(apiErrorKey(code), null, String(code));
    }
  });

  it('leaves a route-specific code to the screen, and takes the screen\'s meaning first', () => {
    assert.equal(apiErrorKey('not_found'), null);
    assert.equal(apiErrorKey('not_found', { not_found: 'admin.rules.errorNotFound' }), 'admin.rules.errorNotFound');
    assert.equal(apiErrorKey('invalid_id', { invalid_id: 'x.y' }), 'x.y');
  });
});

describe('apiErrorText', () => {
  it('shows representative refusals in the interface language', () => {
    const cases = [
      ['contact_exists', 'A contact with this email already exists.', 'Контакт с таким адресом уже есть.'],
      ['todoist_token_invalid', /Todoist did not accept the API token/, /Todoist не принял API-токен/],
      ['account_not_found', /mailbox no longer exists/, /ящика больше нет/],
      ['move_folder_not_found', /destination folder does not exist/, /папки в этом ящике нет/],
      ['internal_error', /went wrong on the server/, /На сервере что-то пошло не так/],
    ];
    for (const [code, english, russian] of cases) {
      const err = refusal('English server text', code);
      for (const [dict, expected] of [[en, english], [ru, russian]]) {
        const text = apiErrorText(err, tFor(dict));
        if (expected instanceof RegExp) assert.match(text, expected, code);
        else assert.equal(text, expected, code);
      }
    }
  });

  it('says a busy mailbox is busy', () => {
    assert.equal(apiErrorText(refusal('busy', 'mailbox_busy'), tFor(en)), en.common.mailboxBusy);
  });

  it('keeps the server text for an unknown or missing code (an older backend)', () => {
    assert.equal(apiErrorText(refusal('Rule not found'), tFor(en)), 'Rule not found');
    assert.equal(apiErrorText(refusal('Rule not found', 'not_found'), tFor(en)), 'Rule not found');
    assert.equal(apiErrorText(refusal('Something new', 'brand_new_code'), tFor(ru)), 'Something new');
  });

  it('falls back to the given text, then to a generic one', () => {
    assert.equal(apiErrorText(refusal(''), tFor(en), { fallback: 'saved?' }), 'saved?');
    assert.equal(apiErrorText(undefined, tFor(ru)), ru.common.actionFailed.body);
  });
});
