// The delivery codes the panel explains (R-17) and alerts on (R-18): one list, shared by the node
// alerts (services/mailNode/nodeAlerts.js) and the delivery details of a letter
// (services/deliveryStatus.js, services/deliveryReport.js). The screens carry the plain-language
// texts under message.delivery.code.<key> (en.json, ru.json); this module only says which key a
// code is.
//
// A code matches a delivery line or a report by its enhanced status code (Postfix's dsn=, a DSN's
// Status:) exactly, or by the code standing alone in the remote reply or the diagnostic text (not
// part of a longer code or of an address like [5.7.64.12]); some by a marker in the text as well
// (AS(2204), EOP's "connector blocked").
//
// alert: the node alert the code raises (nodeAlerts.js REFUSALS), or null when it raises none.

const standalone = (code) => new RegExp(`(?<![\\d.])${code.replaceAll('.', '\\.')}(?![\\d.])`);

export const DELIVERY_CODES = Object.freeze([
  // EOP refused the connection's attribution to the tenant: the node's certificate does not match
  // the inbound connector, or its chain is incomplete ("5.7.64 TenantAttribution; Relay Access Denied").
  { key: 'tenant_attribution', codes: ['5.7.64'], markers: [], alert: 'tenant_attribution' },
  // Microsoft blocked the inbound connector, usually for spam sent through it
  // ("5.7.711 Access denied, bad inbound connector. AS(2204)").
  { key: 'connector_blocked', codes: ['5.7.711'], markers: [/AS\(2204\)/], alert: 'connector_blocked' },
  // The tenant reached its daily limit of external recipients (TERRL, R-21).
  { key: 'terrl_exceeded', codes: ['5.7.233'], markers: [], alert: 'terrl_exceeded' },
  // The same limit of a trial tenant.
  { key: 'terrl_trial', codes: ['5.7.232'], markers: [], alert: 'terrl_exceeded' },
  // The recipient is not accepted: an address of an accepted domain that does not exist in the
  // tenant while the domain blocks unknown recipients (DBEB), or an address the remote server does
  // not know.
  { key: 'recipient_not_accepted', codes: ['5.4.1'], markers: [], alert: null },
  // A routing loop: the letter came back to where it was already, as between EOP and the node when
  // a domain's MX, connectors and accepted domain type disagree.
  { key: 'routing_loop', codes: ['5.4.14'], markers: [], alert: null },
].map((entry) => Object.freeze({ ...entry, patterns: [...entry.codes.map(standalone), ...entry.markers] })));

// The classes of an enhanced status code: 2 success, 4 temporary (Postfix tries again), 5 permanent.
export const CODE_CLASSES = Object.freeze({ 2: 'success', 4: 'temporary', 5: 'permanent' });

// The enhanced status code at the start of a text or a reply ("550 5.4.1 ..." -> "5.4.1"), or null.
export function statusCodeIn(text) {
  const match = /(?:^|\s)([245]\.\d{1,3}\.\d{1,3})(?![\d.])/.exec(String(text ?? ''));
  return match ? match[1] : null;
}

// The dictionary entries a code and a text match, most specific first (the list's order): [] when
// none. code: the exact enhanced status code (dsn=, Status:); text: the reply or diagnostic.
export function matchDeliveryCodes({ code = null, text = '' } = {}) {
  const words = String(text ?? '');
  return DELIVERY_CODES.filter((entry) => entry.codes.includes(code) || entry.patterns.some((re) => re.test(words)));
}

// How the screens explain one outcome: { key, class, code }. key: the first dictionary entry the
// code or the text matches, else the class of the code ('temporary', 'permanent', 'success'), else
// null. code: the enhanced status code given, else the one found in the text.
export function explainDeliveryCode({ code = null, text = '' } = {}) {
  const found = code || statusCodeIn(text);
  const klass = found ? CODE_CLASSES[found[0]] ?? null : null;
  const entry = matchDeliveryCodes({ code: found, text })[0];
  return { key: entry?.key ?? klass, class: klass, code: found };
}
