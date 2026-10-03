-- Stage 7c of the EOP panel work: what the tenant driver learns from Microsoft's message trace on
-- request (R-30) and what it releases from EOP's quarantine (R-42).
--
-- tenant_quarantine_releases: one row per quarantined message (its Identity, GUID1\GUID2) the
-- release job (services/tenant/quarantineRelease.js) has looked at: high confidence phishing EOP
-- quarantined (decision D-2) that the panel releases to the node's mailboxes, where the R-11 Sieve
-- rule files it into Junk and the panel shows it in the safe view (R-41). The row is the job's
-- claim and its idempotency: a message is released at most once by the panel; a row left
-- 'releasing' (the process stopped between the claim and the answer) is resolved by reading the
-- message back before anything is sent again.
--   state     releasing  claimed, the release was sent or is about to be
--             released   EOP shows it released (by the panel, or by someone else first: by_panel)
--             skipped    a guard kept it in quarantine (reason: outbound, foreign_recipients,
--                        no_recipients, not_high_conf_phish, release_denied); final
--             failed     the release failed (error, attempts); the next slot tries again up to the
--                        job's limit, then it stays failed for an administrator
-- sender, subject and recipients are kept for the administrators' list (the quarantine itself
-- keeps them for 30 days); rows are deleted 45 days after their last change. No body is kept.
CREATE TABLE IF NOT EXISTS tenant_quarantine_releases (
  identity      TEXT PRIMARY KEY,
  message_id    TEXT,
  sender        TEXT,
  subject       TEXT,
  recipients    TEXT[] NOT NULL DEFAULT '{}',
  received_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  state         TEXT NOT NULL CHECK (state IN ('releasing', 'released', 'skipped', 'failed')),
  reason        TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  by_panel      BOOLEAN NOT NULL DEFAULT false,
  released_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tenant_quarantine_releases_state_idx ON tenant_quarantine_releases (state, updated_at);

-- message_eop_traces: the latest on-demand trace of a sent letter (R-30), per (mailbox, Message-ID)
-- like message_delivery_status (migration 0084). The trace job (services/tenant/messageTrace.js)
-- lists Graph's message trace over the hours after the letter was sent, keeps the rows with the
-- letter's Message-ID, and reads each recipient's details.
--   state      queued, running (a cut-short listing keeps cursor and goes on), done, failed
--   recipients [{ recipient, traceId, status, receivedAt, statusCode, detail, eventAt, deliveredAt }]
--   error      a stable code when failed or when the last attempt was throttled
-- No subject, body or event data is kept.
CREATE TABLE IF NOT EXISTS message_eop_traces (
  account_id    UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_id    TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  sent_at       TIMESTAMPTZ NOT NULL,
  requested_by  UUID,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at    TIMESTAMPTZ,
  cursor        JSONB,
  recipients    JSONB NOT NULL DEFAULT '[]'::jsonb,
  error         TEXT,
  job_id        BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, message_id)
);
