import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestComposeClose, onComposeCloseRequest } from './composeCloseRequest.js';

test('an open composer takes the request and runs its own close handler', () => {
  const target = new EventTarget();
  let closes = 0;
  const off = onComposeCloseRequest(() => { closes += 1; }, target);
  assert.equal(requestComposeClose(target), true);
  assert.equal(closes, 1);
  off();
});

test('with no composer listening the caller is told to close it itself', () => {
  const target = new EventTarget();
  assert.equal(requestComposeClose(target), false);
});

test('a removed handler no longer takes requests', () => {
  const target = new EventTarget();
  let closes = 0;
  const off = onComposeCloseRequest(() => { closes += 1; }, target);
  off();
  assert.equal(requestComposeClose(target), false);
  assert.equal(closes, 0);
});
