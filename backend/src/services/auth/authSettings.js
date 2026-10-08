// Sign-in configuration from the environment. Read on every call: parsing is cheap and a
// changed environment (tests, a restart with new values) is never served from a stale copy.
export const AUTH_MODES = new Set(['local', 'google']);

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

const text = (value) => String(value ?? '').trim();

export function getAuthSettings(env = process.env) {
  const issuer = text(env.CF_ACCESS_ISSUER).replace(/\/+$/, '');
  const audience = text(env.CF_ACCESS_AUDIENCE);
  const clientId = text(env.AUTH_GOOGLE_CLIENT_ID);
  const clientSecret = text(env.AUTH_GOOGLE_CLIENT_SECRET);
  const bootstrap = text(env.BOOTSTRAP_ADMIN_EMAILS)
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => EMAIL_PATTERN.test(email));

  return {
    mode: (text(env.AUTH_MODE) || 'local').toLowerCase(),
    cloudflare: issuer && audience ? { issuer, audience } : null,
    googleSignIn: clientId && clientSecret ? { clientId, clientSecret } : null,
    bootstrapAdminEmails: new Set(bootstrap),
  };
}

// What the host set for Cloudflare Access (configure.sh -> <prefix>/.env), each value on its own:
// getAuthSettings() answers cloudflare: null unless both are set, which hides which one is missing.
// Neither is a secret (the team domain is in every Access redirect, the aud tag in every token).
export function cloudflareEnvState(env = process.env) {
  const issuer = text(env.CF_ACCESS_ISSUER).replace(/\/+$/, '');
  const audience = text(env.CF_ACCESS_AUDIENCE);
  return { issuer: issuer || null, audience: audience || null };
}

// A startup error for a configuration the server cannot run with, or null.
export function authSettingsError(settings = getAuthSettings()) {
  if (!AUTH_MODES.has(settings.mode)) return 'AUTH_MODE must be "local" or "google".';
  if (settings.mode === 'google' && !settings.cloudflare && !settings.googleSignIn) {
    return 'AUTH_MODE=google needs CF_ACCESS_ISSUER and CF_ACCESS_AUDIENCE, or AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET.';
  }
  return null;
}
