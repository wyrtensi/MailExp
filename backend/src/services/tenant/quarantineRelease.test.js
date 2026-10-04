import { describe, expect, it } from 'vitest';
import { decide, recipientsOf } from './quarantineRelease.js';
import { TENANT_FIXTURES } from './fakes.js';

// The guards of R-42 on one message read by its Identity (the shapes of fixtures.json).
const ROW = TENANT_FIXTURES.exo.get_quarantine_message[0];
const DOMAINS = ['example.com'];

describe('decide (R-42 guards)', () => {
  it('releases inbound high confidence phishing to the node only', () => {
    expect(decide(ROW, DOMAINS)).toEqual({ act: 'release' });
    // Type alone (QuarantineTypes missing) and either casing of the status.
    expect(decide({ ...ROW, QuarantineTypes: undefined, ReleaseStatus: 'NotReleased' }, DOMAINS)).toEqual({ act: 'release' });
    expect(decide({ ...ROW, ReleaseStatus: 'ERROR' }, DOMAINS)).toEqual({ act: 'release' });
  });

  it('never releases another type, an outbound message or one with a recipient off the node', () => {
    expect(decide({ ...ROW, QuarantineTypes: 'Phish', Type: 'Phish' }, DOMAINS)).toEqual({ act: 'skip', reason: 'not_high_conf_phish' });
    expect(decide({ ...ROW, QuarantineTypes: 'Malware', Type: 'Malware' }, DOMAINS)).toEqual({ act: 'skip', reason: 'not_high_conf_phish' });
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

  it('takes the recipients as an array or a single value, lower case, once each', () => {
    expect(recipientsOf({ RecipientAddress: 'Info@Example.com' })).toEqual(['info@example.com']);
    expect(recipientsOf({ RecipientAddress: ['b@example.com', 'A@example.com', 'a@example.com', ''] })).toEqual(['a@example.com', 'b@example.com']);
    expect(recipientsOf({})).toEqual([]);
  });
});
