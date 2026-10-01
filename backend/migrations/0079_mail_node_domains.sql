-- The panel's record of each mail node domain and how far its onboarding got
-- (services/mailNode/domains.js). A domain on the node without a row here is "unknown": no mailbox
-- can be created on it until an administrator adopts it and brings it to 'ready'.
--
-- state: node_created -> node_configured -> dns_ok -> tenant_verified -> internal_relay ->
-- connector_ready -> ready -> authoritative (the last one once the tenant rejects unknown
-- recipients, DBEB). Mailboxes are created only in 'ready' and 'authoritative'.
-- origin: 'created' (added in the panel), 'adopted' (made on the node by hand and taken in by an
-- administrator) or 'existing_mailboxes' (taken in at startup because the panel already had
-- mailboxes there, services/mailNode/domains.js adoptDomainsWithMailboxes).
-- steps: the steps a person confirmed with "Done", {"<state>": {"at", "userId", "email"}}; the
-- email is copied so the entry stays readable after the user is gone.
-- max_mailboxes: the limit the domain was added with; null for an adopted domain (the node's own).
-- dkim_mode, mailbox_send_limit: this domain's own choice; null means the EOP settings' default.
-- mailbox_send_limit is messages per hour for each new mailbox.
-- relayhost_id: the mailcow relayhost the domain sends through (<EOP_HOST>).
-- expected_mx: the MX values the domain must publish (from the tenant, or typed in before it).
-- dns_check, dns_checked_at: the last DNS check and when it ran.
-- tenant: what the tenant reported for the domain (verification record, service records).
-- accepted_domain_type: the domain's type in the tenant, InternalRelay or Authoritative.
CREATE TABLE IF NOT EXISTS mail_node_domains (
  domain text PRIMARY KEY,
  state text NOT NULL DEFAULT 'node_created' CHECK (state IN (
    'node_created', 'node_configured', 'dns_ok', 'tenant_verified', 'internal_relay',
    'connector_ready', 'ready', 'authoritative'
  )),
  origin text NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'adopted', 'existing_mailboxes')),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  steps jsonb NOT NULL DEFAULT '{}',
  state_changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  max_mailboxes integer,
  dkim_mode text CHECK (dkim_mode IN ('mailcow', 'eop')),
  mailbox_send_limit integer CHECK (mailbox_send_limit > 0),
  relayhost_id integer,
  expected_mx jsonb NOT NULL DEFAULT '[]',
  dns_check jsonb,
  dns_checked_at timestamptz,
  tenant jsonb,
  accepted_domain_type text CHECK (accepted_domain_type IN ('InternalRelay', 'Authoritative')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
