// The pending deletion of mail node mailboxes against PGlite with every real migration (0081): asking
// for it and cancelling it, and the deletion job: only due rows go, a node failure keeps the row
// pending with a longer wait, a mailbox already gone from the node lets the row go, a row on another
// host stays, and the reason survives into the final journal entry (the real recordAudit).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null };
vi.mock('../db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));
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
    const result = await requestDeletion({ accountId: id, userId: USER, reason: 'Left the company' });
    expect(result.days).toBe(5);
    const r = await row(id);
    expect(r).toMatchObject({ deletion_requested_by: USER, deletion_requested_by_email: 'anna@example.com', deletion_reason: 'Left the company' });
    const days = (new Date(r.delete_after).getTime() - before) / 86400000;
    expect(days).toBeGreaterThan(4.99);
    expect(days).toBeLessThan(5.01);
    expect(await requestDeletion({ accountId: id, userId: USER, reason: 'again' })).toEqual({ error: 'deletion_already_requested' });
    expect((await row(id)).deletion_reason).toBe('Left the company');
  });

  it('takes the days an administrator set; a change does not move dates already set', async () => {
    await db.query(`INSERT INTO integration_config (provider, config) VALUES ('mail_node', '{"deleteAfterDays": 30}')`);
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r' });
    const first = (await row(id)).delete_after;
    expect((new Date(first).getTime() - Date.now()) / 86400000).toBeGreaterThan(29.9);
    await db.query(`UPDATE integration_config SET config = '{"deleteAfterDays": 1}' WHERE provider = 'mail_node'`);
    expect((await row(id)).delete_after).toEqual(first);
  });

  it('refuses another mailbox or an unknown one', async () => {
    const gmail = await addMailbox('x@gmail.com', { mailNode: false });
    expect(await requestDeletion({ accountId: gmail, userId: USER, reason: 'r' })).toEqual({ error: 'not_mail_node' });
    expect(await requestDeletion({ accountId: '70000000-0000-4000-8000-0000000000ff', userId: USER, reason: 'r' }))
      .toEqual({ error: 'account_not_found' });
  });

  it('cancels a pending deletion, clearing every column, and answers what was set', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'Left the company' });
    const { delete_after: was } = await row(id);
    expect(await cancelDeletion({ accountId: id })).toEqual({ deleteAfter: was, reason: 'Left the company' });
    expect(await row(id)).toMatchObject({
      deletion_requested_at: null, deletion_requested_by: null, deletion_requested_by_email: null, deletion_reason: null,
      delete_after: null, deletion_attempts: 0, deletion_last_error: null,
    });
    expect(await cancelDeletion({ accountId: id })).toEqual({ error: 'deletion_not_requested' });
    expect(await cancelDeletion({ accountId: '70000000-0000-4000-8000-0000000000ff' })).toEqual({ error: 'account_not_found' });
  });
});

describe('the deletion job', () => {
  it('deletes only due mailboxes, on the node first, and journals who asked, when and why', async () => {
    const due = await addMailbox('due@example.com');
    const later = await addMailbox('later@example.com');
    const never = await addMailbox('never@example.com');
    await requestDeletion({ accountId: due, userId: USER, reason: 'Project closed' });
    await requestDeletion({ accountId: later, userId: USER, reason: 'Not yet' });
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
    await requestDeletion({ accountId: ahead, userId: USER, reason: 'r' });
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 0 });
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect((await db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(2);
  });

  it('keeps the row pending with the reason and a growing wait when the node fails, then deletes it', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r' });
    await makeDue(id);
    deleteMailbox.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ETIMEDOUT)'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 1 });
    errorSpy.mockRestore();
    let r = await row(id);
    expect(r).toMatchObject({ deletion_attempts: 1, deletion_last_error: 'mail_node_unreachable: The mail node is unreachable (ETIMEDOUT)' });
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
      await requestDeletion({ accountId: id, userId: USER, reason: 'r' });
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
    expect((await row(kept)).deletion_last_error).toContain('mail_node_refused');
  });

  it('keeps a row on another host than the node the settings name, and says why', async () => {
    const id = await addMailbox('info@example.com', { host: 'old-node.example.com' });
    await requestDeletion({ accountId: id, userId: USER, reason: 'r' });
    await makeDue(id);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 1 });
    warnSpy.mockRestore();
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect((await row(id)).deletion_last_error).toBe('mail_node_host_mismatch');
  });

  it('keeps every due row while the mail node is not set up', async () => {
    node.cfg = null;
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r' });
    await makeDue(id);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runDueDeletions()).toMatchObject({ deleted: 0, failed: 1, skipped: 'mail_node_not_configured' });
    warnSpy.mockRestore();
    expect(await row(id)).toBeDefined();
  });

  it('runs the steps before the node delete (the tenant hook) and keeps the row when one fails', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r' });
    await makeDue(id);
    const step = vi.fn(async () => { throw new Error('tenant down'); });
    BEFORE_NODE_DELETE.push(step);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 1 });
    errorSpy.mockRestore();
    expect(step).toHaveBeenCalledWith(expect.objectContaining({ id, email_address: 'info@example.com' }), CFG);
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect((await row(id)).deletion_last_error).toBe('tenant down');
  });

  it('lets a cancel win for a row of the same batch that the job has not reached yet', async () => {
    const first = await addMailbox('first@example.com');
    const second = await addMailbox('second@example.com');
    for (const [id, ago] of [[first, '2 minutes'], [second, '1 minute']]) {
      await requestDeletion({ accountId: id, userId: USER, reason: 'r' });
      await makeDue(id, ago);
    }
    let cancelled;
    deleteMailbox.mockImplementationOnce(async () => {
      cancelled = await cancelDeletion({ accountId: second });
      return { warnings: [] };
    });
    expect(await runDueDeletions()).toEqual({ deleted: 1, failed: 0 });
    expect(cancelled).toMatchObject({ reason: 'r' });
    expect(deleteMailbox).toHaveBeenCalledTimes(1);
    expect(deleteMailbox).toHaveBeenCalledWith(CFG, 'first@example.com');
    expect(await row(first)).toBeUndefined();
    expect(await row(second)).toMatchObject({ delete_after: null, deletion_reason: null });
  });

  it('refuses a cancel while the job is deleting the mailbox, and a cancel before keeps it', async () => {
    const id = await addMailbox('info@example.com');
    await requestDeletion({ accountId: id, userId: USER, reason: 'r' });
    await makeDue(id);
    let cancelDuring;
    deleteMailbox.mockImplementationOnce(async () => {
      cancelDuring = await cancelDeletion({ accountId: id });
      return { warnings: [] };
    });
    expect(await runDueDeletions()).toEqual({ deleted: 1, failed: 0 });
    expect(cancelDuring).toEqual({ error: 'deletion_in_progress' });

    const kept = await addMailbox('kept@example.com');
    await requestDeletion({ accountId: kept, userId: USER, reason: 'r' });
    await makeDue(kept);
    await cancelDeletion({ accountId: kept });
    expect(await runDueDeletions()).toEqual({ deleted: 0, failed: 0 });
    expect(await row(kept)).toBeDefined();
  });
});
