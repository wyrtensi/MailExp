import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchScopeKey } from './searchScope.js';

test('the key differs by account, folder and query', () => {
  const base = { accountId: 'a', folder: 'INBOX', query: 'invoice' };
  const key = searchScopeKey(base);
  assert.equal(searchScopeKey({ ...base }), key);
  assert.notEqual(searchScopeKey({ ...base, accountId: 'b' }), key);
  assert.notEqual(searchScopeKey({ ...base, folder: 'Sent' }), key);
  assert.notEqual(searchScopeKey({ ...base, folder: undefined }), key);
  assert.notEqual(searchScopeKey({ ...base, query: 'invoices' }), key);
});

test('a cleared query has an empty key whatever the mailbox', () => {
  assert.equal(searchScopeKey({ accountId: 'a', folder: 'INBOX', query: '' }), '');
  assert.equal(searchScopeKey({ accountId: 'a', query: '   ' }), '');
  assert.equal(searchScopeKey(), '');
});
