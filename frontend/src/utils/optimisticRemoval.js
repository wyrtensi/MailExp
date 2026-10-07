// Bookkeeping for rows that are removed from the list before the server confirms an archive or
// a move. When the request fails, or answers ok without listing a row, the row comes back and
// the unread counters it took with it are given back too. Pure functions so they run under
// `node --test`.

/**
 * Splits optimistically removed rows by what the server confirmed.
 *
 * @param {Array<{id: string}>} rows       rows that were removed from the list
 * @param {Iterable<string>|null|undefined} confirmedIds ids the server reported as done
 * @returns {{done: Array, failed: Array}}
 */
export function splitByConfirmed(rows, confirmedIds) {
  const confirmed = new Set(confirmedIds ?? []);
  const done = [];
  const failed = [];
  for (const row of rows) (confirmed.has(row.id) ? done : failed).push(row);
  return { done, failed };
}

/**
 * Unread messages per account that a set of rows accounts for in the sidebar counters.
 * A read row counts for nothing; a row counts as one, matching the single decrement the move
 * and archive paths apply when the row is removed.
 *
 * @returns {Array<[string, number]>} [accountId, count] pairs with count > 0
 */
export function unreadByAccount(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.is_read) continue;
    counts.set(row.account_id, (counts.get(row.account_id) || 0) + 1);
  }
  return [...counts];
}
