-- The Google grant journal follows the Google Cloud project, not the app row. Google counts an
-- unverified app's users for the whole life of the project, so deleting an app and adding a client
-- of the same project again must find the seats already taken there; with the journal keyed by
-- app_id (ON DELETE CASCADE) it started from zero. An app is one project (project_number UNIQUE),
-- so (project_number, email) names the same rows (app_id, email) did.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'google_oauth_grants' AND column_name = 'app_id'
  ) THEN
    ALTER TABLE google_oauth_grants ADD COLUMN IF NOT EXISTS project_number TEXT;
    UPDATE google_oauth_grants g SET project_number = a.project_number
      FROM google_oauth_apps a WHERE a.id = g.app_id;
    ALTER TABLE google_oauth_grants ALTER COLUMN project_number SET NOT NULL;
    ALTER TABLE google_oauth_grants DROP CONSTRAINT IF EXISTS google_oauth_grants_pkey;
    -- Drops the foreign key (and its cascade) with the column.
    ALTER TABLE google_oauth_grants DROP COLUMN app_id;
    ALTER TABLE google_oauth_grants ADD PRIMARY KEY (project_number, email);
  END IF;
END $$;
