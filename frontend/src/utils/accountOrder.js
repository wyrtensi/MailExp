// The order of the mailboxes in the sidebar. Pure functions: no DOM, no store, so they can be
// unit-tested with `node --test`.
//
// Pinned mailboxes come first, in the order they were pinned. The rest follow by the date of the
// letter they received last (`last_received_at`, the server's record of arrivals: GET /api/accounts
// and the WebSocket's account_received event, never derived on the client), newest first, when "sort by latest mail" is on; with it off they
// keep the given order, which is the server's sort_order. A mailbox with no inbox mail has no date
// and goes after those that have one, in the given order, so the list does not shuffle among them.

function receivedTime(account) {
  const time = Date.parse(account?.last_received_at);
  return Number.isNaN(time) ? null : time;
}

const isAccount = (account) => account != null && typeof account === 'object';

// `pinnedIds` entries naming no mailbox in `accounts` are ignored, so a pin of a deleted mailbox
// can never show or hide anything.
export function orderAccounts(accounts, { pinnedIds = [], sortByLatest = true } = {}) {
  const list = (Array.isArray(accounts) ? accounts : []).filter(isAccount);
  const byId = new Map(list.map(account => [account.id, account]));
  const pinned = [];
  const seen = new Set();
  for (const id of Array.isArray(pinnedIds) ? pinnedIds : []) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    pinned.push(byId.get(id));
  }
  const rest = list.filter(account => !seen.has(account.id));
  if (sortByLatest) {
    // Array.prototype.sort is stable, so equal dates (and the undated tail) keep the given order.
    rest.sort((a, b) => {
      const ta = receivedTime(a);
      const tb = receivedTime(b);
      if (ta === tb) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    });
  }
  const ordered = pinned.length ? [...pinned, ...rest] : rest;
  // The same array back when nothing moved: callers can keep their memoised work.
  if (Array.isArray(accounts) && ordered.length === accounts.length && ordered.every((account, i) => account === accounts[i])) {
    return accounts;
  }
  return ordered;
}

// Lays `accounts` out in the order `previousIds` had, using the current account objects: the list
// does not move while the person is dragging or has a menu open, yet what each row shows stays
// current. Accounts that are gone drop out; new ones go at the end, in their given order.
export function freezeOrder(previousIds, accounts) {
  const list = (Array.isArray(accounts) ? accounts : []).filter(isAccount);
  if (!Array.isArray(previousIds) || !previousIds.length) return list;
  const byId = new Map(list.map(account => [account.id, account]));
  const placed = new Set();
  const frozen = [];
  for (const id of previousIds) {
    if (placed.has(id) || !byId.has(id)) continue;
    placed.add(id);
    frozen.push(byId.get(id));
  }
  for (const account of list) if (!placed.has(account.id)) frozen.push(account);
  return frozen;
}

// Pins: an ordered list of account ids, a new pin at the end.
export function pinAccountIds(pinnedIds, accountId) {
  const current = Array.isArray(pinnedIds) ? pinnedIds : [];
  return current.includes(accountId) ? current : [...current, accountId];
}

export function unpinAccountIds(pinnedIds, accountId) {
  return (Array.isArray(pinnedIds) ? pinnedIds : []).filter(id => id !== accountId);
}

// The pins that still name a mailbox in `accounts`, each once, in pin order.
export function prunePinnedIds(pinnedIds, accounts) {
  const live = new Set((Array.isArray(accounts) ? accounts : []).filter(isAccount).map(account => account.id));
  const seen = new Set();
  return (Array.isArray(pinnedIds) ? pinnedIds : []).filter((id) => {
    if (!live.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// "Move up / down" in the account menu reorders the mailboxes by hand (the server's sort_order),
// which only shows while the list is not ordered by latest mail, and only among the unpinned ones:
// pinned mailboxes are ordered by their pins. The neighbour is the next unpinned mailbox as the list
// is shown, so a swap always moves the row the person sees move; null at either end, for a pinned
// mailbox, or one that is not in the list.
export function manualMoveNeighbour(shownAccounts, pinnedIds, accountId, direction) {
  const pinned = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
  const unpinned = (Array.isArray(shownAccounts) ? shownAccounts : []).filter(account => isAccount(account) && !pinned.has(account.id));
  const at = unpinned.findIndex(account => account.id === accountId);
  if (at === -1) return null;
  return unpinned[direction === 'up' ? at - 1 : at + 1] ?? null;
}

// "Move up / down" for a pinned mailbox reorders the pins themselves: the pin list with `accountId`
// swapped with its neighbour in `direction`, or null at either end or when it is not pinned. The
// list is first cleaned of pins that name no mailbox in `accounts`, so a neighbour is always a row
// the person can see.
export function movePinnedId(pinnedIds, accounts, accountId, direction) {
  const list = prunePinnedIds(pinnedIds, accounts);
  const at = list.indexOf(accountId);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (at === -1 || to < 0 || to >= list.length) return null;
  const next = [...list];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}
