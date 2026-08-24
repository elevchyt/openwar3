import type { AbilityDef, AbilityLevel, BuffFx } from "../data/abilities";
import type { SimUnit, BuffKind, ClaimedCorpse } from "./world";
import type { CorpseOrder } from "./corpses";

// Spell effect handlers, dispatched on an ability's base `code` (data/abilities).
// This is the modular seam: the sim executes a cast by looking up the handler for
// the ability's `code`, so a custom map's ability that copies a standard one runs
// the same behaviour with the map's own numbers. Adding a spell = one entry here
// + a KNOWN_ABILITIES row; no other engine changes.
//
// Handlers are pure effect appliers over a small SpellApi (below). Whether the
// effect is delivered instantly or by a travelling missile is decided by the
// caller (world.ts, from the ability's missileArt) — the handler is the same.

/** What a handler can do to the world. Implemented by SimWorld. */
export interface SpellApi {
  rng(): number;
  getUnit(id: number): SimUnit | undefined;
  /** Live units whose collision hull is within `radius` of a point. */
  unitsInArea(x: number, y: number, radius: number): SimUnit[];
  hostile(a: SimUnit, b: SimUnit): boolean;
  /** Same team (friendly). */
  ally(a: SimUnit, b: SimUnit): boolean;
  /** Does this ability's own Targets Allowed (`targs1`) admit this unit as a KIND — air,
   *  ground, structure, organic, hero, ancient? The one place that question is answered
   *  (World.targsAdmit), shared with single-target casts, spell fields and orbs, so a
   *  handler never has to hand-write `if (t.flying) continue` and get it wrong. */
  admits(def: AbilityDef, target: SimUnit): boolean;
  /**
   * Launch a travelling WAVE from the caster toward (tx,ty): `dist` far, `halfWidth` to
   * either side. Each unit the front sweeps over gets the handler called again with
   * `ctx.targetId` set and `ctx.wave` holding the remaining damage budget — so the spell
   * lands ON a unit when the wave actually reaches it, which is the whole point.
   *
   * The wave shows itself one of two ways, and the ability's own row decides which:
   *   • as the ability's `Missileart`, carried along the line (Shock Wave, Carrion Swarm,
   *     Breath of Fire — the missile IS the spell), at the row's own `Missilespeed`;
   *   • as a `trail` of one-shot effects dropped every `step` units (Impale, whose art is
   *     a row of tendrils bursting out of the ground, not a projectile).
   * `speed` overrides `Missilespeed` for a wave whose row states its pace some other way
   * (Impale's `DataB` is "Wave Time (seconds)" for the whole `DataA` distance).
   *
   * Returns false when the ability has NEITHER — nothing to draw, so the handler should
   * sweep the line instantly instead.
   */
  launchWave(caster: SimUnit, def: AbilityDef, rank: number, opts: WaveOptions): boolean;
  /** Deal spell damage (armour is NOT applied to most spell damage in WC3). */
  spellDamage(target: SimUnit, amount: number, sourceId: number): void;
  spellHeal(target: SimUnit, amount: number): void;
  applyBuff(target: SimUnit, buff: SimBuffInit): void;
  /** Remove timed (dispellable) buffs from a unit (Dispel Magic, etc.). */
  dispel(target: SimUnit): void;
  /** Ask the renderer to create a summoned/raised unit (deferred, like training).
   *  `art.summon` plays where the unit materializes; `art.unsummon` replaces it when its
   *  timer runs out or it is dismissed (see summonArt/unsummonArt).
   *  `atPoint` says (x, y) is a TARGETED point the unit must land ON — a ward goes where
   *  you clicked. Without it (x, y) is the caster's own position and the unit is placed a
   *  step in front of them, WC3-style (see MapViewerScene.summonSpot).
   *
   *  `bound` ties the summon's life to the caster's — it leaves when the caster does. Rare,
   *  and only for an ability that says so: the Avatar of Vengeance's Spirits last "50 seconds
   *  or until the avatar dies", while an Archmage's Water Elemental outlives him. */
  requestSummon(unitId: string, x: number, y: number, facing: number, owner: number, team: number, durationSec: number, sourceId: number, art?: { summon: string; unsummon: string }, atPoint?: boolean, bound?: boolean): void;
  /**
   * TAKE up to `max` corpses within `radius` — the one door onto the corpse pool, shared by
   * every ability that spends bodies (see sim/corpses.ts for the family and the filter).
   *
   * Which bodies it may have comes off the ability's OWN row: `def.targetFlags` is `targs1`,
   * whose `friend`/`player` half is why Resurrection raises only your dead while Animate Dead
   * takes anyone's. `needsType = false` for a consumer that spends the body on something
   * other than rebuilding it (Cannibalize does not care what died).
   *
   * The bodies are marked spent before this returns — a corpse goes to exactly one caster.
   */
  claimCorpses(caster: SimUnit, def: AbilityDef, x: number, y: number, radius: number, max: number, order?: CorpseOrder, needsType?: boolean): ClaimedCorpse[];
  /** …and the RAISE-AS-THEMSELVES half: stand claimed bodies back up as what they were.
   *
   *  Resurrection calls it bare and gives the unit back whole. Animate Dead passes `opts`,
   *  and what comes back is a SUMMON: a timed, optionally invulnerable SHELL that keeps its
   *  weapon and loses everything it knew. */
  raiseClaimed(taken: ClaimedCorpse[], owner: number, team: number, opts?: RaiseOptions): number;
  /** Spirit Link: mark `unit` as sharing `share` of its damage across the `group` unit ids
   *  for `durationSec`. Applied to every member so the split is symmetric. */
  linkSpirits(unit: SimUnit, group: number[], durationSec: number, share: number): void;
  /** Kodo Devour: `kodo` swallows `prey` (hidden inside, digested over time). */
  devour(kodo: SimUnit, prey: SimUnit): void;
  /** Spirit Walker: toggle between ethereal and corporeal form (morph + ethereal state). */
  toggleSpiritForm(unit: SimUnit): void;
  /** True during daylight (Dawn–Dusk on the sim clock). Shadow Meld is a night ability, and
   *  the day/night cycle is the only world state any spell currently reads. */
  isDay(): boolean;
  /** Root/Unroot (`Aroo`): toggle an Ancient between planted and walking. False if it refused
   *  — the only refusal is trying to plant where the footprint no longer fits. */
  toggleRoot(unit: SimUnit): boolean;
  /** Entangle (`Aent`): wrap the nearest un-entangled gold mine within the ability's range.
   *  False when there is no mine in reach. */
  entangleMine(unit: SimUnit, def: AbilityDef): boolean;
  /** Eat Tree (`Aeat`): fell the nearest tree to (x, y) that `eater` can reach, and say
   *  whether there was one. The tree is destroyed outright — no lumber for anybody. */
  eatTree(eater: SimUnit, x: number, y: number, reach: number): boolean;
  /** Point a Moon Well at a unit to drink from it (`Ambt`). The pour itself is a tick, not
   *  an instant — see SimWorld.tickReplenish. */
  setReplenishTarget(well: SimUnit, targetId: number): void;
  /** Swap a unit between the two forms its ability names (DataA "Normal Form Unit" and
   *  UnitID1 "Alternate Form Unit") — Burrow and every other two-form ability. */
  morphToggle(unit: SimUnit, def: AbilityDef, rank?: number): boolean;
  /** Look up another ability's own row. The town bell reaches for `Amil` this way so the
   *  militia's stats and timer stay stated once, on the ability that owns them. */
  abilityOf(id: string): AbilityDef | undefined;
  /** Put a unit into the hold-position stance (order "hold"), clearing whatever it was
   *  doing. Shadow Meld melds a unit INTO this stance: WC3 has a melded unit "hold position
   *  and hold their fire", which is what stops it walking out of its own invisibility. */
  holdPosition(unit: SimUnit): void;
  /** Dismiss an owner's existing summons of the given types — Feral Spirit replaces the
   *  caster's old wolves on re-cast. Each leaves via its OWN unsummon effect (the art it
   *  was summoned with), so this needs no art passed in. */
  dismissSummons(owner: number, typeIds: string[]): void;
  /** Play an effect model at a unit (targetId>0) or a point (renderer). `life` = how
   *  long (s) the model instance is held before detaching (default ~2s); pass a longer
   *  value for a sustained effect like Flame Strike's 7s fire pillar. */
  emitEffect(art: string, x: number, y: number, targetId: number, life?: number): void;
  /** String a lightning bolt between two units (issue #97) — the ribbon art Chain Lightning,
   *  Healing Wave, the Drains, Mana Burn and Finger of Death use INSTEAD of an effect model.
   *  `id` is a LightningData row, normally taken straight off the ability
   *  (`def.lightning[0]` = the primary bolt, `[1]` = the secondary). `life` 0 = the row's own
   *  fade duration; `delay` staggers a chain's bounces. Ends attach at each unit's own
   *  missile launch/impact height, so a bolt leaves the caster's hands and lands on the
   *  target's body rather than at their feet. */
  emitLightning(id: string, from: SimUnit, to: SimUnit, life?: number, delay?: number, tag?: string): void;
  /** Cut every live bolt carrying `tag` (see SimLightning.tag) — an interrupted channel
   *  taking its tether down with it. */
  stopLightning(tag: string): void;
  /** The persistent models a given BUFF row hangs on its holder. An ability that lists
   *  several buffs picks between them off its own numbers, and the role matters as much as
   *  the flavour: the Drain's nine are caster/target/icon × life/mana/both. */
  buffFxOf(buffId: string): BuffFx[];
  /** Paint a temporary ground decal at a point — an `Splats\UberSplatData.slk` row id
   *  (Thunder Clap's `THND`). The row carries the texture, its half-width `Scale`, and
   *  the BirthTime/PauseTime/Decay fade the renderer plays it through. Which ability
   *  paints which splat is the engine's own wiring: nothing in AbilityData points at an
   *  ubersplat, but the table names the rows after the abilities that use them. */
  emitSplat(splatId: string, x: number, y: number): void;
  /** Register a repeating area effect (Blizzard waves, Rain of Fire, …). */
  addSpellField(f: SpellFieldInit): void;
  /** Drain up to `amount` mana from a unit; returns the mana actually removed
   *  (Mana Burn deals damage equal to what it burned). */
  burnMana(target: SimUnit, amount: number): number;
  /** Move a unit instantly to a point (Blink, Mass Teleport) — re-settles pathing. */
  teleport(unit: SimUnit, x: number, y: number): void;
  /** Change a unit's controller (Charm): new owner + team. */
  changeOwner(unit: SimUnit, owner: number, team: number): void;
  /** Kill a unit outright (Death Pact / Dark Ritual sacrifice, Transmute). */
  killUnit(unit: SimUnit): void;
  /** Transmute (`ANtm`): melt a unit down for its owner-facing cost and pay the CASTER's
   *  player, then kill it. The factors are the ability's own columns; everything else (what
   *  the victim is worth, whose purse it lands in, the number that floats over the body) is
   *  the world's. Returns the gold paid. */
  transmute(target: SimUnit, caster: SimUnit, goldFactor: number, lumberFactor: number): number;
  /** Fell up to `max` trees within `radius` of a point and say WHERE each stood. Force of
   *  Nature is the reason it returns the spots rather than a count: its `targs1` is `tree`
   *  and each treant it makes stands in the hole its own tree left. */
  fellTrees(x: number, y: number, radius: number, max: number): Array<{ x: number; y: number }>;
  /** Immolation (`AEim`): light the caster, or put him out. The burn itself runs on the
   *  caster's own tick (world.ts tickImmolation) because it has to follow him around. */
  toggleImmolation(unit: SimUnit): void;
  /** Doom (`ANdo`): mark a unit so that DYING under the curse summons the Doom Guard its
   *  `UnitID1` names. Same shape as Black Arrow's minion — the death is the trigger, so the
   *  fact has to be recorded on the victim rather than acted on here. */
  markDoom(target: SimUnit, caster: SimUnit, def: AbilityDef, rank: number): void;
  /** Big Bad Voodoo (`AOvd`): open the ritual. A channel, so the world keeps handing the
   *  invulnerability out for as long as the Shadow Hunter stands there (tickVoodoo). */
  voodoo(caster: SimUnit, def: AbilityDef, rank: number): void;
  /** How many units of a given type this owner already has alive — Carrion Beetles' own
   *  `Ucb5 "Max Units Summoned"` cap, which is the only thing stopping a Crypt Lord
   *  turning a battlefield of corpses into an army. */
  countOwned(owner: number, typeId: string): number;

  /** Mirror Image: run the caster-vanishes -> missiles -> illusions sequence (AOmi).
   *  Staged over time in the world, so the handler only kicks it off. */
  mirrorImage(caster: SimUnit, def: AbilityDef, rank: number): void;
}

export interface SimBuffInit {
  kind: BuffKind;
  group?: string;
  timeLeft: number;
  sourceId: number;
  value?: number;
  value2?: number;
  art?: string;
  /** The buff's persistent models + attachment points (def.buffFx). Pass this via
   *  `...fx(def)` — see below — rather than setting `art` by hand. */
  fx?: BuffFx[];
  /** The `B….` row this buff IS (`Ablo` → `Bblo`). Carried so the info panel's Status
   *  row can name and describe it the way the game does — see `fx(def)`, which supplies
   *  it alongside the art, and AbilityRegistry.buff(). */
  buffId?: string;
  delay?: number; // seconds before the effect engages (Wind Walk's Transition Time)
  /** Marks a Shadow Meld invisibility, which also breaks on MOVEMENT and at DAWN
   *  (world.ts tickMeld). See SimBuff.meld. */
  meld?: boolean;
  /** A `dot` that cannot land the killing blow — WC3 poison. See SimBuff.nonLethal. */
  nonLethal?: boolean;
  /** Runs on the holder's HEALTH BAR rather than on a clock: it ends the moment the unit is
   *  at full hit points, whenever that is. See SimBuff.untilHealed (Staff of Sanctuary). */
  untilHealed?: boolean;
  /** Dispel Magic may not remove this (Doom). See SimBuff.undispellable. */
  undispellable?: boolean;
}

/** The art half of an applyBuff: spread into a SimBuffInit (`...fx(def)`).
 *
 *  A buff's persistent model lives on its BUFF row, not on the ability — most
 *  buff-applying abilities (Divine Shield, Slow, Bloodlust, Inner Fire…) have no
 *  TargetArt of their own at all, so reaching for `def.targetArt` here silently
 *  rendered nothing. `def.targetArt` is the one-shot CAST burst (Holy Light's
 *  flash) and belongs in emitEffect, not on a buff. Falls back to targetArt for
 *  the handful of custom abilities that do put their buff model there.
 *
 *  It also carries the buff's own ID along, because the same row is what the info
 *  panel's Status row reads its icon, name and tooltip off (see BuffDef). */
export function fx(def: AbilityDef): { art: string; fx: BuffFx[]; buffId: string } {
  const buffId = buffIdOf(def);
  if (def.buffFx.length) return { art: def.buffArt, fx: def.buffFx, buffId };
  return { art: def.targetArt, fx: def.targetArt ? [{ path: def.targetArt, attach: [] }] : [], buffId };
}

/** An ability's buff row (`buffid<rank>`, first of the list). Rank is rarely worth passing:
 *  no stock ability changes which buff it applies between ranks — the LEVELS of a spell
 *  differ in numbers, not in the state they put the target in. */
export function buffIdOf(def: AbilityDef, rank = 1): string {
  const lvl = def.levelData[Math.min(Math.max(1, rank), def.levelData.length) - 1];
  return lvl?.buffs?.[0] ?? ""; // `buffs` is absent on hand-built defs (tests, custom rows)
}

export interface SpellFieldInit {
  code: string;
  x: number;
  y: number;
  area: number;
  damagePerWave: number;
  waves: number;
  interval: number; // seconds between waves
  casterId: number;
  art: string;
  /** The looping bed under this field for as long as it runs — an AbilitySounds.slk LABEL
   *  (see AbilityDef.fxLoopSound / effectSoundLooped), carried on the field so the renderer
   *  can key one loop per field without having to find the ability again. */
  loopSound?: string;
  artPerWave?: number; // how many copies of `art` to scatter across the area each wave (default 1).
  //                      WC3's Blizzard rains a handful of shards per wave, not a single one.
  waveSound?: boolean; // cue the art's folder WAV once per wave (Blizzard's shard fall).
  delay?: number; // seconds before the FIRST wave (default 0 = fire immediately). Lets a
  //                 field start after another (Flame Strike's subsiding burn follows the pillar).
  maxDamagePerWave?: number; // "Maximum Damage per Wave" (DataF): the total a single wave may
  //                            deal across everything it hits. Over that, the wave splits its
  //                            budget evenly — Blizzard's 30/wave hits 5 units for full, 10 for 15.
  buildingReduction?: number; // "Building Reduction" (DataD): fraction of the wave's damage a
  //                             BUILDING shrugs off (0.5 → structures take half).
  dot?: { dps: number; duration: number; heroDuration: number; group: string; art: string; buffId: string }; // per-wave
  //       burn left on everything the wave hits (Rain of Fire's "and N damage per second for 3 seconds").
  impactDelay?: number; // seconds between a wave's art SPAWNING and its damage landing. The shard
  //                       is a falling model, and WC3 hurts you when it hits the ground, not when
  //                       it appears in the sky. See SHARD_FALL.
  /** Each wave lands at a RANDOM point within `scatter` of (x,y) rather than dead centre —
   *  a field whose area of EFFECT is smaller than the area it covers. Stampede is the one
   *  that needs it: `Area1` = 1000 is the ground the herd tramples, while `Nst4 "Damage
   *  Radius"` = 275 is what a single beast catches, and 60 beasts arrive one at a time. */
  scatter?: number;
  /** Damage is a FRACTION OF EACH TARGET'S MAXIMUM LIFE, not a flat number. Death and Decay
   *  is the whole reason: `Udd1` is named "Max Life Drained per Second (%)" and reads 0.04,
   *  which is why it melts a Town Hall and tickles a Ghoul. */
  damagePctOfMax?: boolean;
  /** Fell trees in the area even though `targs1` doesn't list `tree`. Death and Decay clears
   *  a forest in the real game, but its Targets Allowed is only `air,ground,structure,ward` —
   *  the flag list can't express it, so the ability states it (cf. POLARITY_SPELLS). */
  fellsTrees?: boolean;
  /** Only STRUCTURES take this field's damage. Earthquake's `Oeq2` is named "Damage per
   *  Second to Buildings" and its units half is a slow, not a wound — the tooltip says so
   *  outright ("damages buildings … slows units"). */
  buildingsOnly?: boolean;
  /** The field rocks the CAMERA while it runs (Earthquake, the one thing in the game that
   *  does). Presentation only — see MapViewerScene.updateFieldLoops. */
  shake?: boolean;
}

/** Play a field's art ONCE, at its centre, held for the whole run — for the effects that are
 *  one big sustained model rather than a shower of small ones.
 *
 *  Which a field is comes from its own data. Blizzard and Rain of Fire carry `DataC "Number
 *  of Shards"` and scatter that many BlizzardTarget/RainOfFireTarget copies per wave; the
 *  ones with no count column at all are single effects sized for the whole circle, and their
 *  models say so — Tranquility.mdx runs Birth 0–2.7s then Stand to 5.6s, EarthQuakeTarget.mdx
 *  Birth then a 9-second Stand. Scattering a dozen of THOSE per second (which is what a
 *  shard-style field did to Tranquility) buries the map in overlapping light pillars and
 *  costs a third of the frame rate. */
function fieldOnce(api: SpellApi, def: AbilityDef, x: number, y: number, seconds: number): void {
  const art = fieldArt(def);
  if (art) api.emitEffect(art, x, y, 0, seconds);
}

/** The model a FIELD paints on the ground, and the looping bed it lays under it.
 *
 *  Neither is normally on the ability row: WC3 puts them on the ability's EFFECT OBJECT,
 *  the `[X….]` section its `EfctID1` column names (see AbilityDef.fxArt) — `[AUdd] EfctID1
 *  = XUdd`, and `[XUdd]` is where `DeathandDecayTarget.mdl` and `Effectsoundlooped =
 *  DeathAndDecayLoop` sit. Nine of our field spells are like that (Blizzard, Rain of Fire,
 *  Starfall, Volcano, Flame Strike, Earthquake, Tranquility, Death and Decay, Healing Spray
 *  and Cluster Rockets), which is why they used to run with bare ground and no sound.
 *  `areaArt` and
 *  `targetArt` come first for the custom rows that DO put the model on the ability itself;
 *  FIELD_ART is the last resort for a row that names none anywhere. */
function fieldArt(def: AbilityDef): string {
  return def.areaArt || def.fxArt || def.targetArt || FIELD_ART[def.code] || "";
}
/** …and the loop label: the effect object's, else the ability's own (Stampede and Locust
 *  Swarm carry `Effectsoundlooped` on themselves and have no effect object at all). */
function fieldLoop(def: AbilityDef): string {
  return def.fxLoopSound || def.effectSoundLooped;
}

/** How a wave sweeps and how it shows itself (SpellApi.launchWave). */
export interface WaveOptions {
  tx: number; // aim point — the wave takes its DIRECTION from this, not its length
  ty: number;
  dist: number; // how far the front runs
  halfWidth: number; // how far either side of the line it catches
  budget?: number; // total damage the wave may spend (the family's "Maximum Damage")
  speed?: number; // world units a second; defaults to the row's `Missilespeed`
  /** One-shot effects dropped along the line every `step` units, for a wave whose art is
   *  the ground it passes over rather than a projectile (Impale's tendrils). */
  trail?: { art: string; step: number };
}

/** Animate Dead's half of a raise (see SpellApi.raiseClaimed). */
export interface RaiseOptions {
  durationSec: number; // 0 = permanent (Resurrection)
  invulnerable?: boolean; // `Hre2 "Raised Units Are Invulnerable"`
  art?: string; // the burst each body rises in
  unsummonArt?: string; // …and the one that replaces it when the timer runs out
}

/** Where a cast is aimed. */
export interface CastContext {
  targetId: number; // unit target (0 = none)
  x: number; // point target / caster position
  y: number;
  /** Set when this call is a WAVE reaching a unit rather than the cast itself (see
   *  SpellApi.launchWave): `targetId` is the unit the front just swept over, and `budget`
   *  is the wave's remaining total-damage allowance, which the handler spends. */
  wave?: { budget: number };
}

type Handler = (api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, ctx: CastContext) => void;

/** Curated effect models for spell fields whose art isn't in the ability data.
 *  (Neither ability names one: MPQ HumanAbilityFunc [AHbz] / NeutralAbilityFunc
 *  [ANrf] both have an empty Casterart and no Target/Special art at all.) */
const FIELD_ART: Record<string, string> = {
  AHbz: "Abilities\\Spells\\Human\\Blizzard\\BlizzardTarget.mdx",
  ANrf: "Abilities\\Spells\\Demon\\RainOfFire\\RainOfFireTarget.mdx",
};

/**
 * Impale's other two models. `[AUim]` names ONE art — `Specialart =
 * ImpaleMissTarget.mdl`, the tendril that bursts out of empty ground — and the install
 * holds two more in the same folder that no ability row mentions at all:
 *
 *     Abilities\Spells\Undead\Impale\ImpaleCaster.mdx      the Crypt Lord's slam
 *     Abilities\Spells\Undead\Impale\ImpaleHitTarget.mdx   the tendril that catches a unit
 *
 * The pairing is the file names' own doing — "MissTarget" only means anything opposite a
 * "HitTarget" — and it is the same shape as FIELD_ART above: art the engine knows and the
 * table does not. (`ImpaleTargetDust.mdx` under Objects\Spawnmodels is the dust beneath a
 * hurled unit; we do not throw units, so it has nothing to sit under yet.)
 */
const IMPALE_CASTER_ART = "Abilities\\Spells\\Undead\\Impale\\ImpaleCaster.mdx";
const IMPALE_HIT_ART = "Abilities\\Spells\\Undead\\Impale\\ImpaleHitTarget.mdx";

/** When a shard's damage lands, measured off the models themselves: in BOTH
 *  BlizzardTarget.mdx and RainOfFireTarget.mdx (the same rig, reskinned) the falling
 *  helper `Dummy01` drops from z=+161 to the ground over 33→833ms, and the impact
 *  burst emitters (BlizParticle01x, Rain of Fire's Sphere1x debris) switch their
 *  visibility on at exactly 800ms. The rest of the 3.3s "Birth" clip is the ice/fire
 *  lingering on the ground. So a wave hurts you 0.8s after it appears in the sky —
 *  you can walk out from under a Blizzard you see coming. */
const SHARD_FALL = 0.8;

// Flame Strike models, straight from the 1.27 MPQ (War3x, Abilities\Spells\Human\
// FlameStrike\). The ability's Specialart lists FlameStrike1,FlameStrike2,FlameStrike
// but our data keeps only the first (FlameStrike1); WC3 erupts the PLAIN FlameStrike
// pillar, whose "birth" clip burns for ~7.2s — the lingering fire. FlameStrikeEmbers
// (a ~0.7s flame burst) is dropped in a ring to paint the burning circle at ignition.
const FLAMESTRIKE_PILLAR = "Abilities\\Spells\\Human\\FlameStrike\\FlameStrike.mdx";
const FLAMESTRIKE_EMBERS = "Abilities\\Spells\\Human\\FlameStrike\\FlameStrikeEmbers.mdx";

/** Effect duration on a target: heroes resist longer effects (herodur). */
function dur(lvl: AbilityLevel, target: SimUnit): number {
  // …and a RESISTANT unit takes the hero duration too — that is what Resistant Skin IS:
  // "effects last on resistant units as long as they would last on heroes" (Liquipedia).
  // Ensnare's 9 seconds become 3 on a Mountain Giant, a Tauren, an Avatar of Vengeance.
  return (target.isHero || target.resistant) && lvl.heroDuration > 0 ? lvl.heroDuration : lvl.duration;
}
/** Read dataX (a=0..i=8); NaN-safe default. */
function d(lvl: AbilityLevel, i: number, def = 0): number {
  const v = lvl.data[i];
  return v === undefined || Number.isNaN(v) ? def : v;
}

/** Blizzard and Rain of Fire are the SAME engine ability with different numbers:
 *  MPQ Units\AbilityMetaData.slk gives their Data columns one shared row
 *  (`useSpecific=ahbz,acbz,anrf,acrf`), so both read
 *    DataA "Number of Waves"  DataB "Damage"  DataC "Number of Shards"
 *    DataD "Building Reduction"  DataE "Damage Per Second"  DataF "Maximum Damage per Wave".
 *  Neither the Duration column nor any Data column holds the gap between waves —
 *  it's fixed in the engine at one second (Liquipedia "Blizzard": "Wave Duration:
 *  1 second"), so Blizzard's 6 waves fill its 6s channel and cooldown exactly. */
export const WAVE_FIELDS = new Set(["AHbz", "ANrf"]);
const WAVE_INTERVAL = 1; // seconds between waves — engine constant, in no data file

/** Wave schedule for a repeating area field, shared by the spell handler (which
 *  registers the field) and `channelDuration` (which locks the caster for exactly as
 *  long as the waves run) so the two can never drift apart. Rain of Fire's Duration
 *  column is its BURN duration (3s), not its channel — the channel is waves × 1s,
 *  which is why both spells must come through here rather than read `duration`. */
export function waveSchedule(lvl: AbilityLevel): { waves: number; interval: number } {
  return { waves: d(lvl, 0, 6), interval: WAVE_INTERVAL };
}

/** Blizzard / Rain of Fire: register the repeating wave field both of them are.
 *  Every number comes from the shared data row (see WAVE_FIELDS); `defaultDamage`
 *  only covers a custom ability that left DataB blank. */
function waveField(api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, ctx: CastContext, defaultDamage: number): void {
  const lvl = def.levelData[rank - 1];
  const { waves, interval } = waveSchedule(lvl);
  const dps = d(lvl, 4, 0); // DataE — Rain of Fire burns, Blizzard's is 0
  api.addSpellField({
    code: def.code,
    x: ctx.x,
    y: ctx.y,
    area: lvl.area || 200,
    damagePerWave: d(lvl, 1, defaultDamage),
    waves,
    interval,
    casterId: caster.id,
    art: fieldArt(def),
    loopSound: fieldLoop(def),
    artPerWave: Math.max(1, d(lvl, 2, 6)), // DataC "Number of Shards": 6/7/10 by rank
    waveSound: true,
    impactDelay: SHARD_FALL,
    buildingReduction: d(lvl, 3, 0), // DataD
    maxDamagePerWave: d(lvl, 5, 0), // DataF (0 = uncapped)
    dot: dps > 0 ? { dps, duration: lvl.duration || 3, heroDuration: lvl.heroDuration || lvl.duration || 3, group: def.code, art: def.buffArt, buffId: buffIdOf(def, rank) } : undefined,
  });
}

// --- targeting helpers (shared by the hero spell handlers) -----------------
//
// Every one of these takes the ability's own `def`, because WHAT a spell may strike is in
// its data (`targs1`) and nowhere else: `api.admits` is the single reader (World.targsAdmit),
// shared with single-target casts, spell fields and orbs. A handler states only the half the
// data does NOT carry — allegiance for the hardcoded enemies-only nukes, which name none.

/** Live enemies of `caster` within `radius` of a point, filtered by the ability's own
 *  Targets Allowed (so Fan of Knives' `air,ground,organic` spares a tower and War Stomp's
 *  `ground,organic` spares a Gargoyle), and never the caster. */
function enemiesInArea(api: SpellApi, caster: SimUnit, def: AbilityDef, x: number, y: number, radius: number): SimUnit[] {
  return api.unitsInArea(x, y, radius).filter((t) => t !== caster && api.hostile(caster, t) && api.admits(def, t) && !t.invulnerable);
}

/** Living allies of `caster` within `radius` of a point (optionally including the caster),
 *  filtered by the ability's Targets Allowed the same way. */
function alliesInArea(api: SpellApi, caster: SimUnit, def: AbilityDef, x: number, y: number, radius: number, opts: { self?: boolean } = {}): SimUnit[] {
  return api.unitsInArea(x, y, radius).filter((t) => (opts.self || t !== caster) && api.ally(caster, t) && api.admits(def, t));
}

/** Units struck by a line from the caster toward (tx,ty): within `length` forward
 *  and `halfWidth` to either side, and admissible to the ability. Powers the line
 *  nukes (Shockwave, Impale, Carrion Swarm, Breath of Fire). */
function lineTargets(api: SpellApi, caster: SimUnit, def: AbilityDef, tx: number, ty: number, length: number, halfWidth: number): SimUnit[] {
  const dx = tx - caster.x;
  const dy = ty - caster.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const out: SimUnit[] = [];
  // Query a circle covering the whole segment, then keep units near the axis.
  for (const t of api.unitsInArea(caster.x + ux * (length / 2), caster.y + uy * (length / 2), length / 2 + halfWidth + 64)) {
    if (t === caster || !api.admits(def, t)) continue;
    const rx = t.x - caster.x;
    const ry = t.y - caster.y;
    const forward = rx * ux + ry * uy;
    const perp = Math.abs(rx * uy - ry * ux);
    if (forward >= -t.radius && forward <= length + t.radius && perp <= halfWidth + t.radius) out.push(t);
  }
  return out;
}

/** Build a bounce chain of up to `count` targets, each the nearest unvisited valid
 *  unit within `jumpRange` of the previous (Chain Lightning, Healing Wave). */
function chainFrom(api: SpellApi, caster: SimUnit, def: AbilityDef, first: SimUnit, count: number, jumpRange: number, wantHostile: boolean): SimUnit[] {
  const chain = [first];
  const visited = new Set<number>([first.id]);
  let cur = first;
  while (chain.length < count) {
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const t of api.unitsInArea(cur.x, cur.y, jumpRange)) {
      if (visited.has(t.id) || t === caster || !api.admits(def, t)) continue;
      if (wantHostile ? !api.hostile(caster, t) || t.invulnerable : !api.ally(caster, t)) continue;
      const dd = Math.hypot(t.x - cur.x, t.y - cur.y);
      if (dd < bestD) {
        bestD = dd;
        best = t;
      }
    }
    if (!best) break;
    visited.add(best.id);
    chain.push(best);
    cur = best;
  }
  return chain;
}

/** The bolt ids an ability strings (issue #97): `[primary, secondary]` — the caster→first
 *  bolt and the target→target one. The profile lists them in that order
 *  (`LightningEffect=CLPB,CLSB`); an ability that names only one uses it for both. */
function bolts(def: AbilityDef): [string, string] {
  const primary = def.lightning[0] ?? "";
  return [primary, def.lightning[1] ?? primary];
}

/** The Drain's buff rows, by ROLE then by flavour (both, life, mana) — the order its
 *  `BuffID1` list is written in (`Bdcb,Bdcl,Bdcm,Bdtb,Bdtl,Bdtm,Bdbb,Bdbl,Bdbm`, 1.27a
 *  Units\AbilityData.slk). The `icon` trio carries no model at all: those rows exist only to
 *  put BTNLifeDrain / BTNManaDrain on the info card, which is why they are named apart from
 *  the two that do have art. See src/sim/spells.ts AHdr and docs/spell-fx.md. */
const DRAIN_BUFFS = {
  caster: ["Bdcb", "Bdcl", "Bdcm"],
  target: ["Bdtb", "Bdtl", "Bdtm"],
  icon: ["Bdbb", "Bdbl", "Bdbm"],
} as const;

/** The lightning tag a caster's drain tether carries, so an interrupted channel can cut it. */
export function drainTag(casterId: number): string {
  return `drain:${casterId}`;
}

/** The buff group every drain effect shares — the handle world.ts uses to strip a broken
 *  channel's damage-over-time, heal-over-time and buff art off both ends at once. */
export const DRAIN_GROUP = "drain";

/** Seconds between a chain's bounces. Chain Lightning and Healing Wave visibly WALK down
 *  their chain rather than lighting every link at once, but — unlike Finger of Death
 *  ("Graphic Delay") and Mana Burn ("Bolt Delay") — their ability rows name no interval, so
 *  the engine hardcodes one and so do we. Presentation only: the damage/heal is applied to
 *  the whole chain on cast, as it already was. */
const CHAIN_BOUNCE_DELAY = 0.15;

/** String a chain's lightning: the primary from the caster to the first link, a secondary
 *  between each pair after it, each one bounce later. */
function chainBolts(api: SpellApi, caster: SimUnit, def: AbilityDef, chain: SimUnit[]): void {
  const [primary, secondary] = bolts(def);
  let prev = caster;
  chain.forEach((u, i) => {
    api.emitLightning(i === 0 ? primary : secondary, prev, u, 0, i * CHAIN_BOUNCE_DELAY);
    prev = u;
  });
}

/** Summon `count` copies of a unit for the caster, fanned around a point (each
 *  request is placed on the nearest free tile by the renderer). */
function summonMany(api: SpellApi, caster: SimUnit, def: AbilityDef, unitId: string, x: number, y: number, count: number, durationSec: number, atPoint = false): void {
  if (!unitId) return;
  const art = summonArt(def);
  for (let i = 0; i < Math.max(1, count); i++) {
    const facing = caster.facing + (i - (count - 1) / 2) * 0.5;
    api.requestSummon(unitId, x, y, facing, caster.owner, caster.team, durationSec, caster.id, art, atPoint);
  }
}

/** The pair of effects a summoning ability gives its summons: the burst each unit
 *  materializes in, and the one that replaces it when it leaves.
 *
 *  Both come straight from the data, and neither is where you'd first look:
 *    [AOsf] Specialart = …\FeralSpirit\feralspirittarget.mdl   ← summon
 *    [BOsf] Effectart  = …\FeralSpirit\feralspiritdone.mdl     ← unsummon (on the BUFF)
 *  The Beastmaster's summons (ANsg/ANsq/ANsw) put their summon burst in `TargetArt`
 *  instead of `Specialart`, hence the fallback. Nothing here may default to Undead's
 *  `Unsummon\UnsummonTarget.mdl` — that is the acolyte's *Unsummon Building* art and has
 *  nothing to do with a summon expiring (it was hardcoded here, and looked very wrong on
 *  a wolf). A summon with no art in the data simply leaves without one. */
function summonArt(def: AbilityDef): { summon: string; unsummon: string } {
  return { summon: def.specialArt || def.targetArt, unsummon: def.buffEffectArt };
}

/** Summoned-unit ids for abilities whose unit isn't in the SLK `unitid` column
 *  (it lives in a data string we parse only as a number). Verified in the MPQ. */
const SUMMON_FALLBACK: Record<string, string> = {
  AUcb: "ucs1", // Carrion Beetles → Carrion Beetle (dataC string in the SLK)
  ANef: "npn1", // Storm, Earth & Fire → one of the split pandaren (npn1/2/3)
};

/** The spells whose legal targets are a POLARITY, not a flag list. `targs1` can say
 *  "organic, not self" but it has no way to say "a friendly living unit or an enemy
 *  Undead one" — so the engine hardcodes that rule and gives each of these its own
 *  error string in commandstrings.txt (Holybolttarget/Deathcoiltarget), which is how we
 *  know the rule is the ability's and not the data's. `healsUndead` says which side the
 *  Undead are on; the handlers below apply the same split to decide heal vs. damage.
 *  Verified in the 1.27 MPQ: AHhb targs1 = "air,ground,organic,notself,invu,vuln,
 *  nonancient" — no allegiance flag at all, so the flags alone would let a Paladin
 *  Holy Light an enemy Footman, which the real game refuses. */
export const POLARITY_SPELLS: Record<string, { healsUndead: boolean; error: string }> = {
  AHhb: { healsUndead: false, error: "Holybolttarget" }, // "Must target friendly living units or enemy Undead units."
  AUdc: { healsUndead: true, error: "Deathcoiltarget" }, // "Must target enemy living units or friendly Undead units."
};

/** Single-target heals that ALWAYS heal whatever they may legally touch. The polarity
 *  spells above heal too, but only their friendly half, so they're judged separately.
 *  A heal that would restore nothing is refused by WC3 rather than wasted (HPmaxed /
 *  UnitHPmaxed) — you cannot burn a Paladin's mana on an undamaged Footman. */
export const HEAL_SPELLS = new Set(["Ahea"]); // Priest — Heal

/** Spells that need the TARGET to have a mana pool, and the [Errors] line each says when
 *  it doesn't. Nothing in `targs1` can express this — Mana Burn's is
 *  `air,ground,enemy,organic,nonancient,vuln,invu`, which a Footman satisfies in full — so
 *  the rule is the ability's own, and the giveaway is that commandstrings.txt ships a line
 *  written for exactly one ability: `Cantmanaburn` = "Unable to cast Mana Burn on this
 *  target." (the general-purpose `Targetmanauser` sits right beside it for the rows that
 *  want the positive wording). A pool of zero is the test, not an empty one: a drained
 *  Sorceress is still a caster and burning her nothing is a legal, useless cast — a
 *  Footman has no mana bar at all and the Demon Hunter simply may not pick him. */
export const MANA_TARGET_SPELLS: Record<string, string> = {
  AEmb: "Cantmanaburn", // Demon Hunter — Mana Burn
};

export const SPELL_HANDLERS: Record<string, Handler> = {
  // Holy Light — heal a friendly living unit for dataA, or smite an enemy Undead
  // unit for dataA (the projectile/impact carries this on units with a missile;
  // Holy Light itself is instant). Half damage vs the living is not applicable —
  // it only harms the Undead.
  AHhb: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    if (api.ally(caster, t) && t.race !== "undead") api.spellHeal(t, d(lvl, 0));
    else if (api.hostile(caster, t) && t.race === "undead") api.spellDamage(t, d(lvl, 0), caster.id);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Death Coil — the inverse: heal a friendly Undead unit, or harm an enemy
  // living unit, for dataA.
  AUdc: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    if (api.ally(caster, t) && t.race === "undead") api.spellHeal(t, d(lvl, 0));
    else if (api.hostile(caster, t) && t.race !== "undead") api.spellDamage(t, d(lvl, 0), caster.id);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Storm Bolt — throw a hammer: dataA damage + stun for dur/herodur.
  AHtb: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.spellDamage(t, d(lvl, 0), caster.id);
    api.applyBuff(t, { kind: "stun", timeLeft: dur(lvl, t), sourceId: caster.id, ...fx(def) });
  },

  // Thunder Clap — slam the ground: dataA damage + slow (move dataC, attack dataD)
  // to enemy ground units within `area`.
  AHtc: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    // The shockwave also scorches the ground under the caster: UberSplatData row THND
    // ("ThunderClap", ReplaceableTextures\Splats\ThunderClapUbersplat.blp).
    api.emitSplat("THND", caster.x, caster.y);
    for (const t of api.unitsInArea(ctx.x, ctx.y, lvl.area)) {
      if (t === caster || !api.hostile(caster, t) || t.flying) continue;
      api.spellDamage(t, d(lvl, 0), caster.id);
      // fx(def) → the slow buff BHtc's own Targetart, StasisTotemTarget.mdx worn
      // `overhead` (the amber swirl — the same rig as the blue stun one).
      api.applyBuff(t, { kind: "slow", timeLeft: dur(lvl, t), sourceId: caster.id, value: d(lvl, 2, 0.25), value2: d(lvl, 3, 0.25), ...fx(def) });
    }
  },

  // Divine Shield — self-invulnerability for the duration.
  AHds: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.applyBuff(caster, { kind: "invuln", timeLeft: lvl.duration || lvl.heroDuration, sourceId: caster.id, ...fx(def) });
  },

  // Avatar (MK ultimate) — become a giant: +armour, +damage, immune to stun/slow
  // (approximated via the invuln flag being magic-immunity here). Big and brief.
  AHav: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const t = lvl.duration || lvl.heroDuration || 30;
    api.applyBuff(caster, { kind: "armor", group: "avatar", timeLeft: t, sourceId: caster.id, value: d(lvl, 0, 5) < 1 ? 15 : d(lvl, 0), ...fx(def) });
    api.applyBuff(caster, { kind: "damage", group: "avatar", timeLeft: t, sourceId: caster.id, value: 40 });
  },

  // Resurrection (Paladin ultimate) — raise up to dataA dead friendly units near
  // the caster back to life from their corpses.
  AHre: (api, caster, def, rank, ctx) => {
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    // Bare options: what comes back is the unit ITSELF, whole and permanent. And only YOUR
    // dead — `targs1 = air,ground,dead,friend`, which the shared claim now enforces (it did
    // not before, so a Paladin stood up whatever the enemy had lost nearby and kept it).
    raiseCorpses(api, caster, def, rank, ctx.x, ctx.y);
  },

  // Summon Water Elemental — spawn the summoned unit (unitid) beside the caster
  // for the duration; it expires (and dies) automatically.
  AHwe: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    if (!lvl.summon) return;
    api.requestSummon(lvl.summon, caster.x, caster.y, caster.facing, caster.owner, caster.team, lvl.heroDuration || lvl.duration || 60, caster.id, summonArt(def));
  },

  // Blizzard — channelled: DataA waves of DataB damage in `area`, a second apart
  // (registered as a repeating field; see tickSpellFields / waveSchedule).
  //
  // Blizzard ships no effect-art field in the data — use the known shard model.
  // (It ships no SOUND field either: MPQ HumanAbilityFunc.txt [AHbz] has an EMPTY
  // Casterart and no Target/Special art at all, and BlizzardTarget.mdx carries no
  // SND event objects. So neither of our sound paths — ability-art folder scan,
  // model SND events — could find anything, and Blizzard played silent. Its WAVs
  // sit unclaimed in the ability's own folder next to the shard model:
  // BlizzardTarget1/2/3.wav (the 3s shard fall, one per wave) and BlizzardLoop1.wav
  // (the 4s wind bed, looped for the channel — started by the renderer off
  // activeSpellFields). `waveSound` cues the former from the art's folder.
  AHbz: (api, caster, def, rank, ctx) => waveField(api, caster, def, rank, ctx, 30),

  // Rain of Fire (Pit Lord) — Blizzard's twin (same engine ability, same six data
  // columns), but each wave also leaves a burn: DataE damage per second for the
  // ability's Duration (MPQ NeutralAbilityStrings [ANrf]: "Each wave deals <DataB>
  // initial damage and <DataE> damage per second for <Dur> seconds. Lasts for <DataA>
  // waves."). Blizzard's DataE is 0, so the same code path leaves no burn there.
  ANrf: (api, caster, def, rank, ctx) => waveField(api, caster, def, rank, ctx, 25),

  // Heal (Priest) — restore dataA HP to a friendly living, non-mechanical unit.
  Ahea: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t) || t.mechanical) return;
    api.spellHeal(t, d(def.levelData[rank - 1], 0, 25));
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Inner Fire — buff a friendly unit: +armour (dataB) and +damage (dataA as a
  // fraction of base is complex; apply a flat bonus scaled by the caster's data).
  Ainf: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "armor", group: "innerfire", timeLeft: dur(lvl, t) || 30, sourceId: caster.id, value: d(lvl, 1, 5), ...fx(def) });
    api.applyBuff(t, { kind: "damage", group: "innerfire", timeLeft: dur(lvl, t) || 30, sourceId: caster.id, value: Math.max(1, Math.round((t.baseDamage || 10) * (d(lvl, 0, 0.1) || 0.1))) });
  },

  // Slow — cripple an enemy: slow its movement (dataA) and attack (dataB).
  Aslo: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "slow", group: "slow", timeLeft: dur(lvl, t) || 15, sourceId: caster.id, value: d(lvl, 0, 0.35), value2: d(lvl, 1, 0.35), ...fx(def) });
  },

  // Dispel Magic — clear timed buffs from every unit in the area; summoned units
  // additionally take dataB damage (which usually destroys them).
  Adis: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.targetArt) api.emitEffect(def.targetArt, ctx.x, ctx.y, 0);
    for (const t of api.unitsInArea(ctx.x, ctx.y, lvl.area)) {
      api.dispel(t);
      if (t.summonLeft > 0) api.spellDamage(t, d(lvl, 1, 200), caster.id);
    }
  },

  // Bloodlust (Shaman) — buff a friendly unit: +attack speed (dataA) and +move
  // speed (dataB). haste buff: value = move fraction, value2 = attack fraction.
  Ablo: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "haste", group: "bloodlust", timeLeft: dur(lvl, t) || 60, sourceId: caster.id, value: d(lvl, 1, 0.25), value2: d(lvl, 0, 0.4), ...fx(def) });
  },

  // Purge (Shaman) — strip ALL buffs from the target; an enemy is then slowed to a
  // crawl for dataD seconds (movement only), and a summoned unit is destroyed outright.
  Aprg: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.dispel(t); // remove every timed buff (good AND bad)
    if (api.hostile(caster, t)) {
      if (t.summonLeft > 0) { api.spellDamage(t, 100000, caster.id); return; } // Purge destroys summons
      // dataD = slow duration; heavy MOVE slow that recovers when it expires (no attack slow).
      api.applyBuff(t, { kind: "slow", group: "purge", timeLeft: d(lvl, 3, 3), sourceId: caster.id, value: 0.75, value2: 0, ...fx(def) });
    }
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Ensnare (Raider) — bind an enemy to the ground: it cannot move (root pins movement
  // to 1.0) for the duration (hero units get the shorter herodur). It can still attack.
  Aens: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "root", group: "ensnare", timeLeft: dur(lvl, t) || 12, sourceId: caster.id, value: 1, ...fx(def) });
  },

  // Lightning Shield (Shaman) — a shield of electricity around the TARGET: the target is
  // unharmed, but every unit around it takes dataA dps (area = radius). Cast it on an enemy
  // (hurts them + their neighbours) or an expendable own unit. See tickLightningShields.
  Alsh: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "shield", group: "lightningshield", timeLeft: dur(lvl, t) || 20, sourceId: caster.id, value: d(lvl, 0, 20), value2: lvl.area || 160, ...fx(def) });
  },

  // Spirit Link (Spirit Walker) — link up to dataB friendly organic units within the area
  // into a group; dataA of any hit taken by a member is spread across the whole group. Sets
  // the shared link state on each member (world.spiritLinkSplit does the distribution).
  Aspl: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const cap = Math.max(2, Math.round(d(lvl, 1, 4)));
    const share = d(lvl, 0, 0.5);
    const anchor = api.getUnit(ctx.targetId) ?? caster;
    const group = api
      .unitsInArea(anchor.x, anchor.y, lvl.area || 500)
      .filter((t) => api.ally(caster, t) && !t.building && !t.isSummon)
      .slice(0, cap);
    if (group.length < 2) return;
    const ids = group.map((u) => u.id);
    const linkTime = dur(lvl, group[0]) || 75;
    for (const u of group) {
      api.linkSpirits(u, ids, dur(lvl, u) || 75, share);
      if (def.targetArt) api.emitEffect(def.targetArt, u.x, u.y, u.id);
    }
    // The link made visible: an SPLK bolt from each member to the next, closing the ring, and
    // held for the whole link — the bolts follow the units as they walk, which is what tells
    // the player at a glance which four are sharing the damage.
    const links = group.length > 2 ? group.length : 1; // a pair needs one bolt, not two on top of each other
    for (let i = 0; i < links; i++) {
      api.emitLightning(bolts(def)[0], group[i], group[(i + 1) % group.length], linkTime);
    }
  },

  // Ancestral Spirit (Spirit Walker) — raise ONE fallen non-hero Tauren from its corpse at
  // the point, back at full strength (dataA = HP fraction restored ≈ 1). Shape B with a max
  // of one, and its `targs1 = ground,player,dead` is the tightest allegiance in the family:
  // `player` means the caster's OWN dead, not an ally's.
  Aast: (api, caster, def, _rank, ctx) => {
    api.raiseClaimed(api.claimCorpses(caster, def, ctx.x, ctx.y, 250, 1, "nearest"), caster.owner, caster.team);
    if (def.targetArt) api.emitEffect(def.targetArt, ctx.x, ctx.y, 0);
  },

  // Corporeal/Ethereal Form (Spirit Walker) — a self toggle between its two forms (both carry
  // this one ability). morphUnit swaps the type (weapons + abilities), and the ethereal form
  // (no weapon) becomes immune to physical / unable to attack / +magic damage.
  Acpf: (api, caster) => api.toggleSpiritForm(caster),

  // === Creep & neutral casters ===
  //
  // Every Data index below is named by the game itself: AbilityMetaData.slk's `useSpecific`
  // rows point at WorldEditStrings.txt, which spells out what each column of each of these
  // abilities means ("WESTRING_AEVAL_CRI1 = Movement Speed Reduction (%)"). Nothing here is
  // inferred from watching the ability — see docs and the ability-data-column-names memory.

  // Roar — the caster bellows and every FRIENDLY unit within `area` hits harder for the
  // duration. dataA "Damage Increase (%)", dataB "Defense Increase", dataC "Life
  // Regeneration Rate". The stock Roar carries only dataA (0.25), so the armour and regen
  // halves are applied only when a row actually sets them — a custom map may.
  Aroa: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    for (const t of alliesInArea(api, caster, def, caster.x, caster.y, lvl.area || 500, { self: true })) {
      const time = dur(lvl, t) || 45;
      api.applyBuff(t, { kind: "damagePct", group: "roar", timeLeft: time, sourceId: caster.id, value: d(lvl, 0, 0.25), ...fx(def) });
      const armor = d(lvl, 1, 0);
      if (armor) api.applyBuff(t, { kind: "armor", group: "roar", timeLeft: time, sourceId: caster.id, value: armor });
      const regen = d(lvl, 2, 0);
      if (regen) api.applyBuff(t, { kind: "hpRegen", group: "roar", timeLeft: time, sourceId: caster.id, value: regen });
    }
  },

  // Fire Bolt — the creeps' Storm Bolt: a missile that deals dataA "Damage" and stuns for
  // the row's duration. Same shape as AHtb, and like it the missile is the caller's
  // business (world.ts spawns it off def.missileArt) — the handler is the impact.
  ANfb: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.spellDamage(t, d(lvl, 0, 100), caster.id);
    api.applyBuff(t, { kind: "stun", group: "firebolt", timeLeft: dur(lvl, t) || 2, sourceId: caster.id, ...fx(def) });
  },

  // Finger of Death — one enormous hit, no stun and no duration. dataC is the "Damage"
  // (500); dataA and dataB are "Graphic Delay" and "Graphic Duration", i.e. presentation,
  // which is why the damage is NOT read from dataA the way most nukes are.
  ANfd: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.spellDamage(t, d(lvl, 2, 500), caster.id);
    // …and dataA/dataB, the presentation pair, are exactly the AFOD bolt's timing: it
    // strikes 0.25s after the cast and burns for 1s.
    api.emitLightning(bolts(def)[0], caster, t, d(lvl, 1, 1), d(lvl, 0, 0.25));
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Heal (creep) — the neutral casters' version of the Priest's Heal, dataA "Hit Points
  // Gained". Shares Ahea's rules: allies only, and never a mechanical unit.
  Anhe: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t) || t.mechanical) return;
    api.spellHeal(t, d(def.levelData[rank - 1], 0, 15));
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Rejuvenation — dataA "Hit Points Gained" and dataB "Mana Points Gained", both restored
  // ACROSS the duration rather than at once (the Druid of the Claw's 400 over 12s). Same
  // total-over-duration shape as the regeneration items, and the mana half is likewise a
  // timed manaRegen bonus.
  Arej: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    const time = dur(lvl, t) || 12;
    const hp = d(lvl, 0, 400);
    const mana = d(lvl, 1, 0);
    if (hp > 0) api.applyBuff(t, { kind: "hot", group: "rejuv", timeLeft: time, sourceId: caster.id, value: hp / time, ...fx(def) });
    if (mana > 0) api.applyBuff(t, { kind: "manaRegen", group: "rejuv", timeLeft: time, sourceId: caster.id, value: mana / time });
  },

  // Cripple — dataA "Movement Speed Reduction (%)", dataB "Attack Speed Reduction (%)",
  // dataC "Damage Reduction". The third is what separates it from a plain Slow: the target
  // also hits for less, so it rides a NEGATIVE damagePct buff.
  Acri: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    const time = dur(lvl, t) || 60;
    api.applyBuff(t, { kind: "slow", group: "cripple", timeLeft: time, sourceId: caster.id, value: d(lvl, 0, 0.75), value2: d(lvl, 1, 0.5), ...fx(def) });
    const cut = d(lvl, 2, 0.5);
    if (cut) api.applyBuff(t, { kind: "damagePct", group: "cripple", timeLeft: time, sourceId: caster.id, value: -cut });
  },

  // Faerie Fire — dataA "Defense Reduction" (4), as a negative armour buff. (Its other
  // column, dataB, is "Always Autocast" — a flag about the button, not an effect.)
  Afae: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "armor", group: "faeriefire", timeLeft: dur(lvl, t) || 90, sourceId: caster.id, value: -d(lvl, 0, 4), ...fx(def) });
  },

  // Unholy Frenzy — dataA "Attack Speed Bonus (%)" and dataB "Damage per Second", the
  // bargain the spell IS: the target swings faster and bleeds for it. Cast on allies in
  // WC3 (a Necromancer frenzies his own front line), so allegiance is not restricted here.
  Auhf: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const time = dur(lvl, t) || 45;
    api.applyBuff(t, { kind: "haste", group: "unholyfrenzy", timeLeft: time, sourceId: caster.id, value: 0, value2: d(lvl, 0, 0.75), ...fx(def) });
    api.applyBuff(t, { kind: "dot", group: "unholyfrenzy", timeLeft: time, sourceId: caster.id, value: d(lvl, 1, 4) });
  },

  // Abolish Magic (Dryad) — Dispel Magic aimed at ONE unit instead of an area: strip its
  // timed buffs, and a summon takes dataB "Summoned Unit Damage" (300), which is enough to
  // end most of them. dataA is "Mana Loss", 0 on every stock row but honoured if a map sets
  // it. Its allegiance is deliberately unrestricted — the same cast cleanses a poisoned
  // ally and strips an enemy's Bloodlust, which is exactly why `targs1` names neither
  // `friend` nor `enemy`.
  // Cannibalize (Ghoul) — eat a nearby corpse and regenerate off it. dataA is "Hit Points
  // per Second" (10) across the row's duration (33s), so a body is worth 330 hit points if
  // the meal is not interrupted.
  //
  // dataB is "Max Hit Points" (800) and is deliberately unused: at the stock rate and
  // duration the total is 330, so the cap cannot bind, and inventing a meaning for a number
  // that never takes effect would be guessing. A custom map that raises the rate would need
  // it, and that is the point at which to work out what it actually caps.
  //
  // No corpse, no ability — the cast simply does nothing rather than granting the buff,
  // which is why this reads the corpse first.
  Acan: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const reach = lvl.castRange || 50;
    // `needsType = false`: a meal does not care what died, only that something did. Every
    // other consumer rebuilds the unit and so needs its type.
    if (!api.claimCorpses(caster, def, ctx.x || caster.x, ctx.y || caster.y, reach, 1, "nearest", false).length) return;
    api.applyBuff(caster, {
      kind: "hot", group: "cannibalize", timeLeft: dur(lvl, caster) || 33,
      sourceId: caster.id, value: d(lvl, 0, 10), ...fx(def),
    });
  },

  Aadm: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.dispel(t);
    if (t.summonLeft > 0) api.spellDamage(t, d(lvl, 1, 300), caster.id);
    const manaLoss = d(lvl, 0, 0);
    if (manaLoss > 0) t.mana = Math.max(0, t.mana - manaLoss);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Kaboom! (Goblin Sapper) — he walks up to the target and detonates himself. The blast is
  // two concentric rings, and the columns say so: dataA "Full Damage Radius" (100) and dataB
  // "Full Damage Amount" (250), then dataC "Partial Damage Radius" (250) and dataD "Partial
  // Damage Amount" (100). Those four are shared with the other death-blast abilities
  // (AbilityMetaData rows Dda1..Dda4, useSpecific = Adda,Amnx,Amnz,Asds,Auco).
  //
  // Everything in range is hit, friend and foe alike: `targs1` is `ground,structure,debris,
  // tree,ward` with no allegiance flag at all, and a sapper pack really does kill its own
  // escort if it detonates among them.
  //
  // NOT applied: the extra damage a sapper is famous for doing to BUILDINGS. dataE is
  // "Building Damage Factor" (AbilityMetaData Sds1, data=5) and its value is 100, while
  // Liquipedia states the ability does "3 times as much damage against buildings". 100 is
  // neither 3 nor a percentage that yields 3, so the two sources do not reconcile and
  // neither reading can be called verified. Rather than invent a multiplier, the blast lands
  // as written and this is left for a measurement against the real client (see the
  // wc3-ground-truth memory) — the one source that can settle it.
  Asds: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const t = api.getUnit(ctx.targetId);
    const cx = t ? t.x : ctx.x;
    const cy = t ? t.y : ctx.y;
    const fullR = d(lvl, 0, 100);
    const full = d(lvl, 1, 250);
    const partR = d(lvl, 2, 250);
    const part = d(lvl, 3, 100);
    for (const e of api.unitsInArea(cx, cy, Math.max(fullR, partR))) {
      if (e === caster) continue; // he dies below, not to his own blast
      const amount = Math.hypot(e.x - cx, e.y - cy) <= fullR ? full : part;
      if (amount > 0) api.spellDamage(e, amount, caster.id);
    }
    if (def.specialArt) api.emitEffect(def.specialArt, cx, cy, 0);
    else if (def.targetArt) api.emitEffect(def.targetArt, cx, cy, 0);
    api.killUnit(caster);
  },

  // Devour (Kodo Beast) — swallow an enemy land non-hero unit whole; it's digested inside
  // (tickDevour) and freed if the Kodo is slain first.
  Adev: (api, caster, def, _rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t) || t.building || t.isHero) return;
    api.devour(caster, t);
    if (def.targetArt) api.emitEffect(def.targetArt, caster.x, caster.y, caster.id);
  },

  // Unstable Concoction (Batrider) — the rider blows himself up: dataB damage to the target
  // air unit and dataD to other enemy air units within dataC, then the caster dies.
  Auco: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const t = api.getUnit(ctx.targetId);
    const cx = t ? t.x : ctx.x;
    const cy = t ? t.y : ctx.y;
    if (t && api.hostile(caster, t)) api.spellDamage(t, d(lvl, 1, 600), caster.id); // dataB — direct hit
    const splash = d(lvl, 3, 140); // dataD — nearby air
    const radius = d(lvl, 2, 200) || 200; // dataC — blast radius
    for (const e of api.unitsInArea(cx, cy, radius)) {
      if (e === t || e === caster || !e.flying || !api.hostile(caster, e)) continue;
      api.spellDamage(e, splash, caster.id);
    }
    if (def.specialArt) api.emitEffect(def.specialArt, cx, cy, 0);
    api.killUnit(caster); // the Batrider explodes
  },

  // Witch Doctor wards — each summons an immobile ward at the point (unitid1). Sentry
  // gives vision for free (an owned unit reveals fog); the Healing Ward's heal and the
  // Stasis Trap's proximity stun run in world.tickWards, keyed off the ward's own data.
  Aeye: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  Ahwd: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  Asta: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),

  // Berserk (Troll Berserker) — self only: attack dataB% faster (haste) but take dataC%
  // more damage (vuln) for the duration. dataA rides the haste's move-speed slot.
  Absk: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const t = dur(lvl, caster) || 12;
    api.applyBuff(caster, { kind: "haste", group: "berserk", timeLeft: t, sourceId: caster.id, value: d(lvl, 0, 0), value2: d(lvl, 1, 0.5), ...fx(def) });
    api.applyBuff(caster, { kind: "vuln", group: "berserk", timeLeft: t, sourceId: caster.id, value: d(lvl, 2, 0.5) });
  },

  // ======================================================================
  //  Melee hero abilities (dispatched on base code — see data/abilities.ts).
  //  Numbers read from the MPQ AbilityData.slk data columns (verified 2026-07).
  // ======================================================================

  // --- line / cone / area nukes ---

  // Shockwave (Tauren) — dataA damage to every enemy along an 800-long, 125-wide
  // line toward the target point (dataC = distance, area = width).
  //
  // THE MISSILE IS THE SPELL. `[AOsh] Missileart = ShockwaveMissile.mdl, Missilespeed =
  // 1050` — Shock Wave has no Targetart, no Areaeffectart and no Casterart, so that
  // travelling model is the whole of its art, and because it travels, it is also the
  // TIMING: a unit 800 out is struck three quarters of a second after the cast, not at
  // once. Hence launchWave rather than a sweep (see SpellApi.launchWave); the handler is
  // re-entered per unit as the front reaches it. The wave family is AOsh/AUcs/ANbf; Impale
  // and Forked Lightning name no missile and stay instant.
  AOsh: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const hit = (t: SimUnit) => {
      if (api.hostile(caster, t)) api.spellDamage(t, d(lvl, 0, 75), caster.id);
    };
    const swept = api.getUnit(ctx.targetId);
    if (swept) return hit(swept); // the wave has just reached this one
    const dist = d(lvl, 2, 800);
    const half = lvl.area || 125;
    // dataB is the family's total-damage cap — `UI\WorldEditStrings.txt` calls `Osh2`
    // "Maximum Damage" (900 at rank 1, i.e. twelve units' worth), and `Ucs2` "Max Damage".
    if (api.launchWave(caster, def, rank, { tx: ctx.x, ty: ctx.y, dist, halfWidth: half, budget: d(lvl, 1, 0) })) return;
    for (const t of lineTargets(api, caster, def, ctx.x, ctx.y, dist, half)) hit(t); // artless fallback
  },

  // Carrion Swarm (Dreadlord) — line nuke (dataC distance, area width), dataA per
  // unit up to a dataB total-damage cap. Travels as its own missile, like Shock Wave
  // (`[AUcs] Missileart = CarrionSwarmMissile.mdl, Missilespeed = 1100`), and each unit
  // the swarm reaches wears the Specialart (`CarrionSwarmDamage.mdl`) as it is bitten.
  AUcs: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const budget = ctx.wave ?? { budget: d(lvl, 1, 300) };
    const hit = (t: SimUnit) => {
      if (!api.hostile(caster, t) || budget.budget <= 0) return;
      const dmg = Math.min(d(lvl, 0, 75), budget.budget);
      api.spellDamage(t, dmg, caster.id);
      budget.budget -= dmg;
      if (def.specialArt) api.emitEffect(def.specialArt, t.x, t.y, t.id);
    };
    const swept = api.getUnit(ctx.targetId);
    if (swept) return hit(swept);
    const dist = d(lvl, 2, 700);
    const half = lvl.area || 100;
    if (api.launchWave(caster, def, rank, { tx: ctx.x, ty: ctx.y, dist, halfWidth: half, budget: budget.budget })) return;
    for (const t of lineTargets(api, caster, def, ctx.x, ctx.y, dist, half)) hit(t);
  },

  // Impale (Crypt Lord) — "shooting spiked tendrils out in a straight line, dealing
  // <AUim,DataC1> damage and hurling enemy ground units into the air in their wake"
  // (`UndeadAbilityStrings [AUim]`). A wave like its Osh/Ucs cousins, and the game names
  // its columns in `UI\WorldEditStrings.txt`: `Uim1` **Wave Distance** (600), `Uim2`
  // **Wave Time (seconds)** (0.3 — so the tendrils cross the line at 2000 units a second),
  // `Uim3` **Damage Dealt** (75/120/165) and `Uim4` **Air Time (seconds)** (1).
  //
  // Its art is the ONE case in the family that is not a missile: `[AUim]` names no
  // `Missileart` at all, only `Specialart = ImpaleMissTarget.mdl` — a single tendril. The
  // spell is a ROW of them bursting out of the ground as the wave passes, so it launches
  // with a `trail` instead: one tendril every half-width, which lays them shoulder to
  // shoulder down a line whose width is `Area1`.
  AUim: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const hit = (t: SimUnit) => {
      if (!api.hostile(caster, t) || t.flying) return;
      api.spellDamage(t, d(lvl, 2, 75), caster.id);
      api.applyBuff(t, { kind: "stun", timeLeft: dur(lvl, t) || 1, sourceId: caster.id, ...fx(def) });
      api.emitEffect(IMPALE_HIT_ART, t.x, t.y, t.id); // the tendril that CAUGHT something
    };
    const swept = api.getUnit(ctx.targetId);
    if (swept) return hit(swept);
    const dist = d(lvl, 0, 600);
    const half = (lvl.area || 250) / 2;
    const time = d(lvl, 1, 0.3);
    api.emitEffect(IMPALE_CASTER_ART, caster.x, caster.y, caster.id); // the Crypt Lord's slam
    if (api.launchWave(caster, def, rank, {
      tx: ctx.x, ty: ctx.y, dist, halfWidth: half,
      speed: time > 0 ? dist / time : 2000, // "Wave Time" is the whole run, not a speed
      trail: def.specialArt ? { art: def.specialArt, step: half } : undefined,
    })) return;
    for (const t of lineTargets(api, caster, def, ctx.x, ctx.y, dist, half)) hit(t);
  },

  // Breath of Fire (Brewmaster) — cone/line of flame: dataA damage (dataC distance,
  // area width) to enemies in front of the caster.
  ANbf: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const hit = (t: SimUnit) => {
      if (api.hostile(caster, t)) api.spellDamage(t, d(lvl, 0, 65), caster.id);
    };
    const swept = api.getUnit(ctx.targetId);
    if (swept) return hit(swept);
    const dist = d(lvl, 2, 375);
    const half = lvl.area || 125;
    // `[ANbf] Missileart = BreathOfFireMissile.mdl, Missilespeed = 1050` — the breath, again.
    if (api.launchWave(caster, def, rank, { tx: ctx.x, ty: ctx.y, dist, halfWidth: half, budget: d(lvl, 1, 0) })) return;
    for (const t of lineTargets(api, caster, def, ctx.x, ctx.y, dist, half)) hit(t);
  },

  // Forked Lightning (Naga) — cast ON AN ENEMY UNIT; the cone of bolts fans out from the
  // Sea Witch through it, hitting up to dataB units for dataA damage each.
  //
  // The game says the aim in its own words: `NeutralAbilityStrings [ANfl]` Ubertip level 1
  // is "Calls forth a cone of lightning ON A TARGET ENEMY UNIT, hitting up to <ANfl,DataB1>
  // enemy units for <ANfl,DataA1> damage." It reads as a point spell in the tables — it has
  // a cast Range AND an Area, and it shares Carrion Swarm's `Ucs3`/`Ucs4` (distance, final
  // width) meta fields — which is exactly the trap: `Rng1`/`Area1` cannot tell a point spell
  // from a unit-target one, and only the tooltip can (see the recipe in audit-abilities.mjs).
  ANfl: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    // The cone is the family's line (dataC long, `area` to either side — the widening to
    // dataD is not modelled for any of AUcs/ANbf/AOsh either), aimed THROUGH the target.
    // The target itself is hit whether or not the geometry catches it: it is what was aimed
    // at, and the rest of the fan is who else stands in the way.
    const swept = lineTargets(api, caster, def, t.x, t.y, d(lvl, 2, 900), lvl.area || 125);
    const targets = [t, ...swept.filter((o) => o !== t)].filter((o) => api.hostile(caster, o));
    // Forked: every target gets its OWN bolt from the caster, all at once — that fan of
    // bolts is the whole look of the spell.
    for (const o of targets.slice(0, d(lvl, 1, 3))) {
      api.spellDamage(o, d(lvl, 0, 85), caster.id);
      api.emitLightning(bolts(def)[0], caster, o);
    }
  },

  // Fan of Knives (Warden) — PBAoE: `Efk1 "Damage Per Target"` to every enemy within `area`,
  // capped in total by `Efk2 "Maximum Total Damage"` (300/625/950 — the AoE cap that stops it
  // scaling forever with the size of the clump).
  //
  // Its art is the reason this looked like nothing happened: `[AEfk] Casterart=` is EMPTY and
  // the models sit on the two fields beside it —
  //     Effectart  = …\NightElf\FanOfKnives\FanOfKnivesCaster.mdl   the burst at the Warden
  //     Missileart = …\NightElf\FanOfKnives\FanOfKnivesMissile.mdl  the blades that fan out
  // — so reaching for `casterArt` drew neither. The blades are not real projectiles (the
  // damage is instant and uncapped by travel), so each one is dropped as a one-shot on the
  // unit it is meant for, which is where WC3's land too.
  //
  // The BURST is not emitted here: it is the Warden's own spin-up, so it plays at the start
  // of the wind-up with the gesture (world.ts CAST_START_ART), a Cast Point ahead of the
  // blades it throws. Only the blades belong to this instant.
  AEfk: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const hit = enemiesInArea(api, caster, def, caster.x, caster.y, lvl.area || 400);
    const per = d(lvl, 0, 75);
    const cap = d(lvl, 1, 0);
    const each = cap > 0 && hit.length * per > cap ? cap / hit.length : per;
    for (const t of hit) {
      api.spellDamage(t, each, caster.id);
      if (def.missileArt) api.emitEffect(def.missileArt, t.x, t.y, t.id, 0.6);
    }
  },

  // War Stomp (Tauren) — slam: dataA damage + a stun (dur/herodur) to ground
  // enemies within `area`.
  AOws: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    for (const t of enemiesInArea(api, caster, def, caster.x, caster.y, lvl.area || 250)) {
      if (t.flying) continue;
      api.spellDamage(t, d(lvl, 0, 25), caster.id);
      // fx(def) → the shared stun buff BPSE's Targetart (ThunderclapTarget.mdx, `overhead`) —
      // the swirl every stunned unit wears. Without it War Stomp stunned in silence.
      api.applyBuff(t, { kind: "stun", timeLeft: dur(lvl, t) || 2, sourceId: caster.id, ...fx(def) });
    }
  },

  // Frost Nova (Lich) — the missile impacts one unit; dataB to the primary target,
  // dataA to others within `area`, and a movement/attack slow to all of them.
  AUfn: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    // The nova ring is `[AUfn] Effectart = …\Undead\FrostNova\FrostNovaTarget.mdl`. The row
    // has no TargetArt at all, so the old reach for `targetArt` drew nothing — and took the
    // cast sound with it, because the WAV (FrostNovaTarget1.wav) is resolved off the model.
    if (def.effectArt) api.emitEffect(def.effectArt, t.x, t.y, 0);
    api.spellDamage(t, d(lvl, 1, 100), caster.id);
    for (const o of enemiesInArea(api, caster, def, t.x, t.y, lvl.area || 200)) {
      if (o !== t) api.spellDamage(o, d(lvl, 0, 50), caster.id);
      // …and the frozen unit wears `Bfro`'s own art (FrostDamage.mdl) for as long as it is
      // slowed — the shared "Frozen" buff Frost Armor and the Frost Attacks also apply.
      api.applyBuff(o, { kind: "slow", group: "frostnova", timeLeft: dur(lvl, o) || 4, sourceId: caster.id, value: 0.4, value2: 0.4, ...fx(def) });
    }
  },

  // Chain Lightning (Far Seer) — bounces to dataB targets, losing dataC of the
  // damage each jump (area = jump range, dataA = base damage).
  AOcl: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const chain = chainFrom(api, caster, def, t, d(lvl, 1, 4), lvl.area || 500, true);
    const falloff = d(lvl, 2, 0.15);
    // The bolt IS the spell's art (CLPB caster→first, CLSB between the rest) — Chain
    // Lightning ships no TargetArt at all, which is why it used to land in silence.
    chainBolts(api, caster, def, chain);
    chain.forEach((u, i) => {
      api.spellDamage(u, d(lvl, 0, 85) * Math.pow(1 - falloff, i), caster.id);
      if (def.targetArt) api.emitEffect(def.targetArt, u.x, u.y, u.id);
    });
  },

  // --- heals ---

  // Healing Wave (Shadow Hunter) — heals the target for dataA, then bounces to
  // dataB allies, losing dataC of the healing each jump.
  AOhw: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const chain = chainFrom(api, caster, def, t, d(lvl, 1, 3), lvl.area || 500, false);
    const falloff = d(lvl, 2, 0.25);
    chainBolts(api, caster, def, chain); // HWPB then HWSB — the healing arc between allies
    chain.forEach((u, i) => {
      if (!u.mechanical) api.spellHeal(u, d(lvl, 0, 130) * Math.pow(1 - falloff, i));
      if (def.targetArt) api.emitEffect(def.targetArt, u.x, u.y, u.id);
    });
  },

  // Tranquility (Keeper, ult) — rain of healing energy over everything friendly around the
  // KEEPER. It takes no target at all: `Rng1` is "-" in the SLK (see KNOWN_ABILITIES), so
  // pressing the button IS the cast and the circle is centred on the caster, not on a spot
  // the player picks. Columns Etq1..Etq4:
  //   DataA "Life Healed"                40    per interval
  //   DataB "Heal Interval"              1
  //   DataD "Initial Immunity Duration"  3     the tooltip names it; nothing else reads it
  //
  // Both models come from outside the ability row, which is why it used to rain nothing:
  //   [XEtq] Effectart = …\NightElf\Tranquility\Tranquility.mdl  (EfctID1 — the downpour)
  //          Effectsoundlooped = TranquilityLoop
  //   [AEtr] Targetart = …\Tranquility\TranquilityTarget.mdl      (BuffID1 — worn by each
  //          healed unit; note the buff id is an ABILITY row, see the buff index)
  AEtq: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const total = lvl.heroDuration || lvl.duration || 30;
    const area = lvl.area || 900;
    const interval = d(lvl, 1, 1) || 1;
    // The downpour is ONE model over the whole circle (see fieldOnce); the field beside it
    // deals nothing and exists only to hold the loop for exactly as long as the channel runs
    // and to be torn down with it on an interrupt.
    fieldOnce(api, def, caster.x, caster.y, total);
    api.addSpellField({
      code: def.code, x: caster.x, y: caster.y, area,
      damagePerWave: 0, waves: Math.max(1, Math.round(total / interval)), interval,
      casterId: caster.id, art: "", loopSound: fieldLoop(def),
    });
    for (const t of alliesInArea(api, caster, def, caster.x, caster.y, area, { self: true })) {
      if (!t.mechanical) api.applyBuff(t, { kind: "hot", group: "tranquility", timeLeft: total, sourceId: caster.id, value: d(lvl, 0, 40) / interval, ...fx(def) });
    }
  },

  // Healing Spray (Alchemist) — the Alchemist lobs potion bottles into the area, wave after
  // wave. It shares Cluster Rockets' Data row (AbilityMetaData `Ncs1..Ncs5`,
  // useSpecific=ANhs,ANcs) with one column of its own (`Nhs6`):
  //   DataA "Damage Amount"    30/45/60   ← HEALING here: `targs1` is friend,self,…
  //   DataB "Damage Interval"  1
  //   DataC "Missile Count"    6          bottles per wave
  //   DataD "Max Damage"       280/385/490  the cap over the whole spray
  //   DataF "Wave Count"       3/4/5
  // So it is a heal-over-time, not the single 40-hp splash this used to be.
  //
  // The bottle is `Missileart = …\Other\HealingSpray\HealBottleMissile.mdl` and the burst
  // on each healed unit is on the EFFECT OBJECT (`[XNhs] Specialart = …\Human\Heal\
  // HealTarget.mdl`) — the ability row has no Casterart, Targetart or Areaeffectart at all.
  ANhs: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const interval = d(lvl, 1, 1) || 1;
    const waves = Math.max(1, d(lvl, 5, 3));
    const cap = d(lvl, 3, 0);
    const total = Math.min(cap > 0 ? cap : Infinity, d(lvl, 0, 30) * waves);
    const time = waves * interval;
    const area = lvl.area || 250;
    // The bottles raining in, as a damage-less field so they arrive wave by wave.
    api.addSpellField({
      code: def.code, x: ctx.x, y: ctx.y, area, damagePerWave: 0,
      waves, interval, casterId: caster.id,
      art: def.missileArt, artPerWave: Math.max(1, d(lvl, 2, 6)), scatter: area * 0.7, waveSound: true,
    });
    for (const t of alliesInArea(api, caster, def, ctx.x, ctx.y, area, { self: true })) {
      if (t.mechanical) continue;
      api.applyBuff(t, { kind: "hot", group: "healingspray", timeLeft: time, sourceId: caster.id, value: total / time, ...fx(def) });
      if (def.fxSpecialArt) api.emitEffect(def.fxSpecialArt, t.x, t.y, t.id);
    }
  },

  // --- disables / debuffs ---

  // Entangling Roots (Keeper) — root a target in place (can still attack) and
  // deal dataA damage per second for the duration.
  AEer: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || t.flying) return;
    const lvl = def.levelData[rank - 1];
    const d0 = dur(lvl, t) || 9;
    api.applyBuff(t, { kind: "root", group: "roots", timeLeft: d0, sourceId: caster.id, value: 1, ...fx(def) });
    api.applyBuff(t, { kind: "dot", group: "roots", timeLeft: d0, sourceId: caster.id, value: d(lvl, 0, 15) });
  },

  // Sleep (Dreadlord) — put a target to sleep (disabled until it takes damage).
  AUsl: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || t.building) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "sleep", group: "sleep", timeLeft: dur(lvl, t) || 5, sourceId: caster.id, ...fx(def) });
  },

  // Hex (Shadow Hunter) — transform a target into a critter: disabled (can't
  // attack or cast) for the duration; modelled as a stun.
  AOhx: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "stun", group: "hex", timeLeft: dur(lvl, t) || 4, sourceId: caster.id, ...fx(def) });
  },

  // Banish (Blood Mage) — turn a target ETHEREAL for the duration (issue #49). While
  // ethereal the unit can't attack and takes NO physical damage, but takes +66% from
  // Magic/Spells (EtherealDamageBonus) — so Banish pulls a unit out of the melee and
  // hands it to your casters. It also slows movement by DataA ("Movement Speed
  // Reduction (%)"; DataB is the now-moot attack-speed cut). The banished unit wears
  // the ethereal BanishTarget glow the whole time — that model is the buff's own
  // TargetArt (def.buffArt), not the ability's (which is empty), so the renderer keeps
  // it attached while the buff lasts.
  AHbn: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "ethereal", group: "banish", timeLeft: dur(lvl, t) || 12, sourceId: caster.id, value: d(lvl, 0, 0.5), ...fx(def) });
  },

  // Doom (Pit Lord, ult) — the curse is only half of it. `Ndo1..Ndo3` + `UnitID1`:
  //   DataA "Damage Per Second"            40
  //   DataB "Number of Summoned Units"     1
  //   DataC "Summoned Unit Duration (s)"   120
  //   UnitID1                              nba2 — a DOOM GUARD
  // "…until the unit dies, at which point a Doom Guard is summoned in its place" — and it
  // is UNDISPELLABLE, which is the reason the row lists no duration column at all: Doom
  // runs until it kills. So the curse goes on with no clock and the death half rides the
  // mark, exactly as Black Arrow's minion does (both are raised in world.ts orbDeathEffects).
  //
  // Its two buffs split the same way: `[BNdo] Targetart = …\Other\Doom\DoomTarget.mdl` is
  // the fire the doomed unit wears, `[BNdi] Effectart = …\Doom\DoomDeath.mdl` is what plays
  // when it goes.
  ANdo: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "dot", group: "doom", timeLeft: Infinity, sourceId: caster.id, value: d(lvl, 0, 40), undispellable: true, ...fx(def) });
    api.markDoom(t, caster, def, rank);
  },

  // Soul Burn (Firelord) — a damage-over-time burn that also silences the target.
  ANso: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const d0 = dur(lvl, t) || 6;
    api.applyBuff(t, { kind: "dot", group: "soulburn", timeLeft: d0, sourceId: caster.id, value: d(lvl, 0, 7), ...fx(def) });
    api.applyBuff(t, { kind: "silence", group: "soulburn", timeLeft: d0, sourceId: caster.id });
  },

  // Acid Bomb (Alchemist) — "Hurls a flask of acid at a target. The flask breaks upon
  // impact, splashing a powerful acid on nearby hostile units" (Ubertip): a UNIT-target
  // throw whose `Area1` = 200 splashes around whoever it lands on — the same shape as the
  // Brewmaster's Drunken Haze, which is the other half of the same idea. Columns Nab3..Nab6,
  // and the old code was one column out on every one of them:
  //   DataC "Armor Penalty"      3/4/5     ← was read from DataD
  //   DataD "Primary Damage"     6/11/17   the PRIMARY target's dps
  //   DataE "Secondary Damage"   4/7/11    …and everyone else's ("slightly less damage")
  //   DataF "Damage Interval"    1
  ANab: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const life = lvl.duration || 15;
    const tick = d(lvl, 5, 1) || 1;
    for (const o of enemiesInArea(api, caster, def, t.x, t.y, lvl.area || 200)) {
      api.applyBuff(o, { kind: "armor", group: "acid", timeLeft: life, sourceId: caster.id, value: -d(lvl, 2, 3), ...fx(def) });
      api.applyBuff(o, { kind: "dot", group: "acid", timeLeft: life, sourceId: caster.id, value: (o === t ? d(lvl, 3, 6) : d(lvl, 4, 4)) / tick });
    }
  },

  // Mana Burn (Demon Hunter) — burn up to dataA mana; deal that much damage.
  AEmb: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const burned = api.burnMana(t, d(lvl, 0, 50));
    if (burned > 0) api.spellDamage(t, burned, caster.id);
    // dataB/dataC are named "Bolt Delay" and "Bolt Lifetime" — the MBUR beam's own timing.
    api.emitLightning(bolts(def)[0], caster, t, d(lvl, 2, 1), d(lvl, 1, 0.25));
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Shadow Strike (Warden) — a thrown dagger: `Esh5 "Initial Damage"` (75/150/225) on the
  // hit, then `Esh1 "Decaying Damage"` (10/30/45) every three seconds for `Dur1` = 15.1,
  // plus `Esh2 "Movement Speed Factor"` = 0.5 of a slow.
  //
  // Those three seconds are the ability's `Cast1` column, and its own Ubertip is what proves
  // it: "…dealing <AEsh,DataE1> initial damage, and <AEsh,DataA1> damage every
  // <AEsh,Cast1> seconds for <AEsh,Dur1> seconds." `Cast` on this row is the POISON TICK,
  // not a casting time — which is why the Warden used to stand still for three seconds
  // before throwing (see world.ts CAST_TIME_IS_NOT_A_WINDUP). Our dot ticks continuously,
  // so the per-tick figure is spread over the interval to give the same total.
  AEsh: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const d0 = dur(lvl, t) || 15.1;
    const tick = lvl.castTime || 3;
    api.spellDamage(t, d(lvl, 4, 75), caster.id);
    api.applyBuff(t, { kind: "dot", group: "shadowstrike", timeLeft: d0, sourceId: caster.id, value: d(lvl, 0, 10) / tick, ...fx(def) });
    api.applyBuff(t, { kind: "slow", group: "shadowstrike", timeLeft: d0, sourceId: caster.id, value: d(lvl, 1, 0.5), value2: d(lvl, 2, 0) });
  },

  // Howl of Terror (Pit Lord) — enemies in `area` deal dataA less attack damage.
  ANht: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    for (const t of enemiesInArea(api, caster, def, caster.x, caster.y, lvl.area || 500)) {
      api.applyBuff(t, { kind: "damagePct", group: "howl", timeLeft: lvl.duration || 15, sourceId: caster.id, value: -d(lvl, 0, 0.3) });
    }
  },

  // Drunken Haze (Brewmaster) — a flask thrown at ONE unit that splashes over the ones
  // beside it: "Drenches enemy units in alcohol, causing their movement speed to be reduced
  // by <ANdh,DataC1,%>%, and have a <ANdh,DataB1,%>% chance to miss on attacks" (Ubertip).
  // Its `targs1` is `air,ground,enemy,organic,neutral` and `Rng1` = 550 — a unit-target
  // ability whose `Area1` = 200 is the splash around the one you hit, not a circle you aim
  // at the ground. (Same shape as Acid Bomb, the Alchemist's version of the same throw.)
  // Its columns are the shared Silence row `Nsi1..Nsi4`:
  //   DataB "Chance To Miss (%)"       0.45/0.65/0.8
  //   DataC "Movement Speed Modifier"  0.15/0.3/0.5
  ANdh: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    for (const o of enemiesInArea(api, caster, def, t.x, t.y, lvl.area || 200)) {
      const d0 = dur(lvl, o) || 12;
      api.applyBuff(o, { kind: "slow", group: "haze", timeLeft: d0, sourceId: caster.id, value: d(lvl, 2, 0.15), value2: 0, ...fx(def) });
      api.applyBuff(o, { kind: "miss", group: "haze", timeLeft: d0, sourceId: caster.id, value: d(lvl, 1, 0.45) });
    }
  },

  // Silence (Dark Ranger) — enemies in the area can't cast for the duration.
  ANsi: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    // `[ANsi] Effectart = …\Other\Silence\SilenceAreaBirth.mdl` — the dark ring that
    // slams down over the area. The row names no Areaeffectart, so the old read drew
    // nothing and the spell was also silent (Silence1.wav resolves off this model).
    if (def.effectArt) api.emitEffect(def.effectArt, ctx.x, ctx.y, 0);
    for (const t of enemiesInArea(api, caster, def, ctx.x, ctx.y, lvl.area || 300)) {
      api.applyBuff(t, { kind: "silence", group: "silence", timeLeft: lvl.duration || 8, sourceId: caster.id, ...fx(def) });
    }
  },

  // --- point-AoE fields (Blizzard-style repeating waves) ---
  // (Blizzard AHbz and Rain of Fire ANrf both live up with the Archmage's spells.)

  // Flame Strike (Blood Mage) — reached only when the 1.33s cast wind-up FINISHES
  // (MPQ AHfs Cast=1.33). The wind-up drops the FlameStrikeTarget "beware" vortex and
  // spends the mana up front (in tickCast, PRECAST_WARNING), so moving the Blood Mage
  // before ignition aborts here and leaves just the gong + vortex and a wasted cast —
  // matching WC3 (Liquipedia: Blood Mage). At ignition the plain FlameStrike pillar
  // erupts ONCE (its ~7.2s "birth" clip is the lingering fire), then FlameStrikeEmbers
  // paint the burning circle: 9 in a ring around the area + 1 at the centre.
  //
  // Damage is TWO phases, straight from the MPQ AHfs fields (verified 2026-07 against the
  // 1.27 SLK + ubertip): the ubertip reads "burns ground units for N damage a second for
  // 3 seconds. As the pillar of flame subsides, units within the fire continue to take
  // minor damage." So the pillar deals "Full Damage Dealt" (dataA) every "Full Damage
  // Interval" (dataB, 0.33s) — L1 15/0.33s ≈ 45 dps, matching the tooltip's 45/80/110 —
  // for the FIRST THIRD of the duration (Dur=9 → 3s), then the subsiding "Half Damage
  // Dealt" (dataC) every "Half Damage Interval" (dataD, 1s) for the remaining two-thirds.
  // The old code spread dataA over the whole 9s as 1s waves (15 dps for 9s), so the burn
  // did far too little per second and lasted three times too long. Heroes take the shorter
  // herodur (2.67s) throughout. Damage begins the instant this handler runs — i.e. when the
  // cast-point wind-up ends — since a field's first wave fires on its next tick (delay 0).
  AHfs: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const area = lvl.area || 200;
    // Eruption pillar: hold it ~7.2s so the whole "birth" fire plays out, not just 2s.
    api.emitEffect(FLAMESTRIKE_PILLAR, ctx.x, ctx.y, 0, 7.2);
    // Ring of embers marking the burning circle (see reference: a solid ring of flame
    // blobs with one in the middle). A ring a little inside `area` reads as a cohesive
    // ring rather than sparse dots on the rim.
    const ringR = area * 0.62;
    api.emitEffect(FLAMESTRIKE_EMBERS, ctx.x, ctx.y, 0); // centre
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2;
      api.emitEffect(FLAMESTRIKE_EMBERS, ctx.x + Math.cos(ang) * ringR, ctx.y + Math.sin(ang) * ringR, 0);
    }
    const total = caster.isHero && lvl.heroDuration > 0 ? lvl.heroDuration : lvl.duration || 9;
    const fullDur = total / 3; // the "3 seconds" full-damage pillar (Dur=9 → 3s)
    const fullInt = d(lvl, 1, 0.33) || 0.33; // Full Damage Interval
    const halfInt = d(lvl, 3, 1) || 1; // Half Damage Interval
    // Full-damage pillar: dataA every dataB, over the first third of the duration.
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area, damagePerWave: d(lvl, 0, 15), waves: Math.max(1, Math.round(fullDur / fullInt)), interval: fullInt, casterId: caster.id, art: "" });
    // Subsiding "minor damage": dataC every dataD, for the remaining two-thirds — begins
    // once the pillar fades (delay = fullDur) so the two phases don't overlap.
    const halfDmg = d(lvl, 2, 0);
    const halfWaves = Math.max(0, Math.round((total - fullDur) / halfInt));
    if (halfDmg > 0 && halfWaves > 0) {
      api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area, damagePerWave: halfDmg, waves: halfWaves, interval: halfInt, delay: fullDur, casterId: caster.id, art: "" });
    }
  },

  // Death and Decay (Lich, ult) — the plague field. Every number is its own row's:
  //   `Udd1 "Max Life Drained per Second (%)"` = 0.04 — a PERCENTAGE of each victim's
  //   maximum life, once a second, for `Dur1` = 35 over `Area1` = 300/400. That is what
  //   makes it the building-killer it is: 4% of a Town Hall's 1500 dwarfs 4% of a Ghoul's
  //   340, and a flat 20 (what this used to deal) had the ranking exactly backwards.
  //
  // Its art is on the effect object, not the ability: `[AUdd] EfctID1 = XUdd`, and
  // `[XUdd] Effectart = …\Undead\DeathandDecay\DeathandDecayTarget.mdl` with
  // `Effectsoundlooped = DeathAndDecayLoop`. `[AUdd]` itself names no art and no sound at
  // all, which is why the field ran invisibly and in silence. The per-victim rot is
  // `[BUdd] Targetart = …\DeathandDecayDamage.mdl`, carried on the wave's own buff art.
  //
  // Trees: it clears a forest in the real game, but `targs1` is `air,ground,structure,ward`
  // with no `tree` — the flag list has no way to say it, so the ability does (fellsTrees).
  AUdd: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const waves = Math.max(6, Math.round(lvl.duration || 35));
    api.addSpellField({
      code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 300,
      damagePerWave: d(lvl, 0, 0.04), damagePctOfMax: true,
      waves, interval: 1, casterId: caster.id,
      // DeathandDecayTarget is ONE small purple spirit, not a pool — WC3 carpets the circle
      // with them. Ten a second, each living out its ~1.9s Stand clip, is what reads as the
      // rot spreading over the ground rather than as three dots on a lawn.
      art: fieldArt(def), loopSound: fieldLoop(def), artPerWave: 10, fellsTrees: true,
    });
  },

  // Starfall (Priestess, ult) — channelled: stars rain on enemies around the
  // caster (dataA per wave, dataB apart) for the duration.
  AEsf: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const interval = d(lvl, 1, 1.5) || 1.5;
    const waves = Math.max(4, Math.round((lvl.duration || 45) / interval));
    api.addSpellField({ code: def.code, x: caster.x, y: caster.y, area: lvl.area || 800, damagePerWave: d(lvl, 0, 50), waves, interval, casterId: caster.id, art: fieldArt(def), loopSound: fieldLoop(def) });
  },

  // Stampede (Beastmaster, ult) — a herd of thunder lizards stampedes THROUGH the area,
  // one beast at a time. AbilityMetaData names all five columns (Nst1..Nst5):
  //   DataA "Beasts Per Second"        2      → one arrives every 0.5s for the 30s duration
  //   DataB "Beast Collision Radius"   55
  //   DataC "Damage Amount"            60     ← what a beast deals where it lands
  //   DataD "Damage Radius"            275    ← …and how wide, which is NOT `Area1` (1000,
  //                                             the ground the herd covers — hence `scatter`)
  //   DataE "Damage Delay"             0.2
  // The old code read DataB — the COLLISION RADIUS — as the damage, so a stampede hit for
  // 55 in a 1000-radius circle 15 times instead of 60 in a 275 one sixty times.
  //
  // The beast itself is the ability's Missileart (StampedeMissile.mdl, the running lizard);
  // `Effectsoundlooped = StampedeLoop` is on the ability rather than on an effect object,
  // which is what fieldLoop's second half is for.
  ANst: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const perSec = Math.max(0.1, d(lvl, 0, 2));
    const total = lvl.heroDuration || lvl.duration || 30;
    api.addSpellField({
      code: def.code, x: ctx.x, y: ctx.y,
      area: d(lvl, 3, 275), scatter: lvl.area || 1000,
      damagePerWave: d(lvl, 2, 60),
      waves: Math.max(1, Math.round(total * perSec)), interval: 1 / perSec,
      impactDelay: d(lvl, 4, 0.2), casterId: caster.id,
      art: def.missileArt || fieldArt(def), loopSound: fieldLoop(def), waveSound: true,
    });
  },

  // Cluster Rockets (Tinker) — a salvo of rockets into the area. Its Data columns are the
  // SAME shared row Healing Spray uses (AbilityMetaData `Ncs1..Ncs5`, useSpecific=ANhs,ANcs):
  //   DataA "Damage Amount"      11.25/19.75/30.5   per rocket
  //   DataB "Damage Interval"    0.25
  //   DataC "Missile Count"      6/12/18
  //   DataD "Max Damage"         105/195/300        the cap over the whole salvo
  //   DataF "Effect Duration"    1.01               how long the salvo takes to land
  // The rockets are the ability's own Missileart (TinkerRocketMissile.mdl) — nothing is on
  // an area art field, which is why the salvo used to be an invisible tick of damage.
  ANcs: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const interval = d(lvl, 1, 0.25) || 0.25;
    const waves = Math.max(1, Math.round((d(lvl, 5, 1) || 1) / interval));
    const rockets = Math.max(1, d(lvl, 2, 6));
    const perWave = rockets / waves;
    api.addSpellField({
      code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 200,
      damagePerWave: d(lvl, 0, 11.25) * perWave, waves, interval,
      maxDamagePerWave: d(lvl, 3, 0) / waves,
      casterId: caster.id, art: def.missileArt || fieldArt(def),
      artPerWave: Math.max(1, Math.round(perWave)), waveSound: true,
    });
  },

  // Volcano (Firelord, ult) — sustained eruption damaging the target area.
  ANvc: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 500, damagePerWave: d(lvl, 1, 8), waves: 12, interval: 1, casterId: caster.id, art: fieldArt(def), loopSound: fieldLoop(def) });
  },

  // Earthquake (Far Seer, ult) — the ground itself comes apart. Columns Oeq1..Oeq4:
  //   DataA "Effect Delay"                    0.5
  //   DataB "Damage per Second to Buildings"  50    ← BUILDINGS ONLY
  //   DataC "Units Slowed (%)"                0.75  ← and units are only SLOWED
  //   DataD "Final Area"                      250
  // The old code read DataA (the 0.5s delay) as the slow fraction and split DataB across
  // everything in the circle, so it hurt units it should not touch and slowed them by half
  // instead of three quarters.
  //
  // Art + sound are on the effect object: `[AOeq] EfctID1 = XOeq`, `[XOeq] Effectart =
  // …\Orc\EarthQuake\EarthQuakeTarget.mdl`, `Effectsoundlooped = EarthquakeLoop`. The
  // ability row names neither, which is why the quake was silent, still and invisible. The
  // slowed unit wears `[BOeq] Targetart` (StasisTotemTarget, overhead) through fx(def).
  AOeq: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const total = lvl.heroDuration || lvl.duration || 25;
    const area = lvl.area || 250;
    fieldOnce(api, def, ctx.x, ctx.y, total); // one EarthQuakeTarget over the whole circle
    api.addSpellField({
      code: def.code, x: ctx.x, y: ctx.y, area,
      damagePerWave: d(lvl, 1, 50), buildingsOnly: true,
      waves: Math.max(6, Math.round(total)), interval: 1, delay: d(lvl, 0, 0.5),
      casterId: caster.id, art: "", loopSound: fieldLoop(def),
      shake: true,
    });
    for (const t of enemiesInArea(api, caster, def, ctx.x, ctx.y, area)) {
      if (t.building) continue; // a building cannot be slowed; it is being knocked down instead
      api.applyBuff(t, { kind: "slow", group: "quake", timeLeft: total, sourceId: caster.id, value: d(lvl, 2, 0.75), value2: 0, ...fx(def) });
    }
  },

  // --- self buffs / channels ---

  // Bladestorm (Blademaster, ult) — the caster becomes a whirlwind, dealing dataA
  // damage per second to surrounding enemies for the channel.
  AOww: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.addSpellField({ code: def.code, x: caster.x, y: caster.y, area: lvl.area || 200, damagePerWave: d(lvl, 0, 110), waves: Math.max(3, Math.round(lvl.duration || 7)), interval: 1, casterId: caster.id, art: def.casterArt || def.specialArt });
  },

  // Immolation (Demon Hunter) — a TOGGLE, not a cast: pressing it lights the Demon Hunter
  // and he burns until he (or an empty mana bar) puts it out. Columns Eim1..Eim3:
  //   DataA "Damage per Interval"   10/15/20   every `Dur1` = 1 second
  //   DataB "Mana Drained per Second" 7
  //   DataC "Buffer Mana Required"    10       below this it snuffs itself out
  // plus `Cost1` = 25 to light it (deactivating is free — `Unorder = unimmolation`).
  // The burn itself lives in world.ts tickImmolation, because it has to keep up with a
  // caster who is walking; all this does is flip the switch.
  AEim: (api, caster) => api.toggleImmolation(caster),

  // Locust Swarm (Crypt Lord, ult) — the swarm is not an effect, it is TWENTY UNITS. The
  // ability's columns say so (Uls1..Uls5 + `UnitID1 = uloc`, the Locust):
  //   DataA "Number of Swarm Units"          20
  //   DataB "Unit Release Interval (s)"      0.2
  //   DataC "Max Swarm Units Per Target"     7
  //   DataD "Damage Return Factor"           0.75   (what the Crypt Lord heals back)
  //   DataE "Damage Return Threshold"        20
  // `uloc` is a 65-hp flier with a 12-damage Spells-type attack and the `Aloc` Locust
  // ability — it does the damage with its own weapon, which is why there is no damage
  // column here at all. Modelling it as a nameless damage field (what this was) is why it
  // had "no particles": the locusts ARE the particles.
  //
  // The field it still registers deals nothing — it is there to hold the swarm's own
  // `Effectsoundlooped = LocustSwarmLoop` for the duration and to be torn down with it.
  // NOT YET MODELLED: the DataD/DataE return that heals the Crypt Lord off their bites.
  AUls: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const total = lvl.heroDuration || lvl.duration || 30;
    const unit = lvl.summon || "uloc";
    const count = Math.max(1, d(lvl, 0, 20));
    for (let i = 0; i < count; i++) {
      const facing = caster.facing + (i / count) * Math.PI * 2;
      api.requestSummon(unit, caster.x, caster.y, facing, caster.owner, caster.team, total, caster.id, summonArt(def), false);
    }
    api.addSpellField({
      code: def.code, x: caster.x, y: caster.y, area: lvl.area || 800,
      damagePerWave: 0, waves: Math.max(1, Math.round(total)), interval: 1,
      casterId: caster.id, art: "", loopSound: fieldLoop(def),
    });
  },

  // Wind Walk (Blademaster) — vanish after a beat, move faster, and hit the next thing you
  // touch harder. AbilityData.slk AOwk, whose Data columns AbilityMetaData names Owk1/2/3:
  //   DataA "Transition Time"            0.6      — the pause before he actually fades out
  //   DataB "Movement Speed Increase (%)" 0.1/0.4/0.7
  //   DataC "Backstab Damage"             40/70/100
  // The backstab is NOT a standing damage bonus (it used to be modelled as one, which paid
  // out on every swing for the whole 20-50s). Liquipedia: "when the Blademaster attacks a
  // unit to break invisibility, he will deal bonus damage" — it is one blow's worth, so it
  // rides on the invisible buff and world.ts breakInvisibility() hands it to that swing.
  // Both buffs share the "windwalk" group, which is what makes the break end the speed too.
  AOwk: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const d0 = lvl.duration || 20;
    const transition = d(lvl, 0, 0.6);
    api.applyBuff(caster, { kind: "haste", group: "windwalk", timeLeft: d0, sourceId: caster.id, value: d(lvl, 1, 0.5), value2: 0, ...fx(def) });
    api.applyBuff(caster, { kind: "invisible", group: "windwalk", timeLeft: d0, sourceId: caster.id, value: d(lvl, 2, 40), delay: transition });
  },

  // Call to Arms, the Peasant's own half (`Amil`, order `militia` / `militiaoff`) — the same
  // form toggle as Burrow, between the two units the ability names:
  //   DataA "Normal Form Unit"    hpea   the Peasant
  //   DataB "Alternate Form Unit" hmil   the Militia
  // (DataB, not UnitID1 — see altFormOf for why the column moves between abilities.)
  //
  // The militia is faster, armoured and hits nearly three times as hard (hmil: spd 270, def 4
  // large, dmg 11, against the Peasant's 190 / 0 medium / 4), and every one of those numbers
  // is hmil's own row. What makes it a decision rather than a free upgrade is Dur1 = 45: the
  // form is TIMED, and a militia that survives its 45 seconds turns back into a Peasant
  // wherever it happens to be standing — see tickAltForm.
  Amil: (api, caster, def) => { api.morphToggle(caster, def); },

  // Call to Arms, the town bell (`Amic`, order `townbellon` / `townbelloff`) — the half a
  // player actually clicks. It converts no one itself: it rings, and every Peasant the hall
  // owns within Area1 = 2000 runs their OWN `Amil`, which is why the militia's numbers and its
  // 45-second clock live in one place rather than being restated here.
  //
  // Toggle direction is read off the field rather than tracked on the hall: if anything nearby
  // is already a militia the bell sends them all back to work, otherwise it calls them up.
  // That matches the button ("Call to Arms" / "Back to Work") without the hall having to
  // remember a state that the militia themselves already carry — and it stays correct when a
  // militia's own timer runs out from under the hall.
  Amic: (api, caster, def) => {
    const lvl = def.levelData[0];
    const militia = api.abilityOf("Amil");
    if (!militia) return;
    const alt = militia.levelData[0]?.dataStr[1] ?? "";
    const near = api.unitsInArea(caster.x, caster.y, lvl.area || 2000)
      .filter((u) => u.owner === caster.owner && u.hp > 0 && u.abilities.some((a) => a.code === "Amil"));
    const anyUp = near.some((u) => u.typeId === alt);
    for (const u of near) {
      if ((u.typeId === alt) === anyUp) api.morphToggle(u, militia); // only those on the wrong side
    }
  },

  // Burrow (`Abur`, aliases Abu2/Abu3/Abu5) — the Crypt Fiend digs in. It is a FORM TOGGLE,
  // not a state: the ability names both units outright (DataA "Normal Form Unit" = ucry,
  // UnitID1 "Alternate Form Unit" = ucrm) and morphing between them is the entire ability.
  //
  // Everything burrowing DOES is already in `ucrm`: spd "-" so it cannot move, weapsOn 0 so it
  // cannot attack, regenHP 5 against the walking Fiend's 2 — which is the whole reason to
  // burrow — and an abilList that drops Web but keeps Burrow so it can dig out. So there is
  // nothing to write here beyond asking for the swap.
  //
  // The same handler is the mechanism behind Bear Form, Crow Form, Stone Form, Destroyer
  // Form, Ethereal Form and Submerge — identical columns, different art. They are NOT enabled
  // yet: each has its own wrinkles (Bear Form's morph time, Crow Form being a travel form,
  // Metamorphosis being timed rather than a toggle), and enabling a unit's form swap without
  // checking that unit is how you ship six half-right abilities instead of one right one.
  Abur: (api, caster, def) => { api.morphToggle(caster, def); },

  // Root / Unroot (`Aroo`, aliases Aro1/Aro2) — an Ancient pulling itself out of the ground,
  // or planting again. One ability, two directions (`Order=root` / `Unorder=unroot`), so it
  // toggles; the command card shows one button that swaps its label with the state.
  //
  // Everything the two states differ by is DERIVED in recomputeStats — the walk speed and the
  // live weapon slot both fall out of `uprooted` — so the handler only has to ask the sim to
  // make the physical transition (free or claim the Ancient's cells). See toggleRoot.
  //
  // Unspent: DataD "Uprooted Defense Type" = 2. It is an INDEX into the game's own defense
  // type ordering, and our ArmorType is a string enum with no such index, so mapping it means
  // establishing what 2 means rather than assuming it lands on Medium because that is the
  // answer I expect. A rooted Ancient is `fort` in UnitBalance and stays `fort` uprooted until
  // that is settled — see CLAUDE.md on not inventing a number.
  Aroo: (api, caster) => { api.toggleRoot(caster); },

  // Entangle Gold Mine (`Aent`) — the Tree of Life throws roots around a gold mine so that
  // wisps can climb into it. The only night elf ability with a three-second cast time on a
  // building, and the reason a night elf expansion is a Tree of Life planted at the mine.
  //
  // Nothing here decides WHICH mine: targs1 is `_`, so the ability takes no target at all and
  // the engine's own rule is "the one in range" (Rng1 = 500). Nor does it decide WHAT it
  // makes — the row names that too (UnitID1 = egol). Both live in SimWorld.entangleMine,
  // beside the mine table it has to search.
  Aent: (api, caster, def) => { api.entangleMine(caster, def); },

  // Detonate (`Adtn`) — the Wisp's last act. It blows itself up, and what the blast carries
  // is not damage: it is a DISPEL and a mana burn, which is why five wisps beat a hero army
  // that leans on its buffs and its mana.
  //
  //   DataA1  50   mana drained from every unit in the blast (`Dtn1`)
  //   DataB1  225  damage, to SUMMONED units only (`Dtn2`)
  //   Area1   300  the blast
  //   targs1  air,ground,ward,invu,vuln,tree — no allegiance flag at all
  //
  // Two things follow from that target list and both are the ability, not an oversight.
  // There is no `enemy`, so Detonate burns FRIENDLY mana as readily as the enemy's — a wisp
  // popped in your own army's midst empties your own casters. And `invu` is listed, but only
  // for the dispel: "Since Patch 1.25b Detonate no longer drains mana from invulnerable
  // units. The dispelling effect still affects invulnerable units" (Liquipedia, Wisp). Our
  // 1.30.4 is well past that, so the mana burn skips them and the dispel does not.
  //
  // 50 is the 1.30-era figure; it became 40 in 1.32.9, long after the version we are.
  Adtn: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const area = lvl.area || 300;
    if (def.specialArt) api.emitEffect(def.specialArt, caster.x, caster.y, 0);
    for (const t of api.unitsInArea(caster.x, caster.y, area)) {
      if (t === caster || t.hp <= 0 || t.building) continue;
      api.dispel(t);
      if (!t.invulnerable) api.burnMana(t, d(lvl, 0, 50));
      if (t.summonLeft > 0) api.spellDamage(t, d(lvl, 1, 225), caster.id);
      if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
    }
    api.killUnit(caster); // "Destroys the Wisp" — the cost, and the whole of the cast
  },

  // Eat Tree (`Aeat`) — an Ancient pulls a tree up and eats it. `DataC1` = 500 hit points
  // over `Dur1` = 30 seconds, which is a HEAL OVER TIME and not a heal: "Eating trees now
  // gives a constant, non-stacking healing effect" (1.03), raised to its present 500/30s in
  // 1.13. Non-stacking is why the buff carries `BuffID1` = Beat as its group — a second tree
  // eaten mid-heal replaces the first rather than doubling the rate.
  //
  // The tree is the cast's real cost: it is destroyed outright and nobody gets its lumber.
  // Aimed at a POINT rather than at a tree handle, because a tree is not a unit in this sim —
  // the nearest one to the click that the Ancient can actually reach is the one it eats.
  // DataA 0.8 and DataB 2.5 have field ids of their own (Eat1/Eat2) and no source that names
  // them, so they stay unspent.
  Aeat: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    // Rng1 is 32 — a tree the Ancient is already touching. Measured from its HULL, which for
    // a 12x12 Ancient of War is most of the reason the number can be that small.
    if (!api.eatTree(caster, ctx.x, ctx.y, (lvl.castRange || 32) + caster.radius)) return;
    const secs = lvl.duration || 30;
    // `Beat` carries no art of its own — the sprite is `Aeat`'s own Specialart, worn at the
    // Ancient's `eattree` attachment point for as long as the heal runs.
    const art = def.specialArt ? [{ path: def.specialArt, attach: def.specialAttach }] : [];
    api.applyBuff(caster, {
      kind: "hot",
      group: lvl.buffs[0] || "Beat", // non-stacking: a second tree replaces the first
      timeLeft: secs,
      sourceId: caster.id,
      value: d(lvl, 2, 500) / secs,
      art: art[0]?.path ?? "",
      fx: art,
      buffId: lvl.buffs[0] || "",
    });
  },

  // Replenish Mana and Life (`Ambt`) — the Moon Well. The cast only says WHO is drinking;
  // the well then spends itself into them over the following seconds at its own rate, so the
  // effect is a state on the caster rather than anything applied here. See tickReplenish for
  // the 2-hp/0.5-mana-per-point split and why it spills between the two.
  Ambt: (api, caster, _def, _rank, ctx) => { api.setReplenishTarget(caster, ctx.targetId); },

  // Shadow Meld (`Ashm`) — the night elf racial: an Archer standing still in the dark simply
  // isn't there. Every night elf ground unit has it, which is what a night elf army does when
  // it wants the map to stop knowing where it is.
  //
  // It is the one invisibility that is a STANCE, not a spell, and that shapes the whole
  // implementation. There is no duration column at all: it holds for as long as its
  // conditions hold. So the buff goes on with timeLeft Infinity and world.ts tickMeld takes
  // it off again when the unit moves or the sun comes up (`meld: true` marks it) — the other
  // breaks (attack, cast) come free through the shared breakInvisibility path.
  //
  // AbilityData.slk Ashm, Data columns named by AbilityMetaData Shm1/2/3 through
  // WorldEditStrings:
  //   DataA "Fade Duration"      1.5   (Sshm, the instant variant, 0.1)
  //   DataB "Day/Night Duration" 2.5
  //   DataC "Action Duration"    0.5
  // Only DataA is spent, as the buff's `delay` — Liquipedia names the 1.5s fade outright and
  // the number agrees. DataB and DataC have names but no source that says what they MEASURE,
  // so they stay unspent rather than guessed at (see tickMeld, and CLAUDE.md's "do not invent
  // a number"). Both want a measurement against the real client.
  //
  // Casting is refused by day. That is not decoration: without it the unit would meld, pay
  // the fade, and be stripped by tickMeld on the very next tick.
  Ashm: (api, caster, def, rank) => {
    if (api.isDay()) return; // night ability — the button is dead in daylight
    const lvl = def.levelData[rank - 1];
    // Hold position and hold fire. WC3 melds the unit INTO this stance, and it is the reason
    // a melded unit stays melded: left on its own orders it would walk or shoot itself out of
    // hiding within seconds.
    api.holdPosition(caster);
    api.applyBuff(caster, {
      kind: "invisible",
      group: "shadowmeld",
      timeLeft: Infinity, // no duration column — the conditions are the duration
      sourceId: caster.id,
      value: 0, // no Backstab Damage: that is Wind Walk's DataC, and Ashm has no equivalent
      delay: d(lvl, 0, 1.5), // "Fade Duration"
      meld: true,
      ...fx(def),
    });
  },

  // Metamorphosis / Robo-Goblin / Chemical Rage — REAL form swaps, not stat buffs. All
  // three sit in AbilityMetaData's morph family (`Eme1..Eme4` are declared
  // `useSpecific=AEme,…,Abur,…,ANcr,ANrg,…` — the very same columns Burrow uses), so each
  // carries the pair morphToggle already reads:
  //   DataA   "Normal Form Unit"      Edem / Nalc / Ntin
  //   UnitID1 "Alternate Form Unit"   Edmm / Nalm / Nrob
  // and the alternate UNIT is where every "bonus" in the tooltip actually lives, which is
  // why a stat buff could never have got any of them right:
  //   • Edmm (Demon Form) attacks at range 600 with `atkType chaos`, `weapTp msplash` and
  //     750 base life, against the Demon Hunter's 100-range melee normal attack — that is
  //     the tooltip's "a powerful Demon with a ranged attack" in full. On top of it,
  //     `Eme5 "Alternate Form Hit Point Bonus"` = DataE = 500 is the only stat the ability
  //     itself adds, and the tooltip names that too.
  //   • Nrob is `type Mechanical` and carries `ANde` (Demolish) — "rendering him immune to
  //     most forms of stun, most offensive spells" is what being Mechanical MEANS.
  //   • Nalm moves 405 against the Alchemist's 290.
  // Duration comes off HeroDur (see morphToggle): 45s for Metamorphosis, 15 for Chemical
  // Rage, and Robo-Goblin has none at all — it is a toggle you turn off yourself.
  AEme: (api, caster, def, rank) => { api.morphToggle(caster, def, rank); },
  ANrg: (api, caster, def, rank) => { api.morphToggle(caster, def, rank); },
  ANcr: (api, caster, def, rank) => { api.morphToggle(caster, def, rank); },

  // Frost Armor (Lich) — buff a friendly unit with +armour (dataB) for the
  // duration (WC3 also slows melee attackers, which we don't model). Autocasts.
  AUfu: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "armor", group: "frostarmor", timeLeft: lvl.duration || 60, sourceId: caster.id, value: d(lvl, 1, 3), ...fx(def) });
  },

  // Far Sight (Far Seer) — reveal an area of the map. We have no fog of war yet, so
  // this only plays its effect; it exists so the Far Seer can learn all 4 skills.
  AOfs: (api, _caster, def, _rank, ctx) => {
    if (def.areaArt || def.targetArt) api.emitEffect(def.areaArt || def.targetArt, ctx.x, ctx.y, 0);
  },

  // Mana Shield (Naga) — absorb incoming damage into mana (dataA mana per hp).
  ANms: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.applyBuff(caster, { kind: "manaShield", group: "manashield", timeLeft: 3600, sourceId: caster.id, value: d(lvl, 0, 1) || 1, ...fx(def) });
  },

  // Blink (Warden / Demon Hunter's Illidan) — teleport toward the target point,
  // capped at the ability's max range (dataA).
  AEbl: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const maxR = d(lvl, 0, 1000);
    const dx = ctx.x - caster.x;
    const dy = ctx.y - caster.y;
    const dist = Math.hypot(dx, dy) || 1;
    const r = Math.min(dist, maxR);
    // Both models, and the AbilityFunc row says outright which end each belongs to:
    //     // Art to play at the new coordinate
    //     Areaeffectart = …\NightElf\Blink\BlinkTarget.mdl
    //     // Art to leave behind at old coordinate
    //     Specialart    = …\NightElf\Blink\BlinkCaster.mdl
    // Neither is TargetArt or Casterart — both of those are empty on `[AEbl]`, which is why
    // Blink used to teleport with no smoke at either end (and, with no model to resolve a
    // WAV off, in silence: BlinkBirth1.wav / BlinkArrival1.wav live beside them).
    //
    // Only the ARRIVAL is emitted here. The departure plume is the Warden's own gesture and
    // already went up at the start of the wind-up, where she still stood (world.ts
    // CAST_START_ART) — it is art to leave BEHIND, so it is left behind unattached and this
    // teleport walks out of it.
    api.teleport(caster, caster.x + (dx / dist) * r, caster.y + (dy / dist) * r);
    if (def.areaArt) api.emitEffect(def.areaArt, caster.x, caster.y, 0);
  },

  // Mass Teleport (Archmage, ult) — warp the caster and nearby allies to a point.
  AHmt: (api, caster, def, rank, ctx) => {
    // Cast on a friendly UNIT or structure, and everyone lands around IT — `Area1` is the
    // radius around the CASTER that comes along, not a destination circle (see
    // KNOWN_ABILITIES for the tooltip that says so).
    const dest = api.getUnit(ctx.targetId);
    if (!dest) return;
    const lvl = def.levelData[rank - 1];
    const allies = alliesInArea(api, caster, def, caster.x, caster.y, lvl.area || 700, { self: true }).slice(0, d(lvl, 0, 24));
    allies.forEach((t, i) => {
      const a = (i / Math.max(1, allies.length)) * Math.PI * 2;
      api.teleport(t, dest.x + Math.cos(a) * (i === 0 ? 0 : 128), dest.y + Math.sin(a) * (i === 0 ? 0 : 128));
    });
  },

  // Big Bad Voodoo (Shadow Hunter, ult) — a CHANNEL (`Animnames = stand,channel`), and that
  // is the whole balance of it: the Shadow Hunter himself is not protected and has to stand
  // in his own circle for the full `Dur1` = 30 seconds. Move him, stun him or kill him and
  // the ritual breaks — and every ally loses the invulnerability the same instant, which is
  // why the buff is refreshed on a short leash from the caster's tick (world.ts tickVoodoo)
  // instead of being handed out once for 30 seconds.
  //
  // Two buffs, and neither is on the ability: `[BOvd] Targetart = …\Orc\Voodoo\
  // VoodooAuraTarget.mdl` (overhead, on each protected ally) and `[BOvc] Targetart =
  // …\Voodoo\VoodooAura.mdl` (the ring on the ground under the Shadow Hunter).
  AOvd: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.voodoo(caster, def, rank);
    if (def.buffFx.length) api.emitEffect(def.buffArt, caster.x, caster.y, caster.id, lvl.duration || 30);
  },

  // --- drains / sacrifices ---

  // Siphon Mana / Life Drain (Blood Mage / Dark Ranger) — drain the target: a
  // damage-over-time on it and an equal heal-over-time on the caster.
  AHdr: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const d0 = lvl.duration || 6;
    // What the drain TAKES decides everything it looks like. dataA is "Life Transferred Per
    // Second" and dataB "Mana Transferred Per Second" (AbilityMetaData Ndr4/Ndr5), so the
    // Dark Ranger's Drain is a life drain, the Blood Mage's Siphon Mana a mana one, and an
    // ability that sets both is the combined drain. `flavour` indexes all three of the
    // ability's art lists in that same order.
    const lifeRate = d(lvl, 0, 0);
    const manaRate = d(lvl, 1, 0);
    const flavour = lifeRate > 0 && manaRate > 0 ? 0 : manaRate > 0 ? 2 : 1; // both | life | mana
    // Nine buffs, and the FIRST one is the wrong one for everybody: `BuffID1 =
    // Bdcb,Bdcl,Bdcm, Bdtb,Bdtl,Bdtm, Bdbb,Bdbl,Bdbm` is caster-trio, target-trio, then the
    // info-card icons — each trio ordered both/life/mana. So the role picks the trio and the
    // flavour picks within it: the victim of a Siphon Mana wears ManaDrainTarget, its caster
    // ManaDrainCaster, and neither wears the green DrainCaster art that buffid1 alone gives
    // (which is what put a life drain's swirl on a mana drain's victim).
    const casterFx = api.buffFxOf(DRAIN_BUFFS.caster[flavour]);
    const targetFx = api.buffFxOf(DRAIN_BUFFS.target[flavour]);
    // A drain TRANSFERS: what leaves the victim arrives in the caster, at the same rate, for
    // the same seconds. Life is a damage-over-time paired with a heal-over-time; mana is the
    // same shape with the mana-regen buff, negative on the victim. A row that names neither
    // (a custom ability with no data) falls back to a small life drain rather than doing
    // nothing at all, which is what the old single-rate reading effectively did for everyone.
    const life = lifeRate || (manaRate > 0 ? 0 : 15);
    if (life > 0) {
      api.applyBuff(t, { kind: "dot", group: DRAIN_GROUP, timeLeft: d0, sourceId: caster.id, value: life, art: targetFx[0]?.path ?? "", fx: targetFx });
      api.applyBuff(caster, { kind: "hot", group: DRAIN_GROUP, timeLeft: d0, sourceId: caster.id, value: life, art: casterFx[0]?.path ?? "", fx: casterFx });
    }
    if (manaRate > 0) {
      // One set of models, not two: when a drain takes both, the life half above is already
      // wearing the art.
      const artT = life > 0 ? [] : targetFx;
      const artC = life > 0 ? [] : casterFx;
      api.applyBuff(t, { kind: "manaRegen", group: DRAIN_GROUP, timeLeft: d0, sourceId: caster.id, value: -manaRate, art: artT[0]?.path ?? "", fx: artT });
      api.applyBuff(caster, { kind: "manaRegen", group: DRAIN_GROUP, timeLeft: d0, sourceId: caster.id, value: manaRate, art: artC[0]?.path ?? "", fx: artC });
    }
    // The tether: the beam holds between caster and victim for the whole drain, its texture
    // crawling BACK toward the caster (TexCoordScale is negative on all three drain rows).
    // `LightningEffect=DRAB,DRAL,DRAM` is the same both/life/mana order. Tagged with the
    // caster, because a drain is CHANNELLED and an interrupted channel must cut its beam
    // (world.ts tickDrains) rather than leave it hanging for the rest of the duration.
    api.emitLightning(def.lightning[flavour] ?? def.lightning[0] ?? "", caster, t, d0, 0, drainTag(caster.id));
  },

  // Death Pact (Death Knight) — sacrifice a friendly non-hero unit to heal the
  // caster for its remaining hit points.
  AUdp: (api, caster, def, _rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t) || t.isHero) return;
    api.spellHeal(caster, t.maxHp);
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    api.killUnit(t);
  },

  // Dark Ritual (Lich) — sacrifice a friendly non-hero unit for mana (dataA of its
  // hit points).
  AUdr: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t) || t.isHero) return;
    const lvl = def.levelData[rank - 1];
    // `Udp1 "Life Converted to Mana"` — a FRACTION of the sacrifice's maximum life
    // (0.33/0.66/1), which is why the Lich wants a full-health Ghoul and not a hurt one.
    caster.mana = Math.min(caster.maxMana, caster.mana + t.maxHp * d(lvl, 0, 0.33));
    // Two models, one per end of the ritual, and the row names them plainly:
    //   Casterart = …\Undead\DarkRitual\DarkRitualCaster.mdl   the mana arriving
    //   Targetart = …\Undead\DarkRitual\DarkRitualTarget.mdl   the sacrifice going out
    // The target's is the one carrying the sound (DarkRitualTarget1.wav) — playing only the
    // caster's, as this did, left the spell both half-drawn and silent.
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    api.killUnit(t);
  },

  // Charm (Dark Ranger, ult) — take control of a non-hero enemy of level ≤ dataA.
  ANch: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || t.isHero || t.level > d(def.levelData[rank - 1], 0, 5)) return;
    api.changeOwner(t, caster.owner, caster.team);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Transmute (Alchemist, ult) — melt a non-hero target down for gold. Its whole effect is a
  // transaction, and both halves are the row's own numbers.
  ANtm: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || t.isHero || t.building) return;
    const lvl = def.levelData[rank - 1];
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
    // The two `unreal` columns this row carries are the price it pays for the body:
    //   Ntm1 (DataA) = 1.25   × the victim's GOLD cost
    //   Ntm2 (DataB) = 0      × its lumber cost
    // (Ntm3 = 5 is the creep level it refuses above — enforced at the order, see
    // SimWorld.targetError / CREEP_LEVEL_CAP.) The World Editor's own names for these live
    // in strings the install does not ship, so the reading is checked against the numbers
    // players quote instead, and they are `goldcost × 1.25` rounded to the point: a Footman
    // (135) pays 169, a Rifleman (205) 256, a Knight (245) 306.
    api.transmute(t, caster, d(lvl, 0, 1.25), d(lvl, 1, 0));
  },

  // --- summons ---

  // Feral Spirit (Far Seer) — dismiss the caster's existing wolves (with an unsummon poof),
  // then raise a fresh pack of dataB (2) Spirit Wolves beside him. count:0 → summonSpell reads
  // the count from the ability's dataB.
  AOsf: (api, caster, def, rank) => {
    const wolfTypes = def.levelData.map((l) => l.summon).filter(Boolean);
    api.dismissSummons(caster.owner, wolfTypes);
    summonSpell(api, caster, def, rank, { count: 0, atPoint: false });
  },
  // Force of Nature (Keeper) — it does not conjure treants out of the air, it turns TREES
  // into them, and its own `targs1` says so: the single flag `tree`. `Efn1 "Number of
  // Summoned Units"` = 2/3/4 is the cap and `Area1` = 150/225/300 the circle it looks in;
  // each Treant stands in the hole its own tree left, so a Keeper cutting a Force of Nature
  // out of a treeline opens a path through it. Summoning them off `dataB` at the click
  // (what summonSpell did) both made the wrong number and left the grove standing.
  AEfn: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (!lvl.summon) return;
    const art = summonArt(def);
    const life = lvl.heroDuration || lvl.duration || 60;
    for (const spot of api.fellTrees(ctx.x, ctx.y, lvl.area || 150, Math.max(1, d(lvl, 0, 2)))) {
      api.requestSummon(lvl.summon, spot.x, spot.y, caster.facing, caster.owner, caster.team, life, caster.id, art, true);
    }
  },
  // Carrion Beetles (Crypt Lord) — `targs1 = dead`: the ability eats a CORPSE. Pressing it
  // takes no aiming at all; the Crypt Lord finds the nearest body inside `Rng1` = 900 and a
  // beetle climbs out of it. Shape A (see summonFromCorpse for the family and its columns);
  // beetles carry no `Dur1`, and "Beetles are permanent until killed" (Ubertip) is what that
  // zero means.
  AUcb: (api, caster, def, rank) => summonFromCorpse(api, caster, def, rank),
  // Raise Dead (Necromancer) — the family's plainest member and the one it is named after:
  // `Rai1` = 2 skeleton warriors (`uske`) out of one body, for `Dur1` = 45 seconds. Autocast,
  // and OFF by default — `Units\UnitAbilities.slk` gives `unec` `abilList = Acri,Arai,Auhf,
  // Aiun` with `auto = _`, so a Necromancer raises nothing until the player turns it on.
  // `ACrd` is the creep copy (40s) and `AIrd` the Rod of Necromancy (65s); all three share
  // this code, so all three arrive here with their own numbers.
  Arai: (api, caster, def, rank) => summonFromCorpse(api, caster, def, rank),
  // Spirit of Vengeance — the AVATAR of Vengeance's own ability, not the Warden's ultimate
  // that made the Avatar (`AEsv`, above). "Raises an invulnerable feral spirit from a corpse.
  // Lasts 50 seconds or until the avatar dies." (Liquipedia / Wowpedia, Avatar of Vengeance.)
  //
  // It is a RAISE-FROM-CORPSE row, and AbilityMetaData says so by sharing Raise Dead's own
  // field group with it — `Rai1..Rai4` are declared `useSpecific=Arai,ACrd,AUcb,AIrd,Avng`,
  // and `Ucb5`/`Ucb6` are shared with Carrion Beetles alone. So the columns read:
  //   DataA "Units Raised"    1
  //   DataC "Unit Type"       even   ← a RAWCODE, hence dataStr (the Spirit of Vengeance)
  //   DataE "Max Summoned"    6      ← Liquipedia's "Max Units Summoned: 6"
  //   Rng1                    600    Dur1 50    Cool1 2    Cost1 25    targs1 air,ground,dead
  //
  // Same shape as Carrion Beetles (which is why the two share those last two columns), with
  // two differences: the Spirits are on a CLOCK rather than permanent, and they are BOUND —
  // the Avatar's death (or its own 180s expiring) takes every one of them with it.
  //
  // Nothing here makes them invulnerable: they carry it themselves. `Units\UnitAbilities.slk`
  // gives `even` the whole ability list `Avul` — "Invulnerable (Neutral)" — which the spawn
  // path already reads as `baseInvulnerable`. The ability that raises them says nothing about
  // it, and neither should this.
  Avng: (api, caster, def, rank) => summonFromCorpse(api, caster, def, rank, { bound: true }),
  // Summon Bear / Quilbeast / Hawk (Beastmaster) — one beast beside the caster.
  ANsg: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  ANsq: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  ANsw: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  // Scout (Priestess) — summon a flying owl for vision.
  AEst: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  // Summon Lava Spawn (Firelord) — spawn a lava spawn at the point.
  ANlm: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  // Serpent Ward (Shadow Hunter) — a stationary attack ward at the point.
  AOwd: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  // Tornado (Naga, ult) — a roaming tornado at the point.
  ANto: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  // Pocket Factory (Tinker) — deploy a factory at the point.
  ANsy: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  // Storm, Earth and Fire (Brewmaster, ult) — split into three pandaren.
  ANef: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 3, atPoint: false }),
  // Phoenix (Blood Mage, ult) — summon a phoenix beside the caster.
  AHpx: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  // Vengeance (Warden, ult) — "Creates a powerful avatar that summons invulnerable spirits
  // from nearby corpses to attack your enemies" (Ubertip). It is a SUMMON, and the data says
  // exactly what of: `Esv1 "Number of Summoned Units"` = 1 of `UnitID1 = espv`, the Avatar of
  // Vengeance (level 7, 1200 hp, a 450-range missile attack) for `Dur1` = 180 seconds. The
  // Avatar carries `Avng` on autocast — raising the `even` Spirits is ITS ability, not this
  // one. It was filed as a passive in KNOWN_ABILITIES, which is why the button did nothing
  // at all: with no target type there was no order to give.
  //
  // Its birth is `Missileart = …\SpiritOfVengeance\SpiritOfVengeanceBirthMissile.mdl` and
  // the Avatar leaves on `Targetart` (feralspiritdone), which summonArt reads via
  // `[BEsv] Effectart`.
  AEsv: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),

  // Mirror Image (Blademaster) — conjure illusions (copies of the caster's type).
  // Mirror Image (Blademaster) — the whole ability is a staged shuffle (the caster
  // vanishes, MirrorImageCaster plays, missiles fly out, and images land alongside the
  // real hero on random tiles), so it runs as its own sequence in the world rather than
  // as a plain summon. See startMirrorImage.
  //
  // It was summonMany'd off `d(lvl, 1, …)` — DataB — which AbilityMetaData names "Damage
  // Dealt (%)" and the data sets to 0. `Math.max(1, 0)` meant exactly one image at every
  // rank, for an ability whose entire tooltip is about the count going 1 → 2 → 3. The
  // count is DataA, "Number of Images".
  AOmi: (api, caster, def, rank) => api.mirrorImage(caster, def, rank),

  // Inferno (Dreadlord, ult) — an infernal crashes down at the point, dealing
  // dataA impact damage to enemies in `area`, then fights for the duration.
  AUin: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    for (const t of enemiesInArea(api, caster, def, ctx.x, ctx.y, lvl.area || 250)) api.spellDamage(t, d(lvl, 0, 50), caster.id);
    // How long the Infernal stays is `Uin2 "Duration"` = 180 — NOT the Dur/HeroDur columns,
    // which on this row are the 4s/2s STUN the crash lands on everything under it. Reading
    // them (as this did) gave the Dreadlord's ultimate a two-second demon.
    if (lvl.summon) api.requestSummon(lvl.summon, ctx.x, ctx.y, caster.facing, caster.owner, caster.team, d(lvl, 1, 180), caster.id, { summon: def.effectArt, unsummon: def.buffEffectArt }, true);
    if (def.specialArt) api.emitEffect(def.specialArt, ctx.x, ctx.y, 0);
  },

  // Animate Dead (Death Knight, ult) — `targs1 = air,ground,dead`, the same corpse-eating
  // family as Carrion Beetles, and cast the same way: pressed, not aimed. It sweeps `Area1`
  // = 900 around the Death Knight and stands `Uan1 "Number of Corpses Raised"` = 6 of the
  // bodies back up.
  //   DataB — `Hre2 "Raised Units Are Invulnerable"` = 1. They cannot be killed; they simply
  //           run out (`Dur1` = 40s at rank 1, 120 after) — which is the whole ultimate.
  // What comes back is a SUMMON, not the unit that died: it keeps the corpse's body and its
  // weapon and loses everything else it once knew (spells, autocast, its own abilities), and
  // it leaves no second corpse behind. That is what `raiseCorpses` builds.
  //
  // The burst each body rises in is `Specialart = …\Undead\AnimateDead\AnimateDeadTarget.mdl`
  // (the ability row has no Casterart at all, so the old read drew nothing).
  AUan: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    raiseCorpses(api, caster, def, rank, caster.x, caster.y, {
      durationSec: lvl.heroDuration || lvl.duration || 40,
      invulnerable: d(lvl, 1, 0) !== 0,
      art: def.specialArt || def.casterArt,
      unsummonArt: def.buffEffectArt,
    });
  },
};

/** Level-data of the ability being cast (rank is 1-based). */
function lv(def: AbilityDef, rank: number): AbilityLevel {
  return def.levelData[Math.min(rank, def.levelData.length) - 1];
}

/**
 * SHAPE A of the corpse family — **one body becomes N of a FIXED type**.
 *
 * These rows share a field group and therefore a reading; AbilityMetaData declares
 * `Rai1..Rai4` as `useSpecific=Arai,ACrd,AUcb,AIrd,Avng`, and those five rows are the whole
 * shape. Only the numbers differ:
 *
 *   Raise Dead          `Arai`  DataA 2  DataC uske  Dur 45   Rng 600  — 2 skeletons a body
 *   Raise Dead (creep)  `ACrd`  DataA 2  DataC uske  Dur 40   Rng 600
 *   Rod of Necromancy   `AIrd`  DataA 2  DataC uske  Dur 65   Rng 600  — the item that copies it
 *   Carrion Scarabs     `AUcb`  DataA 1  DataC ucs1  Dur 0    Rng 900  DataE 5 — permanent
 *   Spirit of Vengeance `Avng`  DataA 1  DataC even  Dur 50   Rng 600  DataE 6 — bound
 *
 *   DataA `Rai1` "Units Raised"      how many climb out of the ONE body
 *   DataC `Rai3` "Unit Type"         a RAWCODE, hence dataStr — not the SLK `unitid` column
 *   DataE `Ucb5` "Max Summoned"      a live cap on the caster's total, 0 = uncapped
 *
 * `bound` is Vengeance's alone (its Spirits die with the Avatar). Everything else is data.
 */
function summonFromCorpse(api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, o: { bound?: boolean } = {}): void {
  const lvl = lv(def, rank);
  const unit = lvl.dataStr[2] || lvl.summon || SUMMON_FALLBACK[def.code] || "";
  if (!unit) return;
  const cap = d(lvl, 4, 0);
  if (cap > 0 && api.countOwned(caster.owner, unit) >= cap) return;
  // Nearest: you raise the body you are standing over, not the freshest one on the map.
  const [corpse] = api.claimCorpses(caster, def, caster.x, caster.y, lvl.castRange || lvl.area || 600, 1, "nearest");
  if (!corpse) return;
  const art = summonArt(def);
  const life = lvl.heroDuration || lvl.duration || 0;
  const n = Math.max(1, d(lvl, 0, 1));
  // …and they climb out of the body, so they land ON it (atPoint) rather than a step in
  // front of the caster — who, for Raise Dead, is 600 units away.
  for (let i = 0; i < n; i++) {
    api.requestSummon(unit, corpse.x, corpse.y, corpse.facing, caster.owner, caster.team, life, caster.id, art, true, o.bound);
  }
}

/**
 * SHAPE B of the corpse family — **up to N bodies get back up AS THEMSELVES**.
 *
 * The Hre1/Hre2 group: Resurrection and the two Runes, Animate Dead and its creep and item
 * copies. `DataA "Number of Corpses Raised"`, and the difference between the two halves of
 * the family is entirely in what comes back —
 *
 *   Resurrection `AHre`  Dur 0                    the unit itself, whole and permanent
 *   Animate Dead `AUan`  Dur 40, DataB 1          a timed, invulnerable SHELL
 *
 * — which `RaiseOptions` carries and world.ts honours. `targs1` decides WHOSE dead: `[AHre]
 * air,ground,dead,friend` is your own, `[AUan] air,ground,dead` is anybody's.
 *
 * Freshest first, because this one sweeps and takes SEVERAL: the bodies that have been lying
 * longest are the ones a six-corpse Resurrection should leave behind.
 */
function raiseCorpses(api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, x: number, y: number, opts?: RaiseOptions): number {
  const lvl = lv(def, rank);
  const taken = api.claimCorpses(caster, def, x, y, lvl.area || 900, Math.max(1, d(lvl, 0, 6)), "freshest");
  return api.raiseClaimed(taken, caster.owner, caster.team, opts);
}

/** Generic summon: place `count` (0 ⇒ read dataA/dataB) copies of the ability's
 *  summoned unit (SLK `unitid`, or a per-code fallback) beside the caster or at a
 *  target point, for the (hero) duration. */
function summonSpell(api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, opts: { count: number; atPoint: boolean }, ctx?: CastContext): void {
  const lvl = lv(def, rank);
  const unitId = lvl.summon || SUMMON_FALLBACK[def.code] || "";
  if (!unitId) return;
  const count = opts.count > 0 ? opts.count : Math.max(1, d(lvl, 1, d(lvl, 0, 1)));
  const x = opts.atPoint && ctx ? ctx.x : caster.x;
  const y = opts.atPoint && ctx ? ctx.y : caster.y;
  // The summon burst rides each unit (requestSummon's `art.summon`), fired where it
  // actually materializes. It used to be emitted once, here, at the CASTER's feet — so
  // three wolves fanned out around the Far Seer shared a single puff behind them.
  summonMany(api, caster, def, unitId, x, y, count, lvl.heroDuration || lvl.duration || 60, opts.atPoint);
}

/** One stat effect an aura grants to a unit in range. */
export interface AuraEffect {
  kind: BuffKind;
  value: number;
  value2?: number;
  rangedOnly?: boolean; // only benefits units with a ranged weapon (Trueshot)
  meleeOnly?: boolean; // only benefits melee units (Vampiric)
  /** Seconds the buff LINGERS once applied, for auras whose effect outlives the radius.
   *  Omitted for an ordinary aura, which re-applies on a short TTL and therefore fades the
   *  moment its holder walks out (see AURA_REFRESH). Disease Cloud is the exception the
   *  field exists for: catching the plague is not "standing in the cloud", and its own
   *  column says so — dataA is named "Aura Duration" and reads 120 seconds. */
  duration?: number;
  /** `value` is a FRACTION OF THE TARGET'S MAXIMUM, not a flat amount — so it can only be
   *  resolved once the target is known (the world multiplies it out). The regeneration
   *  auras say so in the data: their second Data column is literally named "Percentage"
   *  (AbilityMetaData → WESTRING_AEVAL_OAR2 / _NRE2) and reads 1, while the first holds
   *  0.01. A Fountain of Health restores 1% of a unit's max life per second, which is a
   *  very different thing for a Peasant than for a Mountain Giant. */
  pctOfMax?: boolean;
}

/** Passive auras, applied each tick by the world to the caster + nearby allies.
 *  Keyed by base `code` → the effect(s) each aura grants at the shown level. Data
 *  columns verified against the MPQ + Liquipedia (see docs/REFERENCES.md). */
export const AURA_BUFFS: Record<string, (lvl: AbilityLevel) => AuraEffect[]> = {
  AHad: (lvl) => [{ kind: "armor", value: d(lvl, 0, 1.5) }], // Devotion — +armour
  AHab: (lvl) => [{ kind: "manaRegen", value: d(lvl, 0, 0.75) }], // Brilliance — +mana regen/sec
  AOae: (lvl) => [{ kind: "haste", value: d(lvl, 0, 0.1), value2: d(lvl, 0, 0.1) }], // Endurance — +move & attack speed
  AUau: (lvl) => [
    { kind: "haste", value: d(lvl, 0, 0.1), value2: 0 }, // Unholy — +move speed
    { kind: "hpRegen", value: d(lvl, 1, 0.5) }, // …and hp regen
  ],
  AEar: (lvl) => [{ kind: "damagePct", value: d(lvl, 0, 0.1), rangedOnly: true }], // Trueshot — +ranged damage
  AOac: (lvl) => [{ kind: "damagePct", value: d(lvl, 0, 0.1) }], // Command — +attack damage
  AUav: (lvl) => [{ kind: "lifesteal", value: d(lvl, 0, 0.15), meleeOnly: true }], // Vampiric — melee life steal
  AEah: (lvl) => [{ kind: "thorns", value: d(lvl, 0, 0.1) }], // Thorns — return melee damage
  Aakb: (lvl) => [{ kind: "damagePct", value: d(lvl, 0, 0.1) }], // War Drums (Kodo) — +attack damage
  // Disease Cloud (Abomination) — the one HOSTILE aura here. Its targs1 is
  // `ground,enemy,organic,neutral`, so unlike every entry above it lands on enemies, and
  // the world picks the side off those flags rather than a rule in the code. dataB is
  // "Damage per Second" (1) and dataA "Aura Duration" (120), the latter being why the
  // plague follows a unit that walks out of the cloud instead of ending at its edge.
  Aapl: (lvl) => [{ kind: "dot", value: d(lvl, 1, 1), duration: d(lvl, 0, 120) }],
  // --- the two REGENERATION auras, and what a Fountain actually is -------------------
  //
  // A Fountain of Health (`nfoh`) and a Fountain of Mana (`nmoo`) carry no special code:
  // `Units\UnitAbilities.slk` gives them `Avul,ACnr` and `Avul,ANre`, and those two rows are
  // ordinary auras whose base codes are `Aoar` and `Aarm`. So a fountain is a building
  // standing inside its own aura, and implementing the aura is implementing the fountain.
  //
  // Both read the same pair of columns (`AbilityMetaData` useSpecific `Aoar,ACnr,Aabr` and
  // `ANre,Aarm`): DataA "Amount Regenerated" = 0.01 and DataB "Percentage" = 1 — one percent
  // of the target's MAXIMUM per second, inside 500. The same code is the Healing Ward's
  // (`Aoar` itself, at 2%) and the Marketplace statue's (`Aabr`, 0.4% over 700), so all three
  // land here together.
  //
  // Note what the flags do NOT say: `ground,air,organic,vuln,invu` names neither `friend` nor
  // `enemy`, and a fountain really does heal whoever stands in it — including the enemy army
  // camped on top of it. `organic` is the one restriction, which is the description's own
  // wording ("Regenerates the health of all non-mechanical units nearby"). The world reads
  // both off `targs1` rather than assuming an aura is friendly (see applyAuras).
  Aoar: (lvl) => [{ kind: "hpRegen", value: d(lvl, 0, 0.01), pctOfMax: d(lvl, 1, 1) !== 0 }],
  Aabr: (lvl) => [{ kind: "hpRegen", value: d(lvl, 0, 0.004), pctOfMax: d(lvl, 1, 1) !== 0 }],
  Aarm: (lvl) => [{ kind: "manaRegen", value: d(lvl, 0, 0.01), pctOfMax: d(lvl, 1, 1) !== 0 }],
};
