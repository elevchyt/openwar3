import type { DataSource } from "./types";
import { isRoc, ROC_DATA_SET } from "../data/edition";

// The Reign of Chaos DATA SET, laid over the live paths (docs/editions.md).
//
// A 1.30.4 store keeps the expansion's object tables at their ordinary paths (`Units\UnitData.slk`)
// and Reign of Chaos's copies one folder down, at the SAME path under `Melee_V0\` — every
// `Units\*` table, the four melee `Scripts\*.ai` with their `.pld`s, and
// `UI\FrameDef\InfoPanelStrings.fdf` (whose armour tips describe RoC's damage table). That is the
// whole of the rule, so it is written as one: while the client is on Reign of Chaos, a path that
// has a `Melee_V0\` twin reads the twin.
//
// Why `Melee_V0` and not `Custom_V0`: the World Editor names the pair "Melee (Latest Patch)" and
// "Custom (1.01)" (UI\WorldEditStrings.txt `WESTRING_GAMEDATASET_*`). The expansion side of this
// client reads the latest tables for every map, melee or custom alike, and its RoC side does the
// same — the balance a Reign of Chaos player last played on.
//
// The switch is read at EVERY lookup rather than baked in, because the menu flips it on a mounted
// install. Anything that parsed a table before the flip still holds the old edition's copy; the
// things that cache across matches are told through `onEditionChange` (src/data/edition.ts).
// An MPQ-era install has no `Melee_V0\` at all, so it reads the live tables in both editions.

export class EditionDataSource implements DataSource {
  constructor(private base: DataSource) {}

  get label(): string {
    return this.base.label;
  }

  /** The path the current edition reads `path` from. */
  private resolve(path: string): string {
    if (!isRoc()) return path;
    const twin = `${ROC_DATA_SET}\\${path.replace(/\//g, "\\").replace(/^\\+/, "")}`;
    return this.base.exists(twin) ? twin : path;
  }

  exists(path: string): boolean {
    return this.base.exists(path);
  }

  read(path: string): Promise<Uint8Array> {
    return this.base.read(this.resolve(path));
  }

  rawBytes(path: string): Uint8Array | null {
    return this.base.rawBytes(this.resolve(path));
  }

  list(): string[] {
    return this.base.list();
  }

  openArchive(path: string): DataSource | null {
    return this.base.openArchive?.(path) ?? null;
  }
}
