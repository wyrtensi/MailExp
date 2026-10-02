import { describe, expect, it } from 'vitest';
import { policyConflicts, summarizePolicy } from './antispam.js';
import { TENANT_FIXTURES } from './fakes.js';

// R-28: the default policy against the filing layout of R-11.

const fitting = {
  SpamAction: 'MoveToJmf', HighConfidenceSpamAction: 'AddXHeader', BulkSpamAction: 'MoveToJmf',
  PhishSpamAction: 'MoveToJmf', HighConfidencePhishAction: 'Quarantine',
};

describe('policyConflicts', () => {
  it('a policy that delivers spam to the node with headers fits', () => {
    expect(policyConflicts(summarizePolicy(fitting))).toEqual([]);
  });

  it('quarantined spam is hidden from the employees', () => {
    expect(policyConflicts(summarizePolicy({ ...fitting, SpamAction: 'Quarantine' }))).toEqual([
      { field: 'SpamAction', action: 'Quarantine', expected: ['MoveToJmf', 'AddXHeader'], code: 'quarantined', severity: 'warning' },
    ]);
  });

  it('names each kind of mismatch', () => {
    const conflicts = policyConflicts(summarizePolicy({
      SpamAction: 'Delete', HighConfidenceSpamAction: 'Redirect', BulkSpamAction: 'NoAction',
      PhishSpamAction: 'ModifySubject', HighConfidencePhishAction: 'Redirect',
    }));
    expect(conflicts.map((c) => [c.field, c.code, c.severity])).toEqual([
      ['SpamAction', 'deleted', 'error'],
      ['HighConfidenceSpamAction', 'redirected', 'warning'],
      ['BulkSpamAction', 'no_action', 'warning'],
      ['PhishSpamAction', 'subject_only', 'info'],
      ['HighConfidencePhishAction', 'redirect_not_decided', 'warning'],
    ]);
  });

  it('the recorded Default policy quarantines phishing', () => {
    const policy = summarizePolicy(TENANT_FIXTURES.exo.get_content_filter_policy[0]);
    expect(policy).toMatchObject({ identity: 'Default', BulkThreshold: 7, PhishSpamAction: 'Quarantine' });
    expect(policyConflicts(policy).map((c) => c.field)).toEqual(['PhishSpamAction']);
  });

  it('nothing for no policy', () => {
    expect(summarizePolicy(null)).toBeNull();
    expect(policyConflicts(null)).toEqual([]);
  });
});
