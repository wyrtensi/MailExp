-- Letters delayed or lost while the mail node was down (R-43, option A of the owner: observe and
-- report; services/mailNode/outages.js and outageTrace.js).
--
-- mail_node_outages: a window during which the node could not take mail from EOP. EOP keeps such
-- mail in its queue for at most 24 hours, retrying every 15 minutes, then returns it to the sender
-- (550 4.4.7 QUEUE.Expired). source:
-- - detected: the alert job (every five minutes) found the mailcow API unreachable on two checks in
--   a row, or postfix-mailcow not running (Dovecot down is not one: Postfix still takes the mail and
--   queues it on the node). started_at is the last good check before the first failed one
--   (conservative), ended_at the first good check after it; a window closed less than 15 minutes
--   before a new failure opens again; at most one detected window is open at a time;
-- - manual: an administrator marked one (a planned maintenance, a panel-side outage), with a reason.
-- cause: what the failed checks saw ({ signals, containers, startUncertain }); evidence: what the
-- node's Postfix log shows around the window (last inbound session from EOP before it, first after
-- it, sessions during it); trace: the last pass of the message trace over the window ({ checkedAt,
-- complete, requests, counts, error, cursor }: cursor is where an unfinished listing goes on in the
-- next pass). No subject or address is kept here.
CREATE TABLE IF NOT EXISTS mail_node_outages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  source      text NOT NULL CHECK (source IN ('detected', 'manual')),
  planned     boolean NOT NULL DEFAULT false,
  reason      text,
  cause       jsonb NOT NULL DEFAULT '{}',
  evidence    jsonb,
  trace       jsonb,
  last_failed_at timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_node_outages_one_open_detected
  ON mail_node_outages ((true)) WHERE ended_at IS NULL AND source = 'detected';
CREATE INDEX IF NOT EXISTS mail_node_outages_started ON mail_node_outages (started_at DESC);

-- mail_node_outage_letters: what the message trace says of a letter to a node domain that EOP
-- received during a window (one hour either side), per recipient. outcome:
-- - delayed: delivered after the window (the node's log, where it covers the letter, shows when it
--   arrived);
-- - unaffected: not touched by the outage: delivered, and the node's log showed it arriving within
--   minutes, or refused in the hour around the window without expiring. Kept, hidden from every
--   screen, so that a later pass with a log that no longer reaches that far back cannot turn it into
--   delayed, and its details are not read again;
-- - waiting: still in EOP's queue (pending); EOP gives up 24 hours after received_at;
-- - lost: failed after waiting in EOP's queue (expired: the 4.4.7 QUEUE.Expired of the 24-hour
--   limit); EOP sent the sender a non-delivery report;
-- - other: quarantined or filtered as spam by EOP, or refused without waiting: not a loss of the
--   outage (administrators only).
-- node_log: whether the node's Postfix log shows the letter arriving (seen, with node_seen_at),
-- covers its time without it (missing), or does not reach that far back (not_covered); a later
-- read that sees less never overwrites it. details_status: the trace status the details were last
-- read at (details_at): they are read again only when the status changes, or, for a letter still
-- waiting, now and then.
-- Subjects are kept so the recipient can recognise a letter; rows go after the retention of the
-- outage settings (30 days by default).
CREATE TABLE IF NOT EXISTS mail_node_outage_letters (
  outage_id    uuid NOT NULL REFERENCES mail_node_outages(id) ON DELETE CASCADE,
  trace_id     text NOT NULL,
  recipient    text NOT NULL,
  message_id   text,
  sender       text,
  subject      text,
  received_at  timestamptz NOT NULL,
  status       text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('delayed', 'unaffected', 'waiting', 'lost', 'other')),
  expired      boolean NOT NULL DEFAULT false,
  status_code  text,
  detail       text,
  event_at     timestamptz,
  node_log     text CHECK (node_log IN ('seen', 'missing', 'not_covered')),
  node_seen_at timestamptz,
  details_status text,
  details_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outage_id, trace_id, recipient)
);
CREATE INDEX IF NOT EXISTS mail_node_outage_letters_recipient ON mail_node_outage_letters (recipient);
CREATE INDEX IF NOT EXISTS mail_node_outage_letters_received ON mail_node_outage_letters (received_at);
