-- The CAT field of the letter's X-Forefront-Antispam-Report header (utils/antispamReport.js): the
-- category Microsoft EOP gave it (SPM, BULK, PHSH, HPHSH, HPHISH, SPOOF, MALW, ...), the most
-- dangerous one when the header comes more than once. Written by the sync from the headers it
-- already fetches; NULL when the letter has no such header or was synced before this column. The
-- reading pane shows a phishing, malware or spoofed letter in safe mode wherever it lies (R-41).
-- Not related to the spam_* columns of 0021_spam_training.sql, which are the panel's own filter.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS eop_category text;
