import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_APP_SCOPES,
  canDeleteGoogleApp,
  googleAppErrorKey,
  googleAppForm,
  googleAppFormError,
  googleAppGmailApiWarningKey,
  googleAppPayload,
  googleAppSeatsText,
  googleAppState,
  googleAppStateKey,
  googleAppStatusActions,
  googleAppWarningKey,
  googleCallbackAltUri,
  googleCallbackFormError,
  parseGoogleClientJsonPreview,
  shortClientId,
} from './googleApps.js';

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const APP = {
  id: 'a1', label: 'Google 1', clientId: CLIENT_ID, projectNumber: '123456789012', userLimit: 100,
  status: 'active', grantsCount: 40, reservedCount: 2, accountsCount: 38, full: false, createdAt: '2026-09-21T00:00:00.000Z',
};

describe('googleAppState', () => {
  it('shows a full active app as its own state and keeps the stored ones', () => {
    assert.equal(googleAppState(APP), 'active');
    assert.equal(googleAppState({ ...APP, full: true }), 'full');
    assert.equal(googleAppState({ ...APP, status: 'closed', full: false }), 'closed');
    assert.equal(googleAppState({ ...APP, status: 'disabled' }), 'disabled');
  });

  it('only an active app is ever full', () => {
    assert.equal(googleAppState({ ...APP, status: 'closed', full: true }), 'closed');
  });

  it('is null for an unknown status', () => {
    assert.equal(googleAppState({ ...APP, status: 'weird' }), null);
    assert.equal(googleAppState(null), null);
    assert.equal(googleAppStateKey({ ...APP, status: 'weird' }), null);
  });

  it('maps each state to a key', () => {
    assert.equal(googleAppStateKey(APP), 'admin.integrations.googleApps.stateActive');
    assert.equal(googleAppStateKey({ ...APP, full: true }), 'admin.integrations.googleApps.stateFull');
    assert.equal(googleAppStateKey({ ...APP, status: 'closed' }), 'admin.integrations.googleApps.stateClosed');
    assert.equal(googleAppStateKey({ ...APP, status: 'disabled' }), 'admin.integrations.googleApps.stateDisabled');
  });
});

describe('shortClientId', () => {
  it('keeps the project number and the start of the client hash', () => {
    assert.equal(shortClientId(CLIENT_ID), '123456789012-abc123…');
    assert.equal(shortClientId('1-a.apps.googleusercontent.com'), '1-a…');
  });

  it('cuts anything else to 24 characters', () => {
    assert.equal(shortClientId('short'), 'short');
    assert.equal(shortClientId('x'.repeat(30)), `${'x'.repeat(24)}…`);
    assert.equal(shortClientId(null), '');
  });
});

describe('googleAppSeatsText', () => {
  it('counts the journal and the live reservations against the limit', () => {
    assert.equal(googleAppSeatsText(APP), '42 / 100');
    assert.equal(googleAppSeatsText({ ...APP, grantsCount: undefined, reservedCount: undefined }), '0 / 100');
  });
});

describe('googleAppStatusActions', () => {
  it('offers the two other states and asks to confirm only disabling', () => {
    assert.deepEqual(googleAppStatusActions(APP), [
      { status: 'closed', labelKey: 'admin.integrations.googleApps.close', confirm: false },
      { status: 'disabled', labelKey: 'admin.integrations.googleApps.disable', confirm: true },
    ]);
    assert.deepEqual(googleAppStatusActions({ ...APP, status: 'disabled' }).map((a) => a.status), ['active', 'closed']);
    assert.deepEqual(googleAppStatusActions({ ...APP, status: 'closed' }).map((a) => a.status), ['active', 'disabled']);
  });

  it('keeps offering the other states for a full app', () => {
    assert.deepEqual(googleAppStatusActions({ ...APP, full: true }).map((a) => a.status), ['closed', 'disabled']);
  });
});

describe('canDeleteGoogleApp', () => {
  it('allows deleting only an app without mailboxes', () => {
    assert.equal(canDeleteGoogleApp(APP), false);
    assert.equal(canDeleteGoogleApp({ ...APP, accountsCount: 0 }), true);
  });
});

describe('googleAppForm', () => {
  it('starts a new app with the default limit', () => {
    assert.deepEqual(googleAppForm(null), { label: '', clientId: '', clientSecret: '', clientJson: '', userLimit: '100' });
  });

  it('fills an edit form from the app and never from a secret', () => {
    assert.deepEqual(googleAppForm(APP), { label: 'Google 1', clientId: CLIENT_ID, clientSecret: '', clientJson: '', userLimit: '100' });
  });
});

describe('parseGoogleClientJsonPreview', () => {
  const WEB_JSON = JSON.stringify({
    web: { client_id: CLIENT_ID, client_secret: 'GOCSPX-x', project_id: 'my-project-123' },
  });

  it('reads the client id and project id of a web client', () => {
    assert.deepEqual(parseGoogleClientJsonPreview(WEB_JSON), { ok: true, clientId: CLIENT_ID, projectId: 'my-project-123' });
  });

  it('rejects malformed JSON, empty input and the wrong top-level type', () => {
    for (const bad of ['', '  ', 'not json', '[]', '42', null, undefined]) {
      assert.equal(parseGoogleClientJsonPreview(bad).errorKey, 'admin.integrations.googleApps.errorClientJsonInvalid', String(bad));
    }
  });

  it('rejects a service account key', () => {
    const json = JSON.stringify({ type: 'service_account' });
    assert.equal(parseGoogleClientJsonPreview(json).errorKey, 'admin.integrations.googleApps.errorClientJsonServiceAccount');
  });

  it('rejects a desktop client or anything without a web client', () => {
    assert.equal(
      parseGoogleClientJsonPreview(JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } })).errorKey,
      'admin.integrations.googleApps.errorClientJsonNotWeb',
    );
    assert.equal(parseGoogleClientJsonPreview('{}').errorKey, 'admin.integrations.googleApps.errorClientJsonNotWeb');
  });

  it('rejects a web client missing the id or the secret', () => {
    assert.equal(
      parseGoogleClientJsonPreview(JSON.stringify({ web: { client_id: CLIENT_ID } })).errorKey,
      'admin.integrations.googleApps.errorClientJsonIncomplete',
    );
    assert.equal(
      parseGoogleClientJsonPreview(JSON.stringify({ web: { client_secret: 'y' } })).errorKey,
      'admin.integrations.googleApps.errorClientJsonIncomplete',
    );
  });
});

describe('googleAppFormError', () => {
  const form = { label: 'Google 2', clientId: CLIENT_ID, clientSecret: 'GOCSPX-x', userLimit: '100' };

  it('accepts a complete new app', () => {
    assert.equal(googleAppFormError(form, { editing: false }), null);
    assert.equal(googleAppFormError({ ...form, clientId: ` ${CLIENT_ID} ` }, { editing: false }), null);
  });

  it('names the first problem of a new app', () => {
    assert.equal(googleAppFormError({ ...form, label: '  ' }, { editing: false }), 'admin.integrations.googleApps.errorLabelInvalid');
    assert.equal(googleAppFormError({ ...form, label: 'x'.repeat(101) }, { editing: false }), 'admin.integrations.googleApps.errorLabelInvalid');
    assert.equal(googleAppFormError({ ...form, clientId: 'abc' }, { editing: false }), 'admin.integrations.googleApps.errorClientIdInvalid');
    assert.equal(googleAppFormError({ ...form, clientSecret: ' ' }, { editing: false }), 'admin.integrations.googleApps.errorClientSecretRequired');
    assert.equal(googleAppFormError({ ...form, clientSecret: '••••••••' }, { editing: false }), 'admin.integrations.googleApps.errorClientSecretRedacted');
    for (const userLimit of ['', '0', '-1', '1.5', 'abc', '2147483648']) {
      assert.equal(googleAppFormError({ ...form, userLimit }, { editing: false }), 'admin.integrations.googleApps.errorUserLimitInvalid', userLimit);
    }
  });

  it('lets an edit keep the stored secret and ignores the fixed client ID', () => {
    assert.equal(googleAppFormError({ ...form, clientId: 'abc', clientSecret: '' }, { editing: true }), null);
    assert.equal(googleAppFormError({ ...form, clientSecret: 'x•' }, { editing: true }), 'admin.integrations.googleApps.errorClientSecretRedacted');
  });

  it('accepts a new app from an imported client JSON and skips the clientId/secret checks', () => {
    const clientJson = JSON.stringify({ web: { client_id: 'x', client_secret: 'y', project_id: 'p' } });
    assert.equal(googleAppFormError({ ...form, clientId: '', clientSecret: '', clientJson }, { editing: false }), null);
  });

  it('names the client JSON problem when it is not importable', () => {
    assert.equal(
      googleAppFormError({ ...form, clientJson: JSON.stringify({ type: 'service_account' }) }, { editing: false }),
      'admin.integrations.googleApps.errorClientJsonServiceAccount',
    );
    assert.equal(
      googleAppFormError({ ...form, clientJson: 'not json' }, { editing: false }),
      'admin.integrations.googleApps.errorClientJsonInvalid',
    );
  });

  it('ignores clientJson on an edit: the clientId/secret rules apply as usual', () => {
    const clientJson = JSON.stringify({ type: 'service_account' });
    assert.equal(googleAppFormError({ ...form, clientId: 'abc', clientSecret: '', clientJson }, { editing: true }), null);
  });
});

describe('googleAppPayload', () => {
  const form = { label: ' Google 2 ', clientId: ` ${CLIENT_ID} `, clientSecret: ' GOCSPX-x ', userLimit: ' 50 ' };

  it('sends every field of a new app, trimmed, with a numeric limit', () => {
    assert.deepEqual(googleAppPayload(form, { editing: false }), {
      label: 'Google 2', clientId: CLIENT_ID, clientSecret: 'GOCSPX-x', userLimit: 50,
    });
  });

  it('never sends the client ID of an edited app and leaves a blank secret out', () => {
    assert.deepEqual(googleAppPayload(form, { editing: true }), { label: 'Google 2', userLimit: 50, clientSecret: 'GOCSPX-x' });
    assert.deepEqual(googleAppPayload({ ...form, clientSecret: '  ' }, { editing: true }), { label: 'Google 2', userLimit: 50 });
  });

  it('sends clientJson instead of clientId/clientSecret for an imported new app', () => {
    const clientJson = JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } });
    assert.deepEqual(googleAppPayload({ ...form, clientJson }, { editing: false }), {
      label: 'Google 2', userLimit: 50, clientJson,
    });
  });

  it('ignores clientJson on an edit', () => {
    const clientJson = JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } });
    assert.deepEqual(googleAppPayload({ ...form, clientJson }, { editing: true }), { label: 'Google 2', userLimit: 50, clientSecret: 'GOCSPX-x' });
  });
});

describe('googleAppWarningKey', () => {
  it('maps the warning codes the server can send and nothing else', () => {
    assert.equal(googleAppWarningKey('redirect_uri_missing'), 'admin.integrations.googleApps.warningRedirectUriMissing');
    assert.equal(googleAppWarningKey('callback_not_configured'), 'admin.integrations.googleApps.warningCallbackNotConfigured');
    for (const code of [undefined, null, '', 'toString', '__proto__', 'other']) assert.equal(googleAppWarningKey(code), null);
  });
});

describe('googleAppGmailApiWarningKey', () => {
  it('warns only when the app has gmailApiDisabledAt set', () => {
    assert.equal(
      googleAppGmailApiWarningKey({ ...APP, gmailApiDisabledAt: '2026-09-27T00:00:00.000Z' }),
      'admin.integrations.googleApps.gmailApiDisabledWarning',
    );
    assert.equal(googleAppGmailApiWarningKey({ ...APP, gmailApiDisabledAt: null }), null);
    assert.equal(googleAppGmailApiWarningKey(APP), null);
    assert.equal(googleAppGmailApiWarningKey(undefined), null);
  });
});

describe('googleAppErrorKey', () => {
  it('maps every admin API code and nothing else', () => {
    const codes = {
      label_invalid: 'admin.integrations.googleApps.errorLabelInvalid',
      client_id_invalid: 'admin.integrations.googleApps.errorClientIdInvalid',
      client_secret_required: 'admin.integrations.googleApps.errorClientSecretRequired',
      client_secret_redacted: 'admin.integrations.googleApps.errorClientSecretRedacted',
      user_limit_invalid: 'admin.integrations.googleApps.errorUserLimitInvalid',
      app_status_invalid: 'admin.integrations.googleApps.errorStatusInvalid',
      app_exists: 'admin.integrations.googleApps.errorAppExists',
      app_same_project: 'admin.integrations.googleApps.errorSameProject',
      app_in_use: 'admin.integrations.googleApps.errorInUse',
      app_not_found: 'admin.integrations.googleApps.errorNotFound',
      redirect_uri_invalid: 'admin.integrations.googleApps.errorCallbackInvalid',
    };
    for (const [code, key] of Object.entries(codes)) assert.equal(googleAppErrorKey(code), key, code);
    for (const code of [undefined, null, '', 'toString', '__proto__', 'other']) assert.equal(googleAppErrorKey(code), null);
  });
});

describe('googleCallbackFormError', () => {
  it('accepts only an absolute http(s) address', () => {
    assert.equal(googleCallbackFormError('https://mail.example.com/oauth/google/callback'), null);
    assert.equal(googleCallbackFormError(' http://localhost:8080/oauth/google/callback '), null);
    for (const value of ['', '  ', '/oauth/google/callback', 'mail.example.com', 'ftp://x/cb', 'javascript:alert(1)']) {
      assert.equal(googleCallbackFormError(value), 'admin.integrations.googleApps.errorCallbackInvalid', value);
    }
  });
});

describe('googleCallbackAltUri', () => {
  const configured = 'https://mail.example.com/oauth/google/callback';

  it('is null when the panel is open on the configured host', () => {
    assert.equal(googleCallbackAltUri(configured, 'https://mail.example.com'), null);
    assert.equal(googleCallbackAltUri(configured, 'https://mail.example.com/'), null);
  });

  it('names the callback of the host the panel is open on', () => {
    assert.equal(googleCallbackAltUri(configured, 'https://alt.example.net'), 'https://alt.example.net/oauth/google/callback');
  });

  it('is null without a usable configured callback', () => {
    assert.equal(googleCallbackAltUri('', 'https://alt.example.net'), null);
    assert.equal(googleCallbackAltUri('not a url', 'https://alt.example.net'), null);
    assert.equal(googleCallbackAltUri(configured, ''), null);
  });
});

describe('GOOGLE_APP_SCOPES', () => {
  it('lists the scopes the consent screen needs', () => {
    assert.equal(GOOGLE_APP_SCOPES, 'openid email profile https://mail.google.com/');
  });
});
