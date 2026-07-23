import type { DataSource } from "../vfs/types";
import type { SoundBoard } from "../audio/sounds";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
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
//   • Show ONE panel at a time. GameplayPanel / VideoPanel / SoundPanel are three overlapping
//     frames in the file; the category buttons pick which is visible (WC3 hides the other two).
//   • Give OK / Cancel their meaning. We edit a WORKING copy of the options and apply the audio
//     ones live so a volume drag is heard immediately; OK commits the copy to localStorage,
//     Cancel throws it away and restores the committed values (re-applying the audio it touched).
//
// The three video-quality dropdowns and the gameplay sliders are remembered but don't yet drive
// anything (a WebGL client sizes to its canvas; see OPTION_DEFS `applied:false`) — the Sound
// panel is the one with a live backend, wired through applyAudioOptions.

const OPTIONS_FDF = "UI\\FrameDef\\Glue\\OptionsMenu.fdf";

type PanelName = "gameplay" | "video" | "sound";
const PANEL_FRAME: Record<PanelName, string> = {
  gameplay: "GameplayPanel",
  video: "VideoPanel",
  sound: "SoundPanel",
};
const CATEGORY_BUTTON: Record<PanelName, string> = {
  gameplay: "GameplayButton",
  video: "VideoButton",
  sound: "SoundButton",
};

export interface OptionsHandlers {
  /** The live SoundBoard, so the Sound panel is audible as you drag it. */
  sounds?: SoundBoard | null;
  /** Leave the Options screen — both OK and Cancel go here (back to the main menu). */
  onClose: () => void;
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
      GameplayButton: () => showPanel("gameplay"),
      VideoButton: () => showPanel("video"),
      SoundButton: () => showPanel("sound"),
      OKButton: () => { saveOptions(working); h.onClose(); },
      // Undo everything this visit changed — including the audio applied live along the way.
      CancelButton: () => { Object.assign(working, committed); applyAudio(committed); h.onClose(); },
    },
    onBuild: (s) => bind(s),
  });

  /** Switch the visible settings panel, and latch the chosen category button pressed. */
  function showPanel(panel: PanelName): void {
    activePanel = panel;
    applyPanelState(screen);
  }

  function applyPanelState(s: FdfScreen): void {
    for (const name of Object.keys(PANEL_FRAME) as PanelName[]) {
      const el = s.frame(PANEL_FRAME[name]);
      if (el) el.style.display = name === activePanel ? "" : "none";
      // The chosen category button stays visually pressed, as its counterpart does in WC3.
      const btn = s.frame(CATEGORY_BUTTON[name]);
      if (btn) btn.classList.toggle("fdf-latched", name === activePanel);
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
