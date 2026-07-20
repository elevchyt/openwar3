import { VisionMap, FogState, fogStateOf } from "../sim/vision";
import type { AllianceTable } from "../sim/alliances";
import type { SimUnit } from "../sim/world";
import type { HeightSampler } from "./heightmap";
import type { FogArea, FogModifier } from "./fog";

/**
 * One player's eyes: a fog-of-war grid, and every question that can only be answered
 * "…for whom?" (docs/multiplayer.md Phase D item 2).
 *
 * These questions lived on `RtsController` as a dozen methods reading `this.localTeam` and
 * `this.vision`, which was correct while exactly one machine rendered exactly one viewpoint.
 * Phase E sends each client an AoI-filtered snapshot, so the authority has to answer them N
 * times over, once per recipient — and a method that closes over "local" cannot be asked
 * about anybody else.
 *
 * **This class is the extraction, not the change.** `rts.ts` holds a single `Viewpoint` and
 * the local player still sees exactly what it saw. What it buys is that every one of these
 * rules is now a method on an object you can have more than one of.
 *
 * Deliberately NOT here:
 *   • the fog-modifier REGISTRY — modifier ids are a single global handle space shared with
 *     JASS, so one registry stays on the controller and hands the running ones to `rebuild`.
 *     A standing modifier is not "routed" anywhere: every viewpoint is offered all of them and
 *     keeps the ones its own `seesFor` accepts, which is what makes an ally's modifier show up
 *     in your fog and an opponent's not. One-shots go through `VisionSet.stampFor`.
 *   • `pruneFogged` — it drops units from the SELECTION, which is client state, not vision.
 *     The controller calls it after `rebuild`.
 *   • anything that touches a render `Entry`. `applyFogTint` stays on the renderer side and
 *     asks `showsFromMemory` for the fog half of its answer.
 */

/** The slice of the world a viewpoint reads. Narrow on purpose: a viewpoint must be
 *  constructible in a test, and must never become a second handle on the whole `SimWorld`. */
export interface VisionWorld {
  readonly units: ReadonlyMap<number, SimUnit>;
  readonly isDay: boolean;
  activeAttackReveals(): Iterable<{ team: number; x: number; y: number; radius: number; flying: boolean }>;
  /** True Sight is a TEAM property in WC3 — one Shade uncovers a hero for the whole army —
   *  so this is the sim's own answer rather than one re-derived here. That keeps what you
   *  can shoot and what you can see the same answer. */
  teamDetects(team: number, x: number, y: number): boolean;
}

/** Fog rebuild cadence — 10 Hz, as it has always been. Cheap enough that N of them is a
 *  budget question rather than a design one, which is what item 7 measures. */
const REBUILD_INTERVAL = 0.1;

/** How the match starts every player's fog (the lobby's FogMode, minus the default). */
export type StartFog = "explored" | "revealall" | null;

export class Viewpoint {
  readonly vision: VisionMap;
  /** Seconds since this viewpoint's last rebuild. Starts above the interval so the first
   *  tick rebuilds rather than showing a frame of blank fog. */
  private accum = 1;
  /** Players whose units are REVEALED to this viewpoint — blizzard.j `CripplePlayer`, what
   *  MeleeExposePlayer does to a player whose crippled timer ran out. Their units show
   *  through the fog wherever they stand, which is the punishment itself and the one thing
   *  that can put an enemy unit on screen through black fog. */
  private exposed = new Set<number>();

  constructor(
    /** The slot these eyes belong to. */
    public player: number,
    /** The team whose combined sight lifts this viewpoint's fog. Not derivable from
     *  `player` — `teamOfPlayer` falls back to the slot number and the lobby may seat two
     *  slots on one team — so the caller states it (`setTeam`). */
    public team: number,
    private readonly world: VisionWorld,
    private readonly alliances: AllianceTable,
    originX: number,
    originY: number,
    worldWidth: number,
    worldHeight: number,
  ) {
    this.vision = new VisionMap(originX, originY, worldWidth, worldHeight);
  }

  setPlayer(player: number): void {
    this.player = player;
  }
  setTeam(team: number): void {
    this.team = team;
  }

  // --- who this viewpoint counts as "us" -------------------------------------------

  /** Does this viewpoint render `player`'s fog? True for itself and any team-mate — the
   *  grid is per-TEAM, so a modifier placed on an ally's fog shows up in ours, and one
   *  placed on an opponent's is invisible here (correctly: it is their fog, not ours). */
  seesFor(player: number): boolean {
    return player === this.player || this.teamOfPlayer(player) === this.team;
  }

  /** The team a player slot is on, as the sim knows it (any unit they own carries it).
   *  Falls back to the slot number, matching mapViewer.teamOf's own default. */
  teamOfPlayer(player: number): number {
    for (const u of this.world.units.values()) if (u.owner === player) return u.team;
    return player;
  }

  /** Does this unit's sight lift OUR fog? Your own team always does. Beyond that, a player
   *  who grants us ALLIANCE_SHARED_VISION lends us their units' eyes — which is the whole
   *  point of the setting, and what the GUI's "Player - Make X treat Y as an Ally (with
   *  shared vision)" turns on. */
  revealsFor(u: SimUnit): boolean {
    if (u.team === this.team) return true;
    return u.owner >= 0 && this.alliances.sharesVisionWith(u.owner, this.player);
  }

  /** CripplePlayer: reveal (or stop revealing) every unit `player` owns to these eyes. */
  setExposed(player: number, flag: boolean): void {
    if (flag) this.exposed.add(player);
    else this.exposed.delete(player);
  }
  isExposed(u: SimUnit): boolean {
    return u.owner >= 0 && this.exposed.has(u.owner);
  }

  // --- what this viewpoint may see ---------------------------------------------------

  /** Should this unit's model be hidden by the fog right now? Your own team is always
   *  visible. Enemy/neutral STRUCTURES persist once SEEN (WC3 leaves the last-seen building
   *  greyed in fog); mobile units and critters vanish unless currently in sight —
   *  "concealing enemy movements". "Seen", not "explored": see VisionMap.hasSeen. */
  fogHides(u: SimUnit): boolean {
    if (this.vision.revealed) return false;
    if (u.team === this.team && !u.neutralPassive) return false;
    if (this.isExposed(u)) return false;
    if (u.building != null) {
      const [cx, cy] = this.vision.worldToCell(u.x, u.y);
      return !this.vision.hasSeen(cx, cy);
    }
    return this.vision.stateAt(u.x, u.y) !== FogState.Visible;
  }

  /** May this viewpoint CLICK this unit right now — select it, hover it, aim an order at
   *  it? A different question from whether its model is drawn (fogHides), and the difference
   *  is the whole of issue #62: a structure you have seen KEEPS its image in the fog, but
   *  the image is a MEMORY, not eyes on the building. You can see the Goblin Merchant across
   *  the map; you cannot shop at it, select it, or send a unit to attack it, until something
   *  of yours is actually looking. */
  fogBlocksClick(u: SimUnit): boolean {
    if (this.vision.revealed) return false;
    if (u.team === this.team && !u.neutralPassive) return false;
    if (this.isExposed(u)) return false;
    return this.vision.stateAt(u.x, u.y) !== FogState.Visible;
  }

  /** No eyes on this spot right now. The test for things that are NOT sim units and so have
   *  their own pick paths — a gold mine (found from the ground point) and a ground item.
   *  Neither is remembered under fog the way a building is: a building you have seen keeps
   *  standing on the terrain as an image, but a mine you cannot see is one you cannot send a
   *  worker into, and an item is a live widget that vanishes with the eyes on it. */
  fogBlocksAt(p: { x: number; y: number }): boolean {
    if (this.vision.revealed) return false;
    return this.vision.stateAt(p.x, p.y) !== FogState.Visible;
  }

  /** Is this unit being shown from MEMORY — last-seen, out of current sight? What the
   *  renderer dims to the same grey as the terrain veil. An exposed player's units are shown
   *  rather than remembered, so they keep full colour. */
  showsFromMemory(u: SimUnit): boolean {
    if (this.vision.revealed || this.isExposed(u)) return false;
    return u.team !== this.team && this.vision.stateAt(u.x, u.y) !== FogState.Visible;
  }

  /** Does invisibility hide this unit from these eyes? Ours and our allies' invisible units
   *  stay drawn (half-faded) so we can still command them — the same viewpoint rule as the
   *  illusion wash. True Sight takes it back, and detection is a team property. */
  invisHides(u: SimUnit): boolean {
    if (!u.invisible) return false;
    if (this.seesFor(u.owner)) return false; // ours/an ally's — drawn, faded
    return !this.world.teamDetects(this.team, u.x, u.y);
  }

  // --- rebuilding the grid -------------------------------------------------------------

  /** Rebuild the "currently visible" layer from this viewpoint's live sight. Each friendly
   *  unit reveals a circle of its day- or night-sight radius; buildings and allies count
   *  too. Neutral shops grant no vision. Throttled by the caller (10 Hz).
   *
   *  `modifiers` is every script-placed modifier the controller holds; the ones this
   *  viewpoint renders are picked out here. */
  /** Advance this viewpoint's own rebuild clock; rebuild if it is due. Returns whether it
   *  did. Per-viewpoint rather than one shared clock so N viewpoints stagger naturally
   *  instead of all rebuilding on the same frame. */
  tick(dt: number, modifiers: Iterable<FogModifier>): boolean {
    this.accum += dt;
    if (this.accum < REBUILD_INTERVAL) return false;
    this.accum = 0;
    this.rebuild(modifiers);
    return true;
  }

  rebuild(modifiers: Iterable<FogModifier>): void {
    const day = this.world.isDay;
    this.vision.beginFrame();
    for (const u of this.world.units.values()) {
      if (u.neutralPassive) continue; // shops/critters don't scout for you
      if (!this.revealsFor(u)) continue;
      const r = (day ? u.sightDay : u.sightNight) || u.sightDay || 800;
      this.vision.reveal(u.x, u.y, r, u.flying); // flyers see over terrain/trees
    }
    // An enemy that shot at us out of the fog gives its position away for a second
    // (MiscData FoggedAttackRevealRadius) — so you see what is hitting you, and it fades
    // again if it stops. `flying` reveals over the treeline it fired through.
    for (const r of this.world.activeAttackReveals()) {
      if (r.team !== this.team) continue; // only OUR side learns where it came from
      this.vision.reveal(r.x, r.y, r.radius, r.flying);
    }
    // Script-placed fog modifiers are stamped LAST, over everything the units revealed —
    // that's what lets a running FOG_OF_WAR_VISIBLE modifier light ground nobody stands near
    // (a TD showing you its whole maze) and a FOG_OF_WAR_MASKED one black out ground you are
    // standing in (a cinematic area). Re-applied every rebuild, since the `visible` layer is
    // cleared and recomputed each time.
    for (const m of modifiers) {
      if (!m.running || !this.seesFor(m.player)) continue;
      this.stampArea(m.area, fogStateOf(m.state));
    }
  }

  stampArea(area: FogArea, state: FogState): void {
    if (area.kind === "rect") this.vision.stampRect(area.minX, area.minY, area.maxX, area.maxY, state);
    else this.vision.stampCircle(area.x, area.y, area.radius, state);
  }

  // --- pass-throughs to the grid --------------------------------------------------------

  /** Install the fog's line-of-sight height field + tree blockers, so vision is shadowed by
   *  high ground and treelines. `cliffHeightAt` is the CLIFF-LEVEL sampler, not the full
   *  terrain height — only real cliff levels block WC3 sight, not rolling groundHeight. */
  initBlockers(cliffHeightAt: HeightSampler, trees: Iterable<{ x: number; y: number; blockRadius: number }>): void {
    this.vision.setHeightField((x, y) => cliffHeightAt(x, y));
    for (const tree of trees) this.vision.addTreeBlocker(tree.x, tree.y, tree.blockRadius);
  }
  onTreeFelled(x: number, y: number, radius: number): void {
    this.vision.removeTreeBlocker(x, y, radius);
  }

  setFogEnabled(on: boolean): void {
    this.vision.setFogEnabled(on);
  }
  setFogMaskEnabled(on: boolean): void {
    this.vision.setMaskEnabled(on);
  }
  isFogEnabled(): boolean {
    return this.vision.isFogEnabled();
  }
  isFogMaskEnabled(): boolean {
    return this.vision.isMaskEnabled();
  }
  setRevealAll(on: boolean): void {
    this.vision.setRevealAll(on);
  }
  get revealed(): boolean {
    return this.vision.revealed;
  }
  exploreAll(): void {
    this.vision.exploreAll();
  }
}

/**
 * Every viewpoint in the match, created on demand (docs/multiplayer.md Phase D item 3).
 *
 * The registry exists rather than a bare `Map` because a viewpoint is not just a blank grid:
 * it has to be caught up on everything the world has already told the others. The boot order
 * makes that concrete — `initVisionBlockers` runs while the terrain loads, a good half-second
 * BEFORE `setLocalPlayer` says who is playing. A viewpoint minted after that moment and handed
 * out bare would have no height field and no tree blockers, and would see straight through
 * every cliff and treeline on the map. So the set records world setup and replays it onto each
 * viewpoint it creates.
 *
 * Tree blockers are seeded from the LIVE tree collection rather than from a replayed log,
 * because `SimWorld` deletes a felled tree from `trees` — so "the trees standing right now" is
 * already the correct answer for a viewpoint created right now, and stays correct for free.
 *
 * Exactly one viewpoint exists at runtime today: nothing asks for a second yet. Phase E's
 * snapshots are what start calling `viewpointFor` with somebody else's slot.
 */
export class VisionSet {
  private readonly byPlayer = new Map<number, Viewpoint>();
  private cliffHeight: HeightSampler | null = null;
  private startFog: StartFog = null;
  /** recipient → the players revealed to them (CripplePlayer). Held here rather than only on
   *  the viewpoints so a viewpoint created later inherits it. */
  private readonly exposures = new Map<number, Set<number>>();
  /** Teams with no player viewpoint of their own — creeps, and any side the local client
   *  holds no seat for. Keyed separately so a team is never rebuilt twice. */
  private readonly byTeam = new Map<number, Viewpoint>();

  constructor(
    private readonly world: VisionWorld,
    private readonly alliances: AllianceTable,
    /** The trees standing right now — read afresh each time a viewpoint is created. */
    private readonly trees: () => Iterable<{ x: number; y: number; blockRadius: number }>,
    private readonly originX: number,
    private readonly originY: number,
    private readonly worldWidth: number,
    private readonly worldHeight: number,
  ) {}

  /** This player's eyes, created (and caught up) on first ask. `team` seeds from whatever the
   *  sim currently says; the caller states it authoritatively via `Viewpoint.setTeam` when the
   *  lobby settles, because at boot there are no units yet to derive it from. */
  viewpointFor(player: number): Viewpoint {
    const existing = this.byPlayer.get(player);
    if (existing) return existing;
    const vp = new Viewpoint(
      player,
      player, // provisional team — see doc comment
      this.world,
      this.alliances,
      this.originX,
      this.originY,
      this.worldWidth,
      this.worldHeight,
    );
    vp.setTeam(vp.teamOfPlayer(player));
    if (this.cliffHeight) vp.initBlockers(this.cliffHeight, this.trees());
    if (this.startFog === "explored") vp.exploreAll();
    else if (this.startFog === "revealall") vp.setRevealAll(true);
    for (const exposed of this.exposures.get(player) ?? []) vp.setExposed(exposed, true);
    this.byPlayer.set(player, vp);
    return vp;
  }

  /** Every viewpoint that needs rebuilding. A team-only viewpoint is skipped once some
   *  player's viewpoint has taken over answering for that team — otherwise the same team
   *  would be rebuilt twice a tick, and the two grids could drift apart. */
  *all(): Iterable<Viewpoint> {
    yield* this.byPlayer.values();
    for (const [team, vp] of this.byTeam) if (!this.claimed(team)) yield vp;
  }

  /** Is some PLAYER's viewpoint already answering for this team? */
  private claimed(team: number): boolean {
    for (const vp of this.byPlayer.values()) if (vp.team === team) return true;
    return false;
  }

  /**
   * The eyes of a whole TEAM — what the sim's auto-acquisition gate asks (`visibleToTeam`).
   *
   * Prefers an existing PLAYER viewpoint on that team over minting a team-only one. That is
   * not just thrift: it means the local team keeps being answered by the very grid it was
   * always answered by, so this cannot change what the local player's units acquire.
   *
   * A team-only viewpoint is created with `player: -1`, which is deliberate. Creeps are a team
   * with no player slot, and `revealsFor` already keys team membership off `u.team` — the
   * `sharesVisionWith` half needs `owner >= 0` and correctly finds nobody.
   */
  viewpointForTeam(team: number): Viewpoint {
    for (const vp of this.byPlayer.values()) if (vp.team === team) return vp;
    const existing = this.byTeam.get(team);
    if (existing) return existing;
    const vp = new Viewpoint(-1, team, this.world, this.alliances, this.originX, this.originY, this.worldWidth, this.worldHeight);
    if (this.cliffHeight) vp.initBlockers(this.cliffHeight, this.trees());
    if (this.startFog === "revealall") vp.setRevealAll(true);
    // NOT exploreAll: the lobby's start-explored is a courtesy to HUMANS looking at a minimap.
    // Handing it to the creep team would explore ground no creep has walked, and `explored` is
    // not what the acquisition gate reads anyway — but it would be a lie in the grid.
    this.byTeam.set(team, vp);
    return vp;
  }

  /** Install the fog's line-of-sight height field on every viewpoint, present and future. */
  initBlockers(cliffHeightAt: HeightSampler): void {
    this.cliffHeight = cliffHeightAt;
    for (const vp of this.byPlayer.values()) vp.initBlockers(cliffHeightAt, this.trees());
  }

  /** A tree was felled — it stops blocking sight for everyone. */
  onTreeFelled(x: number, y: number, radius: number): void {
    for (const vp of this.byPlayer.values()) vp.onTreeFelled(x, y, radius);
  }

  /** The lobby's fog mode. A MATCH setting, so it applies to every viewpoint and is
   *  remembered for ones created later — unlike `iseedeadpeople`, which reveals the map to
   *  the one player who typed it and stays on their viewpoint alone. */
  setStartFog(mode: StartFog): void {
    this.startFog = mode;
    for (const vp of this.byPlayer.values()) {
      // revealall is a toggle and is set BOTH ways, so that clearing the mode actually
      // clears it rather than merely declining to apply it to viewpoints created later.
      vp.setRevealAll(mode === "revealall");
      // explored is sticky by construction — terrain memory is not un-learned — so there is
      // no "off" to apply here. Un-exploring is what a MASKED fog modifier is for.
      if (mode === "explored") vp.exploreAll();
    }
  }

  /** A ONE-SHOT `SetFogState` for `player` — stamped into every viewpoint that renders that
   *  player's fog, which is their own and any team-mate's or shared-vision ally's.
   *
   *  Applies to the viewpoints that exist WHEN IT FIRES, and is not replayed onto ones created
   *  later. That is a real limitation and it is deliberate: a one-shot's lasting effect is on
   *  the sticky `explored`/`seen` layers, so replaying would mean remembering every one-shot
   *  the match ever fired, forever, against the chance that a viewpoint appears afterwards.
   *  Standing modifiers do not have this problem — they are re-stamped on every rebuild by
   *  whoever is listening, which is exactly the distinction the two APIs exist to draw. It
   *  only bites if Phase E creates player viewpoints lazily mid-match rather than at match
   *  start; creating them at start is both easier and what removes this note. */
  stampFor(player: number, area: FogArea, state: FogState): void {
    for (const vp of this.byPlayer.values()) if (vp.seesFor(player)) vp.stampArea(area, state);
  }

  /** blizzard.j `CripplePlayer`: reveal `player`'s units to `recipient`, wherever they stand.
   *
   *  Recorded on the SET rather than pushed straight at a viewpoint, so that it does not
   *  conjure one. Exposure is standing state — it lasts until the cripple timer is cleared —
   *  so a viewpoint created later must inherit it, the same way it inherits the height field
   *  and the lobby's fog mode. Creating twelve grids to record a flag would have made every
   *  melee match pay item 7's cost early and by accident. */
  setExposed(recipient: number, player: number, flag: boolean): void {
    let set = this.exposures.get(recipient);
    if (!set) this.exposures.set(recipient, (set = new Set()));
    if (flag) set.add(player);
    else set.delete(player);
    this.byPlayer.get(recipient)?.setExposed(player, flag);
  }

  /** Advance every viewpoint's rebuild clock. Returns those that actually rebuilt, so the
   *  caller can follow up on its own (the controller re-prunes its selection). */
  tick(dt: number, modifiers: Iterable<FogModifier>): Viewpoint[] {
    const rebuilt: Viewpoint[] = [];
    // `modifiers` is iterated once per viewpoint, so it must be re-iterable — a Map's
    // .values() is, a bare generator is not. The controller passes the Map view.
    for (const vp of this.all()) if (vp.tick(dt, modifiers)) rebuilt.push(vp);
    return rebuilt;
  }
}
