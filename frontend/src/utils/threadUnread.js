// A list row stands for a conversation: `is_read` is the state of the message the row shows,
// `unread_count` the number of unread messages in the whole conversation (that message
// included). Reading or unreading one message moves the aggregate by one, not to zero.
// Pure functions so they run under `node --test`.

const countOf = (row) => {
  const n = Number.parseInt(row?.unread_count, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * The aggregate after the row's own (unread) message is marked read.
 * A row without an aggregate counted just that message.
 */
export function unreadAfterHeadRead(row) {
  const n = Number.parseInt(row?.unread_count, 10);
  return Number.isFinite(n) ? Math.max(0, n - 1) : 0;
}

/**
 * The row after a flag patch for the message the row itself shows (from another client).
 * `unread_count` follows a change of the row message's read state by one in either direction.
 */
export function applyHeadFlagPatch(row, patch) {
  const next = { ...row, ...patch };
  if (typeof patch.is_read === 'boolean' && patch.is_read !== Boolean(row.is_read)) {
    next.unread_count = Math.max(0, countOf(row) + (patch.is_read ? -1 : 1));
  }
  return next;
}

/** Number of unread messages in a cached conversation. */
export function unreadInConversation(messages) {
  return messages.filter(m => !m.is_read).length;
}
