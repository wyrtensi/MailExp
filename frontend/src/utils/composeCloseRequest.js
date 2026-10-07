// Anything that wants the composer closed from outside it (the Android hardware Back button)
// asks the composer instead of closing it: the composer owns the unsaved-changes check and the
// save/discard dialog that its own close button runs.

export const COMPOSE_CLOSE_REQUEST = 'mailexpert:compose-close-request';

/**
 * Asks the open composer to close the way its close button does.
 * @returns {boolean} true when a composer took the request; false when none is listening and the
 *   caller must close it itself.
 */
export function requestComposeClose(target = window) {
  const event = new CustomEvent(COMPOSE_CLOSE_REQUEST, { cancelable: true });
  // dispatchEvent returns false when a listener called preventDefault.
  return !target.dispatchEvent(event);
}

/**
 * Registers the composer's close handler. Returns the function that removes it.
 */
export function onComposeCloseRequest(handler, target = window) {
  const listener = (event) => {
    event.preventDefault();
    handler();
  };
  target.addEventListener(COMPOSE_CLOSE_REQUEST, listener);
  return () => target.removeEventListener(COMPOSE_CLOSE_REQUEST, listener);
}
