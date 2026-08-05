import type { DataSource } from "../vfs/types";
import type { Race } from "./races";

// The loading screens (issue #110) — the art WC3 puts up between the menus and the match.
//
// There are three families, and a map picks one of them without ever naming a file:
//
//   1. **The preset screens.** `UI\WorldEditData.txt` `[LoadingScreens]` is the whole table,
//      and it documents its own columns:
//
//          // Value 0: Game version in which this loading screen first appeared
//          // Value 1: Display text for editor
//          // Value 2: Integer indicating which animation sequence to use
//          // Value 3: Model file for screen graphics
//          46=1,WESTRING_LOADINGSCREEN_NIGHTELFX01,0,…\AshenvaleExpansionBackground.mdl
//
//      A map names a ROW of it by number, and that is the field the World Editor calls the
//      "campaign background". Verified against the archives: Rise of the Naga (NightElfX01)
//      carries 46, Chapter One of the Alliance campaign (HumanX01) 57, Undead X04 72 — each
//      the row whose WESTRING is that chapter's. Note the sequence column: one model serves a
//      whole campaign and the sequence picks the LOCATION marker for that chapter
//      (AshenvaleExpansionBackground.mdx's two clips are literally named "NightElfX01" and
//      "NightElfXInterlude01").
//   2. **The map's own imported model**, when it ships one (`war3map.w3i`'s TFT-only custom
//      loading screen path). Nothing stock uses it; custom maps do.
//   3. **The multiplayer screens**, which no map names at all: a melee game shows the LOCAL
//      player's race (`Load-Multiplayer-Orc.mdx` and friends, `-Random` included), because
//      the screen is about who YOU are, not about the map.
//
// Every one of these models is a flat quad authored in the FDF's own 0.8 × 0.6 UI space with
// no camera — they are 2D art, not scenes (render/loadingScene.ts draws them as such).

/** The table's home. Also holds the editor's tileset/sound-channel lists. */
export const WORLD_EDIT_DATA = "UI\\WorldEditData.txt";

/** One row of `[LoadingScreens]`. */
export interface LoadingScreenDef {
  /** The editor's own label key ("WESTRING_LOADINGSCREEN_NIGHTELFX01") — kept for logging;
   *  nothing on the loading screen shows it. */
  label: string;
  /** Which sequence of `model` to play. One model serves a whole campaign; this is the clip
   *  that lights up the chapter's own location on it. */
  sequence: number;
  /** The background model, as an `.mdx` path (the table spells it `.mdl`, the archives ship
   *  the compiled twin — the same swap data/campaigns.ts makes for the campaign backdrops). */
  model: string;
}

/** The screen a melee game shows: the LOCAL player's race, `-Random` included. */
export function multiplayerLoadingScreen(race: Race): string {
  const art: Record<Race, string> = {
    human: "Human", orc: "Orc", undead: "Undead", nightelf: "NightElf", random: "Random",
  };
  return `UI\\Glues\\Loading\\Multiplayer\\Load-Multiplayer-${art[race]}.mdx`;
}

/** The fallback background: a map that names no screen and no race to show. It is a row of
 *  the table too (45, WESTRING_LOADINGSCREEN_GENERIC) — named here because it is reached when
 *  the table itself could not be read. */
export const GENERIC_LOADING_SCREEN = "UI\\Glues\\Loading\\Load-Generic\\Load-Generic.mdx";

/** The load bar, over whichever background is up. Its own model, in the same 0.8 × 0.6 space —
 *  and the one piece of the screen the ENGINE animates rather than the file: its "Loading Bar
 *  Fill" and "Loading Bar Glow" bones carry no tracks at all (see render/loadingScene.ts). */
export const LOAD_BAR_MODEL = "UI\\Glues\\Loading\\LoadBar\\LoadBar.mdx";

/** Read `[LoadingScreens]` out of the mounted install. Returns [] if the file is absent. */
export async function loadLoadingScreens(vfs: DataSource): Promise<LoadingScreenDef[]> {
  if (!vfs.exists(WORLD_EDIT_DATA)) return [];
  return parseLoadingScreens(new TextDecoder("latin1").decode(await vfs.read(WORLD_EDIT_DATA)));
}

/** The parse itself, split out so it can be run over the raw file headlessly. */
export function parseLoadingScreens(src: string): LoadingScreenDef[] {
  const out: LoadingScreenDef[] = [];
  let inSection = false;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    // `//#LINENOBETA` sits between the expansion rows — a build directive, not data.
    if (!line || line.startsWith("//")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { inSection = head[1].trim() === "LoadingScreens"; continue; }
    if (!inSection) continue;
    // `00=0,WESTRING_…,0,UI\Glues\…\TutorialBackground.mdl` — the index is the row's own
    // zero-padded number, which is what a w3i stores.
    const m = /^(\d+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue; // NumScreens=98 and anything else that isn't a row
    const fields = m[2].split(",");
    if (fields.length < 4) continue;
    out[parseInt(m[1], 10)] = {
      label: fields[1].trim(),
      sequence: parseInt(fields[2], 10) || 0,
      model: fields[3].trim().replace(/\.mdl$/i, ".mdx"),
    };
  }
  return out;
}
