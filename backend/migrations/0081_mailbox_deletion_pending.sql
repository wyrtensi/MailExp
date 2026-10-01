-- A mail node mailbox someone asked to delete (services/mailNode/mailboxDeletion.js). The mailbox
-- keeps working until delete_after; then the deletion job deletes it on the node with all its mail
-- and removes the row. Anyone signed in may ask for the deletion or cancel it before then.
--
-- deletion_requested_at, deletion_requested_by: who asked and when (NULL when nobody did). The
-- requester's email is copied (deletion_requested_by_email) so the journal entry of the final
-- delete still names them after the user is gone.
-- deletion_reason: why, as the requester wrote it (required). The final journal entry keeps it after
-- the row is gone; a cancel clears it here (the journal keeps the request).
-- delete_after: when the job deletes the mailbox for good; NULL means no deletion is pending. The
-- job never touches a row whose delete_after is NULL or in the future.
-- deletion_started_at: the job's claim on a due row while it deletes it on the node; a cancel is
-- refused while a claim exists, and a claim older than 10 minutes (a run that stopped) is taken
-- again by the next run.
-- deletion_attempts, deletion_next_attempt_at, deletion_last_error: the job's retries after a
-- failure (backoff) and the last reason as a code the screens translate.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deletion_requested_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deletion_requested_by_email text;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deletion_reason text;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS delete_after timestamptz;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deletion_started_at timestamptz;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deletion_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deletion_next_attempt_at timestamptz;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deletion_last_error text;

CREATE INDEX IF NOT EXISTS idx_email_accounts_delete_after
  ON email_accounts (delete_after) WHERE delete_after IS NOT NULL;
