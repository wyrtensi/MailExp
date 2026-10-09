import { query } from './db.js';
import { fanOutReadToSiblings, resolveAllDraftsPaths, resolveAllTrashPaths, resolveAllSpamPaths } from '../utils/mailUtils.js';
import { movePendingError } from '../utils/mailboxBusy.js';

// A negative uid is the placeholder of a letter whose DB-first move has not reached the server
// (services/moveQueue.js): no server has it, so no COPY, STORE or delete may be sent for it.
// Label work on such a letter throws movePendingError before anything is changed.
const pendingUid = (uid) => uid != null && Number(uid) < 0;

// Throws movePendingError when the message, or a copy of it (same Message-ID) in one of
// `folders`, is waiting for its move. Callers that change several copies (GTD done) check first,
// so they never stop half-way.
export async function assertNoPendingCopies(message, folders = []) {
  if (pendingUid(message.uid)) throw movePendingError();
  if (!message.message_id || !folders.length) return;
  const { rows } = await query(
    'SELECT 1 FROM messages WHERE account_id = $1 AND message_id = $2 AND folder = ANY($3::text[]) AND uid < 0 LIMIT 1',
    [message.account_id, message.message_id, folders]
  );
  if (rows.length) throw movePendingError();
}

// Generic "labels" capability (v3.0 plugin platform).
//
// A label on a message physically means a COPY of that message living in the label's
// designated folder — a sibling row sharing the original's RFC Message-ID. Core owns the
// mechanics (ensure the folder, copy in, resolve the sibling, remove the copy) so features —
// and, once the boundary is finished, sandboxed plugins — apply/remove labels without ever
// touching IMAP or SQL directly. GTD is the first consumer; its states (Todo/Watch/…) are
// just labels whose folders come from its own config.
//
// imapManager is injected (callers pass their handle) so the DB/IMAP logic is unit-testable
// without a live connection pool — matching the pattern gtdTransitions/gtdSections already use.

// Resolve the uid of the message's copy that lives in `folder` for its account, or null. The
// acted row is used directly when it already lives there; otherwise the shared RFC Message-ID
// (an IMAP COPY duplicates it verbatim) joins to the sibling copy. A message with no
// Message-ID can only be resolved via the acted-row case.
export async function resolveLabelCopyUid(message, folder) {
  if (message.folder === folder) {
    if (pendingUid(message.uid)) throw movePendingError();
    return message.uid;
  }
  if (!message.message_id) return null;
  const { rows } = await query(
    'SELECT uid FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3 AND is_deleted = false ORDER BY uid DESC LIMIT 1',
    [message.account_id, folder, message.message_id]
  );
  if (pendingUid(rows[0]?.uid)) throw movePendingError();
  return rows[0]?.uid ?? null;
}

// Apply a label: ensure the label folder exists, then COPY the message into it (leaving the
// original in place). imapManager.copyMessage also emits the section-refresh event. No-op when
// the message already lives in the label folder. `message` needs { uid, folder }.
export async function applyLabel(imapManager, account, message, labelFolder) {
  if (message.folder === labelFolder) {
    return { applied: false, uid: message.uid, reason: 'already-there' };
  }
  const existingUid = await resolveLabelCopyUid(message, labelFolder);
  if (existingUid != null) {
    return { applied: false, uid: existingUid, reason: 'already-labelled' };
  }
  // The COPY is sent from the message's uid, which a pending move has replaced by a placeholder.
  if (pendingUid(message.uid)) throw movePendingError();
  await imapManager.ensureFolder(account, labelFolder);
  const uid = await imapManager.copyMessage(account.id, message.uid, message.folder, labelFolder);
  return { applied: true, uid: uid ?? null };
}

// Remove one exact label copy only when it still carries the source message's RFC Message-ID.
// This is the safe inverse for a COPY whose destination UID was returned by UIDPLUS: a stale or
// forged UID cannot remove a different message's label copy. Without a Message-ID there is no
// stable identity shared by the source and copied rows, so no inverse is advertised.
export async function removeExactLabelCopy(imapManager, message, labelFolder, uid) {
  if (!message.message_id) return { removed: false };
  const { rows } = await query(
    `SELECT uid FROM messages
      WHERE account_id = $1 AND folder = $2 AND uid = $3
        AND message_id = $4 AND is_deleted = false
      LIMIT 1`,
    [message.account_id, labelFolder, uid, message.message_id]
  );
  if (!rows[0]) return { removed: false };
  await imapManager.removeMessageCopy(message.account_id, uid, labelFolder);
  return { removed: true };
}

// Remove a label: delete the message's copy living in the label folder, leaving INBOX and any
// other labels intact. No-op when no such copy exists. `message` needs { account_id, uid,
// folder, message_id }.
export async function removeLabel(imapManager, message, labelFolder) {
  const uid = await resolveLabelCopyUid(message, labelFolder);
  if (uid == null) return { removed: false };
  await imapManager.removeMessageCopy(message.account_id, uid, labelFolder);
  return { removed: true };
}

// Whether a message keeps a live copy once its copies in the `removing` folders are deleted.
// Removing a label deletes its copy, and a label folder can hold a message's only copy: mail the
// user filed there by moving it. Drafts, Trash and Junk do not count, since those get emptied. A
// row can outlive its message for a while after another client moves it, so a copy counts only
// once the server confirms its uid still carries the Message-ID; a failed check, or a copy whose
// move is pending (no server uid yet), counts as no copy, which keeps the mail. Without a
// Message-ID the other copies cannot be found, so the answer is no. On a label store (Gmail) it is
// always yes: a folder is a label there, and removing it leaves the message in All Mail.
// `message` needs { account_id, message_id }. background: see imapManager.hasMessageCopy.
export async function hasSurvivingCopy(imapManager, account, message, removing, { background = false } = {}) {
  if (imapManager.isLabelStore(account)) return true;
  if (!message.message_id) return false;
  const [drafts, trash, spam, { rows }] = await Promise.all([
    resolveAllDraftsPaths(account.id, account.folder_mappings),
    resolveAllTrashPaths(account.id, account.folder_mappings),
    resolveAllSpamPaths(account.id, account.folder_mappings),
    query(
      'SELECT folder, uid FROM messages WHERE account_id = $1 AND message_id = $2 AND is_deleted = false',
      [message.account_id, message.message_id]
    ),
  ]);
  const unsafe = new Set([...removing, ...drafts, ...trash, ...spam]);
  for (const { folder, uid } of rows) {
    if (unsafe.has(folder) || uid == null || pendingUid(uid)) continue;
    try {
      if (await imapManager.hasMessageCopy(account, uid, folder, message.message_id, { background })) return true;
    } catch (err) {
      console.warn(`labels: could not confirm the copy in ${folder}: ${err.message}`);
    }
  }
  return false;
}

// Best-effort \Seen on one copy, for when a copy other than INBOX becomes the durable one (GTD
// Done keeping a message's only copy). The DB side is markThreadRead's fan-out; without the flag
// the next sync of the destination folder reads the copy back as unread. Never throws.
// `message` needs { uid, folder, is_read }.
export async function markCopySeen(imapManager, account, message) {
  if (message.is_read) return {};
  try {
    await imapManager.setFlag(account, message.uid, message.folder, '\\Seen', true);
  } catch (err) {
    return { error: err };
  }
  return {};
}

// Ensure a set of label folders exist on the IMAP server, resolving each to its REAL server
// path (a prefixed namespace turns a bare 'Todo' into 'INBOX.Todo') and reporting whether this
// call created it. Returns one result per DEDUPED input path, in input order:
//   { folder, path, created }  on success  |  { folder, error: true }  on failure.
// A single folder's failure is isolated (logged, marked) so one bad name never aborts the rest.
// Core owns the IMAP mechanics; the caller owns any config persistence keyed off the results
// (e.g. recording where a relocated folder actually landed).
export async function ensureLabelFolders(imapManager, account, folderPaths) {
  const paths = [...new Set(folderPaths || [])];
  const results = [];
  for (const folder of paths) {
    try {
      const { path, created } = await imapManager.ensureFolder(account, folder, { resolvePath: true });
      results.push({ folder, path, created });
    } catch (err) {
      console.error(`ensureLabelFolders failed for ${folder}:`, err.message);
      results.push({ folder, error: true });
    }
  }
  return results;
}

// Mark an entire thread read: a DB fan-out across every sibling copy (by Message-ID, adjusting
// each folder's unread count) plus a best-effort \Seen on the durable INBOX copy (it rides the
// archive move; Gmail propagates message-wide). The INBOX copy is looked up first and returned
// so the caller can archive it afterward — it survives even if the fan-out/flag push degrades.
// The lookup itself may throw (caller treats that as fatal, matching the plain read route); the
// fan-out + flag push are best-effort and reported via the returned `error`, never thrown.
// `message` needs { account_id, message_id }.
export async function markThreadRead(imapManager, account, message) {
  const { rows } = await query(
    'SELECT id, uid, is_read FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3 AND is_deleted = false LIMIT 1',
    [message.account_id, 'INBOX', message.message_id]
  );
  const inboxCopy = rows[0] || null;
  // An INBOX copy whose move is pending has no uid to STORE at, and cannot be archived either.
  if (pendingUid(inboxCopy?.uid)) throw movePendingError();
  try {
    await fanOutReadToSiblings(message.account_id, message.message_id, true);
    if (inboxCopy && !inboxCopy.is_read) {
      await imapManager.setFlag(account, inboxCopy.uid, 'INBOX', '\\Seen', true);
    }
  } catch (err) {
    return { inboxCopy, error: err };
  }
  return { inboxCopy };
}
