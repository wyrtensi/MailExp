import { query } from './db.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts } from '../utils/mailUtils.js';
import { movePendingError } from '../utils/mailboxBusy.js';

// Archive a single copy of a message (INBOX unless `fromFolder` says otherwise): the one guarded
// per-copy archive move, shared by any route that needs "move this row to the account's Archive
// and repoint the DB". The GTD /done handler owns the surrounding orchestration (mark-read →
// strip labels → archive, plus the partial-success response contract); this module owns ONLY the
// move itself so that its semantics — the guard protocol, the Gmail All-Mail branch, the
// race-safe DB repoint, and the count adjustments — live in exactly one place. GTD /done also
// passes a label folder as `fromFolder`, to archive a copy that is the message's only one
// instead of deleting it.
//
// Contract, mirroring the move paths in mail.js and imapManager.js:
//   • No Archive folder configured is a SOFT outcome, not a failure: returns
//     { archived: false, noArchiveFolder: true } so the caller can leave the row alone
//     without treating it as an error (in /done the labels are already gone, so the thread
//     has left the rail regardless).
//   • A concurrent /done can move + repoint this same row between the caller's load and our
//     write. moveMessage is then a silent server-side no-op (the uid no longer lives in the
//     source folder) and returns without throwing. Every DB write is scoped to WHERE folder =
//     <source> and its rowCount is the authority: the loser of that race applies nothing, so
//     we skip the count adjustments and return archived:false rather than double-decrementing
//     the source.
//   • Gmail's All Mail is excluded from sync/backfill and the relocate guard, so archiving
//     there just strips the source row from our view: DELETE, not move+repoint, and no
//     destination count (All Mail counts aren't tracked).
//   • IMAP move / DB write failures THROW. The caller maps that to its own failure contract
//     (in /done: HTTP 200 { archived:false, archiveFailed:true } so a mostly-successful action
//     isn't misreported as a 500 and the id stays retryable).
//   • The caller has already marked the thread read, so the counts move no unread.
export async function archiveInboxCopy(imapManager, account, copy, fromFolder = 'INBOX') {
  // A copy whose DB-first move is pending (placeholder uid, moveQueue.js) is on its way elsewhere.
  if (Number(copy.uid) < 0) throw movePendingError();
  const archiveFolder = await resolveArchiveFolder(account.id, account.folder_mappings);
  if (!archiveFolder) return { archived: false, noArchiveFolder: true };
  const allMail = await isAllMailFolder(account.id, archiveFolder);
  const archived = await moveCopy(imapManager, account, copy, fromFolder, archiveFolder, { allMail, unread: 0 });
  return { archived, noArchiveFolder: false };
}

// Move one label copy of a message back to INBOX: GTD's label removal when the label folder
// holds the message's only copy, so deleting it would lose the mail. Same guard protocol and
// race contract as archiveInboxCopy; the copy keeps its read state, so an unread copy carries
// its unread count along. Returns { moved }. `copy` needs { id, uid, is_read }.
export async function moveCopyToInbox(imapManager, account, copy, fromFolder) {
  if (Number(copy.uid) < 0) throw movePendingError();
  const moved = await moveCopy(imapManager, account, copy, fromFolder, 'INBOX', { allMail: false, unread: copy.is_read ? 0 : 1 });
  return { moved };
}

// The guarded move + race-safe DB repoint both callers share. Returns whether this call's DB
// write applied (false when a concurrent action moved the row first).
//
// Guard protocol (ref-counted _guardMoveUid/_unguardMoveUid, byte-equivalent to the move
// paths): the source (fromFolder, uid) is guarded for the whole move so reconcileDeletes can't
// treat the row as an orphan mid-flight; released in the finally so it is freed even when the
// move or write throws. On a non-UIDPLUS server the new destination uid is unknown, so the DB
// row keeps the stale source uid at the destination — guard (toFolder, uid) too, and hold that
// guard for the sync that learns the real uid only when the row was actually moved; a lost
// race (rowCount 0) or a throw releases it immediately, since there is nothing to protect.
async function moveCopy(imapManager, account, copy, fromFolder, toFolder, { allMail, unread }) {
  const accountId = account.id;
  imapManager._guardMoveUid(accountId, fromFolder, copy.uid);
  let destGuardHeld = false;
  try {
    const newUid = await imapManager.moveMessage(account, copy.uid, fromFolder, toFolder);
    let applied;
    if (allMail) {
      const del = await query('DELETE FROM messages WHERE id = $1 AND folder = $2', [copy.id, fromFolder]);
      applied = del.rowCount > 0;
    } else if (newUid != null) {
      const upd = await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3 AND folder = $4', [toFolder, newUid, copy.id, fromFolder]);
      applied = upd.rowCount > 0;
    } else {
      imapManager._guardMoveUid(accountId, toFolder, copy.uid);
      destGuardHeld = true;
      const upd = await query('UPDATE messages SET folder = $1 WHERE id = $2 AND folder = $3', [toFolder, copy.id, fromFolder]);
      applied = upd.rowCount > 0;
      // Hold the destination guard for the sync that learns the real uid only when we
      // actually moved the row; a lost race releases it immediately (nothing to protect).
      if (applied) setTimeout(() => imapManager._unguardMoveUid(accountId, toFolder, copy.uid), 10_000);
      else imapManager._unguardMoveUid(accountId, toFolder, copy.uid);
      destGuardHeld = false;
    }
    if (applied) {
      adjustFolderCounts(accountId, fromFolder, -1, unread ? -unread : 0);
      if (!allMail) adjustFolderCounts(accountId, toFolder, 1, unread);
    }
    return applied;
  } finally {
    imapManager._unguardMoveUid(accountId, fromFolder, copy.uid);
    // Release the destination guard when its DB write throws before normal handoff.
    if (destGuardHeld) imapManager._unguardMoveUid(accountId, toFolder, copy.uid);
  }
}
