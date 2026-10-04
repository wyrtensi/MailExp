import { describe, expect, it } from 'vitest';
import { fmtDate, fmtValue, keyValues, table } from './output.js';

describe('fmtDate', () => {
  it('prints a date or an ISO string to the minute in UTC, and - for none', () => {
    expect(fmtDate('2026-10-04T09:05:59.000Z')).toBe('2026-10-04 09:05Z');
    expect(fmtDate(new Date('2026-10-04T09:05:00Z'))).toBe('2026-10-04 09:05Z');
    expect(fmtDate(null)).toBe('-');
    expect(fmtDate('not a date')).toBe('not a date');
  });
});

describe('fmtValue', () => {
  it('prints booleans, lists, objects and empty values readably', () => {
    expect(fmtValue(true)).toBe('yes');
    expect(fmtValue(false)).toBe('no');
    expect(fmtValue(['a', 'b'])).toBe('a, b');
    expect(fmtValue([])).toBe('-');
    expect(fmtValue('')).toBe('-');
    expect(fmtValue({ a: 1 })).toBe('{"a":1}');
    expect(fmtValue(0)).toBe('0');
  });
});

describe('table', () => {
  it('pads every column but the last to its widest cell', () => {
    const lines = table([{ a: 'x', b: 'long value' }, { a: 'longer', b: null }], [
      { header: 'A', value: (r) => r.a },
      { header: 'B', value: (r) => r.b },
    ]);
    expect(lines).toEqual(['A       B', 'x       long value', 'longer  -']);
  });

  it('answers the empty text for no rows and folds line breaks in a cell', () => {
    expect(table([], [{ header: 'A', value: () => 1 }], { empty: 'nothing' })).toEqual(['nothing']);
    expect(table([{ a: 'one\ntwo' }], [{ header: 'A', value: (r) => r.a }])).toEqual(['A', 'one two']);
  });
});

describe('keyValues', () => {
  it('aligns the keys and leaves out undefined values', () => {
    expect(keyValues([['state', 'ready'], ['next step', null], ['skip', undefined]])).toEqual(['state:     ready', 'next step: -']);
  });
});
