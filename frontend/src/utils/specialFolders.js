// Whether a folder is Trash- or Junk/Spam-like, mirroring the backend's own heuristic exactly
// (backend/src/routes/search.js's trashFolderExclusionCondition / spamFolderExclusionCondition):
// special_use (this is how Gmail's [Gmail]/Trash and [Gmail]/Spam resolve, since their path is
// not the English word) or the same multilingual name heuristic. Deliberately does NOT consult
// folder_mappings.trash/.spam — the server's exclusion doesn't either (see spamFolderExclusionCondition's
// own comment: a per-account canonical-folder override doesn't apply to a broad "does this look
// like Junk" heuristic spanning every account in scope) — so this stays exactly the set of
// folders the server would otherwise exclude, no more and no less. Pure function, so it runs
// under `node --test`.
//
// This exists so a search issued while standing IN Trash or Junk stays scoped to that folder
// even when "search all folders" is on: the server excludes special folders from an all-folder
// search (so freshly-deleted mail and spam don't resurface by default), which would otherwise
// silently return nothing for a search the user issued while looking straight at that folder.
const SPAM_NAME_RE = /(spam|junk|bulk|indesiderata|spamverdacht|courrier ind|posta indesiderata)/;

export function isTrashOrJunkFolder(folder, folderList) {
  if (!folder) return false;

  const info = (folderList || []).find(f => f.path === folder);
  if (info?.special_use === '\\Trash' || info?.special_use === '\\Junk') return true;

  // Falls back to the raw folder path when the folder isn't in the synced list yet (e.g. right
  // after switching accounts, before folders load) — an approximation of the server's `name`
  // column, but better than assuming "not special" with nothing to check against.
  const name = String(info?.name ?? folder).toLowerCase();
  return name.includes('trash') || name.includes('deleted') || SPAM_NAME_RE.test(name);
}
