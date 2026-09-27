// The reading pane's toolbar: which buttons carry their name next to the icon. Pure functions,
// so they run under `node --test`.

// Buttons in the order their names are given up when the row gets tight: the everyday actions
// keep theirs longest.
export const LABEL_RANK = Object.freeze({
  reply: 1, forward: 2, archive: 3, delete: 4, move: 5,
  star: 6, unread: 7, spam: 8, headers: 9, print: 10, eml: 11, task: 12, ai: 13,
});
export const ALL_LABELS = Object.keys(LABEL_RANK).length;

// How many names to try first: all of them, none on a phone (its toolbar is narrow and the rest
// sits in the More menu) or before the toolbar is measured. The pane then drops one name per
// render while the row overflows (fewerLabels), so what shows is whatever fits in this language.
export function initialLabelCount(width, isMobile) {
  return isMobile || !width ? 0 : ALL_LABELS;
}

export function fewerLabels(count) {
  return Math.max(0, count - 1);
}

// Whether the button of this kind shows its name when `count` names fit.
export function showsLabel(kind, count) {
  const rank = LABEL_RANK[kind];
  return !!rank && rank <= count;
}
