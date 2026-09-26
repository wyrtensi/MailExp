// A delete names the folder the user saw each letter in. The server deletes a letter forever only
// when it has it in Trash AND the user saw it in Trash; a letter it finds in Trash that the user
// saw anywhere else was moved there already (a double click, a retry, a second tab, a colleague),
// and that delete does nothing. Without the folders the server only ever moves to Trash.

// The folder the user saw `row` in: the view's folder (the unified view lists INBOX). A folder
// view shows every row under that folder, a thread row's expanded letters and the letter open in
// the pane included, whatever folder each of them is in by now. Only search results are listed
// across folders, each row under its own folder. null: no folder to name.
export function deleteViewFolder(row, { searching = false, accountId = null, folder = null } = {}) {
  if (searching) return typeof row?.folder === 'string' && row.folder ? row.folder : null;
  if (!accountId) return 'INBOX';
  return typeof folder === 'string' && folder ? folder : null;
}

// { [id]: folder } for a delete of `rows`. Each row stands for itself and, when it is a thread row,
// for the letters resolvedPerRow[i] fetched for it. Every one of them takes the folder the user saw
// the ROW in (folderOf(row)), never its own current folder: a thread member a colleague already
// moved to Trash was not seen in Trash, and must not be deleted forever.
export function rowSeenFolders(rows, resolvedPerRow, folderOf) {
  const out = {};
  (rows || []).forEach((row, i) => {
    const folder = folderOf(row);
    if (!folder) return;
    for (const m of [row, ...(resolvedPerRow?.[i] || [])]) {
      if (m?.id) out[m.id] = folder;
    }
  });
  return out;
}

// What deleteViewFolder needs from the store, read when the user acts.
export function deleteView(state) {
  return {
    searching: !!state?.searchQuery?.trim(),
    accountId: state?.selectedAccountId ?? null,
    folder: state?.selectedFolder ?? null,
  };
}

// The part of `folders` that names `ids`, for one request of a chunked delete; undefined when
// none is named.
export function foldersFor(ids, folders) {
  if (!folders) return undefined;
  const out = {};
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(folders, id)) out[id] = folders[id];
  }
  return Object.keys(out).length ? out : undefined;
}
