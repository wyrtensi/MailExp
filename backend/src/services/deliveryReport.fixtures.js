// Delivery reports for the tests of services/deliveryReport.js.

// The node's own report (stand, 2026-10-02): r17-delivery@stage.test sent a letter to two
// recipients, fake-EOP in recipient-denied refused both with 550 5.4.1, and Postfix (mailcow, which
// renames X-Postfix-* to X-Postcow-*) returned it. BODYSTRUCTURE as imapflow gives it, and the
// message/delivery-status part (part 2) as fetched. No In-Reply-To or References: the original
// Message-ID is in the envelope of the returned letter (part 3, message/rfc822).
export const STAND_DSN_STRUCTURE = Object.freeze({
  childNodes: [
    { part: '1', type: 'text/plain', parameters: { charset: 'utf-8' }, description: 'Notification', encoding: '8bit', size: 729, lineCount: 19 },
    { part: '2', type: 'message/delivery-status', description: 'Delivery report', encoding: '7bit', size: 678 },
    {
      part: '3', type: 'message/rfc822', description: 'Undelivered Message', encoding: '8bit', size: 1125,
      envelope: {
        date: '2026-10-02T09:29:13.000Z', subject: 'R-17 denied',
        from: [{ name: '', address: 'r17-delivery@stage.test' }], sender: [{ name: '', address: 'r17-delivery@stage.test' }],
        replyTo: [{ name: '', address: 'r17-delivery@stage.test' }],
        to: [{ name: '', address: 'test@example.com' }, { name: '', address: 'second@example.org' }],
        messageId: '<r17-denied-1790933353895@stage.test>',
      },
      childNodes: [{ part: '3', type: 'text/plain', parameters: { charset: 'utf-8' }, encoding: '7bit', size: 25, lineCount: 1 }],
      lineCount: 22,
    },
  ],
  type: 'multipart/report',
  parameters: { 'report-type': 'delivery-status', boundary: '127621A4B8F.1790933358/mail.test.local' },
});

export const STAND_DSN_STATUS = [
  'Reporting-MTA: dns; mail.test.local',
  'X-Postcow-Queue-ID: 127621A4B8F',
  'X-Postcow-Sender: rfc822; r17-delivery@stage.test',
  'Arrival-Date: Fri, 02 Oct 2026 09:29:18 +0000 (UTC)',
  '',
  'Final-Recipient: rfc822; test@example.com',
  'Original-Recipient: rfc822;test@example.com',
  'Action: failed',
  'Status: 5.4.1',
  'Remote-MTA: dns; eop.test.local',
  'Diagnostic-Code: smtp; 550 5.4.1 Recipient address rejected: Access denied.',
  '    AS(201806281)',
  '',
  'Final-Recipient: rfc822; second@example.org',
  'Original-Recipient: rfc822;second@example.org',
  'Action: failed',
  'Status: 5.4.1',
  'Remote-MTA: dns; eop.test.local',
  'Diagnostic-Code: smtp; 550 5.4.1 Recipient address rejected: Access denied.',
  '    AS(201806281)',
  '',
].join('\r\n');

// Made up in the shape of a report Exchange Online sends after it accepted a letter: In-Reply-To
// names the original, the returned part is text/rfc822-headers, one recipient failed, one was
// delayed and one relayed (marks nothing).
export const NDR_STRUCTURE = Object.freeze({
  type: 'multipart/report',
  parameters: { 'Report-Type': 'Delivery-Status', boundary: 'b1' },
  childNodes: [
    { part: '1', type: 'multipart/alternative', childNodes: [] },
    { part: '2', type: 'message/delivery-status', encoding: 'base64' },
    { part: '3', type: 'text/rfc822-headers', encoding: '7bit' },
  ],
});

export const NDR_STATUS = [
  'Reporting-MTA: dns;AM0PR01MB1234.eurprd01.prod.outlook.com',
  'Received-From-MTA: dns;mail.example.net',
  'Arrival-Date: Fri, 2 Oct 2026 10:00:00 +0000',
  '',
  'Original-Recipient: rfc822;Boss@Partner.example',
  'Final-Recipient: rfc822;boss@partner.example',
  'Action: failed',
  'Status: 5.7.64',
  'Diagnostic-Code: smtp;550 5.7.64 TenantAttribution; Relay Access Denied [AM0PR01MB1234.eurprd01.prod.outlook.com]',
  'Last-Attempt-Date: Fri, 2 Oct 2026 10:00:05 +0000',
  '',
  'Final-Recipient: rfc822;slow@partner.example',
  'Action: delayed',
  'Status: 4.4.7',
  'Will-Retry-Until: Sat, 3 Oct 2026 10:00:00 +0000',
  '',
  'Final-Recipient: rfc822;relay@partner.example',
  'Action: relayed',
  'Status: 2.0.0',
  '',
].join('\r\n');

export const NDR_HEADERS = 'From: office@stage.test\r\nTo: boss@partner.example\r\nMessage-ID: <orig-from-headers@stage.test>\r\nSubject: hello\r\n\r\n';
