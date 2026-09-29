import type { DataSource } from "./types";
import { BlpImage } from "mdx-m3-viewer/dist/cjs/parsers/blp/image";
import { encodeBlp } from "../assets/blpEncode";

// Icons the install does not ship, COMPUTED from icons it does (docs/icons.md).
//
// The game's later patches name art a 1.30.4 install never had — above all the PASSIVE twins of
// ordinary command icons: 1.32 hangs a "you have this upgrade" badge on a unit
// (`[Aobs] Art=…\PassiveButtons\PASBTNBerserk.blp`), and 1.30.4 has `BTNBerserk.blp` but no
// `PASBTNBerserk.blp`. A PASBTN is not new art. It is the BTN's own picture with the button's
// bevel taken off and the edge darkened into the frame — measured on the pairs 1.30.4 DOES ship
// (Evasion, Critical Strike) and on 2.0.4's own `PASBTNBerserk`, ring by ring from the edge:
//
//   ring  0–3   the BTN's bevel                  → black (0.00–0.04 of the BTN)
//   ring  4–11  an inner shadow fading out        → × 0.35 … 0.97
//   ring 12+    untouched                        → × 1.00
//
// `PASSIVE_RING` below is that curve (the mean of the two 1.30.4 pairs). Applied to BTNEvasion it
// lands 2.3 / 255 from the real PASBTNEvasion, against 31.5 for the bordered BTN as it stands.
// And the DISABLED passive needs nothing computed at all: `DISPASBTN<X>` is `DISBTN<X>` to within
// a level or two (1.30.4's Evasion pair, 2.0.4's Berserk pair), so it is served as that file.
//
// Everything is decided ONCE, when the install is mounted (`prepare`, called by vfs/loader.ts):
// every PASBTN/DISPASBTN the tables name that the install lacks is derived there, off the bytes
// the layers below serve — the patched tables included, so the chain's new rows are covered. A
// path nothing named at mount (a custom map's data) is derived the first time it is asked for.
//
// What this layer does NOT do is the last resort. An icon that can be neither found nor derived
// is drawn as the engine's own placeholder, `BTNTemp.blp` — but that is a fact about DRAWING
// (render/mapViewer.ts `blpIcon`), not about the install, so `exists()` here stays truthful for
// every other reader.

/** How much of the BTN survives at each ring in from the edge; past the end, all of it. */
const PASSIVE_RING = [0, 0, 0, 0, 0.35, 0.36, 0.42, 0.57, 0.72, 0.83, 0.91, 0.97];

const COMMAND = "ReplaceableTextures\\CommandButtons\\";
const DISABLED = "ReplaceableTextures\\CommandButtonsDisabled\\";

/** The source a missing icon can be derived from, or null. Keyed on the file NAME, since the
 *  data sometimes files a PASBTN under CommandButtons (and the rule is the name's). */
function sourceOf(path: string): { kind: "passive" | "same"; from: string } | null {
  const name = path.replace(/\//g, "\\").split("\\").pop() ?? "";
  let m = /^DISPASBTN(.+)\.blp$/i.exec(name);
  if (m) return { kind: "same", from: `${DISABLED}DISBTN${m[1]}.blp` };
  m = /^PASBTN(.+)\.blp$/i.exec(name);
  if (m) return { kind: "passive", from: `${COMMAND}BTN${m[1]}.blp` };
  return null;
}

/** A BTN's picture as its passive twin: the bevel off, the edge shaded (see PASSIVE_RING). */
export function passiveFromCommand(bytes: Uint8Array): Uint8Array | null {
  let image: ImageData;
  try {
    const blp = new BlpImage();
    blp.load(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice());
    image = blp.getMipmap(0);
  } catch {
    return null;
  }
  const { width: w, height: h } = image;
  const out = new Uint8Array(image.data);
  // The curve is measured on 64×64 icons; a larger or smaller one scales its rings with it.
  const scale = Math.min(w, h) / 64;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ring = Math.floor(Math.min(x, y, w - 1 - x, h - 1 - y) / scale);
      if (ring >= PASSIVE_RING.length) continue;
      const k = PASSIVE_RING[ring];
      const i = (y * w + x) * 4;
      out[i] = Math.round(out[i] * k);
      out[i + 1] = Math.round(out[i + 1] * k);
      out[i + 2] = Math.round(out[i + 2] * k);
    }
  }
  return encodeBlp({ width: w, height: h, data: out });
}

export class DerivedArtDataSource implements DataSource {
  /** Lower-cased path → the derived bytes, or null for "asked, and nothing to derive from". */
  private derived = new Map<string, Uint8Array | null>();

  constructor(private base: DataSource) {}

  get label(): string {
    return this.base.label;
  }

  /**
   * Derive, now, every missing PASBTN/DISPASBTN the object tables name — the whole of the work,
   * done once after the mount rather than inside the first frame that shows the card. The
   * tables are read through the layers below, so a patched row's art is found as well; it asks
   * the `*Func.txt` files by name, because those are where every `Art=` of 1.30.4's layout is.
   */
  prepare(): number {
    const named = new Set<string>();
    const tables = ["Units\\ItemFunc.txt"];
    for (const race of ["Human", "Orc", "Undead", "NightElf", "Neutral", "Campaign", "Common", "Item"]) {
      for (const kind of ["AbilityFunc", "UnitFunc", "UpgradeFunc"]) tables.push(`Units\\${race}${kind}.txt`);
    }
    {
      for (const table of tables) {
        const bytes = this.base.rawBytes(table);
        if (!bytes) continue;
        const text = new TextDecoder("windows-1252").decode(bytes);
        for (const m of text.matchAll(/[A-Za-z0-9_\\/]*PASBTN[A-Za-z0-9_]+\.blp/gi)) named.add(m[0]);
      }
    }
    // Every passive the tables name has a greyed twin the card asks for (disabledIconPath).
    for (const p of [...named]) named.add(p.replace(/PassiveButtons[\\/]PASBTN/i, "CommandButtonsDisabled\\DISPASBTN"));
    let made = 0;
    for (const path of named) if (sourceOf(path) && !this.base.exists(path) && this.derive(path)) made++;
    return made;
  }

  private derive(path: string): Uint8Array | null {
    const key = path.replace(/\//g, "\\").toLowerCase();
    if (this.derived.has(key)) return this.derived.get(key)!;
    let out: Uint8Array | null = null;
    const src = sourceOf(path);
    const bytes = src ? this.base.rawBytes(src.from) : null;
    if (src && bytes) out = src.kind === "same" ? bytes : passiveFromCommand(bytes);
    this.derived.set(key, out);
    return out;
  }

  /** The bytes this layer answers `path` with, when the base has none. */
  private own(path: string): Uint8Array | null {
    if (!sourceOf(path) || this.base.exists(path)) return null;
    return this.derive(path);
  }

  exists(path: string): boolean {
    return this.base.exists(path) || this.own(path) !== null;
  }

  async read(path: string): Promise<Uint8Array> {
    return this.own(path) ?? this.base.read(path);
  }

  rawBytes(path: string): Uint8Array | null {
    return this.own(path) ?? this.base.rawBytes(path);
  }

  list(): string[] {
    return this.base.list();
  }

  openArchive(path: string): DataSource | null {
    return this.base.openArchive?.(path) ?? null;
  }
}
