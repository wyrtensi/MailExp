import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import { AUDIT_ACTIONS, recordAudit } from './auditLog.js';

let errorSpy;
beforeEach(() => {
  query.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); });

const insertedRows = (call = 0) => JSON.parse(query.mock.calls[call][1][0]);

describe('recordAudit', () => {
  it('lists every action of the spec', () => {
    expect(AUDIT_ACTIONS).toEqual([
      'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
      'mailbox.enabled', 'mailbox.disabled', 'mailbox.threading_changed', 'mailbox.password_restored',
      'mailbox.quota_changed', 'mailbox.rate_limit_changed', 'mailbox.deletion_requested', 'mailbox.deletion_cancelled',
      'message.sent', 'message.deleted', 'message.move_reverted',
      'message.send_queued', 'message.send_cancelled', 'message.send_rescheduled', 'message.send_failed',
      'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
      'access.sync_aborted',
      'mail_node.config_changed', 'mail_node.domain_added', 'mail_node.domain_adopted', 'mail_node.domain_state_changed',
      'mail_node.domain_identity_acknowledged', 'mail_node.applied', 'mail_node.dns_checked',
      'mail_node.queue_action', 'mail_node.alert_raised', 'mail_node.alert_cleared',
      'mail_node.quarantine_released', 'mail_node.quarantine_deleted', 'mail_node.quarantine_learned_spam',
      'mail_node.quarantine_settings_applied',
      'mail_node.outage_opened', 'mail_node.outage_closed', 'mail_node.outage_added', 'mail_node.outage_changed',
      'mail_node.outage_deleted',
      'tenant.connection_tested', 'tenant.recipients_synced', 'tenant.connector_reference_taken',
    ]);
  });

  it('writes a batch in one statement and lets the database resolve both emails', async () => {
    query.mockResolvedValue({ rowCount: 2 });
    await recordAudit([
      { actorUserId: 'u1', accountId: 'a1', action: 'message.deleted', details: { messageId: '<m1@example.com>', folder: 'INBOX', from: 'x@example.com', permanent: false } },
      { actorUserId: 'u1', accountEmail: 'gone@example.com', action: 'mailbox.deleted' },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO mailbox_audit_log \(actor_user_id, actor_email, account_id, account_email, action, details\)/);
    expect(sql).toMatch(/COALESCE\(NULLIF\(u\.email, ''\), u\.username, e\.actor_email\)/);
    expect(sql).toMatch(/COALESCE\(a\.email_address, e\.account_email\)/);
    expect(sql).toMatch(/LEFT JOIN users u ON u\.id = e\.actor_user_id/);
    expect(sql).toMatch(/LEFT JOIN email_accounts a ON a\.id = e\.account_id/);
    expect(insertedRows()).toEqual([
      { actor_user_id: 'u1', actor_email: null, account_id: 'a1', account_email: null, action: 'message.deleted', details: { messageId: '<m1@example.com>', folder: 'INBOX', from: 'x@example.com', permanent: false } },
      { actor_user_id: 'u1', actor_email: null, account_id: null, account_email: 'gone@example.com', action: 'mailbox.deleted', details: {} },
    ]);
  });

  it('accepts a single entry', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await recordAudit({ actorUserId: 'u1', accountId: 'a1', action: 'mailbox.disabled' });
    expect(insertedRows()).toEqual([
      { actor_user_id: 'u1', actor_email: null, account_id: 'a1', account_email: null, action: 'mailbox.disabled', details: {} },
    ]);
  });

  it('names an actor that is not a user', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await recordAudit({
      actorEmail: 'Cloudflare Access', action: 'access.sync_aborted',
      details: { candidates: ['a@example.com'], activeUsers: 1, maxDisables: 10 },
    });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/AS e\(actor_user_id uuid, actor_email text, account_id uuid, account_email text, action text, details jsonb\)/);
    expect(insertedRows()).toEqual([{
      actor_user_id: null, actor_email: 'Cloudflare Access', account_id: null, account_email: null,
      action: 'access.sync_aborted', details: { candidates: ['a@example.com'], activeUsers: 1, maxDisables: 10 },
    }]);
  });

  it('writes nothing for an empty batch and drops unknown actions', async () => {
    await recordAudit([]);
    await recordAudit({ actorUserId: 'u1', action: 'message.read' });
    expect(query).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[audit] Unknown action:', 'message.read');
  });

  it('splits a large batch into statements of at most 1000 rows', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    const entries = Array.from({ length: 2500 }, (_, i) => ({ actorUserId: 'u1', accountId: 'a1', action: 'message.deleted', details: { messageId: `<${i}@example.com>` } }));
    await recordAudit(entries);
    expect(query.mock.calls.map((_, i) => insertedRows(i).length)).toEqual([1000, 1000, 500]);
  });

  it('never rejects and logs only the error code when the insert fails', async () => {
    query.mockRejectedValue(Object.assign(new Error('insert failed for secret@example.com'), { code: '23503' }));
    await expect(recordAudit({ actorUserId: 'u1', action: 'message.sent', details: { to: ['secret@example.com'] } }))
      .resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[audit] Failed to record entries:', '23503');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret@example.com');
  });

  it('survives a query that throws synchronously or resolves to nothing', async () => {
    query.mockImplementationOnce(() => { throw new TypeError('not a function'); });
    await expect(recordAudit({ action: 'mailbox.deleted' })).resolves.toBeUndefined();
    query.mockReturnValueOnce(undefined);
    await expect(recordAudit({ action: 'mailbox.deleted' })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[audit] Failed to record entries:', 'TypeError');
  });
});
