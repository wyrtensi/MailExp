import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_IN_PATH, accessRefusalCode, isGoogleAuthMode, signInErrorKey } from './authMode.js';

describe('isGoogleAuthMode', () => {
  it('reads the mode from a user or from the sign-in config', () => {
    assert.equal(isGoogleAuthMode({ authMode: 'google' }), true);
    assert.equal(isGoogleAuthMode({ mode: 'google' }), true);
    assert.equal(isGoogleAuthMode({ authMode: 'local' }), false);
    assert.equal(isGoogleAuthMode(null), false);
  });
});

describe('accessRefusalCode', () => {
  it('reads the gate refusal codes from a 403 and ignores everything else', () => {
    assert.equal(accessRefusalCode({ status: 403, code: 'user_deleted' }), 'user_deleted');
    assert.equal(accessRefusalCode({ status: 403, code: 'user_disabled' }), 'user_disabled');
    assert.equal(accessRefusalCode({ status: 403, code: 'not_allowed' }), 'not_allowed');
    assert.equal(accessRefusalCode({ status: 403, code: 'csrf' }), null);
    assert.equal(accessRefusalCode({ status: 401, code: 'user_deleted' }), null);
    assert.equal(accessRefusalCode(null), null);
  });
});

describe('signInErrorKey', () => {
  it('maps known codes and falls back to a generic message', () => {
    assert.equal(signInErrorKey('not_allowed'), 'login.google.errorNotAllowed');
    assert.equal(signInErrorKey('user_disabled'), 'login.google.errorDisabled');
    assert.equal(signInErrorKey('user_deleted'), 'login.google.errorDeleted');
    assert.equal(signInErrorKey('email_not_verified'), 'login.google.errorEmailNotVerified');
    assert.equal(signInErrorKey('locked'), 'login.google.errorLocked');
    assert.equal(signInErrorKey('invalid_state'), 'login.google.errorGeneric');
    assert.equal(signInErrorKey(''), null);
    assert.equal(signInErrorKey(null), null);
  });

  it('points the sign-in button at the backend route', () => {
    assert.equal(SIGN_IN_PATH, '/oauth/login/google');
  });
});
