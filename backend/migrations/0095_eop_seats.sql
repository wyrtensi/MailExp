-- EOP seats (docs/superpowers/specs/2026-10-07-eop-seats-design.md, services/mailNode/eopSeats.js).

-- A mail node mailbox an administrator deactivated: read-only like one pending deletion (its EOP seat
-- on hold, its tenant recipient removed, no sending), its letters still read over IMAP. NULL: active.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deactivated_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deactivated_by_email text;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS deactivation_reason text;

-- The seat ledger: who held which seat when, kept as evidence for a licence audit, so a row has no
-- foreign key and outlives its mailbox. The latest row of a seat_no says the seat's state: live
-- (released_at NULL; pending_until set while the creation is in flight and the node not asked yet),
-- on hold (released, free_from ahead) or free (free_from passed). A seat never assigned is free.
CREATE TABLE IF NOT EXISTS mail_node_seat_assignments (
  id bigserial PRIMARY KEY,
  seat_no integer NOT NULL CHECK (seat_no > 0),
  account_id uuid,
  email text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT NOW(),
  released_at timestamptz,
  release_reason text,
  free_from timestamptz,
  pending_until timestamptz
);
-- One live holder per seat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_node_seat_live ON mail_node_seat_assignments (seat_no) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mail_node_seat_latest ON mail_node_seat_assignments (seat_no, id DESC);
CREATE INDEX IF NOT EXISTS idx_mail_node_seat_account ON mail_node_seat_assignments (account_id);

-- Requests for more seats (services/mailNode/seatProvider.js). provider 'manual': an administrator
-- buys them; a request closes by itself once purchased reaches purchased_at_request + seats (NULL
-- counts as 0). The requester's email is copied so the list still names a user who is gone.
CREATE TABLE IF NOT EXISTS mail_node_seat_requests (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  seats integer NOT NULL CHECK (seats > 0),
  purchased_at_request integer,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by_email text,
  requested_at timestamptz NOT NULL DEFAULT NOW(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mail_node_seat_requests_open
  ON mail_node_seat_requests (requested_at) WHERE closed_at IS NULL;

-- The mailboxes that exist today, once: a seat each by creation order; one already pending deletion
-- has its seat on hold for the default 90 days from the request.
INSERT INTO mail_node_seat_assignments (seat_no, account_id, email, assigned_at, released_at, release_reason, free_from)
SELECT row_number() OVER (ORDER BY created_at, id), id, lower(email_address), created_at,
       CASE WHEN delete_after IS NOT NULL THEN COALESCE(deletion_requested_at, NOW()) END,
       CASE WHEN delete_after IS NOT NULL THEN 'deletion_requested' END,
       CASE WHEN delete_after IS NOT NULL THEN COALESCE(deletion_requested_at, NOW()) + interval '90 days' END
  FROM email_accounts
 WHERE mail_node AND NOT EXISTS (SELECT 1 FROM mail_node_seat_assignments);
