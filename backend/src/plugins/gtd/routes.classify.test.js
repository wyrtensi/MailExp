import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// POST + DELETE /api/gtd/classify end-to-end — the apply-label (COPY) and remove-label
// contracts the pure classifyTarget test can't reach: ownership scoping, the already-in-folder
// short-circuit, the message-copy resolution (acted row vs. Message-ID sibling), and IMAP-failure
// status mapping. db + imapManager are stubbed; getGtdConfig is mocked to a fixed enabled config
// (so no gtd_enabled query / config cache to manage); requireAuth is a passthrough injecting a
// session. Mirrors gtd.done.test.js's express harness.
vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('./gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getGtdConfig: vi.fn() };
});

import express from 'express';
import { query } from '../../services/db.js';
import { setMailEngine } from '../mailEngine.js';
import { getGtdConfig, DEFAULT_GTD_FOLDERS } from './gtdConfig.js';
import gtdRoutes from './routes.js';

// The label/broadcast capabilities the routes use are bound (via plugin-api) to the platform's
// mail engine. Inject a mock engine instead of the real imapManager; the same object is asserted
// on below (its copyMessage/removeMessageCopy/broadcast are what the label capabilities call).
const imapManager = {
  ensureFolder: vi.fn(),
  copyMessage: vi.fn(),
  removeMessageCopy: vi.fn(),
  broadcast: vi.fn(),
  hasMessageCopy: vi.fn(),
  isLabelStore: vi.fn(),
  moveMessage: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
};
setMailEngine(imapManager);

const MSG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// state 'todo' → folder 'Todo' under the defaults. An INBOX-resident message is the common
// case: its folder differs from the label folder, so classify COPIES into 'Todo' and unclassify
// resolves the label copy through the shared RFC Message-ID.
const inboxMsg = {
  id: MSG_ID,
  account_id: ACCT_ID,
  uid: 10,
  folder: 'INBOX',
  message_id: '<m@x>',
  thread_key: 'thread-1',
  is_read: false,
};
const account = { id: ACCT_ID, user_id: 'u1', folder_mappings: {} };

// Route every query classify issues: the ownership-scoped message load, the account fetch
// (POST copy path), and resolveCopyUid's sibling lookup (DELETE). Each is individually swappable
// so a test can drive the not-owned (msg:null) / no-sibling (sibling:null) branches. `copies` are
// the message's rows as [folder, uid] pairs, for DELETE's only-copy check; by default an INBOX
// copy keeps the message. `moveWrite` is the rowCount of a move's DB repoint.
function stubQueries({ msg = inboxMsg, acct = account, sibling = null, exact = { uid: 77 }, copies = [['INBOX', 10]], moveWrite = { rowCount: 1 } } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT folder, uid FROM messages')) return { rows: copies.map(([folder, uid]) => ({ folder, uid })) };
    if (sql.includes("special_use = '\\Trash'")) return { rows: [{ path: 'Trash' }] };
    if (sql.startsWith('UPDATE messages SET folder')) return moveWrite;
    if (sql.startsWith('SELECT m.* FROM messages m WHERE m.id')) return { rows: msg ? [msg] : [] };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: acct ? [acct] : [] };
    if (sql.includes('thread_key = $4') || sql.includes('message_id = $4')) return { rows: exact ? [exact] : [] };
    if (sql.startsWith('SELECT uid FROM messages')) return { rows: sibling ? [sibling] : [] };
    return { rows: [] };
  });
}

// A letter whose DB-first move is pending holds a placeholder uid (services/moveQueue.js).
const pendingMsg = { ...inboxMsg, uid: -8 };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gtd', gtdRoutes);
  return app;
}

const classify = (body) => fetch(`${base}/api/gtd/classify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const unclassify = (body) => fetch(`${base}/api/gtd/classify`, {
  method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const undoClassify = (body) => fetch(`${base}/api/gtd/classify/undo`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  Object.values(imapManager).forEach(fn => fn.mockReset());
  getGtdConfig.mockReset();
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_GTD_FOLDERS });
  imapManager.copyMessage.mockResolvedValue(77);
  // By default the server confirms a surviving copy, and the account is not Gmail.
  imapManager.hasMessageCopy.mockResolvedValue(true);
  imapManager.isLabelStore.mockReturnValue(false);
  imapManager.moveMessage.mockResolvedValue(300);
  stubQueries();
});

describe('POST /api/gtd/classify — request validation', () => {
  it('rejects a missing messageId/state with 400 before any lookup', async () => {
    const res = await classify({ state: 'todo' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/messageId and state are required/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID messageId with 400 before any lookup', async () => {
    const res = await classify({ messageId: 'not-a-uuid', state: 'todo' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid message id/i);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/gtd/classify — apply a GTD label (COPY)', () => {
  it('copies an INBOX message and returns an exact undo token for UIDPLUS', async () => {
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      folder: 'Todo',
      applied: true,
      undoToken: { messageId: MSG_ID, state: 'todo', folder: 'Todo', uid: 77 },
    });
    // Callers own folder existence, so classify ensures then copies — the message stays in INBOX.
    expect(imapManager.ensureFolder).toHaveBeenCalledWith(account, 'Todo');
    expect(imapManager.copyMessage).toHaveBeenCalledWith(ACCT_ID, 10, 'INBOX', 'Todo');
  });

  it('succeeds without advertising an unsafe inverse for non-UIDPLUS', async () => {
    imapManager.copyMessage.mockResolvedValueOnce(null);
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(await res.json()).toEqual({
      ok: true, folder: 'Todo', applied: true, undoToken: null,
    });
  });

  it('succeeds without advertising an unverifiable inverse when Message-ID is absent', async () => {
    stubQueries({ msg: { ...inboxMsg, message_id: null } });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(await res.json()).toEqual({
      ok: true, folder: 'Todo', applied: true, undoToken: null,
    });
  });

  it('short-circuits when the message already lives in the state folder (no IMAP work)', async () => {
    stubQueries({ msg: { ...inboxMsg, folder: 'Todo' } });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, folder: 'Todo', applied: false, undoToken: null,
    });
    expect(imapManager.ensureFolder).not.toHaveBeenCalled();
    expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

  it('short-circuits when a sibling already carries the state label', async () => {
    stubQueries({ sibling: { uid: 42 } });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(await res.json()).toEqual({
      ok: true, folder: 'Todo', applied: false, undoToken: null,
    });
    expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

  it('404s a message that does not exist', async () => {
    stubQueries({ msg: null });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
    expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

  it('maps an IMAP copy failure to 500', async () => {
    imapManager.copyMessage.mockRejectedValue(new Error('IMAP COPY failed'));
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed to apply gtd label/i);
  });
});

describe('DELETE /api/gtd/classify — remove a GTD label', () => {
  it('removes the sibling copy in the state folder and returns removed:true', async () => {
    stubQueries({ sibling: { uid: 42 } });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo' });
    // resolveCopyUid found the state-folder copy (uid 42) via the shared Message-ID join.
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 42, 'Todo');
  });

  it('returns removed:false when no copy exists in the state folder (nothing to delete)', async () => {
    stubQueries({ sibling: null });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('400s a missing Message-ID ONLY when the acted row is in a different folder than the state folder', async () => {
    stubQueries({ msg: { ...inboxMsg, message_id: null } }); // INBOX ≠ Todo and no Message-ID → sibling unresolvable
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no Message-ID/i);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('does NOT require a Message-ID when the acted row already lives in the state folder', async () => {
    // The acted-row case resolves its own uid directly, so a null Message-ID must not 400 here.
    // Pins the recently-narrowed guard (folder !== stateFolder) against a regression back to an
    // unconditional Message-ID requirement. Without one its other copies cannot be found, so the
    // copy is kept: it moves to INBOX instead of being deleted.
    stubQueries({ msg: { ...inboxMsg, folder: 'Todo', message_id: null } });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo', movedToInbox: true });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Todo', 'INBOX');
  });

  it("404s a message the caller doesn't own", async () => {
    stubQueries({ msg: null });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(404);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('maps an IMAP delete failure to 500', async () => {
    stubQueries({ sibling: { uid: 42 } });
    imapManager.removeMessageCopy.mockRejectedValue(new Error('IMAP delete failed'));
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed to remove gtd label/i);
  });
});

describe('POST /api/gtd/classify/undo — remove only the request-owned copy', () => {
  const token = { messageId: MSG_ID, state: 'todo', folder: 'Todo', uid: 77 };

  it('removes the exact copy identified by the classify response', async () => {
    const res = await undoClassify(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo' });
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 77, 'Todo');
  });

  it('is replay-safe when the exact copy no longer exists', async () => {
    stubQueries({ exact: null });
    const res = await undoClassify(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false, folder: 'Todo' });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, '77', null])('rejects malformed uid %j before lookup', async (uid) => {
    const res = await undoClassify({ ...token, uid });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a token after the state folder configuration changes', async () => {
    getGtdConfig.mockResolvedValueOnce({
      enabled: true,
      folders: { ...DEFAULT_GTD_FOLDERS, todo: 'Next Actions' },
    });
    const res = await undoClassify(token);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/folder changed/i);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('does not remove a UID that belongs to another message', async () => {
    stubQueries({ exact: null });
    const res = await undoClassify(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false, folder: 'Todo' });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });
});

describe('GTD classify of a letter whose move is pending', () => {
  it('answers 409 move_pending and copies nothing', async () => {
    stubQueries({ msg: pendingMsg });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('move_pending');
    expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

  it('answers 409 move_pending when the label copy to remove is pending', async () => {
    stubQueries({ sibling: { uid: '-3' } });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('move_pending');
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });
});

// A GTD folder can hold a message's only copy: mail the user filed there by moving it (upstream
// #524). Removing the label must not delete it; the copy moves back to INBOX instead.
describe('DELETE /api/gtd/classify — a GTD folder holding the only copy', () => {
  const todoMsg = { ...inboxMsg, folder: 'Todo' };

  it('moves the copy to INBOX instead of deleting it', async () => {
    stubQueries({ msg: todoMsg, copies: [['Todo', 10]] });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo', movedToInbox: true });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Todo', 'INBOX');
    const write = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE messages SET folder'));
    expect(write[1]).toEqual(['INBOX', 300, MSG_ID, 'Todo']);
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'folder_updated', folder: 'INBOX', accountId: ACCT_ID });
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: ACCT_ID });
  });

  it('does not count a copy in Trash, which gets emptied', async () => {
    stubQueries({ msg: todoMsg, copies: [['Todo', 10], ['Trash', 3]] });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Todo', 'INBOX');
  });

  it('removes the label when another GTD label still keeps the message', async () => {
    stubQueries({ msg: todoMsg, copies: [['Todo', 10], ['Watch', 41]] });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo' });
    expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(account, 41, 'Watch', '<m@x>', { background: false });
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 10, 'Todo');
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  // A row can outlive its message for a while after another client moves it.
  it('keeps the copy when the server does not confirm the other copy', async () => {
    stubQueries({ msg: todoMsg, copies: [['Todo', 10], ['INBOX', 55]] });
    imapManager.hasMessageCopy.mockResolvedValue(false);
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(account, 55, 'INBOX', '<m@x>', { background: false });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Todo', 'INBOX');
  });

  it('keeps the copy when the confirmation fails', async () => {
    stubQueries({ msg: todoMsg, copies: [['Todo', 10], ['INBOX', 55]] });
    imapManager.hasMessageCopy.mockRejectedValue(new Error('connection refused'));
    await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Todo', 'INBOX');
  });

  // Gmail: removing a GTD label leaves the message in All Mail.
  it('removes the label on Gmail even when it holds the only synced copy', async () => {
    stubQueries({ msg: todoMsg, copies: [['Todo', 10]] });
    imapManager.isLabelStore.mockReturnValue(true);
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 10, 'Todo');
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect(imapManager.hasMessageCopy).not.toHaveBeenCalled();
  });

  it('refuses with 409 only_copy when the acted row is elsewhere and the state copy is the only one kept', async () => {
    stubQueries({ msg: { ...inboxMsg, folder: 'Trash' }, sibling: { uid: 42 }, copies: [['Trash', 10], ['Todo', 42]] });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'only_copy' });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  it('maps a failed move to 500 and deletes nothing', async () => {
    stubQueries({ msg: todoMsg, copies: [['Todo', 10]] });
    imapManager.moveMessage.mockRejectedValue(new Error('IMAP move failed'));
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(500);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('answers 409 move_pending when the only copy is waiting for its move', async () => {
    stubQueries({ msg: { ...todoMsg, uid: -8 }, copies: [['Todo', -8]] });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('move_pending');
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });
});
