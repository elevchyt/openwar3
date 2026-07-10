import MdlxModel from "mdx-m3-viewer/dist/cjs/parsers/mdlx/model";
import type { DataSource } from "../vfs/types";
import { MISC_DATA } from "../data/gameplayConstants";

// WC3's day/night cycle lighting, read from the game's own data (issue #47).
//
// The whole cycle lives in a pair of MDX models per tileset under Environment\DNC\.
// Each holds exactly one Directional light named "FDirectSun" whose Color (KLAC) and
// AmbColor (KLBC) tracks are keyframed across a 60-second "Stand" sequence — and that
// sequence's 60 000 ms maps onto the 24 game hours of MiscData.txt's DayHours. So the
// noon/dusk/midnight tints the issue asks for aren't constants to be typed out: they
// are sampled out of the model at `frame = hour / DayHours * seqDuration`.
//
// Verified against the real 1.27a MPQs: every outdoor DNC model keys its transitions
// at exactly 15 000 ms and 45 000 ms — i.e. game hours 6 and 18, MiscData's Dawn and
// Dusk. The light's rotation track (KGRT) has a single frame, so the sun never moves;
// only its colour does.
//
// Which model a map uses is UI\WorldEditData.txt's job, keyed by the w3e tileset
// letter, with its own note: "If a tileset does not have an entry for a terrain/unit
// light, it will use the hard-coded default (Lordaeron)". [TerrainLights] shades the
// ground and cliffs, [UnitLights] shades units, doodads and destructibles — the same
// colours, but a higher ambient intensity, so models sit flatter than the ground.

const WORLD_EDIT_DATA = "UI\\WorldEditData.txt";
/** The engine's hard-coded fallback when a tileset names no light (WorldEditData.txt). */
const DEFAULT_TERRAIN_LIGHT = "Environment\\DNC\\DNCLordaeron\\DNCLordaeronTerrain\\DNCLordaeronTerrain.mdl";
const DEFAULT_UNIT_LIGHT = "Environment\\DNC\\DNCLordaeron\\DNCLordaeronUnit\\DNCLordaeronUnit.mdl";

/** One evaluation of a DNC light: the terms of WC3's fixed-function lighting. */
export interface DayNightLight {
  /** ambientColor · ambientIntensity, per channel. */
  ambient: Float32Array;
  /** color · intensity, per channel — modulated by max(dot(N, direction), 0). */
  diffuse: Float32Array;
  /** Unit vector pointing TOWARD the sun, world space (Z up). Constant per tileset. */
  direction: Float32Array;
}

/** The two lights a map is shaded with, both driven by the same clock. */
export interface DayNightLights {
  terrain: DayNightLight;
  unit: DayNightLight;
}

// --- MDX animation tracks --------------------------------------------------

const enum Interp {
  None = 0,
  Linear = 1,
  Hermite = 2,
  Bezier = 3,
}

interface Track {
  interpolation: Interp;
  frames: number[];
  values: Float32Array[];
  inTans: Float32Array[];
  outTans: Float32Array[];
}

/** Sample an MDX animation track at `t` (ms), writing `size` channels into `out`.
 *  Mirrors mdx-m3-viewer's own sampling: hold before the first key and after the
 *  last, otherwise interpolate between the bracketing pair. */
function sampleTrack(track: Track, t: number, out: Float32Array, size: number): void {
  const { frames, values } = track;
  if (!frames.length) return;
  if (t <= frames[0]) {
    for (let i = 0; i < size; i++) out[i] = values[0][i];
    return;
  }
  const last = frames.length - 1;
  if (t >= frames[last]) {
    for (let i = 0; i < size; i++) out[i] = values[last][i];
    return;
  }
  let b = 1;
  while (b < last && frames[b] < t) b++;
  const a = b - 1;
  const span = frames[b] - frames[a] || 1;
  const f = (t - frames[a]) / span;
  for (let i = 0; i < size; i++) {
    const va = values[a][i];
    const vb = values[b][i];
    switch (track.interpolation) {
      case Interp.None:
        out[i] = va; // step: hold the previous key (the clock dots use this)
        break;
      case Interp.Linear:
        out[i] = va + (vb - va) * f;
        break;
      case Interp.Hermite: {
        // Standard Hermite basis over the outgoing/incoming tangents of the pair.
        const f2 = f * f;
        const f3 = f2 * f;
        const h1 = 2 * f3 - 3 * f2 + 1;
        const h2 = -2 * f3 + 3 * f2;
        const h3 = f3 - 2 * f2 + f;
        const h4 = f3 - f2;
        out[i] = h1 * va + h2 * vb + h3 * track.outTans[a][i] + h4 * track.inTans[b][i];
        break;
      }
      case Interp.Bezier: {
        // Cubic Bezier with the keys as endpoints and the tangents as controls.
        const g = 1 - f;
        out[i] =
          g * g * g * va +
          3 * g * g * f * track.outTans[a][i] +
          3 * g * f * f * track.inTans[b][i] +
          f * f * f * vb;
        break;
      }
    }
  }
}

/** Pull one named track (KLAC, KLBC, KLAI, KLBI) off a parsed mdlx light. */
function track(light: { animations: unknown[] }, name: string): Track | null {
  for (const raw of light.animations) {
    const a = raw as {
      name: string;
      interpolationType: number;
      frames: number[];
      values: Float32Array[];
      inTans: Float32Array[];
      outTans: Float32Array[];
    };
    if (a.name !== name) continue;
    if (!a.frames.length) return null;
    return {
      interpolation: a.interpolationType as Interp,
      frames: a.frames,
      values: a.values,
      inTans: a.inTans,
      outTans: a.outTans,
    };
  }
  return null;
}

/** Rotate `v` by the quaternion `q` (x, y, z, w). */
function rotate(q: ArrayLike<number>, v: [number, number, number]): Float32Array {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  const [vx, vy, vz] = v;
  const cx = y * vz - z * vy;
  const cy = z * vx - x * vz;
  const cz = x * vy - y * vx;
  const dx = y * cz - z * cy;
  const dy = z * cx - x * cz;
  const dz = x * cy - y * cx;
  return new Float32Array([vx + 2 * (w * cx + dx), vy + 2 * (w * cy + dy), vz + 2 * (w * cz + dz)]);
}

// --- the sampler ------------------------------------------------------------

/** One tileset light: everything needed to evaluate it at any game hour. */
class LightSampler {
  private colorT: Track | null;
  private ambColorT: Track | null;
  private intensityT: Track | null;
  private ambIntensityT: Track | null;
  private scratch = new Float32Array(3);
  readonly out: DayNightLight;

  constructor(
    private readonly light: {
      animations: unknown[];
      color: Float32Array;
      intensity: number;
      ambientColor: Float32Array;
      ambientIntensity: number;
    },
    /** The "Stand" sequence's [start, end] in ms — the 24-hour span. */
    private readonly interval: [number, number],
    /** The light node's pivot rotation (KGRT frame 0), or identity. */
    rotation: ArrayLike<number>,
  ) {
    this.colorT = track(light, "KLAC");
    this.ambColorT = track(light, "KLBC");
    this.intensityT = track(light, "KLAI");
    this.ambIntensityT = track(light, "KLBI");
    // A directional light shines along its node's +Z; `direction` is the vector
    // toward it, so the shader's dot(normal, direction) is the classic N·L.
    // Confirmed by the outdoor sun's quaternion resolving to (-0.68, -0.41, 0.62),
    // which is what mdx-m3-viewer/HiveWE hard-coded as vec3(-0.3, -0.3, 0.25).
    const dir = rotate(rotation, [0, 0, 1]);
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    this.out = {
      ambient: new Float32Array(3),
      diffuse: new Float32Array(3),
      direction: new Float32Array([dir[0] / len, dir[1] / len, dir[2] / len]),
    };
  }

  /** Evaluate at `hour` in [0, DayHours). Returns the shared `out` buffer. */
  sample(hour: number): DayNightLight {
    const [start, end] = this.interval;
    const t = start + (hour / MISC_DATA.DayHours) * (end - start);
    const s = this.scratch;
    const light = this.light;

    let intensity = light.intensity;
    if (this.intensityT) {
      sampleTrack(this.intensityT, t, s, 1);
      intensity = s[0];
    }
    let ambIntensity = light.ambientIntensity;
    if (this.ambIntensityT) {
      sampleTrack(this.ambIntensityT, t, s, 1);
      ambIntensity = s[0];
    }

    if (this.colorT) sampleTrack(this.colorT, t, s, 3);
    else s.set(light.color);
    for (let i = 0; i < 3; i++) this.out.diffuse[i] = s[i] * intensity;

    if (this.ambColorT) sampleTrack(this.ambColorT, t, s, 3);
    else s.set(light.ambientColor);
    for (let i = 0; i < 3; i++) this.out.ambient[i] = s[i] * ambIntensity;

    return this.out;
  }
}

/** The pair of samplers for one map, evaluated together so both share a clock. */
export class DayNightCycle {
  private constructor(private terrain: LightSampler, private unit: LightSampler) {}

  /** Load the DNC models the given w3e tileset letter calls for. Returns null if the
   *  install has no WorldEditData.txt or the models can't be parsed (the caller then
   *  keeps the viewer's stock, unlit shading). */
  static load(vfs: DataSource, tileset: string): DayNightCycle | null {
    const lights = terrainLightPaths(vfs, tileset);
    const terrain = loadSampler(vfs, lights.terrain);
    const unit = loadSampler(vfs, lights.unit);
    return terrain && unit ? new DayNightCycle(terrain, unit) : null;
  }

  sample(hour: number): DayNightLights {
    return { terrain: this.terrain.sample(hour), unit: this.unit.sample(hour) };
  }
}

/** Resolve the tileset's [TerrainLights]/[UnitLights] entries out of WorldEditData.txt. */
function terrainLightPaths(vfs: DataSource, tileset: string): { terrain: string; unit: string } {
  const bytes = vfs.rawBytes(WORLD_EDIT_DATA);
  if (!bytes) return { terrain: DEFAULT_TERRAIN_LIGHT, unit: DEFAULT_UNIT_LIGHT };
  const text = new TextDecoder("windows-1252").decode(bytes);
  const key = tileset.charAt(0).toUpperCase();
  return {
    terrain: iniValue(text, "TerrainLights", key) ?? DEFAULT_TERRAIN_LIGHT,
    unit: iniValue(text, "UnitLights", key) ?? DEFAULT_UNIT_LIGHT,
  };
}

/** `key=value` from a `[section]` of a WC3 INI-style txt, skipping `//` comments. */
function iniValue(text: string, section: string, key: string): string | null {
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("[")) {
      inSection = line.slice(1, -1).toLowerCase() === section.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq).trim().toUpperCase() === key) return line.slice(eq + 1).trim();
  }
  return null;
}

/** Parse one DNC model and wrap its single light in a sampler. WorldEditData names
 *  the models as `.mdl`, but the archives ship the binary `.mdx` — swap the suffix. */
function loadSampler(vfs: DataSource, mdlPath: string): LightSampler | null {
  const bytes = vfs.rawBytes(mdlPath.replace(/\.mdl$/i, ".mdx"));
  if (!bytes) return null;
  let model: MdlxModel;
  try {
    model = new MdlxModel();
    model.load(bytes);
  } catch {
    return null;
  }
  const light = model.lights[0];
  const sequence = model.sequences[0];
  if (!light || !sequence) return null;
  const rotation = track(light, "KGRT")?.values[0] ?? [0, 0, 0, 1];
  return new LightSampler(light, [sequence.interval[0], sequence.interval[1]], rotation);
}
