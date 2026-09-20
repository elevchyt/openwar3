import w3iParser from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";

// Reading a war3map.w3i that may not read whole (docs/map-compatibility.md).
//
// The w3i is the KEYSTONE of a map load: the Custom Game list is built from it, `loadMapBytes`
// refuses a map without it, and its build version is what gates the Reforged skin id in
// war3map.doo / war3mapUnits.doo. So an all-or-nothing read is an all-or-nothing map, and that
// is what OpenWar3 had — `info.load(bytes)` throwing took the whole map out of the list, with
// no row, no reason and nothing for the player to act on.
//
// Two different files land here and only one of them is about a later editor:
//
//   * a map saved by a 1.32+ editor, which the parser now knows (w3i v32 appends two ints and
//     v33 a third — the map's own camera distances; see the viewer patch), and
//   * a **protected** map, whose w3i has been deliberately TRUNCATED so the World Editor cannot
//     open it. Five of the eight maps in a stock install's own `Maps\Download` are like this —
//     Extreme Candy War, DotA, Angel Arena, Custom Hero Survival, Bleach vs One Piece — each
//     ending in a lone 0xff mid-structure. The real client plays every one of them, because it
//     reads the fields it needs and does not care that the file stops early.
//
// So the read is TOLERANT as well as version-aware, which costs nothing: the parser fills its
// own fields as it goes, so whatever was read before the throw is already there. That is
// exactly what mdx-m3-viewer's own `loadMapInformation` relies on, and it is why a protected
// map still knows its tileset and its build version.

/** A w3i read, whole or partial. */
export interface ReadW3i {
  /** The parser, filled as far as the bytes went. */
  info: InstanceType<typeof w3iParser.File>;
  /** The file stopped early — a protected map, or a format even newer than we know. */
  partial: boolean;
  /** Why it stopped, for the diagnostics surface. Empty when it did not. */
  reason: string;
}

/**
 * Read a war3map.w3i, keeping whatever parsed.
 *
 * A caller that needs the fields to be TRUSTWORTHY (the lobby's slots, a match's forces) should
 * check `partial` and decide; a caller that only wants the header (tileset, build version,
 * flags) can use the result as it stands, because those come first in the file and are never
 * the part that is missing.
 */
export function readW3i(bytes: Uint8Array): ReadW3i {
  const info = new w3iParser.File();
  try {
    info.load(bytes);
    return { info, partial: false, reason: "" };
  } catch (err) {
    return { info, partial: true, reason: err instanceof Error ? err.message : String(err) };
  }
}
