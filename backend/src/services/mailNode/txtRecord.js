// The TXT value of a record as one string: mailcow (SPLIT_DKIM_255) and DNS answers may give it
// as quoted pieces of up to 255 characters separated by spaces ("v=DKIM1;..." "..."). Shared by the
// mailcow client (services/mailNode/mailcow.js) and the DNS check (services/mailNode/dnsCheck.js).
export function joinTxtChunks(value) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('"')) return text;
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join('');
}
