-- When a mailbox last RECEIVED a letter: the sidebar lists the mailbox that received mail most
-- recently first. It is a record of arrivals, not a reading of the inbox as it is now: a letter
-- archived, read or deleted a moment after it came still counts, so the column is kept up to date
-- by the sync (services/accountReceived.js) when an INBOX letter is first stored, never recomputed
-- from what is in the inbox. Never ahead of the time it was written (a forged Date header cannot
-- hold a mailbox on top).
--
-- Backfilled once from the INBOX as it is now, the best that can be known for mail that arrived
-- before this column existed; null for a mailbox with no inbox mail.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_received_at TIMESTAMPTZ;

UPDATE email_accounts a
SET last_received_at = (
  SELECT m.date FROM messages m
  WHERE m.account_id = a.id AND m.folder = 'INBOX' AND m.is_deleted = false AND m.date <= NOW()
  ORDER BY m.date DESC
  LIMIT 1
)
WHERE a.last_received_at IS NULL;
