// The Google grant journal against PGlite with every migration: Google counts an unverified app's
// users for the whole life of its Cloud project, so deleting an app and adding a client of the same
// project again must find the seats already taken there.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null };
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc(') ? v.slice(4, -1) : v),
}));
vi.mock('../redis.js', () => ({
  redisClient: {
    zRemRangeByScore: async () => 0,
    zRange: async () => [],
  },
}));

const {
  createGoogleApp, deleteGoogleApp, findKnownGoogleEmails, listGoogleApps, recordGoogleGrant,
} = await import('./googleApps.js');
const { selectGoogleApp } = await import('./googleAppSelection.js');

const PROJECT = '123456789012';
const CLIENT_A = `${PROJECT}-aaa111.apps.googleusercontent.com`;
const CLIENT_B = `${PROJECT}-bbb222.apps.googleusercontent.com`;

let db;
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('DELETE FROM google_oauth_grants; DELETE FROM google_oauth_apps;');
});

describe('Google grant journal across app delete and re-add', () => {
  it('keeps the seats Google counted when an app of the same project is added again', async () => {
    const first = await createGoogleApp({ label: 'Google 1', clientId: CLIENT_A, clientSecret: 's', userLimit: 2 });
    await recordGoogleGrant({ appId: first.id, email: 'one@gmail.com', sub: 'sub-1' });
    await recordGoogleGrant({ appId: first.id, email: 'two@gmail.com', sub: 'sub-2' });
    await deleteGoogleApp(first.id);

    // While no app of that project exists, its addresses are not offered as connected before.
    await expect(findKnownGoogleEmails('gmail')).resolves.toEqual([]);

    const again = await createGoogleApp({ label: 'Google 1 again', clientId: CLIENT_B, clientSecret: 's', userLimit: 2 });
    const [listed] = await listGoogleApps();
    expect(listed).toMatchObject({ id: again.id, grants_count: 2 });
    await expect(findKnownGoogleEmails('gmail')).resolves.toEqual(['one@gmail.com', 'two@gmail.com']);

    // Full: a new address finds no seat, a counted one goes back without a new seat.
    await expect(selectGoogleApp({ email: 'new@gmail.com' })).rejects.toMatchObject({ code: 'no_app_capacity' });
    await expect(selectGoogleApp({ email: 'One@gmail.com' })).resolves.toEqual({ appId: again.id, reserved: false });
  });

  it('records a grant once per project and address', async () => {
    const app = await createGoogleApp({ label: 'Google 1', clientId: CLIENT_A, clientSecret: 's' });
    await recordGoogleGrant({ appId: app.id, email: 'One@gmail.com' });
    await recordGoogleGrant({ appId: app.id, email: 'one@gmail.com', sub: 'sub-1' });
    const { rows } = await db.query('SELECT project_number, email, google_sub FROM google_oauth_grants');
    expect(rows).toEqual([{ project_number: PROJECT, email: 'one@gmail.com', google_sub: 'sub-1' }]);
  });
});
