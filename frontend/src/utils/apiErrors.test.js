// Run with: node --test src/utils/apiErrors.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorKey, apiErrorText } from './apiErrors.js';

const t = (key) => `t:${key}`;
const refusal = (message, code) => Object.assign(new Error(message), code ? { code } : {});

describe('apiErrorKey', () => {
  it('maps the codes the API answers across screens', () => {
    const codes = {
      // backend middleware/errorHandlers.js, utils/uuid.js
      invalid_id: 'common.apiError.invalidId',
      invalid_json: 'common.apiError.invalidJson',
      request_too_large: 'common.apiError.requestTooLarge',
      internal_error: 'common.apiError.internalError',
      // a mailbox reference (utils/requireMailbox.js)
      invalid_account: 'common.apiError.invalidAccount',
      account_not_found: 'common.apiError.accountNotFound',
      account_required: 'common.apiError.accountRequired',
      // rules (services/rules/ruleActions.js RULE_ERRORS)
      not_arrays: 'admin.rules.errorInvalid',
      invalid_condition: 'admin.rules.errorInvalidCondition',
      invalid_action: 'admin.rules.errorInvalidAction',
      move_folder_not_found: 'admin.rules.errorMoveFolderNotFound',
      already_running: 'admin.rules.errorAlreadyRunning',
      // contacts (routes/contacts.js)
      contact_not_found: 'contacts.errorNotFound',
      contact_exists: 'contacts.errorExists',
      contact_name_required: 'contacts.errorNameRequired',
      invalid_contact_url: 'contacts.errorInvalidUrl',
      invalid_contact_field: 'contacts.errorInvalidField',
      // Todoist (routes/todoist.js)
      todoist_not_connected: 'todoist.errorNotConnected',
      todoist_token_required: 'todoist.errorTokenRequired',
      todoist_token_invalid: 'todoist.errorTokenInvalid',
      todoist_unavailable: 'todoist.errorUnavailable',
      todoist_task_title_required: 'todoist.errorTitleRequired',
      todoist_failed: 'todoist.errorFailed',
      // drafts and message bodies (routes/draft.js, routes/mail.js)
      draft_save_failed: 'compose.draftSaveFailedBody',
      draft_delete_failed: 'common.apiError.draftDeleteFailed',
      body_fetch_failed: 'message.bodyFetchFailed',
      // a mailbox (routes/accounts.js)
      connection_admin_only: 'admin.accounts.errorConnectionAdminOnly',
      mailbox_disabled: 'common.mailboxDisabled',
      oauth_mailbox_not_found: 'admin.accounts.errorOAuthMailboxNotFound',
    };
    for (const [code, key] of Object.entries(codes)) assert.equal(apiErrorKey(code), key, code);
    for (const code of [undefined, null, '', 'toString', '__proto__', 'not_found', 'other']) assert.equal(apiErrorKey(code), null, String(code));
  });

  it('takes a screen\'s own meaning of a code first', () => {
    assert.equal(apiErrorKey('not_found', { not_found: 'admin.rules.errorNotFound' }), 'admin.rules.errorNotFound');
    assert.equal(apiErrorKey('invalid_id', { invalid_id: 'x.y' }), 'x.y');
  });
});

describe('apiErrorText', () => {
  it('explains a known code', () => {
    assert.equal(apiErrorText(refusal('Contact not found', 'contact_not_found'), t), 't:contacts.errorNotFound');
  });

  it('says a busy mailbox is busy', () => {
    assert.equal(apiErrorText(refusal('busy', 'mailbox_busy'), t), 't:common.mailboxBusy');
  });

  it('keeps the server text when there is no code (an older backend)', () => {
    assert.equal(apiErrorText(refusal('Rule not found'), t), 'Rule not found');
    assert.equal(apiErrorText(refusal('Rule not found', 'not_found'), t), 'Rule not found');
  });

  it('falls back to the given text, then to a generic one', () => {
    assert.equal(apiErrorText(refusal(''), t, { fallback: 'saved?' }), 'saved?');
    assert.equal(apiErrorText(undefined, t), 't:common.actionFailed.body');
  });
});
