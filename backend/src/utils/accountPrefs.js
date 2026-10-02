// Sanitiser for the per-user account-list preferences carried by PATCH /auth/preferences:
//   pinnedAccounts       the ids of the mailboxes the user pinned to the top of the sidebar, in the
//                        order they were pinned
//   sortAccountsByLatest whether the other mailboxes rise by their latest received mail (handled
//                        by the route as a plain boolean)
//
// A flat top-level key like the other preferences, so the shallow `preferences || ...` merge keeps
// it independent of whatever another tab writes. Pure, so the allow-list is unit-testable.

import { isUuid } from './uuid.js';

// More pins than any list could want; bounds what a crafted payload can store.
export const MAX_PINNED_ACCOUNTS = 200;

// A pin list is an array of account ids: anything else in it is dropped, repeats keep their first
// place, the rest is cut at the cap. A value that is not an array at all returns null, meaning
// "leave the stored list as it is" (the route's convention for an absent or malformed key); an empty
// array is meaningful and clears the pins.
export function sanitizePinnedAccounts(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const clean = [];
  for (const entry of value) {
    if (!isUuid(entry)) continue;
    const id = entry.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
    if (clean.length >= MAX_PINNED_ACCOUNTS) break;
  }
  return clean;
}
