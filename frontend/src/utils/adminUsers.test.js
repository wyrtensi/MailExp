// Run with: node --test src/utils/adminUsers.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adminUserErrorKey, adminUserErrorText } from './adminUsers.js';

const t = (key) => `t:${key}`;

describe('adminUserErrorKey', () => {
  it('maps every refusal code of the admin users API and nothing else', () => {
    // backend services/admin/users.js ADMIN_USER_ERRORS
    const codes = {
      email_invalid: 'admin.users.errorEmailInvalid',
      user_exists: 'admin.users.errorUserExists',
      username_taken: 'admin.users.errorUsernameTaken',
      invalid_field: 'admin.users.errorInvalidField',
      no_fields: 'admin.users.errorInvalidField',
      self_change: 'admin.users.errorSelfChange',
      not_found: 'admin.users.errorNotFound',
      bootstrap_admin: 'admin.users.errorBootstrapAdmin',
      last_admin: 'admin.users.errorLastAdmin',
      email_taken: 'admin.users.errorEmailTaken',
    };
    for (const [code, key] of Object.entries(codes)) assert.equal(adminUserErrorKey(code), key, code);
    for (const code of [undefined, null, '', 'toString', '__proto__', 'other']) assert.equal(adminUserErrorKey(code), null);
  });
});

describe('adminUserErrorText', () => {
  it('explains a known code in the UI language', () => {
    assert.equal(adminUserErrorText(Object.assign(new Error('At least one active admin must remain'), { code: 'last_admin' }), t),
      't:admin.users.errorLastAdmin');
  });

  it('keeps the server text for a refusal without a known code', () => {
    assert.equal(adminUserErrorText(new Error('Cannot change your own account this way'), t), 'Cannot change your own account this way');
  });

  it('says the action failed when there is no text at all', () => {
    assert.equal(adminUserErrorText(new Error(''), t), 't:admin.users.errorFailed');
    assert.equal(adminUserErrorText(undefined, t), 't:admin.users.errorFailed');
  });
});
