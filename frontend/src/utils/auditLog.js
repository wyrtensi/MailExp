import {
  alertTitleKey, applyItemKey, dnsCheckKey, dnsStatusKey, domainStateKey, quarantineTypeKey, queueActionKey, rateFrameKey,
} from './mailNode.js';
import { formatDateTime, formatDay } from './formatDate.js';

// Helpers for the admin audit log screen. Actions and details mirror
// backend/src/services/auditLog.js and the entries GET /api/admin/audit returns.

export const AUDIT_ACTION_LABEL_KEYS = Object.freeze({
  'mailbox.added': 'admin.audit.actionMailboxAdded',
  'mailbox.reconnected': 'admin.audit.actionMailboxReconnected',
  'mailbox.deleted': 'admin.audit.actionMailboxDeleted',
  'mailbox.connection_changed': 'admin.audit.actionMailboxConnectionChanged',
  'mailbox.enabled': 'admin.audit.actionMailboxEnabled',
  'mailbox.disabled': 'admin.audit.actionMailboxDisabled',
  'mailbox.password_restored': 'admin.audit.actionMailboxPasswordRestored',
  'mailbox.quota_changed': 'admin.audit.actionMailboxQuotaChanged',
  'mailbox.rate_limit_changed': 'admin.audit.actionMailboxRateLimitChanged',
  'mailbox.deletion_requested': 'admin.audit.actionMailboxDeletionRequested',
  'mailbox.deletion_cancelled': 'admin.audit.actionMailboxDeletionCancelled',
  'message.sent': 'admin.audit.actionMessageSent',
  'message.deleted': 'admin.audit.actionMessageDeleted',
  'message.move_reverted': 'admin.audit.actionMessageMoveReverted',
  'message.send_queued': 'admin.audit.actionMessageSendQueued',
  'message.send_cancelled': 'admin.audit.actionMessageSendCancelled',
  'message.send_rescheduled': 'admin.audit.actionMessageSendRescheduled',
  'message.send_failed': 'admin.audit.actionMessageSendFailed',
  'user.added': 'admin.audit.actionUserAdded',
  'user.deleted': 'admin.audit.actionUserDeleted',
  'user.enabled': 'admin.audit.actionUserEnabled',
  'user.disabled': 'admin.audit.actionUserDisabled',
  'user.admin_changed': 'admin.audit.actionUserAdminChanged',
  'access.sync_aborted': 'admin.audit.actionAccessSyncAborted',
  'mail_node.config_changed': 'admin.audit.actionMailNodeConfigChanged',
  'mail_node.domain_added': 'admin.audit.actionMailNodeDomainAdded',
  'mail_node.domain_adopted': 'admin.audit.actionMailNodeDomainAdopted',
  'mail_node.domain_state_changed': 'admin.audit.actionMailNodeDomainStateChanged',
  'mail_node.domain_identity_acknowledged': 'admin.audit.actionMailNodeDomainIdentityAcknowledged',
  'mail_node.applied': 'admin.audit.actionMailNodeApplied',
  'mail_node.dns_checked': 'admin.audit.actionMailNodeDnsChecked',
  'mail_node.queue_action': 'admin.audit.actionMailNodeQueueAction',
  'mail_node.alert_raised': 'admin.audit.actionMailNodeAlertRaised',
  'mail_node.alert_cleared': 'admin.audit.actionMailNodeAlertCleared',
  'mail_node.quarantine_released': 'admin.audit.actionMailNodeQuarantineReleased',
  'mail_node.quarantine_deleted': 'admin.audit.actionMailNodeQuarantineDeleted',
  'mail_node.quarantine_learned_spam': 'admin.audit.actionMailNodeQuarantineLearnedSpam',
  'mail_node.quarantine_settings_applied': 'admin.audit.actionMailNodeQuarantineSettingsApplied',
  'mail_node.outage_opened': 'admin.audit.actionMailNodeOutageOpened',
  'mail_node.outage_closed': 'admin.audit.actionMailNodeOutageClosed',
  'mail_node.outage_added': 'admin.audit.actionMailNodeOutageAdded',
  'mail_node.outage_changed': 'admin.audit.actionMailNodeOutageChanged',
  'mail_node.outage_deleted': 'admin.audit.actionMailNodeOutageDeleted',
  'tenant.connection_tested': 'admin.audit.actionTenantConnectionTested',
  'tenant.recipients_synced': 'admin.audit.actionTenantRecipientsSynced',
  'tenant.connector_reference_taken': 'admin.audit.actionTenantConnectorReference',
  'tenant.domain_hold_changed': 'admin.audit.actionTenantDomainHold',
  'tenant.internal_relay_approved': 'admin.audit.actionTenantInternalRelayApproved',
  'tenant.quarantine_released': 'admin.audit.actionTenantQuarantineReleased',
  'tenant.phish_release_changed': 'admin.audit.actionTenantPhishReleaseChanged',
  'tenant.message_traced': 'admin.audit.actionTenantMessageTraced',
  'tenant.antispam_enforced': 'admin.audit.actionTenantAntispamEnforced',
  'tenant.alias_contacts_removal_approved': 'admin.audit.actionTenantAliasContactsApproved',
});

export const AUDIT_ACTIONS = Object.freeze(Object.keys(AUDIT_ACTION_LABEL_KEYS));

// Why a queued move was reverted: the letter was gone from the server, the destination folder was
// gone, or the server kept refusing the move.
const MOVE_REVERTED_DETAIL_KEYS = Object.freeze({
  gone: 'admin.audit.detailMoveRevertedGone',
  destination_gone: 'admin.audit.detailMoveRevertedDestinationGone',
  gave_up: 'admin.audit.detailMoveRevertedGaveUp',
});

// Why a waiting letter was cancelled: its writer undid the send, took it back to edit, or
// discarded it.
const SEND_CANCEL_DETAIL_KEYS = Object.freeze({
  undo: 'admin.audit.detailSendCancelledUndo',
  edit: 'admin.audit.detailSendCancelledEdit',
  discard: 'admin.audit.detailSendCancelledDiscard',
});

// How a mail_node.domain_state_changed entry moved the domain: "Done", "Mark ready", "Restart
// onboarding" or the tenant driver.
const DOMAIN_STATE_CHANGE_KEYS = Object.freeze({
  step_confirmed: 'admin.audit.detailDomainStepConfirmed',
  marked_ready: 'admin.audit.detailDomainMarkedReady',
  restarted: 'admin.audit.detailDomainRestarted',
  // Stage 7b: the tenant driver confirmed a tenant step, or made the domain Authoritative.
  tenant_driver: 'admin.audit.detailDomainTenantDriver',
});

// The settings fields a mail_node.config_changed entry names, as the journal shows them.
const SETTINGS_FIELD_KEYS = Object.freeze({
  mailHost: 'admin.audit.fieldMailHost',
  apiKey: 'admin.audit.fieldApiKey',
  quotaMb: 'admin.audit.fieldQuota',
  diskPingUrl: 'admin.audit.fieldPingUrl',
  deleteAfterDays: 'admin.audit.fieldDeleteAfterDays',
  panelIps: 'admin.audit.fieldPanelIps',
  tlsPolicy: 'admin.audit.fieldTlsPolicy',
  tlsPolicyParameters: 'admin.audit.fieldTlsParameters',
  eopHost: 'admin.audit.fieldEopHost',
  certificateHost: 'admin.audit.fieldCertificateHost',
  dkimMode: 'admin.audit.fieldDkimMode',
  sendLimitPerHour: 'admin.audit.fieldSendLimit',
  terrl: 'admin.audit.fieldTerrl',
  tenantId: 'admin.audit.fieldTenantId',
  appId: 'admin.audit.fieldAppId',
  certThumbprint: 'admin.audit.fieldThumbprint',
  outboundConnector: 'admin.audit.fieldOutboundConnector',
  dbebExternalDomain: 'admin.audit.fieldDbebExternalDomain',
  nodeIp: 'admin.audit.fieldNodeIp',
  licenses: 'admin.audit.fieldLicenses',
  tenantCreatedOn: 'admin.audit.fieldTenantCreated',
  // The alert settings (settings 'alerts').
  pingUrl: 'admin.audit.fieldAlertPingUrl',
  deferredCount: 'admin.audit.fieldDeferredCount',
  deferredMinutes: 'admin.audit.fieldDeferredMinutes',
  // The values a domain must publish (settings 'domain_dns').
  mx: 'admin.audit.fieldExpectedMx',
  tenantTxt: 'admin.audit.fieldTenantTxt',
  dkimSelector1Cname: 'admin.audit.fieldDkimSelector1Cname',
  dkimSelector2Cname: 'admin.audit.fieldDkimSelector2Cname',
  // Who sees the node's quarantine (settings 'quarantine').
  userView: 'admin.audit.fieldQuarantineUserView',
  // How long the outage letters are kept (settings 'outages'), and the fields of a window.
  retentionDays: 'admin.audit.fieldOutageRetention',
  startedAt: 'admin.audit.fieldOutageStart',
  endedAt: 'admin.audit.fieldOutageEnd',
  reason: 'admin.audit.fieldOutageReason',
});

// The settings a mail_node.config_changed entry is about.
const SETTINGS_DETAIL_KEYS = Object.freeze({
  node: 'admin.audit.detailMailNodeSettingsChanged',
  eop: 'admin.audit.detailEopSettingsChanged',
  domain_dns: 'admin.audit.detailDomainDnsExpectedChanged',
  alerts: 'admin.audit.detailAlertSettingsChanged',
  quarantine: 'admin.audit.detailQuarantineSettingsChanged',
  outages: 'admin.audit.detailOutageSettingsChanged',
});

const when = (iso) => (iso ? formatDateTime(iso) : '—');

// A mail node outage window (R-43): when it began and ended and the administrator's reason; for one
// the alert job opened, which containers were down.
function outageDetail(entry) {
  const details = entry.details ?? {};
  const values = { start: when(details.startedAt), end: when(details.endedAt), reason: details.reason ?? '', minutes: details.minutes ?? '' };
  switch (entry.action) {
    case 'mail_node.outage_opened':
      return (details.down ?? []).length
        ? { key: 'admin.audit.detailOutageOpened', values: { ...values, down: details.down.join(', ') } }
        : { key: 'admin.audit.detailOutageOpenedApi', values };
    case 'mail_node.outage_closed':
      return { key: details.reason ? 'admin.audit.detailOutageClosedReason' : 'admin.audit.detailOutageClosed', values };
    case 'mail_node.outage_added':
      return { key: details.planned ? 'admin.audit.detailOutageAddedPlanned' : 'admin.audit.detailOutageAdded', values };
    case 'mail_node.outage_changed':
      return {
        key: 'admin.audit.detailOutageChanged',
        values,
        valueKeys: { fields: (details.fields ?? []).map((field) => SETTINGS_FIELD_KEYS[field] ?? field) },
      };
    default:
      return { key: 'admin.audit.detailOutageDeleted', values };
  }
}

// A mail_node.dns_checked entry: an administrator's check of everything (the node's status and how
// many domains ended in each), or one scope (the node or a domain) with its status and the one
// before, and the checks that found errors or warnings.
function dnsCheckedDetail(details) {
  const overall = dnsStatusKey(details.overall);
  const names = (list) => (Array.isArray(list) ? list.map((check) => dnsCheckKey(check)) : []);
  // A check that could not ask DNS: no result, only why.
  if (details.lookupFailed) {
    if (details.scope === 'all') return { key: 'admin.audit.detailDnsCheckedAllFailed', values: { code: details.code ?? '' } };
    return details.scope === 'domain'
      ? { key: 'admin.audit.detailDnsCheckLookupFailed', values: { scope: details.domain ?? '', code: details.code ?? '' } }
      : { key: 'admin.audit.detailDnsCheckLookupFailed', values: { code: details.code ?? '' }, valueKeys: { scope: 'admin.audit.detailDnsScopeNode' } };
  }
  if (details.scope === 'all') {
    const counts = details.counts ?? {};
    return {
      key: 'admin.audit.detailDnsCheckedAll',
      values: {
        ok: counts.ok ?? 0, warning: counts.warning ?? 0, error: counts.error ?? 0, lookupFailed: counts.lookupFailed ?? 0,
        domains: Array.isArray(details.errorDomains) && details.errorDomains.length ? details.errorDomains.join(', ') : '—',
      },
      valueKeys: { overall },
    };
  }
  // A list with no check in it reads as a dash.
  const listed = { errors: names(details.errors), warnings: names(details.warnings) };
  const empty = Object.fromEntries(Object.entries(listed).filter(([, list]) => !list.length).map(([name]) => [name, '—']));
  const nonEmpty = Object.fromEntries(Object.entries(listed).filter(([, list]) => list.length));
  return {
    key: details.scope === 'domain' ? 'admin.audit.detailDnsCheckedDomain' : 'admin.audit.detailDnsCheckedNode',
    values: { domain: details.domain ?? '', ...empty },
    valueKeys: {
      overall,
      from: details.from ? dnsStatusKey(details.from) : 'admin.audit.detailDnsCheckedFirst',
      ...nonEmpty,
    },
  };
}

// What a mail_node.applied entry applied to: the node, the spam filing rule, or a domain (named).
const APPLY_SCOPE_KEYS = Object.freeze({
  node: 'admin.audit.detailApplyScopeNode',
  prefilter: 'admin.audit.detailApplyScopePrefilter',
});

// A mail_node.applied entry: the items it changed and those that failed, by name, with the domain
// for a domain's run. Item names this screen does not know show as written.
function appliedDetail(details) {
  const names = (list) => (Array.isArray(list) ? list.map((entry) => applyItemKey(entry?.item)) : []);
  const changed = names(details.changed);
  const failed = names(details.failed);
  let key = 'admin.audit.detailAppliedChanged';
  if (failed.length) key = changed.length ? 'admin.audit.detailAppliedBoth' : 'admin.audit.detailAppliedFailed';
  const scope = details.scope === 'domain' && details.domain ? { values: { scope: details.domain } } : null;
  return {
    key,
    values: scope?.values ?? {},
    valueKeys: {
      ...(scope ? {} : { scope: APPLY_SCOPE_KEYS[details.scope] ?? APPLY_SCOPE_KEYS.node }),
      changed, failed,
    },
  };
}

export function auditActionLabelKey(action) {
  return AUDIT_ACTION_LABEL_KEYS[action] ?? null;
}

// Start of a local calendar day (YYYY-MM-DD from a date input) as an ISO timestamp, moved
// forward by `dayOffset` days. Anything else is not a day and yields null.
function localDayStart(day, dayOffset = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayOffset).toISOString();
}

// Query for GET /api/admin/audit. Empty filters are left out. The admin picks both days
// inclusively, while the API's `to` is exclusive, so `to` is the start of the next day.
export function auditQuery({ account, user, action, fromDate, toDate, before } = {}) {
  const query = {};
  if (account) query.account = account;
  if (user) query.user = user;
  if (action) query.action = action;
  const from = localDayStart(fromDate);
  if (from) query.from = from;
  const to = localDayStart(toDate, 1);
  if (to) query.to = to;
  if (before) query.before = before;
  return query;
}

// What the details column shows for an entry: a translation key with its values, plain text,
// or null when there is nothing to add. `valueKeys` are values that are translation keys
// themselves (a domain's onboarding state), or lists of them shown joined (settings fields); a
// field this screen has no name for is passed as is and shows as written.
export function auditDetail(entry) {
  const details = entry?.details ?? {};
  switch (entry?.action) {
    case 'mailbox.added':
    case 'mailbox.reconnected':
      return details.oauthProvider
        ? { key: 'admin.audit.detailProvider', values: { provider: details.oauthProvider } }
        : null;
    case 'mailbox.deleted': {
      // pending: the deletion job deleted a mailbox someone asked to delete; the entry keeps who
      // asked, when and why, since the mailbox row is gone. nodeWarnings: the node deleted the
      // mailbox but said something went wrong on the way (its maildir could not be moved away),
      // shown as the node wrote it.
      if (!details.mailNode) return null;
      const warnings = Array.isArray(details.nodeWarnings) && details.nodeWarnings.length ? details.nodeWarnings.join('; ') : '';
      if (details.pending) {
        const values = {
          by: details.requestedBy ?? '', at: formatDay(details.requestedAt), reason: details.reason ?? '',
        };
        return warnings
          ? { key: 'admin.audit.detailMailNodeMailboxPendingWarnings', values: { ...values, warnings } }
          : { key: 'admin.audit.detailMailNodeMailboxPending', values };
      }
      return warnings
        ? { key: 'admin.audit.detailMailNodeMailboxWarnings', values: { warnings } }
        : { key: 'admin.audit.detailMailNodeMailbox', values: {} };
    }
    case 'mailbox.deletion_requested':
      return {
        key: 'admin.audit.detailDeletionRequested',
        values: { date: formatDay(details.deleteAfter), reason: details.reason ?? '' },
      };
    case 'mailbox.deletion_cancelled':
      return {
        key: 'admin.audit.detailDeletionCancelled',
        values: { date: formatDay(details.deleteAfter), reason: details.reason ?? '' },
      };
    case 'mailbox.rate_limit_changed':
      return {
        key: details.override ? 'admin.audit.detailRateLimitSet' : 'admin.audit.detailRateLimitDefault',
        values: { value: details.value ?? '' },
        valueKeys: { frame: rateFrameKey(details.frame) },
      };
    case 'mail_node.applied':
      return appliedDetail(details);
    case 'mail_node.dns_checked':
      return dnsCheckedDetail(details);
    case 'mail_node.queue_action':
      // One queued message held, released, tried again or deleted (with its envelope), or the
      // whole queue tried again.
      return details.action === 'flush'
        ? { key: 'admin.audit.detailQueueFlush', values: {} }
        : {
          key: 'admin.audit.detailQueueAction',
          values: {
            id: details.queueId ?? '', sender: details.sender || '<>',
            recipients: Array.isArray(details.recipients) && details.recipients.length ? details.recipients.join(', ') : '—',
          },
          valueKeys: { action: queueActionKey(details.action) },
        };
    case 'tenant.recipients_synced':
      return {
        key: 'admin.audit.detailTenantRecipients',
        values: { domain: details.domain ?? '', created: details.created ?? 0, removed: details.removed ?? 0, retargeted: details.retargeted ?? 0 },
      };
    case 'tenant.domain_hold_changed':
      return { key: details.hold ? 'admin.audit.detailTenantHoldOn' : 'admin.audit.detailTenantHoldOff', values: { domain: details.domain ?? '' } };
    // The type in words (section 5.14); an entry of stage 7c carries none and reads as before.
    case 'tenant.quarantine_released': {
      const values = { sender: details.sender ?? '', recipients: (details.recipients ?? []).join(', '), messageId: details.messageId ?? '' };
      if (!details.type) return { key: 'admin.audit.detailTenantQuarantineReleasedNoType', values };
      const typeKey = quarantineTypeKey(details.type);
      return typeKey
        ? { key: 'admin.audit.detailTenantQuarantineReleased', values, valueKeys: { type: typeKey } }
        : { key: 'admin.audit.detailTenantQuarantineReleased', values: { ...values, type: details.type } };
    }
    case 'tenant.alias_contacts_removal_approved':
      return {
        key: 'admin.audit.detailTenantAliasContactsApproved',
        values: { domain: details.domain ?? '', addresses: (details.addresses ?? []).join(', ') || '—' },
      };
    case 'tenant.antispam_enforced':
      return {
        key: 'admin.audit.detailTenantAntispamEnforced',
        values: { fields: (details.changed ?? []).map((c) => `${c.field}: ${c.from} → ${c.to}`).join(', ') || '—' },
      };
    case 'tenant.phish_release_changed':
      return { key: details.enabled ? 'admin.audit.detailTenantPhishReleaseOn' : 'admin.audit.detailTenantPhishReleaseOff', values: {} };
    case 'tenant.message_traced':
      return { key: 'admin.audit.detailTenantMessageTraced', values: { messageId: details.messageId ?? '' } };
    case 'tenant.internal_relay_approved':
      return { key: 'admin.audit.detailTenantInternalRelayApproved', values: { domain: details.domain ?? '' } };
    case 'tenant.connector_reference_taken':
      return {
        key: 'admin.audit.detailTenantConnectorReference',
        values: { names: [...(details.inbound ?? []), ...(details.outbound ?? [])].join(', ') || '—' },
      };
    case 'tenant.connection_tested':
      return details.ok
        ? { key: 'admin.audit.detailTenantTestOk', values: {} }
        : { key: 'admin.audit.detailTenantTestFailed', values: { steps: (details.failed ?? []).join(', ') || '—' } };
    case 'mail_node.alert_raised':
    case 'mail_node.alert_cleared':
      return {
        key: entry.action === 'mail_node.alert_raised' ? 'admin.audit.detailAlertRaised' : 'admin.audit.detailAlertCleared',
        values: {},
        valueKeys: { alert: alertTitleKey(details.alert) },
      };
    case 'mailbox.quota_changed':
      return details.from == null
        ? { key: 'admin.audit.detailQuotaSet', values: { to: details.quotaMb ?? '' } }
        : { key: 'admin.audit.detailQuotaChanged', values: { from: details.from, to: details.quotaMb ?? '' } };
    case 'mailbox.connection_changed':
      return Array.isArray(details.fields) && details.fields.length
        ? { key: 'admin.audit.detailFields', values: { fields: details.fields.join(', ') } }
        : null;
    case 'message.sent': {
      const recipients = [...(details.to ?? []), ...(details.cc ?? []), ...(details.bcc ?? [])];
      return recipients.length
        ? { key: 'admin.audit.detailRecipients', values: { recipients: recipients.join(', ') } }
        : null;
    }
    case 'message.deleted': {
      const folder = details.folder ?? '';
      // The backend stores `from: null` when a message had no sender address.
      if (!details.from) {
        return {
          key: details.permanent ? 'admin.audit.detailDeletedForeverNoSender' : 'admin.audit.detailMovedToTrashNoSender',
          values: { folder },
        };
      }
      return {
        key: details.permanent ? 'admin.audit.detailDeletedForever' : 'admin.audit.detailMovedToTrash',
        values: { from: details.from, folder },
      };
    }
    // Undo send and send later (backend services/sendQueue.js): a letter queued (for a chosen time,
    // or with the undo window), cancelled (undo, edit or discard), moved or sent again, or not sent.
    case 'message.send_queued':
      return details.scheduled
        ? { key: 'admin.audit.detailSendScheduled', values: { time: formatDateTime(details.sendAt) } }
        : null;
    case 'message.send_cancelled':
      return { key: SEND_CANCEL_DETAIL_KEYS[details.reason] ?? SEND_CANCEL_DETAIL_KEYS.discard, values: {} };
    case 'message.send_rescheduled':
      return details.resend
        ? { key: 'admin.audit.detailSendResent', values: {} }
        : { key: 'admin.audit.detailSendRescheduled', values: { time: formatDateTime(details.sendAt) } };
    case 'message.send_failed':
      return details.status === 'needs_attention'
        ? { key: 'admin.audit.detailSendUncertain', values: {} }
        : { key: 'admin.audit.detailSendFailed', values: { code: details.code ?? '' } };
    case 'message.move_reverted':
      // A queued move the mail server could not do: the letter went back (services/moveQueue.js).
      return {
        key: MOVE_REVERTED_DETAIL_KEYS[details.reason] ?? 'admin.audit.detailMoveRevertedGaveUp',
        values: { from: details.from ?? '', to: details.to ?? '' },
      };
    case 'user.admin_changed':
      return {
        key: details.isAdmin ? 'admin.audit.detailAdminGranted' : 'admin.audit.detailAdminRevoked',
        values: { email: details.email ?? '' },
      };
    case 'user.added':
    case 'user.deleted':
    case 'user.enabled':
    case 'user.disabled':
      return details.email ? { text: details.email } : null;
    case 'access.sync_aborted': {
      const candidates = Array.isArray(details.candidates) ? details.candidates : [];
      return {
        key: 'admin.audit.detailAccessSyncAborted',
        values: { wouldDisable: candidates.length, emails: candidates.join(', ') },
      };
    }
    case 'mail_node.config_changed':
      return Array.isArray(details.fields) && details.fields.length
        ? {
          key: SETTINGS_DETAIL_KEYS[details.settings] ?? SETTINGS_DETAIL_KEYS.node,
          values: details.settings === 'domain_dns' ? { domain: details.domain ?? '' } : {},
          valueKeys: { fields: details.fields.map((field) => SETTINGS_FIELD_KEYS[field] ?? field) },
        }
        : null;
    case 'mail_node.domain_added':
      // from: the state of a domain the panel knew, added to the node again and so started over.
      return details.from
        ? {
          key: 'admin.audit.detailDomainAddedAgain',
          values: { domain: details.domain ?? '', mailboxes: details.mailboxes ?? '' },
          valueKeys: { from: domainStateKey(details.from) },
        }
        : { key: 'admin.audit.detailDomainAdded', values: { domain: details.domain ?? '', mailboxes: details.mailboxes ?? '' } };
    case 'mail_node.domain_adopted':
      return {
        key: details.origin === 'existing_mailboxes' ? 'admin.audit.detailDomainAdoptedWithMailboxes' : 'admin.audit.detailDomainAdopted',
        values: { domain: details.domain ?? '' },
      };
    case 'mail_node.domain_state_changed':
      return {
        key: DOMAIN_STATE_CHANGE_KEYS[details.how] ?? 'admin.audit.detailDomainStepConfirmed',
        values: { domain: details.domain ?? '' },
        valueKeys: { from: domainStateKey(details.from), to: domainStateKey(details.to) },
      };
    // A letter of the node's quarantine an administrator released (delivered to its mailbox and
    // trained as ham; warnings: what the node said went wrong after it went out) or deleted.
    // "Delete and train as spam" reads like a release: the letter, then what the node warned about.
    case 'mail_node.quarantine_released':
    case 'mail_node.quarantine_learned_spam':
    case 'mail_node.quarantine_deleted': {
      const values = { sender: details.sender ?? '', rcpt: details.rcpt ?? '', score: details.score ?? '' };
      if (entry.action === 'mail_node.quarantine_deleted') return { key: 'admin.audit.detailQuarantineDeleted', values };
      const warnings = Array.isArray(details.warnings) && details.warnings.length ? details.warnings.join('; ') : '';
      return warnings
        ? { key: 'admin.audit.detailQuarantineReleasedWarnings', values: { ...values, warnings } }
        : { key: 'admin.audit.detailQuarantineReleased', values };
    }
    // The panel wrote mailcow's quarantine settings: the first time or again, with the values.
    case 'mail_node.quarantine_settings_applied':
      return {
        key: details.reapplied ? 'admin.audit.detailQuarantineSettingsReapplied' : 'admin.audit.detailQuarantineSettingsApplied',
        values: {
          maxSize: details.maxSize ?? '', retention: details.retentionSize ?? '', maxAge: details.maxAge ?? '', format: details.releaseFormat ?? '',
        },
      };
    case 'mail_node.outage_opened':
    case 'mail_node.outage_closed':
    case 'mail_node.outage_added':
    case 'mail_node.outage_changed':
    case 'mail_node.outage_deleted':
      return outageDetail(entry);
    case 'mail_node.domain_identity_acknowledged':
      return {
        key: 'admin.audit.detailDomainIdentityAcknowledged',
        values: { domain: details.domain ?? '', from: details.from ?? '', to: details.to ?? '' },
      };
    default:
      return null;
  }
}
