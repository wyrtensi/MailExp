import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isDraftMessage, pickThreadDraft } from './isDraftMessage.js';

const ACCOUNT_WITH_MAPPING = { id: 'acct-1', folder_mappings: { drafts: '[Gmail]/Drafts' } };
const ACCOUNT_NO_MAPPING = { id: 'acct-2' };
const FOLDERS = {
  'acct-2': [
    { path: 'INBOX', special_use: null },
    { path: '[Gmail]/Drafts', special_use: '\\Drafts' },
  ],
};

describe('isDraftMessage', () => {
  test('null/undefined message is never a draft', () => {
    assert.equal(isDraftMessage(null), false);
    assert.equal(isDraftMessage(undefined), false);
  });

  test('trusts an explicit is_draft field from the backend over anything else', () => {
    assert.equal(isDraftMessage({ is_draft: true, folder: 'INBOX', account_id: 'acct-1' },
      { accounts: [ACCOUNT_WITH_MAPPING] }), true);
    assert.equal(isDraftMessage({ is_draft: false, folder: '[Gmail]/Drafts', account_id: 'acct-1' },
      { accounts: [ACCOUNT_WITH_MAPPING] }), false);
  });

  test('an IMAP \\Draft flag on the row marks it a draft', () => {
    assert.equal(isDraftMessage({ flags: ['\\Seen', '\\Draft'], account_id: 'acct-1', folder: 'INBOX' }), true);
    assert.equal(isDraftMessage({ flags: ['\\Seen'], account_id: 'acct-1', folder: 'INBOX' }), false);
  });

  test('matches the account\'s configured folder_mappings.drafts', () => {
    const msg = { account_id: 'acct-1', folder: '[Gmail]/Drafts' };
    assert.equal(isDraftMessage(msg, { accounts: [ACCOUNT_WITH_MAPPING] }), true);
    assert.equal(isDraftMessage({ ...msg, folder: 'INBOX' }, { accounts: [ACCOUNT_WITH_MAPPING] }), false);
  });

  test('falls back to the folder list\'s special_use when the account has no folder_mappings', () => {
    const msg = { account_id: 'acct-2', folder: '[Gmail]/Drafts' };
    assert.equal(isDraftMessage(msg, { accounts: [ACCOUNT_NO_MAPPING], folders: FOLDERS }), true);
    assert.equal(isDraftMessage({ ...msg, folder: 'INBOX' }, { accounts: [ACCOUNT_NO_MAPPING], folders: FOLDERS }), false);
  });

  test('a message with no account_id or folder is never a draft', () => {
    assert.equal(isDraftMessage({}), false);
    assert.equal(isDraftMessage({ account_id: 'acct-1' }), false);
  });

  test('is decided per message, not per some ambient "current folder" the caller might have in mind', () => {
    // Same account, same folders config, two different messages — only the one actually sitting
    // in the Drafts folder is a draft, regardless of what a caller might otherwise be viewing.
    const ctx = { accounts: [ACCOUNT_NO_MAPPING], folders: FOLDERS };
    const inInbox = { account_id: 'acct-2', folder: 'INBOX' };
    const inDrafts = { account_id: 'acct-2', folder: '[Gmail]/Drafts' };
    assert.equal(isDraftMessage(inInbox, ctx), false);
    assert.equal(isDraftMessage(inDrafts, ctx), true);
  });
});

describe('pickThreadDraft', () => {
  const ctx = { accounts: [ACCOUNT_WITH_MAPPING] };
  const received = { account_id: 'acct-1', folder: 'INBOX', date: '2026-01-01T00:00:00Z', id: 'received' };
  const olderDraft = { account_id: 'acct-1', folder: '[Gmail]/Drafts', date: '2026-01-02T00:00:00Z', id: 'draft-old' };
  const newerDraft = { account_id: 'acct-1', folder: '[Gmail]/Drafts', date: '2026-01-03T00:00:00Z', id: 'draft-new' };

  test('picks the newest draft among the thread\'s cached messages, not the row that was clicked', () => {
    // The representative row handed in is the received message (what a Gmail conversation's
    // newest-by-date row would be), but the thread also holds two drafts — the newer one wins.
    const picked = pickThreadDraft(received, [received, olderDraft, newerDraft], ctx);
    assert.equal(picked?.id, 'draft-new');
  });

  test('falls back to the clicked row itself when it is a draft and nothing is cached yet', () => {
    const picked = pickThreadDraft(olderDraft, undefined, ctx);
    assert.equal(picked?.id, 'draft-old');
  });

  test('returns null when neither the row nor anything cached is a draft', () => {
    assert.equal(pickThreadDraft(received, [received], ctx), null);
    assert.equal(pickThreadDraft(received, undefined, ctx), null);
  });

  test('ignores an explicit is_draft: false on the clicked row itself, checking the cache', () => {
    const picked = pickThreadDraft({ ...received, is_draft: false }, [{ ...received, is_draft: false }, newerDraft], ctx);
    assert.equal(picked?.id, 'draft-new');
  });
});
