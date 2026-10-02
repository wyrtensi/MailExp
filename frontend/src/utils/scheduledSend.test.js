import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeContext, composeDataFromScheduled, scheduledActions, scheduledStatusKey, sendFailureKey, sendOutcome,
} from './scheduledSend.js';

test('the context keeps what makes a letter a reply or a forward, and the forwarded attachments named', () => {
  const context = composeContext(
    { isReply: true, threadId: 't1', accountId: 'a1', to: ['x@example.com'], quoteMeta: { from: 'X' }, body: '<p>hi</p>' },
    [{ messageId: 'm1', part: '2', filename: 'a.pdf', size: 10, extra: 'dropped' }],
  );
  assert.deepEqual(context, {
    isReply: true, threadId: 't1', quoteMeta: { from: 'X' },
    forwardedAttachments: [{ messageId: 'm1', part: '2', filename: 'a.pdf', size: 10 }],
  });
});

test('an oversized context drops the extras but stays a reply', () => {
  const allRecipients = Array.from({ length: 2000 }, (_, i) => `person${i}@example.com`);
  const context = composeContext({ isReplyAll: true, threadId: 't1', allRecipients });
  assert.deepEqual(context, { isReplyAll: true, threadId: 't1' });
});

test('a letter given back reopens the composer as it was', () => {
  const data = composeDataFromScheduled({
    accountId: 'a1', aliasId: 'al1', to: ['you@example.com'], cc: [], bcc: ['b@example.com'], subject: 'Hi',
    body: '<p>Body</p>', bodyIsHtml: true, quotedBody: '> old', quotedBodyHtml: null, inReplyTo: '<o@x>', references: '<o@x>',
    priority: 'high', editedSignature: '<b>Sig</b>',
    attachments: [{ filename: 'n.txt', contentType: 'text/plain', size: 3, content: 'YWJj' }],
    forwardedAttachments: [{ messageId: 'm1', part: '2' }],
    context: { isReply: true, threadId: 't1', forwardedAttachments: [{ messageId: 'm1', part: '2', filename: 'a.pdf', size: 10 }] },
  });
  assert.deepEqual(data, {
    isReply: true, threadId: 't1', restored: true, accountId: 'a1', aliasId: 'al1',
    to: ['you@example.com'], cc: [], bcc: ['b@example.com'], subject: 'Hi', body: '<p>Body</p>',
    quotedBody: '> old', inReplyTo: '<o@x>', references: '<o@x>', priority: 'high',
    forwardedAttachments: [{ messageId: 'm1', part: '2', filename: 'a.pdf', size: 10 }],
    attachments: [{ name: 'n.txt', size: 3, type: 'text/plain', data: 'YWJj' }],
    draftSignature: '<b>Sig</b>',
  });
});

test('a listed letter is labelled by its status, and only its author or an admin acts on it', () => {
  assert.equal(scheduledStatusKey({ status: 'queued', scheduled: false }), 'sendingSoon');
  assert.equal(scheduledStatusKey({ status: 'queued', scheduled: true }), 'scheduled');
  assert.equal(scheduledStatusKey({ status: 'queued', scheduled: true, errorCode: 'smtp_temporary' }), 'retrying');
  assert.equal(scheduledStatusKey({ status: 'running' }), 'sending');
  assert.equal(scheduledStatusKey({ status: 'needs_attention' }), 'needsAttention');
  assert.deepEqual(scheduledActions({ status: 'queued', canManage: true }), ['edit', 'reschedule', 'cancel']);
  assert.deepEqual(scheduledActions({ status: 'failed', canManage: true }), ['resend', 'edit', 'discard']);
  assert.deepEqual(scheduledActions({ status: 'running', canManage: true }), []);
  assert.deepEqual(scheduledActions({ status: 'queued', canManage: false }), []);
});

test('failure codes map to their messages and statuses to outcomes', () => {
  assert.equal(sendFailureKey('send_uncertain'), 'scheduled.failure.uncertain');
  assert.equal(sendFailureKey('gmail_invalid_recipient'), 'compose.gmailInvalidRecipient');
  assert.equal(sendFailureKey('something_new'), null);
  assert.equal(sendFailureKey('toString'), null);
  assert.deepEqual(['queued', 'running', 'done', 'failed', 'needs_attention', 'cancelled'].map(sendOutcome),
    ['waiting', 'waiting', 'sent', 'failed', 'failed', 'cancelled']);
});
