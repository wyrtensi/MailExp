import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The Access sync's settings and state are written by two processes: the backend (screen, runs) and
// the panel CLI. On PGlite with every migration, a second writer is started in the middle of a
// read-then-write (the test hooks of runner.js and settings.js updateConfig) and the outcome must
// be as if the two had run one after the other.

const dbState = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
  return { db: null };
});
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => {} },
}));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn() }));

const { createRealSchemaDb } = await import('../testing/realSchema.js');
const { loadState, loadStoredConfig, saveConfig, updateConfig } = await import('./settings.js');
const { runAccessSync } = await import('./runner.js');

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const OTHER_POLICY = '66666666-7777-4888-9999-000000000001';
let db;

const pause = () => new Promise((resolve) => { setTimeout(resolve, 50); });
const moveTo = (policyId) => (stored) => ({
  enabled: stored.enabled, accountId: stored.accountId, appId: stored.appId, policyId,
});

function cloudflare() {
  let policy = { id: POLICY, name: 'Allow', decision: 'allow', include: [], exclude: [], require: [] };
  return {
    getPolicy: async () => structuredClone(policy),
    updatePolicy: async (next) => { policy = next; return next; },
  };
}

const run = (beforeStateWrite) => runAccessSync({
  trigger: 'test', signOutUser: async () => {}, createClient: cloudflare,
  settings: { mode: 'google', bootstrapAdminEmails: new Set() }, env: {}, beforeStateWrite,
});

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (username, email, password_hash) VALUES ('a', 'a@example.com', 'x'), ('b', 'b@example.com', 'x')");
}, 120000);
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM system_settings WHERE key LIKE 'access_sync%';");
  await saveConfig({ enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'cf-token-0123456789abcdef' });
});

describe('Access sync settings across processes', () => {
  it('a settings change that lands while a run writes its state still leaves the new policy without the old baseline', async () => {
    let save;
    const result = await run(async () => {
      // The run has read the settings (still the old policy) and is about to write its baseline;
      // the CLI points the sync at another policy now.
      save = updateConfig(moveTo(OTHER_POLICY));
      await pause();
    });
    await save;
    expect(result.outcome).toBe('updated');
    expect((await loadStoredConfig()).policyId).toBe(OTHER_POLICY);
    const state = await loadState();
    expect(state.baseline).toEqual([]);
    expect(state.lastRun).toMatchObject({ outcome: 'updated' });
  });

  it('a run that writes its state while a settings change is between its read and its write sees the new policy', async () => {
    let finished;
    let runPolicy;
    await updateConfig(moveTo(OTHER_POLICY), {
      afterRead: async () => {
        // The save has read the old settings; a run starts and finishes now.
        finished = runAccessSync({
          trigger: 'test', signOutUser: async () => {},
          createClient: (config) => { runPolicy = config.policyId; return cloudflare(); },
          settings: { mode: 'google', bootstrapAdminEmails: new Set() }, env: {},
        });
        await pause();
      },
    });
    await finished;
    expect((await loadStoredConfig()).policyId).toBe(OTHER_POLICY);
    // Whatever order the database chose, the baseline belongs to the policy that is stored now: a
    // run of the old policy leaves the reset in place, a run that read the new one writes its own.
    const state = await loadState();
    expect(state.baseline).toEqual(runPolicy === POLICY ? [] : ['a@example.com', 'b@example.com']);
    expect(state.lastRun).toMatchObject({ outcome: 'updated' });
  });

  it('two partial saves from different processes both survive', async () => {
    let second;
    await updateConfig((stored) => ({ ...moveTo(stored.policyId)(stored), enabled: false }), {
      afterRead: async () => {
        // Another process stores a new token while this save works with what it read.
        second = updateConfig((stored) => ({ ...moveTo(stored.policyId)(stored), apiToken: 'cf-token-new-0123456789' }));
        await pause();
      },
    });
    await second;
    const stored = await loadStoredConfig();
    expect(stored.enabled).toBe(false);
    expect(stored.apiToken).toMatch(/^enc:v1:/);
    const { decrypt } = await import('../encryption.js');
    expect(decrypt(stored.apiToken)).toBe('cf-token-new-0123456789');
  });
});
