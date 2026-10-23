import { type DataSource, normalizeMpqPath } from "./types";

// A MAP's own copy of a game table, laid over the install's (docs/map-compatibility.md
// "A map that ships its own tables").
//
// WC3 mounts the map archive ABOVE the game's own archives, so any file the map carries at a
// path the game reads replaces the game's copy wholesale — the object tables included. That is
// how an OPTIMISED map defines its objects: Vexorian's Optimizer and W3x2Lni's "slk" mode fold
// the map's whole `war3map.w3u`/`.w3a`/`.w3t` into its own `Units\UnitData.slk`,
// `Units\AbilityData.slk`, `Units\ItemData.slk` and the `*Func.txt`/`*Strings.txt` profiles,
// and leave the w3 files holding little or nothing. DotA v6.77b AI is that shape: no w3u at all,
// a w3a whose 769 ORIGINAL rows name ids only its own `AbilityData.slk` defines, and 35
// `Units\*` tables of its own — a 1.4 MB AbilityData.slk among them. Read past the map, every
// tower, Ancient, creep and hero the script creates is an id nothing knows, and CreateUnit
// makes nothing. Uther Party and BleachVsOnepiece in the install's own `Maps\Download` ship
// tables the same way, and a ZERO-byte file is an answer too: `CampaignUpgradeFunc.txt` empty
// in the map means "no campaign upgrades", not "ask the install".
//
// Scoped to the readers handed THIS source (the object-table loaders and the viewer's own
// tables); everything else still reads the install. The map archive is already first for every
// model, texture and sound through the scene's own solvers.

export class MapTableSource implements DataSource {
  private map: DataSource | null = null;
  /** Every path a reader has asked of this source, in its normalised form. It is the list of
   *  table files the engine reads, learned off the readers themselves rather than retyped — so
   *  `shadows` stays right when a loader starts reading one more file. */
  private asked = new Set<string>();

  constructor(private base: DataSource) {}

  get label(): string {
    return this.map ? `${this.map.label} over ${this.base.label}` : this.base.label;
  }

  /** Lay `map` over the install (null takes the last one off). */
  setMap(map: DataSource | null): void {
    this.map = map;
  }

  /** The table files `map` carries its own copy of, out of every one a reader has asked for.
   *  Empty for nearly every map, which is what lets a map that has none skip re-reading the
   *  tables altogether. */
  shadows(map: DataSource): string[] {
    return [...this.asked].filter((p) => map.exists(p));
  }

  private from(path: string): DataSource {
    const p = normalizeMpqPath(path).toLowerCase();
    this.asked.add(p);
    return this.map?.exists(p) ? this.map : this.base;
  }

  exists(path: string): boolean {
    return this.from(path).exists(path);
  }

  read(path: string): Promise<Uint8Array> {
    return this.from(path).read(path);
  }

  rawBytes(path: string): Uint8Array | null {
    return this.from(path).rawBytes(path);
  }

  list(): string[] {
    return this.base.list();
  }

  openArchive(path: string): DataSource | null {
    return this.base.openArchive?.(path) ?? null;
  }
}
