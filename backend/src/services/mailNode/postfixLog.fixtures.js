// Postfix log entries as get/logs/postfix answers them (newest first), taken from the local stand
// (mailcow 2026-09, fake-EOP as eop.test.local) on 2026-10-01: one message deferred by a 451 of
// EOP (tempfail), then bounced by 5.7.711 when it was tried again (blocked-connector), a second one
// bounced by 5.7.233 (tenant-limit), each with the bounce notice the node made and delivered back
// over LMTP. For the tests of the log reader, the alerts and the delivery details of a later stage.

export const STAND_LOG = Object.freeze([
  { time: '1790881391', program: 'postfix/qmgr', priority: 'info', message: 'C9244193F13: removed' },
  { time: '1790881391', program: 'postfix/lmtp', priority: 'info', message: "C9244193F13: to=<someone@stage.test>, relay=dovecot[172.22.1.250]:24, delay=0.02, delays=0/0/0/0, dsn=5.1.1, status=bounced (host dovecot[172.22.1.250] said: 550 5.1.1 <someone@stage.test> User doesn't exist: someone@stage.test (in reply to RCPT TO command))" },
  { time: '1790881391', program: 'postfix/qmgr', priority: 'info', message: '98DB419F6B8: removed' },
  { time: '1790881391', program: 'postfix/qmgr', priority: 'info', message: 'C9244193F13: from=<>, size=4573, nrcpt=1 (queue active)' },
  { time: '1790881391', program: 'postfix/bounce', priority: 'info', message: '98DB419F6B8: sender non-delivery notification: C9244193F13' },
  { time: '1790881391', program: 'postfix/cleanup', priority: 'info', message: 'C9244193F13: message-id=<20261001190311.C9244193F13@mail.test.local>' },
  { time: '1790881391', program: 'postfix/smtp', priority: 'info', message: "98DB419F6B8: to=<test@example.com>, relay=eop.test.local[172.22.1.13]:25, delay=0.2, delays=0.02/0/0.13/0.05, dsn=5.7.233, status=bounced (host eop.test.local[172.22.1.13] said: 550 5.7.233 Your message can't be sent because your tenant exceeded its daily limit for sending email to external recipients (in reply to RCPT TO command))" },
  { time: '1790881391', program: 'postfix/qmgr', priority: 'info', message: '98DB419F6B8: from=<someone@stage.test>, size=360, nrcpt=1 (queue active)' },
  { time: '1790881391', program: 'postfix/cleanup', priority: 'info', message: '98DB419F6B8: message-id=<20261001190311.98DB419F6B8@mail.test.local>' },
  { time: '1790881391', program: 'postfix/pickup', priority: 'info', message: '98DB419F6B8: uid=0 from=<someone@stage.test>' },
  { time: '1790881390', program: 'postfix/qmgr', priority: 'info', message: '5302E195CA8: removed' },
  { time: '1790881390', program: 'postfix/lmtp', priority: 'info', message: "5302E195CA8: to=<someone@stage.test>, relay=dovecot[172.22.1.250]:24, delay=0.02, delays=0.01/0.01/0/0, dsn=5.1.1, status=bounced (host dovecot[172.22.1.250] said: 550 5.1.1 <someone@stage.test> User doesn't exist: someone@stage.test (in reply to RCPT TO command))" },
  { time: '1790881390', program: 'postfix/qmgr', priority: 'info', message: '53A99193F13: removed' },
  { time: '1790881390', program: 'postfix/qmgr', priority: 'info', message: '5302E195CA8: from=<>, size=4436, nrcpt=1 (queue active)' },
  { time: '1790881390', program: 'postfix/bounce', priority: 'info', message: '53A99193F13: sender non-delivery notification: 5302E195CA8' },
  { time: '1790881390', program: 'postfix/cleanup', priority: 'info', message: '5302E195CA8: message-id=<20261001190310.5302E195CA8@mail.test.local>' },
  { time: '1790881390', program: 'postfix/smtp', priority: 'info', message: '53A99193F13: to=<test@example.com>, relay=eop.test.local[172.22.1.13]:25, delay=11, delays=11/0/0.14/0.05, dsn=5.7.711, status=bounced (host eop.test.local[172.22.1.13] said: 550 5.7.711 Access denied, bad inbound connector. AS(2204) (in reply to RCPT TO command))' },
  { time: '1790881390', program: 'postfix/qmgr', priority: 'info', message: '53A99193F13: from=<someone@stage.test>, size=360, nrcpt=1 (queue active)' },
  { time: '1790881379', program: 'postfix/smtp', priority: 'info', message: '53A99193F13: to=<test@example.com>, relay=eop.test.local[172.22.1.13]:25, delay=0.26, delays=0.05/0.03/0.13/0.05, dsn=4.7.500, status=deferred (host eop.test.local[172.22.1.13] said: 451 4.7.500 Server busy. Please try again later from [172.22.1.253]. (S77) (in reply to RCPT TO command))' },
  { time: '1790881379', program: 'postfix/qmgr', priority: 'info', message: '53A99193F13: from=<someone@stage.test>, size=360, nrcpt=1 (queue active)' },
  { time: '1790881379', program: 'postfix/cleanup', priority: 'info', message: '53A99193F13: message-id=<20261001190259.53A99193F13@mail.test.local>' },
  { time: '1790881379', program: 'postfix/pickup', priority: 'info', message: '53A99193F13: uid=0 from=<someone@stage.test>' },
]);

// A message accepted by fake-EOP (stand, 2026-10-01): sent through <EOP_HOST>.
export const STAND_SENT_VIA_EOP = Object.freeze({
  time: '1790877403', program: 'postfix/smtp', priority: 'info',
  message: '2127219CF48: to=<test@example.com>, relay=eop.test.local[172.22.1.13]:25, delay=0.23, delays=0.03/0.01/0.14/0.05, dsn=2.6.0, status=sent (250 2.6.0 <20261001T095137363-0030-5f27@eop.test.local> [InternalId=30] Queued mail for delivery)',
});

// Local delivery to Dovecot (stand, 2026-10-01).
export const STAND_SENT_LOCAL = Object.freeze({
  time: '1790877007', program: 'postfix/lmtp', priority: 'info',
  message: '1F2E3D4C5B6: to=<sieve-test-r11b@stage.test>, relay=dovecot[172.22.1.250]:24, delay=0.07, delays=0.03/0.01/0/0.03, dsn=2.0.0, status=sent (250 2.0.0 <sieve-test-r11b@stage.test> UASAK88svmrIAAAAqAbqoQ Saved)',
});

// Made up for the bypass check (R-19): mail handed straight to the recipient's MX, as it would go
// without a relayhost; and one handed to an address inside the EOP ranges under another name.
export const BYPASS_SENT = Object.freeze({
  time: '1790881500', program: 'postfix/smtp', priority: 'info',
  message: '7A1B2C3D4E5: to=<partner@example.org>, relay=mx.example.org[198.51.100.25]:25, delay=1.2, delays=0.1/0/0.6/0.5, dsn=2.0.0, status=sent (250 2.0.0 OK 1790881500 q1-20020a05)',
});
export const SENT_TO_EOP_ADDRESS = Object.freeze({
  time: '1790881501', program: 'postfix/smtp', priority: 'info',
  message: '8B2C3D4E5F6: to=<partner@example.org>, relay=contoso-com.mail.protection.outlook.com[2a01:111:f403:c800::1]:25, delay=0.9, delays=0.1/0/0.4/0.4, dsn=2.6.0, status=sent (250 2.6.0 <id@example> [InternalId=1] Queued mail for delivery)',
});
// A message qmgr gave up on (Postfix's format; not seen on the stand).
export const EXPIRED = Object.freeze({
  time: '1790881600', program: 'postfix/qmgr', priority: 'info',
  message: '9C3D4E5F6A7: from=<someone@stage.test>, status=expired, returned to sender',
});
