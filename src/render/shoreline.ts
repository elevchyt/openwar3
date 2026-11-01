// The foam along every coast. `TerrainArt\Water.slk` names it, per tileset: `shoreDir` plus
// `shoreSFile` (a straight shore), `shoreOCFile` and `shoreICFile` (its two corners), each with a
// `...Var` count of numbered variants, as `<dir>\<file>\<file><n>.mdx`. No map places them: the
// models hold nothing but particle emitters, and the real client lays them along the coast itself.
//
// PLACEMENT is read off the models, because they only make sense one way. All three emit toward
// the LAND and fade out at the end of their life, so which way each faces says what it is for:
//
//   Shoreline0              one line of emitter at x = +80, 100 long in y, swimming to -x:
//                           the sea is +x of the origin (two wet corners of a cell).
//   ShorelineInsideCorner0  a short line (30) at (-67, +70), swimming to (+x, -y): the only wet
//                           corner of a cell is at (-x, +y) — a bay's head.
//   ShorelineOutsideCorner0 two long lines on the +x and -y sides, swimming to (-x, +y): the only
//                           DRY corner of a cell is at (-x, +y) — a point of land.
//
// All of them are centred on the cell: a straight shore's wave crosses it from the far edge and
// is brightest halfway over (`segmentAlphas` 0,255,0), which is where the water meets the ground.
// Checked against 1.30.4 (Booty Bay) by eye; nothing states this in a file.
//
// `shoreInFog` 0 is every row but Outland's: the foam only shows on ground in sight. The stand
// clips differ (Stand 3 holds the splash), so a finished clip picks again, as a doodad's does.

import { FogState, type VisionMap } from "../sim/vision";
import { CELL, type TerrainData } from "../world/terrain";

type Quat = readonly [number, number, number, number];
/** A quarter turn count about +Z, counter-clockwise: 0, 90, 180, 270 degrees. */
const TURN: readonly Quat[] = [
  [0, 0, 0, 1],
  [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  [0, 0, 1, 0],
  [0, 0, Math.SQRT1_2, -Math.SQRT1_2],
];

/** Corner bits of one cell. */
const BL = 1, BR = 2, TL = 4, TR = 8;
/** Which turn puts each straight model's +x (the sea) over a pair of wet corners. */
const STRAIGHT: Readonly<Record<number, number>> = { [BR | TR]: 0, [TL | TR]: 1, [BL | TL]: 2, [BL | BR]: 3 };
/** Which turn takes a corner model's own (-x, +y) corner to each corner, counter-clockwise. */
const CORNER_TURN: Readonly<Record<number, number>> = { [TL]: 0, [BL]: 1, [BR]: 2, [TR]: 3 };

interface ShoreInstance {
  setSequence(i: number): unknown;
  setSequenceLoopMode(mode: number): unknown;
  setScene(scene: unknown): unknown;
  setLocation(v: ArrayLike<number>): unknown;
  setRotation(q: ArrayLike<number>): unknown;
  show(): unknown;
  hide(): unknown;
  sequenceEnded: boolean;
  rendered: boolean;
  frame: number;
}
interface ShoreModel {
  addInstance(): ShoreInstance;
  sequences: unknown[];
}
interface WaterRow {
  string(key: string): string;
  number(key: string): number;
}
interface ShoreMap {
  worldScene: unknown;
  waterHeightOffset: number;
  viewer: { waterData: { getRow(id: string): WaterRow | undefined } };
}
interface ShoreViewer {
  load(path: string, solver: never): Promise<unknown>;
}

interface Placed {
  inst: ShoreInstance;
  x: number;
  y: number;
  clips: number;
}

export class Shoreline {
  private placed: Placed[] = [];
  private inFog = false;

  constructor(terrain: TerrainData, map: ShoreMap, viewer: ShoreViewer, solver: unknown) {
    const row = map.viewer.waterData.getRow(`${terrain.tileset}Sha`);
    if (!row) return;
    this.inFog = row.number("shoreInFog") !== 0;
    const dir = row.string("shoreDir");
    const load = async (file: string, count: number): Promise<ShoreModel[]> => {
      const all = await Promise.all(
        Array.from({ length: Math.max(1, count) }, (_, n) => viewer.load(`${dir}\\${file}\\${file}${n}.mdx`, solver as never).catch(() => undefined)),
      );
      return all.filter((m): m is ShoreModel => !!m);
    };
    void Promise.all([
      load(row.string("shoreSFile"), row.number("shoreSVar")),
      load(row.string("shoreOCFile"), row.number("shoreOCVar")),
      load(row.string("shoreICFile"), row.number("shoreICVar")),
    ]).then(([straight, outside, inside]) => this.place(terrain, map, straight, outside, inside));
  }

  private place(terrain: TerrainData, map: ShoreMap, straight: ShoreModel[], outside: ShoreModel[], inside: ShoreModel[]): void {
    const { width, height, centerOffset, corners } = terrain;
    const put = (models: ShoreModel[], cx: number, cy: number, turn: number): void => {
      if (!models.length) return;
      const model = models[Math.floor(Math.random() * models.length)];
      const inst = model.addInstance();
      const x = centerOffset[0] + (cx + 0.5) * CELL;
      const y = centerOffset[1] + (cy + 0.5) * CELL;
      const bl = corners[cy * width + cx];
      inst.setScene(map.worldScene);
      inst.setLocation([x, y, (bl.waterHeight + map.waterHeightOffset) * CELL]);
      inst.setRotation(TURN[turn]);
      inst.setSequenceLoopMode(0);
      inst.setSequence(Math.floor(Math.random() * model.sequences.length));
      // So a whole coast does not breathe in step.
      inst.frame += Math.random() * 2000;
      inst.hide();
      this.placed.push({ inst, x, y, clips: model.sequences.length });
    };
    for (let cy = 0; cy < height - 1; cy++) {
      for (let cx = 0; cx < width - 1; cx++) {
        const i = cy * width + cx;
        const wet = (corners[i].water ? BL : 0) | (corners[i + 1].water ? BR : 0)
          | (corners[i + width].water ? TL : 0) | (corners[i + width + 1].water ? TR : 0);
        if (wet === 0 || wet === 15) continue;
        const dry = 15 ^ wet;
        if (STRAIGHT[wet] !== undefined) put(straight, cx, cy, STRAIGHT[wet]);
        else if (CORNER_TURN[wet] !== undefined) put(inside, cx, cy, CORNER_TURN[wet]);
        else if (CORNER_TURN[dry] !== undefined) put(outside, cx, cy, CORNER_TURN[dry]);
        else {
          // Two wet corners on a diagonal: a bay's head at each.
          for (const c of [BL, BR, TL, TR]) if (wet & c) put(inside, cx, cy, CORNER_TURN[c]);
        }
      }
    }
  }

  /** A finished clip picks its next, as a doodad's stand does (`Widget.update`). */
  update(): void {
    for (const p of this.placed) {
      if (p.inst.rendered && p.inst.sequenceEnded) p.inst.setSequence(Math.floor(Math.random() * p.clips));
    }
  }

  /** Foam shows on ground in sight (`shoreInFog` 0), and on anything but the black if it is set. */
  applyFog(vision: VisionMap): void {
    for (const p of this.placed) {
      const s = vision.revealed ? FogState.Visible : vision.stateAt(p.x, p.y);
      const on = this.inFog ? s !== FogState.Unexplored : s === FogState.Visible;
      if (on !== p.inst.rendered) {
        if (on) p.inst.show();
        else p.inst.hide();
      }
    }
  }
}
