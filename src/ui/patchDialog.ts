import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { ProgressBarScene, PROGRESS_BAR_H, PROGRESS_BAR_W } from "../render/progressBarScene";
import type { DataSource } from "../vfs/types";

// The dialog Warcraft III showed while something downloaded: `BattleNetPatchDialog`
// (`UI\FrameDef\Glue\MainMenu.fdf`), the box the game put up while Battle.net handed it a patch —
// the dialogue box, a gold title, one line of text, `BattlenetProgressBar.mdl` filling itself
// (render/progressBarScene.ts) and one button, Cancel while it runs and OK once it is done.
//
// Two things fetch through it: Voice Control's speech model (ui/voiceDownload.ts) and a LAN
// game's map, from the host, when the joiner's install lacks it (ui/mapDownload.ts). This file is
// the box and its bar; the words and the fetch are theirs.
//
// Mounted straight out of the player's install; nothing here draws chrome of its own. A MODAL
// over whatever screen opened it (`glue-dialog-scrim`, so `anyModalOpen` stands the keyboard
// down), and it can be left: the button or Escape calls `onClose`, which the caller answers by
// aborting whatever it was fetching.

const MAIN_MENU_FDF = "UI\\FrameDef\\Glue\\MainMenu.fdf";

/** The patch dialog's width (`BattleNetPatchDialog` Width), which every placement is scaled by. */
const DIALOG_W = 0.35;

/**
 * The bar's BOTTOM above the dialog's bottom edge. The FDF says `SetPoint BOTTOM …, 0.07875` of a
 * frame with no size, and nothing says how the engine sat a model in a sizeless sprite; taken as
 * the art's own bottom edge it puts the bar over the second line of the text. 0.06 is measured
 * off the running dialog instead: the bar's drawn body (the middle ~40% of its art — the rest is
 * glow) then sits in the middle of the band between the button's top (0.052) and the text,
 * clear of the button rather than resting on it.
 */
const BAR_BOTTOM = 0.06;

/** How much larger than authored the bar is drawn. Ours: at the art's own 0.229 it read small
 *  in a 0.35 box. Uniform, so the border's end caps keep their shape. */
const BAR_SCALE = 1.15;

export interface PatchDialogOptions {
  container: HTMLElement;
  vfs: DataSource;
  title: string;
  info: string;
  /** Marks the scrim, so a caller's own styles and a test can find the box. */
  className: string;
  /** The button or Escape. The dialog is already gone when this runs. */
  onClose: () => void;
}

export interface PatchDialog {
  setProgress(fraction: number): void;
  /** Rewrite the one line while it runs (it stays one line — see `finish`). */
  setInfo(info: string): void;
  /**
   * The run is over: a new title and line, the button reads OK, and — when `withBar` is false —
   * the bar and its percentage go and the line may WRAP. While the bar is up the line is held to
   * one line, because it sits directly over the bar and a second line wrapped under it; a result
   * (a failure's reason, a warning) is of any length and needs the room the bar leaves.
   */
  finish(title: string, info: string, withBar?: boolean): void;
  close(): void;
}

/** Put the dialog up, the bar at zero. Rejects only if the FDF itself cannot be mounted. */
export async function showPatchDialog(opts: PatchDialogOptions): Promise<PatchDialog> {
  const scrim = document.createElement("div");
  scrim.className = `glue-dialog-scrim dimmed patch-dialog ${opts.className}`;
  opts.container.appendChild(scrim);
  let bar: ProgressBarScene | null = null;
  let screen: FdfScreen | null = null;
  let raf = 0;
  let open = true;

  const teardown = (): void => {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey, true);
    bar?.dispose();
    screen?.dispose();
    scrim.remove();
  };
  const dismiss = (): void => {
    if (!open) return;
    teardown();
    opts.onClose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  };
  window.addEventListener("keydown", onKey, true);

  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: MAIN_MENU_FDF,
      rootFrame: "BattleNetPatchDialog",
      centerRoot: true,
      textOverrides: { PatchTitleText: opts.title, PatchInfoText: opts.info },
      // Cancel while it runs, OK once it has finished — one button, as the patch box has.
      handlers: { PatchButton: () => dismiss() },
    });
  } catch (err) {
    teardown();
    throw err;
  }
  const s = screen;
  // A title is measured off the words it was mounted with; a longer one ("Voice Control is
  // ready") would wrap in a box sized for the first otherwise.
  const title = s.frame("PatchTitleText");
  if (title) title.style.whiteSpace = "nowrap";
  // The FDF's own `PatchProgressText` is anchored off a zero-sized sprite frame and has nowhere
  // sensible to be; the percentage is printed in the bar's middle instead, as the update overlay
  // prints its own.
  const info = s.frame("PatchInfoText");
  if (info) Object.assign(info.style, { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
  const own = s.frame("PatchProgressText");
  if (own) own.hidden = true;

  const canvas = document.createElement("canvas");
  canvas.className = "patch-dialog-bar";
  const percent = document.createElement("p");
  percent.className = "patch-dialog-percent";
  scrim.append(canvas, percent);

  // The bar where the FDF's SPRITE frame puts it: centred across the box (its art spans x 0…0.229
  // from its own origin; started AT the anchor, it would run off the box's right edge).
  const dialog = s.frame("BattleNetPatchDialog");
  const place = (): void => {
    if (dialog) {
      const r = dialog.getBoundingClientRect();
      const k = r.width / DIALOG_W;
      const w = PROGRESS_BAR_W * BAR_SCALE;
      const h = PROGRESS_BAR_H * BAR_SCALE;
      const top = r.bottom - (BAR_BOTTOM + h) * k;
      canvas.style.left = `${r.left + r.width / 2 - (w / 2) * k}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${w * k}px`;
      canvas.style.height = `${h * k}px`;
      percent.style.left = `${r.left + r.width / 2}px`;
      percent.style.top = `${top + (h / 2) * k}px`;
      percent.style.fontSize = `${0.013 * k}px`;
    }
    raf = requestAnimationFrame(place);
  };
  place();
  bar = new ProgressBarScene(canvas, opts.vfs);
  void bar.load().then(() => bar?.start()).catch((err) => console.warn("[patch dialog] progress bar unavailable:", err));

  const setProgress = (p: number): void => {
    bar?.setProgress(p);
    percent.textContent = `${Math.round(p * 100)}%`;
  };
  setProgress(0);

  /**
   * A wrapped result is given the room down to the button, and no more: the box is a fixed 0.2
   * tall, so a reason long enough to reach the button is set smaller — a step at a time, to no
   * less than 70% of the template's size — rather than run under it. The ones we write are a
   * line or two and never need it; the browser's own error text is of any length.
   */
  const fitInfo = (): void => {
    const button = s.frame("PatchButton");
    if (!info || !button) return;
    const base = parseFloat(info.style.fontSize);
    if (!(base > 0)) return;
    const room = (): number => button.getBoundingClientRect().top - 4;
    const bottom = (): number => {
      const text = info.firstElementChild as HTMLElement | null;
      return (text ?? info).getBoundingClientRect().bottom;
    };
    for (let k = 1; bottom() > room() && k > 0.7; k -= 0.05) info.style.fontSize = `${base * (k - 0.05)}px`;
  };

  return {
    setProgress,
    setInfo: (text) => { if (open) s.setText("PatchInfoText", text); },
    finish: (titleText, infoText, withBar = true) => {
      if (!open) return;
      if (!withBar) {
        // The line may wrap now — inside the box, not past its right edge: the FDF gives it a
        // Width, so `normal` wrapping is all it takes, and `overflow-wrap` breaks a path or a URL
        // the browser's own error text may carry rather than letting it run out of the box. Its
        // frame is ONE line tall and centres its text, so a second line spilled UP over the
        // title; the FDF anchors it by its TOP (`SetPoint TOP, "PatchTitleText"`), so the lines
        // hang DOWN from there, into the room the bar has left.
        if (info) {
          Object.assign(info.style, {
            whiteSpace: "normal", overflow: "visible", textOverflow: "clip", overflowWrap: "anywhere", alignItems: "flex-start",
          });
        }
        canvas.hidden = true;
        percent.hidden = true;
      }
      s.setText("PatchTitleText", titleText);
      s.setText("PatchInfoText", infoText);
      s.setText("PatchButtonText", "OK");
      if (!withBar) fitInfo();
    },
    close: teardown,
  };
}
