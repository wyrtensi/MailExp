import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateLanguage, formatDate, formatDateTime, formatDay, localeTag, setDateLanguage } from './formatDate.js';

// Local-time dates relative to now, so the expectations hold in any timezone.
function localDate(daysAgo, hours, minutes) {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

test('formatDate shows a 12-hour time for today', () => {
  assert.equal(formatDate(localDate(0, 9, 5).toISOString()), '9:05 AM');
  assert.equal(formatDate(localDate(0, 15, 30).toISOString()), '3:30 PM');
});

test('formatDate labels yesterday', () => {
  assert.equal(formatDate(localDate(1, 12, 0).toISOString()), 'Yesterday');
});

test('formatDate shows month and day for older dates in the current year, and adds the year otherwise', () => {
  const now = new Date();
  // Pick a date in the current year that is neither today nor yesterday.
  const thisYear = now.getMonth() === 0 && now.getDate() <= 2
    ? null
    : new Date(now.getFullYear(), 0, 1, 12, 0, 0);
  if (thisYear) {
    assert.equal(formatDate(thisYear.toISOString()), 'Jan 1');
  }
  const lastYear = new Date(now.getFullYear() - 1, 2, 7, 12, 0, 0);
  assert.equal(formatDate(lastYear.toISOString()), `Mar 7, ${now.getFullYear() - 1}`);
});

test('formatDate returns an empty string for missing or invalid input', () => {
  assert.equal(formatDate(''), '');
  assert.equal(formatDate(null), '');
  assert.equal(formatDate(undefined), '');
  assert.equal(formatDate('not a date'), '');
});

test('formatDate in Russian: 24-hour time, Вчера, day before month', () => {
  assert.equal(formatDate(localDate(0, 15, 30).toISOString(), 'ru'), '15:30');
  assert.equal(formatDate(localDate(1, 12, 0).toISOString(), 'ru'), 'Вчера');
  const lastYear = new Date(new Date().getFullYear() - 1, 2, 7, 12, 0, 0);
  assert.equal(formatDate(lastYear.toISOString(), 'ru'), `7 мар. ${lastYear.getFullYear()}`);
});

test('the interface language set by i18n is the default, and anything unknown reads as English', () => {
  const lastYear = new Date(new Date().getFullYear() - 1, 8, 16, 8, 45, 0);
  setDateLanguage('ru');
  try {
    assert.equal(dateLanguage(), 'ru');
    assert.equal(formatDay(lastYear), `16 сент. ${lastYear.getFullYear()}`);
    assert.equal(formatDateTime(lastYear), `16 сент. ${lastYear.getFullYear()}, 08:45`);
    assert.equal(formatDateTime(lastYear, { withYear: false }), '16 сент., 08:45');
    assert.equal(localeTag(), 'ru-RU');
  } finally {
    setDateLanguage('xx');
  }
  assert.equal(dateLanguage(), 'en');
  assert.equal(formatDateTime(lastYear), `Sep 16, ${lastYear.getFullYear()} 8:45 AM`);
  assert.equal(localeTag(), 'en-US');
  assert.equal(formatDay('nope'), '');
});

test('a date and time with seconds, where they tell events apart', () => {
  const at = new Date(new Date().getFullYear() - 1, 9, 4, 21, 12, 9);
  assert.equal(formatDateTime(at, { seconds: true, lang: 'ru' }), `4 окт. ${at.getFullYear()}, 21:12:09`);
  assert.equal(formatDateTime(at, { seconds: true, lang: 'en' }), `Oct 4, ${at.getFullYear()} 9:12:09 PM`);
  assert.equal(formatDateTime(at, { seconds: true, withYear: false, lang: 'ru' }), '4 окт., 21:12:09');
  assert.equal(formatDateTime('nope', { seconds: true }), '');
});
