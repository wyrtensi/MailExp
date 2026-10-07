// A PGlite database with the real schema: every migration in backend/migrations, in order, as the
// runner (services/migrations.js) applies them. For PGlite tests that need the real `messages`
// table (its UNIQUE, generated columns and indexes) instead of a hand-written subset.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { hasNoTransactionMarker } from '../migrations.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');

// A "-- no-transaction" migration runs one statement at a time (CREATE INDEX CONCURRENTLY cannot
// run in a transaction block); the rest run whole, as the runner does.
async function applyMigration(db, sql) {
  if (!hasNoTransactionMarker(sql)) {
    await db.exec(sql);
    return;
  }
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
  for (const statement of statements) await db.query(statement);
}

// `before` (a migration file name or its number prefix, e.g. '0096') stops ahead of that migration,
// for a test that fills the older schema and then applies the migration itself.
export async function createRealSchemaDb({ before = null } = {}) {
  const db = new PGlite({ extensions: { pg_trgm } });
  const files = readdirSync(migrationsDir).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort()
    .filter(f => !before || f < before);
  for (const file of files) {
    try {
      await applyMigration(db, readFileSync(join(migrationsDir, file), 'utf8'));
    } catch (err) {
      throw new Error(`migration ${file} failed on PGlite: ${err.message}`, { cause: err });
    }
  }
  return db;
}
