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
// One piece of art here is not an icon: `bnet-slider-bar4.blp`, the LAN create screen's Game
// Speed track with FOUR notches, for our four speeds (src/data/gameSpeed.ts). The game's own
// `bnet-slider-bar3.blp` has its three notches drawn into it — under each of the 2003 slider's
// three steps — so a fourth rung left two knobs parked between notches. It is the same track
// with the middle notch painted out and stamped again at the thirds (`fourStepTrack`).
//
// And three kinds are for an OLDER BUILD (docs/versions.md, issue #319) — art a later patch
// added, that the engine asks for whatever the install is:
//
//   • the 24-PLAYER TEAM COLOURS. Before 1.29 there were twelve, `TeamColor12` was the black
//     the neutral players wore, and nothing past 15 existed. A flat swatch is its colour and
//     nothing else, so the sixteen 1.29 added are made from the colours themselves
//     (`TEAM_COLORS`, read off 1.30.4's swatches), and each `TeamGlowNN` is the install's own
//     `TeamGlow00` — a red glow — with its red swapped for that colour. They REPLACE such an
//     install's 12–15, which are not the colours a thirteenth player wears today.
//   • the WIDE CONSOLE's side panels, `<Race>UITile05`/`06` (1.29's widescreen HUD). They are
//     more of the wall the console is built from, so they are made from the stone the older
//     console's own first tile has (`wallFromConsole`).
//
// What this layer does NOT do is the last resort. An icon that can be neither found nor derived
// is drawn as a flat fuchsia square (`MISSING_ICON_URL`) — but that is a fact about DRAWING
// (render/mapViewer.ts `blpIcon`), not about the install, so `exists()` here stays truthful for
// every other reader.

/** How much of the BTN survives at each ring in from the edge; past the end, all of it. */
const PASSIVE_RING = [0, 0, 0, 0, 0.35, 0.36, 0.42, 0.57, 0.72, 0.83, 0.91, 0.97];

const COMMAND = "ReplaceableTextures\\CommandButtons\\";
const DISABLED = "ReplaceableTextures\\CommandButtonsDisabled\\";
const BATTLENET = "UI\\Widgets\\BattleNet\\";

/** The OUR-named four-notch track (see the file header) — the path a screen asks for. */
export const FOUR_STEP_TRACK = `${BATTLENET}bnet-slider-bar4.blp`;

/** Where things sit across `bnet-slider-bar3.blp`, as fractions of its width (measured on the
 *  1.30.4 file, 512 texels): the knob's two ends as the create screen lays the slider over the
 *  track (18 and 488 — the end notches are a few texels inside them, which is the game's own
 *  look), and the middle notch, which sits exactly halfway between those ends (254). */
const TRACK_KNOB_LO = 18.2 / 512;
const TRACK_KNOB_HI = 488.3 / 512;
const TRACK_MID_NOTCH = 254 / 512;
/** Half the notch's footprint, and how far the plain track is read from to paint it out. */
const TRACK_NOTCH_HALF = 16 / 512;
const TRACK_PLAIN_OFFSET = 34 / 512;
/** Each pasted strip fades in over this many texels at its two edges, so no seam shows. */
const TRACK_FADE = 5;

/** The 1.29 player colours 13–24 and the four neutral slots, as `TeamColor12…27.blp` hold them
 *  in 1.30.4 (every texel of a swatch is the colour; measured, not chosen). */
export const TEAM_COLORS: Record<number, [number, number, number]> = {
  12: [155, 0, 0], 13: [0, 0, 195], 14: [0, 234, 255], 15: [190, 0, 254], 16: [235, 205, 135], 17: [248, 164, 139],
  18: [191, 255, 128], 19: [220, 185, 235], 20: [40, 40, 40], 21: [235, 240, 255], 22: [0, 120, 30], 23: [164, 111, 51],
  24: [0, 0, 0], 25: [0, 0, 0], 26: [0, 0, 0], 27: [0, 0, 0],
};
const TEAM = "ReplaceableTextures\\Team";
/** The swatch only a 24-colour install has — what tells the two team-colour tables apart
 *  (src/render/teamColor.ts asks the same file the same question). */
const TEAM_24 = `${TEAM}Color\\TeamColor24.blp`;

type Source = { kind: "passive" | "same" | "track4" | "teamcolor" | "teamglow" | "wall"; from: string; n?: number };

/** The source a missing icon can be derived from, or null. Keyed on the file NAME, since the
 *  data sometimes files a PASBTN under CommandButtons (and the rule is the name's). */
function sourceOf(path: string): Source | null {
  const whole = path.replace(/\//g, "\\");
  const name = whole.split("\\").pop() ?? "";
  const team = /^Team(Color|Glow)(\d\d)\.blp$/i.exec(name);
  if (team && TEAM_COLORS[Number(team[2])]) {
    return team[1].toLowerCase() === "color"
      ? { kind: "teamcolor", from: `${TEAM}Color\\TeamColor00.blp`, n: Number(team[2]) }
      : { kind: "teamglow", from: `${TEAM}Glow\\TeamGlow00.blp`, n: Number(team[2]) };
  }
  // The skin table names these with no extension (`UI\Console\Human\HumanUITile05`).
  const wall = /^(.*UITile0)([56])(\.blp)?$/i.exec(whole);
  if (wall) return { kind: "wall", from: `${wall[1]}1.blp`, n: Number(wall[2]) };
  if (/^bnet-slider-bar4\.blp$/i.test(name)) return { kind: "track4", from: `${BATTLENET}bnet-slider-bar3.blp` };
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

function decode(bytes: Uint8Array): ImageData | null {
  try {
    const blp = new BlpImage();
    blp.load(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice());
    return blp.getMipmap(0);
  } catch {
    return null;
  }
}

/** A flat team-colour swatch, the size the install's own are. */
export function teamColorSwatch(like: Uint8Array, [r, g, b]: [number, number, number]): Uint8Array | null {
  const image = decode(like);
  if (!image) return null;
  const out = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < out.length; i += 4) out.set([r, g, b, 255], i);
  return encodeBlp({ width: image.width, height: image.height, data: out });
}

/** The install's red glow (`TeamGlow00`) in another colour: its brightness, that colour's hue. */
export function teamGlowFrom(red: Uint8Array, [r, g, b]: [number, number, number]): Uint8Array | null {
  const image = decode(red);
  if (!image) return null;
  const out = new Uint8Array(image.data);
  for (let i = 0; i < out.length; i += 4) {
    const k = Math.max(out[i], out[i + 1], out[i + 2]) / 255; // player 0 is pure red: its own peak
    out[i] = Math.round(r * k);
    out[i + 1] = Math.round(g * k);
    out[i + 2] = Math.round(b * k);
  }
  return encodeBlp({ width: image.width, height: image.height, data: out });
}

/** The share of the tile the console's bottom band starts at, and its top strip ends at — the
 *  `TexCoord`s `ConsoleUI.fdf` draws the two bands with (0.3125 … 1 and 0 … 0.125). */
const BAND_TOP = 0.3125;
const STRIP_BOTTOM = 0.125;

/**
 * A wide console's side panel, made from the console's own first tile (`<Race>UITile01`).
 *
 * A pre-1.29 console has no spare wall: its minimap and command card run to the ends of the 4:3
 * box. What it does have is the stone the sockets are cut out of, and the widest run of columns
 * that is SOLID stone from the band's top to the bottom of the tile (the pier between the
 * minimap and the portrait, on all four races) is laid across the new tile, every other copy
 * mirrored so each seam meets itself. The top strip is the tile's own first columns, laid the
 * same way, so the rail the resource bar sits in carries on. Null when the tile has no such
 * run — then there is no panel, which is what such an install's own game showed.
 */
export function wallFromConsole(tile: Uint8Array): Uint8Array | null {
  const image = decode(tile);
  if (!image) return null;
  const { width: w, height: h, data } = image;
  const from = Math.floor(h * 0.55);
  const rows = h - from;
  // A column of STONE: opaque all the way down, and not the black of a socket or a button.
  const stone = (x: number): boolean => {
    let opaque = 0, dark = 0;
    for (let y = from; y < h; y++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] > 200) opaque++;
      if (data[i] + data[i + 1] + data[i + 2] < 36) dark++;
    }
    return opaque >= rows * 0.97 && dark < rows * 0.2;
  };
  let best = [0, 0];
  for (let x = 0, start = -1; x <= w; x++) {
    const ok = x < w && stone(x);
    if (ok && start < 0) start = x;
    if (!ok && start >= 0) {
      if (x - start > best[1] - best[0]) best = [start, x];
      start = -1;
    }
  }
  // Inset: the run's first and last columns are where the stone meets a socket's bevel.
  const a = best[0] + 2, sw = best[1] - best[0] - 4;
  if (sw < 12) return null;
  const mirror = (x: number, period: number): number => {
    const k = x % (2 * period);
    return k < period ? k : 2 * period - 1 - k;
  };
  const out = new Uint8Array(w * h * 4);
  const bandTop = Math.floor(h * BAND_TOP), stripBottom = Math.ceil(h * STRIP_BOTTOM);
  const rail = Math.min(64, w);
  for (let y = 0; y < h; y++) {
    if (y >= stripBottom && y < bandTop) continue;
    for (let x = 0; x < w; x++) {
      const sx = y < stripBottom ? mirror(x, rail) : a + mirror(x, sw);
      const si = (y * w + sx) * 4, di = (y * w + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return encodeBlp({ width: w, height: h, data: out });
}

/** The three-notch track as a four-notch one: the middle notch painted over with the plain track
 *  beside it, then stamped at one and two thirds of the knob's travel (see the file header). */
export function fourStepTrack(bytes: Uint8Array): Uint8Array | null {
  let image: ImageData;
  try {
    const blp = new BlpImage();
    blp.load(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice());
    image = blp.getMipmap(0);
  } catch {
    return null;
  }
  const { width: w, height: h } = image;
  const src = image.data;
  const out = new Uint8Array(src);
  const half = Math.round(TRACK_NOTCH_HALF * w);
  const span = 2 * half + 1;
  // Copy a `span`-wide strip of the ORIGINAL from column `from` onto column `to` (both its left
  // edges), cross-fading the first and last TRACK_FADE columns into what is already there.
  const paste = (from: number, to: number): void => {
    for (let i = 0; i < span; i++) {
      const sx = from + i;
      const dx = to + i;
      if (sx < 0 || sx >= w || dx < 0 || dx >= w) continue;
      const edge = Math.min(i, span - 1 - i);
      const k = edge >= TRACK_FADE ? 1 : (edge + 1) / (TRACK_FADE + 1);
      for (let y = 0; y < h; y++) {
        const si = (y * w + sx) * 4;
        const di = (y * w + dx) * 4;
        for (let c = 0; c < 4; c++) out[di + c] = Math.round(out[di + c] * (1 - k) + src[si + c] * k);
      }
    }
  };
  const mid = Math.round(TRACK_MID_NOTCH * w) - half;
  paste(mid + Math.round(TRACK_PLAIN_OFFSET * w), mid); // the middle notch, painted out
  const lo = TRACK_KNOB_LO * w;
  const hi = TRACK_KNOB_HI * w;
  for (const t of [1 / 3, 2 / 3]) paste(mid, Math.round(lo + (hi - lo) * t) - half);
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
    if (src && bytes) {
      out =
        src.kind === "same" ? bytes
        : src.kind === "track4" ? fourStepTrack(bytes)
        : src.kind === "teamcolor" ? teamColorSwatch(bytes, TEAM_COLORS[src.n!])
        : src.kind === "teamglow" ? teamGlowFrom(bytes, TEAM_COLORS[src.n!])
        : src.kind === "wall" ? wallFromConsole(bytes)
        : passiveFromCommand(bytes);
    }
    this.derived.set(key, out);
    return out;
  }

  /** The bytes this layer answers `path` with, when the base has none. */
  private own(path: string): Uint8Array | null {
    const src = sourceOf(path);
    if (!src) return null;
    // A twelve-colour install's swatches 12–15 are REPLACED, not kept: its 12 is the neutral
    // players' black, where a thirteenth player is maroon now.
    const replaces = (src.kind === "teamcolor" || src.kind === "teamglow") && !this.base.exists(TEAM_24);
    if (!replaces && (this.base.exists(path) || (src.kind === "wall" && !/\.blp$/i.test(path) && this.base.exists(`${path}.blp`)))) return null;
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
