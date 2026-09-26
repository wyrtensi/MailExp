// The DB-first move queue on a mail server without the MOVE extension, end to end: the real
// queue (moveQueue.js) against the real schema, and the real bulkMoveMessages under it, talking to
// a fake IMAP server through imapflow's own move command.
//
// imapflow 2.0.3 emulates MOVE there as COPY, then \Deleted + EXPUNGE, and expunged the source even
// when the server refused the COPY (upstream maathimself/mailflow@05a8b6e8). Through the queue that
// was the worst outcome: the letter was gone from the server, nowhere else, and the queue reverted
// its row to the source as 'gone'. A refused COPY must be an ordinary failed move instead: the
// letter stays on the server, the move is retried, and it settles once the server takes the COPY.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import imapflowMove from 'imapflow/lib/commands/move.js';
import { createRealSchemaDb } from './testing/realSchema.js';

const dbState = { db: null };
vi.mock('./db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./encryption.js', () => ({ encrypt: vi.fn(v => v), decrypt: vi.fn(() => 'pw') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn(), validateHost: vi.fn(async () => null) }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({ ...(await importOriginal()), adjustFolderCounts: vi.fn() }));

const { ImapFlow } = await import('imapflow');
const { resolveForConnection } = await import('./hostValidation.js');
const { getConnectionPolicy } = await import('./connectionPolicy.js');
const { ImapManager, evictPool } = await import('./imapManager.js');
const { MoveQueue } = await import('./moveQueue.js');

const ACCOUNT = '50000000-0000-4000-8000-000000000001';
const USER = '52000000-0000-4000-8000-000000000001';
const A = '51000000-0000-4000-8000-000000000001';
let db;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

// The mail server, shared by every connection the pool opens. No MOVE, with UIDPLUS.
let server;
function uidSet(range, present) {
  const want = new Set([].concat(range).join(',').split(',').map(Number));
  return present.filter(u => want.has(u));
}
function connectionTo() {
  return Object.assign(new EventEmitter(), {
    capabilities: new Map(server.capabilities.map(c => [c, true])),
    enabled: new Set(),
    states: { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 },
    state: 2,
    usable: true,
    mailbox: false,
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    logout: vi.fn(async () => {}),
    async getMailboxLock(path) {
      this.mailbox = { path, exists: server.folders[path].uids.length };
      this.state = this.states.SELECTED;
      return { release: () => {} };
    },
    async status(path) { return { path, uidNext: server.folders[path].uidNext }; },
    async search(q) { return uidSet(q.uid, server.folders[this.mailbox.path].uids); },
    async messageCopy(range, destination) {
      const uids = uidSet(range, server.folders[this.mailbox.path].uids);
      server.commands.push('COPY');
      if (server.refuseCopy) return false; // imapflow copy.js: a NO resolves false
      const dst = server.folders[destination];
      const uidMap = new Map(uids.map(u => [u, dst.uidNext++]));
      dst.uids.push(...uidMap.values());
      const res = { path: this.mailbox.path, destination };
      return this.capabilities.has('UIDPLUS') ? { ...res, uidValidity: 1n, uidMap } : res;
    },
    async messageDelete(range) {
      const src = server.folders[this.mailbox.path];
      const uids = uidSet(range, src.uids);
      server.commands.push('EXPUNGE');
      if (server.refuseExpunge) return false; // imapflow expunge.js: a NO resolves false
      src.uids = src.uids.filter(u => !uids.includes(u));
      return true;
    },
    messageMove(range, destination, options) {
      return imapflowMove(this, [].concat(range).join(','), destination, options);
    },
  });
}

// The manager surface the queue uses. The IMAP side of a move is the real one (bulkMoveMessages,
// its reconcile and the source check); the rest is what moveQueue.pglite.test.js fakes too.
function manager() {
  return {
    connections: new Map(),
    _pollOnlyAccounts: new Set([ACCOUNT]),
    _pendingMoveUids: new Map(),
    _guardMoveUid: ImapManager.prototype._guardMoveUid,
    _unguardMoveUid: ImapManager.prototype._unguardMoveUid,
    _isMoveUidGuarded: ImapManager.prototype._isMoveUidGuarded,
    _secondaryLoginBlocked: vi.fn(() => null),
    _poolLoginOpts: vi.fn(() => ({ noNewLogin: false })),
    flagStoresSettled: vi.fn(async () => {}),
    bulkMoveMessages: ImapManager.prototype.bulkMoveMessages,
    _reconcileMoveBySearch: ImapManager.prototype._reconcileMoveBySearch,
    searchUids: ImapManager.prototype.searchUids,
    findMessageIdInFolders: vi.fn(async () => []),
    setFlags: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    _pendingFlagPush: new Map(),
    _enqueueFlagPush: vi.fn(),
    _resolveFlagPush: vi.fn(),
    _scheduleProviderIdBackfill: vi.fn(),
    broadcast: vi.fn(),
  };
}

let queue;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  evictPool(ACCOUNT);
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  ImapFlow.mockImplementation(function () { return connectionTo(); });
  server = {
    capabilities: ['IMAP4rev1', 'UIDPLUS'],
    refuseCopy: true,
    refuseExpunge: false,
    folders: { INBOX: { uids: [11], uidNext: 12 }, Archive: { uids: [], uidNext: 900 } },
    commands: [],
  };
  await db.exec('DELETE FROM mailbox_audit_log; DELETE FROM message_moves; DELETE FROM messages; DELETE FROM folders; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query("INSERT INTO users (id, username) VALUES ($1, 'anna')", [USER]);
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, imap_host, imap_port, imap_tls, auth_user, auth_pass)
     VALUES ($1, 'Office', 'office@example.com', 'imap.example.com', 993, true, 'office', 'enc')`,
    [ACCOUNT]
  );
  for (const path of ['INBOX', 'Archive']) {
    await db.query('INSERT INTO folders (account_id, path, name) VALUES ($1, $2, $2)', [ACCOUNT, path]);
  }
  await db.query(
    "INSERT INTO messages (id, account_id, uid, folder, message_id) VALUES ($1, $2, 11, 'INBOX', '<a@example.com>')",
    [A, ACCOUNT]
  );
  queue = new MoveQueue(manager());
  queue.kick = vi.fn(); // the worker runs when the test says so
});
afterEach(() => {
  evictPool(ACCOUNT);
  vi.restoreAllMocks();
});

const moves = async () => (await db.query('SELECT state, attempts FROM message_moves')).rows;
const row = async () => (await db.query('SELECT uid::int AS uid, folder FROM messages WHERE id = $1', [A])).rows[0];

describe('the move queue on a server without MOVE', () => {
  it('a refused COPY is a failed move: the letter stays on the server and the move is retried', async () => {
    const [rowA] = (await db.query('SELECT * FROM messages WHERE id = $1', [A])).rows;
    await queue.enqueue(ACCOUNT, [rowA], 'Archive');
    await queue.runAccount(ACCOUNT);

    expect(server.commands).toEqual(['COPY']);          // no EXPUNGE after the refused COPY
    expect(server.folders.INBOX.uids).toEqual([11]);    // the letter is still on the server
    expect(await moves()).toEqual([{ state: 'queued', attempts: 1 }]); // retried later, not settled
    expect((await row()).folder).toBe('Archive');       // the row keeps its DB-first place

    // The server takes the COPY on the retry: the move completes and the row gets its uid.
    server.refuseCopy = false;
    await db.query('UPDATE message_moves SET next_attempt_at = now()');
    await queue.runAccount(ACCOUNT);

    expect(server.folders.INBOX.uids).toEqual([]);
    expect(server.folders.Archive.uids).toEqual([900]);
    expect(await moves()).toEqual([]);
    expect(await row()).toEqual({ uid: 900, folder: 'Archive' });
  });

  // The COPY lands but the server refuses the delete (no right to delete in a shared folder, say):
  // the letter is in both folders. That must end the move, never retry it: every retry would COPY
  // it into the destination once more.
  const runTwice = async () => {
    const [rowA] = (await db.query('SELECT * FROM messages WHERE id = $1', [A])).rows;
    await queue.enqueue(ACCOUNT, [rowA], 'Archive');
    await queue.runAccount(ACCOUNT);
    await db.query('UPDATE message_moves SET next_attempt_at = now()');
    await queue.runAccount(ACCOUNT);
  };

  it('a copied letter whose source the server kept is copied once, without UIDPLUS', async () => {
    Object.assign(server, { capabilities: ['IMAP4rev1'], refuseCopy: false, refuseExpunge: true });
    await runTwice();

    expect(server.commands.filter(c => c === 'COPY')).toHaveLength(1);
    expect(server.folders.Archive.uids).toEqual([900]);
    expect(server.folders.INBOX.uids).toEqual([11]);
    expect(await moves()).toEqual([]);
    // No uid to settle on: the row goes, and both folders sync to show the letter where it is.
    expect(await row()).toBeUndefined();
    expect(queue.mgr.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 'Archive', { background: true });
    expect(queue.mgr.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 'INBOX', { background: true });
  });

  it('a copied letter whose source the server kept is copied once, with UIDPLUS', async () => {
    Object.assign(server, { refuseCopy: false, refuseExpunge: true });
    await runTwice();

    expect(server.commands.filter(c => c === 'COPY')).toHaveLength(1);
    expect(await moves()).toEqual([]);
    expect(await row()).toEqual({ uid: 900, folder: 'Archive' });
    expect(queue.mgr.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 'INBOX', { background: true });
  });
});
