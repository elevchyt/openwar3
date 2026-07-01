// Content profiles (plan §0). A profile is which MPQ layers to mount (+ ruleset,
// later). Profiles, not forks: RoC and TFT are the same engine over different
// data. `archives` is listed LOWEST priority first (later entries override earlier).

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
    archives: ["war3.mpq", "war3x.mpq", "war3xlocal.mpq", "war3patch.mpq"],
  },
  // Later (§9): a Reign of Chaos install mounts only the base + its patch.
  roc: {
    id: "roc",
    name: "Reign of Chaos",
    archives: ["war3.mpq", "war3patch.mpq"],
  },
};

export const DEFAULT_PROFILE = PROFILES.tft;
