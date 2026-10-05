import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => `enc:${v}`, decrypt: (v) => v }));
vi.mock('../services/accessSync/index.js', () => ({
  requestAccessSync: vi.fn(), runAccessSyncNow: vi.fn(), withAccessSyncLock: vi.fn((op) => op()),
}));
vi.mock('../services/accessSync/settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadStoredConfig: vi.fn(), loadState: vi.fn(), saveConfig: vi.fn(), updateConfig: vi.fn(),
}));

import express from 'express';
import accessSyncRoutes from './accessSync.js';
import { requestAccessSync, runAccessSyncNow, withAccessSyncLock } from '../services/accessSync/index.js';
import { AccessSyncConfigError, loadState, loadStoredConfig, saveConfig, updateConfig } from '../services/accessSync/settings.js';
import { query } from '../services/db.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const STORED = { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'enc:tok-secret' };
const LAST_RUN = {
  trigger: 'schedule', startedAt: '2026-09-17T09:00:00.000Z', finishedAt: '2026-09-17T09:00:01.000Z',
  outcome: 'updated', added: 1, removed: 0, disabled: 0, wouldDisable: 0, error: null,
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: 'admin-id' }; next(); });
  app.use('/api/admin/access-sync', accessSyncRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_MODE', 'google');
  vi.stubEnv('ACCESS_SYNC_MAX_DISABLES', '5');
  loadStoredConfig.mockResolvedValue(STORED);
  // The real updateConfig reads, builds and saves in one locked transaction; here it is built on
  // the two mocks so the tests can still say what was read and what was saved.
  updateConfig.mockImplementation(async (build) => {
    const before = await loadStoredConfig();
    return { before, saved: await saveConfig(build(before)) };
  });
  loadState.mockResolvedValue({ baseline: ['person@example.com'], abortedCandidates: null, lastRun: LAST_RUN });
});
afterEach(() => { vi.unstubAllEnvs(); });

const send = async (method, path, body) => {
  const res = await fetch(`${base}/api/admin/access-sync${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

// The journal rows recordAudit inserted through the mocked query.
const journaled = () => query.mock.calls
  .filter(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'))
  .flatMap(([, params]) => JSON.parse(params[0]));

const SNAPSHOT = {
  config: { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiTokenSet: true },
  lastRun: LAST_RUN, maxDisables: 5, googleMode: true,
};

describe('Access sync admin API', () => {
  it('shows the settings and the last run without the token or the baseline', async () => {
    const { status, body, text } = await send('GET', '');
    expect(status).toBe(200);
    expect(body).toEqual(SNAPSHOT);
    expect(text).not.toContain('tok-secret');
    expect(text).not.toContain('person@example.com');
  });

  it('saves settings under the sync lock and asks for a run when the sync is on', async () => {
    saveConfig.mockResolvedValue(STORED);
    const input = { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'tok-new' };
    const { status, body } = await send('PUT', '', input);
    expect(status).toBe(200);
    expect(body).toEqual(SNAPSHOT);
    expect(withAccessSyncLock).toHaveBeenCalledTimes(1);
    expect(saveConfig).toHaveBeenCalledWith(input);
    expect(requestAccessSync).toHaveBeenCalledWith('config');
  });

  it('does not ask for a run when the sync is saved off', async () => {
    saveConfig.mockResolvedValue({ ...STORED, enabled: false });
    await send('PUT', '', { enabled: false });
    expect(requestAccessSync).not.toHaveBeenCalled();
  });

  it('answers 400 with the reason for invalid settings', async () => {
    saveConfig.mockRejectedValue(new AccessSyncConfigError('invalid_id'));
    expect(await send('PUT', '', { enabled: true, accountId: 'x' })).toMatchObject({
      status: 400, body: { error: 'Invalid Cloudflare Access settings', code: 'invalid_id' },
    });
  });

  it('runs the sync now and returns its result with the new state', async () => {
    runAccessSyncNow.mockResolvedValue({ outcome: 'not_configured' });
    const { status, body } = await send('POST', '/run');
    expect(status).toBe(200);
    expect(body).toEqual({ result: { outcome: 'not_configured' }, ...SNAPSHOT });
    expect(journaled()).toEqual([expect.objectContaining({ actor_user_id: 'admin-id', action: 'access.sync_requested' })]);
  });

  it('journals the changed settings under the administrator, the token only as replaced', async () => {
    saveConfig.mockResolvedValue({ ...STORED, enabled: false, apiToken: 'enc:tok-other' });
    await send('PUT', '', { enabled: false, apiToken: 'tok-other' });
    const [entry] = journaled();
    expect(entry).toMatchObject({
      actor_user_id: 'admin-id', action: 'access.config_changed',
      details: { changed: ['enabled'], tokenChanged: true, enabled: false },
    });
    expect(JSON.stringify(entry)).not.toContain('tok-other');
  });

  it('journals nothing when nothing changed', async () => {
    saveConfig.mockResolvedValue(STORED);
    await send('PUT', '', { enabled: true });
    expect(journaled()).toEqual([]);
  });
});
