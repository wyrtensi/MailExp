-- A general durable job queue (services/jobQueue.js): work that runs later, in the background, and
-- survives a restart. The first kind is send_message (undo send and send later, routes/send.js);
-- reminders, auto-replies, tenant jobs and delayed mailbox actions are meant to follow.
--
-- kind: the handler that runs the job; payload: its parameters (ids and references only, never a
-- letter's content). run_at: when it is due. status:
--   queued          waiting for run_at (or for a retry)
--   running         claimed by a worker (claim_token), its lease (lease_until) renewed while it runs
--   done            finished
--   failed          gave up (a permanent error, or max_attempts reached); kept until someone acts
--   cancelled       cancelled while it was still queued
--   needs_attention an at-most-once job whose outcome is unknown (its lease ran out, or the
--                   connection broke, after it began its effect): never run again automatically
-- effect_started_at: set by an at-most-once handler right before its irreversible step (a send
-- handing the letter to the mail server). A running job whose lease ran out without it is queued
-- again; with it, it needs attention.
-- dedupe_key: an enqueue with the same (kind, dedupe_key) returns the job already there (a double
-- click on Send). created_by / account_id: who asked for the job and which mailbox it is about.
-- finished_at: when it became done or cancelled; such rows are deleted after a retention period.
CREATE TABLE IF NOT EXISTS jobs (
  id                 BIGSERIAL PRIMARY KEY,
  kind               TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}',
  run_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled', 'needs_attention')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 5,
  last_error         TEXT,
  error_code         TEXT,
  claim_token        TEXT,
  claimed_at         TIMESTAMPTZ,
  lease_until        TIMESTAMPTZ,
  effect_started_at  TIMESTAMPTZ,
  dedupe_key         TEXT,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  account_id         UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
  finished_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs (kind, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (run_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs (lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs (account_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_jobs_finished ON jobs (finished_at) WHERE finished_at IS NOT NULL;

-- The letter a send_message job sends, kept apart from the job so listing jobs never reads it.
-- compose: what the writer composed (recipients, subject, body, reply context), to reopen it in
-- the composer on undo or edit. mail: the built message (nodemailer options, attachments in
-- base64), compiled to MIME when it is sent. Deleted as soon as the letter is sent or the job is
-- cancelled; kept with a failed job so the letter can be sent again.
CREATE TABLE IF NOT EXISTS outgoing_messages (
  job_id      BIGINT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  compose     JSONB NOT NULL,
  mail        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
