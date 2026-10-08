-- Cloudflare Access two-way sync (services/accessSync/).

-- Addresses that must not come back on their own: the email of a user an administrator deleted
-- (reason 'deleted') and the address a user had before an administrator changed or cleared it
-- (reason 'email_changed'). While an address is here, the sync does not import it from the
-- Access policy and a Cloudflare Access sign-in under it is refused, even if Cloudflare still
-- lists it or the person's Access token is still valid. Approving the address again clears it.
-- No foreign key on the email: the user row is gone or has another address.
CREATE TABLE IF NOT EXISTS access_tombstones (
  email text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text,
  reason text NOT NULL DEFAULT 'deleted' CHECK (reason IN ('deleted', 'email_changed'))
);

-- Users deleted before this migration: the journal names their address (user.deleted), and an
-- address no user has now is tombstoned as of the latest delete, by whoever did it.
INSERT INTO access_tombstones (email, created_at, created_by, created_by_name, reason)
SELECT DISTINCT ON (lower(trim(l.details->>'email')))
       lower(trim(l.details->>'email')), l.occurred_at, l.actor_user_id,
       CASE WHEN l.actor_user_id IS NULL THEN l.actor_email END, 'deleted'
  FROM mailbox_audit_log l
 WHERE l.action = 'user.deleted'
   AND COALESCE(trim(l.details->>'email'), '') <> ''
   AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(l.details->>'email')))
 ORDER BY lower(trim(l.details->>'email')), l.occurred_at DESC, l.id DESC
ON CONFLICT (email) DO NOTHING;

-- Why a user is disabled, when the Access sync did it: 'cloudflare_access' (the email was removed
-- from the policy in Cloudflare). NULL for an administrator's disable and for active users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_source text;

-- Users disabled before this migration whose latest enable/disable in the journal is the sync's
-- disable (user.disabled with details.source 'cloudflare_access'). Anything else stays NULL.
UPDATE users u
   SET disabled_source = 'cloudflare_access'
 WHERE u.disabled_at IS NOT NULL
   AND u.disabled_source IS NULL
   AND (SELECT l.details->>'source'
          FROM mailbox_audit_log l
         WHERE l.action IN ('user.disabled', 'user.enabled')
           AND l.details->>'userId' = u.id::text
         ORDER BY l.occurred_at DESC, l.id DESC
         LIMIT 1) = 'cloudflare_access';

-- How an account came in through Cloudflare Access without an email rule of its own: 'login' for
-- an account created at an Access sign-in whose email the policy did not list by address (a
-- domain or group rule admitted it). The sync does not write such users into the policy; once
-- the policy lists the email by address, the sync adopts it and clears the mark. NULL otherwise.
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_source text;
