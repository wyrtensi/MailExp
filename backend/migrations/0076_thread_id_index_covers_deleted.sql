-- no-transaction
-- The thread_id re-root UPDATE (rerootThreadChildren in services/imapManager.js) now also moves
-- soft-deleted rows: they are still threading inputs, because the ancestor lookup in
-- services/threading/threadId.js reads thread_id from any row, deleted or not. A deleted row left
-- on a stale provisional root handed that root to the next reply referencing it and split the
-- thread (upstream maathimself/mailflow@5b16e3fc, #495). Without its is_deleted predicate the
-- UPDATE cannot use the old index, which was partial on is_deleted = false, and would read every
-- row of the account per processed reply. A full index serves every query the partial one served,
-- so it replaces it rather than sitting next to it.
--
-- CONCURRENTLY (hence no-transaction) so a large messages table stays writable. The new index is
-- built under a temporary name, renamed, and only then is the old one dropped, so some
-- (account_id, thread_id) index exists at every step, a crashed and retried run included:
--   1. A crash during CREATE INDEX CONCURRENTLY leaves an INVALID index that IF NOT EXISTS would
--      keep for good, so the retry drops the temporary name first. The old index still serves.
--   2. The retry of a run that got past the rename finds idx_messages_account_thread already
--      there; it is dropped only once the rebuilt temporary index is valid, then replaced.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_account_thread_build;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_account_thread_build ON messages (account_id, thread_id);
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_account_thread;
ALTER INDEX idx_messages_account_thread_build RENAME TO idx_messages_account_thread;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_thread_id;
