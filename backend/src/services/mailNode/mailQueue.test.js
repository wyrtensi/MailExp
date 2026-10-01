import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, parsePostcat, postcatGone, summarizeQueue } from './mailQueue.js';

// `postcat -q` of a message fake-EOP deferred on the stand (2026-10-01), its long headers shortened.
const POSTCAT = [
  '*** ENVELOPE RECORDS deferred/5/53A99193F13 ***',
  'message_size:             360             300               1               0             360               0',
  'message_arrival_time: Thu Oct  1 19:02:59 2026',
  'create_time: Thu Oct  1 19:02:59 2026',
  'named_attribute: rewrite_context=local',
  'sender_fullname: root',
  'sender: someone@stage.test',
  'warning_message_time: Thu Oct  1 23:02:59 2026',
  'named_attribute: dsn_orig_rcpt=rfc822;test@example.com',
  'original_recipient: test@example.com',
  'recipient: test@example.com',
  '*** MESSAGE CONTENTS deferred/5/53A99193F13 ***',
  'Received: by mail.test.local (Postcow, from userid 0)',
  '\tid 53A99193F13; Thu, 01 Oct 2026 19:02:59 +0000 (UTC)',
  'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=stage.test; s=dkim;',
  '\tt=1790881379; h=from:subject:date:message-id:to;',
  'From: someone@stage.test',
  'To: test@example.com',
  'Subject: stage eop test 00:02:59',
  'Message-Id: <20261001190259.53A99193F13@mail.test.local>',
  'X-Spamd-Result: default: False [0.40 / 15.00];',
  '\tR_MISSING_CHARSET(0.50)[];',
  '',
  'Sent by stage.sh eop send.',
  '*** HEADER EXTRACTED deferred/5/53A99193F13 ***',
  'named_attribute: message_id=<20261001190259.53A99193F13@mail.test.local>',
  '*** MESSAGE FILE END deferred/5/53A99193F13 ***',
  '',
].join('\n');

describe('parsePostcat', () => {
  it('splits the envelope and the headers and leaves the body out unless asked', () => {
    const message = parsePostcat(POSTCAT);
    expect(message).toMatchObject({
      queueId: '53A99193F13', queue: 'deferred',
      envelope: { sender: 'someone@stage.test', recipients: ['test@example.com'], arrival: 'Thu Oct  1 19:02:59 2026' },
      bodyBytes: 'Sent by stage.sh eop send.'.length, body: null, bodyTruncated: false,
    });
    expect(message.headers.map((h) => h.name)).toEqual(['Received', 'DKIM-Signature', 'From', 'To', 'Subject', 'Message-Id', 'X-Spamd-Result']);
    expect(message.headers[0].value).toBe('by mail.test.local (Postcow, from userid 0) id 53A99193F13; Thu, 01 Oct 2026 19:02:59 +0000 (UTC)');
  });

  it('gives the body on request, cut at 64 KB', () => {
    expect(parsePostcat(POSTCAT, { withBody: true }).body).toBe('Sent by stage.sh eop send.');
    const big = POSTCAT.replace('Sent by stage.sh eop send.', 'x'.repeat(MAX_BODY_BYTES + 10));
    const cut = parsePostcat(big, { withBody: true });
    expect(cut.body).toHaveLength(MAX_BODY_BYTES);
    expect(cut.bodyTruncated).toBe(true);
  });

  it('reads a message of an unhashed queue and CRLF output', () => {
    const active = POSTCAT.replaceAll('deferred/5/53A99193F13', 'active/53A99193F13').replace(/\n/g, '\r\n');
    expect(parsePostcat(active)).toMatchObject({ queue: 'active', queueId: '53A99193F13' });
  });

  it('reads recipients from the extracted headers too, and keeps delivered ones apart', () => {
    const dump = POSTCAT
      .replace('recipient: test@example.com', 'recipient: test@example.com\ndone_recipient: done@example.com')
      .replace('named_attribute: message_id=', 'recipient: Bcc-Copy@Example.org\nnamed_attribute: message_id=');
    expect(parsePostcat(dump).envelope).toMatchObject({
      recipients: ['test@example.com', 'bcc-copy@example.org'], doneRecipients: ['done@example.com'],
    });
  });

  it('marks a dump cut at the read limit', () => {
    const message = parsePostcat(POSTCAT.split('*** HEADER EXTRACTED')[0], { withBody: true, truncated: true });
    expect(message).toMatchObject({ dumpTruncated: true, bodyTruncated: true });
  });

  it('tells a message gone from the queue from other failures', () => {
    expect(postcatGone('/usr/sbin/postcat: fatal: open queue file DDA3F1A23C1: No such file or directory\n')).toBe(true);
    expect(postcatGone('err: invalid')).toBe(false);
    expect(postcatGone(POSTCAT)).toBe(false);
  });

  it('is null for what postcat says when the message is gone', () => {
    expect(parsePostcat('postcat: fatal: open queue file 53A99193F13: No such file or directory\n')).toBeNull();
    expect(parsePostcat('1')).toBeNull();
    expect(parsePostcat(null)).toBeNull();
  });
});

describe('summarizeQueue', () => {
  it('counts per queue and finds the oldest deferred message', () => {
    const now = Date.parse('2026-10-01T20:00:00Z');
    const summary = summarizeQueue([
      { queueId: 'A1', queue: 'deferred', arrivedAt: '2026-10-01T19:30:00Z', recipients: [] },
      { queueId: 'B2', queue: 'hold', arrivedAt: '2026-10-01T18:00:00Z', recipients: [] },
      { queueId: 'C3', queue: 'deferred', arrivedAt: '2026-10-01T19:00:00Z', recipients: [] },
      { queueId: 'D4', queue: 'active', arrivedAt: null, recipients: [] },
    ], now);
    expect(summary.counts).toEqual({ active: 1, deferred: 2, hold: 1, incoming: 0, maildrop: 0 });
    expect(summary.total).toBe(4);
    expect(summary.oldestDeferredSeconds).toBe(3600);
    expect(summary.items.map((i) => [i.queueId, i.ageSeconds])).toEqual([['B2', 7200], ['C3', 3600], ['A1', 1800], ['D4', null]]);
  });

  it('has no oldest deferred without deferred messages', () => {
    expect(summarizeQueue([]).oldestDeferredSeconds).toBeNull();
  });
});
