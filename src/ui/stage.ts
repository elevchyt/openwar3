// The STAGE — the one game frame everything on screen is measured against.
//
// Warcraft III draws a 16:9 frame and lays its UI out inside it, so we do the same: the map
// renders into a fixed 1920x1080 buffer, and CSS scales that into the largest 16:9 box the
// window allows, letterboxing the rest (see `.stage-box` in style.css). Fullscreen on a 16:9
// display makes the box the whole screen and the bars vanish.
//
// The trap this module exists to close: an overlay that is positioned from CANVAS coordinates
// but parented to the WINDOW. While the canvas filled the window those were the same thing, so
// health bars, the drag box and the floating text all quietly relied on it — the moment the
// frame became a centred box, every one of them was off by the letterbox.
//
// So: anything anchored to a point IN THE WORLD goes in `worldLayer()`, whose box is exactly
// the canvas's, and anything laid out as UI is fitted to the element it is mounted in (which
// CSS has already sized to the stage). Nothing measures `window` any more.

export const GAME_WIDTH = 1920;
export const GAME_HEIGHT = 1080;
export const GAME_ASPECT = GAME_WIDTH / GAME_HEIGHT; // 16:9

/** The game frame's on-screen size in CSS px — the largest 16:9 box that fits the window.
 *  Mirrors the `--stage-w` / `--stage-h` custom properties CSS lays the box out with. */
export function stageSize(): { w: number; h: number } {
  const w = Math.min(window.innerWidth, window.innerHeight * GAME_ASPECT);
  return { w, h: w / GAME_ASPECT };
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
