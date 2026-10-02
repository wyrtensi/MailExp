-- What became of a sent letter, per recipient (R-17; services/deliveryStatus.js): the last known
-- outcome of (mailbox, Message-ID, recipient), kept after its source is gone. Two sources:
-- - log: the mail node's Postfix log (services/mailNode/postfixLog.js), for letters of mailboxes on
--   the node: sent (handed to the next server, EOP), deferred, bounced or expired, with the relay,
--   the TLS of the connection and EOP's acceptance id; unknown when a deferred letter left the queue
--   without a final line (an administrator deleted it);
-- - dsn: a delivery status notification (multipart/report; report-type=delivery-status) that came
--   back to the same mailbox, for any mailbox: failed or delayed.
-- state, source, status_code, diagnostic and event_at are the winning outcome: a failure over what is
-- not one (a non-delivery report Microsoft sends after accepting the letter wins over the log's
-- "sent"), else the later of the two sources. log and report keep each source's own latest details, so one never
-- erases the other. message_id is the Message-ID header as messages.message_id stores it (with
-- the angle brackets); recipient is the address as the sender wrote it, lower case. Only letters the
-- mailbox itself sent get rows. No subject, body or log line is kept.
CREATE TABLE IF NOT EXISTS message_delivery_status (
  account_id   UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_id   TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('sent', 'deferred', 'bounced', 'expired', 'failed', 'delayed', 'unknown')),
  source       TEXT NOT NULL CHECK (source IN ('log', 'dsn')),
  status_code  TEXT,
  diagnostic   TEXT,
  event_at     TIMESTAMPTZ,
  log          JSONB,
  report       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, message_id, recipient)
);
