// Shared by the observer HUD's panels and the map list's search box (ui/mapFind.ts).

/**
 * An 8-tile backdrop strip — the engine's BackdropEdgeFile, left, right, top, bottom and then
 * the four corners, with the two horizontal edges stored as VERTICAL bars — re-sliced into the
 * 3×3 nine-patch CSS `border-image` drives. The same cut hud.ts makes of the tooltip's strip,
 * at whatever tile size the strip has (its height).
 *
 * `keep` trims every tile to the texels its OUTER edge actually draws (the edit-box strips are
 * mostly transparent toward the inside: bnet-inputbox-border's iron is the outer 22 of 64). The
 * engine lays a 0.032 corner over a field barely taller than that and lets the corners overlap;
 * CSS shrinks a border wider than half its box instead, which drew the iron at half its weight.
 * Cut to what is drawn, the border can be given the iron's own thickness. `tile` is then `keep`.
 */
export function ninePatch(strip: HTMLCanvasElement | null, keep?: number): { url: string; tile: number } | null {
  if (!strip) return null;
  const t = strip.height;
  if (strip.width < t * 8) return null;
  const full = document.createElement("canvas");
  full.width = full.height = t * 3;
  const g = full.getContext("2d")!;
  const tile = (i: number, cx: number, cy: number, turn = false): void => {
    g.save();
    g.translate(cx * t + t / 2, cy * t + t / 2);
    if (turn) g.rotate(Math.PI / 2);
    g.drawImage(strip, i * t, 0, t, t, -t / 2, -t / 2, t, t);
    g.restore();
  };
  tile(0, 0, 1); tile(1, 2, 1); tile(2, 1, 0, true); tile(3, 1, 2, true);
  tile(4, 0, 0); tile(5, 2, 0); tile(6, 0, 2); tile(7, 2, 2);
  if (!keep || keep >= t) return { url: full.toDataURL(), tile: t };

  // Corners keep their outer k×k, edges their outer k-wide band (at full length t).
  const k = keep;
  const out = document.createElement("canvas");
  out.width = out.height = 2 * k + t;
  const o = out.getContext("2d")!;
  const cols = [[0, k], [t, t], [3 * t - k, k]] as const; // [source x, width] per column
  const dest = [0, k, k + t];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (r === 1 && c === 1) continue; // the centre stays clear
      const [sx, w] = cols[c];
      const [sy, h] = cols[r];
      o.drawImage(full, sx, sy, w, h, dest[c], dest[r], w, h);
    }
  }
  return { url: out.toDataURL(), tile: k };
}
