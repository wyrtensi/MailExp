import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { ADDRESS_LIMIT_FACTOR, createAuthRateLimit, limitedIdentity } from './authLimiter.js';

// An in-memory fixed window, enough to drive the middleware.
function memoryStore() {
  const counts = new Map();
  return {
    counts,
    consume: vi.fn(async (key, max) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { limited: count > max, resetMs: 60_000 };
    }),
    reset: vi.fn(async (key) => { counts.delete(key); }),
  };
}

async function hit(limiter, { ip, username }) {
  const req = { ip, body: username === undefined ? {} : { username } };
  const res = {
    locals: {}, statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
  };
  let passed = false;
  await limiter(req, res, () => { passed = true; });
  return { passed, res };
}

const CONFIG = { maxRequests: 3, windowMs: 60_000 };

describe('limitedIdentity', () => {
  it('trims and lower-cases, and ignores what is not a name', () => {
    expect(limitedIdentity('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(limitedIdentity('')).toBeNull();
    expect(limitedIdentity('   ')).toBeNull();
    expect(limitedIdentity(['a'])).toBeNull();
    expect(limitedIdentity(undefined)).toBeNull();
  });
});

describe('createAuthRateLimit', () => {
  it('limits failed sign-ins per account, so others on the same address still get in', async () => {
    const store = memoryStore();
    const limiter = createAuthRateLimit(CONFIG, { ...store, identity: (req) => limitedIdentity(req.body.username) });
    for (let i = 0; i < 3; i += 1) expect((await hit(limiter, { ip: '10.0.0.1', username: 'alice' })).passed).toBe(true);
    const blocked = await hit(limiter, { ip: '10.0.0.1', username: 'ALICE ' });
    expect(blocked.passed).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers['Retry-After']).toBe(60);
    // Same office address, another person.
    expect((await hit(limiter, { ip: '10.0.0.1', username: 'bob' })).passed).toBe(true);
    // The account stays limited from another address too.
    expect((await hit(limiter, { ip: '10.0.0.2', username: 'alice' })).passed).toBe(false);
  });

  it('still caps one address trying many accounts, at a looser limit', async () => {
    const store = memoryStore();
    const limiter = createAuthRateLimit(CONFIG, { ...store, identity: (req) => limitedIdentity(req.body.username) });
    const cap = CONFIG.maxRequests * ADDRESS_LIMIT_FACTOR;
    for (let i = 0; i < cap; i += 1) expect((await hit(limiter, { ip: '10.0.0.9', username: `user${i}` })).passed).toBe(true);
    expect((await hit(limiter, { ip: '10.0.0.9', username: 'fresh' })).passed).toBe(false);
    expect((await hit(limiter, { ip: '10.0.0.10', username: 'fresh2' })).passed).toBe(true);
  });

  it('resets only the account counter on success', async () => {
    const store = memoryStore();
    const limiter = createAuthRateLimit(CONFIG, { ...store, identity: (req) => limitedIdentity(req.body.username) });
    const { res } = await hit(limiter, { ip: '10.0.0.1', username: 'alice' });
    await res.locals.resetRateLimit();
    expect(store.reset).toHaveBeenCalledWith('auth:user:alice');
    expect(store.counts.get('auth:10.0.0.1')).toBe(1);
  });

  it('keys by address alone on routes that name no account', async () => {
    const store = memoryStore();
    const limiter = createAuthRateLimit(CONFIG, store);
    for (let i = 0; i < 3; i += 1) expect((await hit(limiter, { ip: '10.0.0.1' })).passed).toBe(true);
    expect((await hit(limiter, { ip: '10.0.0.1' })).passed).toBe(false);
    expect((await hit(limiter, { ip: '10.0.0.2' })).passed).toBe(true);
    expect(store.consume).toHaveBeenCalledWith('auth:10.0.0.1', 3, 60_000);
  });
});
