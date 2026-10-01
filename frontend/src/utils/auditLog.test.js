import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_ACTIONS, auditActionLabelKey, auditDetail, auditQuery } from './auditLog.js';

describe('AUDIT_ACTIONS', () => {
  it('lists every action the server records, each with a label', () => {
    assert.deepEqual(AUDIT_ACTIONS, [
      'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
      'mailbox.enabled', 'mailbox.disabled', 'mailbox.password_restored', 'mailbox.quota_changed', 'message.sent', 'message.deleted',
      'message.move_reverted', 'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
      'access.sync_aborted',
      'mail_node.config_changed', 'mail_node.domain_added', 'mail_node.domain_adopted', 'mail_node.domain_state_changed',
      'mail_node.domain_identity_acknowledged',
    ]);
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
      auditDetail({ action: 'mail_node.config_changed', details: { settings: 'eop', fields: ['terrl', 'tlsPolicy'] } }),
      { key: 'admin.audit.detailEopSettingsChanged', values: {}, valueKeys: { fields: ['admin.audit.fieldTerrl', 'tlsPolicy'] } },
    );
    assert.equal(auditDetail({ action: 'mail_node.config_changed', details: { settings: 'eop', fields: [] } }), null);
  });

  it('names the domain added, adopted or moved on, with its states translated', () => {
    assert.deepEqual(
      auditDetail({ action: 'mail_node.domain_added', details: { domain: 'new.example', mailboxes: 50 } }),
      { key: 'admin.audit.detailDomainAdded', values: { domain: 'new.example', mailboxes: 50 } },
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

  it('shows nothing for actions without details or unknown entries', () => {
    assert.equal(auditDetail({ action: 'mailbox.deleted', details: {} }), null);
    assert.equal(auditDetail({ action: 'mailbox.disabled' }), null);
    assert.equal(auditDetail(null), null);
  });
});
