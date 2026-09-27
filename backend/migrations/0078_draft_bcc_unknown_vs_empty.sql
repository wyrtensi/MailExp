-- 0058 made bcc_addresses NOT NULL DEFAULT '[]', so a row no writer ever set it on (any sync
-- insert: regular mail, backfill, a draft first seen by sync or saved by another client) got '[]'
-- by default — indistinguishable from a draft MailExpert saved with no Bcc. Reopening such a row
-- then started the composer with an empty Bcc, and its next save replaced (and expunged) the only
-- copy on the server that still had one.
--
-- NULL now means "not known locally" (sync never writes this column, so it never overwrites what
-- the composer stored, and it simply leaves the default alone). '[]' means MailExpert saved the
-- draft without a Bcc: a deliberate, known-empty value written only by
-- imapManager.upsertDraftMessageRecord. Readers must go to the server copy's Bcc header for NULL
-- and must never treat it as "no Bcc".
ALTER TABLE messages ALTER COLUMN bcc_addresses DROP NOT NULL;
ALTER TABLE messages ALTER COLUMN bcc_addresses DROP DEFAULT;
