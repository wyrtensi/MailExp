import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCommitPendingInput } from './pendingRecipient.js';

test('commits only when the input still holds what was sent', () => {
  assert.equal(shouldCommitPendingInput('a@x.com', 'a@x.com'), true);
  assert.equal(shouldCommitPendingInput('a@x.com', '  a@x.com '), true);
});

test('keeps input typed while the request was in flight', () => {
  assert.equal(shouldCommitPendingInput('a@x.com', 'a@x.com, b@y'), false);
  assert.equal(shouldCommitPendingInput('a@x.com', 'b@y.com'), false);
  assert.equal(shouldCommitPendingInput('a@x.com', ''), false);
});

test('nothing sent means nothing to commit', () => {
  assert.equal(shouldCommitPendingInput('', ''), false);
  assert.equal(shouldCommitPendingInput('', 'typed'), false);
  assert.equal(shouldCommitPendingInput('a@x.com', undefined), false);
});
