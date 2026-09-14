// The STAGE — the one game frame everything on screen is measured against.
//
// Warcraft III 1.30 draws its frame at the screen's own aspect, from 4:3 up to 16:9, and lays
// its UI out inside it, so we do the same: the map renders into a buffer of the stage's aspect,
// and CSS scales that into the largest box of an aspect in [4:3, 16:9] the window allows,
// letterboxing only what is outside that range (see `.stage-box` in style.css). Fullscreen on a
// 4:3, 16:10 or 16:9 display makes the box the whole screen and the bars vanish (issue #151 —
// the frame used to be 16:9 whatever the screen, so a 4:3 monitor lost a quarter of its height).
//
// The trap this module exists to close: an overlay that is positioned from CANVAS coordinates
// but parented to the WINDOW. While the canvas filled the window those were the same thing, so
// health bars, the drag box and the floating text all quietly relied on it — the moment the
// frame became a centred box, every one of them was off by the letterbox.
//
// So: anything anchored to a point IN THE WORLD goes in `worldLayer()`, whose box is exactly
// the canvas's, and anything laid out as UI is fitted to the element it is mounted in (which
// CSS has already sized to the stage). Nothing measures `window` any more.

/** The LOGICAL game frame at 16:9 — the widest the stage gets, and what the Resolution rungs
 *  are named by (render/videoQuality.ts). A narrower stage keeps the height. */
export const GAME_WIDTH = 1920;
export const GAME_HEIGHT = 1080;
/** The widest stage: 16:9. Past it the lens would hand the player more map than WC3 does. */
export const GAME_ASPECT = GAME_WIDTH / GAME_HEIGHT;
/** The narrowest stage: 4:3, the aspect the console and every FDF file are authored at. */
export const MIN_GAME_ASPECT = 4 / 3;

/** The game frame's on-screen size in CSS px — the largest box of an aspect in [4:3, 16:9]
 *  that fits the window. Mirrors the `--stage-w` / `--stage-h` custom properties CSS lays the
 *  box out with. */
export function stageSize(): { w: number; h: number } {
  // No window is a headless test (tools/sim-options-test.cjs): the widest stage, the one the
  // Resolution rungs are named by.
  if (typeof window === "undefined") return { w: GAME_WIDTH, h: GAME_HEIGHT };
  return {
    w: Math.min(window.innerWidth, window.innerHeight * GAME_ASPECT),
    h: Math.min(window.innerHeight, window.innerWidth / MIN_GAME_ASPECT),
  };
}

/** The stage's aspect (width / height), always within [4:3, 16:9]. */
export function stageAspect(): number {
  const { w, h } = stageSize();
  return h > 0 ? w / h : GAME_ASPECT;
}

let layer: HTMLDivElement | null = null;

/** The layer world-anchored overlays live in: exactly the canvas's box, so a position in
 *  canvas CSS pixels can be written straight to `left`/`top` with no offset to remember.
 *  It clips (overflow: hidden), so a bar on a unit at the frame's edge stops at the edge
 *  instead of spilling over the letterbox. */
export function worldLayer(): HTMLElement {
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "world-layer";
    layer.className = "stage-box";
    document.body.appendChild(layer);
  }
  return layer;
}

/** Take the world layer off the page — the match that filled it is over. The cached node has
 *  to be dropped WITH it: keep the variable and the next match's bars are appended to a div
 *  that is no longer in the document, which looks exactly like "the health bars stopped
 *  working" and nothing like a teardown bug. */
export function disposeWorldLayer(): void {
  layer?.remove();
  layer = null;
}
