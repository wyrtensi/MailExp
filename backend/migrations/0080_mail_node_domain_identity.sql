-- The node's own identity of a domain the panel onboarded: when mailcow made it (get/domain
-- "created"). A domain deleted on the node and made again by hand has another one, and the panel
-- then treats it as unknown until an administrator adopts it again, instead of keeping the old
-- row's 'ready' (services/mailNode/domains.js). NULL until the panel first sees the domain on the
-- node, or when mailcow does not report it.
ALTER TABLE mail_node_domains ADD COLUMN IF NOT EXISTS node_created text;
