// Content profiles (plan §0). A profile is which MPQ layers to mount (+ ruleset,
// later). Profiles, not forks: RoC and TFT are the same engine over different
// data. `archives` is listed LOWEST priority first (later entries override earlier).
//
// The archive ORDER is no longer here: an MPQ-era folder mounts every archive of
// `MPQ_ERA_ORDER` it has (vfs/mpqEra.ts — three generations of names, one order), and a 1.30+
// install is a CASC content store whose layering is in its own root listing (ARCHIVE_ORDER in
// vfs/casc.ts). `archives` is what a profile cannot do WITHOUT, for the gate to report.

export interface ContentProfile {
  id: "tft" | "roc";
  name: string;
  archives: string[];
}

export const PROFILES: Record<ContentProfile["id"], ContentProfile> = {
  // Default: a Frozen Throne install is a superset layered over RoC's base data.
  tft: {
    id: "tft",
    name: "The Frozen Throne",
    archives: ["war3.mpq", "war3x.mpq"],
  },
  // Later (§9): a Reign of Chaos install mounts only the base + its patch.
  roc: {
    id: "roc",
    name: "Reign of Chaos",
    archives: ["war3.mpq"],
  },
};

export const DEFAULT_PROFILE = PROFILES.tft;
