// Mail node (mailcow) screens: the domain mailbox form and the admin section. Pure functions: no
// DOM, no store, no network, so they run under `node --test`.

// Same checks as the backend (services/mailNode/mailcow.js).
export const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const DEFAULT_QUOTA_MB = 5120;
export const MAX_QUOTA_MB = 102400;
export const DEFAULT_DOMAIN_MAILBOXES = 500;
export const MAX_DOMAIN_MAILBOXES = 10000;
// Days a mail node mailbox keeps working after its deletion is asked for (backend mailcow.js).
export const DEFAULT_DELETE_AFTER_DAYS = 5;
export const MAX_DELETE_AFTER_DAYS = 90;
// The longest reason for a deletion the server takes (backend routes/accounts.js).
export const MAX_DELETION_REASON = 500;
// The disk share at which the panel pings /fail (backend services/mailNode/diskWatch.js).
export const DISK_WARN_PERCENT = 85;
// EOP settings limits (backend services/mailNode/eopSettings.js).
export const DKIM_MODES = ['mailcow', 'eop'];
export const DEFAULT_SEND_LIMIT_PER_HOUR = 50;
export const MAX_SEND_LIMIT_PER_HOUR = 10000;
export const MAX_TERRL = 10000000;
// The TLS Policy Map entry for the next hop (backend eopSettings.js TLS_POLICIES); 'default' is no
// entry, mailcow's own DANE / MTA-STS then.
export const TLS_POLICIES = ['secure', 'dane', 'dane-only', 'verify', 'fingerprint', 'encrypt', 'default'];
// A mailbox's send limit: messages per second, minute, hour or day (mailcow rl_frame).
export const RATE_LIMIT_FRAMES = ['s', 'm', 'h', 'd'];
// The panel's addresses for the node's fail2ban whitelist (backend mailcow.js MAX_PANEL_IPS).
export const MAX_PANEL_IPS = 10;
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
  domain_not_recreated: 'admin.mailNode.errorDomainNotRecreated',
  domain_node_changed: 'admin.mailNode.errorDomainNodeChanged',
  node_created_required: 'admin.mailNode.errorDomainNodeChanged',
  domain_nothing_to_restart: 'admin.mailNode.errorNothingToRestart',
  mail_node_host_mismatch: 'admin.mailNode.errorHostMismatch',
  delete_after_days_invalid: 'admin.mailNode.errorDeleteAfterDays',
  mailbox_pending_deletion: 'admin.accounts.add.domainErrorPendingDeletion',
  confirmation_mismatch: 'admin.accounts.deletion.errorConfirmation',
  deletion_reason_required: 'admin.accounts.deletion.errorReasonRequired',
  deletion_reason_too_long: 'admin.accounts.deletion.errorReasonTooLong',
  deletion_already_requested: 'admin.accounts.deletion.errorAlreadyRequested',
  deletion_not_requested: 'admin.accounts.deletion.errorNotRequested',
  deletion_in_progress: 'admin.accounts.deletion.errorInProgress',
  mail_node_deletion_request_required: 'admin.accounts.deletion.errorRequestRequired',
  account_not_found: 'admin.accounts.deletion.errorAccountNotFound',
  deletion_step_failed: 'admin.accounts.deletion.errorStepFailed',
  node_deleted_row_kept: 'admin.accounts.deletion.errorRowKept',
  mailbox_disabled_on_node: 'admin.accounts.add.domainErrorDisabledOnNode',
  mail_node_disable_unsupported: 'admin.accounts.mailNodeDisableUnsupported',
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
  tls_policy_invalid: 'admin.eop.errorTlsPolicy',
  tls_parameters_invalid: 'admin.eop.errorTlsParameters',
  panel_ips_invalid: 'admin.mailNode.errorPanelIps',
  rate_limit_invalid: 'admin.mailNode.errorRateLimit',
  // Codes of the items an "apply" reports (backend services/mailNode/nodeApply.js).
  eop_host_missing: 'admin.mailNode.applyCodeEopHostMissing',
  panel_ips_missing: 'admin.mailNode.applyCodePanelIpsMissing',
  dkim_delete_unconfirmed: 'admin.mailNode.applyCodeDkimDeleteUnconfirmed',
  prefilter_differs: 'admin.mailNode.applyCodePrefilterDiffers',
  dovecot_restart_failed: 'admin.mailNode.applyCodeDovecotRestartFailed',
};
const ERROR_FALLBACK_KEY = 'admin.mailNode.errorFailed';

export function mailNodeErrorKey(code) {
  return ERROR_KEYS[code] ?? ERROR_FALLBACK_KEY;
}

// Whether a refusal code is one the mail node screens translate.
export function isMailNodeErrorCode(code) {
  return Object.hasOwn(ERROR_KEYS, code);
}

// A mail node mailbox someone asked to delete (GET /api/accounts fields, migration 0081): when it
// goes for good, who asked, when and why, and why the deletion job could not delete it yet. Null
// for a mailbox with no deletion pending.
export function pendingDeletion(account) {
  if (!account?.delete_after) return null;
  return {
    deleteAfter: account.delete_after,
    requestedAt: account.deletion_requested_at ?? null,
    requestedBy: account.deletion_requested_by_email ?? null,
    reason: account.deletion_reason ?? '',
    lastError: account.deletion_last_error ?? null,
  };
}

// The error key for the reason typed in the delete confirmation, or null when it can be sent.
export function deletionReasonError(reason) {
  const text = String(reason ?? '').trim();
  if (!text) return 'admin.accounts.deletion.errorReasonRequired';
  if (text.length > MAX_DELETION_REASON) return 'admin.accounts.deletion.errorReasonTooLong';
  return null;
}

// When a deletion asked for now would happen: the given days from now (the server sets the exact
// time). Null when the days are not known.
export function deletionDate(days, now = Date.now()) {
  const n = Number(days);
  return Number.isInteger(n) && n > 0 ? new Date(now + n * 86400000).toISOString() : null;
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
// refuses it too (409 mailbox_exists); the form says so while the name is typed. A mailbox deleted
// in MailExpert is gone from the node too, so creating the address again makes a new, empty one.
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

// Whether only administrators may delete a mail node mailbox, which takes its mail with it. Off:
// everyone signed in may delete any mailbox today. The owner is deciding (R-04); switching it on is
// this flag together with NODE_MAILBOX_DELETE_ADMIN_ONLY in the backend (routes/accounts.js).
export const NODE_MAILBOX_DELETE_ADMIN_ONLY = false;

// Whether the screen offers to delete this mailbox.
export function canDeleteAccount(account, { isAdmin = false } = {}) {
  if (!account) return false;
  return !(account.mail_node === true && NODE_MAILBOX_DELETE_ADMIN_ONLY) || isAdmin;
}

// The sentences the delete confirmation adds about the node's aliases that deliver to the mailbox
// (GET /api/accounts/:id/node-aliases): those delivering only to it are deleted with it, the others
// stop delivering to it. Only the kinds there are; an empty list when there are none.
export function nodeAliasesNote(aliases) {
  const list = Array.isArray(aliases) ? aliases : [];
  const names = (onlyTarget) => list.filter((a) => !!a.onlyTarget === onlyTarget).map((a) => a.address).join(', ');
  const deleted = names(true);
  const changed = names(false);
  return [
    ...(deleted ? [{ key: 'admin.accounts.deleteMailNodeAliasesDeleted', values: { list: deleted } }] : []),
    ...(changed ? [{ key: 'admin.accounts.deleteMailNodeAliasesChanged', values: { list: changed } }] : []),
  ];
}

// The confirmation of deleting a mail node mailbox (ConfirmOverlay fields, without onConfirm): it
// keeps working until the date the given days make (or the administrator's days, when they are not
// known), then it goes for good with its mail and the node aliases listed; the address is typed out
// and a reason is required. `t` is the translator; `formatDate` formats the moment.
export function nodeMailboxDeleteDialog({ t, account, days, aliases, formatDate = (d) => d }) {
  const email = account.email_address;
  const date = deletionDate(days);
  const note = nodeAliasesNote(aliases).map((part) => t(part.key, part.values)).join(' ');
  return {
    title: t('admin.accounts.deleteTitle'),
    message: date
      ? t('admin.accounts.deleteMailNodeMessage', { email, date: formatDate(date) })
      : t('admin.accounts.deleteMailNodeMessageNoDate', { email }),
    requireTyped: email,
    typedLabel: t('admin.accounts.deleteMailNodeTypeLabel', { email }),
    requireReason: true,
    reasonLabel: t('admin.accounts.deletion.reasonLabel'),
    ...(note ? { note } : {}),
    confirmLabel: t('admin.accounts.deleteMailNodeConfirm'),
  };
}

// Deleting a mail node mailbox takes its mail with it, so the confirmation asks for the address
// typed out in full: it matches ignoring case and the spaces around it.
export function deleteConfirmationMatches(typed, expected) {
  const want = String(expected ?? '').trim().toLowerCase();
  return want !== '' && String(typed ?? '').trim().toLowerCase() === want;
}

// Whether "Restart onboarding" would change anything: not for a domain at the first step with no
// step confirmed and no warning about the node (the server refuses it too).
export function canRestartOnboarding(domain) {
  if (!domain || !DOMAIN_STATES.includes(domain.state)) return false;
  return domain.state !== 'node_created' || Object.keys(domain.steps ?? {}).length > 0 || !!domain.recreated;
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
export function mailNodeConfigError({ mailHost, apiKey, quotaMb, diskPingUrl, deleteAfterDays, panelIps }, { hasStoredKey = false } = {}) {
  if (!HOST_PATTERN.test(String(mailHost ?? '').trim().toLowerCase())) return 'admin.mailNode.errorHost';
  if (!String(apiKey ?? '').trim() && !hasStoredKey) return 'admin.mailNode.errorApiKey';
  if (parseWholeNumber(quotaMb, 1, MAX_QUOTA_MB) == null) return 'admin.mailNode.errorQuota';
  const ping = String(diskPingUrl ?? '').trim();
  if (ping && !/^https:\/\/\S+$/.test(ping)) return 'admin.mailNode.errorPingUrl';
  if (deleteAfterDays !== undefined && parseWholeNumber(deleteAfterDays, 1, MAX_DELETE_AFTER_DAYS) == null) {
    return 'admin.mailNode.errorDeleteAfterDays';
  }
  if (panelIps !== undefined && parseNetworkList(panelIps).error) return 'admin.mailNode.errorPanelIps';
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
// Postfix policy attributes: name=value pairs separated by single spaces (backend eopSettings.js).
export function parseTlsParameters(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > 500) return null;
  return text.split(' ').every((token) => /^[a-z][a-z0-9_]*=[!-~]+$/i.test(token)) ? text : null;
}
const parseThumbprint = (value) => {
  const hex = String(value).replace(/[\s:]/g, '').toUpperCase();
  return /^[0-9A-F]{40}$/.test(hex) ? hex : null;
};
// field: [parse, refusal code, whether it may be left empty]
const EOP_PARSERS = {
  eopHost: [parseHost, 'eop_host_invalid', true],
  tlsPolicy: [(v) => (TLS_POLICIES.includes(v) ? v : null), 'tls_policy_invalid', false],
  tlsPolicyParameters: [parseTlsParameters, 'tls_parameters_invalid', true],
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

// What the settings as a whole refuse once merged with the stored ones (backend
// eopSettingsConflict), or null: a fingerprint policy checks nothing without the fingerprint.
export function eopSettingsConflict(settings) {
  if (settings?.tlsPolicy === 'fingerprint' && !/(^| )match=/.test(settings?.tlsPolicyParameters ?? '')) {
    return 'tls_parameters_invalid';
  }
  return null;
}

// The error key for the EOP settings form, or null. Empty optional fields are fine.
export function eopSettingsError(form) {
  const { settings, error } = normalizeEopSettings(form);
  const refusal = error ?? eopSettingsConflict(settings);
  return refusal ? mailNodeErrorKey(refusal) : null;
}

// One address or network for the node's fail2ban whitelist, as the server takes it (backend
// mailcow.js parseNetwork): an IPv4 or IPv6 address, or one with a prefix of /8 to /32 (IPv4) or
// /16 to /128 (IPv6). Lowercased; null for anything else.
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function ipFamily(address) {
  if (IPV4_PATTERN.test(address)) return 4;
  if (!address.includes(':') || !/^[0-9a-f:.]+$/.test(address)) return 0;
  try {
    return new URL(`http://[${address}]/`).hostname ? 6 : 0;
  } catch {
    return 0;
  }
}
export function parseNetwork(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const [address, prefix, extra] = text.split('/');
  if (extra !== undefined) return null;
  const family = ipFamily(address);
  if (!family) return null;
  if (prefix === undefined) return address;
  if (!/^\d{1,3}$/.test(prefix)) return null;
  const bits = Number(prefix);
  const [min, max] = family === 4 ? [8, 32] : [16, 128];
  return bits >= min && bits <= max ? `${address}/${bits}` : null;
}

// The panel's addresses as typed (commas, spaces or new lines): { networks } without repeats, or
// { error } with the server's refusal code.
export function parseNetworkList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  const networks = [];
  for (const part of parts) {
    if (!String(part ?? '').trim()) continue;
    const network = parseNetwork(part);
    if (!network) return { error: 'panel_ips_invalid' };
    if (!networks.includes(network)) networks.push(network);
  }
  return networks.length > MAX_PANEL_IPS ? { error: 'panel_ips_invalid' } : { networks };
}

// --- Applying the settings to the node (backend services/mailNode/nodeApply.js) ---------------

// Spelled out literally so the i18n coverage test finds them.
const APPLY_ITEM_KEYS = {
  tls_policy: 'admin.mailNode.applyItemTlsPolicy',
  relayhost: 'admin.mailNode.applyItemRelayhost',
  fail2ban: 'admin.mailNode.applyItemFail2ban',
  prefilter: 'admin.mailNode.applyItemPrefilter',
  domain_relayhost: 'admin.mailNode.applyItemDomainRelayhost',
  dkim: 'admin.mailNode.applyItemDkim',
  mailbox_limits: 'admin.mailNode.applyItemMailboxLimits',
};
const APPLY_STATUS_KEYS = {
  ok: 'admin.mailNode.applyStatusOk',
  changed: 'admin.mailNode.applyStatusChanged',
  failed: 'admin.mailNode.applyStatusFailed',
  skipped: 'admin.mailNode.applyStatusSkipped',
  pending: 'admin.mailNode.applyStatusPending',
};
export const APPLY_STATUS_COLORS = {
  ok: 'var(--text-secondary)', changed: 'var(--accent)', failed: 'var(--red)', skipped: 'var(--amber)', pending: 'var(--amber)',
};

export function applyItemKey(item) {
  return APPLY_ITEM_KEYS[item] ?? item;
}

export function applyStatusKey(status) {
  return APPLY_STATUS_KEYS[status] ?? APPLY_STATUS_KEYS.failed;
}

// The prefilter item of the node's last result: whether the spam filing rule waits to be written.
export function prefilterPending(nodeResult) {
  return (nodeResult?.items ?? []).some((i) => i.item === 'prefilter' && i.status === 'pending');
}

// Whether the domain's last apply left mailcow's DKIM key in place for the administrator to delete.
export function dkimDeleteWaiting(domain) {
  return (domain?.apply?.items ?? []).some((i) => i.item === 'dkim' && i.code === 'dkim_delete_unconfirmed');
}

// --- Send limits --------------------------------------------------------------------------------

// Spelled out literally so the i18n coverage test finds them.
const RATE_FRAME_KEYS = {
  s: 'admin.mailNode.rateFrameS',
  m: 'admin.mailNode.rateFrameM',
  h: 'admin.mailNode.rateFrameH',
  d: 'admin.mailNode.rateFrameD',
};

export function rateFrameKey(frame) {
  return RATE_FRAME_KEYS[frame] ?? RATE_FRAME_KEYS.h;
}

// The error key for an administrator's send limit, or null when it can be sent.
export function rateLimitError({ value, frame }) {
  if (parseWholeNumber(value, 1, MAX_SEND_LIMIT_PER_HOUR) == null || !RATE_LIMIT_FRAMES.includes(frame)) {
    return 'admin.mailNode.errorRateLimit';
  }
  return null;
}

const sameLimit = (a, b) => !!a && !!b && Number(a.value) === Number(b.value) && a.frame === b.frame;

// What a mailbox's send limit is: 'own' (an administrator's), 'default', or 'differs' when the node
// holds another limit than the panel wants (an apply sets it again; null on the node too).
export function rateLimitState(mailbox) {
  const wanted = mailbox?.rateLimitOverride ?? mailbox?.rateLimitDefault ?? null;
  if (!sameLimit(mailbox?.rateLimit, wanted)) return 'differs';
  return mailbox?.rateLimitOverride ? 'own' : 'default';
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
