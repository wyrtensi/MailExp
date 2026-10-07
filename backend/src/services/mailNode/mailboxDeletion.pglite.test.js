// The pending deletion of mail node mailboxes against PGlite with every real migration (0081): asking
// for it and cancelling it, and the deletion job: only due rows go, a node failure keeps the row
// pending with a longer wait, a mailbox already gone from the node lets the row go, a row on another
// host stays, and the reason survives into the final journal entry (the real recordAudit).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null };
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
const node = vi.hoisted(() => ({ cfg: null }));
vi.mock('./mailcow.js', async (importActual) => ({
  ...(await importActual()),
  getMailNodeConfig: vi.fn(async () => node.cfg),
  deleteMailbox: vi.fn(async () => ({ warnings: [] })),
  getMailbox: vi.fn(async () => null),
}));

const { MailNodeError, deleteMailbox, getMailbox } = await import('./mailcow.js');
const {
  BEFORE_NODE_DELETE, cancelDeletion, requestDeletion, retryDelaySeconds, runDueDeletions,
} = await import('./mailboxDeletion.js');

const USER = '70000000-0000-4000-8000-000000000001';
const CFG = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, deleteAfterDays: 5 };
let db;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email) VALUES ($1, 'anna', 'anna@example.com')", [USER]);
});
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  node.cfg = CFG;
  BEFORE_NODE_DELETE.length = 0;
  await db.query('DELETE FROM mailbox_audit_log');
  await db.query('DELETE FROM email_accounts');
  await db.query('DELETE FROM integration_config');
  await db.query('DELETE FROM mail_node_seat_assignments');
});

async function addMailbox(email, { mailNode = true, host = 'mail.example.com' } = {}) {
  const { rows } = await db.query(
    `INSERT INTO email_accounts (added_by, name, email_address, mail_node, imap_host) VALUES ($1, $2, $2, $3, $4) RETURNING id`,
    [USER, email, mailNode, host],
  );
  return rows[0].id;
}
const row = async (id) => (await db.query('SELECT * FROM email_accounts WHERE id = $1', [id])).rows[0];
const makeDue = (id, ago = '1 minute') => db.query(`UPDATE email_accounts SET delete_after = NOW() - $2::interval WHERE id = $1`, [id, ago]);
const audit = async () => (await db.query('SELECT actor_email, account_email, action, details FROM mailbox_audit_log ORDER BY id')).rows;

describe('the pending deletion columns (migration 0081)', () => {
  it('starts with no deletion pending on every mailbox', async () => {
    const id = await addMailbox('info@example.com');
    expect(await row(id)).toMatchObject({
      deletion_requested_at: null, deletion_requested_by: null, deletion_requested_by_email: null, deletion_reason: null,
      delete_after: null, deletion_attempts: 0, deletion_next_attempt_at: null, deletion_last_error: null,
    });
  });
});

describe('asking for and cancelling a deletion', () => {
  it('schedules the deletion the configured days ahead with who asked and why, once', async () => {
    const id = await addMailbox('info@example.com');
    const before = Date.now();
    const result = await requestDeletion({ accountId: id, userId: USER, reason: 'Left the company', holdDays: 90 });
    expect(result.days).toBe(5);
    const r = await row(id);
    expect(r).toMatchObject({ deletion_requested_by: USER, deletion_requested_by_email: 'anna@example.com', deletion_reason: 'Left the company' });
    const days = (new Date(r.delete_after).getTime() - before) / 86400000;
    expect(days).toBeGreaterThan(4.99);
    expect(days).toBeLessThan(5.01);
    expect(await requestDeletion({ accountId: id, userId: USER, reason: 'again', holdDays: 90 })).toEqual({ error: 'deletion_already_requested' });
    expect((await row(id)).deletion_reason).toBe('Left the company');
  });

  it('takes the days an administrator set; a change does not move dates already set', async () => {
    await db.query(`INSERT INTO integration_config (provider, config) VALUES ('mail_node', '{"deleteAfterDays": 30}')`);
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
    const first = (await row(id)).delete_after;
    expect((new Date(first).getTime() - Date.now()) / 86400000).toBeGreaterThan(29.9);
    await db.query(`UPDATE integration_config SET config = '{"deleteAfterDays": 1}' WHERE provider = 'mail_node'`);
    expect((await row(id)).delete_after).toEqual(first);
  });

  it('refuses another mailbox or an unknown one', async () => {
    const gmail = await addMailbox('x@gmail.com', { mailNode: false });
    expect(await requestDeletion({ accountId: gmail, userId: USER, reason: 'r', holdDays: 90 })).toEqual({ error: 'not_mail_node' });
    expect(await requestDeletion({ accountId: '70000000-0000-4000-8000-0000000000ff', userId: USER, reason: 'r', holdDays: 90 }))
      .toEqual({ error: 'account_not_found' });
  });

  it('cancels a pending deletion, clearing every column, and answers what was set', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'Left the company', holdDays: 90 });
    const { delete_after: was } = await row(id);
    expect(await cancelDeletion({ accountId: id, purchased: 100 })).toEqual({ deleteAfter: was, reason: 'Left the company', seat: expect.anything() });
    expect(await row(id)).toMatchObject({
      deletion_requested_at: null, deletion_requested_by: null, deletion_requested_by_email: null, deletion_reason: null,
      delete_after: null, deletion_attempts: 0, deletion_last_error: null,
    });
    expect(await cancelDeletion({ accountId: id, purchased: 100 })).toEqual({ error: 'deletion_not_requested' });
    expect(await cancelDeletion({ accountId: '70000000-0000-4000-8000-0000000000ff', purchased: 100 })).toEqual({ error: 'account_not_found' });
  });
});

describe('the deletion job', () => {
  it('deletes only due mailboxes, on the node first, and journals who asked, when and why', async () => {
    const due = await addMailbox('due@example.com');
    const later = await addMailbox('later@example.com');
    const never = await addMailbox('never@example.com');
    await requestDeletion({ accountId: due, userId: USER, reason: 'Project closed', holdDays: 90 });
    await requestDeletion({ accountId: later, userId: USER, reason: 'Not yet', holdDays: 90 });
    await makeDue(due);
    const disconnect = vi.fn(async () => {});
    expect(await runDueDeletions({ disconnect })).toEqual({ deleted: 1, failed: 0 });
    expect(deleteMailbox).toHaveBeenCalledTimes(1);
    expect(deleteMailbox).toHaveBeenCalledWith(CFG, 'due@example.com');
    expect(await row(due)).toBeUndefined();
    expect(await row(later)).toBeDefined();
    expect(await row(never)).toBeDefined();
    expect(disconnect).toHaveBeenCalledWith(due);
    const [entry] = await audit();
    expect(entry).toMatchObject({ actor_email: 'MailExpert', account_email: 'due@example.com', action: 'mailbox.deleted' });
    expect(entry.details).toMatchObject({ mailNode: true, pending: true, requestedBy: 'anna@example.com', reason: 'Project closed' });
    expect(Number.isNaN(Date.parse(entry.details.requestedAt))).toBe(false);
  });

  it('never touches a row without a date or with a date ahead', async () => {
    await addMailbox('plain@example.com');
    const ahead = await addMailbox('ahead@example.com');
    await requestDeletion({ accountId: ahead, userId: USER, reason: 'r', holdDays: 90 });
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 0 });
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect((await db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(2);
  });

  it('keeps the row pending with the reason and a growing wait when the node fails, then deletes it', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
    await makeDue(id);
    deleteMailbox.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ETIMEDOUT)'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 1 });
    errorSpy.mockRestore();
    let r = await row(id);
    // Only the code is kept on the row; the details go to the server log.
    expect(r).toMatchObject({ deletion_attempts: 1, deletion_last_error: 'mail_node_unreachable', deletion_started_at: null });
    expect(new Date(r.deletion_next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(r.delete_after).not.toBeNull();
    // Not retried before the wait is over.
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 0 });
    expect(deleteMailbox).toHaveBeenCalledTimes(1);
    await db.query('UPDATE email_accounts SET deletion_next_attempt_at = NOW() - interval \'1 second\' WHERE id = $1', [id]);
    expect(await runDueDeletions()).toEqual({ deleted: 1, failed: 0 });
    r = await row(id);
    expect(r).toBeUndefined();
    expect(retryDelaySeconds(0)).toBe(900);
    expect(retryDelaySeconds(1)).toBe(1800);
    expect(retryDelaySeconds(20)).toBe(86400);
  });

  it('lets the row go when the node no longer has the mailbox, and keeps it when the node still has it', async () => {
    const gone = await addMailbox('gone@example.com');
    const kept = await addMailbox('kept@example.com');
    for (const id of [gone, kept]) {
      await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
      await makeDue(id);
    }
    deleteMailbox.mockImplementation(async () => { throw new MailNodeError('mail_node_refused', 'The mail node refused: access_denied'); });
    getMailbox.mockImplementation(async (_cfg, email) => (email === 'kept@example.com' ? { email } : null));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDueDeletions()).toEqual({ deleted: 1, failed: 1 });
    errorSpy.mockRestore();
    deleteMailbox.mockReset().mockResolvedValue({ warnings: [] });
    getMailbox.mockReset().mockResolvedValue(null);
    expect(await row(gone)).toBeUndefined();
    expect((await row(kept)).deletion_last_error).toBe('mail_node_refused');
    const [entry] = await audit();
    expect(entry.details).toMatchObject({ pending: true, alreadyAbsent: true });
  });

  it('keeps a row on another host than the node the settings name, and says why', async () => {
    const id = await addMailbox('info@example.com', { host: 'old-node.example.com' });
    await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
    await makeDue(id);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 1 });
    warnSpy.mockRestore();
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect((await row(id)).deletion_last_error).toBe('mail_node_host_mismatch');
  });

  it('keeps every due row while the mail node is not set up, saying so and waiting before the next try', async () => {
    node.cfg = null;
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
    await makeDue(id);
    expect(await runDueDeletions()).toMatchObject({ deleted: 0, failed: 1, skipped: 'mail_node_not_configured' });
    const r = await row(id);
    expect(r).toMatchObject({ deletion_last_error: 'mail_node_not_configured', deletion_attempts: 1, deletion_started_at: null });
    expect(new Date(r.deletion_next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    // Not tried again before the wait is over.
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 0 });
  });

  it('runs the steps before the node delete (the tenant hook) and keeps the row when one fails', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
    await makeDue(id);
    const step = vi.fn(async () => { throw new Error('tenant down'); });
    BEFORE_NODE_DELETE.push(step);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 1 });
    errorSpy.mockRestore();
    expect(step).toHaveBeenCalledWith(expect.objectContaining({ id, email_address: 'info@example.com' }), CFG);
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect((await row(id)).deletion_last_error).toBe('deletion_step_failed');
  });

  it('lets a cancel win for a row of the same batch that the job has not reached yet', async () => {
    const first = await addMailbox('first@example.com');
    const second = await addMailbox('second@example.com');
    for (const [id, ago] of [[first, '2 minutes'], [second, '1 minute']]) {
      await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
      await makeDue(id, ago);
    }
    let cancelled;
    deleteMailbox.mockImplementationOnce(async () => {
      cancelled = await cancelDeletion({ accountId: second, purchased: 100 });
      return { warnings: [] };
    });
    expect(await runDueDeletions()).toEqual({ deleted: 1, failed: 0 });
    expect(cancelled).toMatchObject({ reason: 'r' });
    expect(deleteMailbox).toHaveBeenCalledTimes(1);
    expect(deleteMailbox).toHaveBeenCalledWith(CFG, 'first@example.com');
    expect(await row(first)).toBeUndefined();
    expect(await row(second)).toMatchObject({ delete_after: null, deletion_reason: null });
  });

  it('takes a claim left by a run that stopped again after 10 minutes; a cancel stays refused while it exists', async () => {
    const stale = await addMailbox('stale@example.com');
    const fresh = await addMailbox('fresh@example.com');
    for (const id of [stale, fresh]) {
      await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
      await makeDue(id);
    }
    await db.query("UPDATE email_accounts SET deletion_started_at = NOW() - interval '11 minutes' WHERE id = $1", [stale]);
    await db.query("UPDATE email_accounts SET deletion_started_at = NOW() - interval '1 minute' WHERE id = $1", [fresh]);
    expect(await cancelDeletion({ accountId: stale, purchased: 100 })).toEqual({ error: 'deletion_in_progress' });
    expect(await cancelDeletion({ accountId: fresh, purchased: 100 })).toEqual({ error: 'deletion_in_progress' });
    expect(await runDueDeletions()).toEqual({ deleted: 1, failed: 0 });
    expect(deleteMailbox).toHaveBeenCalledWith(CFG, 'stale@example.com');
    expect(await row(stale)).toBeUndefined();
    expect(await row(fresh)).toBeDefined();
  });

  it('never stays silent when the node mailbox went but the row changed under the claim', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'Left', holdDays: 90 });
    await makeDue(id);
    deleteMailbox.mockImplementationOnce(async () => {
      await db.query("UPDATE email_accounts SET deletion_started_at = NOW() + interval '1 hour' WHERE id = $1", [id]);
      return { warnings: [] };
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 1 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    expect((await row(id)).deletion_last_error).toBe('node_deleted_row_kept');
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'mailbox.deleted' });
    expect(entry.details).toMatchObject({ panelRowKept: true, reason: 'Left' });
  });

  it('writes the final journal entry with the row removal, or neither', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
    await makeDue(id);
    await db.query('ALTER TABLE mailbox_audit_log RENAME TO mailbox_audit_log_away');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 1 });
    } finally {
      await db.query('ALTER TABLE mailbox_audit_log_away RENAME TO mailbox_audit_log');
      errorSpy.mockRestore();
    }
    // The row is still there, claimed: the next run after the claim goes stale finishes it.
    expect((await row(id)).deletion_started_at).not.toBeNull();
    await db.query("UPDATE email_accounts SET deletion_started_at = NOW() - interval '11 minutes' WHERE id = $1", [id]);
    getMailbox.mockResolvedValueOnce(null);
    deleteMailbox.mockRejectedValueOnce(new MailNodeError('mail_node_refused', 'The mail node refused: access_denied'));
    expect(await runDueDeletions()).toEqual({ deleted: 1, failed: 0 });
    expect(await row(id)).toBeUndefined();
    expect((await audit())[0].details).toMatchObject({ alreadyAbsent: true });
  });

  it('refuses a cancel while the job is deleting the mailbox, and a cancel before keeps it', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
    await makeDue(id);
    let cancelDuring;
    deleteMailbox.mockImplementationOnce(async () => {
      cancelDuring = await cancelDeletion({ accountId: id, purchased: 100 });
      return { warnings: [] };
    });
    expect(await runDueDeletions()).toEqual({ deleted: 1, failed: 0 });
    expect(cancelDuring).toEqual({ error: 'deletion_in_progress' });

    const kept = await addMailbox('kept@example.com');
    await requestDeletion({ accountId: kept, userId: USER, reason: 'r', holdDays: 90 });
    await makeDue(kept);
    await cancelDeletion({ accountId: kept, purchased: 100 });
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 0 });
    expect(await row(kept)).toBeDefined();
  });
});

describe('the seat of a deletion (EOP seats design)', () => {
  const take = async (id, email, seatNo = 1) => db.query(
    'INSERT INTO mail_node_seat_assignments (seat_no, account_id, email) VALUES ($1, $2, $3)', [seatNo, id, email],
  );

  it('puts the seat on hold at the request and takes it back at the cancel', async () => {
    const id = await addMailbox('info@example.com');
    await take(id, 'info@example.com');
    expect((await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 })).seat.seat).toBe(1);
    expect((await cancelDeletion({ accountId: id, purchased: 1 })).seat).toEqual({ seat: 1, reclaimed: true });
  });

  it('refuses the cancel at 0 free once the own seat is past its hold, the deletion stays', async () => {
    const id = await addMailbox('info@example.com');
    await take(id, 'info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 0 });
    const other = await addMailbox('other@example.com');
    await take(other, 'other@example.com');
    expect(await cancelDeletion({ accountId: id, purchased: 1 })).toEqual({ error: 'no_free_seats' });
    expect(await cancelDeletion({ accountId: id, purchased: null })).toEqual({ error: 'seats_unknown' });
    expect((await row(id)).delete_after).not.toBeNull();
  });

  it('keeps the ledger row after the final deletion', async () => {
    const id = await addMailbox('info@example.com');
    await take(id, 'info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r', holdDays: 90 });
    await makeDue(id);
    await runDueDeletions();
    expect(await row(id)).toBeUndefined();
    const { rows } = await db.query('SELECT account_id, release_reason FROM mail_node_seat_assignments');
    expect(rows).toEqual([{ account_id: id, release_reason: 'deletion_requested' }]);
  });
});
