// What the live-mail socket does when the server closes it. Pure, so it can be unit-tested.
//
// The server closes with 1008 and a reason when the session can no longer receive mail events
// (backend services/websocket.js):
//   'Locked'                         - the session was locked (#235): show the lock screen now
//                                      instead of waiting for the next API call's 423.
//   'Session ended' / 'Unauthorized' - logout, password reset, a disabled user, or no session:
//                                      reconnecting would be refused again. Confirm with one API
//                                      call, whose 401 handling sends the tab to sign-in.
// 4001/4003 are the older auth close codes; they only stop reconnecting.
export const WS_CLOSE_ACTIONS = Object.freeze({
  RECONNECT: 'reconnect',
  STOP: 'stop',
  LOCKED: 'locked',
  SIGNED_OUT: 'signed_out',
});

const NO_RECONNECT_CODES = new Set([4001, 4003]);
const SIGNED_OUT_REASONS = new Set(['Session ended', 'Unauthorized']);

export function wsCloseAction(event) {
  const code = event?.code;
  if (NO_RECONNECT_CODES.has(code)) return WS_CLOSE_ACTIONS.STOP;
  if (code === 1008 && event.reason === 'Locked') return WS_CLOSE_ACTIONS.LOCKED;
  if (code === 1008 && SIGNED_OUT_REASONS.has(event.reason)) return WS_CLOSE_ACTIONS.SIGNED_OUT;
  return WS_CLOSE_ACTIONS.RECONNECT;
}
