// The CAT field of Microsoft EOP's X-Forefront-Antispam-Report header: the category EOP gave the
// letter (SPM, HSPM, PHSH, HPHSH, HPHISH, SPOOF, MALW, BULK, NONE, ...). The panel reads it to
// show a dangerous letter in safe mode wherever it lies (R-41 in
// docs/architecture/mail-node-research/eop-panel-requirements.md); the Sieve rule R-11 files it.
//
// The header is a list of NAME:value fields separated by ';' and can arrive folded. A letter can
// carry the header more than once (parseRawHeaders joins the copies with '\n'), for instance a
// copy a sender wrote themselves next to the one EOP added. Every copy is read and the most
// dangerous category wins: a forged copy can only make the letter look more dangerous, never
// hide what EOP found. A value that is not a plain category name is ignored.

// Most dangerous first. Anything else found is kept only when none of these is present.
const DANGER_ORDER = ['MALW', 'HPHISH', 'HPHSH', 'PHSH', 'SPOOF'];
const CATEGORY_RE = /^[A-Z]{1,16}$/;

export function eopCategory(headerValue) {
  if (!headerValue) return null;
  const found = [];
  for (const field of String(headerValue).split(/[;\n]/)) {
    const colon = field.indexOf(':');
    if (colon < 0) continue;
    if (field.slice(0, colon).trim().toUpperCase() !== 'CAT') continue;
    // A letter with several categories is not documented; read a comma or space list either way.
    for (const value of field.slice(colon + 1).split(/[,\s]+/)) {
      const category = value.trim().toUpperCase();
      if (CATEGORY_RE.test(category)) found.push(category);
    }
  }
  if (!found.length) return null;
  return DANGER_ORDER.find(category => found.includes(category)) ?? found[0];
}
