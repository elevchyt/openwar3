// What `SetTerrainType(x, y, type, variation, area, shape)` paints (docs/map-compatibility.md
// pass 10): which tile POINTS an area of a given size and shape covers, and which variation a
// "-1" picks.
//
// The GUI names the action "Change terrain type at … in an area of size N and shape S"
// (UI\TriggerStrings.txt), and the shape is the WORLD EDITOR's brush shape: `TerrainShapeCircle`
// is 0 and `TerrainShapeSquare` is 1 (UI\TriggerData.txt). No page documents what a size
// covers, so it is read off the one depiction the install has — the editor's own brush icons,
// `ReplaceableTextures\WorldEditUI\TextureBrush0N.blp` (circle) and `SquareSizeBrush0N.blp`
// (square), size N+1, which draw a brush one tile point every two pixels. Decoded, the circle
// icons for sizes 1–5 are exactly:
//
//     size 1: 1 point · size 2: the 5-point plus · size 3: 21 · size 4: 37 · size 5: 61
//
// i.e. a footprint (2N−1) points across, radius r = N−1, keeping the points with
// dx² + dy² < r(r+1) — every point of those five icons, and none outside. The square keeps
// the whole (2N−1)×(2N−1) block, as its size-4 icon draws it. (The icons for sizes 6 and 7
// reuse size 5's picture and size 8's is drawn at another scale, so they settle nothing; the
// rule above is simply carried on.) A size below 1 paints the one point it names.
//
// The VARIATION a -1 picks is the editor's random painting ("Use a variation of -1 to generate
// random variations across the area" — the action's hint), weighted by
// `UI\WorldEditData.txt [TerrainCellRarity]`: cells 0–15 are the extra variations, 16 and 17
// the two originals, and the weights are the file's.

/** The tile points `SetTerrainType` covers, as offsets from the point it was aimed at. `limit`
 *  caps the radius (the map's own size) — Angel Arena paints "the whole map" with an area of
 *  1 000 000 000, which must not become a billion-point loop. */
export function brushPoints(area: number, shape: number, limit: number): Array<[number, number]> {
  const r = Math.max(0, Math.min(Math.floor(area) - 1, limit));
  const out: Array<[number, number]> = [];
  const circle = shape === 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (circle && r > 0 && dx * dx + dy * dy >= r * (r + 1)) continue;
      out.push([dx, dy]);
    }
  }
  return out;
}

/** The [TerrainCellRarity] weights by cell id, read from WorldEditData.txt's text. Absent (or
 *  unreadable) → null, and the caller keeps the original cell. */
export function parseCellRarity(text: string): Array<[number, number]> | null {
  const start = text.search(/^\[TerrainCellRarity\]/m);
  if (start < 0) return null;
  const body = text.slice(start).split(/\r?\n/).slice(1);
  const out: Array<[number, number]> = [];
  for (const line of body) {
    if (/^\s*\[/.test(line)) break; // the next section
    const m = /^\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)/.exec(line);
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out.length ? out : null;
}

/** Pick a cell id by weight, `u` in [0, 1). */
export function pickCell(weights: ReadonlyArray<[number, number]>, u: number): number {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let at = u * total;
  for (const [id, w] of weights) {
    if (at < w) return id;
    at -= w;
  }
  return weights[weights.length - 1]?.[0] ?? 0;
}
