import { useCallback, useLayoutEffect, useRef } from 'react';

// Keyboard access to a list of rows (the sidebar's mailboxes and folders) as ONE tab stop: Tab
// reaches the list once, the arrow keys move between its rows, and Shift+F10 or the Menu key opens
// the row's context menu, which until now only a right-click could.
//
// A row is any element carrying `data-nav-row="<unique key>"`; the hook gives exactly one of them
// tabindex=0 (the one last focused, else the first) and the rest -1, by setting the attribute itself
// after every render, so the rows need no tabIndex of their own and a re-render cannot undo it.
// Only keys pressed ON a row are handled: an input or button inside it keeps its own keys.
//
// A row that can be expanded carries `aria-expanded` and a `data-nav-toggle` child (its chevron
// button): Right opens it, Left closes it.

const ROW = '[data-nav-row]';

const rowsOf = (container) => [...container.querySelectorAll(ROW)];

// Exactly one row is the tab stop: `activeKey`'s row if it is still there, else the first.
export function syncRovingTabindex(container, activeKey) {
  const rows = rowsOf(container);
  const stop = rows.find(row => row.dataset.navRow === activeKey) ?? rows[0];
  for (const row of rows) row.setAttribute('tabindex', row === stop ? '0' : '-1');
}

// Where a Shift+F10 menu should open: under the start of the row, as a mouse user's would.
function menuPoint(row) {
  const rect = row.getBoundingClientRect();
  return { x: Math.round(rect.left + Math.min(40, rect.width / 2)), y: Math.round(rect.bottom - 2) };
}

// Handles one keydown on the container. Returns true when it was a row key and was acted on.
export function handleRowKeyDown(event, container) {
  const row = event.target;
  if (typeof row?.matches !== 'function' || !row.matches(ROW) || !container.contains(row)) return false;
  const rows = rowsOf(container);
  const at = rows.indexOf(row);
  const go = (target) => { if (target) { target.focus({ preventScroll: false }); } };

  if (event.key === 'ArrowDown') go(rows[at + 1]);
  else if (event.key === 'ArrowUp') go(rows[at - 1]);
  else if (event.key === 'Home') go(rows[0]);
  else if (event.key === 'End') go(rows[rows.length - 1]);
  else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    const expanded = row.getAttribute('aria-expanded');
    const wantsOpen = event.key === 'ArrowRight';
    if (expanded === null || (expanded === 'true') === wantsOpen) return false;
    row.querySelector('[data-nav-toggle]')?.click();
  } else if (event.key === 'Enter' || event.key === ' ') {
    row.click();
  } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    const { x, y } = menuPoint(row);
    const view = row.ownerDocument.defaultView;
    row.dispatchEvent(new view.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  } else {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

// Props for the scroll container that holds the rows.
export function useRovingRows() {
  const containerRef = useRef(null);
  const activeKey = useRef(null);

  // After every render: rows come and go (folders load, accounts reorder), so re-apply.
  useLayoutEffect(() => {
    if (containerRef.current) syncRovingTabindex(containerRef.current, activeKey.current);
  });

  const onKeyDown = useCallback((event) => {
    if (containerRef.current) handleRowKeyDown(event, containerRef.current);
  }, []);

  const onFocus = useCallback((event) => {
    const row = typeof event.target?.matches === 'function' && event.target.matches(ROW) ? event.target : null;
    if (!row || !containerRef.current) return;
    activeKey.current = row.dataset.navRow;
    syncRovingTabindex(containerRef.current, activeKey.current);
  }, []);

  return { containerRef, onKeyDown, onFocus };
}
