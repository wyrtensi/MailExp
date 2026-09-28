import { GoogleAppError } from './googleApps.js';

// Parses the OAuth client JSON downloaded from Google Cloud Console (Credentials -> OAuth
// client -> Download JSON; the file is named client_secret_<id>.apps.googleusercontent.com.json).
// Only the "web" client type is accepted: MailExpert's OAuth apps run a server-side redirect,
// which needs a web client's secret. A desktop ("installed") client or a service-account key
// would parse just as easily, so both are refused by name instead of failing on a missing field
// further down. Never logs clientSecret.
export function parseGoogleClientJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new GoogleAppError('client_json_invalid');

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GoogleAppError('client_json_invalid');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GoogleAppError('client_json_invalid');

  if (data.type === 'service_account') throw new GoogleAppError('client_json_service_account');
  if (data.installed) throw new GoogleAppError('client_json_not_web');

  const web = data.web;
  if (!web || typeof web !== 'object' || Array.isArray(web)) throw new GoogleAppError('client_json_not_web');

  const clientId = typeof web.client_id === 'string' ? web.client_id.trim() : '';
  const clientSecret = typeof web.client_secret === 'string' ? web.client_secret : '';
  if (!clientId || !clientSecret) throw new GoogleAppError('client_json_incomplete');

  const projectId = typeof web.project_id === 'string' ? web.project_id.trim() : '';
  const redirectUris = Array.isArray(web.redirect_uris)
    ? web.redirect_uris.filter((uri) => typeof uri === 'string').map((uri) => uri.trim())
    : [];

  return { clientId, clientSecret, projectId, redirectUris };
}

// Warnings for an imported client JSON, checked against the panel's current Google callback URL
// (see getEffectiveGoogleRedirectUri in googleApps.js). Compared as exact strings after trim:
// Google itself matches redirect URIs exactly, so normalizing here would hide a real mismatch.
// Returns [] when the file already lists the expected callback.
export function googleClientJsonWarnings(redirectUris, expectedUri) {
  if (!expectedUri) return [{ code: 'callback_not_configured' }];
  const uris = Array.isArray(redirectUris) ? redirectUris : [];
  if (!uris.includes(expectedUri)) return [{ code: 'redirect_uri_missing', expected: expectedUri }];
  return [];
}
