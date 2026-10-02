import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  freezeOrder, manualMoveNeighbour, movePinnedId, orderAccounts, pinAccountIds, prunePinnedIds, unpinAccountIds,
} from './accountOrder.js';

const at = (iso) => ({ last_received_at: iso });
const ACCOUNTS = [
  { id: 'a', ...at('2026-09-10T08:00:00.000Z') },
  { id: 'b', ...at('2026-09-12T08:00:00.000Z') },
  { id: 'c' },
  { id: 'd', ...at('2026-09-11T08:00:00.000Z') },
  { id: 'e', ...at(null) },
  { id: 'f', ...at('not a date') },
];
const ids = (list) => list.map(a => a.id);

describe('orderAccounts: latest mail first', () => {
  it('puts the mailbox that received mail most recently on top', () => {
    assert.deepEqual(ids(orderAccounts(ACCOUNTS, { sortByLatest: true })).slice(0, 3), ['b', 'd', 'a']);
  });

  it('keeps mailboxes without mail after those with mail, in their given order', () => {
    assert.deepEqual(ids(orderAccounts(ACCOUNTS, { sortByLatest: true })), ['b', 'd', 'a', 'c', 'e', 'f']);
  });

  it('keeps the given order between mailboxes that received mail at the same moment', () => {
    const same = [{ id: 'x', ...at('2026-09-10T00:00:00Z') }, { id: 'y', ...at('2026-09-10T00:00:00.000Z') }, { id: 'z', ...at('2026-09-11T00:00:00Z') }];
    assert.deepEqual(ids(orderAccounts(same, { sortByLatest: true })), ['z', 'x', 'y']);
  });

  it('is on unless it is switched off', () => {
    assert.deepEqual(ids(orderAccounts(ACCOUNTS)), ['b', 'd', 'a', 'c', 'e', 'f']);
  });

  it('does not touch the input array', () => {
    const copy = ids(ACCOUNTS);
    orderAccounts(ACCOUNTS, { sortByLatest: true });
    assert.deepEqual(ids(ACCOUNTS), copy);
  });

  it('returns the very same array when nothing moves', () => {
    const ordered = [{ id: 'p', ...at('2026-09-12T00:00:00Z') }, { id: 'q', ...at('2026-09-11T00:00:00Z') }, { id: 'r' }];
    assert.equal(orderAccounts(ordered, { sortByLatest: true }), ordered);
    assert.equal(orderAccounts(ACCOUNTS, { sortByLatest: false }), ACCOUNTS);
  });
});

describe('orderAccounts: switched off', () => {
  it('keeps the given order', () => {
    assert.deepEqual(ids(orderAccounts(ACCOUNTS, { sortByLatest: false })), ids(ACCOUNTS));
  });

  it('still floats the pinned ones to the top', () => {
    assert.deepEqual(ids(orderAccounts(ACCOUNTS, { sortByLatest: false, pinnedIds: ['d', 'a'] })), ['d', 'a', 'b', 'c', 'e', 'f']);
  });
});

describe('orderAccounts: pins', () => {
  it('keeps pinned mailboxes on top in the order they were pinned, above the latest-mail order', () => {
    assert.deepEqual(
      ids(orderAccounts(ACCOUNTS, { sortByLatest: true, pinnedIds: ['c', 'a'] })),
      ['c', 'a', 'b', 'd', 'e', 'f'],
    );
  });

  it('orders the pinned ones by pin order, not by their mail', () => {
    assert.deepEqual(ids(orderAccounts(ACCOUNTS, { pinnedIds: ['a', 'b'] })).slice(0, 2), ['a', 'b']);
    assert.deepEqual(ids(orderAccounts(ACCOUNTS, { pinnedIds: ['b', 'a'] })).slice(0, 2), ['b', 'a']);
  });

  it('ignores pins of mailboxes that are gone, and repeats', () => {
    assert.deepEqual(
      ids(orderAccounts(ACCOUNTS, { sortByLatest: true, pinnedIds: ['gone', 'd', 'd', 'also-gone'] })),
      ['d', 'b', 'a', 'c', 'e', 'f'],
    );
  });

  it('tolerates a missing or odd pin list and odd accounts', () => {
    assert.deepEqual(ids(orderAccounts(ACCOUNTS, { pinnedIds: null })), ids(orderAccounts(ACCOUNTS)));
    assert.deepEqual(ids(orderAccounts(ACCOUNTS, { pinnedIds: 'a' })), ids(orderAccounts(ACCOUNTS)));
    assert.deepEqual(orderAccounts(null, {}), []);
    assert.deepEqual(ids(orderAccounts([null, { id: 'k' }], {})), ['k']);
  });
});

describe('freezeOrder', () => {
  it('lays accounts out as the earlier order had them, with their current data', () => {
    const fresh = [{ id: 'x', n: 2 }, { id: 'y', n: 2 }, { id: 'z', n: 2 }];
    const frozen = freezeOrder(['z', 'x', 'y'], fresh);
    assert.deepEqual(ids(frozen), ['z', 'x', 'y']);
    assert.ok(frozen.every(a => a.n === 2), 'each entry is the current account object');
    assert.equal(frozen[0], fresh[2]);
  });

  it('drops accounts that are gone and appends new ones in their given order', () => {
    const frozen = freezeOrder(['z', 'gone', 'x'], [{ id: 'x' }, { id: 'new1' }, { id: 'z' }, { id: 'new2' }]);
    assert.deepEqual(ids(frozen), ['z', 'x', 'new1', 'new2']);
  });

  it('falls back to the given order with no earlier order', () => {
    const fresh = [{ id: 'x' }, { id: 'y' }];
    assert.deepEqual(ids(freezeOrder(null, fresh)), ['x', 'y']);
    assert.deepEqual(ids(freezeOrder([], fresh)), ['x', 'y']);
  });
});

describe('pins', () => {
  it('pinning adds to the end, once', () => {
    assert.deepEqual(pinAccountIds(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(pinAccountIds(['a', 'b'], 'a'), ['a', 'b']);
    assert.deepEqual(pinAccountIds(undefined, 'a'), ['a']);
  });

  it('unpinning removes it and keeps the rest in order', () => {
    assert.deepEqual(unpinAccountIds(['a', 'b', 'c'], 'b'), ['a', 'c']);
    assert.deepEqual(unpinAccountIds(['a'], 'zzz'), ['a']);
    assert.deepEqual(unpinAccountIds(null, 'a'), []);
  });

  it('pruning drops the ids of mailboxes that are gone', () => {
    assert.deepEqual(prunePinnedIds(['c', 'gone', 'a', 'c'], ACCOUNTS), ['c', 'a']);
    assert.deepEqual(prunePinnedIds(['a'], []), []);
    assert.deepEqual(prunePinnedIds('a', ACCOUNTS), []);
  });
});

describe('manualMoveNeighbour', () => {
  const shown = [{ id: 'p1' }, { id: 'p2' }, { id: 'x' }, { id: 'y' }, { id: 'z' }];
  const pinned = ['p1', 'p2'];
  const neighbour = (id, direction, pins = pinned) => manualMoveNeighbour(shown, pins, id, direction)?.id ?? null;

  it('is the next unpinned mailbox in the direction of the move', () => {
    assert.equal(neighbour('y', 'up'), 'x');
    assert.equal(neighbour('y', 'down'), 'z');
  });

  it('is null at the ends of the unpinned ones, pinned neighbours do not count', () => {
    assert.equal(neighbour('x', 'up'), null, 'p2 above it is pinned: not a place to move to');
    assert.equal(neighbour('z', 'down'), null);
  });

  it('is null for a pinned mailbox or one that is not shown', () => {
    assert.equal(neighbour('p1', 'down'), null);
    assert.equal(neighbour('nope', 'up'), null);
  });

  it('counts every mailbox when nothing is pinned', () => {
    assert.equal(neighbour('p1', 'down', []), 'p2');
  });
});

describe('movePinnedId', () => {
  const accounts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('swaps a pinned mailbox with its neighbour', () => {
    assert.deepEqual(movePinnedId(['a', 'b', 'c'], accounts, 'b', 'up'), ['b', 'a', 'c']);
    assert.deepEqual(movePinnedId(['a', 'b', 'c'], accounts, 'b', 'down'), ['a', 'c', 'b']);
  });

  it('is null at the ends and for a mailbox that is not pinned', () => {
    assert.equal(movePinnedId(['a', 'b'], accounts, 'a', 'up'), null);
    assert.equal(movePinnedId(['a', 'b'], accounts, 'b', 'down'), null);
    assert.equal(movePinnedId(['a', 'b'], accounts, 'c', 'up'), null);
  });

  it('skips pins of mailboxes that are gone when looking for the neighbour', () => {
    assert.deepEqual(movePinnedId(['a', 'gone', 'b'], accounts, 'b', 'up'), ['b', 'a']);
  });
});
