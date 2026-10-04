import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A WebSocket is authenticated once, at upgrade, so ending or locking the session that opened
// it does not stop the user's live mail events (new_messages carries sender, subject and
// snippet) reaching it. The routes that end or lock a session close those sockets.

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  closeUserSockets: vi.fn(),
  compare: vi.fn(),
  consume: vi.fn(),
  redis: { scan: vi.fn(), get: vi.fn(), del: vi.fn() },
  wss: { clients: new Set() },
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, pool: {} }));
vi.mock('../index.js', () => ({ imapManager: { wss: mocks.wss } }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: mocks.closeUserSockets }));
vi.mock('../services/encryption.js', () => ({
  decrypt: value => value,
  encrypt: value => value,
}));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(),
}));
vi.mock('../services/authLimiter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  authLimiterConfig: { maxRequests: 10, windowMs: 900000 },
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn(async () => null) }));
vi.mock('../services/categorizer.js', () => ({ getGlobalCategorizationEnabled: vi.fn(async () => false) }));
vi.mock('../services/redis.js', () => ({ redisClient: mocks.redis }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: mocks.consume,
  peek: vi.fn(async () => ({ limited: false })),
  reset: vi.fn(async () => {}),
}));
// Password hashing is not under test, and bcrypt at cost 12 is slow enough to matter under load.
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn(async () => 'new-hash'), hashSync: () => 'dummy-hash', compare: mocks.compare },
}));

import express from 'express';
import authRoutes from './auth.js';

// What happened, in order, across the session store, Redis and the sockets.
let events;

function buildApp() {
  const app = express();
  app.use(express.json());
  // Stands in for express-session. Its store calls finish on a later tick, as the Redis
  // store's do, so a socket closed before the store has caught up shows in `events`.
  // destroy() drops req.session at once, as the real one does.
  app.use((req, _res, next) => {
    req.sessionID = 'sess-1';
    req.session = {
      userId: 'u1',
      destroy(cb) {
        delete req.session;
        setImmediate(() => { events.push('session destroyed'); cb(); });
      },
      save(cb) {
        const { locked } = this;
        setImmediate(() => { events.push(locked ? 'session saved locked' : 'session saved'); cb(); });
      },
    };
    next();
  });
  app.use('/api/auth', authRoutes);
  return app;
}

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  events = [];
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.closeUserSockets.mockReset().mockImplementation(() => { events.push('sockets closed'); });
  mocks.compare.mockReset();
  mocks.consume.mockReset().mockResolvedValue({ limited: false });
  mocks.redis.scan.mockReset();
  mocks.redis.get.mockReset();
  mocks.redis.del.mockReset();
});

const post = (path, body = {}) => fetch(`${base}/api/auth${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  body: JSON.stringify(body),
});

describe('ending or locking a session closes the WebSockets it opened', () => {
  it('logout closes the sockets of this session once it is destroyed', async () => {
    const res = await post('/logout');
    expect(res.status).toBe(200);
    expect(mocks.closeUserSockets.mock.calls).toEqual([[mocks.wss, 'u1', { sessionId: 'sess-1' }]]);
    expect(events).toEqual(['session destroyed', 'sockets closed']);
  });

  it('lock closes the sockets of this session once the lock is saved, so a reconnect is refused', async () => {
    const res = await post('/lock');
    expect(res.status).toBe(200);
    expect(mocks.closeUserSockets.mock.calls).toEqual([[mocks.wss, 'u1', { sessionId: 'sess-1', reason: 'Locked' }]]);
    expect(events).toEqual(['session saved locked', 'sockets closed']);
  });

  it('too many wrong PINs sign out and close the sockets of this session', async () => {
    mocks.query.mockResolvedValue({ rows: [{ lock_pin_hash: 'pin-hash' }] });
    mocks.compare.mockResolvedValue(false);
    mocks.consume.mockResolvedValue({ limited: true });

    const res = await post('/unlock', { pin: '0000' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ signedOut: true });
    expect(mocks.closeUserSockets.mock.calls).toEqual([[mocks.wss, 'u1', { sessionId: 'sess-1' }]]);
    expect(events).toEqual(['session destroyed', 'sockets closed']);
  });

  it('a password reset closes every socket of the user once their sessions are deleted', async () => {
    mocks.query.mockImplementation(async (sql) => (
      sql.includes('DELETE FROM password_reset_tokens') ? { rows: [{ user_id: 'u1' }] } : { rows: [] }
    ));
    mocks.redis.scan.mockResolvedValue({ cursor: '0', keys: ['sess:a', 'sess:b'] });
    mocks.redis.get.mockImplementation(async (key) => JSON.stringify({ userId: key === 'sess:a' ? 'u1' : 'u2' }));
    mocks.redis.del.mockImplementation(async (key) => { events.push(`deleted ${key}`); });

    const res = await post('/reset-password', { token: 'reset-token', password: 'a-new-password' });
    expect(res.status).toBe(200);
    expect(mocks.closeUserSockets.mock.calls).toEqual([[mocks.wss, 'u1']]);
    expect(events).toEqual(['deleted sess:a', 'sockets closed']);
  });
});
