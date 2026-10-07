import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unreadAfterHeadRead, applyHeadFlagPatch, unreadInConversation } from './threadUnread.js';

test('reading the row message leaves the other unread messages counted', () => {
  assert.equal(unreadAfterHeadRead({ is_read: false, unread_count: 3 }), 2);
  assert.equal(unreadAfterHeadRead({ is_read: false, unread_count: '2' }), 1);
  assert.equal(unreadAfterHeadRead({ is_read: false, unread_count: 1 }), 0);
});

test('a row without an aggregate counted only its own message', () => {
  assert.equal(unreadAfterHeadRead({ is_read: false }), 0);
  assert.equal(unreadAfterHeadRead({ is_read: false, unread_count: 0 }), 0);
});

test('a remote read of the row message lowers the aggregate by one', () => {
  const row = { id: 'h', is_read: false, unread_count: 3 };
  assert.deepEqual(applyHeadFlagPatch(row, { is_read: true }), { id: 'h', is_read: true, unread_count: 2 });
});

test('a remote unread of the row message raises the aggregate by one', () => {
  const row = { id: 'h', is_read: true, unread_count: 1 };
  assert.equal(applyHeadFlagPatch(row, { is_read: false }).unread_count, 2);
});

test('a patch that does not change the read state keeps the aggregate', () => {
  const row = { id: 'h', is_read: false, unread_count: 3 };
  assert.equal(applyHeadFlagPatch(row, { is_read: false }).unread_count, 3);
  const starred = applyHeadFlagPatch(row, { is_starred: true });
  assert.equal(starred.unread_count, 3);
  assert.equal(starred.is_starred, true);
});

test('the aggregate never goes below zero', () => {
  assert.equal(applyHeadFlagPatch({ is_read: false, unread_count: 0 }, { is_read: true }).unread_count, 0);
});

test('counts unread messages of a cached conversation', () => {
  assert.equal(unreadInConversation([{ is_read: true }, { is_read: false }, { is_read: false }]), 2);
});
