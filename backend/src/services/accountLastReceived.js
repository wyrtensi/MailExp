// When did a mailbox last receive a letter: the date of the newest live letter in its inbox. The
// sidebar lists the mailbox that received mail most recently first (GET /api/accounts carries it
// as `last_received_at`).
//
// A correlated subquery over the `email_accounts` row of the query it is placed in: for each
// mailbox one descending seek on idx_messages_list (account_id, folder, date DESC) WHERE
// is_deleted = false, which reads a single index entry, so it stays cheap for hundreds of
// mailboxes and needs no column to keep up to date.
//
// `date <= NOW()` leaves out letters dated in the future (a forged or misconfigured sender's
// Date header would otherwise hold its mailbox at the top for good); a letter with no date has
// nothing to order by and is left out too. Only the inbox counts: sent mail, drafts and what was
// moved away are not "received".
export const LAST_RECEIVED_AT_SQL = `(
  SELECT m.date FROM messages m
  WHERE m.account_id = email_accounts.id AND m.folder = 'INBOX' AND m.is_deleted = false AND m.date <= NOW()
  ORDER BY m.date DESC
  LIMIT 1
)`;
