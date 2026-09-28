// Pure geometry for the floating compose window's drag/reposition logic (ComposeModal.jsx).
//
// All inputs and outputs live in one coordinate space: the same "layout" space the window's own
// width/height/top/left CSS values are in. That is NOT necessarily the real on-screen pixel grid
// — the whole app can render inside a `transform: scale(fontSize/100)` wrapper (see
// hooks/useUiScale.js), which becomes the containing block for this `position: fixed` window and
// scales it. Callers must convert real/visual measurements (getBoundingClientRect(), clientX/Y,
// window.innerWidth/innerHeight) into layout space with descale() from useUiScale.js BEFORE
// calling this function, the same way every other floating panel in ComposeModal.jsx already
// does for its own position. Passing a visual-space viewport with a layout-space window position
// (or vice versa) is exactly the bug this function exists to prevent.
//
// Only the title bar needs to stay fully reachable — the window's full width, at its top, for
// titleBarHeight px — not the whole (possibly much taller) window body below it.
export function clampComposePosition({ x, y }, { width, titleBarHeight }, { viewportWidth, viewportHeight }) {
  const maxX = Math.max(0, viewportWidth - width);
  const maxY = Math.max(0, viewportHeight - titleBarHeight);
  return {
    x: Math.max(0, Math.min(maxX, x)),
    y: Math.max(0, Math.min(maxY, y)),
  };
}

// Same coordinate-space contract as clampComposePosition (layout space, descale() before
// calling). Mirrors the window's own minimum size and edge margins — a little breathing room on
// the right, more at the bottom so the title bar / toolbar chrome never gets squeezed away.
const COMPOSE_MIN_WIDTH = 360;
const COMPOSE_MIN_HEIGHT = 200;
const COMPOSE_RIGHT_MARGIN = 16;
const COMPOSE_BOTTOM_MARGIN = 40;

export function clampComposeSize({ width, height }, { viewportWidth, viewportHeight }) {
  return {
    width: Math.min(viewportWidth - COMPOSE_RIGHT_MARGIN, Math.max(COMPOSE_MIN_WIDTH, width)),
    height: Math.min(viewportHeight - COMPOSE_BOTTOM_MARGIN, Math.max(COMPOSE_MIN_HEIGHT, height)),
  };
}
