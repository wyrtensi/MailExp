// Migration 0095 on a database that already holds mail node mailboxes: the seat ledger is backfilled
// by creation order, and a mailbox without a creation time (the column is nullable) must not fail it.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const migration = readFileSync(new URL('../../../migrations/0095_eop_seats.sql', import.meta.url), 'utf8');
const USER = '20000000-0000-4000-8000-000000000001';
const id = (n) => `30000000-0000-4000-8000-00000000000${n}`;

let db;
beforeAll(async () => {
  db = await createRealSchemaDb({ before: '0095' });
  await db.exec(`
    INSERT INTO users (id, username) VALUES ('${USER}', 'owner');
    INSERT INTO email_accounts (id, added_by, name, email_address, mail_node, created_at, delete_after, deletion_requested_at) VALUES
      ('${id(1)}', '${USER}', 'a', 'Second@Example.com', true, '2026-02-01T00:00:00Z', NULL, NULL),
      ('${id(2)}', '${USER}', 'b', 'first@example.com', true, '2026-01-01T00:00:00Z', NULL, NULL),
      ('${id(3)}', '${USER}', 'c', 'nodate@example.com', true, NULL, NULL, NULL),
      ('${id(4)}', '${USER}', 'd', 'pending@example.com', true, '2026-03-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      ('${id(5)}', '${USER}', 'e', 'pending-nodate@example.com', true, '2026-03-02T00:00:00Z', '2026-09-01T00:00:00Z', NULL),
      ('${id(6)}', '${USER}', 'f', 'external@example.com', false, '2026-01-01T00:00:00Z', NULL, NULL);
  `);
  await db.exec(migration);
});
afterAll(async () => { await db?.close(); });

describe('migration 0095: seat backfill', () => {
  it('gives each node mailbox a seat in creation order, a mailbox without a date last', async () => {
    const { rows } = await db.query(
      'SELECT seat_no, email, assigned_at IS NOT NULL AS has_date FROM mail_node_seat_assignments ORDER BY seat_no',
    );
    expect(rows).toEqual([
      { seat_no: 1, email: 'first@example.com', has_date: true },
      { seat_no: 2, email: 'second@example.com', has_date: true },
      { seat_no: 3, email: 'pending@example.com', has_date: true },
      { seat_no: 4, email: 'pending-nodate@example.com', has_date: true },
      { seat_no: 5, email: 'nodate@example.com', has_date: true },
    ]);
  });

  it('holds the seat of a mailbox pending deletion for 90 days, with or without a request time', async () => {
    const { rows } = await db.query(
      `SELECT email, release_reason, released_at IS NOT NULL AS released,
              EXTRACT(DAY FROM free_from - released_at)::int AS hold_days
         FROM mail_node_seat_assignments WHERE release_reason IS NOT NULL ORDER BY seat_no`,
    );
    expect(rows.map((r) => [r.email, r.release_reason, r.released, r.hold_days])).toEqual([
      ['pending@example.com', 'deletion_requested', true, 90],
      ['pending-nodate@example.com', 'deletion_requested', true, 90],
    ]);
  });

  it('is a no-op when applied again', async () => {
    await db.exec(migration);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM mail_node_seat_assignments');
    expect(rows[0].n).toBe(5);
  });
});
