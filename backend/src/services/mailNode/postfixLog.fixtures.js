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

// Two letters of the mailbox r17-delivery@stage.test sent through submission (stand, 2026-10-02,
// newest first), each to two recipients, with the TLS lines of the smtp client: the first refused
// by fake-EOP in recipient-denied (550 5.4.1, with the bounce notice delivered back over LMTP), the
// second accepted by fake-EOP answering in EOP's shape (Message-ID, InternalId, Hostname, bytes).
// The API gives no process id: program is "postfix/smtp", never "postfix/smtp[442]".
export const STAND_DELIVERY = Object.freeze([
  { time: '1790933738', program: 'postfix/qmgr', priority: 'info', message: '0C3BF1A4B81: removed' },
  { time: '1790933738', program: 'postfix/smtp', priority: 'info', message: '0C3BF1A4B81: to=<second@example.org>, relay=eop.test.local[172.22.1.7]:25, delay=0.26, delays=0.09/0.02/0.1/0.05, dsn=2.6.0, status=sent (250 2.6.0 <r17-accepted-1790933733899@stage.test> [InternalId=1099511627777, Hostname=EOPSTAGE01MB0001.stageprd01.prod.eop.test.local] 1091 bytes in 0.049, 21.743 KB/sec Queued mail for delivery)' },
  { time: '1790933738', program: 'postfix/smtp', priority: 'info', message: '0C3BF1A4B81: to=<test@example.com>, relay=eop.test.local[172.22.1.7]:25, delay=0.26, delays=0.09/0.02/0.1/0.05, dsn=2.6.0, status=sent (250 2.6.0 <r17-accepted-1790933733899@stage.test> [InternalId=1099511627777, Hostname=EOPSTAGE01MB0001.stageprd01.prod.eop.test.local] 1091 bytes in 0.049, 21.743 KB/sec Queued mail for delivery)' },
  { time: '1790933738', program: 'postfix/smtp', priority: 'info', message: 'Untrusted TLS connection established to eop.test.local[172.22.1.7]:25: TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits) key-exchange x25519 server-signature RSA-PSS (2048 bits) server-digest SHA256 client-signature RSA-PSS (2048 bits) client-digest SHA256' },
  { time: '1790933738', program: 'postfix/qmgr', priority: 'info', message: '0C3BF1A4B81: from=<r17-delivery@stage.test>, size=494, nrcpt=2 (queue active)' },
  { time: '1790933738', program: 'postfix/cleanup', priority: 'info', message: '0C3BF1A4B81: message-id=<r17-accepted-1790933733899@stage.test>' },
  { time: '1790933738', program: 'postfix/submission/smtpd', priority: 'info', message: '0C3BF1A4B81: client=unknown[172.22.1.1], sasl_method=PLAIN, sasl_username=r17-delivery@stage.test' },
  { time: '1790933358', program: 'postfix/lmtp', priority: 'info', message: '61EB61A4B57: to=<r17-delivery@stage.test>, relay=dovecot[172.22.1.250]:24, delay=0.06, delays=0.01/0.01/0/0.04, dsn=2.0.0, status=sent (250 2.0.0 <r17-delivery@stage.test> WEvfGG55v2rJAAAAqAbqoQ Saved)' },
  { time: '1790933358', program: 'postfix/qmgr', priority: 'info', message: '61EB61A4B57: removed' },
  { time: '1790933358', program: 'postfix/qmgr', priority: 'info', message: '127621A4B8F: removed' },
  { time: '1790933358', program: 'postfix/qmgr', priority: 'info', message: '61EB61A4B57: from=<>, size=3611, nrcpt=1 (queue active)' },
  { time: '1790933358', program: 'postfix/bounce', priority: 'info', message: '127621A4B8F: sender non-delivery notification: 61EB61A4B57' },
  { time: '1790933358', program: 'postfix/cleanup', priority: 'info', message: '61EB61A4B57: message-id=<20261002092918.61EB61A4B57@mail.test.local>' },
  { time: '1790933358', program: 'postfix/smtp', priority: 'info', message: '127621A4B8F: to=<second@example.org>, relay=eop.test.local[172.22.1.7]:25, delay=0.34, delays=0.15/0.03/0.1/0.06, dsn=5.4.1, status=bounced (host eop.test.local[172.22.1.7] said: 550 5.4.1 Recipient address rejected: Access denied. AS(201806281) (in reply to RCPT TO command))' },
  { time: '1790933358', program: 'postfix/smtp', priority: 'info', message: '127621A4B8F: to=<test@example.com>, relay=eop.test.local[172.22.1.7]:25, delay=0.34, delays=0.15/0.03/0.1/0.06, dsn=5.4.1, status=bounced (host eop.test.local[172.22.1.7] said: 550 5.4.1 Recipient address rejected: Access denied. AS(201806281) (in reply to RCPT TO command))' },
  { time: '1790933358', program: 'postfix/smtp', priority: 'info', message: 'Untrusted TLS connection established to eop.test.local[172.22.1.7]:25: TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits) key-exchange x25519 server-signature RSA-PSS (2048 bits) server-digest SHA256 client-signature RSA-PSS (2048 bits) client-digest SHA256' },
  { time: '1790933358', program: 'postfix/qmgr', priority: 'info', message: '127621A4B8F: from=<r17-delivery@stage.test>, size=488, nrcpt=2 (queue active)' },
  { time: '1790933358', program: 'postfix/cleanup', priority: 'info', message: '127621A4B8F: message-id=<r17-denied-1790933353895@stage.test>' },
  { time: '1790933358', program: 'postfix/submission/smtpd', priority: 'info', message: '127621A4B8F: client=unknown[172.22.1.1], sasl_method=PLAIN, sasl_username=r17-delivery@stage.test' },
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

// A message deferred, held, released and delivered through the panel's queue actions (stand,
// 2026-10-01, branch code), newest first.
export const STAND_QUEUE_ACTIONS = Object.freeze([
  { time: '1790882447', program: 'postfix/qmgr', priority: 'info', message: '20BA719F6B6: removed' },
  { time: '1790882447', program: 'postfix/smtp', priority: 'info', message: '20BA719F6B6: to=<test@example.com>, relay=eop.test.local[172.22.1.13]:25, delay=20, delays=20/0/0.13/0.05, dsn=2.6.0, status=sent (250 2.6.0 <20261001T192047154-0031-08e6@eop.test.local> [InternalId=35] Queued mail for delivery)' },
  { time: '1790882446', program: 'postfix/qmgr', priority: 'info', message: '20BA719F6B6: from=<someone@stage.test>, size=360, nrcpt=1 (queue active)' },
  { time: '1790882444', program: 'postfix/postsuper', priority: 'info', message: '20BA719F6B6: released from hold' },
  { time: '1790882437', program: 'postfix/postsuper', priority: 'info', message: '20BA719F6B6: placed on hold' },
  { time: '1790882427', program: 'postfix/smtp', priority: 'info', message: '20BA719F6B6: to=<test@example.com>, relay=eop.test.local[172.22.1.13]:25, delay=0.25, delays=0.03/0.03/0.14/0.05, dsn=4.7.500, status=deferred (host eop.test.local[172.22.1.13] said: 451 4.7.500 Server busy. Please try again later from [172.22.1.253]. (S77) (in reply to RCPT TO command))' },
  { time: '1790882427', program: 'postfix/qmgr', priority: 'info', message: '20BA719F6B6: from=<someone@stage.test>, size=360, nrcpt=1 (queue active)' },
  { time: '1790882427', program: 'postfix/cleanup', priority: 'info', message: '20BA719F6B6: message-id=<20261001192027.20BA719F6B6@mail.test.local>' },
  { time: '1790882427', program: 'postfix/pickup', priority: 'info', message: '20BA719F6B6: uid=0 from=<someone@stage.test>' },
]);

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
// Made up: mail handed straight to a recipient's Microsoft 365 MX (another tenant's EOP, inside the
// EOP ranges): not this tenant's path, so a bypass while <EOP_HOST> names this tenant's.
export const SENT_TO_RECIPIENT_M365_MX = Object.freeze({
  time: '1790881502', program: 'postfix/smtp', priority: 'info',
  message: '9D3E4F5A6B7: to=<buyer@m365cust.com>, relay=m365cust-com.mail.protection.outlook.com[52.101.10.5]:25, delay=0.8, delays=0.1/0/0.3/0.4, dsn=2.6.0, status=sent (250 2.6.0 <id@example> [InternalId=2] Queued mail for delivery)',
});
// A message a header check threw away (Postfix's format).
export const DISCARDED = Object.freeze({
  time: '1790881503', program: 'postfix/discard', priority: 'info',
  message: 'AE4F5A6B7C8: to=<nobody@example.org>, relay=none, delay=0.1, delays=0.1/0/0/0, dsn=2.0.0, status=sent (discarded by header check)',
});
// A message qmgr gave up on (Postfix's format; not seen on the stand).
export const EXPIRED = Object.freeze({
  time: '1790881600', program: 'postfix/qmgr', priority: 'info',
  message: '9C3D4E5F6A7: from=<someone@stage.test>, status=expired, returned to sender',
});
