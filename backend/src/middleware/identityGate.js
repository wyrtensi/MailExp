import { getAuthSettings } from '../services/auth/authSettings.js';
import { CF_ACCESS_HEADER, verifyCloudflareAccessToken } from '../services/auth/cloudflareAccess.js';
import { bindSessionUser, loadUserById, resolveVerifiedUser } from '../services/auth/userIdentity.js';

// Reachable without a signed-in user in google mode.
const PUBLIC_PATHS = new Set([
  '/api/health', '/api/health/ready', '/api/version', '/api/auth/config', '/api/auth/logout',
  '/oauth/login/google', '/oauth/login/google/callback',
]);

// Local sign-in surfaces that do not exist in google mode.
const LOCAL_ONLY_PREFIXES = [
  '/api/auth/register', '/api/auth/login', '/api/auth/2fa', '/api/auth/forgot-password',
  '/api/auth/reset-password', '/api/auth/registration-status', '/api/auth/invite',
  '/api/auth/profile/recovery-email', '/api/auth/oidc', '/auth/oidc', '/api/totp',
  '/api/admin/invites', '/api/admin/oidc',
];
const LOCAL_ONLY_PATTERNS = [/^\/api\/admin\/users\/[^/]+\/totp\/disable$/];

// Express matches routes case-insensitively (/API/Auth/Login reaches the login route), so the
// path is compared in lower case: every entry above is lower case.
export function isLocalOnlyPath(rawPath) {
  const path = String(rawPath).toLowerCase();
  return LOCAL_ONLY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    || LOCAL_ONLY_PATTERNS.some((pattern) => pattern.test(path));
}

function deny(req, res, status, code) {
  // A refused identity must not keep the session it may already hold.
  if (status === 403 && req.session?.userId) req.session.destroy(() => {});
  return res.status(status).json({ error: code, code });
}

// In google mode every request needs an approved, active user: a verified Cloudflare Access
// token, or a session opened by direct Google sign-in. The user row is read on every
// request, so turning a user off takes effect at once.
export function createIdentityGate({
  getSettings = getAuthSettings,
  verifyToken = verifyCloudflareAccessToken,
  resolveUser = resolveVerifiedUser,
  loadUser = loadUserById,
} = {}) {
  return async function identityGate(req, res, next) {
    const settings = getSettings();
    if (settings.mode !== 'google') return next();

    const path = req.originalUrl.split('?')[0].toLowerCase();
    if (isLocalOnlyPath(path)) return res.status(404).json({ error: 'Not found' });
    if (PUBLIC_PATHS.has(path)) return next();

    try {
      const token = settings.cloudflare ? req.get(CF_ACCESS_HEADER) : undefined;
      if (token) {
        const email = await verifyToken(token, settings.cloudflare);
        if (!email) return deny(req, res, 401, 'not_authenticated');
        const result = await resolveUser({ email, source: 'cloudflare', settings });
        if (result.error) return deny(req, res, 403, result.error);
        await bindSessionUser(req, result.user, 'cloudflare');
        return next();
      }

      // Without an Access token only a direct sign-in session counts: a session opened
      // through Cloudflare must keep arriving through Cloudflare.
      if (!req.session?.userId || req.session.authMethod !== 'google') {
        return deny(req, res, 401, 'not_authenticated');
      }
      const user = await loadUser(req.session.userId);
      if (!user || !user.email) return deny(req, res, 401, 'not_authenticated');
      if (user.disabled_at) return deny(req, res, 403, 'user_disabled');
      req.session.isAdmin = user.is_admin;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export const identityGate = createIdentityGate();
