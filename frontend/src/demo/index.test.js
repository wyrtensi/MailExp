import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

let demoRequest;

beforeEach(async () => {
  ({ demoRequest } = await import(`./index.js?test=${crypto.randomUUID()}`));
});

test('marking an unread demo message as read lowers the unread total by one', async () => {
  const before = await demoRequest('GET', '/mail/unread-counts');

  await demoRequest('POST', '/mail/messages/bulk-read', {
    ids: ['demo-001'],
    read: true,
  });

  const after = await demoRequest('GET', '/mail/unread-counts');
  assert.equal(after.total, before.total - 1);
});

test('sent letters carry delivery marks and details like the server answers them (R-17)', async () => {
  const sent = [];
  for (let page = 0; page < 40; page += 1) {
    const { messages } = await demoRequest('GET', `/mail/messages?folder=Sent&limit=50&offset=${page * 50}`);
    if (!messages.length) break;
    sent.push(...messages);
  }
  const marked = sent.filter((m) => m.delivery_state);
  assert.deepEqual([...new Set(marked.map((m) => m.delivery_state))].sort(), ['delayed', 'failed']);
  const failed = await demoRequest('GET', `/mail/messages/${marked.find((m) => m.delivery_state === 'failed').id}/delivery`);
  assert.ok(failed.recipients.length > 0);
  assert.ok(failed.recipients.every((r) => ['bounced', 'failed'].includes(r.state) && r.explanation?.key));
  assert.deepEqual(await demoRequest('GET', '/mail/messages/demo-005/delivery'), {
    messageId: (await demoRequest('GET', '/mail/messages/demo-005')).message_id, owned: true, node: false, log: null, recipients: [],
  });
  // A received letter has none.
  assert.equal((await demoRequest('GET', '/mail/messages/demo-001/delivery')).owned, false);
});

test('advertised demo attachments expose pane fields and resolve to local content', async () => {
  const body = await demoRequest('GET', '/mail/messages/demo-001/body');

  assert.deepEqual(body.attachments, [{
    part: '1',
    filename: 'renewal-order-form.txt',
    type: 'text/plain',
    size: 45,
  }]);
  assert.deepEqual(
    await demoRequest('GET', '/mail/messages/demo-001/attachments/1'),
    {
      filename: 'renewal-order-form.txt',
      type: 'text/plain',
      content: 'Demo attachment: renewal order form preview.\n',
    },
  );
});

test('the demo shows the safe view: a letter in Spam and one EOP marked as phishing in the Inbox', async () => {
  // R-41: the Spam letter and the phishing letter carry a link whose words hide its target.
  const spam = await demoRequest('GET', '/mail/messages/demo-008');
  assert.equal(spam.folder, 'Spam');
  const spamBody = await demoRequest('GET', '/mail/messages/demo-008/body');
  assert.match(spamBody.html, /href="https:\/\/prize\.suspicious\.example\//);
  assert.equal(spamBody.eopCategory, null);
  assert.equal(spamBody.attachments.length, 1);

  const phish = await demoRequest('GET', '/mail/messages/demo-010');
  assert.equal(phish.folder, 'INBOX');
  const phishBody = await demoRequest('GET', '/mail/messages/demo-010/body');
  assert.equal(phishBody.eopCategory, 'PHSH');
  assert.match(phishBody.html, /href="https:\/\/login\.helpdesk-mailexpert\.example\//);

  // An ordinary letter has no category.
  assert.equal((await demoRequest('GET', '/mail/messages/demo-002/body')).eopCategory, null);
});

test('bulk delete removes Trash and Drafts messages but moves ordinary mail to Trash', async () => {
  const draft = await demoRequest('POST', '/mail/draft', {
    accountId: 'demo-sales',
    subject: 'Temporary draft',
    body: 'Draft body',
  });

  const result = await demoRequest('POST', '/mail/messages/bulk-delete', {
    ids: ['demo-001', 'demo-009', `demo-draft-${draft.uid}`],
  });

  assert.deepEqual(result, { ok: true, deleted: ['demo-001', 'demo-009', `demo-draft-${draft.uid}`] });
  // Like the server, the Trash copy is a new row: the old id is gone, the letter (Message-ID) is in Trash.
  assert.deepEqual(await demoRequest('GET', '/mail/messages/demo-001'), {});
  const trash = await demoRequest('GET', '/mail/messages?accountId=demo-sales&folder=Trash');
  const moved = trash.messages.find(m => m.message_id === '<demo-001@demo.mailexpert.local>');
  assert.ok(moved);
  assert.notEqual(moved.id, 'demo-001');
  assert.deepEqual(await demoRequest('GET', '/mail/messages/demo-009'), {});
  assert.deepEqual(await demoRequest('GET', `/mail/messages/demo-draft-${draft.uid}`), {});
});

test('demo contacts can enter the edit form and round-trip through create and update', async () => {
  const fixture = await demoRequest('GET', '/contacts/demo-contact-1');

  assert.deepEqual(fixture.emails, [{
    value: 'maya.chen@northstar.example',
    type: 'work',
    primary: true,
  }]);
  assert.deepEqual(fixture.phones, [{
    value: '+1 555 0142',
    type: 'work',
    primary: true,
  }]);

  const editPayload = {
    displayName: fixture.display_name,
    firstName: fixture.first_name,
    lastName: fixture.last_name,
    emails: fixture.emails.filter((email) => email.value.trim()),
    phones: fixture.phones.filter((phone) => phone.value.trim()),
    organization: fixture.organization,
    notes: 'Updated in demo mode',
  };
  const updated = await demoRequest('PATCH', `/contacts/${fixture.id}`, editPayload);

  assert.equal(updated.display_name, 'Maya Chen');
  assert.equal(updated.primary_email, 'maya.chen@northstar.example');
  assert.deepEqual(updated.emails, editPayload.emails);
  assert.deepEqual(updated.phones, editPayload.phones);
  assert.equal(updated.notes, 'Updated in demo mode');

  const created = await demoRequest('POST', '/contacts', {
    ...editPayload,
    displayName: 'Jordan Lee',
    firstName: 'Jordan',
    lastName: 'Lee',
    emails: [{ value: 'JORDAN.LEE@EXAMPLE.COM', type: 'work' }],
    phones: [{ value: '+1 555 0199', type: 'mobile' }],
  });

  assert.equal(created.display_name, 'Jordan Lee');
  assert.equal(created.first_name, 'Jordan');
  assert.equal(created.last_name, 'Lee');
  assert.equal(created.primary_email, 'jordan.lee@example.com');
  assert.deepEqual(created.emails, [{
    value: 'JORDAN.LEE@EXAMPLE.COM',
    type: 'work',
    primary: true,
  }]);
  assert.deepEqual(created.phones, [{
    value: '+1 555 0199',
    type: 'mobile',
    primary: true,
  }]);
});

test('the demo audit log lists entries newest first and applies the mailbox, user and action filters', async () => {
  const all = await demoRequest('GET', '/admin/audit');
  assert.equal(all.nextCursor, null);
  assert.ok(all.entries.length >= 4);
  const times = all.entries.map((entry) => entry.occurredAt);
  assert.deepEqual(times, [...times].sort().reverse());

  const sales = await demoRequest('GET', '/admin/audit?account=demo-sales');
  assert.ok(sales.entries.length > 0);
  assert.ok(sales.entries.every((entry) => entry.accountId === 'demo-sales'));

  const sent = await demoRequest('GET', '/admin/audit?action=message.sent');
  assert.ok(sent.entries.length > 0);
  assert.ok(sent.entries.every((entry) => entry.action === 'message.sent'));

  const nobody = await demoRequest('GET', '/admin/audit?user=someone-else');
  assert.deepEqual(nobody.entries, []);
});

test('the demo Access sync keeps the token hidden and reports a manual run', async () => {
  const initial = await demoRequest('GET', '/admin/access-sync');
  assert.equal(initial.googleMode, true);
  assert.equal(initial.config.apiTokenSet, true);
  assert.equal('apiToken' in initial.config, false);
  assert.equal(initial.lastRun.outcome, 'updated');

  const off = await demoRequest('PUT', '/admin/access-sync', { ...initial.config, enabled: false, apiToken: 'demo-token' });
  assert.equal(off.config.enabled, false);
  assert.equal(JSON.stringify(off).includes('demo-token'), false);
  assert.equal((await demoRequest('POST', '/admin/access-sync/run')).result.outcome, 'not_configured');

  await demoRequest('PUT', '/admin/access-sync', { ...initial.config, enabled: true });
  const ran = await demoRequest('POST', '/admin/access-sync/run');
  assert.equal(ran.result.outcome, 'unchanged');
  assert.equal(ran.lastRun.trigger, 'manual');
  assert.deepEqual(ran.config, { ...initial.config, enabled: true });
});

test('the demo audit log shows a stopped Access sync', async () => {
  const { entries } = await demoRequest('GET', '/admin/audit?action=access.sync_aborted');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actorEmail, 'Cloudflare Access');
  assert.ok(entries[0].details.candidates.length > 0);
});

test('the demo mail node creates a domain mailbox and lists it with its quota', async () => {
  assert.deepEqual((await demoRequest('GET', '/integrations/status')).domainMail, { configured: true });
  const account = await demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'Info', domain: 'demo.mailexpert.local', name: '' });
  assert.equal(account.email_address, 'info@demo.mailexpert.local');
  assert.equal(account.mail_node, true);
  assert.ok((await demoRequest('GET', '/accounts')).some(a => a.id === account.id));
  const { mailboxes, disk } = await demoRequest('GET', '/mail-node/mailboxes');
  assert.equal(mailboxes.find(m => m.accountId === account.id).quotaMb, 5120);
  assert.equal(typeof disk.usedPercent, 'number');
  const { domains } = await demoRequest('GET', '/mail-node/domains');
  assert.equal(domains.find(d => d.domain === 'demo.mailexpert.local').mailboxes, 1);
  await demoRequest('PUT', `/mail-node/mailboxes/${account.id}/quota`, { quotaMb: 10240 });
  assert.equal((await demoRequest('GET', '/mail-node/mailboxes')).mailboxes.find(m => m.accountId === account.id).quotaMb, 10240);
});

test('the demo mail node domains show every onboarding state, and only ready ones take mailboxes', async () => {
  const { domains } = await demoRequest('GET', '/mail-node/domains');
  const byName = new Map(domains.map(d => [d.domain, d]));
  assert.equal(byName.get('demo.mailexpert.local').state, 'ready');
  assert.equal(byName.get('demo.mailexpert.local').origin, 'existing_mailboxes');
  assert.equal(byName.get('pilot.demo.mailexpert.local').state, 'dns_ok');
  assert.equal(byName.get('pilot.demo.mailexpert.local').nextStep, 'tenant_verified');
  assert.equal(byName.get('pilot.demo.mailexpert.local').steps.dns_ok.email, 'demo@mailexpert.local');
  assert.equal(byName.get('legacy.demo.mailexpert.local').state, 'unknown');
  for (const domain of ['pilot.demo.mailexpert.local', 'legacy.demo.mailexpert.local']) {
    await assert.rejects(
      () => demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'info', domain, name: '' }),
      err => err.code === 'domain_not_ready',
    );
  }
});

test('the demo walks a domain through its onboarding with the server refusals', async () => {
  await assert.rejects(() => demoRequest('POST', '/mail-node/domains/pilot.demo.mailexpert.local/steps/ready'), err => err.code === 'step_out_of_order');
  await assert.rejects(() => demoRequest('POST', '/mail-node/domains/pilot.demo.mailexpert.local/adopt'), err => err.code === 'domain_known');
  await assert.rejects(() => demoRequest('POST', '/mail-node/domains/legacy.demo.mailexpert.local/ready'), err => err.code === 'domain_not_found');
  const confirmed = await demoRequest('POST', '/mail-node/domains/pilot.demo.mailexpert.local/steps/tenant_verified');
  assert.equal(confirmed.state, 'tenant_verified');
  const ready = await demoRequest('POST', '/mail-node/domains/pilot.demo.mailexpert.local/ready');
  assert.equal(ready.state, 'ready');
  await assert.rejects(() => demoRequest('POST', '/mail-node/domains/pilot.demo.mailexpert.local/ready'), err => err.code === 'domain_already_ready');
  const adopted = await demoRequest('POST', '/mail-node/domains/legacy.demo.mailexpert.local/adopt');
  assert.equal(adopted.state, 'node_created');
  const pilot = (await demoRequest('GET', '/mail-node/domains')).domains.find(d => d.domain === 'pilot.demo.mailexpert.local');
  assert.equal(pilot.steps.ready.markedReady, true);
  const account = await demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'pilot', domain: 'pilot.demo.mailexpert.local', name: '' });
  assert.equal(account.email_address, 'pilot@pilot.demo.mailexpert.local');
});

test('the demo keeps a domain whose node creation time differs ready, and lets an admin accept it or restart', async () => {
  const branch = () => demoRequest('GET', '/mail-node/domains').then(({ domains }) => domains.find(d => d.domain === 'branch.demo.mailexpert.local'));
  const before = await branch();
  assert.equal(before.state, 'ready');
  assert.equal(before.recreated, true);
  // Mailboxes are still created on it.
  const account = await demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'desk', domain: 'branch.demo.mailexpert.local', name: '' });
  assert.equal(account.email_address, 'desk@branch.demo.mailexpert.local');
  const acknowledge = (body) => demoRequest('POST', '/mail-node/domains/branch.demo.mailexpert.local/acknowledge', body);
  await assert.rejects(() => acknowledge({}), err => err.code === 'node_created_required');
  await assert.rejects(() => acknowledge({ created: '2026-01-01 00:00:00' }), err => err.code === 'domain_node_changed');
  await acknowledge({ created: before.created });
  const accepted = await branch();
  assert.equal(accepted.state, 'ready');
  assert.equal(accepted.recreated, undefined);
  await assert.rejects(() => acknowledge({ created: before.created }), err => err.code === 'domain_not_recreated');
  const restarted = await demoRequest('POST', '/mail-node/domains/branch.demo.mailexpert.local/restart');
  assert.equal(restarted.state, 'node_created');
  const after = await branch();
  assert.deepEqual(after.steps, {});
  assert.equal(after.nextStep, 'node_configured');
  // Nothing left to clear: refused, as on the server.
  await assert.rejects(() => demoRequest('POST', '/mail-node/domains/branch.demo.mailexpert.local/restart'), err => err.code === 'domain_nothing_to_restart');
  // The mailbox made on it stays.
  assert.ok((await demoRequest('GET', '/accounts')).some(a => a.id === account.id));
  await assert.rejects(() => demoRequest('POST', '/mail-node/domains/legacy.demo.mailexpert.local/restart'), err => err.code === 'domain_not_found');
});

test('the demo schedules the deletion of a mail node mailbox with a reason, keeps it working, and lets anyone cancel', async () => {
  const account = await demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'gone', domain: 'demo.mailexpert.local', name: '' });
  const url = `/accounts/${encodeURIComponent(account.id)}/deletion`;
  // Never removed at once.
  await assert.rejects(() => demoRequest('DELETE', `/accounts/${encodeURIComponent(account.id)}`), err => err.code === 'mail_node_deletion_request_required');
  await assert.rejects(() => demoRequest('POST', url, { email: 'gone@demo', reason: 'r' }), err => err.code === 'confirmation_mismatch');
  await assert.rejects(() => demoRequest('POST', url, { email: 'gone@demo.mailexpert.local', reason: '  ' }), err => err.code === 'deletion_reason_required');
  await assert.rejects(
    () => demoRequest('POST', url, { email: 'gone@demo.mailexpert.local', reason: 'x'.repeat(501) }),
    err => err.code === 'deletion_reason_too_long',
  );
  const pending = await demoRequest('POST', url, { email: 'GONE@demo.mailexpert.local', reason: ' Moved to the archive ' });
  assert.equal(pending.deletion_reason, 'Moved to the archive');
  const days = (Date.parse(pending.delete_after) - Date.now()) / 86400000;
  assert.ok(days > 4.9 && days < 5.1, `deleted in about 5 days, not ${days}`);
  // Still in the list, still working.
  assert.ok((await demoRequest('GET', '/accounts')).some(a => a.id === account.id && a.delete_after));
  await assert.rejects(() => demoRequest('POST', url, { email: 'gone@demo.mailexpert.local', reason: 'again' }), err => err.code === 'deletion_already_requested');
  // The same address cannot be created while it is pending.
  await assert.rejects(
    () => demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'gone', domain: 'demo.mailexpert.local', name: '' }),
    err => err.code === 'mailbox_pending_deletion',
  );
  const kept = await demoRequest('DELETE', url);
  assert.equal(kept.delete_after, null);
  assert.equal(kept.deletion_reason, null);
  await assert.rejects(() => demoRequest('DELETE', url), err => err.code === 'deletion_not_requested');
});

test('the demo shows one mail node mailbox pending deletion and keeps the days setting like the server', async () => {
  const pending = (await demoRequest('GET', '/accounts')).filter(a => a.delete_after);
  assert.deepEqual(pending.map(a => a.id), ['demo-fx-46']);
  assert.ok(pending[0].deletion_reason);
  // Dated from now: always still ahead in the demo.
  const ahead = (Date.parse(pending[0].delete_after) - Date.now()) / 86400000;
  assert.ok(ahead > 2.9 && ahead < 3.1, `about 3 days ahead, not ${ahead}`);
  assert.equal((await demoRequest('GET', '/mail-node/config')).deleteAfterDays, 5);
  await assert.rejects(() => demoRequest('PUT', '/mail-node/config', { deleteAfterDays: 91 }), err => err.code === 'delete_after_days_invalid');
  await demoRequest('PUT', '/mail-node/config', { deleteAfterDays: '14' });
  assert.equal((await demoRequest('GET', '/mail-node/config')).deleteAfterDays, 14);
  // A date already set does not move.
  assert.equal((await demoRequest('GET', '/accounts')).find(a => a.id === 'demo-fx-46').delete_after, pending[0].delete_after);
});

test('the demo lists the node aliases of a mail node mailbox for its delete confirmation', async () => {
  const sales = (await demoRequest('GET', '/accounts')).find(a => a.mail_node && a.email_address.startsWith('sales@'));
  const { aliases } = await demoRequest('GET', `/accounts/${encodeURIComponent(sales.id)}/node-aliases`);
  assert.deepEqual(aliases, [{ address: `orders@${sales.email_address.split('@')[1]}`, onlyTarget: true }]);
  assert.equal((await demoRequest('GET', `/accounts/${encodeURIComponent(sales.id)}/node-aliases`)).deleteAfterDays, 5);
  const other = (await demoRequest('GET', '/accounts')).find(a => !a.mail_node);
  await assert.rejects(() => demoRequest('GET', `/accounts/${encodeURIComponent(other.id)}/node-aliases`), err => err.code === 'mailbox_not_found');
});

test('the demo refuses to disable a mail node mailbox but not a connected one', async () => {
  const node = await demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'paused', domain: 'demo.mailexpert.local', name: '' });
  await assert.rejects(() => demoRequest('PUT', `/accounts/${encodeURIComponent(node.id)}`, { enabled: false }), err => err.code === 'mail_node_disable_unsupported');
  const other = (await demoRequest('GET', '/accounts')).find(a => !a.mail_node);
  const updated = await demoRequest('PUT', `/accounts/${encodeURIComponent(other.id)}`, { enabled: false });
  assert.equal(updated.enabled, false);
});

test('the demo EOP settings start at mailcow signing and 50 messages an hour, and keep a save', async () => {
  const initial = await demoRequest('GET', '/mail-node/eop');
  assert.equal(initial.dkimMode, 'mailcow');
  assert.equal(initial.sendLimitPerHour, 50);
  assert.equal(initial.tenantConfigured, false);
  const saved = await demoRequest('PUT', '/mail-node/eop', {
    tenantId: '11111111-2222-4333-8444-555555555555', appId: '22222222-3333-4444-8555-666666666666', certThumbprint: 'A'.repeat(40),
  });
  assert.equal(saved.tenantConfigured, true);
  assert.equal(saved.tenantDriverActive, false);
  assert.equal((await demoRequest('GET', '/mail-node/eop')).appId, '22222222-3333-4444-8555-666666666666');
});

test('the demo EOP settings refuse and normalize like the server', async () => {
  await assert.rejects(() => demoRequest('PUT', '/mail-node/eop', { certThumbprint: 'xyz' }), err => err.code === 'thumbprint_invalid');
  await assert.rejects(() => demoRequest('PUT', '/mail-node/eop', { sendLimitPerHour: '0' }), err => err.code === 'send_limit_invalid');
  await assert.rejects(() => demoRequest('PUT', '/mail-node/eop', { tenantId: 'contoso' }), err => err.code === 'tenant_id_invalid');
  const saved = await demoRequest('PUT', '/mail-node/eop', {
    certThumbprint: 'ab:cd ef01 2345 6789 abcd ef01 2345 6789 abcd ef01', tenantId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', terrl: '48248',
  });
  assert.equal(saved.certThumbprint, 'ABCDEF0123456789ABCDEF0123456789ABCDEF01');
  assert.equal(saved.tenantId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(saved.terrl, 48248);
});

test('the demo applies the node settings: the node and its domains, and the spam rule only by its own action', async () => {
  const before = await demoRequest('GET', '/mail-node/apply');
  assert.deepEqual(before.node.items.find(i => i.item === 'prefilter'), { item: 'prefilter', target: null, status: 'pending', code: 'prefilter_differs' });
  const result = await demoRequest('POST', '/mail-node/apply');
  assert.deepEqual(result.node.map(i => i.item), ['tls_policy', 'relayhost', 'fail2ban', 'prefilter', 'forwarding_hosts']);
  // The forwarding hosts wait for the spam filing rule.
  const waiting = result.node.find(i => i.item === 'forwarding_hosts');
  assert.equal(waiting.status, 'skipped');
  assert.equal(waiting.code, 'prefilter_not_applied');
  assert.equal(waiting.fwdhosts.missing.length, waiting.fwdhosts.wanted);
  assert.deepEqual(waiting.fwdhosts.foreign, ['198.51.100.25']);
  assert.ok(result.domains.length > 0);
  assert.ok(result.domains.every(d => d.items.map(i => i.item).join() === 'domain_relayhost,dkim,mailbox_limits'));
  // Every mailbox has the limit the panel wants after an apply.
  const { mailboxes } = await demoRequest('GET', '/mail-node/mailboxes');
  assert.ok(mailboxes.every(m => m.rateLimit && m.rateLimit.value === (m.rateLimitOverride ?? m.rateLimitDefault).value));
  // A domain the tenant signs keeps mailcow's key until the administrator confirms its deletion.
  let pilot = await demoRequest('POST', '/mail-node/domains/pilot.demo.mailexpert.local/apply');
  assert.deepEqual(pilot.items.find(i => i.item === 'dkim').code, 'dkim_delete_unconfirmed');
  pilot = await demoRequest('POST', '/mail-node/domains/pilot.demo.mailexpert.local/apply', { confirmDkimDelete: true });
  assert.equal(pilot.items.find(i => i.item === 'dkim').status, 'changed');
  assert.equal(pilot.dkim, null);
  const listed = (await demoRequest('GET', '/mail-node/domains')).domains.find(d => d.domain === 'pilot.demo.mailexpert.local');
  assert.equal(listed.apply.items.find(i => i.item === 'dkim').status, 'changed');
  const ready = (await demoRequest('GET', '/mail-node/domains')).domains.find(d => d.domain === 'demo.mailexpert.local');
  assert.equal(ready.apply.dkim.name, 'dkim._domainkey.demo.mailexpert.local');
  const written = await demoRequest('POST', '/mail-node/apply/prefilter');
  assert.equal(written.status, 'changed');
  assert.deepEqual(written.forwardingHosts, { status: 'changed' });
  assert.equal((await demoRequest('POST', '/mail-node/apply/prefilter')).status, 'ok');
  assert.equal((await demoRequest('GET', '/mail-node/apply')).node.items.find(i => i.item === 'prefilter').status, 'ok');
  // Once the rule is on the node the ranges follow it; the next apply finds them in place.
  const fwd = (await demoRequest('GET', '/mail-node/apply')).node.items.find(i => i.item === 'forwarding_hosts');
  assert.equal(fwd.status, 'ok');
  assert.deepEqual(fwd.fwdhosts.missing, []);
  assert.equal((await demoRequest('POST', '/mail-node/apply')).node.find(i => i.item === 'forwarding_hosts').status, 'ok');
  await assert.rejects(() => demoRequest('POST', '/mail-node/domains/nowhere.example/apply'), err => err.code === 'domain_not_on_node');
});

test('the demo keeps the TLS policy of the next hop and applies a change to the node', async () => {
  assert.equal((await demoRequest('GET', '/mail-node/eop')).tlsPolicy, 'secure');
  await assert.rejects(() => demoRequest('PUT', '/mail-node/eop', { tlsPolicy: 'none' }), err => err.code === 'tls_policy_invalid');
  await assert.rejects(() => demoRequest('PUT', '/mail-node/eop', { tlsPolicy: 'fingerprint' }), err => err.code === 'tls_parameters_invalid');
  await assert.rejects(() => demoRequest('PUT', '/mail-node/eop', { tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=AB:CD' }), err => err.code === 'tls_parameters_invalid');
  await assert.rejects(() => demoRequest('PUT', '/mail-node/eop', { tlsPolicy: 'encrypt', tlsPolicyParameters: 'match=nexthop' }), err => err.code === 'tls_parameters_invalid');
  const saved = await demoRequest('PUT', '/mail-node/eop', { tlsPolicy: 'fingerprint', tlsPolicyParameters: ' match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A ' });
  assert.equal(saved.tlsPolicyParameters, 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A');
  assert.equal(saved.applying, true);
  assert.deepEqual((await demoRequest('GET', '/mail-node/apply')).node.items[0], {
    item: 'tls_policy', target: 'demo-mailexpert-local.mail.protection.outlook.com', status: 'changed', from: 'secure', to: 'fingerprint match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A',
  });
  const back = await demoRequest('PUT', '/mail-node/eop', { tlsPolicy: 'secure', tlsPolicyParameters: '' });
  assert.equal(back.applying, true);
  assert.equal((await demoRequest('GET', '/mail-node/apply')).node.items[0].to, 'secure');
  assert.equal((await demoRequest('PUT', '/mail-node/eop', { terrl: '1000' })).applying, undefined);
});

test('the demo sets a mailbox\'s own send limit and its default again, refusing bad ones', async () => {
  const [first] = (await demoRequest('GET', '/mail-node/mailboxes')).mailboxes;
  await assert.rejects(() => demoRequest('PUT', `/mail-node/mailboxes/${first.accountId}/rate-limit`, { value: 0, frame: 'h' }), err => err.code === 'rate_limit_invalid');
  await assert.rejects(() => demoRequest('PUT', `/mail-node/mailboxes/${first.accountId}/rate-limit`, { value: 5, frame: 'w' }), err => err.code === 'rate_limit_invalid');
  let saved = await demoRequest('PUT', `/mail-node/mailboxes/${first.accountId}/rate-limit`, { value: 7, frame: 'm' });
  assert.deepEqual(saved, { ok: true, rateLimit: { value: 7, frame: 'm' }, rateLimitOverride: { value: 7, frame: 'm' } });
  saved = await demoRequest('PUT', `/mail-node/mailboxes/${first.accountId}/rate-limit`, { value: null });
  assert.equal(saved.rateLimitOverride, null);
  const listed = (await demoRequest('GET', '/mail-node/mailboxes')).mailboxes.find(m => m.accountId === first.accountId);
  assert.deepEqual(listed.rateLimit, listed.rateLimitDefault);
});

test('the demo keeps the panel addresses for fail2ban, checked like the server', async () => {
  assert.deepEqual((await demoRequest('GET', '/mail-node/config')).panelIps, ['203.0.113.10']);
  await assert.rejects(() => demoRequest('PUT', '/mail-node/config', { panelIps: '0.0.0.0/0' }), err => err.code === 'panel_ips_invalid');
  const saved = await demoRequest('PUT', '/mail-node/config', { panelIps: '203.0.113.10, 198.51.100.0/24' });
  assert.equal(saved.applying, true);
  assert.ok((await demoRequest('GET', '/mail-node/apply')).node.items.some(i => i.item === 'fail2ban'));
  await assert.rejects(() => demoRequest('PUT', '/mail-node/config', { panelIps: '203.0.0.0/23' }), err => err.code === 'panel_ips_invalid');
  assert.deepEqual((await demoRequest('GET', '/mail-node/config')).panelIps, ['203.0.113.10', '198.51.100.0/24']);
});

test('an ordinary demo user is offered only the ready domains', async () => {
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'user', setItem: () => {} };
  try {
    const { domains } = await demoRequest('GET', '/mail-node/domains');
    assert.ok(domains.length > 0);
    assert.ok(domains.every(d => d.active && ['ready', 'authoritative'].includes(d.state)));
    assert.equal(domains.some(d => d.domain === 'legacy.demo.mailexpert.local'), false);
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('the demo sender history lists earlier letters with their direction, and from: search finds them', async () => {
  const history = await demoRequest('GET', '/mail/messages/demo-001/sender-history?limit=5');
  assert.equal(history.correspondent, 'maya@northstar.example');
  assert.deepEqual(history.items.map(i => [i.id, i.direction]), [['demo-005', 'out']]);
  const found = await demoRequest('GET', '/mail/search?q=from%3Amaya%40northstar.example');
  assert.deepEqual(found.messages.map(m => m.id), ['demo-001']);
});

test('the demo contact letters cover every mailbox and report direction, counts and last contact', async () => {
  // demo-contact-2 (Priya Shah) matches demo-004: received in the ops mailbox's inbox.
  const letters = await demoRequest('GET', '/contacts/demo-contact-2/letters?limit=20&offset=0');
  assert.equal(letters.received, 1);
  assert.equal(letters.sent, 0);
  assert.equal(letters.total, 1);
  assert.deepEqual(letters.items.map(i => [i.id, i.account_id, i.direction]), [['demo-004', 'demo-ops', 'in']]);
  assert.equal(letters.lastDate, letters.items[0].date);
});

test('the demo contact letters precedence matches mailboxBanner: an own address never counts as received', async () => {
  // A contact whose address happens to equal one of our own mailboxes (demo-sales). demo-005 is
  // that mailbox's own Sent reply to Maya — its from_email matches the contact's address, but an
  // own address must win precedence and it's not addressed back to itself, so it must not appear
  // at all (neither in nor out).
  const contact = await demoRequest('POST', '/contacts', { displayName: 'Sales (self)', emails: [{ value: 'sales@demo.mailexpert.local' }] });
  const letters = await demoRequest('GET', `/contacts/${contact.id}/letters?limit=20&offset=0`);
  assert.equal(letters.items.some(i => i.id === 'demo-005'), false);
  assert.equal(letters.total, 0);
});

test('the demo contact letters reject like the real 404 for an unknown contact', async () => {
  await assert.rejects(
    () => demoRequest('GET', '/contacts/does-not-exist/letters'),
    /Contact not found/,
  );
});

test('the demo threading diagnostics report the reply chain and letter count for a known message', async () => {
  const diagnostics = await demoRequest('GET', '/mail/messages/demo-005/threading');
  assert.equal(diagnostics.inReplyTo, '<demo-001@demo.mailexpert.local>');
  assert.deepEqual(diagnostics.references, ['<demo-001@demo.mailexpert.local>']);
  assert.equal(diagnostics.reason, 'rfc-root');
  assert.equal(diagnostics.conversation.total, 2);
});

test('the demo threading diagnostics reject like the real 404 for an unknown message', async () => {
  await assert.rejects(
    () => demoRequest('GET', '/mail/messages/does-not-exist/threading'),
    /Message not found/,
  );
});

test('the demo holds 50 mailboxes: Gmail ones in gmail mode and node ones on several domains', async () => {
  const accounts = await demoRequest('GET', '/accounts');
  assert.equal(accounts.length, 50);
  assert.equal(new Set(accounts.map(a => a.email_address)).size, 50);
  assert.equal(accounts.filter(a => a.thread_mode === 'gmail' && a.oauth_provider === 'google').length, 24);
  const nodeDomains = new Set(accounts.filter(a => a.mail_node).map(a => a.email_address.split('@')[1]));
  assert.ok(nodeDomains.size >= 3);
  const { domains } = await demoRequest('GET', '/mail-node/domains');
  assert.ok(domains.some(d => !d.active), 'an inactive domain shows the form filters it out');
});

test('the demo threaded list folds a conversation into one row with its letter count', async () => {
  const flat = await demoRequest('GET', '/mail/messages?accountId=demo-fx-00&folder=INBOX');
  const threaded = await demoRequest('GET', '/mail/messages?accountId=demo-fx-00&folder=INBOX&threaded=true');
  assert.equal(threaded.threaded, true);
  assert.ok(threaded.total < flat.total);
  const conversation = threaded.messages.find(m => m.message_count > 1);
  assert.ok(conversation);
  const { messages } = await demoRequest('GET', `/mail/thread/${encodeURIComponent(conversation.thread_id)}?accountId=demo-fx-00`);
  assert.ok(messages.length > conversation.message_count, 'the expansion adds the replies from Sent');
  assert.ok(messages.some(m => m.folder === 'Sent'));
});

test('the demo letters cover every threading reason, each mailbox in its own mode', async () => {
  const reasons = new Set();
  const modes = new Map((await demoRequest('GET', '/accounts')).map(a => [a.id, a.thread_mode]));
  for (const id of ['demo-fx-00', 'demo-fx-01', 'demo-fx-02', 'demo-fx-04', 'demo-fx-06', 'demo-fx-08']) {
    for (const folder of ['INBOX', 'Sent', 'Archive', 'Projects/Launch']) {
      const { messages } = await demoRequest('GET', `/mail/messages?accountId=${id}&folder=${encodeURIComponent(folder)}&limit=500`);
      for (const m of messages) {
        const diagnostics = await demoRequest('GET', `/mail/messages/${m.id}/threading`);
        assert.equal(diagnostics.mode, modes.get(id));
        reasons.add(diagnostics.reason);
      }
    }
  }
  for (const reason of ['new-root', 'rfc-root', 'rfc-ancestor', 'rfc-provisional', 'gmail-thrid', null]) {
    assert.ok(reasons.has(reason), `no letter with reason ${reason}`);
  }
});

test('the demo refuses a domain mailbox whose address is already a mailbox, like the server', async () => {
  await assert.rejects(
    () => demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'Sales', domain: 'example.com', name: '' }),
    err => err.code === 'mailbox_exists',
  );
  await assert.rejects(
    () => demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'info', domain: 'old-brand.example', name: '' }),
    err => err.code === 'domain_unknown',
  );
  const created = await demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'sales', domain: 'example.org', name: 'Продажи Запад' });
  assert.equal(created.email_address, 'sales@example.org');
  assert.equal(created.name, 'Продажи Запад');
  await assert.rejects(
    () => demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'sales', domain: 'example.org', name: '' }),
    err => err.code === 'mailbox_exists',
  );
  const inbox = await demoRequest('GET', `/mail/messages?accountId=${encodeURIComponent(created.id)}&folder=INBOX`);
  assert.equal(inbox.total, 1);
});

test('the demo connects a Gmail address in place of Google and refuses it twice', async () => {
  assert.deepEqual((await demoRequest('GET', '/integrations/status')).google, { configured: true, available: true });
  const known = await demoRequest('GET', '/oauth/google/known-emails?q=archive');
  assert.deepEqual(known.emails, ['acme.archive.demo@gmail.com']);
  const started = await demoRequest('POST', '/oauth/google/start', { email: 'Acme.Archive.Demo@gmail.com' });
  assert.equal(started.result, 'created');
  const account = (await demoRequest('GET', '/accounts')).find(a => a.email_address === 'acme.archive.demo@gmail.com');
  assert.equal(account.oauth_provider, 'google');
  assert.equal(account.thread_mode, 'gmail');
  assert.deepEqual((await demoRequest('GET', '/oauth/google/known-emails?q=archive')).emails, []);
  await assert.rejects(
    () => demoRequest('POST', '/oauth/google/start', { email: 'acme.archive.demo@gmail.com' }),
    err => err.code === 'already_connected',
  );
});

test('a letter deleted in the demo shows in Trash under a new id, as after an IMAP move', async () => {
  await demoRequest('DELETE', '/mail/messages/demo-002');
  const trash = await demoRequest('GET', '/mail/messages?accountId=demo-ops&folder=Trash');
  const moved = trash.messages.find(m => m.message_id === '<demo-002@demo.mailexpert.local>');
  assert.ok(moved, 'the letter is in Trash');
  assert.notEqual(moved.id, 'demo-002');
  // Deleting it again from Trash removes it for good.
  await demoRequest('DELETE', `/mail/messages/${moved.id}`);
  const after = await demoRequest('GET', '/mail/messages?accountId=demo-ops&folder=Trash');
  assert.equal(after.messages.some(m => m.message_id === '<demo-002@demo.mailexpert.local>'), false);
});

test('the demo sends a new mailbox under its sender name and offers the second one in From', async () => {
  const created = await demoRequest('POST', '/accounts', {
    kind: 'domain', localPart: 'press', domain: 'example.com', name: '', senderName: 'Пресс-служба', senderNameAlt: 'Press Office',
  });
  assert.equal(created.sender_name, 'Пресс-служба');
  assert.equal(created.name, 'Пресс-служба');
  assert.deepEqual(created.aliases.map(a => [a.name, a.email]), [['Press Office', 'press@example.com']]);
  assert.deepEqual((await demoRequest('GET', `/accounts/${encodeURIComponent(created.id)}/aliases`)).map(a => a.name), ['Press Office']);

  await demoRequest('POST', '/oauth/google/start', { email: 'acme.legacy.demo@gmail.com', senderName: 'Иван Петров', senderNameAlt: 'Ivan Petrov' });
  const gmail = (await demoRequest('GET', '/accounts')).find(a => a.email_address === 'acme.legacy.demo@gmail.com');
  assert.equal(gmail.sender_name, 'Иван Петров');
  assert.deepEqual(gmail.aliases.map(a => a.name), ['Ivan Petrov']);
});

test('the demo shows a past outage with delayed and lost letters and one going on with letters waiting (R-43)', async () => {
  const outages = await demoRequest('GET', '/mail-node/outages');
  const [ongoing, past] = outages.windows;
  assert.equal(ongoing.open, true);
  assert.ok(ongoing.counts.waiting > 0);
  assert.equal(past.open, false);
  assert.ok(past.counts.delayed > 0 && past.counts.lost > 0);
  assert.ok(outages.waiting.waiting > 0 && outages.traceConnected);
  const { letters } = await demoRequest('GET', `/mail-node/outages/${past.id}/letters`);
  assert.ok(letters.some(l => l.outcome === 'lost' && l.expired && l.statusCode === '4.4.7'));
  const mine = await demoRequest('GET', '/mail-node/outage-letters');
  assert.ok(mine.letters.length > 0 && mine.letters.every(l => l.outcome !== 'other' && l.accountId && l.key && !('detail' in l) && !('statusCode' in l) && !('status' in l)));
  const alerts = await demoRequest('GET', '/mail-node/alerts');
  assert.ok(alerts.state.alerts.some(a => a.key === 'outage_letters_waiting'));
});

test('the demo reports when each mailbox last received mail, so the sidebar order shows', async () => {
  const accounts = await demoRequest('GET', '/accounts');
  assert.ok(accounts.every(a => a.last_received_at === null || !Number.isNaN(Date.parse(a.last_received_at))));
  const byLatest = accounts.filter(a => a.last_received_at).sort((a, b) => Date.parse(b.last_received_at) - Date.parse(a.last_received_at));
  // Mail that arrived just now sits in mailboxes down the fleet: they come before the older ones.
  assert.deepEqual(byLatest.slice(0, 3).map(a => a.id), ['demo-fx-19', 'demo-fx-41', 'demo-fx-07']);
  assert.notDeepEqual(byLatest.slice(0, 3).map(a => a.id), accounts.slice(0, 3).map(a => a.id), 'not just the stored order');
  // A mailbox's date is its newest INBOX letter, not one in another folder.
  const { messages } = await demoRequest('GET', '/mail/messages?accountId=demo-fx-19&folder=INBOX&limit=500');
  const newest = messages.map(m => m.date).sort().at(-1);
  assert.equal(accounts.find(a => a.id === 'demo-fx-19').last_received_at, newest);
});

test('the demo\'s last-received date is a record of arrivals: archiving the letter does not take it back', async () => {
  const before = (await demoRequest('GET', '/accounts')).find(a => a.id === 'demo-fx-19').last_received_at;
  const { messages } = await demoRequest('GET', '/mail/messages?accountId=demo-fx-19&folder=INBOX&limit=500');
  const newest = messages.find(m => m.date === before);
  assert.ok(newest);
  await demoRequest('POST', '/mail/messages/bulk-move', { ids: [newest.id], folder: 'Archive' });
  const after = (await demoRequest('GET', '/mail/messages?accountId=demo-fx-19&folder=INBOX&limit=500')).messages;
  assert.ok(!after.some(m => m.id === newest.id), 'the letter left the inbox');
  assert.equal((await demoRequest('GET', '/accounts')).find(a => a.id === 'demo-fx-19').last_received_at, before);
});

test('the demo\'s accounts carry no date ahead of now', async () => {
  const now = Date.now();
  for (const account of await demoRequest('GET', '/accounts')) {
    assert.ok(account.last_received_at === null || Date.parse(account.last_received_at) <= now, account.id);
  }
});

test('the demo pins and unpins one mailbox at a time, on its stored list, with the server\'s rules', async () => {
  await demoRequest('PATCH', '/auth/preferences', { pinnedAccounts: ['demo-fx-03'] });
  await demoRequest('PATCH', '/auth/preferences', { pinAccount: 'demo-ops' });
  await demoRequest('PATCH', '/auth/preferences', { pinAccount: 'demo-ops' });
  assert.deepEqual((await demoRequest('GET', '/auth/preferences')).pinnedAccounts, ['demo-fx-03', 'demo-ops']);
  await demoRequest('PATCH', '/auth/preferences', { unpinAccount: 'demo-fx-03' });
  assert.deepEqual((await demoRequest('GET', '/auth/preferences')).pinnedAccounts, ['demo-ops']);
  await assert.rejects(() => demoRequest('PATCH', '/auth/preferences', { pinnedAccounts: 'demo-ops' }), /must be an array/);
  await assert.rejects(() => demoRequest('PATCH', '/auth/preferences', { pinAccount: 7 }), /must be an account id/);
  await assert.rejects(() => demoRequest('PATCH', '/auth/preferences', { pinAccount: 'a', unpinAccount: 'b' }), /cannot be sent together/);
});

test('the demo keeps pins and the sort switch in its preferences, with the server\'s rules', async () => {
  const first = await demoRequest('GET', '/auth/preferences');
  assert.deepEqual(first.pinnedAccounts, ['demo-fx-24', 'demo-fx-09']);
  assert.equal(first.sortAccountsByLatest, true);

  await demoRequest('PATCH', '/auth/preferences', { pinnedAccounts: ['demo-fx-03', 'demo-fx-03', 7, 'demo-ops'], sortAccountsByLatest: false });
  const saved = await demoRequest('GET', '/auth/preferences');
  assert.deepEqual(saved.pinnedAccounts, ['demo-fx-03', 'demo-ops'], 'ids only, once each, in pin order');
  assert.equal(saved.sortAccountsByLatest, false);

  // Another preference leaves them alone; a pin of a mailbox that does not exist is dropped on read.
  await demoRequest('PATCH', '/auth/preferences', { theme: 'dusk' });
  assert.deepEqual((await demoRequest('GET', '/auth/preferences')).pinnedAccounts, ['demo-fx-03', 'demo-ops']);
  await demoRequest('PATCH', '/auth/preferences', { pinnedAccounts: ['demo-fx-03', 'gone'] });
  assert.deepEqual((await demoRequest('GET', '/auth/preferences')).pinnedAccounts, ['demo-fx-03']);

  await assert.rejects(() => demoRequest('PATCH', '/auth/preferences', { sortAccountsByLatest: 'yes' }), /must be a boolean/);
  assert.equal((await demoRequest('GET', '/auth/preferences')).sortAccountsByLatest, false);
});

test('a node mailbox keeps its address on its aliases and does not send from an old foreign one (D-16)', async () => {
  const accounts = await demoRequest('GET', '/accounts');
  const node = accounts.find((a) => a.id === 'demo-fx-00');
  assert.equal(node.mail_node, true);
  const legacy = node.aliases.find((a) => a.email !== node.email_address);
  assert.ok(legacy, 'the demo keeps one alias with another address on a node mailbox');

  await assert.rejects(
    () => demoRequest('POST', `/accounts/${node.id}/aliases`, { name: 'Other', email: `other@${node.email_address.split('@')[1]}` }),
    { code: 'node_alias_address_mismatch' },
  );
  await assert.rejects(
    () => demoRequest('PUT', `/accounts/${node.id}/aliases/${legacy.id}`, { name: 'Orders' }),
    { code: 'node_alias_address_mismatch' },
  );
  const added = await demoRequest('POST', `/accounts/${node.id}/aliases`, { name: 'Second name', email: node.email_address.toUpperCase() });
  assert.equal(added.name, 'Second name');

  await assert.rejects(
    () => demoRequest('POST', '/mail/send', { accountId: node.id, aliasId: legacy.id, to: ['you@example.com'], subject: 'Hi', body: 'Hello' }),
    { code: 'node_alias_stale' },
  );

  const gmail = accounts.find((a) => a.mail_node !== true && a.oauth_provider === 'google');
  const other = await demoRequest('POST', `/accounts/${gmail.id}/aliases`, { name: 'Work', email: 'work@example.org' });
  assert.equal(other.email, 'work@example.org');
});
