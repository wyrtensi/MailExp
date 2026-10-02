// email_accounts.last_received_at (migration 0085): the moment a mailbox last RECEIVED a letter, as
// the sidebar orders its mailboxes by. An arrival is an INBOX letter stored for the first time;
// what happens to it afterwards (read, archived, deleted, moved by a rule) does not take it back.
import { query } from './db.js';

// What the sync calls after storing INBOX letters for the first time (`arrivedAtMs` is the newest of
// them): move the mailbox's date and tell the open clients (`broadcast`) so the sidebar order
// follows. The event goes out when the date really moved, whether the arrivals were unread or
// already read (new_messages carries only the unread ones). Never throws: it must not fail the sync
// batch that called it, and the next arrival moves the date on. `describe` names the account in the
// log without its address.
export async function recordInboxArrival(account, arrivedAtMs, broadcast, describe = () => 'a mailbox') {
  try {
    const lastReceivedAt = await noteInboxArrival(account.id, arrivedAtMs);
    if (lastReceivedAt) broadcast({ type: 'account_received', accountId: account.id, lastReceivedAt });
  } catch (err) {
    console.warn(`Could not record the last received mail of ${describe(account)}: ${err.message}`);
  }
}

// Moves the mailbox's date forward to `arrivedAtMs`, never backward and never past now (a letter
// carries the sender's Date header, which may be ahead or behind: a late delivery of an old letter
// changes nothing, a future one counts as now). Returns the new date as an ISO string when it
// moved, null when it did not (so the caller broadcasts only a real change).
export async function noteInboxArrival(accountId, arrivedAtMs) {
  if (!Number.isFinite(arrivedAtMs)) return null;
  const { rows } = await query(
    `UPDATE email_accounts
     SET last_received_at = LEAST($2::timestamptz, NOW())
     WHERE id = $1 AND (last_received_at IS NULL OR last_received_at < LEAST($2::timestamptz, NOW()))
     RETURNING last_received_at`,
    [accountId, new Date(arrivedAtMs).toISOString()],
  );
  return rows[0]?.last_received_at ? new Date(rows[0].last_received_at).toISOString() : null;
}
