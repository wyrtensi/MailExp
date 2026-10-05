import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../auth/userStatus.js', () => ({ disableUsersByEmail: vi.fn() }));
vi.mock('./settings.js', () => ({
  loadRunConfig: vi.fn(), loadState: vi.fn(), loadStoredConfig: vi.fn(), saveState: vi.fn(), accessSyncMaxDisables: vi.fn(),
  withAccessSyncTransaction: vi.fn(async (fn) => fn('locked-db')),
}));

import { query, withTransaction } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { disableUsersByEmail } from '../auth/userStatus.js';
import { accessSyncMaxDisables, loadRunConfig, loadState, loadStoredConfig, saveState } from './settings.js';
import { CloudflareAccessError } from './cloudflareAccessClient.js';
import { runAccessSync } from './runner.js';

const CONFIG = { accountId: 'acc', appId: 'app', policyId: 'pol', apiToken: 'tok' };
const NOW = '2026-09-17T10:00:00.000Z';
const email = (address) => ({ email: { email: address } });
const group = { group: { id: 'g-1' } };
const policyWith = (include, extra = {}) => ({ id: 'pol', name: 'Allow', decision: 'allow', include, exclude: [], require: [], ...extra });

let cf;
let signOutUser;
let createClient;
const cloudflare = (policy) => {
  cf = { getPolicy: vi.fn(async () => structuredClone(policy)), updatePolicy: vi.fn(async () => ({})) };
};
const state = (baseline, abortedCandidates = null) => loadState.mockResolvedValue({ baseline, abortedCandidates, lastRun: null });
const activeUsers = (...emails) => query.mockResolvedValue({ rows: emails.map((address) => ({ email: address })) });
const run = (options = {}) => runAccessSync({
  trigger: 'test', signOutUser, createClient, settings: { mode: 'google', bootstrapAdminEmails: new Set() },
  env: {}, now: () => new Date(NOW), ...options,
});
const saved = () => saveState.mock.calls.at(-1)[0];
const lastRun = (fields) => ({
  trigger: 'test', startedAt: NOW, finishedAt: NOW, added: 0, removed: 0, disabled: 0, wouldDisable: 0, error: null, ...fields,
});

beforeEach(() => {
  vi.clearAllMocks();
  loadRunConfig.mockResolvedValue(CONFIG);
  loadStoredConfig.mockResolvedValue({ enabled: true, ...CONFIG, apiToken: 'enc:tok' });
  state([]);
  saveState.mockResolvedValue(undefined);
  accessSyncMaxDisables.mockReturnValue(10);
  withTransaction.mockImplementation(async (fn) => fn('tx'));
  disableUsersByEmail.mockResolvedValue({ disabled: [], keptLastAdmin: [] });
  signOutUser = vi.fn(async () => {});
  createClient = vi.fn(() => cf);
});

describe('runAccessSync', () => {
  it('does nothing outside google mode or without complete settings', async () => {
    expect(await run({ settings: { mode: 'local', bootstrapAdminEmails: new Set() } })).toEqual({ outcome: 'not_google_mode' });
    loadRunConfig.mockResolvedValue(null);
    expect(await run()).toEqual({ outcome: 'not_configured' });
    expect(createClient).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('adds approved users, keeps rules it does not own and remembers what it wrote', async () => {
    cloudflare(policyWith([group, email('contractor@example.net')]));
    activeUsers('b@example.com', 'a@example.com');
    const result = await run();
    expect(createClient).toHaveBeenCalledWith(CONFIG);
    expect(cf.updatePolicy).toHaveBeenCalledWith(policyWith([group, email('contractor@example.net'), email('a@example.com'), email('b@example.com')]));
    expect(result).toEqual(lastRun({ outcome: 'updated', added: 2 }));
    expect(saved()).toEqual({ baseline: ['a@example.com', 'b@example.com'], abortedCandidates: null, lastRun: result });
    expect(query.mock.calls[0][0]).toBe('SELECT email FROM users WHERE disabled_at IS NULL AND email IS NOT NULL');
  });

  it('keeps the state of a policy the settings moved to while it ran (the CLI saves from another process)', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    activeUsers('a@example.com', 'b@example.com');
    // The run starts with no baseline; meanwhile the CLI points the sync at another policy and
    // saveConfig resets the state for it.
    const reset = { baseline: [], abortedCandidates: null, lastRun: null };
    loadState.mockResolvedValueOnce({ baseline: ['old@example.com'], abortedCandidates: null, lastRun: null }).mockResolvedValue(reset);
    loadStoredConfig.mockResolvedValue({ enabled: true, ...CONFIG, policyId: 'other-pol' });
    const result = await run();
    expect(result.outcome).toBe('updated');
    expect(saved()).toEqual({ ...reset, lastRun: result });
    // Read and written inside the settings' locked transaction (settings.race.pglite.test.js).
    expect(loadStoredConfig).toHaveBeenLastCalledWith('locked-db');
    expect(saveState.mock.calls.at(-1)[1]).toBe('locked-db');
  });

  it('writes nothing when the policy is already in line', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com']);
    activeUsers('a@example.com');
    expect(await run()).toEqual(lastRun({ outcome: 'unchanged' }));
    expect(cf.updatePolicy).not.toHaveBeenCalled();
  });

  it('removes emails it wrote for users who are no longer active', async () => {
    cloudflare(policyWith([email('a@example.com'), email('b@example.com')]));
    state(['a@example.com', 'b@example.com']);
    activeUsers('a@example.com');
    expect(await run()).toEqual(lastRun({ outcome: 'updated', removed: 1 }));
    expect(cf.updatePolicy.mock.calls[0][0].include).toEqual([email('a@example.com')]);
    expect(saved().baseline).toEqual(['a@example.com']);
  });

  it('disables a user removed in Cloudflare, signs them out and journals it', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com', 'b@example.com']);
    activeUsers('a@example.com', 'b@example.com');
    disableUsersByEmail.mockResolvedValue({ disabled: [{ id: 'u-b', email: 'b@example.com', is_admin: false }], keptLastAdmin: [] });
    expect(await run()).toEqual(lastRun({ outcome: 'unchanged', disabled: 1 }));
    expect(disableUsersByEmail).toHaveBeenCalledWith('tx', ['b@example.com'], { googleMode: true, bootstrapAdminEmails: new Set() });
    expect(signOutUser).toHaveBeenCalledWith('u-b');
    expect(recordAudit).toHaveBeenCalledWith([{
      actorEmail: 'Cloudflare Access', action: 'user.disabled',
      details: { userId: 'u-b', email: 'b@example.com', isAdmin: false, source: 'cloudflare_access' },
    }]);
    expect(saved().baseline).toEqual(['a@example.com']);
  });

  it('journals a disable before signing the user out, so a throwing signOutUser cannot lose it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com', 'b@example.com', 'c@example.com']);
    activeUsers('a@example.com', 'b@example.com', 'c@example.com', 'd@example.com');
    disableUsersByEmail.mockResolvedValue({
      disabled: [
        { id: 'u-b', email: 'b@example.com', is_admin: false },
        { id: 'u-c', email: 'c@example.com', is_admin: false },
      ],
      keptLastAdmin: [],
    });
    signOutUser = vi.fn(async (id) => { if (id === 'u-b') throw new Error('socket close failed'); });
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'internal_error' }));
    expect(recordAudit).toHaveBeenCalledWith([
      { actorEmail: 'Cloudflare Access', action: 'user.disabled', details: { userId: 'u-b', email: 'b@example.com', isAdmin: false, source: 'cloudflare_access' } },
      { actorEmail: 'Cloudflare Access', action: 'user.disabled', details: { userId: 'u-c', email: 'c@example.com', isAdmin: false, source: 'cloudflare_access' } },
    ]);
    errorSpy.mockRestore();
  });

  it('puts back the last admin that Cloudflare removed', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com', 'admin@example.com']);
    activeUsers('a@example.com', 'admin@example.com');
    disableUsersByEmail.mockResolvedValue({ disabled: [], keptLastAdmin: ['admin@example.com'] });
    expect(await run()).toEqual(lastRun({ outcome: 'updated', added: 1 }));
    expect(cf.updatePolicy.mock.calls[0][0].include).toEqual([email('a@example.com'), email('admin@example.com')]);
    expect(signOutUser).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('stops above the limit without changing anything and journals each new set of users once', async () => {
    accessSyncMaxDisables.mockReturnValue(1);
    cloudflare(policyWith([email('a@example.com')]));
    const baseline = ['a@example.com', 'b@example.com', 'c@example.com'];
    state(baseline);
    activeUsers('a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com');
    expect(await run()).toEqual(lastRun({ outcome: 'aborted', wouldDisable: 2 }));
    expect(disableUsersByEmail).not.toHaveBeenCalled();
    expect(cf.updatePolicy).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith({
      actorEmail: 'Cloudflare Access', action: 'access.sync_aborted',
      details: { candidates: ['b@example.com', 'c@example.com'], activeUsers: 5, maxDisables: 1 },
    });
    expect(saved()).toMatchObject({ baseline, abortedCandidates: ['b@example.com', 'c@example.com'] });

    recordAudit.mockClear();
    state(baseline, ['b@example.com', 'c@example.com']);
    await run();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('never removes or disables a bootstrap admin and lists one without a user', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com', 'boot@example.com']);
    activeUsers('a@example.com', 'boot@example.com');
    await run({ settings: { mode: 'google', bootstrapAdminEmails: new Set(['boot@example.com', 'later@example.com']) } });
    expect(disableUsersByEmail).not.toHaveBeenCalled();
    expect(cf.updatePolicy.mock.calls[0][0].include).toEqual([
      email('a@example.com'), email('boot@example.com'), email('later@example.com'),
    ]);
  });

  it('never writes an empty include list', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com']);
    activeUsers();
    expect(await run()).toEqual(lastRun({ outcome: 'empty' }));
    expect(cf.updatePolicy).not.toHaveBeenCalled();
    expect(saved().baseline).toEqual(['a@example.com']);

    cloudflare(policyWith([email('contractor@example.net'), email('a@example.com')]));
    expect(await run()).toEqual(lastRun({ outcome: 'updated', removed: 1 }));
    expect(cf.updatePolicy.mock.calls[0][0].include).toEqual([email('contractor@example.net')]);
  });

  it('refuses to write a policy that is not an Allow policy', async () => {
    cloudflare(policyWith([email('a@example.com')], { decision: 'bypass' }));
    activeUsers('a@example.com');
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'policy_not_allow' }));
    expect(cf.updatePolicy).not.toHaveBeenCalled();
  });

  it('reports a Cloudflare failure and keeps the baseline', async () => {
    cloudflare(policyWith([]));
    cf.getPolicy.mockRejectedValue(new CloudflareAccessError('getPolicy', 403, [10000]));
    state(['a@example.com']);
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'Cloudflare getPolicy failed (403): error 10000' }));
    expect(saved().baseline).toEqual(['a@example.com']);
  });

  it('translates a not-attached policy to a named error', async () => {
    cloudflare(policyWith([]));
    cf.getPolicy.mockRejectedValue(new CloudflareAccessError('getPolicy', 'not_attached'));
    state(['a@example.com']);
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'policy_not_attached' }));
    expect(saved().baseline).toEqual(['a@example.com']);
  });

  it('reports an unexpected error without its message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare(policyWith([]));
    query.mockRejectedValue(Object.assign(new Error('boom near a@example.com'), { code: '57P01' }));
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'internal_error' }));
    expect(errorSpy).toHaveBeenCalledWith('[access-sync] Run failed:', '57P01');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('a@example.com');
    errorSpy.mockRestore();
  });

  it('reports a token that no longer decrypts without calling Cloudflare', async () => {
    loadRunConfig.mockResolvedValue({ ...CONFIG, apiToken: null });
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'token_unreadable' }));
    expect(createClient).not.toHaveBeenCalled();
  });
});
