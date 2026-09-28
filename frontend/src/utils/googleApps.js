// Helpers for the "Google apps" admin screen. Shapes mirror /api/admin/google-apps
// (backend/src/routes/googleAppsAdmin.js). Pure: no DOM, no store, no network.
const CLIENT_ID_RE = /^(\d+)-([a-z0-9]+)\.apps\.googleusercontent\.com$/;
const LABEL_MAX = 100;
// user_limit is a Postgres INTEGER.
const USER_LIMIT_MAX = 2147483647;
const DEFAULT_USER_LIMIT = 100;
const STATUSES = ['active', 'closed', 'disabled'];

export const GOOGLE_APP_SCOPES = 'openid email profile https://mail.google.com/';

// Keys are spelled out literally so the i18n coverage tests can find them.
const STATE_KEYS = Object.freeze({
  active: 'admin.integrations.googleApps.stateActive',
  full: 'admin.integrations.googleApps.stateFull',
  closed: 'admin.integrations.googleApps.stateClosed',
  disabled: 'admin.integrations.googleApps.stateDisabled',
});

const STATUS_ACTION_KEYS = Object.freeze({
  active: 'admin.integrations.googleApps.activate',
  closed: 'admin.integrations.googleApps.close',
  disabled: 'admin.integrations.googleApps.disable',
});

const ERROR_KEYS = Object.freeze({
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
  client_json_invalid: 'admin.integrations.googleApps.errorClientJsonInvalid',
  client_json_service_account: 'admin.integrations.googleApps.errorClientJsonServiceAccount',
  client_json_not_web: 'admin.integrations.googleApps.errorClientJsonNotWeb',
  client_json_incomplete: 'admin.integrations.googleApps.errorClientJsonIncomplete',
  client_json_conflict: 'admin.integrations.googleApps.errorClientJsonConflict',
});

// Keys are spelled out literally so the i18n coverage tests can find them.
const WARNING_KEYS = Object.freeze({
  redirect_uri_missing: 'admin.integrations.googleApps.warningRedirectUriMissing',
  callback_not_configured: 'admin.integrations.googleApps.warningCallbackNotConfigured',
});

// Keys are spelled out literally so the i18n coverage tests can find them.
const GMAIL_API_DISABLED_KEY = 'admin.integrations.googleApps.gmailApiDisabledWarning';

// The app's card shows this when a Gmail API send through this project's OAuth client came back
// "API disabled" (see backend/src/services/gmailApiSender.js / googleApps.js's
// markGmailApiDisabled) — mail for its mailboxes falls back to SMTP until the project's owner
// enables the API and a later send clears the flag again.
export function googleAppGmailApiWarningKey(app) {
  return app?.gmailApiDisabledAt ? GMAIL_API_DISABLED_KEY : null;
}

// "Full" is not stored: the server computes it for an active app whose seats reached the limit.
export function googleAppState(app) {
  if (!STATUSES.includes(app?.status)) return null;
  return app.status === 'active' && app.full === true ? 'full' : app.status;
}

export function googleAppStateKey(app) {
  const state = googleAppState(app);
  return state ? STATE_KEYS[state] : null;
}

export function shortClientId(clientId) {
  if (typeof clientId !== 'string') return '';
  const match = CLIENT_ID_RE.exec(clientId.trim());
  if (match) return `${match[1]}-${match[2].slice(0, 6)}…`;
  return clientId.length > 24 ? `${clientId.slice(0, 24)}…` : clientId;
}

// Seats Google has counted plus live reservations, against the app's limit.
export function googleAppSeatsText(app) {
  const used = (app?.grantsCount ?? 0) + (app?.reservedCount ?? 0);
  return `${used} / ${app?.userLimit ?? 0}`;
}

// Disabling sends the app's mailboxes to "needs reconnect", so only it asks for confirmation.
export function googleAppStatusActions(app) {
  return STATUSES
    .filter((status) => status !== app?.status)
    .map((status) => ({ status, labelKey: STATUS_ACTION_KEYS[status], confirm: status === 'disabled' }));
}

// The server refuses to delete an app with bound mailboxes (409 app_in_use).
export function canDeleteGoogleApp(app) {
  return (app?.accountsCount ?? 0) === 0;
}

// The secret field always starts empty: the server never returns it, and an empty value keeps it.
// clientJson holds the raw text of an imported client file (new apps only; see googleAppPayload).
export function googleAppForm(app) {
  return {
    label: app?.label ?? '',
    clientId: app?.clientId ?? '',
    clientSecret: '',
    clientJson: '',
    userLimit: String(app?.userLimit ?? DEFAULT_USER_LIMIT),
  };
}

// Lightweight preview of an imported Google OAuth client JSON, for immediate feedback in the form
// (what was read, or what is wrong with the file) without a round trip. The backend's
// parseGoogleClientJson (backend/src/services/oauth/googleClientJson.js) is the source of truth
// and is checked again on save; this only reads the same top-level shape.
export function parseGoogleClientJsonPreview(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errorKey: ERROR_KEYS.client_json_invalid };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errorKey: ERROR_KEYS.client_json_invalid };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errorKey: ERROR_KEYS.client_json_invalid };
  if (data.type === 'service_account') return { ok: false, errorKey: ERROR_KEYS.client_json_service_account };
  if (data.installed) return { ok: false, errorKey: ERROR_KEYS.client_json_not_web };
  const web = data.web;
  if (!web || typeof web !== 'object' || Array.isArray(web)) return { ok: false, errorKey: ERROR_KEYS.client_json_not_web };
  const clientId = typeof web.client_id === 'string' ? web.client_id.trim() : '';
  const hasSecret = typeof web.client_secret === 'string' && web.client_secret.trim() !== '';
  if (!clientId || !hasSecret) return { ok: false, errorKey: ERROR_KEYS.client_json_incomplete };
  const projectId = typeof web.project_id === 'string' ? web.project_id.trim() : '';
  return { ok: true, clientId, projectId };
}

function parseUserLimit(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n <= USER_LIMIT_MAX ? n : null;
}

// Import mode only applies to a new app: an existing app's client ID is fixed, and re-importing
// a file over an edit would silently try to change it.
function importedJson(form, editing) {
  return !editing && typeof form.clientJson === 'string' ? form.clientJson.trim() : '';
}

// The first problem that stops the form from saving, as a translation key, or null. The client
// ID of an existing app never changes, so an edit does not check it.
export function googleAppFormError(form, { editing }) {
  const label = form.label.trim();
  if (!label || label.length > LABEL_MAX) return ERROR_KEYS.label_invalid;
  const clientJson = importedJson(form, editing);
  if (clientJson) {
    const preview = parseGoogleClientJsonPreview(clientJson);
    if (!preview.ok) return preview.errorKey;
  } else {
    if (!editing && !CLIENT_ID_RE.test(form.clientId.trim())) return ERROR_KEYS.client_id_invalid;
    const secret = form.clientSecret.trim();
    if (!editing && !secret) return ERROR_KEYS.client_secret_required;
    if (secret.includes('•')) return ERROR_KEYS.client_secret_redacted;
  }
  if (parseUserLimit(form.userLimit) === null) return ERROR_KEYS.user_limit_invalid;
  return null;
}

// Body for POST (new app, manual or imported) or PATCH (edit). A blank secret on edit is left
// out, which keeps the stored one; the client ID is never sent on edit. An imported file sends
// clientJson instead of clientId/clientSecret: the server refuses both together.
export function googleAppPayload(form, { editing }) {
  const body = { label: form.label.trim(), userLimit: parseUserLimit(form.userLimit) };
  const clientJson = importedJson(form, editing);
  if (clientJson) return { label: body.label, clientJson, userLimit: body.userLimit };
  const secret = form.clientSecret.trim();
  if (!editing) return { label: body.label, clientId: form.clientId.trim(), clientSecret: secret, userLimit: body.userLimit };
  if (secret) body.clientSecret = secret;
  return body;
}

export function googleAppErrorKey(code) {
  return typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : null;
}

// A warning the server returned alongside a created app (see googleClientJsonWarnings on the
// backend), as a translation key, or null for a code this UI does not know.
export function googleAppWarningKey(code) {
  return typeof code === 'string' && Object.hasOwn(WARNING_KEYS, code) ? WARNING_KEYS[code] : null;
}

// Same rule as the server: an absolute http(s) address.
export function googleCallbackFormError(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') return null;
  } catch {
    // fall through
  }
  return ERROR_KEYS.redirect_uri_invalid;
}

// When the panel is open on another public host (APP_ALT_URLS), Google must also know that
// host's callback: the backend sends the browser back to the host the flow started on.
export function googleCallbackAltUri(configured, origin) {
  if (typeof configured !== 'string' || typeof origin !== 'string' || !origin) return null;
  let url;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  const base = origin.replace(/\/+$/, '');
  return url.origin === base ? null : `${base}${url.pathname}`;
}
