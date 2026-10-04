import { query } from './db.js';
import { sanitizeSignature } from './emailSanitizer.js';
import { isForeignNodeAliasAddress } from '../utils/senderNames.js';

// A mailbox's aliases (account_aliases): more names, reply-to addresses and signatures to send
// with. Shared by routes/accounts.js and the panel CLI (src/cli/mailexpert.js). A node mailbox's
// alias is another sender name for its own address (D-16): any other address is refused. Name,
// reply-to and signature stay free. Answers the alias or { error: code } (ALIAS_ERRORS). The
// db: a transaction's client, so the alias changes with what goes with it (the pool by default). The
// caller tells the plugins the account's identity changed (routes/accounts.js); the CLI changes
// only node mailboxes, whose aliases never add an address, so nothing they cache goes stale.

export const ALIAS_ERRORS = Object.freeze({
  account_not_found: [404, 'Account not found'],
  alias_not_found: [404, 'Alias not found'],
  alias_fields_required: [400, 'Name and email required'],
  alias_fields_invalid: [400, 'Fields cannot contain control characters'],
  node_alias_address_mismatch: [400, 'A mail node mailbox sends only from its own address: another address is a separate mailbox'],
});

// Characters that could inject extra email headers.
export function hasHeaderInjectionChars(str) {
  return typeof str === 'string' && /[\r\n\0]/.test(str);
}

// The address an alias is stored with: a node mailbox's own address as the mailbox row spells it
// (the request may differ in case, spacing or IDN form), anything else as given.
function aliasAddress(account, email) {
  return account?.mail_node === true ? account.email_address : email;
}

function fieldsRefusal({ name, email, reply_to: replyTo }) {
  if (!name || !email) return 'alias_fields_required';
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email) || hasHeaderInjectionChars(replyTo)) return 'alias_fields_invalid';
  return null;
}

export async function listAliases(accountId, db = { query }) {
  const result = await db.query(
    'SELECT id, account_id, name, email, reply_to, signature, created_at FROM account_aliases WHERE account_id = $1 ORDER BY created_at',
    [accountId],
  );
  return result.rows.map((alias) => ({
    ...alias,
    signature: alias.signature ? sanitizeSignature(alias.signature) : alias.signature,
  }));
}

// { alias } or { error }.
export async function createAlias(accountId, fields, db = { query }) {
  const refusal = fieldsRefusal(fields);
  if (refusal) return { error: refusal };
  const check = await db.query('SELECT id, email_address, mail_node FROM email_accounts WHERE id = $1', [accountId]);
  if (!check.rows.length) return { error: 'account_not_found' };
  if (isForeignNodeAliasAddress(check.rows[0], fields.email)) return { error: 'node_alias_address_mismatch' };
  const result = await db.query(
    'INSERT INTO account_aliases (account_id, name, email, reply_to, signature) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [accountId, fields.name, aliasAddress(check.rows[0], fields.email), fields.reply_to || null, sanitizeSignature(fields.signature) || null],
  );
  return { alias: result.rows[0] };
}

// { alias, accountId } or { error }; accountId: the account the alias was found on.
export async function updateAlias(accountId, aliasId, fields, db = { query }) {
  const refusal = fieldsRefusal(fields);
  if (refusal) return { error: refusal };
  const check = await db.query(
    `SELECT a.id, a.account_id, e.email_address, e.mail_node FROM account_aliases a
     JOIN email_accounts e ON a.account_id = e.id
     WHERE a.id = $1 AND e.id = $2`,
    [aliasId, accountId],
  );
  if (!check.rows.length) return { error: 'alias_not_found' };
  if (isForeignNodeAliasAddress(check.rows[0], fields.email)) return { error: 'node_alias_address_mismatch' };
  const result = await db.query(
    'UPDATE account_aliases SET name = $1, email = $2, reply_to = $3, signature = $4 WHERE id = $5 RETURNING *',
    [fields.name, aliasAddress(check.rows[0], fields.email), fields.reply_to || null, sanitizeSignature(fields.signature) || null, aliasId],
  );
  return { alias: result.rows[0], accountId: check.rows[0].account_id };
}

// { ok, accountId } or { error }.
export async function deleteAlias(accountId, aliasId, db = { query }) {
  const check = await db.query(
    `SELECT a.id, a.account_id FROM account_aliases a
     JOIN email_accounts e ON a.account_id = e.id
     WHERE a.id = $1 AND e.id = $2`,
    [aliasId, accountId],
  );
  if (!check.rows.length) return { error: 'alias_not_found' };
  await db.query('DELETE FROM account_aliases WHERE id = $1', [aliasId]);
  return { ok: true, accountId: check.rows[0].account_id };
}
