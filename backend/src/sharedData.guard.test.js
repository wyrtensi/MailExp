import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

// Migration 0056 dropped the owner column of mailboxes and the data around them. Route tests
// mock the database, so a query that still names it would only fail against a real one. These
// files handle genuinely personal tables (sessions, identities, auth events, push subscriptions,
// personal integrations); no other file may mention user_id.
const PERSONAL_DATA_FILES = new Set([
  'routes/admin.js',
  'routes/auth.js',
  'routes/oidc.js',
  'routes/todoist.js',
  // Turning password login off checks the administrator's SSO identities (user_identities).
  'services/admin/systemSettings.js',
  'services/authEvents.js',
  'services/pushNotifications.js',
]);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [path] : [];
  });
}

describe('shared mailbox data', () => {
  it('names no owner column outside the files about personal data', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file).split(sep).join('/'))
      .filter((file) => !PERSONAL_DATA_FILES.has(file))
      .filter((file) => /\buser_id\b/.test(readFileSync(join(SRC, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
