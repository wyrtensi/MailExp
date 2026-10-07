// Identity of one search: the mailbox, the folder and the query text. An answer for a search
// is only applied while the list still shows that same search -- comparing the text alone let a
// late page for one mailbox land in another mailbox's results.

/**
 * @param {{accountId?: string|null, folder?: string|null, query?: string|null}} scope
 * @returns {string} '' when there is no active query
 */
export function searchScopeKey({ accountId, folder, query } = {}) {
  const text = typeof query === 'string' ? query : '';
  if (!text.trim()) return '';
  return JSON.stringify([accountId ?? null, folder ?? null, text]);
}
