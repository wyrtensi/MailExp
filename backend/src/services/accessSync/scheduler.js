// Runs the Access sync one at a time in this process: user changes request a run, which waits a
// few seconds so a burst of changes becomes one run; a full reconcile runs every hour. MailExpert
// runs as a single backend container, so an in-process queue is enough.
export const DEBOUNCE_MS = 10_000;
export const INTERVAL_MS = 60 * 60_000;

const logFailure = (err) => console.error('[access-sync] Run failed:', err?.code || err?.name || 'Error');

//
// A run that failed for a reason that may pass (runner.js: the network, a timeout, Cloudflare's 5xx
// or 429) answers the time of its retry in nextRetryAt; the scheduler runs it then with the
// trigger 'retry'. Whatever run ends next replaces that timer with its own answer.
export function createAccessSyncScheduler({
  run, debounceMs = DEBOUNCE_MS, intervalMs = INTERVAL_MS, now = () => Date.now(),
}) {
  let tail = Promise.resolve();
  let queuedRun = null;
  let debounceTimer = null;
  let intervalTimer = null;
  let retryTimer = null;

  function scheduleRetry(result) {
    clearTimeout(retryTimer);
    retryTimer = null;
    const at = Date.parse(result?.nextRetryAt ?? '');
    if (!intervalTimer || Number.isNaN(at)) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      queueRun('retry').catch(logFailure);
    }, Math.max(0, at - now()));
    retryTimer.unref?.();
  }

  // Runs op after everything queued before it, so runs and settings changes never overlap.
  function exclusive(op) {
    const result = tail.then(() => op());
    tail = result.then(() => {}, () => {});
    return result;
  }

  // A run that has not started yet serves every later request: it reads the users when it starts.
  function queueRun(trigger) {
    if (!queuedRun) {
      queuedRun = exclusive(async () => {
        queuedRun = null;
        const result = await run(trigger);
        scheduleRetry(result);
        return result;
      });
    }
    return queuedRun;
  }

  function request(trigger) {
    if (!intervalTimer) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      queueRun(trigger).catch(logFailure);
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function start() {
    if (intervalTimer) return;
    intervalTimer = setInterval(() => { queueRun('schedule').catch(logFailure); }, intervalMs);
    intervalTimer.unref?.();
    request('startup');
  }

  function stop() {
    clearInterval(intervalTimer);
    clearTimeout(debounceTimer);
    clearTimeout(retryTimer);
    intervalTimer = null;
    debounceTimer = null;
    retryTimer = null;
  }

  function runNow(trigger = 'manual') {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    return queueRun(trigger);
  }

  return { start, stop, request, runNow, exclusive };
}
