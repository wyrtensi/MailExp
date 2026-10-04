import { describe, expect, it } from 'vitest';
import { RELEASABLE_TYPES, decide, quarantineTypeOf, recipientsOf } from './quarantineRelease.js';
import { TENANT_FIXTURES } from './fakes.js';

// The guards of R-42 on one message read by its Identity (the shapes of fixtures.json), with the
// releasable types of the owner's decision after stage 7 (section 5.14).
const ROW = TENANT_FIXTURES.exo.get_quarantine_message[0];
const DOMAINS = ['example.com'];

describe('decide (R-42 guards)', () => {
  it('releases inbound high confidence phishing to the node only', () => {
    expect(decide(ROW, DOMAINS)).toEqual({ act: 'release' });
    // Type alone (QuarantineTypes missing) and either casing of the status.
    expect(decide({ ...ROW, QuarantineTypes: undefined, ReleaseStatus: 'NotReleased' }, DOMAINS)).toEqual({ act: 'release' });
    expect(decide({ ...ROW, ReleaseStatus: 'ERROR' }, DOMAINS)).toEqual({ act: 'release' });
  });

  it('releases phishing, spam and high confidence spam the same way (section 5.14)', () => {
    expect(RELEASABLE_TYPES).toEqual(['HighConfPhish', 'Phish', 'Spam', 'HighConfSpam']);
    expect(decide({ ...ROW, QuarantineTypes: 'Phish', Type: 'Phish' }, DOMAINS)).toEqual({ act: 'release' });
    expect(decide({ ...ROW, QuarantineTypes: 'Spam', Type: 'Spam' }, DOMAINS)).toEqual({ act: 'release' });
    expect(decide({ ...ROW, QuarantineTypes: 'Spam', Type: 'High Confidence Spam' }, DOMAINS)).toEqual({ act: 'release' });
    expect(decide({ ...ROW, QuarantineTypes: ['Spam'], Type: undefined }, DOMAINS)).toEqual({ act: 'release' });
    // The other guards hold for every type.
    expect(decide({ ...ROW, QuarantineTypes: 'Spam', Type: 'Spam', Direction: 'Outbound' }, DOMAINS)).toEqual({ act: 'skip', reason: 'outbound' });
    expect(decide({ ...ROW, QuarantineTypes: 'Phish', Type: 'Phish', RecipientAddress: ['x@other.example.org'] }, DOMAINS))
      .toEqual({ act: 'skip', reason: 'foreign_recipients' });
  });

  it('never releases malware or another type, a message without a type or one of mixed types', () => {
    for (const [types, type] of [
      ['Malware', 'Malware'], ['Bulk', 'Bulk'], ['TransportRule', 'Transport Rule'], ['FileTypeBlock', 'FileTypeBlock'],
      ['DataLossPrevention', 'Data Loss Prevention'], ['SPOMalware', 'SPOMalware'],
      [['Phish', 'Malware'], 'Phish'], ['Spam', 'Phish, Malware'], [undefined, undefined], ['', ''], [[], null],
    ]) {
      expect(decide({ ...ROW, QuarantineTypes: types, Type: type }, DOMAINS), JSON.stringify([types, type]))
        .toEqual({ act: 'skip', reason: 'type_not_allowed' });
    }
  });

  it('never releases an outbound message or one with a recipient off the node', () => {
    expect(decide({ ...ROW, Direction: 'Outbound' }, DOMAINS)).toEqual({ act: 'skip', reason: 'outbound' });
    expect(decide({ ...ROW, Direction: undefined }, DOMAINS)).toEqual({ act: 'skip', reason: 'outbound' });
    expect(decide({ ...ROW, RecipientAddress: ['info@example.com', 'x@other.example.org'] }, DOMAINS)).toEqual({ act: 'skip', reason: 'foreign_recipients' });
    // A subdomain of a node domain is another domain.
    expect(decide({ ...ROW, RecipientAddress: ['x@sub.example.com'] }, DOMAINS)).toEqual({ act: 'skip', reason: 'foreign_recipients' });
    expect(decide({ ...ROW, RecipientAddress: [] }, DOMAINS)).toEqual({ act: 'skip', reason: 'no_recipients' });
  });

  it('reads the release status: released, denied, in progress, unknown', () => {
    expect(decide({ ...ROW, ReleaseStatus: 'RELEASED' }, DOMAINS)).toEqual({ act: 'released' });
    expect(decide({ ...ROW, ReleaseStatus: 'Approved' }, DOMAINS)).toEqual({ act: 'released' });
    expect(decide({ ...ROW, ReleaseStatus: 'DENIED' }, DOMAINS)).toEqual({ act: 'skip', reason: 'release_denied' });
    expect(decide({ ...ROW, ReleaseStatus: 'PREPARINGTORELEASE' }, DOMAINS)).toEqual({ act: 'wait', reason: 'preparingtorelease' });
    expect(decide({ ...ROW, ReleaseStatus: 'Requested' }, DOMAINS)).toEqual({ act: 'wait', reason: 'requested' });
    expect(decide({ ...ROW, ReleaseStatus: 'Something new' }, DOMAINS)).toEqual({ act: 'wait', reason: 'status_unknown' });
  });

  it('names the type a message was quarantined as, the more precise Type first', () => {
    expect(quarantineTypeOf(ROW)).toBe('HighConfPhish');
    expect(quarantineTypeOf({ QuarantineTypes: 'Spam', Type: 'High Confidence Spam' })).toBe('HighConfSpam');
    expect(quarantineTypeOf({ QuarantineTypes: 'Phish' })).toBe('Phish');
    expect(quarantineTypeOf({ QuarantineTypes: 'Malware', Type: 'Malware' })).toBe('Malware');
    expect(quarantineTypeOf({})).toBeNull();
  });

  it('takes the recipients as an array or a single value, lower case, once each', () => {
    expect(recipientsOf({ RecipientAddress: 'Info@Example.com' })).toEqual(['info@example.com']);
    expect(recipientsOf({ RecipientAddress: ['b@example.com', 'A@example.com', 'a@example.com', ''] })).toEqual(['a@example.com', 'b@example.com']);
    expect(recipientsOf({})).toEqual([]);
  });
});
