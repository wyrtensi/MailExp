// Whether a rich quote holds nothing a reader would see: no text and no image. A contentEditable
// the writer cleared still keeps markup such as <br> or <div><br></div>.
export function isEmptyQuoteHtml(html) {
  if (!html) return true;
  if (/<img\b/i.test(html)) return false;
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/[\s\u00a0\u200b\ufeff]/g, '');
  return text === '';
}

// The quote fields of a send or a draft save (POST /mail/send, /mail/draft).
// liveQuoteHtml: the rich quote as it stands in the composer (null until it is mounted).
// The server builds the HTML part from quotedBodyHtml, falling back to quotedBody when that is
// empty, and appends quotedBody to the text part. So a rich quote the writer deleted goes without
// quotedBody, or the original quote would come back in the letter and in the draft.
export function quotePayload({ plaintextEmail, quotedBody, quotedBodyHtml, liveQuoteHtml }) {
  if (!plaintextEmail && (quotedBodyHtml != null || liveQuoteHtml != null)) {
    const html = liveQuoteHtml != null ? liveQuoteHtml : quotedBodyHtml;
    if (isEmptyQuoteHtml(html)) return { quotedBodyHtml: '' };
    return { ...(quotedBody ? { quotedBody } : {}), quotedBodyHtml: html };
  }
  return quotedBody ? { quotedBody } : {};
}
