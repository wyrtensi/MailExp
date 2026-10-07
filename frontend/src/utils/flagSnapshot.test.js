import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFlag } from './flagSnapshot.js';

test('takes the previous value of each message from the store', () => {
  const state = {
    messages: [{ id: 'row-1', is_starred: true }, { id: 'row-2', is_starred: false }],
    searchResults: [],
    threadMessages: { 'a:t1': [{ id: 'child-1', is_starred: true }, { id: 'child-2', is_starred: false }] },
  };
  const snap = snapshotFlag(state, ['row-1', 'row-2', 'child-1', 'child-2'], 'is_starred');
  assert.deepEqual([...snap], [['row-1', true], ['row-2', false], ['child-1', true], ['child-2', false]]);
});

test('the list row wins over the copy fetched with its conversation', () => {
  const state = {
    messages: [{ id: 'row-1', is_starred: false }],
    searchResults: [],
    threadMessages: { 'a:t1': [{ id: 'row-1', is_starred: true }] },
  };
  assert.equal(snapshotFlag(state, ['row-1'], 'is_starred').get('row-1'), false);
});

test('ids absent from the store fall back to the given rows, else are left out', () => {
  const state = { messages: [], searchResults: [], threadMessages: {} };
  const snap = snapshotFlag(state, ['gone', 'unknown'], 'is_starred', [{ id: 'gone', is_starred: true }]);
  assert.deepEqual([...snap], [['gone', true]]);
});

test('reads search results too and ignores other ids', () => {
  const state = { messages: [], searchResults: [{ id: 's1', is_starred: true }, { id: 'other', is_starred: true }] };
  assert.deepEqual([...snapshotFlag(state, ['s1'], 'is_starred')], [['s1', true]]);
});
