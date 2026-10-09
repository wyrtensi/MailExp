import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('./gtdConfig.js', () => ({ getGtdConfig: vi.fn() }));
vi.mock('../../utils/mailUtils.js', () => ({ resolveAllDraftsPaths: vi.fn(), resolveAllTrashPaths: vi.fn(), resolveAllSpamPaths: vi.fn() }));
vi.mock('../../services/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  getOwnerAddresses,
  invalidateOwnerAddressesCache,
  runGtdTransitions,
  runTransitionsForSentMessage,
  threadKeysForMessageIds,
  threadKeysInFolders,
} from './gtdTransitions.js';
import { query } from '../../services/db.js';
import { getGtdConfig } from './gtdConfig.js';
import { resolveAllDraftsPaths, resolveAllTrashPaths, resolveAllSpamPaths } from '../../utils/mailUtils.js';

const DEFAULT_FOLDERS = { todo: 'Todo', watch: 'Watch', delegated: 'Delegated', someday: 'Someday', reference: 'Reference' };
const account = { id: 'acct-1', user_id: 'user-1', email_address: 'me@example.com', folder_mappings: {} };

// By default the server confirms every copy it is asked about, and the account is not Gmail.
const fakeManager = () => ({
  removeMessageCopy: vi.fn().mockResolvedValue({}),
  broadcast: vi.fn(),
  hasMessageCopy: vi.fn().mockResolvedValue(true),
  isLabelStore: vi.fn().mockReturnValue(false),
});

// One switchboard for the queries the engine issues: the sent-message Message-ID lookup
// (recognised by message_id = ANY), the owner-address UNION (account_aliases), and the
// per-thread row load (thread_key = ANY). A row that names no Message-ID is a copy of one shared
// message, so a GTD copy's INBOX row keeps that message once the GTD copy is stripped.
function mockQuery({ owner = [{ addr: 'me@example.com' }], rows = [], sent = [] }) {
  query.mockImplementation((sql) => {
    if (sql.includes('message_id = ANY')) return Promise.resolve({ rows: sent });
    if (sql.includes('account_aliases')) return Promise.resolve({ rows: owner });
    if (sql.includes('thread_key = ANY')) return Promise.resolve({ rows: rows.map(r => ({ message_id: '<m@x>', ...r })) });
    return Promise.resolve({ rows: [] });
  });
}

// ── getOwnerAddresses ────────────────────────────────────────────────────────

describe('getOwnerAddresses', () => {
  beforeEach(() => { query.mockReset(); invalidateOwnerAddressesCache('acct-1'); });

  it('unions the login address with aliases, lowercased', async () => {
    query.mockResolvedValueOnce({ rows: [{ addr: 'Me@Example.com' }, { addr: 'alias@example.com' }] });
    const set = await getOwnerAddresses('acct-1');
    expect(set.has('me@example.com')).toBe(true);
    expect(set.has('alias@example.com')).toBe(true);
  });

  it('normalizes a "Name <addr>" alias down to the bare addr-spec', async () => {
    query.mockResolvedValueOnce({ rows: [{ addr: 'me@example.com' }, { addr: 'Work Me <  Work@Alias.COM >' }] });
    const set = await getOwnerAddresses('acct-1');
    expect(set.has('work@alias.com')).toBe(true);
  });

  it('drops empty / blank alias values', async () => {
    query.mockResolvedValueOnce({ rows: [{ addr: 'me@example.com' }, { addr: '   ' }, { addr: null }] });
    const set = await getOwnerAddresses('acct-1');
    expect(set.size).toBe(1);
  });

  it('caches within the TTL and re-queries only after invalidation', async () => {
    query.mockResolvedValue({ rows: [{ addr: 'me@example.com' }] });
    await getOwnerAddresses('acct-1');
    await getOwnerAddresses('acct-1');
    expect(query).toHaveBeenCalledTimes(1);
    invalidateOwnerAddressesCache('acct-1');
    await getOwnerAddresses('acct-1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('picks up changed aliases immediately after cache invalidation', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ addr: 'me@example.com' }, { addr: 'old@example.com' }] })
      .mockResolvedValueOnce({ rows: [{ addr: 'me@example.com' }, { addr: 'masked@user.masked.fastmail.com' }] });
    const cached = await getOwnerAddresses('acct-1');
    expect(cached.has('old@example.com')).toBe(true);

    invalidateOwnerAddressesCache('acct-1');
    const refreshed = await getOwnerAddresses('acct-1');
    expect(refreshed.has('old@example.com')).toBe(false);
    expect(refreshed.has('masked@user.masked.fastmail.com')).toBe(true);
  });
});

// ── runGtdTransitions ────────────────────────────────────────────────────────

describe('runGtdTransitions', () => {
  beforeEach(() => {
    query.mockReset();
    getGtdConfig.mockReset();
    resolveAllDraftsPaths.mockReset();
    invalidateOwnerAddressesCache('acct-1');
    getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_FOLDERS });
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
    resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
    resolveAllSpamPaths.mockResolvedValue(new Set(['Junk']));
  });

  it('strips Todo and Someday when the last message is from the owner, leaving waiting labels', async () => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 10, folder: 'INBOX',     from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { thread_key: 't1', uid: 11, folder: 'Todo',      from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      { thread_key: 't1', uid: 12, folder: 'Someday',   from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r3' },
      { thread_key: 't1', uid: 13, folder: 'Watch',     from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r4' },
      { thread_key: 't1', uid: 14, folder: 'Delegated', from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r5' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 11, 'Todo', { background: true });
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 12, 'Someday', { background: true });
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 13, 'Watch');
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 14, 'Delegated');
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-1' });
  });

  it('keeps every GTD label when the last message is not from the owner', async () => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 20, folder: 'INBOX',     from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r1' },
      { thread_key: 't1', uid: 21, folder: 'Todo',      from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r2' },
      { thread_key: 't1', uid: 22, folder: 'Someday',   from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r3' },
      { thread_key: 't1', uid: 23, folder: 'Watch',     from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r4' },
      { thread_key: 't1', uid: 24, folder: 'Delegated', from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r5' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('treats an alias sender as the owner (self-strips Todo)', async () => {
    mockQuery({
      owner: [{ addr: 'me@example.com' }, { addr: 'Work Me <work@alias.com>' }],
      rows: [
        { thread_key: 't1', uid: 30, folder: 'INBOX', from_email: 'work@alias.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
        { thread_key: 't1', uid: 31, folder: 'Todo',  from_email: 'work@alias.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      ],
    });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 31, 'Todo', { background: true });
  });

  it('keeps Watch when the newest message is from a configured Fastmail masked alias', async () => {
    mockQuery({
      owner: [{ addr: 'me@example.com' }, { addr: 'masked@user.masked.fastmail.com' }],
      rows: [
        { thread_key: 't1', uid: 32, folder: 'INBOX', from_email: 'masked@user.masked.fastmail.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
        { thread_key: 't1', uid: 33, folder: 'Watch', from_email: 'masked@user.masked.fastmail.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      ],
    });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 33, 'Watch');
  });

  it('keeps Watch when the newest message is from an external address', async () => {
    mockQuery({
      owner: [{ addr: 'me@example.com' }, { addr: 'masked@user.masked.fastmail.com' }],
      rows: [
        { thread_key: 't1', uid: 34, folder: 'INBOX', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
        { thread_key: 't1', uid: 35, folder: 'Watch', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      ],
    });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 35, 'Watch');
  });

  it('never strips Reference, whoever sent last', async () => {
    // last message from me
    mockQuery({ rows: [
      { thread_key: 't1', uid: 40, folder: 'INBOX',     from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { thread_key: 't1', uid: 41, folder: 'Reference', from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
    ] });
    let mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();

    // last message from them
    invalidateOwnerAddressesCache('acct-1');
    mockQuery({ rows: [
      { thread_key: 't1', uid: 42, folder: 'INBOX',     from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r3' },
      { thread_key: 't1', uid: 43, folder: 'Reference', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r4' },
    ] });
    mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('does not let a newer owner-authored draft clear Todo or Someday', async () => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 50, folder: 'INBOX',   from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r1' },
      { thread_key: 't1', uid: 51, folder: 'Todo',    from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r2' },
      { thread_key: 't1', uid: 52, folder: 'Someday', from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r3' },
      { thread_key: 't1', uid: 53, folder: 'Drafts',  from_email: 'me@example.com',  date: '2026-07-09T15:00:00Z', id: 'r4' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('is fully inert when GTD is disabled — no rows query, no strips, no broadcast', async () => {
    getGtdConfig.mockResolvedValue({ enabled: false, folders: DEFAULT_FOLDERS });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(query).not.toHaveBeenCalled();
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('does nothing for an empty thread-key set (no config lookup)', async () => {
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, []);
    expect(getGtdConfig).not.toHaveBeenCalled();
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('is a no-op on the second run once the state-folder rows are gone (idempotent)', async () => {
    const withTodo = [
      { thread_key: 't1', uid: 60, folder: 'INBOX', from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { thread_key: 't1', uid: 61, folder: 'Todo',  from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
    ];
    const mgr = fakeManager();

    mockQuery({ rows: withTodo });
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);

    // Second run sees the stripped state: the Todo sibling is gone. Same verdict, nothing left.
    mockQuery({ rows: [withTodo[0]] });
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
  });

  it('keeps Watch and Delegated through subsequent transition reconciliation', async () => {
    const waitingRows = [
      { thread_key: 't1', uid: 62, folder: 'INBOX',     from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { thread_key: 't1', uid: 63, folder: 'Watch',     from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      { thread_key: 't1', uid: 64, folder: 'Delegated', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r3' },
    ];
    const mgr = fakeManager();

    mockQuery({ rows: waitingRows });
    await runGtdTransitions(mgr, account, ['t1']);
    mockQuery({ rows: waitingRows });
    await runGtdTransitions(mgr, account, ['t1']);

    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  // A label copy whose DB-first move is pending (placeholder uid, services/moveQueue.js) has
  // nothing on the server to delete yet: skipped, and not counted as stripped.
  it('skips a label copy whose move is pending instead of deleting a placeholder uid', async () => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 70, folder: 'INBOX', from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { thread_key: 't1', uid: -5, folder: 'Todo',  from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('tolerates a removeMessageCopy rejection (concurrent external strip) as success', async () => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 70, folder: 'INBOX', from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { thread_key: 't1', uid: 71, folder: 'Todo',  from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
    ] });
    const mgr = fakeManager();
    mgr.removeMessageCopy.mockRejectedValue(new Error('NO [TRYCREATE] no such UID'));
    await expect(runGtdTransitions(mgr, account, ['t1'])).resolves.toBeUndefined();
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 71, 'Todo', { background: true });
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
  });
});

// ── runTransitionsForSentMessage (the send-route hook) ───────────────────────

describe('runTransitionsForSentMessage', () => {
  beforeEach(() => {
    query.mockReset();
    getGtdConfig.mockReset();
    resolveAllDraftsPaths.mockReset();
    invalidateOwnerAddressesCache('acct-1');
    getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_FOLDERS });
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
    resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
    resolveAllSpamPaths.mockResolvedValue(new Set(['Junk']));
  });

  it('is inert when the account has GTD disabled — no query, no engine', async () => {
    getGtdConfig.mockResolvedValue({ enabled: false, folders: DEFAULT_FOLDERS });
    const mgr = fakeManager();
    await runTransitionsForSentMessage(mgr, account, '<abc@example.com>');
    expect(query).not.toHaveBeenCalled();
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('strips Todo and Someday on a self-reply while keeping Watch and Delegated', async () => {
    mockQuery({
      sent: [{ thread_key: 't1' }],
      rows: [
        { thread_key: 't1', uid: 80, folder: 'INBOX', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
        { thread_key: 't1', uid: 81, folder: 'Todo',  from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
        { thread_key: 't1', uid: 82, folder: 'Someday', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r3' },
        { thread_key: 't1', uid: 83, folder: 'Watch', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r4' },
        { thread_key: 't1', uid: 84, folder: 'Delegated', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r5' },
        // My just-sent reply, now synced into Sent — the newest non-draft message.
        { thread_key: 't1', uid: 85, folder: 'Sent',  from_email: 'me@example.com',  date: '2026-07-09T11:00:00Z', id: 'r6' },
      ],
    });
    const mgr = fakeManager();
    await runTransitionsForSentMessage(mgr, { ...account, gtd_enabled: true }, '<abc@example.com>');

    const midCall = query.mock.calls.find(([sql]) => sql.includes('message_id = ANY'));
    expect(midCall[1]).toEqual(['acct-1', ['abc@example.com', '<abc@example.com>']]);
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 81, 'Todo', { background: true });
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 82, 'Someday', { background: true });
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 83, 'Watch');
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 84, 'Delegated');
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-1' });
  });

  it('no-ops when the Sent copy has not synced yet (Message-ID resolves to nothing)', async () => {
    mockQuery({ sent: [] });
    const mgr = fakeManager();
    await runTransitionsForSentMessage(mgr, { ...account, gtd_enabled: true }, '<notyet@example.com>');
    // Only the Message-ID lookup ran; the engine short-circuits on an empty thread set.
    expect(query.mock.calls.every(([sql]) => sql.includes('message_id = ANY'))).toBe(true);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });
});

// ── thread-key resolvers (feed the two hooks) ────────────────────────────────

describe('threadKeysForMessageIds', () => {
  beforeEach(() => query.mockReset());

  it('returns the distinct thread keys for the given row ids', async () => {
    query.mockResolvedValue({ rows: [{ thread_key: 't1' }, { thread_key: 't2' }] });
    const keys = await threadKeysForMessageIds('acct-1', ['r1', 'r2']);
    expect(keys).toEqual(['t1', 't2']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('id = ANY($2::uuid[])');
    expect(params).toEqual(['acct-1', ['r1', 'r2']]);
  });

  it('short-circuits with no query on an empty id list', async () => {
    expect(await threadKeysForMessageIds('acct-1', [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('keys on row id with no folder filter, so a rule-MOVED reply still yields its thread', async () => {
    // An inbound reply a rule filed out of INBOX keeps its row (just in another folder) and
    // its thread must still be re-evaluated. The lookup never filters on folder, so the moved
    // row resolves.
    query.mockResolvedValue({ rows: [{ thread_key: 't-moved' }] });
    const keys = await threadKeysForMessageIds('acct-1', ['moved-reply']);
    expect(keys).toEqual(['t-moved']);
    expect(query.mock.calls[0][0]).not.toContain('folder');
  });
});

describe('threadKeysInFolders', () => {
  beforeEach(() => query.mockReset());

  it('returns the distinct thread keys for non-deleted rows in the given folders', async () => {
    query.mockResolvedValue({ rows: [{ thread_key: 't1' }] });
    const keys = await threadKeysInFolders('acct-1', ['Watch', 'Todo']);
    expect(keys).toEqual(['t1']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('folder = ANY($2::text[])');
    expect(sql).toContain('is_deleted = false');
    expect(params).toEqual(['acct-1', ['Watch', 'Todo']]);
  });

  it('short-circuits with no query on an empty folder list', async () => {
    expect(await threadKeysInFolders('acct-1', [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

// ── never strip a message's last copy (upstream f84f3aa9, #524) ──────────────
// Users can move mail into GTD folders, so a Todo or Someday copy can be the message's only one.
// An automatic strip deletes it only when a copy of the same message survives outside the GTD,
// Drafts, Trash and Junk folders, and the server confirms that copy.
describe('runGtdTransitions — the last copy of a message', () => {
  beforeEach(() => {
    query.mockReset();
    getGtdConfig.mockReset();
    invalidateOwnerAddressesCache('acct-1');
    getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_FOLDERS });
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
    resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
    resolveAllSpamPaths.mockResolvedValue(new Set(['Junk']));
  });

  // The incoming message lives only in Todo; the owner's reply is a different message in Sent.
  const onlyInTodo = (extra = []) => [
    { thread_key: 't1', uid: 98, folder: 'Todo', message_id: '<in@x>', from_email: 'them@other.com', date: '2026-07-01', id: 'in' },
    { thread_key: 't1', uid: 90, folder: 'Sent', message_id: '<reply@x>', from_email: 'me@example.com', date: '2026-07-02', id: 'reply' },
    ...extra,
  ];

  it('keeps a Todo copy that is the message\'s only copy', async () => {
    mockQuery({ rows: onlyInTodo() });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it.each(['Trash', 'Junk', 'Drafts', 'Someday', 'Watch'])('does not count a copy in %s', async (folder) => {
    mockQuery({ rows: onlyInTodo([
      { thread_key: 't1', uid: 10, folder, message_id: '<in@x>', from_email: 'them@other.com', date: '2026-07-01', id: 'other' },
    ]) });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 98, 'Todo', { background: true });
  });

  it('strips the Todo copy when the server confirms another copy, checking in the background', async () => {
    mockQuery({ rows: onlyInTodo([
      { thread_key: 't1', uid: 10, folder: 'Receipts', message_id: '<in@x>', from_email: 'them@other.com', date: '2026-07-01', id: 'kept' },
    ]) });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.hasMessageCopy).toHaveBeenCalledWith(account, 10, 'Receipts', '<in@x>', { background: true });
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 98, 'Todo', { background: true });
  });

  // A row can outlive its message for a while after another client moves it.
  it('keeps the Todo copy when the server does not confirm the other copy', async () => {
    mockQuery({ rows: onlyInTodo([
      { thread_key: 't1', uid: 10, folder: 'INBOX', message_id: '<in@x>', from_email: 'them@other.com', date: '2026-07-01', id: 'gone' },
    ]) });
    const mgr = fakeManager();
    mgr.hasMessageCopy.mockResolvedValue(false);
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('keeps the Todo copy when the confirmation fails', async () => {
    mockQuery({ rows: onlyInTodo([
      { thread_key: 't1', uid: 10, folder: 'INBOX', message_id: '<in@x>', from_email: 'them@other.com', date: '2026-07-01', id: 'inbox' },
    ]) });
    const mgr = fakeManager();
    mgr.hasMessageCopy.mockRejectedValue(new Error('connection refused'));
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('does not count a copy whose move is pending', async () => {
    mockQuery({ rows: onlyInTodo([
      { thread_key: 't1', uid: -4, folder: 'INBOX', message_id: '<in@x>', from_email: 'them@other.com', date: '2026-07-01', id: 'pending' },
    ]) });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.hasMessageCopy).not.toHaveBeenCalled();
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('keeps a Todo copy with no Message-ID, whose other copies cannot be found', async () => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 98, folder: 'Todo', message_id: null, from_email: 'them@other.com', date: '2026-07-01', id: 'in' },
      { thread_key: 't1', uid: 10, folder: 'INBOX', message_id: null, from_email: 'them@other.com', date: '2026-07-01', id: 'inbox' },
      { thread_key: 't1', uid: 90, folder: 'Sent', message_id: '<reply@x>', from_email: 'me@example.com', date: '2026-07-02', id: 'reply' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  // Gmail: a strip only drops the label; the message stays in All Mail.
  it('strips as before on Gmail, with no server check', async () => {
    mockQuery({ rows: onlyInTodo() });
    const mgr = fakeManager();
    mgr.isLabelStore.mockReturnValue(true);
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 98, 'Todo', { background: true });
    expect(mgr.hasMessageCopy).not.toHaveBeenCalled();
  });
});
