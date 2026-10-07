// Rolling back an optimistic flag change (star, read) has to put every message back to the
// state it had in the store, not to the state of whichever copy the code happened to hold: the
// copy fetched with a conversation can differ from the list row for the same id, and a bulk
// change touches messages whose previous states differ. Pure functions so they run under
// `node --test`.

/**
 * Reads `field` for each id from the loaded lists and conversation caches, taking the first copy
 * found in this order: list rows, search results, cached conversations. Ids that no loaded copy
 * holds fall back to the matching entry of `fallbackRows`, and are left out when there is none.
 *
 * @param {{messages?: Array, searchResults?: Array, threadMessages?: Record<string, Array>}} state
 * @param {Iterable<string>} ids
 * @param {string} field
 * @param {Array<{id: string}>} [fallbackRows]
 * @returns {Map<string, *>} id -> previous value
 */
export function snapshotFlag(state, ids, field, fallbackRows = []) {
  const wanted = new Set(ids);
  const found = new Map();
  const scan = (list) => {
    for (const m of list || []) {
      if (wanted.has(m.id) && !found.has(m.id) && field in m) found.set(m.id, m[field]);
    }
  };
  scan(state.messages);
  scan(state.searchResults);
  Object.values(state.threadMessages || {}).forEach(scan);
  scan(fallbackRows);
  return found;
}
