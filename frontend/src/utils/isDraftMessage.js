// Whether a message row is a draft — decided from the message itself, never from whichever
// folder happens to be selected in the UI. MessageList used to gate draft-opening purely on
// "is the currently selected folder the account's Drafts folder", which misses every message
// that reaches the list some other way: a Gmail conversation's representative/child rows (Gmail
// threads span folders, e.g. a thread fetched via /thread/:threadId is not folder-scoped), a
// unified/all-accounts view (selectedAccountId is null), a moment right after switching accounts
// before the folder list has loaded, search results, and starred/other-folder listings that
// happen to include a draft. Per-message detection fixes all of these the same way.
//
// Pure function, so it runs under `node --test`.
export function isDraftMessage(message, { accounts = [], folders = {} } = {}) {
  if (!message) return false;

  // Trust an explicit signal from the backend when the row carries one: GET /thread/:threadId
  // resolves this per-row (across every folder the thread touches) via resolveAllDraftsPaths,
  // so it is more authoritative than re-deriving it from folder_mappings/special_use below.
  if (typeof message.is_draft === 'boolean') return message.is_draft;

  // IMAP \Draft flag, if the row happens to carry one.
  if (Array.isArray(message.flags) && message.flags.includes('\\Draft')) return true;

  const accountId = message.account_id;
  const folder = message.folder;
  if (!accountId || !folder) return false;

  const account = accounts.find(a => a.id === accountId);
  if (account?.folder_mappings?.drafts) {
    return account.folder_mappings.drafts === folder;
  }

  const folderList = folders[accountId] || [];
  const folderInfo = folderList.find(f => f.path === folder);
  return folderInfo?.special_use === '\\Drafts';
}

// The draft "of a conversation" that a Drafts-folder conversation row should open: the newest
// message, among the thread's cached messages, that is itself a draft. Falls back to the row
// clicked (the collapsed thread's own representative) when no cached child is a draft, so a row
// clicked before its thread has ever been expanded still opens correctly.
export function pickThreadDraft(message, threadMsgs, ctx) {
  const candidates = Array.isArray(threadMsgs) && threadMsgs.length ? threadMsgs : [message];
  const drafts = candidates.filter(m => isDraftMessage(m, ctx));
  if (!drafts.length) return isDraftMessage(message, ctx) ? message : null;
  return drafts.reduce((newest, m) => (new Date(m.date) > new Date(newest.date) ? m : newest));
}
