-- The mail node's agent (scripts/deploy/mail-node/node-agent.sh, services/mailNode/nodeAgent.js):
-- a service on the node host that long-polls the panel for jobs over HTTPS with its own token.
--
-- node_agent: one row (id 1) for the installation's one mail node. token_hash: sha256 (hex) of the
-- agent's token; the token itself is shown once and never stored. NULL: no agent is connected (never
-- set up, or revoked). token_created_at / token_created_by: the last issue or rotation (a rotation
-- replaces the hash, so the old token stops working at once). last_seen_at: the agent's last
-- authenticated request (a poll comes at least every 50 seconds). status / status_at: the agent's
-- last status report (scripts commit, mailcow version, containers, last node backup), kept across a
-- revocation so the screen still shows what the node said last.
CREATE TABLE IF NOT EXISTS node_agent (
  id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  token_hash        TEXT,
  token_created_at  TIMESTAMPTZ,
  token_created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  last_seen_at      TIMESTAMPTZ,
  status            JSONB,
  status_at         TIMESTAMPTZ
);

-- The agent's jobs, asked for by an administrator (or the panel itself) and picked up by the agent.
-- kind: what the agent runs, from a fixed list it checks again on the node. params: the job's
-- parameters (never a secret). state: queued (waiting for the agent), running (the agent took it),
-- succeeded, failed. step: the step the agent reported last; log_tail: the end of its output (capped
-- by the server); error: why it failed. A job stuck queued or running past its bound is failed by
-- the server (services/mailNode/nodeAgent.js), so the screen never waits for ever.
CREATE TABLE IF NOT EXISTS node_agent_jobs (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('status', 'backup')),
  params       JSONB NOT NULL DEFAULT '{}',
  state        TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  step         TEXT,
  log_tail     TEXT,
  error        TEXT,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

-- At most one job of a kind waiting or running: a second "Back up mail now" is refused.
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_agent_jobs_active ON node_agent_jobs (kind) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_node_agent_jobs_created ON node_agent_jobs (created_at DESC, id DESC);
