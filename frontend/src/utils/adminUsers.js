// The admin users screens (UsersAndInvitesPanel in AdminPanel.jsx, GoogleUsersPanel.jsx): the
// refusal codes of /api/admin/users as translation keys. Pure functions, run under `node --test`.

import { apiErrorText } from './apiErrors.js';

// Backend services/admin/users.js ADMIN_USER_ERRORS. Spelled out literally so the i18n coverage
// test finds them.
const ERROR_KEYS = {
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

export function adminUserErrorKey(code) {
  return typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : null;
}

// What to show for a failed users action: the code explained (a users code, then one any route
// answers, such as invalid_id), else the server's own text (a route that answers no code), else
// that the action failed.
export function adminUserErrorText(err, t) {
  const key = adminUserErrorKey(err?.code);
  if (key) return t(key);
  return apiErrorText(err, t, { fallback: t('admin.users.errorFailed') });
}
