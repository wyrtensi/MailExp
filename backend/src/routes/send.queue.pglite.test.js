// Undo send and send later end to end against a real (in-process) Postgres engine and the real
// migrations: POST /send enqueues the letter, the undo cancels it while it waits, the worker sends
// it once the window or the scheduled time has passed (the journal's message.sent with the real
// Message-ID), a worker that dies mid-delivery leaves it for its author, and a failure keeps it.
// The mail server is a mock transport; PGlite is one connection, so a race is its two orders.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../services/testing/realSchema.js';

const dbState = { db: null };
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.get('x-test-user') }; next(); },
}));
const imapManager = vi.hoisted(() => ({
  broadcast: () => {},
  syncFolderOnDemand: async () => {},
  findUidByMessageId: async () => null,
}));
vi.mock('../index.js', () => ({ imapManager }));
vi.mock('../services/mailSendTransport.js', () => ({ createAccountSendTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => null) }));

const express = (await import('express')).default;
const sendRoutes = (await import('./send.js')).default;
const scheduledRoutes = (await import('./scheduled.js')).default;
const { createAccountSendTransport } = await import('../services/mailSendTransport.js');
const { registerSendJobKind, SEND_JOB_KIND } = await import('../services/sendQueue.js');
const {
  claimDueJobs, failJobsOfDeletedAccount, runJob, runDueJobs, sweepExpiredLeases, unregisterJobKind,
  _setSettleRetryDelaysForTests,
} = await import('../services/jobQueue.js');

const ACCOUNT = '40000000-0000-4000-8000-000000000001';
const ANNA = '42000000-0000-4000-8000-000000000001';
const BOB = '42000000-0000-4000-8000-000000000002';
const ADMIN = '42000000-0000-4000-8000-000000000003';
let db;
let server;
let base;
const sendMail = vi.fn();

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  const app = express();
  app.use(express.json({ limit: '35mb' }));
  app.use('/api/mail', sendRoutes);
  app.use('/api/mail', scheduledRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  imapManager.broadcast = vi.fn();
  registerSendJobKind({ imapManager });
  await db.exec('DELETE FROM outgoing_messages; DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM contacts; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query("INSERT INTO users (id, username, email) VALUES ($1, 'anna', 'anna@example.com'), ($2, 'bob', 'bob@example.com')", [ANNA, BOB]);
  await db.query("INSERT INTO users (id, username, email, is_admin) VALUES ($1, 'root', 'root@example.com', true)", [ADMIN]);
  await db.query("INSERT INTO email_accounts (id, name, email_address) VALUES ($1, 'Office', 'office@example.com')", [ACCOUNT]);
  const account = (await db.query('SELECT * FROM email_accounts WHERE id = $1', [ACCOUNT])).rows[0];
  createAccountSendTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockReset();
  sendMail.mockResolvedValue({});
});

const call = (method, path, { user = ANNA, body, key } = {}) => fetch(`${base}/api/mail${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', 'x-test-user': user, ...(key ? { 'X-Idempotency-Key': key } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const LETTER = {
  accountId: ACCOUNT, to: ['you@example.com'], bcc: ['hidden@example.com'], subject: 'Quarterly numbers',
  body: '<p>Confidential body text</p>', bodyIsHtml: true,
  attachments: [{ filename: 'notes.txt', content: Buffer.from('hello notes').toString('base64'), contentType: 'text/plain' }],
  context: { isReply: false, threadId: null },
};
const send = async (extra = {}, opts = {}) => {
  const res = await call('POST', '/send', { body: { ...LETTER, ...extra }, key: opts.key ?? `k-${Math.random()}`, user: opts.user });
  return { status: res.status, body: await res.json() };
};
const job = async (id) => (await db.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
const content = async (id) => (await db.query('SELECT job_id FROM outgoing_messages WHERE job_id = $1', [id])).rows[0];
const makeDue = (id) => db.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1", [id]);
const audit = async (action) => (await db.query('SELECT * FROM mailbox_audit_log WHERE action = $1 ORDER BY id', [action])).rows;

describe('Send with the undo window', () => {
  it('enqueues the letter due five seconds later and sends nothing yet', async () => {
    const { status, body } = await send();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'queued', scheduled: false });
    const secs = (Date.parse(body.sendAt) - Date.now()) / 1000;
    expect(secs).toBeGreaterThan(3);
    expect(secs).toBeLessThanOrEqual(5.5);
    expect(await job(body.jobId)).toMatchObject({ kind: SEND_JOB_KIND, status: 'queued', created_by: ANNA, account_id: ACCOUNT });
    expect(await content(body.jobId)).toBeTruthy();
    await runDueJobs({ wait: true });
    expect(sendMail).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await audit('message.send_queued')).toHaveLength(1));
    const [entry] = await audit('message.send_queued');
    expect(entry.details).toMatchObject({ jobId: body.jobId, scheduled: false });
    expect(JSON.stringify(entry.details)).not.toMatch(/Quarterly|Confidential/);
  });

  it('enqueues once for a double click with the same idempotency key', async () => {
    const first = await send({}, { key: 'same' });
    const second = await send({}, { key: 'same' });
    expect(second.body.jobId).toBe(first.body.jobId);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(1);
  });

  it('undo cancels the letter and gives back what was composed, attachments included', async () => {
    const { body } = await send();
    const res = await call('POST', `/scheduled/${body.jobId}/cancel`, { body: { reason: 'undo' } });
    expect(res.status).toBe(200);
    const { compose } = await res.json();
    expect(compose).toMatchObject({
      accountId: ACCOUNT, to: ['you@example.com'], bcc: ['hidden@example.com'], subject: 'Quarterly numbers',
      body: '<p>Confidential body text</p>', bodyIsHtml: true, context: { isReply: false, threadId: null },
    });
    expect(compose.attachments).toEqual([{ filename: 'notes.txt', contentType: 'text/plain', size: 11, content: Buffer.from('hello notes').toString('base64') }]);
    expect(await job(body.jobId)).toMatchObject({ status: 'cancelled' });
    expect(await content(body.jobId)).toBeUndefined();
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await audit('message.send_cancelled')).toHaveLength(1));
  });

  it('refuses the undo once a worker has started sending', async () => {
    const { body } = await send();
    await makeDue(body.jobId);
    await claimDueJobs(10);
    const res = await call('POST', `/scheduled/${body.jobId}/cancel`, { body: { reason: 'undo' } });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('send_started');
  });

  it('sends once the window has passed: the real Message-ID journaled, the letter content gone, the author told', async () => {
    let ours;
    sendMail.mockImplementation(async (options) => {
      ours = options.messageId;
      return { via: 'api', messageId: ours.replace('@', '.real@') };
    });
    const { body } = await send();
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).toHaveBeenCalledOnce();
    const [options] = sendMail.mock.calls[0];
    expect(options).toMatchObject({ subject: 'Quarterly numbers', to: 'you@example.com', bcc: 'hidden@example.com' });
    expect(options.attachments.map(a => a.filename)).toContain('notes.txt');
    expect(Buffer.isBuffer(options.attachments.find(a => a.filename === 'notes.txt').content)).toBe(true);
    expect(await job(body.jobId)).toMatchObject({ status: 'done' });
    expect(await content(body.jobId)).toBeUndefined();
    await vi.waitFor(async () => expect(await audit('message.sent')).toHaveLength(1));
    const [sent] = await audit('message.sent');
    expect(sent.actor_user_id).toBe(ANNA);
    expect(ours).toMatch(/^<[0-9a-f]{32}@example\.com>$/);
    expect(sent.details).toEqual({ messageId: ours.replace('@', '.real@'), to: ['you@example.com'], cc: [], bcc: ['hidden@example.com'] });
    await vi.waitFor(() => expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'send_done', jobId: body.jobId }), ANNA));
    // A second run sends nothing more.
    await runDueJobs({ wait: true });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  // The server took the letter but refused one recipient at RCPT (upstream maathimself/mailflow#518).
  // The composer closed long ago: the job's result, the author's notice and the delivery status say so.
  it('a recipient the server refused is kept with the job, told to the author and marked failed', async () => {
    sendMail.mockResolvedValue({
      accepted: ['you@example.com'], rejected: ['gone@example.com'],
      rejectedErrors: [Object.assign(new Error('Recipient command failed'), {
        recipient: 'gone@example.com', responseCode: 550, response: '550 5.1.1 <gone@example.com>: User unknown',
      })],
    });
    const { body } = await send({ to: ['you@example.com', 'gone@example.com'] });
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(await job(body.jobId)).toMatchObject({ status: 'done', payload: expect.objectContaining({ rejected: ['gone@example.com'] }) });
    await vi.waitFor(() => expect(imapManager.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_done', jobId: body.jobId, rejected: ['gone@example.com'] }), ANNA));
    // The author sees them on the letter; someone else, who may not see its Bcc, does not.
    expect((await (await call('GET', `/scheduled/${body.jobId}`)).json()).letter.rejected).toEqual(['gone@example.com']);
    expect((await (await call('GET', `/scheduled/${body.jobId}`, { user: BOB })).json()).letter.rejected).toBeUndefined();
    const [sent] = await audit('message.sent');
    const { rows } = await db.query('SELECT recipient, state, source, status_code, diagnostic, submission FROM message_delivery_status WHERE account_id = $1', [ACCOUNT]);
    expect(rows).toEqual([{
      recipient: 'gone@example.com', state: 'failed', source: 'submission', status_code: '5.1.1',
      diagnostic: '550 5.1.1 <gone@example.com>: User unknown',
      submission: expect.objectContaining({ reply: '550 5.1.1 <gone@example.com>: User unknown', responseCode: 550 }),
    }]);
    expect(sent.details.messageId).toBeTruthy();
  });

  it('a letter every recipient took reports no refusals', async () => {
    const { body } = await send();
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect((await job(body.jobId)).payload).not.toHaveProperty('rejected');
    await vi.waitFor(() => expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'send_done', jobId: body.jobId }), ANNA));
    const done = imapManager.broadcast.mock.calls.find(([data]) => data.type === 'send_done')[0];
    expect(done).not.toHaveProperty('rejected');
    expect((await db.query('SELECT 1 FROM message_delivery_status')).rows).toEqual([]);
  });

  it('still sends a letter queued before a restart', async () => {
    const { body } = await send();
    unregisterJobKind(SEND_JOB_KIND);
    registerSendJobKind({ imapManager });
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).toHaveBeenCalledOnce();
    expect((await job(body.jobId)).status).toBe('done');
  });

  it('refuses a letter it cannot build before anything is queued', async () => {
    const { status } = await send({ to: [], cc: [], bcc: [] });
    expect(status).toBe(400);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });
});

describe('Send later', () => {
  it('keeps the letter until the chosen time, lists it, and moves it to another time', async () => {
    const at = new Date(Date.now() + 3 * 3600 * 1000);
    const { body } = await send({ sendAt: at.toISOString() });
    expect(body).toMatchObject({ scheduled: true, sendAt: at.toISOString() });
    await runDueJobs({ wait: true });
    expect(sendMail).not.toHaveBeenCalled();

    const mine = await (await call('GET', `/scheduled?accountId=${ACCOUNT}`)).json();
    expect(mine.letters).toEqual([expect.objectContaining({
      id: body.jobId, status: 'queued', scheduled: true, subject: 'Quarterly numbers', to: ['you@example.com'],
      bcc: ['hidden@example.com'], canManage: true, attachmentCount: 1, author: { id: ANNA, email: 'anna@example.com' },
    })]);
    // Another user of the shared mailbox sees it waiting, without its Bcc, and cannot change it.
    const theirs = await (await call('GET', '/scheduled', { user: BOB })).json();
    expect(theirs.letters[0]).toMatchObject({ id: body.jobId, canManage: false });
    expect(theirs.letters[0].bcc).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toMatch(/Confidential/);
    const refused = await call('PATCH', `/scheduled/${body.jobId}`, { user: BOB, body: { sendAt: new Date(Date.now() + 7200e3).toISOString() } });
    expect(refused.status).toBe(403);

    const later = new Date(Date.now() + 26 * 3600 * 1000);
    const moved = await call('PATCH', `/scheduled/${body.jobId}`, { body: { sendAt: later.toISOString() } });
    expect(moved.status).toBe(200);
    expect((await moved.json()).letter.sendAt).toBe(later.toISOString());
    await vi.waitFor(async () => expect(await audit('message.send_rescheduled')).toHaveLength(1));

    // An administrator can cancel it too.
    const cancelled = await call('POST', `/scheduled/${body.jobId}/cancel`, { user: ADMIN, body: {} });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true });
  });

  it('refuses a time that has passed', async () => {
    const { status, body } = await send({ sendAt: new Date(Date.now() - 60000).toISOString() });
    expect(status).toBe(400);
    expect(body.code).toBe('send_at_past');
    const { body: queued } = await send({ sendAt: new Date(Date.now() + 3600e3).toISOString() });
    const res = await call('PATCH', `/scheduled/${queued.jobId}`, { body: { sendAt: new Date(Date.now() - 1000).toISOString() } });
    expect(res.status).toBe(400);
  });

  it('answers a retry whose time passed meanwhile with the letter it enqueued, not send_at_past', async () => {
    const at = new Date(Date.now() + 3600e3);
    const first = await send({ sendAt: at.toISOString() }, { key: 'k-late' });
    expect(first.status).toBe(200);
    // The letter was asked for a minute ago, at a time that has come since; the client's retry of
    // that request arrives only now.
    const past = new Date(Date.now() - 60e3);
    await db.query(
      `UPDATE jobs SET run_at = $2, payload = payload || jsonb_build_object('requestedAt', $3::text) WHERE id = $1`,
      [first.body.jobId, past, past.toISOString()],
    );
    const retried = await send({ sendAt: past.toISOString() }, { key: 'k-late' });
    expect(retried).toMatchObject({ status: 200, body: { jobId: first.body.jobId, scheduled: true } });
    // A retry backoff moved the job: the retry is still compared with the time asked for.
    await db.query("UPDATE jobs SET run_at = now() + interval '10 minutes' WHERE id = $1", [first.body.jobId]);
    expect((await send({ sendAt: past.toISOString() }, { key: 'k-late' })).body.jobId).toBe(first.body.jobId);
    // The same key with another time is still a conflict, and without a known key a past time is refused.
    const other = await send({ sendAt: new Date(past.getTime() - 60e3).toISOString() }, { key: 'k-late' });
    expect(other).toMatchObject({ status: 409, body: { code: 'idempotency_conflict' } });
    expect((await send({ sendAt: past.toISOString() }, { key: 'k-new' })).body.code).toBe('send_at_past');
  });
});

describe('Failures after the writer left', () => {
  it('a worker that dies mid-delivery leaves the letter needs_attention: never resent, the author told', async () => {
    sendMail.mockImplementation(() => new Promise(() => {})); // the server never answers
    const { body } = await send();
    await makeDue(body.jobId);
    const [claimed] = await claimDueJobs(10);
    runJob(claimed); // the worker that will "die"
    await vi.waitFor(async () => expect((await job(body.jobId)).effect_started_at).not.toBeNull());
    await db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [body.jobId]);
    await sweepExpiredLeases();
    expect(await job(body.jobId)).toMatchObject({ status: 'needs_attention', error_code: 'lease_expired' });
    expect(await content(body.jobId)).toBeTruthy(); // kept, so the author can decide
    await vi.waitFor(() => expect(imapManager.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_failed', jobId: body.jobId, status: 'needs_attention' }), ANNA));
    await runDueJobs({ wait: true });
    expect(sendMail).toHaveBeenCalledOnce();

    // Sending it again needs an explicit resend.
    const plain = await call('PATCH', `/scheduled/${body.jobId}`, { body: { sendAt: new Date(Date.now() + 3600e3).toISOString() } });
    expect(plain.status).toBe(409);
    expect((await plain.json()).code).toBe('resend_required');
    const resend = await call('PATCH', `/scheduled/${body.jobId}`, { body: { resend: true } });
    expect(resend.status).toBe(200);
    expect((await job(body.jobId)).status).toBe('queued');
  });

  it('a rejected letter fails, stays listed with its error, and can be reopened to edit', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('Message failed: 550 rejected'), { code: 'EMESSAGE', responseCode: 550, command: 'DATA' }));
    const { body } = await send();
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(await job(body.jobId)).toMatchObject({ status: 'failed', error_code: 'smtp_rejected' });
    const { letters } = await (await call('GET', '/scheduled')).json();
    expect(letters[0]).toMatchObject({ id: body.jobId, status: 'failed', errorCode: 'smtp_rejected', error: 'Message was rejected by the mail server.' });
    await vi.waitFor(async () => expect(await audit('message.send_failed')).toHaveLength(1));
    const edit = await call('POST', `/scheduled/${body.jobId}/cancel`, { body: { reason: 'edit' } });
    expect((await edit.json()).compose).toMatchObject({ subject: 'Quarterly numbers' });
  });

  it('retries a temporary failure later instead of failing', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('451 try later'), { responseCode: 451, command: 'RCPT TO' }));
    const { body } = await send();
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    const row = await job(body.jobId);
    expect(row).toMatchObject({ status: 'queued', attempts: 1, error_code: 'smtp_temporary', effect_started_at: null });
    expect(new Date(row.run_at).getTime()).toBeGreaterThan(Date.now() + 30000);
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect((await job(body.jobId)).status).toBe('done');
  });

  it('does not send for an author who was disabled meanwhile', async () => {
    const { body } = await send();
    await db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [ANNA]);
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).not.toHaveBeenCalled();
    expect(await job(body.jobId)).toMatchObject({ status: 'failed', error_code: 'author_disabled' });
  });

  // D-16: a letter queued from an alias with another address before its mailbox counted as a mail
  // node one (or before this check existed) is refused by the job, not by the node's SMTP.
  it('fails a queued letter whose From is not the address of its node mailbox, before SMTP', async () => {
    const { rows: [alias] } = await db.query(
      "INSERT INTO account_aliases (account_id, name, email) VALUES ($1, 'Orders desk', 'orders@example.com') RETURNING id",
      [ACCOUNT],
    );
    const { body } = await send({ aliasId: alias.id });
    await db.query('UPDATE email_accounts SET mail_node = true WHERE id = $1', [ACCOUNT]);
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).not.toHaveBeenCalled();
    expect(await job(body.jobId)).toMatchObject({ status: 'failed', error_code: 'node_alias_stale' });
  });

  it('sends a queued letter of a node mailbox under its own address', async () => {
    await db.query('UPDATE email_accounts SET mail_node = true WHERE id = $1', [ACCOUNT]);
    const { body } = await send();
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect((await job(body.jobId)).status).toBe('done');
  });

  it('fails a queued letter of a mailbox disabled meanwhile, before SMTP', async () => {
    const { body } = await send();
    await db.query('UPDATE email_accounts SET enabled = false WHERE id = $1', [ACCOUNT]);
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).not.toHaveBeenCalled();
    expect(await job(body.jobId)).toMatchObject({ status: 'failed', error_code: 'mailbox_disabled' });
  });

  it('fails a queued letter of a node mailbox deactivated meanwhile, before SMTP', async () => {
    await db.query('UPDATE email_accounts SET mail_node = true WHERE id = $1', [ACCOUNT]);
    const { body } = await send();
    await db.query('UPDATE email_accounts SET deactivated_at = NOW() WHERE id = $1', [ACCOUNT]);
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).not.toHaveBeenCalled();
    expect(await job(body.jobId)).toMatchObject({ status: 'failed', error_code: 'mailbox_read_only' });
  });
});

describe('Review round', () => {
  it('answers how long until the letter is due by the database clock', async () => {
    const { body } = await send();
    expect(body.dueInMs).toBeGreaterThan(3000);
    expect(body.dueInMs).toBeLessThanOrEqual(5000);
  });

  it('refuses a repeated key for a cancelled letter or another time', async () => {
    const at = new Date(Date.now() + 3600e3).toISOString();
    const first = await send({ sendAt: at }, { key: 'k1' });
    expect((await send({ sendAt: at }, { key: 'k1' })).body.jobId).toBe(first.body.jobId);
    const other = await send({ sendAt: new Date(Date.now() + 7200e3).toISOString() }, { key: 'k1' });
    expect(other).toMatchObject({ status: 409, body: { code: 'idempotency_conflict' } });
    expect((await send({}, { key: 'k1' })).body.code).toBe('idempotency_conflict');
    await call('POST', `/scheduled/${first.body.jobId}/cancel`, { body: {} });
    expect((await send({ sendAt: at }, { key: 'k1' })).body.code).toBe('send_cancelled');
  });

  it('refuses a send time without a time zone', async () => {
    const local = new Date(Date.now() + 3600e3).toISOString().replace('Z', '');
    expect((await send({ sendAt: local })).body.code).toBe('send_at_invalid');
  });

  it('gives an edited scheduled letter back with its time, and keeps context to the known keys', async () => {
    const at = new Date(Date.now() + 3 * 3600e3);
    const { body } = await send({ sendAt: at.toISOString(), context: { isReply: true, draftUid: 7, draftFolder: 'Drafts' } });
    const res = await call('POST', `/scheduled/${body.jobId}/cancel`, { body: { reason: 'edit' } });
    const answer = await res.json();
    expect(answer).toMatchObject({ sendAt: at.toISOString(), scheduled: true });
    expect(answer.compose.context).toEqual({ isReply: true });
  });

  it('marks a letter moved out of its undo window as scheduled', async () => {
    const { body } = await send();
    await call('PATCH', `/scheduled/${body.jobId}`, { body: { sendAt: new Date(Date.now() + 86400e3).toISOString() } });
    const { letter } = await (await call('GET', `/scheduled/${body.jobId}`)).json();
    expect(letter.scheduled).toBe(true);
  });

  it('a delivered letter whose lease was swept meanwhile ends done, never left to be resent', async () => {
    const { body } = await send();
    sendMail.mockImplementation(async () => {
      // The worker stalls past its lease while the server takes the letter.
      await db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [body.jobId]);
      await sweepExpiredLeases();
      return {};
    });
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(await job(body.jobId)).toMatchObject({ status: 'done', error_code: null });
    expect(await content(body.jobId)).toBeUndefined();
    await vi.waitFor(() => expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'send_done', jobId: body.jobId }), ANNA));
    const resend = await call('PATCH', `/scheduled/${body.jobId}`, { body: { resend: true } });
    expect(resend.status).toBe(409);
  });

  it('a delivered letter that cannot be recorded done is marked delivered_unrecorded, never resent', async () => {
    const { body } = await send();
    await makeDue(body.jobId);
    // The database refuses to record the job done (twice: once after delivery, once more).
    await db.exec(`
      CREATE FUNCTION refuse_done() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'connection lost'; END $$;
      CREATE TRIGGER refuse_done BEFORE UPDATE ON jobs FOR EACH ROW WHEN (NEW.status = 'done') EXECUTE FUNCTION refuse_done();`);
    try {
      await runDueJobs({ wait: true });
    } finally {
      await db.exec('DROP TRIGGER refuse_done ON jobs; DROP FUNCTION refuse_done();');
    }
    expect(sendMail).toHaveBeenCalledOnce();
    expect(await job(body.jobId)).toMatchObject({ status: 'needs_attention', error_code: 'delivered_unrecorded' });
    await vi.waitFor(() => expect(imapManager.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_failed', jobId: body.jobId, status: 'needs_attention', code: 'delivered_unrecorded' }), ANNA));
    const { letters } = await (await call('GET', '/scheduled')).json();
    expect(letters[0]).toMatchObject({ id: body.jobId, errorCode: 'delivered_unrecorded' });
    // Neither a resend nor a new time sends it again.
    const resend = await call('PATCH', `/scheduled/${body.jobId}`, { body: { resend: true } });
    expect(resend.status).toBe(409);
    expect((await resend.json()).code).toBe('already_delivered');
    const moved = await call('PATCH', `/scheduled/${body.jobId}`, { body: { sendAt: new Date(Date.now() + 3600e3).toISOString() } });
    expect(moved.status).toBe(409);
    await runDueJobs({ wait: true });
    expect(sendMail).toHaveBeenCalledOnce();
    // Deleting its mailbox leaves it as it is: still never sent again.
    await failJobsOfDeletedAccount(ACCOUNT);
    expect(await job(body.jobId)).toMatchObject({ status: 'needs_attention', error_code: 'delivered_unrecorded' });
    expect((await call('PATCH', `/scheduled/${body.jobId}`, { body: { resend: true } })).status).toBe(409);
    // Edit only dismisses it: no letter comes back to send again, and the journal says discard.
    const edited = await call('POST', `/scheduled/${body.jobId}/cancel`, { body: { reason: 'edit' } });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({ ok: true });
    await vi.waitFor(async () => expect(await audit('message.send_cancelled')).toHaveLength(1));
    expect((await audit('message.send_cancelled'))[0].details.reason).toBe('discard');
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('a worker that stops after the server took the letter leaves it delivered_unrecorded, never resent', async () => {
    const { body } = await send();
    await makeDue(body.jobId);
    // After the server accepted the letter the database refuses to settle the job, and the worker
    // gives up (no retries here): only the delivery mark was written.
    const [claimed] = await claimDueJobs(10);
    await db.exec(`
      CREATE FUNCTION hold_done() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'connection lost'; END $$;
      CREATE TRIGGER hold_done BEFORE UPDATE ON jobs FOR EACH ROW
        WHEN (NEW.status IN ('done', 'needs_attention') AND OLD.status = 'running') EXECUTE FUNCTION hold_done();`);
    _setSettleRetryDelaysForTests([]);
    try {
      await runJob(claimed);
    } finally {
      _setSettleRetryDelaysForTests();
      await db.exec('DROP TRIGGER hold_done ON jobs; DROP FUNCTION hold_done();');
    }
    // Nothing could be recorded but the delivery mark: the job is still running, until the sweep.
    expect(await job(body.jobId)).toMatchObject({ status: 'running' });
    await db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [body.jobId]);
    await sweepExpiredLeases();
    expect(await job(body.jobId)).toMatchObject({ status: 'needs_attention', error_code: 'delivered_unrecorded' });
    const resend = await call('PATCH', `/scheduled/${body.jobId}`, { body: { resend: true } });
    expect(resend.status).toBe(409);
    await runDueJobs({ wait: true });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('a deleted mailbox fails its waiting letters: journaled, the author told, the row kept', async () => {
    const { body } = await send({ sendAt: new Date(Date.now() + 3600e3).toISOString() });
    await failJobsOfDeletedAccount(ACCOUNT);
    await db.query('DELETE FROM email_accounts WHERE id = $1', [ACCOUNT]);
    expect(await job(body.jobId)).toMatchObject({ status: 'failed', error_code: 'account_missing', account_id: null });
    await vi.waitFor(async () => expect(await audit('message.send_failed')).toHaveLength(1));
    await vi.waitFor(() => expect(imapManager.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_failed', jobId: body.jobId, code: 'account_missing', subject: 'Quarterly numbers' }), ANNA));
    // Every tab's Scheduled list refreshes.
    expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'scheduled_changed' }), null);
    const { letters } = await (await call('GET', '/scheduled')).json();
    expect(letters[0]).toMatchObject({ id: body.jobId, status: 'failed', accountId: null });
    expect(letters[0].keptUntil).toBeTruthy();
  });

  it('a deleted mailbox does not report again a letter that had failed already', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('Message failed: 550 rejected'), { code: 'EMESSAGE', responseCode: 550, command: 'DATA' }));
    const { body } = await send();
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    await vi.waitFor(async () => expect(await audit('message.send_failed')).toHaveLength(1));
    const failedToasts = () => imapManager.broadcast.mock.calls.filter(([event]) => event.type === 'send_failed').length;
    await vi.waitFor(() => expect(failedToasts()).toBe(1));
    await failJobsOfDeletedAccount(ACCOUNT);
    expect(await job(body.jobId)).toMatchObject({ status: 'failed', error_code: 'smtp_rejected' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await audit('message.send_failed')).toHaveLength(1);
    expect(failedToasts()).toBe(1);
  });

  it('fails a running letter whose mailbox went, and journals the failure of an author-less letter', async () => {
    const { body } = await send();
    await db.query('UPDATE jobs SET account_id = NULL, created_by = NULL WHERE id = $1', [body.jobId]);
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).not.toHaveBeenCalled();
    expect(await job(body.jobId)).toMatchObject({ status: 'failed' });
    await vi.waitFor(async () => expect(await audit('message.send_failed')).toHaveLength(1));
  });
});

describe('Editing a scheduled forward', () => {
  const FORWARDED = 'forwarded attachment bytes';
  // A scheduled forward of one attachment of a received letter, next to one the writer added: the
  // send resolves the reference and the queue stores the bytes. The source row is then deleted, as
  // when the original was purged while the forward waited.
  const scheduleForward = async () => {
    imapManager.moveQueue = { serverLocation: async row => ({ uid: row.uid, folder: row.folder }) };
    imapManager.fetchAttachment = vi.fn(async () => Buffer.from(FORWARDED));
    const { rows: [source] } = await db.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, attachments)
       VALUES ($1, 88, 'INBOX', '<forward-source@example.com>', 'Source', $2::jsonb) RETURNING id`,
      [ACCOUNT, JSON.stringify([{ part: '2', filename: 'report.pdf', type: 'application/pdf', size: FORWARDED.length }])]
    );
    const at = new Date(Date.now() + 3600e3).toISOString();
    const { status, body } = await send({
      sendAt: at,
      forwardedAttachments: [{ messageId: source.id, part: '2' }],
      context: { isForward: true, forwardedAttachments: [{ messageId: source.id, part: '2', filename: 'report.pdf', size: FORWARDED.length }] },
    });
    expect(status).toBe(200);
    await db.query('DELETE FROM messages WHERE id = $1', [source.id]);
    return body;
  };
  const editAndResend = async (jobId) => {
    const edit = await call('POST', `/scheduled/${jobId}/cancel`, { body: { reason: 'edit' } });
    expect(edit.status).toBe(200);
    const answer = await edit.json();
    const res = await call('POST', '/send', {
      body: { ...answer.compose, subject: 'Edited subject', sendAt: answer.sendAt }, key: `edit-${jobId}`,
    });
    return { answer, res, body: await res.json() };
  };
  const sentAttachments = () => sendMail.mock.calls[0][0].attachments.map(a => [a.filename, Buffer.from(a.content).toString()]);

  it('gives the stored forwarded attachment back with its bytes, so it is sent again without its source', async () => {
    const queued = await scheduleForward();
    const { answer, res, body } = await editAndResend(queued.jobId);
    expect(answer.compose.attachments).toEqual([
      { filename: 'notes.txt', contentType: 'text/plain', size: 11, content: Buffer.from('hello notes').toString('base64') },
      { filename: 'report.pdf', contentType: 'application/pdf', size: FORWARDED.length, content: Buffer.from(FORWARDED).toString('base64') },
    ]);
    // No reference is handed back: the next send would resolve it again against a source that is gone.
    expect(answer.compose.forwardedAttachments).toEqual([]);
    expect(answer.compose.context).toEqual({ isForward: true });
    expect(res.status).toBe(200);
    await makeDue(body.jobId);
    await runDueJobs({ wait: true });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0][0].subject).toBe('Edited subject');
    expect(sentAttachments()).toEqual([['notes.txt', 'hello notes'], ['report.pdf', FORWARDED]]);
  });

  it('gives back the forwarded attachment of a letter queued before the forwarded indexes were stored', async () => {
    const queued = await scheduleForward();
    const { rows: [row] } = await db.query('SELECT mail FROM outgoing_messages WHERE job_id = $1', [queued.jobId]);
    const stored = JSON.parse(Buffer.from(row.mail).toString('utf8'));
    delete stored.forwarded;
    await db.query('UPDATE outgoing_messages SET mail = $2 WHERE job_id = $1', [queued.jobId, Buffer.from(JSON.stringify(stored))]);
    const { answer, res } = await editAndResend(queued.jobId);
    expect(answer.compose.attachments.map(a => a.filename)).toEqual(['notes.txt', 'report.pdf']);
    expect(res.status).toBe(200);
  });
});
