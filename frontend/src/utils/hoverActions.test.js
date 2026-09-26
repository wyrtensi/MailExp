import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HOVER_ACTION_KEYS, DEFAULT_HOVER_ACTIONS, sanitizeHoverActionSet } from './hoverActions.js';

describe('sanitizeHoverActionSet (#440)', () => {
  it('reorders to canonical order regardless of input order', () => {
    assert.deepEqual(sanitizeHoverActionSet(['move', 'markRead', 'archive']), ['markRead', 'archive', 'move']);
  });

  it('drops unknown keys instead of storing them', () => {
    assert.deepEqual(sanitizeHoverActionSet(['snooze', 'bogus', 'archive']), ['archive', 'snooze']);
  });

  it('deduplicates repeats of the same key', () => {
    assert.deepEqual(sanitizeHoverActionSet(['star', 'star', 'delete']), ['star', 'delete']);
  });

  it('returns an empty array for non-array input, not a guess at the default', () => {
    assert.deepEqual(sanitizeHoverActionSet(null), []);
    assert.deepEqual(sanitizeHoverActionSet(undefined), []);
    assert.deepEqual(sanitizeHoverActionSet('markRead'), []);
  });

  it('the default cluster is a subset of the canonical vocabulary, in canonical order', () => {
    assert.deepEqual(sanitizeHoverActionSet(DEFAULT_HOVER_ACTIONS), DEFAULT_HOVER_ACTIONS);
    for (const key of DEFAULT_HOVER_ACTIONS) assert.ok(HOVER_ACTION_KEYS.includes(key));
  });
});
