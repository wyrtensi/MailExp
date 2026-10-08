// The stable `code` of an API refusal as a translation key, for the screens that have no mapping
// of their own (rules, block list, contacts, Todoist, drafts, the account form). Pure: runs under
// `node --test`. An answer without a code (an older backend) keeps its own text.

import { isMailboxBusy, mailboxBusyText } from './mailboxBusy.js';

// Spelled out literally so the i18n coverage test finds them. A code whose meaning depends on the
// route (not_found) is left to the screen's own `keys`.
const ERROR_KEYS = {
  // Any route (backend middleware/errorHandlers.js, utils/uuid.js).
  invalid_id: 'common.apiError.invalidId',
  invalid_json: 'common.apiError.invalidJson',
  request_too_large: 'common.apiError.requestTooLarge',
  internal_error: 'common.apiError.internalError',
  // A mailbox named by a request (utils/requireMailbox.js, rules, block list, drafts).
  invalid_account: 'common.apiError.invalidAccount',
  account_not_found: 'common.apiError.accountNotFound',
  account_required: 'common.apiError.accountRequired',
  // Rules (services/rules/ruleActions.js RULE_ERRORS).
  not_arrays: 'admin.rules.errorInvalid',
  invalid_condition: 'admin.rules.errorInvalidCondition',
  invalid_action: 'admin.rules.errorInvalidAction',
  move_folder_not_found: 'admin.rules.errorMoveFolderNotFound',
  already_running: 'admin.rules.errorAlreadyRunning',
  // Contacts (routes/contacts.js).
  contact_not_found: 'contacts.errorNotFound',
  contact_exists: 'contacts.errorExists',
  contact_name_required: 'contacts.errorNameRequired',
  invalid_contact_url: 'contacts.errorInvalidUrl',
  invalid_contact_field: 'contacts.errorInvalidField',
  // Todoist (routes/todoist.js).
  todoist_not_connected: 'todoist.errorNotConnected',
  todoist_token_required: 'todoist.errorTokenRequired',
  todoist_token_invalid: 'todoist.errorTokenInvalid',
  todoist_unavailable: 'todoist.errorUnavailable',
  todoist_task_title_required: 'todoist.errorTitleRequired',
  todoist_failed: 'todoist.errorFailed',
  // Drafts and message bodies (routes/draft.js, routes/mail.js).
  draft_save_failed: 'compose.draftSaveFailedBody',
  draft_delete_failed: 'common.apiError.draftDeleteFailed',
  body_fetch_failed: 'message.bodyFetchFailed',
  // A mailbox's own settings (routes/accounts.js).
  connection_admin_only: 'admin.accounts.errorConnectionAdminOnly',
  mailbox_disabled: 'common.mailboxDisabled',
  oauth_mailbox_not_found: 'admin.accounts.errorOAuthMailboxNotFound',
};

// The codes this module explains (for the locale coverage test).
export const API_ERROR_CODES = Object.freeze(Object.keys(ERROR_KEYS));

// `keys` is the screen's own { code: key } (checked first).
export function apiErrorKey(code, keys = {}) {
  if (typeof code !== 'string') return null;
  if (Object.hasOwn(keys, code)) return keys[code];
  return Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : null;
}

// What to show for a failed request: the code explained, the busy mailbox text, else the server's
// text, else `fallback`, else that the request failed.
export function apiErrorText(err, t, { keys, fallback } = {}) {
  const key = apiErrorKey(err?.code, keys);
  if (key) return t(key);
  if (isMailboxBusy(err)) return mailboxBusyText(err, t);
  return err?.message || fallback || t('common.actionFailed.body');
}
