/**
 * What the RENDER path reads off a unit (docs/multiplayer.md Phase E item 10c-2b).
 *
 * A host draws its own `SimWorld`; a client draws the `WorldSnapshot` it was sent. Those are
 * two different structs, and the renderer must not care which one it was handed — so every
 * render consumer is typed against this readonly surface instead, and both `SimUnit` and
 * `UnitSnapshot` satisfy it structurally. `tools/render-unit-conformance.ts` is what makes
 * that a fact rather than an intention.
 *
 * **It carries only fields something is actually typed against today**, and it grows one
 * consumer at a time as 10c takes them. A speculative field here would be a field nobody has
 * checked either struct against, which is exactly the drift the conformance file exists to
 * catch. Item 5 chose `UnitSnapshot`'s members by reading these same consumers, so the two
 * lists are two views of one decision and are expected to converge.
 *
 * **Readonly throughout, and that is load-bearing.** Rendering never writes to the world — on
 * a client there is no world to write to, only a payload that the next snapshot replaces. A
 * `readonly` surface makes a render consumer that tried to mutate a compile error rather than
 * a bug that only shows up on the client build.
 *
 * This file imports nothing. It is a contract between two modules that must not import each
 * other, so it belongs to neither.
 */

/** The four numbers `attackAnimRate` recovers the attack-speed factor from. `SimWeapon` and
 *  `WeaponSnapshot` both carry them; the rest of each (damage dice, range, cooldown) is the
 *  HUD's business, not the animation's. */
export interface RenderWeapon {
  readonly damagePoint: number;
  readonly backswing: number;
  readonly baseDamagePoint: number;
  readonly baseBackswing: number;
  /** The selection panel's damage line: `damage + dice` to `damage + dice*sides`, with the
   *  buff/aura portion split out against the unit's `bonusDamage` (item 10c-2c-3). */
  readonly damage: number;
  readonly dice: number;
  readonly sides: number;
}

/**
 * One production-queue slot, as the HUD reads it.
 *
 * `BuildJob` is a discriminated union of three shapes (unit / research / upgrade) and the panel
 * only ever asks four things of a slot: what kind it is, what it names, which LEVEL (research
 * has its own art per level), and how far along it is. Flattened to one shape with `level`
 * optional, because narrowing a union across the sim/wire boundary would make the panel care
 * which side it was reading from — which is the whole thing this type exists to prevent.
 */
export interface RenderBuildJob {
  readonly kind: string;
  readonly unitId: string;
  readonly level?: number;
  readonly timeLeft: number;
  readonly buildTime: number;
}

/** What the HUD's Status line reads off one buff — the buff row it is, its non-stacking key
 *  and what kind of thing it is. The magnitudes, the timers and the attached-model list are
 *  the sim's and the effect layer's; neither is a row of icons. */
export interface RenderBuff {
  readonly kind: string;
  readonly group: string;
  /** The `B….` buff row this IS — where the Status line reads its icon, name and tooltip
   *  (see BuffDef). "" when nothing named one, which falls back to the group. */
  readonly buffId: string;
  /** Seconds until the effect actually engages — an invisibility's Transition Time, counting
   *  down (see SimBuff.delay). The renderer reads it to draw the vanish as the BLEND it is
   *  rather than as a snap; it crosses the wire with the rest of the buff. */
  readonly delay: number;
}

/**
 * One ability on a unit, as the WORLD layer reads it — the row of spell icons floated over an
 * allied hero's health bar (rts.ts allyAbilityRow).
 *
 * Three fields, and they are the three questions that row asks: WHICH row it is (the alias, to
 * find the icon and whether it is a hero spell at all), what RANK it stands at (the pips), and
 * whether it is ready. `code`/`autocastOn` are the command card's business — the card reads a
 * `SimAbility` directly, because a card is only ever drawn for a unit this machine owns.
 */
export interface RenderAbility {
  readonly id: string;
  readonly level: number;
  readonly cooldownLeft: number;
}

/** The unit, as the render path reads it. */
export interface RenderUnit {
  // --- where it is, and what floats over it (item 10c-2c-2) -------------------
  // Everything the FRAME is drawn from: the model's place on the terrain, the health bar above
  // it, the selection ring under it, the hover slab beside it. These arrived together because
  // they are drawn together — a model at the snapshot's position with a bar at the sim's is the
  // Frankenstein the item exists to avoid.
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly radius: number;
  readonly owner: number;
  readonly team: number;
  readonly neutralPassive: boolean;
  readonly isHero: boolean;
  readonly properName: string;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly mana: number;
  readonly maxMana: number;
  /**
   * This record is a last-seen IMAGE rather than sight, and every live value above it has been
   * redacted to zero. On a client this REPLACES asking the fog `showsFromMemory` /
   * `fogBlocksClick` — the same fact arriving as data instead of as a second derivation of the
   * grid.
   *
   * **The one OPTIONAL member here, and the exception is the point.** A `SimUnit` has no such
   * field and must not grow one: "remembered" is a fact about a PAYLOAD addressed to somebody,
   * not about the world, and the host holding the world is never remembering it. So the sim path
   * leaves it `undefined` (falsy, which is the correct answer there) and only a `UnitSnapshot`
   * ever sets it. The conformance file is what found this: widening it as required broke
   * `SimUnit` immediately, which is exactly the drift it exists to catch.
   */
  readonly remembered?: boolean;

  // --- off the field: no position anybody can see (see `isOffField`) ----------
  readonly inMine: boolean;
  readonly insideBuild: boolean;
  readonly inBurrow: boolean;
  readonly devouredBy: number;
  readonly vanished: boolean;

  // --- how it is tinted ------------------------------------------------------
  /** Already viewpoint-resolved on the wire: item 5 masks it, so an enemy's snapshot says
   *  `false` for a Mirror Image and the reader needs no `seesFor` of its own. */
  readonly isIllusion: boolean;
  readonly ethereal: boolean;
  readonly invisible: boolean;

  // --- the selection panel's readout (item 10c-2c-3) --------------------------
  // The numbers the HUD prints when you click a unit. They arrived a slice later than the
  // frame's because a panel is drawn at a FIXED place in the HUD: it shares no position with
  // the model, so it is not frame-atomic with it and could wait.
  readonly armor: number;
  readonly bonusArmor: number;
  readonly bonusDamage: number;
  readonly invulnerable: boolean;
  /** Attack / armour upgrade levels — the corner number on the panel's damage and armour
   *  icons. Carried by the unit, so an ENEMY's shows its owner's research (WC3 scouting). */
  readonly attackUpgrade: number;
  readonly armorUpgrade: number;
  readonly xp: number;
  readonly skillPoints: number;
  readonly str: number;
  readonly agi: number;
  readonly int: number;
  readonly bonusStr: number;
  readonly bonusAgi: number;
  readonly bonusInt: number;
  /** Summon timer. Masked with the illusion tell on the wire — an enemy clicking a Mirror
   *  Image must see an ordinary hero, and a ticking expiry bar is itself the answer. */
  readonly isSummon: boolean;
  readonly summonLeft: number;
  readonly summonMax: number;
  /** The status row's icons. `SimBuff` is a plain data record and crosses whole. */
  readonly buffs: readonly RenderBuff[];
  /** What it can cast, and at what rank. Read by the world layer for an ALLY's hero only —
   *  your own hero's spells are on your command card, and an enemy's are not yours to read
   *  (see rts.ts allyAbilityRow). Already on the wire for the selection panel. */
  readonly abilities: readonly RenderAbility[];

  // --- animation -------------------------------------------------------------
  readonly spawning: number;
  readonly moving: boolean;
  readonly inCombat: boolean;
  readonly swingBroken: boolean;
  readonly swingSlam: boolean;
  readonly swingSeq: number;
  readonly chopSeq: number;
  /** Live move speed — the walk clip is re-rated against the model's authored gait. */
  readonly speed: number;
  /** `SimOrder` on the sim side and a plain string on the wire; the renderer only ever
   *  compares it, so the wider type is the honest one here. */
  readonly order: string;
  readonly working: boolean;
  /** Station this worker holds in a Haunted Gold Mine's mining ring (0 = none). Read only for
   *  the pose: an Acolyte kneeling at a mine wears "Stand Work Gold" (see pickSequence). */
  readonly ringSlot: number;
  /** Building id this worker is constructing (0 = none) — the renderer only asks truthiness. */
  readonly constructing: number;
  /** Which HALF of a two-form model is showing (a rooted Ancient, a burrowed Crypt Fiend). */
  readonly altModel: boolean;
  /** Seconds left on a TIMED alternate form (a Militia's 40), or 0. Drives the expiry bar. */
  readonly altFormLeft: number;
  readonly repair: { readonly active: boolean } | null;
  readonly worker: { readonly carryGold: number; readonly carryLumber: number } | null;
  /** Present iff this is a structure — which the renderer keys the health-bar suppression, the
   *  footprint-sized selection ring and the terrain seating off. The queue is read only for
   *  whether it is non-empty (the "Stand Work" clip); the construction pair scrubs the Birth
   *  clip to the build timer. */
  readonly building: {
    readonly queue: readonly RenderBuildJob[];
    readonly constructionLeft: number;
    readonly buildTimeTotal: number;
  } | null;
  /** Who is INSIDE it, and how many it holds — an Orc Burrow's peons, an Entangled Gold Mine's
   *  wisps. Read for the crew's SIZE only: the occupancy bar WC3 floats under such a building's
   *  health bar is a count of slots, not a fraction (rts.ts updateHealthBars). Already on the
   *  wire for the selection panel, so no snapshot field had to be invented for it. */
  readonly garrison: readonly number[];
  readonly garrisonCap: number;
  readonly weapon: RenderWeapon | null;
  readonly swingWeapon: RenderWeapon | null;
}
