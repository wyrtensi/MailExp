import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { createPrefSaveQueue } from './prefSaveQueue.js';

function harness({ saveImpl, exitImpl } = {}) {
  const saves = [];
  const exitSaves = [];
  const errors = [];
  const queue = createPrefSaveQueue({
    save: (p) => { saves.push(p); return saveImpl ? saveImpl(p) : Promise.resolve({ ok: true }); },
    saveOnExit: (p) => { exitSaves.push(p); return exitImpl ? exitImpl(p) : Promise.resolve({ ok: true }); },
    delayMs: 1000,
    onError: (err, keys) => errors.push({ message: err?.message ?? String(err), keys }),
  });
  return { queue, saves, exitSaves, errors };
}

// A deferred save the test settles by hand, to hold a write "on the wire".
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
// Lets a save's promise callbacks run. Saves are serialized, so a test that sends twice has to
// let the first one settle. setImmediate is real here; only setTimeout is mocked.
const settle = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => { mock.timers.reset(); });

describe('debouncing', () => {
  test('does not send before the delay elapses', () => {
    const { queue, saves } = harness();
    queue.schedule({ theme: 'dark' });
    mock.timers.tick(999);
    assert.equal(saves.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(saves, [{ theme: 'dark' }]);
  });

  test('coalesces rapid changes into one write', () => {
    const { queue, saves } = harness();
    queue.schedule({ theme: 'dark' });
    mock.timers.tick(300);
    queue.schedule({ fontSize: '110' });
    mock.timers.tick(300);
    queue.schedule({ theme: 'light' });   // later value wins
    mock.timers.tick(1000);
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0], { theme: 'light', fontSize: '110' });
  });

  test('clears the queue after sending, so the next write is independent', async () => {
    const { queue, saves } = harness();
    queue.schedule({ theme: 'dark' });
    mock.timers.tick(1000);
    await settle();
    queue.schedule({ pageSize: '50' });
    mock.timers.tick(1000);
    assert.deepEqual(saves, [{ theme: 'dark' }, { pageSize: '50' }]);
  });
});

describe('flush: the lost-write bug (#417 follow-up)', () => {
  test('sends immediately instead of waiting out the debounce', () => {
    // The reported failure: select a setting, reload within the second, write never
    // happens, and the next load hydrates the older server value back over it.
    const { queue, saves, exitSaves } = harness();
    queue.schedule({ defaultSender: 'account:abc' });
    queue.flush({ exiting: true });
    assert.equal(saves.length, 0, 'must not use the normal sender when exiting');
    assert.deepEqual(exitSaves, [{ defaultSender: 'account:abc' }]);
  });

  test('uses the ordinary sender when not exiting', () => {
    const { queue, saves, exitSaves } = harness();
    queue.schedule({ theme: 'dark' });
    queue.flush();
    assert.deepEqual(saves, [{ theme: 'dark' }]);
    assert.equal(exitSaves.length, 0);
  });

  test('cancels the pending timer so the write is not sent twice', () => {
    const { queue, saves, exitSaves } = harness();
    queue.schedule({ theme: 'dark' });
    queue.flush({ exiting: true });
    mock.timers.tick(5000);
    assert.equal(exitSaves.length, 1);
    assert.equal(saves.length, 0, 'the debounce must not fire after a flush');
  });

  test('is a no-op when nothing is queued', () => {
    const { queue, saves, exitSaves } = harness();
    queue.flush({ exiting: true });
    queue.flush();
    assert.equal(saves.length + exitSaves.length, 0, 'an empty flush must not hit the network');
  });

  test('falls back to the normal sender if no exit sender was provided', () => {
    const saves = [];
    const q = createPrefSaveQueue({ save: (p) => { saves.push(p); return Promise.resolve(); }, delayMs: 1000 });
    q.schedule({ theme: 'dark' });
    q.flush({ exiting: true });
    assert.deepEqual(saves, [{ theme: 'dark' }]);
  });
});

describe('cancel', () => {
  test('drops queued writes without sending them', () => {
    // Logout and account switch: a pending write belongs to the previous session.
    const { queue, saves, exitSaves } = harness();
    queue.schedule({ theme: 'dark' });
    queue.cancel();
    mock.timers.tick(5000);
    assert.equal(saves.length + exitSaves.length, 0);
  });

  test('a flush after cancel sends nothing', () => {
    const { queue, saves, exitSaves } = harness();
    queue.schedule({ theme: 'dark' });
    queue.cancel();
    queue.flush({ exiting: true });
    assert.equal(saves.length + exitSaves.length, 0);
  });
});

describe('failures are reported, not swallowed', () => {
  test('a rejected save reaches onError with the affected keys', async () => {
    const { queue, errors } = harness({ saveImpl: () => Promise.reject(new Error('400 Bad Request')) });
    queue.schedule({ defaultSender: 'account:bad', theme: 'dark' });
    mock.timers.tick(1000);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, '400 Bad Request');
    assert.deepEqual(errors[0].keys.sort(), ['defaultSender', 'theme']);
  });

  test('a synchronous throw is reported too', () => {
    const { queue, errors } = harness({ saveImpl: () => { throw new Error('offline'); } });
    queue.schedule({ theme: 'dark' });
    mock.timers.tick(1000);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'offline');
  });

  test('a failed write does not block later writes', async () => {
    // Deliberately no retry: re-queueing a permanently rejected key (a value the server
    // validates and refuses) would poison every subsequent batch.
    const { queue, saves, errors } = harness({ saveImpl: () => Promise.reject(new Error('nope')) });
    queue.schedule({ bad: 'x' });
    mock.timers.tick(1000);
    await settle();
    queue.schedule({ good: 'y' });
    mock.timers.tick(1000);
    assert.deepEqual(saves, [{ bad: 'x' }, { good: 'y' }]);
    assert.equal(queue.hasPending(), false, 'a failed batch must not stay queued');
    await settle();   // let the rejections settle
    assert.equal(errors.length, 2, 'both failures reported');
  });

  test('survives a save that returns nothing at all', () => {
    const { queue, errors } = harness({ saveImpl: () => undefined });
    queue.schedule({ theme: 'dark' });
    assert.doesNotThrow(() => mock.timers.tick(1000));
    assert.equal(errors.length, 0);
  });
});

describe('serialized writes: an older save cannot land after a newer one', () => {
  // The server merges each PATCH in the order it executes them and knows nothing about the
  // order of the user's clicks. Two saves in flight at once could execute in either order,
  // so picking "dusk" and then "daylight" could end with "dusk" saved.
  test('the next save starts only after the previous one settles', async () => {
    const first = deferred();
    const { queue, saves } = harness({ saveImpl: (p) => (p.theme === 'dusk' ? first.promise : Promise.resolve()) });
    queue.schedule({ theme: 'dusk' });
    mock.timers.tick(1000);
    queue.schedule({ theme: 'daylight' });
    mock.timers.tick(1000);
    await settle();
    assert.deepEqual(saves, [{ theme: 'dusk' }], 'the newer save must wait for the older one');
    assert.equal(queue.hasPending(), true, 'the held write still counts as pending');
    first.resolve();
    await settle();
    assert.deepEqual(saves, [{ theme: 'dusk' }, { theme: 'daylight' }]);
    assert.equal(queue.hasPending(), false);
  });

  test('writes held behind an in-flight save are coalesced and keep the latest value', async () => {
    const first = deferred();
    const { queue, saves } = harness({ saveImpl: () => (saves.length === 1 ? first.promise : Promise.resolve()) });
    queue.schedule({ theme: 'dusk' });
    mock.timers.tick(1000);
    queue.schedule({ theme: 'daylight', fontSize: '110' });
    mock.timers.tick(1000);
    queue.schedule({ theme: 'night' });
    mock.timers.tick(1000);
    first.resolve();
    await settle();
    assert.deepEqual(saves, [{ theme: 'dusk' }, { theme: 'night', fontSize: '110' }]);
  });

  test('a failed save still releases the held one', async () => {
    const first = deferred();
    const { queue, saves, errors } = harness({ saveImpl: () => (saves.length === 1 ? first.promise : Promise.resolve()) });
    queue.schedule({ theme: 'dusk' });
    mock.timers.tick(1000);
    queue.schedule({ theme: 'daylight' });
    mock.timers.tick(1000);
    first.reject(new Error('502'));
    await settle();
    assert.deepEqual(saves, [{ theme: 'dusk' }, { theme: 'daylight' }]);
    assert.deepEqual(errors, [{ message: '502', keys: ['theme'] }]);
  });

  test('an exit flush sends held writes at once instead of waiting for the save in flight', async () => {
    // The page is going away: a write held until the previous one settles would never be sent.
    const first = deferred();
    const { queue, saves, exitSaves } = harness({ saveImpl: () => first.promise });
    queue.schedule({ theme: 'dusk' });
    mock.timers.tick(1000);
    queue.schedule({ theme: 'daylight' });
    mock.timers.tick(1000);
    queue.schedule({ fontSize: '110' });
    queue.flush({ exiting: true });
    assert.deepEqual(exitSaves, [{ theme: 'daylight', fontSize: '110' }]);
    first.resolve();
    await settle();
    assert.deepEqual(saves, [{ theme: 'dusk' }], 'nothing is sent twice after the exit flush');
  });

  test('after an exit flush, later writes wait for both saves in flight', async () => {
    // visibilitychange counts as exit too, so the page can stay and keep writing.
    const first = deferred();
    const onExit = deferred();
    const { queue, saves, exitSaves } = harness({
      saveImpl: () => (saves.length === 1 ? first.promise : Promise.resolve()),
      exitImpl: () => onExit.promise,
    });
    queue.schedule({ theme: 'dusk' });
    mock.timers.tick(1000);
    queue.schedule({ theme: 'daylight' });
    queue.flush({ exiting: true });
    queue.schedule({ theme: 'night' });
    mock.timers.tick(1000);
    first.resolve();
    await settle();
    assert.deepEqual(saves, [{ theme: 'dusk' }], 'the exit save is still in flight');
    onExit.resolve();
    await settle();
    assert.deepEqual(exitSaves, [{ theme: 'daylight' }]);
    assert.deepEqual(saves, [{ theme: 'dusk' }, { theme: 'night' }]);
  });

  test('cancel drops a write held behind an in-flight save', async () => {
    const first = deferred();
    const { queue, saves } = harness({ saveImpl: () => first.promise });
    queue.schedule({ theme: 'dusk' });
    mock.timers.tick(1000);
    queue.schedule({ theme: 'daylight' });
    mock.timers.tick(1000);
    queue.cancel();
    assert.equal(queue.hasPending(), false);
    first.resolve();
    await settle();
    assert.deepEqual(saves, [{ theme: 'dusk' }]);
  });
});

describe('hasPending', () => {
  test('tracks the queue accurately across its lifecycle', () => {
    const { queue } = harness();
    assert.equal(queue.hasPending(), false);
    queue.schedule({ theme: 'dark' });
    assert.equal(queue.hasPending(), true);
    mock.timers.tick(1000);
    assert.equal(queue.hasPending(), false);
  });
});
