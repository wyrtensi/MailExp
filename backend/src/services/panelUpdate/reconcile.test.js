import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReconciler, startUpdateAuditReconciler } from './reconcile.js';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ADMIN = '99999999-9999-4999-8999-999999999999';

const result = (over = {}) => ({
  id: ID1, action: 'update', target: 'sha-0123456789ab', state: 'updating', terminal: false, from: 'sha-aaaaaaaaaaaa',
  receivedAt: '2026-10-05T11:50:00.000Z', updatedAt: '2026-10-05T11:59:00.000Z', exitCode: null, ...over,
});
const requested = (id = ID1) => ({ action: 'panel.update_requested', request_id: id, actor_user_id: ADMIN, actor_email: 'admin@example.com' });
const recorded = (action, id = ID1) => ({ action, request_id: id, actor_user_id: ADMIN, actor_email: 'admin@example.com' });

function setup(results, rows) {
  const spool = { readResults: vi.fn(async () => results) };
  const query = vi.fn(async () => ({ rows }));
  const recordAudit = vi.fn(async () => {});
  return { spool, query, recordAudit, reconcile: createReconciler({ getSpool: () => spool, query, recordAudit }) };
}

let errorSpy;
beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errorSpy.mockRestore(); });

describe('update audit reconciler', () => {
  it('hands every pass the update results for the node update; its failure does not stop the journal', async () => {
    const spool = { readResults: vi.fn(async () => [result({ state: 'succeeded', terminal: true, exitCode: 0 })]) };
    const recordAudit = vi.fn(async () => {});
    const afterResults = vi.fn(async () => { throw new Error('db down'); });
    const reconcile = createReconciler({ getSpool: () => spool, query: vi.fn(async () => ({ rows: [requested()] })), recordAudit, afterResults });
    await reconcile();
    expect(afterResults).toHaveBeenCalledWith([expect.objectContaining({ id: ID1, state: 'succeeded' })]);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it('records the start of an update under the admin who asked for it', async () => {
    const { query, recordAudit, reconcile } = setup([result()], [requested()]);
    await reconcile();

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM mailbox_audit_log/);
    expect(sql).toMatch(/details->>'requestId' = ANY\(\$2/);
    expect(params[0]).toEqual(['panel.update_requested', 'panel.update_started', 'panel.update_finished', 'panel.update_failed']);
    expect(params[1]).toEqual([ID1]);
    expect(recordAudit).toHaveBeenCalledWith([{
      action: 'panel.update_started', actorUserId: ADMIN, actorEmail: 'admin@example.com',
      details: { requestId: ID1, target: 'sha-0123456789ab', from: 'sha-aaaaaaaaaaaa', state: 'updating', exitCode: null },
    }]);
  });

  it('records started and finished for a success seen only at its end', async () => {
    const { recordAudit, reconcile } = setup([result({ state: 'succeeded', terminal: true, exitCode: 0 })], [requested()]);
    await reconcile();
    expect(recordAudit.mock.calls[0][0].map((e) => [e.action, e.details.state, e.details.exitCode])).toEqual([
      ['panel.update_started', 'updating', null],
      ['panel.update_finished', 'succeeded', 0],
    ]);
  });

  it.each(['failed', 'rolled_back', 'rollback_failed'])('records started and failed for %s', async (state) => {
    const { recordAudit, reconcile } = setup([result({ state, terminal: true, exitCode: 1 })], [requested()]);
    await reconcile();
    expect(recordAudit.mock.calls[0][0].map((e) => e.action)).toEqual(['panel.update_started', 'panel.update_failed']);
  });

  it.each(['refused', 'blocked', 'error'])('records only failed for an update %s before it started', async (state) => {
    const { recordAudit, reconcile } = setup([result({ state, terminal: true })], [requested()]);
    await reconcile();
    expect(recordAudit.mock.calls[0][0].map((e) => [e.action, e.details.state])).toEqual([['panel.update_failed', state]]);
  });

  it('does not record an entry twice', async () => {
    const { recordAudit, reconcile } = setup(
      [result({ state: 'succeeded', terminal: true }), result({ id: ID2, state: 'updating' })],
      [requested(), recorded('panel.update_started'), recorded('panel.update_finished'), requested(ID2), recorded('panel.update_started', ID2)],
    );
    await reconcile();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('remembers what the journal holds and does not query again', async () => {
    const { query, reconcile } = setup([result({ state: 'succeeded', terminal: true })],
      [requested(), recorded('panel.update_started'), recorded('panel.update_finished')]);
    await reconcile();
    await reconcile();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('records with no actor when no request entry exists', async () => {
    const { recordAudit, reconcile } = setup([result()], []);
    await reconcile();
    expect(recordAudit.mock.calls[0][0][0]).toMatchObject({ actorUserId: null, actorEmail: null, action: 'panel.update_started' });
  });

  it('ignores checks, unreadable requests and requests still checking', async () => {
    const { query, recordAudit, reconcile } = setup([
      result({ action: 'check', state: 'ready', terminal: true }),
      result({ action: null, target: null, state: 'refused', terminal: true }),
      result({ state: 'checking' }),
    ], []);
    await reconcile();
    expect(query).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('runs one pass at a time', async () => {
    const { query, reconcile } = setup([result()], [requested()]);
    await Promise.all([reconcile(), reconcile()]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('never throws and logs only the error code', async () => {
    const { query, recordAudit, reconcile } = setup([result()], []);
    query.mockRejectedValueOnce(Object.assign(new Error('secret value in message'), { code: '42P01' }));
    await expect(reconcile()).resolves.toBeUndefined();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), '42P01');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret');
  });

  it('runs on an unref\'d interval', async () => {
    vi.useFakeTimers();
    try {
      const reconcile = vi.fn(async () => {});
      const stop = startUpdateAuditReconciler({ reconcile, intervalMs: 30_000 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
