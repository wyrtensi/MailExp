import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_CODE_KEYS, coverageKey, deliveryMark, deliveryStateKey, deliveryTone, explanationKey,
} from './delivery.js';

test('the list marks only failed and delayed letters', () => {
  assert.equal(deliveryMark('failed').labelKey, 'message.delivery.marker.failed');
  assert.equal(deliveryMark('delayed').labelKey, 'message.delivery.marker.delayed');
  assert.equal(deliveryMark(null), null);
  assert.equal(deliveryMark('sent'), null);
  assert.equal(deliveryMark('toString'), null);
  assert.equal(explanationKey({ key: 'constructor' }), null);
});

test('a sent recipient says where the letter went, never that it was read', () => {
  assert.equal(deliveryStateKey({ state: 'sent', log: { relayKind: 'eop' } }), 'message.delivery.state.sentEop');
  assert.equal(deliveryStateKey({ state: 'sent', log: { relayKind: 'local' } }), 'message.delivery.state.sentLocal');
  assert.equal(deliveryStateKey({ state: 'sent', log: { relayKind: 'other' } }), 'message.delivery.state.sent');
  assert.equal(deliveryStateKey({ state: 'bounced' }), 'message.delivery.state.bounced');
  assert.equal(deliveryStateKey({ state: 'failed' }), 'message.delivery.state.failed');
  assert.equal(deliveryStateKey({ state: 'weird' }), null);
});

test('tones follow the states', () => {
  assert.deepEqual(['bounced', 'expired', 'failed', 'deferred', 'delayed', 'sent'].map(deliveryTone), ['failed', 'failed', 'failed', 'delayed', 'delayed', 'ok']);
});

test('explanations only for the keys the server knows', () => {
  assert.equal(explanationKey({ key: 'recipient_not_accepted' }), 'message.delivery.code.recipient_not_accepted');
  assert.equal(explanationKey({ key: 'temporary' }), 'message.delivery.code.temporary');
  assert.equal(explanationKey({ key: 'success' }), null);
  assert.equal(explanationKey(null), null);
  assert.equal(DELIVERY_CODE_KEYS.length, 8);
});

test('the log note: nothing when the log shows the letter or there is no log lookup', () => {
  assert.equal(coverageKey(null), null);
  assert.equal(coverageKey({ coverage: 'found' }), null);
  assert.equal(coverageKey({ coverage: 'gone' }), 'message.delivery.coverage.gone');
  assert.equal(coverageKey({ coverage: 'unavailable' }), 'message.delivery.coverage.unavailable');
});
