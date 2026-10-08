import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
vi.mock('pg', () => ({ default: { Pool: class extends EventEmitter {} } }));
vi.mock('./encryption.js', () => ({ encrypt: vi.fn(), isEncrypted: vi.fn() }));
vi.mock('./performanceMetrics.js', () => ({ recordDb: vi.fn() }));
import { pool, withSessionLock } from './db.js';
it('handles an idle connection failure instead of crashing the process', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(() => pool.emit('error', new Error('connection terminated'))).not.toThrow();
    expect(log).toHaveBeenCalledWith('Idle PostgreSQL connection error:', 'connection terminated');
  } finally { log.mockRestore(); }
});

// A pooled client that records its queries; failUnlock: the unlock fails (the connection is gone).
function lockClient({ failUnlock = false } = {}) {
  const calls = [];
  const client = {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push(params ? [sql, ...params] : [sql]);
      if (failUnlock && sql.includes('pg_advisory_unlock')) throw new Error('connection lost');
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  pool.connect = vi.fn(async () => client);
  return client;
}

it('withSessionLock holds the session lock on its own connection around fn, waiting without a statement timeout', async () => {
  const client = lockClient();
  expect(await withSessionLock('k', async () => { client.calls.push(['fn']); return 7; })).toBe(7);
  expect(client.calls).toEqual([
    ['SET statement_timeout = 0'],
    ['SELECT pg_advisory_lock(hashtext($1))', 'k'],
    ['RESET statement_timeout'],
    ['fn'],
    ['SELECT pg_advisory_unlock(hashtext($1))', 'k'],
  ]);
  expect(client.release).toHaveBeenCalledWith(false);
});

it('withSessionLock unlocks when fn fails and keeps the connection; destroys it when the unlock fails', async () => {
  let client = lockClient();
  await expect(withSessionLock('k', async () => { throw new Error('apply failed'); })).rejects.toThrow('apply failed');
  expect(client.calls.at(-1)).toEqual(['SELECT pg_advisory_unlock(hashtext($1))', 'k']);
  expect(client.release).toHaveBeenCalledWith(false);
  client = lockClient({ failUnlock: true });
  expect(await withSessionLock('k', async () => 1)).toBe(1);
  expect(client.release).toHaveBeenCalledWith(true);
});
