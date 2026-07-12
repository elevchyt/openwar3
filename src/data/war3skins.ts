// UI\war3skins.txt — WC3's per-race skin table, and it serves two very different
// consumers, which is why the parse lives here rather than in either of them:
//
//   • the FDF `DecorateFileNames` flag (src/ui/fdf/library.ts) — a frame marked with it
//     names its textures by KEY ("EscMenuEditBoxBackground"), and the engine resolves the
//     key through this file. Without it, no in-game panel has any chrome (7.19).
//   • the MUSIC playlists (src/audio/sounds.ts) — `SetMapMusic("Music", true, 0)`, which
//     every one of the 165 bundled maps calls, names a PLAYLIST KEY, not a file. It
//     resolves to e.g. `Music_V1` in the local player's race section:
//       [Orc] Music_V1=Sound\Music\mp3Music\OrcX1.mp3;…\Orc3.mp3;…\Orc2.mp3;…\Orc1.mp3
//     That is how melee gives an Orc player orc music and a Human player human music.
//
// Structure: `[Section]` blocks of `Key=Value`, `//` comments. `[Default]` carries the
// full table (Human's art); each race section overrides a handful of entries.

export const WAR3SKINS = "UI\\war3skins.txt";

/** The `_V<n>` suffix the engine appends to a versioned key. Warcraft III keys its music
 *  lists by game version — `Music_V0` is Reign of Chaos, `Music_V1` is The Frozen Throne.
 *  We target TFT 1.27a, so V1. (A `_V1Beta` set also ships; the engine ignores it.) */
export const SKIN_VERSION_SUFFIX = "_V1";

/** Parse war3skins.txt into `section → key → value`. */
export function parseWar3Skins(src: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let section = new Map<string, string>();
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = new Map();
      out.set(head[1], section);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) section.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

/** Look a key up in `skin`'s section, falling back to `[Default]`. Returns undefined
 *  when neither has it — callers treat that as "the name is already a literal". */
export function skinValue(skins: Map<string, Map<string, string>>, skin: string, key: string): string | undefined {
  return skins.get(skin)?.get(key) ?? skins.get("Default")?.get(key);
}
