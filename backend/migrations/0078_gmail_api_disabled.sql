-- Journals when a Google Cloud project's Gmail API turned out to be disabled while sending
-- through it (services/gmailApiSender.js). Cleared on the next successful Gmail API send.
-- Used only to show a warning on that app's admin card; the app keeps trying the API on every
-- send regardless of this flag (a disabled API can be re-enabled by the project's owner at
-- any time, and the flag must self-heal without an admin action).
ALTER TABLE google_oauth_apps ADD COLUMN IF NOT EXISTS gmail_api_disabled_at TIMESTAMPTZ;
