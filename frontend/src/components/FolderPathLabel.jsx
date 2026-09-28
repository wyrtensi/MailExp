import { useLayoutEffect, useRef, useState } from 'react';
import { folderParentLabel } from '../utils/folderDisplay.js';

// Folder name prefixed with its muted ancestor path ("Personal / Insurance"),
// used by every move-to-folder picker so duplicate names under different
// parents stay distinguishable. Long labels truncate at rest (the parent
// chain shrinks first); hovering a label that overflows slides the text left
// marquee-style to reveal the clipped remainder, and it snaps back on leave.
//
// A favorite carrying a custom `favoriteLabel` (#505) displays that instead of the real
// folder name — the same substitution the sidebar's favorites list already makes — and the
// real name moves to a tooltip rather than disappearing.
export default function FolderPathLabel({ folder }) {
  const parent = folderParentLabel(folder);
  const displayName = folder.favoriteLabel || folder.name || folder.path;
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [shift, setShift] = useState(0);

  // While hovered the segments stop shrinking (natural width), so the overflow
  // can be measured and slid into view; measuring the at-rest layout would only
  // see the already-clipped spans.
  useLayoutEffect(() => {
    if (!hovered) { setShift(0); return; }
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const overflow = content.scrollWidth - viewport.clientWidth;
    setShift(overflow > 1 ? overflow : 0);
  }, [hovered]);

  const segmentStyle = {
    minWidth: 0,
    flexShrink: hovered ? 0 : 1,
    overflow: hovered ? 'visible' : 'hidden',
    textOverflow: 'ellipsis',
  };

  return (
    <span
      ref={viewportRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={folder.favoriteLabel ? (folder.name || folder.path) : undefined}
      style={{ flex: 1, minWidth: 0, display: 'flex', overflow: 'hidden', whiteSpace: 'nowrap' }}
    >
      <span
        ref={contentRef}
        style={{
          display: 'flex', alignItems: 'center', minWidth: 0,
          transform: shift ? `translateX(${-shift}px)` : 'none',
          // The reveal pace scales with distance; the short delay keeps quick
          // mouse passes over the list from triggering a distracting slide.
          transition: shift
            ? `transform ${Math.max(0.4, shift / 80)}s linear 0.3s`
            : 'transform 0.2s ease-out',
        }}
      >
        {parent && (
          <span style={{ ...segmentStyle, color: 'var(--text-tertiary)' }}>
            {parent}{' / '}
          </span>
        )}
        <span style={segmentStyle}>
          {displayName}
        </span>
      </span>
    </span>
  );
}
