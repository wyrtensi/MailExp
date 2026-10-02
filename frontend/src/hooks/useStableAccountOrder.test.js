import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStableAccountOrder } = await import('./useStableAccountOrder.js');

const acc = (id, at) => ({ id, last_received_at: at, tag: 0 });
const A = acc('a', '2026-09-10T00:00:00Z');
const B = acc('b', '2026-09-11T00:00:00Z');
const C = acc('c', null);

describe('useStableAccountOrder', () => {
  let root;
  let seen;

  const Probe = (props) => {
    const ordered = useStableAccountOrder(props.accounts, props.options);
    seen = ordered;
    return null;
  };
  const render = (accounts, options) => React.act(async () => {
    root.render(React.createElement(Probe, { accounts, options }));
  });
  const ids = () => seen.map(a => a.id);

  beforeEach(() => {
    root = createRoot(document.getElementById('root'));
    seen = null;
  });
  afterEach(async () => { await React.act(async () => root.unmount()); });

  const NO_PINS = [];
  const base = { pinnedIds: NO_PINS, sortByLatest: true, frozen: false };

  test('orders by latest mail, pins first', async () => {
    await render([A, B, C], base);
    assert.deepEqual(ids(), ['b', 'a', 'c']);
    await render([A, B, C], { ...base, pinnedIds: ['c'] });
    assert.deepEqual(ids(), ['c', 'b', 'a']);
  });

  test('a re-render with the same data moves nothing', async () => {
    const list = [A, B, C];
    await render(list, base);
    const first = seen;
    await render(list, { ...base });
    assert.deepEqual(ids(), ['b', 'a', 'c']);
    assert.equal(seen, first, 'the very same array: nothing downstream re-computes');
  });

  test('new account objects with the same dates keep the order', async () => {
    await render([A, B, C], base);
    await render([{ ...A, sync_error: 'x' }, { ...B, tag: 1 }, { ...C }], base);
    assert.deepEqual(ids(), ['b', 'a', 'c']);
  });

  test('holds the order while frozen, even when mail arrives, and shows current data', async () => {
    await render([A, B, C], base);
    assert.deepEqual(ids(), ['b', 'a', 'c']);

    const AFresh = { ...A, last_received_at: '2026-09-12T00:00:00Z', tag: 7 };
    await render([AFresh, B, C], { ...base, frozen: true });
    assert.deepEqual(ids(), ['b', 'a', 'c'], 'a must not jump above b while the menu is open');
    assert.equal(seen[1].tag, 7, 'the row still carries the current account');

    await render([AFresh, B, C], { ...base, frozen: false });
    assert.deepEqual(ids(), ['a', 'b', 'c'], 'it follows once the interaction is over');
  });

  test('stays frozen across many renders and pin changes until released', async () => {
    await render([A, B, C], base);
    await render([A, B, C], { ...base, frozen: true });
    await render([A, B, C], { ...base, frozen: true, pinnedIds: ['c'] });
    assert.deepEqual(ids(), ['b', 'a', 'c']);
    await render([A, B, C], { ...base, frozen: false, pinnedIds: ['c'] });
    assert.deepEqual(ids(), ['c', 'b', 'a']);
  });

  test('a mailbox added while frozen shows at the end; one removed disappears', async () => {
    await render([A, B, C], base);
    const D = acc('d', '2026-09-20T00:00:00Z');
    await render([A, C, D], { ...base, frozen: true });
    assert.deepEqual(ids(), ['a', 'c', 'd']);
  });

  test('frozen from the very first render has nothing to hold and shows the live order', async () => {
    await render([A, B, C], { ...base, frozen: true });
    assert.deepEqual(ids(), ['b', 'a', 'c']);
  });
});
