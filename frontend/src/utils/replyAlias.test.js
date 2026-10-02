import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddressListField, pickReplyAlias } from './replyAlias.js';

const aliases = [
  { id: 'alias-1', email: 'sales@example.com' },
  { id: 'alias-2', email: 'support@example.com' },
];

describe('parseAddressListField', () => {
  it('returns arrays as-is', () => {
    const arr = [{ email: 'a@example.com' }];
    assert.equal(parseAddressListField(arr), arr);
  });

  it('parses a JSON string', () => {
    assert.deepEqual(parseAddressListField('[{"email":"a@example.com"}]'), [{ email: 'a@example.com' }]);
  });

  it('is null-safe for malformed JSON', () => {
    assert.deepEqual(parseAddressListField('not json'), []);
  });

  it('defaults missing input to []', () => {
    assert.deepEqual(parseAddressListField(undefined), []);
    assert.deepEqual(parseAddressListField(null), []);
  });
});

describe('pickReplyAlias', () => {
  it('matches a delivery address not present in To/Cc (BCC / catch-all case)', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['sales@example.com'],
      toAddresses: [{ email: 'someone-else@example.com' }],
      ccAddresses: [],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('matches To when there is no delivery address hit (unchanged semantics)', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [{ email: 'support@example.com' }],
      ccAddresses: [],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-2');
  });

  it('matches Cc when there is no delivery or To hit', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [],
      ccAddresses: [{ email: 'sales@example.com' }],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('falls back to from_email when nothing else matches', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [],
      ccAddresses: [],
      fromEmail: 'support@example.com',
    });
    assert.equal(result, 'alias-2');
  });

  it('prefers the delivery address match over a different To/Cc match', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['sales@example.com'],
      toAddresses: [{ email: 'support@example.com' }],
      ccAddresses: [],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('returns null when the account has no aliases', () => {
    const result = pickReplyAlias({
      aliases: [],
      deliveryAddresses: ['sales@example.com'],
      toAddresses: [],
      ccAddresses: [],
      fromEmail: '',
    });
    assert.equal(result, null);
  });

  it('is null-safe against malformed JSON strings', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: 'not json',
      toAddresses: 'not json',
      ccAddresses: 'not json',
      fromEmail: '',
    });
    assert.equal(result, null);
  });

  it('matches case-insensitively', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['SALES@Example.com'],
      toAddresses: [],
      ccAddresses: [],
      fromEmail: '',
    });
    assert.equal(result, 'alias-1');
  });

  it('keeps alias creation order as the tiebreak when To and Cc match different aliases', () => {
    // alias-1 was created first; the original matcher scanned aliases against
    // the combined To+Cc set, so it wins even though alias-2 is in To.
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [{ email: 'support@example.com' }],
      ccAddresses: [{ email: 'sales@example.com' }],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('keeps alias creation order as the tiebreak between a From match and a Cc match', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [],
      ccAddresses: [{ email: 'support@example.com' }],
      fromEmail: 'sales@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('lets a delivery match beat alias creation order', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['support@example.com'],
      toAddresses: [{ email: 'sales@example.com' }],
      ccAddresses: [],
      fromEmail: '',
    });
    assert.equal(result, 'alias-2');
  });
});

describe('pickReplyAlias with a second sender name', () => {
  const second = { id: 'al-second', email: 'Sales@Example.com' };
  const other = { id: 'al-other', email: 'info@example.com' };

  it('replies under the main name: an alias with the mailbox address never wins', () => {
    assert.equal(pickReplyAlias({
      aliases: [second], deliveryAddresses: ['sales@example.com'], toAddresses: [{ email: 'sales@example.com' }],
      fromEmail: 'client@example.net', accountEmail: 'sales@example.com',
    }), null);
    // A letter from Sent, written under the second name, still replies under the main one.
    assert.equal(pickReplyAlias({
      aliases: [second], toAddresses: [{ email: 'client@example.net' }], fromEmail: 'sales@example.com', accountEmail: 'sales@example.com',
    }), null);
  });

  it('still picks an alias with its own address next to it', () => {
    assert.equal(pickReplyAlias({
      aliases: [second, other], deliveryAddresses: ['info@example.com'], accountEmail: 'sales@example.com',
    }), 'al-other');
  });
});

describe('pickReplyAlias for a mail node mailbox (D-16)', () => {
  const aliases = [{ id: 'old', name: 'Orders desk', email: 'orders@example.com' }];
  const letter = { deliveryAddresses: ['orders@example.com'], toAddresses: [{ email: 'orders@example.com' }], accountEmail: 'sales@example.com' };

  it('never picks an alias with another address: sending from it is refused', () => {
    assert.equal(pickReplyAlias({ aliases, ...letter, mailNode: true }), null);
  });

  it('still picks it for a mailbox that is not on the mail node', () => {
    assert.equal(pickReplyAlias({ aliases, ...letter }), 'old');
  });
});
