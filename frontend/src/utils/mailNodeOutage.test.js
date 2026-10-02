import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adviceKey, causeParts, durationParts, fromLocalInput, letterCounts, lettersFor, noticeSummary, outageFormError, outcomeKey,
  timeLeft, toLocalInput, waitingBanner, windowMinutes, windowSourceKey,
} from './mailNodeOutage.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const letter = (outcome, fields = {}) => ({ outcome, accountId: 'a', receivedAt: '2026-10-02T10:00:00Z', ...fields });

describe('timeLeft', () => {
  it('counts down to EOP giving up, rounding minutes up, and says when the time has passed', () => {
    assert.deepEqual(timeLeft('2026-10-03T10:00:00Z', NOW), { past: false, hours: 22, minutes: 0 });
    assert.deepEqual(timeLeft('2026-10-02T12:00:30Z', NOW), { past: false, hours: 0, minutes: 1 });
    assert.deepEqual(timeLeft('2026-10-02T11:00:00Z', NOW), { past: true });
    assert.equal(timeLeft(null, NOW), null);
  });
});

describe('the words of a letter', () => {
  it('names the outcome, the expiry and what to do', () => {
    assert.equal(outcomeKey(letter('waiting')), 'messageList.outage.outcomeWaiting');
    assert.equal(outcomeKey(letter('lost', { expired: true })), 'messageList.outage.outcomeLostExpired');
    assert.equal(outcomeKey(letter('lost')), 'messageList.outage.outcomeLost');
    assert.equal(outcomeKey(letter('delayed')), 'messageList.outage.outcomeDelayed');
    assert.equal(outcomeKey(letter('other')), 'messageList.outage.outcomeOther');
    assert.equal(adviceKey(letter('lost')), 'messageList.outage.adviceLost');
    assert.equal(adviceKey(letter('waiting')), 'messageList.outage.adviceWaiting');
    assert.equal(adviceKey(letter('delayed')), null);
  });
});

describe('the letters of a mailbox', () => {
  const letters = [
    letter('delayed', { receivedAt: '2026-10-02T11:00:00Z' }),
    letter('lost', { receivedAt: '2026-10-01T10:00:00Z' }),
    letter('waiting', { accountId: 'b' }),
    letter('waiting', { receivedAt: '2026-10-02T09:00:00Z' }),
  ];

  it('keeps one mailbox (all for the unified inbox), waiting and lost first, newest first', () => {
    assert.deepEqual(lettersFor(letters, 'a').map((l) => l.outcome), ['waiting', 'lost', 'delayed']);
    assert.equal(lettersFor(letters, null).length, 4);
    assert.deepEqual(lettersFor(null, 'a'), []);
  });

  it('sums them up for the notice', () => {
    assert.deepEqual(letterCounts(lettersFor(letters, 'a')), { waiting: 1, lost: 1, delayed: 1, total: 3 });
    assert.deepEqual(noticeSummary(lettersFor(letters, 'a')), { key: 'messageList.outage.summaryWaiting', values: { count: 1, total: 3 } });
    assert.deepEqual(noticeSummary([letter('lost'), letter('delayed')]), { key: 'messageList.outage.summaryLost', values: { count: 1, total: 2 } });
    assert.deepEqual(noticeSummary([letter('delayed')]), { key: 'messageList.outage.summaryDelayed', values: { count: 1 } });
  });
});

describe('windows', () => {
  it('measures a window, open ones up to now', () => {
    assert.equal(windowMinutes({ startedAt: '2026-10-02T10:00:00Z', endedAt: '2026-10-02T11:30:00Z' }), 90);
    assert.equal(windowMinutes({ startedAt: '2026-10-02T11:00:00Z', endedAt: null }, NOW), 60);
    assert.deepEqual(durationParts(45), { key: 'admin.outages.durationMinutes', values: { minutes: 45 } });
    assert.deepEqual(durationParts(185), { key: 'admin.outages.durationHours', values: { hours: 3, minutes: '05' } });
    assert.deepEqual(durationParts(26 * 60), { key: 'admin.outages.durationHours', values: { hours: 26, minutes: '00' } });
    assert.deepEqual(durationParts(3 * 1440 + 120), { key: 'admin.outages.durationDays', values: { days: 3, hours: 2 } });
    assert.equal(durationParts(null).key, 'admin.outages.durationUnknown');
  });

  it('says how a window came to be and what failed', () => {
    assert.equal(windowSourceKey({ source: 'detected' }), 'admin.outages.sourceDetected');
    assert.equal(windowSourceKey({ source: 'manual', planned: true }), 'admin.outages.sourcePlanned');
    assert.equal(windowSourceKey({ source: 'manual' }), 'admin.outages.sourceManual');
    assert.deepEqual(causeParts({ cause: { signals: ['api_unreachable', 'containers'], down: [{ name: 'postfix-mailcow', state: 'exited' }] } }), [
      { key: 'admin.outages.causeApi', values: {} },
      { key: 'admin.outages.causeContainers', values: { names: 'postfix-mailcow (exited)' } },
    ]);
    assert.deepEqual(causeParts({}), []);
  });

  it('shows the banner only while letters wait', () => {
    assert.equal(waitingBanner({ waiting: 0 }), null);
    assert.deepEqual(waitingBanner({ waiting: 2, soonestExpiresAt: '2026-10-03T10:00:00Z' }), { count: 2, soonest: '2026-10-03T10:00:00Z' });
  });
});

describe('the window form', () => {
  it('round-trips a datetime-local value through ISO', () => {
    const iso = fromLocalInput('2026-10-02T10:30');
    assert.equal(toLocalInput(iso), '2026-10-02T10:30');
    assert.equal(fromLocalInput(''), null);
    assert.equal(toLocalInput(null), '');
  });

  it('needs a start (not to close), an end after it and a reason', () => {
    assert.equal(outageFormError({ start: '', reason: 'x' }), 'admin.outages.errorStart');
    assert.equal(outageFormError({ end: '', reason: 'Back' }, { requireStart: false }), null);
    assert.equal(outageFormError({ start: '2026-10-02T10:30', end: '2026-10-02T10:00', reason: 'x' }), 'admin.outages.errorEndBeforeStart');
    assert.equal(outageFormError({ start: '2026-10-02T10:30', reason: '  ' }), 'admin.outages.errorReason');
    assert.equal(outageFormError({ start: '2026-10-02T10:30', reason: 'x'.repeat(501) }), 'admin.outages.errorReasonTooLong');
    assert.equal(outageFormError({ start: '2026-10-02T10:30', end: 'nope', reason: 'x' }), 'admin.outages.errorEnd');
    assert.equal(outageFormError({ start: '2026-10-02T10:30', reason: 'Maintenance' }), null);
  });
});
