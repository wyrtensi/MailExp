import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
const imapManager = vi.hoisted(() => ({
  appendToFolder: vi.fn(),
  upsertDraftMessageRecord: vi.fn(),
  permanentDeleteMessage: vi.fn(),
}));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import draftRoutes from './draft.js';
import { query } from '../services/db.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ROW = {
  id: ACCOUNT_ID, email_address: 'matthias@mailexpert.test', name: 'Matt',
  sender_name: null, signature: null, folder_mappings: {},
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', draftRoutes);
  return app;
}

describe('POST /api/mail/draft — local row persistence', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    imapManager.permanentDeleteMessage.mockReset();
    // 1) owner check, 2) buildRawDraft account load, 3) resolveDraftsFolder lookup
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockResolvedValue({ uid: 5, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  it.each([true, false])('preserves reply headers in appended MIME and local metadata (reply=%s)', async reply => {
    const inReplyTo = '<parent@example.com>';
    const references = '<root@example.com> <parent@example.com>';
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, body: 'Reply', ...(reply ? { inReplyTo, references } : {}) }),
    });
    expect(res.status).toBe(200);
    const { parseRawHeaders } = await import('../services/messageParser.js');
    const parsed = parseRawHeaders(imapManager.appendToFolder.mock.calls[0][2].toString().split(/\r?\n\r?\n/)[0]);
    const meta = imapManager.upsertDraftMessageRecord.mock.calls[0][3];
    expect(parsed['in-reply-to']).toBe(reply ? inReplyTo : undefined);
    expect(parsed.references).toBe(reply ? references : undefined);
    expect(meta.inReplyTo ?? null).toBe(reply ? inReplyTo : null);
    expect(meta.references ?? null).toBe(reply ? references : null);
  });

  it('persists a Drafts row with parsed recipient, subject and body after append', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID,
        to: ['Mike Scanlan <mike@scanlan.ai>'],
        cc: [],
        subject: 'Re: MailExpert hero',
        body: 'hello mike',
        bodyIsHtml: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });

    expect(imapManager.upsertDraftMessageRecord).toHaveBeenCalledTimes(1);
    const [acct, folder, uid, meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(acct.id).toBe(ACCOUNT_ID);
    expect(folder).toBe('Drafts');
    expect(uid).toBe(5);
    expect(meta.to).toEqual([{ name: 'Mike Scanlan', email: 'mike@scanlan.ai' }]);
    expect(meta.subject).toBe('Re: MailExpert hero');
    expect(meta.fromEmail).toBe('matthias@mailexpert.test');
    expect(meta.bodyHtml).toContain('hello mike');
    expect(meta.bodyText).toContain('hello mike');
    expect(meta.messageId).toMatch(/^<[0-9a-f]+@mailexpert\.test>$/);
  });

  it('still returns success if the local row persistence throws (append already stored it)', async () => {
    imapManager.upsertDraftMessageRecord.mockRejectedValueOnce(new Error('db down'));
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
  });

  it.each([
    ['a full pool', { poolExhausted: true }, 'mailbox_busy'],
    ['a login held back', { providerRefusing: true }, 'mailbox_busy'],
    ['a rejected password', { providerRefusing: true, authRejected: true }, 'mailbox_auth_rejected'],
  ])('answers 503 with a stable code when the append gets no session (%s)', async (_what, flags, code) => {
    imapManager.appendToFolder.mockRejectedValueOnce(Object.assign(new Error('Mail server is not accepting new connections for this account right now'), flags));
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe(code);
  });

  it('answers another append failure with a 500 draft_save_failed, not the server text', async () => {
    imapManager.appendToFolder.mockRejectedValueOnce(new Error('NO [SERVERBUG] internal detail'));
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save the draft', code: 'draft_save_failed' });
  });

  it('answers a malformed accountId with a 400 invalid_account before any query', async () => {
    query.mockReset();
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'nope', body: 'y' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_account');
    expect(query).not.toHaveBeenCalled();
  });

  it('does not persist a row when the append returns no uid (no reliable key)', async () => {
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: null, folder: 'Drafts' });
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(200);
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();
  });
});

describe('POST /api/mail/draft — signature wrapper (#432)', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    // 1) owner check, 2) buildRawDraft account load (with a signature), 3) Drafts folder lookup
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [{ ...ACCOUNT_ROW, signature: '<b>Sig</b>' }] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockResolvedValue({ uid: 7, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  const save = async (extra) => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: '<p>hello</p>', bodyIsHtml: true, ...extra }),
    });
    expect(res.status).toBe(200);
    return imapManager.upsertDraftMessageRecord.mock.calls[0][3];
  };

  it('stores the account signature once inside a marked wrapper', async () => {
    const meta = await save({});
    expect(meta.bodyHtml.match(/class="mailexpert-signature"/g)).toHaveLength(1);
    expect(meta.bodyHtml).toContain(
      '<div class="mailexpert-signature" style="margin-top:16px;color:#555;font-size:13px"><b>Sig</b></div>'
    );
    expect(meta.bodyText.match(/\n\n-- \nSig/g)).toHaveLength(1);
  });

  it('keeps the chosen priority in the draft headers, and none for normal', async () => {
    await save({ priority: 'high' });
    expect(imapManager.appendToFolder.mock.calls[0][2].toString()).toMatch(/^X-Priority: 1/m);
  });

  it('writes no priority header for a normal-priority draft', async () => {
    await save({ priority: 'normal' });
    expect(imapManager.appendToFolder.mock.calls[0][2].toString()).not.toMatch(/^X-Priority:/m);
  });

  it('keeps ampersands and angle brackets unescaped in the draft text part', async () => {
    const meta = await save({ body: '<p>R&amp;D a &lt; b</p>', editedSignature: '<b>R&amp;D &lt;team&gt;</b>' });
    expect(meta.bodyText).toBe('R&D a < b\n\n-- \nR&D <team>');
    // The appended MIME's text/plain part (the HTML part legitimately keeps &amp;).
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString();
    const textPart = raw.split('Content-Type: text/plain')[1].split('----_')[0];
    expect(textPart).toContain('R&D a < b');
    expect(textPart).not.toContain('&amp;');
  });

  it('uses the edited signature inside the wrapper', async () => {
    const meta = await save({ editedSignature: '<i>Edited</i>' });
    expect(meta.bodyHtml).toContain('<div class="mailexpert-signature" style="margin-top:16px;color:#555;font-size:13px"><i>Edited</i></div>');
    expect(meta.bodyHtml).not.toContain('<b>Sig</b>');
  });

  it('writes no wrapper when the edited signature is empty', async () => {
    const meta = await save({ editedSignature: '' });
    expect(meta.bodyHtml).not.toContain('mailexpert-signature');
    expect(meta.bodyText).not.toContain('-- \n');
  });
});

// Every query the two routes above and their folder-resolution helpers (isDraftsPath,
// resolveDraftsFolder, resolveAllDraftsPaths, mappedFolderUsable) can issue, keyed by SQL shape
// rather than call position — inserting the Message-ID check ahead of the delete (upstream
// e8eb7583) must not force every test to recount query positions.
const OLD_MESSAGE_ID = '<old-draft@mailexpert.test>';
function draftQueryStub({
  account = ACCOUNT_ROW,
  draftsFolderPath = 'Drafts',   // resolveDraftsFolder's own \Drafts lookup (no folder_mappings.drafts)
  mappedUsable = false,          // mappedFolderUsable(folder_mappings.drafts)
  allDraftsPaths = ['Drafts'],   // resolveAllDraftsPaths' name-heuristic fallback
  specialUseMatch = false,       // isDraftsPath's own direct special_use check
  oldMessageId = OLD_MESSAGE_ID, // the old copy's local row, read before it is deleted
} = {}) {
  return async (sql) => {
    if (sql.includes('SELECT id FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
    if (sql.includes('no_select = false')) return { rows: mappedUsable ? [{ '?column?': 1 }] : [] };
    if (sql.includes("lower(name) IN ('drafts', 'draft')")) return { rows: allDraftsPaths.map(path => ({ path })) };
    if (sql.includes('SELECT 1 FROM folders')) return { rows: specialUseMatch ? [{ '?column?': 1 }] : [] };
    if (sql.includes('SELECT path FROM folders')) return { rows: draftsFolderPath ? [{ path: draftsFolderPath }] : [] };
    if (sql.includes('SELECT message_id FROM messages')) return { rows: oldMessageId ? [{ message_id: oldMessageId }] : [] };
    return { rows: [] };
  };
}

describe('POST /api/mail/draft — replacing the previous copy', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    imapManager.permanentDeleteMessage.mockReset();
    query.mockImplementation(draftQueryStub());
    imapManager.appendToFolder.mockResolvedValue({ uid: 5, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
    imapManager.permanentDeleteMessage.mockResolvedValue(true);
  });

  const saveDraft = (extra) => fetch(`${base}/api/mail/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The composer names the mailbox the previous copy lives in; default it to this one.
    body: JSON.stringify({
      accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y',
      ...(extra?.existingUid !== undefined ? { existingAccountId: ACCOUNT_ID } : {}),
      ...extra,
    }),
  });

  it('keeps the previous copy when it lives in another mailbox', async () => {
    // Switching From to another mailbox saves there; the same uid in this mailbox's Drafts is
    // somebody else's draft, so only the composer may remove the old copy, from its own mailbox.
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts', existingAccountId: '22222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('keeps the previous copy when the request does not say which mailbox it lives in', async () => {
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts', existingAccountId: undefined });
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('stores Bcc recipients on the local draft row so a reopened draft keeps them', async () => {
    const res = await saveDraft({ bcc: ['Hidden <hidden@example.com>'] });
    expect(res.status).toBe(200);
    expect(imapManager.upsertDraftMessageRecord.mock.calls[0][3].bcc).toEqual([{ name: 'Hidden', email: 'hidden@example.com' }]);
  });

  it('replaces the previous copy when it is in the Drafts folder it just saved to', async () => {
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 4, 'Drafts', { expectMessageId: OLD_MESSAGE_ID });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('DELETE FROM messages'), [ACCOUNT_ID, 4, 'Drafts']);
  });

  it('accepts a reopened draft (string BIGINT uid) from another canonical Drafts path', async () => {
    query.mockImplementation(draftQueryStub({ allDraftsPaths: ['Drafts', 'INBOX.Drafts'] }));
    const res = await saveDraft({ existingUid: '12', existingFolder: 'INBOX.Drafts' });
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 12, 'INBOX.Drafts', { expectMessageId: OLD_MESSAGE_ID });
  });

  it('replaces its own previous copy even when the drafts mapping is not a synced folder', async () => {
    // resolveDraftsFolder uses the raw mapping, so the new copy lands in 'Custom'; the canonical
    // set would not include it, and every autosave would otherwise leave a duplicate behind.
    query.mockImplementation(draftQueryStub({ account: { ...ACCOUNT_ROW, folder_mappings: { drafts: 'Custom' } } }));
    imapManager.appendToFolder.mockResolvedValue({ uid: 5, folder: 'Custom' });
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Custom' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Custom' });
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 4, 'Custom', { expectMessageId: OLD_MESSAGE_ID });
  });

  it('saves the draft but never expunges the old uid from a non-Drafts folder', async () => {
    const res = await saveDraft({ existingUid: 4, existingFolder: 'INBOX' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
    expect(imapManager.appendToFolder).toHaveBeenCalledTimes(1);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it.each([['1:*'], ['1,2,3'], [[1, 2, 3]], ['4abc'], [-1], [1.5]])('never expunges a uid range or non-integer uid %j', async (existingUid) => {
    const res = await saveDraft({ existingUid, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('leaves the old copy in place, and logs the refusal, when there is no local row to check the server copy against', async () => {
    query.mockImplementation(draftQueryStub({ oldMessageId: null }));
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('leaves the old copy in place when the server copy does not match the local row\'s Message-ID', async () => {
    imapManager.permanentDeleteMessage.mockResolvedValue(false); // Message-ID did not match
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 4, 'Drafts', { expectMessageId: OLD_MESSAGE_ID });
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('reads the old copy\'s Message-ID before the new draft is appended, not after', async () => {
    // A UIDVALIDITY reset can hand the new draft the uid the old one had; reading the row before
    // the append (rather than after) keeps its Message-ID from vouching for the new draft.
    let readBeforeAppend = null;
    const base = draftQueryStub();
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT message_id FROM messages') && readBeforeAppend === null) {
        readBeforeAppend = imapManager.appendToFolder.mock.calls.length === 0;
      }
      return base(sql, params);
    });
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(readBeforeAppend).toBe(true);
  });
});

describe('DELETE /api/mail/draft/:uid — Drafts folders only', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.permanentDeleteMessage.mockReset();
    imapManager.permanentDeleteMessage.mockResolvedValue(true);
    query.mockImplementation(draftQueryStub());
  });

  const del = (qs) => fetch(`${base}/api/mail/draft/9?accountId=${ACCOUNT_ID}&${qs}`, { method: 'DELETE' });

  // A negative uid is the placeholder of a letter whose move is pending (services/moveQueue.js).
  it('rejects a uid that is not a single positive number', async () => {
    for (const uid of ['-42', '0', '9abc', '1.5']) {
      const res = await fetch(`${base}/api/mail/draft/${uid}?accountId=${ACCOUNT_ID}&folder=Drafts`, { method: 'DELETE' });
      expect(res.status).toBe(400);
    }
    expect(query).not.toHaveBeenCalled();
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('deletes a draft from the Drafts folder', async () => {
    const res = await del('folder=Drafts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 9, 'Drafts', { expectMessageId: OLD_MESSAGE_ID });
  });

  it('deletes from any canonical Drafts path (e.g. a second drafts-named folder)', async () => {
    query.mockImplementation(draftQueryStub({ allDraftsPaths: ['Drafts', 'INBOX.Drafts'] }));
    const res = await del('folder=INBOX.Drafts');
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 9, 'INBOX.Drafts', { expectMessageId: OLD_MESSAGE_ID });
  });

  it('refuses to expunge from a non-Drafts folder', async () => {
    const res = await del('folder=INBOX');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Folder is not a Drafts folder' });
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('answers a malformed accountId with a 400 invalid_account, not the database cast error', async () => {
    const res = await fetch(`${base}/api/mail/draft/9?accountId=nope&folder=Drafts`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_account');
    expect(query).not.toHaveBeenCalled();
  });

  it('answers an IMAP failure with a 500 draft_delete_failed, not the server text', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    imapManager.permanentDeleteMessage.mockRejectedValueOnce(new Error('NO [SERVERBUG] internal detail'));
    const res = await del('folder=Drafts');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete the draft', code: 'draft_delete_failed' });
    expect(spy.mock.calls.some(([line]) => String(line).includes(ACCOUNT_ID))).toBe(true);
    spy.mockRestore();
  });

  it('refuses a repeated folder param (array) without touching IMAP', async () => {
    const res = await del('folder=Drafts&folder=INBOX');
    expect(res.status).toBe(400);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('with the drafts mapping pointing elsewhere, still deletes from the server\'s own \\Drafts folder', async () => {
    // The message list opens that folder as Drafts through special_use, so a draft opened there
    // must still be discardable.
    query.mockImplementation(draftQueryStub({
      account: { ...ACCOUNT_ROW, folder_mappings: { drafts: 'INBOX.Drafts' } },
      mappedUsable: true,
      specialUseMatch: true,
    }));
    const res = await del('folder=Drafts');
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 9, 'Drafts', { expectMessageId: OLD_MESSAGE_ID });
  });

  it('with the drafts mapping pointing elsewhere, refuses a folder that is neither mapped nor \\Drafts', async () => {
    query.mockImplementation(draftQueryStub({
      account: { ...ACCOUNT_ROW, folder_mappings: { drafts: 'INBOX.Drafts' } },
      mappedUsable: true,
      specialUseMatch: false,
    }));
    const res = await del('folder=Sent');
    expect(res.status).toBe(400);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('leaves the old copy in place, and logs the refusal, when there is no local row to check the server copy against', async () => {
    query.mockImplementation(draftQueryStub({ oldMessageId: null }));
    const res = await del('folder=Drafts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('leaves the old copy in place when the server copy does not match the local row\'s Message-ID', async () => {
    imapManager.permanentDeleteMessage.mockResolvedValue(false); // Message-ID did not match
    const res = await del('folder=Drafts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });
});
