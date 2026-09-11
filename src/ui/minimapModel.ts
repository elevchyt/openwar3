import MdlxModel from "mdx-m3-viewer/dist/cjs/parsers/mdlx/model";
import { mat4, quat, vec3 } from "gl-matrix";

// The minimap's two MODELS, drawn onto the minimap's own 2D canvas.
//
// `UI\war3skins.txt` names both beside the minimap's textures:
//     MinimapHero=UI\Minimap\MiniMap-Hero.mdl
//     MinimapIndicator=UI\Minimap\Minimap-Ping.mdl
// so a hero on the minimap and a ping are not painted glyphs at all — the engine plays a model
// at the spot, in the minimap's own 0.8 × 0.6 UI units.
//
// Both are small enough to read in full, and both are FLAT, which is why a 2D canvas draws them
// exactly rather than approximately:
//
//   MiniMap-Hero.mdx   one quad laid out as a DIAMOND (vertices at ±0.003 on each axis), UVs
//                      spanning the whole texture, texture ReplaceableId 1 (the team colour),
//                      filter mode None, no animation. A hero is a solid diamond in its colour.
//
//   Minimap-Ping.mdx   five quads facing +Z on four bones, all in one plane to within 0.02.
//                      Sequences Birth (0–1333, the four arrows `ping5.blp` swoop in from 0.276
//                      across, rotating, and shrink to 0.0877 of that) → Stand (1500–2333, the
//                      ring `ping2.blp` held and an echo `ping4.blp` scaled 1 → 10 and faded) →
//                      Death (2500–2833, everything fades); and the same three again as
//                      "AllyPing Birth/Stand/Death", which hide the arrows and show an
//                      exclamation mark (`ping6.blp`) with a wider echo instead. Every layer
//                      is Additive, and the arrows spin on the model's one global sequence.
//
// Every bone only scales about, and rotates around, the Z axis through its pivot, so projecting
// onto X/Y loses nothing. What a real MDX can do beyond this — particles, ribbons, a geoset
// animation's colour — neither model uses, and none of it is read here.

/** An MDX animation track as the mdlx parser hands it over. */
interface RawTrack {
  name: string;
  interpolationType: number;
  globalSequenceId: number;
  frames: ArrayLike<number>;
  values: Float32Array[];
  inTans: Float32Array[];
  outTans: Float32Array[];
}

interface RawNode {
  objectId: number;
  parentId: number;
  animations: RawTrack[];
}

/** Where on the timeline to sample: a sequence's own time, and the global-sequence clock. */
interface Clock {
  start: number;
  end: number;
  frame: number;
  globalMs: number;
}

// MDX filter modes (the layer's `filterMode`).
const FILTER_ADDITIVE = 3;
const FILTER_ADD_ALPHA = 4;
const FILTER_MODULATE = 5;
const FILTER_MODULATE_2X = 6;

export class MinimapModel {
  private readonly model: MdlxModel;
  private readonly nodes = new Map<number, RawNode>();
  private readonly textures: Array<HTMLCanvasElement | null>;
  private readonly tinted = new Map<string, HTMLCanvasElement>();
  private readonly world = new Map<number, mat4>(); // per draw: objectId → world matrix

  constructor(bytes: Uint8Array, texture: (path: string) => HTMLCanvasElement | null) {
    this.model = new MdlxModel();
    this.model.load(bytes);
    const m = this.model as unknown as { bones: RawNode[]; helpers: RawNode[] };
    for (const n of [...m.bones, ...m.helpers]) this.nodes.set(n.objectId, n);
    // A replaceable texture (the team colour) has no file; it is the colour the caller draws in.
    this.textures = this.model.textures.map((t) => (t.replaceableId === 0 && t.path ? texture(t.path) : null));
  }

  /** The [start, end] of a named sequence, or null if the model has none by that name. */
  sequence(name: string): { start: number; end: number } | null {
    const seq = this.model.sequences.find((s) => s.name.toLowerCase() === name.toLowerCase());
    return seq ? { start: seq.interval[0], end: seq.interval[1] } : null;
  }

  /**
   * Draw the model centred on (`cx`, `cy`) canvas pixels, `pxPerUnit` canvas pixels to one UI
   * unit, `ms` into the sequence `seq`, with `globalMs` on the global-sequence clock. `colour`
   * (CSS) is the team colour a replaceable texture takes and the tint every other texture is
   * multiplied by.
   */
  draw(ctx: CanvasRenderingContext2D, cx: number, cy: number, pxPerUnit: number, seq: string, ms: number, globalMs: number, colour: string): void {
    const s = this.sequence(seq);
    if (!s) return;
    const clock: Clock = { start: s.start, end: s.end, frame: Math.min(s.end, s.start + Math.max(0, ms)), globalMs };
    this.world.clear();
    const model = this.model as unknown as {
      geosets: Array<{ vertices: Float32Array; uvSets: Float32Array[]; faces: Uint16Array; vertexGroups: Uint8Array; matrixGroups: Uint32Array; matrixIndices: Uint32Array; materialId: number }>;
      materials: Array<{ layers: Array<{ filterMode: number; textureId: number; alpha: number; animations: RawTrack[] }> }>;
    };
    const p = vec3.create();
    for (const g of model.geosets) {
      const count = g.vertices.length / 3;
      // Each vertex rides the AVERAGE of its matrix group's bones, as the engine skins it.
      const groups: number[][] = [];
      for (let i = 0, k = 0; i < g.matrixGroups.length; i++) {
        groups.push(Array.from(g.matrixIndices.subarray(k, k + g.matrixGroups[i])));
        k += g.matrixGroups[i];
      }
      const sx: number[] = [], sy: number[] = [];
      for (let v = 0; v < count; v++) {
        let x = 0, y = 0;
        const bones = groups[g.vertexGroups[v]] ?? [];
        for (const b of bones) {
          vec3.transformMat4(p, [g.vertices[v * 3], g.vertices[v * 3 + 1], g.vertices[v * 3 + 2]], this.worldOf(b, clock));
          x += p[0];
          y += p[1];
        }
        const n = Math.max(1, bones.length);
        // The UI's +Y is up; the canvas's is down.
        sx.push(cx + (x / n) * pxPerUnit);
        sy.push(cy - (y / n) * pxPerUnit);
      }
      const uv = g.uvSets[0];
      if (!uv || g.faces.length < 3) continue;
      for (const layer of model.materials[g.materialId]?.layers ?? []) {
        const alpha = this.scalar(layer.animations, "KMTA", clock, layer.alpha);
        if (alpha <= 0.001) continue;
        const texture = this.textures[layer.textureId];
        const replaceable = !texture && (this.model.textures[layer.textureId]?.replaceableId ?? 0) > 0;
        if (!texture && !replaceable) continue;
        ctx.save();
        ctx.globalAlpha = Math.min(1, alpha);
        const additive = layer.filterMode === FILTER_ADDITIVE || layer.filterMode === FILTER_ADD_ALPHA;
        ctx.globalCompositeOperation =
          additive ? "lighter"
            : layer.filterMode === FILTER_MODULATE || layer.filterMode === FILTER_MODULATE_2X ? "multiply"
              : "source-over";
        // The geoset's outline, as a clip: every quad here is one plane mapped by ONE affine
        // transform of its UVs, so the texture drawn under the first triangle's transform and
        // clipped to the quad is the quad.
        ctx.beginPath();
        hull(sx, sy).forEach(([hx, hy], i) => (i ? ctx.lineTo(hx, hy) : ctx.moveTo(hx, hy)));
        ctx.closePath();
        if (replaceable) {
          ctx.fillStyle = colour;
          ctx.fill();
        } else if (texture) {
          ctx.clip();
          const [i0, i1, i2] = [g.faces[0], g.faces[1], g.faces[2]];
          const tw = texture.width, th = texture.height;
          const m = affine(
            [uv[i0 * 2] * tw, uv[i0 * 2 + 1] * th, uv[i1 * 2] * tw, uv[i1 * 2 + 1] * th, uv[i2 * 2] * tw, uv[i2 * 2 + 1] * th],
            [sx[i0], sy[i0], sx[i1], sy[i1], sx[i2], sy[i2]],
          );
          if (m) {
            ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
            ctx.drawImage(this.tint(layer.textureId, texture, colour, additive), 0, 0);
          }
        }
        ctx.restore();
      }
    }
  }

  /** A node's world matrix: pivot-relative translation · rotation · scale, under its parent's. */
  private worldOf(objectId: number, clock: Clock): mat4 {
    const cached = this.world.get(objectId);
    if (cached) return cached;
    const node = this.nodes.get(objectId);
    const out = mat4.create();
    if (!node) return out;
    const pivots = (this.model as unknown as { pivotPoints: Float32Array[] }).pivotPoints;
    const pivot = pivots[objectId] ?? vec3.create();
    const t = vec3.create(), r = quat.create(), sc = vec3.fromValues(1, 1, 1);
    this.vector(node.animations, "KGTR", clock, t);
    this.vector(node.animations, "KGSC", clock, sc);
    this.rotation(node.animations, clock, r);
    mat4.fromRotationTranslationScaleOrigin(out, r, t, sc, pivot as vec3);
    if (node.parentId >= 0 && node.parentId !== objectId) mat4.multiply(out, this.worldOf(node.parentId, clock), out);
    this.world.set(objectId, out);
    return out;
  }

  private scalar(tracks: RawTrack[], name: string, clock: Clock, fallback: number): number {
    const out = new Float32Array([fallback]);
    const track = tracks.find((a) => a.name === name);
    if (track) sampleTrack(track, clock, out, 1, (this.model as unknown as { globalSequences: number[] }).globalSequences);
    return out[0];
  }

  private vector(tracks: RawTrack[], name: string, clock: Clock, out: vec3): void {
    const track = tracks.find((a) => a.name === name);
    if (track) sampleTrack(track, clock, out as Float32Array, 3, (this.model as unknown as { globalSequences: number[] }).globalSequences);
  }

  private rotation(tracks: RawTrack[], clock: Clock, out: quat): void {
    const track = tracks.find((a) => a.name === "KGRT");
    if (track) sampleRotation(track, clock, out, (this.model as unknown as { globalSequences: number[] }).globalSequences);
  }

  /**
   * The texture multiplied by `colour`, cached per texture, colour and blend. An Additive
   * texture's black stays black, so the tint colours only what the texture lights.
   *
   * An ADDITIVE texture also takes its brightness as its alpha. These have no alpha channel —
   * black IS nothing when they are added onto the frame — but the minimap's dots canvas is a
   * TRANSPARENT layer over the map picture, and "lighter" onto a transparent pixel adds the
   * texel's alpha too: an opaque black texel became opaque black, and the Birth arrows' quads
   * (0.276 across, wider than the minimap) blacked the whole map out. Carried as alpha, black
   * texels are simply not there and the lit ones read the same as before.
   */
  private tint(id: number, texture: HTMLCanvasElement, colour: string, additive: boolean): HTMLCanvasElement {
    const key = `${id}|${colour}|${additive}`;
    const cached = this.tinted.get(key);
    if (cached) return cached;
    const c = document.createElement("canvas");
    c.width = texture.width;
    c.height = texture.height;
    const g = c.getContext("2d")!;
    g.drawImage(texture, 0, 0);
    g.globalCompositeOperation = "multiply";
    g.fillStyle = colour;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "destination-in"; // keep the texture's own alpha
    g.drawImage(texture, 0, 0);
    if (additive && c.width > 0 && c.height > 0) {
      const img = g.getImageData(0, 0, c.width, c.height);
      const px = img.data;
      for (let i = 0; i < px.length; i += 4) {
        const lit = Math.max(px[i], px[i + 1], px[i + 2]) * (px[i + 3] / 255);
        if (lit <= 0) { px[i + 3] = 0; continue; }
        const k = 255 / Math.max(px[i], px[i + 1], px[i + 2]);
        px[i] *= k; px[i + 1] *= k; px[i + 2] *= k; // un-premultiplied: the alpha carries the level
        px[i + 3] = lit;
      }
      g.putImageData(img, 0, 0);
    }
    this.tinted.set(key, c);
    return c;
  }
}

/**
 * Which keys of a track answer for this moment, as mdx-m3-viewer reads them: a global-sequence
 * track runs on its own clock over all its keys; any other track only over the keys INSIDE the
 * sequence, holding the first before it and the last after it — and a sequence with no key of
 * its own leaves the default (the static value, identity).
 */
function bracket(track: RawTrack, clock: Clock, globalSequences: number[]): { a: number; b: number; f: number } | null {
  const frames = track.frames;
  let frame: number, lo: number, hi: number;
  if (track.globalSequenceId >= 0) {
    const duration = globalSequences[track.globalSequenceId] ?? 0;
    frame = duration > 0 ? clock.globalMs % duration : 0;
    lo = 0;
    hi = duration;
  } else {
    frame = clock.frame;
    lo = clock.start;
    hi = clock.end;
  }
  let first = -1, last = -1;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] < lo || frames[i] > hi) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return null;
  if (frame <= frames[first]) return { a: first, b: first, f: 0 };
  if (frame >= frames[last]) return { a: last, b: last, f: 0 };
  let b = first + 1;
  while (b < last && frames[b] < frame) b++;
  const a = b - 1;
  const span = frames[b] - frames[a];
  return { a, b, f: span > 0 ? (frame - frames[a]) / span : 0 };
}

function sampleTrack(track: RawTrack, clock: Clock, out: Float32Array, size: number, globalSequences: number[]): void {
  const k = bracket(track, clock, globalSequences);
  if (!k) return;
  const { a, b, f } = k;
  for (let i = 0; i < size; i++) {
    const va = track.values[a][i], vb = track.values[b][i];
    if (a === b || track.interpolationType === 0) out[i] = va;
    else if (track.interpolationType === 1) out[i] = va + (vb - va) * f;
    else if (track.interpolationType === 2) {
      const f2 = f * f, f3 = f2 * f;
      out[i] = (2 * f3 - 3 * f2 + 1) * va + (-2 * f3 + 3 * f2) * vb + (f3 - 2 * f2 + f) * track.outTans[a][i] + (f3 - f2) * track.inTans[b][i];
    } else {
      const g = 1 - f;
      out[i] = g * g * g * va + 3 * g * g * f * track.outTans[a][i] + 3 * g * f * f * track.inTans[b][i] + f * f * f * vb;
    }
  }
}

/** A rotation track: slerp for linear keys, and for Hermite/Bezier the two-control-point
 *  `sqlerp` over the keys' tangents — the same reading mdx-m3-viewer gives a KGRT. */
function sampleRotation(track: RawTrack, clock: Clock, out: quat, globalSequences: number[]): void {
  const k = bracket(track, clock, globalSequences);
  if (!k) return;
  const { a, b, f } = k;
  const qa = track.values[a] as unknown as quat, qb = track.values[b] as unknown as quat;
  if (a === b || track.interpolationType === 0) quat.copy(out, qa);
  else if (track.interpolationType === 1) quat.slerp(out, qa, qb, f);
  else quat.sqlerp(out, qa, track.outTans[a] as unknown as quat, track.inTans[b] as unknown as quat, qb, f);
}

/** The canvas transform taking three texel points onto three screen points, or null if the
 *  triangle has collapsed (a bone scaled to nothing). */
function affine(src: number[], dst: number[]): [number, number, number, number, number, number] | null {
  const [x0, y0, x1, y1, x2, y2] = src;
  const [X0, Y0, X1, Y1, X2, Y2] = dst;
  const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(den) < 1e-9) return null;
  const a = ((X1 - X0) * (y2 - y0) - (X2 - X0) * (y1 - y0)) / den;
  const c = ((X2 - X0) * (x1 - x0) - (X1 - X0) * (x2 - x0)) / den;
  const b = ((Y1 - Y0) * (y2 - y0) - (Y2 - Y0) * (y1 - y0)) / den;
  const d = ((Y2 - Y0) * (x1 - x0) - (Y1 - Y0) * (x2 - x0)) / den;
  if (Math.abs(a * d - b * c) < 1e-6) return null;
  return [a, b, c, d, X0 - a * x0 - c * y0, Y0 - b * x0 - d * y0];
}

/** The convex outline of a geoset's projected vertices (a quad's four corners, in order). */
function hull(xs: number[], ys: number[]): Array<[number, number]> {
  const pts = xs.map((x, i) => [x, ys[i]] as [number, number]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: [number, number], p: [number, number], q: [number, number]): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
  for (const pt of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  for (const pt of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
