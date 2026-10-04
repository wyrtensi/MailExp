import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, open: vi.fn(actual.open) };
});

import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpool, isBusy, spoolDirFromEnv } from './spool.js';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');

let dir;
let spool;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spool-test-'));
  await mkdir(join(dir, 'request'));
  await mkdir(join(dir, 'result'));
  spool = createSpool(dir);
  open.mockClear();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const result = (over = {}) => ({
  id: ID1, action: 'update', target: 'sha-0123456789ab', state: 'updating', terminal: false,
  message: 'Updating', from: 'sha-aaaaaaaaaaaa',
  receivedAt: '2026-10-05T11:50:00.000Z', updatedAt: '2026-10-05T11:59:00.000Z',
  startedAt: '2026-10-05T11:51:00.000Z', finishedAt: null, exitCode: null,
  preflight: { ok: true, problems: [], warnings: ['w'], next: [], info: ['i'], pendingMigrations: [], migrationsApplied: 12 },
  autoRollback: true, next: [], log: ['line 1', 'line 2'],
  logFile: '/opt/mailexpert/state/updater/x.log', journal: 'journalctl -u mailexpert-updater.service',
  ...over,
});
const putResult = (name, body) => writeFile(join(dir, 'result', name), typeof body === 'string' ? body : JSON.stringify(body));

let canSymlink = true;
try {
  const probe = await mkdtemp(join(tmpdir(), 'spool-probe-'));
  await writeFile(join(probe, 'a'), 'x');
  try { await symlink(join(probe, 'a'), join(probe, 'b')); } catch { canSymlink = false; }
  await rm(probe, { recursive: true, force: true });
} catch { canSymlink = false; }

describe('spool directory', () => {
  it('comes from UPDATE_SPOOL_DIR', () => {
    expect(spoolDirFromEnv({ UPDATE_SPOOL_DIR: '/var/lib/mailexpert/update-spool' })).toBe('/var/lib/mailexpert/update-spool');
    expect(spoolDirFromEnv({})).toBeNull();
    expect(spoolDirFromEnv({ UPDATE_SPOOL_DIR: '  ' })).toBeNull();
  });

  it('without a directory the spool is off and refuses writes', async () => {
    const off = createSpool(null);
    expect(off.enabled).toBe(false);
    await expect(off.writeRequest({ action: 'check', target: 'sha-0123456789ab', requestedBy: 'a@example.com' }))
      .rejects.toMatchObject({ code: 'updater_not_installed' });
    expect(await off.readResults()).toEqual([]);
    expect(await off.readUpdater()).toEqual({ installed: false, version: null });
  });
});

describe('writeRequest', () => {
  it('writes the request atomically with exactly the contract keys', async () => {
    const id = await spool.writeRequest({
      action: 'update', target: 'sha-0123456789ab', requestedBy: 'admin@example.com', now: new Date(NOW),
    });

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await readdir(join(dir, 'request'))).toEqual([`${id}.json`]);
    const text = await readFile(join(dir, 'request', `${id}.json`), 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(text)).toEqual({
      id, action: 'update', target: 'sha-0123456789ab', requestedAt: '2026-10-05T12:00:00.000Z', requestedBy: 'admin@example.com',
    });
    expect(Object.keys(JSON.parse(text))).toEqual(['id', 'action', 'target', 'requestedAt', 'requestedBy']);

    // Created exclusively under a temporary name, owner-only.
    expect(open).toHaveBeenCalledTimes(1);
    const [path, flags, mode] = open.mock.calls[0];
    expect(path).toBe(join(dir, 'request', `${id}.tmp`));
    expect(flags).toBe('wx');
    expect(mode).toBe(0o600);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'request', `${id}.json`))).mode & 0o777).toBe(0o600);
    }
  });

  it('caps requestedBy at 254 characters', async () => {
    const id = await spool.writeRequest({ action: 'check', target: 'sha-0123456789ab', requestedBy: 'x'.repeat(400) });
    const body = JSON.parse(await readFile(join(dir, 'request', `${id}.json`), 'utf8'));
    expect(body.requestedBy).toHaveLength(254);
  });

  it.each([
    [{ action: 'rollback', target: 'sha-0123456789ab' }],
    [{ action: 'check', target: 'sha-0123456789AB' }],
    [{ action: 'check', target: 'latest' }],
  ])('refuses a bad request %j', async (req) => {
    await expect(spool.writeRequest({ ...req, requestedBy: 'a' })).rejects.toThrow();
    expect(await readdir(join(dir, 'request'))).toEqual([]);
  });
});

describe('results', () => {
  it('reads and normalizes a result', async () => {
    await putResult(`${ID1}.json`, { ...result(), extra: 'dropped' });
    const [r] = await spool.readResults();
    expect(r).toEqual(result());
    expect(await spool.readResult(ID1)).toEqual(result());
    expect(await spool.readResult(ID2)).toBeNull();
  });

  it('derives terminal from the state', async () => {
    await putResult(`${ID1}.json`, result({ state: 'succeeded', terminal: false }));
    expect((await spool.readResult(ID1)).terminal).toBe(true);
  });

  it('accepts a refused result with no action or target', async () => {
    await putResult(`${ID1}.json`, result({ state: 'refused', terminal: true, action: null, target: null }));
    expect(await spool.readResult(ID1)).toMatchObject({ id: ID1, action: null, target: null, state: 'refused' });
  });

  it('ignores junk, oversize files, wrong ids and other names', async () => {
    await putResult(`${ID1}.json`, '{not json');
    await putResult(`${ID2}.json`, result({ id: ID3 }));                       // id != file name
    await putResult(`${ID3}.json`, JSON.stringify(result({ id: ID3, log: ['x'.repeat(300_000)] }))); // oversize
    await putResult('notes.json', result());
    await putResult(`${ID1}.tmp`, result());
    expect(await spool.readResults()).toEqual([]);
    expect(await spool.readResult(ID1)).toBeNull();
  });

  it.each([
    ['an unknown state', { state: 'exploded' }],
    ['a bad target', { target: '../../etc' }],
    ['a null action outside refused', { action: null }],
    ['a non-boolean preflight.ok', { preflight: { ok: 'yes' } }],
    ['an array body', null],
  ])('ignores a result with %s', async (_name, over) => {
    await putResult(`${ID1}.json`, over === null ? [result()] : result(over));
    expect(await spool.readResults()).toEqual([]);
  });

  it('ignores a directory named like a result', async () => {
    await mkdir(join(dir, 'result', `${ID1}.json`));
    expect(await spool.readResults()).toEqual([]);
    expect(await spool.readResult(ID1)).toBeNull();
  });

  // Symlinks need privileges on Windows: this case runs only where the probe above could make one.
  it.skipIf(!canSymlink)('ignores a symlinked result', async () => {
    const outside = join(dir, 'outside.json');
    await writeFile(outside, JSON.stringify(result()));
    await symlink(outside, join(dir, 'result', `${ID1}.json`));
    expect(await spool.readResults()).toEqual([]);
    expect(await spool.readResult(ID1)).toBeNull();
  });

  it('sorts results newest first', async () => {
    await putResult(`${ID1}.json`, result({ id: ID1, receivedAt: '2026-10-05T10:00:00.000Z' }));
    await putResult(`${ID2}.json`, result({ id: ID2, receivedAt: '2026-10-05T11:00:00.000Z' }));
    expect((await spool.readResults()).map((r) => r.id)).toEqual([ID2, ID1]);
  });

  it('a missing result directory reads as empty', async () => {
    await rm(join(dir, 'result'), { recursive: true });
    expect(await spool.readResults()).toEqual([]);
  });
});

describe('updater.json', () => {
  it('reads the installed updater', async () => {
    await putResult('updater.json', { installed: true, version: 'sha-0123456789ab', updatedAt: '2026-10-05T10:00:00Z' });
    expect(await spool.readUpdater()).toEqual({ installed: true, version: 'sha-0123456789ab' });
  });

  it('absent or junk means not installed', async () => {
    expect(await spool.readUpdater()).toEqual({ installed: false, version: null });
    await putResult('updater.json', '{"installed": "yes"');
    expect(await spool.readUpdater()).toEqual({ installed: false, version: null });
    await putResult('updater.json', { installed: true, version: 'v1' });
    expect(await spool.readUpdater()).toEqual({ installed: true, version: null });
  });
});

describe('requests and busy', () => {
  it('lists a pending request and finds it by id', async () => {
    const id = await spool.writeRequest({ action: 'check', target: 'sha-0123456789ab', requestedBy: 'a' });
    const p = await spool.readRequests({ now: Date.now() });
    expect(p).toEqual({ pending: { id, action: 'check' }, count: 1, freshTmp: false });
    expect(await spool.hasRequest(id)).toBe(true);
    expect(await spool.hasRequest(ID1)).toBe(false);
  });

  it('counts a fresh *.tmp but not an old one', async () => {
    const tmp = join(dir, 'request', `${ID1}.tmp`);
    await writeFile(tmp, '{');
    expect((await spool.readRequests({ now: Date.now() })).freshTmp).toBe(true);
    const old = new Date(Date.now() - 61_000);
    await utimes(tmp, old, old);
    expect((await spool.readRequests({ now: Date.now() })).freshTmp).toBe(false);
  });

  const base = { count: 0, freshTmp: false, results: [], now: NOW };
  it('is idle with nothing pending and no running update', () => {
    expect(isBusy(base)).toBe(false);
  });
  it('is busy with a pending request or a fresh tmp', () => {
    expect(isBusy({ ...base, count: 1 })).toBe(true);
    expect(isBusy({ ...base, freshTmp: true })).toBe(true);
  });
  it('is busy while the newest update runs', () => {
    expect(isBusy({ ...base, results: [result({ state: 'updating' })] })).toBe(true);
    expect(isBusy({ ...base, results: [result({ state: 'rolling_back' })] })).toBe(true);
  });
  it('a stale running update (no change for 30 minutes) does not count', () => {
    expect(isBusy({ ...base, results: [result({ updatedAt: '2026-10-05T11:29:59.000Z' })] })).toBe(false);
    expect(isBusy({ ...base, results: [result({ updatedAt: '2026-10-05T11:30:01.000Z' })] })).toBe(true);
  });
  it('only the newest update result counts, checks and unreadable requests do not', () => {
    const older = result({ id: ID2, state: 'updating' });
    const newer = result({ id: ID1, state: 'succeeded', terminal: true });
    expect(isBusy({ ...base, results: [newer, older] })).toBe(false);
    expect(isBusy({ ...base, results: [result({ action: 'check', state: 'checking' })] })).toBe(false);
    expect(isBusy({ ...base, results: [result({ action: null, target: null, state: 'refused' }), older] })).toBe(true);
  });
});
