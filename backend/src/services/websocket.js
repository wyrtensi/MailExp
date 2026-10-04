import { recordWsConnect, recordWsDisconnect } from './diagnosticsRing.js';
import { getPublicOrigins } from '../utils/publicOrigins.js';
import { getAuthSettings } from './auth/authSettings.js';
import { CF_ACCESS_HEADER, verifyCloudflareAccessToken } from './auth/cloudflareAccess.js';
import { findUserByEmail, loadUserById } from './auth/userIdentity.js';

// Accepted browser origins (APP_URL plus APP_ALT_URLS), read once at startup.
// Without any, origin validation is skipped — log a warning so operators know.
const ALLOWED_ORIGINS = getPublicOrigins();
if (!ALLOWED_ORIGINS.length) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: APP_URL is not set in production — WebSocket connections with an Origin header will be rejected.');
  } else {
    console.warn('WARNING: APP_URL is not set — WebSocket origin validation is disabled. Set APP_URL in .env for production.');
  }
}

// The user a WebSocket upgrade belongs to, or null. Google mode applies the rules of the HTTP
// identity gate but cannot change the session: an Access token must belong to the user the
// page's HTTP requests already put into the session.
export async function authorizeSocketUser(req, {
  settings = getAuthSettings(),
  verifyToken = verifyCloudflareAccessToken,
  loadUser = loadUserById,
  findUser = findUserByEmail,
} = {}) {
  const sessionUserId = req.session?.userId;
  if (!sessionUserId) return null;
  if (settings.mode !== 'google') return sessionUserId;

  const token = settings.cloudflare ? req.headers[CF_ACCESS_HEADER] : undefined;
  let user;
  if (token) {
    if (req.session.authMethod !== 'cloudflare') return null;
    const email = await verifyToken(token, settings.cloudflare);
    user = email ? await findUser(email) : null;
    if (!user || user.id !== sessionUserId) return null;
  } else {
    if (req.session.authMethod !== 'google') return null;
    user = await loadUser(sessionUserId);
  }
  return user && user.email && !user.disabled_at ? user.id : null;
}

// Close the live sockets of a user whose access just ended: every one of them, or with
// `sessionId` only those that session opened (logout, lock). A socket is authenticated once,
// at upgrade, so nothing else stops broadcasts reaching it after its session ends or locks.
// No userId closes nothing: a socket still in its session lookup has no userId either.
// The close waits a turn: an upgrade whose session lookup was answered in the same Redis read
// as the write that ended the session authenticates a microtask after that write's callback,
// and closing at once would miss it.
export function closeUserSockets(wss, userId, { sessionId = null, reason = 'Session ended' } = {}) {
  if (!wss || !userId) return;
  setImmediate(() => {
    for (const ws of wss.clients) {
      if (ws.userId !== userId || ws.readyState !== 1) continue;
      if (sessionId && ws.sessionId !== sessionId) continue;
      ws.close(1008, reason);
    }
  });
}

export function setupWebSocket(wss, sessionMiddleware, { authorize = authorizeSocketUser } = {}) {
  wss.on('connection', (ws, req) => {
    // Transport errors can arrive during session lookup, before authentication.
    ws.on('error', err => {
      console.warn('WebSocket transport error:', err.message);
      ws.terminate();
    });
    // Reject cross-origin WebSocket connections when public origins are configured.
    // Browsers always send Origin on WS upgrades; absence means a non-browser client.
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
      ws.close(1008, 'Forbidden');
      return;
    }
    // In production without APP_URL, reject browser connections (non-browser clients omit Origin)
    if (!ALLOWED_ORIGINS.length && process.env.NODE_ENV === 'production' && origin) {
      ws.close(1008, 'Forbidden');
      return;
    }

    // Parse session from upgrade request
    const fakeRes = {
      getHeader: () => {},
      setHeader: () => {},
      end: () => {}
    };

    sessionMiddleware(req, fakeRes, (err) => {
      if (ws.readyState !== 1) return;
      if (err) {
        // A temporary session-store outage should be retried, not treated as
        // invalid credentials (1008 disables automatic browser reconnects).
        ws.close(1011, 'Session unavailable');
        return;
      }
      authorize(req)
        .then((userId) => {
          if (ws.readyState !== 1) return;
          if (!userId) {
            ws.close(1008, 'Unauthorized');
            return;
          }
          if (req.session.locked) {
            // Screen lock (#235) is server-enforced: don't stream live mail to a locked
            // session. POST /auth/lock closes the sockets already open; this blocks a new one.
            ws.close(1008, 'Locked');
            return;
          }
          ws.userId = userId;
          // The session that opened the socket, so logout and lock can close just its sockets.
          ws.sessionId = req.sessionID;
          recordWsConnect();
          ws._diagCounted = true;
          console.log(`WebSocket connected for user ${userId}`);
          ws.send(JSON.stringify({ type: 'connected' }));
        })
        .catch((authErr) => {
          // Only the error class: a lookup failure must not end in a message with details.
          console.error(`WebSocket authorization failed: ${authErr?.name || 'Error'}`);
          if (ws.readyState === 1) ws.close(1011, 'Session unavailable');
        });
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch { /* ignore malformed client message */ }
    });

    ws.on('close', () => {
      if (ws._diagCounted) recordWsDisconnect();
      console.log(`WebSocket disconnected`);
    });
  });
}
