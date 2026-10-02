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
const node = vi.hoisted(() => ({ cfg: null, log: [], calls: 0 }));
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
  getEopSettings: vi.fn(async () => ({ eopHost: 'eop.test.local' })),
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { default: express } = await import('express');
const { default: routes } = await import('./delivery.js');
const { MailNodeError } = await import('../services/mailNode/mailcow.js');
const { clearPostfixLogCache, readPostfixLog } = await import('../services/mailNode/postfixLog.js');
const { STAND_DELIVERY } = await import('../services/mailNode/postfixLog.fixtures.js');
const { captureFromLog } = await import('../services/deliveryStatus.js');
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
  await db.exec('DELETE FROM message_delivery_status; DELETE FROM mailbox_audit_log; DELETE FROM messages; DELETE FROM email_accounts;');
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, imap_host, mail_node) VALUES
       ($1, 'R17', 'r17-delivery@stage.test', 'mail.test.local', true),
       ($2, 'Office', 'office@example.net', 'imap.example.net', false)`,
    [NODE_BOX, OTHER_BOX],
  );
  await db.query(
    `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, date) VALUES
       ($1, $5, 1, 'Sent', '${ACCEPTED}', 'R-17 accepted', '2026-10-02T09:35:37Z'),
       ($2, $5, 2, 'Sent', '${DENIED}', 'R-17 denied', '2026-10-02T09:29:13Z'),
       ($3, $5, 3, 'Sent', '<old@stage.test>', 'old', '2026-09-20T09:00:00Z'),
       ($4, $6, 1, 'Sent', '<orig-ndr@example.net>', 'to partner', '2026-10-02T09:59:00Z')`,
    [ACCEPTED_ROW, DENIED_ROW, OLD_ROW, OTHER_ROW, NODE_BOX, OTHER_BOX],
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
    expect(Object.fromEntries(messages.map((m) => [m.id, m.delivery_state]))).toEqual({ [ACCEPTED_ROW]: null, [DENIED_ROW]: 'failed', [OLD_ROW]: null });
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
    await recordDeliveryReport({ accountId: OTHER_BOX, report: deliveryReportOf(NDR_STRUCTURE), statusText: NDR_STATUS, inReplyTo: '<orig-ndr@example.net>', date: '2026-10-02T10:01:00Z' });
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

  it('answers 404 for an unknown letter and 400 for a bad id', async () => {
    expect((await details('51000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    expect((await fetch(`${base}/api/mail/messages/x/delivery`)).status).toBe(400);
  });
});

describe('the alert job\'s pass (captureFromLog)', () => {
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
