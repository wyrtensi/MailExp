import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccessSyncScheduler } from './scheduler.js';

const DEBOUNCE = 1_000;
const INTERVAL = 60_000;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const instantRun = () => vi.fn(async (trigger) => ({ outcome: 'unchanged', trigger }));

// Runs that stay in progress until the test finishes them.
function heldRuns() {
  const pending = [];
  const run = vi.fn((trigger) => new Promise((resolve) => { pending.push(() => resolve({ outcome: 'unchanged', trigger })); }));
  const finish = async () => {
    pending.shift()();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { run, finish };
}

const scheduler = (run) => createAccessSyncScheduler({ run, debounceMs: DEBOUNCE, intervalMs: INTERVAL });

describe('access sync scheduler', () => {
  it('ignores requests until started, then runs shortly after start and every interval', async () => {
    const run = instantRun();
    const s = scheduler(run);
    s.request('user_added');
    await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
    expect(run).not.toHaveBeenCalled();

    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.mock.calls.map(([trigger]) => trigger)).toEqual(['startup']);

    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(run.mock.calls.map(([trigger]) => trigger)).toEqual(['startup', 'schedule', 'schedule']);
    s.stop();
  });

  it('merges a burst of requests into one run', async () => {
    const run = instantRun();
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    s.request('a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    s.request('b');
    s.request('c');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(run.mock.calls.map(([trigger]) => trigger)).toEqual(['startup', 'c']);
    s.stop();
  });

  it('runs once more after a run when asked during it, however often', async () => {
    const { run, finish } = heldRuns();
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    s.request('user_added');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    s.request('user_changed');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(run).toHaveBeenCalledTimes(1);

    await finish();
    expect(run.mock.calls.map(([trigger]) => trigger)).toEqual(['startup', 'user_added']);
    await finish();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('runs now on demand, joining a run that has not started, even when not started', async () => {
    const { run, finish } = heldRuns();
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const first = s.runNow();
    const second = s.runNow();
    expect(second).toBe(first);
    await finish();
    await finish();
    expect(await first).toEqual({ outcome: 'unchanged', trigger: 'manual' });
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();

    const idle = scheduler(instantRun());
    expect(await idle.runNow()).toEqual({ outcome: 'unchanged', trigger: 'manual' });
  });

  it('never lets a settings change overlap a run', async () => {
    const { run, finish } = heldRuns();
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const order = [];
    const saved = s.exclusive(async () => { order.push('save'); });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    await finish();
    await saved;
    expect(order).toEqual(['save']);
    s.stop();
  });

  it('keeps going after a failed run and logs only the error code', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('failed for a@example.com'), { code: 'ECONNREFUSED' }))
      .mockResolvedValue({ outcome: 'unchanged' });
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(errorSpy).toHaveBeenCalledWith('[access-sync] Run failed:', 'ECONNREFUSED');
    s.request('user_added');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
    errorSpy.mockRestore();
  });

  it('runs a retry at the time a failed run asked for, and a later run replaces it', async () => {
    const run = vi.fn(async (trigger) => (trigger === 'startup'
      ? { outcome: 'failed', nextRetryAt: new Date(Date.now() + 5_000).toISOString() }
      : { outcome: 'unchanged', nextRetryAt: null }));
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(run.mock.calls.map(([trigger]) => trigger)).toEqual(['startup']);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.mock.calls.map(([trigger]) => trigger)).toEqual(['startup', 'retry']);
    // A started scheduler tells the run it can retry; a stopped one does not.
    expect(run.mock.calls[0][1]).toEqual({ canRetry: true });
    s.stop();
    await s.runNow('manual');
    expect(run.mock.calls.at(-1)).toEqual(['manual', { canRetry: false }]);
    run.mockClear();

    // A run that ends before the retry is due cancels it when it needs none.
    run.mockClear();
    run.mockImplementation(async (trigger) => (trigger === 'startup'
      ? { outcome: 'failed', nextRetryAt: new Date(Date.now() + 5_000).toISOString() }
      : { outcome: 'unchanged', nextRetryAt: null }));
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await s.runNow('manual');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.mock.calls.map(([trigger]) => trigger)).toEqual(['startup', 'manual']);
    s.stop();
  });

  it('stops every timer', async () => {
    const run = instantRun();
    const s = scheduler(run);
    s.start();
    s.stop();
    s.request('user_added');
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(run).not.toHaveBeenCalled();
  });
});
