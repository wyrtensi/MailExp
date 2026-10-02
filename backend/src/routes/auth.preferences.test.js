import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({ imapManager: {} }));
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
vi.mock('../services/authLimiter.js', () => ({
  authLimiterConfig: { maxRequests: 10, windowMs: 900000 },
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ getGlobalCategorizationEnabled: vi.fn(async () => true) }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(),
  reset: vi.fn(),
}));

import { query } from '../services/db.js';
import { getPreferences, patchPreferences } from './auth.js';

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
});

describe('PATCH /auth/preferences folderOrder', () => {
  it('merges folderOrder into existing preferences as JSONB', async () => {
    const folderOrder = { 'account-1': ['Archive', 'INBOX'] };
    const req = { session: { userId: 'user-1' }, body: { folderOrder } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await patchPreferences(req, res);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('SET preferences = preferences');
    expect(sql).toContain(
      "jsonb_build_object('folderOrder', $36::jsonb)",
    );
    expect(params[0]).toBe('user-1');
    expect(params[35]).toBe(JSON.stringify(folderOrder));
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

describe('PATCH /auth/preferences senderFavicons', () => {
  it('merges the senderFavicons boolean into preferences as JSONB', async () => {
    const req = { session: { userId: 'user-1' }, body: { senderFavicons: true } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await patchPreferences(req, res);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(
      "jsonb_build_object('senderFavicons', $37::boolean)",
    );
    expect(params[0]).toBe('user-1');
    expect(params[36]).toBe(true);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects a non-boolean senderFavicons without querying', async () => {
    const req = { session: { userId: 'user-1' }, body: { senderFavicons: 'yes' } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await patchPreferences(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'senderFavicons must be a boolean' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('PATCH /auth/preferences themeFollowsSystem (#508)', () => {
  it('merges the themeFollowsSystem boolean into preferences as JSONB', async () => {
    const req = { session: { userId: 'user-1' }, body: { themeFollowsSystem: true } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await patchPreferences(req, res);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(
      "jsonb_build_object('themeFollowsSystem', $41::boolean)",
    );
    expect(params[0]).toBe('user-1');
    expect(params[40]).toBe(true);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('stores an explicit false the same way (turning the checkbox off)', async () => {
    const req = { session: { userId: 'user-1' }, body: { themeFollowsSystem: false } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await patchPreferences(req, res);

    expect(query.mock.calls[0][1][40]).toBe(false);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects a non-boolean themeFollowsSystem without querying', async () => {
    const req = { session: { userId: 'user-1' }, body: { themeFollowsSystem: 'yes' } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await patchPreferences(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'themeFollowsSystem must be a boolean' });
    expect(query).not.toHaveBeenCalled();
  });

  it('leaves the stored value untouched when the key is absent', async () => {
    const req = { session: { userId: 'user-1' }, body: { theme: 'dusk' } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await patchPreferences(req, res);

    expect(query.mock.calls[0][1][40]).toBeNull();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

describe('PATCH /auth/preferences defaultSender (#417)', () => {
  const run = async (body) => {
    const req = { session: { userId: 'user-1' }, body };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await patchPreferences(req, res);
    return res;
  };
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('persists an account default', async () => {
    const res = await run({ defaultSender: `account:${A}` });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("jsonb_build_object('defaultSender', $39::text)");
    expect(params[38]).toBe(`account:${A}`);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('persists an alias default, so an identity can be the default and not just an account', async () => {
    await run({ defaultSender: `alias:${A}:${B}` });
    expect(query.mock.calls[0][1][38]).toBe(`alias:${A}:${B}`);
  });

  it('persists an empty string, which is how the preference is cleared', async () => {
    // '' is meaningful: it means "no preference, fall back to last used". It must be
    // written rather than treated as an absent key, or clearing would silently no-op.
    await run({ defaultSender: '' });
    expect(query.mock.calls[0][1][38]).toBe('');
  });

  it('leaves the stored value untouched when the key is absent', async () => {
    await run({ theme: 'dark' });
    expect(query.mock.calls[0][1][38]).toBe(null);
  });

  it('rejects malformed values instead of storing something unusable', async () => {
    for (const bad of ['account:not-a-uuid', 'alias:only-one', `alias:${A}`, 'nonsense',
                       `ACCOUNT:${A}`, 42, {}, [], `account:${A} extra`]) {
      query.mockClear();
      const res = await run({ defaultSender: bad });
      expect(res.status, `${JSON.stringify(bad)} should be rejected`).toHaveBeenCalledWith(400);
      expect(query).not.toHaveBeenCalled();
    }
  });
});

describe('sync intervals are install-wide', () => {
  it('PATCH ignores the old per-user interval fields', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await patchPreferences({ session: { userId: 'user-1' }, body: { syncInterval: '15', folderSyncInterval: '0' } }, res);
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/syncInterval|folderSyncInterval/);
    expect(params).toHaveLength(45);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('PATCH ignores the old per-user categorization switch', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await patchPreferences({ session: { userId: 'user-1' }, body: { categorizationEnabled: true } }, res);
    expect(query.mock.calls[0][0]).not.toContain('categorizationEnabled');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('GET reports the install-wide message interval over a stale personal value', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT preferences')) return { rows: [{ preferences: { theme: 'dark', syncInterval: '15' } }] };
      if (sql.includes('key = ANY')) return { rows: [{ key: 'sync_interval_sec', value: '120' }] };
      return { rows: [] };
    });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getPreferences({ session: { userId: 'user-1' } }, res);
    expect(res.json).toHaveBeenCalledWith({ theme: 'dark', syncInterval: 120, categorizationEnabled: true });
  });
});

describe('PATCH /auth/preferences hoverActionSet (#440)', () => {
  const call = async (body) => {
    const req = { session: { userId: 'user-1' }, body };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await patchPreferences(req, res);
    return { req, res };
  };

  it('merges a sanitized set into preferences as JSONB, canonical order, unknown keys dropped', async () => {
    // The frontend saves through schedulePrefSave like every other preference; without this
    // clause the key is silently dropped server-side and the setting never syncs across
    // devices — localStorage makes it LOOK persisted on the device that set it.
    const { res } = await call({ hoverActionSet: ['snooze', 'bogus', 'archive'] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("jsonb_build_object('hoverActionSet', $40::jsonb)");
    expect(params[39]).toBe(JSON.stringify(['archive', 'snooze'])); // canonical order, 'bogus' gone
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('leaves the stored value untouched when the key is absent or malformed', async () => {
    await call({ theme: 'dark' });
    expect(query.mock.calls[0][1][39]).toBeNull();
    query.mockClear();
    await call({ hoverActionSet: 'markRead' }); // not an array — ignored, not stored
    expect(query.mock.calls[0][1][39]).toBeNull();
  });
});

describe('PATCH /auth/preferences pinnedAccounts', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const call = async (body) => {
    const req = { session: { userId: 'user-1' }, body };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await patchPreferences(req, res);
    return res;
  };

  it('merges the pin list into preferences as JSONB, in pin order', async () => {
    const res = await call({ pinnedAccounts: [B, A] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("jsonb_build_object('pinnedAccounts', $42::jsonb)");
    expect(params[41]).toBe(JSON.stringify([B, A]));
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('stores only account ids, once each', async () => {
    await call({ pinnedAccounts: [A, 'junk', 7, A, B, { id: A }] });
    expect(query.mock.calls[0][1][41]).toBe(JSON.stringify([A, B]));
  });

  it('stores an empty list, which is how the last pin is removed', async () => {
    await call({ pinnedAccounts: [] });
    expect(query.mock.calls[0][1][41]).toBe('[]');
  });

  it('leaves the stored list untouched when the key is absent', async () => {
    await call({ theme: 'dark' });
    expect(query.mock.calls[0][1][41]).toBeNull();
    expect(query.mock.calls[0][1][43]).toBeNull();
    expect(query.mock.calls[0][1][44]).toBeNull();
  });

  it('rejects a list that is not an array without querying, like a bad sort switch', async () => {
    for (const bad of [A, null, {}, 7, 'x']) {
      query.mockClear();
      const res = await call({ pinnedAccounts: bad });
      expect(res.status, JSON.stringify(bad)).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'pinnedAccounts must be an array of account ids' });
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('pins one id with an atomic append, lower-cased', async () => {
    await call({ pinAccount: A.toUpperCase() });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("jsonb_build_object('pinnedAccounts'");
    expect(sql).toContain('$44::text');
    expect(params[43]).toBe(A);
    expect(params[44]).toBeNull();
    expect(params[41]).toBeNull();
  });

  it('unpins one id with an atomic removal', async () => {
    await call({ unpinAccount: B });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('$45::text');
    expect(params[44]).toBe(B);
    expect(params[43]).toBeNull();
  });

  it('rejects a malformed id, or both operations at once, without querying', async () => {
    for (const body of [{ pinAccount: 'nope' }, { unpinAccount: 5 }, { pinAccount: null }, { pinAccount: A, unpinAccount: B }]) {
      query.mockClear();
      const res = await call(body);
      expect(res.status, JSON.stringify(body)).toHaveBeenCalledWith(400);
      expect(query).not.toHaveBeenCalled();
    }
  });
});

describe('PATCH /auth/preferences sortAccountsByLatest', () => {
  const call = async (body) => {
    const req = { session: { userId: 'user-1' }, body };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await patchPreferences(req, res);
    return res;
  };

  it('merges the boolean into preferences as JSONB, true and false alike', async () => {
    await call({ sortAccountsByLatest: false });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("jsonb_build_object('sortAccountsByLatest', $43::boolean)");
    expect(params[42]).toBe(false);
    query.mockClear();
    await call({ sortAccountsByLatest: true });
    expect(query.mock.calls[0][1][42]).toBe(true);
  });

  it('rejects a non-boolean without querying', async () => {
    const res = await call({ sortAccountsByLatest: 'yes' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'sortAccountsByLatest must be a boolean' });
    expect(query).not.toHaveBeenCalled();
  });

  it('leaves the stored value untouched when the key is absent', async () => {
    await call({ theme: 'dark' });
    expect(query.mock.calls[0][1][42]).toBeNull();
  });
});

describe('GET /auth/preferences pinnedAccounts', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const GONE = '33333333-3333-4333-8333-333333333333';

  it('drops the pins of mailboxes that no longer exist, keeping the pin order', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT preferences')) return { rows: [{ preferences: { pinnedAccounts: [B, GONE, A] } }] };
      if (sql.includes('FROM email_accounts')) return { rows: [{ id: A }, { id: B }] };
      return { rows: [] };
    });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getPreferences({ session: { userId: 'user-1' } }, res);
    expect(res.json.mock.calls[0][0].pinnedAccounts).toEqual([B, A]);
    const lookup = query.mock.calls.find(([sql]) => sql.includes('FROM email_accounts'));
    expect(lookup[1]).toEqual([[B, GONE, A]]);
  });

  it('asks nothing about mailboxes when nothing is pinned', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT preferences')) return { rows: [{ preferences: { pinnedAccounts: [] } }] };
      return { rows: [] };
    });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getPreferences({ session: { userId: 'user-1' } }, res);
    expect(res.json.mock.calls[0][0].pinnedAccounts).toEqual([]);
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM email_accounts'))).toBe(false);
  });

  it('cleans a stored value that is not a list of ids', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT preferences')) return { rows: [{ preferences: { pinnedAccounts: ['junk', 3] } }] };
      return { rows: [] };
    });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getPreferences({ session: { userId: 'user-1' } }, res);
    expect(res.json.mock.calls[0][0].pinnedAccounts).toEqual([]);
  });
});
