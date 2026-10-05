// Run with: node --test src/utils/staleBuild.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimReloadInto, fetchServerBuild, isStaleBuildError } from './staleBuild.js';
import { BOUNDARY_TEXT, boundaryLanguage } from './boundaryText.js';

function memoryStorage() {
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

describe('isStaleBuildError', () => {
  it('recognises each browser\'s failed dynamic import and Vite\'s CSS preload failure', () => {
    for (const message of [
      // Firefox, as reported against webmail after the 3.7.1 deploy
      'error loading dynamically imported module: https://webmail.example/assets/AdminPanel-BbJRN0h2.js',
      'Failed to fetch dynamically imported module: https://mail.example/assets/ContactsPage-x1.js', // Chromium
      'Importing a module script failed.', // Safari
      'Unable to preload CSS for /assets/AdminPanel-x.css', // Vite
    ]) {
      assert.equal(isStaleBuildError(new Error(message)), true, message);
    }
  });

  it('leaves every other error alone', () => {
    for (const value of [new Error('kaboom'), new TypeError('x is undefined'), 'Network error', null, undefined]) {
      assert.equal(isStaleBuildError(value), false, String(value));
    }
  });
});

describe('fetchServerBuild', () => {
  const answer = ({ ok = true, type = 'application/json; charset=utf-8', body = { version: '3.3.0', sha: 'abc123' } } = {}) => {
    const calls = [];
    const impl = async (url, options) => {
      calls.push([url, options]);
      return { ok, headers: { get: () => type }, json: async () => body };
    };
    return { impl, calls };
  };

  it('asks /api/version, uncached, and answers its build sha', async () => {
    const { impl, calls } = answer();
    assert.equal(await fetchServerBuild(impl), 'abc123');
    assert.equal(calls[0][0], '/api/version');
    assert.equal(calls[0][1].cache, 'no-store');
  });

  // The edge's maintenance page during an update is HTML, often with 200: not a server that is up.
  it('answers no build for a maintenance page, an error, a body without a sha or a network failure', async () => {
    assert.equal(await fetchServerBuild(answer({ type: 'text/html' }).impl), null);
    assert.equal(await fetchServerBuild(answer({ ok: false }).impl), null);
    assert.equal(await fetchServerBuild(answer({ body: { version: '3.3.0' } }).impl), null);
    assert.equal(await fetchServerBuild(async () => { throw new TypeError('Failed to fetch'); }), null);
  });
});

describe('claimReloadInto', () => {
  it('allows one automatic reload into a build, and one into each later build', () => {
    const storage = memoryStorage();
    assert.equal(claimReloadInto(storage, 'b1'), true);
    assert.equal(claimReloadInto(storage, 'b1'), false);
    assert.equal(claimReloadInto(storage, 'b2'), true);
  });

  it('never reloads without working session storage or a build, since a loop could not be stopped', () => {
    assert.equal(claimReloadInto(null, 'b1'), false);
    assert.equal(claimReloadInto(memoryStorage(), null), false);
    assert.equal(claimReloadInto({ getItem() { throw new Error('denied'); }, setItem() {} }, 'b1'), false);
    assert.equal(claimReloadInto({ getItem: () => null, setItem() { throw new Error('quota'); } }, 'b1'), false);
  });
});

describe('the error page\'s language', () => {
  it('follows the language saved in the app, else the browser, else English', () => {
    assert.equal(boundaryLanguage('ru', 'en-US'), 'ru');
    assert.equal(boundaryLanguage('en', 'ru-RU'), 'en');
    assert.equal(boundaryLanguage(null, 'ru-RU'), 'ru');
    assert.equal(boundaryLanguage(null, 'de-DE'), 'en');
    assert.equal(boundaryLanguage(null, null), 'en');
  });

  it('has every English text in Russian too', () => {
    assert.deepEqual(Object.keys(BOUNDARY_TEXT.ru).sort(), Object.keys(BOUNDARY_TEXT.en).sort());
  });
});
