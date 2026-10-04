import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_ACTIONS, auditActionLabelKey, auditDetail, auditQuery } from './auditLog.js';

describe('AUDIT_ACTIONS', () => {
  it('lists every action the server records, each with a label', () => {
    assert.deepEqual(AUDIT_ACTIONS, [
      'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
      'mailbox.enabled', 'mailbox.disabled', 'mailbox.password_restored', 'mailbox.quota_changed',
      'mailbox.rate_limit_changed', 'mailbox.deletion_requested', 'mailbox.deletion_cancelled', 'mailbox.oauth_subject_reset',
      'message.sent', 'message.deleted',
      'message.move_reverted', 'message.send_queued', 'message.send_cancelled', 'message.send_rescheduled', 'message.send_failed',
      'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
      'access.sync_aborted',
      'mail_node.config_changed', 'mail_node.domain_added', 'mail_node.domain_adopted', 'mail_node.domain_state_changed',
      'mail_node.domain_identity_acknowledged', 'mail_node.applied', 'mail_node.dns_checked',
      'mail_node.queue_action', 'mail_node.alert_raised', 'mail_node.alert_cleared',
      'mail_node.quarantine_released', 'mail_node.quarantine_deleted', 'mail_node.quarantine_learned_spam',
      'mail_node.quarantine_settings_applied',
      'mail_node.outage_opened', 'mail_node.outage_closed', 'mail_node.outage_added', 'mail_node.outage_changed',
      'mail_node.outage_deleted',
      'tenant.connection_tested', 'tenant.recipients_synced', 'tenant.connector_reference_taken',
      'tenant.domain_hold_changed', 'tenant.internal_relay_approved',
      'tenant.quarantine_released', 'tenant.phish_release_changed', 'tenant.message_traced', 'tenant.antispam_enforced',
      'tenant.alias_contacts_removal_approved',
      'rule.created', 'rule.updated', 'rule.deleted', 'rule.run',
    ]);
    // Section 5.14: the type in words, as EOP wrote it for one the panel does not name.
    assert.deepEqual(auditDetail({ action: 'tenant.quarantine_released', details: { type: 'Spam', sender: 's@x.test', recipients: ['a@example.com'], messageId: '<m@x>' } }), {
      key: 'admin.audit.detailTenantQuarantineReleased', values: { sender: 's@x.test', recipients: 'a@example.com', messageId: '<m@x>' }, valueKeys: { type: 'admin.tenant.qtypeSpam' },
    });
    assert.deepEqual(auditDetail({ action: 'tenant.quarantine_released', details: { type: 'Odd', sender: '', recipients: [], messageId: '' } }).values.type, 'Odd');
    assert.deepEqual(auditDetail({ action: 'tenant.alias_contacts_removal_approved', details: { domain: 'example.com', addresses: ['sales@example.com'] } }), {
      key: 'admin.audit.detailTenantAliasContactsApproved', values: { domain: 'example.com', addresses: 'sales@example.com' },
    });
    assert.deepEqual(auditDetail({ action: 'tenant.antispam_enforced', details: { changed: [{ field: 'PhishSpamAction', from: 'Quarantine', to: 'MoveToJmf' }] } }), {
      key: 'admin.audit.detailTenantAntispamEnforced', values: { fields: 'PhishSpamAction: Quarantine → MoveToJmf' },
    });
    assert.deepEqual(auditDetail({ action: 'tenant.domain_hold_changed', details: { domain: 'example.com', hold: false } }), {
      key: 'admin.audit.detailTenantHoldOff', values: { domain: 'example.com' },
    });
    assert.deepEqual(auditDetail({ action: 'tenant.recipients_synced', details: { domain: 'example.com', created: 2, removed: 1 } }), {
      key: 'admin.audit.detailTenantRecipients', values: { domain: 'example.com', created: 2, removed: 1, retargeted: 0 },
    });
    assert.deepEqual(auditDetail({ action: 'tenant.connector_reference_taken', details: { inbound: ['From mail node'], outbound: ['To mail node'] } }), {
      key: 'admin.audit.detailTenantConnectorReference', values: { names: 'From mail node, To mail node' },
    });
    assert.equal(auditActionLabelKey('tenant.connection_tested'), 'admin.audit.actionTenantConnectionTested');
    assert.deepEqual(auditDetail({ action: 'tenant.connection_tested', details: { ok: true, failed: [] } }), { key: 'admin.audit.detailTenantTestOk', values: {} });
    assert.deepEqual(auditDetail({ action: 'tenant.connection_tested', details: { ok: false, failed: ['exo:exo_connect_failed'] } }), {
      key: 'admin.audit.detailTenantTestFailed', values: { steps: 'exo:exo_connect_failed' },
    });
    // Stage 7c: a release from EOP's quarantine, the pause switch, a trace asked for.
    assert.deepEqual(auditDetail({ action: 'tenant.quarantine_released', details: { sender: 'x@phish.example.net', recipients: ['a@example.com', 'b@example.com'], messageId: '<m@x>' } }), {
      key: 'admin.audit.detailTenantQuarantineReleasedNoType', values: { sender: 'x@phish.example.net', recipients: 'a@example.com, b@example.com', messageId: '<m@x>' },
    });
    assert.deepEqual(auditDetail({ action: 'tenant.phish_release_changed', details: { enabled: false } }), { key: 'admin.audit.detailTenantPhishReleaseOff', values: {} });
    assert.deepEqual(auditDetail({ action: 'tenant.message_traced', details: { messageId: '<m@x>' } }), { key: 'admin.audit.detailTenantMessageTraced', values: { messageId: '<m@x>' } });
    assert.equal(auditActionLabelKey('mail_node.applied'), 'admin.audit.actionMailNodeApplied');
    assert.equal(auditActionLabelKey('mailbox.rate_limit_changed'), 'admin.audit.actionMailboxRateLimitChanged');
    assert.equal(auditActionLabelKey('mail_node.domain_identity_acknowledged'), 'admin.audit.actionMailNodeDomainIdentityAcknowledged');
    assert.equal(auditActionLabelKey('mail_node.domain_state_changed'), 'admin.audit.actionMailNodeDomainStateChanged');
    assert.equal(auditActionLabelKey('message.sent'), 'admin.audit.actionMessageSent');
    assert.equal(auditActionLabelKey('mailbox.password_restored'), 'admin.audit.actionMailboxPasswordRestored');
    assert.equal(auditActionLabelKey('user.admin_changed'), 'admin.audit.actionUserAdminChanged');
    assert.equal(auditActionLabelKey('access.sync_aborted'), 'admin.audit.actionAccessSyncAborted');
    assert.equal(auditActionLabelKey('message.read'), null);
  });
});

describe('auditQuery', () => {
  it('leaves empty filters out', () => {
    assert.deepEqual(auditQuery({}), {});
    assert.deepEqual(auditQuery({ account: '', user: '', action: '', fromDate: '', toDate: '', before: null }), {});
    assert.deepEqual(auditQuery(), {});
  });

  it('passes the chosen mailbox, user, action and cursor through', () => {
    assert.deepEqual(
      auditQuery({ account: 'acc-1', user: 'user-1', action: 'message.deleted', before: '2026-09-17T10:00:00.123456Z_42' }),
      { account: 'acc-1', user: 'user-1', action: 'message.deleted', before: '2026-09-17T10:00:00.123456Z_42' },
    );
  });

  it('turns local days into an inclusive range: from the start of the first day to the start of the day after the last', () => {
    assert.deepEqual(auditQuery({ fromDate: '2026-09-01', toDate: '2026-09-17' }), {
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 8, 18).toISOString(),
    });
    assert.deepEqual(auditQuery({ toDate: '2026-12-31' }), { to: new Date(2027, 0, 1).toISOString() });
  });

  it('ignores a date that is not a calendar day', () => {
    assert.deepEqual(auditQuery({ fromDate: 'yesterday', toDate: '17.09.2026' }), {});
  });
});

describe('auditDetail', () => {
  it('says why a queued move was reverted and where the letter went back', () => {
    const detail = (reason) => auditDetail({ action: 'message.move_reverted', details: { messageId: '<m@x>', from: 'Trash', to: 'INBOX', reason } });
    assert.deepEqual(detail('gone'), { key: 'admin.audit.detailMoveRevertedGone', values: { from: 'Trash', to: 'INBOX' } });
    assert.deepEqual(detail('destination_gone'), { key: 'admin.audit.detailMoveRevertedDestinationGone', values: { from: 'Trash', to: 'INBOX' } });
    assert.deepEqual(detail('gave_up'), { key: 'admin.audit.detailMoveRevertedGaveUp', values: { from: 'Trash', to: 'INBOX' } });
    assert.equal(auditActionLabelKey('message.move_reverted'), 'admin.audit.actionMessageMoveReverted');
  });

  it('names the OAuth provider of an added or reconnected mailbox', () => {
    assert.deepEqual(
      auditDetail({ action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: 'google' } }),
      { key: 'admin.audit.detailProvider', values: { provider: 'google' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mailbox.reconnected', details: { oauthProvider: 'microsoft' } }),
      { key: 'admin.audit.detailProvider', values: { provider: 'microsoft' } },
    );
    assert.equal(auditDetail({ action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: null } }), null);
  });

  it('lists changed connection fields', () => {
    assert.deepEqual(
      auditDetail({ action: 'mailbox.connection_changed', details: { fields: ['imap_host', 'auth_pass'] } }),
      { key: 'admin.audit.detailFields', values: { fields: 'imap_host, auth_pass' } },
    );
    assert.equal(auditDetail({ action: 'mailbox.connection_changed', details: { fields: [] } }), null);
  });

  it('lists every recipient of a sent message', () => {
    assert.deepEqual(
      auditDetail({ action: 'message.sent', details: { messageId: '<m@x>', to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'] } }),
      { key: 'admin.audit.detailRecipients', values: { recipients: 'a@example.com, b@example.com, c@example.com' } },
    );
  });

  it('describes a queued, cancelled, moved and failed letter without its content', () => {
    assert.equal(auditDetail({ action: 'message.send_queued', details: { jobId: '1', scheduled: false } }), null);
    const scheduled = auditDetail({ action: 'message.send_queued', details: { jobId: '1', scheduled: true, sendAt: '2026-10-05T08:00:00.000Z' } });
    assert.equal(scheduled.key, 'admin.audit.detailSendScheduled');
    assert.ok(scheduled.values.time);
    assert.deepEqual(auditDetail({ action: 'message.send_cancelled', details: { reason: 'undo' } }), { key: 'admin.audit.detailSendCancelledUndo', values: {} });
    assert.deepEqual(auditDetail({ action: 'message.send_cancelled', details: { reason: 'edit' } }), { key: 'admin.audit.detailSendCancelledEdit', values: {} });
    assert.deepEqual(auditDetail({ action: 'message.send_cancelled', details: {} }), { key: 'admin.audit.detailSendCancelledDiscard', values: {} });
    assert.deepEqual(auditDetail({ action: 'message.send_rescheduled', details: { resend: true } }), { key: 'admin.audit.detailSendResent', values: {} });
    assert.deepEqual(auditDetail({ action: 'message.send_failed', details: { status: 'needs_attention' } }), { key: 'admin.audit.detailSendUncertain', values: {} });
    assert.deepEqual(auditDetail({ action: 'message.send_failed', details: { status: 'failed', code: 'smtp_rejected' } }), { key: 'admin.audit.detailSendFailed', values: { code: 'smtp_rejected' } });
  });

  it('tells a move to Trash from a permanent delete', () => {
    assert.deepEqual(
      auditDetail({ action: 'message.deleted', details: { messageId: '<m@x>', folder: 'INBOX', from: 's@example.com', permanent: false } }),
      { key: 'admin.audit.detailMovedToTrash', values: { from: 's@example.com', folder: 'INBOX' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'message.deleted', details: { folder: 'Trash', from: null, permanent: true } }),
      { key: 'admin.audit.detailDeletedForeverNoSender', values: { folder: 'Trash' } },
    );
  });

  it('drops the sender clause when a deleted message has no sender address', () => {
    assert.deepEqual(
      auditDetail({ action: 'message.deleted', details: { folder: 'INBOX', permanent: false } }),
      { key: 'admin.audit.detailMovedToTrashNoSender', values: { folder: 'INBOX' } },
    );
  });

  it('describes user actions by email', () => {
    assert.deepEqual(
      auditDetail({ action: 'user.admin_changed', details: { userId: 'u', email: 'u@example.com', isAdmin: true } }),
      { key: 'admin.audit.detailAdminGranted', values: { email: 'u@example.com' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'user.admin_changed', details: { userId: 'u', email: 'u@example.com', isAdmin: false } }),
      { key: 'admin.audit.detailAdminRevoked', values: { email: 'u@example.com' } },
    );
    assert.deepEqual(auditDetail({ action: 'user.disabled', details: { userId: 'u', email: 'u@example.com', isAdmin: false } }), { text: 'u@example.com' });
    assert.equal(auditDetail({ action: 'user.deleted', details: { userId: 'u', email: null, isAdmin: false } }), null);
  });

  it('lists the users a stopped Access sync would have disabled', () => {
    assert.deepEqual(
      auditDetail({ action: 'access.sync_aborted', details: { candidates: ['a@example.com', 'b@example.com'], activeUsers: 3, maxDisables: 1 } }),
      { key: 'admin.audit.detailAccessSyncAborted', values: { wouldDisable: 2, emails: 'a@example.com, b@example.com' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'access.sync_aborted', details: {} }),
      { key: 'admin.audit.detailAccessSyncAborted', values: { wouldDisable: 0, emails: '' } },
    );
  });

  it('describes mail node settings changes by the names of the fields', () => {
    assert.deepEqual(
      auditDetail({ action: 'mail_node.config_changed', details: { settings: 'node', fields: ['apiKey', 'quotaMb'] } }),
      { key: 'admin.audit.detailMailNodeSettingsChanged', values: {}, valueKeys: { fields: ['admin.audit.fieldApiKey', 'admin.audit.fieldQuota'] } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.config_changed', details: { settings: 'eop', fields: ['terrl', 'tlsPolicy', 'futureField'] } }),
      { key: 'admin.audit.detailEopSettingsChanged', values: {}, valueKeys: { fields: ['admin.audit.fieldTerrl', 'admin.audit.fieldTlsPolicy', 'futureField'] } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.config_changed', details: { settings: 'node', fields: ['panelIps'] } }).valueKeys,
      { fields: ['admin.audit.fieldPanelIps'] },
    );
  });

  it('describes the values a domain must publish by the names of the fields', () => {
    assert.deepEqual(
      auditDetail({ action: 'mail_node.config_changed', details: { settings: 'domain_dns', domain: 'a.example', fields: ['mx', 'tenantTxt'] } }),
      {
        key: 'admin.audit.detailDomainDnsExpectedChanged', values: { domain: 'a.example' },
        valueKeys: { fields: ['admin.audit.fieldExpectedMx', 'admin.audit.fieldTenantTxt'] },
      },
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.config_changed', details: { settings: 'eop', fields: ['nodeIp'] } }).valueKeys,
      { fields: ['admin.audit.fieldNodeIp'] },
    );
  });

  it('describes a DNS check: everything at once, or one scope with its status before', () => {
    assert.deepEqual(
      auditDetail({
        action: 'mail_node.dns_checked',
        details: { scope: 'all', trigger: 'manual', overall: 'ok', from: null, counts: { ok: 2, warning: 1, error: 1 }, errorDomains: ['b.example'] },
      }),
      { key: 'admin.audit.detailDnsCheckedAll', values: { ok: 2, warning: 1, error: 1, lookupFailed: 0, domains: 'b.example' }, valueKeys: { overall: 'admin.mailNode.dnsStatusOk' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.dns_checked', details: { scope: 'domain', domain: 'a.example', lookupFailed: true, code: 'dns_lookup_failed' } }),
      { key: 'admin.audit.detailDnsCheckLookupFailed', values: { scope: 'a.example', code: 'dns_lookup_failed' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.dns_checked', details: { scope: 'node', lookupFailed: true, code: 'dns_resolver_invalid' } }),
      { key: 'admin.audit.detailDnsCheckLookupFailed', values: { code: 'dns_resolver_invalid' }, valueKeys: { scope: 'admin.audit.detailDnsScopeNode' } },
    );
    assert.equal(
      auditDetail({ action: 'mail_node.dns_checked', details: { scope: 'all', lookupFailed: true, code: 'dns_lookup_failed', counts: {} } }).key,
      'admin.audit.detailDnsCheckedAllFailed',
    );
    assert.deepEqual(
      auditDetail({
        action: 'mail_node.dns_checked',
        details: { scope: 'domain', domain: 'a.example', trigger: 'schedule', overall: 'error', from: 'ok', errors: ['mx'], warnings: [] },
      }),
      {
        key: 'admin.audit.detailDnsCheckedDomain', values: { domain: 'a.example', warnings: '—' },
        valueKeys: { overall: 'admin.mailNode.dnsStatusError', from: 'admin.mailNode.dnsStatusOk', errors: ['admin.mailNode.dnsCheckMx'] },
      },
    );
    const node = auditDetail({ action: 'mail_node.dns_checked', details: { scope: 'node', overall: 'warning', from: null, errors: [], warnings: ['node_aaaa'] } });
    assert.equal(node.key, 'admin.audit.detailDnsCheckedNode');
    assert.deepEqual(node.valueKeys, {
      overall: 'admin.mailNode.dnsStatusWarning', from: 'admin.audit.detailDnsCheckedFirst', warnings: ['admin.mailNode.dnsCheckNodeAaaa'],
    });
    assert.equal(auditActionLabelKey('mail_node.dns_checked'), 'admin.audit.actionMailNodeDnsChecked');
  });

  it('describes what an apply of the node settings changed and what failed', () => {
    assert.deepEqual(
      auditDetail({
        action: 'mail_node.applied',
        details: { scope: 'node', trigger: 'manual', changed: [{ item: 'tls_policy', target: 'eop.example.net', from: null, to: 'secure' }], failed: [] },
      }),
      { key: 'admin.audit.detailAppliedChanged', values: {}, valueKeys: { scope: 'admin.audit.detailApplyScopeNode', changed: ['admin.mailNode.applyItemTlsPolicy'], failed: [] } },
    );
    assert.deepEqual(
      auditDetail({
        action: 'mail_node.applied',
        details: { scope: 'domain', domain: 'a.example', changed: [{ item: 'dkim' }], failed: [{ item: 'mailbox_limits', code: 'mail_node_refused' }] },
      }),
      {
        key: 'admin.audit.detailAppliedBoth', values: { scope: 'a.example' },
        valueKeys: { changed: ['admin.mailNode.applyItemDkim'], failed: ['admin.mailNode.applyItemMailboxLimits'] },
      },
    );
    assert.equal(
      auditDetail({ action: 'mail_node.applied', details: { scope: 'prefilter', changed: [], failed: [{ item: 'prefilter' }] } }).key,
      'admin.audit.detailAppliedFailed',
    );
  });

  it('describes a send limit set for one mailbox or set back to the default', () => {
    assert.deepEqual(
      auditDetail({ action: 'mailbox.rate_limit_changed', details: { value: 200, frame: 'd', override: true, from: null } }),
      { key: 'admin.audit.detailRateLimitSet', values: { value: 200 }, valueKeys: { frame: 'admin.mailNode.rateFrameD' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mailbox.rate_limit_changed', details: { value: 50, frame: 'h', override: false, from: { value: 200, frame: 'd' } } }),
      { key: 'admin.audit.detailRateLimitDefault', values: { value: 50 }, valueKeys: { frame: 'admin.mailNode.rateFrameH' } },
    );
    assert.equal(auditDetail({ action: 'mail_node.config_changed', details: { settings: 'eop', fields: [] } }), null);
  });

  it('names the domain added, adopted or moved on, with its states translated', () => {
    assert.deepEqual(
      auditDetail({ action: 'mail_node.domain_added', details: { domain: 'new.example', mailboxes: 50 } }),
      { key: 'admin.audit.detailDomainAdded', values: { domain: 'new.example', mailboxes: 50 } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.domain_added', details: { domain: 'new.example', mailboxes: 50, from: 'dns_ok', steps: {} } }),
      {
        key: 'admin.audit.detailDomainAddedAgain', values: { domain: 'new.example', mailboxes: 50 },
        valueKeys: { from: 'admin.mailNode.stateDnsOk' },
      },
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.domain_adopted', details: { domain: 'stage.test', state: 'ready', origin: 'existing_mailboxes' } }),
      { key: 'admin.audit.detailDomainAdoptedWithMailboxes', values: { domain: 'stage.test' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.domain_adopted', details: { domain: 'manual.example', state: 'node_created', origin: 'adopted' } }),
      { key: 'admin.audit.detailDomainAdopted', values: { domain: 'manual.example' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.domain_state_changed', details: { domain: 'a.example', from: 'dns_ok', to: 'tenant_verified', how: 'step_confirmed' } }),
      {
        key: 'admin.audit.detailDomainStepConfirmed', values: { domain: 'a.example' },
        valueKeys: { from: 'admin.mailNode.stateDnsOk', to: 'admin.mailNode.stateTenantVerified' },
      },
    );
    assert.equal(
      auditDetail({ action: 'mail_node.domain_state_changed', details: { domain: 'a.example', from: 'node_created', to: 'ready', how: 'marked_ready' } }).key,
      'admin.audit.detailDomainMarkedReady',
    );
    assert.deepEqual(
      auditDetail({ action: 'mail_node.domain_state_changed', details: { domain: 'a.example', from: 'ready', to: 'node_created', how: 'restarted' } }),
      {
        key: 'admin.audit.detailDomainRestarted', values: { domain: 'a.example' },
        valueKeys: { from: 'admin.mailNode.stateReady', to: 'admin.mailNode.stateNodeCreated' },
      },
    );
  });

  it('names both creation times when an administrator accepts the one the node reports', () => {
    assert.deepEqual(
      auditDetail({
        action: 'mail_node.domain_identity_acknowledged',
        details: { domain: 'a.example', from: '2026-09-01 10:00:00', to: '2026-09-30 12:00:00' },
      }),
      {
        key: 'admin.audit.detailDomainIdentityAcknowledged',
        values: { domain: 'a.example', from: '2026-09-01 10:00:00', to: '2026-09-30 12:00:00' },
      },
    );
  });

  it('keeps the reason of a node mailbox deletion through request, cancel and the final delete', () => {
    const at = '2026-10-01T10:00:00.000Z';
    const date = '2026-10-06T10:00:00.000Z';
    const requested = auditDetail({ action: 'mailbox.deletion_requested', details: { mailNode: true, deleteAfter: date, days: 5, reason: 'Left' } });
    assert.equal(requested.key, 'admin.audit.detailDeletionRequested');
    assert.equal(requested.values.reason, 'Left');
    assert.ok(requested.values.date.includes('2026'));
    assert.equal(auditDetail({ action: 'mailbox.deletion_cancelled', details: { deleteAfter: date, reason: 'Left' } }).key, 'admin.audit.detailDeletionCancelled');
    const deleted = auditDetail({
      action: 'mailbox.deleted', details: { mailNode: true, pending: true, requestedBy: 'anna@example.com', requestedAt: at, reason: 'Left' },
    });
    assert.equal(deleted.key, 'admin.audit.detailMailNodeMailboxPending');
    assert.equal(deleted.values.by, 'anna@example.com');
    assert.equal(deleted.values.reason, 'Left');
    assert.equal(
      auditDetail({ action: 'mailbox.deleted', details: { mailNode: true, pending: true, reason: 'Left', nodeWarnings: ['w'] } }).key,
      'admin.audit.detailMailNodeMailboxPendingWarnings',
    );
    assert.equal(auditActionLabelKey('mailbox.deletion_requested'), 'admin.audit.actionMailboxDeletionRequested');
  });

  it('describes a quota change and the delete of a mail node mailbox', () => {
    assert.deepEqual(
      auditDetail({ action: 'mailbox.quota_changed', details: { quotaMb: 10240, from: 5120 } }),
      { key: 'admin.audit.detailQuotaChanged', values: { from: 5120, to: 10240 } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mailbox.quota_changed', details: { quotaMb: 10240, from: null } }),
      { key: 'admin.audit.detailQuotaSet', values: { to: 10240 } },
    );
    assert.deepEqual(auditDetail({ action: 'mailbox.deleted', details: { mailNode: true } }), { key: 'admin.audit.detailMailNodeMailbox', values: {} });
    assert.deepEqual(
      auditDetail({ action: 'mailbox.deleted', details: { mailNode: true, nodeWarnings: ['Could not move maildir to garbage collector: x'] } }),
      { key: 'admin.audit.detailMailNodeMailboxWarnings', values: { warnings: 'Could not move maildir to garbage collector: x' } },
    );
    assert.equal(auditDetail({ action: 'mailbox.deleted', details: { mailNode: false } }), null);
  });

  it('describes a released or deleted quarantine letter and the quarantine setting', () => {
    const details = { id: 3, qid: 'Q3', rcpt: 'info@example.com', sender: 'spam@bad.test', score: 16.1, action: 'reject' };
    assert.deepEqual(auditDetail({ action: 'mail_node.quarantine_released', details: { ...details, learned: true } }), {
      key: 'admin.audit.detailQuarantineReleased', values: { sender: 'spam@bad.test', rcpt: 'info@example.com', score: 16.1 },
    });
    assert.deepEqual(auditDetail({ action: 'mail_node.quarantine_released', details: { ...details, warnings: ['ham_learn_error x'] } }), {
      key: 'admin.audit.detailQuarantineReleasedWarnings',
      values: { sender: 'spam@bad.test', rcpt: 'info@example.com', score: 16.1, warnings: 'ham_learn_error x' },
    });
    assert.deepEqual(auditDetail({ action: 'mail_node.quarantine_deleted', details }), {
      key: 'admin.audit.detailQuarantineDeleted', values: { sender: 'spam@bad.test', rcpt: 'info@example.com', score: 16.1 },
    });
    assert.deepEqual(auditDetail({ action: 'mail_node.config_changed', details: { settings: 'quarantine', fields: ['userView'] } }), {
      key: 'admin.audit.detailQuarantineSettingsChanged', values: {}, valueKeys: { fields: ['admin.audit.fieldQuarantineUserView'] },
    });
    assert.equal(auditActionLabelKey('mail_node.quarantine_released'), 'admin.audit.actionMailNodeQuarantineReleased');
    assert.deepEqual(auditDetail({ action: 'mail_node.quarantine_learned_spam', details: { ...details, learned: true } }), {
      key: 'admin.audit.detailQuarantineReleased', values: { sender: 'spam@bad.test', rcpt: 'info@example.com', score: 16.1 },
    });
    const applied = { maxSize: 10, retentionSize: 20, maxAge: 365, releaseFormat: 'raw' };
    assert.deepEqual(auditDetail({ action: 'mail_node.quarantine_settings_applied', details: { reapplied: false, ...applied } }), {
      key: 'admin.audit.detailQuarantineSettingsApplied', values: { maxSize: 10, retention: 20, maxAge: 365, format: 'raw' },
    });
    assert.equal(
      auditDetail({ action: 'mail_node.quarantine_settings_applied', details: { reapplied: true, ...applied } }).key,
      'admin.audit.detailQuarantineSettingsReapplied',
    );
  });

  it('shows nothing for actions without details or unknown entries', () => {
    assert.equal(auditDetail({ action: 'mailbox.deleted', details: {} }), null);
    assert.equal(auditDetail({ action: 'mailbox.disabled' }), null);
    assert.equal(auditDetail(null), null);
  });
});

describe('auditDetail of the node operations', () => {
  it('names the queue action, the message and its envelope, or the whole queue', () => {
    assert.deepEqual(auditDetail({
      action: 'mail_node.queue_action',
      details: { action: 'delete', queueId: '53A99193F13', queue: 'deferred', sender: 'someone@stage.test', size: 360, recipients: ['a@example.org', 'b@example.org'] },
    }), {
      key: 'admin.audit.detailQueueAction',
      values: { id: '53A99193F13', sender: 'someone@stage.test', recipients: 'a@example.org, b@example.org' },
      valueKeys: { action: 'admin.nodeOps.actionDelete' },
    });
    assert.equal(auditDetail({ action: 'mail_node.queue_action', details: { action: 'hold', queueId: 'AB12CD34EF', sender: '', recipients: [] } }).values.sender, '<>');
    assert.deepEqual(auditDetail({ action: 'mail_node.queue_action', details: { action: 'flush' } }), { key: 'admin.audit.detailQueueFlush', values: {} });
    assert.equal(auditDetail({ action: 'mail_node.queue_action', details: { action: 'view_body', queueId: 'AB12CD34EF', sender: 'a@b.c', recipients: ['d@e.f'] } }).valueKeys.action, 'admin.nodeOps.actionViewBody');
  });

  it('names the alert raised or cleared', () => {
    assert.deepEqual(auditDetail({ action: 'mail_node.alert_raised', details: { alert: 'connector_blocked', severity: 'error', count: 2 } }), {
      key: 'admin.audit.detailAlertRaised', values: {}, valueKeys: { alert: 'admin.nodeOps.alertConnectorBlocked' },
    });
    assert.equal(auditDetail({ action: 'mail_node.alert_cleared', details: { alert: 'eop_bypass' } }).key, 'admin.audit.detailAlertCleared');
  });

  it('describes an outage window of the node: what failed, its times, the reason, the fields changed (R-43)', () => {
    const times = { startedAt: '2026-10-02T12:22:40.902Z', endedAt: '2026-10-02T12:26:21.702Z' };
    assert.equal(auditDetail({ action: 'mail_node.outage_opened', details: { ...times, endedAt: null, down: ['postfix-mailcow'] } }).values.down, 'postfix-mailcow');
    assert.equal(auditDetail({ action: 'mail_node.outage_opened', details: { startedAt: times.startedAt, down: [] } }).key, 'admin.audit.detailOutageOpenedApi');
    const closed = auditDetail({ action: 'mail_node.outage_closed', details: { ...times, minutes: 4 } });
    assert.equal(closed.key, 'admin.audit.detailOutageClosed');
    assert.equal(closed.values.minutes, 4);
    assert.notEqual(closed.values.start, '—');
    assert.equal(auditDetail({ action: 'mail_node.outage_closed', details: { ...times, reason: 'Back' } }).key, 'admin.audit.detailOutageClosedReason');
    assert.equal(auditDetail({ action: 'mail_node.outage_added', details: { ...times, planned: true, reason: 'Update' } }).key, 'admin.audit.detailOutageAddedPlanned');
    assert.equal(auditDetail({ action: 'mail_node.outage_added', details: { startedAt: times.startedAt, endedAt: null, reason: 'x' } }).values.end, '—');
    assert.deepEqual(auditDetail({ action: 'mail_node.outage_changed', details: { ...times, fields: ['startedAt', 'reason'], reason: 'Earlier' } }).valueKeys, {
      fields: ['admin.audit.fieldOutageStart', 'admin.audit.fieldOutageReason'],
    });
    assert.equal(auditDetail({ action: 'mail_node.outage_deleted', details: { ...times, reason: 'Twice' } }).values.reason, 'Twice');
    assert.equal(auditDetail({ action: 'mail_node.config_changed', details: { settings: 'outages', fields: ['retentionDays'] } }).key, 'admin.audit.detailOutageSettingsChanged');
  });

  it('names the alert settings and the TERRL fields that changed', () => {
    assert.deepEqual(auditDetail({ action: 'mail_node.config_changed', details: { settings: 'alerts', fields: ['pingUrl', 'deferredCount'] } }), {
      key: 'admin.audit.detailAlertSettingsChanged', values: {},
      valueKeys: { fields: ['admin.audit.fieldAlertPingUrl', 'admin.audit.fieldDeferredCount'] },
    });
    assert.deepEqual(
      auditDetail({ action: 'mail_node.config_changed', details: { settings: 'eop', fields: ['licenses', 'tenantCreatedOn'] } }).valueKeys.fields,
      ['admin.audit.fieldLicenses', 'admin.audit.fieldTenantCreated'],
    );
  });
});

describe('auditDetail for inbox rules', () => {
  it('names the rule and where it forwards to', () => {
    assert.deepEqual(auditDetail({ action: 'rule.created', details: { name: 'Copy', forwardTo: 'books@example.net' } }), {
      key: 'admin.audit.detailRuleForward', values: { name: 'Copy', address: 'books@example.net' },
    });
    assert.deepEqual(auditDetail({ action: 'rule.deleted', details: { name: 'Star', forwardTo: null } }), {
      key: 'admin.audit.detailRule', values: { name: 'Star' },
    });
  });

  it('shows a forward target a change moved or removed', () => {
    assert.deepEqual(auditDetail({ action: 'rule.updated', details: { name: 'Copy', forwardTo: 'new@example.net', previousForwardTo: 'old@example.net' } }), {
      key: 'admin.audit.detailRuleForwardChanged', values: { name: 'Copy', from: 'old@example.net', to: 'new@example.net' },
    });
    assert.deepEqual(auditDetail({ action: 'rule.updated', details: { name: 'Copy', forwardTo: null, previousForwardTo: 'old@example.net' } }), {
      key: 'admin.audit.detailRuleForwardRemoved', values: { name: 'Copy', from: 'old@example.net' },
    });
    assert.deepEqual(auditDetail({ action: 'rule.updated', details: { name: 'Copy', forwardTo: 'same@example.net', previousForwardTo: 'same@example.net' } }), {
      key: 'admin.audit.detailRuleForward', values: { name: 'Copy', address: 'same@example.net' },
    });
  });
});

describe('auditDetail for a rules run and an OAuth binding reset', () => {
  it('counts the rules a run ran', () => {
    assert.deepEqual(auditDetail({ action: 'rule.run', details: { ruleIds: ['a', 'b'], allMailboxes: true } }), {
      key: 'admin.audit.detailRuleRun', values: { count: 2 },
    });
  });

  it('names the provider of a reset binding', () => {
    assert.deepEqual(auditDetail({ action: 'mailbox.oauth_subject_reset', details: { oauthProvider: 'microsoft' } }), {
      key: 'admin.audit.detailProvider', values: { provider: 'microsoft' },
    });
  });
});
