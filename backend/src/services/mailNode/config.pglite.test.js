// The node and EOP settings rows against PGlite with the real migrations: a save merges into the
// stored JSON, so a field another form (or a later stage) wrote survives "Check and save".
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null };
vi.mock('../db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));

const { MAIL_NODE_PROVIDER, getDeleteAfterDays, getMailNodeConfig, saveMailNodeConfig } = await import('./mailcow.js');
const { EOP_DEFAULTS, EOP_PROVIDER, getEopSettings, saveEopSettings } = await import('./eopSettings.js');

let db;
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.query('DELETE FROM integration_config'); });

const storedConfig = async (provider) => (await db.query(
  'SELECT config FROM integration_config WHERE provider = $1', [provider],
)).rows[0]?.config;

describe('saveMailNodeConfig', () => {
  it('keeps fields it does not write when the settings are saved again', async () => {
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'first', quotaMb: 5120, diskPingUrl: 'https://hc.example.com/p/1' });
    await db.query(
      "UPDATE integration_config SET config = config || '{\"tlsPolicy\": \"secure\"}' WHERE provider = $1", [MAIL_NODE_PROVIDER],
    );
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'second', quotaMb: 1024, diskPingUrl: 'https://hc.example.com/p/2' });
    expect(await storedConfig(MAIL_NODE_PROVIDER)).toEqual({
      mailHost: 'mail.example.com', apiKey: 'enc:second', quotaMb: 1024, diskPingUrl: 'https://hc.example.com/p/2', tlsPolicy: 'secure',
    });
    expect(await getMailNodeConfig()).toEqual({
      mailHost: 'mail.example.com', apiKey: 'second', quotaMb: 1024, diskPingUrl: 'https://hc.example.com/p/2', deleteAfterDays: 5,
      panelIps: [],
    });
  });

  it('keeps the days before a deletion, 5 until an administrator sets them, 1 to 90', async () => {
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120 });
    expect((await getMailNodeConfig()).deleteAfterDays).toBe(5);
    expect(await getDeleteAfterDays()).toBe(5);
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, deleteAfterDays: 30 });
    expect((await getMailNodeConfig()).deleteAfterDays).toBe(30);
    // A save from a form without the field keeps it.
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120 });
    expect(await getDeleteAfterDays()).toBe(30);
    await db.query("UPDATE integration_config SET config = config || '{\"deleteAfterDays\": 365}' WHERE provider = $1", [MAIL_NODE_PROVIDER]);
    expect(await getDeleteAfterDays()).toBe(5);
  });

  it('clears the ping URL when it is saved empty', async () => {
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, diskPingUrl: 'https://hc.example.com/p/1' });
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, diskPingUrl: null });
    expect((await storedConfig(MAIL_NODE_PROVIDER)).diskPingUrl).toBeNull();
    expect((await getMailNodeConfig()).diskPingUrl).toBeNull();
  });
});

describe('EOP settings', () => {
  it('reads the defaults before anything is saved: mailcow signs, 50 messages an hour', async () => {
    expect(await getEopSettings()).toEqual(EOP_DEFAULTS);
    expect(EOP_DEFAULTS).toMatchObject({ dkimMode: 'mailcow', sendLimitPerHour: 50 });
  });

  it('merges a save into the stored row, apart from the node settings', async () => {
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120 });
    await saveEopSettings({ eopHost: 'contoso-com.mail.protection.outlook.com', terrl: 48248 });
    await saveEopSettings({ dkimMode: 'eop', terrl: null });
    expect(await storedConfig(EOP_PROVIDER)).toEqual({ eopHost: 'contoso-com.mail.protection.outlook.com', dkimMode: 'eop', terrl: null });
    expect(await getEopSettings()).toEqual({ ...EOP_DEFAULTS, eopHost: 'contoso-com.mail.protection.outlook.com', dkimMode: 'eop' });
    // The node's own row is untouched.
    expect((await storedConfig(MAIL_NODE_PROVIDER)).mailHost).toBe('mail.example.com');
    // And "Check and save" of the node does not touch the EOP row.
    await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 2048 });
    expect((await getEopSettings()).dkimMode).toBe('eop');
  });
});
