-- A third source of what became of a sent letter (R-17; services/deliveryStatus.js): the mailbox's
-- own outgoing server refusing a recipient at RCPT while it took the letter for the others
-- (services/sendDelivery.js). Nodemailer resolves such a send instead of failing it, so without
-- this the refused recipients were dropped without the author ever hearing of it.
--
-- source 'submission': the row's outcome is that refusal, state failed. submission keeps its own
-- details ({ at, statusCode, diagnostic, reply, responseCode }) next to log and report, as those
-- two keep theirs. A refusal at submission is the last word for that recipient: the letter never
-- left for them, so no log line or report can say otherwise.
ALTER TABLE message_delivery_status DROP CONSTRAINT IF EXISTS message_delivery_status_source_check;
ALTER TABLE message_delivery_status
  ADD CONSTRAINT message_delivery_status_source_check CHECK (source IN ('log', 'dsn', 'submission'));
ALTER TABLE message_delivery_status ADD COLUMN IF NOT EXISTS submission JSONB;
