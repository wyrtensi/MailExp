// Migration 0096 on a journal written under the old schema: grants keyed by app_id (ON DELETE
// CASCADE) are re-keyed by the app's Cloud project and no longer go with a deleted app.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const migration = readFileSync(new URL('../../../migrations/0096_google_grants_by_project.sql', import.meta.url), 'utf8');
const APP_1 = '10000000-0000-4000-8000-000000000001';
const APP_2 = '10000000-0000-4000-8000-000000000002';

let db;
beforeAll(async () => {
  db = await createRealSchemaDb({ before: '0096' });
  await db.exec(`
    INSERT INTO google_oauth_apps (id, label, client_id, client_secret, project_number) VALUES
      ('${APP_1}', 'Google 1', '111111111111-a.apps.googleusercontent.com', 'enc', '111111111111'),
      ('${APP_2}', 'Google 2', '222222222222-b.apps.googleusercontent.com', 'enc', '222222222222');
    INSERT INTO google_oauth_grants (app_id, email, google_sub) VALUES
      ('${APP_1}', 'one@gmail.com', 'sub-1'),
      ('${APP_1}', 'two@gmail.com', NULL),
      ('${APP_2}', 'one@gmail.com', 'sub-1');
  `);
  await db.exec(migration);
});
afterAll(async () => { await db?.close(); });

const grants = async () => (await db.query(
  'SELECT project_number, email, google_sub FROM google_oauth_grants ORDER BY project_number, email',
)).rows;

describe('migration 0096: grants keyed by project', () => {
  it('re-keys every grant by the project of its app and drops app_id', async () => {
    expect(await grants()).toEqual([
      { project_number: '111111111111', email: 'one@gmail.com', google_sub: 'sub-1' },
      { project_number: '111111111111', email: 'two@gmail.com', google_sub: null },
      { project_number: '222222222222', email: 'one@gmail.com', google_sub: 'sub-1' },
    ]);
    const { rows } = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'google_oauth_grants' AND column_name = 'app_id'",
    );
    expect(rows).toEqual([]);
    await expect(db.query(
      "INSERT INTO google_oauth_grants (project_number, email) VALUES ('111111111111', 'one@gmail.com')",
    )).rejects.toThrow(/duplicate key/);
  });

  it('keeps the grants when their app is deleted', async () => {
    await db.query('DELETE FROM google_oauth_apps WHERE id = $1', [APP_1]);
    expect((await grants()).filter((g) => g.project_number === '111111111111')).toHaveLength(2);
  });

  it('is a no-op when applied again', async () => {
    await db.exec(migration);
    expect(await grants()).toHaveLength(3);
  });
});
