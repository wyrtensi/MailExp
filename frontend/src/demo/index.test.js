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
  await demoRequest('POST', '/mail-node/domains/branch.demo.mailexpert.local/acknowledge');
  const accepted = await branch();
  assert.equal(accepted.state, 'ready');
  assert.equal(accepted.recreated, undefined);
  await assert.rejects(() => demoRequest('POST', '/mail-node/domains/branch.demo.mailexpert.local/acknowledge'), err => err.code === 'domain_not_recreated');
  const restarted = await demoRequest('POST', '/mail-node/domains/branch.demo.mailexpert.local/restart');
  assert.equal(restarted.state, 'node_created');
  const after = await branch();
  assert.deepEqual(after.steps, {});
  assert.equal(after.nextStep, 'node_configured');
  // The mailbox made on it stays.
  assert.ok((await demoRequest('GET', '/accounts')).some(a => a.id === account.id));
  await assert.rejects(() => demoRequest('POST', '/mail-node/domains/legacy.demo.mailexpert.local/restart'), err => err.code === 'domain_not_found');
});

test('the demo deletes a mail node mailbox with its mail, and the address can be created again empty', async () => {
  const account = await demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'gone', domain: 'demo.mailexpert.local', name: '' });
  const letters = async (id) => (await demoRequest('GET', `/mail/messages?accountId=${encodeURIComponent(id)}&folder=INBOX`)).messages
    ?.filter(m => m.account_id === id) ?? [];
  assert.equal((await letters(account.id)).length, 1);
  const count = async () => (await demoRequest('GET', '/mail-node/domains')).domains.find(d => d.domain === 'demo.mailexpert.local').mailboxes;
  const before = await count();
  await demoRequest('DELETE', `/accounts/${encodeURIComponent(account.id)}`);
  assert.equal((await demoRequest('GET', '/accounts')).some(a => a.id === account.id), false);
  assert.equal((await demoRequest('GET', '/mail-node/mailboxes')).mailboxes.some(m => m.accountId === account.id), false);
  assert.equal(await count(), before - 1);
  const again = await demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'gone', domain: 'demo.mailexpert.local', name: '' });
  assert.equal((await letters(again.id)).length, 1, 'only the new welcome letter');
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
