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
// A socket still being authorized (google mode awaits a token check and a DB read) is matched
// by the user its session named (ws.pendingUserId) and marked revoked, so the authorization
// cannot attach a user to it afterwards. A socket still in its session lookup names no user
// and is not matched; it reads the session after the change. No userId closes nothing.
// The close waits a turn: an upgrade whose session lookup was answered in the same Redis read
// as the write that ended the session authenticates a microtask after that write's callback,
// and closing at once would miss it.
export function closeUserSockets(wss, userId, { sessionId = null, reason = 'Session ended' } = {}) {
  if (!wss || !userId) return;
  setImmediate(() => {
    for (const ws of wss.clients) {
      if ((ws.userId ?? ws.pendingUserId) !== userId || ws.readyState !== 1) continue;
      if (sessionId && ws.sessionId !== sessionId) continue;
      ws.revoked = true;
      ws.close(1008, reason);
    }
  });
}

// Read the session again from the store, after an authorization that may have awaited for a
// while: it may have been destroyed or locked meanwhile. Resolves to the fresh session or null.
function reloadSession(req) {
  return new Promise((resolve) => {
    if (typeof req.session?.reload !== 'function') return resolve(null);
    req.session.reload((err) => resolve(err ? null : req.session));
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
      // Known before the authorization awaits anything, so closeUserSockets can reach a socket
      // whose session ends or locks while it is being authorized.
      ws.sessionId = req.sessionID;
      ws.pendingUserId = req.session?.userId;
      authorize(req)
        .then(async (userId) => {
          if (ws.readyState !== 1 || ws.revoked) return;
          if (!userId) {
            ws.close(1008, 'Unauthorized');
            return;
          }
          // The session read at upgrade is a snapshot: logout, lock or a disable may have
          // happened while the authorization awaited. Read it again before attaching the user.
          const session = await reloadSession(req);
          if (ws.readyState !== 1 || ws.revoked) return;
          if (!session || session.userId !== userId) {
            ws.close(1008, 'Unauthorized');
            return;
          }
          if (session.locked) {
            // Screen lock (#235) is server-enforced: don't stream live mail to a locked
            // session. POST /auth/lock closes the sockets already open; this blocks a new one.
            ws.close(1008, 'Locked');
            return;
          }
          ws.userId = userId;
          delete ws.pendingUserId;
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
