import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The pin operations of PATCH /auth/preferences against real Postgres SQL: pinAccount and
// unpinAccount change the stored list atomically, so a client holding a stale list cannot
// overwrite a pin made elsewhere.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params), pool: {} }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 10, windowMs: 900000 } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ getGlobalCategorizationEnabled: vi.fn(async () => true) }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(), reset: vi.fn() }));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { patchPreferences, getPreferences } = await import('./auth.js');
const { MAX_PINNED_ACCOUNTS } = await import('../utils/accountPrefs.js');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = '70000000-0000-4000-8000-000000000001';

let db;
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

beforeEach(async () => {
  await db.exec('DELETE FROM email_accounts; DELETE FROM users;');
  await db.query(`INSERT INTO users (id, username, preferences) VALUES ($1, 'pin-user', '{}')`, [USER]);
});

const patch = async (body) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await patchPreferences({ session: { userId: USER }, body }, res);
  return res;
};
const pins = async () => (await db.query('SELECT preferences FROM users WHERE id = $1', [USER])).rows[0].preferences.pinnedAccounts;

describe('pin operations', () => {
  it('pinAccount appends to the stored list, in pin order, once', async () => {
    await patch({ pinAccount: id(1) });
    await patch({ pinAccount: id(2) });
    await patch({ pinAccount: id(1) });
    expect(await pins()).toEqual([id(1), id(2)]);
  });

  it('a stale tab pinning another mailbox does not overwrite a pin made elsewhere', async () => {
    await patch({ pinAccount: id(1) });          // device A
    await patch({ pinAccount: id(2) });          // device B, which never saw id(1)
    expect(await pins()).toEqual([id(1), id(2)]);
  });

  it('unpinAccount removes just that id and keeps the order of the rest', async () => {
    await patch({ pinnedAccounts: [id(3), id(1), id(2)] });
    await patch({ unpinAccount: id(1) });
    expect(await pins()).toEqual([id(3), id(2)]);
    await patch({ unpinAccount: id(9) });
    expect(await pins()).toEqual([id(3), id(2)]);
    await patch({ unpinAccount: id(3) });
    await patch({ unpinAccount: id(2) });
    expect(await pins()).toEqual([]);
  });

  it('the first pin works on preferences that never had the key', async () => {
    expect(await pins()).toBeUndefined();
    await patch({ pinAccount: id(5) });
    expect(await pins()).toEqual([id(5)]);
  });

  it('stops growing at the cap', async () => {
    await patch({ pinnedAccounts: Array.from({ length: MAX_PINNED_ACCOUNTS }, (_, i) => id(i + 1)) });
    await patch({ pinAccount: id(5000) });
    expect((await pins()).length).toBe(MAX_PINNED_ACCOUNTS);
    expect(await pins()).not.toContain(id(5000));
  });

  it('GET drops pins of mailboxes that no longer exist', async () => {
    await db.query(`INSERT INTO email_accounts (id, name, email_address, imap_host) VALUES ($1, 'A', 'a@pin.test', 'h')`, [id(1)]);
    await patch({ pinnedAccounts: [id(2), id(1)] });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getPreferences({ session: { userId: USER } }, res);
    expect(res.json.mock.calls[0][0].pinnedAccounts).toEqual([id(1)]);
  });
});
