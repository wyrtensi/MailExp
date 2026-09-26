import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => {
  const query = vi.fn();
  return { query };
});
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    moveMessage: vi.fn(async () => 900),
    permanentDeleteMessage: vi.fn(async () => {}),
    bulkMoveMessages: vi.fn(),
    bulkPermanentDelete: vi.fn(),
    syncFolderOnDemand: vi.fn(async () => {}),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    _scheduleProviderIdBackfill: vi.fn(),
    scheduleCountRefresh: vi.fn(),
    // Moves to Trash are DB-first: the row moves now and the MOVE is queued (moveQueue.js).
    moveQueue: { enqueue: vi.fn(async (_accountId, rows) => rows.map(r => ({ id: r.id, from: r.folder, isRead: !!r.is_read }))) },
  },
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []) } }));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveTrashFolder: vi.fn(async () => 'Trash'),
  resolveAllTrashPaths: vi.fn(async () => new Set(['Trash'])),
  resolveAllDraftsPaths: vi.fn(async () => new Set(['Drafts'])),
  adjustFolderCounts: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const MSG = (id, folder, uid) => ({
  id, account_id: ACCOUNT_ID, uid, folder, is_read: true, message_id: `<${uid}@example.com>`,
  subject: 'Board minutes', from_name: 'Sender', from_email: 'sender@example.com', folder_mappings: null,
});
const INBOX_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const TRASH_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const DRAFT_ID = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
const rows = { [INBOX_ID]: MSG(INBOX_ID, 'INBOX', 11), [TRASH_ID]: MSG(TRASH_ID, 'Trash', 22), [DRAFT_ID]: MSG(DRAFT_ID, 'Drafts', 33) };

let server;
let base;
let errorSpy;
let failJournal;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  failJournal = false;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  query.mockReset().mockImplementation(async (sql, params) => {
    if (sql.includes('INSERT INTO mailbox_audit_log')) {
      if (failJournal) throw Object.assign(new Error('journal down'), { code: '57P01' });
      return { rowCount: 1 };
    }
    if (/FROM messages m\s+WHERE m\.id = \$1/.test(sql)) return { rows: rows[params[0]] ? [rows[params[0]]] : [] };
    if (/FROM messages m\s+JOIN email_accounts a/.test(sql)) return { rows: params[0].map((id) => rows[id]) };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: [{ id: ACCOUNT_ID, folder_mappings: null }] };
    // A permanent delete claims its rows, then removes the ones the server deleted (expungeClaimed).
    if (sql.includes('SET expunge_claim = $1')) return { rows: params[1].map((id) => rows[id]).filter(Boolean) };
    if (sql.includes('DELETE FROM messages m') && sql.includes('expunge_claim = $1')) return { rows: params[1].map((id) => rows[id]) };
    return { rows: [] };
  });
});
afterEach(() => { errorSpy.mockRestore(); });

const journaled = () => query.mock.calls
  .filter(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'))
  .flatMap(([, [payload]]) => JSON.parse(payload));
const deleted = (messageId, folder, permanent) => ({
  actor_user_id: 'u1', actor_email: null, account_id: ACCOUNT_ID, account_email: null, action: 'message.deleted',
  details: { messageId, folder, from: 'sender@example.com', permanent },
});

// The client names the folder it listed the letter in; only one seen in Trash is deleted forever.
const del = (id) => fetch(`${base}/api/mail/messages/${id}`, {
  method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: rows[id].folder }),
});

describe('deleting messages is journaled', () => {
  it('records a move to Trash, a delete from Trash and a draft delete without the subject', async () => {
    for (const id of [INBOX_ID, TRASH_ID, DRAFT_ID]) {
      expect((await del(id)).status).toBe(200);
    }
    await vi.waitFor(() => expect(journaled()).toHaveLength(3));
    expect(journaled()).toEqual([
      deleted('<11@example.com>', 'INBOX', false),
      deleted('<22@example.com>', 'Trash', true),
      deleted('<33@example.com>', 'Drafts', true),
    ]);
    expect(JSON.stringify(journaled())).not.toContain('Board minutes');
  });

  it('records nothing when the server refuses a permanent delete', async () => {
    imapManager.permanentDeleteMessage.mockRejectedValueOnce(new Error('NO'));
    expect((await del(TRASH_ID)).status).toBe(500);
    expect(journaled()).toEqual([]);
  });

  it('records one entry per message that bulk delete removed', async () => {
    imapManager.bulkPermanentDelete.mockResolvedValue({ succeeded: [22], failed: [] });
    const res = await fetch(`${base}/api/mail/messages/bulk-delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [INBOX_ID, TRASH_ID], folders: { [INBOX_ID]: 'INBOX', [TRASH_ID]: 'Trash' } }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(journaled()).toHaveLength(2));
    expect(journaled()).toEqual([
      deleted('<22@example.com>', 'Trash', true),
      deleted('<11@example.com>', 'INBOX', false),
    ]);
  });

  it('skips messages the server failed to delete and keeps the delete successful when the journal fails', async () => {
    failJournal = true;
    imapManager.bulkPermanentDelete.mockResolvedValue({ succeeded: [], failed: [22] });
    const res = await fetch(`${base}/api/mail/messages/bulk-delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [INBOX_ID, TRASH_ID], folders: { [INBOX_ID]: 'INBOX', [TRASH_ID]: 'Trash' } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toEqual([INBOX_ID]);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('[audit] Failed to record entries:', '57P01'));
    expect(JSON.parse(query.mock.calls.find(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'))[1][0]))
      .toEqual([deleted('<11@example.com>', 'INBOX', false)]);
  });
});
