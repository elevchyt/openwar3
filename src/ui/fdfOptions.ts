import type { DataSource } from "../vfs/types";
import type { SoundBoard } from "../audio/sounds";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { fadePanels } from "./fdf/anim";
import type { FdfLibrary } from "./fdf/library";
import {
  OPTION_DEFS,
  loadOptions,
  saveOptions,
  applyAudioOptions,
  type Options,
  type OptionDef,
} from "../data/options";

// The Options screen (issue #81), built from the game's own UI\FrameDef\Glue\OptionsMenu.fdf:
// the three category buttons (Gameplay / Video / Sound) down the right, the settings for the
// chosen one on the left, and OK / Cancel at the bottom. The values are persisted to
// localStorage (src/data/options.ts).
//
// Two things the FDF doesn't do that the engine's glue code did, and so we do here:
//   • Show ONE panel at a time, and SWAP it the way the screen was built to. GameplayPanel /
//     VideoPanel / SoundPanel are three overlapping frames in the file, and they are three
//     different heights — so the left-hand frame that carries them, being a fixed piece of
//     3D art, cannot just resize under the player. It leaves and comes back: the panel plays
//     its Death, the contents cross over behind it, and it plays its Birth around the new
//     ones (MenuScene.replayPanel, and on this screen those two clips are the Morph pair the
//     model carries for exactly this — see LEFT_PANEL_CLIPS).
//   • Give OK / Cancel their meaning. We edit a WORKING copy of the options and apply the audio
//     ones live so a volume drag is heard immediately; OK commits the copy to localStorage,
//     Cancel throws it away and restores the committed values (re-applying the audio it touched).
//
// The three video-quality dropdowns and the gameplay sliders are remembered but don't yet drive
// anything (a WebGL client sizes to its canvas; see OPTION_DEFS `applied:false`) — the Sound
// panel is the one with a live backend, wired through applyAudioOptions.
//
// WHERE THE BIG PANEL BEHIND THESE CONTROLS COMES FROM. Nothing in this file draws it: the
// settings frame is 3D chrome in the LEFT sprite layer, and it is the one screen in the game
// whose two panels play different clips of their triple — the right panel's buttons are
// "Options Stand", the left panel's frame is "Options Stand *Alternate*". See
// `LEFT_PANEL_CLIPS` in render/menuScene.ts; the FDF's left column is authored to land inside
// that frame and needs no nudge (unlike the right-hand columns of the wider screens).

const OPTIONS_FDF = "UI\\FrameDef\\Glue\\OptionsMenu.fdf";

type PanelName = "gameplay" | "video" | "sound";
const PANEL_FRAME: Record<PanelName, string> = {
  gameplay: "GameplayPanel",
  video: "VideoPanel",
  sound: "SoundPanel",
};
export interface OptionsHandlers {
  /** The live SoundBoard, so the Sound panel is audible as you drag it. */
  sounds?: SoundBoard | null;
  /** Leave the Options screen — both OK and Cancel go here (back to the main menu). */
  onClose: () => void;
  /**
   * Send the left-hand settings frame away and bring it back, and say how long each half
   * takes — `MenuScene.replayPanel("left")`. Handed in rather than reached for, because the
   * 3D scene is main.ts's and this screen only ever asks it one question.
   *
   * Absent (or answering 0) the panels simply cross over where they stand, which is what a
   * screen mounted with no scene behind it should do.
   */
  swapPanel?: () => { death: number; birth: number };
}

export async function mountOptions(
  container: HTMLElement,
  vfs: DataSource,
  h: OptionsHandlers,
): Promise<FdfScreen> {
  const committed = loadOptions();
  // The screen edits this copy; OK commits it, Cancel discards it. So a player who fiddles
  // and cancels is exactly where they started, audio included.
  const working: Options = { ...committed };
  let activePanel: PanelName = "gameplay";
  /** True while the frame is away and the panels are crossing over (see showPanel). */
  let swapping = false;
  let lib: FdfLibrary | null = null;

  const applyAudio = (opts: Options): void => {
    if (h.sounds) applyAudioOptions(h.sounds, opts);
  };

  const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
  const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
  const bool = (v: unknown): boolean => v === true;

  const screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: OPTIONS_FDF,
    rootFrame: "OptionsMenu",
    // Capture the library so choice labels (LOW/MEDIUM/HIGH…) resolve through GlobalStrings,
    // and keep the default root.
    buildRoot: (l) => {
      lib = l;
      const root = l.resolveRoot("OptionsMenu");
      if (!root) throw new Error("OptionsMenu frame not found in OptionsMenu.fdf");
      return root;
    },
    buttonWidthScale: 1.35, // the category + OK/Cancel buttons fill the widescreen chain slot
    handlers: {
      GameplayButton: () => void showPanel("gameplay"),
      VideoButton: () => void showPanel("video"),
      SoundButton: () => void showPanel("sound"),
      OKButton: () => { saveOptions(working); h.onClose(); },
      // Undo everything this visit changed — including the audio applied live along the way.
      CancelButton: () => { Object.assign(working, committed); applyAudio(committed); h.onClose(); },
    },
    onBuild: (s) => bind(s),
  });

  /**
   * Switch the visible settings panel — as a TRANSITION, not a swap.
   *
   * The frame these three panels sit on leaves on its Death and comes back on its Birth
   * (see the file header), so the contents go with it: they fade out into the departing
   * frame, change over while there is nothing on screen to change under, and fade up on the
   * frame as it lands. `fadePanels` puts an exit at the start of the window it is given and
   * an entrance at the end, so handing it the two clip lengths is all the timing there is.
   *
   * Re-entrant clicks are dropped: the screen is inert for the duration anyway, but the
   * category buttons live on the OTHER panel and stay up throughout.
   */
  async function showPanel(panel: PanelName): Promise<void> {
    if (panel === activePanel || swapping) return;
    swapping = true;
    screen.setInteractive(false);
    try {
      const { death, birth } = h.swapPanel?.() ?? { death: 0, birth: 0 };
      const leaving = screen.frame(PANEL_FRAME[activePanel]);
      if (leaving) await fadePanels([leaving], "out", death);
      activePanel = panel;
      applyPanelState(screen);
      const arriving = screen.frame(PANEL_FRAME[activePanel]);
      if (arriving) await fadePanels([arriving], "in", birth);
    } finally {
      swapping = false;
      screen.setInteractive(true);
    }
  }

  function applyPanelState(s: FdfScreen): void {
    for (const name of Object.keys(PANEL_FRAME) as PanelName[]) {
      const el = s.frame(PANEL_FRAME[name]);
      if (el) el.style.display = name === activePanel ? "" : "none";
    }
  }

  /** (Re)fill every widget from the working copy — called on first build and each rebuild. */
  function bind(s: FdfScreen): void {
    applyPanelState(s);
    for (const d of OPTION_DEFS) bindOne(s, d);
  }

  function bindOne(s: FdfScreen, d: OptionDef): void {
    const commit = (v: Options[string]): void => {
      working[d.key] = v;
      if (d.panel === "sound") applyAudio(working); // heard the instant it changes
    };
    if (d.kind === "bool") {
      const c = s.checkBox(d.frame);
      if (!c) return;
      c.checked = bool(working[d.key]);
      c.onChange = (v) => commit(v);
    } else if (d.kind === "range") {
      const c = s.slider(d.frame);
      if (!c) return;
      c.value = num(working[d.key], num(d.def, 0));
      c.onChange = (v) => commit(v);
    } else if (d.kind === "choice") {
      const c = s.popup(d.frame);
      if (!c) return;
      const choices = d.choices ?? [];
      if (choices.length) {
        c.setOptions(choices.map((ch) => ({ value: ch.value, label: lib?.string(ch.label) ?? ch.label })));
        c.value = str(working[d.key], String(d.def));
        c.onChange = (v) => commit(v);
      } else {
        // A dropdown the game fills at runtime (resolution list, sound provider): nothing to
        // offer here, so it's shown empty and inert rather than pretending to choices.
        c.setEnabled(false);
      }
    } else {
      const c = s.editBox(d.frame);
      if (!c) return;
      c.value = str(working[d.key], String(d.def));
      c.onChange = (v) => commit(v);
    }
  }

  return screen;
}
