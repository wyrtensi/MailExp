// Ignore display-name quotes and nested comments when locating a From mailbox.
export function draftSenderAddress(fromHeader) {
  let quoted = false;
  let commentDepth = 0;
  let escaped = false;
  let mailboxText = '';
  for (const char of fromHeader || '') {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && (quoted || commentDepth)) {
      escaped = true;
      continue;
    }
    if (commentDepth) {
      if (char === '(') commentDepth++;
      if (char === ')') commentDepth--;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === '(') {
      commentDepth = 1;
      continue;
    }
    mailboxText += char;
  }
  const address = mailboxText.match(/<([^<>]+)>/)?.[1] || mailboxText.trim();
  return /^[^\s<>@]+@[^\s<>@]+$/.test(address.trim()) ? address.trim() : null;
}
