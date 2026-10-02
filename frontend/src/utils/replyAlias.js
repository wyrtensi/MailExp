export function parseAddressListField(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

// An alias with the mailbox's own address (a second sender name, e.g. the same name in Latin
// letters) matches every letter by address, so it cannot be told apart from the mailbox itself:
// the mailbox wins and replies go out under its main name; the second name is picked by hand.
// A mail node mailbox (`mailNode`) sends only from its own address (D-16): an alias with another
// address left from before is never picked, since sending from it is refused.
export function pickReplyAlias({ aliases, deliveryAddresses, toAddresses, ccAddresses, fromEmail, accountEmail, mailNode = false }) {
  if (mailNode) return null;
  const own = (accountEmail || '').toLowerCase();
  aliases = (aliases || []).filter(al => (al.email || '').toLowerCase() !== own);
  if (!aliases.length) return null;

  const delivered = parseAddressListField(deliveryAddresses).map(e => (e || '').toLowerCase()).filter(Boolean);
  const to = parseAddressListField(toAddresses).map(a => a.email?.toLowerCase()).filter(Boolean);
  const cc = parseAddressListField(ccAddresses).map(a => a.email?.toLowerCase()).filter(Boolean);
  const from = (fromEmail || '').toLowerCase();

  const deliveredMatch = aliases.find(al => delivered.includes(al.email.toLowerCase()));
  if (deliveredMatch) return deliveredMatch.id;

  // Same scan as before delivery addresses existed: aliases in creation order
  // against the combined To/Cc/From set, so multi-alias picks don't change.
  const headerEmails = [...to, ...cc];
  const match = aliases.find(al => {
    const aliasEmail = al.email.toLowerCase();
    return headerEmails.includes(aliasEmail) || (from && from === aliasEmail);
  });
  return match ? match.id : null;
}
