import assert from 'node:assert/strict';
import test from 'node:test';
import { fromLocalInputValue, sendAtProblem, sendLaterPresets, toLocalInputValue } from './sendLater.js';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test('a weekday morning offers later today, tomorrow morning and Monday morning', () => {
  // 2026-10-01 is a Thursday.
  const presets = sendLaterPresets(local(2026, 10, 1, 9, 30));
  assert.deepEqual(presets.map(p => p.key), ['laterToday', 'tomorrowMorning', 'mondayMorning']);
  assert.deepEqual(presets.map(p => p.at.getTime()), [
    local(2026, 10, 1, 18).getTime(), local(2026, 10, 2, 8).getTime(), local(2026, 10, 5, 8).getTime(),
  ]);
});

test('later today goes once it is less than an hour away', () => {
  assert.deepEqual(sendLaterPresets(local(2026, 10, 1, 17, 1)).map(p => p.key), ['tomorrowMorning', 'mondayMorning']);
  assert.deepEqual(sendLaterPresets(local(2026, 10, 1, 17, 0)).map(p => p.key), ['laterToday', 'tomorrowMorning', 'mondayMorning']);
});

test('on Sunday tomorrow morning is Monday morning, offered once', () => {
  assert.deepEqual(sendLaterPresets(local(2026, 10, 4, 20)).map(p => p.key), ['tomorrowMorning']);
});

test('on Monday the next Monday is a week away', () => {
  const monday = sendLaterPresets(local(2026, 10, 5, 10)).find(p => p.key === 'mondayMorning');
  assert.equal(monday.at.getTime(), local(2026, 10, 12, 8).getTime());
});

test('a datetime-local value round-trips in local time', () => {
  const at = local(2026, 12, 31, 7, 5);
  assert.equal(toLocalInputValue(at), '2026-12-31T07:05');
  assert.equal(fromLocalInputValue('2026-12-31T07:05').getTime(), at.getTime());
  assert.equal(fromLocalInputValue('tomorrow'), null);
  assert.equal(fromLocalInputValue(''), null);
});

test('a chosen time must lie ahead and within a year', () => {
  const now = local(2026, 10, 1, 12);
  assert.equal(sendAtProblem(local(2026, 10, 1, 12, 1), now), null);
  assert.equal(sendAtProblem(now, now), 'past');
  assert.equal(sendAtProblem(local(2026, 9, 30), now), 'past');
  assert.equal(sendAtProblem(local(2027, 11, 1), now), 'tooFar');
  assert.equal(sendAtProblem(null, now), 'invalid');
});
