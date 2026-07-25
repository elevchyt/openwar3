import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";

// Lightning effects — WC3's link-two-points bolts (issue #97). Chain Lightning, Healing
// Wave, Finger of Death, Forked Lightning, Mana Burn, Spirit Link and the Drains do NOT
// use an effect MODEL the way every other spell does: they draw a textured ribbon strung
// between a source and a target that follows both while it lives. That is why they looked
// like they had no art at all — there is no .mdx to play.
//
// Which bolt an ability uses is in its profile, not the SLK: `LightningEffect=CLPB,CLSB`
// in `Units\OrcAbilityFunc.txt` (see abilities.ts `lightning`). Each four-letter code is a
// row of `Splats\LightningData.slk`, which carries the whole look:
//
//   CLPB  Chain Lightning - Primary Bolt   ReplaceableTextures\Weather\Lightning.blp
//         AvgSegLen=100 Width=50 RGBA=255,255,255,255 NoiseScale=0.05 TexCoordScale=0.5 Duration=2
//   HWPB  Healing Wave - Primary Bolt      …\HealBeam.blp   NoiseScale=0.0001 (a smooth arc)
//   DRAL  Life Drain                       …\DrainLightning.blp  TexCoordScale=-0.8 (flows BACK)
//
// Field meanings, from the Hive Workshop tutorials "How to Customise Lightning Effects"
// (thread 203171) and "Beginner's Guide to Lightning Effects" (thread 220370), checked
// against the real 1.27a table and the textures themselves:
//   • `Dir`\`file`   the texture — a 256×64 horizontal STRIP with the bolt drawn into it
//                    on black, i.e. authored for additive blending and tiling along U.
//   • `AvgSegLen`    "the portion of the texture file visible at any instant (50 is half,
//                    100 is full)" — the U span across the whole bolt. Doubles as the
//                    average world length of a geometry segment (its literal name), which
//                    is what gives the ribbon its joints to be noised at.
//   • `Width`        the ribbon's width in world units.
//   • `R,G,B,A`      a tint over the texture (every stock row is plain white 255s).
//   • `NoiseScale`   "how fuzzy the lightning will become over long distances" — the
//                    perpendicular jitter as a FRACTION of the bolt's length, so a long
//                    bolt frays and a short one stays taut. 0.0001 = perfectly smooth
//                    (the heal beams), 0.05 = the electric bolts.
//   • `TexCoordScale` how fast the texture scrolls along the bolt: "higher values => very
//                    slow, low values => very fast", so the speed goes as 1/scale. NEGATIVE
//                    on the drains because their texture crawls back toward the caster.
//   • `Duration`     "how long it will take to naturally fade" — the fade-out, not the
//                    lifetime. The lifetime comes from the ABILITY (Finger of Death's
//                    "Graphic Duration", Mana Burn's "Bolt Lifetime"); rows are all 2s.

export interface LightningDef {
  id: string; // row id / the string a trigger names it by ("CLPB")
  texture: string; // resolved BLP path, backslashes (`dir\file`; `file` already has .blp)
  avgSegLen: number; // U span across the bolt, and the segment length (world units)
  width: number; // ribbon width, world units
  color: [number, number, number]; // R,G,B as 0..1
  alpha: number; // A as 0..1
  noiseScale: number; // perpendicular jitter as a fraction of the bolt's length
  texCoordScale: number; // scroll speed divisor; negative = scrolls toward the source
  duration: number; // fade-out time, seconds
}

export class LightningRegistry {
  constructor(private defs: Map<string, LightningDef>) {}
  get(id: string): LightningDef | undefined {
    return this.defs.get(id.toUpperCase());
  }
  get size(): number {
    return this.defs.size;
  }
}

// Lives under Splats\ beside UberSplatData.slk — verified in War3.mpq and War3x.mpq
// (the expansion's copy adds the TFT rows: FORK, SPLK, the drains, the heal beams).
const SLK = "Splats\\LightningData.slk";

export function loadLightningRegistry(vfs: DataSource): LightningRegistry {
  const defs = new Map<string, LightningDef>();
  const bytes = vfs.rawBytes(SLK);
  if (!bytes) return new LightningRegistry(defs);
  const table = new MappedData(new TextDecoder("windows-1252").decode(bytes));

  for (const id of Object.keys(table.map)) {
    const r = table.getRow(id) as { string(key: string): string | undefined } | undefined;
    if (!r) continue;
    const dir = str(r, "dir");
    const file = str(r, "file");
    if (!dir || !file) continue; // header / empty rows
    defs.set(id.toUpperCase(), {
      id,
      // `file` already carries its extension here (`Lightning.blp`), unlike UberSplatData.
      texture: `${dir.replace(/\//g, "\\")}\\${file}`,
      avgSegLen: num(r, "avgseglen", 100),
      width: num(r, "width", 40),
      color: [num(r, "r", 255) / 255, num(r, "g", 255) / 255, num(r, "b", 255) / 255],
      alpha: num(r, "a", 255) / 255,
      noiseScale: num(r, "noisescale", 0.05),
      texCoordScale: num(r, "texcoordscale", 0.5),
      duration: num(r, "duration", 2),
    });
  }
  return new LightningRegistry(defs);
}

// SLK cells use "-" for "none"; treat that (and missing) as empty/default.
function str(row: { string(key: string): string | undefined }, key: string): string {
  const v = row.string(key);
  return v === undefined || v === "-" ? "" : v;
}
function num(row: { string(key: string): string | undefined }, key: string, fallback: number): number {
  const v = row.string(key);
  if (v === undefined || v === "-") return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}
