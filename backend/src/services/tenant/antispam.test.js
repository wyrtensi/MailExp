import { describe, expect, it } from 'vitest';
import { ENFORCED, enforcementPlan, policyConflicts, summarizePolicy } from './antispam.js';
import { TENANT_FIXTURES } from './fakes.js';

// R-28: the default policy against the filing layout of R-11, and what the panel sets (section 5.14).

const fitting = {
  SpamAction: 'MoveToJmf', HighConfidenceSpamAction: 'MoveToJmf', BulkSpamAction: 'MoveToJmf',
  PhishSpamAction: 'MoveToJmf', HighConfidencePhishAction: 'Quarantine',
};

describe('policyConflicts', () => {
  it('a policy that delivers spam, bulk and phishing to the node\'s Junk fits', () => {
    expect(policyConflicts(summarizePolicy(fitting))).toEqual([]);
  });

  it('quarantined spam is hidden from the employees', () => {
    expect(policyConflicts(summarizePolicy({ ...fitting, SpamAction: 'Quarantine' }))).toEqual([
      { field: 'SpamAction', action: 'Quarantine', expected: ['MoveToJmf'], code: 'quarantined', severity: 'warning' },
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
    // An enforced field takes MoveToJmf only; AddXHeader is noted and changed by the panel.
    expect(policyConflicts(summarizePolicy({ ...fitting, SpamAction: 'AddXHeader' })).map((c) => [c.field, c.code, c.severity]))
      .toEqual([['SpamAction', 'header_only', 'info']]);
  });

  it('the recorded Default policy quarantines phishing', () => {
    const policy = summarizePolicy(TENANT_FIXTURES.exo.get_content_filter_policy[0]);
    expect(policy).toMatchObject({ identity: 'Default', BulkThreshold: 7, PhishSpamAction: 'Quarantine' });
    expect(policyConflicts(policy).map((c) => c.field)).toEqual(['PhishSpamAction']);
  });

  it('nothing for no policy', () => {
    expect(summarizePolicy(null)).toBeNull();
    expect(policyConflicts(null)).toEqual([]);
    expect(enforcementPlan(null)).toEqual([]);
  });
});

describe('enforcementPlan (section 5.14)', () => {
  it('sets spam, high confidence spam, phishing and bulk to MoveToJmf, never high confidence phishing', () => {
    expect(ENFORCED).toEqual({
      SpamAction: 'set_spam_action_junk',
      HighConfidenceSpamAction: 'set_high_confidence_spam_action_junk',
      PhishSpamAction: 'set_phish_spam_action_junk',
      BulkSpamAction: 'set_bulk_spam_action_junk',
    });
    expect(enforcementPlan(summarizePolicy(fitting))).toEqual([]);
    expect(enforcementPlan(summarizePolicy({
      SpamAction: 'Quarantine', HighConfidenceSpamAction: 'AddXHeader', PhishSpamAction: 'Delete',
      BulkSpamAction: 'Quarantine', HighConfidencePhishAction: 'Redirect',
    }))).toEqual([
      { field: 'SpamAction', from: 'Quarantine', op: 'set_spam_action_junk' },
      { field: 'HighConfidenceSpamAction', from: 'AddXHeader', op: 'set_high_confidence_spam_action_junk' },
      { field: 'PhishSpamAction', from: 'Delete', op: 'set_phish_spam_action_junk' },
      { field: 'BulkSpamAction', from: 'Quarantine', op: 'set_bulk_spam_action_junk' },
    ]);
  });

  it('writes only what differs and never a field the answer did not carry', () => {
    expect(enforcementPlan(summarizePolicy({ ...fitting, PhishSpamAction: 'Quarantine' })))
      .toEqual([{ field: 'PhishSpamAction', from: 'Quarantine', op: 'set_phish_spam_action_junk' }]);
    expect(enforcementPlan(summarizePolicy({ HighConfidencePhishAction: 'Quarantine' }))).toEqual([]);
  });
});
