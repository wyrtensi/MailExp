import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget();

// Compose used to be a single boolean (`composing`) with no notion of minimized, so clicking
// "Написать"/Compose while the (single, global) composer was minimized just re-set composeData
// to a blank message — the mounted ComposeModal instance never noticed anything had happened,
// because minimizing was tracked as its own local React state, invisible to the store. Lifting
// it into the store (composeMinimized) lets openCompose tell the two cases apart.
beforeEach(() => {
  useStore.setState({ composing: false, composeData: null, composeMinimized: false });
});

test('opening a composer when none is open behaves as before: composing, with the given data', () => {
  useStore.getState().openCompose({ subject: 'Hello' });
  const state = useStore.getState();
  assert.equal(state.composing, true);
  assert.deepEqual(state.composeData, { subject: 'Hello' });
  assert.equal(state.composeMinimized, false);
});

test('opening again while the composer is open and NOT minimized replaces the draft as before', () => {
  useStore.getState().openCompose({ subject: 'First' });
  useStore.getState().openCompose({ subject: 'Second' });
  const state = useStore.getState();
  assert.equal(state.composing, true);
  assert.deepEqual(state.composeData, { subject: 'Second' });
});

test('opening while minimized restores it instead of discarding the in-progress draft', () => {
  useStore.getState().openCompose({ subject: 'In progress, not yet sent' });
  useStore.getState().setComposeMinimized(true);
  assert.equal(useStore.getState().composeMinimized, true);

  // The Compose button (or its keyboard shortcut) fires again with fresh "new message" data —
  // it must restore the minimized composer, not replace its data with a blank message.
  useStore.getState().openCompose({ accountId: 'acct-1' });

  const state = useStore.getState();
  assert.equal(state.composing, true);
  assert.equal(state.composeMinimized, false, 'the composer must be restored (un-minimized)');
  assert.deepEqual(state.composeData, { subject: 'In progress, not yet sent' },
    'the minimized draft must be preserved, not overwritten by the new-message request');
});

test('closeCompose always clears the minimized flag along with composing/composeData', () => {
  useStore.getState().openCompose({ subject: 'x' });
  useStore.getState().setComposeMinimized(true);
  useStore.getState().closeCompose();
  const state = useStore.getState();
  assert.equal(state.composing, false);
  assert.equal(state.composeData, null);
  assert.equal(state.composeMinimized, false);
});
