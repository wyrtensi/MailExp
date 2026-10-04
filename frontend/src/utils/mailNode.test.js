import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canMarkReady,
  domainStateKey,
  eopSettingsError,
  normalizeEopSettings,
  onboardingSteps,
  tenantPending,
  tenantFailureKey,
  alertDetail,
  alertTitleKey,
  domainMailboxFormError,
  canDeleteAccount,
  deletionDate,
  deletionReasonError,
  isMailNodeErrorCode,
  nodeMailboxDeleteDialog,
  pendingDeletion,
  canRestartOnboarding,
  deleteConfirmationMatches,
  nodeAliasesNote,
  NODE_MAILBOX_DELETE_ADMIN_ONLY,
  domainMailboxTaken,
  senderNameError,
  senderNamesPayload,
  mailNodeConfigError,
  mailNodeErrorDetail,
  mailNodeErrorKey,
  quotaMbInGb,
  selectableDomains,
  sizeParts,
  usagePercent,
  applyItemKey,
  applyStatusKey,
  dkimDeleteWaiting,
  eopSettingsConflict,
  tlsParametersFit,
  parseNetwork,
  parseNetworkList,
  parseTlsParameters,
  prefilterDoneKey,
  prefilterPending,
  rateFrameKey,
  rateLimitError,
  rateLimitState,
  dnsCheckKey,
  dnsCodeKey,
  dnsCodeValues,
  dnsStatusKey,
  dnsSummary,
  dnsVerdictKey,
  expectedForm,
  expectedValuesError,
  hasDnsErrors,
  normalizeExpectedValues,
  foreignNodeAliases,
  isForeignNodeAlias,
  isNodeMailbox,
  mailboxPrefillFromAlias,
  mailboxWithAddress,
} from './mailNode.js';

describe('prefilterDoneKey', () => {
  it('words the notice by how the forwarding hosts went', () => {
    assert.equal(prefilterDoneKey({ status: 'changed', forwardingHosts: { status: 'changed' } }), 'admin.mailNode.prefilterDoneWithRanges');
    assert.equal(prefilterDoneKey({ status: 'ok', forwardingHosts: { status: 'ok' } }), 'admin.mailNode.prefilterDoneWithRanges');
    assert.equal(prefilterDoneKey({ forwardingHosts: { status: 'failed', code: 'fwdhost_keep_spam' } }), 'admin.mailNode.prefilterDoneRangesNot');
    assert.equal(prefilterDoneKey({ forwardingHosts: { status: 'skipped', code: 'eop_ranges_invalid' } }), 'admin.mailNode.prefilterDoneRangesNot');
    assert.equal(prefilterDoneKey({ status: 'changed', forwardingHosts: null }), 'admin.mailNode.prefilterDone');
    assert.equal(prefilterDoneKey(undefined), 'admin.mailNode.prefilterDone');
  });
});

describe('domainMailboxFormError', () => {
  it('accepts a valid name before @ with a picked domain', () => {
    assert.equal(domainMailboxFormError({ localPart: ' Info.Sales ', domain: 'example.com' }), null);
  });

  it('refuses a bad name before @ and a missing domain', () => {
    for (const localPart of ['', '.a', 'a.', 'a..b', 'a b', 'a@b', 'a+b']) {
      assert.equal(domainMailboxFormError({ localPart, domain: 'example.com' }), 'admin.accounts.add.domainErrorLocalPart');
    }
    assert.equal(domainMailboxFormError({ localPart: 'info', domain: '' }), 'admin.accounts.add.domainErrorPickDomain');
  });
});

describe('selectableDomains', () => {
  it('offers active domains whose onboarding is done, sorted', () => {
    assert.deepEqual(selectableDomains([
      { domain: 'b.example', active: true, state: 'ready' },
      { domain: 'off.example', active: false, state: 'ready' },
      { domain: 'a.example', active: true, state: 'authoritative' },
      { domain: 'pending.example', active: true, state: 'connector_ready' },
      { domain: 'manual.example', active: true, state: 'unknown' },
      { domain: 'old.example', active: true },
    ]), ['a.example', 'b.example']);
    assert.deepEqual(selectableDomains(null), []);
  });
});

describe('domain onboarding', () => {
  it('names every state, unknown for anything else', () => {
    assert.equal(domainStateKey('ready'), 'admin.mailNode.stateReady');
    assert.equal(domainStateKey('connector_ready'), 'admin.mailNode.stateConnectorReady');
    assert.equal(domainStateKey('unknown'), 'admin.mailNode.stateUnknown');
    assert.equal(domainStateKey(undefined), 'admin.mailNode.stateUnknown');
  });

  it('lists the manual steps with who confirmed them and which one is next', () => {
    const steps = onboardingSteps({
      state: 'dns_ok', nextStep: 'tenant_verified',
      steps: {
        node_configured: { at: '2026-10-01T10:00:00Z', email: 'admin@example.com' },
        dns_ok: { at: '2026-10-01T11:00:00Z', email: 'ops@example.com' },
      },
    });
    assert.deepEqual(steps.map((s) => [s.state, s.status, s.by]), [
      ['node_configured', 'confirmed', 'admin@example.com'],
      ['dns_ok', 'confirmed', 'ops@example.com'],
      ['tenant_verified', 'next', null],
      ['internal_relay', 'pending', null],
      ['connector_ready', 'pending', null],
      ['ready', 'pending', null],
    ]);
    assert.equal(steps[0].labelKey, 'admin.mailNode.stepNodeConfigured');
  });

  it('shows the steps a domain marked ready passed over as skipped', () => {
    const steps = onboardingSteps({
      state: 'ready', nextStep: null,
      steps: { node_configured: { email: 'a@example.com' }, ready: { email: 'b@example.com', markedReady: true } },
    });
    assert.deepEqual(steps.map((s) => s.status), ['confirmed', 'skipped', 'skipped', 'skipped', 'skipped', 'confirmed']);
    assert.equal(steps[5].markedReady, true);
    assert.equal(steps[5].by, 'b@example.com');
  });

  it('with the tenant driver, the next tenant step is MailExpert\'s, not a person\'s (stage 7b)', () => {
    const domain = {
      state: 'dns_ok', nextStep: 'tenant_verified',
      steps: { dns_ok: { email: 'ops@example.com' } },
    };
    assert.equal(onboardingSteps(domain, { tenantDriver: true })[2].status, 'tenant');
    assert.equal(onboardingSteps(domain)[2].status, 'next');
    const later = onboardingSteps({
      state: 'connector_ready', nextStep: 'ready',
      steps: { tenant_verified: { email: 'MailExpert', tenantDriver: true } },
    }, { tenantDriver: true });
    assert.equal(later[2].byTenantDriver, true);
    // 'ready' stays a person's step: the owner switches the MX.
    assert.equal(later[5].status, 'next');
  });

  it('says a mailbox waits for the tenant only when the server says so', () => {
    assert.equal(tenantPending({ mail_node: true, tenant_pending: true }), true);
    assert.equal(tenantPending({ mail_node: true, tenant_pending: false }), false);
    assert.equal(tenantPending({ mail_node: false, tenant_pending: true }), false);
    assert.equal(tenantPending(null), false);
  });

  it('names the stage 7b failures and the connector drift alert', () => {
    assert.equal(tenantFailureKey('outbound_connector_ambiguous'), 'admin.tenant.failOutboundAmbiguous');
    assert.equal(tenantFailureKey('exo_throttled'), 'admin.tenant.failThrottled');
    assert.equal(tenantFailureKey('mail_node_unreachable'), 'admin.mailNode.errorUnreachable');
    assert.equal(tenantFailureKey('something_new'), 'admin.tenant.failOther');
    assert.equal(alertTitleKey('tenant_connector_drift'), 'admin.nodeOps.alertTenantConnectorDrift');
    assert.equal(tenantFailureKey('address_taken'), 'admin.tenant.failAddressTaken');
    assert.equal(tenantFailureKey('authoritative_in_tenant'), 'admin.tenant.failAuthoritativeInTenant');
    assert.equal(alertTitleKey('tenant_domain_authoritative'), 'admin.nodeOps.alertTenantDomainAuthoritative');
    assert.deepEqual(alertDetail({ key: 'tenant_domain_authoritative', details: { count: 1, domains: ['example.com'] } }), {
      key: 'admin.nodeOps.alertDetailTenantDomainAuthoritative', values: { count: 1, domains: 'example.com' },
    });
    assert.deepEqual(alertDetail({ key: 'tenant_connector_drift', details: { count: 1, connectors: [{ name: 'To mail node' }], checkedAt: 'x' } }), {
      key: 'admin.nodeOps.alertDetailTenantConnectorDrift', values: { count: 1, names: 'To mail node' }, at: 'x',
    });
  });

  it('lets an administrator mark ready only a known domain before ready', () => {
    assert.equal(canMarkReady({ state: 'node_created' }), true);
    assert.equal(canMarkReady({ state: 'connector_ready' }), true);
    assert.equal(canMarkReady({ state: 'ready' }), false);
    assert.equal(canMarkReady({ state: 'authoritative' }), false);
    assert.equal(canMarkReady({ state: 'unknown' }), false);
  });
});

describe('normalizeEopSettings', () => {
  it('normalizes the fields sent the way the server does', () => {
    assert.deepEqual(normalizeEopSettings({
      eopHost: ' Contoso-com.mail.protection.outlook.com ', dkimMode: 'eop', sendLimitPerHour: '25', terrl: 48248,
      tenantId: ' AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE ', appId: '', certThumbprint: 'ab:cd ef01 2345 6789 abcd ef01 2345 6789 abcd ef01',
    }), {
      settings: {
        eopHost: 'contoso-com.mail.protection.outlook.com', dkimMode: 'eop', sendLimitPerHour: 25, terrl: 48248,
        tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', appId: null, certThumbprint: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      },
    });
  });

  it('answers the server refusal codes', () => {
    assert.deepEqual(normalizeEopSettings({ dkimMode: '' }), { error: 'dkim_mode_invalid' });
    assert.deepEqual(normalizeEopSettings({ sendLimitPerHour: null }), { error: 'send_limit_invalid' });
    assert.deepEqual(normalizeEopSettings({ certThumbprint: 'xyz' }), { error: 'thumbprint_invalid' });
    assert.deepEqual(normalizeEopSettings({}), { settings: {} });
    // Stage 7b: the Outbound connector and DBEB variant B, checked as the server does.
    assert.deepEqual(normalizeEopSettings({ outboundConnector: ' To mail node ', dbebExternalDomain: 'Relay.Example.net' }), {
      settings: { outboundConnector: 'To mail node', dbebExternalDomain: 'relay.example.net' },
    });
    assert.deepEqual(normalizeEopSettings({ outboundConnector: 'To node [EU] & co' }), { settings: { outboundConnector: 'To node [EU] & co' } });
    assert.deepEqual(normalizeEopSettings({ outboundConnector: 'a'.repeat(65) }), { error: 'outbound_connector_invalid' });
    assert.deepEqual(normalizeEopSettings({ dbebExternalDomain: 'not a domain' }), { error: 'dbeb_external_domain_invalid' });
  });

  it('keeps the node address as an IPv4 address only, and lets it be cleared', () => {
    assert.deepEqual(normalizeEopSettings({ nodeIp: ' 203.0.113.10 ' }), { settings: { nodeIp: '203.0.113.10' } });
    assert.deepEqual(normalizeEopSettings({ nodeIp: '' }), { settings: { nodeIp: null } });
    assert.deepEqual(normalizeEopSettings({ nodeIp: '2001:db8::10' }), { error: 'node_ip_invalid' });
    assert.deepEqual(normalizeEopSettings({ nodeIp: 'mail.example.com' }), { error: 'node_ip_invalid' });
  });
});

describe('eopSettingsError', () => {
  const valid = {
    eopHost: 'contoso-com.mail.protection.outlook.com', certificateHost: 'mail.example.com', dkimMode: 'mailcow',
    sendLimitPerHour: '50', terrl: '48248', tenantId: '11111111-2222-4333-8444-555555555555',
    appId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', certThumbprint: 'ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01',
  };

  it('accepts filled and empty optional fields', () => {
    assert.equal(eopSettingsError(valid), null);
    assert.equal(eopSettingsError({ dkimMode: 'eop', sendLimitPerHour: '1' }), null);
  });

  it('names the first bad field', () => {
    assert.equal(eopSettingsError({ ...valid, eopHost: '10.0.0.1' }), 'admin.eop.errorEopHost');
    assert.equal(eopSettingsError({ ...valid, certificateHost: 'mail' }), 'admin.eop.errorCertificateHost');
    assert.equal(eopSettingsError({ ...valid, dkimMode: 'both' }), 'admin.eop.errorDkimMode');
    assert.equal(eopSettingsError({ ...valid, sendLimitPerHour: '' }), 'admin.eop.errorSendLimit');
    assert.equal(eopSettingsError({ ...valid, sendLimitPerHour: '10001' }), 'admin.eop.errorSendLimit');
    assert.equal(eopSettingsError({ ...valid, terrl: '0' }), 'admin.eop.errorTerrl');
    assert.equal(eopSettingsError({ ...valid, tenantId: 'contoso' }), 'admin.eop.errorTenantId');
    assert.equal(eopSettingsError({ ...valid, appId: '123' }), 'admin.eop.errorAppId');
    assert.equal(eopSettingsError({ ...valid, certThumbprint: 'xyz' }), 'admin.eop.errorThumbprint');
  });
});

describe('mailNodeConfigError', () => {
  const ok = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: '5120', diskPingUrl: '' };

  it('accepts complete settings, and a blank key when one is stored', () => {
    assert.equal(mailNodeConfigError(ok), null);
    assert.equal(mailNodeConfigError({ ...ok, apiKey: '' }, { hasStoredKey: true }), null);
  });

  it('names the first problem', () => {
    assert.equal(mailNodeConfigError({ ...ok, mailHost: '10.0.0.1' }), 'admin.mailNode.errorHost');
    assert.equal(mailNodeConfigError({ ...ok, apiKey: '' }), 'admin.mailNode.errorApiKey');
    assert.equal(mailNodeConfigError({ ...ok, quotaMb: '0' }), 'admin.mailNode.errorQuota');
    assert.equal(mailNodeConfigError({ ...ok, quotaMb: '1.5' }), 'admin.mailNode.errorQuota');
    assert.equal(mailNodeConfigError({ ...ok, diskPingUrl: 'http://hc.example.com/x' }), 'admin.mailNode.errorPingUrl');
  });
});

describe('errors', () => {
  it('maps server codes to keys, unknown ones to the generic text', () => {
    assert.equal(mailNodeErrorKey('mail_node_auth'), 'admin.mailNode.errorAuth');
    assert.equal(mailNodeErrorKey('mailbox_exists'), 'admin.accounts.add.domainErrorExists');
    assert.equal(mailNodeErrorKey('domain_not_ready'), 'admin.accounts.add.domainErrorNotReady');
    assert.equal(mailNodeErrorKey('step_out_of_order'), 'admin.mailNode.errorStepOutOfOrder');
    assert.equal(mailNodeErrorKey('thumbprint_invalid'), 'admin.eop.errorThumbprint');
    assert.equal(mailNodeErrorKey('something_new'), 'admin.mailNode.errorFailed');
    assert.equal(mailNodeErrorKey('domain_not_recreated'), 'admin.mailNode.errorDomainNotRecreated');
    assert.equal(mailNodeErrorKey('mailbox_disabled_on_node'), 'admin.accounts.add.domainErrorDisabledOnNode');
    assert.equal(mailNodeErrorKey('mail_node_disable_unsupported'), 'admin.accounts.mailNodeDisableUnsupported');
    assert.equal(mailNodeErrorKey('domain_node_changed'), 'admin.mailNode.errorDomainNodeChanged');
    assert.equal(mailNodeErrorKey('domain_nothing_to_restart'), 'admin.mailNode.errorNothingToRestart');
    assert.equal(mailNodeErrorKey('mail_node_host_mismatch'), 'admin.mailNode.errorHostMismatch');
    assert.equal(mailNodeErrorKey('node_alias_address_mismatch'), 'admin.aliases.errorNodeAddress');
    assert.equal(mailNodeErrorKey('address_is_node_alias'), 'admin.accounts.add.domainErrorNodeAlias');
  });

  it('shows the node words of a refusal only', () => {
    assert.equal(mailNodeErrorDetail({ code: 'mail_node_refused', message: 'The mail node refused: max_mailbox_exceeded 500' }), 'max_mailbox_exceeded 500');
    assert.equal(mailNodeErrorDetail({ code: 'mail_node_auth', message: 'The mail node refused the API key' }), '');
  });
});

describe('usage', () => {
  it('gives the share of the quota, capped at 100', () => {
    assert.equal(usagePercent(1048576 * 512, 1024), 50);
    assert.equal(usagePercent(1048576 * 2048, 1024), 100);
    assert.equal(usagePercent(null, 1024), null);
    assert.equal(usagePercent(10, null), null);
  });

  it('shows megabytes below a gigabyte and gigabytes above', () => {
    assert.deepEqual(sizeParts(1048576 * 300), { value: '300', unitKey: 'admin.mailNode.unitMb' });
    assert.deepEqual(sizeParts(1024 ** 3 * 1.25), { value: '1.3', unitKey: 'admin.mailNode.unitGb' });
  });
});

describe('quotaMbInGb', () => {
  it('is null below a full gigabyte', () => {
    assert.equal(quotaMbInGb(1023), null);
    assert.equal(quotaMbInGb('700'), null);
    assert.equal(quotaMbInGb(''), null);
    assert.equal(quotaMbInGb('not a number'), null);
  });

  it('reads MB back in GB at and above a full gigabyte', () => {
    assert.equal(quotaMbInGb(1024), '1.0');
    assert.equal(quotaMbInGb('5120'), '5.0');
    assert.equal(quotaMbInGb(102400), '100.0');
  });
});

describe('deleteConfirmationMatches', () => {
  it('matches the full address, ignoring case and surrounding spaces', () => {
    assert.equal(deleteConfirmationMatches('info@example.com', 'info@example.com'), true);
    assert.equal(deleteConfirmationMatches('  Info@Example.COM ', 'info@example.com'), true);
  });

  it('refuses anything short of the full address, and an empty one', () => {
    for (const typed of ['', 'info', 'info@example', 'info@example.com.', 'info @example.com', null, undefined]) {
      assert.equal(deleteConfirmationMatches(typed, 'info@example.com'), false, String(typed));
    }
    assert.equal(deleteConfirmationMatches('', ''), false);
    assert.equal(deleteConfirmationMatches(' ', null), false);
  });
});

describe('the pending deletion of a node mailbox', () => {
  it('reads the pending state of an account, and none for one without a date', () => {
    assert.equal(pendingDeletion({ delete_after: null }), null);
    assert.equal(pendingDeletion(null), null);
    assert.deepEqual(pendingDeletion({
      delete_after: 'd', deletion_requested_at: 'r', deletion_requested_by_email: 'anna@example.com', deletion_reason: 'Left', deletion_last_error: 'x',
    }), { deleteAfter: 'd', requestedAt: 'r', requestedBy: 'anna@example.com', reason: 'Left', lastError: 'x' });
  });

  it('wants a reason of at most 500 characters', () => {
    assert.equal(deletionReasonError(''), 'admin.accounts.deletion.errorReasonRequired');
    assert.equal(deletionReasonError('   '), 'admin.accounts.deletion.errorReasonRequired');
    assert.equal(deletionReasonError(undefined), 'admin.accounts.deletion.errorReasonRequired');
    assert.equal(deletionReasonError(' x '.repeat(1) + 'y'.repeat(498)), null);
    assert.equal(deletionReasonError('y'.repeat(501)), 'admin.accounts.deletion.errorReasonTooLong');
  });

  it('dates a deletion asked for now the given days ahead, and none without days', () => {
    const now = Date.parse('2026-10-01T10:00:00.000Z');
    assert.equal(deletionDate(5, now), '2026-10-06T10:00:00.000Z');
    assert.equal(deletionDate(null, now), null);
    assert.equal(deletionDate(0, now), null);
  });

  it('builds the confirmation: date, typed address, required reason and the aliases', () => {
    const t = (k, v) => (v ? `${k}|${JSON.stringify(v)}` : k);
    const dialog = nodeMailboxDeleteDialog({
      t, account: { email_address: 'info@example.com' }, days: 5,
      aliases: [{ address: 'orders@example.com', onlyTarget: true }], formatDate: () => 'DATE',
    });
    assert.equal(dialog.requireTyped, 'info@example.com');
    assert.equal(dialog.requireReason, true);
    assert.equal(dialog.reasonLabel, 'admin.accounts.deletion.reasonLabel');
    assert.equal(dialog.message, 'admin.accounts.deleteMailNodeMessage|{"email":"info@example.com","date":"DATE"}');
    assert.ok(dialog.note.includes('orders@example.com'));
    assert.equal(dialog.confirmLabel, 'admin.accounts.deleteMailNodeConfirm');
    const noDays = nodeMailboxDeleteDialog({ t, account: { email_address: 'info@example.com' }, days: null, aliases: [] });
    assert.equal(noDays.message, 'admin.accounts.deleteMailNodeMessageNoDate|{"email":"info@example.com"}');
    assert.equal(noDays.note, undefined);
  });

  it('translates the deletion refusals and knows which codes are its own', () => {
    assert.equal(mailNodeErrorKey('mailbox_pending_deletion'), 'admin.accounts.add.domainErrorPendingDeletion');
    assert.equal(mailNodeErrorKey('deletion_reason_required'), 'admin.accounts.deletion.errorReasonRequired');
    assert.equal(isMailNodeErrorCode('deletion_in_progress'), true);
    for (const code of ['account_not_found', 'deletion_step_failed', 'node_deleted_row_kept', 'mail_node_not_configured', 'mail_node_unreachable']) {
      assert.equal(isMailNodeErrorCode(code), true, code);
    }
    assert.equal(isMailNodeErrorCode('toString'), false);
    assert.equal(isMailNodeErrorCode(undefined), false);
  });

  it('checks the days of the settings form, 1 to 90', () => {
    const form = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: '5120', diskPingUrl: '' };
    assert.equal(mailNodeConfigError({ ...form, deleteAfterDays: '5' }), null);
    assert.equal(mailNodeConfigError({ ...form, deleteAfterDays: '91' }), 'admin.mailNode.errorDeleteAfterDays');
    assert.equal(mailNodeConfigError({ ...form, deleteAfterDays: '0' }), 'admin.mailNode.errorDeleteAfterDays');
  });
});

describe('who may delete a mailbox', () => {
  it('lets everyone delete any mailbox while the owner has not made node mailboxes admin-only', () => {
    assert.equal(NODE_MAILBOX_DELETE_ADMIN_ONLY, false);
    assert.equal(canDeleteAccount({ mail_node: true }, { isAdmin: false }), true);
    assert.equal(canDeleteAccount({ mail_node: false }, { isAdmin: false }), true);
    assert.equal(canDeleteAccount(null, { isAdmin: true }), false);
  });
});

describe('nodeAliasesNote', () => {
  it('names the aliases deleted with the mailbox and those that only lose it', () => {
    assert.deepEqual(nodeAliasesNote([]), []);
    assert.deepEqual(nodeAliasesNote(undefined), []);
    assert.deepEqual(nodeAliasesNote([
      { address: 'orders@example.com', onlyTarget: true },
      { address: 'team@example.com', onlyTarget: false },
      { address: 'all@example.com', onlyTarget: false },
    ]), [
      { key: 'admin.accounts.deleteMailNodeAliasesDeleted', values: { list: 'orders@example.com' } },
      { key: 'admin.accounts.deleteMailNodeAliasesChanged', values: { list: 'team@example.com, all@example.com' } },
    ]);
    assert.deepEqual(nodeAliasesNote([{ address: 'orders@example.com', onlyTarget: true }]), [
      { key: 'admin.accounts.deleteMailNodeAliasesDeleted', values: { list: 'orders@example.com' } },
    ]);
  });
});

describe('canRestartOnboarding', () => {
  it('offers a restart only when there is something to clear', () => {
    assert.equal(canRestartOnboarding({ state: 'ready', steps: {} }), true);
    assert.equal(canRestartOnboarding({ state: 'node_created', steps: {} }), false);
    assert.equal(canRestartOnboarding({ state: 'node_created', steps: { node_configured: {} } }), true);
    assert.equal(canRestartOnboarding({ state: 'node_created', steps: {}, recreated: true }), true);
    assert.equal(canRestartOnboarding({ state: 'unknown', steps: {} }), false);
  });
});

describe('domainMailboxTaken', () => {
  const accounts = [{ email_address: 'Sales@Example.com' }, { email_address: 'ops@example.org' }];

  it('finds an address that is already a mailbox, whatever the case and spaces', () => {
    assert.equal(domainMailboxTaken({ localPart: ' sales ', domain: 'example.com' }, accounts), true);
    assert.equal(domainMailboxTaken({ localPart: 'SALES', domain: 'EXAMPLE.COM' }, accounts), true);
  });

  it('lets the same name through on another domain, and says nothing for an empty form', () => {
    assert.equal(domainMailboxTaken({ localPart: 'sales', domain: 'example.org' }, accounts), false);
    assert.equal(domainMailboxTaken({ localPart: '', domain: 'example.com' }, accounts), false);
    assert.equal(domainMailboxTaken({ localPart: 'sales', domain: '' }, accounts), false);
    assert.equal(domainMailboxTaken({ localPart: 'sales', domain: 'example.com' }), false);
  });
});

describe('sender names', () => {
  it('requires the sender name of Our mailbox', () => {
    assert.equal(senderNameError('  '), 'admin.accounts.add.senderNameRequired');
    assert.equal(senderNameError(undefined), 'admin.accounts.add.senderNameRequired');
    assert.equal(senderNameError('Иван Петров'), null);
  });

  it('sends trimmed names, leaves empty ones out and drops a second name equal to the first', () => {
    assert.deepEqual(senderNamesPayload({ senderName: ' Иван Петров ', senderNameAlt: ' Ivan Petrov ' }),
      { senderName: 'Иван Петров', senderNameAlt: 'Ivan Petrov' });
    assert.deepEqual(senderNamesPayload({ senderName: 'Sales', senderNameAlt: 'sales' }), { senderName: 'Sales' });
    assert.deepEqual(senderNamesPayload({ senderName: '', senderNameAlt: '' }), {});
    assert.deepEqual(senderNamesPayload({ senderNameAlt: 'Ivan' }), { senderNameAlt: 'Ivan' });
  });
});

describe('the TLS policy for the next hop', () => {
  it('checks the policy and its parameters as the server does', () => {
    assert.deepEqual(normalizeEopSettings({ tlsPolicy: 'dane', tlsPolicyParameters: '' }), { settings: { tlsPolicy: 'dane', tlsPolicyParameters: null } });
    assert.deepEqual(normalizeEopSettings({ tlsPolicy: 'none' }), { error: 'tls_policy_invalid' });
    assert.deepEqual(normalizeEopSettings({ tlsPolicyParameters: 'match' }), { error: 'tls_parameters_invalid' });
    assert.equal(parseTlsParameters('  match=nexthop:dot-nexthop   ciphers=high '), 'match=nexthop:dot-nexthop ciphers=high');
    assert.equal(parseTlsParameters('=x'), null);
  });

  it('wants the fingerprint with the fingerprint policy, also in the form', () => {
    assert.equal(eopSettingsConflict({ tlsPolicy: 'fingerprint', tlsPolicyParameters: null }), 'tls_parameters_invalid');
    assert.equal(eopSettingsConflict({ tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=AB' }), 'tls_parameters_invalid');
    assert.equal(eopSettingsConflict({ tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A' }), null);
    assert.equal(eopSettingsError({ tlsPolicy: 'fingerprint', tlsPolicyParameters: '', dkimMode: 'mailcow', sendLimitPerHour: '50' }), 'admin.eop.errorTlsParameters');
    assert.equal(eopSettingsError({ tlsPolicy: 'secure', tlsPolicyParameters: '', dkimMode: 'mailcow', sendLimitPerHour: '50' }), null);
  });
});

describe('TLS parameters per policy, as the server checks them', () => {
  it('takes names for secure and verify, fingerprints for fingerprint, and no match= otherwise', () => {
    assert.equal(tlsParametersFit('secure', 'match=nexthop:dot-nexthop'), true);
    assert.equal(tlsParametersFit('verify', 'match=.mail.protection.outlook.com'), true);
    assert.equal(tlsParametersFit('secure', 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A'), false);
    assert.equal(tlsParametersFit('fingerprint', 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A|E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A'), true);
    assert.equal(tlsParametersFit('fingerprint', 'match=nexthop'), false);
    assert.equal(tlsParametersFit('fingerprint', ''), false);
    for (const policy of ['encrypt', 'dane', 'dane-only', 'default']) {
      assert.equal(tlsParametersFit(policy, ''), true, policy);
      assert.equal(tlsParametersFit(policy, 'match=nexthop'), false, policy);
    }
    assert.deepEqual(normalizeEopSettings({ tlsPolicyParameters: `match=${'a'.repeat(250)}` }), { error: 'tls_parameters_invalid' });
  });
});

describe('the panel addresses for fail2ban', () => {
  it('takes IP addresses and networks, never the whole internet', () => {
    assert.equal(parseNetwork(' 203.0.113.10 '), '203.0.113.10');
    assert.equal(parseNetwork('2001:DB8::/64'), '2001:db8::/64');
    assert.equal(parseNetwork('203.0.113.0/24'), '203.0.113.0/24');
    assert.equal(parseNetwork('2001:db8::/48'), '2001:db8::/48');
    for (const bad of ['0.0.0.0/0', '10.0.0.0/8', '203.0.0.0/23', '2001:db8::/47', '::/0', '203.0.113.256', '203.0.113.10/33', 'mail.example.com', 'a:b:c']) {
      assert.equal(parseNetwork(bad), null, bad);
    }
    assert.deepEqual(parseNetworkList('203.0.113.10, 198.51.100.0/24\n203.0.113.10'), { networks: ['203.0.113.10', '198.51.100.0/24'] });
    assert.deepEqual(parseNetworkList(''), { networks: [] });
    assert.deepEqual(parseNetworkList('203.0.113.10 nope'), { error: 'panel_ips_invalid' });
  });

  it('refuses the node settings with a bad address', () => {
    const form = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: '5120', diskPingUrl: '' };
    assert.equal(mailNodeConfigError({ ...form, panelIps: '203.0.113.10' }), null);
    assert.equal(mailNodeConfigError({ ...form, panelIps: 'everyone' }), 'admin.mailNode.errorPanelIps');
    assert.equal(mailNodeErrorKey('panel_ips_invalid'), 'admin.mailNode.errorPanelIps');
  });
});

describe('the result of applying the settings to the node', () => {
  it('names each item, outcome and code', () => {
    assert.equal(applyItemKey('tls_policy'), 'admin.mailNode.applyItemTlsPolicy');
    assert.equal(applyItemKey('mailbox_limits'), 'admin.mailNode.applyItemMailboxLimits');
    assert.equal(applyItemKey('future_item'), 'future_item');
    assert.equal(applyStatusKey('pending'), 'admin.mailNode.applyStatusPending');
    assert.equal(applyStatusKey('weird'), 'admin.mailNode.applyStatusFailed');
    assert.equal(mailNodeErrorKey('dkim_delete_unconfirmed'), 'admin.mailNode.applyCodeDkimDeleteUnconfirmed');
    assert.equal(mailNodeErrorKey('dovecot_restart_failed'), 'admin.mailNode.applyCodeDovecotRestartFailed');
  });

  it('tells when the spam rule or a DKIM deletion waits for the administrator', () => {
    assert.equal(prefilterPending({ items: [{ item: 'prefilter', status: 'pending' }] }), true);
    assert.equal(prefilterPending({ items: [{ item: 'prefilter', status: 'ok' }] }), false);
    assert.equal(prefilterPending(null), false);
    assert.equal(dkimDeleteWaiting({ apply: { items: [{ item: 'dkim', status: 'skipped', code: 'dkim_delete_unconfirmed' }] } }), true);
    assert.equal(dkimDeleteWaiting({ apply: { items: [{ item: 'dkim', status: 'ok' }] } }), false);
    assert.equal(dkimDeleteWaiting({ apply: null }), false);
  });
});

describe('send limits', () => {
  it('checks an administrator\'s limit', () => {
    assert.equal(rateLimitError({ value: '50', frame: 'h' }), null);
    assert.equal(rateLimitError({ value: '0', frame: 'h' }), 'admin.mailNode.errorRateLimit');
    assert.equal(rateLimitError({ value: '10001', frame: 'h' }), 'admin.mailNode.errorRateLimit');
    assert.equal(rateLimitError({ value: '5', frame: 'w' }), 'admin.mailNode.errorRateLimit');
    assert.equal(rateFrameKey('d'), 'admin.mailNode.rateFrameD');
  });

  it('tells an own limit, the default, and a node that holds another one', () => {
    const def = { value: 50, frame: 'h' };
    assert.equal(rateLimitState({ rateLimit: def, rateLimitOverride: null, rateLimitDefault: def }), 'default');
    assert.equal(rateLimitState({ rateLimit: { value: 9, frame: 'm' }, rateLimitOverride: { value: 9, frame: 'm' }, rateLimitDefault: def }), 'own');
    assert.equal(rateLimitState({ rateLimit: null, rateLimitOverride: null, rateLimitDefault: def }), 'differs');
    assert.equal(rateLimitState({ rateLimit: def, rateLimitOverride: { value: 9, frame: 'm' }, rateLimitDefault: def }), 'differs');
  });
});

describe('the DNS checks', () => {
  const dns = (overall) => ({ at: '2026-10-01T10:00:00.000Z', overall, checks: [] });

  it('warns about a domain only once it takes mailboxes, and never from its state alone', () => {
    assert.equal(hasDnsErrors({ state: 'ready', dns: dns('error') }), true);
    assert.equal(hasDnsErrors({ state: 'authoritative', dns: dns('error') }), true);
    assert.equal(hasDnsErrors({ state: 'ready', dns: dns('warning') }), false);
    assert.equal(hasDnsErrors({ state: 'dns_ok', dns: dns('error') }), false);
    assert.equal(hasDnsErrors({ state: 'ready', dns: null }), false);
  });

  it('sums up the ready domains with errors and the node', () => {
    const domains = [
      { domain: 'a.example', state: 'ready', dns: dns('error') },
      { domain: 'b.example', state: 'node_created', dns: dns('error') },
      { domain: 'c.example', state: 'ready', dns: dns('ok') },
    ];
    assert.deepEqual(dnsSummary(domains, dns('error')), { domains: ['a.example'], node: true });
    assert.deepEqual(dnsSummary(null, null), { domains: [], node: false });
  });

  it('names the latest result next to the step that confirms the DNS', () => {
    assert.equal(dnsVerdictKey({ dns: dns('ok') }), 'admin.mailNode.dnsVerdictOk');
    assert.equal(dnsVerdictKey({ dns: dns('error') }), 'admin.mailNode.dnsVerdictError');
    assert.equal(dnsVerdictKey({ dns: null }), 'admin.mailNode.dnsVerdictNone');
  });

  it('translates checks, statuses and codes, with a fallback for what it does not know', () => {
    assert.equal(dnsCheckKey('mx'), 'admin.mailNode.dnsCheckMx');
    assert.equal(dnsCheckKey('future_check'), 'future_check');
    assert.equal(dnsStatusKey('warning'), 'admin.mailNode.dnsStatusWarning');
    assert.equal(dnsStatusKey('strange'), 'admin.mailNode.dnsStatusError');
    assert.equal(dnsCodeKey('cert_chain_incomplete'), 'admin.mailNode.dnsCodeCertChainIncomplete');
    assert.equal(dnsCodeKey('future_code'), 'admin.mailNode.dnsCodeUnknown');
    assert.deepEqual(dnsCodeValues({ found: ['a', 'b'], expected: [], detail: 'ETIMEOUT', daysLeft: 9, name: 'x.example' }), {
      found: 'a, b', expected: '—', detail: 'ETIMEOUT', days: 9, missing: '—', name: 'x.example',
    });
  });

  it('edits the values to publish as strings and checks them the way the server does', () => {
    assert.deepEqual(expectedForm({ mx: ['a.example', 'b.example'], tenantTxt: 'MS=ms1', dkimSelector1Cname: null, dkimSelector2Cname: null }), {
      expectedMx: 'a.example, b.example', tenantTxt: 'MS=ms1', dkimSelector1Cname: '', dkimSelector2Cname: '',
    });
    assert.deepEqual(expectedForm(null), { expectedMx: '', tenantTxt: '', dkimSelector1Cname: '', dkimSelector2Cname: '' });
    assert.deepEqual(normalizeExpectedValues({ expectedMx: 'A.Example.com., b.mx.microsoft b.mx.microsoft', tenantTxt: ' ', dkimSelector1Cname: 'S1.Example.com.' }), {
      values: { mx: ['a.example.com', 'b.mx.microsoft'], tenantTxt: null, dkimSelector1Cname: 's1.example.com' },
    });
    assert.deepEqual(normalizeExpectedValues({ expectedMx: 'not a host' }), { error: 'expected_mx_invalid' });
    assert.deepEqual(normalizeExpectedValues({ expectedMx: Array.from({ length: 11 }, (_, i) => `mx${i}.example.com`) }), { error: 'expected_mx_invalid' });
    assert.deepEqual(normalizeExpectedValues({ tenantTxt: 'MS="x"' }), { error: 'tenant_txt_invalid' });
    assert.deepEqual(normalizeExpectedValues({ dkimSelector2Cname: '10.0.0.1' }), { error: 'dkim_cname_invalid' });
    assert.equal(expectedValuesError({ expectedMx: 'not a host' }), 'admin.mailNode.errorExpectedMx');
    assert.equal(expectedValuesError(expectedForm(null)), null);
  });

  it('takes the selector CNAME targets EOP really gives, with "_" in their labels', () => {
    assert.deepEqual(normalizeExpectedValues({ dkimSelector1Cname: 'Selector1-contoso-com._domainkey.contoso.n-v1.dkim.mail.microsoft.' }), {
      values: { dkimSelector1Cname: 'selector1-contoso-com._domainkey.contoso.n-v1.dkim.mail.microsoft' },
    });
    assert.deepEqual(normalizeExpectedValues({ dkimSelector2Cname: 'selector2._domainkey.contoso.dkim_mail' }), { error: 'dkim_cname_invalid' });
    assert.deepEqual(normalizeExpectedValues({ expectedMx: 'mx_1.example.com' }), { error: 'expected_mx_invalid' });
  });

  it('says when the last check could not ask DNS, and checks the node address with the node settings', () => {
    assert.equal(dnsVerdictKey({ dns: { overall: 'ok', lookupFailed: { code: 'dns_lookup_failed' } } }), 'admin.mailNode.dnsVerdictLookupFailed');
    assert.equal(hasDnsErrors({ state: 'ready', dns: { overall: null, checks: [], lookupFailed: { code: 'dns_lookup_failed' } } }), false);
    const form = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: '5120', diskPingUrl: '' };
    assert.equal(mailNodeConfigError({ ...form, nodeIp: '' }), null);
    assert.equal(mailNodeConfigError({ ...form, nodeIp: '203.0.113.10' }), null);
    assert.equal(mailNodeConfigError({ ...form, nodeIp: '2001:db8::10' }), 'admin.eop.errorNodeIp');
  });
});

describe('aliases of node mailboxes keep the mailbox address (D-16)', () => {
  const node = {
    id: 'n1', email_address: 'Sales@example.com', mail_node: true,
    aliases: [
      { id: 'a1', name: 'Sales Department', email: 'sales@EXAMPLE.com ' },
      { id: 'a2', name: 'Orders desk', email: 'orders@example.com' },
    ],
  };
  const gmail = { id: 'g1', email_address: 'me@gmail.example', aliases: [{ id: 'a3', name: 'Work', email: 'work@example.org' }] };
  const legacy = { id: 'n2', email_address: 'hr@example.org', mail_node: true, aliases: [{ id: 'a4', name: 'Jobs', email: 'jobs@example.org' }] };

  it('tells a node mailbox by mail_node only', () => {
    assert.equal(isNodeMailbox(node), true);
    assert.equal(isNodeMailbox(gmail), false);
    assert.equal(isNodeMailbox({ mail_node: null }), false);
    assert.equal(isNodeMailbox(null), false);
  });

  it('marks only another address on a node mailbox', () => {
    assert.equal(isForeignNodeAlias(node, node.aliases[0]), false);
    assert.equal(isForeignNodeAlias(node, node.aliases[1]), true);
    assert.equal(isForeignNodeAlias(gmail, gmail.aliases[0]), false);
  });

  it('lists the foreign-address aliases of node mailboxes by address', () => {
    const rows = foreignNodeAliases([legacy, gmail, node]);
    assert.deepEqual(rows.map((r) => [r.account.id, r.alias.id]), [['n2', 'a4'], ['n1', 'a2']]);
    assert.deepEqual(foreignNodeAliases(undefined), []);
    assert.deepEqual(foreignNodeAliases([{ mail_node: true, email_address: 'x@example.com' }]), []);
  });

  it('prefills the create-mailbox form from an alias', () => {
    assert.deepEqual(mailboxPrefillFromAlias({ name: ' Orders desk ', email: ' Orders@Example.com' }), {
      localPart: 'orders', domain: 'example.com', senderName: 'Orders desk',
    });
    assert.deepEqual(mailboxPrefillFromAlias({ name: '', email: 'broken' }), { localPart: 'broken', domain: '', senderName: '' });
  });
});

describe('mailboxWithAddress', () => {
  it('finds a mailbox of the panel by address, any case and spacing', () => {
    const accounts = [{ id: 'a', email_address: 'Orders@Example.com' }, { id: 'b', email_address: 'sales@example.com' }];
    assert.equal(mailboxWithAddress(accounts, ' orders@example.COM')?.id, 'a');
    assert.equal(mailboxWithAddress(accounts, 'none@example.com'), null);
    assert.equal(mailboxWithAddress(undefined, 'x@example.com'), null);
  });
});
