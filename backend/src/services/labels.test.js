import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  fanOutReadToSiblings: vi.fn(),
  resolveAllDraftsPaths: vi.fn(),
  resolveAllTrashPaths: vi.fn(),
  resolveAllSpamPaths: vi.fn(),
}));
import { query } from './db.js';
import { fanOutReadToSiblings, resolveAllDraftsPaths, resolveAllTrashPaths, resolveAllSpamPaths } from '../utils/mailUtils.js';
import {
  findSurvivingCopy,
  checkMessageCopy,
  markCopySeen,
  applyLabel,
  removeExactLabelCopy,
  removeLabel,
  resolveLabelCopyUid,
  markThreadRead,
  ensureLabelFolders,
  assertNoPendingCopies,
} from './labels.js';

const account = { id: 'acct-1' };
const mkImap = () => ({ ensureFolder: vi.fn(), copyMessage: vi.fn(), removeMessageCopy: vi.fn() });

beforeEach(() => { query.mockReset(); fanOutReadToSiblings.mockReset(); });

describe('resolveLabelCopyUid', () => {
  it('uses the acted row directly when it already lives in the folder', async () => {
    const uid = await resolveLabelCopyUid({ folder: 'Todo', uid: 42, account_id: 'a', message_id: '<m>' }, 'Todo');
    expect(uid).toBe(42);
    expect(query).not.toHaveBeenCalled(); // no DB lookup needed
  });

  it('resolves the sibling copy via shared Message-ID otherwise', async () => {
    query.mockResolvedValueOnce({ rows: [{ uid: 99 }] });
    const uid = await resolveLabelCopyUid({ folder: 'INBOX', uid: 1, account_id: 'a', message_id: '<m>' }, 'Todo');
    expect(uid).toBe(99);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM messages WHERE account_id = \$1 AND folder = \$2 AND message_id = \$3/);
    expect(params).toEqual(['a', 'Todo', '<m>']);
  });

  it('returns null when no sibling exists, and when the message has no Message-ID', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await resolveLabelCopyUid({ folder: 'INBOX', uid: 1, account_id: 'a', message_id: '<m>' }, 'Todo')).toBeNull();
    expect(await resolveLabelCopyUid({ folder: 'INBOX', uid: 1, account_id: 'a', message_id: null }, 'Todo')).toBeNull();
  });
});

describe('applyLabel', () => {
  it('returns the exact UIDPLUS destination identity after copying', async () => {
    const imap = mkImap();
    imap.copyMessage.mockResolvedValueOnce(77);
    const r = await applyLabel(imap, account, { uid: 7, folder: 'INBOX' }, 'Todo');
    expect(r).toEqual({ applied: true, uid: 77 });
    expect(imap.ensureFolder).toHaveBeenCalledWith(account, 'Todo');
    expect(imap.copyMessage).toHaveBeenCalledWith('acct-1', 7, 'INBOX', 'Todo');
  });

  it('reports a successful non-UIDPLUS copy without inventing an identity', async () => {
    const imap = mkImap();
    imap.copyMessage.mockResolvedValueOnce(null);
    const r = await applyLabel(imap, account, { uid: 7, folder: 'INBOX' }, 'Todo');
    expect(r).toEqual({ applied: true, uid: null });
  });

  it('is a no-op when the message already lives in the label folder', async () => {
    const imap = mkImap();
    const r = await applyLabel(imap, account, { uid: 7, folder: 'Todo' }, 'Todo');
    expect(r).toEqual({ applied: false, uid: 7, reason: 'already-there' });
    expect(imap.ensureFolder).not.toHaveBeenCalled();
    expect(imap.copyMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when a sibling already carries the label', async () => {
    query.mockResolvedValueOnce({ rows: [{ uid: 91 }] });
    const imap = mkImap();
    const r = await applyLabel(imap, account, {
      account_id: 'acct-1', uid: 7, folder: 'INBOX', message_id: '<m>',
    }, 'Todo');
    expect(r).toEqual({ applied: false, uid: 91, reason: 'already-labelled' });
    expect(imap.ensureFolder).not.toHaveBeenCalled();
    expect(imap.copyMessage).not.toHaveBeenCalled();
  });
});

describe('removeExactLabelCopy', () => {
  const source = { account_id: 'acct-1', message_id: '<source@example.com>', thread_key: 'thread-1' };

  it('removes only the requested UID when it belongs to the exact source message', async () => {
    query.mockResolvedValueOnce({ rows: [{ uid: 77 }] });
    const imap = mkImap();
    const result = await removeExactLabelCopy(imap, source, 'Todo', 77);

    expect(result).toEqual({ removed: true });
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/message_id = \$4/), [
      'acct-1', 'Todo', 77, '<source@example.com>',
    ]);
    expect(imap.removeMessageCopy).toHaveBeenCalledWith('acct-1', 77, 'Todo');
  });

  it('does not remove an absent UID or a UID belonging to another message', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const imap = mkImap();
    const result = await removeExactLabelCopy(imap, source, 'Todo', 77);

    expect(result).toEqual({ removed: false });
    expect(imap.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('does not advertise an unverifiable inverse for a source without a Message-ID', async () => {
    const imap = mkImap();
    const result = await removeExactLabelCopy(
      imap,
      { account_id: 'acct-1', message_id: null, thread_key: 'row-specific-key' },
      'Todo',
      77,
    );

    expect(result).toEqual({ removed: false });
    expect(query).not.toHaveBeenCalled();
    expect(imap.removeMessageCopy).not.toHaveBeenCalled();
  });
});

describe('removeLabel', () => {
  it('removes the resolved sibling copy from the label folder', async () => {
    query.mockResolvedValueOnce({ rows: [{ uid: 99 }] });
    const imap = mkImap();
    const r = await removeLabel(imap, { account_id: 'acct-1', uid: 1, folder: 'INBOX', message_id: '<m>' }, 'Todo');
    expect(r).toEqual({ removed: true });
    expect(imap.removeMessageCopy).toHaveBeenCalledWith('acct-1', 99, 'Todo');
  });

  it('is a no-op (no IMAP call) when no copy lives in the label folder', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const imap = mkImap();
    const r = await removeLabel(imap, { account_id: 'acct-1', uid: 1, folder: 'INBOX', message_id: '<m>' }, 'Todo');
    expect(r).toEqual({ removed: false });
    expect(imap.removeMessageCopy).not.toHaveBeenCalled();
  });
});

describe('ensureLabelFolders', () => {
  it('dedupes paths, resolves each to its real server path, and reports created', async () => {
    const imap = { ensureFolder: vi.fn()
      .mockResolvedValueOnce({ path: 'INBOX.Todo', created: true })
      .mockResolvedValueOnce({ path: 'INBOX.Watch', created: false }) };
    const results = await ensureLabelFolders(imap, account, ['Todo', 'Watch', 'Todo']);
    expect(results).toEqual([
      { folder: 'Todo', path: 'INBOX.Todo', created: true },
      { folder: 'Watch', path: 'INBOX.Watch', created: false },
    ]);
    expect(imap.ensureFolder).toHaveBeenCalledTimes(2); // 'Todo' deduped
    expect(imap.ensureFolder).toHaveBeenCalledWith(account, 'Todo', { resolvePath: true });
  });

  it('isolates a single folder failure and continues with the rest', async () => {
    const imap = { ensureFolder: vi.fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ path: 'Watch', created: true }) };
    const results = await ensureLabelFolders(imap, account, ['Todo', 'Watch']);
    expect(results).toEqual([
      { folder: 'Todo', error: true },
      { folder: 'Watch', path: 'Watch', created: true },
    ]);
  });
});

describe('markThreadRead', () => {
  const msg = { account_id: 'acct-1', message_id: '<m>' };
  const imapMR = () => ({ setFlag: vi.fn() });

  it('fans out read state and sets \\Seen on an unread INBOX copy; returns the copy', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'i1', uid: 5, is_read: false }] });
    const imap = imapMR();
    const r = await markThreadRead(imap, { id: 'acct-1' }, msg);
    expect(fanOutReadToSiblings).toHaveBeenCalledWith('acct-1', '<m>', true);
    expect(imap.setFlag).toHaveBeenCalledWith({ id: 'acct-1' }, 5, 'INBOX', '\\Seen', true);
    expect(r.inboxCopy).toEqual({ id: 'i1', uid: 5, is_read: false });
    expect(r.error).toBeUndefined();
  });

  it('skips the flag push when the INBOX copy is already read', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'i1', uid: 5, is_read: true }] });
    const imap = imapMR();
    await markThreadRead(imap, { id: 'acct-1' }, msg);
    expect(fanOutReadToSiblings).toHaveBeenCalled();
    expect(imap.setFlag).not.toHaveBeenCalled();
  });

  it('handles no INBOX copy (nothing to flag, inboxCopy null)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const imap = imapMR();
    const r = await markThreadRead(imap, { id: 'acct-1' }, msg);
    expect(r.inboxCopy).toBeNull();
    expect(imap.setFlag).not.toHaveBeenCalled();
  });

  it('degrades gracefully: a fan-out failure returns the copy + error, never throws', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'i1', uid: 5, is_read: false }] });
    fanOutReadToSiblings.mockRejectedValueOnce(new Error('db down'));
    const imap = imapMR();
    const r = await markThreadRead(imap, { id: 'acct-1' }, msg);
    expect(r.inboxCopy).toEqual({ id: 'i1', uid: 5, is_read: false }); // still available for archive
    expect(r.error).toBeInstanceOf(Error);
  });
});

// A letter whose DB-first move is pending holds a placeholder uid (services/moveQueue.js): no
// COPY, STORE or delete may be sent for it. Label work throws movePending before changing anything.
describe('a letter whose move is pending', () => {
  it('is not labelled: no COPY from a placeholder uid', async () => {
    const imap = mkImap();
    query.mockResolvedValueOnce({ rows: [] }); // no label copy yet
    await expect(applyLabel(imap, account, { uid: -4, folder: 'INBOX', account_id: 'a', message_id: '<m>' }, 'Todo'))
      .rejects.toMatchObject({ movePending: true, code: 'move_pending' });
    expect(imap.ensureFolder).not.toHaveBeenCalled();
    expect(imap.copyMessage).not.toHaveBeenCalled();
  });

  it('has no label copy to remove while it or that copy is pending', async () => {
    const imap = mkImap();
    await expect(removeLabel(imap, { uid: -4, folder: 'Todo', account_id: 'a', message_id: '<m>' }, 'Todo'))
      .rejects.toMatchObject({ movePending: true });
    query.mockResolvedValueOnce({ rows: [{ uid: '-9' }] });
    await expect(removeLabel(imap, { uid: 1, folder: 'INBOX', account_id: 'a', message_id: '<m>' }, 'Todo'))
      .rejects.toMatchObject({ movePending: true });
    expect(imap.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('is not marked read at its INBOX copy while that copy is pending', async () => {
    const imap = { setFlag: vi.fn() };
    query.mockResolvedValueOnce({ rows: [{ id: 'ib', uid: '-3', is_read: false }] });
    await expect(markThreadRead(imap, account, { account_id: 'a', message_id: '<m>' })).rejects.toMatchObject({ movePending: true });
    expect(fanOutReadToSiblings).not.toHaveBeenCalled();
    expect(imap.setFlag).not.toHaveBeenCalled();
  });

  it('is found by assertNoPendingCopies, itself or a copy in the given folders', async () => {
    await expect(assertNoPendingCopies({ uid: -1, account_id: 'a', message_id: '<m>' }, ['INBOX'])).rejects.toMatchObject({ movePending: true });
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(assertNoPendingCopies({ uid: 5, account_id: 'a', message_id: '<m>' }, ['INBOX', 'Todo'])).rejects.toMatchObject({ movePending: true });
    expect(query.mock.calls.at(-1)[1]).toEqual(['a', '<m>', ['INBOX', 'Todo']]);
    query.mockResolvedValueOnce({ rows: [] });
    await expect(assertNoPendingCopies({ uid: 5, account_id: 'a', message_id: '<m>' }, ['INBOX'])).resolves.toBeUndefined();
  });
});

/// GTD deletes a label copy outright, and a label folder can hold a message's only copy: mail the
// user filed there by moving it (upstream #524). findSurvivingCopy answers whether another copy
// keeps the message outside the excluded folders: 'kept', 'none', or 'unknown' when it could not
// tell.
describe('findSurvivingCopy', () => {
  const msg = { id: 'm1', account_id: 'acct-1', uid: 10, folder: 'Todo', message_id: '<m@x>' };
  const mkEngine = ({ labelStore = false, live = () => true } = {}) => ({
    isLabelStore: vi.fn(() => labelStore),
    hasMessageCopy: vi.fn(async (_account, uid, folder) => live(uid, folder)),
  });
  // `copies` are the message's rows as [folder, uid, date?] triples.
  const stubCopies = (copies) => query.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT folder, uid, date FROM messages')) return { rows: copies.map(([folder, uid, date = null]) => ({ folder, uid, date })) };
    return { rows: [] };
  });
  beforeEach(() => {
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
    resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
    resolveAllSpamPaths.mockResolvedValue(new Set(['Junk']));
  });

  it('is kept when the server confirms a copy outside the excluded folders, matching its date', async () => {
    stubCopies([['Todo', 10], ['INBOX', 55, '2026-07-01T10:00:00Z']]);
    const engine = mkEngine();
    expect(await findSurvivingCopy(engine, account, msg, ['Todo'])).toBe('kept');
    expect(engine.hasMessageCopy).toHaveBeenCalledWith(account, 55, 'INBOX', '<m@x>', { background: false, date: '2026-07-01T10:00:00Z' });
    expect(engine.hasMessageCopy).toHaveBeenCalledTimes(1);
  });

  it('is none when the excluded folder holds the only copy', async () => {
    stubCopies([['Todo', 10]]);
    const engine = mkEngine();
    expect(await findSurvivingCopy(engine, account, msg, ['Todo'])).toBe('none');
    expect(engine.hasMessageCopy).not.toHaveBeenCalled();
  });

  it('does not count Drafts, Trash or Junk, which get emptied', async () => {
    stubCopies([['Todo', 10], ['Trash', 3], ['Junk', 4], ['Drafts', 5]]);
    expect(await findSurvivingCopy(mkEngine(), account, msg, ['Todo'])).toBe('none');
  });

  it('does not count a copy in another excluded label folder', async () => {
    stubCopies([['Todo', 10], ['Watch', 41]]);
    expect(await findSurvivingCopy(mkEngine(), account, msg, ['Todo', 'Watch'])).toBe('none');
  });

  it('does not count a row the server no longer has', async () => {
    stubCopies([['Todo', 10], ['INBOX', 55], ['Receipts', 8]]);
    expect(await findSurvivingCopy(mkEngine({ live: (_uid, folder) => folder === 'Receipts' }), account, msg, ['Todo'])).toBe('kept');
    stubCopies([['Todo', 10], ['INBOX', 55]]);
    expect(await findSurvivingCopy(mkEngine({ live: () => false }), account, msg, ['Todo'])).toBe('none');
  });

  it('is unknown when no copy is confirmed and a check failed', async () => {
    stubCopies([['Todo', 10], ['INBOX', 55]]);
    const engine = mkEngine();
    engine.hasMessageCopy.mockRejectedValue(new Error('connection refused'));
    expect(await findSurvivingCopy(engine, account, msg, ['Todo'])).toBe('unknown');
  });

  it('is kept when one check failed but another copy is confirmed', async () => {
    stubCopies([['Todo', 10], ['INBOX', 55], ['Receipts', 8]]);
    const engine = mkEngine();
    engine.hasMessageCopy.mockRejectedValueOnce(new Error('connection refused'));
    expect(await findSurvivingCopy(engine, account, msg, ['Todo'])).toBe('kept');
  });

  it('does not count a copy whose move is pending: it has no server uid to confirm', async () => {
    stubCopies([['Todo', 10], ['INBOX', '-4']]);
    const engine = mkEngine();
    expect(await findSurvivingCopy(engine, account, msg, ['Todo'])).toBe('none');
    expect(engine.hasMessageCopy).not.toHaveBeenCalled();
  });

  it('is none without a Message-ID, since the other copies cannot be found', async () => {
    expect(await findSurvivingCopy(mkEngine(), account, { ...msg, message_id: null }, ['Todo'])).toBe('none');
    expect(query).not.toHaveBeenCalled();
  });

  // Gmail: a folder is a label, and removing it leaves the message in All Mail.
  it('is always kept on a label store, with no lookups', async () => {
    const engine = mkEngine({ labelStore: true });
    expect(await findSurvivingCopy(engine, account, msg, ['Todo'])).toBe('kept');
    expect(query).not.toHaveBeenCalled();
    expect(engine.hasMessageCopy).not.toHaveBeenCalled();
  });

  it('passes background through to the server check', async () => {
    stubCopies([['Todo', 10], ['INBOX', 55]]);
    const engine = mkEngine();
    await findSurvivingCopy(engine, account, msg, ['Todo'], { background: true });
    expect(engine.hasMessageCopy).toHaveBeenCalledWith(account, 55, 'INBOX', '<m@x>', { background: true, date: null });
  });
});

describe('checkMessageCopy', () => {
  const mkEngine = (impl, labelStore = false) => ({ isLabelStore: vi.fn(() => labelStore), hasMessageCopy: vi.fn(impl) });

  it('answers kept, none or unknown from the server check', async () => {
    expect(await checkMessageCopy(mkEngine(async () => true), account, { uid: 7 }, 'INBOX', '<m@x>')).toBe('kept');
    expect(await checkMessageCopy(mkEngine(async () => false), account, { uid: 7 }, 'INBOX', '<m@x>')).toBe('none');
    expect(await checkMessageCopy(mkEngine(async () => { throw new Error('down'); }), account, { uid: 7 }, 'INBOX', '<m@x>')).toBe('unknown');
  });

  it('is none with nothing to check, and kept on a label store', async () => {
    const engine = mkEngine(async () => true);
    expect(await checkMessageCopy(engine, account, { uid: -2 }, 'INBOX', '<m@x>')).toBe('none');
    expect(await checkMessageCopy(engine, account, { uid: 7 }, 'INBOX', null)).toBe('none');
    expect(engine.hasMessageCopy).not.toHaveBeenCalled();
    expect(await checkMessageCopy(mkEngine(async () => false, true), account, { uid: 7 }, 'INBOX', '<m@x>')).toBe('kept');
  });
});

// When a label copy becomes the durable one (GTD Done keeps a message's only copy), it takes the
// \Seen that markThreadRead set on INBOX only; otherwise the next sync reads it back as unread.
describe('markCopySeen', () => {
  it('sets \\Seen on an unread copy', async () => {
    const imap = { setFlag: vi.fn() };
    expect(await markCopySeen(imap, account, { uid: 10, folder: 'Watch', is_read: false })).toEqual({});
    expect(imap.setFlag).toHaveBeenCalledWith(account, 10, 'Watch', '\\Seen', true);
  });

  it('sends nothing for a copy already read', async () => {
    const imap = { setFlag: vi.fn() };
    await markCopySeen(imap, account, { uid: 10, folder: 'Watch', is_read: true });
    expect(imap.setFlag).not.toHaveBeenCalled();
  });

  it('reports a failed flag push instead of throwing', async () => {
    const err = new Error('STORE failed');
    const imap = { setFlag: vi.fn().mockRejectedValue(err) };
    expect(await markCopySeen(imap, account, { uid: 10, folder: 'Watch', is_read: false })).toEqual({ error: err });
  });
});
