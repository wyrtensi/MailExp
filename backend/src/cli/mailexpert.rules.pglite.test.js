import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The panel CLI's rule group end to end: the real rules service the /api/rules routes use, on
// PGlite with every migration. Running rules on the inbox is the backend's: the CLI queues an
// admin_effects job, which the test runs with a recording hook.

const dbState = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  return { db: null };
});
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => {} },
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { claimDueJobs, runJob } = await import('../services/jobQueue.js');
const { registerAdminEffectsJobKind } = await import('../services/admin/adminEffects.js');
const { run } = await import('./mailexpert.js');

const ADMIN = '67000000-0000-4000-8000-000000000001';
const USER = '67000000-0000-4000-8000-000000000002';
let db;
let hooks;
let dir;
let box;
let other;

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function cli(argv, { stdin = '', interactive = false, answer = '' } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, {
    stdout, stderr, interactive, ask: async () => answer, readStdin: async () => stdin, stdinIsTerminal: false,
    sleep: async () => {}, now: Date.now, pollMs: 0,
  });
  return { code, out: stdout.text, err: stderr.text, json: () => JSON.parse(stdout.text) };
}

const audit = async () => (await db.query('SELECT actor_user_id, actor_email, account_id, action, details FROM mailbox_audit_log ORDER BY id')).rows;
async function auditSettled(count) {
  for (let i = 0; i < 50; i += 1) {
    if ((await audit()).length >= count) return audit();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return audit();
}
const rules = async () => (await db.query('SELECT * FROM inbox_rules ORDER BY priority')).rows;
async function runEffects() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}

const RULE = (accountId, extra = {}) => ({
  name: 'Invoices',
  accountId,
  conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }],
  actions: [{ type: 'forward', value: ' books@example.com ' }, { type: 'forward', value: 'second@example.com' }],
  ...extra,
});

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  hooks = { runRules: vi.fn(async () => {}) };
  registerAdminEffectsJobKind(hooks);
  dir = await mkdtemp(join(tmpdir(), 'mailexpert-rule-'));
}, 120000);
afterAll(async () => {
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await db.exec('DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM inbox_rules; DELETE FROM folders; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query(`INSERT INTO users (id, username, email, password_hash, is_admin) VALUES
    ($1, 'admin', 'admin@example.com', 'x', true), ($2, 'user', 'user@example.com', 'x', false)`, [ADMIN, USER]);
  ({ rows: [{ id: box }] } = await db.query("INSERT INTO email_accounts (added_by, name, email_address) VALUES ($1, 'Box', 'box@example.com') RETURNING id", [ADMIN]));
  ({ rows: [{ id: other }] } = await db.query("INSERT INTO email_accounts (added_by, name, email_address) VALUES ($1, 'Other', 'other@example.com') RETURNING id", [ADMIN]));
  hooks.runRules.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('mailexpert rule', () => {
  it('creates a rule from stdin with the API\'s normalization, journaled as the CLI', async () => {
    const result = await cli(['rule', 'create', '--json'], { stdin: JSON.stringify(RULE(box)) });
    expect(result.code).toBe(0);
    const rule = result.json();
    expect(rule).toMatchObject({ account_id: box, name: 'Invoices', enabled: true, created_by: null, actions: [{ type: 'forward', value: 'books@example.com' }] });
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({
      action: 'rule.created', account_id: box, actor_email: 'cli',
      details: { ruleId: rule.id, name: 'Invoices', actions: ['forward'], forwardTo: 'books@example.com', via: 'cli' },
    });
  });

  it('creates from a file in a user\'s name, with the mailbox by address', async () => {
    const file = join(dir, 'rule.json');
    await writeFile(file, JSON.stringify(RULE(undefined, { actions: [{ type: 'mark_read' }] })));
    const result = await cli(['rule', 'create', '--file', file, '--account', 'box@example.com', '--user', 'user@example.com', '--as', 'admin@example.com', '--json']);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ account_id: box, created_by: USER, created_by_name: 'user@example.com' });
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({ action: 'rule.created', actor_user_id: ADMIN, details: { onBehalfOf: 'user@example.com', via: 'cli' } });
  });

  it('refuses what the API refuses', async () => {
    const create = (body) => cli(['rule', 'create'], { stdin: JSON.stringify(body) });
    expect(await create({ accountId: box, conditions: 'x', actions: [] })).toMatchObject({ code: 1, err: expect.stringContaining('(not_arrays)') });
    expect(await create(RULE(box, { conditions: [{ field: 'from', operator: 'contains', value: ' ' }] })))
      .toMatchObject({ code: 1, err: expect.stringContaining('Condition value cannot be empty (invalid_condition)') });
    expect(await create(RULE(box, { actions: [{ type: 'forward', value: 'not-an-address' }] })))
      .toMatchObject({ code: 1, err: expect.stringContaining('(invalid_action)') });
    expect(await create(RULE(undefined))).toMatchObject({ code: 1, err: expect.stringContaining('(account_required)') });
    await db.query("INSERT INTO folders (account_id, path, name, delimiter) VALUES ($1, 'INBOX', 'INBOX', '/')", [box]);
    expect(await create(RULE(box, { actions: [{ type: 'move', value: 'Nowhere' }] })))
      .toMatchObject({ code: 1, err: expect.stringContaining('(move_folder_not_found)') });
    expect((await cli(['rule', 'create'], { stdin: 'not json' })).code).toBe(2);
    expect(await rules()).toEqual([]);
  });

  it('lists and shows rules, by mailbox and by author', async () => {
    await cli(['rule', 'create'], { stdin: JSON.stringify(RULE(box)) });
    await cli(['rule', 'create', '--user', 'user@example.com'], { stdin: JSON.stringify(RULE(other, { name: 'Other' })) });
    expect((await cli(['rule', 'list', '--json'])).json().map((r) => r.name)).toEqual(['Invoices', 'Other']);
    expect((await cli(['rule', 'list', '--account', 'other@example.com', '--json'])).json().map((r) => r.name)).toEqual(['Other']);
    expect((await cli(['rule', 'list', '--user', 'user@example.com', '--json'])).json().map((r) => r.name)).toEqual(['Other']);
    const [first] = await rules();
    const show = await cli(['rule', 'show', first.id]);
    expect(show.out).toMatch(/subject contains invoice/);
    expect(show.out).toMatch(/forward books@example\.com/);
    expect(await cli(['rule', 'show', '67000000-0000-4000-8000-0000000000ff'])).toMatchObject({ code: 1, err: expect.stringContaining('(not_found)') });
    expect((await cli(['rule', 'show', 'nope'])).code).toBe(2);
  });

  it('replaces a rule, journaling the old forward address', async () => {
    await cli(['rule', 'create'], { stdin: JSON.stringify(RULE(box)) });
    const [{ id }] = await rules();
    const result = await cli(['rule', 'set', id, '--json'], { stdin: JSON.stringify(RULE(other, { actions: [{ type: 'forward', value: 'new@example.com' }] })) });
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ account_id: other, actions: [{ type: 'forward', value: 'new@example.com' }] });
    const entries = await auditSettled(2);
    expect(entries[1]).toMatchObject({
      action: 'rule.updated', account_id: other,
      details: { forwardTo: 'new@example.com', previousForwardTo: 'books@example.com', previousAccountId: box, via: 'cli' },
    });
  });

  it('turns a rule off and on through the whole-rule save', async () => {
    await cli(['rule', 'create'], { stdin: JSON.stringify(RULE(box, { stopProcessing: true, conditionLogic: 'OR' })) });
    const [{ id }] = await rules();
    expect((await cli(['rule', 'disable', id])).code).toBe(0);
    expect((await rules())[0]).toMatchObject({ enabled: false, stop_processing: true, condition_logic: 'OR', account_id: box });
    expect((await cli(['rule', 'disable', id])).out).toMatch(/already disabled/);
    expect((await cli(['rule', 'enable', id])).code).toBe(0);
    expect((await rules())[0].enabled).toBe(true);
    const entries = await auditSettled(3);
    expect(entries.map((e) => [e.action, e.details.enabled])).toEqual([['rule.created', undefined], ['rule.updated', false], ['rule.updated', true]]);
  });

  it('deletes a rule after confirmation', async () => {
    await cli(['rule', 'create'], { stdin: JSON.stringify(RULE(box)) });
    const [{ id }] = await rules();
    expect(await cli(['rule', 'delete', id])).toMatchObject({ code: 2, err: expect.stringContaining('confirmation_required') });
    expect((await cli(['rule', 'delete', id], { interactive: true, answer: 'y' })).code).toBe(0);
    expect(await rules()).toEqual([]);
    expect((await auditSettled(2))[1]).toMatchObject({ action: 'rule.deleted', details: { ruleId: id, via: 'cli' } });
  });

  it('runs the rules of a mailbox through the backend, journaled per mailbox', async () => {
    await cli(['rule', 'create'], { stdin: JSON.stringify(RULE(box)) });
    expect((await cli(['rule', 'run', '--yes'])).code).toBe(2);
    expect((await cli(['rule', 'run', '--account', 'box@example.com', '--all', '--yes'])).code).toBe(2);
    expect((await cli(['rule', 'run', '--account', 'box@example.com'])).code).toBe(2);
    const result = await cli(['rule', 'run', '--account', 'box@example.com', '--yes', '--json']);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ ok: true, started: true, job: { kind: 'admin_effects' } });
    // rule.run is the backend's to journal once it has claimed the mailbox (the hook), not the CLI's.
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect((await audit()).map((e) => e.action)).toEqual(['rule.created']);
    await runEffects();
    expect(hooks.runRules).toHaveBeenCalledWith([box], { allMailboxes: false, actor: { userId: null, via: 'cli' } });

    hooks.runRules.mockClear();
    expect((await cli(['rule', 'run', '--all', '--yes', '--as', 'admin@example.com'])).code).toBe(0);
    await runEffects();
    expect(hooks.runRules.mock.calls[0][0].sort()).toEqual([box, other].sort());
    expect(hooks.runRules.mock.calls[0][1]).toEqual({ allMailboxes: true, actor: { userId: ADMIN, via: 'cli' } });
  });
});
