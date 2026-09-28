// The strip at the top of an open letter that says which mailbox it belongs to: with many shared
// mailboxes the reader must see at once where a letter arrived (or which one sent it). Pure
// function, so it runs under `node --test`.
import { parseAddressListField } from './replyAlias.js';

const lower = (value) => String(value ?? '').trim().toLowerCase();

// An address-list entry is either a bare string (delivery_addresses) or an {email, name} object
// (to_addresses/cc_addresses) — see parseAddressListField's callers elsewhere (replyAlias.js,
// senderHistory.js's correspondentOf). Normalizes either shape to a lowercased address.
const entryEmail = (entry) => lower(typeof entry === 'string' ? entry : entry?.email);

// { direction: 'in' | 'out', via }. 'out' when the mailbox (or one of its aliases) wrote it AND
// either the letter sits in the mailbox's own Sent folder, or none of its recipients is the
// mailbox itself. A letter a mailbox sends to ITSELF (e.g. a note-to-self, or a shared mailbox
// CC'd on its own outgoing mail) is also a received copy — Gmail keeps it in both Sent and
// Inbox — so outside Sent it badges 'in' like any other letter that landed here; via stays null
// for it (delivery_addresses on a letter the mailbox itself sent isn't a forwarding signal).
// `via` is the address a genuinely received letter was delivered to when that is not the
// mailbox's own (an alias or a group address that forwards here), else null.
export function mailboxBanner(message, account, folderList) {
  const own = lower(account?.email_address ?? message?.account_email);
  const aliasEmails = (account?.aliases || []).map((a) => lower(a.email));
  const isOwnAddress = (email) => !!email && (email === own || aliasEmails.includes(email));
  const from = lower(message?.from_email);

  if (!isOwnAddress(from)) {
    const delivered = parseAddressListField(message?.delivery_addresses).map(lower).filter(Boolean);
    const via = delivered.find((address) => address !== own) ?? null;
    return { direction: 'in', via };
  }

  if (isSentFolder(message?.folder, account?.folder_mappings, folderList)) {
    return { direction: 'out', via: null };
  }
  const to = parseAddressListField(message?.to_addresses).map(entryEmail);
  const cc = parseAddressListField(message?.cc_addresses).map(entryEmail);
  const delivered = parseAddressListField(message?.delivery_addresses).map(entryEmail);
  const selfAddressed = [...to, ...cc, ...delivered].some(isOwnAddress);
  return selfAddressed ? { direction: 'in', via: null } : { direction: 'out', via: null };
}

// Whether `folder` is the given account's Sent folder. Prefers the account's configured
// folder_mappings.sent (exact match, same as isDraftFolder's primary check below); falls back to
// the folder's own special_use ('\Sent', as synced per account — see isDraftMessage.js's
// equivalent Drafts check) when folderList is available. No name heuristic fallback: the backend
// resolves the canonical Sent folder the same narrow way (mailUtils.js's resolveSentFolder).
export function isSentFolder(folder, folderMappings, folderList) {
  if (!folder) return false;
  if (folderMappings?.sent) return folder === folderMappings.sent;
  const info = (folderList || []).find((f) => f.path === folder);
  return info?.special_use === '\\Sent';
}

// Whether `folder` is the given account's Drafts folder — an unsent draft is neither "sent" nor
// "received", so a direction badge (DirectionBadge.jsx) shows 'draft' instead of asking
// mailboxBanner(). Prefers the account's configured folder_mappings.drafts (exact match); falls
// back to a path heuristic (matches Sidebar.jsx's own folder-icon detection) for an account that
// never had one configured.
export function isDraftFolder(folder, folderMappings) {
  if (!folder) return false;
  if (folderMappings?.drafts) return folder === folderMappings.drafts;
  return String(folder).toLowerCase().includes('draft');
}
