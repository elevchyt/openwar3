import w3iParser from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";
import type { MpqDataSource } from "../vfs/mpq";
import { readMapScript, type MapScript } from "./triggers";

// Classify a map as **standard melee** vs **custom / scenario / game mode**.
//
// Ground truth is the war3map.w3i "flags" bitfield: the World Editor sets the
// MELEE bit (0x0004) iff the map was authored as a melee map. This is what lets
// us set up a melee map with the standard rules (starting town hall + workers,
// melee AI, defeat-on-no-buildings) while leaving a custom map's setup to its
// own triggers.
//
// Verified against ALL 161 bundled 1.27a maps (RoC + TFT): every one of the 148
// stock melee maps has the MELEE flag set AND every standard Melee* init call in
// war3map.j; every Scenario map has the flag clear. The single edge case —
// TFT Scenario (4)Monolith — calls 5/8 Melee* functions yet has the flag OFF,
// which is exactly right: it's an *altered-melee* custom map and must run as
// custom. So the FLAG is authoritative; the trigger-script scan (readMapScript)
// is a corroborating signal we keep for diagnostics, not the decider.
//
// Flag bit meanings: WC3 w3i format (Hive Workshop map spec / wc3maptranslator).

/** war3map.w3i global-property flags (Map Properties dialog). Only `melee`
 *  drives behaviour today; the rest are decoded for diagnostics / future use. */
export const W3I_FLAGS = {
  hideMinimapPreview: 0x0001,
  modifyAllyPriorities: 0x0002,
  melee: 0x0004,
  playableSizeLargeNeverReduced: 0x0008,
  maskedAreaPartiallyVisible: 0x0010,
  fixedPlayerForceSetting: 0x0020,
  useCustomForces: 0x0040,
  useCustomTechtree: 0x0080,
  useCustomAbilities: 0x0100,
  useCustomUpgrades: 0x0200,
  mapPropertiesOpened: 0x0400,
  waterWavesOnCliffShores: 0x0800,
  waterWavesOnRollingShores: 0x1000,
} as const;

export type MapKind = "melee" | "custom";

export interface MapClassification {
  kind: MapKind;
  /** The authoritative w3i melee flag. */
  isMelee: boolean;
  /** Raw w3i flags bitfield (0 if the map has no war3map.w3i). */
  flags: number;
  /** Names of the set flags (diagnostics). */
  flagNames: string[];
  /** The compiled trigger script + its melee-init markers (see readMapScript). */
  script: MapScript;
}

/** Classify an already-opened map archive. Cheap: reads only war3map.w3i (tiny)
 *  and the compiled trigger script. */
export function classifyMap(mpq: MpqDataSource): MapClassification {
  let flags = 0;
  const w3iBytes = mpq.rawBytes("war3map.w3i");
  if (w3iBytes) {
    const info = new w3iParser.File();
    info.load(w3iBytes);
    flags = info.flags;
  }
  const isMelee = (flags & W3I_FLAGS.melee) !== 0;
  const flagNames = Object.entries(W3I_FLAGS)
    .filter(([, bit]) => (flags & bit) !== 0)
    .map(([name]) => name);
  return {
    kind: isMelee ? "melee" : "custom",
    isMelee,
    flags,
    flagNames,
    script: readMapScript(mpq),
  };
}
