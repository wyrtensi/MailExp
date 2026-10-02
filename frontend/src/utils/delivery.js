// What the screens say about a sent letter's delivery (R-17): the list's mark (delivery_state of a
// list row: 'failed' or 'delayed', backend services/deliveryStatus.js deliveryStateColumn) and the
// rows of "Delivery details" (GET /api/mail/messages/:id/delivery). Pure: the components
// DeliveryMarker and DeliveryDetails render what these return.

export const DELIVERY_MARKS = Object.freeze({
  failed: { labelKey: 'message.delivery.marker.failed', summaryKey: 'message.delivery.summary.failed', color: 'var(--red)' },
  delayed: { labelKey: 'message.delivery.marker.delayed', summaryKey: 'message.delivery.summary.delayed', color: 'var(--amber)' },
});

// The explanation keys the code list of the backend (services/mailNode/deliveryCodes.js) answers,
// with the classes it falls back to.
const CODE_KEYS = Object.freeze({
  tenant_attribution: 'message.delivery.code.tenant_attribution',
  connector_blocked: 'message.delivery.code.connector_blocked',
  terrl_exceeded: 'message.delivery.code.terrl_exceeded',
  terrl_trial: 'message.delivery.code.terrl_trial',
  recipient_not_accepted: 'message.delivery.code.recipient_not_accepted',
  routing_loop: 'message.delivery.code.routing_loop',
  temporary: 'message.delivery.code.temporary',
  permanent: 'message.delivery.code.permanent',
});
export const DELIVERY_CODE_KEYS = Object.freeze(Object.keys(CODE_KEYS));

const STATE_KEYS = Object.freeze({
  deferred: 'message.delivery.state.deferred',
  bounced: 'message.delivery.state.bounced',
  expired: 'message.delivery.state.expired',
  failed: 'message.delivery.state.failed',
  delayed: 'message.delivery.state.delayed',
});
const SENT_KEYS = Object.freeze({
  eop: 'message.delivery.state.sentEop',
  local: 'message.delivery.state.sentLocal',
  other: 'message.delivery.state.sent',
});
const COVERAGE_KEYS = Object.freeze({
  stored: 'message.delivery.coverage.stored',
  gone: 'message.delivery.coverage.gone',
  not_found: 'message.delivery.coverage.not_found',
  unavailable: 'message.delivery.coverage.unavailable',
});
const TLS_LEVEL_KEYS = Object.freeze({
  verified: 'message.delivery.tlsLevel.verified',
  trusted: 'message.delivery.tlsLevel.trusted',
  untrusted: 'message.delivery.tlsLevel.untrusted',
  anonymous: 'message.delivery.tlsLevel.anonymous',
});

// A key of one of the maps above, never one of Object's own properties.
const own = (map, key) => (typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : null);

export const FAILED_STATES = Object.freeze(['bounced', 'expired', 'failed']);
export const DELAYED_STATES = Object.freeze(['deferred', 'delayed']);

// The mark of a list row, or null.
export function deliveryMark(state) {
  return own(DELIVERY_MARKS, state);
}

// The words for one recipient's state. A letter the log shows sent was handed to the next server:
// EOP (relay named <EOP_HOST>), a mailbox on the node itself, or another server; never "read".
export function deliveryStateKey(row) {
  if (row?.state === 'sent') return own(SENT_KEYS, row.log?.relayKind) ?? SENT_KEYS.other;
  return own(STATE_KEYS, row?.state);
}

// The words for a state of a delivery report (failed or delayed), or null.
export function reportStateKey(state) {
  return state === 'failed' || state === 'delayed' ? STATE_KEYS[state] : null;
}

// 'failed', 'delayed' or 'ok': what the row's state is, for its icon and its colour (never the
// only sign: the state is written out).
export function deliveryTone(state) {
  if (FAILED_STATES.includes(state)) return 'failed';
  if (DELAYED_STATES.includes(state)) return 'delayed';
  return 'ok';
}

// The plain-language explanation of a refusal or delay, or null.
export function explanationKey(explanation) {
  return own(CODE_KEYS, explanation?.key);
}

// What to say about the node's log for this letter, or null when there is nothing to add (no log
// lookup: a mailbox off the node; or the log shows the letter now).
export function coverageKey(log) {
  return own(COVERAGE_KEYS, log?.coverage);
}

// Postfix's verdict on the server certificate in words, or null for a level it does not log.
export function tlsLevelKey(level) {
  return own(TLS_LEVEL_KEYS, level);
}
