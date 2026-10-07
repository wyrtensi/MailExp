// A draft save sends the recipient text still sitting in the To/Cc/Bcc input along with the
// chips. When the save resolves, that text becomes a chip -- but only if the input still holds
// what was sent. Anything typed during the request is newer than the saved draft and must stay.

/**
 * @param {string} submitted the trimmed input text included in the save request
 * @param {string} live      the input's value now
 * @returns {boolean} true when the sent text may be turned into a chip and the input cleared
 */
export function shouldCommitPendingInput(submitted, live) {
  return Boolean(submitted) && String(live ?? '').trim() === submitted;
}
