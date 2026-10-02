// The names a new mailbox sends under: the main one goes to email_accounts.sender_name, the second
// (for instance the same person in Latin letters) becomes an alias with the mailbox's own address,
// so the From selector of compose offers both. Used by the domain mailbox route and the Gmail
// start and callback.

import { domainToASCII } from 'node:url';

export const SENDER_NAME_MAX = 200;

const clean = (value) => (typeof value === 'string' ? value.trim().slice(0, SENDER_NAME_MAX) : '');

// { senderName, senderNameAlt } with empty values as null, or { error } for a name that would
// break the From header. The second name is dropped when it repeats the first.
export function parseSenderNames(body) {
  const senderName = clean(body?.senderName) || null;
  let senderNameAlt = clean(body?.senderNameAlt) || null;
  if ([senderName, senderNameAlt].some((n) => n && /[\r\n\0]/.test(n))) {
    return { error: 'Sender names cannot contain control characters' };
  }
  if (senderNameAlt && senderName && senderNameAlt.toLowerCase() === senderName.toLowerCase()) senderNameAlt = null;
  return { senderName, senderNameAlt };
}

// A mailbox on the mail node sends only from its own address (owner decision D-16): its aliases
// are more sender names for that address, and another address is a separate, billed mailbox
// created on the node. Gmail and IMAP mailboxes keep aliases with any address. `account` needs
// email_address and mail_node.
export function isForeignNodeAliasAddress(account, email) {
  if (account?.mail_node !== true) return false;
  return normalizeAddress(email) !== normalizeAddress(account.email_address);
}

// An address compared the way node mailboxes are made: lowercase, the domain in its ASCII (punycode)
// form, which is the only form a node mailbox has (services/mailNode/mailcow.js parseHostName), so
// `sales@пример.рф` and `sales@xn--e1afmkfd.xn--p1ai` are one address.
export function normalizeAddress(value) {
  const email = String(value ?? '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 0) return email;
  const domain = email.slice(at + 1);
  return `${email.slice(0, at)}@${domainToASCII(domain) || domain}`;
}

// The address of a From header as nodemailer takes it: 'Name <address>' or a bare address.
export function fromHeaderAddress(from) {
  if (from && typeof from === 'object') return String(from.address ?? '');
  const text = String(from ?? '');
  const match = text.match(/<([^<>]*)>\s*$/);
  return (match ? match[1] : text).trim();
}

// Adds the second name as an alias of the mailbox, inside the caller's transaction.
export async function addSecondSenderName(client, { accountId, email, senderNameAlt }) {
  if (!senderNameAlt) return null;
  const result = await client.query(
    'INSERT INTO account_aliases (account_id, name, email) VALUES ($1, $2, $3) RETURNING id, name, email, reply_to, signature',
    [accountId, senderNameAlt, email],
  );
  return result.rows[0];
}
