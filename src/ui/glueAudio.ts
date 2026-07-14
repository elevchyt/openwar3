import type { SoundBoard } from "../audio/sounds";
import type { DataSource } from "../vfs/types";

// The menu's audio, all of it read from the install (issue #54/#61). Three layers, and
// only one of them is a file path we have to name ourselves:
//
//   the click   UISounds.slk `GlueScreenClick`  → Sound\Interface\BigButtonClick.wav
//                 (volume 100, NODUPLICATES — so a double-click doesn't play it twice)
//   the bed     AmbienceSounds.slk `ExpansionGlueScreenWind` → Sound\Ambient\War3XMainGlueScreen.wav
//                 (volume 75, LOOPING; RoC's `GlueScreenWind` → GlueScreenWindLoop1.wav)
//   the whoosh  the panel models' own SND events (render/menuScene.ts), which resolve
//                 through AnimLookups → AnimSounds to Left/Right/BothGlueScreenPop*.wav
//
// The MUSIC is the exception: it is the one thing the data doesn't name. war3skins.txt has
// a `Music` playlist per RACE (what a melee game plays) and Victory/Defeat stings, but no
// glue-screen entry — the main-screen theme is chosen by the client itself, so the path is
// ours to state. It is the only hardcoded string here, and both editions ship one.
//
// Note the ambience is NOT the music, despite War3XMainGlueScreen.wav being the file people
// reach for: it is the wind/creak bed under the menu (its row sits in AmbienceSounds with
// the waterfalls and braziers). The theme is a separate mp3.

const TFT_MUSIC = "Sound\\Music\\mp3Music\\War3XMainScreen.mp3";
const ROC_MUSIC = "Sound\\Music\\mp3Music\\Mainscreen.mp3";
const TFT_AMBIENCE = "ExpansionGlueScreenWind";
const ROC_AMBIENCE = "GlueScreenWind";

/** UISounds.slk row for a menu button press. */
export const GLUE_CLICK = "GlueScreenClick";

/** The main menu's music + ambience bed, and the sounds its screens make. */
export class GlueAudio {
  private readonly music: string;
  private readonly ambience: string;

  constructor(private sounds: SoundBoard, vfs: DataSource) {
    // Expansion install → the TFT main screen (its theme, its wind); else Reign of Chaos's.
    // The same signal MenuScene picks its 3D background model with: is the TFT file there.
    const tft = vfs.exists(TFT_MUSIC);
    this.music = tft ? TFT_MUSIC : ROC_MUSIC;
    this.ambience = tft ? TFT_AMBIENCE : ROC_AMBIENCE;
  }

  /** The menu is up: theme + wind. Both survive the browser's autoplay gate — the
   *  SoundBoard holds the request and starts it on the first gesture if it must. */
  start(): void {
    this.sounds.playMusic(this.music); // one track, looped: the list is this file alone
    this.sounds.setAmbienceLoop(this.ambience, true);
  }

  /** The menu is gone (a match is starting): the theme fades, the wind stops dead. From
   *  here the map's own script owns the music channel (SetMapMusic in its main()). */
  stop(): void {
    this.sounds.stopMusic(true);
    this.sounds.setAmbienceLoop(this.ambience, false);
  }

  /** A menu button was pressed. */
  click(): void {
    this.sounds.playUi(GLUE_CLICK);
  }

  /** A panel-chrome SND event came due (MenuScene.onSound) — its 4-char AnimLookups code. */
  event(code: string): void {
    this.sounds.playAnimEvent(code);
  }
}
