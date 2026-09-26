import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A full IMAP pool fails an operation with poolExhausted (upstream #474), and a login held back
// by a rejected password fails it with providerRefusing. Neither is a broken server and nothing
// was sent, so the routes that still talk to the server first (permanent delete, snooze, folder
// changes, attachments) answer 503 { code: 'mailbox_busy' }, which the client shows as "the
// mailbox is busy, try again". Moves (move, archive, delete to Trash, spam/not spam) are DB-first
// (services/moveQueue.js): they never wait for the server and never answer busy.
vi.mock('../services/db.js', () => {
  const query = vi.fn();
  return { query };
});
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    moveMessage: vi.fn(),
    permanentDeleteMessage: vi.fn(),
    bulkMoveMessages: vi.fn(),
    bulkPermanentDelete: vi.fn(),
    fetchAttachment: vi.fn(),
    fetchMultipleAttachments: vi.fn(),
    ensureFolder: vi.fn(),
    deleteFolder: vi.fn(),
    renameFolder: vi.fn(),
    emptyFolder: vi.fn(),
    syncFolderOnDemand: vi.fn(async () => {}),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    _scheduleProviderIdBackfill: vi.fn(),
    scheduleCountRefresh: vi.fn(),
    moveQueue: {
      // Every row moves in the database; the MOVE is queued for the worker.
      enqueue: vi.fn(async (_accountId, rows) => rows.map(r => ({ id: r.id, from: r.folder, isRead: !!r.is_read }))),
      serverLocation: async (m) => ({ folder: m.folder, uid: Number(m.uid) }),
      holdFolder: vi.fn(() => () => {}),
      reguardAccount: vi.fn(async () => {}),
    },
  },
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []) } }));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveTrashFolder: vi.fn(async () => 'Trash'),
  resolveAllTrashPaths: vi.fn(async () => new Set(['Trash'])),
  resolveAllDraftsPaths: vi.fn(async () => new Set(['Drafts'])),
  resolveSpamFolder: vi.fn(async () => 'Junk'),
  resolveArchiveFolder: vi.fn(async () => 'Archive'),
  isAllMailFolder: vi.fn(async () => false),
  adjustFolderCounts: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const INBOX_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const TRASH_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const SENT_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const MSG = (id, folder, uid) => ({
  id, account_id: ACCOUNT_ID, uid, folder, is_read: true, message_id: `<${uid}@example.com>`,
  subject: 'Board minutes', from_email: 'sender@example.com', folder_mappings: null,
  attachments: [{ part: '2', filename: 'minutes.pdf', size: 10, type: 'application/pdf' }],
});
const rows = { [INBOX_ID]: MSG(INBOX_ID, 'INBOX', 11), [TRASH_ID]: MSG(TRASH_ID, 'Trash', 22), [SENT_ID]: MSG(SENT_ID, 'Sent', 33) };
// A letter in the Trash of a second mailbox, for bulk requests that span two.
const OTHER_ACCOUNT_ID = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
const OTHER_ID = 'f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6';
rows[OTHER_ID] = { ...MSG(OTHER_ID, 'Trash', 44), account_id: OTHER_ACCOUNT_ID };
// A letter whose own move into Trash has not reached the server yet (placeholder uid -7).
const PENDING_ID = 'a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7';
rows[PENDING_ID] = MSG(PENDING_ID, 'Trash', -7);
const poolBusy = () => Object.assign(new Error('IMAP pool busy, please retry'), { poolExhausted: true });
// A rejected password holds the mailbox's logins back and no pooled session is open: the pool
// fails at once with providerRefusing instead of logging in (imapManager's loginHeldBack).
const loginHeld = () => Object.assign(new Error('Mail server is not accepting new connections for this account right now'), { providerRefusing: true });
// The same hold when the reason is a rejected password (authRejected): retrying will not help, so
// the answer says so with its own code.
const authHeld = () => Object.assign(loginHeld(), { authRejected: true });

let server;
let base;
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
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  query.mockReset().mockImplementation(async (sql, params) => {
    if (/FROM messages m[\s\S]*WHERE m\.id = \$1/.test(sql)) return { rows: rows[params[0]] ? [rows[params[0]]] : [] };
    if (/FROM messages m[\s\S]*m\.id = ANY/.test(sql)) return { rows: params[0].map((id) => rows[id]).filter(Boolean) };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: [{ id: params[0], folder_mappings: null }] };
    if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
    // A permanent delete claims its rows, then removes the ones the server deleted (expungeClaimed).
    if (sql.includes('SET expunge_claim = $1')) return { rows: params[1].map((id) => rows[id]).filter(Boolean) };
    if (sql.includes('DELETE FROM messages m') && sql.includes('expunge_claim = $1')) return { rows: params[1].map((id) => rows[id]) };
    return { rows: [], rowCount: 0 };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

// A delete names the folder the client listed each letter in (deleteIntent): these letters were
// seen where they are, so the ones in Trash are deleted forever.
const deleteOne = (id) => call('DELETE', `/messages/${id}`, { folder: rows[id].folder });
const bulkDelete = (ids) => call('POST', '/messages/bulk-delete', { ids, folders: Object.fromEntries(ids.map(id => [id, rows[id].folder])) });

const call = async (method, path, body) => {
  const res = await fetch(`${base}/api/mail${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

describe('a move never answers busy: it changes the database and queues the server MOVE', () => {
  beforeEach(() => {
    // Every IMAP call would find the mailbox busy; a move makes none.
    imapManager.moveMessage.mockRejectedValue(poolBusy());
    imapManager.bulkMoveMessages.mockRejectedValue(poolBusy());
  });

  it('on delete (move to Trash)', async () => {
    const res = await call('DELETE', `/messages/${INBOX_ID}`);
    expect(res.status).toBe(200);
    expect(imapManager.moveQueue.enqueue).toHaveBeenCalledWith(ACCOUNT_ID, [expect.objectContaining({ id: INBOX_ID })], 'Trash', { dropRow: false, movedBy: 'u1' });
  });

  it('on bulk move, bulk delete to Trash and bulk archive', async () => {
    const moved = await call('POST', '/messages/bulk-move', { ids: [INBOX_ID, SENT_ID], folder: 'Archive' });
    expect(moved).toEqual({ status: 200, body: { ok: true, moved: [INBOX_ID, SENT_ID] } });
    const deleted = await call('POST', '/messages/bulk-delete', { ids: [INBOX_ID] });
    expect(deleted).toEqual({ status: 200, body: { ok: true, deleted: [INBOX_ID] } });
    const archived = await call('POST', '/messages/bulk-archive', { ids: [INBOX_ID] });
    expect(archived).toEqual({ status: 200, body: { ok: true, archived: [INBOX_ID], noArchiveFolder: [] } });
  });

  it('on mark as spam', async () => {
    const res = await call('POST', `/messages/${INBOX_ID}/spam`);
    expect(res.status).toBe(200);
    expect(res.body.folder).toBe('Junk');
    expect(imapManager.moveQueue.enqueue).toHaveBeenCalledWith(ACCOUNT_ID, [expect.objectContaining({ id: INBOX_ID })], 'Junk', { dropRow: false, movedBy: 'u1' });
  });

  afterEach(() => {
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect(imapManager.bulkMoveMessages).not.toHaveBeenCalled();
  });
});

for (const [what, busy, code] of [
  ['a full pool', poolBusy, 'mailbox_busy'],
  ['a login held back', loginHeld, 'mailbox_busy'],
  ['a rejected password', authHeld, 'mailbox_auth_rejected'],
]) describe(`a busy mailbox answers 503 ${code} where the server comes first: ${what}`, () => {
  const expectBusy = ({ status, body }) => {
    expect(status).toBe(503);
    expect(body.code).toBe(code);
  };

  it('on delete of a message already in Trash', async () => {
    imapManager.permanentDeleteMessage.mockRejectedValue(busy());
    expectBusy(await deleteOne(TRASH_ID));
  });

  it('on bulk delete of messages already in Trash', async () => {
    imapManager.bulkPermanentDelete.mockRejectedValue(busy());
    expectBusy(await bulkDelete([TRASH_ID]));
  });

  it('commits the moves to Trash when the permanent delete of the same request finds the pool busy', async () => {
    // INBOX goes to Trash in the database (queued); the letter already in Trash finds the pool
    // busy. The move must be written, counted and journaled, and the response must name it, or the
    // UI restores a letter the panel already shows in Trash.
    imapManager.bulkPermanentDelete.mockRejectedValue(busy());
    const res = await bulkDelete([INBOX_ID, TRASH_ID]);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([INBOX_ID]);
    expect(res.body.busy).toBe(true);
    expect(res.body.code).toBe(code);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM messages'))).toBe(false);
    const audit = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'));
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0][1][0]).map(e => e.details.messageId)).toEqual(['<11@example.com>']);
  });

  it('on an attachment download and the ZIP of all attachments', async () => {
    imapManager.fetchAttachment.mockRejectedValue(busy());
    imapManager.fetchMultipleAttachments.mockRejectedValue(busy());
    expectBusy(await call('GET', `/messages/${INBOX_ID}/attachments/2`));
    expectBusy(await call('GET', `/messages/${INBOX_ID}/attachments.zip`));
  });

  it('on creating, renaming and deleting a folder', async () => {
    imapManager.ensureFolder.mockRejectedValue(busy());
    imapManager.renameFolder.mockRejectedValue(busy());
    imapManager.deleteFolder.mockRejectedValue(busy());
    expectBusy(await call('POST', '/folders', { accountId: ACCOUNT_ID, name: 'Projects' }));
    expectBusy(await call('POST', '/folders/rename', { accountId: ACCOUNT_ID, oldPath: 'Projects', newName: 'Clients' }));
    expectBusy(await call('POST', '/folders/delete', { accountId: ACCOUNT_ID, path: 'Projects' }));
  });

  it('on emptying a folder, over the folder_emptied event (the request already answered 202)', async () => {
    imapManager.emptyFolder.mockRejectedValue(busy());
    const res = await call('POST', '/folders/empty', { accountId: ACCOUNT_ID, path: 'Trash' });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'folder_emptied', ok: false, code })));
  });

  it('keeps other failures as they were', async () => {
    imapManager.permanentDeleteMessage.mockRejectedValue(new Error('Mailbox does not exist'));
    const res = await deleteOne(TRASH_ID);
    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
    imapManager.emptyFolder.mockRejectedValue(new Error('Mailbox does not exist'));
    await call('POST', '/folders/empty', { accountId: ACCOUNT_ID, path: 'Junk' });
    await vi.waitFor(() => expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'folder_emptied', ok: false })));
    const emptied = imapManager.broadcast.mock.calls.find(([e]) => e.type === 'folder_emptied')[0];
    expect(emptied.code).toBeUndefined();
  });
});

describe('a bulk request over two mailboxes names the reason both share', () => {
  // One code speaks for the whole request: mailbox_auth_rejected only when every busy mailbox had
  // its password rejected. Mixed with a mailbox that is merely busy, the answer is mailbox_busy.
  const failByAccount = (byAccount) => imapManager.bulkPermanentDelete.mockImplementation(async (account, uids) => {
    if (byAccount[account.id]) throw byAccount[account.id]();
    return { succeeded: uids, failed: [] };
  });

  it('says busy when one mailbox is busy and the other rejects the password', async () => {
    failByAccount({ [ACCOUNT_ID]: poolBusy, [OTHER_ACCOUNT_ID]: authHeld });
    const res = await bulkDelete([TRASH_ID, OTHER_ID]);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('mailbox_busy');
  });

  it('says the password was rejected when that holds back every busy mailbox', async () => {
    failByAccount({ [ACCOUNT_ID]: authHeld, [OTHER_ACCOUNT_ID]: authHeld });
    const res = await bulkDelete([TRASH_ID, OTHER_ID]);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('mailbox_auth_rejected');
  });

  it('keeps the rejected-password code on a partial success where only that mailbox failed', async () => {
    failByAccount({ [OTHER_ACCOUNT_ID]: authHeld });
    const res = await bulkDelete([TRASH_ID, OTHER_ID]);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([TRASH_ID]);
    expect(res.body.code).toBe('mailbox_auth_rejected');
  });
});

describe('a letter whose move has not reached the server', () => {
  it('cannot be deleted permanently yet: 409 move_pending, nothing sent', async () => {
    const res = await deleteOne(PENDING_ID);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('move_pending');
    const bulk = await bulkDelete([PENDING_ID]);
    expect(bulk.status).toBe(409);
    expect(bulk.body.code).toBe('move_pending');
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(imapManager.bulkPermanentDelete).not.toHaveBeenCalled();
  });

  it('names move_pending for the rest of a bulk delete that went through otherwise', async () => {
    imapManager.bulkPermanentDelete.mockImplementation(async (_account, uids) => ({ succeeded: uids, failed: [] }));
    const res = await bulkDelete([TRASH_ID, PENDING_ID]);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([TRASH_ID]);
    expect(res.body.code).toBe('move_pending');
    expect(imapManager.bulkPermanentDelete).toHaveBeenCalledWith(expect.anything(), [22], 'Trash');
  });

  it('cannot be snoozed yet', async () => {
    const res = await call('POST', `/messages/${PENDING_ID}/snooze`, { until: new Date(Date.now() + 86400000).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('move_pending');
  });
});
