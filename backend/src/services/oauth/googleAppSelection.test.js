import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
// In-memory sorted sets with the node-redis 6 method names this module uses.
const zsets = vi.hoisted(() => new Map());
vi.mock('../redis.js', () => {
  const set = (key) => { if (!zsets.has(key)) zsets.set(key, new Map()); return zsets.get(key); };
  return {
    redisClient: {
      zAdd: vi.fn(async (key, { score, value }) => { set(key).set(value, score); return 1; }),
      zRem: vi.fn(async (key, value) => (set(key).delete(value) ? 1 : 0)),
      zScore: vi.fn(async (key, value) => set(key).get(value) ?? null),
      zCard: vi.fn(async (key) => set(key).size),
      zRange: vi.fn(async (key) => [...set(key).keys()]),
      zRemRangeByScore: vi.fn(async (key, _min, max) => {
        let removed = 0;
        for (const [member, score] of set(key)) if (score <= max) { set(key).delete(member); removed += 1; }
        return removed;
      }),
      expire: vi.fn(async () => true),
    },
  };
});

const { query, withTransaction } = await import('../db.js');
const {
  GoogleAppSelectionError, googleEmailDigest, countGoogleReservations,
  releaseGoogleSeat, selectGoogleApp, googleHasCapacity,
} = await import('./googleAppSelection.js');

const app = (id, extra = {}) => ({ id, status: 'active', user_limit: 100, grants: 0, granted: false, ...extra });
const key = (id) => `oauth:google:reservations:${id}`;

// The selection transaction runs the lock, then one query returning the apps.
function installApps(apps) {
  const client = {
    query: vi.fn(async (sql) => {
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/FROM google_oauth_apps/.test(sql)) return { rows: apps };
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  withTransaction.mockImplementation(async (fn) => fn(client));
  query.mockImplementation(async (sql) => {
    if (/FROM google_oauth_apps/.test(sql)) return { rows: apps };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return client;
}

beforeEach(() => {
  zsets.clear();
  query.mockReset();
  withTransaction.mockReset();
});

describe('selectGoogleApp', () => {
  it('serializes selection under the advisory lock', async () => {
    const client = installApps([app('a1')]);
    await selectGoogleApp({ email: 'x@gmail.com' });
    expect(client.query.mock.calls[0][0]).toMatch(/pg_advisory_xact_lock\(hashtext\('google-oauth-app-selection'\)\)/);
  });

  it('keeps a reconnecting mailbox on its own app while that app is not disabled', async () => {
    installApps([app('a1'), app('a2', { status: 'closed' })]);
    await expect(selectGoogleApp({ email: 'x@gmail.com', account: { oauth_app_id: 'a2' } }))
      .resolves.toEqual({ appId: 'a2', reserved: false });
  });

  it('moves a mailbox off a disabled app', async () => {
    installApps([app('a1', { status: 'disabled' }), app('a2')]);
    await expect(selectGoogleApp({ email: 'x@gmail.com', account: { oauth_app_id: 'a1' } }))
      .resolves.toEqual({ appId: 'a2', reserved: true, reservation: expect.any(String) });
  });

  it('reuses the app that already counted this email, spending no seat', async () => {
    installApps([app('a1'), app('a2', { status: 'closed', granted: true })]);
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).resolves.toEqual({ appId: 'a2', reserved: false });
    expect(zsets.get(key('a1'))?.size ?? 0).toBe(0);
  });

  it('reserves a seat in the first active app with room', async () => {
    installApps([app('a1', { user_limit: 2, grants: 2 }), app('a2')]);
    const selected = await selectGoogleApp({ email: 'X@Gmail.com' });
    expect(selected).toEqual({ appId: 'a2', reserved: true, reservation: expect.any(String) });
    expect(zsets.get(key('a2')).has(`${googleEmailDigest('x@gmail.com')}:${selected.reservation}`)).toBe(true);
  });

  it('counts live reservations as taken seats', async () => {
    installApps([app('a1', { user_limit: 1 }), app('a2')]);
    await selectGoogleApp({ email: 'first@gmail.com' });
    await expect(selectGoogleApp({ email: 'second@gmail.com' })).resolves.toMatchObject({ appId: 'a2', reserved: true });
  });

  it('a repeated start for the same email does not take a second seat', async () => {
    installApps([app('a1', { user_limit: 1 })]);
    await selectGoogleApp({ email: 'same@gmail.com' });
    await expect(selectGoogleApp({ email: 'same@gmail.com' })).resolves.toMatchObject({ appId: 'a1', reserved: true });
    await expect(countGoogleReservations('a1')).resolves.toBe(1);
  });

  it('gives every start its own reservation: a failed flow cannot free the seat another flow of that email holds', async () => {
    installApps([app('a1', { user_limit: 1 }), app('a2', { status: 'closed' })]);
    const first = await selectGoogleApp({ email: 'same@gmail.com' });
    const second = await selectGoogleApp({ email: 'same@gmail.com' });
    expect(first.reservation).not.toBe(second.reservation);

    // The first flow's callback fails before the grant is journaled and releases its reservation.
    await releaseGoogleSeat('a1', 'same@gmail.com', first.reservation);
    // The second flow is still in progress: its seat is not handed to another address.
    await expect(countGoogleReservations('a1')).resolves.toBe(1);
    await expect(selectGoogleApp({ email: 'other@gmail.com' })).rejects.toMatchObject({ code: 'no_app_capacity' });

    await releaseGoogleSeat('a1', 'same@gmail.com', second.reservation);
    await expect(selectGoogleApp({ email: 'other@gmail.com' })).resolves.toMatchObject({ appId: 'a1', reserved: true });
  });

  it('still counts and releases a reservation stored before reservations named their flow', async () => {
    installApps([app('a1', { user_limit: 1 })]);
    zsets.set(key('a1'), new Map([[googleEmailDigest('old@gmail.com'), Date.now() + 60_000]]));
    await expect(selectGoogleApp({ email: 'new@gmail.com' })).rejects.toMatchObject({ code: 'no_app_capacity' });
    await expect(selectGoogleApp({ email: 'old@gmail.com' })).resolves.toMatchObject({ appId: 'a1', reserved: true });
    await releaseGoogleSeat('a1', 'old@gmail.com');
    expect(zsets.get(key('a1')).has(googleEmailDigest('old@gmail.com'))).toBe(false);
  });

  it('ignores expired reservations', async () => {
    installApps([app('a1', { user_limit: 1 })]);
    zsets.set(key('a1'), new Map([[`${googleEmailDigest('old@gmail.com')}:r1`, Date.now() - 1]]));
    await expect(selectGoogleApp({ email: 'new@gmail.com' })).resolves.toMatchObject({ appId: 'a1', reserved: true });
  });

  it('never picks a closed app for a new email', async () => {
    installApps([app('a1', { status: 'closed' })]);
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).rejects.toMatchObject({ code: 'no_app_capacity' });
  });

  it('reports no_app_capacity when every active app is full', async () => {
    installApps([app('a1', { user_limit: 1, grants: 1 })]);
    const err = await selectGoogleApp({ email: 'x@gmail.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAppSelectionError);
    expect(err.code).toBe('no_app_capacity');
  });

  it('reports not_configured when there is no app or every app is disabled', async () => {
    installApps([]);
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).rejects.toMatchObject({ code: 'not_configured' });
    installApps([app('a1', { status: 'disabled' })]);
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('requires an email: every flow names the address it connects', async () => {
    installApps([app('a1')]);
    await expect(selectGoogleApp()).rejects.toThrow(TypeError);
    await expect(selectGoogleApp({ email: '' })).rejects.toThrow(TypeError);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('a repeated start for the same email keeps its app even when that app has no other free seat', async () => {
    installApps([app('a1', { user_limit: 1 }), app('a2')]);
    await selectGoogleApp({ email: 'x@gmail.com' });
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).resolves.toMatchObject({ appId: 'a1', reserved: true });
    await expect(countGoogleReservations('a1')).resolves.toBe(1);
    await expect(countGoogleReservations('a2')).resolves.toBe(0);
  });
});

describe('reservations', () => {
  it('stores only a hash of the email', async () => {
    installApps([app('a1')]);
    const { reservation } = await selectGoogleApp({ email: 'secret@gmail.com' });
    const members = [...zsets.get(key('a1')).keys()];
    expect(members).toEqual([`${googleEmailDigest('secret@gmail.com')}:${reservation}`]);
    expect(JSON.stringify(members)).not.toContain('secret');
  });

  it('releaseGoogleSeat frees the seat and tolerates missing input', async () => {
    installApps([app('a1')]);
    const { reservation } = await selectGoogleApp({ email: 'x@gmail.com' });
    await releaseGoogleSeat('a1', 'X@gmail.com', reservation);
    await expect(countGoogleReservations('a1')).resolves.toBe(0);
    await expect(releaseGoogleSeat(null, 'x@gmail.com')).resolves.toBeUndefined();
    await expect(releaseGoogleSeat('a1', null)).resolves.toBeUndefined();
  });
});

describe('googleHasCapacity', () => {
  it('is true only when an active app has a free seat', async () => {
    installApps([app('a1', { user_limit: 1, grants: 1 }), app('a2', { status: 'closed' })]);
    await expect(googleHasCapacity()).resolves.toBe(false);
    installApps([app('a1', { user_limit: 1, grants: 1 }), app('a2')]);
    await expect(googleHasCapacity()).resolves.toBe(true);
  });
});
