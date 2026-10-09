// The refusal codes of the admin routes (backend routes/admin.js) as translation keys, one map per
// screen: a code such as not_found or fields_required means something else on each. Passed as
// `keys` to apiErrorText (utils/apiErrors.js), which keeps the server's text when there is no code.
// Spelled out literally so the i18n coverage test finds them. A key may use {{detail}}: the
// server's text, where it carries the useful part (the SMTP answer, the refused host).

// PATCH /api/admin/settings (services/admin/systemSettings.js SYSTEM_SETTINGS_ERRORS).
export const SETTINGS_ERROR_KEYS = Object.freeze({
  no_sso_provider: 'admin.settingsError.noSsoProvider',
  sso_identity_required: 'admin.settingsError.ssoIdentityRequired',
  auth_max_attempts_invalid: 'admin.settingsError.maxAttempts',
  auth_window_minutes_invalid: 'admin.settingsError.windowMinutes',
  mfa_enforcement_invalid: 'admin.settingsError.mfaEnforcement',
  mfa_device_trust_invalid: 'admin.settingsError.mfaDeviceTrust',
  custom_css_invalid: 'admin.settingsError.customCss',
  custom_css_too_long: 'admin.settingsError.customCssTooLong',
  invalid_field: 'admin.settingsError.invalidField',
});

// The invites (services/admin/invites.js INVITE_ERRORS).
export const INVITE_ERROR_KEYS = Object.freeze({
  email_invalid: 'admin.users.inviteErrorEmail',
  app_url_missing: 'admin.users.inviteErrorAppUrl',
  not_found: 'admin.users.inviteErrorNotFound',
});

// The SSO providers (services/auth/oidcProviders.js OIDC_PROVIDER_ERRORS).
export const OIDC_ERROR_KEYS = Object.freeze({
  fields_required: 'admin.sso.errorFieldsRequired',
  slug_invalid: 'admin.sso.errorSlugInvalid',
  login_match_claim_invalid: 'admin.sso.errorLoginMatchClaim',
  issuer_not_https: 'admin.sso.errorIssuerNotHttps',
  issuer_host_refused: 'admin.sso.errorIssuerHostRefused',
  issuer_invalid: 'admin.sso.errorIssuerInvalid',
  slug_taken: 'admin.sso.errorSlugTaken',
  not_found: 'admin.sso.errorNotFound',
  last_provider: 'admin.sso.errorLastProvider',
});

// The system email (services/admin/systemEmail.js SYSTEM_EMAIL_ERRORS).
export const SYSTEM_EMAIL_ERROR_KEYS = Object.freeze({
  fields_required: 'admin.systemEmail.errorFieldsRequired',
  host_refused: 'admin.systemEmail.errorHostRefused',
  not_configured: 'admin.systemEmail.errorNotConfigured',
  config_corrupted: 'admin.systemEmail.errorConfigCorrupted',
  password_missing: 'admin.systemEmail.errorPasswordMissing',
  insecure_tls_not_allowed: 'admin.systemEmail.errorInsecureTlsNotAllowed',
  smtp_failed: 'admin.systemEmail.errorSmtpFailed',
});
