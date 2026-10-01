import { query } from '../db.js';
import { isUuid } from '../../utils/uuid.js';
import { parseHostName, parseWholeNumber } from './mailcow.js';

// The mail path through Microsoft EOP, set next to the mail node settings (integration_config row
// 'mail_node_eop'): the next hop of the node (<EOP_HOST>) with the TLS Postfix must use toward it,
// the name on the node's client certificate (<MAIL_HOST>), who signs DKIM, the send limit of a
// mailbox, the tenant's external recipient limit (TERRL, read by hand from the EAC report) and how
// the panel will reach the tenant. The next hop, its TLS, DKIM and the send limit are applied to the
// node through the mailcow API (services/mailNode/nodeApply.js); the tenant fields are only kept.
//
// None of these is a secret: the tenant and application ids and the certificate thumbprint only
// name things, and the application's certificate with its password stays in the tenant worker's
// volume. A secret added here later is stored with encrypt() and sent back redacted, like the node's
// API key.

export const EOP_PROVIDER = 'mail_node_eop';
// mailcow signs until a tenant experiment shows EOP signs relayed mail; then EOP alone.
export const DKIM_MODES = Object.freeze(['mailcow', 'eop']);
// Messages per hour per mailbox: the service is person-to-person mail, the limit stops a
// compromised mailbox. An administrator changes it for one mailbox.
export const DEFAULT_SEND_LIMIT_PER_HOUR = 50;
export const MAX_SEND_LIMIT_PER_HOUR = 10000;
export const MAX_TERRL = 10000000;
// The TLS Policy Map entry for <EOP_HOST> (Postfix smtp_tls_policy_maps levels), or 'default' for
// none: mailcow's own default then (DANE, then MTA-STS through postfix-tlspol). Which one a tenant
// needs depends on the form of its host name (eop-panel-requirements.md, sections 2.3 and 6,
// experiment 4): 'secure' for *.mail.protection.outlook.com; 'encrypt' and 'fingerprint' are what a
// test stand without a public CA can check. Levels that send mail without TLS are not offered.
export const TLS_POLICIES = Object.freeze(['secure', 'dane', 'dane-only', 'verify', 'fingerprint', 'encrypt', 'default']);
export const DEFAULT_TLS_POLICY = 'secure';
const MAX_TLS_PARAMETERS = 500;

export const EOP_DEFAULTS = Object.freeze({
  eopHost: null,
  tlsPolicy: DEFAULT_TLS_POLICY,
  tlsPolicyParameters: null,
  certificateHost: null,
  dkimMode: 'mailcow',
  sendLimitPerHour: DEFAULT_SEND_LIMIT_PER_HOUR,
  terrl: null,
  tenantId: null,
  appId: null,
  certThumbprint: null,
});
export const EOP_FIELDS = Object.freeze(Object.keys(EOP_DEFAULTS));

// A SHA-1 thumbprint as Windows and the Entra portal show it, with or without spaces or colons.
function parseThumbprint(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/[\s:]/g, '').toUpperCase();
  return /^[0-9A-F]{40}$/.test(hex) ? hex : null;
}

// Postfix policy attributes as mailcow takes them: name=value pairs separated by single spaces,
// e.g. "match=nexthop:dot-nexthop" or "match=AB:CD:...". Null for anything else.
export function parseTlsParameters(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text.length > MAX_TLS_PARAMETERS) return null;
  return text.split(' ').every((token) => /^[a-z][a-z0-9_]*=[!-~]+$/i.test(token)) ? text : null;
}

function parseGuid(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isUuid(id) ? id : null;
}

// field: [parse, refusal code, whether it may be left empty]
const PARSERS = {
  eopHost: [parseHostName, 'eop_host_invalid', true],
  tlsPolicy: [(v) => (TLS_POLICIES.includes(v) ? v : null), 'tls_policy_invalid', false],
  tlsPolicyParameters: [parseTlsParameters, 'tls_parameters_invalid', true],
  certificateHost: [parseHostName, 'certificate_host_invalid', true],
  dkimMode: [(v) => (DKIM_MODES.includes(v) ? v : null), 'dkim_mode_invalid', false],
  sendLimitPerHour: [(v) => parseWholeNumber(v, 1, MAX_SEND_LIMIT_PER_HOUR), 'send_limit_invalid', false],
  terrl: [(v) => parseWholeNumber(v, 1, MAX_TERRL), 'terrl_invalid', true],
  tenantId: [parseGuid, 'tenant_id_invalid', true],
  appId: [parseGuid, 'app_id_invalid', true],
  certThumbprint: [parseThumbprint, 'thumbprint_invalid', true],
};

const isBlank = (value) => value === null || (typeof value === 'string' && value.trim() === '');

// The fields the body sends, checked: { settings } or { error } with the first refusal. A field left
// out keeps its stored value; an optional field sent empty is cleared.
export function parseEopSettings(body) {
  const settings = {};
  for (const [field, [parse, code, optional]] of Object.entries(PARSERS)) {
    const value = body?.[field];
    if (value === undefined) continue;
    if (isBlank(value)) {
      if (!optional) return { error: code };
      settings[field] = null;
      continue;
    }
    const parsed = parse(value);
    if (parsed == null) return { error: code };
    settings[field] = parsed;
  }
  return { settings };
}

// What the settings as a whole refuse once merged with the stored ones, or null: a fingerprint
// policy checks nothing without the fingerprint to match.
export function eopSettingsConflict(settings) {
  if (settings.tlsPolicy === 'fingerprint' && !/(^| )match=/.test(settings.tlsPolicyParameters ?? '')) {
    return 'tls_parameters_invalid';
  }
  return null;
}

// The stored settings over the defaults.
export async function getEopSettings() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [EOP_PROVIDER]);
  const stored = rows[0]?.config ?? {};
  return Object.fromEntries(EOP_FIELDS.map((field) => [field, stored[field] ?? EOP_DEFAULTS[field]]));
}

// Merges into the stored settings, so a field a later stage adds survives a save of this form.
export async function saveEopSettings(settings) {
  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = integration_config.config || EXCLUDED.config, updated_at = NOW()
  `, [EOP_PROVIDER, settings]);
}

// The panel may reach the tenant once all three are set; it does not yet.
export function tenantConfigured(settings) {
  return !!(settings.tenantId && settings.appId && settings.certThumbprint);
}

// Whether the panel works with the tenant itself (the tenant driver of a later stage). Until it
// does, every onboarding step is confirmed by hand, whatever is filled in above, and the EOP screen
// keeps the checklist. The tenant driver replaces this with its own status.
export function tenantDriverActive() {
  return false;
}
