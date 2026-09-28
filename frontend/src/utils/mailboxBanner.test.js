import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mailboxBanner, isSentFolder, isDraftFolder } from './mailboxBanner.js';

const account = {
  email_address: 'Sales@example.com',
  aliases: [{ email: 'info@example.com' }],
  folder_mappings: { sent: 'Sent' },
};

describe('mailboxBanner', () => {
  it('names the mailbox a letter arrived in, with no extra address when it came to the mailbox itself', () => {
    assert.deepEqual(mailboxBanner({ from_email: 'client@example.net', delivery_addresses: ['sales@example.com'] }, account),
      { direction: 'in', via: null });
    assert.deepEqual(mailboxBanner({ from_email: 'client@example.net' }, account), { direction: 'in', via: null });
  });

  it('shows the address it was delivered to when that is an alias or a group address', () => {
    assert.deepEqual(mailboxBanner({ from_email: 'client@example.net', delivery_addresses: '["team@example.com"]' }, account),
      { direction: 'in', via: 'team@example.com' });
  });

  it('says the mailbox sent it when the mailbox or one of its aliases wrote it, to someone else, in Sent', () => {
    assert.equal(mailboxBanner({ from_email: 'sales@example.com', folder: 'Sent', to_addresses: [{ email: 'client@example.net' }] }, account).direction, 'out');
    assert.equal(mailboxBanner({ from_email: 'INFO@example.com', folder: 'Sent', to_addresses: [{ email: 'client@example.net' }] }, account).direction, 'out');
  });

  it('falls back to the address on the letter row when the mailbox is not in the store', () => {
    assert.equal(mailboxBanner({ from_email: 'ops@example.com', account_email: 'ops@example.com', folder: 'Sent', to_addresses: [{ email: 'x@example.net' }] }, null).direction, 'out');
  });

  it('a letter the mailbox sent to itself is "out" only in Sent — elsewhere it is also a received copy', () => {
    const selfSent = { from_email: 'sales@example.com', to_addresses: [{ email: 'sales@example.com' }] };
    assert.deepEqual(mailboxBanner({ ...selfSent, folder: 'INBOX' }, account), { direction: 'in', via: null });
    assert.deepEqual(mailboxBanner({ ...selfSent, folder: '[Gmail]/All Mail' }, account), { direction: 'in', via: null });
    assert.deepEqual(mailboxBanner({ ...selfSent, folder: 'Sent' }, account), { direction: 'out', via: null });
  });

  it('a letter sent to one of the mailbox\'s own aliases is also "in" outside Sent', () => {
    const toAlias = { from_email: 'sales@example.com', folder: 'INBOX', to_addresses: [{ email: 'info@example.com' }] };
    assert.deepEqual(mailboxBanner(toAlias, account), { direction: 'in', via: null });
  });

  it('a self-send reaching the mailbox only via Cc or Bcc (delivery_addresses) is also "in" outside Sent', () => {
    assert.equal(mailboxBanner({
      from_email: 'sales@example.com', folder: 'INBOX',
      to_addresses: [{ email: 'client@example.net' }], cc_addresses: [{ email: 'sales@example.com' }],
    }, account).direction, 'in');
    assert.equal(mailboxBanner({
      from_email: 'sales@example.com', folder: 'INBOX',
      to_addresses: [{ email: 'client@example.net' }], delivery_addresses: ['sales@example.com'],
    }, account).direction, 'in');
  });

  it('a normal outgoing letter with no recipient of our own is "out" everywhere, even without a Sent mapping', () => {
    const noOwnRecipient = { from_email: 'sales@example.com', folder: 'INBOX', to_addresses: [{ email: 'client@example.net' }] };
    assert.equal(mailboxBanner(noOwnRecipient, { ...account, folder_mappings: {} }).direction, 'out');
  });

  it('an own-sent letter with no recipients at all is "out" (nothing to be self-addressed to)', () => {
    assert.equal(mailboxBanner({ from_email: 'sales@example.com', folder: 'INBOX' }, account).direction, 'out');
  });

  it('recognizes Sent by special_use when no folder_mappings.sent is configured', () => {
    const noMapping = { ...account, folder_mappings: {} };
    const folderList = [{ path: 'INBOX' }, { path: '[Gmail]/Sent Mail', special_use: '\\Sent' }];
    const selfSent = { from_email: 'sales@example.com', to_addresses: [{ email: 'sales@example.com' }] };
    assert.equal(mailboxBanner({ ...selfSent, folder: '[Gmail]/Sent Mail' }, noMapping, folderList).direction, 'out');
    assert.equal(mailboxBanner({ ...selfSent, folder: 'INBOX' }, noMapping, folderList).direction, 'in');
  });
});

describe('isSentFolder', () => {
  it('matches the account\'s configured sent folder exactly', () => {
    assert.equal(isSentFolder('Sent', { sent: 'Sent' }), true);
    assert.equal(isSentFolder('INBOX', { sent: 'Sent' }), false);
  });

  it('falls back to special_use when no sent mapping is configured', () => {
    const folderList = [{ path: 'INBOX' }, { path: '[Gmail]/Sent Mail', special_use: '\\Sent' }];
    assert.equal(isSentFolder('[Gmail]/Sent Mail', {}, folderList), true);
    assert.equal(isSentFolder('INBOX', {}, folderList), false);
    assert.equal(isSentFolder('[Gmail]/Sent Mail', undefined, undefined), false);
  });

  it('is false for an empty folder', () => {
    assert.equal(isSentFolder('', { sent: 'Sent' }), false);
    assert.equal(isSentFolder(null, { sent: 'Sent' }), false);
  });
});

describe('isDraftFolder', () => {
  it('matches the account\'s configured drafts folder exactly', () => {
    assert.equal(isDraftFolder('Drafts', { drafts: 'Drafts' }), true);
    assert.equal(isDraftFolder('INBOX', { drafts: 'Drafts' }), false);
  });

  it('falls back to a path heuristic when no drafts mapping is configured', () => {
    assert.equal(isDraftFolder('Drafts', {}), true);
    assert.equal(isDraftFolder('[Gmail]/Drafts', undefined), true);
    assert.equal(isDraftFolder('INBOX', {}), false);
  });

  it('is false for an empty folder', () => {
    assert.equal(isDraftFolder('', { drafts: 'Drafts' }), false);
    assert.equal(isDraftFolder(null, { drafts: 'Drafts' }), false);
  });
});
