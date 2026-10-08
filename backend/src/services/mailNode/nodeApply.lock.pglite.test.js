// Applying the node settings from two processes at once (the backend and the panel CLI): each has
// its own in-process queue, so only the database can keep their runs apart. Two module instances of
// nodeApply.js (two "processes") share PGlite and a mailcow in memory; pg is replaced by a pool whose
// clients keep PostgreSQL's session-level advisory locks in memory (PGlite has one session, where
// such a lock never blocks).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';
import { createFakeMailcow } from '../testing/fakeMailcow.js';

const shared = vi.hoisted(() => ({ db: null, mc: null, locks: new Map(), held: 0, maxHeld: 0, waits: [] }));

vi.mock('pg', () => {
  // One lock per key; a holder is a client. pg_advisory_lock waits until the key is free.
  async function lock(key, client) {
    while (shared.locks.has(key) && shared.locks.get(key) !== client) {
      await new Promise((resolve) => { shared.waits.push(resolve); });
    }
    shared.locks.set(key, client);
    shared.held += 1;
    shared.maxHeld = Math.max(shared.maxHeld, shared.held);
  }
  function unlock(key, client) {
    if (shared.locks.get(key) !== client) return false;
    shared.locks.delete(key);
    shared.held -= 1;
    shared.waits.splice(0).forEach((resolve) => resolve());
    return true;
  }
  class Pool {
    on() {}
    query(sql, params) { return shared.db.query(sql, params); }
    async connect() {
      const client = {
        async query(sql, params) {
          if (/^\s*(SET|RESET) statement_timeout/i.test(sql)) return { rows: [] };
          if (/pg_advisory_lock\(/.test(sql)) { await lock(params[0], client); return { rows: [{}] }; }
          if (/pg_advisory_unlock\(/.test(sql)) return { rows: [{ pg_advisory_unlock: unlock(params[0], client) }] };
          return shared.db.query(sql, params);
        },
        release() {},
      };
      return client;
    }
  }
  return { default: { Pool } };
});
vi.mock('../encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
  isEncrypted: () => true,
}));
// Every mailcow answer waits a turn, so two runs without a common lock interleave.
vi.mock('../safeFetch.js', () => ({
  safeFetch: async (url, options) => {
    await new Promise((resolve) => { setTimeout(resolve, 1); });
    return shared.mc.fetch(url, options);
  },
}));

async function loadProcess() {
  vi.resetModules();
  return import('./nodeApply.js');
}

let backend;
let cli;

beforeAll(async () => {
  shared.db = await createRealSchemaDb();
  backend = await loadProcess();
  cli = await loadProcess();
  const { saveMailNodeConfig } = await import('./mailcow.js');
  const { saveEopSettings } = await import('./eopSettings.js');
  await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, panelIps: [] });
  await saveEopSettings({ eopHost: 'eop.example.net' });
  await shared.db.query("INSERT INTO mail_node_domains (domain, state) VALUES ('a.example', 'ready'), ('b.example', 'ready')");
}, 120000);
afterAll(async () => { await shared.db?.close(); });

beforeEach(async () => {
  shared.mc = createFakeMailcow({ domains: { 'a.example': { relayhost: 0 }, 'b.example': { relayhost: 0 } } });
  shared.locks.clear();
  shared.held = 0;
  shared.maxHeld = 0;
  await shared.db.query("DELETE FROM integration_config WHERE provider = 'mail_node_apply'");
});

describe('apply across processes', () => {
  it('two processes are separate module instances with their own queue', () => {
    expect(backend.applyNode).not.toBe(cli.applyNode);
  });

  it('never runs two applies at once: one relayhost on the node, the lock free afterwards', async () => {
    const results = await Promise.all([
      backend.applyNode({ userId: null, trigger: 'manual' }),
      cli.applyNode({ userId: null, trigger: 'manual' }),
      cli.applyDomain({ domain: 'a.example', userId: null, trigger: 'manual' }),
      backend.applyDomain({ domain: 'b.example', userId: null, trigger: 'manual' }),
    ]);
    expect(results).toHaveLength(4);
    expect(shared.mc.node.relayhosts).toHaveLength(1);
    expect(shared.maxHeld).toBe(1);
    expect(shared.locks.size).toBe(0);
  });

  it('frees the lock when a run fails', async () => {
    await expect(cli.applyDomain({ domain: 'nowhere.example', userId: null, trigger: 'manual' })).rejects.toThrow('The panel does not know this domain');
    expect(shared.locks.size).toBe(0);
    await backend.applyNode({ userId: null, trigger: 'manual' });
    expect(shared.locks.size).toBe(0);
  });
});
