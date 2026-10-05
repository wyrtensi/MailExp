import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// "Delivery details" of a letter (R-17) on the real schema: the log of the node read through the
// shared reader (mailcow mocked with the stand's lines), the store, the alert job's pass, the
// delivery reports' marks, the list's mark, and who gets what.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
const node = vi.hoisted(() => ({ cfg: null, log: [], calls: 0, eopFails: false }));
vi.mock('../services/mailNode/mailcow.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    getMailNodeConfig: vi.fn(async () => node.cfg),
    getPostfixLog: vi.fn(async () => {
      node.calls += 1;
      if (node.log instanceof Error) throw node.log;
      return node.log;
    }),
  };
});
vi.mock('../services/mailNode/eopSettings.js', async (importActual) => ({
  ...(await importActual()),
  getEopSettings: vi.fn(async () => {
    if (node.eopFails) throw new Error('database gone');
    return { eopHost: 'eop.test.local' };
  }),
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { default: express } = await import('express');
const { default: routes } = await import('./delivery.js');
const { MailNodeError } = await import('../services/mailNode/mailcow.js');
const { clearPostfixLogCache, parsePostfixLog, readPostfixLog } = await import('../services/mailNode/postfixLog.js');
const { STAND_DELIVERY } = await import('../services/mailNode/postfixLog.fixtures.js');
const { captureFromLog, recordOutcomes } = await import('../services/deliveryStatus.js');
const { recordDeliveryReport, deliveryReportOf } = await import('../services/deliveryReport.js');
const { NDR_STATUS, NDR_STRUCTURE } = await import('../services/deliveryReport.fixtures.js');
const { listMessages } = await import('../services/messageService.js');

const CFG = { mailHost: 'mail.test.local', apiKey: 'k' };
const NODE_BOX = '50000000-0000-4000-8000-000000000001';
const OTHER_BOX = '50000000-0000-4000-8000-000000000002';
const ACCEPTED_ROW = '51000000-0000-4000-8000-000000000001';
const DENIED_ROW = '51000000-0000-4000-8000-000000000002';
const OLD_ROW = '51000000-0000-4000-8000-000000000003';
const OTHER_ROW = '51000000-0000-4000-8000-000000000004';
const BOSS_ROW = '51000000-0000-4000-8000-000000000005';
const CLAIMED_ROW = '51000000-0000-4000-8000-000000000006';
const BOSS = '<boss-1@stage.test>';
// The boss's own letter on the same node, with a Bcc, submitted with the boss's login.
const BOSS_LINES = [
  { time: '1790934000', program: 'postfix/qmgr', priority: 'info', message: 'BB11CC22DD3: removed' },
  { time: '1790934000', program: 'postfix/smtp', priority: 'info', message: 'BB11CC22DD3: to=<secret-bcc@example.org>, relay=eop.test.local[172.22.1.7]:25, delay=0.2, delays=0.1/0/0.05/0.05, dsn=2.6.0, status=sent (250 2.6.0 <boss-1@stage.test> [InternalId=1099511627800, Hostname=EOP01] 400 bytes in 0.010, 39.063 KB/sec Queued mail for delivery)' },
  { time: '1790934000', program: 'postfix/qmgr', priority: 'info', message: 'BB11CC22DD3: from=<boss@stage.test>, size=400, nrcpt=1 (queue active)' },
  { time: '1790934000', program: 'postfix/cleanup', priority: 'info', message: 'BB11CC22DD3: message-id=<boss-1@stage.test>' },
  { time: '1790934000', program: 'postfix/submission/smtpd', priority: 'info', message: 'BB11CC22DD3: client=unknown[172.22.1.1], sasl_method=PLAIN, sasl_username=boss@stage.test' },
];
const ACCEPTED = '<r17-accepted-1790933733899@stage.test>';
const DENIED = '<r17-denied-1790933353895@stage.test>';

let db;
let server;
let base;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  const app = express();
  app.use('/api/mail', routes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

beforeEach(async () => {
  await db.exec('DELETE FROM message_delivery_status; DELETE FROM mailbox_audit_log; DELETE FROM account_aliases; DELETE FROM messages; DELETE FROM email_accounts;');
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, imap_host, mail_node, folder_mappings) VALUES
       ($1, 'R17', 'r17-delivery@stage.test', 'mail.test.local', true, '{"sent":"Sent"}'),
       ($2, 'Office', 'office@example.net', 'imap.example.net', false, '{"sent":"Sent"}')`,
    [NODE_BOX, OTHER_BOX],
  );
  await db.query(
    `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, date, from_email) VALUES
       ($1, $5, 1, 'Sent', '${ACCEPTED}', 'R-17 accepted', '2026-10-02T09:35:37Z', 'r17-delivery@stage.test'),
       ($2, $5, 2, 'Sent', '${DENIED}', 'R-17 denied', '2026-10-02T09:29:13Z', 'r17-delivery@stage.test'),
       ($3, $5, 3, 'Sent', '<old@stage.test>', 'old', '2026-09-20T09:00:00Z', 'r17-delivery@stage.test'),
       ($4, $6, 1, 'Sent', '<orig-ndr@example.net>', 'to partner', '2026-10-02T09:59:00Z', 'office@example.net'),
       ($7, $5, 4, 'INBOX', '${BOSS}', 'from the boss', '2026-10-02T09:40:00Z', 'boss@stage.test'),
       ($8, $5, 5, 'Sent', '${BOSS}', 'a copy claimed through an alias', '2026-10-02T09:40:00Z', 'boss@stage.test')`,
    [ACCEPTED_ROW, DENIED_ROW, OLD_ROW, OTHER_ROW, NODE_BOX, OTHER_BOX, BOSS_ROW, CLAIMED_ROW],
  );
  await db.query(
    `INSERT INTO mailbox_audit_log (account_id, account_email, action, details, occurred_at) VALUES
       ($1, 'r17-delivery@stage.test', 'message.sent', '{"messageId": "${ACCEPTED}"}', '2026-10-02T09:35:38Z'),
       ($1, 'r17-delivery@stage.test', 'message.sent', '{"messageId": "${DENIED}"}', '2026-10-02T09:29:18Z')`,
    [NODE_BOX],
  );
  node.cfg = CFG;
  node.log = STAND_DELIVERY;
  node.calls = 0;
  node.eopFails = false;
  clearPostfixLogCache();
});

const details = async (id) => {
  const res = await fetch(`${base}/api/mail/messages/${id}/delivery`);
  return { status: res.status, body: await res.json() };
};

describe('GET /api/mail/messages/:id/delivery', () => {
  it('shows an accepted letter of a node mailbox per recipient: relay, TLS, EOP\'s acceptance', async () => {
    const { status, body } = await details(ACCEPTED_ROW);
    expect(status).toBe(200);
    expect(body).toMatchObject({ messageId: ACCEPTED, node: true, log: { coverage: 'found', error: null, sentAt: '2026-10-02T09:35:38.000Z' } });
    expect(body.recipients.map((r) => [r.recipient, r.state, r.source])).toEqual([
      ['second@example.org', 'sent', 'log'], ['test@example.com', 'sent', 'log'],
    ]);
    expect(body.recipients[1]).toMatchObject({
      statusCode: '2.6.0', explanation: null,
      log: {
        relayHost: 'eop.test.local', relayIp: '172.22.1.7', relayPort: 25, relayKind: 'eop', queueId: '0C3BF1A4B81',
        tls: { level: 'untrusted', protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', matchedBy: 'time' },
        acceptance: { internalId: '1099511627777', hostname: 'EOPSTAGE01MB0001.stageprd01.prod.eop.test.local' },
      },
    });
  });

  it('shows a refused letter with the code explained, and the list marks it', async () => {
    const { body } = await details(DENIED_ROW);
    expect(body.recipients.map((r) => [r.recipient, r.state, r.statusCode, r.explanation?.key])).toEqual([
      ['second@example.org', 'bounced', '5.4.1', 'recipient_not_accepted'],
      ['test@example.com', 'bounced', '5.4.1', 'recipient_not_accepted'],
    ]);
    const { messages } = await listMessages({ accountId: NODE_BOX, folder: 'Sent' });
    expect(Object.fromEntries(messages.map((m) => [m.id, m.delivery_state]))).toEqual({ [ACCEPTED_ROW]: null, [DENIED_ROW]: 'failed', [OLD_ROW]: null, [CLAIMED_ROW]: null });
    const threaded = await listMessages({ accountId: NODE_BOX, folder: 'Sent', threaded: true });
    expect(threaded.messages.find((m) => m.id === DENIED_ROW).delivery_state).toBe('failed');
  });

  it('keeps what it saw once the log no longer covers the letter, and says when it never saw it', async () => {
    await details(DENIED_ROW);
    // The log now holds only the accepted letter: it begins after the refused one was sent.
    node.log = STAND_DELIVERY.slice(0, 7);
    clearPostfixLogCache();
    const stored = await details(DENIED_ROW);
    expect(stored.body.log.coverage).toBe('stored');
    expect(stored.body.recipients.map((r) => r.state)).toEqual(['bounced', 'bounced']);
    const gone = await details(OLD_ROW);
    expect(gone.body).toMatchObject({ node: true, log: { coverage: 'gone', sentAt: '2026-09-20T09:00:00.000Z' }, recipients: [] });
  });

  it('says the log could not be read without inventing anything', async () => {
    node.log = new MailNodeError('mail_node_unreachable', 'The mail node is unreachable');
    const { status, body } = await details(ACCEPTED_ROW);
    expect(status).toBe(200);
    expect(body).toMatchObject({ node: true, log: { coverage: 'unavailable', error: 'mail_node_unreachable' }, recipients: [] });
  });

  it('gives a mailbox off the node only the delivery reports\' marks, and never reads the log for it', async () => {
    // The report came an hour ago: a delay is marked only while its news is younger than
    // DELAY_STALE_MS, so a fixed date would turn "delayed" into "unknown" a few days later.
    const reportedAt = new Date(Date.now() - 3600e3).toISOString();
    await recordDeliveryReport({ accountId: OTHER_BOX, report: deliveryReportOf(NDR_STRUCTURE), statusText: NDR_STATUS, inReplyTo: '<orig-ndr@example.net>', date: reportedAt });
    const { body } = await details(OTHER_ROW);
    expect(node.calls).toBe(0);
    expect(body).toMatchObject({ node: false, log: null });
    expect(body.recipients.map((r) => [r.recipient, r.state, r.source, r.explanation?.key])).toEqual([
      ['boss@partner.example', 'failed', 'dsn', 'tenant_attribution'],
      ['slow@partner.example', 'delayed', 'dsn', 'temporary'],
    ]);
    const { messages } = await listMessages({ accountId: OTHER_BOX, folder: 'Sent' });
    expect(messages[0].delivery_state).toBe('failed');
    // A node mailbox on another host than the node settings name: no log either.
    node.cfg = { ...CFG, mailHost: 'other-node.example' };
    expect((await details(ACCEPTED_ROW)).body).toMatchObject({ node: false, log: null });
  });

  // The mailbox's own outgoing server refused one recipient at RCPT and took the letter for the
  // rest (services/sendDelivery.js records it with source 'submission', migration 0091).
  it('shows a recipient the outgoing server refused at sending as failed, with its reply, and the list marks it', async () => {
    await db.query(
      `INSERT INTO mailbox_audit_log (account_id, account_email, action, details, occurred_at)
       VALUES ($1, 'office@example.net', 'message.sent', '{"messageId": "<orig-ndr@example.net>"}', NOW())`,
      [OTHER_BOX],
    );
    await recordOutcomes(OTHER_BOX, '<orig-ndr@example.net>', 'submission', [{
      recipient: 'Gone@Partner.Example', state: 'failed', at: '2026-10-02T09:59:01.000Z', statusCode: '5.1.1',
      diagnostic: '550 5.1.1 <gone@partner.example>: Recipient address rejected: User unknown',
      details: { reply: '550 5.1.1 <gone@partner.example>: Recipient address rejected: User unknown', responseCode: 550 },
    }]);
    const { body } = await details(OTHER_ROW);
    expect(body).toMatchObject({ owned: true, node: false });
    expect(body.recipients).toHaveLength(1);
    expect(body.recipients[0]).toMatchObject({
      recipient: 'gone@partner.example', state: 'failed', source: 'submission', statusCode: '5.1.1',
      explanation: { key: 'permanent', class: 'permanent', code: '5.1.1' },
      submission: { reply: '550 5.1.1 <gone@partner.example>: Recipient address rejected: User unknown', responseCode: 550 },
      log: null, report: null,
    });
    const { messages } = await listMessages({ accountId: OTHER_BOX, folder: 'Sent' });
    expect(messages[0].delivery_state).toBe('failed');
  });

  it('gives nothing for a letter the mailbox did not send, whatever aliases a user added to it', async () => {
    await db.query("INSERT INTO account_aliases (account_id, email, name) VALUES ($1, 'boss@stage.test', 'Boss')", [NODE_BOX]);
    node.log = [...BOSS_LINES, ...STAND_DELIVERY];
    for (const row of [BOSS_ROW, CLAIMED_ROW]) {
      const { body } = await details(row);
      expect(body).toEqual({ messageId: BOSS, owned: false, node: false, log: null, recipients: [] });
    }
    expect(node.calls).toBe(0);
    // Even a copy that claims the mailbox's own address in Sent never reads the boss's queue entry:
    // the log knows the boss's login submitted it.
    await db.query("UPDATE messages SET from_email = 'r17-delivery@stage.test' WHERE id = $1", [CLAIMED_ROW]);
    const forged = await details(CLAIMED_ROW);
    expect(forged.body).toMatchObject({ owned: true, node: true, log: { coverage: 'not_found' }, recipients: [] });
    expect(JSON.stringify(forged.body)).not.toContain('secret-bcc');
  });

  it('marks nothing from a report about a letter the mailbox received (a spoofed report)', async () => {
    const result = await recordDeliveryReport({ accountId: NODE_BOX, report: deliveryReportOf(NDR_STRUCTURE), statusText: NDR_STATUS, inReplyTo: BOSS, date: '2026-10-02T10:01:00Z' });
    expect(result).toMatchObject({ original: BOSS, changed: 0, ignored: 'not_sent' });
    expect((await db.query('SELECT count(*)::int AS n FROM message_delivery_status')).rows[0].n).toBe(0);
  });

  it('answers the stored outcomes when looking the letter up fails for any reason', async () => {
    await details(DENIED_ROW);
    node.eopFails = true;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, body } = await details(DENIED_ROW);
    errorLog.mockRestore();
    expect(status).toBe(200);
    expect(body).toMatchObject({ node: true, log: { coverage: 'stored', error: 'lookup_failed' } });
    expect(body.recipients).toHaveLength(2);
  });

  it('answers 404 for an unknown letter and 400 for a bad id', async () => {
    expect((await details('51000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    expect((await fetch(`${base}/api/mail/messages/x/delivery`)).status).toBe(400);
  });
});

describe('the alert job\'s pass (captureFromLog)', () => {
  // A letter deferred a few minutes ago (times relative to now: the list's delay mark ages out).
  const T0 = Math.floor(Date.now() / 1000) - 600;
  const deferredLines = (queueId, messageId) => [
    { time: String(T0), program: 'postfix/smtp', priority: 'info', message: `${queueId}: to=<a@example.org>, relay=eop.test.local[172.22.1.7]:25, delay=0.3, delays=0.1/0/0.1/0.1, dsn=4.7.500, status=deferred (host eop.test.local[172.22.1.7] said: 451 4.7.500 Server busy (in reply to RCPT TO command))` },
    { time: String(T0), program: 'postfix/qmgr', priority: 'info', message: `${queueId}: from=<r17-delivery@stage.test>, size=400, nrcpt=1 (queue active)` },
    { time: String(T0), program: 'postfix/cleanup', priority: 'info', message: `${queueId}: message-id=${messageId}` },
    { time: String(T0), program: 'postfix/submission/smtpd', priority: 'info', message: `${queueId}: client=unknown[172.22.1.1], sasl_method=PLAIN, sasl_username=r17-delivery@stage.test` },
  ];
  const journal = async (messageId, uid) => {
    await db.query("INSERT INTO messages (account_id, uid, folder, message_id, subject, date, from_email) VALUES ($1, $2, 'Sent', $3, 'deferred', NOW(), 'r17-delivery@stage.test')", [NODE_BOX, uid, messageId]);
    await db.query("INSERT INTO mailbox_audit_log (account_id, account_email, action, details, occurred_at) VALUES ($1, 'r17-delivery@stage.test', 'message.sent', $2, $3)",
      [NODE_BOX, { messageId, to: ['a@example.org'], cc: [], bcc: [] }, new Date((T0 - 5) * 1000)]);
  };
  const mark = async (messageId) => (await listMessages({ accountId: NODE_BOX, folder: 'Sent' })).messages.find((m) => m.message_id === messageId).delivery_state;
  const run = (entries, queueIds) => captureFromLog({ cfg: CFG, log: { lines: parsePostfixLog(entries).lines }, eopHost: 'eop.test.local', now: Date.now(), queueIds });

  it('follows a deferred letter by its queue id once the cleanup line left the log', async () => {
    await journal('<defer-1@stage.test>', 10);
    await run(deferredLines('DE11AA22BB3', '<defer-1@stage.test>'), new Set(['DE11AA22BB3']));
    expect(await mark('<defer-1@stage.test>')).toBe('delayed');
    // A later read holds only the later attempt: no cleanup or submission line any more.
    const later = [
      { time: String(T0 + 300), program: 'postfix/smtp', priority: 'info', message: 'DE11AA22BB3: to=<a@example.org>, relay=eop.test.local[172.22.1.7]:25, delay=300, delays=300/0/0.1/0.1, dsn=2.6.0, status=sent (250 2.6.0 ok)' },
      { time: String(T0 + 300), program: 'postfix/qmgr', priority: 'info', message: 'DE11AA22BB3: from=<r17-delivery@stage.test>, size=400, nrcpt=1 (queue active)' },
    ];
    expect(await run(later, new Set())).toMatchObject({ changed: 1 });
    expect(await mark('<defer-1@stage.test>')).toBeNull();
    expect((await db.query("SELECT state FROM message_delivery_status WHERE message_id = '<defer-1@stage.test>'")).rows[0].state).toBe('sent');
  });

  it('reads a deferred letter that left the queue without a final line as unknown, and ages the delay mark out', async () => {
    await journal('<defer-2@stage.test>', 11);
    await run(deferredLines('DE22AA33BB4', '<defer-2@stage.test>'), new Set(['DE22AA33BB4']));
    // Still queued: stays deferred. Gone from the queue with nothing in the log: unknown, no mark.
    await run(STAND_DELIVERY, new Set(['DE22AA33BB4']));
    expect(await mark('<defer-2@stage.test>')).toBe('delayed');
    await run(STAND_DELIVERY, new Set());
    expect(await mark('<defer-2@stage.test>')).toBeNull();
    const { rows: [letter] } = await db.query("SELECT id FROM messages WHERE message_id = '<defer-2@stage.test>'");
    const { body } = await details(letter.id);
    expect(body.recipients[0]).toMatchObject({ recipient: 'a@example.org', state: 'unknown', log: { leftQueue: true } });
    // A delay with no news for longer than the queue lifetime is no longer marked.
    await journal('<defer-3@stage.test>', 12);
    await run(deferredLines('DE33AA44BB5', '<defer-3@stage.test>'), null);
    await db.query("UPDATE message_delivery_status SET event_at = NOW() - interval '7 days' WHERE message_id = '<defer-3@stage.test>'");
    expect(await mark('<defer-3@stage.test>')).toBeNull();
  });

  it('records the journaled letters of node mailboxes found in the log, once', async () => {
    const log = await readPostfixLog(CFG);
    expect(await captureFromLog({ cfg: CFG, log, eopHost: 'eop.test.local', now: Date.parse('2026-10-02T10:00:00Z') })).toEqual({ letters: 2, changed: 4 });
    // The next run over the same lines writes nothing.
    expect(await captureFromLog({ cfg: CFG, log, eopHost: 'eop.test.local', now: Date.parse('2026-10-02T10:05:00Z') })).toEqual({ letters: 2, changed: 0 });
    // Past the window the journal no longer names them.
    expect(await captureFromLog({ cfg: CFG, log, eopHost: 'eop.test.local', now: Date.parse('2026-10-10T10:00:00Z') })).toEqual({ letters: 0, changed: 0 });
  });

  it('lets a later report of Microsoft win over the log\'s sent and keeps the log\'s details', async () => {
    const log = await readPostfixLog(CFG);
    await captureFromLog({ cfg: CFG, log, eopHost: 'eop.test.local', now: Date.parse('2026-10-02T10:00:00Z') });
    const report = { ...deliveryReportOf(NDR_STRUCTURE) };
    const status = 'Reporting-MTA: dns;AM0PR01MB1234.eurprd01.prod.outlook.com\r\n\r\nFinal-Recipient: rfc822;test@example.com\r\nAction: failed\r\nStatus: 5.4.1\r\nDiagnostic-Code: smtp;550 5.4.1 Recipient address rejected: Access denied. AS(201806281)\r\n';
    await recordDeliveryReport({ accountId: NODE_BOX, report, statusText: status, inReplyTo: ACCEPTED, date: '2026-10-02T09:40:00Z' });
    await captureFromLog({ cfg: CFG, log, eopHost: 'eop.test.local', now: Date.parse('2026-10-02T10:05:00Z') });
    const { body } = await details(ACCEPTED_ROW);
    const row = body.recipients.find((r) => r.recipient === 'test@example.com');
    expect(row).toMatchObject({ state: 'failed', source: 'dsn', statusCode: '5.4.1', log: { state: 'sent', acceptance: { internalId: '1099511627777' } }, report: { state: 'failed' } });
    expect(body.recipients.find((r) => r.recipient === 'second@example.org').state).toBe('sent');
  });
});
