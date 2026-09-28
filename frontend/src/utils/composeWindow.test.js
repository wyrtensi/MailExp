import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampComposePosition, clampComposeSize } from './composeWindow.js';

const VIEWPORT = { viewportWidth: 1200, viewportHeight: 800 };
const WINDOW = { width: 760, titleBarHeight: 44 };

describe('clampComposePosition', () => {
  it('leaves an in-bounds position unchanged', () => {
    assert.deepEqual(
      clampComposePosition({ x: 200, y: 100 }, WINDOW, VIEWPORT),
      { x: 200, y: 100 },
    );
  });

  it('pulls the window back when dragged past the right/bottom edge', () => {
    assert.deepEqual(
      clampComposePosition({ x: 5000, y: 5000 }, WINDOW, VIEWPORT),
      { x: VIEWPORT.viewportWidth - WINDOW.width, y: VIEWPORT.viewportHeight - WINDOW.titleBarHeight },
    );
  });

  it('pulls the window back when dragged past the left/top edge', () => {
    assert.deepEqual(
      clampComposePosition({ x: -400, y: -400 }, WINDOW, VIEWPORT),
      { x: 0, y: 0 },
    );
  });

  it('only constrains the title-bar strip, not the whole window height', () => {
    // A window taller than the viewport can still have its (much shorter) title bar
    // fully on screen — the body is allowed to run below the fold.
    const tallWindow = { width: 760, titleBarHeight: 44 };
    const result = clampComposePosition({ x: 100, y: 780 }, tallWindow, VIEWPORT);
    assert.equal(result.y, VIEWPORT.viewportHeight - tallWindow.titleBarHeight);
  });

  it('keeps x at 0 when the window is wider than the viewport (nothing better to do)', () => {
    const wideWindow = { width: 1400, titleBarHeight: 44 };
    const result = clampComposePosition({ x: 50, y: 0 }, wideWindow, VIEWPORT);
    assert.equal(result.x, 0);
  });

  it('keeps y at 0 when the title bar itself is taller than the viewport', () => {
    const result = clampComposePosition({ x: 0, y: 50 }, { width: 760, titleBarHeight: 900 }, VIEWPORT);
    assert.equal(result.y, 0);
  });

  it('is idempotent — clamping an already-clamped position is a no-op', () => {
    const once = clampComposePosition({ x: 5000, y: 5000 }, WINDOW, VIEWPORT);
    const twice = clampComposePosition(once, WINDOW, VIEWPORT);
    assert.deepEqual(once, twice);
  });
});

describe('clampComposeSize', () => {
  it('leaves an in-bounds size unchanged', () => {
    assert.deepEqual(
      clampComposeSize({ width: 760, height: 500 }, VIEWPORT),
      { width: 760, height: 500 },
    );
  });

  it('pulls the width/height back to the viewport minus its edge margins when grown too far', () => {
    assert.deepEqual(
      clampComposeSize({ width: 5000, height: 5000 }, VIEWPORT),
      { width: VIEWPORT.viewportWidth - 16, height: VIEWPORT.viewportHeight - 40 },
    );
  });

  it('never shrinks below the minimum size, even when the viewport itself is smaller', () => {
    assert.deepEqual(
      clampComposeSize({ width: 10, height: 10 }, VIEWPORT),
      { width: 360, height: 200 },
    );
  });

  it('is idempotent — clamping an already-clamped size is a no-op', () => {
    const once = clampComposeSize({ width: 5000, height: 5000 }, VIEWPORT);
    const twice = clampComposeSize(once, VIEWPORT);
    assert.deepEqual(once, twice);
  });
});
