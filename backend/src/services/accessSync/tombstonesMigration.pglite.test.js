// Migration 0097 on a panel that ran the Access sync before it: users deleted earlier are
// tombstoned from the journal, and users the sync disabled earlier get their mark.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const migration = readFileSync(new URL('../../../migrations/0097_access_tombstones.sql', import.meta.url), 'utf8');
const ADMIN = '20000000-0000-4000-8000-000000000001';
const BACK = '20000000-0000-4000-8000-000000000002';
const SYNC_OFF = '20000000-0000-4000-8000-000000000003';
const ADMIN_OFF = '20000000-0000-4000-8000-000000000004';
const REENABLED = '20000000-0000-4000-8000-000000000005';

let db;
beforeAll(async () => {
  db = await createRealSchemaDb({ before: '0097' });
  await db.exec(`
    INSERT INTO users (id, username, email, is_admin, disabled_at) VALUES
      ('${ADMIN}', 'admin@example.com', 'admin@example.com', true, NULL),
      ('${BACK}', 'back@example.com', 'back@example.com', false, NULL),
      ('${SYNC_OFF}', 'cf@example.com', 'cf@example.com', false, NOW()),
      ('${ADMIN_OFF}', 'off@example.com', 'off@example.com', false, NOW()),
      ('${REENABLED}', 'again@example.com', 'again@example.com', false, NOW());
    INSERT INTO mailbox_audit_log (occurred_at, actor_user_id, actor_email, action, details) VALUES
      ('2026-09-01T10:00:00Z', '${ADMIN}', 'admin@example.com', 'user.deleted', '{"email": "Gone@Example.com"}'),
      ('2026-09-02T10:00:00Z', NULL, 'cli', 'user.deleted', '{"email": "gone@example.com"}'),
      ('2026-09-03T10:00:00Z', '${ADMIN}', 'admin@example.com', 'user.deleted', '{"email": "back@example.com"}'),
      ('2026-09-04T10:00:00Z', '${ADMIN}', 'admin@example.com', 'user.deleted', '{"userId": "x"}'),
      ('2026-09-05T10:00:00Z', NULL, 'Cloudflare Access', 'user.disabled', '{"userId": "${SYNC_OFF}", "source": "cloudflare_access"}'),
      ('2026-09-05T10:00:00Z', '${ADMIN}', 'admin@example.com', 'user.disabled', '{"userId": "${ADMIN_OFF}"}'),
      ('2026-09-05T10:00:00Z', NULL, 'Cloudflare Access', 'user.disabled', '{"userId": "${REENABLED}", "source": "cloudflare_access"}'),
      ('2026-09-06T10:00:00Z', '${ADMIN}', 'admin@example.com', 'user.enabled', '{"userId": "${REENABLED}"}'),
      ('2026-09-07T10:00:00Z', '${ADMIN}', 'admin@example.com', 'user.disabled', '{"userId": "${REENABLED}"}');
  `);
  await db.exec(migration);
});
afterAll(async () => { await db?.close(); });

describe('migration 0097: tombstones and the sync mark from the journal', () => {
  it('tombstones the address of each deleted user no user has now, as of its latest delete', async () => {
    const { rows } = await db.query('SELECT email, created_at, created_by, created_by_name, reason FROM access_tombstones ORDER BY email');
    expect(rows).toEqual([
      { email: 'gone@example.com', created_at: new Date('2026-09-02T10:00:00Z'), created_by: null, created_by_name: 'cli', reason: 'deleted' },
    ]);
  });

  it('marks only users whose latest disable was the sync\'s', async () => {
    const { rows } = await db.query('SELECT email, disabled_source, access_source FROM users ORDER BY email');
    expect(rows).toEqual([
      { email: 'admin@example.com', disabled_source: null, access_source: null },
      { email: 'again@example.com', disabled_source: null, access_source: null },
      { email: 'back@example.com', disabled_source: null, access_source: null },
      { email: 'cf@example.com', disabled_source: 'cloudflare_access', access_source: null },
      { email: 'off@example.com', disabled_source: null, access_source: null },
    ]);
  });
});
