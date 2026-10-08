// The app-wide error handlers (index.js). Each answer carries a stable code the screens translate;
// the detail of an unexpected error stays in the server log.

// Right after the body parsers: a body they refuse is the client's mistake, not a 500.
export function bodyErrorHandler(err, req, res, next) {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request too large. Total attachment size must not exceed 25 MiB.', code: 'request_too_large',
    });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request body is not valid JSON', code: 'invalid_json' });
  }
  return next(err);
}

// Last in the chain: whatever a route threw (Express 5 forwards a rejected async handler here).
// The log names the request and the signed-in user so the line can be traced back.
// eslint-disable-next-line no-unused-vars
export function finalErrorHandler(err, req, res, _next) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  const user = req.session?.userId ? ` user=${req.session.userId}` : '';
  console.error(`Unhandled route error: ${req.method} ${path}${user}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
}
