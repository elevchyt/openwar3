import type { SoundBoard } from "../audio/sounds";
import type { DataSource } from "../vfs/types";
import type { FdfLibrary } from "./fdf/library";
import type { FdfScreen } from "./fdf/render";
import {
  OPTION_DEFS,
  loadOptions,
  saveOptions,
  applyAudioOptions,
  type Options,
  type OptionDef,
  type OptionValue,
} from "../data/options";
import { applyVideoOptions, LOW_PERF_FORCED } from "../render/videoQuality";
import { applyHealthBarOptions } from "../render/worldOverlays";
import { applyHotkeyOptions } from "../data/hotkeys";
import { applyScrollOptions } from "../render/scrollOptions";
import { bindGamepadButton } from "./gamepad";
import { bindVoiceRow } from "./voiceOptions";
import { applyVoiceOptions } from "../voice/control";
import {
  GAME_SPEED_MAX,
  GAME_SPEED_MIN,
  gameSpeedLabel,
  toGameSpeed,
  type GameSpeed,
} from "../data/gameSpeed";

// The IN-GAME Options panels — F10 → Options → Gameplay / Video / Sound — built from the game's
// own `UI\FrameDef\UI\EscMenuOptionsPanel.fdf`. The panel STACK is ui/escMenu.ts's (this file's
// three panels are four more faces of the one Esc menu); what lives here is the model behind
// them, the way src/data/options.ts is the model behind the glue screen.
//
// It is the SAME model. Every row on these panels is an `OPTION_DEFS` row, bound through the
// same `escFrame ?? frame` name and applied through the same four appliers, so a volume set
// mid-match and one set from the main menu are one setting with one store. The screen edits a
// WORKING copy and applies it live (a volume drag has to be heard, a gamma drag seen); OK
// commits it to localStorage, Cancel puts the committed values back through the same appliers,
// which makes it a complete undo.
//
// WHAT THE IN-GAME PANEL DOES NOT OFFER, and why it is not a gap. Five of the Video panel's rows
// are read-only VALUES in the game's own file — Resolution, Model Detail, Animation Quality,
// Texture Quality, Spell Detail — because changing any of them in 2003 meant resetting the D3D
// device mid-match. We print the live value into each of them exactly as the game does; the
// pulldowns that change them are on the glue screen.
//
// GAME SPEED is the one row that is not an `OPTION_DEFS` row (the glue Options screen has no
// slider for it — in the game it lives here and on the create screen): src/data/gameSpeed.ts is
// its model. In single player it is live, a drag is felt at once and OK remembers it for the
// next match; in ANY multiplayer game it is the host's pick for every machine, so the slider is
// greyed and only shows it.

export interface EscOptionsHost {
  /** The live SoundBoard, so the Sound panel is audible as you drag it. */
  sounds(): SoundBoard | null;
  /** The match's speed, and whether this player may change it (single player only). */
  gameSpeed(): { speed: GameSpeed; locked: boolean };
  /** Apply a new speed to the running match. */
  setGameSpeed(speed: GameSpeed): void;
  /** Where a download dialog goes up (Voice Control's speech model). */
  dialogDoor(): { container: HTMLElement; vfs: DataSource };
}

/**
 * The options being edited by the panel that is up: a working copy, the committed one to put
 * back on Cancel, and the binding that fills either.
 *
 * One of these lives as long as the Esc menu does rather than as long as a panel does, because
 * the panel is rebuilt on every category switch and on every resize, and a working copy that
 * died with the DOM would lose a change the moment the player looked at another category.
 */
export class EscOptions {
  private committed: Options = loadOptions();
  private working: Options = { ...this.committed };
  /** The game speed, kept the same way: what the match ran at when the menu opened, and what
   *  the slider has it running at now. */
  private committedSpeed: GameSpeed;
  private workingSpeed: GameSpeed;

  constructor(private host: EscOptionsHost) {
    this.committedSpeed = this.workingSpeed = host.gameSpeed().speed;
  }

  /** Re-read the store. Called when the menu opens, so a change made from the glue screen since
   *  the last visit is what the panel shows. */
  reload(): void {
    this.committed = loadOptions();
    this.working = { ...this.committed };
    this.committedSpeed = this.workingSpeed = this.host.gameSpeed().speed;
  }

  /** OK: commit the working copy. Everything it changed is already applied. */
  ok(): void {
    this.committed = { ...this.working };
    saveOptions(this.committed);
    // The speed is already applied and lasts for this match only — never remembered, so the
    // next match opens on Fast again (src/data/gameSpeed.ts).
    this.committedSpeed = this.workingSpeed;
  }

  /** Cancel: throw the working copy away and put the committed values back through every
   *  applier the visit touched — audio included, which is the half you would otherwise still
   *  be hearing. */
  cancel(): void {
    this.working = { ...this.committed };
    this.applyAll(this.committed);
    if (this.workingSpeed !== this.committedSpeed && !this.host.gameSpeed().locked) {
      this.host.setGameSpeed(this.committedSpeed);
    }
    this.workingSpeed = this.committedSpeed;
  }

  /** Fill every widget on the panel that is up, and wire it to the working copy. */
  bind(screen: FdfScreen, panel: "gameplay" | "video" | "sound", lib: FdfLibrary | null): void {
    for (const d of OPTION_DEFS) {
      if (d.panel !== panel) continue;
      this.bindOne(screen, d, lib);
    }
    if (panel === "gameplay") this.fillGameplay(screen, lib);
    else if (panel === "video") this.fillVideo(screen, lib);
    // The Sound panel has nothing to fill: its one readout, "Sound Provider:", is retired by
    // ESC_OPTIONS_OVERRIDE (a browser has one audio device).
  }

  /**
   * "Low Performance Mode" (issue #161) on THIS panel: the four pulldowns it forces go dead and
   * show the rung it puts them at, exactly as on the glue screen (ui/fdfOptions.ts says why both
   * halves are needed). The three read-only rows are covered by `fillVideo`, which prints the
   * effective value rather than the stored one.
   *
   * The switch has to be reachable HERE and not only from the menus: the two panels are one store,
   * so a mode turned on before a match would otherwise be unreachable until the match ended.
   */
  private syncVideoRows(screen: FdfScreen): void {
    const on = this.working.lowPerf === true;
    for (const d of OPTION_DEFS) {
      if (d.panel !== "video" || d.kind !== "choice") continue;
      const forced = LOW_PERF_FORCED[d.key];
      if (forced === undefined) continue;
      const c = screen.popup(d.escFrame ?? d.frame);
      if (!c) continue;
      c.setEnabled(!on);
      c.value = on ? forced : String(this.working[d.key] ?? d.def);
    }
  }

  private applyAll(opts: Options): void {
    const sounds = this.host.sounds();
    if (sounds) applyAudioOptions(sounds, opts);
    applyVideoOptions(opts);
    applyHealthBarOptions(opts);
    applyHotkeyOptions(opts);
    applyScrollOptions(opts);
    applyVoiceOptions(opts);
  }

  private bindOne(screen: FdfScreen, d: OptionDef, lib: FdfLibrary | null): void {
    const name = d.escFrame ?? d.frame;
    const commit = (v: OptionValue): void => {
      this.working[d.key] = v;
      // Applied per PANEL, as the glue screen does it: the panel that is up is the only one
      // whose rows can have changed, and a gamma pass on every volume notch is wasted work.
      const sounds = this.host.sounds();
      if (d.panel === "sound" && sounds) applyAudioOptions(sounds, this.working);
      if (d.panel === "video") applyVideoOptions(this.working);
      // …and the mode owns the rows under it, so a tick re-paints the panel it is on.
      if (d.key === "lowPerf") this.fillVideo(screen, lib);
      if (d.panel === "gameplay") {
        applyHealthBarOptions(this.working);
        applyHotkeyOptions(this.working);
        applyScrollOptions(this.working);
        applyVoiceOptions(this.working);
      }
    };
    if (d.kind === "bool") {
      const c = screen.checkBox(name);
      if (!c) return;
      c.checked = this.working[d.key] === true;
      c.onChange = (v) => commit(v);
    } else if (d.kind === "range") {
      const c = screen.slider(name);
      if (!c) return;
      c.value = typeof this.working[d.key] === "number" ? (this.working[d.key] as number) : Number(d.def);
      c.onChange = (v) => commit(v);
    } else if (d.kind === "choice") {
      const c = screen.popup(name);
      if (!c) return;
      const choices = d.choices ?? [];
      if (!choices.length) { c.setEnabled(false); return; }
      c.setOptions(choices.map((ch) => ({ value: ch.value, label: lib?.string(ch.label) ?? ch.label })));
      c.value = String(this.working[d.key] ?? d.def);
      c.onChange = (v) => commit(v);
    }
  }

  /** The Gameplay panel's Game Speed row: live in single player, a readout of the host's pick
   *  in any multiplayer game. Four rungs on a slider the file gives three (src/data/gameSpeed.ts). */
  private fillGameplay(screen: FdfScreen, lib: FdfLibrary | null): void {
    // "Detect Gamepad" / "Unpair Gamepad" (issue #162): its label for the state the pad is in,
    // and its countdown while it is listening.
    bindGamepadButton(screen, {
      detect: lib?.string("DETECT_GAMEPAD") ?? "Detect Gamepad",
      unpair: lib?.string("UNPAIR_GAMEPAD") ?? "Unpair Gamepad",
    });
    // Voice Control: download button or checkbox (src/voice/) — ticked for both copies the
    // moment the model arrives.
    bindVoiceRow(screen, {
      enabled: () => { this.committed.voiceControl = true; this.working.voiceControl = true; },
      ...this.host.dialogDoor(),
    });
    const { locked } = this.host.gameSpeed();
    if (locked) this.workingSpeed = this.host.gameSpeed().speed;
    const speed = screen.slider("GameSpeedSlider");
    if (speed) {
      speed.setRange(GAME_SPEED_MIN, GAME_SPEED_MAX);
      speed.value = this.workingSpeed;
      speed.setEnabled(!locked);
      speed.onChange = (v) => {
        if (locked) return;
        this.workingSpeed = toGameSpeed(v);
        this.host.setGameSpeed(this.workingSpeed);
        screen.setText("GameSpeedValue", gameSpeedLabel(this.workingSpeed, lib));
      };
    }
    screen.setText("GameSpeedValue", gameSpeedLabel(this.workingSpeed, lib));
    // The frame is sized off the file's own placeholder word at build, so "Fast (Default)" would
    // wrap; it is right-justified over the slider's end, so one line grows leftward.
    const value = screen.frame("GameSpeedValue");
    if (value) value.style.whiteSpace = "nowrap";
  }

  /** The Video panel's five read-only rows (see the file header): the live value of each,
   *  worded out of the same GlobalStrings keys the glue screen's pulldowns offer. Three of the
   *  five are rows "Low Performance Mode" forces, and a READOUT prints what the renderer is
   *  doing — so with the mode on they read Low whatever the store remembers (`choiceLabel`). */
  private fillVideo(screen: FdfScreen, lib: FdfLibrary | null): void {
    this.syncVideoRows(screen);
    screen.setText("ResolutionValue", this.choiceLabel("resolution", lib));
    screen.setText("ModelDetailValue", this.choiceLabel("modelDetail", lib));
    screen.setText("AnimQualityValue", this.choiceLabel("animQuality", lib));
    screen.setText("TextureQualityValue", this.choiceLabel("textureQuality", lib));
    // Spell Detail is the one of the five with no row on either screen to read — 1.30.4's glue
    // file has the whole `SpellFilterMenu` block commented out — and nothing in this engine
    // thins a spell's art, so the readout is the game's own word for all of it.
    screen.setText("SpellFilterValue", lib?.string("HIGH_SPELLS") ?? "High");
  }

  /** The label a `choice` option's current value wears, resolved through GlobalStrings — the
   *  same pair the glue screen's pulldown would be showing. */
  private choiceLabel(key: string, lib: FdfLibrary | null): string {
    const def = OPTION_DEFS.find((d) => d.key === key);
    const forced = this.working.lowPerf === true ? LOW_PERF_FORCED[key] : undefined;
    const value = forced ?? String(this.working[key] ?? def?.def ?? "");
    const label = def?.choices?.find((c) => c.value === value)?.label ?? value;
    return lib?.string(label) ?? label;
  }
}
