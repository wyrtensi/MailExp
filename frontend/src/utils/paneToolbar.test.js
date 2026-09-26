import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_LABELS, LABEL_RANK, fewerLabels, initialLabelCount, showsLabel } from './paneToolbar.js';

describe('toolbar names', () => {
  it('tries every name on a measured desktop toolbar and none on a phone or before measuring', () => {
    assert.equal(initialLabelCount(700, false), ALL_LABELS);
    assert.equal(initialLabelCount(700, true), 0);
    assert.equal(initialLabelCount(0, false), 0);
  });

  it('gives names up from the least used button, keeping reply, forward, archive and delete longest', () => {
    const order = Object.entries(LABEL_RANK).sort((a, b) => a[1] - b[1]).map(([kind]) => kind);
    assert.deepEqual(order.slice(0, 4), ['reply', 'forward', 'archive', 'delete']);
    assert.equal(showsLabel('reply', 1), true);
    assert.equal(showsLabel('forward', 1), false);
    assert.equal(showsLabel('delete', 4), true);
    assert.equal(showsLabel('ai', ALL_LABELS - 1), false);
    assert.equal(showsLabel('unknown', ALL_LABELS), false);
  });

  it('places the desktop .eml download between print and the overflow-prone task/ai buttons', () => {
    assert.ok(LABEL_RANK.print < LABEL_RANK.eml, 'eml ranks after print');
    assert.ok(LABEL_RANK.eml < LABEL_RANK.task, 'eml ranks before task');
    assert.equal(showsLabel('eml', LABEL_RANK.eml), true);
    assert.equal(showsLabel('eml', LABEL_RANK.eml - 1), false);
  });

  it('drops one name per overflow and stops at icons only', () => {
    assert.equal(fewerLabels(3), 2);
    assert.equal(fewerLabels(0), 0);
  });
});
