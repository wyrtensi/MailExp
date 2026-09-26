// Repeated and overlapping deletes, on PGlite with the real schema and a real MoveQueue. A move to
// Trash keeps the row's id (the move queue needs it), so the row alone cannot tell "move to Trash"
// from "delete forever from Trash": the request says which (deleteIntent in mail.js). A second
// move to Trash of a letter already there, or on its way there, is a no-op success and never an
// expunge. The upstream fix for the same defect (maathimself/mailflow 22f29a0a) rotated the id.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../services/testing/realSchema.js';

const dbState = { db: null };
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: USER }; next(); } }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []) } }));
const hooks = {};
vi.mock('../utils/mailUtils.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    // Counts are fire-and-forget; the tests read the deltas instead.
    adjustFolderCounts: vi.fn(),
    // Runs once the route has read the row, before it decides: another request lands here.
    resolveAllTrashPaths: vi.fn(async (...args) => {
      const hook = hooks.afterRead;
      hooks.afterRead = null;
      if (hook) await hook();
      return real.resolveAllTrashPaths(...args);
    }),
  };
});
const mgrState = {};
vi.mock('../index.js', () => ({ get imapManager() { return mgrState.mgr; } }));

const USER = '50000000-0000-4000-8000-0000000000aa';
const { MoveQueue, placeholderUid } = await import('../services/moveQueue.js');
const { ImapManager } = await import('../services/imapManager.js');
const { adjustFolderCounts } = await import('../utils/mailUtils.js');
const express = (await import('express')).default;
const mailRoutes = (await import('./mail.js')).default;

const ACCOUNT = '50000000-0000-4000-8000-000000000001';
const GMAIL = '50000000-0000-4000-8000-000000000002';
const BARE = '50000000-0000-4000-8000-000000000003';
const A = '51000000-0000-4000-8000-000000000001'; // INBOX, uid 11, unread
const B = '51000000-0000-4000-8000-000000000002'; // INBOX, uid 12
const T = '51000000-0000-4000-8000-000000000003'; // Trash, uid 21
const U = '51000000-0000-4000-8000-000000000004'; // Trash, uid 22
const D = '51000000-0000-4000-8000-000000000005'; // Drafts, uid 31
const G = '51000000-0000-4000-8000-000000000006'; // Gmail INBOX, uid 41
const N = '51000000-0000-4000-8000-000000000007'; // mailbox without Trash, INBOX uid 51

let db;
let server;
let base;
// What the mail server holds: `${accountId}\n${folder}` -> Map<uid, Message-ID>.
let mailServer;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

const box = (accountId, folder) => {
  const key = `${accountId}\n${folder}`;
  if (!mailServer.has(key)) mailServer.set(key, new Map());
  return mailServer.get(key);
};

beforeEach(async () => {
  vi.clearAllMocks();
  hooks.afterRead = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await db.exec('DELETE FROM mailbox_audit_log; DELETE FROM message_moves; DELETE FROM messages; DELETE FROM folders; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query("INSERT INTO users (id, username) VALUES ($1, 'anna')", [USER]);
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address) VALUES
       ($1, 'Office', 'office@example.com'), ($2, 'Gmail', 'office@gmail.example'), ($3, 'Bare', 'bare@example.com')`,
    [ACCOUNT, GMAIL, BARE]
  );
  await db.query(
    `INSERT INTO folders (account_id, path, name, special_use) VALUES
       ($1, 'INBOX', 'INBOX', NULL), ($1, 'Trash', 'Trash', '\\Trash'), ($1, 'Drafts', 'Drafts', '\\Drafts'),
       ($2, 'INBOX', 'INBOX', NULL), ($2, '[Gmail]/Trash', 'Trash', '\\Trash'), ($2, '[Gmail]/All Mail', 'All Mail', '\\All'),
       ($3, 'INBOX', 'INBOX', NULL), ($3, 'Archive', 'Archive', NULL)`,
    [ACCOUNT, GMAIL, BARE]
  );
  const letters = [
    [A, ACCOUNT, 11, 'INBOX', false], [B, ACCOUNT, 12, 'INBOX', true], [T, ACCOUNT, 21, 'Trash', false],
    [U, ACCOUNT, 22, 'Trash', true], [D, ACCOUNT, 31, 'Drafts', true], [G, GMAIL, 41, 'INBOX', false],
    [N, BARE, 51, 'INBOX', true],
  ];
  mailServer = new Map();
  for (const [id, accountId, uid, folder, isRead] of letters) {
    const mid = `<${uid}@example.com>`;
    await db.query(
      'INSERT INTO messages (id, account_id, uid, folder, message_id, is_read, from_email) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, accountId, uid, folder, mid, isRead, 'sender@example.com']
    );
    box(accountId, folder).set(uid, mid);
  }
  const mgr = {
    _pendingMoveUids: new Map(),
    _guardMoveUid: ImapManager.prototype._guardMoveUid,
    _unguardMoveUid: ImapManager.prototype._unguardMoveUid,
    _isMoveUidGuarded: ImapManager.prototype._isMoveUidGuarded,
    _pendingFlagPush: new Map(),
    broadcast: vi.fn(),
    scheduleCountRefresh: vi.fn(),
    permanentDeleteMessage: vi.fn(async (account, uid, folder) => { box(account.id, folder).delete(Number(uid)); }),
    bulkPermanentDelete: vi.fn(async (account, uids, folder) => {
      for (const uid of uids) box(account.id, folder).delete(Number(uid));
      return { succeeded: uids, failed: [] };
    }),
  };
  mgr.moveQueue = new MoveQueue(mgr);
  mgr.moveQueue.kick = vi.fn();
  mgrState.mgr = mgr;
});

const mgr = () => mgrState.mgr;
const send = async (method, path, body) => {
  const res = await fetch(`${base}/api/mail${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
// `folder`: where the client listed the letter; omitted, the request is an older client's.
const del = (id, folder) => send('DELETE', `/messages/${id}`, folder === undefined ? undefined : { folder });
const bulkDelete = (ids, folders) => send('POST', '/messages/bulk-delete', folders ? { ids, folders } : { ids });
const row = async (id) => {
  const { rows: [r] } = await db.query('SELECT uid::int AS uid, folder FROM messages WHERE id = $1', [id]);
  return r ?? null;
};
const moves = async () => (await db.query('SELECT * FROM message_moves ORDER BY id')).rows;
const deltas = (accountId, folder) => adjustFolderCounts.mock.calls
  .filter(([acc, path]) => acc === accountId && path === folder)
  .map(([, , total, unread]) => [total, unread + 0]); // + 0: -0 reads as 0
const expunged = () => [
  ...mgr().permanentDeleteMessage.mock.calls.map(([, uid, folder]) => [folder, Number(uid)]),
  ...mgr().bulkPermanentDelete.mock.calls.flatMap(([, uids, folder]) => uids.map(u => [folder, Number(u)])),
];
// The worker's MOVE: the server moves each queued letter and names the new uid from `next` up.
async function settleAll(next = 900) {
  for (const op of await moves()) {
    const mid = box(op.account_id, op.src_folder).get(Number(op.src_uid));
    box(op.account_id, op.src_folder).delete(Number(op.src_uid));
    box(op.account_id, op.dest_folder).set(next, mid);
    await mgr().moveQueue._settle(op, next++);
  }
}

describe('a repeated delete never expunges what the first one moved to Trash', () => {
  it('a double delete from INBOX: the second is a no-op while the move is queued and after it settled', async () => {
    expect(await del(A, 'INBOX')).toEqual({ status: 200, body: { ok: true } });
    const [op] = await moves();
    expect(await row(A)).toEqual({ uid: placeholderUid(op.id), folder: 'Trash' });

    // Queued: the second delete finds the row in Trash with a placeholder uid.
    expect(await del(A, 'INBOX')).toEqual({ status: 200, body: { ok: true, alreadyInTrash: true } });
    expect(await moves()).toHaveLength(1);

    // Settled: the row is in Trash at a real uid, exactly like a letter deleted long ago.
    await settleAll(900);
    expect(await row(A)).toEqual({ uid: 900, folder: 'Trash' });
    expect(await del(A, 'INBOX')).toEqual({ status: 200, body: { ok: true, alreadyInTrash: true } });

    expect(expunged()).toEqual([]);
    expect(box(ACCOUNT, 'Trash').get(900)).toBe('<11@example.com>');
    expect(await row(A)).toEqual({ uid: 900, folder: 'Trash' });
    // Counted once: the no-ops touch no counts.
    expect(deltas(ACCOUNT, 'INBOX')).toEqual([[-1, -1]]);
    expect(deltas(ACCOUNT, 'Trash')).toEqual([[1, 1]]);
    // Journaled once, as a move to Trash.
    await vi.waitFor(async () => {
      const { rows } = await db.query('SELECT details FROM mailbox_audit_log');
      expect(rows.map(r => r.details.permanent)).toEqual([false]);
    });
  });

  it('an older client that names no folder never expunges, even a letter it did list in Trash', async () => {
    expect(await del(T)).toEqual({ status: 200, body: { ok: true, alreadyInTrash: true } });
    expect(await bulkDelete([U])).toEqual({ status: 200, body: { ok: true, deleted: [U] } });
    expect(expunged()).toEqual([]);
    expect(await row(T)).toEqual({ uid: 21, folder: 'Trash' });
    expect(await row(U)).toEqual({ uid: 22, folder: 'Trash' });
    // Bulk reads the per-letter map only: a top-level `folder` does not name the letters.
    const topLevel = await send('POST', '/messages/bulk-delete', { ids: [T, U], folder: 'Trash' });
    expect(topLevel.status).toBe(200);
    expect([...topLevel.body.deleted].sort()).toEqual([T, U]);
    expect(expunged()).toEqual([]);
    // An older client's move to Trash still moves.
    expect((await del(B)).status).toBe(200);
    expect((await row(B)).folder).toBe('Trash');
  });

  it('a delete while the move is on its way (claimed, MOVE sent) is a no-op too', async () => {
    await del(A, 'INBOX');
    await db.query("UPDATE message_moves SET state = 'moving', claimed_at = now(), sent_at = now()");
    expect(await del(A, 'INBOX')).toEqual({ status: 200, body: { ok: true, alreadyInTrash: true } });
    // Seen in Trash (the Trash list shows the pending row): nothing to expunge yet.
    const fromTrash = await del(A, 'Trash');
    expect(fromTrash.status).toBe(409);
    expect(fromTrash.body.code).toBe('move_pending');
    expect(expunged()).toEqual([]);
    expect(await moves()).toMatchObject([{ state: 'moving', dest_folder: 'Trash' }]);
  });

  it('two people deleting the same letter at once: one move, counted once, nothing expunged', async () => {
    const [first, second] = await Promise.all([del(A, 'INBOX'), del(A, 'INBOX')]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await moves()).toHaveLength(1);
    expect((await row(A)).folder).toBe('Trash');
    expect(expunged()).toEqual([]);
    expect(deltas(ACCOUNT, 'INBOX')).toEqual([[-1, -1]]);
    expect(deltas(ACCOUNT, 'Trash')).toEqual([[1, 1]]);
  });

  it('two people deleting forever from Trash at once: one expunge, one count, the other finds it gone', async () => {
    const results = await Promise.all([del(T, 'Trash'), del(T, 'Trash')]);
    expect(results.map(r => r.status).sort()).toEqual([200, 404]);
    expect(expunged()).toEqual([['Trash', 21]]);
    expect(await row(T)).toBeNull();
    expect(deltas(ACCOUNT, 'Trash')).toEqual([[-1, -1]]);
  });

  it('a delete from Trash whose row went while it looked (another delete won) answers 404 and sends nothing', async () => {
    let first;
    hooks.afterRead = async () => { first = await del(T, 'Trash'); };
    const second = await del(T, 'Trash');
    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect(expunged()).toEqual([['Trash', 21]]);
    expect(deltas(ACCOUNT, 'Trash')).toEqual([[-1, -1]]);
    await vi.waitFor(async () => {
      const { rows } = await db.query('SELECT count(*)::int AS n FROM mailbox_audit_log');
      expect(rows[0].n).toBe(1);
    });
  });
});

describe('deleting forever what the user sees in Trash still works', () => {
  it('expunges the letter, drops the row, counts and journals it as permanent', async () => {
    expect(await del(T, 'Trash')).toEqual({ status: 200, body: { ok: true } });
    expect(expunged()).toEqual([['Trash', 21]]);
    expect(box(ACCOUNT, 'Trash').has(21)).toBe(false);
    expect(await row(T)).toBeNull();
    expect(deltas(ACCOUNT, 'Trash')).toEqual([[-1, -1]]);
    await vi.waitFor(async () => {
      const { rows } = await db.query('SELECT details FROM mailbox_audit_log');
      expect(rows.map(r => r.details)).toMatchObject([{ folder: 'Trash', permanent: true }]);
    });
    // And a replay of it touches nothing.
    expect((await del(T, 'Trash')).status).toBe(404);
    expect(expunged()).toHaveLength(1);
  });

  it('permanent: true deletes forever a letter in Trash wherever the client listed it, and nothing outside Trash', async () => {
    expect((await send('DELETE', `/messages/${T}`, { permanent: true })).status).toBe(200);
    expect(await row(T)).toBeNull();
    expect((await send('DELETE', `/messages/${B}`, { permanent: true })).status).toBe(200);
    expect((await row(B)).folder).toBe('Trash');
    expect(expunged()).toEqual([['Trash', 21]]);
  });

  it('a letter the client saw in Trash that someone restored meanwhile goes back to Trash, never expunged', async () => {
    await mgr().moveQueue.enqueue(ACCOUNT, [{ id: T, folder: 'Trash', uid: 21 }], 'INBOX');
    expect((await del(T, 'Trash')).status).toBe(200);
    // The queued restore is dropped: the row is back at its server place in Trash.
    expect(await row(T)).toEqual({ uid: 21, folder: 'Trash' });
    expect(await moves()).toEqual([]);
    expect(expunged()).toEqual([]);
  });
});

describe('a delete from Trash racing a move out of Trash', () => {
  it('the move lands after the delete read the row: the delete sees the change under the lock and expunges nothing', async () => {
    hooks.afterRead = async () => {
      const moved = await mgr().moveQueue.enqueue(ACCOUNT, [{ id: T, folder: 'Trash', uid: 21 }], 'INBOX');
      expect(moved).toHaveLength(1);
    };
    const res = await del(T, 'Trash');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('move_pending');
    expect(expunged()).toEqual([]);
    expect(box(ACCOUNT, 'Trash').get(21)).toBe('<21@example.com>');
    const [op] = await moves();
    expect(await row(T)).toEqual({ uid: placeholderUid(op.id), folder: 'INBOX' });
    expect(deltas(ACCOUNT, 'Trash')).toEqual([]);
  });

  it('the same in a bulk delete: the moved letter is left alone and named move_pending', async () => {
    hooks.afterRead = async () => {
      await mgr().moveQueue.enqueue(ACCOUNT, [{ id: T, folder: 'Trash', uid: 21 }], 'INBOX');
    };
    const res = await bulkDelete([T, U], { [T]: 'Trash', [U]: 'Trash' });
    expect(res).toEqual({ status: 200, body: { ok: true, deleted: [U], code: 'move_pending' } });
    expect(expunged()).toEqual([['Trash', 22]]);
    expect((await row(T)).folder).toBe('INBOX');
    expect(await row(U)).toBeNull();
  });

  it('the move comes while the server delete is in flight: it waits for the lock and then finds the letter gone', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const expunge = mgr().permanentDeleteMessage.getMockImplementation();
    mgr().permanentDeleteMessage.mockImplementation(async (...args) => { await gate; return expunge(...args); });

    const deleting = del(T, 'Trash');
    await vi.waitFor(() => expect(mgr().permanentDeleteMessage).toHaveBeenCalledTimes(1));
    const moving = send('POST', '/messages/bulk-move', { ids: [T], folder: 'INBOX' });
    // Never awaited inside the gate: the move waits on the delete's transaction.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [deleted, moved] = await Promise.all([deleting, moving]);

    expect(deleted.status).toBe(200);
    expect(moved.body.moved ?? []).toEqual([]);
    expect(await row(T)).toBeNull();
    expect(await moves()).toEqual([]);
    expect(expunged()).toEqual([['Trash', 21]]);
  });
});

describe('bulk delete with a mix of letters', () => {
  it('moves what was seen outside Trash, expunges what was seen in Trash and drafts, and leaves the already-trashed alone', async () => {
    // A was deleted a moment ago (its move is queued); the client still lists it in INBOX.
    await del(A, 'INBOX');
    adjustFolderCounts.mockClear();
    const ids = [A, B, T, U, D];
    const res = await bulkDelete(ids, { [A]: 'INBOX', [B]: 'INBOX', [T]: 'Trash', [U]: 'INBOX', [D]: 'Drafts' });
    expect(res.status).toBe(200);
    expect([...res.body.deleted].sort()).toEqual([...ids].sort());
    expect(res.body.code).toBeUndefined();

    // Only T (seen in Trash) and the draft are expunged; U was seen in INBOX: moved there already.
    expect(expunged().sort()).toEqual([['Drafts', 31], ['Trash', 21]]);
    expect(await row(T)).toBeNull();
    expect(await row(D)).toBeNull();
    expect(await row(U)).toEqual({ uid: 22, folder: 'Trash' });
    expect((await row(B)).folder).toBe('Trash');
    expect((await row(A)).folder).toBe('Trash');
    expect(await moves()).toHaveLength(2); // A's earlier move and B's
    expect(deltas(ACCOUNT, 'INBOX')).toEqual([[-1, 0]]);
    expect(deltas(ACCOUNT, 'Trash').sort()).toEqual([[-1, -1], [1, 0]].sort());
    expect(deltas(ACCOUNT, 'Drafts')).toEqual([[-1, 0]]);
  });

  it('a replay of the same bulk delete after the moves settled expunges nothing more', async () => {
    const folders = { [A]: 'INBOX', [B]: 'INBOX' };
    await bulkDelete([A, B], folders);
    await settleAll(900);
    const replay = await bulkDelete([A, B], folders);
    expect(replay.status).toBe(200);
    expect([...replay.body.deleted].sort()).toEqual([A, B]);
    expect(expunged()).toEqual([]);
    expect(await row(A)).toEqual({ uid: 900, folder: 'Trash' });
    expect(await row(B)).toEqual({ uid: 901, folder: 'Trash' });
  });

  it('a letter seen in Trash whose move there is still pending waits (move_pending), the rest goes through', async () => {
    await del(A, 'INBOX');
    const res = await bulkDelete([A, T], { [A]: 'Trash', [T]: 'Trash' });
    expect(res).toEqual({ status: 200, body: { ok: true, deleted: [T], code: 'move_pending' } });
    expect(expunged()).toEqual([['Trash', 21]]);
  });
});

describe('Gmail Trash is [Gmail]/Trash', () => {
  it('a repeated delete leaves the letter in [Gmail]/Trash; a delete from the Trash view expunges it there', async () => {
    expect((await del(G, 'INBOX')).status).toBe(200);
    expect((await row(G)).folder).toBe('[Gmail]/Trash');
    await settleAll(700);
    expect(await del(G, 'INBOX')).toEqual({ status: 200, body: { ok: true, alreadyInTrash: true } });
    expect(await bulkDelete([G], { [G]: 'INBOX' })).toEqual({ status: 200, body: { ok: true, deleted: [G] } });
    expect(expunged()).toEqual([]);
    expect(box(GMAIL, '[Gmail]/Trash').get(700)).toBe('<41@example.com>');

    expect(await del(G, '[Gmail]/Trash')).toEqual({ status: 200, body: { ok: true } });
    expect(expunged()).toEqual([['[Gmail]/Trash', 700]]);
    expect(await row(G)).toBeNull();
  });
});

describe('a mailbox without a Trash folder keeps its behaviour', () => {
  it('refuses the delete (422, bulk skips it) and never expunges', async () => {
    expect((await del(N, 'INBOX')).status).toBe(422);
    expect(await bulkDelete([N], { [N]: 'INBOX' })).toEqual({ status: 200, body: { ok: true, deleted: [] } });
    expect(await row(N)).toEqual({ uid: 51, folder: 'INBOX' });
    expect(expunged()).toEqual([]);
  });
});
