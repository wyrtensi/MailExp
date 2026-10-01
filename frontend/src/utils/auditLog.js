import { domainStateKey } from './mailNode.js';

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
  'message.sent': 'admin.audit.actionMessageSent',
  'message.deleted': 'admin.audit.actionMessageDeleted',
  'message.move_reverted': 'admin.audit.actionMessageMoveReverted',
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
});

export const AUDIT_ACTIONS = Object.freeze(Object.keys(AUDIT_ACTION_LABEL_KEYS));

// Why a queued move was reverted: the letter was gone from the server, the destination folder was
// gone, or the server kept refusing the move.
const MOVE_REVERTED_DETAIL_KEYS = Object.freeze({
  gone: 'admin.audit.detailMoveRevertedGone',
  destination_gone: 'admin.audit.detailMoveRevertedDestinationGone',
  gave_up: 'admin.audit.detailMoveRevertedGaveUp',
});

// How a mail_node.domain_state_changed entry moved the domain: "Done", "Mark ready" or "Restart
// onboarding".
const DOMAIN_STATE_CHANGE_KEYS = Object.freeze({
  step_confirmed: 'admin.audit.detailDomainStepConfirmed',
  marked_ready: 'admin.audit.detailDomainMarkedReady',
  restarted: 'admin.audit.detailDomainRestarted',
});

// The settings fields a mail_node.config_changed entry names, as the journal shows them.
const SETTINGS_FIELD_KEYS = Object.freeze({
  mailHost: 'admin.audit.fieldMailHost',
  apiKey: 'admin.audit.fieldApiKey',
  quotaMb: 'admin.audit.fieldQuota',
  diskPingUrl: 'admin.audit.fieldPingUrl',
  eopHost: 'admin.audit.fieldEopHost',
  certificateHost: 'admin.audit.fieldCertificateHost',
  dkimMode: 'admin.audit.fieldDkimMode',
  sendLimitPerHour: 'admin.audit.fieldSendLimit',
  terrl: 'admin.audit.fieldTerrl',
  tenantId: 'admin.audit.fieldTenantId',
  appId: 'admin.audit.fieldAppId',
  certThumbprint: 'admin.audit.fieldThumbprint',
});

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
    case 'mailbox.deleted':
      // nodeWarnings: the node deleted the mailbox but said something went wrong on the way (its
      // maildir could not be moved away), shown as the node wrote it.
      if (!details.mailNode) return null;
      return Array.isArray(details.nodeWarnings) && details.nodeWarnings.length
        ? { key: 'admin.audit.detailMailNodeMailboxWarnings', values: { warnings: details.nodeWarnings.join('; ') } }
        : { key: 'admin.audit.detailMailNodeMailbox', values: {} };
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
          key: details.settings === 'eop' ? 'admin.audit.detailEopSettingsChanged' : 'admin.audit.detailMailNodeSettingsChanged',
          values: {},
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
    case 'mail_node.domain_identity_acknowledged':
      return {
        key: 'admin.audit.detailDomainIdentityAcknowledged',
        values: { domain: details.domain ?? '', from: details.from ?? '', to: details.to ?? '' },
      };
    default:
      return null;
  }
}
