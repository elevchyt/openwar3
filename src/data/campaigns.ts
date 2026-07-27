import type { DataSource } from "../vfs/types";
import { parseWar3Skins, skinValue, SKIN_VERSION_SUFFIX, WAR3SKINS } from "./war3skins";

// The campaign index (issue #101) — what the Campaign screen is a view of.
//
// Warcraft III keeps the whole thing in ONE data file, and the file documents itself in its
// own header comment (UI\CampaignStrings_exp.txt, quoted here where it decides something):
//
//   • `[Index] CampaignList` names the campaign SECTIONS, "The order of these values is
//     significant, as that is the order in which they will appear on the campaign selection
//     screen." TFT's list carries empty entries between them — the Reign of Chaos campaigns'
//     slots — and those are skipped.
//   • each `[Section]` is one campaign: a `Header`/`Name` pair (the two lines a campaign row
//     shows: "Sentinels Campaign" / "Terror of the Tides"), the 3D `Background` model, its fog,
//     the racial `Cursor`, the `AmbientSound`, up to three cinematics, and `MissionN`.
//   • `MissionN="Header","Mission Name","Map Filename"` — "You can have up to 128 missions in a
//     given campaign, but putting more than 15 will make a scrollbar appear to see the rest."
//     (TFT's longest is Legacy of the Damned at 14, so nothing here ever scrolls.)
//   • `DefaultOpen=1` marks a campaign "initially open and selectable by a new user"; the rest
//     unlock as the player finishes the one before (see campaignProgress.ts).
//
// `Background` is a war3skins.txt KEY, not a path, and the file says so: "The value specified
// must be an entry in the war3skins.txt file. Realize that this value is processed using the
// expansion naming convention (i.e. V0, V1, etc)" — so `NightElfBackdrop` + `_V1` resolves to
// UI\Glues\SinglePlayer\NightElf_Exp\NightElf_Exp.mdl, the TFT backdrop, while `_V0` would give
// the RoC one. That is the same `_V1` suffix the music playlists use (data/war3skins.ts).
//
// TFT ONLY, deliberately: Reign of Chaos's UI\CampaignStrings.txt predates this format (its
// campaigns are hardcoded frames in RoC's CampaignMenu.fdf, and its missions are parallel
// `TitleN`/`MissionN`/`FileN` keys with no CampaignList at all). OpenWar3 targets TFT first;
// the RoC layout is a content profile for later, not a second code path today.

/** The expansion campaign index. RoC's same-named file is the older format — see above. */
export const CAMPAIGN_INDEX = "UI\\CampaignStrings_exp.txt";

/** The racial cursor a campaign screen wears. From the file's own header comment:
 *  "Human = 0, Orc = 1, Undead = 2, Night Elf = 3." */
export const CURSOR_RACES = ["Human", "Orc", "Undead", "NightElf"] as const;
export type CursorRace = (typeof CURSOR_RACES)[number];

/** One entry of a campaign's mission list, or one of its three cinematics — both are the
 *  same shape in the file: `Header`, `Name`, `File`. */
export interface CampaignEntry {
  /** The small line above the name: "Chapter One", "Interlude", "Cinematic". */
  header: string;
  /** The entry's own title: "Rise of the Naga". */
  name: string;
  /**
   * What it plays, and it is not always a map:
   *   • a mission names a map inside the archives (`Maps\FrozenThrone\Campaign\*.w3x`);
   *   • a cinematic names a MOVIE (`IntroX` → Movies\IntroX.mpq — which, despite the
   *     extension, is a plain RIFF AVI, not an archive);
   *   • and Legacy of the Damned's finale, "A Long Time Coming", names a MODEL:
   *     `Doodads\Cinematic\ArthasIllidanFight\ArthasIllidanFight.mdl`, played in-engine.
   * Verified against the archives: every other MissionN file in the index resolves to a real
   * map, and that one resolves to a real .mdl.
   */
  file: string;
  /** From a `MissionN` key — a chapter of the campaign, rather than one of its three
   *  campaign-level cinematics. It is what the chapter's progress is counted by. */
  mission: boolean;
  /** The file is a MAP this engine can start. False for the movies and for the model finale. */
  playable: boolean;
}

export interface Campaign {
  /** The section name, and our stable id for it: "NightElf", "Human", "Undead", "Orc". */
  key: string;
  /** "Sentinels Campaign" — the small line over the campaign's name. */
  header: string;
  /** "Terror of the Tides". */
  name: string;
  /** Selectable from a fresh profile (`DefaultOpen=1`); the others unlock in list order. */
  defaultOpen: boolean;
  /** The war3skins key for the 3D backdrop, already `_V1`-resolved to a model path. */
  background: string | null;
  /** The screen's distance fog, straight out of the campaign's `BackgroundFog*` keys. */
  fog: { style: number; r: number; g: number; b: number; a: number; density: number; start: number; end: number };
  /** Which race's cursor the screen wears. */
  cursor: CursorRace;
  /** An AmbienceSounds.slk row key — the loop under the campaign screen. */
  ambientSound: string | null;
  /** The campaign's chapters, in file order. */
  missions: CampaignEntry[];
  /** Intro / Open / End cinematics, in the order the screen lists them (open first, at the
   *  top of the list, and end last — they bracket the missions). Empty keys are dropped. */
  intro: CampaignEntry | null;
  open: CampaignEntry | null;
  end: CampaignEntry | null;
}

/** Read and parse the campaign index out of the mounted install. Returns [] when the file
 *  isn't there (a Reign-of-Chaos-only install). */
export async function loadCampaigns(vfs: DataSource): Promise<Campaign[]> {
  if (!vfs.exists(CAMPAIGN_INDEX)) return [];
  const src = new TextDecoder("latin1").decode(await vfs.read(CAMPAIGN_INDEX));
  const skins = vfs.exists(WAR3SKINS)
    ? parseWar3Skins(new TextDecoder("latin1").decode(await vfs.read(WAR3SKINS)))
    : new Map<string, Map<string, string>>();
  // war3skins spells the backdrop `.mdl` (the World Editor's own spelling); the archives ship
  // the compiled `.mdx`. Same swap as everywhere else a data file names a model
  // (render/dayNight.ts, mapViewer.ts) — without it the campaign screen has no background.
  return parseCampaigns(src, (key) =>
    skinValue(skins, "Default", key + SKIN_VERSION_SUFFIX)?.replace(/\.mdl$/i, ".mdx") ?? null);
}

/** The parse itself, split out so it can be run headlessly over the raw file. */
export function parseCampaigns(src: string, resolveBackground: (key: string) => string | null): Campaign[] {
  const sections = parseSections(src);
  const list = splitValues(sections.get("Index")?.get("CampaignList") ?? "")
    .map(unquote)
    .filter((s) => s.length > 0); // TFT leaves the RoC campaigns' slots empty

  const out: Campaign[] = [];
  for (const key of list) {
    const s = sections.get(key);
    if (!s) continue;
    const bg = unquote(s.get("Background") ?? "");
    out.push({
      key,
      header: unquote(s.get("Header") ?? key),
      name: unquote(s.get("Name") ?? ""),
      defaultOpen: (s.get("DefaultOpen") ?? "0").trim() === "1",
      background: bg ? resolveBackground(bg) : null,
      fog: parseFog(s),
      cursor: CURSOR_RACES[clampCursor(s.get("Cursor"))],
      ambientSound: unquote(s.get("AmbientSound") ?? "") || null,
      missions: parseMissions(s),
      intro: parseEntry(s.get("IntroCinematic")),
      open: parseEntry(s.get("OpenCinematic")),
      end: parseEntry(s.get("EndCinematic")),
    });
  }
  return out;
}

/**
 * The rows the chapter screen shows for a campaign, top to bottom.
 *
 * The campaign's own cinematics bracket its missions: the Open cinematic plays before
 * chapter one (Terror of the Tides opens on "The Awakening") and the End one after the
 * last (Legacy of the Damned closes on "The Ascension"). An Intro cinematic — none of the
 * TFT four has one — sits above the Open.
 */
export function campaignRows(c: Campaign): CampaignEntry[] {
  return [c.intro, c.open, ...c.missions, c.end].filter((e): e is CampaignEntry => e !== null);
}

// --- the file format ---------------------------------------------------------------

/** `[Section]` blocks of `Key=Value`, `//` comments — the same shape as war3skins.txt. */
function parseSections(src: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let section = new Map<string, string>();
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = new Map();
      out.set(head[1].trim(), section);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) section.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

/** `Mission0`, `Mission1`, … in order, stopping at the first gap (the file numbers them
 *  contiguously; a gap means the campaign ended, not that we should keep scanning to 128). */
function parseMissions(s: Map<string, string>): CampaignEntry[] {
  const out: CampaignEntry[] = [];
  for (let i = 0; ; i++) {
    const entry = parseEntry(s.get(`Mission${i}`));
    if (!entry) break;
    out.push({ ...entry, mission: true });
  }
  return out;
}

/** `"Header","Name","File"` — plus, on one Bonus-campaign row, a fourth field
 *  (`Mission1=…,"…OrcX02.w3x",1`, the chapter that continues across OrcX02_02…_10). It
 *  selects nothing we present, so it is read and dropped rather than guessed at. */
function parseEntry(value: string | undefined): CampaignEntry | null {
  if (!value) return null;
  const parts = splitValues(value).map(unquote);
  if (parts.length < 3 || !parts[2]) return null;
  const file = parts[2];
  return { header: parts[0], name: parts[1], file, mission: false, playable: /\.w3[mx]$/i.test(file) };
}

function parseFog(s: Map<string, string>): Campaign["fog"] {
  // BackgroundFogColor=A,R,G,B in 0..255 (Undead's 255,178,178,204 is the pale blue haze
  // over Northrend; Alliance's 255,127,51,51 the red one over Outland).
  const [a, r, g, b] = splitValues(s.get("BackgroundFogColor") ?? "255,255,255,255").map((v) => Number(v) || 0);
  return {
    style: Number(s.get("BackgroundFogStyle") ?? 0) || 0,
    a: a / 255, r: r / 255, g: g / 255, b: b / 255,
    density: Number(s.get("BackgroundFogDensity") ?? 0) || 0,
    start: Number(s.get("BackgroundFogStart") ?? 0) || 0,
    end: Number(s.get("BackgroundFogEnd") ?? 0) || 0,
  };
}

function clampCursor(v: string | undefined): number {
  const n = Number(v ?? 0);
  return Number.isInteger(n) && n >= 0 && n < CURSOR_RACES.length ? n : 0;
}

/** Split a comma-separated value, ignoring commas INSIDE quotes — "Chapter Seven, Part One"
 *  is one field, and splitting it naively would shift every field after it by one. */
function splitValues(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') { quoted = !quoted; cur += ch; continue; }
    if (ch === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function unquote(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1) : t;
}
