-- Cloudflare Access two-way sync (services/accessSync/).

-- Emails of users an administrator deleted permanently. While an email is here, the sync does not
-- import it from the Access policy and a Cloudflare Access sign-in under it is refused, even if
-- Cloudflare still lists the email or the person's Access token is still valid. Adding the user
-- again clears it. No foreign key on the email: the user row is gone.
CREATE TABLE IF NOT EXISTS access_tombstones (
  email text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text
);

-- Why a user is disabled, when the Access sync did it: 'cloudflare_access' (the email was removed
-- from the policy in Cloudflare). NULL for an administrator's disable and for active users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_source text;
