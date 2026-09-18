import type { Options } from "../data/options";

// The two scroll-speed rows of the Options screen's Gameplay panel — "Mouse Scroll:",
// "Disable Mouse Scroll" and "Keyboard Scroll:" — as a module singleton the camera reads,
// exactly as render/videoQuality.ts is the singleton the renderer reads and
// render/worldOverlays.ts is the one the bars read. The camera lives in the 13 000-line
// MapViewerScene; the three lines of state behind these rows do not belong in it.
//
// WC3's own panel has the two sliders and the checkbox (UI\FrameDef\Glue\OptionsMenu.fdf and
// UI\FrameDef\UI\EscMenuOptionsPanel.fdf both carry them), but what a notch on either slider
// MEANS is engine-internal — it is in no .slk, .txt or .fdf in the install, and MiscData/
// MiscGame say nothing about scrolling at all. So the CURVE below is OURS and says so, and it
// is anchored on the one number we do know: the middle of the slider is the speed OpenWar3 has
// always panned at, so a player who never touches the row is where they were.

/** The pan multiplier a 0–100 slider notch means. Ours (see above): a doubling either side of
 *  the middle, so 0 is half today's speed, 50 is exactly it, and 100 is twice it. Exponential
 *  rather than linear because the slider is read as "how fast", and equal steps of a ratio are
 *  what that feels like — a linear 0.5→1.5 spends its whole top half between 1× and 1.5×. */
function scaleOf(notch: number): number {
  return 2 ** ((Math.max(0, Math.min(100, notch)) - 50) / 50);
}

let keyScale = 1;
let mouseScale = 1;
let mouseOn = true;

/** Push the Gameplay panel's scroll rows onto the camera. Called at boot with the committed
 *  options, and again by either Options screen on every change, so a drag is felt at once. */
export function applyScrollOptions(opts: Options): void {
  keyScale = scaleOf(typeof opts.keyScrollSpeed === "number" ? opts.keyScrollSpeed : 50);
  mouseScale = scaleOf(typeof opts.mouseScrollSpeed === "number" ? opts.mouseScrollSpeed : 50);
  mouseOn = opts.mouseScrollDisable !== true;
}

/** "Keyboard Scroll:" — what the arrow keys' pan speed is multiplied by. */
export function keyScrollScale(): number {
  return keyScale;
}

/** "Mouse Scroll:" — what edge-panning's speed is multiplied by, and 0 when "Disable Mouse
 *  Scroll" is ticked. One number rather than a scale plus a flag, because the caller's
 *  question is the same either way: how far does the edge move the camera this frame. */
export function edgeScrollScale(): number {
  return mouseOn ? mouseScale : 0;
}
