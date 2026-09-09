import { LoadingScene } from "../render/loadingScene";
import type { DataSource } from "../vfs/types";

// The screen the game puts up while it is replacing itself.
//
// It cannot be dismissed, and that is the point: between "yes, fetch it" and "the new build is
// on disk" there is a download the player must not be able to wander away from into a match —
// they would be playing on a build that is about to be swapped underneath them, and the restart
// would take the match with it. Every other modal in the game closes on Escape or its own
// button; this one has neither.
//
// The bar is the GAME'S OWN load bar (`LoadBar.mdx`, render/loadingScene.ts), drawn by the same
// code and seeked the same way as the one a match loads behind. A progress bar drawn in CSS
// would be a second answer to what a filling bar looks like in this game, and the first answer
// is already correct.
//
// It also puts up the modal scrim every other panel uses, so the screen behind it stops
// answering the keyboard for free — `anyModalOpen` (ui/modal.ts) asks about exactly that class.

/** The authored UI box every one of these coordinates is in (`ui/fdf/layout.ts`). The loading
 *  screen is STRETCHED to the viewport rather than height-scaled, so a fraction of the box is a
 *  fraction of the screen on both axes and the DOM can be placed in percentages. */
const UI_H = 0.6;

/**
 * The bar's own vertical CENTRE, which is where the percentage goes — inside the bar, rather than
 * at `LoadingBarText`'s anchor (the game prints "Loading..." there, and that string is not trying
 * to sit in the middle of the fill).
 *
 * MEASURED off the running screen, because the file cannot answer it: `Loading.fdf` anchors the
 * bar sprite at `BOTTOMLEFT … 0.0025`, but that is the SPRITE'S BOX and not the art — the drawn
 * bar sits well above it, and taking the file's number put the percentage 31 px below the middle.
 * At 1600×900 the bar's chrome spans y 779…833 against a 1500 px/unit scale, so it runs from
 * 0.0447 to 0.0807 and its centre is here. The top agrees with the 0.08 `ui/loadingScreen.ts`
 * measured separately for its blurb to clear, which is the cross-check that this is the bar and
 * not something else in the picture.
 */
const BAR_CENTRE_Y = 0.0627;

/** The line above the bar, far enough over it to clear that same top edge. */
const CAPTION_Y = 0.108;

/** Type size: `StandardLabelTextTemplate`'s own `FrameFont`, the size the game sets its bar
 *  caption in. Expressed against the viewport HEIGHT because the box is 0.6 of it. */
const FONT = 0.013;

export interface UpdateOverlay {
  /** 0…1. Moves the bar and rewrites the percentage. */
  setProgress(p: number): void;
  /** What the game is doing — it downloads and then restarts, and the player is told which. */
  setCaption(text: string): void;
  dispose(): void;
}

export async function showUpdateOverlay(
  container: HTMLElement,
  vfs: DataSource,
  version: string | null,
): Promise<UpdateOverlay> {
  const scrim = document.createElement("div");
  // The same class every modal uses: it darkens the menu AND stands the keyboard down.
  scrim.className = "glue-dialog-scrim dimmed update-overlay";

  const canvas = document.createElement("canvas");
  canvas.className = "update-overlay-canvas";
  scrim.appendChild(canvas);

  const caption = document.createElement("p");
  caption.className = "update-overlay-caption";
  caption.textContent = version ? `Downloading OpenWar3 ${version}…` : "Downloading the update…";
  caption.style.bottom = `${(CAPTION_Y / UI_H) * 100}%`;
  caption.style.fontSize = `${(FONT / UI_H) * 100}vh`;

  const percent = document.createElement("p");
  percent.className = "update-overlay-percent";
  percent.style.bottom = `${(BAR_CENTRE_Y / UI_H) * 100}%`;
  percent.style.fontSize = `${(FONT / UI_H) * 100}vh`;
  percent.textContent = "0%";

  scrim.append(caption, percent);
  container.appendChild(scrim);

  // Nothing gets out of here: no button, no Escape, and the scrim swallows the clicks. Captured
  // so the key never reaches the screen underneath either.
  const swallow = (e: Event): void => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener("keydown", swallow, true);

  const scene = new LoadingScene(canvas, vfs, true);
  // The bar alone — no background. If its model cannot be read the overlay still stands, with
  // the caption and the percentage doing the whole job: a failure to load ART must not leave the
  // player with no sign that the game is busy replacing itself.
  await scene.load(null).catch((err) => console.warn("[OpenWar3] update bar unavailable:", err));
  scene.start();
  scene.setProgress(0);

  return {
    setProgress(p: number): void {
      scene.setProgress(p);
      percent.textContent = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
    },
    setCaption(text: string): void {
      caption.textContent = text;
    },
    dispose(): void {
      window.removeEventListener("keydown", swallow, true);
      scene.dispose();
      scrim.remove();
    },
  };
}
