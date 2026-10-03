-- Stage 7b of the EOP panel work: the tenant driver takes a domain through its tenant steps (R-23
-- domain in the tenant, R-24 accepted domain type, R-25 Outbound connector, R-26 EOP DKIM) and
-- keeps the DBEB recipient mirror (R-29) (services/tenant/tenantDomains.js).
--
-- mail_node_domains.tenant_sync: what the last run of the domain's tenant job saw and did, for the
-- screen: { at, ok, error, graph, acceptedDomain, connector, dkim, mirror }. Cleared with the rest
-- of what the tenant reported when the onboarding starts over. The values the domain must publish
-- that the tenant gives (verification TXT, DKIM selector CNAMEs, MX) go where the manual ones live
-- (tenant with source 'tenant', expected_mx), so the DNS check reads them as before.
ALTER TABLE mail_node_domains ADD COLUMN IF NOT EXISTS tenant_sync jsonb;

-- email_accounts.tenant_recipient_at: when the mirror last saw the mailbox's recipient (a mail
-- contact) in the tenant; NULL until then, and again when it went missing. In an Authoritative
-- domain EOP rejects mail to an address without one (550 5.4.1), so the mailbox shows "awaiting the
-- tenant" (R-32).
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS tenant_recipient_at timestamptz;
