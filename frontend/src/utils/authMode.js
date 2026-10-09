// Sign-in mode helpers shared by the login screen and the admin panel.
export const SIGN_IN_PATH = '/oauth/login/google';

export function isGoogleAuthMode(value) {
  return value?.authMode === 'google' || value?.mode === 'google';
}

const ERROR_KEYS = {
  not_allowed: 'login.google.errorNotAllowed',
  user_disabled: 'login.google.errorDisabled',
  user_deleted: 'login.google.errorDeleted',
  email_not_verified: 'login.google.errorEmailNotVerified',
  locked: 'login.google.errorLocked',
};

// Codes the identity gate answers a refused Access user with (HTTP 403 {error, code}).
const ACCESS_REFUSAL_CODES = new Set(['not_allowed', 'user_disabled', 'user_deleted']);

// The refusal code of a failed API call, or null when it is not an access refusal.
export function accessRefusalCode(err) {
  if (err?.status !== 403) return null;
  return ACCESS_REFUSAL_CODES.has(err.code) ? err.code : null;
}

// Translation key for an ?auth_error= code, or null when there is none.
export function signInErrorKey(code) {
  if (typeof code !== 'string' || !code) return null;
  return ERROR_KEYS[code] || 'login.google.errorGeneric';
}
