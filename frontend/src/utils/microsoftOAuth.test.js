import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MICROSOFT_OAUTH_PATH, buildMicrosoftReconnectUrl, microsoftDeviceReconnectTarget, microsoftOAuthErrorKey,
} from './microsoftOAuth.js';

describe('microsoftOAuthErrorKey', () => {
  it('maps every stable code to its own key', () => {
    assert.equal(microsoftOAuthErrorKey('email_not_verified'), 'admin.integrations.microsoft.errorEmailNotVerified');
    assert.equal(microsoftOAuthErrorKey('already_connected'), 'admin.integrations.microsoft.errorAlreadyConnected');
    assert.equal(microsoftOAuthErrorKey('account_mismatch'), 'admin.integrations.microsoft.errorAccountMismatch');
    assert.equal(microsoftOAuthErrorKey('invalid_state'), 'admin.integrations.microsoft.errorInvalidState');
    assert.equal(microsoftOAuthErrorKey('access_denied'), 'admin.integrations.microsoft.errorAccessDenied');
    assert.equal(microsoftOAuthErrorKey('not_configured'), 'admin.integrations.microsoft.errorNotConfigured');
    assert.equal(microsoftOAuthErrorKey('admin_required'), 'admin.integrations.microsoft.errorAdminRequired');
  });

  it('falls back for anything else, inherited names included', () => {
    for (const code of ['Authentication failed', '__proto__', 'toString', '', null, undefined]) {
      assert.equal(microsoftOAuthErrorKey(code), 'admin.integrations.microsoft.errorAuthenticationFailed');
    }
  });
});

describe('microsoftDeviceReconnectTarget', () => {
  const base = { type: 'oauth_error', provider: 'microsoft', error: 'redirect_not_configured', account: 'acc-1' };

  it('names the mailbox when only the device-code flow is set up', () => {
    assert.equal(microsoftDeviceReconnectTarget(base), 'acc-1');
    assert.equal(microsoftOAuthErrorKey('redirect_not_configured'), 'admin.integrations.microsoft.errorRedirectNotConfigured');
  });

  it('is null for any other result', () => {
    for (const data of [
      null, 'x', { ...base, account: '' }, { ...base, account: undefined }, { ...base, provider: 'google' },
      { ...base, error: 'access_denied' }, { ...base, type: 'oauth_success' },
    ]) {
      assert.equal(microsoftDeviceReconnectTarget(data), null);
    }
  });
});

describe('buildMicrosoftReconnectUrl', () => {
  it('names the mailbox to reconnect', () => {
    assert.equal(buildMicrosoftReconnectUrl('acc-1'), '/oauth/microsoft?account=acc-1');
    assert.equal(MICROSOFT_OAUTH_PATH, '/oauth/microsoft');
  });

  it('is null without an id', () => {
    assert.equal(buildMicrosoftReconnectUrl(''), null);
    assert.equal(buildMicrosoftReconnectUrl(undefined), null);
  });
});
