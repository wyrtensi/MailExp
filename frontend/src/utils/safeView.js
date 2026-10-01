// Safe view of a letter (R-41 in docs/architecture/mail-node-research/eop-panel-requirements.md):
// a letter in the account's Spam folder, or one Microsoft EOP marked as phishing or malware
// wherever it lies, opens as plain text until the reader asks for it in full. The sender, the
// recipients and the toolbar stay as usual; the body has no images, no remote resources, no styles
// and no clickable links, every link shows where it really goes, and the attachments cannot be
// opened from it. Replies, forwards and prints of such a letter quote this text, not its HTML.

// ── Which letters ──────────────────────────────────────────────────────────────────────────────

// EOP categories (the CAT field of X-Forefront-Antispam-Report, stored by the sync as eop_category)
// that lock a letter in safe view in any folder, and the reason each one shows. Codes from
// Microsoft's "Anti-spam message headers" page: impersonation (DIMP, UIMP, GIMP, BIMP) and
// intra-organization phishing (INTOS) read as phishing; the anti-malware policy (AMP), Safe
// Attachments (SAP) and the common attachments filter (FTBP) as malware.
const LOCKED_CATEGORIES = {
  PHSH: 'phishing',
  HPHSH: 'phishing',
  HPHISH: 'phishing',
  INTOS: 'phishing',
  DIMP: 'phishing',
  UIMP: 'phishing',
  GIMP: 'phishing',
  BIMP: 'phishing',
  MALW: 'malware',
  AMP: 'malware',
  SAP: 'malware',
  FTBP: 'malware',
};

// { reason, locked } for a letter that opens in safe view (locked) or only under a warning, or null
// for a normal letter. A spoofed sender locks the letter in Spam; elsewhere EOP delivered it on
// purpose (an allowed sender, say), so it only warns. The category names the danger more precisely
// than the folder does, so it wins over "in Spam".
export function safeViewState({ inSpamFolder = false, eopCategory = null } = {}) {
  const category = String(eopCategory || '').toUpperCase();
  const reason = LOCKED_CATEGORIES[category];
  if (reason) return { reason, locked: true };
  if (category === 'SPOOF') return { reason: 'spoof', locked: Boolean(inSpamFolder) };
  return inSpamFolder ? { reason: 'spam', locked: true } : null;
}

// The account's Spam folders: the folder mapped as spam, else every \Junk folder and every folder
// whose name looks like one. Mirrors resolveAllSpamPaths on the backend; keep the name list in sync.
const SPAM_NAME_RE = /(spam|junk|bulk|indesiderata|spamverdacht|courrier\s*ind|posta\s*indesiderata)/i;
export function spamFolderPaths(account, folders) {
  const mapped = account?.folder_mappings?.spam;
  if (mapped) return new Set([mapped]);
  return new Set((folders || []).filter(f =>
    f.special_use === '\\Junk' || SPAM_NAME_RE.test(f.name || ''),
  ).map(f => f.path));
}

// ── Invisible characters ───────────────────────────────────────────────────────────────────────

// Built from code points so no invisible character sits in this source file.
const cp = (code) => String.fromCodePoint(code);
// Bidi overrides, embeddings and isolates reorder what follows them (RLO turns "gpj.exe" into
// "exe.jpg"): written out as [U+202E]. Marks (LRM, RLM, ALM) and zero-width characters only hide.
const BIDI_CONTROL_RE = new RegExp(`[${cp(0x202A)}-${cp(0x202E)}${cp(0x2066)}-${cp(0x2069)}]`, 'g');
const HIDDEN_RE = new RegExp(
  `[${cp(0xAD)}${cp(0x61C)}${cp(0x200B)}-${cp(0x200F)}${cp(0x2060)}-${cp(0x2064)}${cp(0xFEFF)}${cp(0xE000)}]`, 'g');
// C0 controls other than tab and line feed, and DEL.
const CONTROL_RE = new RegExp(`[${cp(0)}-${cp(8)}${cp(0xB)}-${cp(0x1F)}${cp(0x7F)}]`, 'g');
const codeOf = (ch) => `[U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`;

// Letter text: reordering controls shown, hidden characters dropped.
function cleanText(value) {
  return String(value).replace(CONTROL_RE, '').replace(HIDDEN_RE, '').replace(BIDI_CONTROL_RE, codeOf);
}
// An address: every invisible character shown, nothing dropped, so nothing hides in it.
function revealAll(value) {
  return String(value).replace(CONTROL_RE, codeOf).replace(HIDDEN_RE, codeOf).replace(BIDI_CONTROL_RE, codeOf);
}

// ── Link targets ───────────────────────────────────────────────────────────────────────────────

const MAX_ADDRESS = 200;

function asciiDomain(domain) {
  try { return new URL(`http://${domain}/`).hostname; } catch { return revealAll(domain); }
}

// Where a link really goes, as the browser would read it: the WHATWG URL's href (control and
// non-ASCII characters percent-encoded, the host in punycode, user info such as
// "paypal.com@" kept in sight) and the host on its own. An address the parser refuses is shown
// as written, every invisible character spelled out and spaces and brackets encoded so it cannot
// pass for two addresses. Over MAX_ADDRESS characters it is cut with an ellipsis; `full` keeps it.
export function describeTarget(raw) {
  let value = String(raw || '').trim();
  if (value.startsWith('//')) value = `https:${value}`;
  let url = null;
  try { url = new URL(value); } catch { /* relative or broken: shown as written */ }
  let full;
  let host = null;
  if (url) {
    full = url.href;
    if (url.protocol === 'mailto:') {
      const address = decodeURIComponent(url.pathname.split(',')[0] || '');
      const at = address.lastIndexOf('@');
      if (at > 0) host = asciiDomain(address.slice(at + 1));
    } else if (url.hostname) {
      host = url.hostname;
    }
  } else {
    full = revealAll(value.replace(/[\t\n\r <>[\]"`]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`));
  }
  const shown = full.length > MAX_ADDRESS ? `${full.slice(0, MAX_ADDRESS)}…` : full;
  return { shown, full, host };
}

// The words of a link say the same as its target: printed once.
function sameAsTarget(words, raw) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/^mailto:/, '').replace(/\/+$/, '');
  return Boolean(words) && norm(words) === norm(raw);
}

// ── Segments: the letter as text and link targets ──────────────────────────────────────────────

// Elements whose text is never part of what the letter says.
const SKIPPED = new Set(['HEAD', 'TITLE', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'OBJECT', 'IFRAME']);
// Elements that start and end on their own line.
const BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL',
]);
// Stands in for a link while the text around it is tidied; dropped from the letter's own text.
const MARK = cp(0xE000);
const MARK_RE = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

// The text of an HTML letter: [string | { href, words, form }]. DOMParser builds an inert
// document: nothing in it runs, loads or fetches. Images are dropped; a link becomes its words and
// its target; a form shows where it would send what is typed into it.
function htmlSegments(html) {
  const Parser = globalThis.DOMParser;
  if (!Parser) return [];
  const doc = new Parser().parseFromString(String(html), 'text/html');
  const links = [];
  const out = [];
  const pushLink = (link) => { out.push(`${MARK}${links.length}${MARK}`); links.push(link); };

  const walk = (node, pre) => {
    if (node.nodeType === 3) {
      const text = cleanText(node.nodeValue);
      out.push(pre ? text : text.replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    if (SKIPPED.has(tag)) return;
    if (tag === 'BR') { out.push('\n'); return; }
    if (tag === 'A' && (node.getAttribute('href') || '').trim() && !node.getAttribute('href').trim().startsWith('#')) {
      const href = node.getAttribute('href').trim();
      const words = cleanText(node.textContent).replace(/\s+/g, ' ').trim();
      pushLink({ href, words: sameAsTarget(words, href) ? '' : words, form: false });
      return;
    }
    const block = BLOCKS.has(tag);
    if (block) out.push('\n');
    const inPre = pre || tag === 'PRE';
    for (const child of node.childNodes) walk(child, inPre);
    if (tag === 'FORM' && (node.getAttribute('action') || '').trim()) {
      out.push(' ');
      pushLink({ href: node.getAttribute('action').trim(), words: '', form: true });
    }
    if (tag === 'TD' || tag === 'TH') out.push(' ');
    if (block) out.push('\n');
  };
  walk(doc.body || doc.documentElement, false);

  const text = out.join('')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const segments = [];
  let last = 0;
  for (const match of text.matchAll(MARK_RE)) {
    if (match.index > last) segments.push(text.slice(last, match.index));
    segments.push(links[Number(match[1])]);
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push(text.slice(last));
  return segments;
}

const ADDRESS_RE = /(?:https?:\/\/|mailto:)[^\s<>"']+/gi;

// A plain-text letter keeps its layout; its web and mail addresses become link targets.
function textSegments(text) {
  const clean = cleanText(text);
  const segments = [];
  let last = 0;
  for (const match of clean.matchAll(ADDRESS_RE)) {
    if (match.index > last) segments.push(clean.slice(last, match.index));
    segments.push({ href: match[0], words: '', form: false });
    last = match.index + match[0].length;
  }
  if (last < clean.length) segments.push(clean.slice(last));
  return segments;
}

// The letter in safe view. Whenever it has HTML the text comes from the HTML, which is what the
// letter shows; a text part can say something else entirely. The text part only when there is no HTML.
export function safeViewSegments(body) {
  if (body?.html) return htmlSegments(body.html);
  return textSegments(typeof body?.text === 'string' ? body.text : '');
}

// The words that introduce a target, in the reader's language (message.safeView.linkTo / formTo).
const DEFAULT_LABELS = { link: 'link to', form: 'form sends to' };

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Plain text, for printing and for quoting in a reply or forward:
// "verify your account [link to evil.example: https://evil.example/login]".
export function safeViewPlainText(body, labels = DEFAULT_LABELS) {
  return safeViewSegments(body).map((segment) => {
    if (typeof segment === 'string') return segment;
    const { shown, host } = describeTarget(segment.href);
    const label = segment.form ? labels.form : labels.link;
    const target = `[${label} ${host ? `${host}: ` : ''}${shown}]`;
    return segment.words ? `${segment.words} ${target}` : target;
  }).join('');
}

// Markup for one innerHTML write (a browser translator then has none of React's nodes to break;
// the body opts back into translation with translate="yes"). Everything is escaped; a link is its
// words, then its labelled target with the host in bold, isolated left-to-right so neighbouring
// text cannot reorder it. No element is a link.
export function safeViewMarkup(body, labels = DEFAULT_LABELS) {
  return safeViewSegments(body).map((segment) => {
    if (typeof segment === 'string') return escapeHtml(segment);
    const { shown, full, host } = describeTarget(segment.href);
    const label = segment.form ? labels.form : labels.link;
    const words = segment.words ? `<span class="safe-view-words">${escapeHtml(segment.words)}</span> ` : '';
    return `${words}<span class="safe-view-target" title="${escapeHtml(full)}">`
      + `<span class="safe-view-target-label">${escapeHtml(label)}</span> `
      + (host ? `<strong class="safe-view-host" dir="ltr">${escapeHtml(host)}</strong> ` : '')
      + `<span class="safe-view-address" dir="ltr">${escapeHtml(shown)}</span></span>`;
  }).join('');
}

// What a reply or forward of a letter in safe view quotes: the safe text, as text and as an
// escaped <pre>, never the letter's own HTML (its images would load in the composer).
export function safeQuoteSource(body, labels = DEFAULT_LABELS) {
  const text = safeViewPlainText(body, labels);
  return {
    text,
    html: `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(text)}</pre>`,
  };
}
