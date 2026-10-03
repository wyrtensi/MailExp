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
export const MAX_LICENSES = 1000000;
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
// The steps the tenant driver confirms itself (stage 7b, backend tenantDomains.js DRIVER_STEPS):
// with the driver, they have no "Done".
export const TENANT_DRIVER_STEPS = ['tenant_verified', 'internal_relay', 'connector_ready'];
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
  // Stage 7b (backend routes/mailNode.js, routes/mailNodeTenant.js, the mailbox deletion's steps).
  step_by_tenant_driver: 'admin.mailNode.errorStepByTenantDriver',
  outbound_connector_invalid: 'admin.eop.errorOutboundConnector',
  dbeb_external_domain_invalid: 'admin.eop.errorDbebExternalDomain',
  connectors_not_read: 'admin.tenant.errorConnectorsNotRead',
  tenant_recipient_not_removed: 'admin.accounts.deletion.errorTenantRecipient',
  mark_ready_by_tenant_driver: 'admin.mailNode.errorMarkReadyByTenantDriver',
  hold_invalid: 'admin.mailNode.errorHoldInvalid',
  domain_authoritative: 'admin.mailNode.errorDomainAuthoritative',
  internal_relay_not_needed: 'admin.mailNode.errorInternalRelayNotNeeded',
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
  tenant_domain_invalid: 'admin.eop.errorTenantDomain',
  // The Microsoft tenant's routes (backend routes/mailNodeTenant.js).
  tenant_driver_missing: 'admin.tenant.errorDriverMissing',
  tenant_not_configured: 'admin.tenant.errorNotConfigured',
  tenant_job_not_found: 'admin.tenant.errorJobNotFound',
  app_id_invalid: 'admin.eop.errorAppId',
  thumbprint_invalid: 'admin.eop.errorThumbprint',
  tls_policy_invalid: 'admin.eop.errorTlsPolicy',
  tls_parameters_invalid: 'admin.eop.errorTlsParameters',
  panel_ips_invalid: 'admin.mailNode.errorPanelIps',
  rate_limit_invalid: 'admin.mailNode.errorRateLimit',
  node_ip_invalid: 'admin.eop.errorNodeIp',
  expected_mx_invalid: 'admin.mailNode.errorExpectedMx',
  tenant_txt_invalid: 'admin.mailNode.errorTenantTxt',
  dkim_cname_invalid: 'admin.mailNode.errorDkimCname',
  // Codes of the items an "apply" reports (backend services/mailNode/nodeApply.js).
  eop_host_missing: 'admin.mailNode.applyCodeEopHostMissing',
  panel_ips_missing: 'admin.mailNode.applyCodePanelIpsMissing',
  dkim_delete_unconfirmed: 'admin.mailNode.applyCodeDkimDeleteUnconfirmed',
  prefilter_differs: 'admin.mailNode.applyCodePrefilterDiffers',
  dovecot_restart_failed: 'admin.mailNode.applyCodeDovecotRestartFailed',
  prefilter_markers_broken: 'admin.mailNode.applyCodePrefilterMarkersBroken',
  prefilter_not_written: 'admin.mailNode.applyCodePrefilterNotWritten',
  relayhost_in_use: 'admin.mailNode.applyCodeRelayhostInUse',
  prefilter_not_applied: 'admin.mailNode.applyCodePrefilterNotApplied',
  prefilter_check_failed: 'admin.mailNode.applyCodePrefilterCheckFailed',
  fwdhost_not_deleted: 'admin.mailNode.applyCodeFwdhostNotDeleted',
  fwdhost_filter_turned_on: 'admin.mailNode.applyCodeFwdhostFilterTurnedOn',
  eop_ranges_invalid: 'admin.mailNode.applyCodeEopRangesInvalid',
  fwdhost_keep_spam: 'admin.mailNode.applyCodeFwdhostKeepSpam',
  fwdhost_not_written: 'admin.mailNode.applyCodeFwdhostNotWritten',
  // The node operations (backend routes/mailNode.js): EOP settings of the TERRL budget, the mail
  // queue and the alerts.
  licenses_invalid: 'admin.eop.errorLicenses',
  tenant_created_invalid: 'admin.eop.errorTenantCreated',
  queue_id_invalid: 'admin.nodeOps.errorQueueId',
  queue_action_invalid: 'admin.nodeOps.errorQueueAction',
  queue_delete_unconfirmed: 'admin.nodeOps.errorDeleteUnconfirmed',
  queue_item_not_found: 'admin.nodeOps.errorQueueItemNotFound',
  queue_item_held: 'admin.nodeOps.errorQueueItemHeld',
  deferred_count_invalid: 'admin.nodeOps.errorDeferredCount',
  deferred_minutes_invalid: 'admin.nodeOps.errorDeferredMinutes',
  alert_check_failed: 'admin.nodeOps.errorAlertCheck',
  // The outage windows (backend routes/mailNodeOutages.js, R-43).
  outage_start_invalid: 'admin.outages.errorStart',
  outage_end_invalid: 'admin.outages.errorEnd',
  outage_end_before_start: 'admin.outages.errorEndBeforeStart',
  outage_reason_required: 'admin.outages.errorReason',
  outage_reason_too_long: 'admin.outages.errorReasonTooLong',
  outage_not_found: 'admin.outages.errorNotFound',
  outage_already_closed: 'admin.outages.errorAlreadyClosed',
  outage_delete_unconfirmed: 'admin.outages.errorDeleteUnconfirmed',
  retention_days_invalid: 'admin.outages.errorRetention',
  trace_cooldown: 'admin.outages.errorCooldown',
  node_alias_address_mismatch: 'admin.aliases.errorNodeAddress',
  address_is_node_alias: 'admin.accounts.add.domainErrorNodeAlias',
};
const ERROR_FALLBACK_KEY = 'admin.mailNode.errorFailed';

export function mailNodeErrorKey(code) {
  return ERROR_KEYS[code] ?? ERROR_FALLBACK_KEY;
}

// Whether a refusal code is one the mail node screens translate.
export function isMailNodeErrorCode(code) {
  return Object.hasOwn(ERROR_KEYS, code);
}

// Owner decision D-16: a mailbox on the mail node sends only from its own address. Its aliases are
// more sender names for that address (a Russian and an English one, say); another address is a
// separate, billed mailbox. Gmail and IMAP mailboxes keep aliases with any address.
export function isNodeMailbox(account) {
  return account?.mail_node === true;
}

const sameAddress = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

// Whether an alias of the account has an address a node mailbox cannot send from (the server
// refuses to save it and to send from it: node_alias_address_mismatch, node_alias_stale).
export function isForeignNodeAlias(account, alias) {
  return isNodeMailbox(account) && !sameAddress(alias?.email, account.email_address);
}

// The aliases with another address left on node mailbox rows from before D-16, for the
// administrator to turn into separate mailboxes or delete: [{ account, alias }], by address.
export function foreignNodeAliases(accounts) {
  const rows = [];
  for (const account of accounts ?? []) {
    for (const alias of account?.aliases ?? []) {
      if (isForeignNodeAlias(account, alias)) rows.push({ account, alias });
    }
  }
  return rows.sort((a, b) => String(a.alias.email).localeCompare(String(b.alias.email)));
}

// The mailbox of the panel with this address (any kind), or null: such an alias cannot become a
// mailbox, it is only deleted.
export function mailboxWithAddress(accounts, email) {
  return (accounts ?? []).find((a) => sameAddress(a?.email_address, email)) ?? null;
}

// The create-mailbox form's starting values for such an alias: its address split at @ and its
// name as the sender name.
export function mailboxPrefillFromAlias(alias) {
  const email = String(alias?.email ?? '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  return {
    localPart: at > 0 ? email.slice(0, at) : email,
    domain: at > 0 ? email.slice(at + 1) : '',
    senderName: String(alias?.name ?? '').trim(),
  };
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
// tenantDriver: the tenant driver runs the tenant steps (stage 7b): the next of them is 'tenant'
// (MailExpert does it) instead of 'next' (a person's "Done").
export function onboardingSteps(domain, { tenantDriver = false } = {}) {
  const reached = DOMAIN_STATES.indexOf(domain?.state);
  return DOMAIN_STATES.slice(1, READY_INDEX + 1).map((state) => {
    const confirmed = domain?.steps?.[state] ?? null;
    let status = 'pending';
    if (confirmed && !(state === 'ready' && confirmed.markedReady)) status = 'confirmed';
    else if (DOMAIN_STATES.indexOf(state) <= reached) status = state === 'ready' ? 'confirmed' : 'skipped';
    else if (domain?.nextStep === state) status = tenantDriver && TENANT_DRIVER_STEPS.includes(state) ? 'tenant' : 'next';
    return {
      state, labelKey: STEP_KEYS[state], status,
      by: confirmed?.email ?? null, at: confirmed?.at ?? null, markedReady: !!confirmed?.markedReady,
      byTenantDriver: !!confirmed?.tenantDriver,
    };
  });
}

// A mail node mailbox whose domain is Authoritative while the tenant has no recipient for it yet:
// EOP rejects mail to it until the mirror makes one (R-32, stage 7b; GET /api/accounts
// tenant_pending).
export function tenantPending(account) {
  return account?.mail_node === true && account?.tenant_pending === true;
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
export function mailNodeConfigError({ mailHost, apiKey, quotaMb, diskPingUrl, deleteAfterDays, panelIps, nodeIp }, { hasStoredKey = false } = {}) {
  if (!HOST_PATTERN.test(String(mailHost ?? '').trim().toLowerCase())) return 'admin.mailNode.errorHost';
  if (!String(apiKey ?? '').trim() && !hasStoredKey) return 'admin.mailNode.errorApiKey';
  if (parseWholeNumber(quotaMb, 1, MAX_QUOTA_MB) == null) return 'admin.mailNode.errorQuota';
  const ping = String(diskPingUrl ?? '').trim();
  if (ping && !/^https:\/\/\S+$/.test(ping)) return 'admin.mailNode.errorPingUrl';
  if (deleteAfterDays !== undefined && parseWholeNumber(deleteAfterDays, 1, MAX_DELETE_AFTER_DAYS) == null) {
    return 'admin.mailNode.errorDeleteAfterDays';
  }
  if (panelIps !== undefined && parseNetworkList(panelIps).error) return 'admin.mailNode.errorPanelIps';
  if (nodeIp !== undefined && normalizeEopSettings({ nodeIp }).error) return 'admin.eop.errorNodeIp';
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
// Postfix policy attributes: name=value pairs separated by single spaces, up to 255 characters
// (mailcow's column; backend eopSettings.js).
export const MAX_TLS_PARAMETERS = 255;
export function parseTlsParameters(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > MAX_TLS_PARAMETERS) return null;
  return text.split(' ').every((token) => /^[a-z][a-z0-9_]*=[!-~]+$/i.test(token)) ? text : null;
}
// The node's public IPv4 address (backend eopSettings.js parseIpv4), for the DNS check only.
const parseIpv4 = (value) => {
  const ip = String(value).trim();
  return IPV4_PATTERN.test(ip) ? ip : null;
};
// A calendar day as YYYY-MM-DD, not after today (UTC): the tenant's creation date (backend
// eopSettings.js parseDay).
// "Today" is the administrator's own (local) day, which the server takes too.
export function parseDay(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const at = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== text) return null;
  const local = new Date(now);
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  return text <= today ? text : null;
}
// The tenant's initial domain, <TENANT>.onmicrosoft.com (backend eopSettings.js parseTenantDomain).
const parseTenantDomain = (value) => {
  const domain = parseHost(value);
  return domain && domain.endsWith('.onmicrosoft.com') ? domain : null;
};
const parseThumbprint = (value) => {
  const hex = String(value).replace(/[\s:]/g, '').toUpperCase();
  return /^[0-9A-F]{40}$/.test(hex) ? hex : null;
};
// An Outbound connector's name in EAC (backend exoRunner.js parseConnectorName): only compared with
// what the tenant answers, so any printable text up to 64 characters.
const parseConnectorName = (value) => {
  const name = String(value).trim();
  const control = [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  return name.length >= 1 && name.length <= 64 && !control ? name : null;
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
  licenses: [(v) => parseWholeNumber(v, 1, MAX_LICENSES), 'licenses_invalid', true],
  tenantCreatedOn: [(v) => parseDay(v), 'tenant_created_invalid', true],
  tenantId: [parseGuid, 'tenant_id_invalid', true],
  tenantDomain: [parseTenantDomain, 'tenant_domain_invalid', true],
  appId: [parseGuid, 'app_id_invalid', true],
  certThumbprint: [parseThumbprint, 'thumbprint_invalid', true],
  nodeIp: [parseIpv4, 'node_ip_invalid', true],
  outboundConnector: [parseConnectorName, 'outbound_connector_invalid', true],
  dbebExternalDomain: [parseHost, 'dbeb_external_domain_invalid', true],
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
const NAME_STRATEGIES = ['hostname', 'nexthop', 'dot-nexthop'];
const FINGERPRINT_PATTERN = /^[0-9A-F]{2}(?::[0-9A-F]{2}){15,63}$/i;
const matchItem = (item) => NAME_STRATEGIES.includes(item) || HOST_PATTERN.test(item.replace(/^\./, '').toLowerCase());

// Whether the parameters fit the policy (backend tlsParametersFit): secure and verify match only by
// name (hostname, nexthop, dot-nexthop or host names); fingerprint needs match= with fingerprints
// (hex pairs, "|"-separated); the other levels check no name, so match= there is refused.
export function tlsParametersFit(policy, parameters) {
  const tokens = parameters ? String(parameters).trim().split(/\s+/) : [];
  const matches = tokens.filter((t) => t.startsWith('match=')).map((t) => t.slice('match='.length));
  if (policy === 'fingerprint') {
    return matches.length > 0 && matches.every((m) => m.split('|').every((fp) => FINGERPRINT_PATTERN.test(fp)));
  }
  if (policy === 'secure' || policy === 'verify') return matches.every((m) => m.split(':').every(matchItem));
  return matches.length === 0;
}

export function eopSettingsConflict(settings) {
  return tlsParametersFit(settings?.tlsPolicy, settings?.tlsPolicyParameters ?? '') ? null : 'tls_parameters_invalid';
}

// The error key for the EOP settings form, or null. Empty optional fields are fine.
export function eopSettingsError(form) {
  const { settings, error } = normalizeEopSettings(form);
  const refusal = error ?? eopSettingsConflict(settings);
  return refusal ? mailNodeErrorKey(refusal) : null;
}

// One address or network for the node's fail2ban whitelist, as the server takes it (backend
// mailcow.js parseNetwork): an IPv4 or IPv6 address, or one with a prefix of /24 to /32 (IPv4) or
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
  const [min, max] = family === 4 ? [24, 32] : [48, 128];
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
  previous_tls_policy: 'admin.mailNode.applyItemPreviousTlsPolicy',
  previous_relayhost: 'admin.mailNode.applyItemPreviousRelayhost',
  tls_policy: 'admin.mailNode.applyItemTlsPolicy',
  relayhost: 'admin.mailNode.applyItemRelayhost',
  fail2ban: 'admin.mailNode.applyItemFail2ban',
  prefilter: 'admin.mailNode.applyItemPrefilter',
  forwarding_hosts: 'admin.mailNode.applyItemForwardingHosts',
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

// The notice after the spam filing rule was written by its own action, by how the forwarding hosts
// that waited for it went (the answer's `forwardingHosts`, backend nodeApply.js applyPrefilter).
export function prefilterDoneKey(answer) {
  const status = answer?.forwardingHosts?.status;
  if (status === 'ok' || status === 'changed') return 'admin.mailNode.prefilterDoneWithRanges';
  if (status) return 'admin.mailNode.prefilterDoneRangesNot';
  return 'admin.mailNode.prefilterDone';
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

// --- DNS checks (backend services/mailNode/dnsCheck.js, R-14 and R-15) -------------------------

// Spelled out literally so the i18n coverage test finds them.
const DNS_CHECK_KEYS = {
  mx: 'admin.mailNode.dnsCheckMx',
  spf: 'admin.mailNode.dnsCheckSpf',
  dkim_txt: 'admin.mailNode.dnsCheckDkimTxt',
  dkim_cname: 'admin.mailNode.dnsCheckDkimCname',
  dmarc: 'admin.mailNode.dnsCheckDmarc',
  tenant_txt: 'admin.mailNode.dnsCheckTenantTxt',
  mta_sts: 'admin.mailNode.dnsCheckMtaSts',
  node_a: 'admin.mailNode.dnsCheckNodeA',
  node_ptr: 'admin.mailNode.dnsCheckNodePtr',
  node_aaaa: 'admin.mailNode.dnsCheckNodeAaaa',
  cert_expiry: 'admin.mailNode.dnsCheckCertExpiry',
  cert_name: 'admin.mailNode.dnsCheckCertName',
  cert_chain: 'admin.mailNode.dnsCheckCertChain',
  cert_connect: 'admin.mailNode.dnsCheckCertConnect',
  resolver: 'admin.mailNode.dnsCheckResolver',
};
const DNS_STATUS_KEYS = {
  ok: 'admin.mailNode.dnsStatusOk',
  warning: 'admin.mailNode.dnsStatusWarning',
  error: 'admin.mailNode.dnsStatusError',
};
export const DNS_STATUS_COLORS = { ok: 'var(--text-secondary)', warning: 'var(--amber)', error: 'var(--red)' };
// Why a check is not ok: each explanation says what is wrong and what to do.
const DNS_CODE_KEYS = {
  mx_expected_missing: 'admin.mailNode.dnsCodeMxExpectedMissing',
  mx_missing: 'admin.mailNode.dnsCodeMxMissing',
  mx_mismatch: 'admin.mailNode.dnsCodeMxMismatch',
  mx_extra: 'admin.mailNode.dnsCodeMxExtra',
  spf_missing: 'admin.mailNode.dnsCodeSpfMissing',
  spf_multiple: 'admin.mailNode.dnsCodeSpfMultiple',
  spf_no_include: 'admin.mailNode.dnsCodeSpfNoInclude',
  spf_node_ip: 'admin.mailNode.dnsCodeSpfNodeIp',
  dkim_key_unknown: 'admin.mailNode.dnsCodeDkimKeyUnknown',
  dkim_missing: 'admin.mailNode.dnsCodeDkimMissing',
  dkim_mismatch: 'admin.mailNode.dnsCodeDkimMismatch',
  dkim_cname_expected_missing: 'admin.mailNode.dnsCodeDkimCnameExpectedMissing',
  dkim_cname_missing: 'admin.mailNode.dnsCodeDkimCnameMissing',
  dkim_cname_mismatch: 'admin.mailNode.dnsCodeDkimCnameMismatch',
  dmarc_missing: 'admin.mailNode.dnsCodeDmarcMissing',
  dmarc_invalid: 'admin.mailNode.dnsCodeDmarcInvalid',
  dmarc_multiple: 'admin.mailNode.dnsCodeDmarcMultiple',
  tenant_txt_expected_missing: 'admin.mailNode.dnsCodeTenantTxtExpectedMissing',
  tenant_txt_missing: 'admin.mailNode.dnsCodeTenantTxtMissing',
  mta_sts_published: 'admin.mailNode.dnsCodeMtaStsPublished',
  dns_lookup_failed: 'admin.mailNode.dnsCodeLookupFailed',
  dns_resolver_invalid: 'admin.mailNode.dnsCodeResolverInvalid',
  node_ip_missing: 'admin.mailNode.dnsCodeNodeIpMissing',
  a_missing: 'admin.mailNode.dnsCodeAMissing',
  a_mismatch: 'admin.mailNode.dnsCodeAMismatch',
  ptr_missing: 'admin.mailNode.dnsCodePtrMissing',
  ptr_mismatch: 'admin.mailNode.dnsCodePtrMismatch',
  aaaa_present: 'admin.mailNode.dnsCodeAaaaPresent',
  cert_expired: 'admin.mailNode.dnsCodeCertExpired',
  cert_expiring: 'admin.mailNode.dnsCodeCertExpiring',
  cert_name_mismatch: 'admin.mailNode.dnsCodeCertNameMismatch',
  cert_chain_incomplete: 'admin.mailNode.dnsCodeCertChainIncomplete',
  cert_untrusted: 'admin.mailNode.dnsCodeCertUntrusted',
  cert_unreachable: 'admin.mailNode.dnsCodeCertUnreachable',
  starttls_unavailable: 'admin.mailNode.dnsCodeStarttlsUnavailable',
  starttls_refused: 'admin.mailNode.dnsCodeStarttlsRefused',
  cert_handshake_failed: 'admin.mailNode.dnsCodeCertHandshakeFailed',
  spf_pass_all: 'admin.mailNode.dnsCodeSpfPassAll',
  spf_neutral_all: 'admin.mailNode.dnsCodeSpfNeutralAll',
  check_failed: 'admin.mailNode.dnsCodeCheckFailed',
};
// What the line of the domain's "DNS is right" step says about the latest check.
const DNS_VERDICT_KEYS = {
  none: 'admin.mailNode.dnsVerdictNone',
  ok: 'admin.mailNode.dnsVerdictOk',
  warning: 'admin.mailNode.dnsVerdictWarning',
  error: 'admin.mailNode.dnsVerdictError',
};

export function dnsCheckKey(check) {
  return DNS_CHECK_KEYS[check] ?? check;
}

export function dnsStatusKey(status) {
  return DNS_STATUS_KEYS[status] ?? DNS_STATUS_KEYS.error;
}

export function dnsCodeKey(code) {
  return DNS_CODE_KEYS[code] ?? 'admin.mailNode.dnsCodeUnknown';
}

// The values an explanation names: what DNS has, what it must have, the resolver's or server's
// words, the days left, the names missing from the certificate, the DNS name asked.
export function dnsCodeValues(check) {
  const list = (value) => (Array.isArray(value) && value.length ? value.join(', ') : '—');
  return {
    found: list(check?.found), expected: list(check?.expected), detail: check?.detail ?? '',
    days: check?.daysLeft ?? '', missing: list(check?.missing), name: check?.name ?? '',
  };
}

// The latest check of a domain next to its "DNS is right" step: only information, the step stays
// a person's confirmation. A check that could not ask DNS says so; the result before still counts.
export function dnsVerdictKey(domain) {
  if (domain?.dns?.lookupFailed) return 'admin.mailNode.dnsVerdictLookupFailed';
  return DNS_VERDICT_KEYS[domain?.dns?.overall] ?? DNS_VERDICT_KEYS.none;
}

// A domain that takes mailboxes while its last check found errors: the domain list warns about it.
// The check never changes the state.
export function hasDnsErrors(domain) {
  return MAILBOX_READY_STATES.includes(domain?.state) && domain?.dns?.overall === 'error';
}

// What the mail node section's summary badge counts: the ready domains with DNS errors, and
// whether the node's own check found errors.
export function dnsSummary(domains, nodeResult) {
  return {
    domains: (domains ?? []).filter(hasDnsErrors).map((d) => d.domain),
    node: nodeResult?.overall === 'error',
  };
}

// The values a domain must publish as the form edits them: every field a string.
export function expectedForm(expected) {
  return {
    expectedMx: (expected?.mx ?? []).join(', '),
    tenantTxt: expected?.tenantTxt ?? '',
    dkimSelector1Cname: expected?.dkimSelector1Cname ?? '',
    dkimSelector2Cname: expected?.dkimSelector2Cname ?? '',
  };
}

// The most MX hosts a domain is expected to publish (backend domains.js MAX_EXPECTED_MX).
export const MAX_EXPECTED_MX = 10;
// A host name as the server takes it: lowercase, without the root dot; null for anything else.
const expectedHost = (value) => {
  const text = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  return HOST_PATTERN.test(text) ? text : null;
};
// The target of an EOP DKIM selector CNAME (backend domains.js parseCnameTarget), such as
// selector1-contoso-com._domainkey.contoso.n-v1.dkim.mail.microsoft: labels other than the last may
// hold "_".
const CNAME_TARGET_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/;
const cnameTarget = (value) => {
  const text = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  return CNAME_TARGET_PATTERN.test(text) ? text : null;
};

// The values as the server takes them (backend domains.js parseExpectedValues): { values } with the
// fields sent (an empty one is null, or [] for the MX), or { error } with the refusal code. The demo
// answers with it too.
export function normalizeExpectedValues(body) {
  const values = {};
  if (body?.expectedMx !== undefined) {
    const parts = Array.isArray(body.expectedMx) ? body.expectedMx : String(body.expectedMx ?? '').split(/[\s,;]+/);
    const mx = [];
    for (const part of parts) {
      if (!String(part ?? '').trim()) continue;
      const host = expectedHost(part);
      if (!host) return { error: 'expected_mx_invalid' };
      if (!mx.includes(host)) mx.push(host);
    }
    if (mx.length > MAX_EXPECTED_MX) return { error: 'expected_mx_invalid' };
    values.mx = mx;
  }
  if (body?.tenantTxt !== undefined) {
    const text = String(body.tenantTxt ?? '').trim() || null;
    if (text && (text.length > 255 || !/^[ -~]+$/.test(text) || text.includes('"'))) return { error: 'tenant_txt_invalid' };
    values.tenantTxt = text;
  }
  for (const field of ['dkimSelector1Cname', 'dkimSelector2Cname']) {
    if (body?.[field] === undefined) continue;
    if (!String(body[field] ?? '').trim()) {
      values[field] = null;
      continue;
    }
    const host = cnameTarget(body[field]);
    if (!host) return { error: 'dkim_cname_invalid' };
    values[field] = host;
  }
  return { values };
}

// The error key for the expected values form, or null.
export function expectedValuesError(form) {
  const { error } = normalizeExpectedValues(form);
  return error ? mailNodeErrorKey(error) : null;
}

// --- Node operations: mail queue (R-16), alerts (R-18, R-19), TERRL budget (R-21) --------------
// Mirrors backend services/mailNode/{mailQueue,nodeAlerts,terrl}.js for the screens and the demo.

// Spelled out literally so the i18n coverage test finds them.
const QUEUE_NAME_KEYS = {
  active: 'admin.nodeOps.queueActive',
  deferred: 'admin.nodeOps.queueDeferred',
  hold: 'admin.nodeOps.queueHold',
  incoming: 'admin.nodeOps.queueIncoming',
  maildrop: 'admin.nodeOps.queueMaildrop',
};
export const QUEUE_NAMES = Object.keys(QUEUE_NAME_KEYS);

export function queueNameKey(queue) {
  return QUEUE_NAME_KEYS[queue] ?? 'admin.nodeOps.queueOther';
}

// What one queued message offers: a held one can be released or deleted; any other can be held,
// tried again now or deleted.
export function queueItemActions(item) {
  return item?.queue === 'hold' ? ['unhold', 'delete'] : ['hold', 'deliver', 'delete'];
}

const QUEUE_ACTION_KEYS = {
  hold: 'admin.nodeOps.actionHold',
  unhold: 'admin.nodeOps.actionUnhold',
  deliver: 'admin.nodeOps.actionDeliver',
  delete: 'admin.nodeOps.actionDelete',
  // Not a button: reading a queued message's body, as the journal names it.
  view_body: 'admin.nodeOps.actionViewBody',
};
export function queueActionKey(action) {
  return QUEUE_ACTION_KEYS[action] ?? action;
}

// An age in seconds as { value, unitKey }: minutes under an hour, hours under two days, then days.
export function ageParts(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 3600) return { value: Math.floor(s / 60), unitKey: 'admin.nodeOps.ageMinutes' };
  if (s < 2 * 86400) return { value: Math.floor(s / 3600), unitKey: 'admin.nodeOps.ageHours' };
  return { value: Math.floor(s / 86400), unitKey: 'admin.nodeOps.ageDays' };
}

export const DEFAULT_DEFERRED_COUNT = 20;
export const DEFAULT_DEFERRED_MINUTES = 60;
export const MAX_DEFERRED_COUNT = 100000;
export const MAX_DEFERRED_MINUTES = 7 * 24 * 60;

// The error key for the alert settings form, or null.
export function alertSettingsError({ pingUrl, deferredCount, deferredMinutes }) {
  const ping = String(pingUrl ?? '').trim();
  if (ping && !/^https:\/\/\S+$/.test(ping)) return 'admin.mailNode.errorPingUrl';
  if (parseWholeNumber(deferredCount, 1, MAX_DEFERRED_COUNT) == null) return 'admin.nodeOps.errorDeferredCount';
  if (parseWholeNumber(deferredMinutes, 1, MAX_DEFERRED_MINUTES) == null) return 'admin.nodeOps.errorDeferredMinutes';
  return null;
}

const ALERT_TITLE_KEYS = {
  connector_blocked: 'admin.nodeOps.alertConnectorBlocked',
  tenant_attribution: 'admin.nodeOps.alertTenantAttribution',
  terrl_exceeded: 'admin.nodeOps.alertTerrlExceeded',
  eop_bypass: 'admin.nodeOps.alertEopBypass',
  queue_deferred: 'admin.nodeOps.alertQueueDeferred',
  certificate: 'admin.nodeOps.alertCertificate',
  containers: 'admin.nodeOps.alertContainers',
  terrl_budget: 'admin.nodeOps.alertTerrlBudget',
  outage_letters_waiting: 'admin.nodeOps.alertOutageLettersWaiting',
  connector_blocked_tenant: 'admin.nodeOps.alertConnectorBlockedTenant',
  tenant_certificate: 'admin.nodeOps.alertTenantCertificate',
  tenant_poll_failing: 'admin.nodeOps.alertTenantPollFailing',
  tenant_connector_drift: 'admin.nodeOps.alertTenantConnectorDrift',
  tenant_domain_authoritative: 'admin.nodeOps.alertTenantDomainAuthoritative',
  eop_host_missing: 'admin.nodeOps.alertEopHostMissing',
};
export const ALERT_KEYS = Object.keys(ALERT_TITLE_KEYS);

export function alertTitleKey(key) {
  return ALERT_TITLE_KEYS[key] ?? 'admin.nodeOps.alertUnknown';
}

// What a source that could not be read is called (backend nodeAlerts.js sources).
const ALERT_SOURCE_KEYS = {
  log: 'admin.nodeOps.sourceLog',
  queue: 'admin.nodeOps.sourceQueue',
  certificate: 'admin.nodeOps.sourceCertificate',
  containers: 'admin.nodeOps.sourceContainers',
  terrl: 'admin.nodeOps.sourceTerrl',
  trace: 'admin.nodeOps.sourceTrace',
  tenant: 'admin.nodeOps.sourceTenant',
  tenant_certificate: 'admin.nodeOps.sourceTenant',
  tenant_poll: 'admin.nodeOps.sourceTenant',
  tenant_connectors: 'admin.nodeOps.sourceTenant',
  tenant_domains: 'admin.nodeOps.sourceTenant',
};
export function alertSourceKey(source) {
  return ALERT_SOURCE_KEYS[source] ?? 'admin.nodeOps.sourceLog';
}

// The line under an alert's title: { key, values } with times left as ISO strings in `at` values
// the screen formats.
export function alertDetail(alert) {
  const d = alert?.details ?? {};
  switch (alert?.key) {
    case 'connector_blocked':
    case 'tenant_attribution':
    case 'terrl_exceeded':
      return { key: 'admin.nodeOps.alertDetailRefusals', values: { count: d.count ?? 0 }, at: d.lastAt ?? null };
    case 'eop_bypass':
      return {
        key: 'admin.nodeOps.alertDetailBypass',
        values: { count: d.count ?? 0, relays: (d.relays ?? []).join(', ') || '—' },
        at: d.lastAt ?? null,
      };
    case 'eop_host_missing':
      return { key: 'admin.nodeOps.alertDetailEopHostMissing', values: {} };
    case 'queue_deferred':
      return {
        key: 'admin.nodeOps.alertDetailQueue',
        values: { deferred: d.deferred ?? 0, oldest: d.oldestMinutes ?? '—', count: d.deferredCount ?? '', minutes: d.deferredMinutes ?? '' },
      };
    case 'certificate':
      return d.code === 'cert_expired'
        ? { key: 'admin.nodeOps.alertDetailCertExpired', values: {}, at: d.expiresAt ?? null }
        : { key: 'admin.nodeOps.alertDetailCertExpiring', values: { days: d.daysLeft ?? '—' }, at: d.expiresAt ?? null };
    case 'containers':
      return {
        key: 'admin.nodeOps.alertDetailContainers',
        values: { names: (d.down ?? []).map((c) => `${c.name} (${c.state || '?'})`).join(', ') },
      };
    case 'terrl_budget':
      return { key: 'admin.nodeOps.alertDetailTerrl', values: { used: d.used ?? 0, limit: d.limit ?? '—', percent: d.percent ?? '—' } };
    // Letters to the node still in EOP's queue after an outage (R-43): EOP gives up on the first
    // at `at`.
    case 'outage_letters_waiting':
      return {
        key: d.asOf ? 'admin.nodeOps.alertDetailOutageWaitingAsOf' : 'admin.nodeOps.alertDetailOutageWaiting',
        values: { count: d.waiting ?? 0, asOf: d.asOf ? new Date(d.asOf).toLocaleString() : '' },
        at: d.soonestExpiresAt ?? null,
      };
    // The tenant poll (backend services/tenant/tenantJobs.js): Get-BlockedConnector, R-27.
    case 'connector_blocked_tenant':
      return {
        key: 'admin.nodeOps.alertDetailConnectorBlockedTenant',
        values: { count: d.count ?? 0, names: (d.connectors ?? []).map((c) => c.connectorName || c.connectorId).filter(Boolean).join(', ') || '—' },
        at: d.checkedAt ?? null,
      };
    case 'tenant_certificate':
      return d.code === 'cert_expired'
        ? { key: 'admin.nodeOps.alertDetailTenantCertExpired', values: {}, at: d.notAfter ?? null }
        : { key: 'admin.nodeOps.alertDetailTenantCertExpiring', values: { days: d.daysLeft ?? '—' }, at: d.notAfter ?? null };
    // The poll failing several times in a row, or not running at all (backend nodeAlerts.js).
    // A domain the tenant had as Authoritative waits for an administrator (stage 7b).
    case 'tenant_domain_authoritative':
      return { key: 'admin.nodeOps.alertDetailTenantDomainAuthoritative', values: { count: d.count ?? 0, domains: (d.domains ?? []).join(', ') || '—' } };
    // A connector changed since its reference (R-25, stage 7b).
    case 'tenant_connector_drift':
      return {
        key: 'admin.nodeOps.alertDetailTenantConnectorDrift',
        values: { count: d.count ?? 0, names: (d.connectors ?? []).map((c) => c.name).filter(Boolean).join(', ') || '—' },
        at: d.checkedAt ?? null,
      };
    case 'tenant_poll_failing':
      return d.failures
        ? { key: 'admin.nodeOps.alertDetailTenantPollFailing', values: { count: d.failures }, at: d.lastReadAt ?? null }
        : { key: 'admin.nodeOps.alertDetailTenantPollStale', values: {}, at: d.lastReadAt ?? null };
    default:
      return null;
  }
}

// The TERRL budget (backend terrl.js): 500 x licenses^0.7 + 9500, rounded; a young tenant gets 10
// percent of it under 31 days and 25 percent at 31 to 60 days.
export const TERRL_WARN_PERCENT = 80;
const DAY_MS = 86400000;

export function terrlFromLicenses(licenses) {
  return Number.isInteger(licenses) && licenses >= 1 ? Math.round(500 * licenses ** 0.7 + 9500) : null;
}

export function tenantAgeDays(createdOn, now = Date.now()) {
  if (typeof createdOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(createdOn)) return null;
  const created = Date.parse(`${createdOn}T00:00:00Z`);
  return Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / DAY_MS)) : null;
}

export function rampPercent(ageDays) {
  if (ageDays == null) return 100;
  if (ageDays < 31) return 10;
  if (ageDays <= 60) return 25;
  return 100;
}

// The budget from the EOP settings and the count: { fullLimit, limitFrom, ageDays, rampPercent,
// limit, used, percent, warn, exceeded }.
export function terrlBudget({ settings = {}, used = 0, now = Date.now() } = {}) {
  const fromLicenses = terrlFromLicenses(settings.licenses ?? null);
  const own = Number.isInteger(settings.terrl) && settings.terrl > 0;
  const fullLimit = own ? settings.terrl : fromLicenses;
  let limitFrom = null;
  if (own) limitFrom = 'terrl';
  else if (fromLicenses != null) limitFrom = 'licenses';
  const ageDays = tenantAgeDays(settings.tenantCreatedOn ?? null, now);
  const ramp = rampPercent(ageDays);
  const limit = fullLimit == null ? null : Math.round((fullLimit * ramp) / 100);
  if (limit == null) return { fullLimit, limitFrom, ageDays, rampPercent: ramp, limit, used, percent: null, warn: false, exceeded: false };
  return {
    fullLimit, limitFrom, ageDays, rampPercent: ramp, limit, used,
    percent: Math.floor((used * 100) / limit),
    warn: used * 100 >= limit * TERRL_WARN_PERCENT,
    exceeded: used >= limit,
  };
}

// ── The Microsoft tenant (stage 7a; backend routes/mailNodeTenant.js) ───────────────────────────

// Whether a tenant job still runs: the screen follows it until it ends.
export function tenantJobActive(job) {
  return job?.status === 'queued' || job?.status === 'running';
}

// The application certificate in the worker against the alert's thresholds (backend nodeAlerts.js
// tenantSignals): { daysLeft, level } with level null, 'warning' (under 30 days) or 'error' (under
// 14, or expired); null without a date.
export const TENANT_CERT_WARN_DAYS = 30;
export const TENANT_CERT_ERROR_DAYS = 14;
export function tenantCertificateLevel(notAfter, now = Date.now()) {
  const at = Date.parse(notAfter ?? '');
  if (!Number.isFinite(at)) return null;
  const daysLeft = Math.floor((at - now) / DAY_MS);
  let level = null;
  if (daysLeft < TENANT_CERT_ERROR_DAYS) level = 'error';
  else if (daysLeft < TENANT_CERT_WARN_DAYS) level = 'warning';
  return { daysLeft, level, expired: at <= now };
}

// Spelled out literally so the i18n coverage test finds them.
const TENANT_STEP_KEYS = {
  certificate: 'admin.tenant.stepCertificate',
  graph: 'admin.tenant.stepGraph',
  exo: 'admin.tenant.stepExo',
};
export const TENANT_STEPS = Object.keys(TENANT_STEP_KEYS);
export function tenantStepKey(step) {
  return TENANT_STEP_KEYS[step] ?? 'admin.tenant.stepUnknown';
}

// What a failed step or read says (codes of backend services/tenant/*.js and the worker).
const TENANT_FAILURE_KEYS = {
  certificate_mismatch: 'admin.tenant.failCertificateMismatch',
  tenant_domain_mismatch: 'admin.tenant.failTenantDomainMismatch',
  worker_unreachable: 'admin.tenant.failWorkerUnreachable',
  worker_timeout: 'admin.tenant.failWorkerTimeout',
  worker_unauthorized: 'admin.tenant.failWorkerUnauthorized',
  exo_timeout: 'admin.tenant.failWorkerTimeout',
  busy: 'admin.tenant.failWorkerBusy',
  exo_connect_failed: 'admin.tenant.failExoConnect',
  exo_failed: 'admin.tenant.failExo',
  exo_not_found: 'admin.tenant.failExo',
  graph_token_failed: 'admin.tenant.failGraphToken',
  graph_forbidden: 'admin.tenant.failGraphForbidden',
  graph_throttled: 'admin.tenant.failGraphThrottled',
  graph_unreachable: 'admin.tenant.failGraphUnreachable',
  graph_failed: 'admin.tenant.failGraph',
  policy_missing: 'admin.tenant.failPolicyMissing',
  tenant_driver_missing: 'admin.tenant.errorDriverMissing',
  tenant_not_configured: 'admin.tenant.errorNotConfigured',
  // Stage 7b: the domain's tenant steps and the mirror (backend services/tenant/tenantDomains.js).
  exo_throttled: 'admin.tenant.failThrottled',
  exo_exists: 'admin.tenant.failExo',
  domain_not_verified: 'admin.tenant.failDomainNotVerified',
  outbound_connector_missing: 'admin.tenant.failOutboundMissing',
  outbound_connector_ambiguous: 'admin.tenant.failOutboundAmbiguous',
  outbound_connector_not_found: 'admin.tenant.failOutboundNotFound',
  connector_domain_missing: 'admin.tenant.failConnectorDomainMissing',
  dkim_config_missing: 'admin.tenant.failDkimConfigMissing',
  authoritative_lost: 'admin.tenant.failAuthoritativeLost',
  authoritative_in_tenant: 'admin.tenant.failAuthoritativeInTenant',
  address_taken: 'admin.tenant.failAddressTaken',
  connector_guid_missing: 'admin.tenant.failConnectorGuidMissing',
  mail_node_not_configured: 'admin.mailNode.errorNotConfigured',
  mail_node_unreachable: 'admin.mailNode.errorUnreachable',
  mail_node_auth: 'admin.mailNode.errorAuth',
  mail_node_refused: 'admin.mailNode.errorRefused',
  mail_node_failed: 'admin.mailNode.errorFailed',
};
export function tenantFailureKey(code) {
  return TENANT_FAILURE_KEYS[code] ?? 'admin.tenant.failOther';
}

// A conflict of the anti-spam policy with the filing layout (backend services/tenant/antispam.js).
const POLICY_CONFLICT_KEYS = {
  quarantined: 'admin.tenant.conflictQuarantined',
  deleted: 'admin.tenant.conflictDeleted',
  redirected: 'admin.tenant.conflictRedirected',
  redirect_not_decided: 'admin.tenant.conflictRedirectNotDecided',
  subject_only: 'admin.tenant.conflictSubjectOnly',
  no_action: 'admin.tenant.conflictNoAction',
  unexpected: 'admin.tenant.conflictUnexpected',
};
export function policyConflictKey(code) {
  return POLICY_CONFLICT_KEYS[code] ?? 'admin.tenant.conflictUnexpected';
}

const POLICY_FIELD_KEYS = {
  SpamAction: 'admin.tenant.policySpam',
  HighConfidenceSpamAction: 'admin.tenant.policyHighSpam',
  BulkSpamAction: 'admin.tenant.policyBulk',
  PhishSpamAction: 'admin.tenant.policyPhish',
  HighConfidencePhishAction: 'admin.tenant.policyHighPhish',
};
export const POLICY_FIELDS = Object.keys(POLICY_FIELD_KEYS);
export function policyFieldKey(field) {
  return POLICY_FIELD_KEYS[field] ?? 'admin.tenant.policyOther';
}
