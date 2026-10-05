-- Plugins are switched on and off by an administrator for the whole panel, no longer per user.
--
-- The switch lives in system_settings under 'enabled_plugins': a JSON array of plugin ids, stored
-- as text like the other panel-wide settings. A plugin starts out on when any user who is not
-- disabled had turned it on for themselves (users.preferences.enabledPlugins). That is exactly when
-- the server already ran the plugin on the shared mailboxes (the old per-mailbox gate asked whether
-- any active user had it), so nothing changes in what happens to mail; taking only administrators
-- could have silently stopped GTD on mailboxes an ordinary user relied on.
--
-- users.preferences.enabledPlugins is left where it is and no longer read.
--
-- Idempotent: the row is written only when it does not exist yet, and always (as '[]' when nobody
-- had a plugin on), so an administrator's later choice is never overwritten.
INSERT INTO system_settings (key, value, updated_at)
SELECT 'enabled_plugins', COALESCE(jsonb_agg(DISTINCT plugin.id ORDER BY plugin.id), '[]'::jsonb)::text, NOW()
  FROM users u
 CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(u.preferences -> 'enabledPlugins') = 'array'
              THEN u.preferences -> 'enabledPlugins'
              ELSE '[]'::jsonb END
       ) AS element
 CROSS JOIN LATERAL (SELECT element #>> '{}' AS id) AS plugin
 WHERE u.disabled_at IS NULL
   AND jsonb_typeof(element) = 'string'
ON CONFLICT (key) DO NOTHING;
