import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteView, deleteViewFolder, rowSeenFolders, foldersFor } from './deleteIntent.js';
import { api, createDirectApi } from './api.js';

const inboxView = deleteView({ searchQuery: '', selectedAccountId: 'acc', selectedFolder: 'INBOX' });
const trashView = deleteView({ searchQuery: '', selectedAccountId: 'acc', selectedFolder: 'Trash' });

test('a stale INBOX thread whose members a colleague already trashed names none of them as seen in Trash', () => {
  // The thread row is listed in INBOX; re-reading the thread finds every member in Trash by now.
  const row = { id: 'newest', folder: 'INBOX' };
  const members = [{ id: 'newest', folder: 'Trash' }, { id: 'older', folder: 'Trash' }, { id: 'reply', folder: 'Sent' }];
  const folders = rowSeenFolders([row], [members], r => deleteViewFolder(r, inboxView));
  assert.deepEqual(folders, { newest: 'INBOX', older: 'INBOX', reply: 'INBOX' });
});

test('a thread deleted from the Trash view names every member as seen in Trash', () => {
  const row = { id: 'newest', folder: 'Trash' };
  const members = [{ id: 'newest', folder: 'Trash' }, { id: 'older', folder: 'Trash' }, { id: 'kept', folder: 'INBOX' }];
  const folders = rowSeenFolders([row], [members], r => deleteViewFolder(r, trashView));
  assert.deepEqual(folders, { newest: 'Trash', older: 'Trash', kept: 'Trash' });
});

test('a bulk delete gives each row\'s members the folder of that row', () => {
  const search = deleteView({ searchQuery: 'invoice', selectedAccountId: 'acc', selectedFolder: 'INBOX' });
  const rows = [{ id: 'a', folder: 'Trash' }, { id: 'b', folder: 'Archive' }];
  assert.deepEqual(rowSeenFolders(rows, [[{ id: 'a', folder: 'Trash' }], []], r => deleteViewFolder(r, search)), { a: 'Trash', b: 'Archive' });
});

test('deleteViewFolder: the view folder, INBOX in the unified view, the row folder in search results', () => {
  const sub = { id: 's', folder: 'Trash' }; // an expanded thread letter, or the letter open in the pane
  assert.equal(deleteViewFolder(sub, inboxView), 'INBOX');
  assert.equal(deleteViewFolder(sub, deleteView({ searchQuery: '', selectedAccountId: null, selectedFolder: 'Projects' })), 'INBOX');
  assert.equal(deleteViewFolder(sub, deleteView({ searchQuery: ' x ', selectedAccountId: 'acc', selectedFolder: 'INBOX' })), 'Trash');
  assert.equal(deleteViewFolder({ id: 'n' }, deleteView({ searchQuery: 'x' })), null);
  assert.deepEqual(rowSeenFolders([{ id: 'n' }], [[{ id: 'm' }]], () => null), {});
});

test('foldersFor picks the ids of one chunk', () => {
  const folders = { a: 'INBOX', b: 'Trash', c: '[Gmail]/Trash' };
  assert.deepEqual(foldersFor(['b', 'c', 'x'], folders), { b: 'Trash', c: '[Gmail]/Trash' });
  assert.equal(foldersFor(['x'], folders), undefined);
  assert.equal(foldersFor(['a'], undefined), undefined);
});

function recorder() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({
      url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined,
      contentType: opts.headers?.['Content-Type'], keepalive: !!opts.keepalive,
    });
    return { ok: true, status: 200, json: async () => ({ ok: true, deleted: [] }) };
  };
  return { calls, fetchImpl };
}

test('the delete calls send the folder the user saw, and no body when none is given', async (t) => {
  const { calls, fetchImpl } = recorder();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => { globalThis.fetch = originalFetch; });
  await api.deleteMessage('a', 'Trash');
  await api.deleteMessage('b');
  await api.bulkDelete(['a', 'b'], { a: 'Trash', b: 'INBOX' });
  await api.bulkDelete(['c']);
  assert.deepEqual(calls.map(c => [c.method, c.url, c.body]), [
    ['DELETE', '/api/mail/messages/a', { folder: 'Trash' }],
    ['DELETE', '/api/mail/messages/b', undefined],
    ['POST', '/api/mail/messages/bulk-delete', { ids: ['a', 'b'], folders: { a: 'Trash', b: 'INBOX' } }],
    ['POST', '/api/mail/messages/bulk-delete', { ids: ['c'] }],
  ]);
});

test('the deletes sent on page exit carry the folders too, as JSON with keepalive', async () => {
  const { calls, fetchImpl } = recorder();
  const direct = createDirectApi({ demoMode: false, fetchImpl });
  await direct.deleteMessagesOnExit(['a'], { a: '[Gmail]/Trash' });
  await direct.deleteMessagesOnExit(['a', 'b'], { a: 'Trash', b: 'INBOX' });
  await direct.deleteMessagesOnExit(['c']);
  assert.deepEqual(calls, [
    { url: '/api/mail/messages/a', method: 'DELETE', body: { folder: '[Gmail]/Trash' }, contentType: 'application/json', keepalive: true },
    { url: '/api/mail/messages/bulk-delete', method: 'POST', body: { ids: ['a', 'b'], folders: { a: 'Trash', b: 'INBOX' } }, contentType: 'application/json', keepalive: true },
    { url: '/api/mail/messages/c', method: 'DELETE', body: undefined, contentType: undefined, keepalive: true },
  ]);
});
