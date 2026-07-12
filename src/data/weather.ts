import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";

// Weather registry — the map's ATMOSPHERE (7.23; issue #33, see docs/triggers.md).
//
// A map's rain / snow / fog / light-rays are not models and not a shader: they are a
// **data-driven particle emitter**, defined entirely in `TerrainArt\Weather.slk` (verified
// against the real War3.mpq). The World Editor's "weather effect" region compiles into the
// map's own script —
//
//     set we = AddWeatherEffect( gg_rct_Region_000, 'SNls' )   // (6)UpperKingdom, verbatim
//     call EnableWeatherEffect( we, true )
//
// — inside `CreateRegions()`, which is why **40 of the 165 bundled maps** (mostly plain
// MELEE maps) ask for weather and, until this milestone, silently got none.
//
// The 21 rows cover five shapes, all from the same emitter:
//
//   rain   RAhr/RAlr/RLhr/RLlr   rainTail        tail   — a velocity-stretched streak
//   snow   SNbs/SNhs/SNls        snow            head   — a billboard flake
//   fog    FDbh/FDbl/FDgh/…      CloudSingleFlat head   — big, slow, near-transparent clouds
//   rays   LRaa/LRma             RaysOfLight     tail   — long shafts of light
//   wind   WNcw/WOcw/WOlw        clouds8x8       head   — an 8×8 ATLAS of cloud sprites
//
// ### `particles` is a DERIVED column — and that's the finding that settles the density
//
// The table gives both an emission rate (`emrate`) and a particle count (`particles`), and
// nothing says how they relate. They are not independent:
//
//     particles == emrate × lifespan × 20      — EXACTLY, for all 21 rows, without exception
//
// (heavy rain 100 × 0.9 × 20 = 1800; light snow 8 × 5 × 20 = 800; moonlight 0.9 × 3 × 20 =
// 54; …). So `particles` is simply the **steady-state population** of an emitter running at
// `emrate` per second over a fixed 20-cell emitter grid — the two columns encode one number.
// We take `particles` as the live-particle budget and derive the emission rate from it
// (`particles / lifespan`), which reproduces exactly the density the table intends without
// having to guess what an "emitter cell" is.

/** One row of TerrainArt\Weather.slk. Field names are the SLK's own column keys. */
export interface WeatherDef {
  id: string; // effectID rawcode ('SNls', 'RAhr', …)
  texture: string; // resolved BLP path (`texDir\texFile.blp`)
  /** alphaMode 0 = alpha blend (snow — solid flakes); 1 = additive (rain, fog, rays, cloud). */
  additive: boolean;
  useFog: boolean; // is the effect dimmed by the atmospheric distance haze?
  height: number; // world units above the ground that particles are born at
  angx: number; // emission tilt, degrees — what slants the rain and drives the wind
  angy: number;
  lifespan: number; // seconds a particle lives
  /** Live-particle budget (the SLK's `particles`; see the header — it is emrate×lifespan×20). */
  particles: number;
  veloc: number; // world units/sec along the emission axis (NEGATIVE = falling)
  accel: number; // 0 in every shipped row, but honoured
  variance: number; // `var` — fractional jitter on the speed (0.1 = ±10 %)
  lati: number; // emission cone half-angle, degrees (the scatter around the axis)
  head: boolean; // draw as a camera-facing billboard
  tail: boolean; // draw as a streak stretched along the velocity
  /** `taillen` — the streak's length as a FRACTION OF SPEED: rain 1200×0.1 = 120 units of
   *  falling streak; moonlight 300×10 = 3000 units of long shaft. */
  taillen: number;
  texRows: number; // `texr` / `texc` — the texture is a texRows×texCols sprite atlas
  texCols: number; //   (clouds8x8 = 8×8 = 64 frames; everything else is 1×1)
  /** The atlas frame index over the particle's life (`hUVStart`/`Mid`/`End`). 0,0,0 for a
   *  single-frame texture; 0→32→63 for the 8×8 cloud atlas, i.e. it animates through it. */
  uvStart: number;
  uvMid: number;
  uvEnd: number;
  midTime: number; // when the "mid" key of every ramp below lands (fraction of life)
  colorStart: [number, number, number]; // 0–255
  colorMid: [number, number, number];
  colorEnd: [number, number, number];
  alphaStart: number; // 0–255
  alphaMid: number;
  alphaEnd: number;
  scaleStart: number; // the particle's size in world units, over its life
  scaleMid: number;
  scaleEnd: number;
  /** A looping ambient bed (`AmbientSound`) — "AmbientSoundRain" / "AmbientSoundTestWind",
   *  a label in the UI\SoundInfo tables (7.20's SoundBoard resolves it). "-" = none. */
  ambientSound: string | null;
}

interface Row {
  string(key: string): string | undefined;
}

export class WeatherRegistry {
  constructor(private defs: Map<string, WeatherDef>) {}
  /** Weather ids are case-sensitive rawcodes ('SNls' — note the mixed case), so unlike the
   *  ubersplat registry we must NOT upper-case the key: 'SNls' and 'snls' are not the same
   *  rawcode, and the SLK's own ids carry the case the scripts pass. */
  get(id: string): WeatherDef | undefined {
    return this.defs.get(id);
  }
  get size(): number {
    return this.defs.size;
  }
  ids(): string[] {
    return [...this.defs.keys()];
  }
}

const SLK = "TerrainArt\\Weather.slk";

export function loadWeatherRegistry(vfs: DataSource): WeatherRegistry {
  const defs = new Map<string, WeatherDef>();
  const bytes = vfs.rawBytes(SLK);
  if (!bytes) return new WeatherRegistry(defs);
  const table = new MappedData(new TextDecoder("windows-1252").decode(bytes));

  for (const key of Object.keys(table.map)) {
    const r = table.getRow(key) as Row | undefined;
    if (!r) continue;
    const id = str(r, "effectID");
    const dir = str(r, "texDir");
    const file = str(r, "texFile");
    if (!id || !dir || !file) continue; // header / empty rows
    defs.set(id, {
      id,
      texture: `${dir.replace(/\//g, "\\")}\\${file}.blp`,
      additive: num(r, "alphaMode", 0) === 1,
      useFog: num(r, "useFog", 0) === 1,
      height: num(r, "height", 0),
      angx: num(r, "angx", 0),
      angy: num(r, "angy", 0),
      lifespan: Math.max(0.01, num(r, "lifespan", 1)),
      particles: Math.max(0, num(r, "particles", 0)),
      veloc: num(r, "veloc", 0),
      accel: num(r, "accel", 0),
      variance: num(r, "var", 0),
      lati: num(r, "lati", 0),
      head: num(r, "head", 0) === 1,
      tail: num(r, "tail", 0) === 1,
      taillen: num(r, "taillen", 0),
      texRows: Math.max(1, num(r, "texr", 1)),
      texCols: Math.max(1, num(r, "texc", 1)),
      uvStart: num(r, "hUVStart", 0),
      uvMid: num(r, "hUVMid", 0),
      uvEnd: num(r, "hUVEnd", 0),
      midTime: clamp01(num(r, "midTime", 0.5)),
      colorStart: [num(r, "redStart", 255), num(r, "greenStart", 255), num(r, "blueStart", 255)],
      colorMid: [num(r, "redMid", 255), num(r, "greenMid", 255), num(r, "blueMid", 255)],
      colorEnd: [num(r, "redEnd", 255), num(r, "greenEnd", 255), num(r, "blueEnd", 255)],
      alphaStart: num(r, "alphaStart", 255),
      alphaMid: num(r, "alphaMid", 255),
      alphaEnd: num(r, "alphaEnd", 255),
      scaleStart: num(r, "scaleStart", 1),
      scaleMid: num(r, "scaleMid", 1),
      scaleEnd: num(r, "scaleEnd", 1),
      ambientSound: sound(str(r, "AmbientSound")),
    });
  }
  return new WeatherRegistry(defs);
}

/** The SLK writes "-" for "no ambient sound" — the same dash-for-empty convention
 *  UnitWeapons.slk uses (see the combat-timing notes). Don't hand it on as a label. */
function sound(v: string | undefined): string | null {
  return !v || v === "-" || v === "_" ? null : v;
}

function str(r: Row, key: string): string | undefined {
  const v = r.string(key);
  return v === undefined || v === "" || v === "-" ? undefined : v;
}

function num(r: Row, key: string, fallback: number): number {
  const v = r.string(key);
  if (v === undefined || v === "" || v === "-") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
