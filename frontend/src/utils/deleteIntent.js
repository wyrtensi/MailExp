// A delete names the folder the user saw each letter in. The server deletes a letter forever only
// when it has it in Trash AND the user saw it in Trash; a letter it finds in Trash that the user
// saw anywhere else was moved there already (a double click, a retry, a second tab, a colleague),
// and that delete does nothing. Without the folders the server only ever moves to Trash.

// { [id]: folder } from lists of message rows; a later list wins for the same id.
export function seenFolders(...lists) {
  const out = {};
  for (const list of lists) {
    for (const m of list || []) {
      if (m?.id && typeof m.folder === 'string' && m.folder) out[m.id] = m.folder;
    }
  }
  return out;
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
