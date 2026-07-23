import { SOUND_GROUP, type SoundBoard } from "../audio/sounds";

// The game options (issue #81) — the settings the Options screen exposes, persisted to
// localStorage. The screen itself is built from the real UI\FrameDef\Glue\OptionsMenu.fdf
// (src/ui/fdfOptions.ts); THIS module is the model behind it: the list of options, their
// defaults, load/save, and the applier that pushes the audio ones onto the live SoundBoard.
//
// One table, `OPTION_DEFS`, is the single source of truth: each entry pairs an option KEY
// with the FDF FRAME that drives it and the kind of control it is, so the screen can bind
// every widget generically instead of naming each one twice. Defaults match Warcraft III's.
//
// Not every option the FDF carries maps to something this engine does yet — the video panel's
// resolution/model-detail/etc. are meaningless to a WebGL client, and are kept as remembered
// UI state rather than faked behaviour. The ones with a real backend (the whole Sound panel)
// are applied live through `applyAudioOptions`. Persist-only options are marked `applied:false`.

/** The kind of control an option is bound to, which decides how its value is read/written. */
export type OptionKind = "bool" | "range" | "choice" | "text";

export interface OptionDef {
  key: string;
  /** The FDF frame name the control lives under (CheckBox / Slider / PopupMenu / EditBox). */
  frame: string;
  kind: OptionKind;
  /** The Options panel it sits on — used to bind and to switch tabs. */
  panel: "gameplay" | "video" | "sound";
  /** Default value: boolean for bool, 0–100 for range, a choice value for choice, string for text. */
  def: boolean | number | string;
  /** `choice` options: the value/label pairs. Labels are GlobalStrings keys resolved by the
   *  screen (LOW/MEDIUM/HIGH/OFF/ON). Empty for the dropdowns WC3 fills at runtime (resolution,
   *  sound provider) — those stay empty and disabled, as they have nothing to offer us. */
  choices?: Array<{ value: string; label: string }>;
  /** False when the option is remembered but nothing in the engine reads it yet. Documented so
   *  a future feature knows the value is already there, and so the screen can dim it if wanted. */
  applied?: boolean;
}

const QUALITY = [
  { value: "low", label: "LOW" },
  { value: "medium", label: "MEDIUM" },
  { value: "high", label: "HIGH" },
];
const ON_OFF = [
  { value: "off", label: "OFF" },
  { value: "on", label: "ON" },
];

// Ordered by panel, then by the FDF's own top-to-bottom order.
export const OPTION_DEFS: readonly OptionDef[] = [
  // --- Gameplay ---
  { key: "mouseScrollSpeed", frame: "MouseScrollSlider", kind: "range", panel: "gameplay", def: 50, applied: false },
  { key: "mouseScrollDisable", frame: "MouseScrollDisableCheckBox", kind: "bool", panel: "gameplay", def: false, applied: false },
  { key: "keyScrollSpeed", frame: "KeyScrollSlider", kind: "range", panel: "gameplay", def: 50, applied: false },
  { key: "enhancedTooltips", frame: "TooltipsCheckBox", kind: "bool", panel: "gameplay", def: true, applied: false },
  { key: "subgroupModifier", frame: "SubgroupCheckBox", kind: "bool", panel: "gameplay", def: false, applied: false },
  { key: "formationToggle", frame: "FormationToggleCheckBox", kind: "bool", panel: "gameplay", def: true, applied: false },
  { key: "customKeys", frame: "CustomKeysCheckBox", kind: "bool", panel: "gameplay", def: false, applied: false },
  { key: "healthBars", frame: "HealthBarsCheckBox", kind: "bool", panel: "gameplay", def: false, applied: false },
  { key: "autosaveReplay", frame: "AutosaveReplayCheckBox", kind: "bool", panel: "gameplay", def: true, applied: false },
  { key: "gamePort", frame: "GamePortEditBox", kind: "text", panel: "gameplay", def: "6112", applied: false },

  // --- Video (remembered, not yet acted on — a WebGL client sizes to its canvas) ---
  { key: "gamma", frame: "GammaSlider", kind: "range", panel: "video", def: 50, applied: false },
  { key: "modelDetail", frame: "ModelDetailMenu", kind: "choice", panel: "video", def: "high", choices: QUALITY, applied: false },
  { key: "animQuality", frame: "AnimQualityMenu", kind: "choice", panel: "video", def: "high", choices: QUALITY, applied: false },
  { key: "textureQuality", frame: "TextureQualityMenu", kind: "choice", panel: "video", def: "high", choices: QUALITY, applied: false },
  { key: "particles", frame: "ParticlesMenu", kind: "choice", panel: "video", def: "high", choices: QUALITY, applied: false },
  { key: "lights", frame: "LightsMenu", kind: "choice", panel: "video", def: "high", choices: QUALITY, applied: false },
  { key: "shadows", frame: "ShadowsMenu", kind: "choice", panel: "video", def: "on", choices: ON_OFF, applied: false },
  { key: "occlusion", frame: "OcclusionMenu", kind: "choice", panel: "video", def: "on", choices: ON_OFF, applied: false },
  { key: "spellFilter", frame: "SpellFilterMenu", kind: "choice", panel: "video", def: "high", choices: QUALITY, applied: false },

  // --- Sound (all live-applied through applyAudioOptions) ---
  { key: "soundEnabled", frame: "SoundCheckBox", kind: "bool", panel: "sound", def: true },
  { key: "soundVolume", frame: "SoundVolumeSlider", kind: "range", panel: "sound", def: 100 },
  { key: "musicEnabled", frame: "MusicCheckBox", kind: "bool", panel: "sound", def: true },
  { key: "musicVolume", frame: "MusicVolumeSlider", kind: "range", panel: "sound", def: 70 },
  { key: "ambientSounds", frame: "AmbientCheckBox", kind: "bool", panel: "sound", def: true },
  { key: "movementSounds", frame: "MovementCheckBox", kind: "bool", panel: "sound", def: true },
  { key: "unitSounds", frame: "UnitCheckBox", kind: "bool", panel: "sound", def: true },
  { key: "subtitles", frame: "SubtitlesCheckBox", kind: "bool", panel: "sound", def: true, applied: false },
  { key: "environmentalEffects", frame: "EnviroCheckBox", kind: "bool", panel: "sound", def: true, applied: false },
  { key: "positionalAudio", frame: "PositionalCheckBox", kind: "bool", panel: "sound", def: true, applied: false },
];

export type OptionValue = boolean | number | string;
export type Options = Record<string, OptionValue>;

/** Every option at its default — the base a stored set is merged over, so a value added to the
 *  table later still has a sane default for a player whose localStorage predates it. */
export function defaultOptions(): Options {
  const o: Options = {};
  for (const d of OPTION_DEFS) o[d.key] = d.def;
  return o;
}

const STORAGE_KEY = "openwar3.options";

/** The committed options, from localStorage merged over the defaults. Reads are best-effort:
 *  a disabled/quota-full/corrupt store just yields the defaults. */
export function loadOptions(): Options {
  const base = defaultOptions();
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) return base;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Options>;
    for (const d of OPTION_DEFS) {
      const v = saved[d.key];
      // Only accept a stored value of the shape this option expects — a hand-edited or
      // stale store can't push a string into a boolean and corrupt the screen.
      if (v !== undefined && typeof v === typeof d.def) base[d.key] = v;
    }
  } catch {
    /* unreadable store — the defaults stand */
  }
  return base;
}

/** Commit the options to localStorage (the OK button). Best-effort: a full/disabled store
 *  simply doesn't persist, and the in-memory values still take effect for the session. */
export function saveOptions(opts: Options): void {
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(opts));
  } catch {
    /* quota exceeded / storage disabled — settings are best-effort */
  }
}

const num = (v: OptionValue, fallback: number): number => (typeof v === "number" ? v : fallback);
const bool = (v: OptionValue): boolean => v === true;

/**
 * Push the Sound-panel options onto a live SoundBoard. This is the one panel with a real
 * backend, so it is the one that actually does something the moment you touch it.
 *
 * Music and SFX are kept independent, the way the two sliders imply: the music track has its
 * own gain (`setMusicVolume`), and the effect groups are scaled by `VolumeGroupSetVolume` —
 * so the "Sound Effects Volume" slider never touches the music, and vice-versa. Each SFX group's
 * final scale is the PRODUCT of the master sound switch, the effects slider, and any per-category
 * checkbox that also governs it (Unit Sounds → UNITSOUNDS, Ambient Sounds → AMBIENTSOUNDS):
 *
 *     UNITSOUNDS = soundOn · soundVol · unitSounds     (a unit's voice / death cry)
 *     COMBAT / SPELLS / UI = soundOn · soundVol         (clangs, spells, the menu click itself)
 *     AMBIENT = soundOn · soundVol · ambientSounds      (dawn cries, the menu wind bed)
 *     UNITMOVEMENT = soundOn · soundVol · movementSounds (footsteps — no pool yet, set for when there is)
 *     MUSIC (via setMusicVolume) = musicOn · musicVol
 *
 * Turning "Sound" off zeroes every effect group (including the UI click — WC3 does the same).
 */
export function applyAudioOptions(sounds: SoundBoard, opts: Options): void {
  const soundOn = bool(opts.soundEnabled);
  const sfx = soundOn ? num(opts.soundVolume, 100) / 100 : 0;
  const musicScale = bool(opts.musicEnabled) ? num(opts.musicVolume, 70) / 100 : 0;

  sounds.setVolumeGroup(SOUND_GROUP.UNITSOUNDS, sfx * (bool(opts.unitSounds) ? 1 : 0));
  sounds.setVolumeGroup(SOUND_GROUP.COMBAT, sfx);
  sounds.setVolumeGroup(SOUND_GROUP.SPELLS, sfx);
  sounds.setVolumeGroup(SOUND_GROUP.UI, sfx);
  sounds.setVolumeGroup(SOUND_GROUP.AMBIENT, sfx * (bool(opts.ambientSounds) ? 1 : 0));
  sounds.setVolumeGroup(SOUND_GROUP.UNITMOVEMENT, sfx * (bool(opts.movementSounds) ? 1 : 0));
  sounds.setMusicVolume(Math.round(musicScale * 127));
}
