// The WIDESCREEN blend — how a glue-screen value tuned at 16:9 becomes the right value at the
// window's actual aspect (issue #151).
//
// Every glue FDF is authored in a 0.8 × 0.6 box, i.e. for a 4:3 screen, and the panel chrome
// under it is a 3D model authored in the same proportions. `fitBox` (ui/fdf/layout.ts) scales
// the UI by HEIGHT and lets the root run to the window's edges, which is what WC3's own
// widescreen glue does — but on a wide screen the chrome then has width the file never
// planned for, and a handful of corrections were tuned by eye against a 16:9 reference to take
// it up: the chrome drawn wider than its authored aspect (`MenuScene.tuning.panelStretchX` and
// friends), the menu buttons widened to fill it (`buttonWidthScale`), and the map-info panes
// nudged left to sit inside it (`nudgeX` call sites).
//
// Every one of those is a share of the EXTRA width a wide screen has over 4:3, and a 4:3 screen
// has none. Applied flat, they drew the right-hand chrome a third wider than the room there is
// for it, straight over the left-hand panel and the contents the file anchors there. So each is
// stated as its 16:9 value and blended: nothing at 4:3 (the file's own layout, which is also the
// one the models were built for), the tuned amount at 16:9, and linear between — linear because
// the chrome's viewport is height-based and right-anchored, so the width it has to absorb grows
// exactly with the aspect. Past 16:9 the value is held rather than extrapolated: that is the
// layout the reference was measured against, and an ultrawide keeps getting it.

/** 4:3, the aspect the glue FDFs and their chrome are authored at. */
export const AUTHORED_ASPECT = 4 / 3;
/** 16:9, the aspect the widescreen corrections were tuned against. */
export const TUNED_ASPECT = 16 / 9;

/** How far `aspect` is from 4:3 towards 16:9: 0 at 4:3 or narrower, 1 at 16:9 or wider. */
export function widescreenShare(aspect: number = windowAspect()): number {
  const t = (aspect - AUTHORED_ASPECT) / (TUNED_ASPECT - AUTHORED_ASPECT);
  return Math.min(1, Math.max(0, t));
}

/** A value tuned at 16:9 (`at169`), blended back to what it is at 4:3 (`at43`) for `aspect`.
 *  `widescreen(1.35, 1)` is a stretch; `widescreen(0.052)` a nudge, which is 0 at 4:3. */
export function widescreen(at169: number, at43 = 0, aspect: number = windowAspect()): number {
  return at43 + (at169 - at43) * widescreenShare(aspect);
}

/** The glue screens fill the WINDOW (only a match re-boxes #ui to the game frame), so this is
 *  the aspect a glue screen is laid out at — unless "4:3 Menus" has boxed them, in which case
 *  it is that box's, and every correction above comes out at its 4:3 value by itself. */
export function windowAspect(): number {
  const aspect = window.innerHeight > 0 ? window.innerWidth / window.innerHeight : TUNED_ASPECT;
  const boxed = fixedMenuAspect && !document.body.classList.contains("in-game");
  return boxed ? Math.min(aspect, AUTHORED_ASPECT) : aspect;
}

// Options → Video → "4:3 Menus". 1.30.4 draws its glue screens in a 4:3 box with black bars at
// the sides on a wide screen — measured off the real client at 1920x1080, where the main menu
// fills the middle 1440x1080 and the rest is black — while OpenWar3 spreads them to the window's
// edges and lets the corrections above take up the extra width. The row puts the original back.
// The box itself is CSS (`body.menus-4x3` in style.css, the same rule a window narrower than 4:3
// already gets); this flag is the half that tells `windowAspect` so.
let fixedMenuAspect = false;

/** Box the menus to 4:3 (or stop). Re-lays whatever glue screen is up: every FDF screen and the
 *  menu scene measure their own element, and the screens re-fit on `resize`, which a class
 *  change does not fire by itself. A match is untouched — the rule and `windowAspect` both stand
 *  down while `body.in-game` is set. */
export function setFixedMenuAspect(on: boolean): void {
  if (typeof document === "undefined") return; // headless (the options test compiles this file)
  if (on === fixedMenuAspect) return;
  fixedMenuAspect = on;
  document.body.classList.toggle("menus-4x3", on);
  window.dispatchEvent(new Event("resize"));
}
