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
// Not every option the FDF carries maps to something this engine does — the resolution list is
// meaningless to a client that renders into a fixed 16:9 buffer (ui/stage.ts), and two of the
// video rows describe features we do not have. Those are kept as remembered UI state rather than
// faked behaviour, and are marked `applied:false` with the reason next to them. The rest have a
// live backend: the Sound panel through `applyAudioOptions` here, the Video panel through
// `applyVideoOptions` in render/videoQuality.ts, which is also where each video setting's
// meaning (and which of its numbers are the game's) is written down, and the Gameplay panel's
// two health-bar rows through `applyHealthBarOptions` in render/worldOverlays.ts — the module
// that draws the bars they describe.

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
   *  screen (`LOW_MODELS`, `HIGH_PARTICLES`, `OFF`/`ON`, …). Empty for the dropdowns WC3 fills at
   *  runtime (resolution, sound provider) — those stay empty and disabled, having nothing to
   *  offer us. */
  choices?: Array<{ value: string; label: string }>;
  /** False when the option is remembered but nothing in the engine reads it yet. Documented so
   *  a future feature knows the value is already there, and so the screen can dim it if wanted. */
  applied?: boolean;
}

// The three-rung dropdowns each have their OWN label keys — the FDF spells the MenuItems out
// per row (`LOW_MODELS`/`MEDIUM_MODELS`/`HIGH_MODELS`, `LOW_ANIM`…, and so on) and GlobalStrings
// gives every one of them the same three words. There is no generic `LOW`/`MEDIUM`/`HIGH` in
// GlobalStrings at all, so a shared table left every video dropdown showing its raw key.
const quality = (suffix: string) => [
  { value: "low", label: `LOW_${suffix}` },
  { value: "medium", label: `MEDIUM_${suffix}` },
  { value: "high", label: `HIGH_${suffix}` },
];
const ON_OFF = [
  { value: "off", label: "OFF" },
  { value: "on", label: "ON" },
];

/**
 * What the Resolution dropdown offers — the size of the buffer the game is DRAWN into.
 *
 * This is the one list WC3 built at runtime rather than writing into the FDF (the `MENU` frame
 * under `ResolutionMenu` is empty in the file), because it enumerated the display modes the
 * hardware would give it. A browser has no display modes: the page renders into a canvas and CSS
 * scales it into the window. So the analogue is the ladder of buffer sizes, and the frame it is
 * scaled into is unchanged — which is why every rung here is EXACTLY 16:9. The stage is a fixed
 * 16:9 box by construction (ui/stage.ts: a wider one quietly hands the player more map than the
 * real game gives), so a 4:3 rung off the 2003 list would have to distort or letterback, and
 * either way it would not mean what it says.
 *
 * Ascending, as the game's own list was. Labels are plain text rather than GlobalStrings keys —
 * there are none for these, for the same reason the list was built at runtime.
 */
/**
 * What the "Healthbars:" pulldown offers (issue #141) — how the bar floating over every unit
 * is COLOURED. Not a WC3 row: the 2003 options screen has no such setting, so the frame comes
 * from `src/overrides/ui/OptionsMenu.fdf` and the labels from our GlobalStrings layer.
 *
 *  · `default` — WC3's own bar: one green slab that turns yellow past 60% lost and red past
 *    70%, the same for your units, an ally's and an enemy's.
 *  · `team` — the bar is the OWNER's colour and does not shift as it drains, so which player
 *    a body belongs to is readable at a glance from the bar alone (Reforged's "Team Colored
 *    Health Bars"). The colour follows the Ally Color Mode, because it is the same question
 *    the body itself is painted by — see render/worldOverlays.ts.
 */
const HEALTH_BAR_STYLES = [
  { value: "default", label: "DEFAULT_HEALTHBARS" },
  { value: "team", label: "TEAM_COLORED_HEALTHBARS" },
];

const RESOLUTIONS = [
  { value: "800x450", label: "800 x 450" },
  { value: "1024x576", label: "1024 x 576" },
  { value: "1280x720", label: "1280 x 720" },
  { value: "1600x900", label: "1600 x 900" },
  { value: "1920x1080", label: "1920 x 1080" },
  { value: "2560x1440", label: "2560 x 1440" },
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
  // Issue #141. ON by default, and live: `applyHealthBarOptions` (render/worldOverlays.ts)
  // is what reads it. The game's own HEALTH_BARS_INFO says what it means and what ALT does to
  // it — "This option will always show unit and building health bars. While this option is
  // enabled, holding down the ALT key will temporarily hide these health bars."
  { key: "healthBars", frame: "HealthBarsCheckBox", kind: "bool", panel: "gameplay", def: true },
  // …and what those bars are COLOURED like (see HEALTH_BAR_STYLES). A row of ours, on a frame
  // of ours, directly under the checkbox it qualifies.
  { key: "healthBarStyle", frame: "HealthBarStyleMenu", kind: "choice", panel: "gameplay", def: "default", choices: HEALTH_BAR_STYLES },
  { key: "autosaveReplay", frame: "AutosaveReplayCheckBox", kind: "bool", panel: "gameplay", def: true, applied: false },
  // Issue #124. The one gameplay option with a live backend: it is the DEFAULT value of the
  // Custom Game screen's "Computer+ (Improved AI)" switch (ui/fdfSkirmish.ts), so ticking it
  // here decides which AI a match starts with. Its frame is not the game's — no 2003 UI file
  // has a row for a second melee AI — it comes from `src/overrides/ui/OptionsMenu.fdf`, which
  // is also where the Game Port and Chat Support rows that used to sit under this one go.
  { key: "computerPlusDefault", frame: "ComputerPlusDefaultCheckBox", kind: "bool", panel: "gameplay", def: false },

  // --- Video (applied through render/videoQuality.ts, which documents what each rung does) ---
  { key: "gamma", frame: "GammaSlider", kind: "range", panel: "video", def: 50 },
  // The buffer the world is drawn into (see RESOLUTIONS). 1920x1080 is the default and is what
  // OpenWar3 has always rendered at, so a player who never opens this screen sees no change.
  { key: "resolution", frame: "ResolutionMenu", kind: "choice", panel: "video", def: "1920x1080", choices: RESOLUTIONS },
  // No LOD models to swap to: an MDX carries one mesh, and WC3's lower rungs picked a simpler
  // one. Faking it by thinning the map's doodads would change what the map LOOKS like rather
  // than how much it costs to draw, which is not what the row says.
  { key: "modelDetail", frame: "ModelDetailMenu", kind: "choice", panel: "video", def: "high", choices: quality("MODELS"), applied: false },
  { key: "animQuality", frame: "AnimQualityMenu", kind: "choice", panel: "video", def: "high", choices: quality("ANIM") },
  { key: "textureQuality", frame: "TextureQualityMenu", kind: "choice", panel: "video", def: "high", choices: quality("TEXTURES") },
  { key: "particles", frame: "ParticlesMenu", kind: "choice", panel: "video", def: "high", choices: quality("PARTICLES") },
  { key: "lights", frame: "LightsMenu", kind: "choice", panel: "video", def: "high", choices: quality("LIGHTS") },
  // "Unit Shadows:" (COLON_SHADOWS) — the model shadow decals, not the baked terrain layer.
  { key: "shadows", frame: "ShadowsMenu", kind: "choice", panel: "video", def: "on", choices: ON_OFF },
  // Occlusion is the x-ray silhouette a unit shows through a cliff or a tree — the thing
  // `EnableOcclusion` turns off for a cinematic (jass/natives/cinematic.ts). We don't draw it,
  // so there is nothing here to switch.
  { key: "occlusion", frame: "OcclusionMenu", kind: "choice", panel: "video", def: "on", choices: ON_OFF, applied: false },
  // …and no Spell Detail row: the shipped 1.30.4 OptionsMenu.fdf has the whole `SpellFilterMenu`
  // block commented out, so the panel it is bound to has never had one.

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
    // A store written before issue #141 carries a `healthBars` NOBODY CHOSE. The checkbox was
    // remembered but unapplied (`applied: false`) and defaulted to the game's own `false`, so
    // pressing OK on this screen once was enough to write a `false` into the store — while the
    // bars went on being drawn regardless, because nothing read it. Honouring that value now
    // would turn the bars off for exactly the players who never touched the row. Such a store
    // is precisely the one with no `healthBarStyle` in it (the sibling row that arrived with
    // the backend), so there the stale value is dropped and the new default stands.
    if (saved.healthBarStyle === undefined) delete saved.healthBars;
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
/** Should a new Custom Game open with Computer+ switched on? Options → Gameplay → "Use
 *  Computer+ as default AI", read straight from the committed store because the Custom Game
 *  screen is mounted long after the Options screen has been closed. */
export function computerPlusDefault(): boolean {
  return loadOptions().computerPlusDefault === true;
}

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
