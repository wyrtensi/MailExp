import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(async () => 'Archive'),
  isAllMailFolder: vi.fn(async () => false),
  adjustFolderCounts: vi.fn(),
}));
import { query } from './db.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';
import { archiveInboxCopy, moveCopyToInbox } from './archiveInbox.js';

const account = { id: 'a', folder_mappings: {} };
const mkImap = (newUid = 91) => ({ moveMessage: vi.fn(async () => newUid), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn() });

beforeEach(() => {
  query.mockReset();
  adjustFolderCounts.mockReset();
  query.mockResolvedValue({ rowCount: 1 });
});

// An INBOX copy whose DB-first move is pending holds a placeholder uid (services/moveQueue.js):
// it is on its way elsewhere, and a MOVE from that uid would reach nothing.
describe('archiveInboxCopy', () => {
  it('does not archive a copy whose move is pending', async () => {
    const imap = mkImap();
    await expect(archiveInboxCopy(imap, account, { id: 'ib', uid: '-6' }))
      .rejects.toMatchObject({ movePending: true, code: 'move_pending' });
    expect(imap.moveMessage).not.toHaveBeenCalled();
    expect(imap._guardMoveUid).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('archives from INBOX by default', async () => {
    const imap = mkImap();
    expect(await archiveInboxCopy(imap, account, { id: 'ib', uid: 77 })).toEqual({ archived: true, noArchiveFolder: false });
    expect(imap.moveMessage).toHaveBeenCalledWith(account, 77, 'INBOX', 'Archive');
    expect(query.mock.calls[0][1]).toEqual(['Archive', 91, 'ib', 'INBOX']);
  });

  // GTD Done keeps a message's only copy, which lives in a label folder, by archiving it.
  it('archives from the folder it is given, guarding and counting that folder', async () => {
    const imap = mkImap();
    expect(await archiveInboxCopy(imap, account, { id: 'w', uid: 10 }, 'Watch')).toEqual({ archived: true, noArchiveFolder: false });
    expect(imap.moveMessage).toHaveBeenCalledWith(account, 10, 'Watch', 'Archive');
    expect(imap._guardMoveUid).toHaveBeenCalledWith('a', 'Watch', 10);
    expect(imap._unguardMoveUid).toHaveBeenCalledWith('a', 'Watch', 10);
    expect(query.mock.calls[0][1]).toEqual(['Archive', 91, 'w', 'Watch']);
    expect(adjustFolderCounts.mock.calls).toEqual([['a', 'Watch', -1, 0], ['a', 'Archive', 1, 0]]);
  });
});

// Removing a GTD label whose folder holds the message's only copy moves that copy back to INBOX
// instead of deleting it.
describe('moveCopyToInbox', () => {
  it('moves the copy to INBOX and repoints its row', async () => {
    const imap = mkImap(300);
    expect(await moveCopyToInbox(imap, account, { id: 't', uid: 10, is_read: true }, 'Todo')).toEqual({ moved: true });
    expect(imap.moveMessage).toHaveBeenCalledWith(account, 10, 'Todo', 'INBOX');
    expect(query.mock.calls[0][1]).toEqual(['INBOX', 300, 't', 'Todo']);
    expect(adjustFolderCounts.mock.calls).toEqual([['a', 'Todo', -1, 0], ['a', 'INBOX', 1, 0]]);
  });

  it('carries an unread copy\'s unread count along', async () => {
    await moveCopyToInbox(mkImap(), account, { id: 't', uid: 10, is_read: false }, 'Todo');
    expect(adjustFolderCounts.mock.calls).toEqual([['a', 'Todo', -1, -1], ['a', 'INBOX', 1, 1]]);
  });

  it('moves no count when a concurrent action already moved the row', async () => {
    query.mockResolvedValue({ rowCount: 0 });
    expect(await moveCopyToInbox(mkImap(), account, { id: 't', uid: 10, is_read: true }, 'Todo')).toEqual({ moved: false });
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('does not move a copy whose move is pending', async () => {
    const imap = mkImap();
    await expect(moveCopyToInbox(imap, account, { id: 't', uid: -2 }, 'Todo')).rejects.toMatchObject({ movePending: true });
    expect(imap.moveMessage).not.toHaveBeenCalled();
  });
});
