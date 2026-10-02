// Message trace rows and details in the shapes of Graph (exchangeMessageTrace, List messageTraces;
// exchangeMessageTraceDetail, getDetailsByRecipient; Learn, 2026-01-27) for one outage of the node,
// 2026-10-01 10:00-14:00 UTC, for the tests of the correlation (R-43). Made up from the Learn
// examples: the shapes and statuses are Learn's; the event words and descriptions of deferred and
// expired mail (Defer with 450 4.4.316, Fail with 550 4.4.7 QUEUE.Expired) follow the mail flow
// documentation and are Inferred until a tenant shows the real strings (requirements, section 6).

export const OUTAGE = Object.freeze({ start: '2026-10-01T10:00:00Z', end: '2026-10-01T14:00:00Z' });

const row = (id, recipient, receivedDateTime, status, subject, sender = 'sender@contoso.com') => ({
  id,
  senderAddress: sender,
  recipientAddress: recipient,
  messageId: `<${id}@contoso.com>`,
  receivedDateTime,
  subject,
  size: 45678,
  fromIP: '203.0.113.10',
  toIP: '',
  status,
});

export const TRACE_ROWS = Object.freeze([
  // Held during the outage, delivered after it.
  row('4451a062-48cb-e80d-e8c0-196330437ae6', 'anna@stage.test', '2026-10-01T10:30:00Z', 'delivered', 'Quarterly Report'),
  // Expired after 24 hours of retries: the sender got 550 4.4.7.
  row('b7c1f4d2-9a6e-4c3b-8f2d-1e0a6c5b4d3f', 'Anna@Stage.test', '2026-10-01T11:00:00Z', 'failed', 'Monthly report', 'partner@fabrikam.com'),
  // Still in EOP's queue.
  row('c1d2e3f4-5678-49ab-9cde-0123456789ab', 'boris@stage.test', '2026-10-01T13:30:00Z', 'pending', 'Weekly digest: updates for your team'),
  // Quarantined by EOP during the window: not the outage's.
  row('a3f6d2c1-5c3b-4f7a-9d1e-2c8f1b0a6e45', 'boris@stage.test', '2026-10-01T12:00:00Z', 'quarantined', 'You won'),
  // Delivered in the hour before the window, never waiting: not affected.
  row('0d7f3a2b-6c1e-4f9a-9b9a-3c0a2b1c4d5e', 'anna@stage.test', '2026-10-01T09:30:00Z', 'delivered', 'Daily report'),
  // Refused by the node in the hour before the window (unknown user), not expired: not affected.
  row('1f2e3d4c-5b6a-7980-9a0b-1c2d3e4f5a6b', 'nobody@stage.test', '2026-10-01T09:20:00Z', 'failed', 'Hello'),
  // Another tenant domain, not the node's.
  row('2a3b4c5d-6e7f-8091-a2b3-c4d5e6f78901', 'someone@cloud.example', '2026-10-01T11:30:00Z', 'pending', 'Not ours'),
  // The trace has not settled yet.
  row('3b4c5d6e-7f80-91a2-b3c4-d5e6f7890123', 'anna@stage.test', '2026-10-01T13:50:00Z', 'gettingStatus', 'In progress'),
]);

const event = (dateTime, name, description, data = '<root></root>') => ({
  id: 'x', messageId: '<x@contoso.com>', dateTime, event: name, action: '', description, data,
});

export const TRACE_DETAILS = Object.freeze({
  'b7c1f4d2-9a6e-4c3b-8f2d-1e0a6c5b4d3f|anna@stage.test': [
    event('2026-10-01T11:00:05Z', 'Receive', 'Message received by: AM0PR00MB0001.eurprd00.prod.outlook.com'),
    event('2026-10-01T11:00:10Z', 'Defer', 'The message was deferred. 450 4.4.316 Connection refused [Message=Socket error code 10061] [LastAttemptedServerName=mail.stage.test] [LastAttemptedServerIP=203.0.113.25:25]'),
    event('2026-10-02T11:00:12Z', 'Fail', 'Reason: [{LED=550 4.4.7 QUEUE.Expired; message expired};{MSG=};{FQDN=mail.stage.test};{IP=203.0.113.25};{LRT=}]. OutboundProxyTargetIP: 203.0.113.25.', '<root><MEP Name="StatusCode" String="550 4.4.7" /></root>'),
  ],
  'c1d2e3f4-5678-49ab-9cde-0123456789ab|boris@stage.test': [
    event('2026-10-01T13:30:04Z', 'Receive', 'Message received by: AM0PR00MB0001.eurprd00.prod.outlook.com'),
    event('2026-10-01T13:30:09Z', 'Defer', 'The message was deferred. 450 4.4.316 Connection refused [Message=Socket error code 10061] [LastAttemptedServerName=mail.stage.test]'),
  ],
  '1f2e3d4c-5b6a-7980-9a0b-1c2d3e4f5a6b|nobody@stage.test': [
    event('2026-10-01T09:20:05Z', 'Fail', '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup'),
  ],
});
