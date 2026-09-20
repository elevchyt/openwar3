import type { MpqDataSource } from "../vfs/mpq";
import { readW3i } from "./w3i";

// What FORMAT a map file is, asked once at the map door (docs/map-compatibility.md).
//
// This is the whole of the compatibility layer's state: one value, read when the archive is
// opened, carried from there. Nothing deeper in the engine re-derives it and nothing in the
// sim, the renderer, the AI or the data tables ever asks "is this a Reforged map" — that is
// the difference between a compatibility layer and a fork.
//
// The versions themselves are documented where they are PARSED (the viewer patch's w3i, w3e
// and w3u hunks); what is here is the reading of them: which of those a map is, and whether
// the engine can play it.

/** Which compiled script the engine would run. */
export type MapScriptLanguage = "jass" | "lua" | "none";

export interface MapFormatProfile {
  /** war3map.w3i's version: 18 = RoC, 25 = TFT, 28 = 1.31, 31 = 1.32, 32/33 = Reforged. */
  w3iVersion: number;
  /** The editor's build as major*100+minor — 130 for a 1.30 map, 200 for a Reforged 2.0 one.
   *  0 below 1.31, which is every map the 2003 editors wrote. Gates the `.doo` skin id. */
  editorBuild: number;
  /** war3map.w3e's version: 11 (7-byte corners) or 12 (8-byte, >16 tilesets). */
  terrainVersion: number;
  /** The highest object-data version across the map's seven object files: 1, 2 or 3. */
  objectVersion: number;
  scriptLanguage: MapScriptLanguage;
  /** The w3i stopped early — a protected map, or a format newer than we read. The header
   *  fields (tileset, build version, flags) are still good; the player slots may not be. */
  partialW3i: boolean;
  /** Saved by an editor newer than the one this engine targets. Diagnostic only: a later
   *  format is not by itself a refusal, and after the parsers learned v32/v33, v3 and v12
   *  most such maps play. */
  laterFormat: boolean;
}

/** What the map door reads when there is no map (a campaign chapter's repacked archive that
 *  has no w3i, a file that is not a map at all). */
export const UNKNOWN_FORMAT: MapFormatProfile = {
  w3iVersion: 0,
  editorBuild: 0,
  terrainVersion: 0,
  objectVersion: 0,
  scriptLanguage: "none",
  partialW3i: false,
  laterFormat: false,
};

/** The seven object files, in the order the engine reads them. */
const OBJECT_FILES = [
  "war3map.w3u", "war3map.w3t", "war3map.w3b", "war3map.w3h",
  "war3map.w3a", "war3map.w3d", "war3map.w3q",
];

/** The first int of a file, or 0 — every one of these formats leads with its version (the w3e
 *  after its `W3E!` magic), so no parser has to run to ask this. */
function versionAt(bytes: Uint8Array | null, offset: number): number {
  if (!bytes || bytes.length < offset + 4) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

/** Read a map archive's format profile. Cheap — four small reads and no full parse. */
export function readMapFormat(mpq: MpqDataSource): MapFormatProfile {
  const w3iBytes = mpq.rawBytes("war3map.w3i");
  if (!w3iBytes) return { ...UNKNOWN_FORMAT, scriptLanguage: scriptOf(mpq) };

  const { info, partial } = readW3i(w3iBytes);
  let objectVersion = 0;
  for (const name of OBJECT_FILES) {
    objectVersion = Math.max(objectVersion, versionAt(mpq.rawBytes(name), 0));
  }
  const editorBuild = info.getBuildVersion();
  return {
    w3iVersion: info.version,
    editorBuild,
    terrainVersion: versionAt(mpq.rawBytes("war3map.w3e"), 4),
    objectVersion,
    scriptLanguage: scriptOf(mpq),
    partialW3i: partial,
    // 1.30.4 is what we target; anything the 1.31+ editors stamped is "later". A 2003 map
    // stamps nothing at all (build 0), which is the common case and not a later format.
    laterFormat: editorBuild > 130 || info.version > 25,
  };
}

/** Which script a map ships — both layouts, the MPQ-era root and the Reforged `scripts\`. */
function scriptOf(mpq: MpqDataSource): MapScriptLanguage {
  if (mpq.exists("war3map.j") || mpq.exists("scripts\\war3map.j")) return "jass";
  if (mpq.exists("war3map.lua") || mpq.exists("scripts\\war3map.lua")) return "lua";
  return "none";
}

/**
 * Why this map cannot be played, in the player's words — or null when it can.
 *
 * This is the ONE place that decides, and it is deliberately short: a map is refused for
 * something the engine genuinely cannot do, never for being new. Everything the parsers were
 * taught (w3i v32/v33, object data v3, terrain v12) is absent from this list on purpose.
 */
export function unsupportedReason(profile: MapFormatProfile): string | null {
  if (profile.w3iVersion === 0) return "This file has no map information in it.";
  if (profile.scriptLanguage === "lua") return "This map's triggers are written in Lua, which OpenWar3 cannot run yet.";
  return null;
}
