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

// A closing page's keepalive requests share 64 KiB of body in the browser (the Fetch spec counts
// every keepalive request in flight), and the preferences flush on unload takes a little of it.
export const EXIT_KEEPALIVE_BUDGET = 48 * 1024;
export const BULK_DELETE_MAX_IDS = 500;

// The bulk-delete bodies for a page-close flush: at most 500 ids each (the server's cap), in the
// compact form `{ seen: { [folder]: [ids] }, ids: [ids with no folder] }`, each folder named once.
// Bodies are taken in order while their total stays within `budget` bytes; the ids of the rest are
// returned as `dropped` (not deleted: the letters stay where they are).
export function exitDeleteBodies(ids, folders, { budget = EXIT_KEEPALIVE_BUDGET, chunkSize = BULK_DELETE_MAX_IDS } = {}) {
  const bodies = [];
  const dropped = [];
  let used = 0;
  const encoder = new TextEncoder();
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const seen = {};
    const bare = [];
    for (const id of chunk) {
      const folder = folders && Object.prototype.hasOwnProperty.call(folders, id) ? folders[id] : null;
      if (typeof folder === 'string' && folder) (seen[folder] = seen[folder] || []).push(id);
      else bare.push(id);
    }
    const body = JSON.stringify({
      ...(Object.keys(seen).length ? { seen } : {}),
      ...(bare.length ? { ids: bare } : {}),
    });
    const size = encoder.encode(body).length;
    if (used + size > budget) {
      dropped.push(...ids.slice(i));
      break;
    }
    used += size;
    bodies.push(body);
  }
  return { bodies, dropped };
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
