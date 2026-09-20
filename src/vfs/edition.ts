import type { DataSource } from "./types";
import { dataSetFolder } from "../data/edition";

// The DATA SET, laid over the live paths (docs/editions.md).
//
// A 1.30.4 store keeps ONE set of object tables at their ordinary paths (`Units\UnitData.slk`)
// and THREE more complete copies one folder down, at the SAME path under `Melee_V0\`,
// `Custom_V1\` and `Custom_V0\` — every `Units\*` table, the melee `Scripts\*.ai` with their
// `.pld`s, and `UI\FrameDef\InfoPanelStrings.fdf` (whose armour tips describe the set's own
// damage table). That is the whole of the rule, so it is written as one: a path that has a twin
// under the folder `dataSetFolder()` names reads the twin.
//
// The four corners are (edition × map kind), and the LIVE paths are the fourth — The Frozen
// Throne's MELEE tables — which is why the store ships no `Melee_V1\`. Both axes matter and
// each was learned the hard way:
//   • the EDITION, because 232 of the 468 units the two games share change armour class
//     (docs/editions.md);
//   • the MAP KIND, because melee carries the balance patches 1.29+ made and custom is frozen
//     where the game shipped. A campaign chapter is a custom map, so on Reign of Chaos its
//     Grunt has `Custom_V0`'s **680** hit points and not the 700 every other set gives it.
//
// Both are read at EVERY lookup rather than baked in, because the menu flips the edition on a
// mounted install and every match may bring the other kind of map. Anything that parsed a table
// before the flip still holds the old set's copy; the things that cache across matches are told
// through `onEditionChange`, which both switches fire (src/data/edition.ts).
// An MPQ-era install has none of the four folders, so it reads the live tables throughout.

export class EditionDataSource implements DataSource {
  constructor(private base: DataSource) {}

  get label(): string {
    return this.base.label;
  }

  /** The path the current edition + map kind reads `path` from. */
  private resolve(path: string): string {
    const set = dataSetFolder();
    if (set === null) return path;
    const twin = `${set}\\${path.replace(/\//g, "\\").replace(/^\\+/, "")}`;
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
