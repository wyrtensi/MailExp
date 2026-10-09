import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// POST /api/gtd/done end-to-end for the archive step's two race/failure contracts (a
// concurrent /done racing the same INBOX row, and an archive move that throws) —
// behaviour the pure resolveDoneFolders tests can't reach. db + imapManager are
// stubbed; mailUtils' side-effecting helpers (archive resolution, count adjust, read fan-out)
// are mocked so the archive DB write's rowCount is the only thing under test. getGtdConfig is
// mocked to a fixed enabled config; requireAuth is a passthrough injecting a session.
vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveArchiveFolder: vi.fn(),
    isAllMailFolder: vi.fn(),
    adjustFolderCounts: vi.fn(),
    fanOutReadToSiblings: vi.fn(),
    resolveAllDraftsPaths: vi.fn(),
    resolveAllTrashPaths: vi.fn(),
    resolveAllSpamPaths: vi.fn(),
  };
});
vi.mock('./gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getGtdConfig: vi.fn() };
});

import express from 'express';
import { query } from '../../services/db.js';
import { setMailEngine } from '../mailEngine.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, fanOutReadToSiblings, resolveAllDraftsPaths, resolveAllTrashPaths, resolveAllSpamPaths } from '../../utils/mailUtils.js';
import { getGtdConfig, DEFAULT_GTD_FOLDERS } from './gtdConfig.js';

// The done route's mail actions (label strip, mark-read, archive, broadcast) go through the bound
// plugin-api capabilities; inject a mock engine, asserted on directly below.
const imapManager = {
  moveMessage: vi.fn(),
  setFlag: vi.fn(),
  removeMessageCopy: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
  broadcast: vi.fn(),
  hasMessageCopy: vi.fn(),
  isLabelStore: vi.fn(),
};
setMailEngine(imapManager);
import gtdRoutes from './routes.js';

const MSG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// The rail acts on the Watch-folder copy; a distinct INBOX sibling is what the archive step
// moves. is_read true on both keeps the mark-read path off the IMAP setFlag mock.
const msg = { id: MSG_ID, account_id: ACCT_ID, uid: 10, folder: 'Watch', message_id: '<m@x>', is_read: true };
const account = { id: ACCT_ID, user_id: 'u1', folder_mappings: {} };
const inboxCopy = { id: 'ib-1', uid: 77, is_read: true };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gtd', gtdRoutes);
  return app;
}

// Route every query /done issues; archiveWrite is the swappable rowCount of the INBOX row's
// archive UPDATE/DELETE — the authority for whether this call or a concurrent /done won the race.
// `copies` are the message's rows as [folder, uid] pairs, for the only-copy check.
function stubQueries({ row = msg, inbox = inboxCopy, archiveWrite = { rowCount: 1 }, copies = [] } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT folder, uid FROM messages')) return { rows: copies.map(([folder, uid]) => ({ folder, uid })) };
    if (sql.startsWith('SELECT m.* FROM messages m WHERE m.id')) return { rows: [row] };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
    if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: inbox ? [inbox] : [] };
    if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: 10 }] };
    if (sql.startsWith('DELETE FROM messages') || sql.startsWith('UPDATE messages SET folder')) return archiveWrite;
    return { rows: [] };
  });
}

const done = (body) => fetch(`${base}/api/gtd/done`, {
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
  [resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, fanOutReadToSiblings, getGtdConfig].forEach(fn => fn.mockReset());
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_GTD_FOLDERS });
  resolveArchiveFolder.mockResolvedValue('Archive');
  isAllMailFolder.mockResolvedValue(false);
  fanOutReadToSiblings.mockResolvedValue(undefined);
  [resolveAllDraftsPaths, resolveAllTrashPaths, resolveAllSpamPaths].forEach(fn => fn.mockReset());
  resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
  resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
  resolveAllSpamPaths.mockResolvedValue(new Set(['Junk']));
  // By default the server confirms a surviving copy, and the account is not Gmail.
  imapManager.hasMessageCopy.mockResolvedValue(true);
  imapManager.isLabelStore.mockReturnValue(false);
});

describe('POST /api/gtd/done — id validation', () => {
  it('rejects a malformed (non-UUID) id with 400 before any lookup', async () => {
    const res = await done({ id: 'not-a-uuid', states: ['watch'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid message id/i);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/gtd/done — archive count-adjust race', () => {
  it('archives + adjusts both counts when the INBOX-scoped write applied (rowCount 1)', async () => {
    stubQueries({ archiveWrite: { rowCount: 1 } });
    imapManager.moveMessage.mockResolvedValue(88); // UIDPLUS newUid
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    expect(adjustFolderCounts).toHaveBeenCalledTimes(2);
    // The terminal refresh so the rail converges post-done.
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: ACCT_ID });
  });

  it('no count drift, archived=false when a concurrent /done already moved the INBOX row (rowCount 0)', async () => {
    stubQueries({ archiveWrite: { rowCount: 0 } });
    imapManager.moveMessage.mockResolvedValue(null); // silent server-side no-op
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: false });
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });
});

describe('POST /api/gtd/done — strip-ok + archive-fail', () => {
  it('returns 200 archived=false archiveFailed=true when only the archive step throws', async () => {
    stubQueries();
    imapManager.moveMessage.mockRejectedValue(new Error('IMAP move failed'));
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true });
    expect(imapManager.removeMessageCopy).toHaveBeenCalled(); // step (b) still ran
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('releases both move guards when the non-UIDPLUS archive write throws', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT m.* FROM messages m WHERE m.id')) return { rows: [msg] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: [inboxCopy] };
      if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: 10 }] };
      if (sql.startsWith('UPDATE messages SET folder')) throw new Error('archive write failed');
      return { rows: [] };
    });
    imapManager.moveMessage.mockResolvedValue(null);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true });
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCT_ID, 'Archive', inboxCopy.uid);
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCT_ID, 'INBOX', inboxCopy.uid);
  });

  it('full success: archived=true, archiveFailed=false, noArchiveFolder=false', async () => {
    stubQueries({ archiveWrite: { rowCount: 1 } });
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false, noArchiveFolder: false });
    // The terminal refresh so the rail converges post-done.
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: ACCT_ID });
  });

  it('strip failure still 500s — the contract only softens the archive step, not the label strip', async () => {
    stubQueries();
    imapManager.removeMessageCopy.mockRejectedValue(new Error('IMAP delete failed'));
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(500);
    expect(imapManager.moveMessage).not.toHaveBeenCalled(); // never reached the archive step
  });

  it('strips the acted folder LAST, so an earlier strip failure leaves the acted row retryable', async () => {
    stubQueries();
    // msg.folder is 'Watch' (the acted head). A merged Waiting done strips watch+delegated;
    // fail the NON-acted folder's removal so the loop throws before reaching the acted copy.
    imapManager.removeMessageCopy.mockImplementation(async (_acct, _uid, folder) => {
      if (folder === 'Delegated') throw new Error('IMAP delete failed');
    });
    const res = await done({ id: MSG_ID, states: ['watch', 'delegated'] });
    expect(res.status).toBe(500);
    // Acted-folder-last ordering: the non-acted 'Delegated' copy is attempted first…
    expect(imapManager.removeMessageCopy.mock.calls[0][2]).toBe('Delegated');
    // …and since it threw, the acted 'Watch' copy is never removed — the acted DB row stays
    // alive, so a same-id retry still resolves it via loadOwnedMessage (no 404, no orphan).
    const strippedFolders = imapManager.removeMessageCopy.mock.calls.map(c => c[2]);
    expect(strippedFolders).not.toContain('Watch');
    expect(imapManager.moveMessage).not.toHaveBeenCalled(); // never reached the archive step
  });
});

// A copy /done would change whose DB-first move is pending (placeholder uid, services/moveQueue.js):
// answer before anything is changed, so done never stops half-way.
describe('POST /api/gtd/done — a copy whose move is pending', () => {
  it('answers 409 move_pending before marking read, stripping or archiving', async () => {
    stubQueries();
    const base = query.getMockImplementation();
    query.mockImplementation(async (sql, params) => (sql.includes('uid < 0') ? { rows: [{ '?column?': 1 }] } : base(sql, params)));
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('move_pending');
    const check = query.mock.calls.find(([sql]) => sql.includes('uid < 0'));
    expect(check[1]).toEqual([ACCT_ID, '<m@x>', ['INBOX', 'Watch']]);
    expect(fanOutReadToSiblings).not.toHaveBeenCalled();
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  it('answers 409 when the INBOX copy became pending after the check', async () => {
    stubQueries({ inbox: { id: 'ib-1', uid: '-2', is_read: false } });
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(409);
    expect(fanOutReadToSiblings).not.toHaveBeenCalled();
    expect(imapManager.setFlag).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });
});

// A GTD folder can hold a message's only copy: mail the user filed there by moving it (upstream
// #524). Done must not delete it; it archives that copy instead.
describe('POST /api/gtd/done — a GTD folder holding the only copy', () => {
  it('archives the acted copy instead of deleting it', async () => {
    stubQueries({ inbox: null, copies: [['Watch', 10]] });
    imapManager.moveMessage.mockResolvedValue(91);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: true, keptOnlyCopy: true, removed: [] });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Watch', 'Archive');
    const write = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE messages SET folder'));
    expect(write[1]).toEqual(['Archive', 91, MSG_ID, 'Watch']);
  });

  it('still strips its other GTD copies, keeping only the acted one', async () => {
    stubQueries({ inbox: null, copies: [['Watch', 10], ['Delegated', 12]] });
    imapManager.moveMessage.mockResolvedValue(91);
    const res = await done({ id: MSG_ID, states: ['watch', 'delegated'] });
    expect(res.status).toBe(200);
    expect(imapManager.removeMessageCopy.mock.calls.map(c => c[2])).toEqual(['Delegated']);
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Watch', 'Archive');
  });

  it('does not count a copy in Trash, which gets emptied', async () => {
    stubQueries({ inbox: null, copies: [['Watch', 10], ['Trash', 3]] });
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Watch', 'Archive');
  });

  it('strips as before when the server confirms another copy', async () => {
    stubQueries({ inbox: null, copies: [['Watch', 10], ['Receipts', 8]] });
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: ['Watch'], archived: false });
    expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(account, 8, 'Receipts', '<m@x>', { background: false });
    expect(imapManager.removeMessageCopy.mock.calls.map(c => c[2])).toEqual(['Watch']);
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  // A row can outlive its message for a while after another client moves it.
  it('archives instead of stripping when the server does not confirm the other copy', async () => {
    stubQueries({ inbox: null, copies: [['Watch', 10], ['Receipts', 8]] });
    imapManager.hasMessageCopy.mockResolvedValue(false);
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Watch', 'Archive');
  });

  it('treats a failed confirmation as no copy', async () => {
    stubQueries({ inbox: null, copies: [['Watch', 10], ['Receipts', 8]] });
    imapManager.hasMessageCopy.mockRejectedValue(new Error('connection refused'));
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Watch', 'Archive');
  });

  // Gmail: removing a GTD label leaves the message in All Mail.
  it('strips as before on Gmail, where the message stays in All Mail', async () => {
    stubQueries({ inbox: null, copies: [['Watch', 10]] });
    imapManager.isLabelStore.mockReturnValue(true);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.removeMessageCopy.mock.calls.map(c => c[2])).toEqual(['Watch']);
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect(imapManager.hasMessageCopy).not.toHaveBeenCalled();
  });

  it('refuses with 409 only_copy when the only copies are ones it would strip and none is the acted copy', async () => {
    stubQueries({ row: { ...msg, folder: 'Trash' }, inbox: null, copies: [['Trash', 10], ['Todo', 12]] });
    const res = await done({ id: MSG_ID, states: ['todo'] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'only_copy' });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  // Done without an archive folder leaves mail in the Inbox; the kept copy goes there too, so it
  // leaves its GTD section like any other done row.
  it('moves the copy to INBOX when the account has no archive folder', async () => {
    stubQueries({ inbox: null, copies: [['Watch', 10]] });
    resolveArchiveFolder.mockResolvedValue(null);
    imapManager.moveMessage.mockResolvedValue(300);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ archived: false, noArchiveFolder: true, movedToInbox: true });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'Watch', 'INBOX');
    // The thread was marked read, so the move carries no unread count.
    expect(adjustFolderCounts.mock.calls).toEqual([[ACCT_ID, 'Watch', -1, 0], [ACCT_ID, 'INBOX', 1, 0]]);
  });

  // The kept copy is the durable one now; without \Seen the next sync reads it back as unread.
  it('marks an unread kept copy \\Seen before archiving it', async () => {
    stubQueries({ row: { ...msg, is_read: false }, inbox: null, copies: [['Watch', 10]] });
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.setFlag).toHaveBeenCalledWith(account, 10, 'Watch', '\\Seen', true);
    expect(imapManager.setFlag.mock.invocationCallOrder[0]).toBeLessThan(imapManager.moveMessage.mock.invocationCallOrder[0]);
  });

  it('sends no flag for a kept copy that is already read', async () => {
    stubQueries({ inbox: null, copies: [['Watch', 10]] });
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.setFlag).not.toHaveBeenCalled();
  });

  it('still archives when the flag push fails', async () => {
    stubQueries({ row: { ...msg, is_read: false }, inbox: null, copies: [['Watch', 10]] });
    imapManager.setFlag.mockRejectedValue(new Error('STORE failed'));
    imapManager.moveMessage.mockResolvedValue(91);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ archived: true });
  });

  it('does not ask when an INBOX copy keeps the message', async () => {
    stubQueries({ copies: [['Watch', 10]] });
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.hasMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.removeMessageCopy.mock.calls.map(c => c[2])).toEqual(['Watch']);
  });
});
