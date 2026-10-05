// Elements that show something without any text: images and other media, a rule, a table (banner
// mail lays out its pictures in tables).
const VISIBLE_WITHOUT_TEXT_RE = /<(img|svg|video|audio|picture|object|embed|iframe|canvas|hr|table)\b/i;
// A background picture: a CSS background-image or url(), or the legacy background attribute.
const BACKGROUND_RE = /background-image\s*:|\bbackground\s*:[^;"'>]*url\(|\sbackground\s*=/i;

// Whether a rich quote holds nothing a reader would see: no text, no media, no background picture.
// A contentEditable the writer cleared still keeps markup such as <br> or <div><br></div>.
export function isEmptyQuoteHtml(html) {
  if (!html) return true;
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  if (VISIBLE_WITHOUT_TEXT_RE.test(markup) || BACKGROUND_RE.test(markup)) return false;
  const text = markup
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/[\s\u00a0\u200b\ufeff]/g, '');
  return text === '';
}

// The quote fields of a send or a draft save (POST /mail/send, /mail/draft).
// liveQuoteHtml: the rich quote as the writer left it in the composer (null when there is none).
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
