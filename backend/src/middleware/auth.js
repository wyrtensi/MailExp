import { query } from '../services/db.js';
import { closeUserSockets } from '../services/websocket.js';

// End the session of a user who no longer has access, and the live sockets of that user:
// a socket is authenticated once, at upgrade, and would keep receiving their mail events.
// The socket server comes from the app (index.js sets imapManager), not an import of index.js.
function endUserAccess(req) {
  const { userId } = req.session;
  req.session.destroy(() => {});
  closeUserSockets(req.app?.get('imapManager')?.wss, userId);
}

// A disabled user loses access at the next request, whatever session they still hold.
function refuseDisabled(req, res) {
  endUserAccess(req);
  return res.status(403).json({ error: 'user_disabled', code: 'user_disabled' });
}

export async function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query('SELECT id, disabled_at FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows.length) {
      endUserAccess(req);
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (result.rows[0].disabled_at) return refuseDisabled(req, res);
    next();
  } catch (err) {
    next(err);
  }
}

// Whether the signed-in user is an active administrator, read from the DB as requireAdmin does:
// for routes open to everyone where only part of the request is an admin's to make.
export async function isAdminRequest(req) {
  if (!req.session?.userId) return false;
  const result = await query('SELECT is_admin, disabled_at FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  return !!user?.is_admin && !user.disabled_at;
}

// Always verifies against the DB so a revoked or disabled admin can't keep using
// a stale session. The extra query is cheap and only hits admin routes.
export async function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query(
      'SELECT is_admin, disabled_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = result.rows[0];
    if (user?.disabled_at) return refuseDisabled(req, res);
    if (!user?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
}
