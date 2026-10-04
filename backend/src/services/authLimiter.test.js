import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import {
  ACCOUNT_LIMIT_FACTOR, ADDRESS_LIMIT_FACTOR, createAuthRateLimit, createLoginLimit, limitedIdentity,
} from './authLimiter.js';

// An in-memory fixed window with the rate limiter's three calls.
function memoryStore() {
  const counts = new Map();
  return {
    counts,
    consume: vi.fn(async (key, max) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { limited: count > max, resetMs: 60_000 };
    }),
    peek: vi.fn(async (key, max) => ({ limited: (counts.get(key) ?? 0) >= max, resetMs: 60_000 })),
    reset: vi.fn(async (key) => { counts.delete(key); }),
  };
}

function fakeRes() {
  return {
    locals: {}, statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
  };
}

async function hit(limiter, { ip, username, session }) {
  const req = { ip, body: username === undefined ? {} : { username }, session: session ?? {} };
  const res = fakeRes();
  let passed = false;
  await limiter(req, res, () => { passed = true; });
  return { passed, res };
}

const CONFIG = { maxRequests: 3, windowMs: 60_000 };
const identity = (req) => limitedIdentity(req.body.username);

// A sign-in attempt that passes the limiter, then fails (wrong password) or succeeds.
async function signIn(limiter, opts, { ok }) {
  const result = await hit(limiter, opts);
  if (!result.passed) return result;
  if (ok) await result.res.locals.resetRateLimit?.();
  else await result.res.locals.recordAuthFailure();
  return result;
}

describe('limitedIdentity', () => {
  it('trims and lower-cases, and ignores what is not a name', () => {
    expect(limitedIdentity('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(limitedIdentity('')).toBeNull();
    expect(limitedIdentity('   ')).toBeNull();
    expect(limitedIdentity(['a'])).toBeNull();
    expect(limitedIdentity(undefined)).toBeNull();
  });
});

describe('createLoginLimit', () => {
  const make = (store, extra = {}) => createLoginLimit(CONFIG, { ...store, purpose: 'login', identity, ...extra });

  it('never counts successful sign-ins, however many come from one address', async () => {
    const store = memoryStore();
    const limiter = make(store);
    for (let i = 0; i < 50; i += 1) {
      expect((await signIn(limiter, { ip: '10.0.0.1', username: `user${i % 5}` }, { ok: true })).passed).toBe(true);
    }
    expect(store.consume).not.toHaveBeenCalled();
  });

  it('does not lock an account that is only named, without a failed password', async () => {
    const store = memoryStore();
    const limiter = make(store);
    for (let i = 0; i < 20; i += 1) expect((await hit(limiter, { ip: `10.0.1.${i}`, username: 'admin' })).passed).toBe(true);
  });

  it('holds an account after the limit of failures from one address, others there still sign in', async () => {
    const store = memoryStore();
    const limiter = make(store);
    for (let i = 0; i < 3; i += 1) await signIn(limiter, { ip: '10.0.0.1', username: 'alice' }, { ok: false });
    const blocked = await hit(limiter, { ip: '10.0.0.1', username: 'ALICE ' });
    expect(blocked.passed).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers['Retry-After']).toBe(60);
    expect((await hit(limiter, { ip: '10.0.0.1', username: 'bob' })).passed).toBe(true);
    // The same account from another address is not held by that address's failures.
    expect((await hit(limiter, { ip: '10.0.0.2', username: 'alice' })).passed).toBe(true);
  });

  it('holds an account after many more failures from many addresses', async () => {
    const store = memoryStore();
    const limiter = make(store);
    const cap = CONFIG.maxRequests * ACCOUNT_LIMIT_FACTOR;
    for (let i = 0; i < cap; i += 1) await signIn(limiter, { ip: `10.1.0.${i}`, username: 'alice' }, { ok: false });
    expect((await hit(limiter, { ip: '10.9.9.9', username: 'alice' })).passed).toBe(false);
  });

  it('lets a trusted device of the account through the account limits, not the address cap', async () => {
    const store = memoryStore();
    const isTrustedDevice = vi.fn(async (_req, account) => account === 'alice');
    const limiter = make(store, { isTrustedDevice });
    const cap = CONFIG.maxRequests * ACCOUNT_LIMIT_FACTOR;
    for (let i = 0; i < cap; i += 1) await signIn(limiter, { ip: `10.1.0.${i}`, username: 'alice' }, { ok: false });
    expect((await hit(limiter, { ip: '10.9.9.9', username: 'alice' })).passed).toBe(true);
    expect(isTrustedDevice).toHaveBeenCalledWith(expect.anything(), 'alice');

    const sprayer = memoryStore();
    const sprayLimiter = make(sprayer, { isTrustedDevice: async () => true });
    for (let i = 0; i < CONFIG.maxRequests * ADDRESS_LIMIT_FACTOR; i += 1) {
      await signIn(sprayLimiter, { ip: '10.0.0.9', username: `user${i}` }, { ok: false });
    }
    expect((await hit(sprayLimiter, { ip: '10.0.0.9', username: 'alice' })).passed).toBe(false);
  });

  it('caps one address failing on many accounts', async () => {
    const store = memoryStore();
    const limiter = make(store);
    for (let i = 0; i < CONFIG.maxRequests * ADDRESS_LIMIT_FACTOR; i += 1) {
      await signIn(limiter, { ip: '10.0.0.9', username: `user${i}` }, { ok: false });
    }
    expect((await hit(limiter, { ip: '10.0.0.9', username: 'fresh' })).passed).toBe(false);
    expect((await hit(limiter, { ip: '10.0.0.10', username: 'fresh' })).passed).toBe(true);
  });

  it('clears only the account-from-this-address counter on success', async () => {
    const store = memoryStore();
    const limiter = make(store);
    await signIn(limiter, { ip: '10.0.0.1', username: 'alice' }, { ok: false });
    await signIn(limiter, { ip: '10.0.0.1', username: 'alice' }, { ok: true });
    expect(store.reset).toHaveBeenCalledWith('auth:login-acct-ip:alice|10.0.0.1');
    expect(store.counts.get('auth:login-ip:10.0.0.1')).toBe(1);
    expect(store.counts.get('auth:login-acct:alice')).toBe(1);
  });
});

describe('createAuthRateLimit', () => {
  it('needs a purpose', () => {
    expect(() => createAuthRateLimit(CONFIG, { ...memoryStore() })).toThrow();
  });

  it('keys a step by its pending sign-in, with a looser cap for the address', async () => {
    const store = memoryStore();
    const limiter = createAuthRateLimit(CONFIG, { ...store, purpose: '2fa', identity: (req) => req.session.pendingUserId });
    for (let i = 0; i < 3; i += 1) expect((await hit(limiter, { ip: '10.0.0.1', session: { pendingUserId: 'u1' } })).passed).toBe(true);
    expect((await hit(limiter, { ip: '10.0.0.1', session: { pendingUserId: 'u1' } })).passed).toBe(false);
    expect((await hit(limiter, { ip: '10.0.0.1', session: { pendingUserId: 'u2' } })).passed).toBe(true);
    expect(store.consume).toHaveBeenCalledWith('auth:2fa-acct:u1', 3, 60_000);
    expect(store.consume).toHaveBeenCalledWith('auth:2fa-ip:10.0.0.1', 3 * ADDRESS_LIMIT_FACTOR, 60_000);
  });

  it('keys by address alone on routes that name nobody', async () => {
    const store = memoryStore();
    const limiter = createAuthRateLimit(CONFIG, { ...store, purpose: 'register' });
    for (let i = 0; i < 3; i += 1) expect((await hit(limiter, { ip: '10.0.0.1' })).passed).toBe(true);
    expect((await hit(limiter, { ip: '10.0.0.1' })).passed).toBe(false);
    expect((await hit(limiter, { ip: '10.0.0.2' })).passed).toBe(true);
  });
});

// The probe: an office NAT where many people sign in correctly, then take their 2FA step.
describe('purposes never share a counter', () => {
  it('lets the 2FA step through after many successful sign-ins from one address', async () => {
    const store = memoryStore();
    const login = createLoginLimit(CONFIG, { ...store, purpose: 'login', identity });
    const twoFactor = createAuthRateLimit(CONFIG, { ...store, purpose: '2fa', identity: (req) => req.session.pendingUserId });
    for (let i = 0; i < 11; i += 1) {
      expect((await signIn(login, { ip: '10.0.0.1', username: `user${i}` }, { ok: true })).passed).toBe(true);
      expect((await hit(twoFactor, { ip: '10.0.0.1', session: { pendingUserId: `u${i}` } })).passed).toBe(true);
    }
  });

  it('a successful 2FA step clears nothing of the sign-in counters', async () => {
    const store = memoryStore();
    const login = createLoginLimit(CONFIG, { ...store, purpose: 'login', identity });
    const twoFactor = createAuthRateLimit(CONFIG, { ...store, purpose: '2fa', identity: (req) => req.session.pendingUserId });
    await signIn(login, { ip: '10.0.0.1', username: 'mallory' }, { ok: false });
    const step = await hit(twoFactor, { ip: '10.0.0.1', session: { pendingUserId: 'u1' } });
    await step.res.locals.resetRateLimit();
    expect(store.counts.get('auth:login-ip:10.0.0.1')).toBe(1);
    expect(store.reset).toHaveBeenCalledWith('auth:2fa-acct:u1');
  });

  it('asking for password reset links never holds the sign-in', async () => {
    const store = memoryStore();
    const login = createLoginLimit(CONFIG, { ...store, purpose: 'login', identity });
    const forgot = createAuthRateLimit(CONFIG, { ...store, purpose: 'forgot', identity: (req) => limitedIdentity(req.body.username) });
    for (let i = 0; i < 10; i += 1) await hit(forgot, { ip: `10.2.0.${i}`, username: 'alice' });
    expect((await hit(login, { ip: '10.0.0.1', username: 'alice' })).passed).toBe(true);
  });
});
