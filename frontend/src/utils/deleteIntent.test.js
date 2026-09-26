import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteView, deleteViewFolder, rowSeenFolders, foldersFor, exitDeleteBodies, EXIT_KEEPALIVE_BUDGET } from './deleteIntent.js';
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
  await direct.deleteMessagesOnExit(['a', 'b', 'x'], { a: 'Trash', b: 'INBOX' });
  await direct.deleteMessagesOnExit(['c']);
  assert.deepEqual(calls, [
    { url: '/api/mail/messages/a', method: 'DELETE', body: { folder: '[Gmail]/Trash' }, contentType: 'application/json', keepalive: true },
    { url: '/api/mail/messages/bulk-delete', method: 'POST', body: { seen: { Trash: ['a'], INBOX: ['b'] }, ids: ['x'] }, contentType: 'application/json', keepalive: true },
    { url: '/api/mail/messages/c', method: 'DELETE', body: undefined, contentType: undefined, keepalive: true },
  ]);
});

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bytes = (body) => new TextEncoder().encode(body).length;

test('the page-close flush is chunked at 500 ids, names each folder once, and stays within the keepalive budget', () => {
  const ids = Array.from({ length: 1200 }, (_, i) => uuid(i));
  const folders = Object.fromEntries(ids.map((id, i) => [id, i % 2 ? 'INBOX' : '&BCcENQRABD0EPgQyBDgEOgQ4-/Archive']));
  const { bodies, dropped } = exitDeleteBodies(ids, folders);
  assert.equal(bodies.length, 3);
  assert.deepEqual(dropped, []);
  const parsed = bodies.map(b => JSON.parse(b));
  assert.deepEqual(parsed.map(b => Object.values(b.seen).flat().length), [500, 500, 200]);
  assert.deepEqual(parsed.flatMap(b => Object.values(b.seen).flat()).sort(), [...ids].sort());
  for (const b of bodies) assert.equal((b.match(/INBOX/g) || []).length, 1);
  assert.ok(bodies.reduce((n, b) => n + bytes(b), 0) <= EXIT_KEEPALIVE_BUDGET);
});

test('what does not fit the keepalive budget is not sent, and is reported', () => {
  const ids = Array.from({ length: 3000 }, (_, i) => uuid(i));
  const { bodies, dropped } = exitDeleteBodies(ids, {});
  const total = bodies.reduce((n, b) => n + bytes(b), 0);
  assert.ok(total <= EXIT_KEEPALIVE_BUDGET, `${total} bytes`);
  const sent = bodies.flatMap(b => JSON.parse(b).ids);
  assert.ok(sent.length >= 1000, `${sent.length} sent`);
  assert.deepEqual([...sent, ...dropped], ids);
});

test('the flush sends one keepalive request per chunk', async () => {
  const { calls, fetchImpl } = recorder();
  const direct = createDirectApi({ demoMode: false, fetchImpl });
  const ids = Array.from({ length: 700 }, (_, i) => uuid(i));
  await direct.deleteMessagesOnExit(ids, Object.fromEntries(ids.map(id => [id, 'Trash'])));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.keepalive && c.method === 'POST'));
  assert.deepEqual(calls.map(c => c.body.seen.Trash.length), [500, 200]);
});

test('a DELETE answered 404 counts as done: the letter is gone, no row is put back', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Message not found' }) });
  assert.deepEqual(await api.deleteMessage('a', 'Trash'), { ok: true, alreadyGone: true });
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Failed to delete message' }) });
  await assert.rejects(api.deleteMessage('a', 'Trash'), (err) => err.status === 500 && err.message === 'Failed to delete message');
});
