import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./diagnosticsRing.js', () => ({ recordWsConnect: vi.fn(), recordWsDisconnect: vi.fn() }));
vi.mock('./auth/userIdentity.js', () => ({ findUserByEmail: vi.fn(), loadUserById: vi.fn() }));
vi.mock('./auth/cloudflareAccess.js', () => ({
  CF_ACCESS_HEADER: 'cf-access-jwt-assertion',
  verifyCloudflareAccessToken: vi.fn(),
}));

import { authorizeSocketUser, closeUserSockets, setupWebSocket } from './websocket.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The session store behind the upgrade: `store.session` is what a reload reads (null once the
// session is destroyed), as express-session's req.session.reload() does.
function setup(sessionMiddleware, options) {
  const wss = Object.assign(new EventEmitter(), { clients: new Set() });
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1, close: vi.fn(), terminate: vi.fn(), send: vi.fn(),
  });
  wss.clients.add(ws);
  const store = { session: { userId: 'u1' } };
  const req = { headers: {}, sessionID: 'sess-1' };
  const sessionFromStore = () => ({
    ...store.session,
    reload(cb) {
      if (!store.session) return cb(new Error('failed to load session'));
      req.session = sessionFromStore();
      cb();
    },
  });
  req.session = sessionFromStore();
  setupWebSocket(wss, sessionMiddleware, options);
  wss.emit('connection', ws, req);
  return { ws, wss, store };
}

// An authorization that waits until the test lets it finish, like google mode's token check.
function delayedAuthorize() {
  let finish;
  const authorize = () => new Promise((resolve) => { finish = resolve; });
  return { authorize, finish: (userId = 'u1') => finish(userId) };
}
afterEach(() => vi.restoreAllMocks());

describe('WebSocket failure recovery', () => {
  it('absorbs transport errors even while session lookup is pending', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ws } = setup(() => {});
    expect(() => ws.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it('allows the browser to retry a session-store outage', () => {
    const { ws } = setup((_req, _res, next) => next(new Error('Redis unavailable')));
    expect(ws.close).toHaveBeenCalledWith(1011, 'Session unavailable');
  });

  it('does not authenticate a socket closed during session lookup', async () => {
    let finish;
    const { ws } = setup((_req, _res, next) => { finish = next; });
    ws.readyState = 3;
    finish();
    await flush();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('greets an authorized socket and leaves mailbox connections to the server', async () => {
    const { ws } = setup((_req, _res, next) => next(), { authorize: async () => 'u1' });
    await flush();
    expect(ws.userId).toBe('u1');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'connected' }));
  });

  it('closes a socket whose user is not authorized', async () => {
    const { ws } = setup((_req, _res, next) => next(), { authorize: async () => null });
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
  });

  it('lets the browser retry when authorization itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws } = setup((_req, _res, next) => next(), {
      authorize: async () => { throw new Error('database unavailable'); },
    });
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1011, 'Session unavailable');
    expect(error).toHaveBeenCalledWith('WebSocket authorization failed: Error');
  });
});

describe('authorizeSocketUser', () => {
  const GOOGLE = {
    mode: 'google',
    cloudflare: { issuer: 'https://team.cloudflareaccess.com', audience: 'aud' },
    googleSignIn: null,
    bootstrapAdminEmails: new Set(),
  };
  const USER = { id: 'u1', email: 'user@example.com', disabled_at: null };
  const deps = (overrides = {}) => ({
    settings: GOOGLE,
    verifyToken: vi.fn(async (token) => (token === 'good' ? 'user@example.com' : null)),
    findUser: vi.fn(async () => USER),
    loadUser: vi.fn(async () => USER),
    ...overrides,
  });
  const req = (session, headers = {}) => ({ session, headers });

  it('uses the session user in local mode', async () => {
    const local = { settings: { ...GOOGLE, mode: 'local' } };
    expect(await authorizeSocketUser(req({ userId: 'u1' }), local)).toBe('u1');
    expect(await authorizeSocketUser(req({}), local)).toBeNull();
  });

  it('accepts an Access token of the session user', async () => {
    const d = deps();
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'cloudflare' }, { 'cf-access-jwt-assertion': 'good' }), d)).toBe('u1');
    expect(d.findUser).toHaveBeenCalledWith('user@example.com');
  });

  it('refuses a token of someone else, an invalid token and a Cloudflare session without its token', async () => {
    expect(await authorizeSocketUser(req({ userId: 'u2', authMethod: 'cloudflare' }, { 'cf-access-jwt-assertion': 'good' }), deps())).toBeNull();
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'cloudflare' }, { 'cf-access-jwt-assertion': 'bad' }), deps())).toBeNull();
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'cloudflare' }), deps())).toBeNull();
  });

  it('accepts an active direct sign-in session and refuses a disabled or email-less user', async () => {
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'google' }), deps())).toBe('u1');
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'google' }), deps({
      loadUser: vi.fn(async () => ({ ...USER, disabled_at: new Date() })),
    }))).toBeNull();
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'google' }), deps({
      loadUser: vi.fn(async () => ({ ...USER, email: null })),
    }))).toBeNull();
  });
});

describe('closeUserSockets', () => {
  function arrange() {
    const socket = (userId, sessionId, readyState = 1) => ({ userId, sessionId, readyState, close: vi.fn() });
    const sockets = {
      mine: socket('u1', 's1'),
      myOtherDevice: socket('u1', 's2'),
      closing: socket('u1', 's1', 3),
      someoneElse: socket('u2', 's3'),
      // Still in its session lookup: setupWebSocket has not set a userId yet.
      authenticating: socket(undefined, undefined),
    };
    return { sockets, wss: { clients: new Set(Object.values(sockets)) } };
  }

  it('closes only the open sockets of that user', async () => {
    const { sockets, wss } = arrange();
    closeUserSockets(wss, 'u1');
    await flush();
    expect(sockets.mine.close).toHaveBeenCalledWith(1008, 'Session ended');
    expect(sockets.myOtherDevice.close).toHaveBeenCalledWith(1008, 'Session ended');
    expect(sockets.closing.close).not.toHaveBeenCalled();
    expect(sockets.someoneElse.close).not.toHaveBeenCalled();
    expect(sockets.authenticating.close).not.toHaveBeenCalled();
  });

  it('closes only the sockets opened by the given session, with the given reason', async () => {
    const { sockets, wss } = arrange();
    closeUserSockets(wss, 'u1', { sessionId: 's1', reason: 'Locked' });
    await flush();
    expect(sockets.mine.close).toHaveBeenCalledWith(1008, 'Locked');
    expect(sockets.myOtherDevice.close).not.toHaveBeenCalled();
    expect(sockets.someoneElse.close).not.toHaveBeenCalled();
    expect(sockets.authenticating.close).not.toHaveBeenCalled();
  });

  it('closes nothing without a userId or without a server', async () => {
    const { sockets, wss } = arrange();
    closeUserSockets(wss, undefined);
    closeUserSockets(undefined, 'u1');
    await flush();
    for (const ws of Object.values(sockets)) expect(ws.close).not.toHaveBeenCalled();
  });

  it('waits a turn, so it also closes a socket that authenticates just after the call', async () => {
    const { sockets, wss } = arrange();
    closeUserSockets(wss, 'u1', { sessionId: 's1' });
    // An upgrade whose session lookup was answered in the same Redis read as the write that
    // ended the session authenticates a microtask after that write's callback.
    await Promise.resolve();
    Object.assign(sockets.authenticating, { userId: 'u1', sessionId: 's1' });
    await flush();
    expect(sockets.authenticating.close).toHaveBeenCalledWith(1008, 'Session ended');
  });
});

describe('a session that ends or locks while its socket is being authorized', () => {
  it('is not attached when its sockets are closed meanwhile', async () => {
    const { authorize, finish } = delayedAuthorize();
    const { ws, wss } = setup((_req, _res, next) => next(), { authorize });
    expect(ws).toMatchObject({ sessionId: 'sess-1', pendingUserId: 'u1' });
    closeUserSockets(wss, 'u1', { sessionId: 'sess-1', reason: 'Locked' });
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1008, 'Locked');
    // ws.close is a stub here, so the socket still reads as open: the revoked mark must hold.
    finish();
    await flush();
    expect(ws.userId).toBeUndefined();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('is refused as locked when the stored session locked meanwhile', async () => {
    const { authorize, finish } = delayedAuthorize();
    const { ws, store } = setup((_req, _res, next) => next(), { authorize });
    store.session = { userId: 'u1', locked: true };
    finish();
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1008, 'Locked');
    expect(ws.userId).toBeUndefined();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('is refused when the stored session was destroyed meanwhile', async () => {
    const { authorize, finish } = delayedAuthorize();
    const { ws, store } = setup((_req, _res, next) => next(), { authorize });
    store.session = null;
    finish();
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(ws.userId).toBeUndefined();
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('WebSocket session binding', () => {
  it('remembers the session that opened the socket, so ending that session can close it', async () => {
    const { ws } = setup((_req, _res, next) => next(), { authorize: async () => 'u1' });
    await flush();
    expect(ws).toMatchObject({ userId: 'u1', sessionId: 'sess-1' });
  });
});

describe('WebSocket origins', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('accepts APP_URL and APP_ALT_URLS origins and closes others', async () => {
    vi.resetModules();
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    vi.stubEnv('APP_ALT_URLS', 'https://direct.example.com');
    const { setupWebSocket: setupWithOrigins } = await import('./websocket.js');
    const connect = (origin) => {
      const wss = new EventEmitter();
      const ws = Object.assign(new EventEmitter(), {
        readyState: 1, close: vi.fn(), terminate: vi.fn(), send: vi.fn(),
      });
      // Session lookup never finishes: only the origin check runs.
      setupWithOrigins(wss, () => {});
      wss.emit('connection', ws, { headers: { origin } });
      return ws;
    };
    expect(connect('https://mail.example.com').close).not.toHaveBeenCalled();
    expect(connect('https://direct.example.com').close).not.toHaveBeenCalled();
    expect(connect('https://evil.example.com').close).toHaveBeenCalledWith(1008, 'Forbidden');
  });
});
