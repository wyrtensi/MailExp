// The CAT field of Microsoft EOP's X-Forefront-Antispam-Report header: the category of the threat
// policy EOP applied to the letter (SPM, HSPM, BULK, PHSH, HPHSH, HPHISH, SPOOF, MALW, and with
// Defender for Office 365 AMP, SAP, FTBP, DIMP, UIMP, GIMP, BIMP, INTOS; Microsoft's "Anti-spam
// message headers" page). The panel reads it to show a dangerous letter in safe mode wherever it
// lies (R-41 in docs/architecture/mail-node-research/eop-panel-requirements.md); the Sieve rule
// R-11 files it.
//
// The header is a list of NAME:value fields separated by ';' and can arrive folded. A letter can
// carry the header more than once (parseRawHeaders joins the copies with '\n'), for instance a
// copy a sender wrote themselves next to the one EOP added. Every copy is read and the most
// dangerous category wins: a forged copy can only make the letter look more dangerous, never
// hide what EOP found. A value that is not a plain category name is ignored.

// Most dangerous first: malware, then phishing and impersonation, then spoofing. Anything else
// found is kept only when none of these is present.
const DANGER_ORDER = [
  'MALW', 'AMP', 'SAP', 'FTBP',
  'HPHISH', 'HPHSH', 'PHSH', 'INTOS', 'UIMP', 'DIMP', 'GIMP', 'BIMP',
  'SPOOF',
];
const CATEGORY_RE = /^[A-Z]{1,16}$/;

export function eopCategory(headerValue) {
  if (!headerValue) return null;
  const found = [];
  for (const field of String(headerValue).split(/[;\n]/)) {
    const colon = field.indexOf(':');
    if (colon < 0) continue;
    if (field.slice(0, colon).trim().toUpperCase() !== 'CAT') continue;
    // A letter with several categories is not documented; read a comma list. Spaces are not a
    // separator: unfolding turns a line break into one, and "PH SH" is not two categories.
    for (const value of field.slice(colon + 1).split(',')) {
      const category = value.trim().toUpperCase();
      if (CATEGORY_RE.test(category)) found.push(category);
    }
  }
  if (!found.length) return null;
  return DANGER_ORDER.find(category => found.includes(category)) ?? found[0];
}
