import { CELL, cornerHeight, type TerrainData } from "../world/terrain";

// The height the camera's FOCUS rides — not the ground under it.
//
// WC3 keeps the camera a fixed distance from the terrain under the middle of the screen
// (docs/camera.md, "The focus rides the terrain"), but the terrain it means is a SMOOTHED one:
// the focus floats over a riverbed, rises before it reaches a cliff and never drops into a
// pond. Nothing in the install states the rule, so it was MEASURED against the real 1.30.4
// client: a copy of Twisted Meadows whose script tours eight points in cinematic mode (AOA
// 330, distance 1650, ZOFFSET 0 — so the focus height is the engine's own terrain answer and
// nothing else), each frame matched against ours rendered with the focus swept in 20-unit
// steps, plus the Frozen Throne credits' own camera:
//
//     point                       ground   real focus   Gaussian σ = 4 cells
//     cliff face                    316        316             303
//     foot of a 4-layer cliff       129        209             220
//     open grass                    169        150             139
//     pond (water surface 43)         5         45              35
//     open grass                    134        140             130
//     low basin                      12         72              80
//     grass below a rise            203        163             146
//     credits, over the river       204        314             314
//
// A Gaussian blur of the corner heights with σ = 4 cells (512 world units) fits all eight to
// 11 units RMS, about the resolution of the measurement; the raw ground misses by 57. A box
// or a tent of the same reach fits nearly as well, so the KERNEL is ours — what the data pins
// down is the reach. It is the ground and not the water: the pond's focus sits where its
// neighbours lift it, and a water-surface field fits worse everywhere water is.

/** σ of the blur, in terrain cells (128 world units). Fitted, see the header. */
export const CAMERA_HEIGHT_SIGMA = 4;

/** The smoothed corner-height field the camera focus rides, built once per map. */
export class CameraHeightField {
  private readonly w: number;
  private readonly h: number;
  private readonly ox: number;
  private readonly oy: number;
  private readonly z: Float32Array; // world units, row-major corners

  constructor(t: TerrainData, sigma = CAMERA_HEIGHT_SIGMA) {
    this.w = t.width;
    this.h = t.height;
    [this.ox, this.oy] = t.centerOffset;
    const raw = new Float32Array(this.w * this.h);
    for (let i = 0; i < raw.length; i++) raw[i] = cornerHeight(t.corners[i]) * CELL;
    const r = Math.ceil(sigma * 3);
    const k = new Float32Array(2 * r + 1);
    for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    // Separable, and renormalised at the map's edge rather than padded: a corner near the
    // boundary is the average of the terrain that EXISTS around it.
    const pass = (src: Float32Array, dx: number, dy: number): Float32Array => {
      const out = new Float32Array(src.length);
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          let s = 0;
          let n = 0;
          for (let i = -r; i <= r; i++) {
            const sx = x + i * dx;
            const sy = y + i * dy;
            if (sx < 0 || sy < 0 || sx >= this.w || sy >= this.h) continue;
            s += src[sy * this.w + sx] * k[i + r];
            n += k[i + r];
          }
          out[y * this.w + x] = s / n;
        }
      }
      return out;
    };
    this.z = pass(pass(raw, 1, 0), 0, 1);
  }

  /** The focus height at a world point, bilinear between the smoothed corners. */
  heightAt(x: number, y: number): number {
    const fx = Math.min(Math.max((x - this.ox) / CELL, 0), this.w - 1);
    const fy = Math.min(Math.max((y - this.oy) / CELL, 0), this.h - 1);
    const x0 = Math.min(Math.floor(fx), this.w - 2);
    const y0 = Math.min(Math.floor(fy), this.h - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const z = this.z;
    const w = this.w;
    const a = z[y0 * w + x0] * (1 - tx) + z[y0 * w + x0 + 1] * tx;
    const b = z[(y0 + 1) * w + x0] * (1 - tx) + z[(y0 + 1) * w + x0 + 1] * tx;
    return a * (1 - ty) + b * ty;
  }
}
