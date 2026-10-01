// Mail node (mailcow) screens: the domain mailbox form and the admin section. Pure functions: no
// DOM, no store, no network, so they run under `node --test`.

// Same checks as the backend (services/mailNode/mailcow.js).
export const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const DEFAULT_QUOTA_MB = 5120;
export const MAX_QUOTA_MB = 102400;
export const DEFAULT_DOMAIN_MAILBOXES = 500;
export const MAX_DOMAIN_MAILBOXES = 10000;
// The disk share at which the panel pings /fail (backend services/mailNode/diskWatch.js).
export const DISK_WARN_PERCENT = 85;
// EOP settings limits (backend services/mailNode/eopSettings.js).
export const DKIM_MODES = ['mailcow', 'eop'];
export const DEFAULT_SEND_LIMIT_PER_HOUR = 50;
export const MAX_SEND_LIMIT_PER_HOUR = 10000;
export const MAX_TERRL = 10000000;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Onboarding of a mail node domain, in order (backend services/mailNode/domains.js). 'unknown' is a
// node domain the panel has no record of. Mailboxes are created only in 'ready' and 'authoritative'.
export const DOMAIN_STATES = [
  'node_created', 'node_configured', 'dns_ok', 'tenant_verified', 'internal_relay',
  'connector_ready', 'ready', 'authoritative',
];
export const MAILBOX_READY_STATES = ['ready', 'authoritative'];
const READY_INDEX = DOMAIN_STATES.indexOf('ready');
const DOMAIN_STATE_KEYS = {
  unknown: 'admin.mailNode.stateUnknown',
  node_created: 'admin.mailNode.stateNodeCreated',
  node_configured: 'admin.mailNode.stateNodeConfigured',
  dns_ok: 'admin.mailNode.stateDnsOk',
  tenant_verified: 'admin.mailNode.stateTenantVerified',
  internal_relay: 'admin.mailNode.stateInternalRelay',
  connector_ready: 'admin.mailNode.stateConnectorReady',
  ready: 'admin.mailNode.stateReady',
  authoritative: 'admin.mailNode.stateAuthoritative',
};
// What a person does to finish each step, the line of the onboarding checklist.
const STEP_KEYS = {
  node_configured: 'admin.mailNode.stepNodeConfigured',
  dns_ok: 'admin.mailNode.stepDnsOk',
  tenant_verified: 'admin.mailNode.stepTenantVerified',
  internal_relay: 'admin.mailNode.stepInternalRelay',
  connector_ready: 'admin.mailNode.stepConnectorReady',
  ready: 'admin.mailNode.stepReady',
};

// Spelled out literally so the i18n coverage test finds them.
const ERROR_KEYS = {
  mail_node_not_configured: 'admin.mailNode.errorNotConfigured',
  mail_node_unreachable: 'admin.mailNode.errorUnreachable',
  mail_node_auth: 'admin.mailNode.errorAuth',
  mail_node_refused: 'admin.mailNode.errorRefused',
  mail_node_failed: 'admin.mailNode.errorFailed',
  mail_host_invalid: 'admin.mailNode.errorHost',
  api_key_required: 'admin.mailNode.errorApiKey',
  quota_invalid: 'admin.mailNode.errorQuota',
  ping_url_invalid: 'admin.mailNode.errorPingUrl',
  domain_invalid: 'admin.mailNode.errorDomain',
  mailboxes_invalid: 'admin.mailNode.errorMailboxes',
  local_part_invalid: 'admin.accounts.add.domainErrorLocalPart',
  domain_unknown: 'admin.accounts.add.domainErrorUnknown',
  mailbox_exists: 'admin.accounts.add.domainErrorExists',
  sender_name_invalid: 'admin.accounts.add.senderNameInvalid',
  domain_not_ready: 'admin.accounts.add.domainErrorNotReady',
  domain_not_on_node: 'admin.mailNode.errorDomainNotOnNode',
  domain_not_found: 'admin.mailNode.errorDomainNotFound',
  domain_known: 'admin.mailNode.errorDomainKnown',
  domain_already_ready: 'admin.mailNode.errorDomainAlreadyReady',
  domain_recreated: 'admin.mailNode.errorDomainRecreated',
  step_invalid: 'admin.mailNode.errorStepOutOfOrder',
  step_out_of_order: 'admin.mailNode.errorStepOutOfOrder',
  eop_host_invalid: 'admin.eop.errorEopHost',
  certificate_host_invalid: 'admin.eop.errorCertificateHost',
  dkim_mode_invalid: 'admin.eop.errorDkimMode',
  send_limit_invalid: 'admin.eop.errorSendLimit',
  terrl_invalid: 'admin.eop.errorTerrl',
  tenant_id_invalid: 'admin.eop.errorTenantId',
  app_id_invalid: 'admin.eop.errorAppId',
  thumbprint_invalid: 'admin.eop.errorThumbprint',
};
const ERROR_FALLBACK_KEY = 'admin.mailNode.errorFailed';

export function mailNodeErrorKey(code) {
  return ERROR_KEYS[code] ?? ERROR_FALLBACK_KEY;
}

// A refusal from mailcow carries the node's own words (e.g. "max_mailbox_exceeded"): the screens
// show them next to the translated text so the administrator can act on them.
export function mailNodeErrorDetail(err) {
  return err?.code === 'mail_node_refused' ? String(err.message ?? '').replace(/^The mail node refused:\s*/, '') : '';
}

export function normalizeLocalPart(value) {
  return String(value ?? '').trim().toLowerCase();
}

// The error key for the add-mailbox form, or null when it can be sent.
export function domainMailboxFormError({ localPart, domain }) {
  const local = normalizeLocalPart(localPart);
  if (!LOCAL_PART_PATTERN.test(local) || local.includes('..')) return 'admin.accounts.add.domainErrorLocalPart';
  if (!domain) return 'admin.accounts.add.domainErrorPickDomain';
  return null;
}

// The sender name is required on "Our mailbox": it is what recipients read in From.
export function senderNameError(senderName) {
  return String(senderName ?? '').trim() ? null : 'admin.accounts.add.senderNameRequired';
}

// The sender names as the server takes them (POST /api/accounts kind=domain, POST
// /api/oauth/google/start): trimmed, empty ones left out, a second name equal to the first dropped.
export function senderNamesPayload({ senderName, senderNameAlt } = {}) {
  const main = String(senderName ?? '').trim();
  const alt = String(senderNameAlt ?? '').trim();
  return {
    ...(main ? { senderName: main } : {}),
    ...(alt && alt.toLowerCase() !== main.toLowerCase() ? { senderNameAlt: alt } : {}),
  };
}

// Whether the address the form would create is a mailbox of the install already. The server
// refuses it too (409 mailbox_exists); the form says so while the name is typed. A mailbox that is
// only on the node, not in MailExpert, is not taken: creating it enables it again.
export function domainMailboxTaken({ localPart, domain }, accounts = []) {
  const local = normalizeLocalPart(localPart);
  if (!local || !domain) return false;
  const email = `${local}@${String(domain).trim().toLowerCase()}`;
  return accounts.some((account) => String(account?.email_address ?? '').trim().toLowerCase() === email);
}

// Domains a mailbox can be created on: active ones whose onboarding is done, by name.
export function selectableDomains(domains) {
  return (domains ?? []).filter((d) => d.active && MAILBOX_READY_STATES.includes(d.state)).map((d) => d.domain).sort();
}

export function domainStateKey(state) {
  return DOMAIN_STATE_KEYS[state] ?? DOMAIN_STATE_KEYS.unknown;
}

// The checklist of a domain the panel knows: each manual step up to 'ready' with its status:
// 'confirmed' (someone pressed Done; `by` and `at` say who and when), 'skipped' (the domain was
// marked ready past it), 'next' (the one Done confirms now) or 'pending'.
export function onboardingSteps(domain) {
  const reached = DOMAIN_STATES.indexOf(domain?.state);
  return DOMAIN_STATES.slice(1, READY_INDEX + 1).map((state) => {
    const confirmed = domain?.steps?.[state] ?? null;
    let status = 'pending';
    if (confirmed && !(state === 'ready' && confirmed.markedReady)) status = 'confirmed';
    else if (DOMAIN_STATES.indexOf(state) <= reached) status = state === 'ready' ? 'confirmed' : 'skipped';
    else if (domain?.nextStep === state) status = 'next';
    return {
      state, labelKey: STEP_KEYS[state], status,
      by: confirmed?.email ?? null, at: confirmed?.at ?? null, markedReady: !!confirmed?.markedReady,
    };
  });
}

// A domain the panel knows that has not reached 'ready' yet: an administrator may mark it ready.
export function canMarkReady(domain) {
  const index = DOMAIN_STATES.indexOf(domain?.state);
  return index >= 0 && index < READY_INDEX;
}

export function parseWholeNumber(value, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

// The error key for the settings form, or null.
export function mailNodeConfigError({ mailHost, apiKey, quotaMb, diskPingUrl }, { hasStoredKey = false } = {}) {
  if (!HOST_PATTERN.test(String(mailHost ?? '').trim().toLowerCase())) return 'admin.mailNode.errorHost';
  if (!String(apiKey ?? '').trim() && !hasStoredKey) return 'admin.mailNode.errorApiKey';
  if (parseWholeNumber(quotaMb, 1, MAX_QUOTA_MB) == null) return 'admin.mailNode.errorQuota';
  const ping = String(diskPingUrl ?? '').trim();
  if (ping && !/^https:\/\/\S+$/.test(ping)) return 'admin.mailNode.errorPingUrl';
  return null;
}

// The EOP settings as the server takes them (backend services/mailNode/eopSettings.js
// parseEopSettings): { settings } with the fields sent, checked and normalized, or { error } with
// the server's refusal code. A field left out is not in `settings`; an optional one sent empty is
// null. The demo answers with it too, so it refuses and stores exactly what the server would.
const parseHost = (value) => {
  const host = String(value).trim().toLowerCase();
  return HOST_PATTERN.test(host) ? host : null;
};
const parseGuid = (value) => {
  const id = String(value).trim().toLowerCase();
  return GUID_PATTERN.test(id) ? id : null;
};
const parseThumbprint = (value) => {
  const hex = String(value).replace(/[\s:]/g, '').toUpperCase();
  return /^[0-9A-F]{40}$/.test(hex) ? hex : null;
};
// field: [parse, refusal code, whether it may be left empty]
const EOP_PARSERS = {
  eopHost: [parseHost, 'eop_host_invalid', true],
  certificateHost: [parseHost, 'certificate_host_invalid', true],
  dkimMode: [(v) => (DKIM_MODES.includes(v) ? v : null), 'dkim_mode_invalid', false],
  sendLimitPerHour: [(v) => parseWholeNumber(v, 1, MAX_SEND_LIMIT_PER_HOUR), 'send_limit_invalid', false],
  terrl: [(v) => parseWholeNumber(v, 1, MAX_TERRL), 'terrl_invalid', true],
  tenantId: [parseGuid, 'tenant_id_invalid', true],
  appId: [parseGuid, 'app_id_invalid', true],
  certThumbprint: [parseThumbprint, 'thumbprint_invalid', true],
};

export function normalizeEopSettings(body) {
  const settings = {};
  for (const [field, [parse, code, optional]] of Object.entries(EOP_PARSERS)) {
    const value = body?.[field];
    if (value === undefined) continue;
    if (value === null || String(value).trim() === '') {
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

// The error key for the EOP settings form, or null. Empty optional fields are fine.
export function eopSettingsError(form) {
  const { error } = normalizeEopSettings(form);
  return error ? mailNodeErrorKey(error) : null;
}

// Usage of a mailbox: share of its quota in whole percent, or null when the node gave no numbers.
export function usagePercent(usedBytes, quotaMb) {
  if (usedBytes == null || !quotaMb) return null;
  return Math.min(100, Math.round((usedBytes / (quotaMb * 1048576)) * 100));
}

// Sizes as the screens show them: { value, unitKey } so the unit is translated.
export function sizeParts(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return { value: (n / 1024 ** 3).toFixed(1), unitKey: 'admin.mailNode.unitGb' };
  return { value: String(Math.round(n / 1024 ** 2)), unitKey: 'admin.mailNode.unitMb' };
}

// The "Quota of a new mailbox, MB" field takes a plain MB number, which stops being legible
// once it is thousands of MB. This reads it back in GB once it crosses a full GB (1024 MB),
// so "5120" also shows as "5.0" for a "= 5.0 GB" hint under the field. Null below that, so the
// hint stays hidden for small quotas where MB alone is already clear.
export function quotaMbInGb(quotaMb) {
  const n = Number(quotaMb);
  if (!Number.isFinite(n) || n < 1024) return null;
  return (n / 1024).toFixed(1);
}
