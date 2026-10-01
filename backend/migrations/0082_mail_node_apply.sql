-- What the panel last applied to the mail node through the mailcow API
-- (services/mailNode/nodeApply.js) and each mailbox's own send limit.
--
-- mail_node_domains.apply_result: the last "apply" of the domain's node settings, one entry per item
-- (the domain's relayhost, DKIM, the send limits of its mailboxes) with its outcome (ok, changed,
-- failed, skipped) and a code the screens translate, plus the DKIM record mailcow publishes for the
-- domain. applied_at: when it ran. Both NULL until the first apply; "Restart onboarding" clears them.
ALTER TABLE mail_node_domains ADD COLUMN IF NOT EXISTS apply_result jsonb;
ALTER TABLE mail_node_domains ADD COLUMN IF NOT EXISTS applied_at timestamptz;

-- node_rl_value, node_rl_frame: an administrator's send limit for this mail node mailbox, messages
-- per second, minute, hour or day (mailcow's rl_value / rl_frame, counted per SASL login). NULL
-- means the default: the domain's mailbox_send_limit, else the EOP settings' limit, per hour.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS node_rl_value integer;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS node_rl_frame text;
ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_node_rl_check;
ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_node_rl_check CHECK (
  (node_rl_value IS NULL AND node_rl_frame IS NULL)
  OR (node_rl_value IS NOT NULL AND node_rl_frame IS NOT NULL AND node_rl_value > 0 AND node_rl_frame IN ('s', 'm', 'h', 'd'))
);
