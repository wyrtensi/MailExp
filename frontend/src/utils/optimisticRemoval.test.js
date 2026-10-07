import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitByConfirmed, unreadByAccount } from './optimisticRemoval.js';

const rows = [
  { id: 'a', account_id: 'x', is_read: false },
  { id: 'b', account_id: 'x', is_read: true },
  { id: 'c', account_id: 'y', is_read: false },
];

test('rows the server did not list as done are failed', () => {
  const { done, failed } = splitByConfirmed(rows, ['a']);
  assert.deepEqual(done.map(r => r.id), ['a']);
  assert.deepEqual(failed.map(r => r.id), ['b', 'c']);
});

test('an empty or missing confirmation fails every row', () => {
  assert.equal(splitByConfirmed(rows, []).failed.length, 3);
  assert.equal(splitByConfirmed(rows, undefined).failed.length, 3);
  assert.equal(splitByConfirmed(rows, null).done.length, 0);
});

test('unread counts are grouped per account and skip read rows', () => {
  assert.deepEqual(unreadByAccount(rows), [['x', 1], ['y', 1]]);
  assert.deepEqual(unreadByAccount(rows.filter(r => r.is_read)), []);
  assert.deepEqual(unreadByAccount([rows[0], rows[0]]), [['x', 2]]);
});
