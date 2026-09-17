import type { SoundBoard } from "../audio/sounds";
import type { DataSource } from "../vfs/types";
import { parseWar3Skins, skinValue, WAR3SKINS } from "../data/war3skins";
import { isRoc, skinVersionSuffix } from "../data/edition";

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
// The MUSIC and the wind are both versioned war3skins keys in `[Default]`:
//   GlueMusic_V1=Sound\Music\mp3Music\War3XMainScreen.mp3;…     GlueScreenLoop_V1=ExpansionGlueScreenWind
//   GlueMusic_V0=Sound\Music\mp3Music\Mainscreen.mp3;…          GlueScreenLoop_V0=GlueScreenWind
// so the pair follows the edition the client is on (data/edition.ts) and is re-read when the
// main menu's edition button flips it. An install whose download left out an edition's theme
// (1.30.4's store streams the mp3s, and not every one is local) keeps the other one playing
// rather than going silent.
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
  private music = TFT_MUSIC;
  private ambience = TFT_AMBIENCE;
  private readonly skins: Map<string, Map<string, string>>;

  constructor(private sounds: SoundBoard, private vfs: DataSource) {
    const bytes = vfs.rawBytes(WAR3SKINS);
    this.skins = bytes ? parseWar3Skins(new TextDecoder("latin1").decode(bytes)) : new Map();
    this.pick();
  }

  /** Read the current edition's theme and wind (see the header). */
  private pick(): void {
    const theme = skinValue(this.skins, "Default", "GlueMusic" + skinVersionSuffix())?.split(";")[0]
      ?? (isRoc() ? ROC_MUSIC : TFT_MUSIC);
    const other = isRoc() ? TFT_MUSIC : ROC_MUSIC;
    this.music = this.vfs.exists(theme) ? theme : other;
    this.ambience = skinValue(this.skins, "Default", "GlueScreenLoop" + skinVersionSuffix())
      ?? (isRoc() ? ROC_AMBIENCE : TFT_AMBIENCE);
  }

  /** The edition changed under a running menu: stop this edition's bed and start the other's.
   *  The theme restarts from the top, as the reference's does when it swaps the glue. */
  swapEdition(): void {
    this.sounds.clearMapMusic();
    this.sounds.stopMusic(false);
    this.sounds.setAmbienceLoop(this.ambience, false);
    this.pick();
    this.start();
  }

  /** The menu is up: theme + wind. Both survive the browser's autoplay gate — the
   *  SoundBoard holds the request and starts it on the first gesture if it must. */
  start(): void {
    this.sounds.playMusic(this.music); // one track, looped: the list is this file alone
    this.sounds.setAmbienceLoop(this.ambience, true);
  }

  /** The wind alone, without touching the theme. The Campaign screen runs its campaign's own
   *  `AmbientSound` loop instead of the main screen's (data/campaigns.ts), and hands this one
   *  back on the way out — the music plays under both. */
  stopAmbience(): void { this.sounds.setAmbienceLoop(this.ambience, false); }
  startAmbience(): void { this.sounds.setAmbienceLoop(this.ambience, true); }

  /** The menu is gone (a match is starting): the theme fades, the wind stops dead. From
   *  here the map's own script owns the music channel (SetMapMusic in its main()). */
  stop(): void {
    // The theme is a one-song PLAYLIST, and StopMusic leaves a playlist standing to come back
    // (SoundBoard.stopMusic) — so it is cleared first, or a map that cues no music of its own
    // would hear the menu theme return a few minutes into the match.
    this.sounds.clearMapMusic();
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
