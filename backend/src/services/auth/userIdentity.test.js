import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../accessSync/settings.js', () => ({ isAccessSyncEnabled: vi.fn() }));

const { query, withTransaction } = await import('../db.js');
const { isAccessSyncEnabled } = await import('../accessSync/settings.js');
const {
  UserIdentityError,
  bindSessionUser,
  claimOrCreateUserByEmail,
  findUserByEmail,
  loadUserById,
  normalizeEmail,
  resolveVerifiedUser,
} = await import('./userIdentity.js');

const USER = {
  id: 'u1', username: 'user@example.com', email: 'user@example.com',
  is_admin: false, disabled_at: null, created_at: new Date('2026-09-15T00:00:00Z'),
};
const settings = (emails = []) => ({ bootstrapAdminEmails: new Set(emails) });

// Transaction client that routes SQL by pattern and records every call.
function scriptedClient(handlers) {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push([sql, params]);
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  return { client, calls };
}

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  isAccessSyncEnabled.mockReset().mockResolvedValue(false);
});

describe('normalizeEmail', () => {
  it('trims and lower-cases an address', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });

  it.each([['empty', ''], ['no at sign', 'user'], ['a space', 'us er@example.com'], ['a number', 42], ['too long', `${'a'.repeat(250)}@x.io`]])(
    'rejects %s', (_label, value) => {
      expect(normalizeEmail(value)).toBeNull();
    },
  );
});

describe('user lookups', () => {
  it('loads a user by id and skips the query without one', async () => {
    query.mockResolvedValue({ rows: [USER] });
    expect(await loadUserById('u1')).toEqual(USER);
    expect(query.mock.calls[0][0]).toMatch(/FROM users WHERE id = \$1/);

    query.mockClear();
    expect(await loadUserById(undefined)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('finds a user by lower-cased email', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await findUserByEmail('user@example.com')).toBeNull();
    expect(query.mock.calls[0][0]).toMatch(/FROM users WHERE lower\(email\) = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['user@example.com']);
  });
});

describe('claimOrCreateUserByEmail', () => {
  const lock = [/pg_advisory_xact_lock/, { rows: [] }];

  it('returns the user that already has the address, under a per-address lock', async () => {
    const { client, calls } = scriptedClient([lock, [/WHERE lower\(email\) = \$1/, { rows: [USER] }]]);
    expect(await claimOrCreateUserByEmail(client, 'user@example.com')).toEqual({ user: USER, created: false, claimed: false });
    expect(calls[0][1]).toEqual(['user-email:user@example.com']);
  });

  it('gives the address to a legacy user whose username it is', async () => {
    const { client, calls } = scriptedClient([
      lock,
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [USER] }],
    ]);
    expect(await claimOrCreateUserByEmail(client, 'user@example.com')).toEqual({ user: USER, created: false, claimed: true });
    expect(calls[2][0]).toMatch(/email IS NULL AND lower\(username\) = \$1/);
  });

  it('creates a passwordless user named by the address', async () => {
    const { client, calls } = scriptedClient([
      lock,
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [] }],
      [/^\s*INSERT INTO users/, { rows: [{ ...USER, is_admin: true }] }],
    ]);
    expect(await claimOrCreateUserByEmail(client, 'user@example.com', { isAdmin: true }))
      .toEqual({ user: { ...USER, is_admin: true }, created: true, claimed: false });
    expect(calls[3][0]).toMatch(/INSERT INTO users \(username, email, is_admin\) VALUES \(\$1, \$1, \$2\)/);
    expect(calls[3][1]).toEqual(['user@example.com', true]);
  });

  it('reports a username that belongs to another address', async () => {
    const { client } = scriptedClient([
      lock,
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [] }],
      [/^\s*INSERT INTO users/, () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); }],
    ]);
    const err = await claimOrCreateUserByEmail(client, 'user@example.com').catch((e) => e);
    expect(err).toBeInstanceOf(UserIdentityError);
    expect(err.code).toBe('username_taken');
  });
});

describe('resolveVerifiedUser', () => {
  it('signs in a known active user without a transaction', async () => {
    query.mockResolvedValue({ rows: [USER] });
    expect(await resolveVerifiedUser({ email: 'User@Example.com', source: 'google', settings: settings() })).toEqual({ user: USER });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('refuses a disabled user', async () => {
    query.mockResolvedValue({ rows: [{ ...USER, disabled_at: new Date() }] });
    expect(await resolveVerifiedUser({ email: 'user@example.com', source: 'cloudflare', settings: settings() }))
      .toEqual({ error: 'user_disabled' });
  });

  it('refuses an unknown address on direct sign-in and an invalid address anywhere', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await resolveVerifiedUser({ email: 'new@example.com', source: 'google', settings: settings() }))
      .toEqual({ error: 'not_allowed' });
    expect(await resolveVerifiedUser({ email: 'not an email', source: 'cloudflare', settings: settings() }))
      .toEqual({ error: 'not_allowed' });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('creates an account for a new Cloudflare Access identity while the sync is off', async () => {
    query.mockResolvedValue({ rows: [] });
    isAccessSyncEnabled.mockResolvedValue(false);
    const { client } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [] }],
      [/^\s*INSERT INTO users/, { rows: [{ ...USER, email: 'new@example.com' }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await resolveVerifiedUser({ email: 'new@example.com', source: 'cloudflare', settings: settings() }))
      .toEqual({ user: { ...USER, email: 'new@example.com' } });
  });

  it('refuses an unknown Cloudflare identity while the Access sync is on', async () => {
    query.mockResolvedValue({ rows: [] });
    isAccessSyncEnabled.mockResolvedValue(true);
    expect(await resolveVerifiedUser({ email: 'new@example.com', source: 'cloudflare', settings: settings() }))
      .toEqual({ error: 'not_allowed' });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('still creates a bootstrap admin on Cloudflare sign-in while the Access sync is on', async () => {
    query.mockResolvedValue({ rows: [] });
    isAccessSyncEnabled.mockResolvedValue(true);
    const { client } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [] }],
      [/^\s*INSERT INTO users/, { rows: [{ ...USER, is_admin: true }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await resolveVerifiedUser({ email: 'user@example.com', source: 'cloudflare', settings: settings(['user@example.com']) }))
      .toEqual({ user: { ...USER, is_admin: true } });
  });

  it('returns a known active user without reading the Access sync setting', async () => {
    query.mockResolvedValue({ rows: [USER] });
    expect(await resolveVerifiedUser({ email: 'user@example.com', source: 'cloudflare', settings: settings() }))
      .toEqual({ user: USER });
    expect(isAccessSyncEnabled).not.toHaveBeenCalled();
  });

  it('creates and promotes a bootstrap admin on direct sign-in', async () => {
    query.mockResolvedValue({ rows: [USER] });
    const { client, calls } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [USER] }],
      [/^\s*UPDATE users SET is_admin = true/, { rows: [{ ...USER, is_admin: true }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await resolveVerifiedUser({ email: 'user@example.com', source: 'google', settings: settings(['user@example.com']) }))
      .toEqual({ user: { ...USER, is_admin: true } });
    expect(calls.at(-1)[1]).toEqual(['u1']);
  });

  it('refuses an address whose username is taken by another user', async () => {
    query.mockResolvedValue({ rows: [] });
    const { client } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [] }],
      [/^\s*INSERT INTO users/, () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await resolveVerifiedUser({ email: 'new@example.com', source: 'cloudflare', settings: settings() }))
      .toEqual({ error: 'not_allowed' });
  });
});

describe('bindSessionUser', () => {
  const session = (data) => {
    const s = { ...data };
    s.regenerate = vi.fn((cb) => {
      for (const key of Object.keys(s)) if (typeof s[key] !== 'function') delete s[key];
      cb();
    });
    return s;
  };

  it('keeps the session id for the same user and method', async () => {
    const req = { session: session({ userId: 'u1', authMethod: 'cloudflare' }) };
    await bindSessionUser(req, USER, 'cloudflare');
    expect(req.session.regenerate).not.toHaveBeenCalled();
    expect(req.session).toMatchObject({ userId: 'u1', username: 'user@example.com', isAdmin: false, authMethod: 'cloudflare' });
  });

  it('keeps the screen lock when the same user switches sign-in method', async () => {
    const req = { session: session({ userId: 'u1', authMethod: 'google', locked: true }) };
    await bindSessionUser(req, USER, 'cloudflare');
    expect(req.session.regenerate).toHaveBeenCalledOnce();
    expect(req.session).toMatchObject({ userId: 'u1', authMethod: 'cloudflare', locked: true });
  });

  it('starts a new session for another user or method', async () => {
    const req = { session: session({ userId: 'u2', authMethod: 'google', locked: true }) };
    await bindSessionUser(req, USER, 'google');
    expect(req.session.regenerate).toHaveBeenCalledOnce();
    expect(req.session.locked).toBeUndefined();
    expect(req.session).toMatchObject({ userId: 'u1', authMethod: 'google' });
  });
});
