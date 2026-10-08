import { query } from '../services/db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// code -> [HTTP status, the API's answer]; each answer carries its code for the screens.
export const MAILBOX_REF_ERRORS = Object.freeze({
  account_required: [400, { error: 'accountId is required', code: 'account_required' }],
  invalid_account: [400, { error: 'Invalid account id', code: 'invalid_account' }],
  account_not_found: [404, { error: 'Account not found', code: 'account_not_found' }],
});

// Rules and block list entries each belong to one mailbox: { id } of the mailbox the request
// names, or { error } when it names none or one that does not exist (services/rules/ruleActions.js
// and the panel CLI use it without a response).
export async function findMailboxId(accountId) {
  if (!accountId) return { error: 'account_required' };
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) return { error: 'invalid_account' };
  const { rows } = await query('SELECT id FROM email_accounts WHERE id = $1', [accountId]);
  if (!rows.length) return { error: 'account_not_found' };
  return { id: rows[0].id };
}

// The same for a route: returns the mailbox id, or answers 400 / 404 itself and returns null.
export async function requireMailbox(accountId, res) {
  const found = await findMailboxId(accountId);
  if (found.error) {
    const [status, body] = MAILBOX_REF_ERRORS[found.error];
    res.status(status).json(body);
    return null;
  }
  return found.id;
}
