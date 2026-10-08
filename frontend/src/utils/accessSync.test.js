import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessSyncForm, accessSyncFormError, accessSyncIdleKey, accessSyncPayload, accessSyncRunNotes, accessSyncRunSummary,
  accessSyncSaveErrorKey, accessSyncVerifyLine, accessSyncVerifyPayload, tombstoneReasonKey,
} from './accessSync.js';

describe('tombstoneReasonKey', () => {
  it('names a deleted user and a replaced email, and treats anything else as deleted', () => {
    assert.equal(tombstoneReasonKey('deleted'), 'admin.accessSync.tombstoneReasonDeleted');
    assert.equal(tombstoneReasonKey('email_changed'), 'admin.accessSync.tombstoneReasonEmailChanged');
    assert.equal(tombstoneReasonKey(undefined), 'admin.accessSync.tombstoneReasonDeleted');
  });
});

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';

describe('accessSyncForm', () => {
  it('fills the form from the settings and never from a token', () => {
    assert.deepEqual(accessSyncForm(null), { enabled: false, accountId: '', appId: '', policyId: '', apiToken: '' });
    assert.deepEqual(
      accessSyncForm({ enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiTokenSet: true }),
      { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: '' },
    );
  });
});

describe('accessSyncFormError', () => {
  const form = { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: '' };

  it('accepts complete settings with a stored or a new token', () => {
    assert.equal(accessSyncFormError(form, true), null);
    assert.equal(accessSyncFormError({ ...form, apiToken: 'tok' }, false), null);
    assert.equal(accessSyncFormError({ ...form, accountId: ` ${ACCOUNT.toUpperCase()} ` }, true), null);
  });

  it('names malformed ids and incomplete settings while the sync is on', () => {
    assert.equal(accessSyncFormError({ ...form, accountId: 'abc' }, true), 'admin.accessSync.errorInvalidId');
    assert.equal(accessSyncFormError({ ...form, policyId: 'not-a-uuid' }, true), 'admin.accessSync.errorInvalidId');
    assert.equal(accessSyncFormError(form, false), 'admin.accessSync.errorIncomplete');
    assert.equal(accessSyncFormError({ ...form, appId: '' }, true), 'admin.accessSync.errorIncomplete');
    assert.equal(accessSyncFormError({ ...form, enabled: false, appId: '' }, false), null);
  });
});

describe('accessSyncPayload', () => {
  it('trims the fields and leaves a blank token out so the stored one is kept', () => {
    assert.deepEqual(
      accessSyncPayload({ enabled: true, accountId: ` ${ACCOUNT} `, appId: APP, policyId: POLICY, apiToken: '  ' }),
      { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY },
    );
    assert.equal(accessSyncPayload({ enabled: true, accountId: '', appId: '', policyId: '', apiToken: ' tok ' }).apiToken, 'tok');
  });
});

describe('accessSyncSaveErrorKey', () => {
  it('translates the codes the server gives for invalid settings', () => {
    assert.equal(accessSyncSaveErrorKey('invalid_id'), 'admin.accessSync.errorInvalidId');
    assert.equal(accessSyncSaveErrorKey('incomplete'), 'admin.accessSync.errorIncomplete');
    assert.equal(accessSyncSaveErrorKey('invalid_field'), null);
    assert.equal(accessSyncSaveErrorKey(undefined), null);
  });
});

describe('accessSyncRunSummary', () => {
  const run = { trigger: 'schedule', outcome: 'updated', added: 2, removed: 1, disabled: 0, wouldDisable: 0, error: null };

  it('describes each outcome with its counts', () => {
    assert.equal(accessSyncRunSummary(null, 10), null);
    assert.deepEqual(accessSyncRunSummary(run, 10), {
      key: 'admin.accessSync.outcomeUpdated',
      values: { added: 2, removed: 1, imported: 0, disabled: 0, wouldDisable: 0, wouldImport: 0, max: 10, error: '' },
      errorKey: null,
    });
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'unchanged' }, 10).key, 'admin.accessSync.outcomeUnchanged');
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'aborted', wouldDisable: 12 }, 10).values.wouldDisable, 12);
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'aborted', wouldImport: 30 }, 10).values.wouldImport, 30);
    assert.equal(accessSyncRunSummary({ ...run, imported: 3 }, 10).values.imported, 3);
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'empty' }, 10).key, 'admin.accessSync.outcomeEmpty');
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'surprise' }, 10), null);
  });

  it('translates the errors the server names and passes Cloudflare status text through', () => {
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'failed', error: 'token_unreadable' }, 10).errorKey, 'admin.accessSync.errorTokenUnreadable');
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'failed', error: 'policy_not_allow' }, 10).errorKey, 'admin.accessSync.errorPolicyNotAllow');
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'failed', error: 'policy_not_attached' }, 10).errorKey, 'admin.accessSync.errorNotAttached');
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'failed', error: 'internal_error' }, 10).errorKey, 'admin.accessSync.errorInternal');
    const cloudflare = accessSyncRunSummary({ ...run, outcome: 'failed', error: 'Cloudflare getPolicy failed (403): error 10000' }, 10);
    assert.equal(cloudflare.key, 'admin.accessSync.outcomeFailed');
    assert.equal(cloudflare.errorKey, null);
    assert.equal(cloudflare.values.error, 'Cloudflare getPolicy failed (403): error 10000');
  });
});

describe('accessSyncIdleKey', () => {
  it('explains a manual run that did nothing', () => {
    assert.equal(accessSyncIdleKey({ outcome: 'not_configured' }), 'admin.accessSync.notConfigured');
    assert.equal(accessSyncIdleKey({ outcome: 'not_google_mode' }), 'admin.accessSync.notGoogleMode');
    assert.equal(accessSyncIdleKey({ outcome: 'updated' }), null);
    assert.equal(accessSyncIdleKey(undefined), null);
  });
});

describe('accessSyncRunNotes', () => {
  it('names import errors and the next retry, or that the retries ran out', () => {
    assert.deepEqual(accessSyncRunNotes(null), []);
    assert.deepEqual(accessSyncRunNotes({ outcome: 'updated', errors: 0 }), []);
    assert.deepEqual(accessSyncRunNotes({ outcome: 'updated', errors: 2 }), [
      { key: 'admin.accessSync.importErrors', values: { count: 2 } },
    ]);
    assert.deepEqual(
      accessSyncRunNotes({ outcome: 'failed', retriable: true, retryAttempt: 2, nextRetryAt: '2026-10-09T10:05:00.000Z' }, (iso) => `at ${iso}`),
      [{ key: 'admin.accessSync.nextRetry', values: { time: 'at 2026-10-09T10:05:00.000Z', attempt: 2 } }],
    );
    assert.deepEqual(accessSyncRunNotes({ outcome: 'failed', retriable: true, nextRetryAt: null }), [
      { key: 'admin.accessSync.retriesExhausted', values: {} },
    ]);
    assert.deepEqual(accessSyncRunNotes({ outcome: 'failed', retriable: false }), []);
  });
});

describe('accessSyncVerifyPayload', () => {
  it('sends only what the form fills in, so the rest comes from the stored settings', () => {
    assert.deepEqual(accessSyncVerifyPayload({ enabled: true, accountId: ' ', appId: APP, policyId: '', apiToken: '' }), { appId: APP });
    assert.deepEqual(
      accessSyncVerifyPayload({ enabled: false, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: ' tok ' }),
      { accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'tok' },
    );
  });
});

describe('accessSyncVerifyLine', () => {
  it('labels each check and turns its code into a sentence key', () => {
    assert.deepEqual(accessSyncVerifyLine({ id: 'token', status: 'ok', code: 'active', expiresOn: null }), {
      labelKey: 'admin.accessSync.verifyToken', key: 'admin.accessSync.checkTokenOk', values: {}, status: 'ok',
    });
    assert.equal(accessSyncVerifyLine({ id: 'token', status: 'ok', code: 'active', expiresOn: '2027-01-01T00:00:00Z' }).key, 'admin.accessSync.checkTokenOkExpires');
    assert.deepEqual(accessSyncVerifyLine({ id: 'app', status: 'ok', code: 'found', name: 'MailExpert' }).values, { name: 'MailExpert' });
    assert.equal(accessSyncVerifyLine({ id: 'audience', status: 'failed', code: 'mismatch' }).key, 'admin.accessSync.checkAudienceMismatch');
    assert.equal(accessSyncVerifyLine({ id: 'policy', status: 'ok', code: 'found', reusable: true }).key, 'admin.accessSync.checkPolicyOkReusable');
    assert.equal(accessSyncVerifyLine({ id: 'policy', status: 'failed', code: 'not_attached' }).key, 'admin.accessSync.checkNotAttached');
    assert.equal(accessSyncVerifyLine({ id: 'app', status: 'failed', code: 'forbidden' }).key, 'admin.accessSync.checkForbidden');
    assert.equal(accessSyncVerifyLine({ id: 'app', status: 'failed', code: 'not_found' }).key, 'admin.accessSync.checkAppNotFound');
    assert.equal(accessSyncVerifyLine({ id: 'policy', status: 'failed', code: 'not_found' }).key, 'admin.accessSync.checkPolicyNotFound');
    assert.equal(accessSyncVerifyLine({ id: 'policy', status: 'skipped', code: 'no_policy_id' }).key, 'admin.accessSync.checkNoPolicyId');
  });

  it('shows an unknown code as it is', () => {
    assert.deepEqual(accessSyncVerifyLine({ id: 'token', status: 'failed', code: 'token_weird' }), {
      labelKey: 'admin.accessSync.verifyToken', key: null, values: {}, status: 'failed', raw: 'token_weird',
    });
  });
});

describe('verify refusals', () => {
  it('names the codes the verify endpoint refuses with', () => {
    assert.equal(accessSyncSaveErrorKey('verify_incomplete'), 'admin.accessSync.errorVerifyIncomplete');
    assert.equal(accessSyncSaveErrorKey('token_invalid'), 'admin.accessSync.errorTokenInvalid');
    assert.equal(accessSyncSaveErrorKey('token_undecryptable'), 'admin.accessSync.errorTokenUnreadableVerify');
  });
});
