-- The node agent's update job (services/mailNode/nodeAgent.js, scripts/deploy/mail-node/node-update.sh):
-- after a panel update, the panel asks the agent to bring the node's scripts to the commit the panel
-- runs (params: {"sha": "<40 hex>"}, built by the server from its own BUILD_SHA, never taken from a
-- request). The agent checks that the commit is in the history of the official repository's main,
-- backs the node up (tag pre-update), checks the commit out and runs setup.sh, and goes back to the
-- previous commit when setup.sh fails.
ALTER TABLE node_agent_jobs DROP CONSTRAINT IF EXISTS node_agent_jobs_kind_check;
ALTER TABLE node_agent_jobs ADD CONSTRAINT node_agent_jobs_kind_check CHECK (kind IN ('status', 'backup', 'update'));

-- The update jobs for a target commit (the panel queues one automatic job per commit).
CREATE INDEX IF NOT EXISTS idx_node_agent_jobs_update_sha ON node_agent_jobs ((params->>'sha')) WHERE kind = 'update';
