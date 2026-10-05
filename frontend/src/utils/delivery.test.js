import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_CODE_KEYS, EOP_TRACE_STATUSES, coverageKey, deliveryMark, deliveryStateKey, deliveryTone, eopStatusKey, eopStatusTone,
  eopTraceActive, eopTraceErrorKey, explanationKey,
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
  // Refused by the mailbox's own outgoing server when the letter was sent: not a delivery report.
  assert.equal(deliveryStateKey({ state: 'failed', source: 'submission' }), 'message.delivery.state.refusedAtSubmission');
  assert.equal(deliveryTone({ state: 'failed', source: 'submission' }), 'failed');
  assert.equal(deliveryStateKey({ state: 'sent', log: { relayKind: 'discard' } }), 'message.delivery.state.sentDiscard');
});

test('unknown outcomes are said as such, and an unexpected state never reads as delivered', () => {
  assert.equal(deliveryStateKey({ state: 'unknown' }), 'message.delivery.state.unknown');
  assert.equal(deliveryStateKey({ state: 'unknown', stale: 'deferred' }), 'message.delivery.state.stale');
  assert.equal(deliveryStateKey({ state: 'unknown', log: { leftQueue: true } }), 'message.delivery.state.leftQueue');
  assert.equal(deliveryStateKey({ state: 'weird' }), 'message.delivery.state.other');
  assert.equal(deliveryStateKey({ state: 'toString' }), 'message.delivery.state.other');
});

test('tones follow the states', () => {
  assert.deepEqual(['bounced', 'expired', 'failed', 'deferred', 'delayed', 'sent', 'unknown', 'weird'].map((state) => deliveryTone({ state })),
    ['failed', 'failed', 'failed', 'delayed', 'delayed', 'ok', 'neutral', 'neutral']);
  assert.equal(deliveryTone({ state: 'sent', log: { relayKind: 'discard' } }), 'failed');
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

test('R-30: Microsoft\'s trace statuses in words and tones, its errors, and when it is still asked', () => {
  assert.deepEqual(EOP_TRACE_STATUSES, ['delivered', 'failed', 'pending', 'quarantined', 'filteredAsSpam', 'expanded', 'gettingStatus']);
  assert.equal(eopStatusKey('quarantined'), 'message.delivery.eop.status.quarantined');
  assert.equal(eopStatusKey('newStatus'), 'message.delivery.eop.status.other');
  assert.equal(eopStatusKey('__proto__'), 'message.delivery.eop.status.other');
  assert.equal(eopStatusTone('delivered'), 'ok');
  assert.equal(eopStatusTone('filteredAsSpam'), 'failed');
  assert.equal(eopStatusTone('pending'), 'delayed');
  assert.equal(eopStatusTone('newStatus'), 'neutral');
  assert.equal(eopTraceErrorKey('graph_throttled'), 'message.delivery.eop.errorThrottled');
  assert.equal(eopTraceErrorKey('trace_auth'), 'message.delivery.eop.errorAuth');
  assert.equal(eopTraceErrorKey('something'), 'message.delivery.eop.errorFailed');
  assert.equal(eopTraceActive({ state: 'running' }), true);
  assert.equal(eopTraceActive({ state: 'done' }), false);
  assert.equal(eopTraceActive(null), false);
});
