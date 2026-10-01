import { pickReplyAlias } from './replyAlias.js';
import { buildQuote, identityName, quoteMetaFor, senderLanguage } from './quoteHeader.js';
import { safeQuoteSource, safeViewState, spamFolderPaths } from './safeView.js';

function parseAddressField(raw) {
  try {
    const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return arr.map(a => a.name ? `${a.name} <${a.email}>` : a.email).filter(Boolean).join(', ');
  } catch { return ''; }
}

// What a reply or forward quotes. A letter that opens in safe view (utils/safeView.js: in the
// account's Spam folder, or marked by EOP as phishing or malware) is quoted as its safe text, never
// its HTML, whose images would load in the composer. From the list there is no "Show in full", so
// such a letter is always quoted this way. folders: the account's folder list; safeLabels: the
// words that introduce a link's target, in the reader's language.
function quoteSource(message, body, { accounts = [], folders = [], safeLabels } = {}) {
  const account = accounts.find(a => a.id === message.account_id);
  const state = safeViewState({
    inSpamFolder: spamFolderPaths(account, folders).has(message.folder),
    eopCategory: message.eop_category || body?.eopCategory || null,
  });
  if (state?.locked) return safeQuoteSource(body, safeLabels);
  return { text: body?.text, html: body?.html };
}

// The options a caller with t() and the account's folders passes to the two helpers below.
export function safeQuoteOptions(t, folders) {
  return {
    folders: folders || [],
    safeLabels: { link: t('message.safeView.linkTo'), form: t('message.safeView.formTo') },
  };
}

export async function openReplyFromMessage(message, { accounts, openCompose, getMessageBody, replyAll = false, folders = [], safeLabels }) {
  const replyToArr = Array.isArray(message.reply_to)
    ? message.reply_to
    : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch { return []; } })();
  const replyTarget = (replyToArr.length && replyToArr[0].email)
    ? replyToArr[0]
    : { name: message.from_name || '', email: message.from_email || '' };
  const sender = replyTarget.email ? [replyTarget] : [];

  const myAccount = accounts.find(a => a.id === message.account_id);
  const myEmail = myAccount?.email_address || '';
  const myAddresses = new Set([
    myEmail.toLowerCase(),
    ...(myAccount?.aliases || []).map(al => al.email.toLowerCase()),
  ]);

  // Delivered-To first, then the To/Cc/From scan: replying from the list or GTD triage picks
  // the same alias as replying from the reading pane.
  const replyAliasId = pickReplyAlias({
    aliases: myAccount?.aliases || [],
    deliveryAddresses: message.delivery_addresses,
    toAddresses: message.to_addresses,
    ccAddresses: message.cc_addresses,
    fromEmail: message.from_email,
    accountEmail: myEmail,
  });

  const allRecipients = (() => {
    try {
      const toArr = Array.isArray(message.to_addresses)
        ? message.to_addresses
        : JSON.parse(message.to_addresses || '[]');
      const ccArr = Array.isArray(message.cc_addresses)
        ? message.cc_addresses
        : JSON.parse(message.cc_addresses || '[]');
      return [...toArr, ...ccArr].filter(
        t => t.email && !myAddresses.has(t.email.toLowerCase()) && t.email !== replyTarget.email
      );
    } catch { return []; }
  })();

  const referencesChain = [message.in_reply_to, message.message_id]
    .filter(Boolean).join(' ').trim() || null;
  const rawSubject = (message.subject || '').trim();

  const replyBody = await getMessageBody(message.id).catch(() => null);
  // The quote header speaks the language of the name the reply goes out under.
  const quoteMeta = quoteMetaFor(message, 'reply');
  const quoteLang = senderLanguage(identityName(myAccount, replyAliasId));
  const { quotedText, quotedHtml: quotedBodyHtml } = buildQuote(quoteMeta, quoteLang, quoteSource(message, replyBody, { accounts, folders, safeLabels }));

  openCompose({
    to: sender,
    cc: replyAll ? allRecipients : [],
    subject: rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:',
    body: '',
    quotedBody: quotedText,
    quotedBodyHtml,
    quoteMeta,
    quoteLang,
    inReplyTo: message.message_id,
    references: referencesChain,
    accountId: message.account_id,
    aliasId: replyAliasId,
    isReply: true,
    isReplyAll: replyAll,
    originalFrom: sender,
    allRecipients,
    // Keeps a reply sent from the list in its Gmail conversation, as the reading pane does.
    threadId: message.thread_id,
  });
}

export async function openForwardFromMessage(message, { openCompose, getMessageBody, accounts = [], folders = [], safeLabels }) {
  const fwdBody = await getMessageBody(message.id).catch(() => null);
  const quoteExtra = { to: parseAddressField(message.to_addresses), cc: parseAddressField(message.cc_addresses) };
  const quoteMeta = quoteMetaFor(message, 'forward');
  const quoteLang = senderLanguage(identityName(accounts.find(a => a.id === message.account_id)));
  const source = quoteSource(message, fwdBody, { accounts, folders, safeLabels });
  const { quotedText: fwdText, quotedHtml: fwdHtml } = buildQuote(quoteMeta, quoteLang, { ...source, ...quoteExtra });

  openCompose({
    subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
    body: '',
    quotedBody: fwdText,
    quotedBodyHtml: fwdHtml,
    quoteMeta,
    quoteLang,
    quoteExtra,
    accountId: message.account_id,
    isForward: true,
    forwardedAttachments: (fwdBody?.attachments || []).map(att => ({
      messageId: message.id,
      part: att.part,
      filename: att.filename || 'attachment',
      type: att.type || 'application/octet-stream',
      size: att.size || 0,
    })),
  });
}
