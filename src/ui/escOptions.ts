import type { SoundBoard } from "../audio/sounds";
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
import { applyVideoOptions } from "../render/videoQuality";
import { applyHealthBarOptions } from "../render/worldOverlays";
import { applyHotkeyOptions } from "../data/hotkeys";
import { applyScrollOptions } from "../render/scrollOptions";
import { bindGamepadButton } from "./gamepad";

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
// pulldowns that change them are on the glue screen. The Game Speed slider is likewise a
// READOUT here: this engine runs at Fast and says so (ui/fdfLanCreate.ts does the same with the
// same slider).

/** What the game prints where "FMOD" stood: the API this engine's SoundBoard is built on. A
 *  product name rather than a label, as the game's was, so it is not a GlobalStrings key. */
const SOUND_PROVIDER = "Web Audio";

/** `LocalMultiplayerCreate.fdf`'s and this file's shared truth: the one speed we run at, which
 *  is index 2 of the slider's own 0 slow / 1 normal / 2 fast range. */
const GAME_SPEED_FAST = 2;

export interface EscOptionsHost {
  /** The live SoundBoard, so the Sound panel is audible as you drag it. */
  sounds(): SoundBoard | null;
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

  constructor(private host: EscOptionsHost) {}

  /** Re-read the store. Called when the menu opens, so a change made from the glue screen since
   *  the last visit is what the panel shows. */
  reload(): void {
    this.committed = loadOptions();
    this.working = { ...this.committed };
  }

  /** OK: commit the working copy. Everything it changed is already applied. */
  ok(): void {
    this.committed = { ...this.working };
    saveOptions(this.committed);
  }

  /** Cancel: throw the working copy away and put the committed values back through every
   *  applier the visit touched — audio included, which is the half you would otherwise still
   *  be hearing. */
  cancel(): void {
    this.working = { ...this.committed };
    this.applyAll(this.committed);
  }

  /** Fill every widget on the panel that is up, and wire it to the working copy. */
  bind(screen: FdfScreen, panel: "gameplay" | "video" | "sound", lib: FdfLibrary | null): void {
    for (const d of OPTION_DEFS) {
      if (d.panel !== panel) continue;
      this.bindOne(screen, d, lib);
    }
    if (panel === "gameplay") this.fillGameplay(screen, lib);
    else if (panel === "video") this.fillVideo(screen, lib);
    else this.fillSound(screen);
  }

  private applyAll(opts: Options): void {
    const sounds = this.host.sounds();
    if (sounds) applyAudioOptions(sounds, opts);
    applyVideoOptions(opts);
    applyHealthBarOptions(opts);
    applyHotkeyOptions(opts);
    applyScrollOptions(opts);
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
      if (d.panel === "gameplay") {
        applyHealthBarOptions(this.working);
        applyHotkeyOptions(this.working);
        applyScrollOptions(this.working);
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

  /** The Gameplay panel's one readout: the speed the match runs at. */
  private fillGameplay(screen: FdfScreen, lib: FdfLibrary | null): void {
    // "Detect Gamepad" / "Unpair Gamepad" (issue #162): its label for the state the pad is in,
    // and its countdown while it is listening.
    bindGamepadButton(screen, {
      detect: lib?.string("DETECT_GAMEPAD") ?? "Detect Gamepad",
      unpair: lib?.string("UNPAIR_GAMEPAD") ?? "Unpair Gamepad",
    });
    const speed = screen.slider("GameSpeedSlider");
    if (speed) {
      speed.value = GAME_SPEED_FAST;
      speed.setEnabled(false);
    }
    screen.setText("GameSpeedValue", lib?.string("FAST") ?? "Fast");
  }

  /** The Video panel's five read-only rows (see the file header): the live value of each,
   *  worded out of the same GlobalStrings keys the glue screen's pulldowns offer. */
  private fillVideo(screen: FdfScreen, lib: FdfLibrary | null): void {
    screen.setText("ResolutionValue", this.choiceLabel("resolution", lib));
    screen.setText("ModelDetailValue", this.choiceLabel("modelDetail", lib));
    screen.setText("AnimQualityValue", this.choiceLabel("animQuality", lib));
    screen.setText("TextureQualityValue", this.choiceLabel("textureQuality", lib));
    // Spell Detail is the one of the five with no row on either screen to read — 1.30.4's glue
    // file has the whole `SpellFilterMenu` block commented out — and nothing in this engine
    // thins a spell's art, so the readout is the game's own word for all of it.
    screen.setText("SpellFilterValue", lib?.string("HIGH_SPELLS") ?? "High");
  }

  private fillSound(screen: FdfScreen): void {
    screen.setText("ProviderValue", SOUND_PROVIDER);
  }

  /** The label a `choice` option's current value wears, resolved through GlobalStrings — the
   *  same pair the glue screen's pulldown would be showing. */
  private choiceLabel(key: string, lib: FdfLibrary | null): string {
    const def = OPTION_DEFS.find((d) => d.key === key);
    const value = String(this.working[key] ?? def?.def ?? "");
    const label = def?.choices?.find((c) => c.value === value)?.label ?? value;
    return lib?.string(label) ?? label;
  }
}
