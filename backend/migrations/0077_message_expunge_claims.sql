-- no-transaction
-- A permanent delete (DELETE /api/mail/messages/:id, bulk-delete: a letter seen in Trash, or a
-- draft) claims its rows in one short statement, deletes the letters on the mail server outside any
-- transaction, then deletes the rows it claimed or releases the claim (services/expungeClaims.js).
-- While a row is claimed, the move queue does not move it (moveQueue.enqueue answers move_pending)
-- and no other permanent delete claims it. A claim left behind by a process that stopped mid-delete
-- is released by the move queue's sweep once it is older than the lease, and at startup.
-- expunge_claim: the token of the request holding the claim. expunge_claimed_at: when it claimed.
-- The index holds only claimed rows, so the sweep never reads the table.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expunge_claim uuid;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expunge_claimed_at timestamptz;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_expunge_claimed
  ON messages (expunge_claimed_at) WHERE expunge_claim IS NOT NULL;
