import { footprintCells, type PathingGrid } from "../sim/pathing";
import type { SimUnit } from "../sim/world";

// Formation solvers: given a group of unit ids and one target, hand each unit its
// OWN destination so a group ordered together spreads over the target instead of
// every member pathing to the identical point and shoving.
//
// AUTHORITY-SIDE (docs/multiplayer.md Phase B). These read only `units` and `grid`
// out of the sim plus the ids they are handed — no selection, no camera, no local
// player, no renderer, no DOM — so they compile and run without a viewer. They
// currently run client-side off the selection before the resulting per-unit
// commands go through `execute()`, and could move behind the wire unchanged.

/** The slice of `SimWorld` a formation solver needs. Narrowed deliberately: a
 *  solver has no business reaching for anything else, and the narrow type is what
 *  lets this file compile with no dependency on the bridge. */
export interface FormationWorld {
  readonly units: ReadonlyMap<number, SimUnit>;
  readonly grid: PathingGrid;
}

// Edge gap between the leader's body and the innermost ring of a follow formation
// — a comfortable body's-length behind, so followers trail rather than crowd.
const FOLLOW_RING_GAP = 40;

/** Give each unit in the group its OWN destination tile so they don't pile onto
 *  one spot — a COMPACT concentric-ring formation centred on the clicked point,
 *  spaced just enough that collision hulls don't overlap (so the group converges
 *  on the target rather than fanning out wide). Every slot is a distinct spot the
 *  unit's footprint fits on; nearest unit takes the nearest slot to minimise crossing. */
export function groupTargets(sim: FormationWorld, ids: number[], tx: number, ty: number): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const list = ids
    .map((id) => ({ id, u: sim.units.get(id) }))
    .filter((x): x is { id: number; u: SimUnit } => !!x.u);
  if (list.length <= 1) {
    for (const { id } of list) out.set(id, [tx, ty]);
    return out;
  }
  const grid = sim.grid;
  // A gap on top of the collision diameter: tight formation, but with a little
  // breathing room so units aren't shoulder-to-shoulder.
  let radius = 16;
  for (const { u } of list) radius = Math.max(radius, u.radius);
  const spacing = radius * 2 + 36;
  // Slots are sized/claimed for the group's LARGEST footprint so big units
  // (Knights, Tauren) reliably get a spot their whole body fits — claiming only
  // a single cell used to hand them a slot clipping terrain, which path-failed
  // and collapsed them back onto the centre.
  const fp = Math.max(1, footprintCells(radius));

  // Claim a distinct spot whose full fp×fp footprint is walkable and unclaimed
  // (spiral out from the desired point); reserve exactly the cells the unit will
  // settle on, using the sim's own snap math so the target is a valid stance.
  const used = new Set<number>();
  const claim = (wx: number, wy: number): [number, number] => {
    const [c0x, c0y] = grid.worldToCell(wx, wy);
    for (let r = 0; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
          const [cwx, cwy] = grid.cellToWorld(c0x + dx, c0y + dy);
          const [sx, sy] = grid.snapForFootprint(cwx, cwy, fp);
          const [ox, oy] = grid.footprintOrigin(sx, sy, fp);
          let ok = true;
          for (let yy = 0; yy < fp && ok; yy++) {
            for (let xx = 0; xx < fp; xx++) {
              const key = (oy + yy) * grid.width + (ox + xx);
              if (used.has(key) || !grid.walkable(ox + xx, oy + yy)) { ok = false; break; }
            }
          }
          if (!ok) continue;
          for (let yy = 0; yy < fp; yy++) for (let xx = 0; xx < fp; xx++) used.add((oy + yy) * grid.width + (ox + xx));
          return [sx, sy];
        }
      }
    }
    return [wx, wy];
  };

  // Concentric hex rings around the target (centre-out), just big enough.
  const slots: Array<[number, number]> = [];
  for (let ring = 0; slots.length < list.length && ring < 24; ring++) {
    if (ring === 0) { slots.push([tx, ty]); continue; }
    const n = ring * 6;
    for (let i = 0; i < n && slots.length < list.length; i++) {
      const a = (i / n) * Math.PI * 2;
      slots.push([tx + Math.cos(a) * ring * spacing, ty + Math.sin(a) * ring * spacing]);
    }
  }
  // Nearest unit → nearest slot (centre-out), each on its own claimed cell.
  const remaining = new Set(list.map((x) => x.id));
  for (const slot of slots) {
    if (!remaining.size) break;
    let best: number | null = null;
    let bestD = Infinity;
    for (const id of remaining) {
      const u = sim.units.get(id)!;
      const d = Math.hypot(u.x - slot[0], u.y - slot[1]);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best !== null) { out.set(best, claim(slot[0], slot[1])); remaining.delete(best); }
  }
  for (const id of remaining) out.set(id, claim(tx, ty));
  return out;
}

/** Distinct approach points fanned around a circular target (a building being
 *  raised, or a gold mine) so a group ordered together spreads over its rim
 *  instead of all pathing to the one centre point and shoving. Concentric rings
 *  start just outside `radius`; nearest worker claims the nearest free walkable
 *  slot (centre-out, like groupTargets — but ringed around an obstacle rather
 *  than filling a point). A single unit gets the plain centre, so the spread
 *  only kicks in when several are commanded at once. */
export function ringTargets(sim: FormationWorld, ids: number[], cx: number, cy: number, radius: number, extraSpacing = 0): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const list = ids
    .map((id) => ({ id, u: sim.units.get(id) }))
    .filter((x): x is { id: number; u: SimUnit } => !!x.u);
  if (list.length <= 1) {
    for (const { id } of list) out.set(id, [cx, cy]);
    return out;
  }
  const grid = sim.grid;
  let wr = 16;
  for (const { u } of list) wr = Math.max(wr, u.radius);
  // Neighbour gap along a ring / between rings. `extraSpacing` widens the fan
  // for callers that want the group spread further apart (speed-build) rather
  // than hugging the target tightly (a gold miner must land within entry reach).
  const spacing = wr * 2 + 24 + extraSpacing;

  // Claim a distinct, walkable cell near a world point (spiral out from it).
  const used = new Set<number>();
  const claim = (wx: number, wy: number): [number, number] => {
    const [c0x, c0y] = grid.worldToCell(wx, wy);
    for (let r = 0; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
          const gx = c0x + dx, gy = c0y + dy;
          const key = gy * grid.width + gx;
          if (used.has(key) || !grid.walkable(gx, gy)) continue;
          used.add(key);
          return grid.cellToWorld(gx, gy);
        }
      }
    }
    return [wx, wy];
  };

  // Ring 0 hugs the footprint edge (radius + a body + slack, so a gold miner
  // lands within its entry reach); outer rings step out by `spacing`. Each ring
  // is filled WHOLE — cutting it off after `list.length` points (as this used to)
  // only ever emitted the arc starting at angle 0, so five peasants sent to a gold
  // mine were all handed slots on its EAST rim and walked around it to enter from
  // behind (issue #63). A full ring lets the assignment below pick the near side.
  const slots: Array<[number, number]> = [];
  for (let ring = 0; slots.length < list.length && ring < 24; ring++) {
    const rr = radius + wr + 8 + extraSpacing + ring * spacing;
    const n = Math.max(1, Math.floor((2 * Math.PI * rr) / spacing));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ring * 0.618; // golden-ish stagger between rings
      slots.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
  }
  // Shortest walk first: take every (unit, slot) pair in ascending distance and
  // hand each unit the nearest slot still free. Greedily walking the SLOTS instead
  // (each grabbing its nearest unit) let a far-side slot claim a unit that had a
  // free slot right in front of it — the other half of the walk-around-the-mine bug.
  const pairs: Array<{ id: number; slot: number; d: number }> = [];
  for (const { id, u } of list) {
    for (let s = 0; s < slots.length; s++) {
      pairs.push({ id, slot: s, d: Math.hypot(u.x - slots[s][0], u.y - slots[s][1]) });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const takenSlot = new Set<number>();
  for (const p of pairs) {
    if (out.has(p.id) || takenSlot.has(p.slot)) continue;
    takenSlot.add(p.slot);
    out.set(p.id, claim(slots[p.slot][0], slots[p.slot][1])); // its own walkable cell
  }
  for (const { id } of list) if (!out.has(id)) out.set(id, claim(cx, cy));
  return out;
}

/** Formation offsets for a group told to FOLLOW one leader: each follower gets a
 *  distinct slot around the leader (returned as a world-space offset from its
 *  centre, since the leader moves) so the group holds a spread instead of all
 *  homing on the centre point and shoving. Concentric rings start a body behind
 *  the leader; nearest follower claims the nearest slot (least crossing). A lone
 *  follower gets (0,0) and simply trails — matching WC3's plain follow. */
export function followOffsets(sim: FormationWorld, ids: number[], leader: SimUnit): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const list = ids
    .map((id) => ({ id, u: sim.units.get(id) }))
    .filter((x): x is { id: number; u: SimUnit } => !!x.u);
  if (list.length <= 1) {
    for (const { id } of list) out.set(id, [0, 0]);
    return out;
  }
  let wr = 16;
  for (const { u } of list) wr = Math.max(wr, u.radius);
  const spacing = wr * 2 + 24; // neighbour gap so collision hulls don't overlap
  const ring0 = leader.radius + wr + FOLLOW_RING_GAP; // innermost ring, a body behind the leader

  // Concentric rings around the leader; each holds as many evenly-spaced slots
  // as fit, staggered so rings interleave rather than line up radially.
  const slots: Array<[number, number]> = [];
  for (let ring = 0; slots.length < list.length && ring < 24; ring++) {
    const rr = ring0 + ring * spacing;
    const n = Math.max(1, Math.floor((2 * Math.PI * rr) / spacing));
    for (let i = 0; i < n && slots.length < list.length; i++) {
      const a = (i / n) * Math.PI * 2 + ring * 0.618; // golden-ish stagger between rings
      slots.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
  }
  // Nearest follower → nearest slot, so each takes the side it already approaches
  // from and paths cross as little as possible.
  const remaining = new Set(list.map((x) => x.id));
  for (const slot of slots) {
    if (!remaining.size) break;
    let best: number | null = null;
    let bestD = Infinity;
    for (const id of remaining) {
      const u = sim.units.get(id)!;
      const d = Math.hypot(u.x - (leader.x + slot[0]), u.y - (leader.y + slot[1]));
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best !== null) { out.set(best, slot); remaining.delete(best); }
  }
  for (const id of remaining) out.set(id, [0, 0]);
  return out;
}
