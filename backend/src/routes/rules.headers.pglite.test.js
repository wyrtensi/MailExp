import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: null }; next();
} }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn() }));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { applyInboxRules } = await import('../services/inboxRules.js');
const { parseHeadersInput } = await import('../services/messageParser.js');
const { default: router } = await import('./rules.js');
const ACCOUNT = '60000000-0000-4000-8000-000000000001';
const MESSAGE = '70000000-0000-4000-8000-000000000001';
const HEADERS = 'From: sender@example.com\r\nList-Id:\r\n <newsletter.example.com>\r\n';
const imap = { fetchHeaders: vi.fn(), setFlag: vi.fn(async () => {}), broadcast: vi.fn() };
let db, server, base;

beforeAll(async () => {
  db = await createRealSchemaDb(); dbState.db = db;
  const app = express(); app.use(express.json()); app.set('imapManager', imap);
  app.use('/api/rules', router);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);
afterAll(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
beforeEach(async () => {
  vi.clearAllMocks(); imap.fetchHeaders.mockReset(); imap.fetchHeaders.mockResolvedValue(HEADERS);
  await db.exec('DELETE FROM inbox_rules; DELETE FROM email_accounts;');
  await db.query(`INSERT INTO email_accounts (id, name, email_address, imap_host)
    VALUES ($1, 'Inbox', 'team@example.com', 'mail.example.com')`, [ACCOUNT]);
  await db.query(`INSERT INTO messages (id, account_id, uid, folder, subject)
    VALUES ($1, $2, 12, 'INBOX', 'Newsletter')`, [MESSAGE, ACCOUNT]);
});
async function addRule(condition, action = 'star') {
  await db.query(`INSERT INTO inbox_rules (account_id, conditions, actions)
    VALUES ($1, $2, $3)`, [ACCOUNT, JSON.stringify([condition]), JSON.stringify([{ type: action }])]);
}
const state = async () => (await db.query('SELECT is_starred, is_read FROM messages WHERE id = $1', [MESSAGE])).rows[0];
async function sweep() {
  const response = await fetch(`${base}/api/rules/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: ACCOUNT }),
  });
  expect(response.status).toBe(202);
  await vi.waitFor(() => expect(imap.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'rules_run_complete', ok: true }), null));
}

describe('manual header rules against real schema and evaluator', () => {
  it.each([['contains', true], ['not_contains', false]])('matches arrival behavior for List-Id %s', async (operator, expected) => {
    await addRule({ field: 'header', headerName: 'List-Id', operator, value: 'example.com' });
    const account = (await db.query('SELECT * FROM email_accounts WHERE id = $1', [ACCOUNT])).rows[0];
    await applyInboxRules([{ id: MESSAGE, uid: 12, folder: 'INBOX', parsedHeaders: parseHeadersInput(HEADERS) }], account, imap);
    expect((await state()).is_starred).toBe(expected);
    expect(imap.fetchHeaders).not.toHaveBeenCalled();
    await db.query('UPDATE messages SET is_starred = false WHERE id = $1', [MESSAGE]);
    await sweep();
    expect((await state()).is_starred).toBe(expected);
  });
  it.each(['reject', 'empty'])('skips negative header actions when header fetch is %s but runs ordinary rules', async failure => {
    await addRule({ field: 'header', headerName: 'List-Id', operator: 'not_contains', value: 'example.com' });
    await addRule({ field: 'subject', operator: 'contains', value: 'Newsletter' }, 'mark_read');
    if (failure === 'reject') imap.fetchHeaders.mockRejectedValue(new Error('Synthetic unavailable headers'));
    else imap.fetchHeaders.mockResolvedValue('');
    await sweep();
    expect(await state()).toMatchObject({ is_starred: false, is_read: true });
  });
  it('runs ordinary rules without fetching headers', async () => {
    await addRule({ field: 'subject', operator: 'contains', value: 'Newsletter' });
    await sweep();
    expect((await state()).is_starred).toBe(true);
    expect(imap.fetchHeaders).not.toHaveBeenCalled();
  });
  it('still matches a negative condition for a genuinely absent header', async () => {
    await addRule({ field: 'header', headerName: 'List-Id', operator: 'not_contains', value: 'example.com' });
    imap.fetchHeaders.mockResolvedValue('From: sender@example.com\r\nSubject: Newsletter\r\n');
    await sweep();
    expect((await state()).is_starred).toBe(true);
  });
});
