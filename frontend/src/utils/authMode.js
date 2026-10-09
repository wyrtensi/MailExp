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

// Translation key for an ?auth_error= code, or null when there is none.
export function signInErrorKey(code) {
  if (typeof code !== 'string' || !code) return null;
  return ERROR_KEYS[code] || 'login.google.errorGeneric';
}
