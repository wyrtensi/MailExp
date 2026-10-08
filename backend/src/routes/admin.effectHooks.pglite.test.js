import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The backend's real admin_effects hooks (ADMIN_EFFECT_HOOKS in routes/admin.js) for what the panel
// CLI queues about mailboxes: reconnecting a mailbox and running rules on the inbox. PGlite with
// every migration; the backend's imapManager and the rules engine are stubbed.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => {} },
}));
const imap = vi.hoisted(() => ({
  disconnectAccount: null, connectAccount: null, clearConnectCooldown: null,
}));
vi.mock('../index.js', () => ({ imapManager: imap }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
const sweep = vi.hoisted(() => ({ apply: null }));
vi.mock('../services/inboxRules.js', () => ({
  applyInboxRules: (...args) => sweep.apply(...args),
  isDangerousRegex: () => false,
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { ADMIN_EFFECT_HOOKS } = await import('./admin.js');
const { applyAdminEffects } = await import('../services/admin/adminEffects.js');
const { claimRulesRun, runClaimedRules } = await import('../services/rules/ruleActions.js');

const ADMIN = '68000000-0000-4000-8000-000000000001';
let db;

const audit = async () => (await db.query('SELECT actor_user_id, actor_email, account_id, action, details FROM mailbox_audit_log ORDER BY id')).rows;
async function settled(check) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}
async function addAccount(email, extra = {}) {
  const row = { name: email, email_address: email, protocol: 'imap', enabled: true, ...extra };
  const keys = Object.keys(row);
  const { rows } = await db.query(
    `INSERT INTO email_accounts (added_by, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [ADMIN, ...keys.map((key) => row[key])],
  );
  return rows[0].id;
}
async function addRule(accountId) {
  const { rows } = await db.query(
    `INSERT INTO inbox_rules (account_id, name, enabled, priority, conditions, actions)
     VALUES ($1, 'R', true, 0, '[]', '[{"type":"mark_read"}]') RETURNING id`, [accountId],
  );
  return rows[0].id;
}
async function addInboxLetter(accountId) {
  await db.query(
    `INSERT INTO messages (account_id, uid, folder, message_id, subject, from_email, date)
     VALUES ($1, 1, 'INBOX', '<m1@example.com>', 's', 'a@example.com', NOW())`, [accountId],
  );
}

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await db.exec('DELETE FROM mailbox_audit_log; DELETE FROM messages; DELETE FROM inbox_rules; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
  imap.disconnectAccount = vi.fn(async () => {});
  imap.connectAccount = vi.fn(async () => {});
  imap.clearConnectCooldown = vi.fn();
  sweep.apply = vi.fn(async () => ({ remaining: [] }));
});

describe('ADMIN_EFFECT_HOOKS reconnect', () => {
  it('reconnects an enabled IMAP mailbox from its stored row', async () => {
    const id = await addAccount('on@example.com');
    await applyAdminEffects({ reconnect: [id] }, ADMIN_EFFECT_HOOKS);
    expect(imap.disconnectAccount).toHaveBeenCalledWith(id);
    expect(imap.clearConnectCooldown).toHaveBeenCalledWith(id);
    expect(imap.connectAccount).toHaveBeenCalledWith(expect.objectContaining({ id, email_address: 'on@example.com' }));
  });

  it('leaves a mailbox disabled since the change disconnected', async () => {
    const id = await addAccount('off@example.com', { enabled: false });
    await applyAdminEffects({ reconnect: [id] }, ADMIN_EFFECT_HOOKS);
    expect(imap.connectAccount).not.toHaveBeenCalled();
  });
});

describe('ADMIN_EFFECT_HOOKS runRules', () => {
  const actor = { userId: null, via: 'cli' };

  it('claims the mailbox, journals rule.run for the job\'s actor and sweeps the inbox', async () => {
    const id = await addAccount('box@example.com');
    const ruleId = await addRule(id);
    await addInboxLetter(id);
    await applyAdminEffects({ runRules: [id] }, ADMIN_EFFECT_HOOKS, { actor });
    await settled(async () => sweep.apply.mock.calls.length > 0 && (await audit()).length > 0);
    expect(sweep.apply).toHaveBeenCalledTimes(1);
    expect(await audit()).toEqual([{
      actor_user_id: null, actor_email: 'cli', account_id: id, action: 'rule.run',
      details: { ruleIds: [ruleId], allMailboxes: false, via: 'cli' },
    }]);
    // The sweep has released the mailbox: a later run claims it again.
    await settled(async () => claimRulesRun([id]));
    await runClaimedRules([id], imap);
  });

  it('journals all mailboxes with the --as administrator', async () => {
    const id = await addAccount('box@example.com');
    await addRule(id);
    await applyAdminEffects({ runRules: [id], runRulesAll: true }, ADMIN_EFFECT_HOOKS, { actor: { userId: ADMIN, via: 'cli' } });
    await settled(async () => (await audit()).length > 0);
    expect(await audit()).toEqual([expect.objectContaining({
      actor_user_id: ADMIN, action: 'rule.run', details: expect.objectContaining({ allMailboxes: true, via: 'cli' }),
    })]);
  });

  it('skips a mailbox a run is already sweeping: no journal entry, no second sweep', async () => {
    const id = await addAccount('busy@example.com');
    await addRule(id);
    await addInboxLetter(id);
    expect(claimRulesRun([id])).toBe(true);
    try {
      await applyAdminEffects({ runRules: [id] }, ADMIN_EFFECT_HOOKS, { actor });
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      expect(sweep.apply).not.toHaveBeenCalled();
      expect(await audit()).toEqual([]);
    } finally {
      await runClaimedRules([id], imap);
    }
  });
});
