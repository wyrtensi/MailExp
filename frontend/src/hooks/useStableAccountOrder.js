import { useEffect, useMemo, useRef } from 'react';
import { freezeOrder, orderAccounts } from '../utils/accountOrder.js';

// The sidebar's mailbox order (utils/accountOrder.js) that holds still while the person is in the
// middle of something: while `frozen` is true (a context menu is open, a drag is under way) the
// rows stay where they were when it began, even if mail arrives meanwhile, and each row still shows
// its current data. The order follows again as soon as `frozen` drops.
//
// The order is a pure function of the accounts, the pins and the switch, so an unrelated re-render
// (a new account object for a sync error, an unread count) yields the same sequence and moves
// nothing; only a changed latest-received date, pin or switch can.
export function useStableAccountOrder(accounts, { pinnedIds, sortByLatest, frozen }) {
  const live = useMemo(
    () => orderAccounts(accounts, { pinnedIds, sortByLatest }),
    [accounts, pinnedIds, sortByLatest],
  );
  // The ids as of the last committed render that was not frozen.
  const settledIds = useRef(null);
  const shown = useMemo(
    () => (frozen && settledIds.current ? freezeOrder(settledIds.current, live) : live),
    [frozen, live],
  );
  useEffect(() => {
    if (!frozen) settledIds.current = live.map(account => account.id);
  }, [frozen, live]);
  return shown;
}
