-- The owner's decisions after stage 7 of the EOP panel work (section 5.14 of
-- docs/architecture/mail-node-research/eop-panel-requirements.md): the release job of R-42
-- (services/tenant/quarantineRelease.js) releases phishing, spam and high confidence spam EOP
-- quarantined as well as high confidence phishing, with the same guards; malware and every other
-- type stay in the quarantine.
--
-- tenant_quarantine_releases.quarantine_type: what EOP quarantined the message as, named
-- (HighConfPhish, Phish, Spam, HighConfSpam, or the type as EOP wrote it for one the panel does not
-- release, such as Malware), for the administrators' list and the journal. NULL on rows written
-- before this migration until a run reads the message again.
ALTER TABLE tenant_quarantine_releases ADD COLUMN IF NOT EXISTS quarantine_type TEXT;

-- Rows stage 7c kept only because the message was not high confidence phishing (its own guard, or
-- the worker's) are looked at again by the next run under the new guards: deleting them makes the
-- message a candidate again if it is still in the quarantine. Every other guard is unchanged.
DELETE FROM tenant_quarantine_releases WHERE state = 'skipped' AND reason IN ('not_high_conf_phish', 'worker_refused');
