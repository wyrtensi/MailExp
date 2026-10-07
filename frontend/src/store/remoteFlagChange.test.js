import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');

// applyRemoteFlagChange is the store side of the WebSocket message_flags event: it keeps a
// conversation row's unread aggregate right (U-14) and says when the change touches a message
// no loaded list holds, so the caller can reload.
beforeEach(() => {
  useStore.setState({ messages: [], searchResults: [], threadMessages: {} });
});

const row = (extra = {}) => ({
  id: 'head', account_id: 'a', thread_id: 't1', is_read: false, unread_count: 3, message_count: 4, ...extra,
});

test('reading the message a row shows lowers the aggregate by one, not to zero', () => {
  useStore.getState().setMessages([row()]);
  assert.equal(useStore.getState().applyRemoteFlagChange('head', { is_read: true }), true);
  const updated = useStore.getState().messages[0];
  assert.equal(updated.is_read, true);
  assert.equal(updated.unread_count, 2);
});

test('unreading the message a row shows raises the aggregate by one', () => {
  useStore.getState().setMessages([row({ is_read: true, unread_count: 1 })]);
  useStore.getState().applyRemoteFlagChange('head', { is_read: false });
  assert.equal(useStore.getState().messages[0].unread_count, 2);
});

test('a cached conversation decides the aggregate when it holds the message', () => {
  useStore.getState().setMessages([row({ unread_count: 3 })]);
  useStore.setState({
    threadMessages: { 'a:t1': [{ id: 'head', is_read: false }, { id: 'c1', is_read: true }, { id: 'c2', is_read: false }] },
  });
  useStore.getState().applyRemoteFlagChange('head', { is_read: true });
  // The cache has one unread message left; the stale aggregate of 3 is not trusted.
  assert.equal(useStore.getState().messages[0].unread_count, 1);
});

test('a cached sub-message change recounts the row', () => {
  useStore.getState().setMessages([row({ unread_count: 2 })]);
  useStore.setState({
    threadMessages: { 'a:t1': [{ id: 'head', is_read: false }, { id: 'c1', is_read: false }] },
  });
  assert.equal(useStore.getState().applyRemoteFlagChange('c1', { is_read: true }), true);
  const updated = useStore.getState().messages[0];
  assert.equal(updated.unread_count, 1);
  assert.equal(updated.is_read, false);
});

test('a message held by no loaded list is reported so the list can reload', () => {
  useStore.getState().setMessages([row()]);
  assert.equal(useStore.getState().applyRemoteFlagChange('uncached-child', { is_read: true }), false);
  assert.equal(useStore.getState().messages[0].unread_count, 3);
});

test('a star change leaves the aggregate alone', () => {
  useStore.getState().setMessages([row()]);
  useStore.getState().applyRemoteFlagChange('head', { is_starred: true });
  const updated = useStore.getState().messages[0];
  assert.equal(updated.is_starred, true);
  assert.equal(updated.unread_count, 3);
});
