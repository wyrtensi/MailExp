// Safe view of a letter (R-41 in docs/architecture/mail-node-research/eop-panel-requirements.md):
// a letter in the account's Spam folder, or one Microsoft EOP marked as phishing, malware or a
// spoofed sender wherever it lies, opens as plain text until the reader asks for it in full. The
// sender, the recipients and the toolbar stay as usual; the body has no images, no remote
// resources, no styles and no clickable links, and the attachments cannot be opened from it.

// EOP categories (the CAT field of X-Forefront-Antispam-Report, stored by the sync as the body's
// eopCategory) that make a letter dangerous in any folder, and the reason each one shows.
const CATEGORY_REASONS = {
  PHSH: 'phishing',
  HPHSH: 'phishing',
  HPHISH: 'phishing',
  MALW: 'malware',
  SPOOF: 'spoof',
};

// Why the letter opens in safe view, or null when it opens normally. The EOP category names the
// danger more precisely than the folder does, so it wins over "in Spam".
export function safeViewReason({ inSpamFolder = false, eopCategory = null } = {}) {
  const fromCategory = CATEGORY_REASONS[String(eopCategory || '').toUpperCase()];
  if (fromCategory) return fromCategory;
  return inSpamFolder ? 'spam' : null;
}

// Elements whose text is never part of what the letter says.
const SKIPPED = new Set(['HEAD', 'TITLE', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'OBJECT', 'IFRAME']);
// Elements that start and end on their own line.
const BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL',
]);

// The text of an HTML letter, with every link's target written out next to its words, so the
// reader sees where a link really goes. DOMParser builds an inert document: nothing in it runs,
// loads or fetches. Images are dropped.
export function htmlToSafeText(html) {
  if (!html) return '';
  const Parser = globalThis.DOMParser;
  if (!Parser) return '';
  const doc = new Parser().parseFromString(String(html), 'text/html');
  const out = [];
  const newline = () => { out.push('\n'); };

  const walk = (node, pre) => {
    if (node.nodeType === 3) {
      out.push(pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    if (SKIPPED.has(tag)) return;
    if (tag === 'BR') { newline(); return; }
    const block = BLOCKS.has(tag);
    if (block) newline();
    const inPre = pre || tag === 'PRE';
    for (const child of node.childNodes) walk(child, inPre);
    if (tag === 'A') {
      const href = (node.getAttribute('href') || '').trim();
      const words = node.textContent.replace(/\s+/g, ' ').trim();
      if (href && !href.startsWith('#') && href !== words && `mailto:${words}` !== href) out.push(` <${href}>`);
    }
    if (tag === 'TD' || tag === 'TH') out.push(' ');
    if (block) newline();
  };
  walk(doc.body || doc.documentElement, false);

  return out.join('')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// What the safe view shows: the letter's own text part, or the text of its HTML when it has none.
export function safeViewText(body) {
  const text = typeof body?.text === 'string' ? body.text : '';
  if (text.trim()) return text;
  return htmlToSafeText(body?.html || '');
}

const escapeHtml = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const ADDRESS_RE = /(?:https?:\/\/|mailto:)[^\s<>"']+/gi;

// The safe text as markup for one innerHTML write: escaped, web and mail addresses marked so they
// read as addresses but are not links. One write keeps a browser translator off React's own nodes
// (index.html has translate="no" on <html>; the body opts back in with translate="yes").
export function safeTextMarkup(text) {
  const raw = String(text || '');
  let out = '';
  let last = 0;
  for (const match of raw.matchAll(ADDRESS_RE)) {
    out += escapeHtml(raw.slice(last, match.index));
    out += `<span class="safe-view-address">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  return out + escapeHtml(raw.slice(last));
}
