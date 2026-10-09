// CSRF defense-in-depth for the cookie-authenticated /api surface. A mutating request must carry
// a custom header that a cross-site <form> cannot set and a cross-origin fetch cannot send
// without a CORS preflight, which the CORS policy (index.js) restricts to FRONTEND_URL.
// SameSite=lax cookies are the primary defense; this closes same-site/subdomain and
// legacy-browser gaps. index.js mounts it on /api, and middleware/bodyParsers.js runs it before
// the large request bodies are read.
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireCsrfHeader(req, res, next) {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (req.get('X-Requested-With')) return next();
  return res.status(403).json({ error: 'Missing required X-Requested-With header' });
}
