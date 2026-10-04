// Microsoft (Outlook / Microsoft 365) OAuth helpers. Pure functions, unit-tested with `node --test`.
//
// The backend (routes/oauth.js) redirects the callback to
//   /?oauth_success=microsoft
//   /?oauth_error=<code>&oauth_provider=microsoft
// and the device-code poll answers { status: 'error', code } with the same codes. The values are
// never rendered: each code maps to a fixed i18n key.

export const MICROSOFT_OAUTH_PATH = '/oauth/microsoft';

// Keys spelled out literally so the i18n source-coverage test can find them.
const MICROSOFT_ERROR_KEYS = {
  access_denied: 'admin.integrations.microsoft.errorAccessDenied',
  invalid_state: 'admin.integrations.microsoft.errorInvalidState',
  not_configured: 'admin.integrations.microsoft.errorNotConfigured',
  email_not_verified: 'admin.integrations.microsoft.errorEmailNotVerified',
  authentication_failed: 'admin.integrations.microsoft.errorAuthenticationFailed',
  already_connected: 'admin.integrations.microsoft.errorAlreadyConnected',
  account_mismatch: 'admin.integrations.microsoft.errorAccountMismatch',
};
const MICROSOFT_ERROR_FALLBACK_KEY = 'admin.integrations.microsoft.errorAuthenticationFailed';

export function microsoftOAuthErrorKey(code) {
  return typeof code === 'string' && Object.hasOwn(MICROSOFT_ERROR_KEYS, code)
    ? MICROSOFT_ERROR_KEYS[code]
    : MICROSOFT_ERROR_FALLBACK_KEY;
}

// Same-origin URL that reconnects one Microsoft mailbox: the server renews only that mailbox, and
// only when the Microsoft account signed in is the one it belongs to. Without an id, the flow adds
// a mailbox instead.
export function buildMicrosoftReconnectUrl(accountId) {
  const id = typeof accountId === 'string' ? accountId.trim() : '';
  if (!id) return null;
  return `${MICROSOFT_OAUTH_PATH}?${new URLSearchParams({ account: id }).toString()}`;
}
