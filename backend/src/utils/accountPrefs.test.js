import { describe, expect, it } from 'vitest';
import { MAX_PINNED_ACCOUNTS, sanitizePinnedAccounts } from './accountPrefs.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('sanitizePinnedAccounts', () => {
  it('keeps account ids in the order they were pinned', () => {
    expect(sanitizePinnedAccounts([id(3), id(1), id(2)])).toEqual([id(3), id(1), id(2)]);
  });

  it('drops anything that is not an account id', () => {
    expect(sanitizePinnedAccounts([id(1), 'nope', 42, null, {}, [], '', `${id(2)} `, id(3)]))
      .toEqual([id(1), id(3)]);
  });

  it('keeps the first place of a repeated id, whatever its letter case', () => {
    expect(sanitizePinnedAccounts([id(1), id(2), id(1), id(2).toUpperCase()])).toEqual([id(1), id(2)]);
  });

  it('lets an empty array through: it clears the pins', () => {
    expect(sanitizePinnedAccounts([])).toEqual([]);
  });

  it('returns null for a value that is not an array, meaning leave the stored list alone', () => {
    for (const value of [undefined, null, 'x', 7, {}, true]) expect(sanitizePinnedAccounts(value)).toBeNull();
  });

  it('cuts the list at the cap', () => {
    const many = Array.from({ length: MAX_PINNED_ACCOUNTS + 25 }, (_, i) => id(i + 1));
    expect(sanitizePinnedAccounts(many)).toEqual(many.slice(0, MAX_PINNED_ACCOUNTS));
  });
});
