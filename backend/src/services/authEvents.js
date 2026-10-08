import { query } from './db.js';

// Prune records older than 90 days once per hour so the table stays bounded.
setInterval(() => {
  query("DELETE FROM auth_events WHERE created_at < NOW() - INTERVAL '90 days'")
    .catch(err => console.error('[auth] Failed to prune auth events:', err.message));
}, 60 * 60 * 1000);

// Fire-and-forget audit log write. Never throws — a logging failure must
// not block or crash authentication flows.
export function logAuthEvent(eventType, { username = null, userId = null, ip, success }) {
  query(
    `INSERT INTO auth_events (event_type, username, user_id, ip, success)
     VALUES ($1, $2, $3, $4, $5)`,
    [eventType, username || null, userId || null, ip || null, success]
  ).catch(err => console.error('[auth] Failed to log event:', err.message));
}

// Sign-in events, newest first: { events, total } (/api/admin/auth-events and the panel CLI's
// "audit auth-events").
export async function listAuthEvents({ limit = 100, offset = 0 } = {}) {
  const [eventsResult, countResult] = await Promise.all([
    query(
      `SELECT id, event_type, username, user_id, ip, success, created_at
       FROM auth_events ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    query('SELECT COUNT(*) AS total FROM auth_events'),
  ]);
  return { events: eventsResult.rows, total: parseInt(countResult.rows[0].total) };
}
