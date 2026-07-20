import type { SimUnit } from "../sim/world";
import type { Viewpoint } from "./viewpoint";

// What the minimap shows, asked for ONE viewpoint (docs/multiplayer.md Phase E item 3b).
//
// These lived on `RtsController`. After item 3 made them read `sim.units` instead of the local
// client's render records, they touched no `Entry`, no model and no DOM — they were authority-side
// data wearing a client-side address. That address was not free: `rts.ts` imports
// `mdx-m3-viewer`, so nothing here could be reached from a headless test, and item 3 shipped a
// behaviour-changing move whose only verification was "the browser looks the same".
//
// The point of the move is therefore testability rather than tidiness: the property that matters —
// these answer for a viewpoint whose client rendered nothing — is exactly the one a single
// running client cannot demonstrate.

/** The slice of the world the minimap reads. Narrow on purpose, the same discipline as
 *  `VisionWorld`: this must never become a second handle on the whole `SimWorld`. */
export interface MinimapWorld {
  readonly units: ReadonlyMap<number, SimUnit>;
}

/**
 * Is this unit off the minimap for `vp` right now?
 *
 * Two different kinds of reason, and keeping them apart is the whole point. A unit inside a gold
 * mine, in a burrow, swallowed by a Kodo or removed is gone for EVERYONE — no viewpoint sees it.
 * Fog and invisibility depend on who is looking. `Entry.hidden` on the render record is the sum of
 * both, computed once for the local viewpoint, which is exactly right for the client drawing it
 * and useless for asking about anybody else.
 */
export function hiddenFor(vp: Viewpoint, u: SimUnit): boolean {
  if (u.inMine || u.insideBuild || u.inBurrow || u.devouredBy > 0 || u.vanished) return true;
  return vp.fogHides(u) || vp.invisHides(u);
}

/**
 * The coloured unit dots, for one viewpoint.
 *
 * Your own team's dots survive the fog test (`u.team === vp.team`): WC3 always shows you your own
 * army on the minimap, including units standing in a corner nobody has looked at for a minute.
 *
 * Neutral-passive units — critters, shops, the neutral buildings — never get a dot. They are
 * furniture, and `minimapIcons` paints the ones that get an icon instead.
 */
export function minimapDots(world: MinimapWorld, vp: Viewpoint): Array<{ x: number; y: number; owner: number }> {
  const out: Array<{ x: number; y: number; owner: number }> = [];
  for (const u of world.units.values()) {
    if (u.neutralPassive) continue;
    if (!hiddenFor(vp, u) || u.team === vp.team) out.push({ x: u.x, y: u.y, owner: u.owner });
  }
  return out;
}

export const ICON_GOLD_MINE = "UI\\MiniMap\\minimap-gold.blp";
export const ICON_NEUTRAL_BUILDING = "UI\\MiniMap\\MiniMap-NeutralBuilding.blp";

/**
 * Persistent minimap glyphs: each world position and the BLP to stamp there.
 *
 * **These are deliberately NOT fog-gated, and that is verified rather than assumed** — the real
 * 1.27a client paints both over pitch-black unexplored ground in a fresh melee game, which is how
 * you pick an expansion before scouting. Phase D left this as an open question ("nobody has
 * checked"); somebody then checked against the running game, and the answer is no gate. Do not
 * "fix" it from a reference or from memory.
 *
 *  · Gold mines wear `MiniMap-Goldmine.mdx`'s texture. (The client swaps in
 *    `minimap-gold-haunted`/`-entangled` once a mine is claimed; we do not model the claimed-mine
 *    unit yet, so every mine draws the plain icon.)
 *  · A neutral building wears the house glyph only if its `unitUI` row sets `nbmmIcon` — the
 *    useful ones (tavern, shops, mercenary camp, fountains, goblin laboratory) do; the scenery
 *    ones (murloc/gnoll huts, city buildings) do not, and fall through to a plain neutral dot.
 *
 * Takes `u.typeId` from the sim rather than the render record's copy, for the same reason as
 * `minimapDots`: a machine that drew nothing still has to be able to answer.
 */
export function minimapIcons(
  world: MinimapWorld & { readonly mines: ReadonlyMap<number, { x: number; y: number }> },
  registry: { get(typeId: string): { minimapIcon?: boolean } | undefined },
): Array<{ x: number; y: number; icon: string }> {
  const out: Array<{ x: number; y: number; icon: string }> = [];
  for (const m of world.mines.values()) out.push({ x: m.x, y: m.y, icon: ICON_GOLD_MINE });
  for (const u of world.units.values()) {
    if (!u.neutralPassive || u.building == null) continue;
    if (!registry.get(u.typeId)?.minimapIcon) continue;
    out.push({ x: u.x, y: u.y, icon: ICON_NEUTRAL_BUILDING });
  }
  return out;
}

/** World units — `MiscGame` CreepCallForHelp, the same "acts as one camp" radius the guard AI
 *  uses (see world.ts `sameCamp`). Two creeps whose GUARD POSTS are within this of each other
 *  belong to one camp. */
const CAMP_LINK = 600;

interface Camp {
  x: number;
  y: number;
  level: number;
  members: number[];
}

/**
 * Creep-camp difficulty markers.
 *
 * WC3 groups a map's Neutral Hostile creeps into camps and marks each on the minimap with a dot
 * coloured by the camp's COMBINED level — green 1–9, yellow 10–19, red 20+ (Liquipedia "Creeps").
 * The level is fixed map data: computed once from the placed creeps and never recomputed, so the
 * colour does not drift as the camp is whittled down.
 *
 * A class rather than a function because the clustering is cached — guard posts do not move.
 */
export class CreepCamps {
  private camps: Camp[] | null = null;

  constructor(private readonly world: MinimapWorld) {}

  /** Drop the cache, so the next ask re-clusters. For a fresh match. */
  reset(): void {
    this.camps = null;
  }

  /** Cluster the seeded creeps into camps: union-find over the "same camp" relation. */
  private build(): Camp[] {
    const creeps: Array<{ id: number; gx: number; gy: number; level: number }> = [];
    // `u.level`, not the render `Entry`'s. The two agree by construction — both are copied from
    // `def.level` at seed time — and only this one survives on a machine that drew nothing.
    for (const u of this.world.units.values()) {
      if (!u.isCreep) continue;
      creeps.push({ id: u.id, gx: u.guardX, gy: u.guardY, level: u.level });
    }
    const parent = creeps.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const link2 = CAMP_LINK * CAMP_LINK;
    for (let i = 0; i < creeps.length; i++) {
      for (let j = i + 1; j < creeps.length; j++) {
        const dx = creeps[i].gx - creeps[j].gx;
        const dy = creeps[i].gy - creeps[j].gy;
        if (dx * dx + dy * dy <= link2) parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, { sx: number; sy: number; level: number; members: number[] }>();
    for (let i = 0; i < creeps.length; i++) {
      const r = find(i);
      const g = groups.get(r) ?? { sx: 0, sy: 0, level: 0, members: [] };
      g.sx += creeps[i].gx;
      g.sy += creeps[i].gy;
      g.level += creeps[i].level;
      g.members.push(creeps[i].id);
      groups.set(r, g);
    }
    return [...groups.values()].map((g) => ({
      x: g.sx / g.members.length,
      y: g.sy / g.members.length,
      level: g.level,
      members: g.members,
    }));
  }

  /**
   * The camps `vp` should be shown a marker for.
   *
   * A camp whose creeps are all dead is gone. A camp with a creep this viewpoint can currently
   * SEE gets no marker — the creep speaks for itself, and the marker stands in for camps you know
   * are there but cannot presently see.
   */
  markers(vp: Viewpoint): Array<{ x: number; y: number; level: number }> {
    this.camps ??= this.build();
    const out: Array<{ x: number; y: number; level: number }> = [];
    for (const camp of this.camps) {
      const alive = camp.members.filter((id) => this.world.units.has(id));
      if (alive.length === 0) continue; // camp cleared
      if (alive.some((id) => !hiddenFor(vp, this.world.units.get(id)!))) continue;
      out.push({ x: camp.x, y: camp.y, level: camp.level });
    }
    return out;
  }
}
