import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  eopSendsToSpam, filterQuarantine, formatScore, matchNoteKey, releaseEopNoteShown, releaseNoteKey, rspamdActionKey, sizeLabel,
  spamReasons,
} from './quarantine.js';

describe('quarantine helpers', () => {
  it('names rspamd actions and leaves an unknown one to be shown as written', () => {
    assert.equal(rspamdActionKey('add header'), 'message.spamVerdict.action.addHeader');
    assert.equal(rspamdActionKey('REJECT'), 'message.spamVerdict.action.reject');
    assert.equal(rspamdActionKey('no action'), 'message.spamVerdict.action.noAction');
    assert.equal(rspamdActionKey('quarantine'), null);
  });

  it('prints scores without trailing zeros', () => {
    assert.equal(formatScore(16.1), '16.1');
    assert.equal(formatScore(8), '8');
    assert.equal(formatScore(-0.1), '-0.1');
    assert.equal(formatScore(12.3456), '12.35');
    assert.equal(formatScore(null), '');
  });

  it('says what releasing does by what rspamd did', () => {
    assert.equal(releaseNoteKey('reject'), 'admin.quarantine.noteRejected');
    assert.equal(releaseNoteKey('add header'), 'admin.quarantine.noteDelivered');
    assert.equal(releaseNoteKey('rewrite subject'), 'admin.quarantine.noteDelivered');
    assert.equal(releaseNoteKey('unknown'), 'admin.quarantine.noteOther');
  });

  it('filters by sender, recipient or subject', () => {
    const items = [
      { sender: 'a@bad.test', rcpt: 'sales@example.com', subject: 'Invoice' },
      { sender: 'b@ok.test', rcpt: 'info@example.com', subject: 'Hello' },
    ];
    assert.equal(filterQuarantine(items, '').length, 2);
    assert.deepEqual(filterQuarantine(items, 'INVOICE'), [items[0]]);
    assert.deepEqual(filterQuarantine(items, 'info@'), [items[1]]);
    assert.deepEqual(filterQuarantine(items, 'ok.test'), [items[1]]);
  });

  it('follows the panel\'s filing rule for EOP verdicts', () => {
    assert.equal(eopSendsToSpam({ verdict: 'SPM', category: 'SPM' }), true);
    // Released from quarantine (section 5.14): spam, high confidence spam and spoofing still go to
    // Spam, bulk does not.
    assert.equal(eopSendsToSpam({ verdict: 'SKQ', category: 'SPM' }), true);
    assert.equal(eopSendsToSpam({ verdict: 'SKQ', category: 'HSPM' }), true);
    assert.equal(eopSendsToSpam({ verdict: 'SKQ', category: 'SPOOF' }), true);
    assert.equal(eopSendsToSpam({ verdict: 'SKQ', category: 'BULK' }), false);
    assert.equal(eopSendsToSpam({ verdict: 'SKQ', category: 'PHSH' }), true);
    assert.equal(eopSendsToSpam({ verdict: 'NSPM', category: 'NONE' }), false);
    assert.equal(eopSendsToSpam({ category: 'BULK' }), true);
    assert.equal(eopSendsToSpam(null), false);
  });

  it('tells why a letter is in Spam', () => {
    assert.deepEqual(spamReasons({ rspamd: { action: 'add header' }, eopCategory: null }), ['message.spamVerdict.reasonRspamd']);
    assert.deepEqual(spamReasons({ rspamd: { action: 'no action' }, eopCategory: 'SPM' }), ['message.spamVerdict.reasonEop']);
    assert.deepEqual(spamReasons({ rspamd: { action: 'add header' }, eopCategory: 'PHSH' }), [
      'message.spamVerdict.reasonRspamd', 'message.spamVerdict.reasonEop',
    ]);
    assert.deepEqual(spamReasons({ rspamd: { action: 'no action' }, eopCategory: null }), ['message.spamVerdict.reasonOther']);
    assert.deepEqual(spamReasons({ rspamd: null, eopCategory: null }), []);
    assert.deepEqual(spamReasons({ rspamd: null, eopCategory: 'SPOOF' }), ['message.spamVerdict.reasonEop']);
    // A refused letter reached the mailbox only by a release: no rspamd reason.
    assert.deepEqual(spamReasons({ rspamd: { action: 'reject' }, eopCategory: 'SPM' }), ['message.spamVerdict.reasonEop']);
    assert.deepEqual(spamReasons({ rspamd: { action: 'reject' }, eopCategory: null }), ['message.spamVerdict.reasonOther']);
  });

  it('notes an unusual match and shows the EOP release note only for refused letters', () => {
    assert.equal(matchNoteKey('message_id'), null);
    assert.equal(matchNoteKey('recipient_time'), 'message.spamVerdict.matchedByTime');
    assert.equal(matchNoteKey('message_id_other_rcpt'), 'message.spamVerdict.matchedOtherRcpt');
    assert.equal(releaseEopNoteShown('reject', { verdict: 'SPM', category: 'SPM' }), true);
    assert.equal(releaseEopNoteShown('add header', { verdict: 'SPM', category: 'SPM' }), false);
    assert.equal(releaseEopNoteShown('reject', { verdict: 'NSPM', category: 'NONE' }), false);
    assert.equal(releaseEopNoteShown('reject', null), false);
  });

  it('prints attachment sizes', () => {
    assert.deepEqual(sizeLabel(12), { key: 'admin.quarantine.sizeBytes', value: '12' });
    assert.deepEqual(sizeLabel(48213), { key: 'admin.quarantine.sizeKb', value: '47' });
    assert.deepEqual(sizeLabel(5 * 1024 * 1024), { key: 'admin.quarantine.sizeMb', value: '5.0' });
  });
});
