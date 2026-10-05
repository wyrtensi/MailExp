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
  unknown: 'message.delivery.state.unknown',
});
// Not one of the states above (a newer server): said as such, never as delivered.
const OTHER_STATE_KEY = 'message.delivery.state.other';
const STALE_KEY = 'message.delivery.state.stale';
const LEFT_QUEUE_KEY = 'message.delivery.state.leftQueue';
// The mailbox's own outgoing server refused the recipient when the letter was sent (source
// 'submission', backend services/sendDelivery.js).
const REFUSED_AT_SUBMISSION_KEY = 'message.delivery.state.refusedAtSubmission';
const SENT_KEYS = Object.freeze({
  eop: 'message.delivery.state.sentEop',
  local: 'message.delivery.state.sentLocal',
  discard: 'message.delivery.state.sentDiscard',
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
// A rule on the node that discarded it is said as such. A delay with no news for the queue
// lifetime (stale) and a letter that left the queue without a final line read as unknown. A
// recipient the outgoing server refused at sending reads as such, not as a delivery report.
export function deliveryStateKey(row) {
  if (row?.state === 'failed' && row.source === 'submission') return REFUSED_AT_SUBMISSION_KEY;
  if (row?.state === 'sent') return own(SENT_KEYS, row.log?.relayKind) ?? SENT_KEYS.other;
  if (row?.state === 'unknown' && row.stale) return STALE_KEY;
  if (row?.state === 'unknown' && row.log?.leftQueue) return LEFT_QUEUE_KEY;
  return own(STATE_KEYS, row?.state) ?? OTHER_STATE_KEY;
}

// The words for a state of a delivery report (failed or delayed), or null.
export function reportStateKey(state) {
  return state === 'failed' || state === 'delayed' ? STATE_KEYS[state] : null;
}

// 'failed', 'delayed', 'ok' or 'neutral': what the row's state is, for its colour (never the only
// sign: the state is written out). ok only for a letter handed on (sent, not discarded); unknown
// and any state this screen does not know are neutral.
export function deliveryTone(row) {
  const state = row?.state;
  if (FAILED_STATES.includes(state) || (state === 'sent' && row.log?.relayKind === 'discard')) return 'failed';
  if (DELAYED_STATES.includes(state)) return 'delayed';
  return state === 'sent' ? 'ok' : 'neutral';
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

// --- R-30: Microsoft's message trace of the letter (backend services/tenant/messageTrace.js) ---

// Graph's exchangeMessageTrace statuses in words; another (a newer one) is said as unknown.
const EOP_STATUS_KEYS = Object.freeze({
  delivered: 'message.delivery.eop.status.delivered',
  failed: 'message.delivery.eop.status.failed',
  pending: 'message.delivery.eop.status.pending',
  quarantined: 'message.delivery.eop.status.quarantined',
  filteredAsSpam: 'message.delivery.eop.status.filteredAsSpam',
  expanded: 'message.delivery.eop.status.expanded',
  gettingStatus: 'message.delivery.eop.status.gettingStatus',
});
export const EOP_TRACE_STATUSES = Object.freeze(Object.keys(EOP_STATUS_KEYS));

export function eopStatusKey(status) {
  return own(EOP_STATUS_KEYS, status) ?? 'message.delivery.eop.status.other';
}

// The tone of a trace row: failed and quarantined or filtered are not delivered; pending waits.
export function eopStatusTone(status) {
  if (status === 'delivered' || status === 'expanded') return 'ok';
  if (status === 'failed' || status === 'quarantined' || status === 'filteredAsSpam') return 'failed';
  if (status === 'pending' || status === 'gettingStatus') return 'delayed';
  return 'neutral';
}

// Why a trace could not be asked or failed, in words.
const EOP_ERROR_KEYS = Object.freeze({
  trace_not_connected: 'message.delivery.eop.notConnected',
  trace_too_old: 'message.delivery.eop.tooOld',
  trace_sent_at_unknown: 'message.delivery.eop.sentAtUnknown',
  trace_throttled: 'message.delivery.eop.errorThrottled',
  graph_throttled: 'message.delivery.eop.errorThrottled',
  trace_budget: 'message.delivery.eop.errorThrottled',
  trace_auth: 'message.delivery.eop.errorAuth',
  graph_token_failed: 'message.delivery.eop.errorAuth',
  graph_forbidden: 'message.delivery.eop.errorAuth',
  trace_unreachable: 'message.delivery.eop.errorUnreachable',
  graph_unreachable: 'message.delivery.eop.errorUnreachable',
});
export function eopTraceErrorKey(code) {
  return own(EOP_ERROR_KEYS, code) ?? 'message.delivery.eop.errorFailed';
}

// Whether a trace is still being asked (the screen asks again until it is not).
export function eopTraceActive(trace) {
  return trace?.state === 'queued' || trace?.state === 'running';
}
