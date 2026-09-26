import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seenFolders, foldersFor } from './deleteIntent.js';
import { api, createDirectApi } from './api.js';

test('seenFolders maps each row to the folder it was listed in; a later list wins', () => {
  const thread = [{ id: 'a', folder: 'INBOX' }, { id: 'b', folder: 'Trash' }];
  const visible = [{ id: 'a', folder: 'Archive' }];
  assert.deepEqual(seenFolders(thread, visible), { a: 'Archive', b: 'Trash' });
});

test('seenFolders skips rows without an id or a folder, and missing lists', () => {
  assert.deepEqual(seenFolders([{ id: 'a' }, { folder: 'INBOX' }, null, { id: 'c', folder: '' }], undefined), {});
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
