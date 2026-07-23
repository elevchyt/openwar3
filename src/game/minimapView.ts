import { isOffField, type SimUnit } from "../sim/world";
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
  if (isOffField(u)) return true;
  return vp.fogHides(u) || vp.invisHides(u);
}

/**
 * The coloured unit dots, for one viewpoint.
 *
 * Your own team's dots survive the FOG test (`u.team === vp.team`): WC3 always shows you your own
 * army on the minimap, including units standing in a corner nobody has looked at for a minute.
 *
 * What that clause must NOT survive is `isOffField` — and it used to (Phase E item 3c). The
 * clause looks like it is about fog, but `Viewpoint.fogHides` already returns false for your own
 * team before it consults the grid, so fog was never what it overrode. The only thing it could
 * override was the viewpoint-independent half of `hiddenFor`, which meant a peasant inside a
 * gold mine and a peon inside a burrow each painted a dot at the spot they walked in from.
 * **Measured in the real 1.27a client: they get no dot.** So the off-field test is applied
 * first, on its own, and the own-team clause is left doing only the fog job it reads like.
 *
 * Neutral-passive units — critters, shops, the neutral buildings — never get a dot. They are
 * furniture, and `minimapIcons` paints the ones that get an icon instead.
 */
export function minimapDots(world: MinimapWorld, vp: Viewpoint): Array<{ x: number; y: number; owner: number }> {
  const out: Array<{ x: number; y: number; owner: number }> = [];
  for (const u of world.units.values()) {
    if (u.neutralPassive) continue;
    if (isOffField(u)) continue;
    if (!hiddenFor(vp, u) || u.team === vp.team) out.push({ x: u.x, y: u.y, owner: u.owner });
  }
  return out;
}

/** The fields `dotsFromSnapshot` reads — a structural slice of `UnitSnapshot`, so this file
 *  needs no import of it and a test can hand it a literal. */
export interface SnapshotDotUnit {
  x: number;
  y: number;
  owner: number;
  neutralPassive: boolean;
  inMine: boolean;
  insideBuild: boolean;
  inBurrow: boolean;
  devouredBy: number;
  vanished: boolean;
}

/**
 * The coloured dots, drawn straight from a per-recipient snapshot (docs/multiplayer.md item 10c).
 *
 * This is the client half of the same picture `minimapDots` computes on the host — and there is
 * **NO fog test here**, deliberately, which is the whole point of rendering from the payload.
 * The snapshot arrived AoI-filtered (item 6): it already contains exactly the units this player
 * is allowed to see, and only those. Re-applying `hiddenFor` would be asking a fog grid the
 * authority already consulted, and a client that could DECIDE its own fog is a client that can
 * turn it off — the maphack the whole per-recipient design exists to prevent. So the client
 * draws what it was sent, and the only local decisions left are the two that are facts about the
 * unit rather than about who may see it: neutral-passive furniture and off-the-field units get
 * no dot, exactly as on the host, through the SAME `isOffField`.
 */
export function dotsFromSnapshot(units: readonly SnapshotDotUnit[]): Array<{ x: number; y: number; owner: number }> {
  const out: Array<{ x: number; y: number; owner: number }> = [];
  for (const u of units) {
    if (u.neutralPassive) continue;
    if (isOffField(u)) continue;
    out.push({ x: u.x, y: u.y, owner: u.owner });
  }
  return out;
}

export const ICON_GOLD_MINE = "UI\\MiniMap\\minimap-gold.blp";
export const ICON_NEUTRAL_BUILDING = "UI\\MiniMap\\MiniMap-NeutralBuilding.blp";

/**
 * Persistent minimap glyphs: each world position and the BLP to stamp there.
 *
 * **A glyph is EXPLORED-gated: it appears the moment the black mask lifts off its tile, and stays
 * for good after** (issue #71). Phase D left "should these be fog-gated?" open, Phase E item 4
 * closed it as "no gate, measured against the real 1.27a client", and that close was wrong — the
 * session it was measured in ran the dev default `?dev&fog=explored`, where the whole map is
 * explored from tick 0 and every gate is invisible. The developer re-checked under normal fog:
 * a gold mine, a tavern, a fountain is NOT on the minimap until something of yours has been
 * there. Scouting expansions is the point of scouting.
 *
 * `explored`, not `visible`, is the gate, and the difference is the whole behaviour: you walk
 * past a mine once and its glyph stays on your minimap forever, the same way the terrain image
 * behind it does. So this asks `Viewpoint.hasExplored` — the very state the minimap's own fog
 * veil is painted from, which is what guarantees a glyph is never stamped onto a black tile.
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
 *
 * This is a PRESENTATION gate, not a secrecy one, and on a client it is asked of that client's
 * own fog grid — the same one it veils its minimap with. Mine positions and neutral-building
 * records still ride every payload (`snapshotFor`: a mine is map-placement furniture, and a
 * frozen client that deleted its shops would lose their models and splats too), so hiding an
 * unexplored mine on the WIRE is a separate job; see docs/multiplayer.md item 4.
 */
export function minimapIcons(
  world: MinimapWorld & { readonly mines: ReadonlyMap<number, { x: number; y: number }> },
  registry: { get(typeId: string): { minimapIcon?: boolean } | undefined },
  vp: Viewpoint,
): Array<{ x: number; y: number; icon: string }> {
  const out: Array<{ x: number; y: number; icon: string }> = [];
  for (const m of world.mines.values()) {
    if (vp.hasExplored(m)) out.push({ x: m.x, y: m.y, icon: ICON_GOLD_MINE });
  }
  for (const u of world.units.values()) {
    if (!u.neutralPassive || u.building == null) continue;
    if (!registry.get(u.typeId)?.minimapIcon) continue;
    if (!vp.hasExplored(u)) continue;
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
   * **Only a viewpoint that was given the whole map gets any** (issue #71). A camp marker is not
   * a memory of a camp you found — it is a difficulty rating for a camp you have not fought,
   * which is map-public knowledge of the same kind as the loading-screen preview. Under normal
   * WC3 fog the map is not public, so there are no markers at all: an unscouted camp is black
   * ground, and a scouted-then-abandoned one is black ground again. Discovering a camp does not
   * earn its dot — that was the bug. `knowsWholeMap` is true for the lobby's `explored` and
   * `revealall` modes (and `iseedeadpeople`), which is where the markers came from all along.
   *
   * Past that gate: a camp whose creeps are all dead is gone, and a camp with a creep this
   * viewpoint can currently SEE gets no marker — the creep speaks for itself through `dots()`,
   * and the marker stands in for camps you know are there but cannot presently see.
   */
  markers(vp: Viewpoint): Array<{ x: number; y: number; level: number }> {
    if (!vp.knowsWholeMap) return [];
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
