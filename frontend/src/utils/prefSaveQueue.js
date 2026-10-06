// Batching queue for user preference writes.
//
// Preferences are saved on a debounce so that dragging a slider or clicking through
// options does not produce a request per keystroke. The original implementation had two
// gaps that between them lost settings silently:
//
//   1. Nothing flushed the queue when the page went away. Change a setting and reload or
//      navigate inside the debounce window and the write never happened. Worse, the value
//      was already in localStorage, so the UI looked correct until the next load, when
//      loadPreferences overwrote it with the older server value. The setting appeared to
//      revert on its own, which is impossible to attribute to a timing window.
//   2. The failure path was `.catch(() => {})`. A save that failed said nothing, anywhere.
//
// Writes are also serialized: the next save starts only after the previous one settles. The
// server merges each PATCH in the order it executes them, so two saves in flight at once could
// land out of order and an older value would overwrite the user's latest choice. Batches that
// become due while a save is in flight are held and coalesced, later values winning.
//
// The queue takes its save functions as dependencies so this behaviour can be tested
// without a network or a DOM.

// How long a save may stay unsettled before later writes stop waiting for it.
export const PREF_SAVE_SETTLE_TIMEOUT_MS = 20_000;

export function createPrefSaveQueue({
  save, saveOnExit, delayMs = 1000, settleTimeoutMs = PREF_SAVE_SETTLE_TIMEOUT_MS, onError,
} = {}) {
  let timer = null;
  let pending = {};
  let inFlight = 0; // saves sent and not yet settled; more than one only after an exit flush
  let held = {};

  const takePending = () => {
    const taken = pending;
    pending = {};
    return taken;
  };

  const takeHeld = () => {
    const taken = held;
    held = {};
    return taken;
  };

  const send = (prefs, exiting) => {
    const keys = Object.keys(prefs);
    if (!keys.length) return;
    if (inFlight > 0 && !exiting) {
      Object.assign(held, prefs);
      return;
    }
    // On exit prefer the keepalive sender: a normal fetch is cancelled when the document
    // goes away, which is the whole failure this queue exists to prevent.
    const fn = (exiting && saveOnExit) || save;
    let result;
    try {
      result = fn(prefs);
    } catch (err) {
      onError?.(err, keys);
      return;
    }
    if (!result || typeof result.then !== 'function') return;
    inFlight += 1;
    // Released once, by whichever comes first: the save settling or the settle timeout. The
    // request layer has no timeout of its own, so a hung save would otherwise hold every later
    // write for the rest of the session. A save that answers after its timeout still reports
    // a failure, but no longer counts as in flight.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(settleTimer);
      inFlight -= 1;
      if (inFlight === 0) send(takeHeld(), false);
    };
    const settleTimer = setTimeout(release, settleTimeoutMs);
    result
      .then(null, err => onError?.(err, keys))
      .then(release);
  };

  return {
    /** Queue preferences and (re)start the debounce. */
    schedule(prefs) {
      Object.assign(pending, prefs);
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        send(takePending(), false);
      }, delayMs);
    },

    /**
     * Send whatever is queued right now, cancelling the debounce.
     *
     * Called when the page is being hidden or unloaded, where waiting out the debounce
     * means the write is simply lost. Safe to call when nothing is pending.
     *
     * On exit, writes held behind a save still in flight go out at once with the rest:
     * waiting for that save to settle would lose them with the page. This is the one case
     * where two saves can overlap.
     */
    flush({ exiting = false } = {}) {
      clearTimeout(timer);
      timer = null;
      send(exiting ? { ...takeHeld(), ...takePending() } : takePending(), exiting);
    },

    /**
     * Drop everything queued without sending.
     *
     * Used on logout and account switch: a pending write belongs to the previous session,
     * so letting it fire would either save into the next user's account or hit a dead one.
     */
    cancel() {
      clearTimeout(timer);
      timer = null;
      pending = {};
      held = {};
    },

    /** Whether anything is waiting to be written. Exposed for tests and diagnostics. */
    hasPending() {
      return Object.keys(pending).length > 0 || Object.keys(held).length > 0;
    },
  };
}
