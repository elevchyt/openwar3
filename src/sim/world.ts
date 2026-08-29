import { BUILD_CELL, BUILD_CELL_CELLS, PATHING_CELL, footprintCells, type PathDomain, type PathingGrid } from "./pathing";
import { findPath, smoothPath } from "./pathfind";
import { targsKindError } from "./targeting";
import { corpseAdmits, corpseMissingError, corpseReach, spawnsFromCorpse, type CorpseNeed, type CorpseOrder } from "./corpses";
import { footprintBuildable, footprintRadius, stampFootprint, unstampFootprint, type Footprint } from "./destructibles";
import { BlightGrid } from "./blight";
import { type AbilityRegistry, type AbilityDef, type AbilityLevel, type BuffFx, emptyAbilityLevel, isCriticalStrikeCode, isRepairCode, requiredHeroLevel, KNOWN_ABILITIES } from "../data/abilities";
import { type ItemRegistry, type ItemDef } from "../data/items";
import { slotMissileArt, type UnitDef, type UnitRegistry } from "../data/units";
import { type TechRegistry } from "../data/techtree";
import { RACE_INDEX, type PlayableRace } from "../data/races";
import { type UpgradeRegistry } from "../data/upgrades";
import { TechState } from "./tech";
import {
  ENABLED_ATTACK_INDEX,
  SLOWED_ATTACK,
  SLOWED_MOVE,
  STACK_DAMAGE,
  abilityOrbTier,
  isArrowOrb,
  isOrbCode,
  itemOrbTier,
  pickOrb,
  type OrbCandidate,
} from "./orbs";
import { AttackType, ArmorType, MoveType, PrimaryAttribute, RegenType, WeaponType, isRangedWeapon, launchesMissile } from "../data/enums";
import {
  MISC_DATA,
  MISC_GAME,
  MELEE,
  GAME_HOURS_PER_SEC,
  armorDamageReduction,
  creepXpFactor,
  damageMultiplier,
  etherealDamageMultiplier,
  ETHEREAL_SPELL_BONUS,
  grantedXp,
  heroReviveVitals,
  xpToReachLevel,
  type ReviveMode,
} from "../data/gameplayConstants";
import { simProfile } from "./profile";
import { SPELL_HANDLERS, AURA_BUFFS, POLARITY_SPELLS, HEAL_SPELLS, MANA_TARGET_SPELLS, waveSchedule, WAVE_FIELDS, fx, buffIdOf, drainTag, DRAIN_GROUP, POSSESSION_GROUP, type SpellApi, type SimBuffInit, type SpellFieldInit, type CastContext, type WaveOptions, type RaiseOptions } from "./spells";

// Headless simulation (plan §1.4, Phase 5/6). Owns unit game-state; the renderer
// only displays it. Fixed-timestep, no rendering or DOM deps — runnable in tests
// and (later) on the authoritative server.

/** Weapon stats (from UnitWeapons.slk). Damage per swing = damage + dice d sides,
 *  reduced by the target's armor (WC3 formula). */
export interface SimWeapon {
  // Live values — recomputeStats() rebuilds these every tick from the base* baselines below,
  // so a mid-game Forged Swords lifts every Footman already on the field.
  damage: number;
  dice: number;
  sides: number;
  cooldown: number; // seconds between swings
  damagePoint: number; // seconds from swing start to the strike/projectile launch
  /** Seconds of follow-through AFTER the strike. Never gates the cooldown. Hasted/slowed with
   *  the damage point, so the pair's live/base ratio recovers the attack-speed factor — which
   *  is the rate the renderer plays the swing clip at (see rts.ts attackAnimRate). */
  backswing: number;
  range: number; // measured between collision hulls, WC3-style
  // Pre-upgrade baselines, straight off this slot's UnitWeapons columns.
  baseDamage: number;
  baseDice: number;
  baseRange: number;
  baseCooldown: number;
  baseDamagePoint: number;
  baseBackswing: number;
  /** Whether this slot may be used at all: its bit in `weapsOn`, which the `renw` upgrade
   *  effect can rewrite (Flying Machine Bombs switches the bomb slot on). See WeaponSlotDef. */
  enabled: boolean;
  /** "Targets Allowed" (`targs1`/`targs2`). A weapon strikes a target only if its list admits
   *  it — `air` for a flyer, `structure` for a building, `ground` for everything else — which
   *  is why a Footman cannot answer a Gryphon Rider and a Siege Engine only knocks down walls.
   *  Empty = unrestricted (a summon or custom unit with no data). See weaponVs(). */
  targets: string[];
  // Line-splash ("spill"): the hit carries down the missile's line, `spillDist` past the
  // target, catching anything within `spillRadius` of it and shedding `damageLoss` of the
  // damage per further body. Storm Hammers (`rasd`) is nothing but a spillDist of 200.
  spillDist: number;
  spillRadius: number;
  baseSpillDist: number; // pre-upgrade (`rasd`/`rasr` add to these, as Long Rifles adds to range)
  baseSpillRadius: number;
  damageLoss: number;
  /** AREA splash — the three concentric rings an ARTILLERY shot lands in (`Farea`/`Harea`/
   *  `Qarea`; see WeaponSlotDef). Nonzero only on the siege weapons: Cannon Tower, Demolisher,
   *  Mortar Team, Glaive Thrower. See spawnProjectile / applyAreaSplash. */
  areaFull: number;
  areaHalf: number;
  areaQuarter: number;
  /** …and what SHARE of the damage each outer ring gets (`Hfact`/`Qfact`). Not a half and a
   *  quarter: 26 of the 73 splashing slots say otherwise, the whole siege roster among them.
   *  See WeaponSlotDef.areaHalfFactor. */
  areaHalfFactor: number;
  areaQuarterFactor: number;
  splashTargets: string[]; // `splashTargs` — what the area may catch
  /** `weapTp` — artillery shots fly at the GROUND, everything else homes (see spawnProjectile). */
  weaponType: WeaponType;
  showUI: boolean; // `showUI` — does this attack get an Attack command on the card
  acquire: number; // auto-acquisition range (0 = never auto-attacks)
  ranged: boolean; // fires a travelling projectile instead of hitting instantly
  missileArt: string; // projectile model path (renderer), "" = invisible
  missileSpeed: number; // projectile travel speed (world units/sec)
  /** This slot's weapon-impact base, paired with the TARGET's material to name the clang
   *  (`weapType1/2` — see WeaponSlotDef.weaponSound). It rides the SLOT rather than being
   *  read off the def at the blow, because which slot is swinging is a RUNTIME fact: an orb
   *  wakes a hero's dormant air attack (`DataE`) and `renw` switches the Flying Machine's
   *  bombs on, and neither touches the def the summary was derived from. */
  weaponSound: string;
  attackType: AttackType; // UnitWeapons atkType1 → picks the damage-table row
  // Projectile launch offset (LOCAL frame: x forward, y left, z up; rotated by facing)
  // and impact height — UnitWeapons.slk launchx/y/z, impactz. The missile leaves from
  // launchZ (e.g. the Archmage's rod at 66) rather than the unit's feet.
  launchX: number;
  launchY: number;
  launchZ: number;
  impactZ: number;
}

/** An in-flight projectile: homes on its target's current position, dealing its
 *  pre-rolled damage on arrival (the renderer draws + moves the missile model). */
export interface SimProjectile {
  id: number;
  x: number;
  y: number;
  z: number; // current height ABOVE GROUND (renderer adds terrain height under x/y)
  sourceId: number; // attacker (for retaliation on hit); may have died mid-flight
  targetId: number;
  speed: number;
  damage: number; // pre-armor damage rolled at launch (armor applied on impact)
  art: string; // missile model path
  // Straight-line height interpolation launch→impact (all above-ground): z lerps from
  // startZ (the launch height) to impactZ across the horizontal flight (startDist).
  startZ: number;
  impactZ: number;
  startDist: number;
  attackType?: AttackType; // attacker's weapon attack type, carried so the damage-table
  // multiplier is correct even if the attacker dies before the arrow lands
  /** The firing weapon's impact base, carried for the same reason `attackType` is: the shot
   *  must land the clang of the weapon that LOOSED it, whatever has become of the shooter —
   *  it may have died, been morphed, or had a different slot switched on mid-flight. */
  weaponSound?: string;
  /** Line-splash, carried from the weapon so the hit spills even if the shooter dies in
   *  flight. `ox`/`oy` is the launch point — the line's direction is impact-minus-launch,
   *  and the spill runs on PAST the target from there. See applySpill. */
  spill?: { dist: number; radius: number; loss: number; ox: number; oy: number };
  /**
   * An ARTILLERY shot: it is thrown at the GROUND, not at a unit. `aimX`/`aimY` is where the
   * target stood at the loosing, and the shell flies there whatever the target does next —
   * which is why a Demolisher, a Mortar Team and a Cannon Tower can all be dodged by walking
   * out of the way, while a Guard Tower's homing arrow cannot. On arrival it damages
   * everything in its rings rather than the one unit it was aimed at (see applyAreaSplash).
   */
  area?: {
    aimX: number; aimY: number;
    /** The three rings, and the fraction of the damage each of the outer two gets. The
     *  fractions travel with the shot because they are the SLOT's (`Hfact`/`Qfact`) and not
     *  a rule — see WeaponSlotDef.areaHalfFactor. */
    full: number; half: number; quarter: number;
    halfFactor: number; quarterFactor: number;
    targets: string[];
  };
  /**
   * A WAVE: the travelling front of a line spell (Shock Wave, Carrion Swarm, Breath of
   * Fire). Aimed at a direction rather than a unit, and unlike every other projectile it
   * does its work ON THE WAY — each unit the front sweeps past takes the spell as it is
   * reached, once (`hit`), and the wave carries on to `dist`. That is why these spells
   * ship a `Missileart` and no target art at all: the missile IS the spell, and its
   * `Missilespeed` is how long the line takes to arrive.
   *
   * `ox`/`oy` is the launch point and `dirX`/`dirY` the unit direction, both fixed at the
   * cast — a wave does not follow the caster who threw it.
   */
  wave?: {
    ox: number; oy: number; dirX: number; dirY: number; dist: number; travelled: number;
    halfWidth: number; budget: number; hit: number[];
    /** A wave whose art is the GROUND it passes over rather than a model in flight
     *  (Impale's tendrils): drop `art` every `step` units, `next` being the mark the front
     *  has to pass for the next one. Such a wave carries no missile of its own. */
    trail?: { art: string; step: number; next: number };
  };
  // Spell projectiles (Storm Bolt, Death Coil) run an ability effect on impact
  // instead of dealing plain `damage` — the base code + rank to dispatch.
  spell?: { code: string; rank: number; abilityId: string };
  /** The ORB effect this shot carries, resolved and paid for at the launch (see
   *  World.resolveOrb). It travels with the missile because the orb is what the missile is
   *  DRAWN as — swapping art at launch and re-resolving at impact could disagree. */
  orb?: ResolvedOrb;
}

/** One lightning bolt the renderer should string up (issue #97).
 *
 *  A lightning is NOT a model: it is a ribbon between two points that follows them for as
 *  long as it lives (src/data/lightning.ts, src/render/lightningOverlay.ts). Both ends are
 *  given as a unit id AND a position: the id wins while that unit lives (so the bolt tracks
 *  a target that walks away, exactly as WC3's does), and the position is where it stays
 *  anchored once the unit is gone — an end that just vanished mid-bolt looks like a bug.
 *  `sz`/`tz` are heights ABOVE GROUND; the renderer adds the terrain under each end. */
export interface SimLightning {
  id: string; // LightningData row ("CLPB", "AFOD", …)
  sourceId: number; // 0 = a fixed point
  targetId: number;
  sx: number;
  sy: number;
  sz: number;
  tx: number;
  ty: number;
  tz: number;
  /** How long the bolt is visible, seconds. From the ability where the data says so
   *  (Finger of Death's "Graphic Duration", Mana Burn's "Bolt Lifetime"); 0 = use the
   *  LightningData row's own fade `Duration`. */
  life: number;
  /** Seconds before it appears — Finger of Death's "Graphic Delay", and what staggers a
   *  Chain Lightning's bounces so the bolt visibly walks down the chain. */
  delay: number;
  /** An owner key, for a bolt that can end EARLY. A Drain's tether is strung for the
   *  channel's full duration, but the channel can break — so the drain tags its bolt
   *  `drain:<casterId>` and the sim asks the renderer to cut it (`drainLightningStops`).
   *  A bolt with no tag simply lives out its `life`. */
  tag?: string;
}

/**
 * One piece of floating COMBAT text — the world-space number the engine itself puts over a
 * unit, as opposed to the `texttag` a script asks for with CreateTextTag (7.19). WC3 raises
 * these off its own resolution and none of them is scriptable:
 *
 *  • `crit` — a Critical Strike's blow, drawn in red as the damage dealt with an exclamation
 *    mark after it ("127!"), over the unit that was struck. It follows the victim.
 *  • `deny` — a bare "!" over one of YOUR OWN or an ALLY's units that a friendly killed, in
 *    the colour of the player the dead unit belonged to. It is why a deny reads as a deny.
 *  • `gold` / `lumber` — a "+N" in the game's own gold or green, wherever the engine CREDITS
 *    you where you can see it: a worker laying its load down at the hall (depositLoad — the
 *    commonest one by far, and the pair of `GoldText*`/`LumberText*` rows exists for it),
 *    Transmute's payout over the body it melted (transmuteInternal) and a shop's over the hero
 *    it just bought an item back from (pawnItem, issue #120).
 *  • `bounty` — a slain creep's payout, over the body (awardBounty). The same gold as a `gold`
 *    credit down to the byte, but its own longer-lived row (`BountyText*`): a bounty is raised
 *    mid-fight and has to outlast it.
 *  • `xp` — the experience a kill hands a hero, over that hero (awardKillXp). The one kind
 *    the 1.30.4 client does NOT raise: it arrived with Reforged, which is also why it is the
 *    one with no row of its own in `UI\MiscData.txt`. Requested in issue #116.
 *
 * The colour of a deny is a SLOT, not an RGB: `SetPlayerColor` can move a slot's colour under
 * the match (see RtsController.playerColor), and the sim does not track that — the client
 * resolves it against the same palette the minimap dots and the cinematic speaker names use.
 * `x`/`y` is where it happened: the anchor for a deny (whose unit is already gone by the time
 * anyone draws it) and the area-of-interest test the host filters recipients by.
 */
export interface CombatText {
  kind: "crit" | "deny" | "gold" | "lumber" | "bounty" | "xp";
  /** The unit the text floats over, and follows. 0 for a deny — the victim is dead. */
  unitId: number;
  x: number;
  y: number;
  text: string;
  /** `deny` only: the slot whose COLOUR the "!" wears (the dead unit's owner). -1 for a crit,
   *  which is red for everyone. */
  colorSlot: number;
  /**
   * Whose SCREEN this belongs on: a player slot, or -1 for "everyone who can see the spot".
   *
   * A blow is a public fact — the crit landed, the ally was denied, and every client watching
   * that patch of ground saw it happen. **Being paid is not.** Your gold is yours: WC3 floats
   * a resource credit on the receiving player's screen alone, and an opponent who happens to
   * have vision of your hero learns nothing from watching him sell a Claws of Attack. The same
   * goes for what a kill paid you, in gold or in experience. So every CREDIT kind (`gold`,
   * `lumber`, `bounty`, `xp`) carries the owner here, and it is enforced twice — the host
   * declines to put the
   * text in anyone else's payload (MatchLink.tickHost) and every client's renderer drops one
   * addressed to a player it is not (see drainFxCombatTexts' consumer). Two gates because
   * either one alone leaks: filtering only on the wire still shows it on the HOST's own
   * screen, and filtering only at the renderer still ships the number to a machine that can
   * read its own network traffic.
   */
  forPlayer: number;
}

/** A unit type's weapon slots as the sim wants them (see WeaponSlotDef for the data behind
 *  each one). A slot carrying no damage at all is dropped — that is how a Town Hall, which has
 *  a UnitWeapons row like everything else, ends up unarmed. A DISABLED slot is KEPT: the Flying
 *  Machine's bombs must be sitting there, switched off, for Flying Machine Bombs to switch on. */
export function weaponsFromDef(def: UnitDef): SimWeapon[] {
  const out: SimWeapon[] = [];
  for (const s of def.weapons) {
    if (s.cooldown <= 0 || s.damage + s.dice * s.sides <= 0) continue;
    // Ranged is `weapTp`'s call alone — NOT "has a missile model". A melee hero's row
    // carries a `Missileart` for the air attack an orb wakes (see units.ts), so reading
    // the art as the signal made every one of them a thrower. slotMissileArt() asks the
    // same column what art, if any, this slot may show.
    const ranged = isRangedWeapon(s.weaponType);
    out.push({
      damage: s.damage,
      dice: s.dice,
      sides: s.sides,
      cooldown: s.cooldown,
      damagePoint: s.damagePoint,
      backswing: s.backswing,
      range: s.range,
      baseDamage: s.damage,
      baseDice: s.dice,
      baseRange: s.range,
      baseCooldown: s.cooldown,
      baseDamagePoint: s.damagePoint,
      baseBackswing: s.backswing,
      enabled: s.enabled,
      targets: s.targets,
      spillDist: s.spillDist,
      spillRadius: s.spillRadius,
      baseSpillDist: s.spillDist,
      baseSpillRadius: s.spillRadius,
      damageLoss: s.damageLoss,
      areaFull: s.areaFull,
      areaHalf: s.areaHalf,
      areaQuarter: s.areaQuarter,
      areaHalfFactor: s.areaHalfFactor,
      areaQuarterFactor: s.areaQuarterFactor,
      splashTargets: s.splashTargets,
      weaponType: s.weaponType,
      showUI: s.showUI,
      // `acquire`, and the launch/impact offsets, are UNIT columns — not per-weapon ones.
      acquire: def.acquireRange,
      ranged,
      missileArt: slotMissileArt(s),
      weaponSound: s.weaponSound,
      missileSpeed: s.missileSpeed,
      attackType: s.attackType,
      launchX: def.launchX,
      launchY: def.launchY,
      launchZ: def.launchZ,
      impactZ: def.impactZ,
    });
  }
  return out;
}

export type SimOrder = "idle" | "move" | "attackmove" | "patrol" | "hold" | "attack" | "follow" | "harvest" | "return" | "repair" | "cast" | "getitem" | "garrison";

/** A learned/innate ability on a unit. `code` is the base ability code (dispatch
 *  key — see data/abilities). `level` 0 = a hero ability not yet learned. */
export interface SimAbility {
  id: string; // alias (for tooltip/icon lookup in the registry)
  code: string; // base ability code — spell dispatch key
  level: number; // current rank (0 = unlearned hero ability, ≥1 = active)
  cooldownLeft: number; // seconds until castable again
  autocastOn: boolean; // autocast toggle (Heal/Slow/…)
}

/** A timed effect on a unit. `kind` is our gameplay category; `group` de-dupes
 *  non-stacking sources (e.g. two Devotion Auras → one armour buff, the larger). */
export interface SimBuff {
  kind: BuffKind;
  group: string; // non-stacking key ("" = always its own instance)
  timeLeft: number; // seconds (Infinity for auras, refreshed while in range)
  sourceId: number;
  value: number; // primary magnitude (armour, slow %, hp/sec, damage, …)
  value2: number; // secondary magnitude (e.g. attack-speed slow)
  art: string; // fx[0]'s path — the primary attached model (renderer), "" = none
  /** Every persistent model this buff hangs on the unit, with its attachment point
   *  (see AbilityDef.buffFx). Usually one; Bloodlust wears two, Spiked Carapace four. */
  fx: BuffFx[];
  /** The `B….` row this buff IS ("" when nothing named one). The info panel's Status row
   *  takes its icon, name and tooltip straight off it — see BuffDef and statusBuffsFor. */
  buffId: string;
  /** Seconds until the buff's effect actually engages — Wind Walk's "Transition Time"
   *  (AbilityData.slk AOwk DataA = 0.6), the beat between the cast and the vanish. The
   *  buff exists and its duration is already running; it just isn't in force yet. 0 for
   *  everything else, which engages the instant it lands. */
  delay: number;
  /** Shadow Meld (`Ashm`), the one invisibility that is a STANCE rather than a spell. It
   *  never expires on a clock — it holds for as long as its conditions do — so it breaks on
   *  two things no other invisibility cares about: the unit MOVING, and DAY breaking. Both
   *  are checked in tickMeld; everything else (attack, cast) reveals it through the shared
   *  breakInvisibility path, same as Wind Walk. */
  meld?: boolean;
  /** A `dot` that cannot land the killing blow: it stops at 1 hp. Every WC3 POISON is one —
   *  "the poison damage is 8 damage per second and is non-lethal" (Liquipedia, Orb of Venom)
   *  — which is why a Dryad's Slow Poison whittles a fleeing unit down and never finishes it.
   *  Liquid Fire and the other damage-over-time effects are ordinary and DO kill. */
  nonLethal?: boolean;
  /** A buff with no clock: it holds until the unit is at FULL HIT POINTS. The Staff of
   *  Sanctuary is the only one — "Lasts until the unit is fully healed" (Liquipedia), and
   *  its `ANsa` row indeed carries no `Dur1`/`HeroDur1` at all, which is the data saying the
   *  same thing. Both halves of the effect (the regeneration and the stun that pins the
   *  unit while it runs) wear the flag, so they end together. `timeLeft` is Infinity. */
  untilHealed?: boolean;
  /** Dispel Magic and its kin may not take this off. Doom is the one that needs it — the
   *  ability's whole point is that it "cannot be dispelled", and its row proves the intent
   *  by carrying no duration column at all: the curse runs until it kills. */
  undispellable?: boolean;
}

/** The ORB EFFECT one blow carries, once the priority ladder has picked it (see
 *  src/sim/orbs.ts and World.resolveOrb). Resolved when the attack is delivered, applied
 *  when it lands — for a ranged attacker those are a flight apart, so it rides the missile. */
export interface ResolvedOrb {
  def: AbilityDef; // the exact ability — its art, its missile, its Data columns
  rank: number;
  lvl: AbilityLevel; // that rank's numbers
  /** The other orb abilities the SAME ITEM grants, which win or lose with this one: the Orb
   *  of Venom is `AIpb` (+5 damage) plus `Apo2` (the poison), and the RoC Orb of Lightning
   *  is `AIlb` plus `AIlp` (the purge). Empty for an ability orb. */
  extra?: ResolvedOrb[];
}

export type BuffKind =
  | "stun" // cannot act
  | "slow" // value = move-slow fraction, value2 = attack-slow fraction
  | "haste" // value = move bonus fraction, value2 = attack-speed bonus fraction
  | "invuln" // immune to damage + enemy targeting (Divine Shield)
  | "armor" // value = flat armour bonus (Devotion Aura, Inner Fire)
  | "manaRegen" // value = flat mana/sec bonus (Brilliance Aura)
  | "damage" // value = flat attack-damage bonus (Inner Fire)
  | "damagePct" // value = fraction of base damage added (Command/Trueshot Aura)
  | "hpRegen" // value = flat hp/sec bonus (Unholy Aura)
  | "lifesteal" // value = fraction of melee damage dealt healed back (Vampiric Aura)
  | "thorns" // value = fraction of melee damage returned to the attacker (Thorns Aura)
  | "hot" // value = hp/sec healed
  | "dot" // value = dps taken
  | "sleep" // cannot act (like stun) but wakes the instant it takes damage (Sleep)
  | "silence" // cannot cast spells (Silence, Soul Burn) — can still move & attack
  | "manaShield" // absorb incoming damage into mana instead of hp; value = mana spent per hp
  | "root" // value = move-slow fraction (Entangling Roots pins to 1.0); can still attack
  | "vuln" // value = fraction of EXTRA damage the holder takes (Berserk +50%)
  | "miss" // value = chance this unit's attacks simply MISS (Drunken Haze's `Nsi2 "Chance To
  //         Miss (%)"`). Not a slow and not a damage cut — the blow is rolled and thrown away,
  //         which is why it stacks with neither.
  | "strength" // value = flat bonus STRENGTH on a hero (Robo-Goblin's `Nrg5 "Strength Bonus"`).
  //             Not the same as `maxHp`: strength is a hero ATTRIBUTE, so the info panel shows
  //             it, it carries hit points at HP_PER_STR, and it carries attack damage too when
  //             Strength is the hero's primary — which for the Tinker it is.
  | "maxHp" // value = flat bonus to the MAXIMUM life pool (Metamorphosis' `Eme5 "Alternate
  //          Form Hit Point Bonus"` = 500). Goes through the same ratio-preserving ceiling
  //          move every other bonus does (see recomputeStats), so the demon arrives as
  //          healthy as the Demon Hunter was.
  | "mark" // no effect of its own: a timed FLAG the holder wears (Black Arrow's, whose whole
  //          point is what happens if the holder dies before it expires — see orbDeathEffects)
  | "spellAbsorb" // Anti-magic Shell (`Aam2` DataC "Max Damage Absorbed" = 300): value = the
  //                 POOL of spell damage still left to soak. Unlike every other buff here it
  //                 is SPENT rather than merely read — each point of spell damage it eats
  //                 comes off `value`, and the buff goes when the pool does, whatever its
  //                 clock says. See SpellApi.spellDamage, the one seam every spell's damage
  //                 passes through. (The pre-TFT rows `Aams`/`ACam` carry DataC = 0: a
  //                 different shell entirely — "cannot be targeted by spells" — which this
  //                 does not model, so a zero pool simply grants nothing.)
  | "shield" // Lightning Shield: value = dps dealt to units around the holder, value2 = radius
  | "ethereal" // Banish: value = move-slow fraction; can't attack, immune to physical
  //            damage but takes +66% from Magic/Spells (see u.ethereal, EtherealDamageBonus)
  | "magicImmune" // TIMED magic immunity — the Anti-magic Potion's 15 seconds (`Aami`, whose
  //                 buffs are `Bams,Bam2`). Distinct from `spellAbsorb`: this row carries no
  //                 "Max Damage Absorbed" column at all, so it is the pre-TFT shell that
  //                 cannot be TARGETED by magic rather than the one that soaks a pool. The
  //                 permanent twin (a Necklace of Spell Immunity, a Spell Breaker) is a
  //                 property of the ability list and needs no buff — see u.magicImmune.
  | "spellShield" // Spell Shield (`ANss` on the Amulet, `ANse` on the Rune of Shielding):
  //                 BLOCKS the next negative spell an enemy casts on the holder, then goes.
  //                 Spent rather than merely read, like `spellAbsorb` — see spellShieldBlocks.
  | "invisible"; // Wind Walk/Invisibility: the holder renders half-faded (see u.invisible).
  //             CONCEALMENT is modelled — canSee() refuses an invisible unit, so it draws no
  //             aggro down any automatic path — and so is its counterpart, True Sight
  //             (`u.detectRadius`, teamDetects). The SCREEN follows the same rule: rts.ts
  //             (invisHides) hides the unit outright from a viewer who neither owns it nor
  //             detects it, and fades it for the ones who may see it.

/** An in-progress spell cast (order === "cast"). The lifecycle, matching WC3
 *  (hiveworkshop "Cast Point and Backswing Point" thread 265781): walk into range
 *  and face → WIND UP for the cast point (unit `castPoint` + the ability's own
 *  Casting Time) → at its end the effect FIRES and mana/cooldown are committed →
 *  then either CHANNEL (the caster stands locked; a new order stops it and the
 *  remaining ticks) or play a cast BACKSWING (pure recovery a new order cancels
 *  for free — the effect already happened, so canceling costs nothing: the
 *  "animation canceling" micro). Interrupting DURING the wind-up cancels the spell
 *  entirely (no effect, no mana, no cooldown), since nothing has committed yet. */
export interface PendingCast {
  code: string; // base ability code (dispatch)
  abilityId: string; // the SimAbility on the caster (for cooldown/mana)
  rank: number; // ability level being cast
  targetId: number; // unit target (0 = none)
  x: number; // point target
  y: number;
  range: number; // cast range (hull-to-hull); 0 = self/no-target
  castLeft: number; // remaining wind-up before the effect fires (-1 = not yet started)
  started: boolean; // wind-up begun (facing done, cast animation playing)
  committed: boolean; // mana/cooldown already spent (Flame Strike commits at wind-up start)
  fired: boolean; // the effect has fired (mana/cooldown committed) — now channel/backswing
  channelLeft: number; // remaining channel time — the caster stands + holds (Blizzard, Starfall)
  backLeft: number; // remaining cast backswing (recovery) after a non-channelled effect
  // The cast has run its course (endCast fired its SPELL_FINISH/ENDCAST). Set so a
  // stale pendingCast left behind by a resumed order can't raise a second ENDCAST
  // when the unit is later stopped (see clearCast — 7.17).
  ended: boolean;
  // Started by AUTOCAST rather than by a player/trigger order. An autocast reaches past its
  // cast range (see autocastSearchRange), so the caster may spend a second or two walking —
  // and in that time somebody else may heal the ally it set out for. The approach re-checks
  // `autocastWants` each tick for these, so the caster gives up instead of arriving to spend
  // mana on a target it would no longer have chosen. An ORDERED cast never gives up: the
  // player asked for it.
  auto: boolean;
  // The order to resume after the cast (so an autocast/manual cast mid attack-move,
  // follow, HOLD or COMMANDED attack continues afterward instead of falling idle).
  resume: { kind: "attackmove"; x: number; y: number } | { kind: "follow"; id: number } | { kind: "attack"; id: number; force: boolean } | { kind: "hold" } | null;
}

/** A corpse left by a dead unit (Liquipedia: Corpse). Persists on the ground,
 *  decaying flesh→bone, and is a targetable entity for corpse-consuming spells
 *  (Raise Dead, Cannibalize, Resurrection, Meat Wagon). */
export interface SimCorpse {
  id: number;
  deadId: number; // the dead unit's sim id (renderer adopts its model as the corpse)
  unitId: string; // the dead unit's type (renderer reuses/re-spawns its model)
  x: number;
  y: number;
  facing: number;
  owner: number;
  isHero: boolean; // hero corpses can't be raised (they revive at an altar instead)
  mechanical: boolean; // mechanical/summoned units leave no raisable corpse
  decayLeft: number; // seconds until the corpse fully decays and is removed
  /** The unit CARRYING this body, or 0 for one lying on the ground (see corpses.ts). Only the
   *  Meat Wagon does this; its cargo stays usable where it stands. */
  heldBy: number;
  raised: boolean; // consumed by a spell (renderer hides it immediately)
}

/** An item held in a hero's inventory (one of 6 slots). Its stat bonus / active
 *  effect is derived from the item def's granted abilities (world.ts item logic),
 *  keyed by the base ability `code` — the same dispatch model spells use. */
/** Everything a copy needs to be indistinguishable from its original. Captured at cast time
 *  and carried through the summon request (spawning is async — see drainSummonRequests). */
export interface IllusionInit {
  dealt: number; // fraction of the copy's damage that lands (0)
  taken: number; // multiplier on damage it receives (2)
  properName: string; // the original's given name
  mana: number; // the original's pool after the cast was paid
  level: number; // the original's hero level
  baseStr: number; // base attributes INCLUDING permanent tome gains
  baseAgi: number;
  baseInt: number;
  baseMaxHp: number; // includes Manual of Health
  inventory: ({ itemId: string; charges: number } | null)[]; // what it is seen carrying
}

/** A unit a spell asked to be brought into the world this tick. The sim owns no model
 *  instances, so spawning is deferred to the renderer exactly like training is. */
/** A corpse a cast has TAKEN — where it lay, which way it faced, and what it used to be.
 *  Everything a raise needs and nothing a corpse still on the ground would carry: by the
 *  time a handler sees one of these the body is already spent. */
/** How a claim is being made: which bodies qualify, how to choose between them, and whether
 *  the taker is spending them or carrying them. */
export interface CorpseClaim extends CorpseNeed {
  order?: CorpseOrder;
  /** Load into the caster's cargo rather than consume (the Meat Wagon, and only it). */
  hold?: boolean;
}

export interface ClaimedCorpse {
  x: number;
  y: number;
  facing: number;
  unitId: string;
  owner: number;
}

export interface SummonRequest {
  unitId: string;
  x: number;
  y: number;
  facing: number;
  owner: number;
  team: number;
  summonLeft: number; // >0 = a temporary summon, seconds until it expires
  sourceId: number; // the caster
  summonArt: string; // the burst it materializes in
  unsummonArt: string; // the burst that replaces it when it leaves
  /** (x, y) is a point the player TARGETED (a ward, an infernal, a raised corpse) and the
   *  unit belongs exactly ON it. Without this the placement steps 96 units along `facing`
   *  first, which is right for a caster-relative summon and wrong for every targeted one
   *  (see MapViewerScene.summonSpot). */
  atPoint: boolean;
  /** The raised unit cannot be hurt at all. Animate Dead's `Hre2 "Raised Units Are
   *  Invulnerable"` = 1 is the only setter, and it is what the ultimate IS: six bodies that
   *  cannot be killed, only waited out. */
  invulnerable?: boolean;
  /** A RAISED SHELL, not a summoned creature: it stands up with its weapon and nothing else
   *  ("the raised units keep their attacks but lose all abilities and spells" — Animate
   *  Dead). Only the raise path sets it. It used to be inferred from `summonLeft > 0`, which
   *  is not the same fact at all — EVERY timed summon has one, so the Phoenix lost Phoenix
   *  Fire and the Avatar of Vengeance arrived with an empty command card. */
  stripped?: boolean;
  /** The summon lives only as long as its summoner does. Rare — a Water Elemental outlives
   *  the Archmage — and stated by the ability that says so: "Lasts 50 seconds or until the
   *  avatar dies" (`Avng`, the Avatar of Vengeance's Spirits). */
  bound?: boolean;
  illusion?: IllusionInit;
}

/**
 * A hero that has fallen — the whole of what an altar brings back.
 *
 * **A revived hero is the SAME hero, not a fresh one of the same type**, and that is the
 * entire feature: it stands up with its level, its experience, its unspent skill points, the
 * ranks it had learned, its inventory and its proper name. So the record is everything a
 * `SimUnit` carries that death would otherwise take with it, plus the two things a hero's
 * stats are derived from rather than stored as — its base attributes and base life, which is
 * where every Tome it ever drank lives (see `applyPowerup`).
 *
 * Keyed by the hero's own sim id. That id is its identity across death: the hero bar orders by
 * it, the revive job names it, and the button the player presses is the one that says which of
 * three dead heroes is coming back.
 */
export interface FallenHero {
  id: number;
  owner: number;
  team: number;
  typeId: string;
  properName: string;
  level: number;
  xp: number;
  skillPoints: number;
  abilities: SimAbility[];
  inventory: (HeldItem | null)[];
  baseStr: number;
  baseAgi: number;
  baseInt: number;
  baseMaxHp: number;
  /** Where it fell. Nothing reads it yet; the death alert already carries the same point, and
   *  a "return to where you died" mode would want it. */
  x: number;
  y: number;
  /** The building currently bringing it back, or 0 while it simply lies dead. One at a time:
   *  two altars must not both be paid to revive the same hero. */
  revivingAt: number;
  /**
   * Seconds until this hero's BODY is finished with — its death clip, then its Dissipate (whose
   * last second is the fade that takes the model off the field). See heroBodyTime. Counts down
   * to 0 and stays there.
   *
   * The hero is on the altar's roster from the instant it falls — its name and its portrait
   * are there at once, because a player must be able to see what they lost — but the revive
   * button is DEAD until this reaches zero. So the button lighting up and the body vanishing
   * are the same moment, which is what the original shows.
   *
   * Timed here rather than in the renderer because a match must play out the same with nothing
   * drawing it: a headless sim, a computer player's altar and a replay all revive on the same
   * clock as the screen does. Both of its terms are data values (UnitDef.deathTime + MiscData
   * DissipateTime), so the sim's clock and the model's are the same clock.
   */
  bodyLeft: number;
}

export interface HeldItem {
  /** Entity id — the SAME id space (and the same id) the item had on the ground.
   *  An item in WC3 is one entity that moves between the ground and an inventory,
   *  and a JASS `item` handle refers to it across that move: `CreateItem` →
   *  `UnitAddItem` → a PICKUP trigger's `GetManipulatedItem()` must all be the one
   *  item. So identity is carried through pickup/give/drop rather than re-minted
   *  (7.18) — without it the handle would go stale the moment a hero picked it up. */
  id: number;
  itemId: string; // item rawcode (ItemRegistry key)
  charges: number; // remaining uses (0 = a passive/permanent item, no active use)
  cooldownLeft: number; // seconds until this item can be used again
}

/** An item lying on the ground: droppable, pickable, and (in WC3) destructible.
 *  Not a SimUnit — a lightweight entity the renderer draws as the item's model. */
export interface SimItem {
  id: number; // sim entity id (own id space; kept when it moves into an inventory)
  itemId: string; // item rawcode
  x: number;
  y: number;
  charges: number; // charges carried onto the ground (restored when picked back up)
}

/** Where an item is right now — the one lookup the trigger engine needs, since a
 *  JASS `item` handle can refer to an item lying on the ground OR sitting in a
 *  hero's inventory (`holder`/`slot` are 0/-1 for a ground item). */
export interface ItemSnapshot {
  id: number;
  typeId: string; // item rawcode
  charges: number;
  x: number;
  y: number;
  holder: number; // sim id of the unit carrying it (0 = on the ground)
  slot: number; // inventory slot when held, else -1
  /** GetItemPlayer: the holder's owner, or Neutral Passive (15) for an item nobody
   *  carries — WC3 files every unowned item under that slot. */
  owner: number;
}

/** An item manipulated by a unit (EVENT_(PLAYER_)UNIT_PICKUP/DROP/USE/SELL_ITEM —
 *  7.18). The item is a SNAPSHOT, not a live reference, because the event is drained
 *  a tick after the sim raised it and the item may be gone by then (a tome is consumed
 *  on pickup; a potion's last charge destroys it) — GetManipulatedItem must still hand
 *  the script a usable handle, exactly as GetDyingUnit does for a corpse. */
export interface ItemEvent {
  unit: EventUnitInfo; // GetManipulatingUnit (the buyer, for a sale)
  item: { id: number; typeId: string; charges: number };
  phase: "pickup" | "drop" | "use" | "sell";
  /** GetSellingUnit — the SHOP, on a "sell". Blizzard.j's whole Marketplace restock cycle
   *  hangs off it: RemovePurchasedItem answers the sale with
   *  `RemoveItemFromStock(GetSellingUnit(), GetItemTypeId(GetSoldItem()))`. */
  seller?: EventUnitInfo;
}

/** A unit that just climbed into a cargo hold — EVENT_UNIT_LOADED / EVENT_PLAYER_UNIT_LOADED.
 *  `unit` is GetLoadedUnit (and the subject a unit-scoped registration watches: the campaign
 *  registers this event on the PASSENGER), `transport` is GetTransportUnit. */
export interface LoadEvent {
  unit: EventUnitInfo;
  transport: EventUnitInfo;
}

/** A creep's dropped-item table (from war3mapUnits.doo). Each SET drops (at most)
 *  one item, chosen among its entries by their `chance` percentages; multiple sets
 *  mean multiple independent drops. Ids may be real item rawcodes or a "random item
 *  of level N" marker resolved through the ItemRegistry. */
export interface ItemDropSet {
  items: Array<{ id: string; chance: number }>;
}

/** Attributes + growth for a hero, applied on spawn and each level-up. */
export interface HeroInit {
  /** The hero's randomly-drawn name ("Painkiller"), from the unit's `Propernames`
   *  list in Units\*UnitStrings.txt. "" for heroes with no list (custom units). */
  properName: string;
  level: number;
  str: number;
  agi: number;
  int: number;
  strPerLevel: number;
  agiPerLevel: number;
  intPerLevel: number;
  primaryAttr: PrimaryAttribute;
}

/** Active repair job on a worker: restore a building's HP over time for a
 *  fraction of its build cost (WC3: 35% of cost, 150% of build time to full). */
export interface RepairState {
  targetId: number;
  hpPerSec: number;
  goldPerHp: number;
  lumberPerHp: number;
  active: boolean; // arrived + hammering (drives the build animation)
}

/** Harvesting profile + carried load for worker units. */
/** The job a worker is put back on when it leaves a burrow (SimUnit.garrisonJob). Only the
 *  standing jobs a worker can be interrupted out of and dropped straight back into: gathering
 *  a named node, and mending a named building. A half-finished BUILD is not one of them — the
 *  foundation keeps its own builder list, and Battle Stations never pulls a peon off one. */
export type GarrisonJob =
  | { kind: "harvest"; res: "gold" | "lumber"; nodeId: number }
  | { kind: "repair"; buildingId: number; hpPerSec: number; goldPerHp: number; lumberPerHp: number };

export interface WorkerState {
  gold: boolean;
  lumber: boolean;
  /** The harvest ability this worker's `abilList` gives it (`Ahar`/`Ahrl`/`Awha`/`Aaha`) —
   *  the row every rate below is read from. See WorkerProfile and applyHarvestData. */
  harvestAbility: string;
  /** Lumber carried per trip. LIVE value: Improved/Advanced Lumber Harvesting (`rlum`) raises
   *  it above `baseLumberCapacity`, which is why recomputeStats owns it (a Peasant already in
   *  the forest when the research lands starts filling to the new load on its next trip). */
  lumberCapacity: number;
  baseLumberCapacity: number;
  lumberPerChop: number;
  chopPeriod: number; // seconds between chops
  /** Gold per trip out of a classic mine (`Ahar` DataC = 10). Per worker rather than a
   *  constant because it is a column on each worker's own harvest row. */
  goldPerTrip: number;
  damagesTree: boolean; // wisps harvest without hurting the tree
  /** No haul: the load is credited to the stash the instant it is cut, and the gatherer never
   *  walks a depot leg at all. TRUE for the night elf Wisp and nothing else — Wisp Harvest
   *  (`Awha`) is a different ability class from everyone else's `Ahar`/`Ahrl`, and this is the
   *  difference between them. It is also why `Awha` has no "Lumber Capacity" that means
   *  anything: with no trip there is nothing to fill. See tickHarvest. */
  deliversInPlace: boolean;
  /** No haul the other way round: the gold never leaves the mine at all, and this worker
   *  kneels in a ring around the building that stands on it. TRUE for the Undead Acolyte and
   *  nothing else — see WorkerProfile.minesInRing and SimWorld.tickRingHarvest. */
  minesInRing: boolean;
  carryGold: number;
  carryLumber: number;
}

/** Where a rally point sends newly-produced units. A plain point is a move; a
 *  mine/tree makes new workers harvest it; a unit makes them move to it (WC3).
 *
 *  **"none" is the state a building is BORN in**, and it is not the same as a point at the
 *  building's own feet. WC3 sets no default rally: a fresh Barracks has no flag, and the
 *  Footman it trains walks clear of the door and stops there. Ours defaulted to a point 200
 *  units south, so every unit any building ever produced marched off it — visible on WTii's
 *  Unit Tester, where a hero bought at an altar immediately ran away from the altar. */
export type RallyKind = "none" | "point" | "mine" | "tree" | "unit";

/** One job in a building's production queue. A building produces three different kinds of
 *  thing on the SAME queue in WC3 — you cannot train a Footman while the Barracks researches
 *  Defend — so they share one list and are told apart by `kind`:
 *   - "unit"     — train a unit; spawns it at the rally point.
 *   - "research" — an upgrade at `level`; raises the player's researched level on completion.
 *   - "upgrade"  — the building becomes `unitId` (Town Hall → Keep). Morphs in place. */
export type BuildJob =
  // `free` marks the melee free first hero — charged nothing, so it must be refunded nothing.
  // `buyer` is who the job belongs to when the BUILDING's owner isn't the answer: a Tavern is
  // Neutral Passive, so a hero queued there is nobody's by ownership. Without it, a hero player
  // A is hiring counts toward player B's copy count — which is what selects B's requirement
  // tier ("your 2nd hero needs a Keep"). Harmless in 1v1, wrong the moment there are three.
  | { kind: "unit"; unitId: string; timeLeft: number; buildTime: number; free?: boolean; buyer?: number }
  | { kind: "research"; unitId: string; level: number; timeLeft: number; buildTime: number }
  | { kind: "upgrade"; unitId: string; timeLeft: number; buildTime: number }
  // A HERO coming back. `unitId` is the hero's TYPE (so the card and the queue draw its icon
  // like any other job) and `heroId` is WHICH hero — the sim id it died under, which is the
  // identity its level, items and name are filed against. `buyer` is the Tavern's rule again:
  // a neutral shop's queue belongs to nobody, so the job says whose hero is being woken.
  | { kind: "revive"; unitId: string; heroId: number; timeLeft: number; buildTime: number; buyer?: number };

/** What a finished structure does to the ground under it — see SimWorld.blightPaintOf. */
interface BlightPaint {
  radius: number; // Area1 — 768 "(Small)" / 960 "(Large)"
  blights: boolean; // DataB "Creates Blight" — 1 = grow, 0 = dispel
  step: number; // DataA "Expansion Amount" — world units the ring gains per period
  period: number; // Dur1 — seconds between those steps
}

/** Per-building state: construction progress + a production queue. */
export interface BuildingState {
  constructionLeft: number; // seconds until built (0 = complete)
  buildTimeTotal: number; // full construction time (for the progress fraction)
  /** This structure raises ITSELF: construction advances on its own clock, with nobody
   *  standing over it. Two things arrive here, from opposite directions.
   *
   *  The Entangled Gold Mine can never have a worker — `Aent` creates it, the Tree's roots
   *  hold it up, and there is no Build order anywhere that would put a Wisp on it (see
   *  attachEntangled). Every UNDEAD structure has one and then lets it GO: an Acolyte summons
   *  and walks away, which is the race's whole build rhythm (see summonsBuildings).
   *
   *  Everything else halts the moment its builder walks off. */
  selfBuilds?: boolean;
  builderIds: number[]; // workers constructing (empty → progress halts). Extra
  // builders past the first "speed build" it (human peasants): faster, but they
  // burn extra resources — see SPEED_BUILD_* constants + tickBuildings.
  goldCost: number; // base build cost, for the speed-build surcharge
  lumberCost: number;
  queue: BuildJob[];
  rallyX: number; // trained units gather here (default: just south of the hall)
  rallyY: number;
  rallyKind: RallyKind; // how the rally target is interpreted (point/mine/tree/unit)
  rallyTargetId: number; // mine/tree/unit id for non-point rallies (0 for a point)
  /** TRAINS units → has a rally point. A tower or a farm has nothing to send anywhere, and
   *  neither — this is the part that is easy to get wrong — does a SHOP. `Trains` and
   *  `Sellunits` are two different fields and only the first one rallies: you cannot set a
   *  rally point on a Tavern, a Mercenary Camp, a Goblin Laboratory or a Shipyard, and a unit
   *  hired at one simply appears beside it. Measured on WTii's Unit Tester, where the only
   *  buildings the real client gives the button to are its altars — the ones that carry
   *  `Trains` — and its forty-odd `Sellunits` shops get nothing. It also matters for room: a
   *  12-ware shop fills the 4×3 card exactly, and reserving (3,1) for a rally cost it a ware. */
  producesUnits: boolean;
  // Shop stock, when this building sells things (Arcane Vault, Goblin Merchant, Tavern…).
  // Keyed by item/unit id. Absent on everything else. See SHOP stock rules in tickShops().
  //
  // Most shops fill this ONCE, from their data (`Sellitems`/`Makeitems`/`Sellunits`). The
  // Marketplace is the exception and the reason the map is mutable: it declares no wares at
  // all, and Blizzard's own JASS stocks it at runtime — see the AddItemToStock natives.
  stock?: Map<string, ShopStock>;
  /** How many distinct item / unit TYPES this shop may hold (JASS Set[All]ItemTypeSlots).
   *  Blizzard.j's InitNeutralBuildings sets both to 11 (bj_MAX_STOCK_ITEM_SLOTS). Undefined =
   *  use the world default. A full shelf silently refuses further stock, which is what makes
   *  the Marketplace rotate: buying an item frees its slot for the next restock tick. */
  stockItemSlots?: number;
  stockUnitSlots?: number;
}

/** One shop slot's stock. WC3 restocks per ITEM, not per shop: each item has its own
 *  `stockStart` (a delay before the shop first carries it), `stockRegen` (seconds to add one
 *  back) and `stockMax` (the ceiling). ItemData.slk carries these for items, UnitBalance.slk
 *  for the units a Tavern/Mercenary Camp sells. */
export interface ShopStock {
  count: number; // how many are on the shelf right now
  max: number; // stockMax
  regen: number; // stockRegen — seconds per restock tick
  timer: number; // seconds until the next one is added (Infinity = never)
  /** `stockRegen` 0 — "no time need pass before another is added", so the ware is back the
   *  instant it is taken and the shelf never empties. `stockStart` still gates its FIRST
   *  appearance, which is the whole of a Tavern hero (1/0/135: nothing until 2:15, then always
   *  there for every player). Reading regen 0 as "gone for good" instead is what made WTii's
   *  Unit Tester a one-shot: it sets `usrg`=0 on every unit its shops sell precisely to make
   *  them unlimited. See UnitDef.stockRegen. */
  unlimited?: boolean;
  /** The full span `timer` was last wound to. Purely for the UI: an out-of-stock ware wears the
   *  same clockwise cooldown sweep an ability does, and the sweep needs the fraction
   *  `timer / period` — which the timer alone cannot give (a ware's FIRST arrival is a
   *  `stockStart` wait, not a `stockRegen` one, and the two are different lengths). */
  period: number;
  /** Which id space the key belongs to — one flat map holds both, and the slot caps are
   *  counted per kind (11 item types AND 11 unit types). */
  kind: "item" | "unit";
}

/** Why a shop purchase was refused. The HUD maps these onto the game's own messages in
 *  Units\commandstrings.txt — "A valid patron must be nearby." (Neednearbypatron),
 *  "Inventory is full." (Inventoryfull), and the standard cost/requirement lines. */
export type ShopResult = "ok" | "no" | "nostock" | "nopatron" | "full" | "cost" | "req";

/** Fallback patron reach for a shop whose ability data we can't read. The real numbers come
 *  from the shop ability itself (Aall 600 / Aneu 450); this only covers a broken data load. */
const DEFAULT_SHOP_RADIUS = 450;

/** A shift-queued follow-up order, replayed when the unit's current order ends.
 *  WC3 allows chaining several (up to ~35) — move, attack, harvest, build… */
export type QueuedOrder =
  // targetId: this move NAMES a unit or building — "go to THAT" rather than "go to that
  // spot". x/y are its centre, and the mover walks up to it: as close as it can get, by
  // the cheapest route to any spot that close (see SimWorld.approachExtent / findPath's
  // `arrived`). Without it a move is an ordinary point order.
  | { kind: "move"; x: number; y: number; targetId?: number }
  | { kind: "attackmove"; x: number; y: number }
  | { kind: "patrol"; x: number; y: number }
  | { kind: "hold" }
  // Stop wipes the unit's queue and its current order. It is a QueuedOrder so that the player
  // path can go through the one funnel (docs/multiplayer.md Phase C) — not because you would
  // ever shift-queue one; `issueOrder` clears the queue before dispatching it either way.
  | { kind: "stop" }
  // `solo`: this attack was commanded to this unit ALONE — the player had it solo-selected
  // when the click went out — rather than handed to it as one of a group. It changes nothing
  // about the attack itself; it decides whether an autocast may interrupt it (see
  // SimUnit.attackSolo).
  | { kind: "attack"; targetId: number; force?: boolean; solo?: boolean }
  // offX/offY: optional formation offset from the leader's centre, so a group told
  // to follow one unit fans into distinct slots instead of stacking on its centre.
  | { kind: "follow"; targetId: number; offX?: number; offY?: number }
  // ax/ay: optional distinct approach point around the node, so a group ordered
  // together fans over the mine's rim instead of all pathing to its centre.
  | { kind: "harvest"; res: "gold" | "lumber"; nodeId: number; ax?: number; ay?: number }
  // The other half of the Gather button. Every harvest row carries a pair of faces —
  // `Art=BTNGatherGold` / `Unart=BTNReturnGoods` (see isHarvestCode) — and this is what the
  // second one orders: take what you are carrying to the nearest depot, now. It takes no
  // target, because the depot is not a thing the player picks.
  | { kind: "returnresources" }
  // `paid` is whether the cost has already left the stash. A build placed outright is paid at
  // the click (the gold drops the instant you put the ghost down); a SHIFT-queued one is not —
  // it is priced when its turn in the queue comes round, because a building queued behind two
  // others is meant to be paid for out of the gold those two builds' worth of mining brings in.
  | { kind: "buildnew"; defId: string; x: number; y: number; gold: number; lumber: number; paid: boolean }
  // ax/ay: as above, a distinct spot around the building's footprint to spread builders.
  | { kind: "buildresume"; buildingId: number; ax?: number; ay?: number }
  | { kind: "repair"; buildingId: number; hpPerSec: number; goldPerHp: number; lumberPerHp: number }
  // Go and drink from a Moon Well (`Ambt`). A move with a promise attached: the unit walks to
  // the well and, once inside the ability's Area1, the well pours itself into it. The order is
  // on the DRINKER because the drinker is what was selected and what has to walk — see
  // SimUnit.drinkWellId.
  | { kind: "drink"; wellId: number }
  // Plant an uprooted Ancient at a NAMED spot (`Aroo`'s root direction). Root is a placement
  // in WC3, not a toggle: the button hands you the building silhouette and its green/red
  // footprint grid, and the Ancient walks to where you put it and settles. So the order is a
  // move with a promise, the same shape as `drink` — see SimUnit.rootPending.
  | { kind: "rootat"; x: number; y: number }
  // Cast an ability at a unit, a point, or nothing — the queue entry behind a SHIFT-queued
  // ability. WC3 chains casts like everything else, and the Ancient told to eat four trees is
  // the case that proves it: without this each right-click replaced the last and it walked
  // past three trees to eat the one clicked most recently. `targetId` 0 with x/y for a point
  // spell, a unit id for a targeted one, both empty for a self cast — the same three shapes
  // `issueCast` already takes.
  | { kind: "cast"; code: string; targetId: number; x: number; y: number }
  // Go and take that gold mine — the whole night elf expansion in one right-click. An
  // uprooted Tree of Life walks to a spot beside the mine that its own footprint fits on,
  // PLANTS itself there, and casts Entangle (`Aent`) once its roots are down. Three acts, one
  // order, because that is what "work that mine" means for the one race whose town hall has
  // to be standing next to it. See SimUnit.entanglePending.
  | { kind: "entangleat"; mineId: number };

/** Fallback length of a root/unroot transition, seconds — `Aroo`'s own `Dur1` when the data is
 *  there (2.5), which is also what Liquipedia lists as Root/Uproot's "Animation Duration". */
const ROOT_MORPH_TIME = 2.5;
/** Ceiling on a form toggle's transition lock (`Dur1`, see morphToggle). A lock is a unit
 *  standing helpless, and every authored transition in the stock data is under two seconds —
 *  so this only ever bites a custom row that means something else by the column. */
const MAX_MORPH_TRANSITION = 3;

/** How much faster than the settle itself a planting Ancient TURNS back to `builtFacing`
 *  (developer request: "double speed").
 *
 *  The walk-on and the turn were both spread across the whole 2.5s transition, and they do not
 *  read the same way: sliding the last stride onto the site over the full clip is the point,
 *  but a tree still swinging round while its roots are already in the ground looks like the
 *  building is being dragged into place. Turning at twice the pace simply means it is square
 *  with the base by the halfway mark and the rest of the morph plays out facing home. */
const ROOT_TURN_SPEEDUP = 2;

/** How close an Ancient must stop to the spot it was told to plant on before it settles there
 *  (`{kind:"rootat"}`), on top of its own collision radius.
 *
 *  The radius is most of it and cannot be left out: an Ancient of War is 144 across, and a
 *  walk aimed at a point stops roughly a body short of it, so a flat one-cell tolerance lost
 *  the order every time and the tree just stood there. What is left over is the build cell the
 *  site was picked on, so ordinary stopping slop cannot lose it either. The gap that is left
 *  is closed by the settling GESTURE itself (SimUnit.rootSettle), never by a jump; the order is
 *  dropped rather than teleported from further out. */
const ROOT_ARRIVE_SLACK = 64;

const MAX_QUEUED_ORDERS = 35; // WC3 action-queue cap (shift-queued ORDERS on a unit)
/** WC3 caps a building's PRODUCTION queue at 7 jobs — training, research and tier upgrades
 *  all share it. A different thing entirely from MAX_QUEUED_ORDERS above. */
const MAX_BUILD_QUEUE = 7;

export interface SimMine {
  id: number;
  x: number;
  y: number;
  radius: number;
  gold: number;
  busy: boolean; // WC3 classic mines hold one worker at a time
  /** The Entangled Gold Mine standing on this mine (`egol`), or 0. Entangle (`Aent`) does not
   *  convert the mine: it CREATES a unit over it (the ability's own `UnitID1` = egol) and the
   *  mine keeps being the gold. So the two stay separate here as well — the building is the
   *  thing wisps climb into and enemies knock down, and this is the seam between them. */
  entangledBy: number;
}

/** An Entangled Gold Mine the sim has asked the renderer to raise (`Aent` UnitID1 = `egol`).
 *  The building needs a model, so it is born on the render side and handed back through
 *  `attachEntangled` — the same asynchrony a summon has. `instant` is the melee opening's
 *  `entangleinstant`: no cast, and no 60-second build either. */
export interface EntangleRequest {
  mineId: number;
  unitId: string;
  x: number;
  y: number;
  owner: number;
  team: number;
  casterId: number;
  instant: boolean;
}

export interface SimTree {
  id: number;
  x: number;
  y: number;
  lumber: number; // remaining lumber a worker can chop before it falls
  hp: number; // destructible HP — drained by tree-damaging spells (Flame Strike), not by harvest
  // Half-extent of the tree's blocked pathing footprint (world units): 64 for the
  // usual 4x4Default tree, 32 for a 2x2Default one. The fog's line-of-sight blocker
  // is stamped over this square, not over the centre point alone (#43).
  blockRadius: number;
}

/** A frozen snapshot of a unit for a trigger event (death/damage/attack). Just enough
 *  for the trigger engine to mint a JASS unit handle (GetDyingUnit/GetEventDamageSource
 *  /GetAttacker/…) even after the unit is gone. */
export interface EventUnitInfo {
  id: number;
  typeId: string;
  owner: number;
  x: number;
  y: number;
  facing: number;
}

/** The unit's owner as the SCRIPT sees it (GetOwningPlayer). Our sim files every neutral
 *  under owner -1 and tells creeps from shops with `neutralPassive`; WC3 gives them real
 *  player slots — Neutral Hostile is **player 12** and Neutral Passive is **player 15**
 *  (common.j PLAYER_NEUTRAL_AGGRESSIVE / PLAYER_NEUTRAL_PASSIVE). Trigger code leans on
 *  that hard: blizzard.j's MeleeClearExcessUnit removes a start-location unit only if its
 *  owner IS one of those two, and countless custom maps spawn "for Player 12". So the
 *  translation happens here, at the one place a sim unit becomes a JASS unit. */
export function jassOwnerOf(u: { owner: number; neutralPassive: boolean }): number {
  if (u.owner >= 0) return u.owner;
  return u.neutralPassive ? 15 : 12;
}

const eventInfo = (u: SimUnit): EventUnitInfo => ({ id: u.id, typeId: u.typeId, owner: jassOwnerOf(u), x: u.x, y: u.y, facing: u.facing });

/** Where a cast is in its lifecycle, for the trigger engine's spell events (7.17).
 *  WC3 raises five, in this order: CHANNEL (the caster begins), CAST (the spell is
 *  committed), EFFECT (it goes off — the one most GUI triggers use), FINISH (the
 *  channel/recovery ran out) and ENDCAST (the caster stopped casting, interrupted
 *  or not). Our cast timeline (see PendingCast) maps onto it directly: the wind-up
 *  starting is CHANNEL+CAST, the cast point is EFFECT, endCast is FINISH+ENDCAST,
 *  and an interrupted wind-up raises ENDCAST alone. */
export type SpellPhase = "channel" | "cast" | "effect" | "finish" | "endcast";

/** One spell event: who cast what, at whom/where. `abilityId` is the SimAbility's
 *  own alias (the rawcode GetSpellAbilityId hands the script back). */
export interface SpellEvent {
  caster: EventUnitInfo;
  abilityId: string;
  phase: SpellPhase;
  target: EventUnitInfo | null; // unit target (null for point/no-target casts)
  x: number; // target point (the unit's position for a unit target)
  y: number;
}

/**
 * Something happened that the engine ANNOUNCES on its own — the news half of
 * `Units\CommandStrings.txt`'s [Errors] block.
 *
 * Those 216 rows are not all refusals. Beside "Not enough gold." sit `Unitattack`,
 * `Townattack`, `Herodeath`, `Goldminelow` and `Goldminedestroyed`: lines nobody asked
 * for, raised by the game itself, and each one paired with a war3skins.txt sound key
 * (`UnderAttackSound`, `TownAttackSound`, `HeroDiesSound`, `GoldMineLowSound`,
 * `GoldMineCollapseSound`). That pairing is the whole test for whether a cue prints
 * text: the three COMPLETION sounds — `JobDoneSound`, `UpgradeComplete`,
 * `ResearchComplete` — have no [Errors] row at all, which is why a finished building
 * only speaks in the real client (issue #111). OpenWar3 prints one anyway for a finished
 * BUILDING ("Completed: Barracks", GlobalStrings' own `COLON_COMPLETED`) — a deliberate
 * departure, decided in the renderer where the audience is known, and shown on this same
 * one-line display, since that is where the engine puts everything it says in one line.
 *
 * The sim raises them; the renderer decides who is told what. It has to be that way
 * round for the ally variants — the same blow is "Our town is under siege!" to the
 * owner and "%s's city is under siege!" to their ally, and only the renderer knows
 * which one is watching (see MapViewerScene.showAlert).
 */
export interface Alert {
  kind: "attack" | "townattack" | "herodeath" | "minelow" | "minedestroyed";
  /** Whose news it is: the owner of what was hit, died, or was being mined. */
  player: number;
  x: number;
  y: number;
  /** `herodeath` only — the dead hero, whose record is gone by the time anyone drains
   *  (kill() deletes it), so the three fields `Herodeath` prints travel with the alert. */
  hero?: { properName: string; typeId: string; level: number };
  /** `herodeath` only, and only when another HERO struck the blow — `Herokilledhero`
   *  ("%s was defeated by %s.") is the line for that, in place of the plain one. */
  killer?: { properName: string; typeId: string };
}

/** A structure's construction reaching a milestone (EVENT_(PLAYER_)UNIT_CONSTRUCT_*):
 *  the foundation laid, the build cancelled, or the building finished. */
export interface ConstructEvent {
  structure: EventUnitInfo;
  phase: "start" | "cancel" | "finish";
}

/** A training queue milestone (EVENT_(PLAYER_)UNIT_TRAIN_*). `trained` is the new
 *  unit — only on "finish", and only once the engine has actually spawned it (the
 *  sim owns no models, so the unit is born in the renderer; see noteTrainFinish). */
export interface TrainEvent {
  building: EventUnitInfo;
  unitTypeId: string; // the trained unit's type rawcode (GetTrainedUnitType)
  trained: EventUnitInfo | null;
  phase: "start" | "cancel" | "finish";
}

/** A unit BOUGHT from a shop — EVENT_(PLAYER_)UNIT_SELL, the unit twin of a sold ITEM. A
 *  Tavern's heroes, a Mercenary Camp's creeps, a Goblin Laboratory's zeppelin: every one of
 *  them arrives through the same queue a barracks trains from, so `noteTrainFinish` is where
 *  the two part company — a `Sellunits` ware is a SALE, anything else a training. */
export interface SellUnitEvent {
  shop: EventUnitInfo; // GetSellingUnit (and GetTriggerUnit)
  sold: EventUnitInfo; // GetSoldUnit
}

/** A hero gaining a level (EVENT_PLAYER_HERO_LEVEL) or learning a skill
 *  (EVENT_PLAYER_HERO_SKILL). `abilityId` is set only for "skill". */
export interface HeroEvent {
  hero: EventUnitInfo;
  phase: "level" | "skill";
  level: number; // the new hero level, or the rank just learned (skill)
  abilityId: string;
}

/** A Way Gate's teleport config (7.22). A waygate is an ordinary unit ('nwgt') that
 *  carries the `Awrp` ("Warp") ability; a script points it somewhere with
 *  `WaygateSetDestination` and switches it on with `WaygateActivate`. Null/absent on
 *  every other unit, so this costs nothing. */
export interface WaygateState {
  destX: number;
  destY: number;
  active: boolean;
  /** Units currently standing in the gate's box. A gate fires on a unit ENTERING it —
   *  the rising edge — not on one merely standing in it, so this is the "was already
   *  inside" baseline the next tick is diffed against. See tickWaygates for why a gate
   *  that fires on occupancy instead of entry makes a pair of gates ping-pong forever. */
  inside: Set<number>;
}

export interface SimUnit {
  id: number;
  owner: number; // player slot; -1 = map-neutral
  team: number; // units on the same team are allied; -1 = hostile to everyone
  race: string; // human|orc|undead|nightelf|… — for spell polarity (Holy Light vs undead)
  typeId: string; // unit-def id (for corpses/Resurrection to re-create the unit)
  neutralPassive: boolean; // Neutral Passive (shops, critters): never hostile, yellow ring
  /** The weapon-target class this unit answers to, when it is not one of the three a unit
   *  derives (see weaponVs). Set for DESTRUCTIBLES, which carry their own: `debris` for the
   *  gates and crates, `wall` for barricades — the very words every melee unit's Targets
   *  Allowed already lists.  for everything else. */
  targetKey: string;
  /** The unit type's OWN `targType` (UnitData "Combat - Targeted As"), derived at spawn from
   *  the registry the way `waterborne` is. It answers the same question `targetKey` does and
   *  is a separate field for one reason: `targetKey` doubles as the marker for "this is a
   *  destructible" (rts.ts reads it that way in two places), so a unit must not fill it in.
   *
   *  It matters because the derivation it replaces is WRONG for 17 stock rows — the twelve
   *  wards are `ward` rather than `ground`, the Fountains of Health/Mana are `structure`
   *  without being buildings, and `zjug` flies while being targeted as `ground` — and for
   *  every custom type whose map states one (`utar`). "" when the registry has no row.
   *  See UnitDef.targType. */
  targClass: string;
  /** How many SEATS this unit takes in a cargo hold (`cargoSize`) — 2 for the siege roster,
   *  4 for a Siege Engine or Mountain Giant, 1 for everything else. Derived at spawn from the
   *  registry alongside `waterborne` and `targClass`. See UnitDef.cargoSize / garrisonLoad. */
  cargoSize: number;
  x: number;
  y: number;
  facing: number; // radians
  desiredFacing: number; // turning continues toward this even when standing
  speed: number; // world units / second
  turnRate: number; // UnitData turnrate; scaled to rad/sec below
  radius: number; // collision radius (0 = no unit collision)
  flying: boolean; // air units ignore ground pathing & collision
  /** `movetype=float` (UnitBalance/UnitData) — a transport ship, and the Sea Giant. It paths
   *  the WATER: the same grid read through `PathingFlag.NoWater` instead of `Unwalkable`, so
   *  the sea it sits on is open ground to it and the shore is the wall. Everything else about
   *  it is a ground unit — it is hit by ground attacks, holds cells, and takes AoE — which is
   *  exactly why it cannot simply be spelled `flying`. Derived at spawn from the registry. */
  waterborne: boolean;
  flyHeight: number; // altitude above ground the unit floats/draws at (0 for ground);
  // matches the render lift so missiles launch from / land at the unit's real height
  sightDay: number; // fog-of-war sight radius in daylight (UnitBalance `sight`)
  sightNight: number; // fog-of-war sight radius at night (UnitBalance `nsight`)
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  armor: number;
  armorType: ArmorType; // UnitBalance defType → picks the damage-table column
  /** Every weapon slot the unit's type declares, in slot order (see WeaponSlotDef). Which one
   *  swings is decided per TARGET — weaponVs(). */
  weapons: SimWeapon[];
  /** The primary weapon: the first ENABLED slot, or null when the unit is unarmed. This is the
   *  attack the HUD shows and what "is this unit armed / melee / ranged" means everywhere.
   *  recomputeStats() re-picks it, so a Flying Machine that researches Bombs keeps its air
   *  attack as primary and simply gains a second one. */
  weapon: SimWeapon | null;
  /** The slot the in-flight swing was launched with (weaponVs at swing start) — a Gargoyle
   *  that starts a ground swing must land THAT hit, not re-pick a weapon at the damage point. */
  swingWeapon: SimWeapon | null;
  // Ability cast animation timing (UnitWeapons.slk castpt/castbsw), per-unit — not
  // per-weapon, so a weaponless pure caster still has them. castPoint = wind-up
  // before a spell's effect fires (added to the ability's Casting Time); castBackswing
  // = the recovery after the effect, which any new order cancels for free (the WC3
  // "animation canceling" micro). See PendingCast + tickCast.
  castPoint: number;
  castBackswing: number;
  worker: WorkerState | null;
  building: BuildingState | null; // set for structures (construction + training)
  depotGold: boolean; // accepts gold deposits (town halls)
  depotLumber: boolean; // accepts lumber deposits (halls + lumber mill)
  order: SimOrder;
  targetId: number | null;
  cooldownLeft: number;
  // A swing is in progress: the strike/projectile lands `swingLeft` seconds after
  // the attack animation begins (the weapon's damage point), not instantly.
  swingLeft: number; // -1 = no pending strike
  swingTargetId: number; // whom the pending strike is aimed at
  swingSeq: number; // increments each swing start (renderer re-triggers the attack clip)
  // "Animation break": the unit walked after firing (an attack's backswing was
  // move-canceled), so its attack clip must NOT resume — it stands out the recovery
  // until the next real swing fires (the swing clears this). Reset every swing start.
  swingBroken: boolean;
  // Swing procs, rolled ONCE at the swing's start (see engage) and spent at its damage
  // point. They are decided up front — not at the blow — because the strike they modify
  // has its own animation: WC3 models that carry a proc-on-attack passive carry an
  // "Attack Slam" clip for exactly this (HeroBlademaster.mdx has one alongside its plain
  // "Attack"/"Attack 2"; HeroMountainKing.mdx has "Attack Slam" + "Attack Slam Alternate"
  // for Bash/Avatar). The clip is chosen when the swing begins, so the roll must be too.
  swingCrit: boolean; // Critical Strike (AOcr) hit this swing — dealDamage multiplies it
  swingBash: boolean; // Bash (AHbh) procced this swing — dealDamage adds its bonus + stuns
  swingSlam: boolean; // this swing shows "Attack Slam": a crit, a bash, or the Wind Walk backstab
  chopSeq: number; // increments each lumber chop (renderer re-triggers the chop clip in sync)
  inCombat: boolean; // engaging in range this tick (drives the attack animation)
  path: Array<[number, number]>; // world waypoints
  waypoint: number;
  moving: boolean;
  chaseX: number; // where the current chase path was aimed (repath when stale)
  chaseY: number;
  // Half-extents of the THING standing on (chaseX, chaseY) when this path is an approach —
  // "walk up to that unit/building" rather than "walk to that spot". 0 = a bare point.
  // Held on the unit because every re-path (a blocked reroute, the stuck watchdog) re-aims
  // at chaseX/chaseY, and a reroute that forgot this would quietly turn the order back into
  // a move at the target's CENTRE — ground it can never stand on — and send it round the
  // building to whichever cell the goal-snapping happened to pick.
  chaseHX: number;
  chaseHY: number;
  // Follow-formation offset from the leader's centre (0,0 = a lone follower that
  // just trails). A group told to follow one unit is fanned into distinct slots
  // so they hold a spread instead of stacking on the leader's centre and shoving.
  followOffX: number;
  followOffY: number;
  // Leader to RESUME following after an opportunistic fight ends (issue #32): a
  // follower that reaches its leader guards it, attacking nearby enemies, but once
  // the fight is over it returns to trailing instead of going idle. Non-null only
  // while such a follow-and-fight is in flight; a fresh player order clears it.
  followLeaderId: number | null;
  // Attack-formation slot: a distinct offset from the TARGET's centre this unit
  // stands at to attack, so a group swarming one enemy fans out around it (WC3
  // surround) instead of lining up. atkOffTarget marks which target the slot was
  // assigned for (re-assigned only when the target changes, so slots stay stable).
  atkOffX: number;
  atkOffY: number;
  atkOffTarget: number; // -1 = no slot assigned
  amDestX: number; // attack-move final destination (units engage enemies en route)
  amDestY: number;
  patrolX: number; // the OTHER patrol endpoint (units bounce between the two)
  patrolY: number;
  acquireT: number; // seconds until the next auto-acquire scan
  stuckT: number; // seconds spent blocked while trying to move
  stuckRetries: number; // consecutive stuck-repath attempts without progress
  stallT: number; // seconds an attacker has been unable to close on its target (issue #24)
  stallAnchorX: number; // position at the start of the current combat-approach window
  stallAnchorY: number;
  stallGap: number; // gap to the target at the start of the current combat-approach window
  gaveUp: boolean; // holding: gave up reaching an unreachable attack target, standing put (issue #24)
  gaveUpGap: number; // gap to the target when the hold began — re-evaluate if it moves
  attackStalls: number; // consecutive combat-approach windows with no headway (forces a hold when high)
  // This attack was ORDERED (a player right-click / Attack command, or a trigger order) rather
  // than picked up automatically. An ordered attack is a commitment: the unit marches to THAT
  // target and doesn't get distracted by whatever it walks past or gets shot by, and only falls
  // back to another target once the pathfinder says the ordered one is genuinely unreachable
  // (issue #83). Cleared by every automatic re-target, so the commitment doesn't outlive the order.
  attackOrdered: boolean;
  // …and it was ordered to THIS unit alone: the player had it solo-selected, so the click was
  // aimed at it and nothing else. A commanded attack normally still lets an autocast take over
  // once the caster is in the fight (issue #94 — an army's Priest is not an archer), but a
  // Priest you picked out by himself and pointed at something is a player micro-ing one unit,
  // and he must do as he is told: Liquipedia's Autocast rule is that an ORDER suppresses
  // autocast, and with one unit selected there is no group for him to be the healer of.
  // Only ever true alongside `attackOrdered`, and cleared by the same automatic re-targets.
  attackSolo: boolean;
  stuckAnchorX: number; // position at the start of the current stuck window (net-progress check)
  stuckAnchorY: number;
  repathT: number; // chase-repath cooldown after getting blocked
  // Seconds a PARKED mover waits before trying its route again. A move/attack-move whose
  // way is shut by other bodies keeps its order and parks (see parkAndWait) instead of
  // being cancelled — a unit does not forget where it was sent because somebody stood in
  // front of it for a second (issue #108). Backs off while the jam lasts.
  waitT: number;
  repollT: number; // proactive-reroute poll timer (issue #6): seconds until the next
  // check of whether the path ahead is still clear of newly-stopped units
  yieldT: number; // seconds paused giving way to another unit (breaks head-on "dancing")
  prevX: number; // position before this tick's movement (stuck detection)
  prevY: number;
  velX: number; // scratch: intended pathed displacement this tick (collision steering)
  velY: number;
  footprint: number; // reserved cells per side when stationary (0 = never)
  // A building's stamped pathTex footprint (see destructibles.ts) and the position it
  // was stamped at. Buildings don't reserve cells like a stopped unit does — they block
  // through this stamp — so the stamp is what has to come back when the building dies.
  // Held with its own x/y because the stamp is applied at the building's FOUNDING spot
  // and must be lifted from exactly there.
  pathStamp: { fp: Footprint; x: number; y: number } | null;
  resX: number; // origin cell of the current reservation
  resY: number;
  hasReservation: boolean;
  // The cell block a MOVING unit holds (see PathingGrid.claim). A walker owns the block it
  // stands on and may only advance once it owns the next one, so it never interpolates
  // toward a tile it will not be allowed to reach and then get shoved back out of it
  // (issue #108). Mirrors resX/resY/hasReservation for the stationary half of the same idea.
  claimX: number;
  claimY: number;
  hasClaim: boolean;
  blockedT: number; // seconds a mover has been unable to take the next tile (forces a reroute)
  resKind: "gold" | "lumber" | null; // active harvest target kind
  resId: number; // mine/tree id being harvested
  /** Consecutive re-paths a gatherer has spent trying to actually REACH its node/depot
   *  after stopping short of it. Bounded so a boxed-in gatherer still parks and works
   *  its node, rather than re-flooding A* every tick (see arriveAtNode, issue #89). */
  nodeRetries: number;
  workT: number; // chop/mine timer
  inMine: boolean; // inside the gold mine (renderer hides the unit)
  /** WHICH mine holds it while `inMine`. The emerge branch clears THAT mine's one-worker
   *  `busy` latch — never `resId`'s, because an order can re-target `resId` while the
   *  worker is still inside (a re-clicked expansion), and clearing the wrong mine leaves
   *  the real one latched shut with every later worker parked outside forever. */
  inMineId?: number;
  insideBuild: boolean; // Orc peon hidden INSIDE the structure it is building (renderer hides it)
  inBurrow: boolean; // peon garrisoned inside an Orc Burrow (renderer hides it)
  garrisonHost: number; // Orc Burrow id this peon is garrisoned in (0 = none)
  garrison: number[]; // for an Orc Burrow: the peon ids loaded inside (fires arrows; DPS scales)
  garrisonCap: number; // max passengers this unit can hold (0 = can't garrison; Abun Dataa1)
  linkGroup: number[]; // Spirit Link: the co-linked unit ids sharing this unit's damage (empty = unlinked)
  linkT: number; // Spirit Link time remaining (0 = not linked)
  linkShare: number; // Spirit Link: fraction of a hit distributed across the group (dataA)
  devouring: number; // Kodo Devour: the prey unit id being digested (0 = none; holds one)
  devouredBy: number; // this unit is swallowed inside that Kodo (0 = free; renderer hides it)
  /** Off the field for a moment while an effect resolves: the renderer hides it, nothing can
   *  target or hurt it, and it takes no orders. Mirror Image's shuffle uses it — the
   *  Blademaster is whisked away while MirrorImageCaster plays and the missiles fly out, then
   *  set down on one of the destination tiles as if he had been a copy all along. */
  vanished: boolean;
  etherealForm: boolean; // Spirit Walker in ethereal form: persistently ethereal (immune physical, no attack)
  working: boolean; // chopping (renderer plays the attack animation)
  atNode: boolean; // parked at the resource (approach finished — stop pathing)
  noCollision: boolean; // ghosts through other units (mining workers, WC3-style)
  constructing: number; // building id this worker is constructing (0 = none)
  repair: RepairState | null; // active repair job (null = not repairing)
  orderQueue: QueuedOrder[]; // shift-queued follow-up orders (drained as each completes)
  // Walking to raise a new building; gold/lumber are its cost, refunded if the build is
  // abandoned before construction starts — but only once `paid` says the stash actually
  // gave it up (see the QueuedOrder note: a queued build is priced when its turn comes).
  buildPending: { defId: string; x: number; y: number; gold: number; lumber: number; paid: boolean; mineId?: number } | null;
  // --- hero / abilities / buffs (spells slice) ---
  isHero: boolean;
  properName: string; // hero's drawn name ("Painkiller"); "" for non-heroes
  level: number; // hero level (0 for non-heroes)
  xp: number; // hero experience
  skillPoints: number; // unspent skill points (1 gained per level)
  primaryAttr: PrimaryAttribute;
  baseStr: number; // level-1 attributes (growth is added per level)
  baseAgi: number;
  baseInt: number;
  strPerLevel: number;
  agiPerLevel: number;
  intPerLevel: number;
  str: number; // current (floored) attributes, recomputed on level-up
  agi: number;
  int: number;
  baseMaxHp: number; // level-1 maxHp — attribute growth is layered on top
  baseMaxMana: number;
  baseArmor: number; // armour before agility growth + buffs
  // The PRIMARY weapon's base damage before primary-attr growth + buffs. Mirrors
  // weapon.baseDamage; kept on the unit because it is the "how hard does this unit hit"
  // figure other systems reason about (Inner Fire's +10% of base, the HUD's green bonus).
  // WC3's attack upgrades add a DIE (`ratd`), not flat damage — the engine HAS a flat-damage
  // effect (`ratx`, used by Burning Oil) and Blizzard pointedly did not use it for Forged
  // Swords: all 19 melee/ranged attack upgrades across the four races are `ratd` base=1 mod=1.
  // So a Footman (1d2+11 = 12-13) upgrades to 2d2+11 = 13-15, then 3d2+11 = 14-17 — the RANGE
  // widens, which is why upgraded WC3 units roll a bigger spread and not just a bigger number.
  baseDamage: number;
  baseSpeed: number; // move speed before slow/haste
  baseSightDay: number; // Magic Sentry / `rsig` widen a tower's vision
  baseSightNight: number;
  manaRegen: number; // mana per second (recomputed from INT + buffs)
  hpRegen: number; // hp per second
  lifesteal: number; // fraction of melee damage healed back (Vampiric Aura); derived
  thorns: number; // fraction of melee damage returned to attackers (Thorns Aura); derived
  /** Fraction of SPELL damage this unit shrugs off — Runed Bracers' 33% (`AIsr` dataB) and
   *  its two siblings. Derived from the inventory, not a buff, so it needs no expiry. */
  magicReduction: number;
  /** Fraction of RANGED-ATTACK damage this unit shrugs off — the Arcanite Shield's 30%
   *  (`AIdd` dataA = 0.7, "reduces ranged damage TO 70%"). Same shape, different pipe. */
  rangedReduction: number;
  bonusArmor: number; // buff/aura portion of armour (green "+N" in the HUD); derived
  bonusDamage: number; // buff/aura portion of attack damage (green "+N"); derived
  bonusStr: number; // item portion of Strength (green "+N" / red "-N" in the HUD); derived
  bonusAgi: number; // item portion of Agility; derived
  bonusInt: number; // item portion of Intelligence; derived
  /** Levels of the owner's researched attack (`class` = melee/ranged) and armour
   *  (`class` = armor) upgrades that apply to this unit — the small number WC3 prints in the
   *  corner box of the info panel's damage / armour icons (`IconValue1..4` in
   *  `UI\FrameDef\UI\InfoPanelUnitDetail.fdf`). It rides on the UNIT rather than being read
   *  off the viewer's own tech ledger because clicking an ENEMY unit is how you scout how far
   *  along its upgrades are. Both derived. */
  attackUpgrade: number;
  armorUpgrade: number;
  abilities: SimAbility[]; // learned/innate abilities
  buffs: SimBuff[]; // active timed effects
  stunned: boolean; // derived from buffs (cannot act)
  paused: boolean; // JASS PauseUnit: frozen — no orders, movement, or turning (cinematics)
  waygate?: WaygateState | null; // JASS WaygateSetDestination/Activate — a Way Gate ('nwgt'), 7.22
  silenced: boolean; // derived from buffs (cannot cast spells)
  ethereal: boolean; // derived from buffs (Banish): can't attack, immune to physical damage
  /** Pulled out of the air and stuck to the ground — derived from a `web` root buff the way
   *  `ethereal` is derived from Banish's. While it is set the unit answers to `ground` rather
   *  than `air` (targetKeyOf) and is drawn on the floor (flyHeight 0), which is the whole of
   *  what Web does that Ensnare does not. False for everything that never flew. */
  webbed: boolean;
  /** Magic Immunity (`Amim`, and the creep copies that share its code) — the unit cannot be
   *  the target of a spell at all, and takes no spell damage. Carried by the Dryad, the
   *  Spell Breaker, the Destroyer, the Faerie Dragon, the Phoenix and the Serpent Wards
   *  (Units\UnitAbilities.slk). Derived from the ability, like `ethereal` from its buff. */
  magicImmune: boolean;
  /** RESISTANT SKIN (`Arsk`, and the ungated creep copy `ACrk` that shares its code) —
   *  "resistant units are treated as if they were heroes" for TARGETING (a `nonhero` spell
   *  refuses them, a hero-only one accepts them: see targeting.ts) and for DURATION (they
   *  get `HeroDur`, so Ensnare lasts 3 seconds on a Mountain Giant and not 9). Not immunity
   *  to a list of spells — the same one rule produces both halves. */
  resistant: boolean;
  /** True Sight radius — how far this unit reveals invisible enemies, or 0 for the vast
   *  majority that reveal nothing. Rng1 of `Atru` (the Shade, the general detector and the
   *  War Eagle, 900), `Adet` (the Sentry Ward, 1100) or `Adts` (Magic Sentinel, 900).
   *  Derived from the ability list. */
  detectRadius: number;
  /** Root (`Aroo`): this Ancient has pulled itself out of the ground and is walking. False is
   *  the resting state for every carrier — an Ancient is BUILT rooted, and a Tree of Life
   *  spends the whole game that way unless something goes badly wrong. See toggleRoot. */
  uprooted: boolean;
  /** Seconds until a TIMED alternate form runs out and reverts on its own, or 0 for a form
   *  that holds until something toggles it back. Call to Arms is the timed one: `[Amil]`
   *  Dur1 = 45, and a militia that survives its 45 seconds becomes a Peasant again wherever
   *  it happens to be standing. Burrow and the rest carry no duration at all. */
  altFormLeft: number;
  /** The ability whose alternate form this unit is currently in, so a timed form knows what to
   *  revert THROUGH — the ability owns both ids, and by then the unit is the wrong one to ask. */
  altFormAbil: string;
  /** This unit is currently showing the ALTERNATE half of its model. WC3 packs both looks of
   *  a two-form unit into one MDX — "Stand" and "Stand Alternate", with Morph/Morph Alternate
   *  between them — and nothing in the unit data says which half is live, because the ABILITY
   *  decides moment to moment.
   *
   *  Two unrelated-looking abilities land here: a ROOTED Ancient is alternate (its planted
   *  pose, see toggleRoot) and a BURROWED Crypt Fiend is alternate (its underground pose, see
   *  morphToggle). It is the same fact about the model either way, so the renderer reads this
   *  one flag rather than knowing about either ability. */
  altModel: boolean;
  /** The stamped BUILDING footprint an uprooted Ancient is carrying with it, lifted off the
   *  grid while it walks and laid back down where it plants. Null for everything else — and
   *  for a rooted Ancient, whose stamp is live in `pathStamp`. See toggleRoot. */
  rootedStamp: Footprint | null;
  /** The building footprint an uprooted Ancient will take back when it plants (0 for
   *  everything else). While it walks its own `footprint` is 0 — it collides by RADIUS like
   *  any other unit — because a 4×4 stamped block is a thing the pathfinder routes around,
   *  and an Ancient carrying one cannot leave the hole it is standing in. See toggleRoot. */
  rootedFootprint: number;
  /** The fade is IN FORCE: renders half-faded, and draws no aggro (see canSee). False during
   *  the Transition Time, when the unit is under the effect but hasn't vanished yet. */
  invisible: boolean;
  /** Under an invisibility effect AT ALL, transition included — a superset of `invisible`.
   *  This, not `invisible`, is what stops the unit picking its own fights and what a strike
   *  breaks: attacking during the transition has to cancel the vanish too, or Wind Walk
   *  would auto-attack its way out of its own 0.6s wind-up. */
  cloaked: boolean;
  invulnerable: boolean; // derived from buffs + baseInvulnerable (immune to damage + enemy targeting)
  baseInvulnerable: boolean; // persistent invulnerability from the unit type's "Invulnerable (Neutral)" ability (Avul) — goblin merchant, gold mine, mercenary camp, tavern, … (issue #26)
  mechanical: boolean; // machines/summons — no raisable corpse, unhealable by Heal
  // A worker, from the unit type's "Peon" classification (UnitBalance.slk `type`,
  // JASS's UNIT_TYPE_PEON): exactly the 9 harvest-and-build units — Peasant, Peon,
  // Acolyte, Wisp and the 5 neutral variants. Workers NEVER auto-acquire a target:
  // they ignore fights around them and only attack when explicitly ordered to
  // (issue #41). The Ghoul harvests lumber but is not Peon-classified, so it fights
  // like any other soldier — which is why the classification, not "can harvest", is
  // the flag to key off.
  isPeon: boolean;
  /** "Ward" in UnitBalance.slk's `type` column — the ten planted, immobile gadgets: Serpent
   *  Ward (`osp1`-`osp4`), Healing Ward (`ohwd`), Sentry Ward (`oeye`), Stasis Trap (`otot`),
   *  Watcher Ward (`nwad`), Monster Lure (`nlur`), Goblin Land Mine (`nglm`). They are units
   *  rather than structures, so nothing else in the data separates them from a soldier.
   *
   *  Like a worker, a ward is something a creep turns on LAST (see threatTier): a camp that
   *  chews on the Serpent Wards while the army that planted them stands on top of it is
   *  fighting the decoy instead of the fight. */
  ward: boolean;
  /** "Ancient" in UnitBalance.slk's `type` column — the six night elf structures that are
   *  really trees: Tree of Life/Ages/Eternity, Ancient of War/Lore/Wind/Wonders and the
   *  Ancient Protector. (Moon Well, Hunter's Hall, Altar of Elders and Chimaera Roost are
   *  `Mechanical` and are NOT ancients, which is the whole distinction below.)
   *
   *  Two things hang off it, and both are behaviour no other race has:
   *   • the Wisp that grows an Ancient is CONSUMED by it, while one that grows a Moon Well
   *     walks back out (see finishConstruction / killBuilding);
   *   • the game's own Targets Allowed carries a `nonancient` flag (the human Repair's targs
   *     list it), so this is the data's own idea of the category rather than ours. */
  ancient: boolean;
  /** For an Entangled Gold Mine (`egol`), the SimMine it stands on — the gold its crew pulls
   *  out. 0 for everything else. See tickMineCrews. */
  mineId: number;
  /** For an Entangled Gold Mine (`egol`), the Tree of Life whose roots are holding it — the
   *  unit that cast `Aent`. 0 for everything else.
   *
   *  The roots are the TREE's, not the mine's, which is why this link has to exist at all:
   *  an Ancient that pulls itself out of the ground lets go of everything it was holding, so
   *  the mine is released and its crew turned out the moment its Tree uproots. (Killing the
   *  Tree does NOT release it — an Entangled Gold Mine is its own building with its own 800
   *  hit points, and knocking it down is a separate job.) */
  entangler: number;
  /** The station this worker holds in a Haunted Gold Mine's MINING RING, 1-based, or 0.
   *
   *  `Abgm` "Blighted Gold mine" carries the whole arrangement: DataC "Max Number of Miners"
   *  = **5**, DataD "Radius of Mining Ring" = **200**. Undead gold is not a round trip and
   *  not a garrison either — the Acolytes kneel in a ring OUTSIDE the building, in the open,
   *  where anything can reach them. That is the trade the race makes for never walking its
   *  gold home: "up to five Acolytes may gather around the Haunted Gold Mine and begin adding
   *  gold to your reserves, without having to carry it back to the Necropolis"
   *  (classic.battle.net/war3/undead/basics.shtml).
   *
   *  Held rather than derived, because it is what keeps two Acolytes off one spot — and it is
   *  released everywhere a harvest job is (stop, a new order, death, the mine running out). */
  ringSlot: number;
  /** Seconds left of a root/unroot transition (`Aroo` `Dur1` = 2.5), or 0.
   *
   *  An Ancient is neither thing while it hauls its roots up or settles them back down, and
   *  the models author the pair of clips that says so. So the stance flips at once (everything
   *  derived from `uprooted` has to be consistent from the same instant) and the unit is then
   *  LOCKED for the animation's own length: it takes no orders (`castLocked`) and it does not
   *  move (`recomputeStats` zeroes the speed). Without it a walking Ancient slid across the
   *  ground mid-morph, and a planting one was already a building before it had sat down. */
  morphT: number;
  /** The facing a building was RAISED with, in radians — what an Ancient turns back to when it
   *  plants itself again.
   *
   *  WC3 gives every structure one facing (`bj_UNIT_FACING` = 270°), and a re-rooted Ancient
   *  is a structure again: it settles square with the rest of the base rather than keeping
   *  whatever direction it happened to be walking in. Kept per unit rather than as a constant
   *  because a map may place a building at any angle, and THAT is the angle it should return
   *  to. */
  builtFacing: number;
  /** Where an uprooted Ancient has been told to plant itself (`{kind:"rootat"}`), or null.
   *
   *  Root is a PLACEMENT, so the order names a spot the player picked off the build grid
   *  rather than "wherever you are standing". The Ancient walks there under an ordinary move
   *  and this is what it does when it arrives (tickRootAt). Cleared by planting, by failing to
   *  get there, and by any other order (`dispatch`). */
  rootPending: { x: number; y: number } | null;
  /** The gold mine an uprooted Tree of Life is on its way to wrap (`{kind:"entangleat"}`), or
   *  0. Taking an expansion is one order and three acts — walk to a spot beside the mine,
   *  PLANT, and only then cast Entangle — so this outlives `rootPending` (which is spent the
   *  moment the tree settles) and is what makes the cast happen on the far side of the root
   *  transition. See issueEntangleAt / tickEntangleAt. */
  entanglePending: number;
  /** The settling GESTURE of an Ancient that is planting itself, or null.
   *
   *  Planting is never a jump. The Ancient walks to the site under an ordinary move, which
   *  stops it within a body of the spot and facing whatever way it happened to travel — and a
   *  building has to end up ON its site, square with the base (`builtFacing`). So the last
   *  stretch and the turn are played out across the root transition itself (`morphT`) rather
   *  than applied the instant the stance flips: `x0/y0/f0` is the pose the walk left it in,
   *  `x1/y1` the site, and `dur` the transition's own length to divide them by.
   *
   *  This is the whole of "an Ancient roots where it stands": with no teleport left in the
   *  plant, a site under the tree's own feet is an ordinary placement like any other. */
  rootSettle: { x0: number; y0: number; f0: number; x1: number; y1: number; dur: number } | null;
  /** What this worker was doing when it climbed into a cargo hold, or null.
   *
   *  Stand Down's own words are "Causes Peons within the Burrow to return to work", and this is
   *  the memory that lets it keep them: boarding cancels the job (`detachBuilder`), so unless
   *  it is written down first there is nothing left to return TO and a burrow emptied after a
   *  raid left every peon standing in the yard. Taken at `issueGarrison`, spent by
   *  `resumeGarrisonJob`, and dropped by any other way out of the hold. */
  garrisonJob: GarrisonJob | null;
  /** The Moon Well this unit has been SENT to drink from (`{kind:"drink"}`), or 0.
   *
   *  Replenish is the one ability in the game whose button is on one unit and whose order is
   *  given to another: you right-click the well with the drinker selected, and it is the
   *  drinker that walks. So the order lives here, on the unit that was told to go, and the
   *  well reads it when the drinker arrives (tickReplenish). Cleared by the pour, and by any
   *  other order the unit is given (`dispatch`). */
  drinkWellId: number;
  /** Who this Moon Well is currently pouring itself into (`Ambt`), or 0. Replenish is not an
   *  instant: the well spends its mana into ONE unit at a rate, so the pour has to be state
   *  rather than a one-shot effect. See tickReplenish. */
  replenishTargetId: number;
  /** Seconds until this unit's Exhume Corpses passive grows its next body (`Aexh`, the Meat
   *  Wagon's upgrade). 0 on everything else, and reset to `Dur1` each time it fires. */
  exhumeLeft: number;
  isSummon: boolean; // a summoned unit (Water Elemental) — leaves no corpse, ×0.5 XP
  spawning: number; // >0: materializing (playing its birth clip) — cannot act yet
  summonLeft: number; // >0: a temporary summon that expires (Water Elemental); else 0
  summonMax: number; // the summon's full duration (for the "Summoned Unit" bar fill)
  /** The summoner this summon is BOUND to (0 = none, which is almost everything). A bound
   *  summon leaves the moment its summoner does — "Lasts 50 seconds or until the avatar
   *  dies" (`Avng`). Provenance alone is not enough to set this: an Archmage dying does not
   *  take his Water Elemental with him, so only an ability that says so binds. */
  summonerId: number;
  /** A Mirror Image illusion: a copy of the caster that fights but cannot hurt anything.
   *  Its factors come from AOmi's own data (AbilityMetaData names the columns):
   *  DataB "Damage Dealt (%)" = 0 and DataC "Damage Taken (%)" = 2. The unit is otherwise
   *  an exact copy — same type, same stats on the sheet — which is the point: only its
   *  owner can tell it apart. It is also a summon (isSummon), so it expires, leaves no
   *  corpse and dies to Dispel Magic. */
  isIllusion: boolean;
  /** The sim id of the unit this illusion copies (0 = not an illusion). The images have to
   *  be findable FROM their original — they level with it — and matching on owner+typeId
   *  would be a guess that quietly breaks the moment a player fields two of the same type. */
  illusionOf: number;
  illusionDamageDealt: number; // fraction of its damage that lands (AOmi DataB) — 0 = none
  illusionDamageTaken: number; // multiplier on damage it receives (AOmi DataC) — 2 = double

  /** The effect that replaces this summon when it LEAVES — its timer running out or a
   *  re-cast dismissing it. Carried from the ability that summoned it (its buff's
   *  Effectart: Feral Spirit -> feralspiritdone). "" = leave without one. This is not a
   *  death: a summon killed in combat plays its Death clip and dissipates instead. */
  unsummonArt: string;
  pendingCast: PendingCast | null; // in-progress cast (order === "cast")
  /** An attack modifier aimed BY HAND at one target: the next blow that lands on it carries
   *  the effect and pays for it, once. See isArrowOrb / issueArrowShot. */
  arrowShot: { code: string; targetId: number } | null;
  /** Marked by Black Arrow / Orb of Darkness (`ANba`/`ANbs`): dying while marked raises the
   *  ability's `UnitID1` in this unit's place, for whoever laid the mark. The mark is the
   *  whole of the effect — it does no damage of its own — so it is state on the VICTIM,
   *  cleared when the buff that carries it expires (see tickBuffs) and read in kill(). */
  blackArrow: { abilityId: string; rank: number; sourceId: number; owner: number; team: number } | null;
  /** DOOM (`ANdo`): the same shape as the Black Arrow mark and for the same reason — the
   *  effect is what happens when the unit DIES, so the fact rides the victim. Dying under
   *  Doom summons `UnitID1` (`nba2`, a Doom Guard) for `Ndo3` = 120 seconds. */
  doomed: { abilityId: string; rank: number; sourceId: number; owner: number; team: number } | null;
  /** IMMOLATION (`AEim`): the ability id currently alight on this unit, "" when it is out.
   *  A toggle, not a cast — see tickImmolation for the mana it burns to stay lit. */
  immolation: string;
  immolationTick: number; // seconds accumulated toward the next burn (`Dur1` = 1s)
  /** CLOAK OF FLAMES (`AIcf`) — the same accumulator for the CARRIED burn, kept apart from
   *  Immolation's so the two clocks cannot interfere (they never run together anyway: the
   *  cloak stands down while its wearer is alight — see tickCarriedItems). */
  cloakBurnTick: number;
  /** AMULET OF SPELL SHIELD (`ANss`) — seconds until the shield grows back after a block
   *  (`Cool1` = 40). 0 = ready, or no amulet carried. */
  spellShieldCooldown: number;
  /** BIG BAD VOODOO (`AOvd`): seconds of ritual left, and the ability running it. A CHANNEL,
   *  so this counts down only while the Shadow Hunter is still standing there casting — see
   *  tickVoodoo, which is also what hands the invulnerability out. */
  voodooLeft: number;
  voodooAbil: string;
  /** Marked by Incinerate (`ANia`/`ANic`): dying while still aflame blasts everything nearby.
   *  Paired with the "incinerate" buff, whose `value2` counts the stacks. */
  incinerate: { abilityId: string; rank: number; sourceId: number } | null;
  // --- neutral-hostile creep guard AI (see the CREEP_* constants) -----------
  isCreep: boolean; // a map-placed Neutral Hostile creep with guard/leash behaviour
  /**
   * A map-placed unit of a COMPUTER player, standing where the map put it — so it keeps the
   * LEASH half of the guard behaviour without any of the rest (no sleep, no camp, no bounty).
   *
   * `Units\MiscGame.txt` states the rule for a *unit*, not for a creep: "After a unit has
   * strayed 'GuardDistance' from where it started, that unit begins thinking about heading
   * back to its start position." Only its `MaxGuardDistance` sentence says "creep". Without
   * it an auto-acquired chase RATCHETS — kill something 600 out, re-acquire from the new
   * spot, and repeat — and a placed unit walks off across the map. Rise of the Naga is the
   * case: Illidan waits at the harbour a thousand units from the fishing village's ships,
   * and two ship deaths is a scripted defeat, so a drifting Illidan lost the chapter before
   * the player got anywhere near him.
   *
   * Cleared the moment anything COMMANDS the unit (see clearGuardPost): a trigger that sends
   * it somewhere has given it a new job, and the harbour sequence sends exactly these units
   * at exactly those ships when it is time.
   */
  guarding: boolean;
  /**
   * This post was planted by the unit's OWN auto-acquisition (tickAcquire), not by the map.
   *
   * `MiscGame.txt` writes the leash for a unit in general — "After a unit has strayed
   * 'GuardDistance' from where it started, that unit begins thinking about heading back to
   * its start position" — and only its `MaxGuardDistance` sentence says "creep". So a player's
   * unit that picks a fight for itself gets the first rule and not the second: it comes back
   * from a chase it was never told to make, but nothing drags it out of a fight it is losing.
   */
  guardAuto: boolean;
  guardX: number; // guard ("home") position — where it was placed; it leashes back here
  guardY: number;
  guardFacing: number; // facing to restore once it has returned home
  aggroRange: number; // acquisition range (per-placed targetAcquisition, else the weapon's)
  canSleep: boolean; // sleeps at night when guarding at home (UnitData `cansleep`)
  asleep: boolean; // currently asleep (won't auto-acquire; wakes on damage/proximity/camp)
  returning: boolean; // leashing back to the guard point (ignores enemies until home)
  campHelper: boolean; // fighting only because a camp-mate called for help (may not call for help itself)
  campGuard: boolean; // war3mapUnits.doo targetAcquisition -2 ("Camp") — guards its ground, deaf to new construction

  strayT: number; // seconds chasing past GUARD_DISTANCE without being attacked (→ return)
  returnBestDist: number; // closest-to-home distance reached this return (stuck detection)
  returnStuckT: number; // seconds making no homeward progress while returning (→ give up, fight)
  // --- inventory (heroes) ---------------------------------------------------
  inventory: (HeldItem | null)[]; // 6 slots for heroes ([] for units without an inventory)
  getItemId: number; // ground item this unit is walking to pick up (order === "getitem"; 0 = none)
  pendingGive: { toId: number; slot: number } | null; // walking to hand a slot's item to another hero
  /** Walking to a SHOP to sell a slot's item (WC3: right-click the item, click the shop —
   *  the same gesture as dropping it, but the shop takes it and pays). See issueSellItem. */
  pendingSell: { shopId: number; slot: number } | null;
  pendingDrop: { slot: number; x: number; y: number } | null; // walking to a spot to drop a slot's item
}

/**
 * Is this unit OFF THE FIELD — carried inside something, swallowed, or whisked away?
 *
 * Inside a gold mine, inside the structure it is building (the Orc peon), garrisoned in a
 * Burrow, digesting inside a Kodo, or `vanished` for the beat of Mirror Image's shuffle. The
 * common fact is that the unit has no position anybody can see: it is not merely fogged, it is
 * not on the map. Nothing draws it, nothing can target it, and — measured against the real
 * 1.27a client — **it gets no minimap dot, not even its owner's**.
 *
 * It lives here, next to `SimUnit`, because four separate places have to agree on it and the
 * expression had already been written out twice: `hiddenFor` (the render/fog question),
 * `minimapDots` (which used to override it and was wrong for it — Phase E item 3c),
 * `visibilityFor` (the snapshot send rule, which drops these for everyone but the owner) and
 * now `dotsFromSnapshot` (item 10c — the client's minimap reading the same off-field rule off a
 * `UnitSnapshot`). Copies of a five-term disjunction are chances to add a sixth term to some.
 *
 * The parameter is a STRUCTURAL type, not `SimUnit`: a `UnitSnapshot` carries the same five
 * flags and must give the same answer, so the client's snapshot minimap and the host's sim
 * minimap cannot drift on what counts as off the field.
 *
 * Deliberately NOT a fog or ownership test. Whether the OWNER should still be told about the
 * unit is a separate question each caller answers differently — a snapshot says yes (a Burrow
 * must list its garrison), the minimap says no (WC3 draws no dot).
 */
export function isOffField(u: {
  inMine: boolean;
  insideBuild: boolean;
  inBurrow: boolean;
  devouredBy: number;
  vanished: boolean;
}): boolean {
  return u.inMine || u.insideBuild || u.inBurrow || u.devouredBy > 0 || u.vanished;
}

/** The [Errors] key for "refused, but the game has no line for this" — an empty key finds no
 *  string, so the UI beeps and stays silent. Named so the intent isn't mistaken for a bug. */
const SILENT_REFUSAL = "";

const ARRIVE_EPS = 8; // world units — "close enough" to a waypoint
// Hero inventory reach, straight from the Gameplay Constants. Note that picking an
// item up reaches FURTHER than dropping one does (150 vs 100) — they are separate
// constants in the game, not one shared radius.
const ITEM_PICKUP_RANGE = MISC_GAME.PickupItemRange;
const ITEM_GIVE_RANGE = MISC_GAME.GiveItemRange;
const ITEM_DROP_RANGE = MISC_GAME.DropItemRange;
// Being PAID for an item: the coins that land on the seller, the label of the sound they
// land with, and how long they last (issue #120).
//
// Neither is a choice — the game keeps a purpose-built pair for "you were just credited
// gold" and names both halves in its own data:
//
//  • the SOUND is what makes a building a shop in the first place. `[Apit] Effectsound =
//    ReceiveGold` (1.27a Units\CommonAbilityFunc.txt) — "Shop Purchase Item", the very
//    ability canPawnAt() looks for — and it is the same coin "cha-ching" a Chest of Gold
//    pays out with (`[AIgo] Effectsound = ReceiveGold`, Units\ItemAbilityFunc.txt). It is
//    a LABEL, not a path: AbilitySounds.slk row Y38 carries the wav and its 3D metadata.
//  • the ART is UI\Feedback\GoldCredit — coins (Textures\gold.blp) over a star sparkle,
//    filed under the interface FEEDBACK models rather than with any one spell, because it
//    belongs to no spell: it is what a credit LOOKS like. The Chest of Gold reaches it the
//    long way round, through the `SPN…GDCR` spawn event on its ground model's death track
//    (see removeItemModel), which is why nothing names it in a Func file.
//
// Its lone clip runs 1.334 s (read off the MDX), so the coins are reaped on that rather
// than on the flat 2 s an effect with nothing to say about its own length gets.
//
// NOT Transmute's `[BNtm] Specialart` PileofGold.mdx, which the issue reached for: that one
// is a 6.3-second pile settling where a body melted, art for the corpse rather than for the
// payment, and it lingers under the hero long after the sale is over.
const PAWN_GOLD_ART = "UI\\Feedback\\GoldCredit\\GoldCredit.mdx";
const PAWN_GOLD_SOUND = "ReceiveGold";
const PAWN_GOLD_FX_LIFE = 1.334;
// A move ordered within this distance of the unit only turns it in place (WC3
// doesn't shuffle a unit a few pixels — it just pivots to face the point).
const MOVE_MIN_DIST = 40;
// WC3 turn rate (hiveworkshop thread 129619): the object-editor value is
// radians per internal 0.03s frame, capped at ~0.2 rad/frame (≈381.95°/s).
const TURN_FRAME = 0.03;
const TURN_RATE_CAP = 0.2;
const FACING_EPS = 0.35; // radians — must roughly face the target to swing
// Hysteresis: once a unit is attacking in range, the target must move this much
// FURTHER than weapon range before it gives chase again — stops the walk/attack
// animation flip-flop (and position jiggle) at the range boundary.
const ATTACK_LEASH = 48;
// Combat-approach watchdog (issue #24). An attacker that neither gets within its
// strike band nor makes real headway toward its target over this window has an
// effectively blocked route — whether it stands still or wobbles in and out of a
// tight crowd (settling/re-pathing every few ticks, which slips past both the
// per-tick "moving" reset and the 0.5s stuck window). It then re-decides: repath if
// the target is still reachable, else switch to the nearest target it CAN reach,
// else stand & face. "Headway" is measured two ways over the window — net ground
// covered AND how much the gap to the target shrank — and either one clears it, so a
// unit marching in, or chasing a runner it's keeping pace with, is never mistaken for
// a stuck wobbler (which does neither). ATTACK_PROGRESS is the least of either that
// still counts as genuine progress.
// A* expansion cap for LOCAL combat pathing (chases + reachability probes). The target
// is always within acquisition range (~25 cells), so a reachable path is found in a few
// hundred expansions; a bigger flood only ever happens when the target is unreachable,
// where we want to bail to a best-effort short path fast rather than flood the whole map
// (the full 8192 cap × 100 units all probing one crowded target was the ~20fps stall).
const COMBAT_EXPANSIONS = 700;
const ATTACK_STALL_TIME = 0.6;
const ATTACK_PROGRESS = PATHING_CELL * 1.5; // 48 world units per window
// After a unit gives up on an unreachable target with nothing else reachable, it
// commits to standing for this long before probing again — so a permanently boxed-in
// unit stands STILL instead of taking a shoved-back step every second (the residual
// micro-wobble). It still re-checks periodically in case a blocker dies or the target
// moves into reach.
const ATTACK_GIVEUP_COOLDOWN = 1.5;
// When an attacker keeps failing to make headway even though A* says the target is
// reachable — the outer unit of a full surround, where the pathfinder threads the ring's
// gaps but live collision keeps blocking the last stretch — it stops chasing and HOLDS,
// with a backoff that grows each time it re-stalls (capped here). A permanently over-
// surrounded unit thus ends up standing still, re-probing only every few seconds, instead
// of jittering at the range edge every tick. It leaves the hold the instant it gets into
// range or the target moves (so it's responsive when the fight actually shifts).
const ATTACK_HOLD_MAX = 4.0;
// How long an EXPLICITLY ordered attacker (player right-click / Attack command / trigger
// order) keeps shoving toward its commanded target before it will even consider another
// one (issue #83). A unit squeezing out of its own army, or round a building, routinely
// makes no headway for a second or two — that is not "unreachable", and giving up on the
// order there is what made units peel off onto whatever stood closer. After this long on
// the same spot we ask the PATHFINDER: still reachable → jammed by bodies, keep the target
// and hold facing it; genuinely unreachable → release the commitment and fall back to the
// nearest enemy we can reach. Automatic (non-ordered) targeting is unchanged.
const ORDERED_COMMIT_TIME = 2.0;
const CHASE_REPATH = 128; // repath when the target strays this far from the path goal
const FOLLOW_GAP = 64; // edge-to-edge distance a follower keeps behind its leader
// Hysteresis for follow (mirrors ATTACK_LEASH): once caught up and parked, the
// leader must drift this much FURTHER than FOLLOW_GAP before the follower gives
// chase again — without it the follower flip-flops chase↔settle at the gap edge
// every tick (settle() snaps it to the grid, nudging the gap back over the line),
// which flickers the walk↔stand clip and visibly jiggles the model.
const FOLLOW_LEASH = 48;
const FOLLOW_SLOT_ARRIVE = 24; // how close a fanned follower parks to its formation slot
const ACQUIRE_PERIOD = 0.5; // seconds between idle auto-acquire scans
// How far an idle unit will look to JOIN a fight a friend is already in (issue #24). It
// wider than a unit's own acquisition range (~500) so a back-rank unit rallies to a
// nearby melee instead of standing idle a few paces behind it, but bounded so an idle
// unit doesn't sprint across the map to every distant skirmish. Only enemies actively
// attacking an ally qualify (see assistTarget), so it never wakes a peaceful creep camp.
const ASSIST_RANGE = 800;
// A mover that cannot take the next tile waits this long before recalculating a route
// AROUND whoever holds it (issue #108's "path-finding disruption"). Short enough that
// walking in front of a unit visibly re-routes it, long enough that a walker briefly
// crossing our tile is simply waited out instead of triggering an A* every time.
const BLOCKED_REPATH_TIME = 0.3;
// A mover whose way is shut by other BODIES parks and tries again after this, growing with
// the length of the jam up to BLOCKED_WAIT_MAX. It does NOT lose its order: bodies move, so
// where the unit was sent is still where it is going (issue #108). Only terrain that puts
// the destination out of reach ends a move.
const BLOCKED_WAIT = 0.5;
const BLOCKED_WAIT_MAX = 3.0;
const STUCK_TIME = 0.5; // seconds of blocked movement before a unit gives up
const STUCK_RATIO = 0.3; // "blocked" = actual displacement below this share of expected
// When two units meet head-on, the lower-priority one pauses for YIELD_TIME so the
// other can clear — this breaks the symmetric "dance" (both endlessly sidestepping
// into the tile the other just vacated) instead of letting it churn for seconds.
const YIELD_TIME = 0.2;
// Air units ignore ground pathing & collision *while cruising* (issue #31), so a
// group flies as one point and stacks perfectly on arrival / when swarming a
// target. WC3 flyers don't stack: once stopped (arrived or fighting) they glide
// apart until their collision hulls no longer overlap. This is the max drift speed
// of that fan-out, as a share of the flyer's own move speed — a share (not full
// speed) so it reads as a gentle spread rather than a pop.
const AIR_FANOUT_SPEED = 0.6;
// Human "speed build": each builder beyond the first adds SPEED_BUILD_BONUS to the
// build rate (1.0 = one builder) and, spread across the shortened build time, a
// SPEED_BUILD_SURCHARGE share of the base cost per extra builder. Tuned to WC3's
// Town Hall reference: 5 peasants take ~53s (from 90s) and cost ~615g (from 385g).
const SPEED_BUILD_BONUS = 0.17;
const SPEED_BUILD_SURCHARGE = 0.15;
// Per-race construction style (engine behaviour, not a data field — observed in-game +
// Warsmash). ORC/NIGHT ELF workers build from INSIDE the structure (hidden, one worker,
// no assist); HUMAN peasants build from outside and can "speed build" — extra peasants
// pile on to finish faster (SPEED_BUILD_*). Undead acolytes summon-and-leave (handled
// elsewhere).
//
// The night elf half of that has a second rule the orc half does not, and it is the one
// thing every night elf player plans around: a Wisp that grows an ANCIENT is spent by it and
// never comes back out, while a Wisp that grows a Moon Well / Hunter's Hall / Altar of Elders
// / Chimaera Roost walks out again when it is done. The category is the data's own —
// UnitBalance.slk `type` = "Ancient" (SimUnit.ancient) — and the split is exactly where that
// column falls. Cancelling always gives the Wisp back, because nothing was finished; and a
// half-built ANCIENT knocked down takes the Wisp inside it with it, while a half-built Moon
// Well lets it go (Warcraft Wiki, Wisp). See finishConstruction / releaseBuilders.
function buildsFromInside(u: SimUnit): boolean {
  return u.race === "orc" || u.race === "nightelf";
}
function speedBuilds(u: SimUnit): boolean {
  return u.race === "human";
}
/** The Undead do not BUILD, they summon — and the difference is that nobody has to stay.
 *
 *  "Acolytes do not need to maintain buildings under construction. Buildings will continue
 *  construction on their own (like Protoss) so start a building summoning then move the
 *  Acolyte to another task" (classic.battle.net/war3/undead/basics.shtml). So an Acolyte that
 *  reaches its site hands the structure its own clock (`BuildingState.selfBuilds`) and is
 *  released on the spot: it can be sent back to a mine, or on to the next building, while the
 *  first is still rising. That is the whole of the Undead build order — one Acolyte lays a
 *  Ziggurat, a Crypt and an Altar in the time a Peasant lays one — and it is why nothing can
 *  interrupt an Undead building by killing its worker.
 *
 *  Nothing else in the game works this way except the Entangled Gold Mine, which arrives at
 *  the same flag from the other end (nobody CAN be put on it). */
export function summonsBuildings(u: SimUnit): boolean {
  return u.race === "undead";
}
/** The grid domain a unit searches — see SimUnit.waterborne. */
function pathDomain(u: SimUnit): PathDomain {
  return u.waterborne ? "water" : "ground";
}
// Proactive reroute poll (issue #6). A unit's path is computed once, but other
// units may stop and reserve cells across it while it travels. Rather than let a
// unit grind into that crowd until checkStuck() fires (0.5 s of no progress),
// every REPATH_POLL seconds it re-checks the path just ahead and, if a unit has
// since blocked it, recomputes the route around the obstruction. REPATH_LOOKAHEAD
// bounds how far ahead (world units) the check scans — deliberately local, so a
// distant block that may clear before arrival doesn't trigger a needless reroute.
const REPATH_POLL = 0.25;
/** How many sim steps a crowd's reroute polls are spread over — see `repollT`'s stagger.
 *  REPATH_POLL is 15 steps at SIM_DT, so 15 phases puts at most one unit's poll on any one
 *  step and no unit ever waits longer for its first poll than it would have anyway. */
const REPATH_POLL_PHASES = 15;
const REPATH_LOOKAHEAD = PATHING_CELL * 5; // ~5 cells (160 world units) ahead
/** Reroutes (a full A* each) any ONE sim step may run. The stagger above is what normally
 *  keeps this slack; this is the backstop for the case it cannot help — a hundred units
 *  shoved into the same corridor by the same event, all blocked on the same step. A skipped
 *  reroute is not a lost one: the poll comes round again in REPATH_POLL, and checkStuck() is
 *  the backstop it always was. Deliberately generous — this must bite only pathologically. */
const REPATH_BUDGET_PER_STEP = 4;
/** What a trip is worth when the worker's own harvest row does not say (`Aaha`, the Acolyte's,
 *  carries no columns at all). Every worker that DOES say — `Ahar` DataC = 10 — is read off
 *  the row instead (WorkerState.goldPerTrip, applyHarvestData). */
const GOLD_PER_TRIP = 10;
/** How far off a gold mine's own hull a Haunted Gold Mine placement still snaps to it. One
 *  build square past the mine's radius — enough that the ghost latches on as the cursor
 *  crosses the mine, and not so much that a click on open ground beside it is silently
 *  redirected. (WC3 states no number; the mine is 16×16 pathing cells, so its own body is by
 *  far the larger half of this.) */
const HAUNT_SNAP = BUILD_CELL;
/** How far out along its own ray a mining-ring station may be pushed to find walkable ground.
 *  A gold mine's `16x16Goldmine` footprint is 512 units across — 256 from its centre, past
 *  `Abgm`'s 200 ring — so on those sides the station has to clear the building itself. See
 *  SimWorld.ringStation. */
const RING_PUSH = 256;
// Gold Mine ability `Agld` in AbilityData.slk — its unlabelled Data columns are named by
// AbilityMetaData.slk + UI\WorldEditStrings.txt: DataA "Max Gold" 12500, DataB "Mining
// Duration" 1, DataC "Mining Capacity" 1. Capacity 1 is the `SimMine.busy` latch: a classic
// gold mine holds exactly ONE worker at a time and the rest queue at the rim.
const MINE_TIME = 1.0; // seconds a worker spends inside the mine (Agld DataB)
/** How many times a gatherer that came to rest SHORT of its node re-issues the approach
 *  before parking where it stands (arriveAtNode). Small: two honest A* attempts per leg
 *  of the round trip beat both a fake arrival and a per-tick re-flood. */
const NODE_REPATH_TRIES = 2;
const TREE_LUMBER = 50; // lumber a standard tree yields before falling
// Tree hit points, separate from lumber: harvesting drains `lumber`, but area
// spells that list `tree` in Targets Allowed (Flame Strike) burn a tree down by
// HP. 50 HP, armor "Wood" — DestructableData.slk `ATtr` (Ashenvale Tree Wall),
// the standard tree destructible; `hp=50`, `targtype=tree`.
const TREE_HP = 50;
const TREE_RADIUS = 16; // half a tree's 2×2-cell footprint, for the reach latch
const DEPOSIT_RANGE = 64; // gap to a depot edge to turn in the load
const RETARGET_RANGE = 1200; // how far a worker looks for the next tree
/** How far an autocasting Wisp looks for a damaged building to Renew. A wisp has no weapon,
 *  so it has no `acquire` of its own to borrow (the number every other friendly autocast uses
 *  — see autocastSearchRange); this is the Ancient of War's 500 acquisition range, the closest
 *  thing the night elf data has to "as far as a building's business reaches". */
const RENEW_SEEK_RANGE = 500;

// --- hero XP / leveling ---
// The tables and thresholds live in data/gameplayConstants (Units\MiscGame.txt),
// derived from the game's own base lists + `f(x) = A·f(x-1) + B·x + C` formulas.
// Cross-checked with Liquipedia: Experience + warcraft3.info article 232.
const MAX_HERO_LEVEL = MISC_GAME.MaxHeroLevel;
/** Heroes within this of a kill share its XP; with none in range, GlobalExperience=1
 *  spreads it across all the killer's heroes instead. */
const XP_SHARE_RANGE = MISC_GAME.HeroExpRange;
const SUMMON_XP_FACTOR = MISC_GAME.SummonedKillFactor;

// Attribute → stat conversions (MiscGame Str/Int/Agi bonuses; Liquipedia: Hero).
const HP_PER_STR = MISC_GAME.StrHitPointBonus;
const MANA_PER_INT = MISC_GAME.IntManaBonus;
const ARMOR_PER_AGI = MISC_GAME.AgiDefenseBonus;
const REGEN_PER_STR = MISC_GAME.StrRegenBonus; // hp/sec per Strength point
const REGEN_PER_INT = MISC_GAME.IntRegenBonus; // mana/sec per Intelligence point
// Attack-speed (IAS) caps. NOT in MiscGame/MiscData — neither file carries any attack-speed
// cap key; the engine hardcodes them, so they live here at the use site rather than in
// gameplayConstants.ts (which mirrors the data files). "The most FAR a unit can have is +400%
// or -80%, afterwhich any excess is wasted" — Hive "Attack Speed Formula?" #12 (Dr Super Good);
// the pair mirrors each other (5x vs 1/5x). They clamp the SUMMED bonus, before the division.
const IAS_MAX = 4.0; // +400% — cannot swing faster than 5x its base attack time
const IAS_MIN = -0.8; // -80% — cannot be slowed below 1/5 of its base attack rate
const DAMAGE_POINT_FLOOR = 0.02; // a swing always lands 0.02s before it may start the next
const UNIT_MANA_REGEN = 0.67; // flat mana/sec for non-hero casters (approx WC3 base)
const AURA_REFRESH = 0.5; // aura buffs re-applied each tick with this TTL (fade on leave)
/** Big Bad Voodoo's invulnerability is handed out on the same short leash an aura is, for
 *  the same reason: a broken CHANNEL has to strip it from everybody the same instant, and
 *  the cheapest way to make that true is to stop renewing it. Shorter than AURA_REFRESH —
 *  "instantly" is what the ritual breaking is supposed to feel like. */
const VOODOO_REFRESH = 0.25;
const FACING_CAST_EPS = 0.4; // must roughly face a unit target to cast
// Channelled abilities (base code): the caster stands locked for the channel and a
// new order stops it AND the remaining ticks (unlike a backswing, which is free to
// cancel because its effect already happened). These are WC3's stand-and-channel
// hero spells — verified against AbilityData.slk + Liquipedia: Blizzard, Rain of
// Fire, Starfall, Tranquility, Death and Decay, Stampede, Earthquake. NOT channelled
// (fire-and-forget, caster free right after the cast): Flame Strike, Volcano, Locust
// Swarm, Bladestorm (the Blademaster keeps moving), Immolation, Cluster Rockets.
// Life Drain / Siphon Mana (AHdr) is a channel too, and the one whose channel is the WHOLE
// spell: Liquipedia is explicit that the Dark Ranger's Drain "is a channeling spell" that
// ends the moment she moves, attacks, casts again or is stunned, and that the life stops
// transferring with it. Its channel length is the plain `Dur1` (6s Siphon Mana, 8s Drain) —
// it schedules no wave field, so the teardown is tickDrains rather than tickSpellFields.
// Big Bad Voodoo joins them on its `Animnames = stand,channel`, which is the data saying the
// Shadow Hunter stands in his own circle for the whole 30 seconds. Its protection is renewed
// off the caster's tick rather than off the field (see tickVoodoo), so it needs no field of
// its own; what CHANNELED buys it is the standing, the looped channel clip, and the break.
const CHANNELED = new Set(["AHbz", "ANrf", "AEsf", "AEtq", "AUdd", "ANst", "AOeq", "AHdr", "AOvd"]);
// Delayed-strike abilities that drop their Effectart (a ground "beware" warning) the
// moment the cast WIND-UP begins — not when it lands — so it charges up in place and
// REMAINS visible even if the cast is interrupted before ignition. Flame Strike's
// FlameStrikeTarget smoke vortex (MPQ AHfs Effectart; Liquipedia: interrupting the
// Blood Mage — by moving or a stun — leaves only the gong + vortex, no flames). The
// strike itself (pillar + burn) still needs the wind-up to finish (see spells AHfs).
const PRECAST_WARNING = new Set(["AHfs"]);
/**
 * Abilities whose OWN art plays at the moment the button is pressed — at the start of the
 * wind-up, on the caster — rather than at the cast point with the effect. Not a warning like
 * PRECAST_WARNING (which paints the target's ground and charges the cast up front): this is
 * the caster's own flourish, which in WC3 begins with the gesture and not with what the
 * gesture throws. The Warden is both cases:
 *
 *   [AEbl] Specialart = …\Blink\BlinkCaster.mdl   the smoke she goes out in
 *   [AEfk] Effectart  = …\FanOfKnives\FanOfKnivesCaster.mdl   the burst she spins up
 *
 * Her Cast Point is 0.5s (UnitWeapons.slk Ewar castpt), so held to the effect both read as
 * half a second LATE — the blades are already out before the burst that threw them.
 *
 * `follow` = ride the caster (the burst spins with her); false = stand where it was struck,
 * which is what Blink's plume needs — it is "art to LEAVE BEHIND at old coordinate" and the
 * caster is about to be somewhere else.
 *
 * `sound` = the model brings the cast sound with it. True only where the model actually
 * CARRIES one: BlinkCaster.mdx keys `SNDXAEBL` (→ BlinkBirth1.wav, the departure), so the
 * pair does not split across the wind-up and the OTHER half — Blink's arrival — is what
 * still sounds at the cast point (see SPELL_SOUND_ART). FanOfKnivesCaster.mdx keys no such
 * event: Fan of Knives puts its cast sound on the WARDEN (`SNDXAEFK` on HeroWarden.mdx →
 * FanOfKnives.wav), which the renderer asks for by ability code at the cast point. Asking
 * the burst for a sound it hasn't got would fall through to "any WAV in the effect folder",
 * and the only WAVs there are the three MissileHit clips.
 */
/** The corpse abilities that CARRY rather than spend — the Meat Wagon's Get Corpse, and only
 *  it in 1.30. They are bounded by a cargo hold instead of a summon count, and they need a
 *  body that is FREE (one already aboard is still a corpse, and would otherwise read as work
 *  forever). Everything else in the family may use a held body exactly as it would one on the
 *  ground — see sim/corpses.ts. */
const CORPSE_LOADERS = new Set(["Amel"]);
/**
 * The corpse ITEMS, and the spell each of them actually is.
 *
 * These rows keep their own base code (AbilityData's `code` column) rather than collapsing
 * onto the spell they copy — `[AIrd] code = AIrd` even though the Rod of Necromancy is Raise
 * Dead down to the field group, and `[AIan] code = AIan` for the Scroll of Animate Dead. Only
 * the two Runes and the Scroll of Resurrection go the other way (`[APrl]`/`[APrr]`/`[AIrx]`
 * carry `code = AHre` outright and so need no entry here). The mapping is what lets the item
 * run the SPELL — one set of corpse rules, in the one place that owns them (sim/corpses.ts) —
 * with the item's own numbers on it: 65 seconds of skeleton against the Necromancer's 45.
 */
const ITEM_CORPSE_SPELL: Record<string, string> = {
  AIrd: "Arai", // Rod of Necromancy → Raise Dead
  ACad: "AUan", // `stre` Scroll of the Dead / the creep row → Animate Dead
  AIan: "AUan", // Scroll of Animate Dead → Animate Dead
  AIrs: "AHre", // Scroll of Resurrection → Resurrection
};
const CAST_START_ART: Record<string, (d: AbilityDef) => { art: string; follow: boolean; sound: boolean }> = {
  AEbl: (d) => ({ art: d.specialArt, follow: false, sound: true }),
  AEfk: (d) => ({ art: d.effectArt, follow: true, sound: false }),
};
/**
 * Abilities whose `Cast` column is NOT a casting time.
 *
 * AbilityData.slk's `Cast` is a wind-up for the spells that have one (Blizzard 1.0, Flame
 * Strike 0.9/1.33, Rain of Fire 1.0 — the Archmage really does hold his staff up before the
 * first shard). But the column is a free number, and several rows use it for something else
 * entirely. Shadow Strike's own Ubertip is the proof, quoting the field as an interval:
 *
 *     "…dealing <AEsh,DataE1> initial damage, and <AEsh,DataA1> damage every
 *      <AEsh,Cast1> seconds for <AEsh,Dur1> seconds."
 *
 * Cast1 = 3 there is the POISON TICK. Read as a wind-up it made the Warden stand still for
 * three seconds before every dagger — an ability that is instant in the real game. The
 * handler spends the number as what it is (see spells.ts AEsh); this is the other half,
 * keeping it out of the wind-up. Reincarnation (Cast=3, the revive delay), Replenish
 * (Cast=6, the pour) and Parasite (Cast=90) are the same kind of borrowing; they don't run
 * through the ordinary cast path, so they need no entry.
 */
const CAST_TIME_IS_NOT_A_WINDUP = new Set(["AEsh"]);
/** Abilities whose CAST ANIMATION runs for the ability's whole duration even though the
 *  caster is free to walk and fight through it — so they are NOT in CHANNELED, which would
 *  pin them in place. Bladestorm is the only one in 1.30: the Blademaster spins for `Dur1` =
 *  7 seconds while he keeps moving and killing, and the spin IS the ability. His model has a
 *  clip that exists for nothing else ("Attack Walk Stand Spin", see CAST_ANIM_FALLBACK), and
 *  without this it would be released after the ordinary cast backswing, a fraction of a
 *  second in. */
export const ANIM_FOR_DURATION = new Set(["AOww"]);
// Immediate abilities (base code): pressing the button IS the cast. No wind-up, no
// cast animation, and no re-tasking — the caster keeps attacking/walking straight
// through it. Two cases, both with `Cast1=0` in AbilityData.slk and no `Animnames`
// in their AbilityFunc:
//   - Divine Shield (and Cenarius's ACds, the same spell) — no Animnames in
//     HumanAbilityFunc.txt, and a toggle rather than an order (`Order=divineshield`
//     / `Unorder=undivineshield`): in WC3 the Paladin bubbles mid-swing without
//     dropping his attack.
//   - Wind Walk — no Animnames in OrcAbilityFunc.txt, and the Blademaster's model
//     carries no "Spell" clip at all (HeroBlademaster.mdx sequences: Stand*/Attack/
//     Attack Slam/Walk/Death/Dissipate/Attack Walk Stand Spin), so the engine has
//     literally nothing to show for the cast — it fades him where he stands and he
//     keeps walking. That is the escape micro the ability exists for.
// Do NOT widen this to every no-Animnames spell: Holy Light and Water Elemental have
// none either, yet the engine falls back to the caster's "Spell" clip for them (see
// RtsController.playCastAnim).
/** The ALTERNATE FORM UNIT a two-form ability morphs into — and the two abilities that need
 *  it disagree about which column it lives in, because AbilityMetaData names the columns per
 *  ability rather than globally:
 *
 *    [Abur]  UnitID1 = ucrm   "Alternate Form Unit"   (DataB there is "Morphing Flags" = 1)
 *    [Amil]  DataB   = hmil   "Alternate Form Unit"   (UnitID1 is empty)
 *
 *  So this reads UnitID1 first and falls back to DataB, which is the metadata's own answer for
 *  each rather than a guess. Reading DataB unconditionally would hand Burrow the number 1 as a
 *  unit id; reading UnitID1 unconditionally leaves the militia with no form to become. */
function altFormOf(lvl: AbilityLevel | undefined): string {
  return lvl?.summon || lvl?.dataStr[1] || "";
}

const IMMEDIATE = new Set(["AHds", "ACds", "AOwk"]);
/** Abilities that refuse a target for being TOO BIG, with the cap in their own `DataC`.
 *  Transmute is the only one in 1.30 and its Ubertip names both the rule and the column:
 *  "Transmute cannot be used on Heroes, or creeps above level <ANtm,DataC1>" (= 5). The
 *  hero half is already the row's `nonhero` flag; this is the other half, and the game
 *  ships the line for it — `Creeptoopowerful` = "That creature is too powerful."
 *  (Units\CommandStrings.txt [Errors]). */
const CREEP_LEVEL_CAP = new Set(["ANtm"]);
/**
 * The ARROWS, the loudest members of the ATTACK MODIFIER (orb) family — abilities that ride
 * on a shot rather than being one. The family itself, and the rule that only ONE of its
 * members may ride any given blow, lives in src/sim/orbs.ts.
 *
 * They are unit-target abilities in the data — `AHfa` (Searing Arrows) carries
 * `targs1 = air,ground,structure,enemy,neutral` and `Rng1 = 600`, `AHca` (Cold Arrows)
 * `air,ground,enemy,neutral`, `ANba` (Black Arrow) the same plus `organic`, `ANia`
 * (Incinerate) `enemy,neutral,organic,nonancient` — and each has a per-shot `Cost1` rather
 * than a per-cast one. So a manual cast is not a bolt fired at the target: it is an ATTACK
 * on that target whose next landed blow carries the effect and pays the mana, which is why
 * these need a path of their own rather than a SPELL_HANDLERS entry. Autocast is the same
 * effect standing on every shot instead of one (resolveOrb serves both).
 */
/** Buff group prefix worn by the regeneration items (`AIrg` — Healing Salve, Clarity
 *  Potion, Potion/Scroll of Rejuvenation). One prefix so a single filter drops both the
 *  life and the mana half together when the effect breaks. */
const ITEM_REGEN_GROUP = "item:regen";
/** Damage that dispels a regeneration item's effect. Not in any data file — see landDamage. */
const ITEM_REGEN_BREAK = 20;
/** The four `pickFlags` values of UI\UnitEditorData.txt, **in bit order** — the domain a
 *  building's UnitData `buffType` draws from and a staff's "Building Types Allowed" masks
 *  (see UnitDef.buffType and SimWorld.staffDestination). WorldEditStrings names them Hall,
 *  Resource, Factory and General; the index in this array IS the bit. */
const STAFF_PICK_CATEGORIES = ["townhall", "resource", "factory", "buffer"];
/** The race order the "Tiny" building items list their four unit ids in (`AIbl` UnitID1 =
 *  `htow,ogre,unpl,etol` — Town Hall, Great Hall, Necropolis, Tree of Life). Read off the
 *  Tiny Great Hall, which is the only one of the eight whose four entries differ. */
const TINY_BUILDING_RACES = ["human", "orc", "undead", "nightelf"];
/** What "crowd-controlled" means to the staves, which refuse to teleport a unit under any of
 *  it — "including with Purge" (Liquipedia), whose contribution is the plain `slow`. Every
 *  member is something holding the unit where it stands: a stun, a Sleep, Entangling Roots
 *  or Ensnare, a slow, or Banish's ethereal drag. */
const CROWD_CONTROL_BUFFS = new Set<BuffKind>(["stun", "sleep", "root", "slow", "ethereal"]);
/** Abilities that may be aimed at a magic-immune unit anyway. There is no flag for this in
 *  the ability data — no `targs1` value means "may target the immune" — so the engine
 *  hardcodes it and so must we, which is why the list is short and explicit rather than
 *  inferred. The dispels are the clear members: a Dryad's Abolish Magic and the Human
 *  Dispel Magic have to be able to clean a Spell Breaker, or a debuff placed before the
 *  immunity applied could never be removed. Kept deliberately narrow — add a code here only
 *  with a source, never to make a cast "work". */
const MAGIC_IMMUNE_EXEMPT = new Set(["Adis", "Aadm", "Adcn"]);
// Corpse decay (Units\MiscData.txt BoneDecayTime): a corpse persists 88s after
// death — the renderer sequences it Death → Decay Flesh → Decay Bone within this
// window — and is then removed. The flesh stage is an early sub-phase, not added
// on top; 88s is the full lifetime from the moment of death.
const CORPSE_TOTAL_TIME = MISC_DATA.BoneDecayTime;

// A HERO's body instead of a corpse (issue #126). It plays its death clip — the type's own
// `death` time — and then DISSIPATES, which `Units\MiscData.txt` states as a duration under
// its own heading "death and decay impact gameplay, so duration is specified":
// DissipateTime = 3.
//
// That window is the ENGINE's, not the model's, and the art says so: a hero's mdx animates no
// alpha at all (HeroPaladin.mdx loads with an empty `geosetAnimations` and no layer anims —
// read off the live model), so the going-away is ours to time and the clip is only the gesture
// inside it. HeroPaladin's Dissipate runs 2.0s of the 3.
export const HERO_DISSIPATE_TIME = MISC_DATA.DissipateTime;
/** The fade at the TAIL of that window — the last second of the dissipate, once the clip has
 *  played itself out, ramping the body away to nothing.
 *
 *  The tail rather than a fourth phase after it, and that is the whole reason it is written
 *  down here: a second added ON TO DissipateTime would leave the altar's button greyed for a
 *  second with nothing left on the field to justify it. No data file names a length for this
 *  (nothing about it "impacts gameplay"), so the one number here that is ours is a second — as
 *  issue #126 asks for. */
export const HERO_FADE_TIME = 1;

/** How long a fallen hero's body takes to leave the field altogether, given its type's death
 *  time: it falls, then it dissipates (the fade being the tail of that). Exported so the
 *  renderer sequences the model on the same clock the altar's revive button is gated on — the
 *  body finishing and the button lighting are one moment, and one number is how they stay
 *  one moment. */
export function heroBodyTime(deathTime: number): number {
  return Math.max(0, deathTime) + HERO_DISSIPATE_TIME;
}

// Repair's share of the target's repair cost and repair time, for a worker whose repair
// ability row could not be read (a bare test world with no ability registry). The live values
// are the ability's own DataA/DataB and are read per worker — see SimWorld.repairRates. Every
// stock repair row in 1.30.4 carries exactly these: Ahrp/Arep/Aren DataA1 0.35, DataB1 1.5.
const REPAIR_COST_RATIO = 0.35;
const REPAIR_TIME_RATIO = 1.5;

// WC3 day/night (Units\MiscData.txt): a full cycle is DayLength=480 real seconds =
// DayHours=24 game hours (so one game hour = 20 real seconds); daytime runs from
// Dawn to Dusk. Melee games open at bj_MELEE_STARTING_TOD = 08:00.
const DAY_START = MISC_DATA.Dawn;
const DAY_END = MISC_DATA.Dusk;

// Neutral-hostile creep guard/leash AI, from Units\MiscGame.txt. (These supersede
// the ~1.8×-aggro guess — the MPQ wins; see CLAUDE.md.)
const GUARD_DISTANCE = MISC_GAME.GuardDistance; // strayed this far from home → start the return timer
const MAX_GUARD_DISTANCE = MISC_GAME.MaxGuardDistance; // strayed this far → return home unconditionally, even under attack
const GUARD_RETURN_TIME = MISC_GAME.GuardReturnTime; // also the "can't get home, resume fighting" window
const CREEP_CALL_FOR_HELP = MISC_GAME.CreepCallForHelp; // camp cohesion: one aggros → the whole camp wakes/joins
// "Radius of creep notification when a new building gets placed" — Units\MiscData.txt's
// own comment on this constant. Laying a foundation shouts to the creeps around it, quite
// apart from anyone's acquisition range: this is why a gold mine's guards charge a Peasant
// who starts an expansion from further out than they'd have noticed him merely walking by.
const BUILDING_PLACEMENT_NOTIFY_RADIUS = MISC_DATA.BuildingPlacementNotifyRadius;
const CREEP_HOME_EPS = 64; // within this of the guard point counts as "home" (reset + can sleep)
// Hysteresis for the "walk back to post" trigger (mirrors ATTACK_LEASH / FOLLOW_LEASH):
// a return FINISHES at CREEP_HOME_EPS and settle() then snaps the creep to the grid —
// a snap of up to ~half a cell can nudge it just back over CREEP_HOME_EPS. Without a
// wider re-trigger threshold an idle creep resting near its post would oscillate
// finish→snap→return→finish, flickering the walk↔stand clip (the return "jiggle"). So a
// guarding creep only heads home again once displaced comfortably past the snap noise.
const CREEP_RETURN_TRIGGER = 128; // 4 cells — safely beyond CREEP_HOME_EPS + the settle snap
// Not in any data file (engine-internal): a sleeping creep only wakes to a hostile
// that strays very close — far enough that you can still scout past camps at night.
const SLEEP_WAKE_RANGE = 200; // a sleeping creep wakes if a hostile comes within this
// Shooting from the dark gives you away (issue #45). MiscData names no duration for
// FoggedAttackRevealRadius, so the blow buys the attacker's position one second,
// re-stamped by every following blow.
const FOGGED_ATTACK_REVEAL_RADIUS = MISC_DATA.FoggedAttackRevealRadius;
const FOGGED_ATTACK_REVEAL_TIME = 1;

// A DYING unit goes on seeing (issue #126). "Fog Reveal Radius - Dying Unit" is the World
// Editor's name for `Units\MiscData.txt` [Misc] DyingRevealRadius = 500 — a CAP on the sight
// the body keeps, not a radius handed to everything that falls: a unit already seeing less
// than 500 dies seeing exactly what it saw, and everything else is cut down to 500. In stock
// data that means almost every unit IS cut (a Footman sees 1400, a Peasant 800) and the
// critters, on 350, are not. (DotA sets the same constant to 500 and the guide reads it the
// same way — hiveworkshop "Vision guide" 290769.) How LONG it lasts is the type's own death
// time (UnitData `death`, UnitDef.deathTime) — the body sees for as long as it takes to fall.
const DYING_REVEAL_RADIUS = MISC_DATA.DyingRevealRadius;

/**
 * The sight a body keeps while it falls — a dying unit's own eyes, outliving it.
 *
 * Deliberately NOT a flag on the SimUnit: `kill()` deletes the unit from `units` in the same
 * breath, and a record that outlives its unit is exactly what this is. Keeping the dead unit
 * around instead would put a corpse back in every loop that walks `units` (targeting,
 * pathing, auras, the tech census) to be filtered out again in each of them.
 *
 * It is also what keeps us out of the original's bug. WC3 caps the DYING UNIT'S OWN sight
 * radius and restores it when the death timer runs out, so a hero revived faster than its
 * death time (a Tavern, an early Ankh) never gets the restore and walks around with 500 sight
 * for good — "he will permanently have incorrect vision until he respawns correctly". Here the
 * cap lives on this record and nothing on the revived hero was ever touched, so there is
 * nothing to restore and nothing to forget to restore.
 */
export interface DeathReveal {
  x: number;
  y: number;
  radius: number;
  /** The side that sees it — the DEAD unit's own, unlike an AttackReveal (which lights the
   *  attacker up for the side that was hit). */
  team: number;
  /** …and the slot it belonged to, so an ally who is granted shared vision gets it too and
   *  one who is not does not. Same test the living unit went through (Viewpoint.revealsFor). */
  owner: number;
  flying: boolean;
  timeLeft: number;
}

/**
 * Ground an ITEM lit up for a player (issue #130) — the only effect in the game that touches
 * vision without putting a unit on the map. A Crystal Ball's targeted circle, a Flare Gun's
 * flare, Dust of Appearance around the hero, a Potion of Omniscience's whole map, and the
 * Wand of Shadowsight's eye riding an enemy unit are all one record with different fields.
 *
 * Unlike an AttackReveal, this is the OWNER's sight, so an ally sharing vision gets it too
 * (the same `revealsForOwner` test a living unit goes through).
 */
export interface ItemReveal {
  x: number;
  y: number;
  radius: number;
  owner: number;
  team: number;
  timeLeft: number; // Infinity for one that ends some other way (see untilBuffGone)
  /** …and strips INVISIBILITY inside it, not merely fog: Dust of Appearance and the Crystal
   *  Ball both buy detection, a Flare Gun does not. See teamDetects. */
  detect: boolean;
  /** >0: the circle rides this unit rather than sitting at (x, y) — the Wand of Shadowsight. */
  unitId: number;
  /** Non-empty: it also ends the moment `unitId` stops carrying this buff group, which is how
   *  "until that unit is dispelled" is stated. */
  untilBuffGone: string;
}

/** A hidden attacker's position, given away to one team for a moment. */
export interface AttackReveal {
  x: number;
  y: number;
  radius: number;
  team: number; // the side that gets to see it — the one that was hit
  flying: boolean;
  timeLeft: number;
}

export class SimWorld {
  readonly units = new Map<number, SimUnit>();
  /** Every hero of every player that is currently dead and revivable (see FallenHero). */
  readonly fallen = new Map<number, FallenHero>();
  readonly mines = new Map<number, SimMine>();
  readonly trees = new Map<number, SimTree>();
  readonly projectiles = new Map<number, SimProjectile>();
  /** Per-player resource stash (gold/lumber). */
  readonly stash = new Map<number, { gold: number; lumber: number }>();
  /** Time of day in game-hours [0, DayHours); advances every tick. A melee game
   *  opens at 08:00 (Scripts\Blizzard.j bj_MELEE_STARTING_TOD). */
  timeOfDay: number = MELEE.MELEE_STARTING_TOD;
  /** `EnableDawnDusk(false)` — the clock STOPS (7.24). A cinematic freezes it so the shot
   *  plays under a constant light and doesn't drift from day into night halfway through;
   *  blizzard.j's CinematicModeExBJ turns it off on the way in and restores it on the way
   *  out. Nothing else in the game switches it. */
  dawnDusk = true;
  /**
   * `SetTimeOfDayScale` — how fast the clock runs, 1 being WC3's own day length.
   *
   * A MAP's setting, and campaign chapters lean on it hard: Rise of the Naga opens with
   * `SetTimeOfDayScalePercentBJ(25.00)` and `SetTimeOfDay(19.00)` — a night that creeps
   * forward at quarter speed, because the mission is written to be played in the dark. We
   * stored the number on the JASS runtime and never multiplied by it, so the chapter's night
   * ran out at full speed and the map was in broad daylight a few minutes in.
   */
  timeOfDayScale = 1;
  /** `SuspendTimeOfDay(true)` — the clock is HELD where it stands. A separate switch from
   *  `dawnDusk` because they are separate natives with separate owners: a map suspends the
   *  cycle for the whole mission (blizzard.j's `UseTimeOfDayBJ` is exactly this), while
   *  EnableDawnDusk is the cinematic's, restored the moment the cinematic ends. One must not
   *  hand the other's answer back. */
  timeOfDaySuspended = false;
  private deaths: number[] = [];
  /** Dead STRUCTURES, kept whole for the ghost path — see drainDeadStructures. */
  private deadStructures: SimUnit[] = [];
  /** The rotted ground itself, kept per terrain corner and painted ONCE by whatever grew
   *  it (see BlightGrid / tickBlight). Built lazily: three of the four races never blight
   *  anything, and a headless combat test has no reason to carry the array. */
  private blightGrid: BlightGrid | null = null;
  /** typeId → the Blight Growth / Blight Dispel row it carries, resolved once per type. */
  private blightRadii = new Map<string, BlightPaint | null>();
  /** Blight discs still growing outward (`Abgs`'s DataA = 64 units every Dur1 = 0.08s).
   *  Keyed by the unit that owns each, so a source only ever has one and a building
   *  knocked down mid-bloom stops where it got to. */
  private blightGrowth = new Map<number, { x: number; y: number; r: number; max: number; step: number; period: number; t: number; on: boolean }>();
  /** Buildings whose blight has already been laid. A source paints when it FINISHES, not
   *  while it is a foundation — "whenever a building is finished, it instantly generates
   *  more blighted area around it" (Warcraft Wiki, Blight). */
  private blightPainted = new Set<number>();
  /** MOONSTONE (`AIct`): the eclipse currently running, and the hour to give back when it
   *  lifts. Null the rest of the time — see itemArtificialNight. */
  private moonstone: { left: number; restore: number } | null = null;
  /** SOUL GEMS holding a hero off the field: who is carrying which gem, and whose soul is
   *  in it. See itemSoulGem / tickSoulGems. */
  private soulGems: Array<{ carrierId: number; heroId: number; itemId: string }> = [];
  /** Whether to record death/damage/attack events for the trigger engine (the host
   *  sets each only when the loaded script actually registers that event kind — off
   *  for melee and for maps that don't listen, so nothing accumulates unread). */
  captureDeaths = false;
  captureDamage = false;
  captureAttacks = false;
  captureOrders = false;
  captureSpells = false; // EVENT_(PLAYER_)UNIT_SPELL_* (7.17)
  captureConstruct = false; // EVENT_(PLAYER_)UNIT_CONSTRUCT_* (7.17)
  captureTrain = false; // EVENT_(PLAYER_)UNIT_TRAIN_* (7.17)
  captureHeroEvents = false; // EVENT_PLAYER_HERO_LEVEL / _SKILL (7.17)
  captureItems = false; // EVENT_(PLAYER_)UNIT_PICKUP/DROP/USE/SELL_ITEM (7.18)
  captureSellUnits = false; // EVENT_(PLAYER_)UNIT_SELL — a unit bought from a shop (269/286)
  captureLoads = false; // EVENT_UNIT_LOADED (88) / EVENT_PLAYER_UNIT_LOADED (51)
  private deathEvents: Array<{ victim: EventUnitInfo; killer: EventUnitInfo | null }> = [];
  private damageEvents: Array<{ target: EventUnitInfo; source: EventUnitInfo | null; amount: number }> = [];
  private attackEvents: Array<{ attacked: EventUnitInfo; attacker: EventUnitInfo }> = [];
  private orderEvents: Array<{ unit: EventUnitInfo; orderId: number; kind: "immediate" | "point" | "target"; x: number; y: number; target: EventUnitInfo | null }> = [];
  private spellEvents: SpellEvent[] = [];
  private constructEvents: ConstructEvent[] = [];
  private trainEvents: TrainEvent[] = [];
  private sellUnitEvents: SellUnitEvent[] = [];
  private heroEvents: HeroEvent[] = [];
  private itemEvents: ItemEvent[] = [];
  private loadEvents: LoadEvent[] = [];
  private removals: number[] = []; // units removed WITHOUT a death animation (cancels)
  private felled: SimTree[] = [];
  private depleted: SimMine[] = [];
  private nextProjectileId = 1;
  private spawnedProjectiles: Array<{ id: number; art: string; x: number; y: number; z: number }> = [];
  private removedProjectiles: number[] = [];
  // Projectiles that actually HIT (vs fizzled) — the renderer plays the impact
  // effect (the missile model's Death clip) at the recorded point (z above ground).
  private projectileImpacts: Array<{ id: number; x: number; y: number; z: number }> = [];
  /** Landed hits (melee + projectile) — the renderer plays the weapon-impact SFX, the
   *  weapon's material against the struck unit's. Each blow carries THE SOUND OF THE WEAPON
   *  THAT LANDED IT, not just the attacker's id: the clang belongs to the blow rather than to
   *  the unit. A hero whose air slot an orb woke, a Flying Machine that has researched Bombs
   *  and a map's `ucs2` all swing something the def's primary-slot summary does not describe,
   *  and a shot still in flight when its shooter dies has no def left to ask at all. */
  private hits: Array<{ attackerId: number; targetId: number; weaponSound: string }> = [];
  // Worker ids whose axe just landed a chop this tick — the renderer plays the
  // chop SFX (worker's lumber-weapon material vs Wood).
  private chops: number[] = [];
  // Positions of trees that took a (non-felling) chop this tick — the renderer plays
  // the tree doodad's "stand hit" wobble once per hit (a felling hit plays "death" via
  // the `felled` queue instead, so it isn't duplicated here).
  private treeHits: Array<{ x: number; y: number }> = [];
  // Attacker ids whose swing just reached its damage point (fired) this tick — the
  // renderer plays the unit's own attack/fire sound (the SND "K" event on its model:
  // rifleman gunshot, mortar boom, dragon breath). Distinct from the landed-hit clang.
  private attackSwings: number[] = [];
  // Debug cheat: when true, construction + unit training complete in ~1 second
  // (any build time is compressed to one second), regardless of builders present.
  fastBuild = false;
  // Injected by the game layer: is world point (x,y) currently VISIBLE (not fogged)
  // to `team`? Idle units only auto-acquire enemies their team can actually see —
  // WC3 units never aggro a target hidden in the fog of war (issue #17). Defaults to
  // always-visible so headless sim tests (which build no vision map) behave as before;
  // only the local player's team is fog-modelled, so other teams pass through as
  // visible (see rts.ts, which wires this to the per-team VisionMap).
  visibleToTeam: (team: number, x: number, y: number) => boolean = () => true;
  /** Does anything (treeline, high ground) stand between these two points? Injected by
   *  rts from the VisionMap's height field; defaults to open ground for headless sims. */
  lineOfSight: (fromX: number, fromY: number, toX: number, toY: number, flying: boolean) => boolean = () => true;
  /** Half the width of a building type's stamped footprint, in world units — how far from a
   *  site's CENTRE its edge is. The pathing texture that decides it is a FILE, so only the
   *  renderer can read one (MapViewerScene.footprintFor); installed by
   *  RtsController.setFootprintReader. 0 when unknown, which reads as "aim at the centre" —
   *  the behaviour buildApproach replaces. */
  buildHalfExtent: (defId: string) => number = () => 0;
  /** Are two PLAYER slots allied? Injected by rts from the alliance matrix (7.22), so a
   *  script's `SetPlayerAlliance` can ally two players the lobby put on different teams —
   *  and un-ally two it put on the same one. `null` = "no opinion, use the teams", which
   *  is what creeps (owner < 0) and a headless sim with no matrix both get, so allegiance
   *  stays the plain team comparison it was before. */
  /** Slots the map set to MAP_CONTROL_NEUTRAL / _RESCUABLE. Written by the config() native
   *  through the engine bridge, empty in melee. The COMBAT half of that lives in the alliance
   *  matrix (RtsController.setPlayerNeutral); this set is what the presentation reads — a
   *  neutral player's units ring neutral-yellow like a shop's (RtsController.ringAllegiance). */
  readonly neutralPlayers = new Set<number>();
  alliedPlayers: (ownerA: number, ownerB: number) => boolean | null = () => null;
  /**
   * Does `ownerA` hold its fire toward `ownerB`? (ALLIANCE_PASSIVE, granted BY A.)
   *
   * Separate from `alliedPlayers` because the two answer different questions, and WC3
   * draws the line exactly here. Being ALLIES is mutual — blizzard.j's PlayersAreCoAllied
   * reads PASSIVE in both directions before it will say yes. But whether a unit will
   * ATTACK is the ATTACKER'S OWN grant and nobody else's, because the matrix is directed.
   */
  passivePlayers: (ownerA: number, ownerB: number) => boolean | null = () => null;
  /** Live fogged-attacker reveals, keyed `attackerId:victimTeam` so a unit shooting two
   *  sides at once gives itself away to each, and each fresh blow re-stamps the entry. */
  private attackReveals = new Map<string, AttackReveal>();
  /** Sight left behind by units that have just died (see DeathReveal). A plain array: each
   *  entry is born at one death, ages out on its own, and nothing ever refreshes one. */
  private deathReveals: DeathReveal[] = [];
  /** Fog an ITEM is holding open (see ItemReveal). Also a plain array — a Crystal Ball
   *  pressed twice lights two circles, it does not refresh one. */
  private itemReveals: ItemReveal[] = [];
  // Trained units ready to spawn: the renderer creates the model + sim unit.
  private trainCompletions: Array<{ buildingId: number; unitId: string; owner: number; x: number; y: number; rallyX: number; rallyY: number; rallyKind: RallyKind; rallyTargetId: number; reviveOf?: number; tavern?: boolean }> = [];
  // Finished research (renderer plays the "upgrade complete" sound + refreshes the card).
  private researchCompletions: Array<{ buildingId: number; upgradeId: string; level: number; owner: number }> = [];
  // Buildings that finished being BUILT this tick (renderer plays the "job's done" sound).
  private buildCompletions: Array<{ buildingId: number; owner: number }> = [];
  // News the engine announces by itself — see Alert.
  private alerts: Alert[] = [];
  /** Per player, WHEN and WHERE they were last told they are under attack. Both halves are
   *  needed: MiscData carries `AttackNotifyDelay=30.0` ("seconds between attack
   *  notifications") beside `AttackNotifyRange=1250`, and a delay alone would have no use
   *  for a range. Read as one rule — a fresh blow is news if the last warning has gone
   *  stale OR it lands somewhere else entirely — which is what stops a raid on the far
   *  side of the map from being silenced by a creep nibbling at home. */
  private attackNotify = new Map<number, { t: number; x: number; y: number }>();
  /** Mines already announced as running low, so the warning is given once per mine rather
   *  than on every trip below the line. */
  private minesRunningLow = new Set<number>();
  // Buildings that changed type this tick (Town Hall → Keep): the renderer swaps the model.
  private morphs: Array<{ unitId: number; from: string; to: string }> = [];
  private nextNodeId = 1;
  private rng: () => number;
  /** The seed this world's RNG was started from. Part of a match's identity: a replay or
   *  a joining client needs it to roll the same damage, crits, misses and item drops as
   *  the machine that owns the game (docs/multiplayer.md). */
  seed: number;
  // --- corpses (persist + decay; targetable by corpse-consuming spells) ---
  readonly corpses = new Map<number, SimCorpse>();
  private nextCorpseId = 1;
  // --- items on the ground (dropped / creep-dropped; pickable) -------------
  readonly items = new Map<number, SimItem>();
  private nextItemId = 1;
  /** Seconds since the match began. Shop restock schedules run on THIS clock, not on when a
   *  shop was raised — see initShopStock. */
  elapsed = 0;
  private itemSpawns: SimItem[] = []; // new ground items the renderer must model
  private itemRemovals: Array<{ id: number; died: boolean }> = []; // ground items picked up/destroyed (drop their model)
  // PowerUp items consumed on pickup this frame: the renderer plays the granted ability's
  // Target/Caster art on the picker and sounds it. See applyPowerup.
  private powerupPickups: Array<{ unitId: number; art: string; soundLabel: string }> = [];
  // Per-unit creep drop tables, seeded at spawn (map .doo), rolled on death.
  private unitDrops = new Map<number, ItemDropSet[]>();
  // --- spell / ability event channels drained by the renderer each frame ---
  // Spell effect models to play at a unit/point (targetArt/casterArt/areaArt). `soundLabel`
  // is an AbilitySounds.slk LABEL to fire with the model — for the cue whose WAV does NOT
  // live beside its art (a shop paying you names `ReceiveGold`, which sits in
  // Abilities\Spells\Items\ResourceItems while the coins it plays with are a UI\Feedback
  // model; `sound` alone, which resolves off the art's own folder, would find nothing).
  private spellEffects: Array<{ art: string; x: number; y: number; targetId: number; z: number; life?: number; sound?: boolean; soundLabel?: string }> = [];
  // Temporary ground decals a spell paints (Thunder Clap's scorch): an UberSplatData
  // row id + where. The row carries the texture, half-width and fade timings.
  private spellSplats: Array<{ splatId: string; x: number; y: number }> = [];
  // Lightning bolts strung this frame (issue #97) — Chain Lightning, Healing Wave, the
  // Drains, Finger of Death… Unlike an effect model these link TWO points and hold, so
  // each carries both ends and how long it lives. See SimLightning.
  private spellLightnings: SimLightning[] = [];
  // Bolts asked to STOP early this frame, by tag (see SimLightning.tag) — an interrupted
  // Drain cutting its tether. A separate queue rather than a flag on the bolt because the
  // renderer holds the live bolt, not the sim.
  private spellLightningStops: string[] = [];
  // A unit began casting: renderer plays the cast animation (spell/throw/slam) and
  // holds it for `hold` seconds — the whole cast (wind-up + backswing, or wind-up +
  // channel). `loop` = a channelled spell (loop the clip for the channel) vs a
  // one-shot gesture (Storm Bolt throw) that plays once. `warnArt` is the "beware"
  // model dropped at tx,ty this same instant (PRECAST_WARNING) — the renderer sounds
  // that model here, at the wind-up, since that is when WC3's model plays its clip.
  private castStarts: Array<{ casterId: number; code: string; abilityId: string; hold: number; loop: boolean; tx: number; ty: number; targetId: number; warnArt: string }> = [];
  // Casts whose effect just FIRED this frame (wind-up elapsed → the clap/bolt/etc.
  // happens now). The renderer plays the ability's cast SOUND off THIS, not off the
  // cast START — WC3 syncs the sound to the effect at the cast point (issue #23), and
  // an interrupted wind-up (which never reaches here) correctly makes no sound.
  private castFires: Array<{ casterId: number; code: string; abilityId: string }> = [];
  // Floating COMBAT text the engine raises by itself — a Critical Strike's red "127!" and a
  // deny's "!" (see CombatText). Not a script's CreateTextTag: no trigger is involved, and it
  // must appear in a melee match where nothing is listening.
  private combatTexts: CombatText[] = [];
  // Heroes that just gained a level: renderer plays the level-up nova + sound.
  private levelUps: Array<{ unitId: number; level: number }> = [];
  // Units summoned/raised by a spell this tick: the renderer creates their models
  // (same deferral as trainCompletions — the sim owns no model instances).
  private summonRequests: SummonRequest[] = [];
  /** Entangled Gold Mines waiting for the renderer to raise them (see entangleMine). */
  private entangleRequests: EntangleRequest[] = [];

  /** Per-player tech state: researched levels + what their live units unlock (issue #57).
   *  Null until the registries are supplied — a bare sim (headless pathing/combat tests)
   *  has no tech tree, and every requirement check then trivially passes. */
  readonly tech: TechState | null;

  constructor(
    readonly grid: PathingGrid,
    seed = 1,
    private abilities?: AbilityRegistry,
    private itemReg?: ItemRegistry,
    private unitReg?: UnitRegistry,
    private techReg?: TechRegistry,
    private upgradeReg?: UpgradeRegistry,
  ) {
    this.seed = seed;
    this.rng = lcg(seed);
    this.tech =
      techReg && upgradeReg
        ? new TechState(techReg, upgradeReg, () =>
            [...this.units.values()].map((u) => ({
              owner: u.owner,
              typeId: u.typeId,
              alive: u.hp > 0,
              underConstruction: !!u.building && u.building.constructionLeft > 0,
            })),
          )
        : null;
  }

  /** Whether `player` may make `unitId` right now — tech prerequisites + availability cap.
   *  `owned` selects the requirement tier (hero #2 needs a Keep). Always true with no tech
   *  registry loaded. */
  canMake(player: number, unitId: string, owned = 0): boolean {
    return !this.tech || this.tech.canMake(player, unitId, owned);
  }

  /** Whether `player` meets the prerequisites for ANY tech id — a unit, an upgrade, a shop
   *  item or an ABILITY. Abilities declare theirs the same way everything else does
   *  (`[Adef] Requires=Rhde` in HumanAbilityFunc.txt), which is how the six "effectless" Human
   *  upgrades work: they grant no stat, they simply satisfy an ability's requirement. Ids with
   *  no requirements pass, so this is safe to ask of anything. */
  techMeets(player: number, id: string): boolean {
    return !this.tech || this.tech.meets(player, id);
  }

  addMine(x: number, y: number, gold: number, radius = 96): SimMine {
    const mine: SimMine = { id: this.nextNodeId++, x, y, radius, gold, busy: false, entangledBy: 0 };
    this.mines.set(mine.id, mine);
    return mine;
  }

  addTree(x: number, y: number, lumber = TREE_LUMBER, blockRadius = 64): SimTree {
    const tree: SimTree = { id: this.nextNodeId++, x, y, lumber, hp: TREE_HP, blockRadius };
    this.trees.set(tree.id, tree);
    return tree;
  }

  initStash(owner: number, gold: number, lumber: number): void {
    this.stash.set(owner, { gold, lumber });
  }

  /**
   * player → what a load DEPOSITED by that player's workers is multiplied by on its way into
   * the till. 1 for everybody, and set only for an INSANE computer, which is paid twice what
   * it carried (src/ai/ids.ts INSANE_HARVEST_FACTOR, and `RtsController.startMeleeAI` is the
   * only caller).
   *
   * It sits on the DEPOSIT rather than on the load a worker picks up, which is the whole point:
   * the mine hands over its usual ten gold and empties on the usual schedule. Nothing about the
   * map's economy changes — only what one player's bank makes of the same trip.
   */
  private readonly harvestBonus = new Map<number, number>();

  /** Pay this player `factor` times what its workers actually carry home. See harvestBonus. */
  setHarvestBonus(player: number, factor: number): void {
    if (factor === 1) this.harvestBonus.delete(player);
    else this.harvestBonus.set(player, factor);
  }

  stashOf(owner: number): { gold: number; lumber: number } {
    let s = this.stash.get(owner);
    if (!s) {
      s = { gold: 0, lumber: 0 };
      this.stash.set(owner, s);
    }
    return s;
  }

  /**
   * Float a "+N" over the world for the ONE player it belongs to — the single door every
   * credit the engine reports goes through (issue #116).
   *
   * Being paid is a thing you SEE, and WC3 says so four different ways: the gold a worker
   * lays down, the lumber it lays down, a creep's bounty, the experience a kill hands a hero.
   * They differ only in the row of `UI\MiscData.txt` the client styles them from — which is
   * exactly why they are one call here and one `kind` on the wire, rather than four hand-rolled
   * pushes drifting apart. (Two of them, Transmute's payout and a shop's buy-back, were the
   * hand-rolled pushes this replaced.)
   *
   * `unitId` ATTACHES the number to a unit that will walk off with it; 0 leaves it where it was
   * raised, which is what a bounty wants — a moment later there is nothing left to follow.
   * A credit of nothing is not reported: the game floats no "+0".
   */
  private floatCredit(kind: "gold" | "lumber" | "bounty" | "xp", amount: number, forPlayer: number, at: { x: number; y: number }, unitId = 0): void {
    if (amount <= 0) return;
    this.combatTexts.push({ kind, unitId, x: at.x, y: at.y, text: `+${Math.round(amount)}`, colorSlot: -1, forPlayer });
  }

  nearestTree(x: number, y: number, maxDist: number): SimTree | null {
    let best: SimTree | null = null;
    let bestD = maxDist;
    for (const t of this.trees.values()) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  /** Up to `limit` trees within `maxDist` of a point, nearest first — used to
   *  spread a group of lumber workers across a cluster instead of piling every
   *  worker onto the single closest tree. */
  nearestTrees(x: number, y: number, maxDist: number, limit: number): SimTree[] {
    const within: Array<{ t: SimTree; d: number }> = [];
    for (const t of this.trees.values()) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d <= maxDist) within.push({ t, d });
    }
    within.sort((a, b) => a.d - b.d);
    return within.slice(0, Math.max(1, limit)).map((e) => e.t);
  }

  /**
   * The wisp that has this tree, if any — one wisp to a tree.
   *
   * A wisp is not a chopper standing at a trunk, it is INSIDE the tree (`deliversInPlace`,
   * see tickHarvest), so a second one has nowhere to be: WC3 puts it in a neighbouring tree
   * instead. Only wisps hold a tree this way — a Peasant and a Peon chop from outside and
   * several of them may work the same tree, as they do in the original.
   *
   * DERIVED, never stored. A `takenBy` field on the tree would have to be cleared by every
   * path a wisp can leave one by (a new order, a Stop, Detonate, a death, a Moon Well, the
   * tree itself burning down), and the one that got missed would wedge that tree shut for the
   * rest of the match — exactly the class of bug the gold mine's `busy` latch already cost us
   * once (see popFromMine). Walking to a tree counts as holding it, so a pair sent at the same
   * trunk in one order split up on the way rather than at the end of it.
   */
  private treeWorkedBy(treeId: number, exceptId: number, workingOnly = false): SimUnit | null {
    for (const u of this.units.values()) {
      if (u.id === exceptId || u.hp <= 0 || !u.worker?.deliversInPlace) continue;
      if (workingOnly && !u.working) continue; // "in the tree", not merely on its way
      if (u.order === "harvest" && u.resKind === "lumber" && u.resId === treeId) return u;
    }
    return null;
  }

  /** The nearest tree to (x, y) within `maxDist` that no other wisp has (treeWorkedBy).
   *  The taken set is collected once and then read — a grove is thousands of trees and
   *  asking each of them who has it would walk the unit list thousands of times. */
  private freeTreeNear(u: SimUnit, x: number, y: number, maxDist: number): SimTree | null {
    const taken = new Set<number>();
    for (const o of this.units.values()) {
      if (o.id === u.id || o.hp <= 0 || !o.worker?.deliversInPlace) continue;
      if (o.order === "harvest" && o.resKind === "lumber") taken.add(o.resId);
    }
    let best: SimTree | null = null;
    let bestD = maxDist;
    for (const t of this.trees.values()) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d >= bestD || taken.has(t.id)) continue;
      bestD = d;
      best = t;
    }
    return best;
  }

  /** Standing trees within `radius` of a point — the set an area spell that lists
   *  `tree` in Targets Allowed (Flame Strike) damages, and which the green cast
   *  preview highlights. */
  treesInArea(x: number, y: number, radius: number): SimTree[] {
    const out: SimTree[] = [];
    for (const t of this.trees.values()) {
      if (Math.hypot(t.x - x, t.y - y) <= radius) out.push(t);
    }
    return out;
  }

  nearestMine(x: number, y: number, maxDist: number): SimMine | null {
    let best: SimMine | null = null;
    let bestD = maxDist;
    for (const m of this.mines.values()) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** Trees felled since the last drain (renderer hides them + unstamps cells). */
  drainFelledTrees(): SimTree[] {
    if (!this.felled.length) return this.felled;
    const out = this.felled;
    this.felled = [];
    return out;
  }

  // === shops (issue #57) =====================================================

  /** Everything a shop sells: its `Makeitems` (a race shop like the Arcane Vault),
   *  `Sellitems` (a neutral one like the Goblin Merchant) and `Sellunits` (a Tavern's heroes,
   *  a Mercenary Camp's creeps). A building with none of these is not a shop. */
  shopWares(typeId: string): { items: string[]; units: string[] } {
    const t = this.techReg?.get(typeId);
    if (!t) return { items: [], units: [] };
    return { items: [...t.makeitems, ...t.sellitems], units: [...t.sellunits] };
  }

  /** What THIS shop is actually selling: its data's wares plus whatever a script has put on its
   *  shelves. Only the second half exists for a Marketplace, whose entire stock is script-made
   *  and changes every 30 seconds — so the command card must be built from the building, not
   *  from the unit type. */
  shopWaresOf(shopId: number): { items: string[]; units: string[] } {
    const u = this.units.get(shopId);
    if (!u) return { items: [], units: [] };
    const w = this.shopWares(u.typeId);
    for (const [id, s] of u.building?.stock ?? []) {
      const list = s.kind === "item" ? w.items : w.units;
      if (!list.includes(id)) list.push(id);
    }
    return w;
  }

  isShop(typeId: string): boolean {
    const w = this.shopWares(typeId);
    return w.items.length > 0 || w.units.length > 0;
  }

  /** Whether this particular building can be bought from — by data OR by script-placed stock.
   *  A Marketplace passes only on the strength of the latter. */
  isShopUnit(shopId: number): boolean {
    const u = this.units.get(shopId);
    if (!u) return false;
    return this.isShop(u.typeId) || (u.building?.stock?.size ?? 0) > 0;
  }

  /** What a shop's "interact" ability says about using it. WC3 puts all of this on the
   *  ability, not the building, and there are three of them (AbilityData.slk, all with
   *  base code `Aneu`; column names from AbilityMetaData `Neu1..Neu4`):
   *
   *    alias  name                          DataA radius  DataB interact  DataC btn  DataD arrow
   *    Aneu   "Select Hero"                 450           1               1          1
   *    Aall   "Shop Sharing, Allied Bldg."  600           1               1          1
   *    Ane2   "Select Unit"                 450           16              0          0
   *
   *  The split is coherent and we honour it: buildings that sell ITEMS carry Aneu (Goblin
   *  Merchant `ngme`, Marketplace `nmrk`) or Aall (the four race shops `hvlt`/`ovln`/`eden`/
   *  `utom`) and get both the Select User button and the overhead arrow, because an item
   *  needs a unit to receive it. Buildings that sell UNITS carry Ane2 (Tavern, Mercenary
   *  Camps, Goblin Lab, the shipyards, Dragon Roosts) and explicitly set BOTH flags to 0 —
   *  a purchased unit walks out on its own, so there is nobody to nominate and nothing to
   *  point an arrow at.
   *
   *  `Rng1` is 350 on all three and is a different number: the range at which the
   *  `neutralinteract` order may be issued, not the range at which buying works.
   *  None of this is MiscData's NeutralUseNotifyRadius=900 either — that is how far the
   *  shop SHOUTS to nearby creeps when used (notifyCreepsOfShopUse).
   *
   *  Match on the BASE CODE, and note it is not one code: Aneu and Ane2 share `Aneu`, but
   *  Aall is its own code `Aall` (verified in the SLK — the two neutral ones being siblings
   *  makes it tempting to assume all three are, and then every race shop silently falls
   *  back to the default radius with no button and no arrow). */
  private shopInteract(typeId: string): { abilityId: string; radius: number; showButton: boolean; showArrow: boolean } {
    const fallback = { abilityId: "", radius: DEFAULT_SHOP_RADIUS, showButton: false, showArrow: false };
    const def = this.unitReg?.get(typeId);
    if (!def || !this.abilities) return fallback;
    for (const abilId of def.abilities) {
      const a = this.abilities.get(abilId);
      if (!a || (a.code !== "Aneu" && a.code !== "Aall")) continue;
      const lvl = a.levelData[0];
      if (!lvl) continue;
      const r = lvl.data[0];
      return {
        abilityId: abilId,
        radius: r && !Number.isNaN(r) ? r : DEFAULT_SHOP_RADIUS,
        showButton: lvl.data[2] === 1,
        showArrow: lvl.data[3] === 1,
      };
    }
    return fallback;
  }

  /** The shop's interact ability (Aneu/Ane2/Aall), so the HUD can build its Select User
   *  button — icon, name, hotkey and tooltip — out of the game's own ability data. */
  shopInteractAbility(shopId: number): string {
    const shop = this.units.get(shopId);
    return shop ? this.shopInteract(shop.typeId).abilityId : "";
  }

  /** How far from a shop a patron may stand (see shopInteract). */
  private shopRadius(typeId: string): number {
    return this.shopInteract(typeId).radius;
  }

  /** Does this shop nominate a purchasing unit — the "Select User" button on its command
   *  card and the team-coloured arrow over the chosen unit? False for the unit-sellers. */
  shopSelectsUser(shopId: number): boolean {
    const shop = this.units.get(shopId);
    return !!shop && this.shopInteract(shop.typeId).showButton;
  }
  shopShowsArrow(shopId: number): boolean {
    const shop = this.units.get(shopId);
    return !!shop && this.shopInteract(shop.typeId).showArrow;
  }

  /** The units of `player` that could take delivery of an item bought from this shop — WC3's
   *  "valid patron". A patron needs an inventory (in melee that means a hero) and must be
   *  standing inside the shop's activation radius; otherwise the purchase is refused with
   *  "A valid patron must be nearby." (commandstrings.txt `Neednearbypatron`).
   *  Measured centre-to-centre against radius + the shop's collision, so a big shop doesn't
   *  make its own doorstep out of range. */
  shopPatrons(shopId: number, player: number): SimUnit[] {
    const shop = this.units.get(shopId);
    if (!shop) return [];
    const out: SimUnit[] = [];
    for (const u of this.units.values()) {
      if (u.owner !== player || u.hp <= 0 || !u.inventory.length) continue;
      if (this.inShopRange(shop, u)) out.push(u);
    }
    return out;
  }

  /** Who a player has nominated to take delivery at a given shop: shopId → player → unitId.
   *
   *  Keyed by PLAYER as well as by shop because a neutral Goblin Merchant serves everyone at
   *  once and each player's choice is their own — which is also why WC3 issues the pick as
   *  `IssueNeutralTargetOrderById(owner, shop, 852566, buyer)`, with the player as the first
   *  argument rather than the shop's owner doing the ordering.
   *
   *  Nothing prunes this map: a nomination is re-validated on every read (shopBuyer), so a
   *  unit that dies, is removed, or simply walks out of range quietly stops being the buyer
   *  without every removal path in the sim having to know shops exist. */
  private shopBuyers = new Map<number, Map<number, number>>();

  /** Nominate `unitId` as `player`'s purchaser at `shop` (WC3's "Select Hero"/"Select Unit",
   *  the `neutralinteract` order). Refuses anything that isn't a valid patron right now.
   *  Passing 0 clears the nomination and hands the shop back to the default rule. */
  setShopBuyer(shopId: number, player: number, unitId: number): boolean {
    const shop = this.units.get(shopId);
    if (!shop || !this.isShopUnit(shopId) || !this.shopSelectsUser(shopId)) return false;
    if (unitId === 0) {
      this.shopBuyers.get(shopId)?.delete(player);
      return true;
    }
    const u = this.units.get(unitId);
    if (!u || u.owner !== player || u.hp <= 0 || !u.inventory.length) return false;
    if (!this.inShopRange(shop, u)) return false;
    let per = this.shopBuyers.get(shopId);
    if (!per) this.shopBuyers.set(shopId, (per = new Map()));
    per.set(player, unitId);
    return true;
  }

  /** The unit that takes delivery of `player`'s next purchase at `shop`, or null if they
   *  have no eligible unit nearby.
   *
   *  The choice is STICKY. Once a shop has a purchaser it keeps it until that unit stops
   *  being eligible (dies, is removed, walks out of range) or the player nominates another
   *  by hand — a second hero arriving, even a nearer one, must never quietly take delivery
   *  of what you were about to buy. This used to recompute "nearest patron" on every read,
   *  so the buyer changed under the player as units wandered past.
   *
   *  Adoption (picking one when there is none) is deliberately NOT done here: this is a
   *  query, called from the renderer among other places, and committing state from it would
   *  tie the sim's choice to how often something happened to ask. tickShopBuyers owns it. */
  shopBuyer(shopId: number, player: number): SimUnit | null {
    const shop = this.units.get(shopId);
    if (!shop) return null;
    const nominated = this.shopBuyers.get(shopId)?.get(player);
    if (nominated === undefined) return null;
    const u = this.units.get(nominated);
    if (u && u.owner === player && u.hp > 0 && u.inventory.length && this.inShopRange(shop, u)) return u;
    this.shopBuyers.get(shopId)?.delete(player); // stale — dead, gone, or walked away
    return null;
  }

  /** Run the shop-buyer adoption pass by hand. For a FROZEN CLIENT (docs/multiplayer.md
   *  option 2): its sim never ticks, so nothing would ever adopt a patron — the local
   *  authority refused every `buyitem` before it could reach the host, and the overhead
   *  arrow never showed. The applier's caller runs this against the freshly-written records
   *  instead; it derives only the local nomination map, and the HOST's own adoption is
   *  still what decides the actual delivery. */
  adoptShopBuyers(): void {
    this.tickShopBuyers();
  }

  /** Give every shop a purchaser for every player who has one standing there and hasn't
   *  got one already — the first eligible unit to arrive becomes the buyer, and from then
   *  on only the player's own Select User pick moves it (see shopBuyer).
   *
   *  Ticked rather than resolved lazily so the choice depends on the sim's clock, not on
   *  who asked. Cheap: it only walks shops that actually nominate a buyer, and only reaches
   *  for the patron list when that shop+player has no valid one. */
  private tickShopBuyers(): void {
    for (const shop of this.units.values()) {
      if (shop.hp <= 0 || !this.isShopUnit(shop.id) || !this.shopSelectsUser(shop.id)) continue;
      // Which players have a unit here at all — no patrons, nothing to adopt.
      const seen = new Set<number>();
      for (const u of this.units.values()) {
        if (u.hp <= 0 || !u.inventory.length || seen.has(u.owner)) continue;
        if (!this.inShopRange(shop, u)) continue;
        seen.add(u.owner);
        if (this.shopBuyer(shop.id, u.owner)) continue; // already has a valid one — leave it
        let per = this.shopBuyers.get(shop.id);
        if (!per) this.shopBuyers.set(shop.id, (per = new Map()));
        per.set(u.owner, u.id);
      }
    }
  }

  /** Every (unit, shop) pairing that should wear the overhead arrow for `player` this
   *  frame: the buyer each arrow-showing shop would deliver to. Returns unit ids — one
   *  unit standing between two shops still wears ONE arrow, as in the game. */
  shopArrowUnits(player: number): Set<number> {
    const out = new Set<number>();
    for (const shop of this.units.values()) {
      if (shop.hp <= 0 || !this.isShopUnit(shop.id) || !this.shopShowsArrow(shop.id)) continue;
      const buyer = this.shopBuyer(shop.id, player);
      if (buyer) out.add(buyer.id);
    }
    return out;
  }

  /** Is `u` standing close enough to use `shop`? The one range test both the patron list and
   *  the purchase itself go through — stated as "within", never as "not beyond", so a NaN
   *  coordinate fails it. (`NaN > reach` is false, so the negated form would have quietly let
   *  a unit with a broken position shop from anywhere.) */
  private inShopRange(shop: SimUnit, u: SimUnit): boolean {
    return Math.hypot(u.x - shop.x, u.y - shop.y) <= this.shopRadius(shop.typeId) + shop.radius;
  }

  /** The requirements `player` has NOT met for `itemId` AT THIS SHOP — the red "Requires:" line,
   *  and the gate on the purchase itself.
   *
   *  A tech requirement belongs to the RACE shop, and to it alone. An item carries ONE
   *  requirement list but is sold in two very different places: the Arcane Vault MAKES a Scroll
   *  of Town Portal (`Makeitems`), and gates it on a Keep the way it gates anything it produces;
   *  a Goblin Merchant merely has one on the shelf (`Sellitems`), and it does not care who you
   *  are or what you have built. Anybody may buy anything a neutral shop has in stock — and
   *  BEING IN STOCK is the whole gate, which is why every ware carries a restock clock of its
   *  own (`stockStart` / `stockRegen`) and wears a cooldown sweep while it is out.
   *
   *  The Scroll of Healing is what makes this unmistakable: `[shea] Requires=unp2` is a Black
   *  Citadel — the Undead Tomb of Relics' own tier-3 gate, and the Tomb does sell the scroll —
   *  yet the same scroll sits on every Goblin Merchant, where a Human could never in the game's
   *  lifetime meet it. The requirement never belonged to the merchant.
   *
   *  UNITS obey the same rule and land in `soldUnitNeedsTech`, which is where the one exception
   *  (a sold HERO) is argued. */
  missingForShop(shopId: number, itemId: string, player: number): string[] {
    if (!this.tech) return [];
    const shop = this.units.get(shopId);
    const raceShop = !!shop && (this.techReg?.get(shop.typeId).makeitems.includes(itemId) ?? false);
    return raceShop ? this.tech.missing(player, itemId) : [];
  }

  /** Does a unit a shop SELLS still have to meet its own `Requires`? Only if it is a HERO.
   *
   *  Being in stock is otherwise the whole gate, exactly as for a sold item — measured in the
   *  real client on WTii's Unit Tester, whose "Human Units" building is a re-skinned Farm
   *  selling all twelve Human units: the Knight is live and buyable there with no Lumber Mill,
   *  no Castle and no Blacksmith anywhere on the map.
   *
   *  Heroes are the exception because the melee hero rule is spelt out in requirement data and
   *  is enforced wherever a hero comes from, an Altar or a Tavern alike: the eight tavern heroes
   *  are the ONLY sold units in the whole of the base data that carry a `Requires` at all, and
   *  it is that rule verbatim (`[Nbrn] Requires=TALT`, `Requires1=TWN2,TALT`,
   *  `Requires2=TWN3,TALT`) — no tavern hero without an Altar, no SECOND one before a Keep.
   *
   *  WTii's own edits draw the same line from the other side. He clears `ureq`/`urq1`/`urq2` on
   *  precisely the eight tavern heroes and on his custom Altar heroes, and on not one of the
   *  ~360 ordinary units his shops sell — which is what you do when heroes are gated and the
   *  rest are not. */
  soldUnitNeedsTech(unitId: string): boolean {
    return !!this.unitReg?.get(unitId)?.isHero;
  }

  /** Stock remaining for one ware (item or unit) at a shop; -1 when it isn't stocked at all. */
  shopStock(shopId: number, wareId: string): number {
    const s = this.units.get(shopId)?.building?.stock?.get(wareId);
    return s ? s.count : -1;
  }

  /** A ware's whole shelf state, for the command card: how many are left, and — while none are
   *  — how long until the next arrives and how far through that wait we are. An out-of-stock
   *  ware wears the same clockwise sweep as an ability on cooldown, because that is exactly
   *  what it is on. */
  shopStockInfo(shopId: number, wareId: string): ShopStock | null {
    return this.units.get(shopId)?.building?.stock?.get(wareId) ?? null;
  }

  /** Seed a shop's shelves. The restock schedule runs on the GAME clock, not on when the shop
   *  was raised, so a shop built (or captured) late already carries whatever has come due —
   *  otherwise an Arcane Vault put up at minute 10 would make you wait until 17:20 for a
   *  Potion of Healing (stockStart 440). */
  private initShopStock(u: SimUnit): void {
    if (!u.building || !this.techReg) return;
    const wares = this.shopWares(u.typeId);
    if (!wares.items.length && !wares.units.length) return;
    const stock = new Map<string, ShopStock>();
    const seed = (id: string, kind: "item" | "unit", max: number, regen: number, start: number) => {
      if (max <= 0) return;
      const t = this.elapsed;
      let count: number;
      let timer: number;
      let period: number;
      if (t < start) {
        count = 0; // not on the shelves yet
        timer = start - t;
        period = timer; // the sweep runs the whole of the FIRST wait, which is not `regen` long
      } else if (regen > 0) {
        const since = t - start;
        count = Math.min(max, 1 + Math.floor(since / regen));
        timer = regen - (since % regen);
        period = regen;
      } else {
        // `stockRegen` 0 — no wait between restocks, so the shelf is simply always full
        // (a Tavern's heroes, once `stockStart` has passed). See ShopStock.unlimited.
        count = max;
        timer = Infinity;
        period = Infinity;
      }
      // A pre-`stockStart` ware is still unlimited-to-be: the flag describes the WARE, and the
      // `count = 0` above is what holds it back until its first arrival.
      stock.set(id, { count, max, regen, timer, period, kind, unlimited: regen <= 0 });
    };
    for (const id of wares.items) {
      const d = this.itemReg?.get(id);
      if (d) seed(id, "item", d.stockMax, d.stockRegen, d.stockStart);
    }
    for (const id of wares.units) {
      const d = this.unitReg?.get(id);
      if (d) seed(id, "unit", d.stockMax, d.stockRegen, d.stockStart);
    }
    if (stock.size) u.building.stock = stock;
  }

  // --- runtime stock, for Blizzard.j's Marketplace (issue #57) ------------------
  //
  // The Marketplace (`nmrk`) is the one shop with no wares in its data at all: NeutralUnitFunc
  // gives it no `Sellitems`. Its shelves are stocked at RUNTIME by Blizzard's own JASS —
  // InitNeutralBuildings starts a timer, and every 30s (after a 120s delay) PerformStockUpdates
  // picks a random (item class, level) that some creep on the map is known to drop, then
  // UpdateEachStockBuilding enumerates every "marketplace" and calls AddItemToStock on it.
  // We run that script rather than reimplementing it (the house rule), so all the sim owes it
  // is these mutators. See src/jass/natives/stock.ts.

  /** Default type-slot caps for shops the script hasn't set explicitly — JASS
   *  SetAllItemTypeSlots / SetAllUnitTypeSlots. Blizzard.j's InitNeutralBuildings sets both to
   *  11 on its own; these defaults only matter on a map whose script never runs. */
  private allItemSlots: number = MELEE.MAX_STOCK_ITEM_SLOTS;
  private allUnitSlots: number = MELEE.MAX_STOCK_UNIT_SLOTS;

  setAllTypeSlots(kind: "item" | "unit", slots: number): void {
    if (kind === "item") this.allItemSlots = Math.max(0, slots);
    else this.allUnitSlots = Math.max(0, slots);
  }

  setTypeSlots(shopId: number, kind: "item" | "unit", slots: number): void {
    const b = this.units.get(shopId)?.building;
    if (!b) return;
    if (kind === "item") b.stockItemSlots = Math.max(0, slots);
    else b.stockUnitSlots = Math.max(0, slots);
  }

  private typeSlots(b: BuildingState, kind: "item" | "unit"): number {
    return (kind === "item" ? b.stockItemSlots : b.stockUnitSlots) ?? (kind === "item" ? this.allItemSlots : this.allUnitSlots);
  }

  /** JASS AddItemToStock / AddUnitToStock: put a ware on `shopId`'s shelf. Re-adding one the
   *  shop already carries just refreshes it. Refused when every type slot is taken — which is
   *  precisely what makes a Marketplace's window rotate rather than grow without bound: a sale
   *  removes the entry (RemoveItemFromStock, off the SELL_ITEM event) and frees the slot.
   *  Returns whether it went on the shelf. */
  addToStock(shopId: number, wareId: string, kind: "item" | "unit", count: number, max: number): boolean {
    const shop = this.units.get(shopId);
    const b = shop?.building;
    if (!shop || !b || shop.hp <= 0 || !wareId) return false;
    const stock = (b.stock ??= new Map());
    const held = stock.get(wareId);
    if (!held) {
      let used = 0;
      for (const s of stock.values()) if (s.kind === kind) used++;
      if (used >= this.typeSlots(b, kind)) return false; // shelf full
    }
    // A script-stocked ware carries no restock schedule of its own — the script IS its
    // schedule (the 30s stock-update timer), so regen stays 0 and the timer never runs.
    stock.set(wareId, { count: Math.max(0, count), max: Math.max(1, max), regen: 0, timer: Infinity, period: Infinity, kind });
    return true;
  }

  /** JASS RemoveItemFromStock / RemoveUnitFromStock: take the ware off the shelf entirely
   *  (not just decrement it) — the slot is freed for the next stock update. */
  removeFromStock(shopId: number, wareId: string): void {
    this.units.get(shopId)?.building?.stock?.delete(wareId);
  }

  /** Replenish every shop's shelves. A full shelf runs no timer; a ware with `stockRegen` 0
   *  never comes back once taken. */
  private tickShops(dt: number): void {
    for (const u of this.units.values()) {
      const stock = u.building?.stock;
      if (!stock || u.hp <= 0) continue;
      for (const s of stock.values()) {
        if (s.count >= s.max || !Number.isFinite(s.timer)) continue;
        s.timer -= dt;
        if (s.timer <= 0) {
          // The only clock an unlimited ware ever runs is its `stockStart` wait, and when that
          // expires the shelf fills right up rather than gaining one (regen 0 = no wait).
          s.count = s.unlimited ? s.max : s.count + 1;
          s.timer = s.regen > 0 ? s.regen : Infinity;
          s.period = s.timer;
        }
      }
    }
  }

  /** Take one off the shelf, starting the restock timer if the shelf had been full.
   *  A ware with no shelf at all (`stockMax` 0 — the state of most units in UnitBalance.slk) is
   *  not stock-limited and always sells; so is an `unlimited` one, which replenishes with no
   *  wait at all and so never actually leaves the shelf. */
  private takeStock(shop: SimUnit, wareId: string): boolean {
    const s = shop.building?.stock?.get(wareId);
    if (!s) return true;
    if (s.count <= 0) return false;
    if (s.unlimited) return true;
    const wasFull = s.count >= s.max;
    s.count--;
    if (wasFull) {
      s.timer = s.regen > 0 ? s.regen : Infinity;
      s.period = s.timer;
    }
    return true;
  }

  /** Buy an item from a shop and hand it straight to `buyerId` (WC3 puts it in the patron's
   *  inventory, it does not drop it on the floor). Returns why it failed, so the HUD can
   *  print the game's own message. */
  purchaseItem(shopId: number, buyerId: number, itemId: string, player: number): ShopResult {
    const shop = this.units.get(shopId);
    const buyer = this.units.get(buyerId);
    const def = this.itemReg?.get(itemId);
    if (!shop || !def || shop.hp <= 0) return "no";
    // `=== 0` and not `<= 0`: shopStock answers -1 for a ware with no shelf at all, which is
    // "not stock-limited", not "sold out". The command card has always read it that way
    // (`inStock = stock !== 0`) and the purchase refusing it was the two disagreeing.
    if (this.shopStock(shopId, itemId) === 0) return "nostock";
    // A RACE shop's tech gates the shelf: an Arcane Vault's Scroll of Town Portal needs a Keep.
    // A NEUTRAL shop's does not — see missingForShop.
    if (this.missingForShop(shopId, itemId, player).length) return "req";
    if (!buyer || buyer.owner !== player || buyer.hp <= 0 || !buyer.inventory.length) return "nopatron";
    if (!this.inShopRange(shop, buyer)) return "nopatron";
    if (buyer.inventory.indexOf(null) < 0) return "full";
    const stash = this.stashOf(player);
    if (stash.gold < def.gold || stash.lumber < def.lumber) return "cost";

    if (!this.takeStock(shop, itemId)) return "nostock";
    stash.gold -= def.gold;
    stash.lumber -= def.lumber;
    const slot = buyer.inventory.indexOf(null);
    const bought = { id: this.nextItemId++, itemId, charges: def.charges, cooldownLeft: 0 };
    buyer.inventory[slot] = bought;
    this.notifyCreepsOfShopUse(shop, buyer, MISC_GAME.ItemSaleAggroRange);
    // EVENT_(PLAYER_)UNIT_SELL_ITEM. Blizzard.j listens for this on every neutral-passive
    // building and answers it with RemoveItemFromStock(GetSellingUnit(), …) — so a Marketplace
    // only ever clears a sold item off its shelf (and frees the slot for the next 30s update)
    // BECAUSE this event fires. The seller is the shop; the manipulating unit is the patron.
    this.noteItem(buyer, bought, "sell", shop);
    return "ok";
  }

  /** Buy a UNIT from a shop (a Tavern's heroes, a Mercenary Camp's creeps). No patron is
   *  needed — the unit is produced by the shop itself and walks out — but the stock still
   *  depletes, and hiring is loud: creeps hear it (UnitSaleAggroRange 600). The caller has
   *  already charged the cost and queues the training. */
  purchaseUnit(shopId: number, unitId: string, player: number): ShopResult {
    const shop = this.units.get(shopId);
    if (!shop || shop.hp <= 0) return "no";
    if (this.shopStock(shopId, unitId) === 0) return "nostock"; // -1 = not stock-limited
    // Only a sold HERO is requirement-gated — see soldUnitNeedsTech.
    if (this.tech && this.soldUnitNeedsTech(unitId) && !this.tech.meets(player, unitId)) return "req";
    if (!this.takeStock(shop, unitId)) return "nostock";
    // Whoever of the buyer's units is nearest the shop takes the blame for the noise. NOT
    // shopPatrons(), which only returns inventory-holders — you don't need a hero to hire a
    // mercenary, so an army of Footmen parked outside the camp must still draw the aggro.
    this.notifyCreepsOfShopUse(shop, this.nearestUnitOf(player, shop), MISC_GAME.UnitSaleAggroRange);
    return "ok";
  }

  /** The player's live unit closest to `to`, or null — who the creeps come for. */
  private nearestUnitOf(player: number, to: SimUnit): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const u of this.units.values()) {
      if (u.owner !== player || u.hp <= 0 || u.building) continue;
      const d = Math.hypot(u.x - to.x, u.y - to.y);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** Sell an item back to a shop. WC3 pays `PawnItemRate` of its gold value (0.50 in the
   *  1.27a MiscGame.txt — NOT the 60% often quoted), and the hero must be within
   *  `PawnItemRange` (300) of the shop. The item is destroyed, not restocked. */
  pawnItem(unitId: number, slot: number, shopId: number): boolean {
    const u = this.units.get(unitId);
    const shop = this.units.get(shopId);
    if (!u || !shop || !this.itemReg || slot < 0 || slot >= u.inventory.length) return false;
    const held = u.inventory[slot];
    if (!held) return false;
    const def = this.itemReg.get(held.itemId);
    if (!def || !def.pawnable) return false;
    // The shop must actually DEAL IN ITEMS — the `Apit` ability, see canPawnAt. (Asking its
    // ware LIST instead, as this did, silently refused a Marketplace: it lists nothing.)
    if (!this.canPawnAt(shop)) return false;
    // Stated as "within", not "not beyond" — see inShopRange. Note pawning uses its own,
    // shorter reach (PawnItemRange 300) than buying does, so a hero can buy from further
    // away than he can sell.
    if (!this.inPawnRange(u, shop)) return false;
    u.inventory[slot] = null;
    const stash = this.stashOf(u.owner);
    const gold = Math.floor(def.gold * MISC_GAME.PawnItemRate);
    const lumber = Math.floor(def.lumber * MISC_GAME.PawnItemRate);
    stash.gold += gold;
    stash.lumber += lumber;
    // Being paid is a thing you SEE (issue #120), and the seller is where you are looking —
    // the coins land on the hero who handed the item over, not on the shop that took it.
    // Same "+N" the Alchemist's payout raises (transmuteInternal), but ATTACHED here rather
    // than placed: this unit is alive and will walk off, and the number goes with him.
    this.floatCredit("gold", gold, u.owner, u, u.id);
    this.floatCredit("lumber", lumber, u.owner, u, u.id); // 0 for every stock item; a custom one can price in wood
    if (gold > 0 || lumber > 0)
      this.spellEffects.push({ art: PAWN_GOLD_ART, x: u.x, y: u.y, targetId: u.id, z: 0, life: PAWN_GOLD_FX_LIFE, soundLabel: PAWN_GOLD_SOUND });
    return true;
  }

  /** Using a NEUTRAL building shouts to the creeps around it (issue #57). Two ranges, and
   *  they do two different things — the names say so:
   *
   *   - MiscData `NeutralUseNotifyRadius` (900) — creeps in earshot are NOTIFIED, i.e. they
   *     wake. Sleeping creeps are otherwise deaf, so this is what stops a player quietly
   *     shopping in the middle of a slumbering camp at night.
   *   - MiscGame `ItemSaleAggroRange` (0) / `UnitSaleAggroRange` (600) — creeps this close
   *     actually CHARGE. Buying a potion is silent (0); hiring a mercenary is not (600).
   *
   *  Only neutral buildings shout: the key is explicitly "when a neutral building is in use",
   *  and buying from the Arcane Vault in your own base must not rouse the map. */
  private notifyCreepsOfShopUse(shop: SimUnit, buyer: SimUnit | null, saleAggroRange: number): void {
    if (!shop.neutralPassive) return;
    for (const c of this.units.values()) {
      if (!c.isCreep || c.hp <= 0 || c.building || !c.weapon || c.returning) continue;
      const d = Math.hypot(c.x - shop.x, c.y - shop.y) - shop.radius;
      if (d > MISC_DATA.NeutralUseNotifyRadius) continue;
      c.asleep = false; // heard it — awake, but not necessarily coming
      if (d > saleAggroRange || !buyer || buyer.hp <= 0 || !this.hostile(c, buyer)) continue;
      c.campHelper = false; // roused in its own right, so it may call the rest of the camp
      this.issueAttack(c.id, buyer.id);
      this.alertCamp(c, buyer);
    }
  }

  /** Research finished since the last drain (renderer plays the completion sound). */
  drainResearchCompletions(): Array<{ buildingId: number; upgradeId: string; level: number; owner: number }> {
    const out = this.researchCompletions;
    this.researchCompletions = [];
    return out;
  }

  /** Announcements since the last drain (renderer turns each into text + sound + ping). */
  drainAlerts(): Alert[] {
    const out = this.alerts;
    this.alerts = [];
    return out;
  }

  /** Buildings finished since the last drain (renderer plays the "job's done" cue). */
  drainBuildCompletions(): Array<{ buildingId: number; owner: number }> {
    const out = this.buildCompletions;
    this.buildCompletions = [];
    return out;
  }

  /** Buildings that morphed since the last drain (renderer swaps the model + food). */
  drainMorphs(): Array<{ unitId: number; from: string; to: string }> {
    const out = this.morphs;
    this.morphs = [];
    return out;
  }

  /** Mines that ran dry since the last drain. */
  drainDepletedMines(): SimMine[] {
    if (!this.depleted.length) return this.depleted;
    const out = this.depleted;
    this.depleted = [];
    return out;
  }

  /** Units that are FINISHED but not yet born — the window between a job completing (or a shop
   *  hire, which completes on the spot) and the renderer's drain giving it a body.
   *
   *  Nothing else can see them: they are off the building's queue and not yet in `units`, so
   *  every "what is this player making" question (food, copies owned, which heroes are spoken
   *  for) would answer as if they had never been trained. That gap is one tick wide and a
   *  double-click is faster than one tick. */
  pendingTrained(): ReadonlyArray<{ unitId: string; owner: number }> {
    return this.trainCompletions;
  }

  /** Units finished training since the last drain (renderer spawns them). */
  drainTrained(): typeof this.trainCompletions {
    if (!this.trainCompletions.length) return this.trainCompletions;
    const out = this.trainCompletions;
    this.trainCompletions = [];
    return out;
  }

  /** Projectiles launched since the last drain (renderer creates missile models). */
  drainSpawnedProjectiles(): Array<{ id: number; art: string; x: number; y: number; z: number }> {
    if (!this.spawnedProjectiles.length) return this.spawnedProjectiles;
    const out = this.spawnedProjectiles;
    this.spawnedProjectiles = [];
    return out;
  }

  /** Projectiles that hit/fizzled since the last drain (renderer detaches them). */
  drainRemovedProjectiles(): number[] {
    if (!this.removedProjectiles.length) return this.removedProjectiles;
    const out = this.removedProjectiles;
    this.removedProjectiles = [];
    return out;
  }

  /** Projectiles that HIT their target since the last drain, with the hit point
   *  (renderer plays the impact effect there). Fizzles are absent. */
  drainProjectileImpacts(): Array<{ id: number; x: number; y: number; z: number }> {
    if (!this.projectileImpacts.length) return this.projectileImpacts;
    const out = this.projectileImpacts;
    this.projectileImpacts = [];
    return out;
  }

  /** Weapon hits (melee + projectile) landed since the last drain. Each names the weapon
   *  that landed it, which the renderer pairs with the struck unit's material to get the
   *  combat-impact sound — see `hits`. */
  drainHits(): Array<{ attackerId: number; targetId: number; weaponSound: string }> {
    if (!this.hits.length) return this.hits;
    const out = this.hits;
    this.hits = [];
    return out;
  }

  /** Worker ids that landed a chop since the last drain (renderer plays the axe SFX). */
  drainChops(): number[] {
    if (!this.chops.length) return this.chops;
    const out = this.chops;
    this.chops = [];
    return out;
  }

  /** Positions of trees hit (but not felled) by a chop since the last drain — the
   *  renderer plays each tree's "stand hit" wobble. */
  drainTreeHits(): Array<{ x: number; y: number }> {
    if (!this.treeHits.length) return this.treeHits;
    const out = this.treeHits;
    this.treeHits = [];
    return out;
  }

  /** Attacker ids whose swing fired since the last drain (renderer plays the unit's
   *  own attack/fire sound — the SND "K" event embedded in its model). */
  drainAttackSwings(): number[] {
    if (!this.attackSwings.length) return this.attackSwings;
    const out = this.attackSwings;
    this.attackSwings = [];
    return out;
  }

  /** A building's production queue is FULL — WC3 caps it at 7 jobs, training, research and
   *  tier upgrades all sharing the one queue. Callers must ask BEFORE charging: an enqueue
   *  refused after the gold has come out of the stash is gold the player never gets back.
   *  (Not to be confused with MAX_QUEUED_ORDERS, the shift-queued ORDER cap on a unit.) */
  queueFull(buildingId: number): boolean {
    const b = this.units.get(buildingId)?.building;
    return !!b && b.queue.length >= MAX_BUILD_QUEUE;
  }

  /** Queue a unit for training at a building. Timing only — the caller has
   *  already checked/charged resources and food. */
  enqueueTrain(buildingId: number, unitId: string, buildTime: number, free = false, buyer?: number): boolean {
    const u = this.units.get(buildingId);
    const b = u?.building;
    if (!u || !b || b.queue.length >= MAX_BUILD_QUEUE) return false;
    this.noteTrain(buildingId, unitId, "start"); // EVENT_(PLAYER_)UNIT_TRAIN_START
    // A HIRE is not production, so it never touches the queue. A shop hands the unit over at
    // once (Authority.SHOP_HIRE_TIME), and a job parked in the queue with nothing left to run
    // is still a job: the card draws a Cancel button over it for the one refresh before the
    // next tick shifts it off, which is a button offering to cancel something that has already
    // happened. WC3 shows no Cancel at a Mercenary Camp because there is nothing queued there
    // at all.
    if (buildTime <= 0) {
      this.completeTrain(u, b, unitId, buyer);
      return true;
    }
    b.queue.push({ kind: "unit", unitId, timeLeft: buildTime, buildTime, free, buyer });
    return true;
  }

  /** Hand a finished (or instantly hired) unit to the renderer, which owns the models.
   *
   *  `owner` is captured HERE, at completion, not re-read at the drain: the trained unit
   *  belongs to whoever owned the building when the job finished, and on a LAN host that is a
   *  REMOTE player as often as the local one (docs/multiplayer.md Phase G item 5 — the drain
   *  used to spawn every training as `localPlayer`).
   *
   *  …except at a SHOP, where the building's owner is the wrong answer entirely: a Tavern is
   *  Neutral Passive, so a hero hired there was born neutral — hostile to the player who just
   *  paid 425 gold for her, and wearing the neutral team colour. The job records its `buyer` (a
   *  Tavern's queue belongs to nobody, so the requirement tier needed it too); hiring is buying,
   *  and what you buy is yours. Gated on the shop rather than applied always so that a building
   *  which changes hands mid-training still hands its unit to whoever owns it NOW. */
  private completeTrain(u: SimUnit, b: BuildingState, unitId: string, buyer?: number): void {
    const owner = u.neutralPassive && buyer !== undefined ? buyer : u.owner;
    this.trainCompletions.push({ buildingId: u.id, unitId, owner, x: u.x, y: u.y, rallyX: b.rallyX, rallyY: b.rallyY, rallyKind: b.rallyKind, rallyTargetId: b.rallyTargetId });
  }

  /**
   * File a dead hero on its owner's altar roster.
   *
   * A PLAYER's hero only. A neutral-hostile or map-owned hero has no altar behind it and
   * nobody to press the button, so filing one would be a leak that grows for the whole match.
   * Reincarnation and a popped illusion both returned long before `killUnit` reaches here, so
   * neither is filed either: nothing has actually fallen.
   */
  private recordFallenHero(u: SimUnit): void {
    if (u.owner < 0 || u.isCreep || u.neutralPassive || u.isIllusion) return;
    this.fallen.set(u.id, {
      id: u.id, owner: u.owner, team: u.team, typeId: u.typeId, properName: u.properName,
      level: u.level, xp: u.xp, skillPoints: u.skillPoints,
      // Copied, not referenced: the SimUnit is about to be dropped from `units` and its
      // arrays would otherwise be the only thing keeping it alive.
      abilities: u.abilities.map((a) => ({ ...a })),
      inventory: u.inventory.map((it) => (it ? { ...it } : null)),
      baseStr: u.baseStr, baseAgi: u.baseAgi, baseInt: u.baseInt, baseMaxHp: u.baseMaxHp,
      x: u.x, y: u.y, revivingAt: 0,
      bodyLeft: heroBodyTime(this.unitReg?.get(u.typeId)?.deathTime ?? 0),
    });
  }

  /** This player's fallen heroes, in the order they were first hired (their sim ids ascend
   *  with hire order) — which is the order the hero bar draws them in and the order the
   *  altar's revive buttons are seated in. */
  fallenHeroesOf(player: number): FallenHero[] {
    return [...this.fallen.values()].filter((f) => f.owner === player).sort((a, b) => a.id - b.id);
  }

  /** Drop a fallen hero's record — a script that removes the unit outright, or a match
   *  cleaning up. Also un-marks whatever building was reviving it. */
  forgetFallenHero(heroId: number): void {
    this.fallen.delete(heroId);
  }

  /**
   * Queue a fallen hero's return at `buildingId`. Timing only — the caller has checked and
   * charged (Authority.execute), exactly as `enqueueTrain` expects.
   *
   * `time` 0 is the TAVERN: waking a hero there is a purchase, not production, so it happens
   * on the spot and nothing is ever queued — the same rule (and the same reason) as an
   * instant hire in `enqueueTrain`.
   */
  enqueueRevive(buildingId: number, heroId: number, time: number, buyer?: number): boolean {
    const u = this.units.get(buildingId);
    const b = u?.building;
    const f = this.fallen.get(heroId);
    if (!u || !b || !f || f.revivingAt || b.queue.length >= MAX_BUILD_QUEUE) return false;
    f.revivingAt = buildingId;
    if (time <= 0) {
      this.completeRevive(u, b, f, buyer);
      return true;
    }
    b.queue.push({ kind: "revive", unitId: f.typeId, heroId, timeLeft: time, buildTime: time, buyer });
    return true;
  }

  /** Hand a revived hero to the renderer, which owns the models — the SAME queue a trained
   *  unit goes out on, because a revival is a birth in every way the birth path cares about
   *  (spot beside the building, rally, "unit ready"). What makes it a revival rather than a
   *  hire is `reviveOf`, which the caller feeds back to `restoreFallenHero`. */
  private completeRevive(u: SimUnit, b: BuildingState, f: FallenHero, buyer?: number): void {
    const owner = u.neutralPassive && buyer !== undefined ? buyer : u.owner;
    this.trainCompletions.push({
      buildingId: u.id, unitId: f.typeId, owner, x: u.x, y: u.y,
      rallyX: b.rallyX, rallyY: b.rallyY, rallyKind: b.rallyKind, rallyTargetId: b.rallyTargetId,
      reviveOf: f.id, tavern: u.neutralPassive,
    });
  }

  /**
   * Put a fallen hero's life back into the freshly-born unit standing at the altar.
   *
   * The order is `initIllusion`'s and for the same reason: the level and the base attributes
   * have to land BEFORE `recomputeStats`, and hp/mana can only be written once that has run —
   * a hero spawned at its type's level 1 otherwise stands there with a level-1 pool and looks
   * wounded the moment the next tick recomputes it.
   *
   * `mode` picks which set of MiscGame factors the vitals come from: an altar hands the hero
   * back whole (full life, its opening 100 mana), a tavern hands it back at half life with
   * nothing in the tank.
   */
  reviveFallenHero(unitId: number, heroId: number, mode: ReviveMode): boolean {
    const u = this.units.get(unitId);
    const f = this.fallen.get(heroId);
    if (!u || !f) return false;
    this.fallen.delete(heroId);
    u.properName = f.properName;
    u.level = Math.max(1, f.level);
    u.xp = f.xp;
    u.skillPoints = f.skillPoints;
    // The ranks it had learned, not the type's blank sheet. Matched by id so an ability the
    // type no longer carries (a map that re-authored the hero mid-match) is simply dropped.
    for (const learned of f.abilities) {
      const ab = u.abilities.find((a) => a.id === learned.id);
      if (ab) ab.level = learned.level;
      else u.abilities.push({ ...learned });
    }
    u.inventory = f.inventory.map((it) => (it ? { ...it } : null));
    // Tomes: permanent, and they live in the base attributes rather than in the level.
    u.baseStr = f.baseStr;
    u.baseAgi = f.baseAgi;
    u.baseInt = f.baseInt;
    u.baseMaxHp = f.baseMaxHp;
    this.recomputeStats(u);
    const vitals = heroReviveVitals(mode, u.maxHp, u.maxMana, this.unitReg?.get(u.typeId)?.manaStart ?? 0);
    u.hp = Math.min(u.maxHp, vitals.hp);
    u.mana = vitals.mana;
    this.emitReviveFx(u, mode);
    return true;
  }

  /**
   * The light a hero comes back in — and the two buildings do it differently, because the two
   * buildings carry different abilities.
   *
   * **An ALTAR plays `[Arev]` "Revive Hero", by RACE.** Its `Targetart` is five models in one
   * comma-separated list, and that list is a LOOKUP rather than a set to play together: the
   * order is `RACE_INDEX`'s own with Demon on the end, so the index is that table minus one
   * and a Blademaster rises in `ReviveOrc.mdx` where an Archmage rises in `ReviveHuman.mdx`.
   * The ability is on no unit's `abilList` (an Altar carries only `Abds`) — it is the
   * engine's, which is why it lives in `Units\CommonAbilityFunc.txt` with `Order=revive` and
   * why the art is fetched by id rather than found on the building.
   *
   * **A TAVERN plays `[Aawa]` "Revive Hero Instantly", which it actually carries** —
   * `[ntav] abilList=Ane2,Avul,Aawa` — and whose `Targetart` is one race-neutral
   * `Abilities\Spells\Other\Awaken\Awaken.mdl`. So waking a hero at a Tavern does not look
   * like raising one at an altar, and it is SILENT: the install ships an `Awaken.mdx` and no
   * `Awaken.wav` beside it, and `AnimSounds.slk` has no `Awaken` row either. That silence is
   * the original's rather than a gap here — the two revivals are different acts, and the data
   * says so three times over: a different ability, a different model, and a different button
   * caption (a hero's `Revivetip` is the altar's, its `Awakentip` the Tavern's).
   *
   * The SOUND rides the model and needs no name here: `sound: true` sends the renderer through
   * `playSpellSound`, which resolves the model's own SND event through AnimLookups/AnimSounds
   * (`ReviveHuman` → `Abilities\Spells\Human\ReviveHuman\ReviveHuman.wav`) and, failing that,
   * finds the WAV sitting beside the model in its own folder. Both routes land on the same
   * four files, and neither is a path typed out here. Asked of the Tavern's art too, where
   * both routes correctly come back with nothing.
   *
   * `targetId` so the burst RIDES the hero: `Targetart` is art worn by the thing it is played
   * on, and a revived hero walks off toward the building's rally point while it is still
   * playing.
   *
   * A hero whose race is none of the four — a Naga or a Pandaren, whose `race` column reads
   * "creeps" — falls back to the list's first entry rather than going without. It can only
   * reach that at an ALTAR, which no neutral hero is revived at in the stock game; the list
   * has no neutral member either (its fifth is Demon, which nothing a player revives is), and
   * a burst of the wrong colour is a smaller wrong than a hero appearing out of nothing.
   */
  private emitReviveFx(u: SimUnit, mode: ReviveMode): void {
    // Each building's OWN ability, which is the whole of the difference between them.
    const arts = this.abilities?.get(mode === "tavern" ? "Aawa" : "Arev")?.targetArts ?? [];
    if (!arts.length) return;
    // A one-entry list is not a race table — the Tavern's Awaken is the same model whoever
    // stands up in it — so the race index only applies where there is something to index.
    const art = arts.length > 1 ? (arts[(RACE_INDEX[u.race as PlayableRace] ?? 1) - 1] ?? arts[0]) : arts[0];
    if (art) this.spellEffects.push({ art, x: u.x, y: u.y, targetId: u.id, z: 0, sound: true });
  }

  /** Queue an upgrade for research at a building. Timing only — the caller has already
   *  checked the tech requirements and charged the cost. WC3 shares ONE queue between
   *  training and research, so a Barracks researching Defend cannot also train a Footman. */
  enqueueResearch(buildingId: number, upgradeId: string, level: number, time: number): boolean {
    const b = this.units.get(buildingId)?.building;
    if (!b || b.queue.length >= MAX_BUILD_QUEUE) return false;
    b.queue.push({ kind: "research", unitId: upgradeId, level, timeLeft: time, buildTime: time });
    return true;
  }

  /** Queue this building's transformation into `toUnitId` (Town Hall → Keep, Scout Tower →
   *  Guard Tower). It keeps working while it upgrades, and morphs in place on completion. */
  enqueueUpgrade(buildingId: number, toUnitId: string, time: number): boolean {
    const b = this.units.get(buildingId)?.building;
    if (!b || b.queue.length >= MAX_BUILD_QUEUE) return false;
    b.queue.push({ kind: "upgrade", unitId: toUnitId, timeLeft: time, buildTime: time });
    return true;
  }

  /** The level a building is currently researching an upgrade at, or 0 — so the command card
   *  can show the in-progress rank and refuse to double-queue it. */
  researchingLevel(buildingId: number, upgradeId: string): number {
    const b = this.units.get(buildingId)?.building;
    if (!b) return 0;
    for (const j of b.queue) if (j.kind === "research" && j.unitId === upgradeId) return j.level;
    return 0;
  }

  /** Whether this building is already turning into something. A structure can only become one
   *  thing, so the upgrade buttons come off its card the moment one is queued — otherwise
   *  clicking "Upgrade to Keep" twice charges 705 gold twice and morphs a Keep into a Keep. */
  isUpgrading(buildingId: number): boolean {
    const b = this.units.get(buildingId)?.building;
    return !!b && b.queue.some((j) => j.kind === "upgrade");
  }

  /** Cancel the last queued item (returns the job, for the caller to refund). */
  cancelLastTrain(buildingId: number): BuildJob | null {
    const b = this.units.get(buildingId)?.building;
    if (!b || !b.queue.length) return null;
    return this.dropJob(buildingId, b.queue.pop()!);
  }

  /** Cancel a specific queued item by index (0 = the one currently in progress). Returns the
   *  job so the caller can refund it at the right rate — WC3 refunds training in full but a
   *  cancelled STRUCTURE UPGRADE only at 75% (MiscGame's UpgradeRefundRate). Removing index 0
   *  just promotes the next item, which keeps its own untouched timer. */
  cancelTrainAt(buildingId: number, index: number): BuildJob | null {
    const b = this.units.get(buildingId)?.building;
    if (!b || index < 0 || index >= b.queue.length) return null;
    return this.dropJob(buildingId, b.queue.splice(index, 1)[0]);
  }

  /** Common tail of a cancel: raise the event, and — the part that is easy to miss — put a
   *  SHOP-bought unit back on the shelf, since the stock is taken at purchase. A hire cannot
   *  normally reach this at all (it is instant, so it never enters the queue — see
   *  enqueueTrain); it is here for the queued case a mod's non-zero hire time would make. */
  private dropJob(buildingId: number, job: BuildJob): BuildJob {
    // A cancelled revival puts the hero back on the roster as merely dead — otherwise its
    // `revivingAt` stays pointing at a job that no longer exists and no altar will ever offer
    // it again. (The gold goes back in full: ReviveRefundRate = 1.0.)
    if (job.kind === "revive") {
      const f = this.fallen.get(job.heroId);
      if (f) f.revivingAt = 0;
    }
    if (job.kind === "unit") {
      this.noteTrain(buildingId, job.unitId, "cancel");
      this.returnStock(buildingId, job.unitId);
    }
    return job;
  }

  /** Put one back on the shelf (a cancelled purchase). Caps at stockMax and stops the restock
   *  timer if that refills the shelf. */
  private returnStock(shopId: number, wareId: string): void {
    const s = this.units.get(shopId)?.building?.stock?.get(wareId);
    if (!s || s.count >= s.max) return;
    s.count++;
  }

  /** Set a building's rally point. A plain point (kind "point") is a move
   *  destination; a mine/tree/unit target makes produced units harvest it or
   *  move to it (resolved in the renderer when each unit finishes). */
  setRally(buildingId: number, x: number, y: number, kind: RallyKind = "point", targetId = 0): void {
    const b = this.units.get(buildingId)?.building;
    if (b) {
      b.rallyX = x;
      b.rallyY = y;
      b.rallyKind = kind;
      b.rallyTargetId = targetId;
    }
  }

  /** Assign a worker to construct a building (walk there; progress advances
   *  once it arrives). Called when the building is first placed and when a
   *  worker is ordered to resume a halted construction. */
  assignBuilder(workerId: number, buildingId: number, ax?: number, ay?: number): void {
    const w = this.units.get(workerId);
    const b = this.units.get(buildingId);
    if (!w || !b?.building) return;
    // Release this worker from any previous job, then add it to the site's
    // builder list (multiple workers speed-build a single structure).
    this.detachBuilder(workerId);
    // Only HUMAN peasants speed-build: extra builders pile on to finish faster. Every
    // other race builds with a single worker (Orc/NE from inside, Undead summon-and-go),
    // so refuse a would-be second builder on a non-speed-build construction.
    if (!speedBuilds(w) && b.building.constructionLeft > 0 && b.building.builderIds.length >= 1) return;
    w.buildPending = null; // its walk-to-build intent is now realised
    w.constructing = buildingId;
    if (!b.building.builderIds.includes(workerId)) b.building.builderIds.push(workerId);
    w.noCollision = false;
    w.stuckT = 0;
    w.stuckRetries = 0;
    const gap = this.siteGap(w, b);
    if (gap >= 96) {
      // Far from the site (e.g. resuming a halted build): walk there. Progress
      // stays paused until the worker arrives (tickBuildings' nearby check). A
      // grouped order passes ax/ay — a distinct spot around the footprint — so
      // builders fan around the structure rather than all making for its centre.
      w.order = "move";
      if (!this.pathTo(w, ax ?? b.x, ay ?? b.y)) {
        w.desiredFacing = Math.atan2(b.y - w.y, b.x - w.x);
      }
      return;
    }
    // Orc peon: vanish INTO the site and build from inside (hidden), rather than
    // standing beside it. Emerges at the doorstep when the build ends (detachBuilder).
    if (buildsFromInside(w)) {
      this.enterBuildSite(w, b);
      return;
    }
    // Undead acolyte: the summoning is done the moment it gets here. Hand the structure
    // its own clock and let the Acolyte go (summonsBuildings) — it keeps standing where it
    // is, as the real game leaves it, but it holds no job and takes any order at once.
    if (summonsBuildings(w)) {
      b.building.selfBuilds = true;
      this.detachBuilder(workerId);
      // …but step OUT from under it first. The Acolyte walked to the site's centre (the
      // building did not exist to path around while it was walking), and the footprint is
      // stamped the instant the structure rises — so the summoner is left standing inside its
      // own foundation, on cells nothing can walk off. Every consequence of that reads as a
      // different bug: it kneels in the middle of the model, a repair order aimed at the new
      // building starts from the centre, and the Acolyte cannot leave. The Peasant has always
      // done this (below); the difference is only that the Undead branch returns before it.
      this.stepOffFootprint(w);
      w.order = "idle";
      w.moving = false;
      w.path = [];
      w.desiredFacing = Math.atan2(b.y - w.y, b.x - w.x); // …facing what it raised
      return;
    }
    // Human peasant: snap to the nearest free tile outside the building's (now
    // stamped) footprint, so it stands beside the site hammering rather than
    // being trapped inside the under-construction model.
    this.stepOffFootprint(w);
    w.order = "idle";
    w.moving = false;
    w.path = [];
    w.desiredFacing = Math.atan2(b.y - w.y, b.x - w.x); // face the build site
  }

  /**
   * How far a worker is from the EDGE of a building — chebyshev to its centre, less the
   * building's own extent and the worker's body. Zero means "standing against it".
   *
   * Measured against the STAMPED FOOTPRINT where that is known (buildHalfExtent), not against
   * `collision`: the collision column is a shove radius and is routinely SMALLER than the
   * square the building actually occupies — a Barracks stamps 12×12 cells (192 either side of
   * centre) and collides at 144. Since a builder now walks up to the stamp and stops
   * (buildApproach), measuring from the smaller number put it "96 away" while it was pressed
   * against the wall: assignBuilder decided it was still en route and sent it to the CENTRE,
   * where it wedged inside the foundation and the build never started. Falls back to
   * `collision` when the footprint is unknown, which is the behaviour this replaces.
   */
  private siteGap(w: SimUnit, b: SimUnit): number {
    const half = Math.max(b.radius, this.buildHalfExtent(b.typeId));
    return Math.max(Math.abs(w.x - b.x), Math.abs(w.y - b.y)) - half - w.radius;
  }

  /** Put a worker that is standing INSIDE the structure it has just started onto a free block
   *  beside it. Both races that build from OUTSIDE need this, and for the same reason: the
   *  worker walked to the SITE (there was no footprint to path around while it walked) and the
   *  stamp lands under its feet the instant the foundation rises. Measured against the
   *  worker's whole footprint rather than the single cell it stands on, so a two-cell body
   *  ends up clear rather than half in — the same move emergeBuilder makes for the peon
   *  coming back out, which is why it is written the same way. */
  private stepOffFootprint(w: SimUnit): void {
    this.unsettle(w);
    const n = Math.max(w.footprint || footprintCells(w.radius), 1);
    const [cx, cy] = this.grid.footprintAnchor(w.x, w.y, n);
    const fit = this.grid.nearestFit(cx, cy, n) ?? this.grid.nearestWalkable(cx, cy);
    if (fit) [w.x, w.y] = this.grid.footprintCenter(fit[0], fit[1], n);
    this.settle(w);
  }

  /** Orc peon disappearing INTO the structure it's building: parked at the site centre,
   *  hidden by the renderer, reserving no cells. It re-emerges via detachBuilder (called
   *  on completion, cancel, or the building's death). */
  private enterBuildSite(w: SimUnit, b: SimUnit): void {
    this.unsettle(w); // stop blocking cells while invisible inside
    w.x = b.x;
    w.y = b.y;
    w.insideBuild = true;
    w.order = "idle";
    w.moving = false;
    w.path = [];
    w.noCollision = false;
    w.desiredFacing = b.facing;
  }

  /** Orc peon leaving a structure it built from inside: place it on a free tile beside
   *  the building's footprint and clear the hidden flag. No-op for a normal builder. */
  private emergeBuilder(w: SimUnit, b: SimUnit): void {
    if (!w.insideBuild) return;
    w.insideBuild = false;
    const n = w.footprint || footprintCells(w.radius);
    // Anchor space, so the cell nearestFit clears is the cell the worker ends up standing on
    // (they differ by half a cell for an even footprint — see PathingGrid.footprintCenter).
    const [bcx, bcy] = this.grid.footprintAnchor(b.x, b.y, n);
    const fit = this.grid.nearestFit(bcx, bcy, n) ?? this.grid.nearestWalkable(bcx, bcy);
    if (fit) [w.x, w.y] = this.grid.footprintCenter(fit[0], fit[1], n);
    w.order = "idle";
    w.moving = false;
    w.path = [];
    this.settle(w);
    w.desiredFacing = Math.atan2(b.y - w.y, b.x - w.x);
  }

  // === Cargo holds: the Orc Burrow, and transports ====================================
  // Peons climb inside an Orc Burrow (up to Abun's Dataa1 = 4) and it fires arrows: one
  // piercing projectile whose DPS scales with the peon count (cooldown = base/(n+1);
  // recomputeStats). Ground truth: UnitAbilities.slk otrb has Abun (Load) + Abtl (Battle
  // Stations); Abun Dataa1=4; weapon 23-27 pierce, range 700, base cd 4 (UnitWeapons.slk);
  // scaling per Liquipedia Orc_Burrow.
  //
  // A TRANSPORT is the same mechanism with a different cargo hold. AbilityData.slk keeps them
  // in one family, told apart by the `code` column (the ability CLASS, which is what we
  // dispatch on everywhere): `Abun` is "Cargo Hold (Burrow)" and `Acar` is the transport's —
  // `Sch5` "Cargo Hold (Ship)" (Dataa1 = 10; every transport ship: hbot/obot/nbot/etrs/ubot)
  // and `Sch3` "Cargo Hold (Transport)" (8; the Goblin Zeppelin and the air barge). The other
  // "Cargo Hold" rows are NOT this: `Advc` is Devour, `Sch2`/`Amtc` is the Meat Wagon's corpse
  // bin and `Aenc` a Gold Mine's crew, and none of them takes a passenger that walks back out.
  //
  // Rise of the Naga is why transports exist here at all: its harbour cinematic ends with
  // `IssueTargetOrderBJ(Illidan, "board", ship)`, and the ship sails on the map's own
  // `EVENT_UNIT_LOADED` trigger. With no cargo hold the order fell through to "follow",
  // Illidan trotted after the boat forever and the chapter's last scene never happened.

  /** Which cargo hold a unit type carries, by ability CODE — `Abun` (burrow), `Aenc` (the
   *  Entangled Gold Mine's crew) or `Acar` (transport), with the alias it came from so the
   *  capacity can be read off that row. Null for a type with neither.
   *
   *  `Aenc` is here because it IS the same mechanism: AbilityData calls it "Cargo Hold (Gold
   *  Mine)", it carries the family's Cargo Capacity column (Car1 = 5 wisps) and its strings are
   *  Load / Unload All. What it is not is a transport — its passengers are workers and they
   *  are in there to work, which is the `holdTakesWorkersOnly` split below. */
  private cargoHold(typeId: string): { alias: string; code: string } | null {
    const def = this.unitReg?.get(typeId);
    if (!def) return null;
    for (const alias of def.abilities) {
      const code = this.abilities?.get(alias)?.code ?? alias;
      if (code === "Abun" || code === "Acar" || code === "Aenc") return { alias, code };
    }
    return null;
  }

  /** The ability CODE of a unit type's cargo hold ("Abun" / "Aenc" / "Acar"), or "". The card
   *  needs it: a burrow's buttons are Battle Stations / Stand Down and an Entangled Gold
   *  Mine's are `Aenc`'s own Load / Unload All. */
  cargoHoldCode(typeId: string): string {
    return this.cargoHold(typeId)?.code ?? "";
  }

  /** A hold that only workers may climb into: the Orc Burrow (peons man the arrow slits) and
   *  the Entangled Gold Mine (wisps mine it). A transport takes anyone who walks. */
  private holdTakesWorkersOnly(typeId: string): boolean {
    const code = this.cargoHold(typeId)?.code;
    return code === "Abun" || code === "Aenc";
  }

  /** Passenger capacity of a unit type: its cargo hold's Dataa1 (4 for the Orc Burrow, 10 for
   *  a transport ship), 0 if it has no hold. Cached per unit in `garrisonCap`. */
  private computeGarrisonCap(typeId: string): number {
    const hold = this.cargoHold(typeId);
    if (!hold) return 0;
    const cap = this.abilities?.get(hold.alias)?.levelData[0]?.data[0];
    if (cap && cap > 0) return Math.round(cap);
    // The data's own defaults, if the row went missing: burrow 4, gold mine 5, transport 8.
    return hold.code === "Abun" ? 4 : hold.code === "Aenc" ? 5 : 8;
  }

  /**
   * How much of a hold is SPENT — the passengers' `cargoSize`s summed, not their number.
   *
   * A cargo hold is measured in seats and the siege roster costs more than one of them
   * (UnitDef.cargoSize): a transport ship's ten seats take five Demolishers or two Siege
   * Engines, and counting heads let it swallow ten of either. The Orc Burrow and the
   * Entangled Gold Mine only ever hold WORKERS, which are one seat each, so the two readings
   * agree there and nothing about either changes.
   */
  private garrisonLoad(host: SimUnit): number {
    let load = 0;
    for (const id of host.garrison) load += this.units.get(id)?.cargoSize ?? 1;
    return load;
  }

  /** Whether `host` can take a passenger right now — `passenger` when it is a particular
   *  one, since what "room" means depends on how many seats it needs. */
  private hostHasRoom(host: SimUnit, passenger?: SimUnit): boolean {
    return (
      host.garrisonCap > 0 &&
      host.hp > 0 &&
      (!host.building || host.building.constructionLeft <= 0) &&
      this.garrisonLoad(host) + (passenger?.cargoSize ?? 1) <= host.garrisonCap
    );
  }

  /** Order a unit into a cargo hold: walk there, then climb inside (tickGarrison). A BURROW
   *  takes workers only (WC3 lets nothing else man one); a transport takes any ground unit
   *  that isn't itself a building or a flier — Acar's targs are "ground,friend,vuln,invu". */
  issueGarrison(passengerId: number, hostId: number): boolean {
    const p = this.units.get(passengerId);
    const b = this.units.get(hostId);
    if (!p || this.castLocked(p) || !b || b.garrisonCap === 0) return false;
    const workersOnly = this.holdTakesWorkersOnly(b.typeId);
    if (workersOnly ? !p.worker : p.building || p.flying) return false;
    if (this.hostile(p, b)) return false; // only your own / allied holds
    // What it was doing, written down BEFORE anything below cancels it — `detachBuilder` and
    // the order change three lines on are exactly what leaves a peon with nothing to go back
    // to. Stand Down spends it (resumeGarrisonJob).
    p.garrisonJob = this.jobOf(p);
    // Boarding does not come through issueOrder (the authority calls this directly), so the
    // two "put the worker back on the field first" steps that funnel does have to run here.
    this.popFromMine(p);
    this.popFromCanopy(p);
    p.order = "garrison";
    p.targetId = hostId;
    p.inCombat = false;
    p.noCollision = false;
    this.cancelSwing(p);
    this.detachBuilder(passengerId); // drop any build/harvest job
    p.stuckT = 0;
    p.stuckRetries = 0;
    if (this.inHostReach(p, b)) {
      // Already at the door — hop in now, but only if the hold is actually OPEN. `enterHost`
      // asks nothing; the walk-up path gates on `hostHasRoom` and this shortcut did not, so a
      // Wisp standing beside a mine that was still closing its roots climbed into an
      // unfinished building (and a peon beside a full burrow made itself a fifth passenger).
      // A shut hold is not a refusal of the ORDER: it keeps it and waits where it stands,
      // exactly as one that walked up does — tickGarrison boards it when the roots close, or
      // stands it down if the hold was merely full.
      if (this.hostHasRoom(b, p)) {
        this.enterHost(p, b);
        return true;
      }
      p.moving = false;
      return true;
    }
    const [ax, ay] = this.hostApproach(p, b);
    // Bodies in the way are not a refusal — the order is still good, so park and take the
    // walk up when the way opens (holdOrGiveUp; the same rule issueMove follows, issue
    // #108). Only terrain that puts the door genuinely out of reach ends it. A unit born
    // into a crowd at a rally point is exactly the case: the wisp a rallied Tree of Life
    // pushes out lands among the ones already standing there, and one blocked A* at that
    // instant used to stand it down for good.
    if (!this.pathTo(p, ax, ay)) this.holdOrGiveUp(p, ax, ay);
    return p.order === "garrison"; // parked keeps the order (accepted); stopped does not
  }

  /** How far out from a cargo hold's CENTRE its body actually reaches. A building's collision
   *  radius is not that: `egol` blocks a 16-cell pathing square and carries a collision of a
   *  fraction of it, so a door found at `radius` is a door in the middle of the rock. The
   *  stamped footprint is the honest extent, and using it is what lets a wisp find its way
   *  into an Entangled Gold Mine at all (it also widens the Orc Burrow's door a little). */
  private hostExtent(b: SimUnit): number {
    // The BLOCKED extent, not the texture's: `16x16Goldmine.tga` pads out to 16 cells and
    // blocks only the middle 8, so its full size would put the door two tiles further out
    // than the rock actually reaches — far enough that a wisp standing against it is judged
    // "not there yet" forever. Same measurement the gold mine's own collider uses.
    const fp = b.pathStamp?.fp;
    return Math.max(b.radius, fp ? footprintRadius(fp) : 0);
  }

  /** A walkable point just outside the host's footprint on the passenger's side — the burrow
   *  centre itself is blocked (and a ship sits on water), so pathing straight at it fails. */
  private hostApproach(p: SimUnit, b: SimUnit): [number, number] {
    const dx = p.x - b.x, dy = p.y - b.y;
    // Project onto the footprint SQUARE rather than a circle around it: on a diagonal a
    // circle of the same reach lands inside the blocked block (the same trap mineStandSpot
    // documents at length).
    const m = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
    const reach = this.hostExtent(b) + p.radius + PATHING_CELL;
    const ax = b.x + (dx / m) * reach, ay = b.y + (dy / m) * reach;
    // …and snap onto a spot the passenger's own BLOCK fits on, exactly as mineStandSpot
    // does — the other half of that trap. `nearestWalkable` clears one CELL, and a door
    // one cell wide is no door to a unit two cells across: A* is asked for a route to a
    // goal it can never anchor on, finds none, and issueGarrison reads that as "the way
    // is shut" and stands the passenger down. A wisp trained at a Tree of Life RALLIED
    // onto its entangled mine is born a couple of cells from the rock, which is where a
    // one-cell door and a two-cell wisp meet: the first wisp of every rally stopped dead
    // beside the mine while the ones behind it (spawned further out) walked in fine.
    const n = p.footprint;
    if (n <= 0) {
      const [cx, cy] = this.grid.worldToCell(ax, ay);
      const free = this.grid.nearestWalkable(cx, cy, 6);
      return free ? this.grid.cellToWorld(free[0], free[1]) : [ax, ay];
    }
    const [sx, sy] = this.grid.snapForFootprint(ax, ay, n);
    const [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
    if (this.blockFree(cx0, cy0, n)) return [sx, sy];
    // Terrain-only line (`unitsBlockLine` false): the queue already standing at the door is
    // what we are spiralling PAST, so their tiles must not veto the hop.
    return this.nearestFreeBlock(sx, sy, n, 8, false) ?? [sx, sy];
  }

  /** "Close enough to climb in." Measured against the same square `hostApproach` aims at, plus
   *  a cell of slack — the door and the test have to agree, or a passenger parks exactly where
   *  it was sent and is told it has not arrived. (That is not hypothetical: at 48 units of
   *  tolerance against a gold mine's 128-unit block, wisps walked to the rim and stood there.) */
  private inHostReach(p: SimUnit, b: SimUnit): boolean {
    const door = this.hostExtent(b) + p.radius + PATHING_CELL;
    return Math.max(Math.abs(p.x - b.x), Math.abs(p.y - b.y)) <= door + PATHING_CELL;
  }

  /** Drive a unit walking to its cargo hold: enter once it reaches the host's edge. */
  private tickGarrison(u: SimUnit): void {
    const b = u.targetId ? this.units.get(u.targetId) : null;
    if (!b || b.garrisonCap === 0 || b.hp <= 0) {
      this.stop(u.id);
      return;
    }
    if (u.moving) return; // still walking up
    if (this.inHostReach(u, b)) {
      if (this.hostHasRoom(b, u)) this.enterHost(u, b);
      // A hold that is still going UP is not a refusal — it is not open yet. Patch 1.10:
      // "Wisps rallied to an incomplete Entangled Gold Mine will automatically begin to mine
      // once the structure is completed." Which is the ordinary case now that entangling a
      // mine takes `egol`'s 60 seconds: the crew walks over while the roots are closing and
      // stands at the door. Only a hold that is genuinely FULL sends anybody home.
      else if (b.building && b.building.constructionLeft > 0 && this.garrisonLoad(b) + u.cargoSize <= b.garrisonCap) return;
      else this.stop(u.id); // full while we walked — give up
      u.nodeRetries = 0;
    } else {
      // Stopped short of the host (blocked); try the door again, and give up only after a
      // couple of honest attempts. One failed A* is not proof the door is shut: five wisps
      // sent into one Entangled Gold Mine arrive at the same approach cell and take turns
      // standing in each other's way, so the loser of any single tick would otherwise be
      // sent home for good. Bounded exactly as the harvest approach is (arriveAtNode) —
      // except while PARKED, where the countdown is itself the retry timer and re-pathing
      // every tick would just burn the tries out on a jam that has not moved yet.
      if (u.waitT > 0) return;
      const [ax, ay] = this.hostApproach(u, b);
      if (this.pathTo(u, ax, ay)) u.nodeRetries = 0;
      else if (this.terrainReachable(u, ax, ay)) this.parkAndWait(u); // bodies, not walls — wait them out
      else if (u.nodeRetries++ >= NODE_REPATH_TRIES) this.stop(u.id);
    }
  }

  /** A passenger climbs in: hidden, reserving no cells, added to the hold's roster — and
   *  riding along, since a transport takes its cargo with it (`carryPassengers`). */
  private enterHost(passenger: SimUnit, host: SimUnit): void {
    this.unsettle(passenger); // no cell block while inside
    passenger.inBurrow = true;
    passenger.garrisonHost = host.id;
    passenger.order = "idle";
    passenger.targetId = null;
    passenger.moving = false;
    passenger.path = [];
    passenger.noCollision = false;
    passenger.x = host.x;
    passenger.y = host.y;
    if (!host.garrison.includes(passenger.id)) host.garrison.push(passenger.id);
    this.recomputeStats(host); // switch the burrow's arrow attack on / rescale its cooldown
    this.noteLoad(passenger, host);
  }

  /** Eject one passenger to a free tile beside its host. */
  private ejectPassenger(passenger: SimUnit, host: SimUnit): void {
    passenger.inBurrow = false;
    passenger.garrisonHost = 0;
    const n = passenger.footprint || footprintCells(passenger.radius);
    const [bcx, bcy] = this.grid.footprintAnchor(host.x, host.y, n);
    const fit = this.grid.nearestFit(bcx, bcy, n) ?? this.grid.nearestWalkable(bcx, bcy);
    if (fit) [passenger.x, passenger.y] = this.grid.footprintCenter(fit[0], fit[1], n);
    passenger.order = "idle";
    passenger.moving = false;
    passenger.path = [];
    this.settle(passenger); // blocks its cell so the next one out fans out beside it
    passenger.desiredFacing = Math.atan2(passenger.y - host.y, passenger.x - host.x);
  }

  /**
   * The standing job a worker would be put back on if it were pulled out of a hold right now
   * (SimUnit.garrisonJob), or null if it was not working when it climbed in.
   *
   * Read off the live order rather than off anything remembered, which is what makes a worker
   * walking a load HOME still count as gathering: `resKind`/`resId` outlive the trip, so a
   * peon caught mid-haul goes back to the same mine rather than standing in the yard holding
   * ten gold.
   */
  private jobOf(u: SimUnit): GarrisonJob | null {
    if (!u.worker) return null;
    if (u.repair) {
      const r = u.repair;
      return { kind: "repair", buildingId: r.targetId, hpPerSec: r.hpPerSec, goldPerHp: r.goldPerHp, lumberPerHp: r.lumberPerHp };
    }
    if (u.resKind && u.resId) return { kind: "harvest", res: u.resKind, nodeId: u.resId };
    return null;
  }

  /** Put a worker that has just left a hold back on the job it was pulled off. Returns whether
   *  it took the order — a mine that ran dry or a tree that fell while it was inside simply
   *  refuses, and the worker stands where it came out, which is the honest answer. */
  private resumeGarrisonJob(u: SimUnit): boolean {
    const job = u.garrisonJob;
    u.garrisonJob = null;
    if (!job) return false;
    return job.kind === "harvest"
      ? this.issueHarvest(u.id, job.res, job.nodeId)
      : this.issueRepair(u.id, job.buildingId, job.hpPerSec, job.goldPerHp, job.lumberPerHp);
  }

  /**
   * Unload every passenger from a cargo hold — the Stand Down / Unload command.
   *
   * `backToWork` is the difference between the two buttons, and each states its own case in
   * CommandStrings: the Orc Burrow's Stand Down "causes Peons within the Burrow to return to
   * work", so its crew picks up the job it was pulled off (Battle Stations is an interruption,
   * not a re-assignment). The Entangled Gold Mine's `Aenc` button only "removes all Wisps from
   * the gold mine" and promises nothing, and every other way a hold empties — the building
   * dying, the mine running dry, a Tree of Life uprooting — is not a command at all. Those all
   * put the passengers out and leave them standing.
   */
  unloadBurrow(hostId: number, backToWork = false): boolean {
    const b = this.units.get(hostId);
    if (!b || b.garrison.length === 0) return false;
    const resume = backToWork && this.cargoHoldCode(b.typeId) === "Abun";
    for (const pid of [...b.garrison]) {
      const p = this.units.get(pid);
      if (!p) continue;
      this.ejectPassenger(p, b);
      if (resume) this.resumeGarrisonJob(p);
      else p.garrisonJob = null; // out by any other door: the memory goes with it
    }
    b.garrison = [];
    this.recomputeStats(b); // empty → arrow attack off
    return true;
  }

  /** Cargo rides with its carrier. A burrow never moves and this costs it nothing; a ship
   *  does, and without it a passenger would be put ashore wherever it happened to board —
   *  `ejectPassenger` places it beside the HOST, so the host's position has to be the one it
   *  is standing at. It also keeps everything that reads a unit's position (vision, groups,
   *  a trigger's GetUnitX) answering where the unit actually is. */
  private carryPassengers(): void {
    for (const u of this.units.values()) {
      if (!u.garrison.length) continue;
      for (const pid of u.garrison) {
        const p = this.units.get(pid);
        if (!p) continue;
        p.x = u.x;
        p.y = u.y;
      }
    }
  }

  /** Battle Stations: order nearby idle friendly peons into burrows with room, this one
   *  first, then the nearest others (Abtl). */
  battleStations(burrowId: number): boolean {
    const b = this.units.get(burrowId);
    if (!b || b.garrisonCap === 0) return false;
    const R2 = 800 * 800; // gather radius around the burrow (WC3 ~ screenful)
    const peons = [...this.units.values()]
      .filter((p) => p.worker && p.owner === b.owner && p.hp > 0 && !p.inBurrow && !p.inMine && !p.insideBuild && !p.constructing && (p.x - b.x) ** 2 + (p.y - b.y) ** 2 <= R2)
      .sort((a, c) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 - ((c.x - b.x) ** 2 + (c.y - b.y) ** 2));
    // Project the seats we've already handed out this call so peons distribute across
    // burrows instead of all walking to the same one (only `cap` can actually enter).
    const dispatched = new Map<number, number>();
    const roomFor = (bur: SimUnit): boolean =>
      bur.hp > 0 && (!bur.building || bur.building.constructionLeft <= 0) &&
      this.garrisonLoad(bur) + (dispatched.get(bur.id) ?? 0) < bur.garrisonCap;
    let sent = 0;
    for (const p of peons) {
      let target: SimUnit | null = roomFor(b) ? b : null;
      if (!target) {
        let bestD = Infinity;
        for (const u of this.units.values()) {
          if (u.garrisonCap === 0 || u.owner !== b.owner || !roomFor(u)) continue;
          const d = (u.x - p.x) ** 2 + (u.y - p.y) ** 2;
          if (d < bestD) { bestD = d; target = u; }
        }
      }
      if (!target) break; // every burrow full
      if (this.issueGarrison(p.id, target.id)) {
        dispatched.set(target.id, (dispatched.get(target.id) ?? 0) + 1);
        sent++;
      }
    }
    return sent > 0;
  }

  // === The Entangled Gold Mine ==========================================================
  //
  // Night elf gold is the only economy in the game with no round trip: the mine is wrapped in
  // roots, up to five wisps climb inside, and gold simply arrives for as long as they are in
  // there. Three data rows say all of it, and none of them is on the wisp:
  //
  //   `Aent`  "Entangle"            Tree of Life. Rng1 = 500, Cast1 = 3s, targs1 = _ (no
  //                                 target at all — you press the button and it takes the
  //                                 mine it is standing next to), and `UnitID1 = egol`: the
  //                                 ability CREATES a unit. So the SimMine is not converted;
  //                                 a building is raised over it. See SimMine.entangledBy.
  //   `Aenc`  "Cargo Hold (Gold Mine)"  on egol. Car1 = 5 — the crew, through exactly the same
  //                                 cargo-hold machinery the Orc Burrow uses.
  //   `Aegm`  "Entangled Gold Mine"     on egol. DataA1 = 10 gold, DataB1 = 1 second.
  //
  // A fourth row is on the BUILDING rather than on any ability, and it is the one that makes
  // taking an expansion cost something: `egol` UnitBalance `bldtm` = **60**. The roots do not
  // snap shut — the Entangled Gold Mine goes up the way every other structure does, from a
  // tenth of its 800 hit points to all of them over a full minute, and it pays nothing until
  // it is finished. Nobody builds it (there is no Wisp in it and none can be sent), so it is
  // the one structure that raises itself: `BuildingState.selfBuilds`.
  //
  // The one exception is the melee opening, and it is the ORDER that says so rather than a
  // special case: `entangleinstant` is instant in both senses — no 3s cast and no 60s build —
  // so a night elf game starts with a finished mine its five Wisps can walk straight into.
  //
  // 10 gold a second is the FULL mine's rate, not one wisp's: five wisps in an entangled mine
  // must earn what five peasants earn out of a classic one, and a peasant's cycle is
  // `Agld`'s 1s inside plus the walk — about 2 gold/sec each, 10 for the line. So the payout
  // scales with how much of the crew is actually aboard (`crew / capacity`), which makes one
  // lone wisp worth 2 gold/sec and a full mine worth 10. Nothing in the data states the
  // scaling in so many words; the parity between the four races' mining rates does.
  //
  // And it arrives on the INTERVAL, in whole gold. `DataB1 = 1 second` is a clock, not a unit
  // of measure to divide by: a mine that paid a fraction of a coin every frame put a running
  // 656.5666666 in the stash and made the counter creep instead of stepping, where WC3 pays a
  // lump each time the interval comes round. Same average, and the only version that can put
  // an integer in the treasury.

  /** Entangle (`Aent`): wrap a gold mine in roots. With no `mine` named it takes the nearest
   *  un-entangled one within the ability's range, which is the button's own behaviour —
   *  `targs1` is literally `_`, so the ability takes NO target and simply wraps whatever it is
   *  standing next to. A named mine is the `entangleinstant` order (see issueEntangleInstant).
   *
   *  The building itself is spawned by the renderer (it needs a model — same asynchrony as a
   *  summon), which calls back through attachEntangled. False if there is no mine in reach,
   *  which is the whole of the ability's failure case.
   *
   *  `instant` skips the 60-second build (`egol` bldtm) as well as the cast — the melee
   *  opening's `entangleinstant`, and nothing else. */
  entangleMine(caster: SimUnit, def: AbilityDef, mine?: SimMine, instant = false): boolean {
    // Roots in the air hold nothing, and the game has a line for it: [Errors]
    // `Mustroottoentangle` = "Must root adjacent to a gold mine to entangle it." A press on
    // the uprooted card never reaches here — `issueCast` turns it into the errand that plants
    // the tree first (issueEntangleAt) — so this is the backstop for a trigger or an order
    // that aims the raw cast at a walking Ancient.
    if (caster.uprooted) return false;
    const range = def.levelData[0]?.castRange || 500;
    let best: SimMine | null = null;
    if (mine) {
      if (mine.entangledBy || !this.mines.has(mine.id)) return false;
      best = mine;
    } else {
      let bestD = Infinity;
      for (const m of this.mines.values()) {
        if (m.entangledBy) continue;
        const d = Math.hypot(m.x - caster.x, m.y - caster.y);
        if (d > range + m.radius || d >= bestD) continue;
        bestD = d;
        best = m;
      }
    }
    if (!best) return false;
    const unitId = def.levelData[0]?.summon || "egol"; // `Aent` UnitID1 — the unit it raises
    // Claimed the moment it is asked for, not when the model lands: the request is in flight
    // for a frame or two and a second Tree of Life must not entangle the same mine again.
    best.entangledBy = -1;
    this.entangleRequests.push({ mineId: best.id, unitId, x: best.x, y: best.y, owner: caster.owner, team: caster.team, casterId: caster.id, instant });
    return true;
  }

  /**
   * `entangleinstant` — Entangle aimed at a NAMED mine, with no cast time.
   *
   * A second order string on the same `Aent` row (UI\TriggerData.txt lists both
   * `UnitOrderEntangleInstant` and `UnitOrderAutoEntangleInstant`), and it exists because the
   * melee opening needs it: `Blizzard.j`'s `MeleeStartingUnitsNightElf` plants the Tree of
   * Life beside the nearest mine and immediately issues
   * `IssueTargetOrder(tree, "entangleinstant", nearestMine)` — which is why a night elf melee
   * game STARTS with its gold mine already entangled and its five Wisps able to walk straight
   * in. Six night elf campaign chapters open the same way.
   *
   * `mineId` 0 means "the one you are standing next to" — the ability's own no-target rule,
   * which is what the second order string (`autoentangleinstant`) asks for.
   *
   * "Instant" is both clocks, not just the cast: the mine it leaves behind is a FINISHED
   * building rather than a foundation with 60 seconds of `bldtm` to serve. A start that had
   * to wait a minute for its own gold would not be the start the melee script is writing.
   *
   * Returns false if the unit has no Entangle, or the mine is gone/already wrapped.
   */
  issueEntangleInstant(casterId: number, mineId: number): boolean {
    const u = this.units.get(casterId);
    if (!u || !this.abilities) return false;
    const mine = mineId ? this.mines.get(mineId) : undefined;
    if (mineId && !mine) return false;
    const ab = u.abilities.find((a) => a.code === "Aent" && a.level >= 1);
    const def = ab && this.abilities.get(ab.id);
    if (!def) return false;
    return this.entangleMine(u, def, mine, true);
  }

  /**
   * "Go and take that mine" — the whole night elf expansion as one order (`{kind:"entangleat"}`).
   *
   * This is what a right-click on a free gold mine means to an uprooted Tree of Life, and it
   * is two acts rather than one, because Entangle itself can do neither: the ability takes no
   * target, has a 500 range, and the game's own refusal line spells out the rest —
   * `Mustroottoentangle` = "Must root adjacent to a gold mine to entangle it." So the tree
   * walks to a spot from which Entangle can reach the mine, and the roots go out the instant
   * it starts lowering itself onto that spot (tickEntangleAt).
   *
   * Only a WALKING tree takes this order: Entangle is the uprooted card's button (see
   * UPROOTED_ONLY), so a planted one is not asked to do anything here.
   *
   * `mineId` 0 = the nearest free mine inside Entangle's own range, which is what pressing the
   * button with no target means.
   */
  issueEntangleAt(id: number, mineId: number): boolean {
    const u = this.units.get(id);
    if (!u || u.hp <= 0 || !this.abilities) return false;
    const ab = u.abilities.find((a) => a.code === "Aent" && a.level >= 1);
    const def = ab && this.abilities.get(ab.id);
    if (!def) return false;
    const range = def.levelData[0]?.castRange || 500;
    let mine = mineId ? this.mines.get(mineId) : undefined;
    if (mineId && !mine) return false;
    if (!mine) {
      // No mine named: the ability's own rule — whatever free one is standing inside `Rng1`.
      let bestD = Infinity;
      for (const m of this.mines.values()) {
        const d = Math.hypot(m.x - u.x, m.y - u.y);
        if (d > range + m.radius || d >= bestD || !this.mineClaimable(m, u)) continue;
        bestD = d;
        mine = m;
      }
    }
    if (!u.uprooted || !mine || !this.mineClaimable(mine, u)) return false;
    const site = this.entangleSite(u, mine, range);
    if (!site) return false;
    if (!this.issueRootAt(id, site[0], site[1])) return false;
    u.entanglePending = mine.id; // …and the roots go out as it plants (tickEntangleAt)
    return true;
  }

  /**
   * Is this mine one a tree may go and take? "Free" is three things, and only the first is
   * ours to read off the mine: it is not already wrapped (or claimed by a request still in
   * flight — `entangledBy` = -1), it is not haunted (we do not model a Haunted Gold Mine at
   * all yet, so there is nothing to ask), and nobody ELSE is working it.
   *
   * That last one is not a rule of the ABILITY — Entangle itself is happy to wrap a mine an
   * enemy peasant is walking out of, and knocking that peasant's economy over is a legitimate
   * thing to do. It is a rule of the RIGHT-CLICK: an order that silently sends your town hall
   * across the map into somebody's base is not what the click meant. So it is asked here, on
   * the smart order, and not in `entangleMine`, which the button still goes through.
   */
  private mineClaimable(mine: SimMine, forUnit: SimUnit): boolean {
    if (mine.entangledBy !== 0) return false;
    for (const o of this.units.values()) {
      if (o.hp <= 0 || !o.worker || o.owner === forUnit.owner || this.allied(o, forUnit)) continue;
      if ((o.inMine && o.inMineId === mine.id) || (o.resKind === "gold" && o.resId === mine.id)) return false;
    }
    return true;
  }

  /**
   * Where to plant a tree that has been sent to entangle `mine`: the spot NEAREST THE TREE on
   * which its rooted footprint fits and from which Entangle can still reach the mine.
   *
   * Nearest the tree, not nearest the mine, and that is the whole rule. The only thing that
   * has to be true of the site is that the ability can be cast from it — `Rng1` = 500, plus
   * the mine's own radius, measured exactly as `entangleMine` measures it — so a tree already
   * standing inside that range has nowhere to go and roots where it is. Walking a tree that
   * could already cast up to the rock would be the order overriding the ability's own range.
   *
   * The candidates are still swept as rings around the MINE, because what is being placed is
   * a BUILDING: the answer has to be a whole free 12×12 on the build grid, and around a mine
   * there are usually only a handful of those (the rock blocks the middle). Every ring out to
   * the ability's reach is swept and the closest survivor to the tree wins, so it also lands
   * on the side it approached from.
   */
  private entangleSite(u: SimUnit, mine: SimMine, range: number): [number, number] | null {
    const fp = u.rootedStamp;
    if (!this.grid || !fp) return null;
    const grid = this.grid;
    const half = (Math.max(fp.w, fp.h) * PATHING_CELL) / 2;
    const fits = (wx: number, wy: number): [number, number] | null => {
      const [sx, sy] = grid.snapForBuildingRect(wx, wy, fp.w, fp.h);
      if (Math.hypot(sx - mine.x, sy - mine.y) - mine.radius > range) return null;
      return footprintBuildable(grid, fp, sx, sy) ? [sx, sy] : null;
    };
    // Where it already stands, first and without a search: in range and on ground it fits on
    // is the answer, and it is the common one — a tree walked to an expansion by hand is
    // standing at the mine by the time anybody presses the button.
    const here = fits(u.x, u.y);
    if (here) return here;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    const seen = new Set<string>();
    // Rings from "as close as the footprint can physically sit" out to the ability's reach,
    // one build cell at a time, with enough samples per ring that a 12×12 candidate cannot
    // slip between spokes.
    for (let r = mine.radius + half; r <= range + mine.radius; r += BUILD_CELL) {
      const steps = Math.max(8, Math.round((2 * Math.PI * r) / BUILD_CELL));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const [px, py] = [mine.x + Math.cos(a) * r, mine.y + Math.sin(a) * r];
        const [sx, sy] = grid.snapForBuildingRect(px, py, fp.w, fp.h);
        const key = `${sx},${sy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const d = Math.hypot(sx - u.x, sy - u.y);
        if (d >= bestD || !fits(px, py)) continue;
        bestD = d;
        best = [sx, sy];
      }
    }
    return best;
  }

  /** An uprooted Tree of Life sent to take a mine has begun to plant itself: throw the roots.
   *
   *  No cast, and nothing waited for. `Cast1` = 3s is the gesture a tree makes when a player
   *  presses the button at a mine it is already standing at; there is no second gesture on the
   *  end of the errand, and the root transition is not one either — the mine starts closing on
   *  the same tick the tree starts lowering itself onto its site. So this goes straight to
   *  `entangleMine` rather than through `issueCast`, which is also what lets it name the mine
   *  the player actually clicked instead of re-deriving "the nearest one".
   *
   *  `toggleRoot` flips the stance before the transition (see SimUnit.morphT), so by the time
   *  this runs on the planting tick the tree is a building again and `entangleMine` will have
   *  it. Dropped if the plant never happened (the way was blocked, or the ground was taken
   *  while it walked) or somebody else got the mine first — the race for an expansion, in one
   *  line. */
  private tickEntangleAt(u: SimUnit): void {
    const mine = this.mines.get(u.entanglePending);
    if (!mine || mine.entangledBy !== 0) {
      u.entanglePending = 0;
      return;
    }
    if (u.uprooted) {
      if (!u.rootPending && !u.moving) u.entanglePending = 0; // the plant fell through
      return;
    }
    u.entanglePending = 0;
    const ab = u.abilities.find((a) => a.code === "Aent" && a.level >= 1);
    const def = ab && this.abilities?.get(ab.id);
    if (def) this.entangleMine(u, def, mine);
  }

  /** The renderer has raised the Entangled Gold Mine and hands the sim its unit id. Links the
   *  three parties: the crew inside the building knows which mine it is emptying, and the
   *  building knows whose roots are holding it up (see SimUnit.entangler). */
  attachEntangled(unitId: number, mineId: number, casterId = 0): void {
    const u = this.units.get(unitId);
    const mine = this.mines.get(mineId);
    if (!u || !mine) return;
    u.mineId = mineId;
    u.entangler = casterId;
    mine.entangledBy = unitId;
    // Nothing builds this one. `egol` costs no gold, no lumber and no Wisp — the Tree's roots
    // are what raises it — so its 60 seconds of `bldtm` run on their own, with no worker to
    // stand next to it and none that could be sent (there is no Build order that makes one).
    if (u.building) u.building.selfBuilds = true;
  }

  /**
   * Let go of any gold mine this unit's roots are holding — an Ancient pulling itself out of
   * the ground (toggleRoot). The mine becomes a plain gold mine again and the crew is turned
   * OUT rather than buried: `unloadBurrow` puts the Wisps back on the field, and the building
   * leaves the way a cancelled one does (no death, no corpse, no kill credit for anybody).
   *
   * The renderer notices the `egol` record is gone and un-hides the gold mine underneath it,
   * exactly as it does when an entangled mine runs dry (see raiseEntangledMines).
   */
  private releaseEntangledMine(u: SimUnit): void {
    for (const o of [...this.units.values()]) {
      if (o.entangler !== u.id) continue;
      this.unloadBurrow(o.id);
      this.removeUnit(o.id);
    }
    // …including one still in flight: a request whose model has not landed yet has already
    // claimed its mine (`entangledBy = -1`), and dropping the request without releasing that
    // claim would leave a mine nobody could ever entangle again.
    this.entangleRequests = this.entangleRequests.filter((r) => {
      if (r.casterId !== u.id) return true;
      const m = this.mines.get(r.mineId);
      if (m && m.entangledBy === -1) m.entangledBy = 0;
      return false;
    });
  }

  drainEntangleRequests(): EntangleRequest[] {
    if (!this.entangleRequests.length) return this.entangleRequests;
    const out = this.entangleRequests;
    this.entangleRequests = [];
    return out;
  }

  /**
   * The crew arrangement a building standing on a gold mine runs, or null.
   *
   * TWO races replace the round trip with a building and a crew, and their two rows say the
   * same three things in the same columns — so one reader serves both and the difference is
   * only WHERE the crew stands:
   *
   *     `Aegm` Entangled Gold Mine   DataA 10 gold  DataB 1s  crew INSIDE  (`Aenc` Car1 = 5)
   *     `Abgm` Blighted Gold mine    DataA 10 gold  DataB 1s  DataC 5      DataD 200 ring
   *
   * Ten gold a second at a full crew, both of them, which is one worker's two gold a second —
   * exactly a Peasant's 10-per-trip round trip, and the reason neither race is simply richer.
   * What each buys with it is different: a Wisp is SAFE and stuck (it is inside a building
   * with 800 hit points), an Acolyte is exposed and free (it kneels in the open and can be
   * pulled off to summon something without losing its place in a queue).
   *
   * `ring` is 0 for the entangled mine — the crew has nowhere to stand, it is cargo.
   */
  private mineCrewOf(u: SimUnit): { gold: number; interval: number; max: number; ring: number } | null {
    // Read off the TYPE's own `abilList` and the registry row, not off `SimUnit.abilities` —
    // the same route blightPaintOf takes, and for the same reason: these are structural
    // properties of a building rather than buttons, and nothing should have to add them to
    // KNOWN_ABILITIES for the mine to pay out.
    const list = this.unitReg?.get(u.typeId)?.abilities ?? [];
    if (list.includes("Abgm")) {
      const lvl = this.abilities?.get("Abgm")?.levelData[0] ?? emptyAbilityLevel();
      return {
        gold: this.dataOf(lvl, 0, 10), // DataA "Gold per Interval"
        interval: this.dataOf(lvl, 1, 1) || 1, // DataB "Interval Duration"
        max: Math.max(1, Math.round(this.dataOf(lvl, 2, 5))), // DataC "Max Number of Miners"
        ring: this.dataOf(lvl, 3, 200) || 200, // DataD "Radius of Mining Ring"
      };
    }
    if (list.includes("Aegm") && u.garrisonCap > 0) {
      const lvl = this.abilities?.get("Aegm")?.levelData[0] ?? emptyAbilityLevel();
      return { gold: this.dataOf(lvl, 0, 10), interval: this.dataOf(lvl, 1, 1) || 1, max: u.garrisonCap, ring: 0 };
    }
    return null;
  }

  /** The finished building standing over this mine that a WORKER may work — a Haunted Gold
   *  Mine with a mining ring. Null for a bare mine, for one still rising, and for an
   *  Entangled Gold Mine (whose crew climbs INSIDE it instead — issueGarrison). */
  hauntedMine(mineId: number): SimUnit | null {
    const id = this.mines.get(mineId)?.entangledBy ?? 0;
    if (id <= 0) return null;
    const u = this.units.get(id);
    if (!u || u.hp <= 0 || (u.building && u.building.constructionLeft > 0)) return null;
    return this.mineCrewOf(u)?.ring ? u : null;
  }

  /**
   * Where the `slot`-th miner of `n` kneels around a Haunted Gold Mine.
   *
   * Slots are 1-based and fixed, so an Acolyte pulled off and sent back takes the first FREE
   * spot rather than shuffling everyone along — and the first one sits due south, where
   * `bj_UNIT_FACING` (270°) puts everything else the game places.
   *
   * `Abgm`'s 200 is a radius from the mine's CENTRE, and a gold mine is a 16×16-cell building
   * — so on the sides where its footprint reaches past 200 the station lands inside solid
   * ground. The fix is to walk OUT along the slot's own ray until the ground is walkable,
   * rather than to the nearest free cell in any direction: pushed radially the ring keeps its
   * shape and its slots stay distinct, where a nearest-cell search would collapse two
   * neighbours onto the same doorstep.
   */
  private ringStation(mine: SimUnit, slot: number, n: number, radius: number): [number, number] {
    const a = -Math.PI / 2 + ((slot - 1) / n) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    for (let r = radius; r <= radius + RING_PUSH; r += PATHING_CELL) {
      const x = mine.x + dx * r, y = mine.y + dy * r;
      const [cx, cy] = this.grid.worldToCell(x, y);
      if (this.grid.walkable(cx, cy)) return [x, y];
    }
    return [mine.x + dx * radius, mine.y + dy * radius];
  }

  /** Where each of a Haunted Gold Mine's miners kneels — the same stations tickRingHarvest
   *  walks them to. The renderer draws WC3's ground mark on every one of them
   *  (MapViewerScene.collectMineCircles), so the marks and the Acolytes are placed by one
   *  answer rather than two that have to agree. Empty for anything that is not a ring mine. */
  mineRingStations(mineUnit: SimUnit): Array<[number, number]> {
    const rules = this.mineCrewOf(mineUnit);
    if (!rules?.ring) return [];
    const out: Array<[number, number]> = [];
    for (let i = 1; i <= rules.max; i++) out.push(this.ringStation(mineUnit, i, rules.max, rules.ring));
    return out;
  }

  /**
   * A free ring slot for this worker — the NEAREST one, or 0 when the ring is full ([Errors]
   * `Blightringfull` = "That gold mine can't support any more Acolytes.").
   *
   * Nearest rather than lowest-numbered, and that is not cosmetic. Acolytes arrive at a mine
   * as a clump from one side (the melee opening literally spawns three of them together), and
   * handing out slots in index order sends some of them round the far side of a 16×16-cell
   * building, through the two who have already sat down. They wedge, and the ring never
   * fills. Taking the near side keeps each one on the arc it walked up to, which is also what
   * the original looks like.
   */
  private freeRingSlot(mineUnit: SimUnit, max: number, worker: SimUnit, radius: number): number {
    const taken = new Set<number>();
    for (const o of this.units.values()) {
      if (o.id === worker.id || o.hp <= 0 || !o.ringSlot) continue;
      if (this.mines.get(o.resId)?.entangledBy === mineUnit.id) taken.add(o.ringSlot);
    }
    let best = 0;
    let bestD = Infinity;
    for (let i = 1; i <= max; i++) {
      if (taken.has(i)) continue;
      const [sx, sy] = this.ringStation(mineUnit, i, max, radius);
      const d = (sx - worker.x) ** 2 + (sy - worker.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** How many workers are actually kneeling at this mine right now. */
  private ringCrew(mineUnit: SimUnit): number {
    let n = 0;
    for (const o of this.units.values()) {
      if (o.hp <= 0 || !o.ringSlot || !o.working) continue;
      if (this.mines.get(o.resId)?.entangledBy === mineUnit.id) n++;
    }
    return n;
  }

  /**
   * One tick of an Acolyte working a Haunted Gold Mine: claim a station, walk to it, kneel.
   *
   * This is the whole of Undead gold, and what is NOT here is the point — no shaft, no load,
   * no depot, no queue at the entrance. The Acolyte simply stands in the ring and the
   * building pays while it does. The consequences are the ones players plan around: gold
   * arrives continuously rather than in 10-gold lumps, a fifth Acolyte is worth exactly as
   * much as the first, and the whole crew is standing in the open where a raid can reach it.
   *
   * The slot is claimed at ARRIVAL, not at the order, for the same reason a wisp's tree is
   * (see tickHarvest): five Acolytes sent at one mine in the same breath must not all believe
   * they hold slot 1, and one that is walking is not yet working.
   */
  private tickRingHarvest(u: SimUnit, mine: SimUnit): void {
    const rules = this.mineCrewOf(mine);
    if (!rules?.ring) return;
    if (!u.ringSlot) {
      // Walk up to the RING, and only then take a mark — so the arrival is tested against the
      // RING, which is the thing being walked to. It used to be tested against the mark the
      // Acolyte hoped to take, and the walk is not aimed there and never can be: pathToNode
      // sends a gold worker to `mineStandSpot`, the rim point facing it. While the near marks
      // were free the two agreed by luck (the nearest mark is a stride to one side of where
      // the approach lands), but the moment they were taken the nearest FREE one was across
      // the mine, ~350 away — a distance the walk was never going to close, so the test said
      // "not there yet" forever. The Acolyte ground against the crew already kneeling, held
      // `moving` (which is what stops arriveAtNode from ever re-pathing), and simply stood
      // there. Two of a crew of five never sat down, and Undead gold came in at half rate.
      //
      // Measured from the mine's CENTRE: `Abgm`'s DataD is a radius from there, and the rim
      // the approach aims at (mine footprint + a block + half a cell) is comfortably inside
      // it, so the test is one the walk can actually satisfy from any side.
      //
      // …and a late Acolyte cannot always TOUCH the ring, because the crew already kneeling
      // STANDS on it. Five sent at once walk up from one side, three sit down, and the last
      // two are left leaning on a picket of their own colleagues with no way through to the
      // rim. They have arrived all the same — they are at the mine, and the mark they are
      // about to take is one they are PLACED on rather than walk to (see below), so nothing
      // downstream needs them to have got any closer. `blockedT` is the mover's own "I am up
      // against a body and not getting past" clock; half a repath cycle of it is a queue, not
      // a stride, and the mover zeroes it at a full cycle so half is what can be observed.
      const walled = u.blockedT >= BLOCKED_REPATH_TIME / 2;
      if (!this.arriveAtNode(u, mine.x, mine.y, u.radius + rules.ring, () => this.pathToNode(u)) && !walled) {
        u.working = false;
        return;
      }
      // Claimed at ARRIVAL, not at the order (see the note above) — and re-asked here rather
      // than reusing `want`, because the walk took time and the mark that was nearest when it
      // set out may have been taken, or a nearer one freed, while it was on its way.
      const slot = this.freeRingSlot(mine, rules.max, u, rules.ring);
      if (!slot) {
        // "That gold mine can't support any more Acolytes." — the ring is full, so this one
        // has no business here. Stopping (rather than queueing at the rim, as a classic mine
        // makes a worker do) is the honest answer: there is no queue, and a body parked
        // against the ring would just crowd the crew.
        this.stop(u.id);
        return;
      }
      u.ringSlot = slot;
    }
    const [sx, sy] = this.ringStation(mine, u.ringSlot, rules.max, rules.ring);
    // STEP ONTO THE MARK, do not walk round to it. The station was chosen at arrival and it
    // is the NEAREST free one (freeRingSlot), so it is a stride away on the arc the Acolyte
    // walked up on — but a second walk leg aimed at it goes through the building's own
    // 16×16-cell footprint, so the pathfinder took it the long way round the mine and past
    // whoever was already kneeling. It is placed instead, which is also what the marks
    // demand: WC3 paints a rune circle on every slot
    // (`Abilities\Spells\Undead\UndeadMine\UndeadMineCircle.mdx`, see
    // MapViewerScene.collectMineCircles) and an Acolyte kneels ON its mark, not beside it.
    // The station is walkable by construction (ringStation pushes out along its own ray until
    // it is), and this happens once: from here on the worker is already there.
    if (u.x !== sx || u.y !== sy) {
      this.unsettle(u);
      u.x = sx;
      u.y = sy;
      this.settle(u, false); // snap=false: the station IS the spot, not the nearest grid cell
      u.atNode = true;
      u.nodeRetries = 0;
    }
    u.working = true;
    u.moving = false;
    u.path = [];
    u.desiredFacing = Math.atan2(mine.y - u.y, mine.x - u.x); // kneeling toward the mine
  }

  /** Give up a mining-ring station. Called from every path a worker leaves a job by, so a
   *  slot can never be held by a body that has walked away (the shape of bug the classic
   *  mine's `busy` latch cost us once — see popFromMine). */
  private popFromRing(u: SimUnit): void {
    if (!u.ringSlot) return;
    u.ringSlot = 0;
    u.working = false;
  }

  /** Pay out every mine with a crew — wisps inside, Acolytes around — and collapse one that
   *  runs dry. */
  private tickMineCrews(dt: number): void {
    for (const u of this.units.values()) {
      if (!u.mineId || u.hp <= 0 || (u.building && u.building.constructionLeft > 0)) continue;
      const mine = this.mines.get(u.mineId);
      if (!mine) continue;
      const rules = this.mineCrewOf(u);
      if (!rules) continue;
      const crew = rules.ring ? this.ringCrew(u) : u.garrison.length;
      // An empty mine simply stops paying; its clock is left where it is rather than reset, so
      // marching wisps in and out cannot buy a fresh payout on every entry.
      if (crew <= 0) continue;
      // The clock runs on the BUILDING (`workT` is free on a structure), so a crew that
      // changes mid-interval simply changes what the next payout is worth.
      u.workT -= dt;
      if (u.workT > 0) continue;
      u.workT += rules.interval;
      const gold = Math.min(mine.gold, Math.round(rules.gold * (Math.min(crew, rules.max) / rules.max)));
      mine.gold -= gold;
      this.stashOf(u.owner).gold += gold;
      // Paid where the gold is dug — the crewed mine IS the drop-off for both races that work
      // one, so the "+N" belongs on it and not on some hall the money never travels to.
      this.floatCredit("gold", gold, u.owner, u);
      if (mine.gold <= 0) {
        this.mines.delete(mine.id);
        this.depleted.push(mine);
        this.alerts.push({ kind: "minedestroyed", player: u.owner, x: mine.x, y: mine.y });
        // Nothing left to hold, or to haunt. WC3 collapses the building with the mine — the
        // crew is turned out (unloadBurrow / the ring is dropped below) rather than buried,
        // and the building goes the way a cancelled one does: no death, no corpse, no kill
        // credit. For the Undead that IS the documented behaviour rather than an analogy:
        // "Acolytes automatically Unsummon Haunted Gold mines after they are empty"
        // (classic.battle.net/war3/undead/units/acolyte.shtml).
        this.unloadBurrow(u.id);
        this.removeUnit(u.id);
      } else if (mine.gold < MISC_DATA.LowGoldAmount && !this.minesRunningLow.has(mine.id)) {
        this.minesRunningLow.add(mine.id);
        this.alerts.push({ kind: "minelow", player: u.owner, x: mine.x, y: mine.y });
      }
    }
  }

  /** Stop a worker constructing/repairing (manual order, or death). Called by
   *  every re-task path, so it also cancels a repair job. */
  private detachBuilder(workerId: number): void {
    const w = this.units.get(workerId);
    if (!w) return;
    w.repair = null; // re-tasking cancels a repair
    if (!w.constructing) return;
    const bu = this.units.get(w.constructing);
    if (bu?.building) bu.building.builderIds = bu.building.builderIds.filter((id) => id !== workerId);
    // Orc peon leaving the site it built from inside — pop it out to the doorstep.
    if (w.insideBuild && bu) this.emergeBuilder(w, bu);
    else w.insideBuild = false;
    w.constructing = 0;
  }

  /** Order a worker to repair a damaged friendly building. Params (rate + cost
   *  per HP) are computed by the caller from the building's build cost/time. */
  issueRepair(id: number, buildingId: number, hpPerSec: number, goldPerHp: number, lumberPerHp: number): boolean {
    const u = this.units.get(id);
    const b = this.units.get(buildingId);
    if (!u || !u.worker || !b?.building || b.building.constructionLeft > 0 || b.hp >= b.maxHp) return false;
    if (this.hasLiquidFire(b)) return false; // Liquid Fire prevents repair while it burns
    if (this.castLocked(u)) return false;
    this.detachBuilder(id); // clears any prior repair/build first
    u.order = "repair";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.waitT = 0; // a fresh order is never still parked on the old one
    u.repair = { targetId: buildingId, hpPerSec, goldPerHp, lumberPerHp, active: false };
    this.pathTo(u, b.x, b.y);
    return true;
  }

  /** Advance a worker's repair: walk to the building, then restore HP over time
   *  while spending the owner's gold/lumber; stop at full or when out of funds. */
  private tickRepair(u: SimUnit, dt: number): void {
    const r = u.repair;
    if (!r) {
      this.stop(u.id);
      return;
    }
    const b = this.units.get(r.targetId);
    if (!b?.building || b.hp >= b.maxHp) {
      this.stop(u.id); // repaired to full, or the building is gone
      return;
    }
    if (u.moving && this.siteGap(u, b) > 96) {
      r.active = false; // still walking to the site
      return;
    }
    this.settle(u);
    r.active = true;
    u.desiredFacing = Math.atan2(b.y - u.y, b.x - u.x);
    const stash = this.stashOf(u.owner);
    const hpAdd = r.hpPerSec * dt;
    if (stash.gold < hpAdd * r.goldPerHp || stash.lumber < hpAdd * r.lumberPerHp) {
      this.stop(u.id); // out of resources
      return;
    }
    stash.gold -= hpAdd * r.goldPerHp;
    stash.lumber -= hpAdd * r.lumberPerHp;
    b.hp = Math.min(b.maxHp, b.hp + hpAdd);
    if (b.hp >= b.maxHp) this.stop(u.id);
  }

  /** Advance construction and training queues for all buildings. */
  private tickBuildings(dt: number): void {
    for (const u of this.units.values()) {
      const b = u.building;
      if (!b) continue;
      // An UPROOTED Ancient is not a building right now: it trains nothing and researches
      // nothing while it walks. The queue is left exactly as it stands rather than refunded —
      // this is a pause, and planting again resumes it where it stopped.
      if (u.uprooted) continue;
      if (b.constructionLeft > 0) {
        // Debug cheat: finish in ~1s no matter what (no builder required).
        if (this.fastBuild) {
          b.constructionLeft = Math.max(0, b.constructionLeft - Math.max(dt, b.buildTimeTotal * dt));
          u.hp = u.maxHp * (0.1 + 0.9 * (1 - b.constructionLeft / b.buildTimeTotal));
          if (b.constructionLeft === 0) this.finishConstruction(u, b);
          continue;
        }
        // Nobody is hammering this one and nobody needs to (selfBuilds): an Entangled Gold
        // Mine is held up by the Tree's roots, and every Undead structure was SUMMONED and
        // then left to rise on its own. Either way the clock runs unattended.
        if (b.selfBuilds) {
          b.constructionLeft = Math.max(0, b.constructionLeft - dt);
          u.hp = u.maxHp * (0.1 + 0.9 * (1 - b.constructionLeft / b.buildTimeTotal));
          if (b.constructionLeft === 0) this.finishConstruction(u, b);
          continue;
        }
        // Only advance while a builder is assigned AND standing next to the site
        // (WC3: construction halts if the worker wanders off). Progress resumes
        // when a worker is re-tasked to build/repair it. Drop any builder that
        // died or was re-tasked away, then count who is actually hammering.
        b.builderIds = b.builderIds.filter((id) => this.units.get(id)?.constructing === u.id);
        let present = 0;
        for (const id of b.builderIds) {
          const builder = this.units.get(id)!;
          // Orc peon that has walked up to the site now vanishes inside to build
          // (hidden). Once inside it sits at the centre, so it reads as "present".
          if (buildsFromInside(builder) && !builder.insideBuild && !builder.moving && this.siteGap(builder, u) < 96) {
            this.enterBuildSite(builder, u);
          }
          const nearby = !builder.moving && this.siteGap(builder, u) < 96;
          if (nearby) {
            if (!builder.insideBuild) builder.desiredFacing = Math.atan2(u.y - builder.y, u.x - builder.x); // face the site while hammering
            present++;
          }
        }
        if (present > 0) {
          // Extra builders past the first speed the build but burn extra
          // resources (HUMAN only — speedBuilds()). If the owner can't pay this
          // tick's surcharge, drop back toward the base rate (only as many extras
          // as they can afford).
          let extra = speedBuilds(u) ? present - 1 : 0;
          if (extra > 0) {
            const stash = this.stashOf(u.owner);
            while (extra > 0) {
              const rate = 1 + extra * SPEED_BUILD_BONUS;
              const frac = extra * SPEED_BUILD_SURCHARGE * ((rate * dt) / b.buildTimeTotal);
              const g = frac * b.goldCost;
              const l = frac * b.lumberCost;
              if (stash.gold >= g && stash.lumber >= l) {
                stash.gold -= g;
                stash.lumber -= l;
                break;
              }
              extra--;
            }
          }
          const rate = 1 + extra * SPEED_BUILD_BONUS;
          b.constructionLeft = Math.max(0, b.constructionLeft - rate * dt);
          const done = 1 - b.constructionLeft / b.buildTimeTotal;
          u.hp = u.maxHp * (0.1 + 0.9 * done);
          if (b.constructionLeft === 0) this.finishConstruction(u, b);
        }
        continue; // can't train while still being built
      }
      const job = b.queue[0];
      if (job) {
        // Debug cheat compresses any train time to ~1 second.
        job.timeLeft -= this.fastBuild ? Math.max(dt, job.buildTime * dt) : dt;
        if (job.timeLeft <= 0) {
          b.queue.shift();
          if (job.kind === "research") {
            this.tech?.setResearchLevel(u.owner, job.unitId, job.level);
            this.researchCompletions.push({ buildingId: u.id, upgradeId: job.unitId, level: job.level, owner: u.owner });
            this.applyUnitSwap(u.owner, job.unitId); // rtma: morph existing units (Headhunter→Berserker)
          } else if (job.kind === "upgrade") {
            this.morphUnit(u, job.unitId);
          } else if (job.kind === "revive") {
            const f = this.fallen.get(job.heroId);
            if (f) this.completeRevive(u, b, f, job.buyer);
          } else {
            this.completeTrain(u, b, job.unitId, job.buyer);
          }
        }
      }
    }
  }

  /** A structure's last tick of construction: let its builders go, then announce it.
   *
   *  "Let go" is not the same thing for every race, and the night elf is where it stops being
   *  a detail. A Wisp grows an Ancient by MERGING with it, and the merge is the payment: the
   *  Wisp is spent and the Ancient stands there alone. Grown into a Moon Well it is not spent
   *  and simply steps back out, which is why night elf food maths works at all. See
   *  buildsFromInside for the category (UnitBalance's own `type` = "Ancient") and why it is
   *  read off the data rather than off a list of building ids.
   *
   *  Consumed, not KILLED: removeUnit is JASS's RemoveUnit — no corpse, no death sound, no
   *  XP for anyone. A merged Wisp does not die, it stops existing, and a death here would
   *  hand a nearby enemy hero experience for a building you just finished. */
  private finishConstruction(u: SimUnit, b: BuildingState): void {
    for (const bid of [...b.builderIds]) {
      const w = this.units.get(bid);
      if (u.ancient && w?.insideBuild) {
        w.insideBuild = false; // it is not coming out — don't let detachBuilder place a body
        this.detachBuilder(bid);
        this.removeUnit(bid);
        continue;
      }
      this.detachBuilder(bid);
    }
    // The building's mana arrives WITH the building. `mana0` is what it opens with and it is
    // not the pool — a finished Moon Well holds 100 of its 300 and fills the rest overnight.
    // Set before recomputeStats runs again, which is what puts the bar back (see there).
    const start = this.unitReg?.get(u.typeId)?.manaStart ?? 0;
    if (start > 0) u.mana = Math.min(start, u.baseMaxMana);
    this.buildCompletions.push({ buildingId: u.id, owner: u.owner });
    this.noteConstruct(u.id, "finish"); // EVENT_(PLAYER_)UNIT_CONSTRUCT_FINISH
  }

  /** Transform a finished building into its upgraded form in place (Town Hall → Keep, Scout
   *  Tower → Guard Tower). WC3 keeps the SAME entity — its rally point, its queue and its
   *  damage all carry over — so this rewrites the type and re-derives the stats rather than
   *  destroying and respawning, which would flash the selection and drop the rally.
   *
   *  HP carries over as a FRACTION: a Town Hall at half health becomes a half-health Keep,
   *  not a Keep with 750/2000. The renderer picks the swap up from `morphs` and re-attaches
   *  the new model. */
  private morphUnit(u: SimUnit, toTypeId: string): void {
    const def = this.unitReg?.get(toTypeId);
    if (!def) return;
    const frac = u.maxHp > 0 ? Math.min(1, u.hp / u.maxHp) : 1;
    const from = u.typeId;
    u.typeId = toTypeId;
    u.baseMaxHp = def.hitPoints;
    // The MANA pool is the new type's too. Every stock morph pair happens to share one —
    // Druid of the Claw 200/200, Druid of the Talon 200/200, Spirit Walker 300/300
    // (UnitBalance.slk `manaN`), which is why nothing in a normal game ever showed this
    // missing — but the pool has to follow the type all the same, or a unit morphed into a
    // caster stands there with 0/0 and can never cast. (What DOES differ across a stock pair
    // is `regenMana`: the bear's 0.333 against the caster form's 0.666 is Bear Form's whole
    // downside, and that already follows the type through recomputeStats.)
    u.baseMaxMana = def.mana;
    u.baseArmor = def.armor;
    u.armorType = def.armorType;
    u.baseSightDay = def.sightDay;
    u.baseSightNight = def.sightNight;
    u.baseSpeed = def.speed;
    // Cast point / backswing are the unit's half of every spell's timeline (see tickCast:
    // wind-up = u.castPoint + the ability's own Casting Time), and they are NOT the same in
    // both forms — UnitWeapons.slk gives the Druid of the Claw 0.5/1.17 and his bear 0.3/0.51,
    // the Druid of the Talon 0.7/1.97 against the storm crow's 0.3/0.51. Leaving them behind
    // makes a morphed caster wind up on the wrong form's clock.
    u.castPoint = def.castPoint;
    u.castBackswing = def.castBackswing;
    // Rebuild the type-derived combat kit: a Headhunter→Berserker gains the Berserk ability
    // and the Berserker's stronger throw; a building keeps its (usually empty) kit. Preserve
    // any current cast/order by leaving order state alone — only the type's innate loadout swaps.
    u.weapons = weaponsFromDef(def);
    u.weapon = u.weapons.find((w) => w.enabled) ?? null;
    // The unit-level damage baseline rides along with the slot it came from: Inner Fire reads
    // `baseDamage` off its target (spells.ts) to size its bonus, so a bear buffed while still
    // wearing the caster form's 18 would get a Druid's Inner Fire, not a bear's.
    u.baseDamage = u.weapon?.baseDamage ?? 0;
    // A hero's LEARNED ranks survive the swap. Both halves of a hero morph carry the same
    // `heroAbilList` — `Edem` and `Edmm` are both `AEmb,AEim,AEev,AEme` — and rebuilding them
    // from the type reset every one to level 0, which took the Demon Hunter's entire spellbook
    // off his command card the instant he metamorphosed, Metamorphosis itself included (an
    // ability at level 0 draws no button). Cooldowns and autocast settings ride along for the
    // same reason: they belong to the hero, not to the body he is currently wearing. An
    // ability the NEW form introduces (Robo-Goblin's `ANde` Demolish) still arrives at the
    // level its own list gives it.
    const kept = new Map(u.abilities.map((a) => [a.id, a]));
    u.abilities = this.buildAbilitiesFor(def).map((a) => {
      const was = kept.get(a.id);
      return was ? { ...a, level: Math.max(a.level, was.level), cooldownLeft: was.cooldownLeft, autocastOn: was.autocastOn } : a;
    });
    // What it produces is a property of the TYPE, so re-derive it: a structure that only gains
    // a training list on upgrade would otherwise never get a rally point.
    if (u.building && this.techReg) u.building.producesUnits = this.techReg.producesUnits(toTypeId);
    // maxHp/maxMana now reflect the new type (+ any research already in). Both POOLS moving is
    // an ordinary ceiling move, so the current values ride it by RATIO — the one rule stated in
    // recomputeStats and cited there to Liquipedia (Hit_Points): a bear at half life comes back
    // a Druid at half life, and a Spirit Walker keeps its share of mana through the swap. No
    // stock pair actually differs in `manaN`, so that ratio is the identity for every real
    // morph; a pair that gains a pool from nothing (0 → N) starts the new one empty, because a
    // share of nothing is nothing.
    this.recomputeStats(u);
    u.hp = Math.max(1, u.maxHp * frac);
    this.tech?.invalidate(); // a Keep satisfies requirements a Town Hall does not
    this.morphs.push({ unitId: u.id, from, to: toTypeId });
  }

  /**
   * TRANSMUTE (`ANtm`), the paying half — the Alchemist's ultimate is the one spell whose
   * whole effect is a transaction, and this is the side of it that needs the world: what the
   * victim is worth, whose purse it lands in, and the number that floats up off the body.
   *
   * What it is worth is its own `goldcost` / `lumbercost` (UnitBalance.slk) scaled by the
   * ability's factors, rounded to the gold piece. 125% is not only what `Ntm1` says, it is
   * the arithmetic behind every number players quote for it — a Footman (135) pays 169, a
   * Rifleman (205) 256, a Knight (245) 306 — which is the check that the column is a gold
   * factor at all, the World Editor's names for these fields living in strings the install
   * does not ship.
   *
   * The text floats over the VICTIM, not the caster: it is the body turning into the money,
   * and that is where the player is looking. It also stays where the body was rather than
   * following anything, because a moment later there is nothing left to follow — the same
   * reason a deny's "!" is placed and not attached (see CombatText).
   */
  private transmuteInternal(target: SimUnit, caster: SimUnit, goldFactor: number, lumberFactor: number): number {
    const def = this.unitReg?.get(target.typeId);
    const gold = Math.max(0, Math.round((def?.goldCost ?? 0) * goldFactor));
    const lumber = Math.max(0, Math.round((def?.lumberCost ?? 0) * lumberFactor));
    const stash = this.stashOf(caster.owner);
    stash.gold += gold;
    stash.lumber += lumber;
    this.floatCredit("gold", gold, caster.owner, target);
    this.floatCredit("lumber", lumber, caster.owner, target);
    this.kill(target, caster.id);
    return gold;
  }

  /**
   * The generic FORM TOGGLE behind every two-form ability in the game: Burrow, Bear Form,
   * Crow Form, Stone Form, Destroyer Form, Ethereal Form, Submerge. They are one mechanism
   * wearing different art, and the ability row says so — AbilityMetaData names the columns
   * the same way for all of them:
   *
   *   DataA   "Normal Form Unit"     `[Abur] = ucry`  the Crypt Fiend
   *   UnitID1 "Alternate Form Unit"  `[Abur] = ucrm`  the burrowed Crypt Fiend
   *
   * So a form is not a state to model — it is a UNIT, and morphing to it is the whole
   * implementation. Everything the burrowed Crypt Fiend does differently is already written
   * down in `ucrm`: spd "-" (it cannot move), weapsOn 0 (it cannot attack), regenHP 5 against
   * the walking form's 2 (the reason to burrow at all), and an abilList that drops Web but
   * keeps Burrow so it can dig out again. Not one of those needed a line of code here.
   *
   * Which direction to go is read off the unit rather than tracked: a unit standing in its
   * alternate form goes back to normal, anything else goes alternate. That also means the
   * pair can be entered from either side, which matters because several of these units are
   * TRAINED in their alternate form (the Spirit Walker arrives ethereal).
   */
  morphToggle(u: SimUnit, def: AbilityDef, rank = 1, byTimer = false): boolean {
    const lvl = def.levelData[Math.min(Math.max(1, rank), def.levelData.length) - 1];
    const normal = lvl?.dataStr[0] ?? ""; // DataA "Normal Form Unit" — the same for all of them
    const alternate = altFormOf(lvl);
    if (!normal || !alternate) return false;
    // Which direction to go is "am I standing in ANY of this ability's alternate forms?", not
    // "am I standing in THIS rank's". Chemical Rage is the row that makes the difference: it
    // names a different ogre per rank (`UnitID1` = Nalm / Nal2 / Nal3, each with the attack
    // cooldown its level's tooltip quotes), so a rank-3 Alchemist raging is a `Nal3` and the
    // revert — which runs at the ability's own rank but must work from whichever body it
    // finds — would otherwise read "not Nalm, so morph FORWARD" and turn an ogre into a
    // smaller ogre instead of back into the Alchemist.
    const inAlt = def.levelData.some((l) => altFormOf(l) === u.typeId);
    // …and going BACK is only a thing for an ability that has an off-switch. `Unorder` is it,
    // and it splits the family cleanly: `unburrow`, `unrobogoblin`, `unstoneform`,
    // `unravenform`, `unetherealform`, `unsubmerge` and `militiaoff` are seven abilities you
    // press a second time to end, while the two TIMED HERO FORMS — `[ANcr]` Chemical Rage and
    // `[AEme]` Metamorphosis — carry no Unorder, no Unart and no Untip at all. One order, one
    // icon: the duration is the only way out of them, which is the whole reason they are worth
    // a hero's mana.
    //
    // The real game never has to answer this, because it cannot be asked: Chemical Rage's 30s
    // cooldown outlives its 15s form and Metamorphosis' 180 outlives its 45, so the button is
    // never live while the hero is still in the form. Anything that shortens the cooldown makes
    // it askable — the debug panel's Reset Cooldown, an item, a map's own cooldown — and the
    // answer this gave was to UN-rage the Alchemist. That reads as "the ability did nothing",
    // and it leaves every OTHER press working, which is exactly how it was reported.
    //
    // The CLOCK is the exception, and it has to be: a timed form's duration is its only way
    // out, so `byTimer` (tickAltForm) always goes back. Without that carve-out an expiring
    // Chemical Rage re-entered the form instead of leaving it — rank 3's ogre ran out and
    // became rank 1's, with a fresh 15 seconds, for ever.
    const to = inAlt && (byTimer || def.unOrder) ? normal : alternate;
    if (!this.unitReg?.get(to)) return false; // this install doesn't ship the other form
    // Re-casting a form the unit is ALREADY wearing is not a morph, it is a re-arming: the
    // clock below goes back to full and nothing else about the body changes. Skipped rather
    // than run as a from===to morph so the renderer isn't asked to re-skin a unit into itself.
    if (to !== u.typeId) this.morphUnit(u, to);
    // Both forms share one MDX (ucrm is CryptFiend.mdx too), so the alternate FORM also wears
    // the alternate half of the model — the burrowed pose is "Stand Alternate", reached
    // through the same Morph clip an Ancient uses. See SimUnit.altModel.
    u.altModel = to === alternate;
    // A TIMED form runs itself out and reverts; an untimed one is a toggle the player turns
    // off. Which is which is **HeroDur**, not Dur, and the whole morph family agrees:
    //   Amil (Militia)      Dur 40   HeroDur 40   → 40 seconds, then back to a Peasant
    //   ANcr (Chem. Rage)   Dur 0.35 HeroDur 15   → 15 seconds of ogre
    //   AEme (Metamorph.)   Dur 1.5  HeroDur 45   → 45 seconds of demon
    //   Abur (Burrow)       Dur 1.45 HeroDur 0    → until you dig out
    //   ANrg (Robo-Goblin)  Dur 1.5  HeroDur 0    → until you press it again
    //   Aetf/Astn/Arav/Asb1 Dur <1   HeroDur 0    → same
    // On a morph row `Dur` is the TRANSITION (the sub-two-second shuffle between models);
    // HeroDur is how long the FORM lasts. Reading Dur — which is what this did — gave every
    // toggle a one-and-a-half-second clock, so a burrowed Crypt Fiend popped straight back
    // out and Robo-Goblin reverted before the animation finished.
    u.altFormLeft = to === alternate ? lvl?.heroDuration ?? 0 : 0;
    u.altFormAbil = to === alternate ? def.id : "";
    // …and `Dur` is the TRANSITION, so it is also the LOCK. A unit changing shape is neither
    // thing while it does it — a Crypt Fiend halfway into the ground is not burrowed and not
    // standing — and the models author the pair of clips that say so (applyFormAnims holds
    // the Morph clip for its own length). Without the lock the sim's half was instantaneous:
    // Burrow flipped the type on the tick it was pressed and Unburrow was live in the same
    // frame, so the two could be alternated faster than either animation could play and the
    // Crypt Fiend twitched in place.
    //
    // Set the same way the Ancient's root transition sets it (`SimUnit.morphT`), which buys
    // the whole behaviour: `castLocked` refuses new orders for the duration, `recomputeStats`
    // zeroes the speed, and the button answers a press with the silent refusal WC3 greys out.
    //
    // MILITIA is the row that must not be read this way, and it says so itself: `[Amil]` has
    // `Dur 40` and `HeroDur 40`, the same number twice, because it spends both columns on how
    // long the form lasts and has no transition to name. Every row that DOES name one splits
    // them — Burrow 1.45/0, Robo-Goblin 1.5/0, Chemical Rage 0.35/15, Metamorphosis 1.5/45 —
    // so "the two columns disagree" is exactly "Dur is a transition". Capped, because a lock
    // is a unit standing helpless and no authored transition is anywhere near it.
    const transition = lvl && lvl.duration !== lvl.heroDuration ? Math.min(lvl.duration, MAX_MORPH_TRANSITION) : 0;
    if (transition > 0) u.morphT = transition;
    // The stats the ABILITY adds on top of whatever the alternate unit already carries.
    // DataE/DataF are NOT one meaning across the family — AbilityMetaData scopes each pair
    // to the rows that own it, so the column has to be read against the base code:
    //   `Eme5 "Alternate Form Hit Point Bonus"`  useSpecific = AEme,AEIl,AEvi   → 500
    //   `Nrg5 "Strength Bonus"` / `Nrg6 "Defense Bonus"`  useSpecific = ANrg,ANg1..3 → 5 / 1
    //   `Ncr5`/`Ncr6` (Chemical Rage) are named "(Info Panel Only)" outright — the movement
    //     and attack rate they quote are already Nalm's own numbers, so nothing to apply.
    // Read blind (DataE for everyone) this handed Robo-Goblin 5 bonus HIT POINTS instead of
    // 5 Strength and gave the Alchemist a half a hit point for his move-speed column.
    // Applied as buffs so leaving the form takes them off again with the rest of the morph.
    u.buffs = u.buffs.filter((b) => b.group !== "altform");
    if (to === alternate) {
      if (def.code === "AEme") {
        const bonusHp = this.dataOf(lvl, 4, 0);
        if (bonusHp > 0) this.applyBuffInternal(u, { kind: "maxHp", group: "altform", timeLeft: Infinity, sourceId: u.id, value: bonusHp });
      } else if (def.code === "ANrg") {
        const str = this.dataOf(lvl, 4, 0);
        const def0 = this.dataOf(lvl, 5, 0);
        if (str > 0) this.applyBuffInternal(u, { kind: "strength", group: "altform", timeLeft: Infinity, sourceId: u.id, value: str });
        if (def0 > 0) this.applyBuffInternal(u, { kind: "armor", group: "altform", timeLeft: Infinity, sourceId: u.id, value: def0 });
      }
      // …and the STATUS line. A morph is not a stat buff, but several morph rows still name a
      // buff row, and a buff row with `Buffart` is exactly what the info panel shows (see
      // RtsController.statusBuffsFor):
      //   `[ANcr] BuffID1 = BNcr` → Bufftip "Chemical Rage", Buffubertip "This unit is
      //     benefiting from Chemical Rage.  It is moving and attacking more quickly.",
      //     Buffart BTNChemicalRage.blp
      //   `[AEme] BuffID1 = BEme` → the same for Metamorphosis
      // while Robo-Goblin and Burrow leave `BuffID` empty and show nothing — which is the
      // data drawing the line for us, so nothing here needs a list. It carries the FORM's
      // clock so the icon is on screen for exactly as long as the ogre is; an untimed toggle
      // gets Infinity and is taken off by the group filter above when it is switched back.
      const row = this.buffArtOf(def, rank);
      if (row.buffId) {
        this.applyBuffInternal(u, { kind: "mark", group: "altform", timeLeft: u.altFormLeft > 0 ? u.altFormLeft : Infinity, sourceId: u.id, ...row });
      }
    }
    // A form with no weapon can neither attack nor keep a target it was swinging at, and the
    // weaponless one is also the ethereal one (weapsOn=0 is how the Spirit Walker's two forms
    // are told apart in the data — there is no "is ethereal" column).
    u.etherealForm = !u.weapon && this.isEtherealForm(u.typeId);
    if (!u.weapon) this.stop(u.id);
    this.recomputeStats(u);
    return true;
  }

  /**
   * Is this ability a FORM TOGGLE — one of the pairs morphToggle swaps between?
   *
   * Read off the row rather than listed, because the row is unambiguous: a morph names a
   * UNIT TYPE in DataA ("Normal Form Unit" — `Edem`, `Nalc`, `Ntin`, `ucry`) where every
   * other ability that uses the column puts a number in it (a summon's DataA is a count).
   * So "DataA resolves to a real unit type AND UnitID1/DataB names another" is the whole
   * test, and it is the same pair morphToggle refuses to run without.
   *
   * What it is FOR is the cast animation. Not one of the nine form-toggle rows in 1.30
   * carries an `Animnames` at all — `[AEme]`, `[ANcr]`, `[ANrg]`, `[Abur]`, `[Amil]`,
   * `[Aetf]`, `[Astn]`, `[Arav]`, `[Asb1]` are each just an icon pair and an order — and
   * that silence is the data saying a morph has no cast GESTURE: the transition between the
   * two halves of the model IS its animation ("Morph" / "Morph Alternate", authored at
   * exactly the `Dur` the row quotes — 0.33s of clip against Chemical Rage's Dur1 = 0.35).
   * Left to the ordinary fallback, `playCastAnim` reached for the caster's "Spell" clip and
   * the Alchemist threw a potion ("Attack two Spell - New") before turning into an ogre.
   */
  private isFormToggle(def: AbilityDef): boolean {
    const lvl = def.levelData[0];
    // `dataStr` is absent on hand-built defs (tests, custom rows), same caveat buffIdOf carries.
    return !!lvl?.dataStr && !!altFormOf(lvl) && !!this.unitReg?.get(lvl.dataStr[0] ?? "");
  }

  /** Run a timed alternate form down, and revert it when the clock does. Call to Arms is the
   *  only user in 1.27a: a militia gets 45 seconds and then goes back to being a Peasant
   *  wherever it stands, which is what makes calling the bell a decision rather than a free
   *  upgrade. Reverting goes through morphToggle so the return trip is the same code as the
   *  outbound one — nothing here knows a Peasant from a militia. */
  private tickAltForm(u: SimUnit, dt: number): void {
    if (u.altFormLeft <= 0) return;
    if ((u.altFormLeft -= dt) > 0) return;
    const def = this.abilities?.get(u.altFormAbil);
    if (def) this.morphToggle(u, def, 1, true); // byTimer: the clock always goes back
    else u.altFormLeft = 0; // ability gone (custom data reload) — just stop counting
  }

  /**
   * IMMOLATION (`AEim`) — the one damage aura you switch on and pay for by the second.
   *
   * `Order=immolation` / `Unorder=unimmolation` make it a toggle rather than a cast, and the
   * three Data columns (AbilityMetaData Eim1..Eim3) are the whole rule:
   *   DataA "Damage per Interval"      10/15/20   every `Dur1` = 1 second
   *   DataB "Mana Drained per Second"  7
   *   DataC "Buffer Mana Required"     10         below this it snuffs itself out
   * plus `Cost1` = 25 to light it. Deactivating is free — the Ubertip says so from both
   * sides ("Drains mana until deactivated." / "Deactivate Immolation to stop draining
   * mana."), which is why only the ON half checks affordability.
   *
   * The burn itself has to follow the Demon Hunter around, so it runs on his tick rather
   * than as a placed field (which is what the old handler made it: a stationary 12-second
   * circle wherever he happened to be standing when he pressed the button).
   */
  private toggleImmolation(u: SimUnit): void {
    const ab = u.abilities.find((a) => a.code === "AEim");
    const def = ab && this.abilities?.get(ab.id);
    if (!ab || !def) return;
    if (u.immolation) {
      this.douseImmolation(u);
      return;
    }
    const lvl = def.levelData[Math.min(ab.level || 1, def.levelData.length) - 1];
    if (!lvl || u.mana < lvl.cost) return;
    u.mana -= lvl.cost; // the activation cost; the per-second drain starts on the next tick
    u.immolation = ab.id;
    // `[BEim] Targetart = …\NightElf\Immolation\ImmolationTarget.mdl` — the flames he
    // wears. Timeless: it holds until the toggle goes off, so the buff carries no clock.
    this.applyBuffInternal(u, { kind: "mark", group: "immolation", timeLeft: Infinity, sourceId: u.id, ...this.buffArtOf(def) });
  }

  /** Put Immolation out — by the player's hand, by an empty mana bar, or by death. */
  private douseImmolation(u: SimUnit): void {
    u.immolation = "";
    u.buffs = u.buffs.filter((b) => b.group !== "immolation");
  }

  /** Burn, and pay for burning. Runs on the lit unit's own tick so the ring of fire travels
   *  with him. `[BEim] Specialart = …\Immolation\ImmolationDamage.mdl` (attach `head`) is
   *  the flare on each unit it catches. */
  private tickImmolation(u: SimUnit, dt: number): void {
    if (!u.immolation) return;
    const def = this.abilities?.get(u.immolation);
    const ab = u.abilities.find((a) => a.id === u.immolation);
    if (!def || !ab) return this.douseImmolation(u);
    const lvl = def.levelData[Math.min(ab.level || 1, def.levelData.length) - 1];
    if (!lvl) return this.douseImmolation(u);
    u.mana -= this.dataOf(lvl, 1, 7) * dt; // DataB "Mana Drained per Second"
    // DataC "Buffer Mana Required": it goes out on its own once the pool is this low, which
    // is what stops Immolation draining a Demon Hunter to zero and leaving him spell-less.
    if (u.mana <= this.dataOf(lvl, 2, 10)) {
      u.mana = Math.max(0, u.mana);
      return this.douseImmolation(u);
    }
    const interval = lvl.duration || 1;
    u.immolationTick += dt;
    if (u.immolationTick < interval) return;
    u.immolationTick -= interval;
    const dmg = this.dataOf(lvl, 0, 10);
    for (const t of this.unitsInAreaInternal(u.x, u.y, lvl.area || 160)) {
      if (t === u || t.hp <= 0 || t.invulnerable || !this.hostile(u, t) || !this.targsAdmit(t, def.targetFlags)) continue;
      this.landDamage(t, dmg, u.id, false);
      if (def.buffSpecialArt) this.spellEffects.push({ art: def.buffSpecialArt, x: t.x, y: t.y, targetId: t.id, z: 0 });
    }
  }

  /**
   * The two carried items that need a CLOCK rather than a stat (issue #130) — everything
   * else an item grants passively is derived in recomputeStats and needs nothing here.
   *
   * **Cloak of Flames** (`AIcf`, also the Shield of the Deathlord): "Engulfs the Hero in fire
   * which deals <AIcf,DataA1> damage per second to nearby enemy land units." Immolation in
   * everything but the mana — the row's columns are the same (`DataA "Damage Per Duration"`
   * 10, `Dur1` 1 the tick interval, `Area1` 160) and its `targs1` is `ground,enemy,neutral`,
   * which is where "land units" comes from. Its own Ubertip says it "does not stack with
   * Immolation", so a lit Demon Hunter's cloak stays cold.
   *
   * **Amulet of Spell Shield** (`ANss`): "Blocks a negative spell that an enemy casts on the
   * Hero once every <ANss,Cool1> seconds." The block itself is consumeSpellShield; this is
   * the regrow — and the reason the amulet is worth wearing after the first block.
   */
  private tickCarriedItems(u: SimUnit, dt: number): void {
    if (u.hp <= 0 || !u.inventory.length) return;
    const cloak = this.itemAbility(u, "AIcf");
    if (cloak && !u.immolation) {
      const interval = cloak.level.duration || 1;
      u.cloakBurnTick += dt;
      if (u.cloakBurnTick >= interval) {
        u.cloakBurnTick -= interval;
        const dmg = this.dataOf(cloak.level, 0, 10);
        for (const t of this.unitsInAreaInternal(u.x, u.y, cloak.level.area || 160)) {
          if (t === u || t.hp <= 0 || t.invulnerable || !this.hostile(u, t) || !this.targsAdmit(t, cloak.def.targetFlags)) continue;
          this.landDamage(t, dmg, u.id, false);
          if (cloak.def.buffSpecialArt) this.spellEffects.push({ art: cloak.def.buffSpecialArt, x: t.x, y: t.y, targetId: t.id, z: 0 });
        }
      }
    }
    const amulet = this.itemAbility(u, "ANss");
    if (!amulet) { u.spellShieldCooldown = 0; return; }
    if (u.spellShieldCooldown > 0) { u.spellShieldCooldown -= dt; return; }
    // Ready and unshielded → put the shield back on. Infinite, because what ends it is being
    // SPENT, not a clock (see consumeSpellShield).
    if (!u.buffs.some((b) => b.kind === "spellShield")) {
      this.applyBuffInternal(u, { kind: "spellShield", group: "spellshield", timeLeft: Infinity, sourceId: u.id, ...fx(amulet.def) });
    }
  }

  /**
   * BIG BAD VOODOO (`AOvd`) — a ritual, not a blessing. `Animnames = stand,channel` makes it
   * a channel, and that is the entire balance of the ultimate: the Shadow Hunter stands in
   * his own circle for the full `Dur1` = 30 seconds, protected by nothing (`targs1` has no
   * `self`), and the moment he moves, is stunned, or dies, every ally in `Area1` = 800 drops
   * out of invulnerability at once.
   *
   * That instant loss is why the buff is handed out on a SHORT leash and renewed here rather
   * than granted once for thirty seconds: stop renewing and it is gone within a tick, with no
   * bookkeeping to walk. Same trick the auras use (AURA_REFRESH).
   */
  private tickVoodoo(u: SimUnit, dt: number): void {
    if (u.voodooLeft <= 0) return;
    const def = this.abilities?.get(u.voodooAbil);
    // The channel's own break test: still ordered to cast, still this ability, still alive
    // and able. `order` leaves "cast" the moment the player moves him or a stun lands.
    if (!def || u.hp <= 0 || u.order !== "cast" || u.stunned) {
      u.voodooLeft = 0;
      u.voodooAbil = "";
      return;
    }
    u.voodooLeft -= dt;
    const lvl = def.levelData[0];
    for (const t of this.unitsInAreaInternal(u.x, u.y, lvl.area || 800)) {
      if (t === u || t.hp <= 0 || !this.allied(u, t) || !this.targsAdmit(t, def.targetFlags)) continue;
      this.applyBuffInternal(t, { kind: "invuln", group: "voodoo", timeLeft: VOODOO_REFRESH, sourceId: u.id, ...this.buffArtOf(def) });
    }
  }

  /**
   * EXHUME CORPSES (`Aexh`) — a Meat Wagon that makes its own supply.
   *
   * "Generates a Crypt Fiend corpse within the Meat Wagon every 15 seconds" (Liquipedia), and
   * the row states both halves: `Dur1` = 15 is the interval and `UnitID1` = `ucry` the body.
   * WITHIN the wagon, not beside it — so the corpse is born already loaded, which is also why
   * it is bounded by the hold rather than by a number of its own: a full wagon stops growing
   * and starts again the moment something is raised out of it.
   *
   * Gated on `Requires = Ruex` like any researched passive, so an un-upgraded wagon simply
   * never starts the clock. (`DataA` = 5 is left alone: the ability's own capacity field is
   * `Amtc`'s 8, the tooltip quotes no second number, and inventing a meaning for a column
   * that never visibly binds would be guessing.)
   */
  private tickExhume(u: SimUnit, dt: number): void {
    const ab = u.abilities.find((a) => a.code === "Aexh");
    if (!ab || ab.level < 1 || !this.techMeets(u.owner, ab.id)) {
      u.exhumeLeft = 0;
      return;
    }
    const def = this.abilities?.get(ab.id);
    const lvl = def?.levelData[Math.max(0, Math.min(ab.level, def.levelData.length) - 1)];
    const interval = lvl?.duration || 15;
    const body = lvl?.summon || "";
    if (!body) return;
    if (u.exhumeLeft <= 0) u.exhumeLeft = interval; // first tick after the research lands
    u.exhumeLeft -= dt;
    if (u.exhumeLeft > 0) return;
    u.exhumeLeft = interval;
    const cap = this.cargoCapacityOf(u);
    if (cap > 0 && this.heldCorpseCount(u.id) >= cap) return; // a full wagon grows nothing
    this.spawnCorpseOf(body, u.x, u.y, u.owner, u.id);
  }

  /** Is this unit type an ETHEREAL form, as opposed to merely a weaponless one? A burrowed
   *  Crypt Fiend has no weapon either and is emphatically not ethereal — it is underground,
   *  not on another plane. Only the Spirit Walker's form pair carries the ethereal rules
   *  (immune to physical, +magic taken), and its alternate form is the one unit that means
   *  it, so this stays an explicit list rather than being inferred from the empty weapon. */
  private isEtherealForm(typeId: string): boolean {
    return typeId === "ospm";
  }

  /** Spirit Walker form toggle (JASS/legacy entry point) — now just the generic morph with
   *  the Ethereal Form ability's own row supplying both ids. */
  toggleSpiritForm(u: SimUnit): void {
    const def = this.abilities?.get("Aetf");
    if (def) this.morphToggle(u, def);
  }

  /** The innate/learnable abilities a unit type carries (mirrors RtsController.
   *  buildInitialAbilities) — used when a unit morphs into another type. */
  private buildAbilitiesFor(def: UnitDef): SimAbility[] {
    const out: SimAbility[] = [];
    if (!this.abilities) return out;
    for (const id of def.abilities) {
      const a = this.abilities.get(id);
      if (a && KNOWN_ABILITIES[a.code]) out.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: def.autoAbility === id });
    }
    for (const id of def.heroAbilities) {
      const a = this.abilities.get(id);
      if (a && KNOWN_ABILITIES[a.code]) out.push({ id, code: a.code, level: 0, cooldownLeft: 0, autocastOn: false });
    }
    return out;
  }

  /** rtma unit-swap: when an upgrade completes, every existing unit of the withdrawn type
   *  (owned by that player) morphs into the enabled type in place — the Berserker Upgrade
   *  turning all of a player's Headhunters into Troll Berserkers. */
  private applyUnitSwap(owner: number, upgradeId: string): void {
    const swap = this.tech?.unitSwapForUpgrade(upgradeId);
    if (!swap || !this.tech) return;
    // Flip production: the enabled unit becomes trainable, the withdrawn one hidden. The map's
    // melee init caps the upgraded unit (SetPlayerTechMaxAllowed(otbk,0)) at start, and that
    // explicit cap outranks the rtma tech-availability — so the swap must override it here.
    this.tech.setMaxAllowed(owner, swap.to, -1);
    this.tech.setMaxAllowed(owner, swap.from, 0);
    // Morph every existing unit of the withdrawn type in place.
    for (const u of this.units.values()) {
      if (u.owner === owner && u.typeId === swap.from && u.hp > 0) this.morphUnit(u, swap.to);
    }
  }

  /**
   * Unsummon a friendly structure and pay half of it back (`Auns`, the Acolyte's fourth
   * button — see the handler in spells.ts for the row).
   *
   * The building leaves the way a CANCELLED one does — `cancelBuilding`, so no death, no
   * corpse, no kill credit for anyone, and the renderer plays the race's own cancel
   * explosion over the spot. That is not an approximation: an unsummoning is a building being
   * un-made by its owner, which is precisely what a cancel already models.
   *
   * A building still UNDER construction is not exempt. WC3 offers cancel for that case and
   * cancel refunds in full, but nothing forbids the ability, and the ratio is what decides
   * what comes back either way.
   *
   * Refuses anything that is not this player's own structure, which is the row's own
   * `targs1 = structure,player` spelled out — and a HAUNTED GOLD MINE is deliberately not
   * special-cased out of it: unsummoning an empty one is the documented behaviour
   * ("Acolytes automatically Unsummon Haunted Gold mines after they are empty").
   */
  unsummonBuilding(caster: SimUnit, target: SimUnit, ratio: number, step: number): boolean {
    if (!target.building || target.owner !== caster.owner || target.hp <= 0) return false;
    const def = this.unitReg?.get(target.typeId);
    const salvage = (cost: number): number => {
      const raw = cost * ratio;
      // "Accumulation Step" — the salvage is paid in whole units of it. With no duration on
      // the row there is nothing to trickle, so what survives of the step is the granularity.
      return step > 0 ? Math.round(raw / step) * step : Math.round(raw);
    };
    const stash = this.stashOf(target.owner);
    stash.gold += salvage(def?.goldCost ?? 0);
    stash.lumber += salvage(def?.lumberCost ?? 0);
    // A mine under a building it is losing goes back to being a plain gold mine; the renderer
    // un-hides the rock when the record disappears (raiseEntangledMines).
    if (target.mineId) {
      const mine = this.mines.get(target.mineId);
      if (mine) mine.entangledBy = 0;
      this.unloadBurrow(target.id); // …and any crew it was holding walks out
    }
    return this.cancelBuilding(target.id);
  }

  /** Cancel a building (manual cancel of an under-construction structure): free
   *  its builder and remove it WITHOUT a death animation — a cancelled building
   *  isn't destroyed in combat, it simply vanishes (the caller plays the race's
   *  cancel-explosion effect over the spot). Returns whether it was removed. */
  cancelBuilding(id: number): boolean {
    const u = this.units.get(id);
    if (!u?.building) return false;
    this.noteConstruct(u.id, "cancel"); // EVENT_(PLAYER_)UNIT_CONSTRUCT_CANCEL (before it's gone)
    for (const bid of [...u.building.builderIds]) this.detachBuilder(bid);
    this.unsettle(u); // free its reserved cells
    this.releaseClaim(u); // …and any tile it was walking onto
    this.releasePathStamp(u); // …and its footprint's collision
    this.units.delete(u.id);
    this.removals.push(u.id);
    return true;
  }

  /** Remove a unit outright — NO death, corpse, XP, or item drops (JASS RemoveUnit
   *  semantics). Frees its cells/builders and queues the render-side drop (onRemove). */
  removeUnit(id: number): boolean {
    const u = this.units.get(id);
    if (!u) return false;
    this.refundPendingBuild(u);
    this.unsettle(u);
    this.releaseClaim(u); // a unit that leaves the world takes its walking claim with it
    this.releasePathStamp(u);
    if (u.building) for (const bid of [...u.building.builderIds]) this.detachBuilder(bid);
    if (u.constructing) this.detachBuilder(u.id);
    if (u.garrison.length) this.unloadBurrow(u.id); // eject passengers before it vanishes
    if (u.garrisonHost) {
      const host = this.units.get(u.garrisonHost);
      if (host) {
        host.garrison = host.garrison.filter((id) => id !== u.id);
        this.recomputeStats(host);
      }
    }
    this.releaseEntangled(u); // an Entangled Gold Mine leaving hands the mine back
    this.units.delete(u.id);
    this.removals.push(u.id);
    this.unitDrops.delete(u.id);
    this.dismissBoundSummons(u.id);
    this.dropHeldCorpses(u.id, u.x, u.y); // …and a carrier puts its cargo down before it goes
    return true;
  }

  /** Everything BOUND to a departing summoner leaves with it (see SimUnit.summonerId). The
   *  Avatar of Vengeance is the case: its Spirits last "50 seconds or until the avatar dies",
   *  so the Avatar's own 180-second timer running out ends them too, not just its death.
   *  Collected first, then dismissed — this runs from inside removeUnit, which each dismissal
   *  re-enters. The bond is one-way and one level deep (a Spirit summons nothing), and
   *  clearing it up front means a cycle could not loop even if one were ever authored. */
  private dismissBoundSummons(summonerId: number): void {
    if (!summonerId) return;
    const bound: SimUnit[] = [];
    for (const u of this.units.values()) if (u.summonerId === summonerId) bound.push(u);
    for (const u of bound) {
      u.summonerId = 0;
      if (u.unsummonArt) this.unsummon(u);
      else this.kill(u);
    }
  }

  /** An Entangled Gold Mine is leaving the world: give the SimMine under it back, so it can be
   *  worked the ordinary way again (or entangled afresh). No-op for everything else. */
  private releaseEntangled(u: SimUnit): void {
    if (!u.mineId) return;
    const mine = this.mines.get(u.mineId);
    if (mine && mine.entangledBy === u.id) mine.entangledBy = 0;
    u.mineId = 0;
  }

  /** Kill a unit as if slain (death animation + corpse + drops — JASS KillUnit). */
  killUnit(id: number): boolean {
    const u = this.units.get(id);
    if (!u) return false;
    this.kill(u);
    return true;
  }

  /** Whether a building is still under construction (renderer/HUD cue). */
  isUnderConstruction(id: number): boolean {
    const b = this.units.get(id)?.building;
    return !!b && b.constructionLeft > 0;
  }

  add(
    unit: Omit<
      SimUnit,
      | "desiredFacing"
      | "waterborne" // derived from the type's movetype, below
      | "targClass" // …and from the type's targType, alongside it
      | "cargoSize" // …and its transported size
      | "path"
      | "waypoint"
      | "moving"
      | "order"
      | "targetId"
      | "cooldownLeft"
      | "swingLeft"
      | "swingTargetId"
      | "swingSeq"
      | "swingBroken"
      | "swingCrit"
      | "swingBash"
      | "swingSlam"
      | "chopSeq"
      | "inCombat"
      | "neutralPassive"
      | "targetKey"
      | "chaseX"
      | "chaseY"
      | "chaseHX"
      | "chaseHY"
      | "followOffX"
      | "followOffY"
      | "followLeaderId"
      | "atkOffX"
      | "atkOffY"
      | "atkOffTarget"
      | "amDestX"
      | "amDestY"
      | "patrolX"
      | "patrolY"
      | "acquireT"
      | "stuckT"
      | "stuckRetries"
      | "stallT"
      | "stallAnchorX"
      | "stallAnchorY"
      | "stallGap"
      | "gaveUp"
      | "gaveUpGap"
      | "attackStalls"
      | "attackOrdered"
      | "attackSolo"
      | "stuckAnchorX"
      | "stuckAnchorY"
      | "repathT"
      | "waitT"
      | "repollT"
      | "yieldT"
      | "prevX"
      | "prevY"
      | "velX"
      | "velY"
      | "footprint"
      | "pathStamp"
      | "resX"
      | "resY"
      | "hasReservation"
      | "claimX"
      | "claimY"
      | "hasClaim"
      | "blockedT"
      | "resKind"
      | "resId"
      | "nodeRetries"
      | "workT"
      | "inMine"
      | "insideBuild"
      | "inBurrow"
      | "garrisonHost"
      | "garrison"
      | "garrisonCap"
      | "linkGroup"
      | "linkT"
      | "linkShare"
      | "devouring"
      | "devouredBy"
      | "etherealForm"
      | "working"
      | "atNode"
      | "noCollision"
      | "building"
      | "constructing"
      | "repair"
      | "orderQueue"
      | "buildPending"
      | "isHero"
      | "properName"
      | "level"
      | "xp"
      | "skillPoints"
      | "primaryAttr"
      | "baseStr"
      | "baseAgi"
      | "baseInt"
      | "strPerLevel"
      | "agiPerLevel"
      | "intPerLevel"
      | "str"
      | "agi"
      | "int"
      | "baseMaxHp"
      | "baseMaxMana"
      | "baseArmor"
      | "baseDamage"
      | "baseSpeed"
      | "weapon"
      | "swingWeapon"
      | "manaRegen"
      | "hpRegen"
      | "lifesteal"
      | "thorns"
      | "magicReduction"
      | "rangedReduction"
      | "bonusArmor"
      | "bonusDamage"
      | "bonusStr"
      | "bonusAgi"
      | "bonusInt"
      | "attackUpgrade"
      | "armorUpgrade"
      | "abilities"
      | "buffs"
      | "stunned"
      | "paused"
      | "silenced"
      | "ethereal"
      | "webbed"
      | "magicImmune"
      | "resistant"
      | "detectRadius"
      | "uprooted"
      | "rootedFootprint"
      | "rootedStamp"
      | "altModel"
      | "altFormLeft"
      | "altFormAbil"
      | "invisible"
      | "cloaked"
      | "invulnerable"
      | "baseInvulnerable"
      | "mechanical"
      | "isPeon"
      | "ward"
      | "ancient"
      | "mineId"
      | "entangler"
      | "ringSlot"
      | "morphT"
      | "builtFacing"
      | "rootPending"
      | "entanglePending"
      | "rootSettle"
      | "garrisonJob"
      | "drinkWellId"
      | "replenishTargetId"
      | "isSummon"
      | "spawning"
      | "summonLeft"
      | "summonMax"
      | "summonerId"
      | "exhumeLeft"
      | "unsummonArt"
      | "vanished"
      | "isIllusion"
      | "illusionOf"
      | "illusionDamageDealt"
      | "illusionDamageTaken"
      | "pendingCast"
      | "arrowShot"
      | "blackArrow"
      | "doomed"
      | "immolation"
      | "immolationTick"
      | "cloakBurnTick"
      | "spellShieldCooldown"
      | "voodooLeft"
      | "voodooAbil"
      | "incinerate"
      | "isCreep"
      | "guarding"
      | "guardAuto"
      | "guardX"
      | "guardY"
      | "guardFacing"
      | "aggroRange"
      | "canSleep"
      | "asleep"
      | "returning"
      | "campHelper"
      | "campGuard"
      | "strayT"
      | "returnBestDist"
      | "returnStuckT"
      | "inventory"
      | "getItemId"
      | "pendingGive"
      | "pendingSell"
      | "pendingDrop"
      | "baseSightDay"
      | "baseSightNight"
    >,
    building?: BuildingState | null,
    opts?: { hero?: HeroInit; abilities?: SimAbility[]; mechanical?: boolean; isPeon?: boolean; ward?: boolean; ancient?: boolean; manaRegen?: number; level?: number; baseInvulnerable?: boolean },
  ): SimUnit {
    const hero = opts?.hero;
    // The primary weapon is DERIVED, never passed in: it is the first slot `weapsOn` has
    // switched on (the Chimaera's is slot 2 — its acid breath sits in slot 1, off, until
    // Corrosive Breath). recomputeStats() re-picks it whenever an upgrade rewrites the mask.
    const weapon = unit.weapons.find((w) => w.enabled) ?? null;
    const u: SimUnit = {
      ...unit,
      weapon,
      swingWeapon: null,
      // Which medium it moves through, straight off the unit's own `movetype` — see
      // SimUnit.waterborne. Derived rather than passed because it is a fact about the TYPE,
      // and every caller that spawns a unit would otherwise have to remember to look it up.
      waterborne: this.unitReg?.get(unit.typeId)?.moveType === MoveType.Float,
      // …and which class another unit's "Targets Allowed" list has to name to reach it. Same
      // reasoning as waterborne: a fact about the TYPE, so no caller has to remember it.
      targClass: this.unitReg?.get(unit.typeId)?.targType ?? "",
      cargoSize: Math.max(1, this.unitReg?.get(unit.typeId)?.cargoSize ?? 1),
      // Pre-upgrade vision baselines. recomputeStats() rebuilds the live values from these
      // every tick, so researching Forged Swords mid-game lifts every existing Footman (the
      // weapon baselines live on each SimWeapon — see SimWeapon.base*).
      baseSightDay: unit.sightDay,
      baseSightNight: unit.sightNight,
      desiredFacing: unit.facing,
      order: "idle",
      targetId: null,
      cooldownLeft: 0,
      swingLeft: -1,
      swingTargetId: 0,
      swingSeq: 0,
      swingBroken: false,
      swingCrit: false,
      swingBash: false,
      swingSlam: false,
      chopSeq: 0,
      inCombat: false,
      neutralPassive: false,
      targetKey: "",
      path: [],
      waypoint: 0,
      moving: false,
      chaseX: 0,
      chaseY: 0,
      chaseHX: 0,
      chaseHY: 0,
      followOffX: 0,
      followOffY: 0,
      followLeaderId: null,
      atkOffX: 0,
      atkOffY: 0,
      atkOffTarget: -1,
      amDestX: unit.x,
      amDestY: unit.y,
      patrolX: unit.x,
      patrolY: unit.y,
      acquireT: 0,
      stuckT: 0,
      stuckRetries: 0,
      stallT: 0,
      stallAnchorX: unit.x,
      stallAnchorY: unit.y,
      stallGap: 0,
      gaveUp: false,
      gaveUpGap: 0,
      attackStalls: 0,
      attackOrdered: false,
      attackSolo: false,
      stuckAnchorX: unit.x,
      stuckAnchorY: unit.y,
      repathT: 0,
      waitT: 0,
      // Staggered, not zero. The poll is what makes a unit re-run A* around a crowd that has
      // stopped across its route, and every unit used to start its clock at 0 — so an army
      // ordered out together polled together, and every REPATH_POLL a whole wave's worth of
      // full-map searches landed in ONE sim step. That is the periodic 100-420 ms hitch the
      // session logs show as `sim.world.move.walk` (docs/perf-logging.md). Spreading the
      // PHASE changes nothing about the poll itself and costs nothing; the id is the sim's
      // own counter, so this is identical on every client (see sim-determinism-test).
      repollT: (unit.id % REPATH_POLL_PHASES) * (REPATH_POLL / REPATH_POLL_PHASES),
      yieldT: 0,
      prevX: unit.x,
      prevY: unit.y,
      velX: 0,
      velY: 0,
      // Buildings (speed 0) block via their stamped static footprint instead.
      footprint: unit.flying || unit.speed <= 0 ? 0 : footprintCells(unit.radius),
      pathStamp: null, // set by setPathStamp once the building's footprint is on the grid
      resX: 0,
      resY: 0,
      hasReservation: false,
      claimX: 0,
      claimY: 0,
      hasClaim: false,
      blockedT: 0,
      resKind: null,
      resId: 0,
      nodeRetries: 0,
      workT: 0,
      inMine: false,
      insideBuild: false,
      inBurrow: false,
      garrisonHost: 0,
      garrison: [],
      garrisonCap: this.computeGarrisonCap(unit.typeId),
      linkGroup: [],
      linkT: 0,
      linkShare: 0,
      devouring: 0,
      devouredBy: 0,
      etherealForm: unit.typeId === "ospm", // the Spirit Walker is TRAINED in its ethereal form (ospm)
      working: false,
      atNode: false,
      noCollision: false,
      building: building ?? null,
      constructing: 0,
      repair: null,
      orderQueue: [],
      buildPending: null,
      // --- hero / abilities / buffs ---
      isHero: !!hero,
      properName: hero?.properName ?? "",
      level: hero?.level ?? opts?.level ?? 0,
      xp: hero ? xpToReachLevel(hero.level) : 0,
      skillPoints: 0, // granted by leveling (initHero sets the starting points)
      primaryAttr: hero?.primaryAttr ?? PrimaryAttribute.None,
      baseStr: hero?.str ?? 0,
      baseAgi: hero?.agi ?? 0,
      baseInt: hero?.int ?? 0,
      strPerLevel: hero?.strPerLevel ?? 0,
      agiPerLevel: hero?.agiPerLevel ?? 0,
      intPerLevel: hero?.intPerLevel ?? 0,
      str: hero?.str ?? 0,
      agi: hero?.agi ?? 0,
      int: hero?.int ?? 0,
      // Level-1 baselines — attribute growth + buffs layer on top of these.
      baseMaxHp: unit.maxHp,
      baseMaxMana: unit.maxMana,
      baseArmor: unit.armor,
      baseDamage: weapon?.baseDamage ?? 0,
      baseSpeed: unit.speed,
      manaRegen: opts?.manaRegen ?? 0, // recomputeStats derives the real value below
      hpRegen: 0,
      lifesteal: 0,
      thorns: 0,
      magicReduction: 0,
      rangedReduction: 0,
      bonusArmor: 0,
      bonusDamage: 0,
      bonusStr: 0,
      bonusAgi: 0,
      bonusInt: 0,
      attackUpgrade: 0,
      armorUpgrade: 0,
      abilities: opts?.abilities ?? [],
      buffs: [],
      stunned: false,
      paused: false,
      silenced: false,
      ethereal: false,
      webbed: false,
      magicImmune: false, // recomputeStats derives it from the unit's ability list
      resistant: false, // …and Resistant Skin beside it
      detectRadius: 0, // …and True Sight likewise
      uprooted: false, // an Ancient is built rooted (Aroo)
      rootedFootprint: 0, // set when it uproots, spent when it plants
      rootedStamp: null, //  …and the building footprint it carries with it while it walks
      altModel: false, // derived: rooted Ancients and burrowed units wear the alternate model
      altFormLeft: 0, // no timed form running
      altFormAbil: "",
      invisible: false,
      cloaked: false,
      invulnerable: !!opts?.baseInvulnerable, // recomputeStats keeps this in sync each tick
      baseInvulnerable: !!opts?.baseInvulnerable,
      mechanical: !!opts?.mechanical,
      isPeon: !!opts?.isPeon,
      ward: !!opts?.ward,
      ancient: !!opts?.ancient,
      mineId: 0, // set by entangleMine for an egol
      entangler: 0, // …and the Tree of Life that grew it (attachEntangled)
      ringSlot: 0,
      morphT: 0,
      builtFacing: unit.facing,
      rootPending: null,
      entanglePending: 0,
      rootSettle: null,
      garrisonJob: null,
      drinkWellId: 0,
      replenishTargetId: 0,
      isSummon: false,
      spawning: 0,
      summonLeft: 0,
      summonMax: 0,
      summonerId: 0,
      exhumeLeft: 0,
      unsummonArt: "",
      vanished: false,
      isIllusion: false,
      illusionOf: 0,
      illusionDamageDealt: 1,
      illusionDamageTaken: 1,
      pendingCast: null,
      arrowShot: null,
      blackArrow: null,
      doomed: null,
      immolation: "",
      immolationTick: 0,
      cloakBurnTick: 0,
      spellShieldCooldown: 0,
      voodooLeft: 0,
      voodooAbil: "",
      incinerate: null,
      // Creep guard AI is off by default; the map seeder flips isCreep on and sets
      // the guard point / aggro range / sleep flag for Neutral Hostile units.
      isCreep: false,
      guarding: false,
      guardAuto: false,
      guardX: unit.x,
      guardY: unit.y,
      guardFacing: unit.facing,
      aggroRange: 0,
      canSleep: false,
      asleep: false,
      returning: false,
      campHelper: false,
      campGuard: false,
      strayT: 0,
      returnBestDist: 0,
      returnStuckT: 0,
      // Only heroes carry an inventory in melee WC3 (6 slots). Other units get an
      // empty array (no inventory ability) so item logic simply skips them.
      inventory: hero ? [null, null, null, null, null, null] : [],
      getItemId: 0,
      pendingGive: null,
      pendingSell: null,
      pendingDrop: null,
    };
    this.units.set(u.id, u);
    this.settle(u);
    if (u.worker) this.applyHarvestData(u.worker); // rates come off the harvest ability's row
    this.tech?.invalidate(); // a new unit may unlock (or, for a shop, be) something
    this.initShopStock(u); // Arcane Vault / Goblin Merchant / Tavern: fill the shelves
    // A structure that arrives already finished (a melee start Town Hall, a map-placed
    // neutral building) was not "placed" in the sense the notification means — only a
    // fresh foundation with construction left to run shouts at the creeps around it.
    if (u.building && u.building.constructionLeft > 0) this.notifyCreepsOfPlacement(u);
    if (hero) {
      // Grant the starting skill point(s) for the hero's level and derive stats
      // (HP/mana/armour/damage/regen) from the level-1 attributes.
      u.skillPoints = hero.level;
      this.recomputeStats(u);
      u.hp = u.maxHp;
      u.mana = u.maxMana;
    } else {
      this.recomputeStats(u); // sets regen for casters and applies any base buffs
    }
    return u;
  }

  // --- cell reservation (WC3 pathing grid) ---------------------------------

  /** A unit came to rest: align it to its cell footprint and reserve the cells
   *  so other units path around it (this is what makes surrounds possible).
   *  `snap` grid-aligns the position — skipped when parking a worker at a
   *  resource so it doesn't teleport off the spot it walked to. */
  private settle(u: SimUnit, snap = true): void {
    u.moving = false;
    u.yieldT = 0; // no longer moving — drop any pending give-way pause
    u.path = [];
    // Hand the walker's claim back BEFORE the free-block tests below, or the unit would
    // find its own claim sitting on the tile it is trying to settle onto and shuffle off it.
    this.releaseClaim(u);
    if (u.footprint <= 0 || u.hasReservation) return;
    const n = u.footprint;
    let sx = u.x;
    let sy = u.y;
    if (snap) {
      const combat = u.order === "attack" || u.order === "attackmove" || u.order === "hold" || u.order === "cast";
      if (combat) {
        // Combat rest: do NOT snap the position — snapping can shove a unit up to half a
        // cell out of its strike band and cause the edge-of-range jiggle. Reserve the
        // block under where it actually stopped; if that's taken, de-conflict onto the
        // nearest free tile (a snap around allies, terrain-only line so never through a
        // wall) so blocked/waiting attackers queue instead of stacking (issue #24).
        let [ccx0, ccy0] = this.grid.footprintOrigin(u.x, u.y, n);
        if (!this.blockFree(ccx0, ccy0, n)) {
          const [ssx, ssy] = this.grid.snapForFootprint(u.x, u.y, n);
          const free = this.nearestFreeBlock(ssx, ssy, n, 6, false);
          if (free) {
            u.x = free[0];
            u.y = free[1];
            [ccx0, ccy0] = this.grid.footprintOrigin(u.x, u.y, n);
          }
        }
        this.grid.reserve(ccx0, ccy0, n);
        u.resX = ccx0;
        u.resY = ccy0;
        u.hasReservation = true;
        return;
      }
      // Non-combat rest: snap to the grid. If the tile's taken (two units the same
      // distance from one free tile), settle onto the nearest FREE tile instead of
      // stacking — a one-shot snap, deterministic (first-settled keeps the tile).
      [sx, sy] = this.grid.snapForFootprint(u.x, u.y, n);
      let [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
      if (!this.blockFree(cx0, cy0, n)) {
        const free = this.nearestFreeBlock(sx, sy, n);
        if (free) {
          [sx, sy] = free;
          [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
        }
      }
      u.x = sx;
      u.y = sy;
      this.grid.reserve(cx0, cy0, n);
      u.resX = cx0;
      u.resY = cy0;
      u.hasReservation = true;
      return;
    }
    // snap=false: reserve exactly where the unit stands (worker parked at a resource).
    const [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
    this.grid.reserve(cx0, cy0, n);
    u.resX = cx0;
    u.resY = cy0;
    u.hasReservation = true;
  }

  /** True if the n×n reservation block at origin (cx0,cy0) is entirely walkable and held
   *  by nobody — i.e. a unit can settle there without overlapping another's tile. Callers
   *  release their OWN claim first (settle/settleSpread do), so a walking unit stopping
   *  where it stands still reads its own block as free. */
  private blockFree(cx0: number, cy0: number, n: number): boolean {
    for (let y = cy0; y < cy0 + n; y++)
      for (let x = cx0; x < cx0 + n; x++)
        if (!this.grid.walkable(x, y) || this.grid.isOccupied(x, y)) return false;
    return true;
  }

  /** Nearest snap-aligned settle position (world coords) whose reservation block is
   *  free, spiralling out from the snapped (sx,sy) in whole-cell steps. Uses the SAME
   *  footprintOrigin the reservation will — so the block it validates is exactly the
   *  block that gets reserved (no even-footprint off-by-one). Bounded; null if the
   *  whole neighbourhood is packed (caller then settles in place — a rare overlap beats
   *  a teleport across the map). */
  private nearestFreeBlock(sx: number, sy: number, n: number, maxR = 6, unitsBlockLine = true): [number, number] | null {
    // The unit's own footprint — exempt from the reachability block-check so it can leave
    // the tile it's overlapping. footprintOrigin, NOT worldToCell − half: for an EVEN
    // footprint the two disagree by a cell half the time, and the exemption then covers the
    // wrong block, so a unit reads its own cells as somebody else's and refuses to move.
    const [oX0, oY0] = this.grid.footprintOrigin(sx, sy, n);
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const wx = sx + dx * PATHING_CELL;
          const wy = sy + dy * PATHING_CELL;
          const [cx0, cy0] = this.grid.footprintOrigin(wx, wy, n);
          if (!this.blockFree(cx0, cy0, n)) continue;
          // Must be REACHABLE in a straight shot — the line to it crosses no wall (and,
          // when unitsBlockLine, no other unit's tile). This stops a unit at a choke from
          // snapping ACROSS a plug into unreachable space. Held attackers de-conflicting
          // among themselves pass unitsBlockLine=false + a small radius: repositioning a
          // tile or two AROUND an ally is fine (it's a snap, not a walk), only terrain must
          // not be crossed — otherwise a packed crowd finds no free tile and stacks.
          if (this.clearLineTo(sx, sy, wx, wy, oX0, oY0, n, unitsBlockLine)) return [wx, wy];
        }
      }
    }
    return null;
  }

  /** True if the straight segment from (sx,sy) to (wx,wy) crosses only walkable,
   *  unreserved cells (cells inside the mover's own start footprint are exempt, so it
   *  can step off the tile it's overlapping). A cheap reachability proxy for the short
   *  relocation hops settle() makes — no full A*. */
  private clearLineTo(sx: number, sy: number, wx: number, wy: number, oX0: number, oY0: number, n: number, unitsBlock = true): boolean {
    const dist = Math.hypot(wx - sx, wy - sy);
    const steps = Math.max(1, Math.ceil(dist / (PATHING_CELL * 0.5)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const [cx, cy] = this.grid.worldToCell(sx + (wx - sx) * t, sy + (wy - sy) * t);
      if (!this.grid.walkable(cx, cy)) return false;
      if (!unitsBlock) continue; // terrain-only line (for a snap-around-allies de-conflict)
      const own = cx >= oX0 && cx < oX0 + n && cy >= oY0 && cy < oY0 + n;
      if (!own && this.grid.isOccupied(cx, cy)) return false;
    }
    return true;
  }

  /** Combat settle: like settle(), but treats an attacker's arrival like a move onto a
   *  distinct tile (issue #24 — "remove combat clustering; treat combat like movement").
   *  If the exact tile is contended, spread to the nearest free tile that STILL keeps us
   *  within striking range of the target — so melee units surround onto their own tiles
   *  instead of piling up, without landing past their re-chase leash (which would make
   *  them walk↔settle forever at the range edge). No free in-range tile (the surround is
   *  full) → settle in place; the slot system parked the extras further out on approach. */
  private settleSpread(u: SimUnit, t: SimUnit): void {
    this.releaseClaim(u); // stopping: the walking claim becomes a standing reservation
    if (u.hasReservation) {
      u.moving = false;
      u.yieldT = 0;
      u.path = [];
      return;
    }
    const n = u.footprint;
    if (n <= 0 || !u.weapon) {
      this.settle(u);
      return;
    }
    // Reserve the cell block under where the unit ACTUALLY stopped — do NOT snap its
    // position to the grid corner. For an even footprint that snap can shove a unit up to
    // half a cell (16 units) AWAY from the target, out of the strike band; it then
    // re-chases, reaches range, settles, gets snapped away again — the edge-of-range
    // jiggle, and it can even end up held out of range not attacking (issue #24).
    let sx = u.x;
    let sy = u.y;
    let [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
    if (!this.blockFree(cx0, cy0, n)) {
      // Our tile is taken — relocate to the nearest free tile still comfortably inside
      // the strike band (hits connect out to range + ATTACK_LEASH; cap a margin below so
      // we stay inCombat and don't re-chase). This branch DOES move us (onto that tile).
      const maxGap = (this.weaponVs(u, t) ?? u.weapon).range + ATTACK_LEASH * 0.6;
      let free = this.nearestFreeBlockInRange(u, t, n, maxGap);
      if (!free) {
        // The whole in-range ring is full. Rather than STACK in range (the "still
        // squeezing" overlap), back off to the nearest free tile just outside it — the
        // unit ends up out of range and holds/queues there for a slot to open, an outer
        // ring, exactly as WC3 does when more units than fit pile onto one target. Terrain-
        // only line + small radius: a snap around allies, never through a wall.
        const [ssx, ssy] = this.grid.snapForFootprint(sx, sy, n);
        free = this.nearestFreeBlock(ssx, ssy, n, 6, false);
      }
      if (free) {
        sx = free[0];
        sy = free[1];
        [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
      }
    }
    u.x = sx;
    u.y = sy;
    this.grid.reserve(cx0, cy0, n);
    u.resX = cx0;
    u.resY = cy0;
    u.hasReservation = true;
    u.moving = false;
    u.yieldT = 0;
    u.path = [];
  }

  /** Nearest free settle tile (snap-aligned world pos) whose block is free, reachable in
   *  a straight shot, AND within `maxGap` of the target — preferring the tile CLOSEST to
   *  the target within the nearest ring, so attackers pack into a tight surround. */
  private nearestFreeBlockInRange(u: SimUnit, t: SimUnit, n: number, maxGap: number): [number, number] | null {
    const [sx, sy] = this.grid.snapForFootprint(u.x, u.y, n);
    const [oX0, oY0] = this.grid.footprintOrigin(sx, sy, n); // our own cells — see nearestFreeBlock
    for (let r = 1; r <= 6; r++) {
      let best: [number, number] | null = null;
      let bestGap = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const wx = sx + dx * PATHING_CELL;
          const wy = sy + dy * PATHING_CELL;
          const [cx0, cy0] = this.grid.footprintOrigin(wx, wy, n);
          if (!this.blockFree(cx0, cy0, n)) continue;
          const gap = Math.hypot(wx - t.x, wy - t.y) - u.radius - t.radius;
          if (gap > maxGap) continue;
          if (!this.clearLineTo(sx, sy, wx, wy, oX0, oY0, n)) continue;
          if (gap < bestGap) {
            bestGap = gap;
            best = [wx, wy];
          }
        }
      }
      if (best) return best; // fill the nearer ring first
    }
    return null;
  }

  /** A unit is about to move: give its reserved cells back. */
  private unsettle(u: SimUnit): void {
    if (u.hasReservation) {
      this.grid.release(u.resX, u.resY, u.footprint);
      u.hasReservation = false;
    }
  }

  // --- moving-unit tile claims (issue #108) --------------------------------
  //
  // A stopped unit RESERVES its cells; a walking one CLAIMS them. The difference is who
  // reads the layer: the pathfinder routes around reservations only — WC3 units path
  // straight through a crowd that is itself on the move and sort the crossing out locally —
  // while the movement step itself honours both, so no unit ever walks THROUGH another.
  //
  // The rule the issue asks for falls out of that: a mover may only step into a cell block
  // it already holds. It takes the next block up front (a "reservation" in the issue's
  // words) and only then interpolates into it; a block it cannot take is a block it never
  // moves toward, so there is no preemptive glide followed by a shove back out.

  /** Does a unit hold cells at all? Flyers pass over everything, footprint-less movers
   *  (an uprooted Ancient) collide by radius only, and a ghosting worker walks through
   *  the crowd around its mine on purpose. */
  private claimsCells(u: SimUnit): boolean {
    return u.footprint > 0 && !u.flying && !u.noCollision && u.hp > 0 && !isOffField(u);
  }

  /** The unit stands where it stands: take the block under it, whatever else holds those
   *  cells. Only ADVANCING a claim is gated (see claimStep) — you can always own the ground
   *  you are already on, which is what lets a unit spawned on top of another walk out. */
  private ensureClaim(u: SimUnit): void {
    const n = u.footprint;
    const [cx0, cy0] = this.grid.footprintOrigin(u.x, u.y, n);
    if (u.hasClaim) {
      if (u.claimX === cx0 && u.claimY === cy0) return;
      this.grid.unclaim(u.claimX, u.claimY, n);
    }
    this.grid.claim(cx0, cy0, n);
    u.claimX = cx0;
    u.claimY = cy0;
    u.hasClaim = true;
  }

  private releaseClaim(u: SimUnit): void {
    if (!u.hasClaim) return;
    this.grid.unclaim(u.claimX, u.claimY, u.footprint);
    u.hasClaim = false;
    u.blockedT = 0;
  }

  /** May `u` take the n×n block at (cx0,cy0)? Every cell must be walkable for its domain
   *  and held by nobody else — cells inside the block it already holds are its own. */
  private blockClaimable(u: SimUnit, cx0: number, cy0: number): boolean {
    const n = u.footprint;
    const domain = pathDomain(u);
    for (let y = cy0; y < cy0 + n; y++) {
      for (let x = cx0; x < cx0 + n; x++) {
        if (!this.grid.walkable(x, y, domain)) return false;
        if (u.hasClaim && x >= u.claimX && x < u.claimX + n && y >= u.claimY && y < u.claimY + n) continue;
        if (this.grid.isOccupied(x, y)) return false;
      }
    }
    return true;
  }

  /** Move `u` to (nx,ny) if — and only if — it can hold the cell block it would then stand
   *  on. Returns false when the way is taken, in which case the unit does not budge: the
   *  whole point is that it never interpolates into a tile it cannot have. */
  private claimStep(u: SimUnit, nx: number, ny: number): boolean {
    if (!this.claimsCells(u)) {
      u.x = nx;
      u.y = ny;
      return true;
    }
    const n = u.footprint;
    const [cx0, cy0] = this.grid.footprintOrigin(nx, ny, n);
    if (u.hasClaim && cx0 === u.claimX && cy0 === u.claimY) {
      u.x = nx; // still inside the block we hold — free movement
      u.y = ny;
      return true;
    }
    if (!this.blockClaimable(u, cx0, cy0)) return false;
    if (u.hasClaim) this.grid.unclaim(u.claimX, u.claimY, n);
    this.grid.claim(cx0, cy0, n);
    u.claimX = cx0;
    u.claimY = cy0;
    u.hasClaim = true;
    u.x = nx;
    u.y = ny;
    return true;
  }

  /** Hand a building the pathTex footprint that was stamped for it, so leaving the
   *  world takes its collision with it (see releasePathStamp). Called by the spawner
   *  once the stamp is down, and by the map loader for the buildings the .doo placed. */
  setPathStamp(id: number, fp: Footprint, x: number, y: number): void {
    const u = this.units.get(id);
    if (u) u.pathStamp = { fp, x, y };
  }

  /** A building has left the world: lift its footprint off the pathing grid. In WC3
   *  the ground a structure stood on is walkable the moment it dies — the collapse you
   *  watch afterwards is only the death animation playing over open ground, which is
   *  why units walk straight through the rubble. So this runs on death, on RemoveUnit,
   *  and on a cancelled construction alike — every way a building stops existing. */
  private releasePathStamp(u: SimUnit): void {
    if (!u.pathStamp) return;
    unstampFootprint(this.grid, u.pathStamp.fp, u.pathStamp.x, u.pathStamp.y);
    u.pathStamp = null;
  }

  /** True if any live ground unit's hull overlaps a circle of `radius` at (x,y).
   *  The grid's reservations only cover *settled* units; a unit that's moving
   *  (or freshly trained and already walking to its rally) doesn't reserve cells,
   *  so grid.footprintFits() alone can't tell a spawn spot is really clear. This
   *  catches those, keeping a new unit from popping out on top of another. Flyers
   *  and buildings (footprints handled by the grid) are ignored. */
  spotOccupied(x: number, y: number, radius: number, excludeId = 0): boolean {
    for (const u of this.units.values()) {
      if (u.id === excludeId || u.flying || u.building || u.radius <= 0 || u.hp <= 0) continue;
      const rr = radius + u.radius;
      if (Math.abs(u.x - x) < rr && Math.abs(u.y - y) < rr && Math.hypot(u.x - x, u.y - y) < rr) return true;
    }
    return false;
  }

  /** Sim ids of units that died since the last drain (renderer plays deaths). */
  drainDeaths(): number[] {
    if (!this.deaths.length) return this.deaths;
    const out = this.deaths;
    this.deaths = [];
    return out;
  }

  /**
   * The STRUCTURES that died since the last drain, as whole units rather than ids
   * (docs/multiplayer.md Phase E item 6c).
   *
   * `drainDeaths` above hands out ids, and for a ghost that is one field too few. A player who
   * scouted a building and walked away must keep its last-seen image until they re-scout, so
   * the authority has to record WHERE it stood, WHAT it was and WHOSE it was — and by the time
   * anybody drains, `killUnit` has already done `this.units.delete(u.id)`, so the id resolves
   * to nothing. Same trap the trigger engine hit two lines below that delete, and it left the
   * same note: "the victim is gone from `units` next tick".
   *
   * Only buildings are pushed. That is not an optimisation, it is the rule — WC3 leaves no
   * image of a dead footman — and it keeps this list naturally tiny, since structures die a
   * handful of times a match.
   *
   * The unit object is handed over as-is rather than copied. It has just been removed from the
   * world, so nothing will mutate it again, and the one consumer (`GhostMemory`) immediately
   * reduces it to a redacted `rememberedUnit` record.
   */
  drainDeadStructures(): SimUnit[] {
    if (!this.deadStructures.length) return this.deadStructures;
    const out = this.deadStructures;
    this.deadStructures = [];
    return out;
  }

  /** Death events (victim + killer snapshots) since the last drain, for the trigger
   *  engine. Only populated when `captureDeaths` is set (a script is listening). */
  drainDeathEvents(): Array<{ victim: EventUnitInfo; killer: EventUnitInfo | null }> {
    if (!this.deathEvents.length) return this.deathEvents;
    const out = this.deathEvents;
    this.deathEvents = [];
    return out;
  }

  /** Damage events (EVENT_UNIT_DAMAGED) since the last drain — only when a script
   *  registered that event (`captureDamage`). */
  drainDamageEvents(): Array<{ target: EventUnitInfo; source: EventUnitInfo | null; amount: number }> {
    if (!this.damageEvents.length) return this.damageEvents;
    const out = this.damageEvents;
    this.damageEvents = [];
    return out;
  }

  /** Attack events (EVENT_(PLAYER_)UNIT_ATTACKED) since the last drain — only when a
   *  script registered that event (`captureAttacks`). */
  drainAttackEvents(): Array<{ attacked: EventUnitInfo; attacker: EventUnitInfo }> {
    if (!this.attackEvents.length) return this.attackEvents;
    const out = this.attackEvents;
    this.attackEvents = [];
    return out;
  }

  /** Record an ISSUED-order event (EVENT_(PLAYER_)UNIT_ISSUED_ORDER/POINT/TARGET) — only
   *  when a script is listening (`captureOrders`). Called at the EXPLICIT-order boundaries
   *  (trigger IssueXOrder + the player command router), never the internal-AI issue* calls,
   *  so auto-acquisition retargeting stays silent, matching WC3. `kind` picks the event
   *  family; `target` is the ordered unit (target orders) else null. */
  noteOrder(unitId: number, orderId: number, kind: "immediate" | "point" | "target", x: number, y: number, targetId: number): void {
    if (!this.captureOrders) return;
    const u = this.units.get(unitId);
    if (!u) return;
    const t = targetId ? this.units.get(targetId) : undefined;
    this.orderEvents.push({ unit: eventInfo(u), orderId, kind, x, y, target: t ? eventInfo(t) : null });
  }
  /** Issued-order events since the last drain — only when a script registered one
   *  (`captureOrders`). Same shape/lifecycle as the death/damage/attack drains. */
  drainOrderEvents(): Array<{ unit: EventUnitInfo; orderId: number; kind: "immediate" | "point" | "target"; x: number; y: number; target: EventUnitInfo | null }> {
    if (!this.orderEvents.length) return this.orderEvents;
    const out = this.orderEvents;
    this.orderEvents = [];
    return out;
  }

  /** Record a spell event (EVENT_(PLAYER_)UNIT_SPELL_*) — only when a script is
   *  listening (`captureSpells`). Raised from the cast timeline in tickCast. */
  private noteSpell(u: SimUnit, pc: PendingCast, phase: SpellPhase): void {
    if (!this.captureSpells) return;
    const t = pc.targetId ? this.units.get(pc.targetId) : undefined;
    this.spellEvents.push({ caster: eventInfo(u), abilityId: pc.abilityId, phase, target: t ? eventInfo(t) : null, x: pc.x, y: pc.y });
  }
  /** Spell events since the last drain (`captureSpells`). */
  drainSpellEvents(): SpellEvent[] {
    if (!this.spellEvents.length) return this.spellEvents;
    const out = this.spellEvents;
    this.spellEvents = [];
    return out;
  }

  /** Record a construction milestone (`captureConstruct`). Called where each one
   *  actually happens: the foundation laid (RtsController.addUnit with a build time),
   *  cancelBuilding, and construction reaching 0 in tickBuildings. */
  noteConstruct(unitId: number, phase: ConstructEvent["phase"]): void {
    if (!this.captureConstruct) return;
    const u = this.units.get(unitId);
    if (u) this.constructEvents.push({ structure: eventInfo(u), phase });
  }
  /** Construction events since the last drain (`captureConstruct`). */
  drainConstructEvents(): ConstructEvent[] {
    if (!this.constructEvents.length) return this.constructEvents;
    const out = this.constructEvents;
    this.constructEvents = [];
    return out;
  }

  /** Record a training milestone (`captureTrain`) — start/cancel, from the queue
   *  methods below. The FINISH is noteTrainFinish: only the engine knows the new
   *  unit (the sim owns no models, so a trained unit is born in the renderer). */
  private noteTrain(buildingId: number, unitTypeId: string, phase: TrainEvent["phase"]): void {
    if (!this.captureTrain) return;
    const b = this.units.get(buildingId);
    if (b) this.trainEvents.push({ building: eventInfo(b), unitTypeId, trained: null, phase });
  }
  /** The engine spawned a trained unit: raise EVENT_(PLAYER_)UNIT_TRAIN_FINISH with it
   *  (GetTrainedUnit). Called from the renderer's drainTrained handler, once the model
   *  is up and the sim unit exists.
   *
   *  …unless the building SOLD it. A Tavern hero, a Mercenary Camp's ogre and a Goblin
   *  Laboratory's zeppelin all ride the same queue as a barracks' footman, but WC3 does not
   *  call buying training: they raise EVENT_(PLAYER_)UNIT_SELL instead, which is a different
   *  event with a different response (GetSoldUnit, not GetTrainedUnit) and — because a shop is
   *  Neutral Passive — filed under a different player. `Sellunits` is the whole test, and it
   *  is the building's own data rather than anything about the transaction.
   *
   *  A REVIVE is neither: it comes back through this same drain, but the unit was not made
   *  here and not bought here. It keeps the training event it has always raised (WC3's own
   *  answer is EVENT_PLAYER_HERO_REVIVE_FINISH, which we don't raise yet) rather than being
   *  mistaken for a sale — else waking a fallen hero at a Tavern would look like hiring a new
   *  one, and melee's twinked-hero count would be spent on a hero that already had its scroll. */
  noteTrainFinish(buildingId: number, trainedId: number, revive = false): void {
    const b = this.units.get(buildingId);
    const t = this.units.get(trainedId);
    if (!b || !t) return;
    if (!revive && this.shopWaresOf(buildingId).units.includes(t.typeId)) {
      if (this.captureSellUnits) this.sellUnitEvents.push({ shop: eventInfo(b), sold: eventInfo(t) });
      return;
    }
    if (!this.captureTrain) return;
    this.trainEvents.push({ building: eventInfo(b), unitTypeId: t.typeId, trained: eventInfo(t), phase: "finish" });
  }

  /** Units bought from a shop since the last drain (`captureSellUnits`). */
  drainSellUnitEvents(): SellUnitEvent[] {
    if (!this.sellUnitEvents.length) return this.sellUnitEvents;
    const out = this.sellUnitEvents;
    this.sellUnitEvents = [];
    return out;
  }
  /** Training events since the last drain (`captureTrain`). */
  drainTrainEvents(): TrainEvent[] {
    if (!this.trainEvents.length) return this.trainEvents;
    const out = this.trainEvents;
    this.trainEvents = [];
    return out;
  }

  /** Hero level-up / skill-learn events since the last drain (`captureHeroEvents`). */
  drainHeroEvents(): HeroEvent[] {
    if (!this.heroEvents.length) return this.heroEvents;
    const out = this.heroEvents;
    this.heroEvents = [];
    return out;
  }

  /** Record an item manipulation (`captureItems`) — raised where the item actually moves
   *  (pickUpItem / doDropItem / transferItem / useItem), so a trigger's UnitAddItem and a
   *  hero walking over the item raise the same event, as in WC3. The item is snapshotted:
   *  a consumed powerup no longer exists by the time the event is drained. */
  private noteItem(u: SimUnit, item: { id: number; itemId: string; charges: number }, phase: ItemEvent["phase"], seller?: SimUnit): void {
    if (!this.captureItems) return;
    this.itemEvents.push({
      unit: eventInfo(u),
      item: { id: item.id, typeId: item.itemId, charges: item.charges },
      phase,
      seller: seller ? eventInfo(seller) : undefined,
    });
  }
  /** Item events since the last drain (`captureItems`). */
  drainItemEvents(): ItemEvent[] {
    if (!this.itemEvents.length) return this.itemEvents;
    const out = this.itemEvents;
    this.itemEvents = [];
    return out;
  }

  /** Record a unit climbing into a cargo hold (`captureLoads`) — EVENT_UNIT_LOADED (88) and
   *  EVENT_PLAYER_UNIT_LOADED (51). Rise of the Naga's harbour sails its ship off exactly
   *  this: `TriggerRegisterUnitEvent(gg_trg_Ships_Sails, <Illidan>, EVENT_UNIT_LOADED)`. */
  private noteLoad(passenger: SimUnit, host: SimUnit): void {
    if (!this.captureLoads) return;
    this.loadEvents.push({ unit: eventInfo(passenger), transport: eventInfo(host) });
  }
  /** Load events since the last drain (`captureLoads`). */
  drainLoadEvents(): LoadEvent[] {
    if (!this.loadEvents.length) return this.loadEvents;
    const out = this.loadEvents;
    this.loadEvents = [];
    return out;
  }

  /** Sim ids removed WITHOUT a death animation (cancelled buildings) — the
   *  renderer just hides them (an explosion effect covers the spot instead). */
  drainRemovals(): number[] {
    if (!this.removals.length) return this.removals;
    const out = this.removals;
    this.removals = [];
    return out;
  }

  /** Order a unit to a world point via the pathing grid. When no movement is
   *  possible at all (blocked in by units/terrain), the unit stays put and
   *  only turns to face the point — WC3 does exactly this.
   *
   *  `targetId` makes it a move at a THING: the unit walks up to that unit/building and
   *  stops as close to it as it can get, by the fastest route to anywhere that close. The
   *  ordered x/y is the target's centre, which is ground it can never stand on, so the
   *  ordinary point search would flood the map hunting a cell it cannot have and then take
   *  whichever explored cell was nearest the centre — possibly on the far side, reached the
   *  long way round the building. */
  issueMove(id: number, tx: number, ty: number, targetId = 0): boolean {
    const u = this.units.get(id);
    if (!u || this.castLocked(u)) return false;
    if (!this.canPursue(u)) return false; // a building goes nowhere — and must not sit on a "move" order
    const target = targetId ? this.units.get(targetId) : undefined;
    const approach = target && target.id !== id ? this.approachExtent(target) : undefined;
    this.clearGuardPost(u);
    u.order = "move";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false; // manual control restores collision
    this.cancelSwing(u);
    this.detachBuilder(id); // wandering off halts the construction
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.waitT = 0; // a fresh order is never still parked on the old one
    // Ordered essentially onto our own position: don't shuffle, just pivot.
    if (Math.hypot(tx - u.x, ty - u.y) <= MOVE_MIN_DIST) {
      this.settle(u);
      u.order = "idle";
      if (Math.hypot(tx - u.x, ty - u.y) > 1) u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
      return false;
    }
    if (!this.pathTo(u, tx, ty, undefined, false, approach)) {
      // Boxed in by bodies at this instant — a crowded rally, a group all told to go at
      // once. The order is still good; park and take it up when the way opens (issue #108).
      // Only terrain that puts the point out of reach refuses the move outright.
      this.holdOrGiveUp(u, tx, ty);
      return u.order === "move"; // parked keeps the order (accepted); stopped does not
    }
    return true;
  }

  /** Half-extents (world units) of the ground a move target actually occupies, measured
   *  from its centre — the box an approach stops OUTSIDE of. A building's is its stamped
   *  pathTex footprint, which is the real thing the pathing grid blocks and is rectangular
   *  (a barracks is not a circle); anything else uses its own hull, floored at the cell
   *  block it reserves, since that block is what nobody else may stand on. */
  private approachExtent(t: SimUnit): { hx: number; hy: number } {
    const fp = t.pathStamp?.fp;
    if (fp) {
      // The BLOCKED core, not the whole texture. A pathTex is wider than the ground it
      // makes unwalkable — the blue border around a production building is walkable spacing
      // — and stopping outside the border would park every visitor a cell short of the wall.
      // Measured as the farthest blocked edge from the stamp's centre on each axis, so a
      // core that sits off-centre in its texture is covered rather than clipped.
      let hxc = 0;
      let hyc = 0;
      for (let y = 0; y < fp.h; y++) {
        for (let x = 0; x < fp.w; x++) {
          if (!fp.blocked[y * fp.w + x]) continue;
          hxc = Math.max(hxc, fp.w / 2 - x, x + 1 - fp.w / 2);
          hyc = Math.max(hyc, fp.h / 2 - y, y + 1 - fp.h / 2);
        }
      }
      if (hxc > 0 && hyc > 0) return { hx: hxc * PATHING_CELL, hy: hyc * PATHING_CELL };
      // Nothing blocked at all (a bridge, a walkable doodad): fall through to the hull.
    }
    const r = Math.max(t.radius, (t.footprint || 1) * PATHING_CELL * 0.5);
    return { hx: r, hy: r };
  }

  /** Attack-move to a point: walk there but engage any enemies acquired en
   *  route (WC3 A-click). Behaves like a move for pathing/arrival. */
  issueAttackMove(id: number, tx: number, ty: number): boolean {
    const u = this.units.get(id);
    if (!u || this.castLocked(u)) return false;
    // A tower cannot advance on anything, so an attack-move is not an order it can hold: it
    // would stand there on an "attackmove" it can never finish. Its own auto-acquisition is
    // already the whole of what a stationary attacker does.
    if (!this.canPursue(u)) return false;
    this.clearGuardPost(u);
    u.order = "attackmove";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.waitT = 0; // a fresh order is never still parked on the old one
    u.amDestX = tx; // final destination; tickAttackMove engages enemies en route
    u.amDestY = ty;
    u.acquireT = 0; // scan on the very first tick so it fights before advancing
    this.pathTo(u, tx, ty); // best-effort initial move (re-decided each tick)
    return true;
  }

  /** Order a unit to patrol between its current position and a point (bounces
   *  back and forth; combat units acquire enemies along the way). */
  issuePatrol(id: number, tx: number, ty: number): boolean {
    const u = this.units.get(id);
    if (!u || this.castLocked(u)) return false;
    if (!this.canPursue(u)) return false; // nothing to patrol between when you cannot walk
    this.clearGuardPost(u);
    u.order = "patrol";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.waitT = 0; // a fresh order is never still parked on the old one
    u.patrolX = u.x; // the return endpoint is where the patrol was issued
    u.patrolY = u.y;
    if (!this.pathTo(u, tx, ty)) {
      this.stop(id);
      u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
      return false;
    }
    return true;
  }

  /** Hold Position: the unit plants where it stands and NEVER chases, but it still
   *  attacks any hostile that comes within its weapon range (WC3 Hold, issue #17). */
  issueHold(id: number): boolean {
    const u = this.units.get(id);
    if (!u || this.castLocked(u)) return false;
    u.order = "hold";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.waitT = 0; // a fresh order is never still parked on the old one
    u.acquireT = 0; // scan for an in-range enemy immediately
    this.settle(u); // stop any current movement and hold this cell
    return true;
  }

  /** Order a unit to attack another. Normally requires the target to be hostile;
   *  `force` (the deliberate Attack command) lets you attack allies/own units too.
   *  `ordered` marks the attack as EXPLICITLY commanded (player right-click / Attack
   *  command / trigger order) rather than picked up by the unit itself — see
   *  `attackOrdered`. Every internal re-target leaves it false on purpose. `solo` narrows
   *  that further: the order named this unit and nothing else (see `attackSolo`). */
  issueAttack(id: number, targetId: number, force = false, ordered = false, solo = false): boolean {
    const u = this.units.get(id);
    const t = this.units.get(targetId);
    if (!u || !t || u === t || !u.weapon || u.ethereal || (!force && !this.hostile(u, t))) return false; // ethereal (Banished) → weapon disabled (issue #49)
    // No weapon that may strike this target — a Footman ordered onto a Gryphon Rider. WC3
    // refuses the order outright (the cursor never turns red); the caller falls back to a
    // move, exactly as it does for any other refused attack.
    if (!this.canAttack(u, t)) return false;
    if (this.castLocked(u)) return false; // mid-wind-up: only Stop breaks a cast
    if (t.invulnerable) return false; // invulnerable units can't be attacked at all — not even with a forced Attack order (issue #26)
    // A TOWER cannot walk to what you point it at. An ordered attack on something outside its
    // weapon range is therefore not an order it can ever carry out, and WC3 refuses it on the
    // spot — commandstrings.txt [Errors] `Notinrange` = "Target is outside range.", which is
    // what the caller says out loud. Only the ORDERED form: auto-acquisition already only
    // reaches as far as `acquire`, and a tower whose acquire outruns its range (the Spirit
    // Tower's 900 against 700) should still lock on and wait for the target to close.
    if (ordered && !this.canPursue(u) && !this.inWeaponRange(u, t)) return false;
    // An ORDERED attack is a command: this unit has a job now, not a post (see clearGuardPost).
    // An AUTO-acquired one is not, which is the whole point of the leash.
    if (ordered) this.clearGuardPost(u);
    // A FRESH attack (from any non-attack state — a player command, idle auto-acquire,
    // a follower peeling off to fight) drops any pending resume-to-follow. Re-targeting
    // WITHIN an ongoing fight (reacquire after a kill, switching to a reachable enemy)
    // leaves it intact — the whole combat episode still belongs to that follow (#32).
    if (u.order !== "attack") u.followLeaderId = null;
    u.order = "attack";
    u.targetId = targetId;
    u.noCollision = false; // manual control restores collision
    u.stallT = 0; // fresh target — reset the unreachable-target watchdog (issue #24)
    u.gaveUp = false; // no longer holding — a new target may well be reachable
    u.attackStalls = 0;
    u.attackOrdered = ordered; // an automatic re-target ends the previous order's commitment
    u.attackSolo = ordered && solo; // …and so ends the "you, personally" of a solo-selected one
    u.repathT = 0; // clear any lingering hold/repath cooldown so we chase the new target
    // NOW — otherwise a freshly re-acquired enemy (e.g. after the first kill) inherited
    // the previous target's multi-second hold cooldown and the unit just stood there.
    this.cancelSwing(u); // a fresh target starts a fresh swing
    this.detachBuilder(id);
    // Claim a distinct standing slot around the target so a group swarming one
    // enemy fans out around it instead of lining up (generic: every attack order,
    // player-issued or a creep camp's, goes through here). No-op if the unit
    // already holds a slot for this target, so an already-committed attacker keeps
    // its place (no per-hit re-shuffle).
    this.setAttackSlot(u, t);
    return true;
  }

  /**
   * Why an ORDERED attack on `targetId` would be refused, as a `commandstrings.txt [Errors]`
   * key — or null if it would be taken. Only the refusal a player can do something about: a
   * tower cannot walk to what you point it at, so a target outside its weapon range answers
   * "Target is outside range." rather than silently eating the click. Mirrors castRefusal /
   * itemUseError, which is where the rest of the card's refusals come from.
   *
   * `commanded` is the Attack COMMAND (the A-click / the card's Attack button), as opposed to
   * a plain right-click. It is the only one that hears about an invulnerable target, and that
   * asymmetry is the real game's: a right-click is a SMART order, and a smart click on
   * something that cannot be attacked is simply not an attack — the cursor never turns red and
   * the units walk over. Naming the target on purpose is a different act, and the engine keeps
   * a line for exactly it.
   */
  attackRefusal(id: number, targetId: number, commanded = false): string | null {
    const u = this.units.get(id);
    const t = this.units.get(targetId);
    if (!u || !t) return null;
    // "That target is invulnerable." — `Units\CommandStrings.txt` [Errors] `Notinvulnerable`.
    // Ahead of every other gate here (and of the weapon/pursue tests below) because it is a
    // fact about the TARGET rather than about this attacker: a Footman, a tower and a Wisp all
    // get the same answer, so it never matters which member of the selection is asked. It is
    // the spoken half of issueAttack's own `t.invulnerable` refusal (issue #26) — the order was
    // already being turned down there, silently, and a click that vanishes reads as a bug.
    if (commanded && t.invulnerable) return "Notinvulnerable";
    if (!u.weapon || this.canPursue(u)) return null;
    // Nothing in the loadout may strike it at all (a ground tower pointed at a Gryphon):
    // that is a different refusal and not one this method has the line for — issueAttack
    // turns the order down on `canAttack` and the cursor never went red in the first place.
    if (!this.canAttack(u, t)) return null;
    return this.inWeaponRange(u, t) ? null : "Notinrange";
  }

  /** Can this unit walk to a fight at all? A structure (and anything else the data gives no
   *  move speed) cannot: it shoots what comes to it. Read off `baseSpeed` rather than the live
   *  `speed` so a unit merely slowed to a crawl still counts as mobile.
   *
   *  A ROOTED Ancient is the case that reads backwards, and it is why this is a method rather
   *  than a field test: it carries a walker's `baseSpeed` (it is the same unit in both stances,
   *  and the walk is what it uproots FOR), and it cannot take a single step until it does —
   *  which is why recomputeStats zeroes its live speed while it stands. While its roots are in
   *  the ground an Ancient Protector is a tower like any other, and everything hanging off this
   *  — an out-of-range attack order refused at the click, a target that walks away being let
   *  go, a right-click that is not a move — has to treat it as one. */
  private canPursue(u: SimUnit): boolean {
    return u.baseSpeed > 0 && (u.uprooted || !this.rootAbility(u));
  }

  /** Is `t` inside the weapon `u` would answer it with — hull to hull, as every range in the
   *  sim is measured. False when nothing in the loadout may strike it at all. */
  private inWeaponRange(u: SimUnit, t: SimUnit): boolean {
    const w = this.weaponVs(u, t);
    if (!w) return false;
    return Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius <= w.range;
  }

  /** Assign `u` a fan-out slot for target `t` (once per target). Melee units get a
   *  distinct ring slot around the target (assignAttackSlot); ranged units stand
   *  off at weapon range and don't surround, so they just aim at the centre. */
  private setAttackSlot(u: SimUnit, t: SimUnit): void {
    if (u.atkOffTarget === t.id) return; // already placed for this target
    if (u.weapon && !u.weapon.ranged) {
      this.assignAttackSlot(u, t);
    } else {
      u.atkOffX = 0;
      u.atkOffY = 0;
      u.atkOffTarget = t.id;
    }
  }

  /** Give `u` a distinct standing slot (offset from the target's centre) among the
   *  units already attacking the same target — the sim-side equivalent of the
   *  worker fan-out around a building/mine, but relative so it tracks a moving
   *  target. Concentric rings sized to the unit's own collision radius, filling the
   *  inner ring first; the unit takes the nearest FREE slot to where it stands (so
   *  it surrounds from its approach side with least crossing). */
  private assignAttackSlot(u: SimUnit, t: SimUnit): void {
    u.atkOffTarget = t.id;
    u.atkOffX = 0;
    u.atkOffY = 0;
    const wr = Math.max(u.radius, 16);
    const spacing = wr * 2 + 24; // neighbour gap so bodies don't overlap
    // Obstacles to route AROUND: every other unit already attacking this same target
    // — both where it stands now and the slot it's heading to — so we don't pick a
    // spot it occupies or is claiming. This is what makes a blocked unit go around
    // to a free spot instead of grinding into the one ahead of it.
    const obstacles: Array<[number, number]> = [];
    for (const o of this.units.values()) {
      if (o === u || o.atkOffTarget !== t.id || o.order !== "attack" || o.targetId !== t.id) continue;
      obstacles.push([o.x, o.y]);
      if (o.atkOffX !== 0 || o.atkOffY !== 0) obstacles.push([t.x + o.atkOffX, t.y + o.atkOffY]);
    }
    // Effective target radius: a building surrounds its footprint, a unit its hull.
    const tr = t.building ? Math.max(t.radius, (t.footprint || 2) * PATHING_CELL * 0.5) : t.radius;
    // Innermost ring sits at the unit's actual standing distance (hull gap == weapon
    // range), so a melee unit that reaches its slot is exactly in range — the slots
    // ARE the surround positions, giving a full ring of them rather than a tight
    // clump the units overshoot.
    const stand = tr + wr + Math.min(this.weaponVs(u, t)?.range ?? 0, 160);
    // Own footprint origin — exempt from the reachability line check so the unit can
    // step off the tile it's standing on.
    const [oX0, oY0] = this.grid.footprintOrigin(u.x, u.y, u.footprint);
    let best: [number, number] | null = null; // nearest slot we can actually reach
    let bestD = Infinity;
    let fallback: [number, number] | null = null; // nearest fitting slot, reachable or not
    let fallbackD = Infinity;
    for (let ring = 0; ring < 8; ring++) {
      const rr = stand + ring * spacing;
      const n = Math.max(1, Math.floor((2 * Math.PI * rr) / spacing));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.618; // golden-ish stagger between rings
        const ox = Math.cos(a) * rr;
        const oy = Math.sin(a) * rr;
        const sx = t.x + ox;
        const sy = t.y + oy;
        // Skip a slot another attacker holds or occupies.
        let taken = false;
        for (const [hx, hy] of obstacles) {
          if (Math.hypot(hx - sx, hy - sy) < spacing * 0.75) { taken = true; break; }
        }
        if (taken) continue;
        // Skip a slot our own footprint can't actually stand on (blocked terrain, a
        // building, or a cell reserved by a settled unit) — only offer slots we FIT.
        const [cx, cy] = this.grid.footprintAnchor(sx, sy, u.footprint);
        if (u.footprint > 0 && !this.grid.footprintFits(cx, cy, u.footprint)) continue;
        const d = Math.hypot(sx - u.x, sy - u.y);
        if (d < fallbackD) { fallbackD = d; fallback = [ox, oy]; }
        // A slot can FIT yet be unreachable — walled off by the ring of attackers around
        // the target, a free tile we can't get to through the other bodies (the reported
        // "picks a spot it can't reach for its size"). Require a clear straight approach —
        // no wall, no other unit's tile between us and the slot — so we head for a slot we
        // can actually stand in, letting the surround fill from the outside in.
        if (u.footprint > 0 && !this.clearLineTo(u.x, u.y, sx, sy, oX0, oY0, u.footprint)) continue;
        if (d < bestD) { bestD = d; best = [ox, oy]; }
      }
      if (best) break; // fill this ring (with a reachable slot) before stepping out
    }
    const pick = best ?? fallback;
    if (pick) { u.atkOffX = pick[0]; u.atkOffY = pick[1]; }
  }

  /** Order a unit to FOLLOW another (friendly/neutral/enemy) unit: it trails the
   *  leader at FOLLOW_GAP and does NOT auto-acquire targets on its own (WC3).
   *  offX/offY give a formation offset from the leader's centre so a group told to
   *  follow one unit fans out (0,0 = a lone follower that just trails). */
  issueFollow(id: number, targetId: number, offX = 0, offY = 0): boolean {
    const u = this.units.get(id);
    const t = this.units.get(targetId);
    if (!u || !t || u === t || u.speed <= 0 || this.castLocked(u)) return false;
    this.clearGuardPost(u);
    u.order = "follow";
    u.targetId = targetId;
    u.followOffX = offX;
    u.followOffY = offY;
    u.followLeaderId = null; // fresh follow — no fight in flight yet; tickFollow arms it
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.waitT = 0; // a fresh order is never still parked on the old one
    return true;
  }

  /** True while a cast's WIND-UP is running (the cast-point timer, after facing
   *  is done and before the effect fires). WC3 locks the caster in for it: the
   *  spell is committed to and only an explicit Stop aborts it — a move/attack/
   *  another cast issued mid-wind-up is dropped, not obeyed. Before the wind-up
   *  (walking into range, turning to face) the caster re-tasks freely, and after
   *  the effect has fired the channel/backswing cancel for free (animation
   *  canceling), so neither phase is locked. Stuns still interrupt regardless
   *  (interruptForStun). */
  private castLocked(u: SimUnit): boolean {
    // An Ancient mid-root is locked for exactly the same reason a caster mid-wind-up is: it is
    // committed to something that takes time and cannot be re-tasked out of it.
    if (u.morphT > 0) return true;
    const pc = u.pendingCast;
    return u.order === "cast" && pc !== null && pc.started && !pc.fired;
  }

  stop(id: number): void {
    const u = this.units.get(id);
    if (u) {
      u.order = "idle";
      this.clearCast(u); // the one command that aborts a locked-in wind-up (raises SPELL_ENDCAST)
      u.arrowShot = null; // …and an aimed arrow is called off with the attack that carried it
      u.targetId = null;
      u.followLeaderId = null; // an explicit stop ends any follow-and-guard episode
      u.inCombat = false;
      u.working = false;
      u.atNode = false;
      u.noCollision = false; // manual stop restores collision
      u.stallT = 0;
      u.waitT = 0; // nothing left to resume
      u.gaveUp = false;
      u.acquireT = 0; // scan for a new target on the very next idle tick (no ½s lag)
      this.cancelSwing(u);
      this.detachBuilder(id);
      u.ringSlot = 0; // an Acolyte told to stop gives up its station in the mining ring
      this.settle(u);
      // Any errand the unit was walking to finish is off: a Stop cancels a pending drop, hand-
      // over or sale as it cancels everything else.
      u.pendingSell = null;
    }
  }

  // --- shift-queued orders --------------------------------------------------

  /** Append a follow-up order to a unit's queue (WC3 shift-queue, capped at 35).
   *  It runs once the unit's current order — and any orders queued before it —
   *  finish. Does not interrupt whatever the unit is doing now. */
  queueOrder(id: number, order: QueuedOrder): void {
    const u = this.units.get(id);
    if (!u || u.orderQueue.length >= MAX_QUEUED_ORDERS) return;
    u.orderQueue.push(order);
  }

  /** Drop a unit's whole queue + any pending new-building intent. Every fresh
   *  (non-shift) order calls this so it replaces the queue instead of appending.
   *  An unstarted build's cost is refunded (the structure never went up). */
  clearQueue(id: number): void {
    const u = this.units.get(id);
    if (!u) return;
    this.refundPendingBuild(u);
    u.orderQueue.length = 0;
  }

  /** Return an abandoned build's already-spent cost and drop the intent. Called
   *  whenever a `buildPending` worker is re-tasked, stopped, dies, or times out
   *  waiting for its site to clear — i.e. any path where the building never rises.
   *  (A successful raise clears `buildPending` in assignBuilder, without refund.)
   *  An UNPAID one gets no refund, having never been charged: it is waiting at its
   *  site for gold that never came (see `payPendingBuild`). */
  private refundPendingBuild(u: SimUnit): void {
    if (!u.buildPending) return;
    if (u.buildPending.paid) {
      const s = this.stashOf(u.owner);
      s.gold += u.buildPending.gold;
      s.lumber += u.buildPending.lumber;
    }
    u.buildPending = null;
  }

  /**
   * Charge a worker's pending build, if it hasn't been charged yet. Returns whether the
   * building may now rise: true if it was already paid or the stash could cover it here,
   * false if the player still can't afford it.
   *
   * This is where a SHIFT-queued build meets its price. The click that queued it asked
   * nothing of the stash — the whole point of queueing five towers is that you are spending
   * gold you have not mined yet — so the question is asked at the site instead, while the
   * silhouette on the ground shows the answer the whole way there (red until the stash can
   * cover it, see updatePendingBuildGhosts). Asked here, at the site, it is asked for the
   * LAST time: a worker that has walked all the way to a building it cannot pay for is told
   * so and the order goes (`dropUnpaidBuilds`), the same way a site whose ground has gone is
   * told and goes. Waiting there indefinitely would be a worker doing nothing with no
   * refusal to explain it.
   */
  payPendingBuild(id: number): boolean {
    const pb = this.units.get(id)?.buildPending;
    if (!pb) return false;
    if (pb.paid) return true;
    const s = this.stashOf(this.units.get(id)!.owner);
    if (s.gold < pb.gold || s.lumber < pb.lumber) return false;
    s.gold -= pb.gold;
    s.lumber -= pb.lumber;
    pb.paid = true;
    return true;
  }

  /**
   * Abandon the build this worker is standing at because it cannot be paid for, AND every
   * unpaid build queued behind it. Returns which resource the site was short of, so the
   * caller can say which one out loud ("Not enough gold." — gold first, as WC3 reports it),
   * or null if there was nothing to drop.
   *
   * The ones behind go with it deliberately. The player queued a row of buildings against
   * gold that was going to be mined, the mining did not keep up, and a queue that cannot
   * afford its FIRST building certainly cannot afford the rest — leaving them standing would
   * be a worker walking a lap of sites it will be refused at one by one, with a refusal at
   * each. One refusal, one clearing of the queue, and the silhouettes go with the orders.
   *
   * Only UNPAID builds go: one already charged for has its money committed and is owed its
   * building. (Nothing queues paid today — a queued build is priced when its turn comes —
   * but the rule belongs with the flag rather than with today's callers.)
   */
  dropUnpaidBuilds(id: number): "gold" | "lumber" | null {
    const u = this.units.get(id);
    const pb = u?.buildPending;
    if (!u || !pb || pb.paid) return null;
    const s = this.stashOf(u.owner);
    const short = s.gold < pb.gold ? "gold" : "lumber";
    u.buildPending = null; // unpaid: nothing to refund (see refundPendingBuild)
    // It has arrived and is standing on a site it will never raise. Stop, so the tick's queue
    // pump (idle + no buildPending) takes it on to whatever else it was told to do; a Stop
    // never touches the queue itself.
    this.stop(id);
    for (let i = u.orderQueue.length - 1; i >= 0; i--) {
      const o = u.orderQueue[i];
      if (o.kind === "buildnew" && !o.paid) u.orderQueue.splice(i, 1);
    }
    return short;
  }

  /** Public entry: abandon a worker's pending build and refund it (the renderer
   *  calls this when the build site can't be cleared of units in time). */
  cancelPendingBuild(id: number): void {
    const u = this.units.get(id);
    if (u) this.refundPendingBuild(u);
  }

  /**
   * Abandon every new-building order this worker still holds — the site it is walking to
   * raise AND anything shift-queued behind it — whose ground `blocked` now refuses,
   * refunding each.
   *
   * A queued build's site is only ever checked when the player PLACES it, and by the time
   * the worker gets there the ground can have changed under it: shift-queue two buildings
   * that overlap and the second was raised straight through the first, because nothing
   * re-asked (nor need the two builds be the same player's — an ally or an enemy raising
   * something on the spot you queued does it just as well). So the sites are re-asked, and
   * an order that has become impossible is dropped rather than carried to a wrong build.
   *
   * `blocked` is the renderer's, because answering it needs the pathTex footprint the
   * renderer decodes (same split as `setFootprintReader`); the money and the queue are the
   * sim's, so the dropping happens here. Returns how many orders went, so the caller can
   * say so out loud.
   */
  dropBlockedBuilds(id: number, blocked: (defId: string, x: number, y: number) => boolean): number {
    const u = this.units.get(id);
    if (!u) return 0;
    let dropped = 0;
    if (u.buildPending && blocked(u.buildPending.defId, u.buildPending.x, u.buildPending.y)) {
      this.refundPendingBuild(u);
      // It was walking to a site that no longer exists as a site. Stop, so the shift-queue
      // advances now instead of after a pointless walk to nowhere (the tick's queue pump
      // wants `idle`); a Stop never touches the queue itself.
      this.stop(id);
      dropped++;
    }
    for (let i = u.orderQueue.length - 1; i >= 0; i--) {
      const o = u.orderQueue[i];
      if (o.kind !== "buildnew" || !blocked(o.defId, o.x, o.y)) continue;
      if (o.paid) { // an unpaid queued build never took the money, so there is none to give back
        const s = this.stashOf(u.owner);
        s.gold += o.gold;
        s.lumber += o.lumber;
      }
      u.orderQueue.splice(i, 1);
      dropped++;
    }
    return dropped;
  }

  /** Send a worker to raise a NEW building at (x,y): it walks there and the
   *  renderer raises the foundation on arrival (watches `buildPending`). Used for
   *  immediate (non-shift) placement; the shift path queues a `buildnew` order.
   *  gold/lumber are the cost; `paid` says whether it has already left the stash
   *  (and so whether abandoning the build refunds anything). An unpaid one tries to
   *  pay the moment it becomes the worker's live order — the gold drops as the worker
   *  sets off, WC3-style — and if it can't, it tries again at the site. */
  issueBuildNew(id: number, defId: string, x: number, y: number, gold: number, lumber: number, paid: boolean): void {
    const u = this.units.get(id);
    if (!u || this.castLocked(u)) return;
    // A Haunted Gold Mine is not placed on GROUND, it is placed on a MINE — so the site is
    // whatever mine the player aimed at, not the pixel they clicked.
    const mine = this.hauntTarget(defId, x, y);
    if (mine) {
      u.buildPending = { defId, x: mine.x, y: mine.y, gold, lumber, paid, mineId: mine.id };
      if (!paid) this.payPendingBuild(id);
      if (!this.issueMove(id, mine.x, mine.y)) u.moving = false;
      return;
    }
    u.buildPending = { defId, x, y, gold, lumber, paid };
    if (!paid) this.payPendingBuild(id);
    const [ax, ay] = this.buildApproach(u, defId, x, y);
    if (!this.issueMove(id, ax, ay)) u.moving = false; // already at the site → raise now
  }

  /**
   * Where a worker walks to raise a building: the near EDGE of the site, not its centre.
   *
   * A builder sent to the centre is standing inside the foundation the moment it rises, and
   * every race then deals with that differently and none of them well — the Peasant and the
   * Acolyte are shoved back out (stepOffFootprint), which reads as the worker teleporting out
   * of a building it is supposed to be laying down in front of itself. WC3 walks them up to
   * the edge and they put it down from there.
   *
   * The stand-off is the site's own half-extent plus the worker's body, so it scales with
   * what is being built: a 5×5 Farm is laid from much closer than a 12×12 Temple of the
   * Damned. The DIRECTION is wherever the worker is standing when the order is given, which
   * is the same "whichever side you came from" every other approach in the sim uses
   * (mineApproach, depotApproach). Nothing enforces the side — the pathfinder may still round
   * the site to reach the spot — and nothing needs to: stepOffFootprint stays as the backstop
   * for the case the player creates deliberately, dropping the site on top of the worker.
   */
  private buildApproach(u: SimUnit, defId: string, x: number, y: number): [number, number] {
    const half = this.buildHalfExtent(defId);
    if (half <= 0) return [x, y]; // footprint unknown (a headless sim, a map's own texture)
    const dx = u.x - x;
    const dy = u.y - y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return [x, y]; // standing on the site's own centre: there is no side to take
    const reach = half + u.radius + PATHING_CELL;
    if (d <= reach) return [u.x, u.y]; // already clear of it — don't walk backwards to a mark
    return [x + (dx / d) * reach, y + (dy / d) * reach];
  }

  /**
   * The gold mine a build order means, when the thing being built is one that stands ON a
   * mine — i.e. when its type carries `Abgm` "Blighted Gold mine". The Haunted Gold Mine is
   * the only stock building that does, and asking the ABILITY rather than the id is what makes
   * a custom map's own version work.
   *
   * Snapping to the mine is the actual UI: WC3's Haunted Gold Mine ghost jumps onto whichever
   * mine you wave it over and refuses everywhere else, because the building's job is to BE the
   * mine's entrance. A mine already carrying a building is refused ([Errors]
   * `Alreadyblightedmine` = "That gold mine is already haunted.").
   */
  hauntTarget(defId: string, x: number, y: number): SimMine | null {
    if (!this.hauntsMines(defId)) return null;
    let best: SimMine | null = null;
    let bestD = Infinity;
    for (const m of this.mines.values()) {
      if (m.entangledBy) continue;
      const d = (m.x - x) ** 2 + (m.y - y) ** 2;
      const reach = m.radius + HAUNT_SNAP;
      if (d > reach * reach || d >= bestD) continue;
      bestD = d;
      best = m;
    }
    return best;
  }

  /** Does this building type stand on a gold mine (`Abgm`)? Cached with the blight paints,
   *  which are asked of the same rows at the same moments. */
  hauntsMines(defId: string): boolean {
    return (this.unitReg?.get(defId)?.abilities ?? []).includes("Abgm");
  }

  /** Execute an order right now, replacing whatever the unit is doing and its
   *  whole queue (every fresh, non-shift order goes through here). */
  issueOrder(id: number, order: QueuedOrder): boolean {
    const u = this.units.get(id);
    // Stop is exempt: it is the one command that ABORTS a locked-in wind-up (see stop()), so
    // being refused by the lock would make it the one order that can't do its own job.
    // Everything else is ignored mid-wind-up, and ignored without dropping the queue.
    if (u && order.kind !== "stop" && this.castLocked(u)) return false;
    // A worker INSIDE a mine is put back on the field before any order replaces its
    // harvest — an order landing mid-mine (only a script can; the authority refuses
    // players' — see Authority.applyOrder) used to leave `inMine` set with nothing ever
    // clearing it, and the mine's one-worker `busy` latch wedged shut with it.
    if (u) this.popFromMine(u);
    if (u) this.popFromCanopy(u); // …and a wisp told to do something else drifts out of its tree
    if (u) this.popFromRing(u); // …and an Acolyte given anything else stands up out of its ring
    // Commanded: this unit is no longer merely holding the ground the map put it on. Placed
    // here because `issueOrder` is the funnel every fresh, non-shift order comes through —
    // a player's click, a network command, and a trigger's IssueXOrder alike.
    if (u) this.clearGuardPost(u);
    this.clearQueue(id);
    return this.dispatch(id, order);
  }

  /** The emerge branch minus the gold: put a mid-mine worker back on the field, empty-
   *  handed, on the hall-facing side, and free the mine's `busy` latch it was holding. */
  private popFromMine(u: SimUnit): void {
    if (!u.inMine) return;
    u.inMine = false;
    const mine = this.mines.get(u.inMineId ?? u.resId);
    u.inMineId = undefined;
    if (mine) {
      mine.busy = false;
      [u.x, u.y] = this.mineApproach(u, mine);
    }
  }

  /** The forest's twin of popFromMine: put a Wisp that was working a tree back on ground it
   *  can walk off, before its new order tries to path out of the canopy.
   *
   *  It has to exist because a working wisp holds no cell (`noCollision`, see tickHarvest) and
   *  a grove's footprints overlap, so the spot it stopped against one trunk can be inside a
   *  neighbour's block — and A* cannot START from a blocked cell. Without this a wisp recalled
   *  from a thick grove had its order accepted, played the walk, and never got anywhere: the
   *  symptom was a handful of wisps standing in the trees forever while the army moved. */
  private popFromCanopy(u: SimUnit): void {
    const w = u.worker;
    if (!w?.deliversInPlace || u.order !== "harvest" || !u.working) return;
    u.working = false;
    const n = Math.max(u.footprint || footprintCells(u.radius), 1);
    const [cx, cy] = this.grid.footprintAnchor(u.x, u.y, n);
    const fit = this.grid.nearestFit(cx, cy, n) ?? this.grid.nearestWalkable(cx, cy);
    if (fit) [u.x, u.y] = this.grid.footprintCenter(fit[0], fit[1], n);
  }

  /** Route a QueuedOrder to the matching issue* method. Shared by immediate
   *  orders (issueOrder) and queue replay (startNextQueued). */
  private dispatch(id: number, o: QueuedOrder): boolean {
    // Any new order lets go of a Moon Well the unit was sent to. One place, because this is
    // the one door every player/trigger order comes through; `issueDrink` sets it again a
    // line later for the order that wants it.
    const u0 = this.units.get(id);
    if (u0) {
      u0.drinkWellId = 0;
      u0.rootPending = null;
      u0.entanglePending = 0;
    }
    switch (o.kind) {
      case "move": return this.issueMove(id, o.x, o.y, o.targetId);
      case "attackmove": return this.issueAttackMove(id, o.x, o.y);
      case "patrol": return this.issuePatrol(id, o.x, o.y);
      case "hold": return this.issueHold(id);
      case "stop": this.stop(id); return true;
      case "attack": return this.issueAttack(id, o.targetId, o.force, true, o.solo); // a QueuedOrder is always a commanded attack (issue #83)
      case "follow": return this.issueFollow(id, o.targetId, o.offX, o.offY);
      case "harvest": return this.issueHarvest(id, o.res, o.nodeId, o.ax, o.ay);
      case "returnresources": return this.issueReturnResources(id);
      case "buildresume": this.assignBuilder(id, o.buildingId, o.ax, o.ay); return true;
      case "repair": return this.issueRepair(id, o.buildingId, o.hpPerSec, o.goldPerHp, o.lumberPerHp);
      case "buildnew": this.issueBuildNew(id, o.defId, o.x, o.y, o.gold, o.lumber, o.paid); return true;
      case "drink": return this.issueDrink(id, o.wellId);
      case "cast": return this.issueCast(id, o.code, o.targetId, o.x, o.y);
      case "rootat": return this.issueRootAt(id, o.x, o.y);
      case "entangleat": return this.issueEntangleAt(id, o.mineId);
    }
  }

  /**
   * Send an uprooted Ancient to plant itself at a named spot — `Aroo`'s root direction.
   *
   * WC3 does not root an Ancient where it stands. Pressing Root hands the player the same
   * thing pressing a Build button does — the finished building's silhouette riding the cursor
   * over a green/red footprint grid — and the click chooses the SITE; the Ancient then walks
   * there and settles. That is why this is an order with a destination rather than a toggle,
   * and why only the UPROOT direction is instant.
   *
   * Refused for a unit that is not an uprooted Ancient. Whether the site is any good is asked
   * twice: once at the click, so the player is told, and again on arrival by `toggleRoot`,
   * because the ground can be taken while the tree is walking to it.
   *
   * The walk is ordered for EVERY site, including the ground the Ancient is already standing
   * on. There is no "close enough, plant now" shortcut: a tree that snapped into its rooted
   * pose the moment the click landed skipped the very thing the order is — walking onto the
   * spot and settling on it — for every site within a body's width of where it stood.
   */
  issueRootAt(id: number, x: number, y: number): boolean {
    const u = this.units.get(id);
    if (!u || !u.uprooted || !this.rootAbility(u) || this.castLocked(u)) return false;
    // A site it is practically standing on has nothing to walk, and `issueMove` says so by
    // refusing it — which is not a refusal of the ORDER: the tree simply roots from here, and
    // tickRootAt does that on the next tick because it is no longer moving.
    this.issueMove(id, x, y);
    u.rootPending = { x, y };
    return true;
  }

  /** An Ancient walking to a site it was told to plant on has stopped: settle it there.
   *  Nothing happens while it is still moving. Returns whether it planted. */
  private tickRootAt(u: SimUnit): boolean {
    const site = u.rootPending;
    if (!site || u.moving || !u.uprooted) return false;
    // Stopped short — the way was blocked, or something took the ground. Drop the order
    // rather than teleport a building across the gap.
    if (Math.hypot(u.x - site.x, u.y - site.y) > u.radius + ROOT_ARRIVE_SLACK) {
      u.rootPending = null;
      return false;
    }
    u.rootPending = null;
    // The site is handed to the plant itself, which walks the last stretch onto it across the
    // root animation instead of jumping there (SimUnit.rootSettle).
    return this.toggleRoot(u, site);
  }

  /** Send a unit to drink from a Moon Well (`Ambt`) — the right-click order. It walks to the
   *  well like any move-at-a-building; the pour happens when it gets there (tickReplenish),
   *  and if the well is dry by then nothing happens, which is what walking to an empty well
   *  looks like in the game too.
   *
   *  Refused for a target that is not a battery, not friendly, or not something the ability
   *  may touch at all (`targs1` says `organic`, so a Mortar Team gets nothing from a well). */
  issueDrink(id: number, wellId: number): boolean {
    const u = this.units.get(id);
    const well = this.units.get(wellId);
    if (!u || !well || well.hp <= 0 || this.castLocked(u)) return false;
    const def = this.replenishAbility(well);
    if (!def || !this.replenishWants(well, u, def)) return false;
    if (!this.issueMove(id, well.x, well.y, wellId)) {
      // Already standing at the well — the move is a no-op, but the drink is not.
      if (u.order !== "idle") return false;
    }
    u.drinkWellId = wellId;
    return true;
  }

  /** Start the next queued order (called when a unit falls idle with a queue).
   *  A failed order (dead target, unbuildable, …) is simply dropped and the next
   *  one is tried on the following tick. */
  private startNextQueued(u: SimUnit): void {
    const o = u.orderQueue.shift();
    if (o) this.dispatch(u.id, o);
  }

  /** Put a worker to work on a GOLD MINE the way its own race works one.
   *
   *  Three races walk in and out of the shaft (issueHarvest); the night elf does not work a
   *  mine at all — it wraps it in roots and posts a crew of five wisps INSIDE the Entangled
   *  Gold Mine, where the gold simply arrives (docs/night-elf.md; `Aenc` Car1 = 5). Boarding
   *  is a garrison, not a harvest, and issueHarvest refuses an entangled mine on purpose —
   *  so anything that means "go work that mine" without knowing whose worker it holds has to
   *  come through here. A Tree of Life's rally point is exactly that caller: rallied onto its
   *  own mine it used to hand every new wisp a plain move, and they parked beside the rock. */
  issueGoldWork(id: number, mineId: number): boolean {
    const mine = this.mines.get(mineId);
    if (!mine) return false;
    // Which building stands over it decides which order "go and mine" is, and the two are
    // opposites: an ENTANGLED mine is a cargo hold (the wisp climbs INSIDE — issueGarrison),
    // a HAUNTED one is a ring (the Acolyte kneels OUTSIDE and the ordinary harvest order is
    // what puts it there — tickRingHarvest). `garrisonCap` is the question asked in the same
    // terms `mineCrewOf` reads them in: a hold, or a ring. Sending an Acolyte at a garrison
    // it can never enter is what left a rallied one standing at the rock doing nothing.
    const host = mine.entangledBy > 0 ? this.units.get(mine.entangledBy) : undefined;
    if (host && host.garrisonCap > 0) return this.issueGarrison(id, host.id);
    return this.issueHarvest(id, "gold", mineId);
  }

  /** Order a worker to harvest a mine or tree. False if it can't. `ax/ay` is an
   *  optional distinct approach point (a group ordered together fans around the
   *  node's rim rather than piling on its centre); only the FIRST walk-up uses
   *  it — later trips re-form the mine→hall line via mineApproach as before. */
  issueHarvest(id: number, kind: "gold" | "lumber", nodeId: number, ax?: number, ay?: number): boolean {
    const u = this.units.get(id);
    if (!u || !u.worker || this.castLocked(u)) return false;
    if (kind === "gold" && (!u.worker.gold || !this.mines.has(nodeId))) return false;
    if (kind === "lumber" && (!u.worker.lumber || !this.trees.has(nodeId))) return false;
    // A mine with a building over it has no shaft to walk into. Which of the two buildings it
    // is decides whether there is any other way at the gold:
    //
    //  • ENTANGLED — the roots close it, and the only way in is to BE a wisp and climb inside
    //    (issueGarrison). Refused for both sides of it: a night elf cannot classic-mine its
    //    own entangled mine, and an enemy peasant cannot mine it at all without knocking the
    //    roots down first.
    //  • HAUNTED — the ring outside is the way in, and it is open to a worker of the owning
    //    side and to nobody else ([Errors] `Notblightedmine` = "Unable to use a Haunted Gold
    //    Mine."). Every Undead worker in the game is a `Aaha` Acolyte, so no further test is
    //    needed than whose mine it is.
    if (kind === "gold" && this.mines.get(nodeId)?.entangledBy) {
      const haunt = this.hauntedMine(nodeId);
      if (!haunt || !this.allied(u, haunt)) return false;
    }
    // …and the mirror, for both races whose gold stays in the ground. A wisp has no pick:
    // night elf gold starts with Entangle (`Aent`), so a wisp sent at a bare mine is not a
    // miner, it is a wisp standing next to a hole. An Acolyte has no pick either — it has a
    // ring to kneel in, and there is no ring until the mine is haunted ([Errors]
    // `Blightminefirst` = "Must haunt gold mine first.").
    if (kind === "gold" && (u.worker.deliversInPlace || (u.worker.minesInRing && !this.hauntedMine(nodeId)))) return false;
    // ONE WISP TO A TREE. A wisp does not chop from outside, it goes IN — so an occupied tree
    // is not a queue you join, it is a seat that is taken, and WC3 sends the second wisp to a
    // neighbouring tree rather than stacking two inside one trunk. Sent at a taken tree, take
    // the nearest free one instead; with none free anywhere near, keep the order as given (the
    // arrival re-asks, and by then a seat may have opened).
    if (kind === "lumber" && u.worker.deliversInPlace && this.treeWorkedBy(nodeId, id)) {
      const t = this.trees.get(nodeId)!;
      nodeId = (this.freeTreeNear(u, t.x, t.y, RETARGET_RANGE) ?? t).id;
    }
    u.order = "harvest";
    u.targetId = null;
    u.inCombat = false;
    u.resKind = kind;
    u.resId = nodeId;
    u.atNode = false;
    u.working = false;
    u.noCollision = false; // manual harvest order restores collision
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.waitT = 0; // a fresh order is never still parked on the old one
    if (ax !== undefined && ay !== undefined) this.pathTo(u, ax, ay); // spread approach for a grouped command
    else this.pathToNode(u); // walk toward the node once; arrival latches atNode
    return true;
  }

  /** Path a harvesting worker toward its current node (once — arriveAtNode then
   *  waits for arrival instead of re-pathing, which is what caused the jitter).
   *  Gold miners approach the mine from the drop-off (town hall) side so they line
   *  up mine-centre → hall-centre like the original game, rather than entering
   *  whichever edge they happened to wander to. */
  private pathToNode(u: SimUnit): void {
    if (u.resKind === "gold") {
      const mine = this.mines.get(u.resId);
      if (!mine) return;
      // Aim at the rim point FACING the worker, not the mine's centre: the centre sits
      // inside the mine's own footprint, so the pathfinder snapped the goal to the first
      // walkable cell of its scan (always the same corner) and the worker walked around
      // the mine to enter from behind (issue #63). The near rim is the shortest path in.
      const [tx, ty] = this.mineStandSpot(u, mine, u.x - mine.x, u.y - mine.y);
      this.pathTo(u, tx, ty);
      return;
    }
    const tree = this.trees.get(u.resId);
    if (tree) this.pathTo(u, tree.x, tree.y); // a tree is one cell — walk at its trunk
  }

  /** A point on the mine's edge facing the drop-off (town hall). Workers enter the
   *  mine from whatever side they walked up to, but always EMERGE here so they exit
   *  toward the nearest hall and form the mine→hall line (WC3). */
  private mineApproach(u: SimUnit, mine: SimMine): [number, number] {
    const depot = this.nearestGoldDepot(u);
    if (!depot) return this.mineStandSpot(u, mine, u.x - mine.x, u.y - mine.y);
    return this.mineStandSpot(u, mine, depot.x - mine.x, depot.y - mine.y);
  }

  /** How far from a mine's CENTRE a worker has to stand for its own reservation block to
   *  clear the mine's footprint, along an axis. `mine.radius` is the half-width of that
   *  footprint (mapViewer sizes it off the blocked extent of `16x16Goldmine.tga`), and a
   *  stopped unit occupies an n×n block of its own — so the two half-widths add, plus half
   *  a cell so the blocks never merely touch. */
  private mineStandDist(u: SimUnit, mine: SimMine): number {
    const half = Math.max(u.radius, (Math.max(u.footprint, 1) * PATHING_CELL) / 2);
    return mine.radius + half + PATHING_CELL / 2;
  }

  /** A spot beside the mine, in direction (dirX, dirY), that the worker can actually STAND
   *  on and path off of.
   *
   *  The mine's pathing footprint is a SQUARE of half-extent `radius`, so projecting onto a
   *  CIRCLE of that radius lands INSIDE the square on every diagonal — unwalkable ground.
   *  Even on an axis it lands flush against the rim, where the worker's own 2×2 clearance
   *  can't fit and A* therefore finds no route at all. A worker that emerged there was stuck
   *  for good: every pathTo failed, so it never walked again (issue #89 — and because
   *  arriveAtNode counted "not moving" as "arrived", it kept banking gold from the rim,
   *  which is why the income hid the frozen workers).
   *
   *  So: project onto the SQUARE (Chebyshev — scale the direction until its dominant axis
   *  clears the rim), then snap onto a reservation block that is genuinely free, spiralling
   *  out past whoever is already parked there. */
  private mineStandSpot(u: SimUnit, mine: SimMine, dirX: number, dirY: number): [number, number] {
    const m = Math.max(Math.abs(dirX), Math.abs(dirY)) || 1;
    const reach = this.mineStandDist(u, mine);
    const x = mine.x + (dirX / m) * reach;
    const y = mine.y + (dirY / m) * reach;
    const n = u.footprint;
    if (n <= 0) return [x, y];
    const [sx, sy] = this.grid.snapForFootprint(x, y, n);
    const [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
    if (this.blockFree(cx0, cy0, n)) return [sx, sy];
    // Terrain-only reachability line: the workers already queued at the rim are exactly
    // what we're spiralling past, so letting THEIR tiles veto the hop would defeat it.
    return this.nearestFreeBlock(sx, sy, n, 8, false) ?? [sx, sy];
  }

  /** Nearest gold drop-off (town hall) of the worker's owner — the anchor for the
   *  mine→hall harvest line. Distinct from nearestDepot, which keys off the load. */
  private nearestGoldDepot(u: SimUnit): SimUnit | null {
    let depot: SimUnit | null = null;
    let bestD = Infinity;
    for (const d of this.units.values()) {
      if (d.owner !== u.owner || !d.depotGold) continue;
      const dist = Math.hypot(d.x - u.x, d.y - u.y);
      if (dist < bestD) {
        bestD = dist;
        depot = d;
      }
    }
    return depot;
  }

  /** Return Goods — the second face of the Gather button (`Unart=BTNReturnGoods` on every
   *  harvest row). Refused when there is nothing to carry home, which is exactly when WC3
   *  draws the button as Gather instead: the two are one button showing whichever of its two
   *  jobs is available. The worker keeps its node in `resKind`/`resId`, so tickReturn sends
   *  it straight back to the same tree or mine after it has dropped the load. */
  issueReturnResources(id: number): boolean {
    const u = this.units.get(id);
    const w = u?.worker;
    if (!u || !w || this.castLocked(u)) return false;
    if (w.carryGold <= 0 && w.carryLumber <= 0) return false;
    this.detachBuilder(id);
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.waitT = 0;
    this.startReturn(u);
    return true;
  }

  /** Send a loaded worker back to deposit: path to the nearest depot ONCE, then
   *  tickReturn waits for arrival (same "park where the pathfinder stops"
   *  contract as harvesting — this is what fixes workers getting stuck at the
   *  town hall, whose big footprint made a fixed deposit radius unreachable). */
  private startReturn(u: SimUnit): void {
    u.order = "return";
    u.working = false;
    u.atNode = false;
    const depot = this.nearestDepot(u);
    if (depot) {
      const [ax, ay] = this.depotApproach(u, depot);
      this.pathTo(u, ax, ay);
    }
  }

  /** A point on the depot's near side (toward the worker) rather than its
   *  centre, so resources return to the closest edge of the building from
   *  whatever direction the worker comes — not always the same back corner
   *  (which is what pathing to the centre + nearest-walkable produced). */
  private depotApproach(u: SimUnit, depot: SimUnit): [number, number] {
    const dx = u.x - depot.x;
    const dy = u.y - depot.y;
    const d = Math.hypot(dx, dy) || 1;
    return [depot.x + (dx / d) * depot.radius, depot.y + (dy / d) * depot.radius];
  }

  private nearestDepot(u: SimUnit): SimUnit | null {
    const w = u.worker;
    if (!w) return null;
    const wantGold = w.carryGold > 0;
    let depot: SimUnit | null = null;
    let bestD = Infinity;
    for (const d of this.units.values()) {
      if (d.owner !== u.owner) continue;
      if (wantGold ? !d.depotGold : !d.depotLumber) continue;
      const dist = Math.hypot(d.x - u.x, d.y - u.y);
      if (dist < bestD) {
        bestD = dist;
        depot = d;
      }
    }
    return depot;
  }

  // Different teams are enemies; creeps all share team -1 (hostile to every
  // player team but not to each other, like WC3's Neutral Hostile). Neutral
  // Passive entities (shops, critters) are hostile to no one. Between two PLAYER
  // slots the alliance matrix wins over the team (7.22): the GUI's "Player - Make
  // X treat Y as an Ally" is exactly a pair of players who stop fighting.
  hostile(a: SimUnit, b: SimUnit): boolean {
    if (a.neutralPassive || b.neutralPassive) return false;
    // (A slot the map set to MAP_CONTROL_NEUTRAL is not tested here. It is not a shield — it
    // is an ALLIANCE, granted at config() time and overridable by the map's own later calls.
    // See RtsController.setPlayerNeutral for why that distinction is load-bearing.)
    // DIRECTED, and it has to be. This asked whether the two were co-ALLIED — PASSIVE in
    // both directions — and treated anything less as a fight. But a map that wants one side
    // to hold its fire writes one line, not two, and every campaign does:
    //
    //     call SetPlayerAllianceStateBJ( udg_AP4_Naga, udg_AP3_FishingVillage, bj_ALLIANCE_NEUTRAL )
    //
    // Rise of the Naga sets exactly that (and the same for its Satyrs, its Wildkin and
    // Neutral Hostile) and never the reverse, then relies on the Naga standing over the
    // fishing village's ships for the whole mission without touching them — until a trigger
    // ORDERS them to, at the harbour. Read mutually, the village never granted anything back,
    // so the Naga auto-acquired the ships in the first seconds and the mission was lost
    // before the player reached it. (When the map wants a mutual relationship it says so
    // twice — the Furbolgs get UNALLIED written in both directions, two lines apart.)
    const passive = this.playerPassive(a, b);
    return passive !== null ? !passive : a.team !== b.team;
  }

  /**
   * The alliance matrix's verdict on two units' owners, or null when no matrix is installed
   * and the caller should fall back to comparing teams.
   *
   * **Neutral Hostile is a PLAYER, and the matrix is where a map talks to it.** Our sim files
   * every neutral under owner -1, and these two guards used to bail on that — creeps kept the
   * plain team rule and no `SetPlayerAlliance` could reach them. WC3 has no such hole: Neutral
   * Hostile is player 12 (common.j PLAYER_NEUTRAL_AGGRESSIVE), an ordinary row of the matrix,
   * and campaign maps write to it by name. Rise of the Naga's init is the case that found this:
   *
   *     call SetPlayerAllianceStateBJ( Player(PLAYER_NEUTRAL_AGGRESSIVE), udg_AP3_FishingVillage, bj_ALLIANCE_NEUTRAL )
   *
   * — the same line it writes for its Naga, its Satyrs and its Wildkin, and the reason none of
   * them touch the fishing village's ships until the harbour sequence orders them to. The four
   * player-owned sides obeyed it and the creeps did not, so the creeps alone went on sinking
   * ships, and two ship deaths is a scripted defeat.
   *
   * So the lookup goes through `jassOwnerOf` — the same translation every other sim→script
   * boundary uses. A creep pair lands on 12/12, which `AllianceTable.get` answers true for
   * (a player is allied with itself), keeping "creeps don't fight each other" exactly as the
   * team rule had it.
   */
  private playerAllegiance(a: SimUnit, b: SimUnit): boolean | null {
    return this.alliedPlayers(jassOwnerOf(a), jassOwnerOf(b));
  }

  /** The same lookup for the DIRECTED question `hostile` asks: does a's owner grant b's
   *  owner ALLIANCE_PASSIVE? Null only when no matrix is installed (a headless sim), where
   *  the team rule still decides. */
  private playerPassive(a: SimUnit, b: SimUnit): boolean | null {
    return this.passivePlayers(jassOwnerOf(a), jassOwnerOf(b));
  }

  /** True during daylight (06:00–18:00 game time). */
  get isDay(): boolean {
    return this.timeOfDay >= DAY_START && this.timeOfDay < DAY_END;
  }

  /**
   * What a finished structure does to the ground under it — grow blight, dispel it, or
   * neither.
   *
   * **Every building in the game carries one of these**, and that is the discovery worth
   * writing down: this is ONE mechanism with a boolean, not an Undead feature with a
   * counter-feature bolted on. `Units\UnitAbilities.slk` gives the four rows out like this —
   *
   *     Abgs  "Blight Growth (Small)"   Area1 768   DataB "Creates Blight" = 1
   *     Abgl  "Blight Growth (Large)"   Area1 960   DataB "Creates Blight" = 1
   *     Abds  "Blight Dispel (Small)"   Area1 768   DataB "Creates Blight" = 0
   *     Abdl  "Blight Dispel (Large)"   Area1 960   DataB "Creates Blight" = 0
   *
   * — with the *Growth* pair on the 20 Undead structures and the *Dispel* pair on all 60-odd
   * Human / Orc / Night Elf / neutral ones, Large on each race's main hall and Small on
   * everything else. So a Human player expanding onto a dead Undead base scrubs the rot off
   * simply by finishing a Farm there, and no code has to say so.
   *
   * All four share `DataA` "Expansion Amount" = 64 and `Dur1` = 0.08: the disc does not
   * appear, it GROWS, 64 units every twelfth of a second, so a 768 bloom takes 0.96s and a
   * 960 one 1.2s. That is the purple wash players watch spread out from a new Ziggurat.
   *
   * Matched on the ABILITY ID and not on the base `code`, because all four share `Abli`.
   * Cached per type — an ability list never changes under us.
   *
   * (`Units\MiscData.txt` also carries `BuildingUnblightRadius=350`, commented "Radius of
   * building blight dispel". It disagrees with `Abds`/`Abdl`'s own 768/960 and nothing says
   * which event it belongs to; the per-building row is the more specific data and the one
   * that has a mechanism attached, so that is what is implemented. See docs/undead.md.)
   */
  private blightPaintOf(typeId: string): BlightPaint | null {
    let paint = this.blightRadii.get(typeId);
    if (paint === undefined) {
      paint = null;
      const def = this.unitReg?.get(typeId);
      for (const id of def?.abilities ?? []) {
        if (id !== "Abgs" && id !== "Abgl" && id !== "Abds" && id !== "Abdl") continue;
        const lvl = this.abilities?.get(id)?.levelData[0] ?? emptyAbilityLevel();
        const large = id === "Abgl" || id === "Abdl";
        const radius = lvl.area || (large ? 960 : 768);
        if (paint && radius <= paint.radius) continue;
        paint = {
          radius,
          // DataB "Creates Blight" — 1 on the growth rows, 0 on the dispel ones.
          blights: this.dataOf(lvl, 1, id === "Abgs" || id === "Abgl" ? 1 : 0) > 0,
          step: this.dataOf(lvl, 0, 64) || 64, // DataA "Expansion Amount"
          period: lvl.duration || 0.08, // Dur1
        };
      }
      this.blightRadii.set(typeId, paint);
    }
    return paint;
  }

  /** The blight map, made on first use. See BlightGrid for why the lattice is the terrain's
   *  own and how it is derived from the pathing grid. */
  private blightMap(): BlightGrid {
    if (!this.blightGrid) {
      const [ox, oy] = this.grid.origin;
      this.blightGrid = new BlightGrid(this.grid.width, this.grid.height, ox, oy);
    }
    return this.blightGrid;
  }

  /** Blight the renderer has not drawn yet. Drained by the terrain overlay each frame; a
   *  headless sim simply never asks and the list is capped rather than growing (BlightGrid). */
  drainBlightUpdates(): { all: boolean; cells: Array<[number, number, boolean]> } {
    return this.blightGrid ? this.blightGrid.drainDirty() : { all: false, cells: [] };
  }

  /** The blight lattice itself, for a renderer doing a full resync (`all`). */
  get blight(): BlightGrid | null {
    return this.blightGrid;
  }

  /**
   * Start each newly-finished structure's disc growing, and advance the ones already going.
   *
   * A building paints ONCE, on completion, and what it paints stays: blight is ground, not
   * an aura, so knocking the Ziggurat down leaves the rot behind (see BlightGrid). The one
   * thing a LIVE source still does is re-assert itself — when a dispel disc has just scrubbed
   * ground out from under a standing Undead building, that building paints again, which is
   * the mechanical form of "blight can be dispelled once the building that generated it has
   * been destroyed" (classic.battle.net/war3/undead/basics.shtml). Re-assertion is driven off
   * the dispel event and not polled, so an ordinary tick with nothing new finished does no
   * work at all.
   */
  private tickBlight(dt: number): void {
    for (const u of this.units.values()) {
      if (u.hp <= 0 || !u.building || u.building.constructionLeft > 0) continue;
      if (this.blightPainted.has(u.id)) continue;
      const paint = this.blightPaintOf(u.typeId);
      this.blightPainted.add(u.id); // …including the `null` case, so it is asked once per building
      if (!paint) continue;
      // A DISPEL with nothing to dispel is not deferred, it is skipped: the scrub happens when
      // the building finishes and at no other time, so a Human Farm raised on clean grass has
      // nothing to do now and nothing to do later either. (Which makes a match with no Undead
      // player in it cost nothing at all here, rather than blooming ~60 empty discs.)
      if (!paint.blights && (!this.blightGrid || this.blightGrid.empty)) continue;
      this.blightGrowth.set(u.id, {
        x: u.x, y: u.y, r: 0, max: paint.radius, step: paint.step, period: paint.period, t: 0, on: paint.blights,
      });
    }
    if (!this.blightGrowth.size) return;
    for (const [id, g] of this.blightGrowth) {
      g.t += dt;
      // Catch the ring up in whole `step`s: a slow frame must not stretch the bloom out.
      while (g.t >= g.period && g.r < g.max) {
        g.t -= g.period;
        g.r = Math.min(g.max, g.r + g.step);
        this.blightMap().paintDisc(g.x, g.y, g.r, g.on);
      }
      if (g.r >= g.max) {
        this.blightGrowth.delete(id);
        // A dispel that has finished scrubbing may have taken ground a LIVING Undead
        // building is still holding. Give those their disc back — at once, not as a fresh
        // bloom, since that ground was theirs all along.
        if (!g.on) this.reassertBlight(g.x, g.y, g.max);
      }
    }
  }

  /** Re-paint every live blight SOURCE whose disc overlaps a patch just dispelled. */
  private reassertBlight(x: number, y: number, radius: number): void {
    for (const u of this.units.values()) {
      if (u.hp <= 0 || !u.building || u.building.constructionLeft > 0) continue;
      const paint = this.blightPaintOf(u.typeId);
      if (!paint?.blights) continue;
      const reach = paint.radius + radius;
      if ((u.x - x) ** 2 + (u.y - y) ** 2 > reach * reach) continue;
      this.blightMap().paintDisc(u.x, u.y, paint.radius, true);
    }
  }

  /** Is this point on blight? */
  isBlighted(x: number, y: number): boolean {
    return this.blightGrid ? this.blightGrid.at(x, y) : false;
  }

  /** Paint or clear a disc of blight outright — the `SetBlight*` natives, and nothing else.
   *  No growth animation: a script asking for blight is stating a fact about the ground, not
   *  raising a building. */
  setBlight(x: number, y: number, radius: number, add: boolean): void {
    this.blightMap().paintDisc(x, y, radius, add);
  }

  /**
   * Raise a Haunted Gold Mine over an existing gold mine, with no Acolyte and no build time —
   * `CreateBlightedGoldmine`, i.e. the Undead melee opening (Blizzard.j's
   * `BlightGoldMineForPlayerBJ`, called from `MeleeStartingUnitsUndead`).
   *
   * The same request the renderer already serves for an Entangled Gold Mine, because it is
   * the same event: a race's own building appearing over a mine, with a model to load first.
   * `instant` skips `ugol`'s 100-second `bldtm` — a melee player starts with a finished mine,
   * not a foundation.
   *
   * Returns the MINE's id, which is what the caller wants a handle for (see the native).
   */
  hauntMine(owner: number, team: number, x: number, y: number, unitId = "ugol"): number {
    let best: SimMine | null = null;
    let bestD = Infinity;
    for (const m of this.mines.values()) {
      if (m.entangledBy) continue;
      const d = (m.x - x) ** 2 + (m.y - y) ** 2;
      if (d >= bestD) continue;
      bestD = d;
      best = m;
    }
    if (!best) return -1;
    best.entangledBy = -1; // claimed while the model is in flight (see entangleMine)
    this.entangleRequests.push({ mineId: best.id, unitId, x: best.x, y: best.y, owner, team, casterId: 0, instant: true });
    return best.id;
  }

  /** Is every corner under an `n`-cell footprint at (x, y) blighted?
   *
   *  What `UnitBalance.slk`'s **`requirePlace` = "blighted"** asks, and the reason the Undead
   *  build the way they do. Exactly eleven types carry it — the Ziggurat and both its towers,
   *  the Crypt, Graveyard, Altar of Darkness, Temple of the Damned, Slaughterhouse, Boneyard,
   *  Tomb of Relics and Sacrificial Pit — and the two that do NOT are the Necropolis chain and
   *  the Haunted Gold Mine, which is precisely the manual's "only the Necropolis and a Haunted
   *  Gold Mine may be placed on normal land" (classic.battle.net/war3/undead/basics.shtml).
   *  Nothing here is a list of ids: the column is the rule.
   *
   *  Asked of every BUILD SQUARE the footprint covers rather than of its centre, because a
   *  12×12 Temple of the Damned is 384 units across and half of it hanging off the edge of
   *  the rot is exactly the placement the real client refuses. The square (64 units — WC3's
   *  own placement grid) is also the resolution the green/red ghost draws at, so what the
   *  player sees refused and what this refuses are the same squares. */
  footprintBlighted(wx: number, wy: number, cellsW: number, cellsH = cellsW): boolean {
    if (!this.blightGrid) return false;
    const x0 = wx - (cellsW * PATHING_CELL) / 2;
    const y0 = wy - (cellsH * PATHING_CELL) / 2;
    const cols = Math.max(1, Math.round(cellsW / BUILD_CELL_CELLS));
    const rows = Math.max(1, Math.round(cellsH / BUILD_CELL_CELLS));
    for (let sy = 0; sy < rows; sy++) {
      for (let sx = 0; sx < cols; sx++) {
        if (!this.blightGrid.at(x0 + (sx + 0.5) * BUILD_CELL, y0 + (sy + 0.5) * BUILD_CELL)) return false;
      }
    }
    return true;
  }

  /** The unit TYPE's own hit-point regeneration (UnitBalance.slk `regenHP`), gated by the
   *  `regenType` column that says when it may run. That single column is the whole of WC3's
   *  racial regeneration rule, and it is why a Grunt heals up after a fight and a Ghoul does
   *  not once it has walked off the blight:
   *
   *    Footman / Grunt / Peasant   always  0.25 hp/sec
   *    Archer / Huntress / Tree    night   0.5   (nothing at all in daylight)
   *    Ghoul / Acolyte / Abomination  blight  2  (only while standing on blight)
   *    Barracks, Ziggurat, …       none    — (which is why they need a worker to repair)
   *
   *  Heroes carry a row of their own too (Paladin 0.25 always, Death Knight 2 blight, Demon
   *  Hunter 0.5 night) and it ADDS to the Strength regen — so a night elf hero really does
   *  heal noticeably slower in the sun, which is the behaviour players know. */
  private typeHpRegen(u: SimUnit): number {
    const def = this.unitReg?.get(u.typeId);
    if (!def || !def.hpRegen) return 0;
    switch (def.regenType) {
      case RegenType.Always: return def.hpRegen;
      case RegenType.Night: return this.isDay ? 0 : def.hpRegen;
      case RegenType.Blight: return this.isBlighted(u.x, u.y) ? def.hpRegen : 0;
      default: return 0; // RegenType.None
    }
  }

  /** A unit type's own mana regeneration, before buffs/items/upgrades.
   *
   *  A HERO's comes from Intelligence and nothing else. Everyone else's is UnitBalance.slk's
   *  `regenMana`, which is a real per-type number the sim used to flatten to one constant:
   *  a Sorceress 0.667, a Priest 0.72, a Spirit Walker 1, a Moon Well 1.5. UNIT_MANA_REGEN
   *  survives only as the fallback for a mana-carrying type whose row states none.
   *
   *  The MOON WELL is the one caster whose regeneration has a clock on it: "Regenerates mana
   *  at night" (NightElfUnitStrings [emow]) — a well drained by day stays drained until dusk,
   *  which is most of what makes night elf healing a resource rather than a tap. The rule is
   *  keyed off `Ambt`, the Moon Well's own Mana Battery row, and NOT off the shared `Ambt`
   *  CODE: the Obsidian Statue carries the same code as `Amb2` and refills at any hour. (The
   *  two rows do differ at DataE — 1 against 0 — and night-only is one plausible reading of
   *  that column, but "can restore mana" fits it exactly as well, so the alias is the honest
   *  discriminator. See tickReplenish.) */
  private baseManaRegen(u: SimUnit): number {
    if (u.isHero) return REGEN_PER_INT * u.int;
    if (u.baseMaxMana <= 0) return 0;
    const def = this.unitReg?.get(u.typeId);
    return def?.manaRegen || UNIT_MANA_REGEN;
  }

  /** A Moon Well by day: it refills at night and not otherwise, and the clock applies to the
   *  WHOLE rate rather than only its base — Well Spring's +0.52 is more of the same water, and
   *  a well that trickled by day would defeat the rule it is an upgrade to. */
  private manaRegenSuspended(u: SimUnit): boolean {
    return this.isDay && u.abilities.some((a) => a.id === "Ambt");
  }

  /** Same team = allied (friendly), unless the alliance matrix says otherwise (7.22).
   *  Neutral-passive shops count as nobody's ally. */
  allied(a: SimUnit, b: SimUnit): boolean {
    if (a.neutralPassive || b.neutralPassive) return false;
    const allied = this.playerAllegiance(a, b);
    return allied !== null ? allied : a.team === b.team;
  }

  // === abilities / buffs / casting ==========================================

  /** Sum the passive stat bonuses granted by the items in a unit's inventory.
   *  Item behaviour is dispatched off the granted ability's base `code` (verified
   *  against AbilityData.slk): +damage AIat, +armour AIde, +attributes AIab
   *  (dataA=agi, dataB=int, dataC=str), +attack-speed AIas, +mana-regen AHab.
   *  Permanent item stats are computed here every tick rather than stored as
   *  buffs, so Dispel Magic (which wipes `u.buffs`) can never remove them. */
  private itemBonuses(u: SimUnit): {
    str: number; agi: number; int: number; damage: number; armor: number; attackSpeed: number; manaRegen: number;
    speed: number; maxHp: number; maxMana: number; hpRegen: number; weaponsOn: number;
    magicReduction: number; rangedReduction: number;
  } {
    const b = {
      str: 0, agi: 0, int: 0, damage: 0, armor: 0, attackSpeed: 0, manaRegen: 0, speed: 0,
      maxHp: 0, maxMana: 0, hpRegen: 0, weaponsOn: 0, magicReduction: 0, rangedReduction: 0,
    };
    if (!u.inventory.length || !this.itemReg || !this.abilities) return b;
    for (const held of u.inventory) {
      if (!held) continue;
      const item = this.itemReg.get(held.itemId);
      if (!item) continue;
      for (const abilId of item.abilities) {
        const def = this.abilities.get(abilId);
        if (!def) continue;
        const d = def.levelData[0]?.data ?? [];
        const val = (i: number) => (d[i] === undefined || Number.isNaN(d[i]) ? 0 : d[i]);
        switch (def.code) {
          case "AIat": b.damage += val(0); break; // Claws of Attack (+damage)
          case "AIde": b.armor += val(0); break; // Ring of Protection (+armour)
          case "AIab": b.agi += val(0); b.int += val(1); b.str += val(2); break; // stat items
          case "AIas": b.attackSpeed += val(0); break; // Gloves of Haste (+attack speed)
          // (`AHab` — Khadgar's Pipe of Insight, the Ring of the Archmagi, the Mindstaff — is
          // NOT here: it is Brilliance AURA, and each of those items says "and friendly
          // nearby units" in its own tooltip. It goes out through applyAuras like the other
          // thirteen aura items, whose `targs1` includes `self`, so the bearer gets it too.)
          // The two REGENERATION items, as distinct from the potions that restore over a
          // fixed duration (AIrg): these are permanent, passive rates while the item is
          // carried. Ring of Regeneration / Health Stone give dataA hp per second; the
          // Sobi Mask and the wands give dataA mana per second.
          case "Arel": b.hpRegen += val(0); break; // Regen Life (+2 hp/sec)
          case "AIrm": b.manaRegen += val(0); break; // ItemRegenMana (+0.5 mana/sec)
          // The two the shops made reachable (issue #57). Both are plain passive bonuses, and
          // both were dead code paths until now because nothing sold them: Boots of Speed are
          // the Goblin Merchant's signature item, and the Periapt is the +HP staple.
          case "AIms": b.speed += val(0); break; // Boots of Speed (+60 movement)
          case "AIml": b.maxHp += val(0); break; // Periapt of Vitality (+150 max HP)
          // …and its mana twin, which had no case at all: `AImm` "MaxManaBonus" is the
          // Pendant of Energy's +150, the Pendant of Mana's +250 and the Mindstaff's +200
          // (`AI2m`, the row whose comment is simply "200 mana bonus"). One code, one
          // column, five aliases — the +max-mana staple of the shop.
          case "AImm": b.maxMana += val(0); break;
          // The two DAMAGE-REDUCTION items, which are neither armour nor a buff: each cuts
          // one CLASS of incoming damage by a fraction, applied where that damage lands.
          //
          //   `AIsr` Runed Bracers      dataB 0.33 — "Reduces Magic damage dealt to the Hero
          //                                          by <AIsr,DataB1,%>%" (also Frost Wyrm
          //                                          Skull Shield, Drek'thar's Spellbook)
          //   `AIdd` Defend (Item)      dataA 0.70 — Arcanite Shield: "Reduces damage from
          //                                          ranged attacks to <AIdd,DataA1,%>%"
          //
          // Note the two columns are stated the opposite way round — the bracers name what
          // they TAKE OFF, the shield what it LETS THROUGH — which is exactly what their
          // tooltips print, so each is normalised here into "fraction removed".
          case "AIsr": b.magicReduction = Math.max(b.magicReduction, val(1)); break;
          case "AIdd": b.rangedReduction = Math.max(b.rangedReduction, 1 - val(0)); break;
        }
        // --- The two things an ORB gives simply by being CARRIED, neither of which is
        // subject to the one-orb-at-a-time rule (src/sim/orbs.ts). The on-hit EFFECT is,
        // and it lives in the attack path (resolveOrb), not here.
        if (isOrbCode(def.code)) {
          // "Adds <DataA> bonus damage to the attack of a Hero when carried" — every orb
          // item's own Ubertip words it as a carried stat, i.e. a Claws of Attack line, so
          // two orbs really do give two damage bonuses. `AIva` (Mask of Death) and the
          // effect-only halves carry no DataA and add nothing.
          if (def.code !== "AIva") b.damage += val(0);
          // "The Hero's attacks also become ranged when attacking air" — DataE, the
          // "Enabled Attack Index" (see ENABLED_ATTACK_INDEX). Every hero ships a dormant
          // second weapon that is ranged and lists `air`; the orb switches it on.
          const slot = val(ENABLED_ATTACK_INDEX);
          if (slot >= 1) b.weaponsOn |= 1 << (slot - 1);
        }
      }
    }
    return b;
  }

  /** Sum the bonuses the owner's RESEARCHED upgrades grant this unit (issue #57).
   *
   *  Two gates decide whether an upgrade touches a unit at all, and both come from the data:
   *  the owner must have researched it, and the unit must LIST it in UnitBalance's `upgrades`
   *  column. That second gate is what separates Forged Swords (on the Footman's list) from
   *  Gunpowder (on the Rifleman's) — they are the same `ratd` effect and would otherwise both
   *  fire on both units.
   *
   *  Effect values are the TOTAL at the researched level, not an increment:
   *  `base + mod*(level-1)`. Priest Master Training therefore reads +200 max mana at level 2,
   *  not another +100 on top of level 1.
   *
   *  Still deliberately unhandled rather than guessed at: `rart` (armour-type swap, Orc
   *  Reinforced Defenses), `ratc` (attack target count — Moon Glaive's bounce), `rrai`,
   *  `rent`, `rspi`, `rlev`, `raud`, `rmin`, `radl`. `rtma` is not a stat at all — it flips a
   *  unit's availability and is handled by TechState.maxAllowed. */
  private upgradeBonuses(u: SimUnit): {
    dice: number; armor: number; hp: number; hpPct: number; mana: number; manaRegen: number;
    range: number; sight: number; speed: number; attackSpeed: number; damage: number;
    lumber: number; spillDist: number; spillRadius: number; weaponMask: number;
    attackLevel: number; armorLevel: number;
  } {
    const b = {
      dice: 0, armor: 0, hp: 0, hpPct: 0, mana: 0, manaRegen: 0, range: 0, sight: 0, speed: 0,
      attackSpeed: 0, damage: 0, lumber: 0, spillDist: 0, spillRadius: 0,
      attackLevel: 0, armorLevel: 0,
      // -1 = "no `renw` researched" — the unit keeps whatever mask its data shipped with.
      weaponMask: -1,
    };
    if (!this.tech || !this.upgradeReg || !this.unitReg) return b;
    const def = this.unitReg.get(u.typeId);
    if (!def || !def.upgradesUsed.length) return b;
    for (const upId of def.upgradesUsed) {
      const level = this.tech.researchLevel(u.owner, upId);
      if (level < 1) continue;
      const up = this.upgradeReg.get(upId);
      if (!up) continue;
      // The number the info panel prints in the corner of the damage / armour icon is not the
      // size of the bonus — it is the LEVEL of the upgrade, picked by `UpgradeData.slk`'s own
      // `class` column: the 9 melee/ranged attack researches, the 9 `armor` ones (Masonry
      // included, which is why a Farm's shield carries a number too), and nothing else. A
      // caster's Master Training raises attack dice as well (`ratd` on `Rhpt` et al.) but is
      // class `caster`, so it does not move either number.
      if (up.className === "melee" || up.className === "ranged") {
        // A unit is only ever listed against ONE attack class, so the max IS its level.
        b.attackLevel = Math.max(b.attackLevel, level);
      } else if (up.className === "armor") {
        b.armorLevel = Math.max(b.armorLevel, level);
      }
      for (const e of up.effects) {
        const v = e.base + e.mod * (level - 1);
        switch (e.effect) {
          case "ratd": b.dice += v; break; // attack DICE (the melee/ranged attack upgrades)
          case "ratx": b.damage += v; break; // flat attack damage (Burning Oil et al.)
          // Armour upgrades ship no magnitude of their own — it is the target's `defUp`
          // (2 per level for a unit, 1 for a building), so one Plating research is +2 on a
          // Footman and one Masonry is +1 on a Farm. Scales with the level researched.
          case "rarm": b.armor += def.defUp * level; break;
          case "rhpx": b.hp += v; break;
          case "rhpo": b.hpPct += v; break; // Masonry's +10%/level building HP
          case "rmnx": b.mana += v; break;
          case "rmnr": b.manaRegen += v; break;
          case "ratr": b.range += v; break; // Long Rifles +200
          case "rsig": b.sight += v; break;
          case "rmvx": b.speed += v; break;
          case "rats": b.attackSpeed += v; break;
          // Improved/Advanced Lumber Harvesting (`Rhlh`): the lumber a worker carries per
          // trip. base 10 / mod 10, so 10 at level 1 and 20 at level 2 — ON TOP of the
          // Peasant's own 10, matching the game's own tooltip ("Increases the amount of
          // lumber that Peasants can carry by <Rhlh,mod1>").
          case "rlum": b.lumber += v; break;
          // Attack spill (Storm Hammers `Rhhb` = rasd 200, Impaling Bolt `Repb` = rasd 200):
          // opens up the line-splash the weapon already carries a radius for.
          case "rasd": b.spillDist += v; break;
          case "rasr": b.spillRadius += v; break;
          // Enable Weapons (`renw`) — an attackBits MASK that REPLACES `weapsOn`, it does not
          // add to it. Flying Machine Bombs (`Rhgb`) and Corrosive Breath (`Recb`) are 3 (both
          // slots); Impaling Bolt (`Repb`) is 2, which SWITCHES the Glaive Thrower off slot 1
          // and onto slot 2 — the tree-piercing bolt — rather than giving it a second attack.
          case "renw": b.weaponMask = v; break;
        }
      }
    }
    return b;
  }

  /** The weapon `u` would strike `t` with: the first ENABLED slot whose Targets Allowed admits
   *  the target. null = it cannot attack `t` at all, which is a real and common answer in WC3 —
   *  a Footman has no answer to a Gryphon Rider, a Siege Engine cannot touch a Footman, and a
   *  Flying Machine cannot hit the ground until Bombs is researched.
   *
   *  WC3 classifies the target by what it IS (allegiance is the caller's business, via
   *  hostile()): a flyer answers to `air`, a structure to `structure`, everything else to
   *  `ground`. Note that a building is NOT "ground" — the Chimaera's corrosive breath lists
   *  `structure,debris` alone and hits nothing but buildings, and the Mortar Team keeps a
   *  separate structure-only slot precisely because its ground shot lists no `structure`. */
  weaponVs(u: SimUnit, t: SimUnit): SimWeapon | null {
    for (const w of u.weapons) {
      if (!w.enabled) continue;
      // No Targets Allowed data at all (a summon or custom unit with no weapons row) → treat
      // the weapon as unrestricted rather than silently disarming the unit.
      if (!w.targets.length) return w;
      if (w.targets.includes(targetKeyOf(t))) return w;
    }
    return null;
  }

  /** Whether `u` has any weapon that may strike `t`. Every automatic target scan asks this, so
   *  a Footman never walks across the map at a passing Gargoyle it can never hit. */
  private canAttack(u: SimUnit, t: SimUnit): boolean {
    return this.weaponVs(u, t) !== null;
  }

  /** Recompute a unit's effective stats from its base values, hero attribute
   *  growth, active buffs, items and the owner's researched upgrades. Called every
   *  tick (cheap, idempotent). */
  private recomputeStats(u: SimUnit): void {
    const item = this.itemBonuses(u);
    const upg = this.upgradeBonuses(u);
    // Buffed attributes (Robo-Goblin's Strength) count exactly as an item's do — same pool,
    // same downstream effects (hit points, damage on a Strength hero, the panel's number).
    let buffStr = 0;
    for (const b of u.buffs) if (b.kind === "strength") buffStr += b.value;
    if (u.isHero) {
      u.str = Math.floor(u.baseStr + u.strPerLevel * (u.level - 1)) + item.str + buffStr;
      u.agi = Math.floor(u.baseAgi + u.agiPerLevel * (u.level - 1)) + item.agi;
      u.int = Math.floor(u.baseInt + u.intPerLevel * (u.level - 1)) + item.int;
    }
    const dStr = u.isHero ? u.str - Math.floor(u.baseStr) : 0;
    const dAgi = u.isHero ? u.agi - Math.floor(u.baseAgi) : 0;
    const dInt = u.isHero ? u.int - Math.floor(u.baseInt) : 0;
    const primaryDelta = u.primaryAttr === PrimaryAttribute.Strength ? dStr : u.primaryAttr === PrimaryAttribute.Agility ? dAgi : u.primaryAttr === PrimaryAttribute.Intelligence ? dInt : 0;
    let armorBonus = 0;
    let manaRegenBonus = 0;
    let damageBonus = 0;
    let slowMove = 0;
    let slowAttack = 0;
    let hasteMove = 0;
    let hasteAttack = 0;
    let damagePct = 0;
    let hpRegenBonus = 0;
    let lifesteal = 0;
    let thorns = 0;
    let stun = false;
    let silence = false;
    let ethereal = false;
    let webbed = false;
    let invisible = false;
    let cloaked = false;
    let invuln = false;
    let magicImmuneBuff = false; // the TIMED kind (Anti-magic Potion); see BuffKind.magicImmune
    let maxHpBonus = 0;
    for (const b of u.buffs) {
      if (b.kind === "armor") armorBonus += b.value;
      else if (b.kind === "manaRegen") manaRegenBonus += b.value;
      else if (b.kind === "damage") damageBonus += b.value;
      else if (b.kind === "damagePct") damagePct += b.value; // Command/Trueshot Aura
      else if (b.kind === "hpRegen") hpRegenBonus += b.value; // Unholy Aura
      else if (b.kind === "lifesteal") lifesteal = Math.max(lifesteal, b.value); // Vampiric Aura
      else if (b.kind === "thorns") thorns = Math.max(thorns, b.value); // Thorns Aura
      else if (b.kind === "slow") {
        slowMove = Math.max(slowMove, b.value);
        slowAttack = Math.max(slowAttack, b.value2);
      } else if (b.kind === "haste") {
        hasteMove = Math.max(hasteMove, b.value);
        hasteAttack = Math.max(hasteAttack, b.value2);
      } else if (b.kind === "root") {
        slowMove = Math.max(slowMove, b.value); // pins movement (can still attack)
        // WEB is Ensnare with one extra clause, and the group is what tells them apart: the
        // target is not merely held, it is pulled DOWN. See SimUnit.webbed.
        if (b.group === "web") webbed = true;
      }
      else if (b.kind === "ethereal") {
        ethereal = true;
        slowMove = Math.max(slowMove, b.value); // Banish's Movement Speed Reduction (DataA)
      } else if (b.kind === "stun" || b.kind === "sleep") stun = true; // sleep disables like a stun (wakes on damage)
      else if (b.kind === "silence") silence = true;
      else if (b.kind === "invisible") {
        cloaked = true; // under the effect from the moment it lands
        if (b.delay <= 0) invisible = true; // …but not actually faded until the transition elapses
      }
      else if (b.kind === "invuln") invuln = true;
      else if (b.kind === "magicImmune") magicImmuneBuff = true; // Anti-magic Potion's 15 seconds
      else if (b.kind === "maxHp") maxHpBonus += b.value; // Metamorphosis' alternate-form pool
    }
    // Masonry-style `rhpo` is a PERCENTAGE of the base pool, applied before the flat `rhpx`
    // adds (Animal War Training's +150).
    const newMaxHp = (u.baseMaxHp + HP_PER_STR * dStr) * (1 + upg.hpPct) + upg.hp + item.maxHp + maxHpBonus;
    const newMaxMana = u.baseMaxMana + MANA_PER_INT * dInt + upg.mana + item.maxMana;
    // Moving the ceiling keeps the unit's RELATIVE pool, in both directions: "Increasing the
    // maximum amount of Hit Points of a unit does not change its relative Hit Points"
    // (Liquipedia, Hit_Points). The page's own item-drop trick proves the ratio (not a flat
    // delta) is what is preserved — regenerate with the item off, re-equip, and the current
    // HP scales up with the ceiling for a gain of `regenerated · Bonus/(MaxHP − Bonus)`, which
    // an additive model could never produce. So this is the ONE rule behind every ceiling
    // move: a hero levelling (issue #69), strength/intellect growth, a tome, an item, and
    // Brute Strength finishing over a field of Grunts (issue #70). A full-health Grunt stays
    // full; a half-health one stays half; a wounded building researching Masonry gains
    // headroom but is no more healed than before.
    if (u.maxHp > 0 && newMaxHp !== u.maxHp) u.hp *= newMaxHp / u.maxHp;
    if (u.maxMana > 0 && newMaxMana !== u.maxMana) u.mana *= newMaxMana / u.maxMana;
    u.maxHp = newMaxHp;
    // A structure still going up has no mana AND no mana bar. WC3 shows a foundation rising
    // with nothing but its health, and the pool arrives with the finished building — a Moon
    // Well you have half-built is not a Moon Well you can drink from. Withheld by zeroing the
    // CEILING rather than the current value, because the bar is drawn off the ceiling: leaving
    // maxMana up and mana at 0 would show an empty blue bar instead of no bar. finishConstruction
    // fills it to the type's `mana0`.
    u.maxMana = u.building && u.building.constructionLeft > 0 ? 0 : newMaxMana;
    if (u.hp > u.maxHp) u.hp = u.maxHp;
    if (u.mana > u.maxMana) u.mana = u.maxMana;
    // Defend: "While Defend is active, movement is reduced to <DataC1,%>% of normal speed"
    // (30%) — a stance, not a debuff, so it is derived here rather than carried as a buff.
    const defend = this.defendStance(u);
    if (defend) slowMove = Math.max(slowMove, 1 - this.dataOf(defend, 2, 0.3));
    // Spiked Carapace (Crypt Lord passive AUts): a flat bonus armour (dataB) while learned.
    const carapace = this.passiveLevelData(u, "AUts");
    const carapaceArmor = carapace ? this.dataOf(carapace, 1) : 0;
    u.armor = u.baseArmor + ARMOR_PER_AGI * dAgi + armorBonus + carapaceArmor + item.armor + upg.armor;
    u.bonusArmor = armorBonus + carapaceArmor + item.armor + upg.armor; // the buff/aura/item/upgrade portion (shown green in the HUD)
    // The corner numbers on the info panel's two icons: the LEVEL researched, not the bonus.
    u.attackUpgrade = upg.attackLevel;
    u.armorUpgrade = upg.armorLevel;
    // Attack speed ("IAS"): every source — agility, items, buffs, upgrades, slows — sums
    // into ONE additive bonus term, which then divides the base attack time exactly once.
    // Bonuses never chain multiplicatively (Hive "Attack Speed Formula?" #12, Dr Super Good:
    // "ARf = ARi/(1+FAR)"; Liquipedia Attack_Speed: "IAS = (0.02 * Agility) + Item Bonuses +
    // Ability Bonuses", "Attack Speed = BCD/1 + IAS"), and a hero's slow is SUBTRACTED from
    // the IAS rather than scaling the result. Heroes gain AgiAttackSpeedBonus (2%) per point
    // of TOTAL agility — `cool1` is the raw Base Attack Time with no agility baked in
    // (Blademaster cool1=1.77, and Liquipedia's displayed 1.23 = 1.77/(1+0.02*22) at that
    // patch's 22 agi). Verified against MiscGame.txt AgiAttackSpeedBonus=0.02.
    const agiAttackSpeed = u.isHero ? MISC_GAME.AgiAttackSpeedBonus * u.agi : 0;
    const ias = Math.min(
      IAS_MAX,
      Math.max(IAS_MIN, agiAttackSpeed + hasteAttack + item.attackSpeed + upg.attackSpeed - slowAttack),
    );
    const speedFactor = 1 / (1 + ias);
    const root = this.rootAbility(u); // Ancients: which weapon slot is live depends on it
    // EVERY slot is rebuilt, not just the one in hand: a Gargoyle's ground and air attacks
    // both carry Forged Talons, and a Flying Machine that researches Bombs must find its bomb
    // slot already carrying its armour/damage upgrades the moment the slot switches on.
    for (const w of u.weapons) {
      // `renw` REPLACES weapsOn (see upgradeBonuses) — hence a bit test against the new mask
      // rather than an OR with the old one, which is what lets Impaling Bolt take the Glaive
      // Thrower OFF its original weapon.
      if (upg.weaponMask >= 0) w.enabled = (upg.weaponMask & (1 << u.weapons.indexOf(w))) !== 0;
      // …and an ORB switches its "Enabled Attack Index" slot ON, which is the whole of "the
      // Hero's attacks also become ranged when attacking air": a hero's dormant slot 2 is a
      // 500-range homing missile that lists `air` (UnitWeapons.slk), and carrying the orb is
      // all it takes to wake it. An OR, never an assignment — the orb adds a way to attack,
      // it never takes the melee away.
      if (item.weaponsOn & (1 << u.weapons.indexOf(w))) w.enabled = true;
      const base = w.baseDamage + primaryDelta;
      w.damage = Math.max(0, base + damageBonus + item.damage + upg.damage + base * damagePct); // Command/Trueshot add a % of base
      w.dice = w.baseDice + upg.dice; // Forged Swords / Gunpowder add dice, widening the roll
      w.range = w.baseRange + upg.range; // Long Rifles
      w.damagePoint = w.baseDamagePoint * speedFactor;
      w.backswing = w.baseBackswing * speedFactor; // the follow-through hastes with the damage point
      // The same IAS divides the cooldown. Floor: a unit can never swing faster than its own
      // strike lands — "the unit is restricted to about its attack animation damage point…
      // always attack slightly slower than the actual animation damage point by 0.02 seconds"
      // (Hive "Attack Speed Formula?", Dr Super Good). Both sides scale with IAS, so this only
      // binds where dmgpt1 > cool1 — rare in stock data, common in custom object data.
      w.cooldown = Math.max(w.baseCooldown * speedFactor, w.damagePoint + DAMAGE_POINT_FLOOR);
      w.spillDist = w.baseSpillDist + upg.spillDist; // Storm Hammers — see the spill fields on SimWeapon
      w.spillRadius = w.baseSpillRadius + upg.spillRadius;
    }
    // Root (`Aroo`) swaps which WEAPON SLOT is live, and the Data columns say so outright
    // (AbilityMetaData Roo1..Roo4 → WorldEditStrings):
    //   DataA "Rooted Weapons"    Aroo/Aro1 = 1, Aro2 = 2
    //   DataB "Uprooted Weapons"  Aroo/Aro1 = 2, Aro2 = 1
    // Same bitmask as `weapsOn` (1 = first slot, 2 = second, 3 = both), so this is a mask
    // assignment and not a bit test. The Ancient Protector is what the column is FOR: `etrp`
    // has weapsOn=3 and takes Aro2, so planted it fires slot 2 — the 700-range attack that
    // also hits air — and uprooted it swings slot 1, a 128-range melee. A tower while it
    // stands still, a slow angry tree while it walks. The three plain Ancients carry the same
    // stats in both slots, so for them this is bookkeeping the data still insists on.
    if (root) {
      const lvl = this.abilities?.get(root.id)?.levelData[0];
      const mask = u.uprooted ? lvl?.data[1] : lvl?.data[0];
      if (mask !== undefined && !Number.isNaN(mask)) {
        for (let i = 0; i < u.weapons.length; i++) u.weapons[i].enabled = (mask & (1 << i)) !== 0;
      }
    }
    // Orc Burrow: its arrow weapon is `weapsOn=1` in data but only fires while GARRISONED,
    // and its attack SPEED scales with the peon count — one projectile always, cooldown =
    // base/(peons+1) → 100/150/200/250 % DPS for 1-4 (Liquipedia Orc_Burrow; base cd 4 from
    // UnitWeapons.slk). Damage per hit is unchanged. Empty → weapon off (no auto-attack).
    // …the BURROW's hold only. A transport's cargo arms nothing (and a hold that armed its
    // carrier would switch a Siege Engine's gun off the moment it emptied).
    if (u.garrisonCap > 0 && this.cargoHold(u.typeId)?.code === "Abun") {
      const n = u.garrison.length;
      for (const w of u.weapons) {
        w.enabled = n >= 1;
        if (n >= 1) w.cooldown = (w.baseCooldown * speedFactor) / (n + 1);
      }
    }
    // Re-pick the primary: an upgrade may have just switched the unit's first live slot.
    u.weapon = u.weapons.find((w) => w.enabled) ?? null;
    if (u.weapon) u.bonusDamage = u.weapon.damage - (u.weapon.baseDamage + primaryDelta); // the buff/aura/item portion
    if (u.worker) u.worker.lumberCapacity = u.worker.baseLumberCapacity + upg.lumber; // Improved/Advanced Lumber Harvesting
    u.sightDay = u.baseSightDay + upg.sight;
    // Ultravision (`Ault`) — the unit keeps its DAY sight radius at night, i.e. the night
    // penalty simply does not apply to it.
    //
    // It is not innate, and that is the whole of the "do night elves see at night?"
    // question. `Ault` does sit on the night elf heroes, the Archer and the Glaive Thrower
    // from birth (Units\UnitAbilities.slk), which makes it look racial — but its own row
    // is `[Ault] Requires=Reuv`, the Ultravision upgrade researched at the Hunter's Hall.
    // So until that research lands a night elf takes exactly the same night penalty as
    // everyone else (Archer 1400 day / 800 night), and afterwards it does not. Same
    // upgrade-gated-ability shape as Pillage (Ropg) and Defend (Rhde).
    //
    // …and the Goblin Night Scope (`AIuv`, `code = Ault`) is the same ability CARRIED, with
    // one difference that matters: `Reuv` gates the night elf racial, not the item. The
    // scope's own row has no `Requires`, and it is sold to every race in the game — a human
    // hero carrying one sees at night without ever having built a Hunter's Hall.
    const ultravision = (this.tech && this.tech.researchLevel(u.owner, "Reuv") > 0
      && u.abilities.some((a) => a.code === "Ault" && a.level >= 1))
      || this.itemAbilityLevel(u, "Ault") !== null;
    u.sightNight = ultravision ? u.sightDay : u.baseSightNight + upg.sight;
    u.speed = Math.max(0, (u.baseSpeed + upg.speed + item.speed) * (1 - slowMove) * (1 + hasteMove));
    // Root (`Aroo`) — an Ancient is a building that can decide to walk. UnitBalance already
    // gives every carrier a real movement speed (eaom spd=40): that is its UPROOTED walk, and
    // what makes it a building the rest of the time is simply that we refuse to spend it.
    // Zeroing the speed is the whole of "rooted" as far as movement is concerned — u.speed<=0
    // is already what issueFollow, the stuck check and the collision list all gate on.
    if (root && !u.uprooted) u.speed = 0;
    // …and neither half of an Ancient walks while it is hauling its roots up or settling them
    // back down. The stance has already flipped by then (see SimUnit.morphT), so without this
    // a just-uprooted Ancient slid across the ground through its own morph clip.
    if (u.morphT > 0) u.speed = 0;
    if (root) u.altModel = !u.uprooted; // planted = the alternate half of the Ancient model
    u.manaRegen = this.manaRegenSuspended(u)
      ? 0
      : this.baseManaRegen(u) + manaRegenBonus + item.manaRegen + upg.manaRegen;
    u.hpRegen = this.typeHpRegen(u) + (u.isHero ? REGEN_PER_STR * u.str : 0) + hpRegenBonus + item.hpRegen;
    // Vampiric Aura only — the Mask of Death's life steal is an ORB (exclusive with every
    // other orb, and it works on a ranged attack), so it is applied at the blow instead.
    u.lifesteal = lifesteal;
    // The two carried damage cuts (Runed Bracers, Arcanite Shield). Derived like every other
    // item stat; spent at the two places the damage they name arrives — spellDamage and the
    // ranged half of dealDamage.
    u.magicReduction = item.magicReduction;
    u.rangedReduction = item.rangedReduction;
    // Spiked Carapace also returns a fraction of melee damage (dataA), like Thorns.
    u.thorns = Math.max(thorns, carapace ? this.dataOf(carapace, 0) : 0);
    u.stunned = stun;
    u.silenced = silence;
    u.ethereal = ethereal || u.etherealForm; // Banish (timed) OR the Spirit Walker's ethereal FORM (persistent)
    // Web, landing and letting go. The altitude it returns to is the TYPE's own `moveheight`
    // — the same number the spawner starts it at — rather than one stashed at cast time: a
    // buff carries no expiry hook to restore from, and "back to its default flight height" is
    // both what the original shows and the only answer that survives the buff being dispelled,
    // expiring, or the caster dying. Touched only on the CHANGE, so a script's
    // SetUnitFlyHeight is left alone for every unit that is not being webbed right now.
    if (webbed !== u.webbed) u.flyHeight = webbed ? 0 : (this.unitReg?.get(u.typeId)?.moveHeight ?? 0);
    u.webbed = webbed;
    // Magic Immunity is a plain property of the unit's ability list, not a buff — nothing
    // grants or removes it mid-life, so it is derived here alongside the rest. (`Amim` carries
    // no Requires, so the tech gate below is a formality for it — it is the tower detection
    // that actually needs one.)
    // (The Necklace of Spell Immunity's `AImx` is that same `Amim` in an inventory, so the
    // carried half is asked too — see itemAbilityLevel.)
    u.magicImmune = magicImmuneBuff
      || u.abilities.some((a) => a.code === "Amim" && a.level >= 1 && this.techMeets(u.owner, a.id))
      || this.itemAbilityLevel(u, "Amim") !== null;
    // …and RESISTANT SKIN (`Arsk`) the same way, with one difference that matters: it DOES
    // carry a `Requires` (`[Arsk] Requires=Rers`, the Ancient of Lore upgrade), which is what
    // makes a Mountain Giant resistant only once the research is in — while the units that
    // are born with it (Tauren, Spirit Walker, Infernal, Phoenix, Avatar of Vengeance) list
    // the ungated creep copy `ACrk`, whose row has no requirement at all. Both share `code =
    // Arsk`, so one derivation covers them and `techMeets` tells them apart.
    u.resistant = u.abilities.some((a) => a.code === "Arsk" && a.level >= 1 && this.techMeets(u.owner, a.id));
    // True Sight, likewise a property of the ability list. Three separate base codes do the
    // one job, so all three are read and the widest wins if a unit somehow carries more than
    // one. AbilityData.slk names them plainly:
    //
    //   Atru  "Detect (Shade)"           Rng1  900
    //   Adet  "Detect (Sentry Ward)"     Rng1 1100
    //   Adts  "Detect (Magic Sentinel)"  Rng1  900
    //
    // The radius is `Rng1` (castRange), NOT dataA — dataA reads 3 for all three, a
    // detection-TYPE enum that is not a distance at all, while those Rng1 values are exactly
    // the radii the game is documented to have. Reading dataA gave every detector a 3-unit
    // reach, i.e. True Sight silently never fired: nothing was ever revealed.
    //
    // `Adet` is the odd one out in the table: its row carries no `code` cell, so it reaches
    // the registry under the id fallback (abilities.ts `str(r, "code") || id`). No 1.27a unit
    // lists it — it is kept here for custom maps that hand it out.
    //
    // The tech gate is the standing "abilList membership is not availability" rule, and this
    // is the case that rule was written for: all four Human towers carry `Adts` from birth,
    // but `[Adts] Requires=Rhse` — Magic Sentry. Without the check, every Scout Tower on the
    // map would see through Wind Walk with the research still unbought.
    u.detectRadius = 0;
    for (const a of u.abilities) {
      if ((a.code !== "Atru" && a.code !== "Adet" && a.code !== "Adts") || a.level < 1) continue;
      if (!this.techMeets(u.owner, a.id)) continue;
      const lvl = this.abilities?.get(a.id)?.levelData[Math.max(0, a.level - 1)];
      const r = lvl?.castRange;
      if (r !== undefined && !Number.isNaN(r)) u.detectRadius = Math.max(u.detectRadius, r);
    }
    // …and the CARRIED detector: the Gem of True Seeing's `Adt1` is `code = Adet`, the row
    // whose comment is literally "Detect (Sentry Ward)" and whose Rng1 = 1100. No unit in
    // 1.27a lists `Adet` — the gem is the only thing in the game that hands it out, which is
    // why the note above says the code is kept "for custom maps". It was the item's all along.
    for (const code of ["Atru", "Adet", "Adts"] as const) {
      const r = this.itemAbilityLevel(u, code)?.castRange;
      if (r !== undefined && !Number.isNaN(r)) u.detectRadius = Math.max(u.detectRadius, r);
    }
    u.invisible = invisible;
    u.cloaked = cloaked;
    u.invulnerable = invuln || u.baseInvulnerable; // buffs (Divine Shield/Avatar) OR the unit type's Avul (issue #26)
    if (u.vanished) u.invulnerable = true; // whisked off the field mid-effect — nothing can reach it
    // An Orc peon building from INSIDE the site is off the field entirely (isOffField): it has
    // no position anything can aim at, so it is invulnerable for as long as it is in there.
    // It comes back out — and the flag with it — through detachBuilder: on completion, on a
    // cancelled build, or when the half-built structure dies under it.
    if (u.insideBuild) u.invulnerable = true;
    // Item attribute contribution (shown as green "+N" / red "-N" beside the stat).
    u.bonusStr = item.str;
    u.bonusAgi = item.agi;
    u.bonusInt = item.int;
  }

  /** This unit's Root ability (`Aroo`), or undefined for everything that is not an Ancient.
   *  Aro1/Aro2 are aliases of the same base code, which is what lets one lookup serve the
   *  Ancients, the three Tree of Life tiers and the Ancient Protector alike. */
  private rootAbility(u: SimUnit): SimAbility | undefined {
    return u.abilities.find((a) => a.code === "Aroo" && a.level >= 1);
  }

  /**
   * Root / Unroot (`Aroo`) — an Ancient pulling itself out of the ground, or planting again.
   * `Order=root` / `Unorder=unroot` in NightElfAbilityFunc: one ability, two directions, which
   * is why this toggles rather than taking a direction.
   *
   * Almost everything about the two states is derived in recomputeStats (the walk speed and
   * the live weapon slot both fall out of `uprooted`). What CANNOT be derived is the physical
   * transition, which is the only reason this method exists: a rooted Ancient occupies its
   * cells and an uprooted one must not, or it would collide with the hole it left behind.
   *
   * Rooting refuses if the Ancient no longer fits where it stands — it may have walked onto
   * ground too tight for its footprint, and a building that plants itself inside a wall is
   * worse than one that refuses to plant. Returns whether the toggle happened, so a caller
   * can tell a refusal from a no-op.
   *
   * `site` is the spot a `{kind:"rootat"}` order picked (tickRootAt). The Ancient does not jump
   * onto it: the leftover stretch of the walk, and the turn back to `builtFacing`, are played
   * out across the transition itself — see SimUnit.rootSettle. Without a site (the plain
   * toggle) the Ancient plants where it stands, on the same terms.
   */
  toggleRoot(u: SimUnit, site?: { x: number; y: number }): boolean {
    const root = this.rootAbility(u);
    if (!root) return false;
    if (!this.canToggleRoot(u)) return false;
    let planted: { x0: number; y0: number; f0: number; x1: number; y1: number } | null = null;
    if (u.uprooted) {
      // The pose the walk left it in, kept before anything below moves it: the settle
      // interpolates OUT of this and into the building's own place and facing.
      const x0 = u.x;
      const y0 = u.y;
      const f0 = u.facing;
      if (site) {
        u.x = site.x;
        u.y = site.y;
      }
      // Planting. Stand still and LET GO of the walker's cells before asking whether the
      // building fits, in that order: an uprooted Ancient holds a mover's reservation (and,
      // mid-step, a claim on the tile ahead), and asking `footprintFits` while it still holds
      // them is asking whether it can plant in a spot that it is itself standing in. The
      // answer is no, every time — which is why an Ancient ordered to root while it was
      // walking simply kept walking.
      const n = u.rootedFootprint;
      this.stop(u.id); // drop any walk/target — it is a building again
      this.unsettle(u);
      this.releaseClaim(u);
      const fp = u.rootedStamp;
      if (fp && this.grid) {
        // The real question is whether the BUILDING footprint fits — `Ancient of War` blocks a
        // 12×12 pathing square, not the 4-cell body it walks around with — so it is that
        // stamp, lifted when it uprooted, that has to be offered the ground again.
        const [ax, ay] = this.grid.snapForBuildingRect(u.x, u.y, fp.w, fp.h);
        if (!footprintBuildable(this.grid, fp, ax, ay)) {
          u.x = x0; // it stays a walker, so it stays where the walk left it
          u.y = y0;
          this.settle(u); // genuinely too tight — take the walker's cell back
          return false;
        }
        // WC3 plants an Ancient on the BUILD grid, exactly where a fresh one would go, so it
        // ends up aligned with everything else rather than half a cell off wherever it stopped.
        u.x = ax;
        u.y = ay;
        stampFootprint(this.grid, fp, ax, ay);
        u.pathStamp = { fp, x: ax, y: ay };
        u.rootedStamp = null;
      } else if (n > 0 && this.grid) {
        const [cx, cy] = this.grid.footprintAnchor(u.x, u.y, n);
        if (!this.grid.footprintFits(cx, cy, n)) {
          u.x = x0;
          u.y = y0;
          this.settle(u);
          return false;
        }
      }
      u.uprooted = false;
      u.footprint = n;
      u.rootedFootprint = 0;
      // Square with the rest of the base again. A building has ONE facing in WC3 (blizzard.j's
      // `bj_UNIT_FACING`, 270°), so an Ancient that settles keeps none of the direction it
      // happened to be walking in — it turns back to the angle it was raised at.
      //
      // It TURNS back to it, though, rather than being stood in it: the root animation is 2.5
      // seconds of a tree lowering itself onto a spot, and a facing that changed on the frame
      // the button was pressed made it play that whole gesture already square. So the pose the
      // walk left it in is handed to the settle below and interpolated across the transition,
      // which is also what closes the last stride onto the site.
      u.desiredFacing = u.builtFacing;
      this.settle(u); // stamp its cells and snap onto the grid
      // …and settle() may have nudged it off the site to a free tile; the gesture ends wherever
      // the unit actually is, so read the destination back rather than assuming the site.
      planted = { x0, y0, f0, x1: u.x, y1: u.y };
    } else {
      u.uprooted = true;
      this.unsettle(u); // free the cells before it can take a step out of them
      // …and lift the BUILDING footprint with them. This is the one that matters: a structure's
      // 12×12 block is stamped straight onto the grid (setPathStamp) and is not part of the
      // reservation system at all, so an Ancient that kept it walked around inside its own
      // wall — every path out failed, and planting again was refused by the hole it had left.
      if (u.pathStamp) {
        u.rootedStamp = u.pathStamp.fp;
        this.releasePathStamp(u);
      }
      // Put the building footprint away for the walk. A stamped n×n block is an obstacle the
      // pathfinder routes AROUND, so an Ancient that kept its 4×4 while walking would be
      // permanently boxed in by itself — pathTo fails on the first step and the thing just
      // stands there having visibly pulled its roots up. Walking, it collides by radius like
      // every other mobile unit; the footprint comes back when it plants.
      u.rootedFootprint = u.footprint;
      u.footprint = 0;
      // Whatever it was building keeps its place in the queue: WC3 halts an uprooted
      // Ancient's production rather than cancelling it (see tickBuildings).
      //
      // The gold mine, though, is let go outright. `Aent`'s roots are the TREE's — a Tree of
      // Life that pulls itself out of the ground takes them with it — so the Entangled Gold
      // Mine collapses, the Wisps working it walk out, and the plain mine is a plain mine
      // again, minable by anybody. It is not given back when the Tree plants: entangling is
      // a button you press.
      this.releaseEntangledMine(u);
    }
    // Neither thing for the length of the transition. `Dur1` is the ability's own 2.5 seconds
    // and the models author the pair of clips for it; see SimUnit.morphT for why the stance
    // flips first and the LOCK follows rather than the other way round.
    const lvl = this.abilities?.get(root.id)?.levelData[0];
    u.morphT = lvl && lvl.duration > 0 ? lvl.duration : ROOT_MORPH_TIME;
    // A plant spends that same clock walking the last stretch onto the site and turning square
    // (tickRootSettle). Uprooting has nothing to interpolate — the Ancient hauls itself up
    // exactly where it stood — so it clears the gesture instead.
    u.rootSettle = planted ? { ...planted, dur: u.morphT } : null;
    // Stand it back in the pose the walk left it in right now, on the same tick the stance
    // flipped. The plant above put the unit ON its site so the footprint could be stamped and
    // reserved there; without this the tree would be drawn on the site for one frame and then
    // step back to where it was walking from, which is the very jump this replaces.
    this.tickRootSettle(u);
    this.recomputeStats(u);
    return true;
  }

  /** Play out a planting Ancient's settle: the last stretch of the walk onto the site, and the
   *  turn back to the facing it was raised at, spread across the root transition (`morphT`)
   *  instead of applied the instant the stance flipped. See SimUnit.rootSettle.
   *
   *  Both ends are pinned so the transition cannot leave a building half-way anywhere: it ends
   *  ON the site, facing `builtFacing`, whatever the clock did. */
  private tickRootSettle(u: SimUnit): void {
    const s = u.rootSettle;
    if (!s) return;
    if (u.morphT <= 0 || s.dur <= 0) {
      u.x = s.x1;
      u.y = s.y1;
      u.facing = u.builtFacing;
      u.desiredFacing = u.builtFacing;
      u.rootSettle = null;
      return;
    }
    const k = Math.min(1, Math.max(0, 1 - u.morphT / s.dur)); // 0 → 1 across the transition
    u.x = s.x0 + (s.x1 - s.x0) * k;
    u.y = s.y0 + (s.y1 - s.y0) * k;
    // The short way round, like every other turn in the sim (turnToward) — but at the turn's
    // own pace rather than the settle's (ROOT_TURN_SPEEDUP), so the tree is square with the
    // base well before the clip ends instead of rotating all the way into the ground.
    u.facing = s.f0 + angleDiff(s.f0, u.builtFacing) * Math.min(1, k * ROOT_TURN_SPEEDUP);
    u.desiredFacing = u.facing; // …so the shared turning pass has nothing to add on top
  }

  /**
   * May this Ancient change stance right now? A [Errors] key when it may not, null when it may.
   *
   * Two reasons it may not, and the second is the one players feel: an Ancient in the middle of
   * TRAINING or RESEARCHING cannot pull itself up — the queue would have nowhere to go — so WC3
   * greys the Uproot button out for as long as anything is in it. (Which is the mirror of the
   * rule that a walking Ancient's queue is halted rather than cancelled: the halt only has to
   * cover work that was already under way when it left the ground.) The other is the transition
   * itself: it takes 2.5 seconds and cannot be interrupted by pressing the button again.
   */
  rootRefusal(u: SimUnit): string | null {
    if (!this.rootAbility(u)) return "Notthisunit";
    if (u.morphT > 0) return SILENT_REFUSAL; // mid-transition; the button is inert, not wrong
    if (!u.uprooted && u.building && u.building.queue.length > 0) return SILENT_REFUSAL;
    return null;
  }

  private canToggleRoot(u: SimUnit): boolean {
    return this.rootRefusal(u) === null;
  }

  /** Defend (Adef), when the unit is actually braced: the ability's level data, else null.
   *
   *  WC3 models Defend as an ORDER PAIR — `Order=defend` / `Unorder=undefend` in
   *  HumanAbilityFunc.txt — which is the same on/off shape as an autocast toggle, so it rides
   *  the autocast flag rather than inventing a second toggle mechanism. (tickAutocast only ever
   *  fires `target: "unit"` abilities, so nothing tries to auto-cast it at anybody.)
   *
   *  The research gate is checked HERE and not merely on the button: an ability the player has
   *  not researched must not do anything even if a trigger or a stale toggle switched it on. */
  private defendStance(u: SimUnit): AbilityLevel | null {
    const ab = u.abilities.find((a) => a.code === "Adef" && a.level >= 1 && a.autocastOn);
    if (!ab || !this.abilities) return null;
    if (this.tech && !this.tech.meets(u.owner, ab.id)) return null; // Rhde not researched
    const def = this.abilities.get(ab.id);
    return def?.levelData[0] ?? null;
  }

  /** The level-data for a passive ability the unit has learned (by base code), or
   *  null. Shared by passive-effect derivations (Spiked Carapace, Critical Strike,
   *  Evasion, Cleaving Attack).
   *
   *  An ability a hero CARRIES counts exactly as one it learned. That is the whole of what
   *  a passive item is in WC3: the Talisman of Evasion's `AIev` is `code = AEev`, the Demon
   *  Hunter's own Evasion, and Searing Blade's `AIcs` is `code = AOcr`, the Blademaster's
   *  Critical Strike — same row shape, same columns, same handler. Looking only at
   *  `u.abilities` here is what silently switched every passive item in the game off (issue
   *  #130): the item was carried, its ability was loaded, and nothing ever asked it. */
  private passiveLevelData(u: SimUnit, code: string): AbilityLevel | null {
    if (!this.abilities) return null;
    const ab = u.abilities.find((a) => a.code === code && a.level >= 1);
    if (!ab) return this.itemAbilityLevel(u, code);
    const def = this.abilities.get(ab.id);
    if (!def) return null;
    return def.levelData[Math.min(ab.level, def.levelData.length) - 1] ?? null;
  }

  /** The def + level-data of the first ability in `u`'s INVENTORY whose base `code` matches
   *  — the item half of passiveLevelData, split out because a few callers want the def too
   *  (an item's Bash reaches for its own buff art the way the Mountain King's does).
   *
   *  Items have no ranks: every item ability row is `levels = 1`, so level 1 is the only
   *  level there is. Slot order decides which of two copies answers, which is the same rule
   *  the orbs already use (src/sim/orbs.ts) — WC3 does not stack two Talismans of Evasion. */
  private itemAbility(u: SimUnit, code: string): { def: AbilityDef; level: AbilityLevel } | null {
    if (!u.inventory.length || !this.itemReg || !this.abilities) return null;
    for (const held of u.inventory) {
      if (!held) continue;
      const item = this.itemReg.get(held.itemId);
      if (!item) continue;
      for (const abilId of item.abilities) {
        const def = this.abilities.get(abilId);
        const level = def?.levelData[0];
        if (def && def.code === code && level) return { def, level };
      }
    }
    return null;
  }

  /** …and just its numbers, for the derivations that need nothing else. */
  private itemAbilityLevel(u: SimUnit, code: string): AbilityLevel | null {
    return this.itemAbility(u, code)?.level ?? null;
  }

  /** Read dataX (a=0..i=8) off an ability level, NaN-safe. */
  private dataOf(lvl: AbilityLevel, i: number, fallback = 0): number {
    const v = lvl.data[i];
    return v === undefined || Number.isNaN(v) ? fallback : v;
  }

  /** Advance timed buffs; apply DoT/HoT. Returns true if the unit died (DoT). */
  private tickBuffs(u: SimUnit, dt: number): boolean {
    if (!u.buffs.length) return false;
    for (const b of u.buffs) {
      // `delay` gates a heal-over-time the same way it gates Wind Walk's fade: the buff is
      // already on the unit and its clock is already running, the healing just hasn't
      // engaged yet. Only the Staff of Sanctuary sets one (its "Hero/Unit Regeneration
      // Delay", 1s and 5s) — every other hot lands with delay 0 and is unaffected.
      if (b.kind === "hot" && b.value && b.delay <= 0) u.hp = Math.min(u.maxHp, u.hp + b.value * dt);
      // A non-lethal dot (every poison) whittles and stops: it may take the last point off
      // a unit's health bar's worth of hp but never the last point itself.
      else if (b.kind === "dot" && b.value) u.hp = b.nonLethal ? Math.max(1, u.hp - b.value * dt) : u.hp - b.value * dt;
      if (b.delay > 0) b.delay -= dt; // Wind Walk's Transition Time, counting down to the vanish
      b.timeLeft -= dt;
      // Sanctuary ends on the health bar, not on a clock. Checked AFTER this tick's healing
      // so the pass that tops the unit up is also the pass that drops the stun with it —
      // the caller recomputes stats straight after this, so the unit acts again the same tick.
      if (b.untilHealed && u.hp >= u.maxHp) b.timeLeft = 0;
    }
    u.buffs = u.buffs.filter((b) => b.timeLeft > 0);
    if (u.hp <= 0) {
      this.kill(u);
      return true;
    }
    return false;
  }

  /** Lightning Shield (Alsh): the shielded unit itself is unharmed, but every OTHER unit
   *  within the buff's radius takes `value` dps (spell damage, bypasses armor) — friend or
   *  foe, which is why it's cast on an enemy (or an expendable own unit). */
  private tickLightningShields(dt: number): void {
    // Snapshot holders first — a shield can kill units (including other holders) mid-pass.
    const shields = [];
    for (const u of this.units.values()) {
      for (const b of u.buffs) {
        if (b.kind === "shield" && b.value > 0) shields.push({ holder: u, dps: b.value, radius: b.value2 || 160, killerId: b.sourceId });
      }
    }
    for (const s of shields) {
      if (s.holder.hp <= 0) continue;
      for (const t of this.unitsInAreaInternal(s.holder.x, s.holder.y, s.radius)) {
        if (t === s.holder || t.hp <= 0 || t.building || t.invulnerable) continue;
        t.hp -= s.dps * dt; // spell damage — no armor reduction
        if (t.hp <= 0) this.kill(t, s.killerId);
      }
    }
  }

  // === Moon Well: Replenish Mana and Life (`Ambt`, "Mana Battery") =====================
  //
  // The Moon Well is a battery, and that word is the ability's own comment in AbilityData.
  // It holds 300 mana (`emow` manaN), it only refills after dark ("Regenerates mana at
  // night", NightElfUnitStrings [emow]), and it pours what it has into whoever needs it:
  //
  //   DataA1 = 2    hit points per point of the WELL's mana
  //   DataB1 = 0.5  mana per point of the well's mana
  //   DataC1 = 10   unspent — see below
  //   Area1  = 400  how close the drinker has to be
  //
  // The drink is a BURST, not a trickle. A unit sent to a Moon Well walks up, flashes, and its
  // bars jump in one step while the well's mana drops by what that cost — it takes everything
  // it can use in one go, and stops early only when the well runs dry. That is what the game
  // shows and what a night elf player counts on (you know at a glance whether a well has
  // another unit's worth left in it), so DataC1 stays unread rather than metering the pour out
  // over ten mana a second: measured against the real client, nothing about the transfer is
  // gradual. It IS still bounded by the drinker's need and by the well — see the spend below.
  //
  // The split between the two is the part no column states and every night elf player knows:
  // "if a unit that has mana uses the Moon Well, it will partition half of its mana for life,
  // and the other half for mana… if the well has 100 mana, it can replenish 100 health and 25
  // mana" — and the half whose need is already met SPILLS into the other half rather than
  // being wasted (Warcraft Wiki / GameFAQs, worked example). That is what the spend below
  // reproduces, and it is why a full-health hero drinks a well dry into mana alone.
  //
  // Rng1 = 99999 is deliberately NOT used as a range. A range of "the whole map" is the
  // engine's way of never refusing the order; what actually bounds the drink is Area1, and
  // treating the 99999 as real would let a well heal across the map.
  //
  // DataE1 = 1 is unspent. It is the one column that differs from the Obsidian Statue's
  // otherwise identical `Amb2` (which is 0) in the same place the two units differ — the
  // statue refills its mana at any hour and the well does not — so "night-only regeneration"
  // is the obvious reading, but obvious is not verified, and the well's night rule is already
  // carried by its own row (see tickRegen). DataD1 = 30 vs the statue's -1 is likewise unread.

  /**
   * Does this building take a RALLY POINT right now?
   *
   * "Produces units" is most of it — a tower or a farm has nothing to send anywhere — but an
   * UPROOTED Ancient is the exception that has to be named, and naming it here is what keeps
   * every asker in step: the rally flag, the rally button, the hero-portrait rally and, above
   * all, the plain right-click. While an Ancient walks it is a unit, its queue is halted, and
   * a right-click on the ground has to mean "go there" — reading `producesUnits` alone left it
   * planting rally flags and refusing to move.
   */
  acceptsRally(id: number): boolean {
    const u = this.units.get(id);
    return !!u?.building?.producesUnits && !u.uprooted;
  }

  /** Is this a FINISHED Moon Well (or Obsidian Statue — same `Ambt` family) that units can be
   *  sent to drink from? Public because the right-click has to ask before it decides what a
   *  click on a friendly building means. Whether a given unit may actually drink is
   *  `issueDrink`'s question, not this one. */
  isReplenisher(unitId: number): boolean {
    const u = this.units.get(unitId);
    if (!u || u.hp <= 0 || (u.building && u.building.constructionLeft > 0)) return false;
    return !!this.replenishAbility(u);
  }

  /** This unit's Replenish row (`Ambt`), or undefined for everything that is not a battery. */
  private replenishAbility(u: SimUnit): AbilityDef | undefined {
    const ab = u.abilities.find((a) => a.code === "Ambt" && a.level >= 1);
    return ab && this.abilities ? this.abilities.get(ab.id) : undefined;
  }

  /** One well's worth of pouring: find whoever is drinking and empty into them.
   *
   *  Three ways a drinker is chosen, in the order the player's intent runs: the unit the well
   *  was aimed at by hand (`Ambt` cast from its own card, or by a trigger), then anyone who was
   *  RIGHT-CLICKED onto this well and has since arrived, then — only with autocast on — the
   *  neediest friendly standing nearby. */
  private tickReplenish(u: SimUnit): void {
    const ab = u.abilities.find((a) => a.code === "Ambt" && a.level >= 1);
    if (!ab) return;
    const def = this.abilities?.get(ab.id);
    const lvl = def?.levelData[0];
    if (!def || !lvl) return;
    // A well still going up holds no mana and pours nothing (see recomputeStats' mana0 rule).
    if (u.mana <= 0 || u.paused || u.stunned || (u.building && u.building.constructionLeft > 0)) return;
    const area = lvl.area || 400;
    // A unit ORDERED to drink from a well across the map keeps the order and gets nothing
    // until it walks in — which is what a cast range of 99999 with an Area of 400 means.
    const reached = (t: SimUnit): boolean => Math.hypot(t.x - u.x, t.y - u.y) - t.radius <= area;
    let t = u.replenishTargetId ? this.units.get(u.replenishTargetId) : undefined;
    if (t && !this.replenishWants(u, t, def)) t = undefined;
    u.replenishTargetId = t?.id ?? 0;
    if (t && !reached(t)) return; // still on its way — hold the aim, pour nothing
    if (!t) t = this.replenishSent(u, def, area);
    if (!t && ab.autocastOn) t = this.replenishPick(u, def, area);
    if (!t) return;

    const hpPerMana = this.dataOf(lvl, 0, 2);
    const manaPerMana = this.dataOf(lvl, 1, 0.5);
    // What each half of the spend could absorb, in WELL mana rather than in the drinker's
    // units — so the two are comparable and the leftover of one can be handed to the other.
    const lifeCap = hpPerMana > 0 ? (t.maxHp - t.hp) / hpPerMana : 0;
    const manaCap = manaPerMana > 0 && t.maxMana > 0 ? (t.maxMana - t.mana) / manaPerMana : 0;
    // Everything the drinker can use, or everything the well has left — whichever runs out
    // first. That is the whole of "drink": one step, no rate.
    const spend = Math.min(u.mana, lifeCap + manaCap);
    let toLife = Math.min(spend / 2, lifeCap);
    let toMana = Math.min(spend / 2, manaCap);
    const spare = spend - toLife - toMana; // the half that had nowhere to go
    if (spare > 0) {
      const moreLife = Math.min(spare, lifeCap - toLife);
      toLife += moreLife;
      toMana = Math.min(manaCap, toMana + (spare - moreLife));
    }
    const used = toLife + toMana;
    // The order is spent whether or not there was anything left to pour: a unit that walked
    // to a dry well has had its drink, and standing there waiting for nightfall is not it.
    t.drinkWellId = 0;
    u.replenishTargetId = 0;
    if (used <= 0) return;
    u.mana -= used;
    t.hp = Math.min(t.maxHp, t.hp + toLife * hpPerMana);
    t.mana = Math.min(t.maxMana, t.mana + toMana * manaPerMana);
    // Two one-shot models, each where it belongs: `Casterart` on the well (MoonWellCasterArt
    // — the surface stirring) and `Specialart` — which for `Ambt` is the Priest's own
    // `Heal\HealTarget.mdl` — on the drinker, carrying the heal sound that lives beside it in
    // its folder (Abilities\Spells\Human\Heal\HealTarget.wav). See NightElfAbilityFunc [Ambt].
    //
    // `Effectart` is deliberately NOT among them. Despite sitting on the same row it is not a
    // cast effect at all: it is the WATER standing in the well, a persistent model whose level
    // is the well's mana, and it belongs to the building for as long as the building lives
    // (renderer, collectMoonWellWater). Playing it here threw the water at the drinker and let
    // it evaporate a few seconds later.
    if (def.casterArt) this.spellEffects.push({ art: def.casterArt, x: u.x, y: u.y, targetId: u.id, z: 0 });
    if (def.specialArt) this.spellEffects.push({ art: def.specialArt, x: t.x, y: t.y, targetId: t.id, z: 0, sound: true });
  }

  /** The nearest unit that was SENT to this well and has arrived (`{kind:"drink"}`). */
  private replenishSent(u: SimUnit, def: AbilityDef, area: number): SimUnit | undefined {
    let best: SimUnit | undefined;
    let bestD = Infinity;
    for (const t of this.unitsInAreaInternal(u.x, u.y, area)) {
      if (t.drinkWellId !== u.id) continue;
      // Arrived with nothing left to gain (it healed on the way, or the well is the wrong
      // kind for it): the order is simply finished.
      if (!this.replenishWants(u, t, def)) {
        t.drinkWellId = 0;
        continue;
      }
      const d = Math.hypot(t.x - u.x, t.y - u.y);
      if (d >= bestD) continue;
      bestD = d;
      best = t;
    }
    return best;
  }

  /** Is `t` still worth pouring into? Alive, allied, short of something, and allowed by the
   *  ability's own Targets Allowed (which is where `organic` keeps machines out). Range is
   *  deliberately NOT part of it — see the caller. */
  private replenishWants(u: SimUnit, t: SimUnit, def: AbilityDef): boolean {
    if (t.hp <= 0 || t.building) return false;
    if (!this.allied(u, t)) return false;
    if (t.hp >= t.maxHp && t.mana >= t.maxMana) return false;
    return this.targetError(u, t, def.targetFlags, def.code) === null;
  }

  /** The most-wounded valid drinker in range — same "worst off first" rule the other
   *  friendly autocasts use (autocastTarget), but scored on the WHOLE deficit, since a hero
   *  at full health with an empty mana bar is exactly who a Moon Well is for. */
  private replenishPick(u: SimUnit, def: AbilityDef, area: number): SimUnit | undefined {
    let best: SimUnit | undefined;
    let bestFrac = 1;
    for (const t of this.unitsInAreaInternal(u.x, u.y, area)) {
      if (!this.replenishWants(u, t, def)) continue;
      const frac = t.maxMana > 0 ? (t.hp / t.maxHp + t.mana / t.maxMana) / 2 : t.hp / t.maxHp;
      if (frac < bestFrac) {
        bestFrac = frac;
        best = t;
      }
    }
    return best;
  }

  // === Renew (`Aren`) — the Wisp's repair ==============================================
  //
  // Repair is one ability with four skins: `Ahrp` (Repair), `Arep` (Repair, orc), `Arst`
  // (Restoration) and `Aren` (Renew) all share the `Arep` code and the same two numbers —
  // Rep1 "Repair Cost Ratio" 0.35 and Rep2 "Repair Time Ratio" 1.5, i.e. a third of the
  // building's price over half again its build time (Liquipedia lists both on Renew's own
  // card). So Renew costs and takes exactly what a Peasant's hammer does, and none of that
  // needs restating here.
  //
  // What IS Renew's own is its Targets Allowed. Every other race's repair lists `nonancient`;
  // Renew does not — which is the whole point, because half the night elf's buildings ARE
  // Ancients and nothing else could mend them. That is `repairRefusal`, below: the flag is
  // real, so an allied Peasant walked up to an Ancient of War is turned away by the data
  // rather than by a special case.
  //
  // The other difference is that it AUTOCASTS (Orderon/Orderoff `renewon`/`renewoff`), which
  // the generic autocast tick cannot do for it: that path issues a CAST, and repair is a job
  // that runs for as long as the building is hurt. Hence a tick of its own.

  /** The repair ability a worker carries (`Arep` code — Repair / Restoration / Renew), or
   *  undefined for a worker that cannot mend anything (the Acolyte, the Ghoul). */
  private repairAbility(u: SimUnit): SimAbility | undefined {
    return u.abilities.find((a) => isRepairCode(a.code) && a.level >= 1);
  }

  /** Why `worker` may not repair `target`, in the game's own [Errors] key, or null if it may.
   *  A worker whose type ships no repair ability at all is refused outright. */
  repairRefusal(workerId: number, buildingId: number): string | null {
    const w = this.units.get(workerId);
    const b = this.units.get(buildingId);
    if (!w || !b) return "Cantrepair";
    const ab = this.repairAbility(w);
    // No repair row on the type: nothing to check the target against, and nothing to do the
    // repairing. (Kept permissive for a bare test/sim world with no ability registry.)
    if (!ab || !this.abilities) return this.abilities ? "Cantrepair" : null;
    const def = this.abilities.get(ab.id);
    if (!def) return null;
    return this.targetError(w, b, def.targetFlags, def.code);
  }

  /** Autocast Renew: an idle Wisp with the toggle on walks to the nearest damaged friendly
   *  building in its acquisition range and mends it. The rates are the same ones the manual
   *  order uses, derived here from the target's own build cost and time (Rep1 / Rep2).
   *
   *  Gated on IDLE deliberately. A wisp gathering lumber, growing a building or sitting in a
   *  gold mine has a job, and an autocast that pulled workers off the economy every time a
   *  tower took a hit would be a worse ability than none. */
  private tickRenew(u: SimUnit): void {
    const ab = u.abilities.find((a) => isRepairCode(a.code) && a.level >= 1 && a.autocastOn);
    if (!ab || !u.worker || u.order !== "idle") return;
    if (u.repair || u.constructing || u.buildPending || u.inMine || u.inBurrow || u.insideBuild) return;
    const range = Math.max(u.weapon?.acquire ?? 0, RENEW_SEEK_RANGE);
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const b of this.units.values()) {
      if (!b.building || b.building.constructionLeft > 0 || b.hp <= 0 || b.hp >= b.maxHp) continue;
      if (!this.allied(u, b)) continue;
      const d = Math.hypot(b.x - u.x, b.y - u.y);
      if (d > range || d >= bestD) continue;
      if (this.repairRefusal(u.id, b.id) !== null) continue;
      bestD = d;
      best = b;
    }
    if (!best) return;
    const r = this.repairRates(u.id, best.id);
    if (r) this.issueRepair(u.id, best.id, r.hpPerSec, r.goldPerHp, r.lumberPerHp);
  }

  /**
   * What one worker mending one building costs and how fast it goes — **the one place** the
   * rates are derived, shared by the ordered repair (authority.ts) and by Renew's autocast
   * above, which used to each carry their own copy of the arithmetic and disagree about it.
   *
   * Both halves come from data rather than from a rule:
   *
   *   • The BASIS is the target's own `goldRep` / `lumberRep` / `reptm` — "Stats - Repair
   *     Gold Cost / Lumber Cost / Time". Substituting the BUILD cost and time (which is what
   *     both call sites did) is right for a from-scratch structure and wrong for every
   *     upgraded tier: a Keep, Castle, Stronghold and Fortress each repair in 120 seconds
   *     having been built in 140, and a Scout Tower repairs in 20 having been built in 25.
   *   • The RATIO is the repair ABILITY's, per level — `Arep`/`Aren` DataA = 0.35 of the
   *     cost, DataB = 1.5 of the time. It is a per-ability number, not a constant of the
   *     game, which is why it is read off the worker's own row.
   *
   * Null when the worker cannot mend that target at all (see repairRefusal).
   */
  repairRates(workerId: number, buildingId: number): { hpPerSec: number; goldPerHp: number; lumberPerHp: number } | null {
    const w = this.units.get(workerId);
    const b = this.units.get(buildingId);
    if (!w || !b || this.repairRefusal(workerId, buildingId) !== null) return null;
    const def = this.unitReg?.get(b.typeId);
    const maxHp = Math.max(1, b.maxHp);
    const lvl = this.abilities?.get(this.repairAbility(w)?.id ?? "")?.levelData[0];
    const costRatio = lvl ? this.dataOf(lvl, 0, REPAIR_COST_RATIO) : REPAIR_COST_RATIO;
    const timeRatio = lvl ? this.dataOf(lvl, 1, REPAIR_TIME_RATIO) : REPAIR_TIME_RATIO;
    // `|| 60` is the same guard both call sites already carried: a type with no repair time
    // at all (a map's own building that states none) still has to mend in FINITE time.
    const secs = Math.max(1, (def?.repairTime || def?.buildTime || 60) * timeRatio);
    return {
      hpPerSec: maxHp / secs,
      goldPerHp: ((def?.goldRep ?? 0) * costRatio) / maxHp,
      lumberPerHp: ((def?.lumberRep ?? 0) * costRatio) / maxHp,
    };
  }

  /** Witch Doctor wards, ticked off their own data. Only the Stasis Trap (`otot`) needs a
   *  tick of its own: it detonates when an enemy land unit enters its trigger radius,
   *  stunning enemies around it, then is consumed.
   *
   *  The Healing Ward used to be here too, as a hand-rolled "heal allied non-mechanical
   *  units in range by a % of max HP/sec". That is a description of an AURA, and `Aoar` IS
   *  one — the same row the Fountain of Health carries (`ACnr`). It moved into AURA_BUFFS
   *  with the fountains, which is where the radius, the percentage and the `organic` rule
   *  now all come from the data instead of from a copy of it. Sentry Ward needs nothing at
   *  all — an owned unit reveals fog on its own. */
  private tickWards(): void {
    for (const u of this.units.values()) {
      if (!u.isSummon || u.hp <= 0) continue;
      const def = this.unitReg?.get(u.typeId);
      if (!def) continue;
      // Stasis Trap — otot: arm until an enemy land unit steps into the trigger radius, then
      // stun every enemy land unit in the (larger) blast radius and consume the trap.
      if (u.typeId === "otot") {
        const astaDef = this.abilities?.get("Asta");
        const asta = astaDef?.levelData[0];
        const trig = asta ? this.dataOf(asta, 1, 250) : 250; // dataB — trigger radius
        const blast = asta ? this.dataOf(asta, 2, 400) : 400; // dataC — stun radius
        const stunDur = asta ? this.dataOf(asta, 3, 6) : 6; // dataD — stun duration
        const armed = this.unitsInAreaInternal(u.x, u.y, trig).some((e) => e.hp > 0 && !e.flying && !e.building && this.hostile(u, e));
        if (armed) {
          // Bsta, Stasis Trap's own buff, wears the same overhead stun swirl as BPSE.
          const stunFx = astaDef ? fx(astaDef) : undefined;
          for (const e of this.unitsInAreaInternal(u.x, u.y, blast)) {
            if (e.hp > 0 && !e.flying && !e.building && this.hostile(u, e)) this.applyBuffInternal(e, { kind: "stun", timeLeft: stunDur, sourceId: u.id, ...stunFx });
          }
          this.removeUnit(u.id); // trap consumed
        }
      }
    }
  }

  /** Kodo Devour: swallow an enemy land non-hero unit — it vanishes inside the Kodo (hidden,
   *  reserving no cells) and is digested. A Kodo holds only one at a time. */
  private devourInternal(kodo: SimUnit, prey: SimUnit): void {
    if (kodo.devouring > 0 || prey.devouredBy > 0 || prey.hp <= 0) return;
    this.unsettle(prey); // no cell block while inside
    this.cancelSwing(prey);
    prey.devouredBy = kodo.id;
    prey.order = "idle";
    prey.moving = false;
    prey.path = [];
    prey.targetId = null;
    prey.noCollision = false;
    kodo.devouring = prey.id;
  }

  /** Digest each swallowed unit at the Kodo's Devour dps; a fully-digested unit dies. */
  private tickDevour(dt: number): void {
    for (const u of this.units.values()) {
      if (u.devouring <= 0) continue;
      const prey = this.units.get(u.devouring);
      if (!prey || prey.hp <= 0) { u.devouring = 0; continue; }
      const lvl = this.passiveLevelData(u, "Adev");
      prey.hp -= (lvl ? this.dataOf(lvl, 0, 5) : 5) * dt; // dataA — digest damage/sec
      if (prey.hp <= 0) { u.devouring = 0; this.kill(prey, u.id); }
    }
  }

  /** Spit a swallowed unit back out beside the Kodo (the Kodo died mid-digest). */
  private freePrey(prey: SimUnit, kodo: SimUnit): void {
    prey.devouredBy = 0;
    const [cx, cy] = this.grid.worldToCell(kodo.x, kodo.y);
    const fit = this.grid.nearestWalkable(cx, cy, 6);
    if (fit) [prey.x, prey.y] = this.grid.cellToWorld(fit[0], fit[1]);
    prey.order = "idle";
    prey.moving = false;
    prey.path = [];
    this.settle(prey);
  }

  private tickRegen(u: SimUnit, dt: number): void {
    // Clamped at BOTH ends, and not gated on "below full": a manaRegen buff may be NEGATIVE
    // (Siphon Mana hangs one on its victim), and a full-mana target that never ticked could
    // not be drained at all.
    if (u.maxMana > 0 && (u.mana < u.maxMana || u.manaRegen < 0)) {
      u.mana = Math.max(0, Math.min(u.maxMana, u.mana + u.manaRegen * dt));
    }
    if (u.hp <= 0) return;
    if (u.hpRegen > 0) {
      if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.hpRegen * dt);
    } else if (u.hpRegen < 0) {
      // A negative regen is a real value, not a guard to skip: the Phoenix (`hphx`) is the one
      // unit in the game that ships one — UnitBalance.slk regenHP **-25**, regenType always —
      // and burning itself down is exactly how it is meant to expire. It dies as if slain, so
      // the Blood Mage's egg/rebirth chain sees a normal death.
      u.hp += u.hpRegen * dt;
      if (u.hp <= 0) {
        u.hp = 0;
        this.kill(u);
      }
    }
  }

  /** Re-apply every active aura's buff to allies in range (short-TTL, so it fades
   *  when a unit leaves the aura). Non-stacking auras keep the strongest. */
  private applyAuras(): void {
    if (!this.abilities) return;
    for (const src of this.units.values()) {
      if (src.hp <= 0) continue;
      for (const ab of this.auraSources(src)) {
        const make = AURA_BUFFS[ab.code];
        if (!make) continue;
        const def = this.abilities.get(ab.id);
        if (!def) continue;
        const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
        const radius = lvl.area || 900;
        const effects = make(lvl);
        // Which side an aura lands on is the ability's own business, read off `targs1`, and
        // there are THREE answers, not two:
        //   • `friend` and not `enemy` — the hero auras (`air,ground,friend,self,vuln,invu`).
        //     The owner's army, which is what an aura usually means.
        //   • `enemy` and not `friend` — Disease Cloud (`ground,enemy,organic,neutral`),
        //     which afflicts the other side.
        //   • NEITHER — the fountains (`ground,air,organic,vuln,invu`). A Fountain of Health
        //     names no side because it takes none: it heals whoever stands in it, your army
        //     and the enemy's alike, which is the whole tactical point of the thing. Read as
        //     "friendly by default" it healed the neutral-passive player who owns it and
        //     nobody else, so the building sat there doing visibly nothing.
        // Whatever the side, the REST of the flags still apply — the plague takes neither a
        // flyer nor a mechanical unit, a Healing Ward mends no Siege Engine, and a fountain
        // restores nothing to one either (all three say `organic`). That is `targetAllowed`,
        // the flag list itself, and every aura runs it. The hostile case keeps the FULL
        // targetError on top, unchanged: magic immunity really does turn Disease Cloud
        // aside. The friendly and sideless cases do not, because the extra gates targetError
        // adds are all about a CAST — a corpse, invulnerability, "already at full health" —
        // and none of them is a question a fountain asks of the ground it wets.
        const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
        const hostileAura = F.has("enemy") && !F.has("friend");
        const alliedAura = F.has("friend") && !F.has("enemy");
        for (const t of this.units.values()) {
          if (t.building || t.hp <= 0) continue;
          if (hostileAura) {
            if (!this.hostile(src, t) || this.targetError(src, t, def.targetFlags, ab.code) !== null) continue;
          } else {
            if (alliedAura && t.team !== src.team) continue;
            if (this.targetAllowed(src, t, def.targetFlags) !== null) continue;
          }
          if (Math.hypot(t.x - src.x, t.y - src.y) > radius) continue;
          const ranged = !!t.weapon?.ranged;
          for (const e of effects) {
            if (e.rangedOnly && !ranged) continue; // Trueshot only helps ranged units
            if (e.meleeOnly && (ranged || !t.weapon)) continue; // Vampiric only helps melee units
            // A percentage aura's amount is the TARGET's — 1% of a Peasant's 220 life is not
            // 1% of a Mountain Giant's 1300 (see AuraEffect.pctOfMax).
            const value = e.pctOfMax ? e.value * (e.kind === "manaRegen" ? t.maxMana : t.maxHp) : e.value;
            if (e.pctOfMax && value <= 0) continue; // a unit with no mana pool gains nothing
            // An ordinary aura re-applies on a short TTL so it fades as its holder walks
            // away; one with its own `duration` (Disease Cloud) leaves something behind.
            this.applyBuffInternal(t, { kind: e.kind, group: `${ab.code}:${e.kind}`, timeLeft: e.duration ?? AURA_REFRESH, sourceId: src.id, value, value2: e.value2, buffId: buffIdOf(def, ab.level) });
          }
        }
      }
    }
  }

  /** Everything on a unit that could be broadcasting an AURA: the abilities it has learned,
   *  and the ones it is CARRYING (issue #130).
   *
   *  Fourteen items in the game are auras — Warsong Battle Drums (`AIcd` = `AOac`, Command),
   *  the Ancient Janggo of Endurance (`AIae` = `AOae`, Endurance), the Legion Doom-Horn
   *  (Unholy), Scourge Bone Chimes (Vampiric), Alleria's Flute (Trueshot), the Lion Horn of
   *  Stormwind and Bladebane Armor (Devotion), Khadgar's Pipe of Insight and the Mindstaff
   *  (Brilliance), the Thunderlizard Diamond (Lightning Shield's aura twin), the Sacred
   *  Relic, the Ancestral Staff, the Shield of Honor and the Scepter of Healing. Every one of
   *  them says "and friendly nearby units" in its own tooltip, and scanning only `abilities`
   *  here made all fourteen do nothing whatever for anybody — including their bearer.
   *
   *  An item ability has no ranks (`levels = 1`), hence level 1. */
  private *auraSources(u: SimUnit): Iterable<{ id: string; code: string; level: number }> {
    for (const ab of u.abilities) if (ab.level >= 1) yield ab;
    if (!u.inventory.length || !this.itemReg || !this.abilities) return;
    for (const held of u.inventory) {
      if (!held) continue;
      for (const abilId of this.itemReg.get(held.itemId)?.abilities ?? []) {
        const def = this.abilities.get(abilId);
        if (def && AURA_BUFFS[def.code]) yield { id: abilId, code: def.code, level: 1 };
      }
    }
  }

  /** Add/refresh a buff. Grouped buffs (auras, Inner Fire) don't stack — the
   *  strongest wins and its timer refreshes. Ungrouped buffs are independent. */
  private applyBuffInternal(u: SimUnit, init: SimBuffInit): void {
    const group = init.group ?? "";
    if (group) {
      // De-dupe per (group, kind): abilities like Avatar/Inner Fire apply an armour
      // AND a damage buff under one group — keying on group alone would drop the 2nd.
      const existing = u.buffs.find((b) => b.group === group && b.kind === init.kind);
      if (existing) {
        existing.value = Math.max(existing.value, init.value ?? 0);
        existing.value2 = Math.max(existing.value2, init.value2 ?? 0);
        existing.timeLeft = Math.max(existing.timeLeft, init.timeLeft);
        existing.sourceId = init.sourceId;
        existing.delay = init.delay ?? 0; // a re-cast restarts the transition
        if (init.art) existing.art = init.art;
        if (init.buffId) existing.buffId = init.buffId;
        return;
      }
    }
    const art = init.art ?? "";
    u.buffs.push({ kind: init.kind, group, timeLeft: init.timeLeft, sourceId: init.sourceId, value: init.value ?? 0, value2: init.value2 ?? 0, art, fx: init.fx ?? (art ? [{ path: art, attach: [] }] : []), buffId: init.buffId ?? "", delay: init.delay ?? 0, meld: init.meld, nonLethal: init.nonLethal, untilHealed: init.untilHealed, undispellable: init.undispellable });
  }

  private interruptForStun(u: SimUnit): void {
    // Pause movement WITHOUT clearing the path, so a plain move/patrol resumes when
    // the stun ends (settle() would wipe the path and strand the unit on "move",
    // which has no per-tick handler to restart it). Casting is fully interrupted.
    u.moving = false;
    u.inCombat = false;
    this.cancelSwing(u);
    if (u.order === "cast") {
      this.clearCast(u); // interrupted mid-cast → SPELL_ENDCAST
      u.order = "idle";
    }
  }

  /** Bash (Mountain King passive AHbh): roll whether THIS swing bashes.
   *
   *  The Data columns are named by AbilityMetaData.slk's Hbh1..5 rows (resolved through
   *  WorldEditStrings): dataA "Chance to Bash", dataB "Damage Multiplier", dataC "Damage
   *  Bonus", dataD "Chance to Miss". dataA is a PERCENT — Hbh1 carries maxVal=100 and
   *  AHbh stores 20/30/40, the 20/30/40% the Ubertip quotes — so it needs /100, exactly
   *  like Critical Strike's dataA. (This used to read dataB, which is 0 at every rank:
   *  Bash simply never fired.) */
  private rollBash(u: SimUnit): boolean {
    const lvl = this.passiveLevelData(u, "AHbh");
    if (!lvl) return false;
    return this.rng() < this.dataOf(lvl, 0, 20) / 100; // dataA — "Chance to Bash" (%)
  }

  /** Spend a rolled Bash at the blow: stun the target for Dur (HeroDur against a hero).
   *  The bonus damage is added to the swing itself in dealDamage, not here — it is attack
   *  damage and must go through the target's armour like the rest of the strike. */
  private applyBash(attacker: SimUnit, target: SimUnit): void {
    if (!this.abilities || target.invulnerable || target.hp <= 0) return;
    // Learned first, then CARRIED — the Rusty Mining Pick's `AIbx` is `code = AHbh` with the
    // same columns (15% for 25 damage and a 2s stun), so it wants the same lookup and the
    // same buff art rather than a second copy of this method.
    const ab = this.findAbility(attacker, "AHbh");
    const def = (ab && this.abilities.get(ab.id)) || this.itemAbility(attacker, "AHbh")?.def;
    const lvl = this.passiveLevelData(attacker, "AHbh");
    if (!def || !lvl) return;
    // Dur1=2 / HeroDur1=1 — the game gives heroes their own, shorter stun rather than
    // clamping the normal one. `group` is the ability code so a second bash REFRESHES the
    // stun instead of stacking a pile of independent 2s buffs on the same victim.
    const stunDur = target.isHero ? lvl.heroDuration : lvl.duration;
    if (stunDur <= 0) return;
    // Bash's buff is BPSE — the same overhead swirl every stun in the game wears
    // (CommonAbilityFunc [BPSE] Targetart=…\Thunderclap\ThunderclapTarget.mdl, overhead).
    this.applyBuffInternal(target, { kind: "stun", group: "AHbh", timeLeft: stunDur, sourceId: attacker.id, ...fx(def) });
  }

  /** The flat damage a rolled Bash adds to its swing (dataC "Damage Bonus" — 25). */
  private bashDamageBonus(u: SimUnit): number {
    const lvl = this.passiveLevelData(u, "AHbh");
    return lvl ? this.dataOf(lvl, 2, 25) : 0; // dataC
  }

  /** Look up a learned/innate ability on a unit by its base code. */
  private findAbility(u: SimUnit, code: string): SimAbility | undefined {
    return u.abilities.find((a) => a.code === code && a.level >= 1);
  }

  /** Can a unit target another with a (harmful) spell right now? */
  private castableTarget(caster: SimUnit, target: SimUnit, flags: string[] = [], code = ""): boolean {
    return this.targetError(caster, target, flags, code) === null;
  }

  /** WHY a unit may not target another with an ability — a commandstrings.txt [Errors]
   *  key ("Targetenemy"), or null when the target is legal. This is the one place the
   *  rule lives: the sim gates the cast on it and the UI turns the key into the gold
   *  line above the console, so what the player is told can never drift from what the
   *  engine actually enforces.
   *
   *  The keys are the game's own and map almost 1:1 onto the `targs1` flags they refuse
   *  (`enemy` → Targetenemy = "Must target an enemy unit.", `nonhero` → Nohero =
   *  "Unable to target Heroes."), which is a good sign the real engine is table-driven
   *  off the same data. */
  targetError(caster: SimUnit, target: SimUnit, flags: string[] = [], code = ""): string | null {
    // Coarsest first: what the target IS, then what the ability may touch, then whether
    // this particular cast would achieve anything. Order is what the player reads — a
    // Paladin aimed at himself hears "Unable to target self." (the flag), not "Hero has
    // full health." (a fact about a target he can't pick in the first place).
    if (target.hp <= 0) return "Notcorpse"; // "Target must be living."
    if (target.invulnerable && this.hostile(caster, target)) return "Notinvulnerable";
    // Magic Immunity — "That unit is immune to magic." It refuses BOTH directions, which is
    // the part people misremember: you cannot Polymorph an enemy Spell Breaker, and you
    // cannot Bloodlust or Heal a friendly one either. See MAGIC_IMMUNE_EXEMPT for the
    // handful of abilities the engine lets through anyway.
    if (target.magicImmune && !MAGIC_IMMUNE_EXEMPT.has(code)) return "Immunetomagic";
    const flagError = this.targetAllowed(caster, target, flags);
    if (flagError !== null) return flagError;
    // Abilities whose legal targets are a rule, not a flag list — the data can't say
    // "friendly living OR enemy Undead", so the engine hardcodes it and gives the
    // ability its own error string. Holy Light and Death Coil are mirror images.
    const polarity = POLARITY_SPELLS[code];
    if (polarity && !this.polarityOk(caster, target, polarity.healsUndead)) return polarity.error;
    // …and abilities that need the target to HAVE a mana bar. Same shape as the polarity
    // rule and known the same way: `targs1` cannot express it, and the game ships a line
    // written for one ability ("Unable to cast Mana Burn on this target."). A Demon Hunter
    // may not pick a Footman at all — see MANA_TARGET_SPELLS.
    const manaTarget = MANA_TARGET_SPELLS[code];
    if (manaTarget && target.maxMana <= 0) return manaTarget;
    // …and the ones that refuse a target for being too big (CREEP_LEVEL_CAP). Read off the
    // caster's own rank rather than a constant, because the cap is a data column: a map that
    // retunes `DataC` retunes what its Alchemist may melt down.
    if (CREEP_LEVEL_CAP.has(code) && target.isCreep) {
      const lvl = this.passiveLevelData(caster, code);
      const cap = lvl ? this.dataOf(lvl, 2, 0) : 0;
      if (cap > 0 && target.level > cap) return "Creeptoopowerful";
    }
    // A heal with nothing to heal is refused, not wasted — WC3 won't let you spend a
    // Paladin's mana on an undamaged Footman. The hero/unit split is the data's own:
    // "Hero has full health." vs "Already at full health."
    if (this.wouldHeal(caster, target, code) && target.hp >= target.maxHp) return target.isHero ? "HPmaxed" : "UnitHPmaxed";
    return null;
  }

  /** Would casting `code` on this target HEAL it? For a polarity spell the friendly half
   *  of its rule is the healing half (Holy Light heals the friendly living and smites the
   *  enemy Undead), so allegiance decides; polarityOk has already vouched for the race. */
  private wouldHeal(caster: SimUnit, target: SimUnit, code: string): boolean {
    if (POLARITY_SPELLS[code]) return !this.hostile(caster, target);
    return HEAL_SPELLS.has(code);
  }

  /** The Holy Light / Death Coil rule: one of heal-a-friendly and harm-an-enemy is for
   *  the Undead and the other is for the living. `healsUndead` picks which way round.
   *  Kept beside the spell handlers' own polarity check (sim/spells.ts) — that's what
   *  decides heal vs. damage once the cast lands; this decides whether it may start. */
  private polarityOk(caster: SimUnit, target: SimUnit, healsUndead: boolean): boolean {
    const undead = target.race === "undead";
    if (!this.hostile(caster, target)) return undead === healsUndead; // friendly
    return undead !== healsUndead; // enemy
  }

  /** Does this ability's `targs1` admit `target` as a KIND (air/ground/structure, organic,
   *  hero, ancient)? Allegiance is the caller's business — a hardcoded enemies-only nuke
   *  (Shock Wave, Carrion Swarm) states no allegiance in its data at all, so reading one
   *  out of `targs1` would invent friendly fire the real game does not have. What the data
   *  DOES decide, for every caller alike, is what may be struck. */
  targsAdmit(target: SimUnit, flags: string[] = []): boolean {
    // Defaulted like targetError's: a def built without a `targs1` (a custom map's row, a
    // test fixture) restricts nothing, which is what an empty flag list means anyway.
    return targsKindError(target, flags) === null;
  }

  /** Enforce the ability's "Targets Allowed" (AbilityData `targs1`) allegiance +
   *  hero/non-hero flags, so a spell only hits what its data says it may. Verified
   *  against the 1.27 MPQ: Storm Bolt/Chain Lightning/Slow are `enemy` (never a
   *  friendly), Heal/Inner Fire/Frost Armor are `friend,self` (never an enemy),
   *  Holy Light/Death Coil/Life Drain are `notself` (anything but the caster).
   *  Codes with no allegiance flag (Banish) stay unrestricted.
   *  Returns an [Errors] key, or null when allowed. */
  private targetAllowed(caster: SimUnit, target: SimUnit, flags: string[]): string | null {
    const F = new Set(flags.map((f) => f.toLowerCase()));
    const kindError = targsKindError(target, flags);
    if (kindError !== null) return kindError;
    const enemy = F.has("enemy");
    const friend = F.has("friend") || F.has("player"); // `player` = own units (Death Pact/Dark Ritual)
    const self = F.has("self");
    const neutral = F.has("neutral");
    const notself = F.has("notself");
    // No allegiance restriction in the data (e.g. Banish) → any allegiance allowed.
    if (!(enemy || friend || self || neutral || notself)) return null;
    if (target.id === caster.id) return self ? null : "Notself";
    if (notself) return null; // anything but the caster
    if (this.hostile(caster, target)) return enemy ? null : "Notenemy";
    if (target.neutralPassive) return neutral || friend ? null : "Notneutral";
    return friend ? null : "Notfriendly";
  }

  /** A refusal the game has no words for: the click is rejected and the error beeps, but no
   *  gold line appears. Not every "no" in WC3 comes with a sentence. */
  static readonly SILENT_REFUSAL = SILENT_REFUSAL;

  /** WHY this unit can't cast this ability AT ALL right now, target or no target — the
   *  caster-side half of `castError`, in the engine's own order: does it have the spell,
   *  is it able to cast, is the spell ready, can it pay. A commandstrings.txt [Errors]
   *  key, or null when the only thing left to check is the target.
   *
   *  This half is asked ONE STEP EARLIER than the other: at the BUTTON, before the game
   *  hands you a reticle. Warsmash keeps the same seam (`CAbilitySpellBase.innerCheckCanUse`
   *  → cooldown, then mana; `MeleeUI.onClick` only enters targeting mode `if (isUseOk())`),
   *  and it is why a spell you have no mana for answers your click with "Not enough mana."
   *  instead of arming a cast that was never going to happen (issue #110). */
  castUseError(unitId: number, code: string): string | null {
    const u = this.units.get(unitId);
    if (!u || !this.abilities) return "Notthisunit";
    const ab = this.findAbility(u, code);
    if (!ab) return "Notthisunit";
    const def = this.abilities.get(ab.id);
    if (!def || def.target === "passive") return "Notthisunit";
    // Silenced/stunned has no string in the data because WC3 never needs one — it greys the
    // button out, so the click can't happen. We refuse with the error beep and no sentence
    // rather than borrow a line that means something else (Notdisabled is about movement).
    if (u.stunned || u.silenced) return SILENT_REFUSAL;
    // …and neither does an ability whose upgrade is not researched (`[Aweb] Requires=Ruwb`).
    // Same shape, same silence: WC3 greys the button, so there is nothing to say.
    if (!this.techMeets(u.owner, ab.id)) return SILENT_REFUSAL;
    // …nor a unit halfway through changing shape (SimUnit.morphT). `castLocked` already
    // refuses the order; this is the half that lets the CARD know, so Unburrow reads as
    // unpressable until the Crypt Fiend is actually underground.
    if (u.morphT > 0) return SILENT_REFUSAL;
    const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
    if (ab.cooldownLeft > 0) return "Cooldown"; // "Spell is not ready yet."
    if (u.mana < lvl.cost) return "Nomana"; // "Not enough mana."
    // …and last, for the corpse family: nothing to raise is a refusal with a sentence of its
    // own. Last because it is the least fundamental of the four — a Necromancer short of mana
    // is short of mana whether or not there is a body — and because it is the only one of them
    // that can change while you stand still. Only the NO-TARGET members are answerable here
    // (which is five of the six: the button IS the cast, so the sweep is centred on the caster
    // and there is nothing left to aim). Ancestral Spirit is the aimed one and is checked in
    // castError, where the point exists. See sim/corpses.ts.
    if (def.target === "none") {
      const missing = this.corpseRefusal(u, def, lvl, u.x, u.y);
      if (missing) return missing;
    }
    return null;
  }

  /**
   * "There are no usable corpses nearby." — the refusal for an ability that builds something
   * out of a body when there is no body to build from, or null when there is one.
   *
   * Both lines are the game's own (`Units\CommandStrings.txt` [Errors] `Cantfindcorpse` /
   * `Cantfindfriendlycorpse`), and which of the two it is comes off the ability's own `targs1`
   * — see corpseMissingError. The LOOK is `corpsesFor`, the same query the handler will take
   * from, at the same radius (`corpseReach`), so the answer the player is given and the answer
   * the cast gets cannot disagree.
   *
   * Without this the cast fired, paid its mana and its cooldown, and produced nothing at all:
   * the handlers each opened with a silent `if (!corpse) return`, which is a correct effect
   * and a terrible answer.
   */
  private corpseRefusal(u: SimUnit, def: AbilityDef, lvl: AbilityLevel | undefined, x: number, y: number): string | null {
    if (!lvl || !spawnsFromCorpse(def.code)) return null;
    if (this.corpsesFor(u, def, x, y, corpseReach(def.code, lvl)).length > 0) return null;
    return corpseMissingError(def.targetFlags);
  }

  /**
   * Is this world point part of the map — inside the PLAYABLE area rather than the black
   * unplayable border, or a patch of "Nothing" painted inside it (issue #117)?
   *
   * Asked of the pathing grid's `Unflyable` bit, which war3map.wpm sets on the boundary and
   * on nothing else (see PathingFlag.Unflyable). Using the GRID rather than a rect is what
   * makes a non-rectangular boundary work — BootyBay's is a shaped coastline, not a frame.
   *
   * A world with no grid (the headless sim tests) has no border to be outside of, so
   * everything is inside it.
   */
  inPlayableArea(x: number, y: number): boolean {
    return !this.grid || this.grid.playableAt(x, y);
  }

  /** WHY this unit can't cast this ability at this target right now — a commandstrings.txt
   *  [Errors] key, or null if it can. This is the click-time gate: the UI asks before it
   *  spends the order, so the player gets told and the cursor stays armed rather than the
   *  click being silently eaten.
   *
   *  Mana and cooldown are checked HERE, at click time, and not only in tickCast — WC3
   *  says "Not enough mana." the instant you click, it doesn't walk the caster into range
   *  first and then quietly give up. tickCast still re-checks both, because the walk takes
   *  time and a cheaper spell may drain the mana in the meantime. */
  castError(unitId: number, code: string, targetId = 0, x = 0, y = 0): string | null {
    const use = this.castUseError(unitId, code);
    if (use !== null) return use;
    const u = this.units.get(unitId)!;
    const ab = this.findAbility(u, code)!;
    const def = this.abilities!.get(ab.id)!;
    if (def.target === "point") {
      // "Targeted location is outside of the map boundary." — the engine keeps a line for
      // exactly this (`Units\CommandStrings.txt` [Errors] `Outofbounds`), and this is where
      // it is earned: a point aimed into the unplayable black is not a place, so nothing may
      // be aimed at it — a Blink, a Blizzard, a Stampede (issue #117). Ahead of the corpse
      // gate because it is the more fundamental "no" of the two.
      if (!this.inPlayableArea(x, y)) return "Outofbounds";
      // The aimed half of the corpse gate: Ancestral Spirit sweeps around the POINT, so this
      // is the first moment it can be answered at all (castUseError took the other five, whose
      // sweep is centred on the caster). Silent for every other point spell.
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      return this.corpseRefusal(u, def, lvl, x, y);
    }
    if (def.target !== "unit") return null;
    const t = this.units.get(targetId);
    if (!t) return "Targetunit"; // "Must target a unit with this action." — clicked bare ground
    return this.targetError(u, t, def.targetFlags, code);
  }

  /** Order a unit to cast an ability. `code` is the ability's base code; targetId
   *  (unit) / x,y (point) depend on the ability's target type. Returns false if
   *  the cast can't be started (unknown/unlearned ability, wrong target, dead). */
  issueCast(unitId: number, code: string, targetId = 0, x = 0, y = 0, auto = false): boolean {
    const u = this.units.get(unitId);
    if (!u || u.stunned || u.silenced || !this.abilities) return false;
    // An illusion is a picture of a caster, not a caster: it has the abilities on its sheet
    // (it is an exact copy) but may not use them. The command card hides them too — this is
    // the backstop for every other route in (a trigger, a hotkey, autocast).
    if (u.isIllusion) return false;
    const ab = this.findAbility(u, code);
    if (!ab) return false;
    // The upgrade gate, at the one door every route in shares — a player's click, an
    // autocast, a JASS `IssueTargetOrder`, a networked command. The command card already
    // refuses the press (the button is drawn unavailable), but a gate that only the UI keeps
    // is not a gate: `[Aweb] Requires=Ruwb` has to mean the same thing to a trigger.
    if (!this.techMeets(u.owner, ab.id)) return false;
    const def = this.abilities.get(ab.id);
    if (!def || def.target === "passive") return false;
    // Entangle pressed on a WALKING tree, which is the only card it is on (UPROOTED_ONLY).
    // Roots in the air hold nothing, so the press is not a cast: it is the errand
    // (`entangleat`), and the tree plants itself within reach of the mine first.
    // `Mustroottoentangle` — "Must root adjacent to a gold mine to entangle it" — is the
    // refusal when there is no free mine inside `Rng1` to plant next to, which is the only
    // case left over. (The raw cast below still serves a JASS `entangle` order aimed at a
    // planted tree.)
    if (code === "Aent" && u.uprooted) return this.issueEntangleAt(unitId, 0);
    const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
    // Nothing to raise, no cast. Refused HERE as well as at the button so that every route in
    // shares the gate — a trigger's IssueImmediateOrder, a command off the wire, an autocast —
    // and, more to the point, so the cast never reaches the effect: mana and cooldown are
    // committed there (see tickCast), and the handler's own `if (!corpse) return` was spending
    // both on nothing. An `auto` cast lands here too and simply doesn't fire, which is exactly
    // what an autocast with no work to do should do.
    if (spawnsFromCorpse(code) && this.corpseRefusal(u, def, lvl, def.target === "point" ? x : u.x, def.target === "point" ? y : u.y)) return false;
    // Immediate abilities (see IMMEDIATE) fire here and now: pay, run the effect, done.
    // They take no order and touch none of the unit's state below, so they neither need
    // the castLocked gate nor interrupt a swing, a walk, or another spell's wind-up.
    if (IMMEDIATE.has(code)) return this.castImmediate(u, ab, def, lvl);
    if (this.castLocked(u)) return false; // already committed to a spell — see castLocked
    // Root / Unroot (`Aroo`) is immediate too, and for the same two reasons the three above
    // are: AbilityData `Cast1` = 0, and `[Aroo]` in NightElfAbilityFunc carries no `Animnames`
    // at all — an order pair (`Order=root` / `Unorder=unroot`) and nothing else. There is
    // no gesture to wind up, because pressing the button IS the transition.
    //
    // Through the generic pipeline it was charged the CASTER's own cast point instead, and
    // that number belongs to a different ability: the Tree of Life's `castpt` of 0.5s is
    // Entangle's wind-up. So an Uproot stood there for half a second doing nothing visible
    // and then took `Dur1` = 2.5s, for 3.0s against the game's 2.5 — and the command card,
    // which empties on the transition, stayed up for the whole of that half second. Root
    // never had the problem: it arrives through `rootat`, which calls toggleRoot outright.
    //
    // Below `castLocked` rather than above it (where the other three sit, deliberately
    // free to fire mid-wind-up): an Ancient already hauling itself up must not be told to
    // do it again, and `toggleRoot`'s own rootRefusal is not the only thing that should
    // say so.
    if (code === "Aroo") return this.castImmediate(u, ab, def, lvl);
    // The point twin of the target test below, and gated at the same door for the same
    // reason: a spot in the unplayable black is not a spot (issue #117), and `castError` only
    // speaks to the local player's click. A trigger's IssuePointOrder, an order off the wire
    // and an autocast all arrive here.
    if (def.target === "point" && !this.inPlayableArea(x, y)) return false;
    const t = def.target === "unit" ? this.units.get(targetId) : undefined;
    if (def.target === "unit" && (!t || !this.castableTarget(u, t, def.targetFlags, code))) return false;
    // An attack modifier aimed by hand: not a cast at all, but an ATTACK carrying one
    // enhanced shot (see isArrowOrb). Checked after the target test so it inherits the
    // same data-driven rules — Searing Arrows may be aimed at a building, Cold Arrows may not.
    if (isArrowOrb(code)) return this.issueArrowShot(u, ab, lvl, targetId);
    // Remember an attack-move/follow/commanded-attack to resume after the cast — for an
    // AUTOMATIC cast only. That is the whole of what resuming is for: an autocast fired from
    // inside a commanded fight is a pause, not a defection, so the Priest heals and goes
    // straight back to the unit the player pointed him at (see tickAttack).
    //
    // A cast the PLAYER issued is the opposite. It is an ORDER, and an order replaces the one
    // before it — that is what every other order in the game does, and a spell is not special.
    // Resuming one made the old order outlive the new one: an Alchemist told to Healing Spray
    // mid-fight sprayed and then went straight back to chasing whatever he had been swinging
    // at, so the cast read as though it had never taken his attention at all. Nothing is lost
    // by dropping it — a unit left idle beside a fight re-acquires on its own next tick, which
    // is the "re-aggro happens by itself" the player is relying on.
    const resume: PendingCast["resume"] = !auto
      ? null
      : u.order === "attackmove"
        ? { kind: "attackmove", x: u.amDestX, y: u.amDestY }
        : u.order === "follow" && u.targetId
          ? { kind: "follow", id: u.targetId }
          : u.order === "attack" && u.attackOrdered && u.targetId !== null && this.units.has(u.targetId)
            ? // `force` preserved: an Attack command may legitimately be aimed at a
              // non-hostile (issueAttack's `force`), and a resume that dropped it would
              // silently refuse to pick the fight back up.
              { kind: "attack", id: u.targetId, force: !this.hostile(u, this.units.get(u.targetId)!) }
            : u.order === "hold"
              ? // A holding caster is STILL HOLDING when the heal is done. Without this he
                // fell idle the moment the cast ended, and an idle unit chases — which is
                // precisely the thing the player pressed Hold Position to prevent.
                { kind: "hold" }
              : null;
    // Re-task away from whatever it was doing.
    this.detachBuilder(unitId);
    this.cancelSwing(u);
    u.inCombat = false;
    u.targetId = null;
    u.order = "cast";
    u.pendingCast = {
      code,
      abilityId: ab.id,
      rank: ab.level,
      targetId: def.target === "unit" ? targetId : 0,
      x: def.target === "point" ? x : (t?.x ?? u.x),
      y: def.target === "point" ? y : (t?.y ?? u.y),
      range: def.target === "none" ? 0 : lvl.castRange + this.aimedBlockRadius(code, u, x, y),
      castLeft: -1,
      started: false,
      committed: false,
      fired: false,
      channelLeft: 0,
      backLeft: 0,
      ended: false,
      auto,
      resume,
    };
    return true;
  }

  /**
   * How much further than its own `castRange` a cast has to be allowed to stand off, because of
   * what it is aimed AT. Zero for everything but Eat Tree.
   *
   * `Aeat`'s `Rng1` is 32 — "a tree the Ancient is already touching" — and it is measured to the
   * point the order names, which for a tree is the middle of a BLOCKED 4×4 (or 2×2) square on
   * the pathing grid. Nothing can ever stand within 32 of that: the approach in tickCast waits
   * at a range it can never make and the cast simply never fires, which is what a right-click
   * aimed straight at a trunk did. The block's own half-extent is the whole of the difference
   * between "touching the tree" and "standing inside it", and it is a property of the thing
   * aimed at rather than of the ability, which is why it is added here rather than in the data.
   *
   * The EFFECT's reach (spells.ts `Aeat`: `Rng1` + the caster's radius, from the aim point for
   * the search and from the Ancient for the reach) still covers the wider stop, since no
   * Ancient's block is bigger than its own hull.
   */
  private aimedBlockRadius(code: string, u: SimUnit, x: number, y: number): number {
    if (code !== "Aeat") return 0;
    const tree = this.nearestTree(x, y, u.radius);
    return tree ? tree.blockRadius : 0;
  }

  /**
   * Aim an attack modifier by hand (isArrowOrb): shoot THAT unit, and let the blow that
   * lands carry the ability.
   *
   * No PendingCast, no wind-up, no cast animation — the Priestess does not stop and gesture,
   * she looses one searing arrow at what she was told to shoot. So the order this leaves on
   * the unit is an ordinary commanded attack, and everything that already governs an attack
   * (walking into weapon range, the swing, retaliation, a target that dies on the way) governs
   * this untouched. The only thing carried is which ability the next landed blow owes.
   *
   * Mana is checked here for the feedback — pressing a spell you cannot pay for should say so
   * — but it is SPENT at the hit, in applyArrowEffects, because that is where the per-shot
   * cost is actually incurred and where a shot that never lands must cost nothing.
   */
  private issueArrowShot(u: SimUnit, ab: SimAbility, lvl: AbilityLevel, targetId: number): boolean {
    if (ab.cooldownLeft > 0 || u.mana < lvl.cost) return false;
    if (!this.issueAttack(u.id, targetId, true, true)) return false; // forced: it is a command
    u.arrowShot = { code: ab.code, targetId };
    return true;
  }

  /** Cast an IMMEDIATE ability on the spot: no PendingCast, no wind-up, no cast
   *  animation, and the caster's current order (an attack in mid-swing, a walk) is
   *  left completely alone. The whole cast collapses into this one call, so every
   *  spell event fires here in the order tickCast would have raised them. */
  private castImmediate(u: SimUnit, ab: SimAbility, def: AbilityDef, lvl: AbilityLevel): boolean {
    if (ab.cooldownLeft > 0 || u.mana < lvl.cost) return false;
    u.mana -= lvl.cost;
    ab.cooldownLeft = lvl.cooldown;
    // A stand-in PendingCast purely to describe the cast to noteSpell/resolveCast —
    // it is never stored on the unit, so nothing can interrupt or resume it.
    const pc: PendingCast = {
      code: def.code,
      abilityId: ab.id,
      rank: ab.level,
      targetId: 0,
      x: u.x,
      y: u.y,
      range: 0,
      castLeft: 0,
      auto: false, // never stored on the unit, so nothing ever re-checks it
      started: true,
      committed: true,
      fired: true,
      channelLeft: 0,
      backLeft: 0,
      ended: true,
      resume: null,
    };
    this.noteSpell(u, pc, "channel");
    this.noteSpell(u, pc, "cast");
    this.breakInvisibility(u); // casting reveals, the same as for a wound-up spell
    this.castFires.push({ casterId: u.id, code: def.code, abilityId: ab.id }); // sound only — no castStarts, so no clip to hold
    this.noteSpell(u, pc, "effect");
    this.resolveCast(u, def, pc);
    this.noteSpell(u, pc, "finish");
    this.noteSpell(u, pc, "endcast");
    return true;
  }

  /** Drive a pending cast through its lifecycle (see PendingCast): approach + face
   *  → wind up → fire (commit mana/cooldown) → channel or backswing → resume. */
  private tickCast(u: SimUnit, dt: number): void {
    const pc = u.pendingCast;
    if (!pc || !this.abilities) {
      this.stop(u.id);
      return;
    }
    const def = this.abilities.get(pc.abilityId);
    const ab = u.abilities.find((a) => a.id === pc.abilityId);
    if (!def || !ab || ab.level < 1) {
      this.stop(u.id);
      return;
    }
    const lvl = def.levelData[Math.min(pc.rank, def.levelData.length) - 1];
    // Resolve where we're aiming; a unit target that died/became invalid aborts
    // (but only until the effect has fired — a channel/backswing keeps its point).
    let tx = pc.x;
    let ty = pc.y;
    if (pc.targetId && !pc.fired) {
      const t = this.units.get(pc.targetId);
      if (!t || !this.castableTarget(u, t, def.targetFlags, pc.code)) {
        this.stop(u.id);
        return;
      }
      tx = t.x;
      ty = t.y;
      pc.x = tx;
      pc.y = ty;
    }

    // --- phase 3: post-effect. Either CHANNEL (locked, a new order stops it and
    // its ticks) or a cast BACKSWING (pure recovery a new order cancels for free).
    // We reach here only via the normal timeline; any new order re-tasks u.order
    // away from "cast", so tickCast simply stops running (the recovery/channel is
    // abandoned) — which is exactly WC3 animation canceling.
    if (pc.fired) {
      if (u.moving) this.settle(u);
      if (pc.channelLeft > 0) {
        // Channelling: keep facing the target point (Blizzard aims where you cast).
        u.desiredFacing = Math.atan2(pc.y - u.y, pc.x - u.x);
        pc.channelLeft -= dt;
        if (pc.channelLeft > 0) return;
      } else if (pc.backLeft > 0) {
        // Backswing: the effect already happened; just stand out the recovery.
        pc.backLeft -= dt;
        if (pc.backLeft > 0) return;
      }
      this.endCast(u, pc);
      return;
    }

    // --- phase 1: approach + face (before the wind-up begins) ---
    if (!pc.started) {
      // Approach: close to cast range (hull-to-hull for unit targets), then face.
      if (pc.range > 0) {
        const t = pc.targetId ? this.units.get(pc.targetId) : null;
        const gap = Math.hypot(tx - u.x, ty - u.y) - u.radius - (t?.radius ?? 0);
        if (gap > pc.range) {
          // An autocast walking to a target it would no longer choose gives up here rather
          // than at the end of the walk (see PendingCast.auto). The next idle/attack-move
          // tick re-runs the search and picks whoever needs it now.
          if (pc.auto && t && !this.autocastStillWanted(u, t, def)) {
            this.stop(u.id);
            return;
          }
          // Straight at the point it was aimed at, and the range test above is what ends the
          // walk. Deliberately NOT at a computed spot on the range ring: the ring around a
          // trunk is where the REST of the grove is, so a goal placed on it lands on a blocked
          // cell, the path "arrives" a body short, and the Ancient stands there with the spell
          // never cast. Walking at the thing itself gets a best-effort path that hugs it.
          this.chasePoint(u, tx, ty);
          return;
        }
      }
      if (u.moving) this.settle(u);
      // Face a unit/point target; for a no-target SELF cast (Water Elemental,
      // Divine Shield, Avatar) keep the current facing so the caster doesn't spin
      // to face east — and so the summon appears in front of where it's looking.
      if (Math.hypot(tx - u.x, ty - u.y) > 1) u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
      if (!this.facesTarget(u, FACING_CAST_EPS)) return; // still turning
      // Gate on affordability up front so the caster never winds up a spell it
      // can't pay for. Mana/cooldown are only COMMITTED at the effect (below), so
      // interrupting the wind-up cancels the spell for free.
      if (ab.cooldownLeft > 0 || u.mana < lvl.cost) {
        this.stop(u.id);
        return;
      }
      pc.started = true;
      // Wind-up before the effect = the unit's Cast Point PLUS the ability's own
      // Casting Time (they add — hiveworkshop "Cast Point and Backswing" 265781;
      // castPoint 0 → an instant cast). Storm Bolt = MK's 0.4; Blizzard = Archmage's
      // 0.3 + the spell's 1.0 Casting Time = 1.3s before the first shard.
      pc.castLeft = u.castPoint + (CAST_TIME_IS_NOT_A_WINDUP.has(pc.code) ? 0 : lvl.castTime);
      const channelLen = this.channelDuration(def, pc.rank);
      // Tell the renderer to play the cast clip and hold it for the whole cast
      // (wind-up + backswing, or wind-up + channel — looped for a channel). A
      // spin-for-the-duration ability (Bladestorm) holds and loops the same way without
      // being a channel; see ANIM_FOR_DURATION.
      const animLen = ANIM_FOR_DURATION.has(pc.code) ? lvl.heroDuration || lvl.duration || 0 : this.loopingCastLength(def, lvl);
      const hold = pc.castLeft + (channelLen > 0 ? channelLen : animLen > 0 ? animLen : u.castBackswing);
      const warnArt = PRECAST_WARNING.has(pc.code) ? def.effectArt : "";
      // tx/ty/targetId let the renderer aim cast-triggered visuals at the target —
      // e.g. the Blood Mage hurling one of his orbiting spheres (issue #37).
      // A FORM TOGGLE raises none: its animation is the morph transition the renderer plays
      // when the body swaps, not a gesture in front of it (see isFormToggle).
      if (!this.isFormToggle(def)) {
        this.castStarts.push({ casterId: u.id, code: pc.code, abilityId: pc.abilityId, hold, loop: channelLen > 0 || animLen > 0, tx, ty, targetId: pc.targetId, warnArt });
      }
      // The caster has begun: SPELL_CHANNEL then SPELL_CAST (7.17). WC3 raises both at
      // the start of the cast — CHANNEL as the caster commits to it, CAST as the spell
      // itself begins; the EFFECT below is the one most triggers actually listen for.
      this.noteSpell(u, pc, "channel");
      this.noteSpell(u, pc, "cast");
      // The caster's own flourish, if this ability's art belongs to the GESTURE rather than
      // to what the gesture throws (see CAST_START_ART): Blink's plume and Fan of Knives'
      // burst play here, at the button press, not half a second later with the effect.
      const startFx = CAST_START_ART[pc.code]?.(def);
      if (startFx?.art) this.spellEffects.push({ art: startFx.art, x: u.x, y: u.y, targetId: startFx.follow ? u.id : 0, z: 0, sound: startFx.sound });
      // Delayed-strike "beware" warning (see PRECAST_WARNING): drop the ability's
      // Effectart at the target NOW, as the wind-up begins, so Flame Strike's smoke
      // vortex charges in place and lingers even if the cast is interrupted before
      // the pillar erupts. Only the completed cast reaches the effect handler.
      if (PRECAST_WARNING.has(pc.code)) {
        if (def.effectArt) this.spellEffects.push({ art: def.effectArt, x: tx, y: ty, targetId: 0, z: 0 });
        // ...and spend the mana + cooldown UP FRONT (WC3/Liquipedia: interrupting the
        // Blood Mage mid-cast still wastes the cast). `committed` stops phase 2 from
        // charging a second time. The affordability gate above already ran, so we know
        // it's payable here.
        u.mana -= lvl.cost;
        ab.cooldownLeft = lvl.cooldown;
        pc.committed = true;
      }
    }

    // --- phase 2: wind-up. The effect fires when it elapses; canceling before then
    // (a new order, or a stun via interruptForStun) aborts the spell — with no cost
    // for a normal spell, but a PRECAST_WARNING spell (Flame Strike) has already paid
    // at wind-up start, so an interrupt there simply wastes the cast. ---
    pc.castLeft -= dt;
    if (pc.castLeft > 0) return;
    // Commit: spend mana + start the cooldown, THEN fire. Re-check mana in case it
    // was drained (Mana Burn) mid-wind-up. Abilities that committed at wind-up start
    // (PRECAST_WARNING) already paid, so skip the charge and fire regardless.
    if (!pc.committed) {
      if (u.mana < lvl.cost || ab.cooldownLeft > 0) {
        this.stop(u.id);
        return;
      }
      u.mana -= lvl.cost;
      ab.cooldownLeft = lvl.cooldown;
    }
    pc.fired = true;
    // Casting reveals, the same as attacking ("anything but move or stop"). This runs BEFORE
    // resolveCast so that Wind Walk itself doesn't break the very fade it is about to grant —
    // the break settles the OLD invisibility, then the handler applies the new one.
    this.breakInvisibility(u); // no backstab: only a blow earns that
    // The effect fires NOW (cast point) — cue its cast sound here so it lands with
    // the visible clap/bolt, not 0.4s early at the wind-up (issue #23).
    this.castFires.push({ casterId: u.id, code: pc.code, abilityId: pc.abilityId });
    this.noteSpell(u, pc, "effect"); // EVENT_(PLAYER_)UNIT_SPELL_EFFECT — the spell goes off
    this.resolveCast(u, def, pc);
    pc.channelLeft = this.channelDuration(def, pc.rank);
    // No channel → play the cast backswing recovery (0 = none). A channel holds
    // instead; there's no backswing after one.
    pc.backLeft = pc.channelLeft > 0 ? 0 : u.castBackswing;
    if (u.moving) this.settle(u);
    if (pc.channelLeft <= 0 && pc.backLeft <= 0) this.endCast(u, pc); // instant, no recovery
  }

  /** End a cast: resume the pre-cast attack-move/follow/hold/commanded attack, else fall idle. */
  private endCast(u: SimUnit, pc: PendingCast): void {
    // The cast ran its course: SPELL_FINISH (the channel/recovery is over) then
    // SPELL_ENDCAST (the caster has stopped casting). `ended` marks it done so the
    // stop below — and any later stop of a stale pendingCast — can't raise a second
    // ENDCAST for the same cast (see clearCast).
    this.noteSpell(u, pc, "finish");
    this.noteSpell(u, pc, "endcast");
    pc.ended = true;
    if (pc.resume?.kind === "attackmove") this.issueAttackMove(u.id, pc.resume.x, pc.resume.y);
    else if (pc.resume?.kind === "follow") this.issueFollow(u.id, pc.resume.id);
    else if (pc.resume?.kind === "hold") this.issueHold(u.id); // back to the line he was told to hold
    // Back to the fight he was told to join — still ORDERED, so it keeps its commitment
    // (the leash, the walk-past-others rule) exactly as before the heal. A target that
    // died while he cast simply refuses, and he falls idle and re-acquires like anyone.
    else if (pc.resume?.kind === "attack") {
      if (!this.issueAttack(u.id, pc.resume.id, pc.resume.force, true)) this.stop(u.id);
    } else this.stop(u.id);
  }

  /** Drop a unit's pending cast, raising SPELL_ENDCAST if it was interrupted mid-cast
   *  (WC3 fires ENDCAST whether the spell completed or was cancelled — a stun, a Stop,
   *  a new order). A cast that already ran to endCast is marked `ended` and stays quiet. */
  private clearCast(u: SimUnit): void {
    const pc = u.pendingCast;
    if (!pc) return;
    u.pendingCast = null;
    if (pc.started && !pc.ended) this.noteSpell(u, pc, "endcast");
  }

  /**
   * How long a LOOPING cast GESTURE runs when the ability is not a channel.
   *
   * `Animnames` draws the distinction and the two Alchemist rows sit either side of it:
   * `[ANhs] Animnames = spell,looping` against a channel's `stand,channel`. Looping means the
   * caster keeps performing — HeroGoblinAlchemist.mdx authors that pose as "Spell Channel",
   * 2.0s and flagged looping — but nothing locks him in place, so he may walk out of it.
   *
   * How long he performs for is how long the SPRAY lasts, and that is `DataF` waves one
   * `DataB` second apart (3/4/5 seconds by rank) — the same schedule the handler hands the
   * field, so the loop stops with the last bottle. Read off the ordinary cast timeline it is
   * not: `Dur1`/`HeroDur1` are both 0 on this row, and the caster's own backswing would have
   * released the pose 0.9s in, a third of the way through one turn of the clip.
   *
   * 0 for everything else: a one-shot gesture ends with the cast, and a real channel is sized
   * by channelDuration instead.
   */
  private loopingCastLength(def: AbilityDef, lvl: AbilityLevel): number {
    if (def.code !== "ANhs") return 0;
    return Math.max(1, this.dataOf(lvl, 5, 3)) * (this.dataOf(lvl, 1, 1) || 1);
  }

  /** How long a channelled spell locks its caster (0 = not a channel). Matches the
   *  wave field the handler schedules so the caster channels exactly as long as the
   *  effect lasts: the ability's Duration for the timed fields (Tranquility 30s,
   *  Starfall 45s, Death and Decay 35s, Stampede/Earthquake), or waves × interval for
   *  the wave fields. A wave field's Duration column is NEVER its channel: Blizzard's
   *  is 0 and Rain of Fire's 3 is how long its burn lingers — the Pit Lord channels
   *  6/8/10s (one second per wave), not 3. See `waveSchedule`. */
  private channelDuration(def: AbilityDef, rank: number): number {
    if (!CHANNELED.has(def.code)) return 0;
    const lvl = def.levelData[Math.min(rank, def.levelData.length) - 1];
    if (lvl.duration > 0 && !WAVE_FIELDS.has(def.code)) return lvl.duration;
    const { waves, interval } = waveSchedule(lvl);
    return waves * interval;
  }

  /** Deliver a cast's effect: launch the spell missile (if the ability has one)
   *  or apply the effect immediately (instant / point / no-target). */
  private resolveCast(u: SimUnit, def: AbilityDef, pc: PendingCast): void {
    if (def.target === "unit" && def.missileArt && pc.targetId) {
      // Travelling spell (Storm Bolt, Death Coil): the effect fires on impact.
      this.spawnSpellProjectile(u, pc.targetId, def, pc.rank);
      return;
    }
    this.applySpellEffect(pc.code, pc.rank, u, { targetId: pc.targetId, x: pc.x, y: pc.y }, def);
  }

  /** Idle autocast: a unit with a toggled-on autocast ability picks a valid
   *  target and casts. Returns true if a cast started.
   *
   *  `inPlace` drops the WALK. Normally an autocast looks as far as the caster's own eyes and
   *  trots over to what it finds (see autocastSearchRange) — but Hold Position's entire
   *  content is "do not move", so a holding caster may only take work that is already inside
   *  the spell's own cast range. Same for the corpse family: a Meat Wagon on hold raises what
   *  it is standing over and does not drive off after the rest of the field. */
  private tickAutocast(u: SimUnit, inPlace = false): boolean {
    // NOT gated on having mana. That was a fast path for the casters, and it is wrong for the
    // autocasts that cost nothing: a Meat Wagon has no mana pool at all, so Get Corpse
    // (`[Amel] Cost1 = 0`) could never fire and the wagon sat next to a field of bodies doing
    // nothing. Affordability is per-ability a few lines down, where it belongs.
    if (!this.abilities) return false;
    for (const ab of u.abilities) {
      if (!ab.autocastOn || ab.level < 1 || ab.cooldownLeft > 0) continue;
      // An attack modifier is a unit-target autocast that must NOT be sought out: its
      // standing order is "enhance the shots you were already taking" (applyArrowEffects at
      // the blow), not "go and find someone to shoot". Left in, a Priestess with Searing
      // Arrows on would hunt down anything inside her acquisition range under a COMMANDED
      // attack — which outranks her guard post and would drag her off a march.
      if (isArrowOrb(ab.code)) continue;
      // An ability whose RESEARCH is not in is not a standing order, it is a promise. The
      // `auto` column arms a unit's autocast from birth (`[ucry] auto = Aweb`) and the
      // upgrade is what unlocks the row — so a Crypt Fiend fresh from the Crypt would have
      // been webbing gargoyles before the Web upgrade was ever paid for. The card shows the
      // same thing from the other side: an unavailable button draws no autocast ring.
      if (!this.techMeets(u.owner, ab.id)) continue;
      // The Moon Well's Replenish is autocast, but not through here: it is a POUR, held open
      // across seconds, and it is the caster's own tick that opens and closes it
      // (tickReplenish). Left in, this would re-issue a fresh cast every tick — and pick its
      // target off `Rng1 = 99999`, i.e. the whole map.
      if (ab.code === "Ambt") continue;
      // Renew is not a cast either — it is the ordinary repair JOB under the wisp's own art
      // (see KNOWN_ABILITIES). tickRenew hands out the work.
      if (isRepairCode(ab.code)) continue;
      const def = this.abilities.get(ab.id);
      if (!def) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (u.mana < lvl.cost) continue;
      // A CORPSE autocast: no target to click, and what it wants is a body. The data alone
      // says which abilities these are — `targs1` naming `dead` on a no-target row — and in
      // 1.30 that is Raise Dead (`Arai` and its copies), the Avatar of Vengeance's Spirits
      // (`Avng`), and the Meat Wagon's Get Corpse (`Amel`).
      //
      // Two ranges, and the family reads them the same way the rest of the autocast code
      // does: `Rng1` is how far it can REACH and `Area1` how far it LOOKS. A body inside the
      // reach is raised on the spot; one it can only see is walked to, which is the doctrine
      // already stated for the unit-target autocasts (see autocastSearchRange, and
      // Liquipedia's Autocast: an autocast "can cause it to move in order to cast their
      // spell"). It is what makes Get Corpse work at all — `[Amel] Rng1 = 100, Area1 = 600`,
      // and Liquipedia prints both, because the wagon drives to the body.
      if (def.target === "none" && def.targetFlags.some((f) => f.toLowerCase() === "dead")) {
        const reach = lvl.castRange || lvl.area || 600;
        const look = Math.max(reach, lvl.area || 0);
        if (!this.corpseAutocastWants(u, def, lvl, reach)) {
          // Nothing in reach — but if there is a body it can SEE, go and stand over it. A
          // plain move order, not a cast: arriving is what makes the next idle tick fire.
          // Never on Hold: the walk is the one thing that order forbids.
          if (inPlace) continue;
          if (!this.corpseAutocastWants(u, def, lvl, look)) continue;
          const [body] = this.corpsesFor(u, def, u.x, u.y, look, { forLoad: CORPSE_LOADERS.has(def.code) });
          if (!body) continue;
          const [bx, by] = this.corpseAt(body);
          this.chasePoint(u, bx, by);
          return true;
        }
        return this.issueCast(u.id, def.code, 0, u.x, u.y, true);
      }
      if (def.target !== "unit") continue;
      // Friendly vs hostile autocast is decided by the ability's real Targets
      // Allowed flags (targs1), not a hard-coded code list: a spell allowing
      // `friend`/`self`/`player` (and not `enemy`) buffs/heals allies; `enemy`
      // targets foes. `self` in the flags lets the caster be its own target
      // (Heal/Inner Fire/Frost Armor all carry it — verified in the 1.27 MPQ).
      const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
      const friendly = !F.has("enemy") && (F.has("friend") || F.has("self") || F.has("player"));
      const range = inPlace ? lvl.castRange : this.autocastSearchRange(u, lvl.castRange);
      const target = this.autocastTarget(u, range, friendly, def.code, F.has("self"), def.targetFlags);
      if (target) return this.issueCast(u.id, def.code, target.id, 0, 0, true);
    }
    return false;
  }

  /** How many live units of a type a player has — the cap check behind Carrion Beetles'
   *  `DataE` and the Avatar of Vengeance's six Spirits. */
  private countOwnedOf(owner: number, typeId: string): number {
    let n = 0;
    for (const u of this.units.values()) if (u.hp > 0 && u.owner === owner && u.typeId === typeId) n++;
    return n;
  }

  /** Would a corpse autocast actually do something right now? Asked BEFORE the order, because
   *  mana is spent when the cast commits and a spell that fires into nothing still pays: a
   *  Necromancer on ground with no bodies on it, or an Avatar already at its six-Spirit cap,
   *  would otherwise bleed its mana away a cast at a time for the rest of the match.
   *
   *  The guards are the handler's own, asked without spending anything: `corpsesFor` is the
   *  same look `claimCorpses` takes from (so the two cannot drift), and the cap is `DataE
   *  "Max Summoned"` against the caster's live count of `DataC`. */
  private corpseAutocastWants(u: SimUnit, def: AbilityDef, lvl: AbilityLevel, radius: number): boolean {
    // A LOADER is bounded by its hold, not by a summon count: the Meat Wagon raises nothing,
    // it fills up. Full wagon, nothing wanted — and it must look for a FREE body, since the
    // ones already aboard are still corpses and would otherwise read as work forever.
    if (CORPSE_LOADERS.has(def.code)) {
      const cap = this.cargoCapacityOf(u);
      if (cap > 0 && this.heldCorpseCount(u.id) >= cap) return false;
      return this.corpsesFor(u, def, u.x, u.y, radius, { forLoad: true }).length > 0;
    }
    const unit = lvl.dataStr[2] || lvl.summon || "";
    if (!unit) return false;
    const cap = lvl.data[4];
    if (cap > 0 && this.countOwnedOf(u.owner, unit) >= cap) return false;
    return this.corpsesFor(u, def, u.x, u.y, radius).length > 0;
  }

  /** How far an autocast LOOKS for work — the caster's own acquisition range, not the
   *  spell's cast range.
   *
   *  This is the difference between a Priest that waits for a wounded Footman to limp into
   *  Heal's 250 and one that trots over to it: "Any friendly unit within acquisition range
   *  of the Priest will be automatically healed" (Warcraft Wiki, Priest), and Liquipedia's
   *  Autocast page puts the same rule generally — autocast "can cause it to move in order to
   *  cast their spell". The number is the unit's own `acquire` in Units\UnitWeapons.slk, the
   *  same field that decides who it picks a fight with: Priest 600, Sorceress 700, Druid of
   *  the Talon 800. The walk itself is free — issueCast's order already closes to cast range.
   *
   *  Never SHORTER than the cast range: Slow reaches 700 out of a Sorceress who only looks
   *  700, but a spell that out-ranged its caster's eyes would otherwise lose the difference. */
  private autocastSearchRange(u: SimUnit, castRange: number): number {
    return Math.max(castRange, u.weapon?.acquire ?? 0);
  }

  private autocastTarget(u: SimUnit, range: number, friendly: boolean, code: string, selfOk: boolean, flags: string[] = []): SimUnit | null {
    let best: SimUnit | null = null;
    let bestScore = friendly ? 0.999 : Infinity;
    for (const t of this.units.values()) {
      if (Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius > range) continue;
      if (!this.autocastWants(u, t, friendly, code, selfOk, flags)) continue;
      if (friendly) {
        const frac = t.hp / t.maxHp; // heal the most-hurt ally
        if (frac < bestScore) {
          bestScore = frac;
          best = t;
        }
      } else {
        const d = Math.hypot(t.x - u.x, t.y - u.y);
        if (d < bestScore) {
          bestScore = d;
          best = t;
        }
      }
    }
    return best;
  }

  /** Everything except the distance that makes `t` a target this autocast wants. Split out of
   *  the search so the APPROACH can re-ask it (see PendingCast.auto): a Priest halfway to a
   *  wounded ally that someone else just healed turns around instead of arriving to spend
   *  mana on a full-health unit. */
  private autocastWants(u: SimUnit, t: SimUnit, friendly: boolean, code: string, selfOk: boolean, flags: string[]): boolean {
    if (t.building || t.hp <= 0) return false;
    // The pick must satisfy the same Targets Allowed gate the cast itself will run.
    // Without this the search happily returns a target issueCast then refuses — and a
    // Shaman standing between a Gryphon and a Grunt would keep choosing the Gryphon for
    // his ground-only Lightning Shield and never shield anything at all.
    if (this.targetError(u, t, flags, code) !== null) return false;
    // Skip the caster unless the spell's flags permit self-targeting (a `self`
    // autocast like Priest Heal can pick itself when it's the most-hurt ally).
    if (t === u && !(friendly && selfOk)) return false;
    if (friendly) {
      if (!this.allied(u, t) || t.mechanical) return false;
      if (code === "Ahea" && t.hp >= t.maxHp) return false; // only wounded
      return true;
    }
    if (!this.hostile(u, t) || t.invulnerable) return false;
    if (u.buffs.length && this.findBuffFrom(t, u.id)) return false;
    return true;
  }

  /** Re-ask autocastWants for a cast the unit is still walking to. Rebuilds the same
   *  friendly/self flags tickAutocast derived from the ability's Targets Allowed. */
  private autocastStillWanted(u: SimUnit, t: SimUnit, def: AbilityDef): boolean {
    const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
    const friendly = !F.has("enemy") && (F.has("friend") || F.has("self") || F.has("player"));
    return this.autocastWants(u, t, friendly, def.code, F.has("self"), def.targetFlags);
  }

  private findBuffFrom(t: SimUnit, sourceId: number): SimBuff | undefined {
    return t.buffs.find((b) => b.sourceId === sourceId);
  }

  /** Launch a spell projectile that runs the ability's effect on its target on
   *  impact (Storm Bolt hammer, Death Coil orb). */
  private spawnSpellProjectile(u: SimUnit, targetId: number, def: AbilityDef, rank: number): void {
    const id = this.nextProjectileId++;
    // Launch from the caster's weapon model point if it has one (e.g. the Death
    // Knight's Death Coil from his hand); otherwise from a default missile height so
    // it never leaves from the feet.
    const w = u.weapon;
    const lzLocal = w && w.launchZ > 0 ? w.launchZ : DEFAULT_MISSILE_HEIGHT;
    const [lx, ly, lz0] = launchPoint(u, w?.launchX ?? 0, w?.launchY ?? 0, lzLocal);
    const t = this.units.get(targetId);
    // Same height handling as attacks: launch from the caster's altitude, land at
    // the target's (a flying caster's/target's spell missile tracks their height).
    const lz = lz0 + u.flyHeight;
    const impactBase = w && w.impactZ > 0 ? w.impactZ : DEFAULT_MISSILE_HEIGHT;
    const proj: SimProjectile = {
      id,
      x: lx,
      y: ly,
      z: lz,
      sourceId: u.id,
      targetId,
      // The row's own `Missilespeed` (Storm Bolt 900, Death Coil 750, Frost Nova 900…),
      // falling back to the 900 this used to hardcode for a row that names none.
      speed: def.missileSpeed || 900,
      damage: 0, // spell effect (not plain damage) is applied on impact
      art: def.missileArt,
      spell: { code: def.code, rank, abilityId: def.id },
      startZ: lz,
      impactZ: impactBase + (t?.flyHeight ?? 0),
      startDist: t ? Math.hypot(t.x - lx, t.y - ly) : 0,
    };
    this.projectiles.set(id, proj);
    this.spawnedProjectiles.push({ id, art: proj.art, x: proj.x, y: proj.y, z: proj.z });
  }

  /**
   * Launch a travelling WAVE (see SimProjectile.wave, and SpellApi.launchWave for the
   * contract). False when the ability has NEITHER a `Missileart` to carry nor a trail to
   * lay — nothing to draw, so the caller sweeps the line instantly instead (Forked
   * Lightning's cone, or a custom map that has stripped the art).
   */
  private spawnWaveProjectile(u: SimUnit, def: AbilityDef, rank: number, o: WaveOptions): boolean {
    if (!def.missileArt && !o.trail?.art) return false;
    const dx = o.tx - u.x;
    const dy = o.ty - u.y;
    const len = Math.hypot(dx, dy) || 1;
    const id = this.nextProjectileId++;
    // A wave hugs the ground it sweeps rather than arcing: launch height stays put, so
    // startZ and impactZ are the same and the renderer's height lerp is a no-op.
    const w = u.weapon;
    const lzLocal = w && w.launchZ > 0 ? w.launchZ : DEFAULT_MISSILE_HEIGHT;
    // A wave that SHOWS a missile leaves the front of the caster, not his middle. The
    // melee casters that throw one name no launch offset at all — UnitWeapons has LaunchX,
    // LaunchY and LaunchZ blank for the Brewmaster, the Warden and the Tauren Chieftain —
    // so `launchPoint` puts the model dead on the unit's origin, i.e. inside him, and the
    // first frames of Breath of Fire were drawn coming out of the panda's back. One hull
    // radius forward is the front of the model, which is where his mouth is. Only for a
    // wave with a missile: a TRAIL wave (Impale) is the ground bursting open and its first
    // tendril belongs at the caster's feet.
    const nose = def.missileArt && !(w && (w.launchX || w.launchY)) ? u.radius : 0;
    const [lx, ly, lz0] = launchPoint(u, (w?.launchX ?? 0) + nose, w?.launchY ?? 0, lzLocal);
    const lz = lz0 + u.flyHeight;
    const proj: SimProjectile = {
      id,
      x: lx,
      y: ly,
      z: lz,
      sourceId: u.id,
      targetId: 0, // a wave chases nobody
      speed: o.speed || def.missileSpeed || 1000,
      damage: 0,
      art: def.missileArt, // "" for a trail wave: it is the ground that shows it, not a model
      spell: { code: def.code, rank, abilityId: def.id },
      startZ: lz,
      impactZ: lz,
      startDist: o.dist,
      wave: {
        ox: lx, oy: ly, dirX: dx / len, dirY: dy / len,
        dist: o.dist, travelled: 0, halfWidth: o.halfWidth, budget: o.budget ?? 0, hit: [],
        // The first tendril bursts at the caster's feet, so the next mark is one step out.
        trail: o.trail ? { art: o.trail.art, step: o.trail.step, next: 0 } : undefined,
      },
    };
    this.projectiles.set(id, proj);
    this.spawnedProjectiles.push({ id, art: proj.art, x: proj.x, y: proj.y, z: proj.z });
    return true;
  }

  /** Sweep a wave forward and hand the spell to everything its front has just reached.
   *  Each unit is struck once (`hit`), the ability's own `targs1` says what may be struck
   *  at all (targsAdmit — allegiance stays the handler's, as everywhere else), and the
   *  wave dies at the end of its run whether or not it found anything. */
  private tickWaveProjectile(p: SimProjectile, dt: number): void {
    const w = p.wave!;
    w.travelled = Math.min(w.dist, w.travelled + p.speed * dt);
    p.x = w.ox + w.dirX * w.travelled;
    p.y = w.oy + w.dirY * w.travelled;
    // Lay the trail the front has just passed over (Impale's tendrils). Each mark is a
    // one-shot effect standing on the ground at its own spot, so the row of them stays
    // behind the wave rather than travelling with it.
    const trail = p.wave!.trail;
    while (trail && trail.next <= w.travelled) {
      this.spellEffects.push({ art: trail.art, x: w.ox + w.dirX * trail.next, y: w.oy + w.dirY * trail.next, targetId: 0, z: 0 });
      trail.next += Math.max(1, trail.step); // never zero — a zero step would spin here forever
    }
    const caster = this.units.get(p.sourceId); // may have died — the wave carries on regardless
    const def = this.abilities?.get(p.spell!.abilityId);
    if (caster && def) {
      for (const t of this.unitsInAreaInternal(p.x, p.y, w.halfWidth + WAVE_SWEEP_MARGIN)) {
        if (t.id === caster.id || t.hp <= 0 || w.hit.includes(t.id)) continue;
        if (!this.targsAdmit(t, def.targetFlags)) continue;
        const rx = t.x - w.ox;
        const ry = t.y - w.oy;
        const forward = rx * w.dirX + ry * w.dirY;
        const perp = Math.abs(rx * w.dirY - ry * w.dirX);
        if (perp > w.halfWidth + t.radius) continue;
        if (forward < -t.radius || forward > w.travelled + t.radius) continue; // the front is not there yet
        w.hit.push(t.id);
        const ctx = { targetId: t.id, x: t.x, y: t.y, wave: w };
        this.applySpellEffect(p.spell!.code, p.spell!.rank, caster, ctx, def);
        w.budget = ctx.wave.budget; // the handler spends the wave's allowance (Carrion Swarm)
      }
    }
    if (w.travelled >= w.dist) {
      // The run is over — and a wave DIES at the end of it rather than blinking out. Its
      // model is the spell (see spells AOsh), and ShockwaveMissile.mdx, like every missile,
      // carries a Death clip for the moment it stops; skipping it snapped the wedge out of
      // existence mid-sweep. Recorded as an IMPACT at the wave's own front, which is the
      // path the renderer already plays a missile's Death clip down (impactProjectile) —
      // and the path a frozen client has always taken for a wave, since its applier treats
      // every removed projectile as one. Missiles with no Death clip still just detach.
      this.projectileImpacts.push({ id: p.id, x: p.x, y: p.y, z: p.impactZ });
      this.removeProjectile(p.id);
    }
  }

  /** Spend a Spell Shield on this cast, if the target is wearing one and the cast is an
   *  enemy's. True = the spell was eaten and must not run.
   *
   *  The AMULET regrows its shield on `ANss` `Cool1` = 40 seconds ("once every <ANss,Cool1>
   *  seconds"), which is what the re-arm below is: the wearer's own item puts the buff back.
   *  The RUNE (`ANse`) grants no cooldown column at all, so its shield is one block and gone
   *  — the same buff, told apart by whether the holder is still carrying an amulet. */
  private consumeSpellShield(caster: SimUnit, targetId: number): boolean {
    const t = this.units.get(targetId);
    if (!t || t === caster || !t.buffs.some((b) => b.kind === "spellShield")) return false;
    if (!this.hostile(caster, t)) return false;
    t.buffs = t.buffs.filter((b) => b.kind !== "spellShield");
    const amulet = this.itemAbility(t, "ANss");
    if (amulet) t.spellShieldCooldown = amulet.level.cooldown || 40;
    // The block's own flash — `BNss`'s art, worn where the spell would have landed.
    const fxDef = amulet?.def ?? this.abilityByCode("ANse");
    if (fxDef?.buffArt) this.spellEffects.push({ art: fxDef.buffArt, x: t.x, y: t.y, targetId: t.id, z: 0 });
    return true;
  }

  /** Run a spell's effect handler (dispatched on base `code`). Shared by instant
   *  casts and spell-projectile impacts. */
  applySpellEffect(code: string, rank: number, caster: SimUnit, ctx: CastContext, def?: AbilityDef): void {
    const handler = SPELL_HANDLERS[code];
    const d = def ?? (this.abilities ? this.abilityByCode(code) : undefined);
    if (!handler || !d) return;
    // Spell Shield (`ANss` on the Amulet, `ANse` on the Rune of Shielding): "Blocks a
    // negative spell that an enemy casts on the Hero." It is spent on the CAST, before any
    // of it lands — the shield is what the spell hit — and only by a spell that was aimed
    // AT the wearer by somebody hostile: an area effect that happens to catch him is not a
    // spell cast on him, and neither is a friendly one.
    if (ctx.targetId && this.consumeSpellShield(caster, ctx.targetId)) return;
    // Which ability is casting, for the length of the handler. Every buff it applies belongs
    // to this ability's buff row unless it says otherwise, so `applyBuff` can fill `buffId`
    // in rather than each of the ~90 handlers repeating it — and a handler that applies a
    // DIFFERENT row (a drain picks among nine) still just passes its own. Saved and restored
    // because a handler may cast in turn (Chain Lightning's bounce, an item's sub-ability).
    const outer = this.casting;
    this.casting = { def: d, rank: Math.max(1, rank) };
    // Casting something HARMFUL at a unit is attacking it, and the victim answers the same
    // way it answers a blow: it wakes, it returns fire, and its camp comes with it (see
    // provoke). Whether it is harmful is not a property list to keep — it is simply whether
    // the caster is hostile to whoever it just aimed at.
    //
    // Raised BEFORE the handler, because two of them leave nothing to raise it from
    // afterwards: Transmute (`ANtm`) deletes its victim outright, so a camp alerted after
    // the fact would be alerted by a corpse, and Acid Bomb (`ANab`) lands its damage as a
    // dot that the victim's own tick spends against `hp` directly rather than through
    // landDamage. Neither ever reached the aggro path at all — an Alchemist could bomb or
    // transmute a creep camp and walk away unchased.
    const victim = ctx.targetId ? this.units.get(ctx.targetId) : undefined;
    if (victim && this.hostile(caster, victim)) this.provoke(victim, caster.id);
    try {
      handler(this.spellApi, caster, d, Math.max(1, rank), ctx);
    } finally {
      this.casting = outer;
    }
    // A drain is a channel whose effect is a pair of buffs rather than a field, so it is
    // recorded here — the one place that knows the caster AND the victim — for tickDrains to
    // tear down if the channel breaks. Re-casting replaces the caster's own entry: WC3 lets
    // one drain per caster, and the old buffs are re-applied over rather than stacked.
    if (code === "AHdr" && ctx.targetId > 0) {
      this.drains = this.drains.filter((x) => x.casterId !== caster.id);
      this.drains.push({ casterId: caster.id, targetId: ctx.targetId });
    }
  }

  /** Live Drain channels (Life Drain / Siphon Mana): caster → victim.
   *
   *  The drain's damage-over-time and the caster's matching heal are ordinary timed buffs,
   *  which is right while the channel runs and wrong the moment it breaks — a buff does not
   *  know its caster walked away. This is the same interrupt test tickSpellFields makes for
   *  Blizzard and friends, applied to a channel whose effect lives on two units instead of in
   *  a field: re-tasked away from "cast" with channel time left, stunned, dead, or started
   *  another spell → strip the drain buffs off BOTH ends and cut the beam.
   *
   *  A channel that simply ran out is not an interrupt: `channelLeft` has reached 0 and the
   *  buffs expire on their own clock the same tick, so they are left alone. */
  private drains: Array<{ casterId: number; targetId: number }> = [];

  /**
   * Spend an Anti-magic Shell's pool against incoming SPELL damage and return what is left to
   * actually land.
   *
   * On this seam and nowhere else, for the same reason Magic Immunity sits here: `landDamage`
   * is also the ATTACK path, and a shielded unit is hit by weapons perfectly normally — the
   * barrier "stops <Aam2,DataC1> points of SPELL damage" and nothing else. A unit can wear
   * more than one (they are separate casts on separate buff instances), so they are drained in
   * turn until the blow is used up; each one dies the moment its pool does, which is what makes
   * the shell a quantity rather than a duration.
   */
  private absorbSpellDamage(t: SimUnit, amount: number): number {
    let left = amount;
    for (let i = t.buffs.length - 1; i >= 0 && left > 0; i--) {
      const b = t.buffs[i];
      if (b.kind !== "spellAbsorb" || b.value <= 0) continue;
      const eaten = Math.min(b.value, left);
      b.value -= eaten;
      left -= eaten;
      if (b.value <= 0) t.buffs.splice(i, 1); // the pool is the buff: spent is expired
    }
    return left;
  }

  /**
   * Possessions in progress (`Aps2`) — the Banshee's ultimate, mid-flight.
   *
   * Held here rather than on either unit for the reason the drains above are: it is a fact
   * about a PAIR, and both ends can be destroyed independently. The tooltip is the spec —
   * "Stuns a target unit and the Banshee for <Aps2,Dur1> seconds, during which the Banshee
   * takes extra damage from attacks. She then displaces the soul of the enemy, giving you
   * permanent control of it, but destroying the caster's body." — so the cast lands two stuns
   * and a vulnerability and leaves this behind; `tickPossessions` is what "she then" means.
   *
   * Both ends are also the counterplay: kill the Banshee inside those 4.5 seconds (which the
   * +66% she is wearing is there to make possible) and the soul stays where it is.
   */
  private possessions: Array<{ casterId: number; targetId: number; left: number }> = [];

  /** Begin one (SpellApi.possess). The buffs are the handler's; this is the clock. */
  beginPossession(casterId: number, targetId: number, seconds: number): void {
    this.possessions = this.possessions.filter((p) => p.casterId !== casterId);
    this.possessions.push({ casterId, targetId, left: seconds });
  }

  private tickPossessions(dt: number): void {
    if (!this.possessions.length) return;
    let w = 0;
    for (const p of this.possessions) {
      const caster = this.units.get(p.casterId);
      const target = this.units.get(p.targetId);
      p.left -= dt;
      // Either body destroyed before the clock ran out and nothing happens: the soul stays
      // where it is and the survivor simply loses the stun with the buff. No cleanup needed
      // for the dead end, and the live one's stun expires on its own — it was given the same
      // duration as this clock, so it has at most a tick left anyway.
      if (!caster || caster.hp <= 0 || !target || target.hp <= 0) continue;
      if (p.left > 0) {
        this.possessions[w++] = p;
        continue;
      }
      // …and the trade completes. The soul changes hands PERMANENTLY (this is not a Charm
      // with a timer), the stun that held the body goes with the possession that placed it,
      // and the Banshee's body is destroyed — killed rather than removed, so it dies the way
      // anything dies: a death animation, a corpse, and the kill credited to nobody.
      this.stripPossession(target);
      this.changeUnitOwner(target, caster.owner, caster.team);
      this.recomputeStats(target);
      this.kill(caster, 0);
    }
    this.possessions.length = w;
  }

  /** Take the possession's own buffs off a unit (the stun that held it, the vulnerability the
   *  Banshee wore). Keyed by the buff GROUP the handler stamps, so nothing else is touched. */
  private stripPossession(u: SimUnit): void {
    if (!u.buffs.length) return;
    const before = u.buffs.length;
    u.buffs = u.buffs.filter((b) => b.group !== POSSESSION_GROUP);
    if (u.buffs.length !== before) this.recomputeStats(u);
  }

  /** The ability whose handler is running right now, if any — see applySpellEffect. Only
   *  the SpellApi's applyBuff reads it, to fill in the buff row a handler didn't name. */
  private casting: { def: AbilityDef; rank: number } | null = null;

  private tickDrains(): void {
    if (!this.drains.length) return;
    let w = 0;
    for (const dr of this.drains) {
      const caster = this.units.get(dr.casterId);
      const target = this.units.get(dr.targetId);
      const pc = caster?.pendingCast;
      const channelling = !!caster && caster.hp > 0 && !!pc && pc.code === "AHdr" && pc.channelLeft > 0 && caster.order === "cast";
      if (channelling && target && target.hp > 0) {
        this.drains[w++] = dr; // still draining
        continue;
      }
      // Over, one way or another — and the two cases need no telling apart. An INTERRUPT has
      // to strip buffs that would otherwise keep draining for a caster who walked away; a
      // channel that ran its course reaches here on the very tick its buffs expire and its
      // beam finishes fading, so the same cleanup costs it nothing.
      this.stripDrain(caster);
      this.stripDrain(target);
      this.spellLightningStops.push(drainTag(dr.casterId));
    }
    this.drains.length = w;
  }

  /** Take the drain buffs (and their art) off one end of a broken channel. */
  private stripDrain(u: SimUnit | undefined): void {
    if (!u || !u.buffs.length) return;
    const before = u.buffs.length;
    u.buffs = u.buffs.filter((b) => b.group !== DRAIN_GROUP);
    if (u.buffs.length !== before) this.recomputeStats(u);
  }

  private abilityByCode(code: string): AbilityDef | undefined {
    if (!this.abilities) return undefined;
    for (const a of this.abilities.all()) if (a.code === code) return a;
    return undefined;
  }

  // === hero XP / leveling ===================================================

  /** Award XP to the killer's heroes for a kill (Liquipedia sharing rules). */
  private awardKillXp(victim: SimUnit, killerId: number): void {
    if (victim.building || !killerId) return; // structures / unattributed deaths grant no XP
    const killer = this.units.get(killerId);
    // Only an ENEMY kill grants XP: killing your own or an allied unit (same team),
    // or a neutral-passive critter/shop, awards nothing (issue #21). Without this the
    // even-share loop finds no eligible hero and the global fallback below would still
    // reward the killer's own heroes for a friendly-fire kill.
    if (killer && !this.hostile(killer, victim)) return;
    // A slain enemy hero pays out the (much larger) GrantHeroXP table; everything
    // else pays GrantNormalXP. Both are indexed by the victim's own level.
    let base = grantedXp(victim.level || 0, victim.isHero);
    if (base <= 0) return;
    if (victim.isSummon) base *= SUMMON_XP_FACTOR;
    // Beneficiaries: enemy heroes of the victim within share range (else global).
    // NB max-level heroes are deliberately NOT excluded — MiscGame
    // MaxLevelHeroesDrainExp=1, so a level-10 hero standing in range still claims a
    // share of the pool (which gainXp then discards), shrinking what its lower-level
    // team-mates receive. This is real WC3 behaviour, not an oversight.
    const eligible: SimUnit[] = [];
    for (const h of this.units.values()) {
      if (!h.isHero || h.hp <= 0 || h.team === victim.team) continue;
      if (killer && h.team !== killer.team) continue; // only the killer's side (team = alliance group)
      if (Math.hypot(h.x - victim.x, h.y - victim.y) <= XP_SHARE_RANGE) eligible.push(h);
    }
    if (!eligible.length) {
      // No hero in range: GlobalExperience=1 — award to ALL the killer's heroes
      // regardless of distance (still split among them, no per-distance loss).
      for (const h of this.units.values()) {
        if (h.isHero && h.hp > 0 && killer && h.team === killer.team) eligible.push(h);
      }
    }
    if (!eligible.length) return;
    const share = base / eligible.length; // split evenly among the sharers
    for (const h of eligible) {
      let amount = share;
      const isCreep = victim.team === -1; // Neutral Hostile
      if (isCreep) amount *= creepXpFactor(h.level);
      const before = h.xp;
      this.gainXp(h, amount, isCreep);
      // What the hero ACTUALLY banked, floated over the hero (issue #116). Reading the pool
      // rather than echoing `amount` is what makes the number honest: gainXp turns a share
      // away at max level, and drops the overshoot when a creep kill pushes a hero past the
      // level where creeps stop counting (HeroFactorXP=0) — so the "+0" cases report nothing
      // at all, which is also what the client does.
      this.floatCredit("xp", h.xp - before, h.owner, h, h.id);
    }
  }

  /**
   * Pay the killer's player the bounty on a body — the "+N" gold a slain creep leaves behind.
   *
   * The amount is the victim TYPE's own roll (UnitDef.bountyDice/Sides/Plus): a flat base plus
   * dice, the same shape as a weapon's damage, off the sim's own RNG so every client rolls the
   * same coins. Whether a body pays at all is not a property of the body, though — it is
   * `PLAYER_STATE_GIVES_BOUNTY` on the player that owned it, which is why a Footman carries a
   * 20 + 6d3 bounty that nobody in a melee game ever collects. Blizzard.j names the default by
   * what it bothers to change: `ConfigureNeutralVictim` explicitly zeroes the state for Neutral
   * Victim ("Neutral Victim does not give bounties", Blizzard.j 5044) and touches no other
   * player — so the neutrals give bounty and the twelve human slots do not. In a melee match
   * that reduces to exactly the rule everyone knows: creeps pay, players don't.
   */
  private awardBounty(victim: SimUnit, killerId: number): void {
    if (victim.team !== -1) return; // not Neutral Hostile — nobody is paying (see above)
    const killer = killerId ? this.units.get(killerId) : undefined;
    if (!killer || !this.hostile(killer, victim)) return; // unattributed, or your own doing
    const def = this.unitReg?.get(victim.typeId);
    if (!def) return;
    const gold = this.rollBounty(def.bountyPlus, def.bountyDice, def.bountySides);
    const lumber = this.rollBounty(def.lumberBountyPlus, def.lumberBountyDice, def.lumberBountySides);
    const stash = this.stashOf(killer.owner);
    stash.gold += gold;
    stash.lumber += lumber;
    // Over the BODY, not over the killer: it is the corpse that turned into the money, and
    // that is where the player is looking. Placed rather than attached, for the same reason a
    // deny's "!" is — a moment later there is nothing left to follow.
    this.floatCredit("bounty", gold, killer.owner, victim);
    this.floatCredit("lumber", lumber, killer.owner, victim);
  }

  /** `plus` + `dice`×d`sides`, off the sim RNG — the bounty roll, identical in shape to the
   *  damage roll (see rollDamage's `1 + floor(rng * sides)`). */
  private rollBounty(plus: number, dice: number, sides: number): number {
    let n = Math.max(0, Math.round(plus));
    for (let i = 0; i < dice && sides > 0; i++) n += 1 + Math.floor(this.rng() * sides);
    return n;
  }

  /** Add XP to a hero, leveling it up (with stat growth) across thresholds. */
  gainXp(hero: SimUnit, amount: number, isCreep = false): void {
    if (!hero.isHero || hero.level >= MAX_HERO_LEVEL || amount <= 0) return;
    hero.xp += amount;
    while (hero.level < MAX_HERO_LEVEL && hero.xp >= xpToReachLevel(hero.level + 1)) {
      this.levelUp(hero);
      // WC3: once a hero reaches a level where creeps grant no XP (HeroFactorXP=0 at
      // level 5+), any surplus that a creep kill pushed past the threshold is dropped
      // — the overshoot came from a creep and must not count (issue #30). The bar sits
      // exactly at the new level's threshold rather than carrying leftover creep XP.
      if (isCreep && creepXpFactor(hero.level) === 0) {
        hero.xp = xpToReachLevel(hero.level);
        break;
      }
    }
  }

  private levelUp(hero: SimUnit): void {
    hero.level++;
    hero.skillPoints++;
    // Levelling does NOT refill (issue #69). The new strength/intellect raise the ceiling and
    // recomputeStats carries the current pool up with it in proportion — a hero who dings at
    // 100/1000 comes out at 105/1050, not healed to full. A level-up is not an escape.
    this.recomputeStats(hero); // new maxHp/maxMana/attributes, current pool scaled with them
    this.levelUps.push({ unitId: hero.id, level: hero.level }); // renderer: level-up nova
    // EVENT_(PLAYER_)HERO_LEVEL for the trigger engine (7.17) — a separate queue from
    // the renderer's, since each side drains its own.
    if (this.captureHeroEvents) this.heroEvents.push({ hero: eventInfo(hero), phase: "level", level: hero.level, abilityId: "" });
    // A hero's images level with him, nova and all. They are copies of him as he is NOW, so
    // a Blademaster who dinged while his images stood beside him would otherwise be the only
    // one of the four to grow and flash — pointing straight at the real one.
    for (const im of this.units.values()) {
      if (im.isIllusion && im.illusionOf === hero.id && im.hp > 0) this.levelUpIllusion(im, hero);
    }
  }

  /** Make a freshly-spawned copy into an illusion of `ofId`. Called by the renderer once the
   *  unit exists (spawning is async — see drainSummonRequests).
   *
   *  Order matters, which is why this is one method and not six writes at the call site: the
   *  level must land BEFORE recomputeStats, and hp/mana can only be set once that has run.
   *  Spawning starts every hero at the unit TYPE's level 1, so an image of a level-5
   *  Blademaster arrives with a level-1 pool; leave it and the next tick's recomputeStats
   *  raises its maxHp past its hp and the copy stands there looking wounded. */
  initIllusion(u: SimUnit, ofId: number, init: IllusionInit): void {
    u.isIllusion = true;
    u.illusionOf = ofId;
    u.illusionDamageDealt = init.dealt; // AOmi DataB "Damage Dealt (%)" — 0: it hurts nothing
    u.illusionDamageTaken = init.taken; // AOmi DataC "Damage Taken (%)" — 200%
    u.properName = init.properName; // the original's name, not the fresh roll spawning gave it
    u.level = Math.max(1, init.level);
    // Tomes are PERMANENT and live in the original's base attributes (applyPowerup bumps
    // baseStr/baseAgi/baseInt/baseMaxHp), so a copy spawned off the unit type alone would be
    // missing every tome he ever drank — visibly weaker on the sheet than the hero beside it.
    u.baseStr = init.baseStr;
    u.baseAgi = init.baseAgi;
    u.baseInt = init.baseInt;
    u.baseMaxHp = init.baseMaxHp;
    // The original's items, as INERT copies: same itemId (so the panel draws the same six
    // slots and itemBonuses grants the same +damage/+armour/+stats), but no entity id. An
    // item is ONE entity that JASS handles track across ground↔inventory (see HeldItem.id);
    // handing four copies the original's ids would have four units claiming to hold it. The
    // image can't drop, give or use them anyway — see the isIllusion guards on those.
    u.inventory = init.inventory.map((it) => (it ? { id: 0, itemId: it.itemId, charges: it.charges, cooldownLeft: 0 } : null));
    this.recomputeStats(u); // maxHp/maxMana/attributes off THAT level, tomes and items
    u.hp = u.maxHp;
    u.mana = Math.min(u.maxMana, init.mana); // the original's pool as it stands after the cast
  }

  /** Bring an illusion up to its hero's new level. Not levelUp(): an image earns nothing of
   *  its own — no skill point (it cannot learn or cast), and no HERO_LEVEL event, which is
   *  the player's hero levelling and must fire once, not once per copy. */
  private levelUpIllusion(im: SimUnit, hero: SimUnit): void {
    im.level = hero.level;
    // The hero's pool rides his new ceiling in proportion, so the images' must too — matching
    // pools is the whole point. recomputeStats does exactly that for both.
    this.recomputeStats(im); // new maxHp/maxMana/attributes off the level
    this.levelUps.push({ unitId: im.id, level: im.level }); // the same nova, on every image
  }

  /** Learn (or rank up) a hero ability by spending a skill point. Returns true on
   *  success. Enforces the hero level requirement, max ranks, and points. */
  learnAbility(unitId: number, abilityId: string): boolean {
    const u = this.units.get(unitId);
    if (!u || !u.isHero || u.skillPoints <= 0 || !this.abilities) return false;
    const def = this.abilities.get(abilityId);
    if (!def) return false;
    const ab = u.abilities.find((a) => a.id === abilityId);
    if (!ab || ab.level >= def.levels) return false;
    if (u.level < requiredHeroLevel(def, ab.level + 1)) return false;
    ab.level++;
    u.skillPoints--;
    // EVENT_(PLAYER_)HERO_SKILL → GetLearningUnit/GetLearnedSkill/GetLearnedSkillLevel.
    if (this.captureHeroEvents) this.heroEvents.push({ hero: eventInfo(u), phase: "skill", level: ab.level, abilityId });
    return true;
  }

  // === trigger effect API (7.17) ===========================================
  // The natives a map's triggers call to grant abilities, level heroes, and flip
  // per-unit flags. Each is a thin, guarded mutation the JASS bridge routes into
  // (src/jass/natives/abilities.ts + world.ts → EngineHooks).

  /** UnitAddAbility — grant an ability, already usable (WC3 adds it at rank 1, even
   *  a hero ability: it is *added*, not made learnable). A duplicate is a no-op. */
  addAbility(unitId: number, abilityId: string): boolean {
    const u = this.units.get(unitId);
    const def = this.abilities?.get(abilityId);
    if (!u || !def) return false;
    if (u.abilities.some((a) => a.id === abilityId)) return false;
    u.abilities.push({ id: abilityId, code: def.code, level: 1, cooldownLeft: 0, autocastOn: false });
    this.recomputeStats(u); // an ability can carry stat bonuses / an aura
    return true;
  }

  /** UnitRemoveAbility — take an ability away (and any cast of it in flight). */
  removeAbility(unitId: number, abilityId: string): boolean {
    const u = this.units.get(unitId);
    if (!u) return false;
    const i = u.abilities.findIndex((a) => a.id === abilityId);
    if (i < 0) return false;
    u.abilities.splice(i, 1);
    if (u.pendingCast?.abilityId === abilityId) this.stop(u.id);
    this.recomputeStats(u);
    return true;
  }

  /** GetUnitAbilityLevel — the unit's rank in an ability (0 = doesn't have it, or a
   *  hero ability it hasn't learned). */
  abilityLevelOf(unitId: number, abilityId: string): number {
    return this.units.get(unitId)?.abilities.find((a) => a.id === abilityId)?.level ?? 0;
  }

  /** SetUnitAbilityLevel (and Inc/DecUnitAbilityLevel, which ride on it) — set the
   *  rank directly, clamped to the ability's max. Returns the resulting rank. */
  setAbilityLevel(unitId: number, abilityId: string, level: number): number {
    const u = this.units.get(unitId);
    const ab = u?.abilities.find((a) => a.id === abilityId);
    const def = this.abilities?.get(abilityId);
    if (!u || !ab || !def) return 0;
    ab.level = Math.max(0, Math.min(def.levels || 1, Math.trunc(level)));
    this.recomputeStats(u);
    return ab.level;
  }

  /** UnitResetCooldown — clear every ability cooldown on the unit. */
  resetCooldowns(unitId: number): void {
    const u = this.units.get(unitId);
    if (u) for (const a of u.abilities) a.cooldownLeft = 0;
  }

  /** SetHeroLevel — jump a hero to `level`. WC3 only ever levels a hero UP with this
   *  (a lower level is ignored), granting the skill points and stat growth of each
   *  level crossed — so it runs the real levelUp path (nova, HP/mana refill, and the
   *  HERO_LEVEL event) once per level, and parks the XP bar at the new level's floor. */
  setHeroLevel(unitId: number, level: number): void {
    const h = this.units.get(unitId);
    if (!h?.isHero) return;
    const target = Math.min(MAX_HERO_LEVEL, Math.trunc(level));
    while (h.level < target) this.levelUp(h);
    h.xp = Math.max(h.xp, xpToReachLevel(h.level));
  }

  /** AddHeroXP — grant experience (levels follow through gainXp). Not a creep kill,
   *  so no HeroFactorXP discount applies. */
  addHeroXp(unitId: number, amount: number): void {
    const h = this.units.get(unitId);
    if (h) this.gainXp(h, amount);
  }

  /** SetHeroXP — set the XP bar directly, levelling the hero to match it. */
  setHeroXp(unitId: number, xp: number): void {
    const h = this.units.get(unitId);
    if (!h?.isHero) return;
    h.xp = Math.max(0, Math.trunc(xp));
    while (h.level < MAX_HERO_LEVEL && h.xp >= xpToReachLevel(h.level + 1)) this.levelUp(h);
  }

  /** UnitModifySkillPoints — add/remove unspent skill points (never below zero). */
  modifySkillPoints(unitId: number, delta: number): boolean {
    const h = this.units.get(unitId);
    if (!h?.isHero) return false;
    h.skillPoints = Math.max(0, h.skillPoints + Math.trunc(delta));
    return true;
  }

  /** SetUnitInvulnerable — the unit takes no damage and can't be targeted by enemies
   *  (issue #26's baseInvulnerable, which recomputeStats folds into `invulnerable`
   *  each tick alongside the buff-granted ones, so set both). */
  setInvulnerable(unitId: number, flag: boolean): void {
    const u = this.units.get(unitId);
    if (!u) return;
    u.baseInvulnerable = flag;
    u.invulnerable = flag || u.invulnerable;
    if (!flag) this.recomputeStats(u); // buffs may still hold it invulnerable
  }

  /** SetUnitPathing(false) — the unit ignores collision (walks through units and,
   *  in WC3, terrain; ours is the sim's existing ghost flag). */
  setPathing(unitId: number, flag: boolean): void {
    const u = this.units.get(unitId);
    if (u) u.noCollision = !flag;
  }

  /** Toggle an ability's autocast (Heal/Slow/…). Returns the new state. */
  toggleAutocast(unitId: number, code: string): boolean {
    const u = this.units.get(unitId);
    const ab = u ? this.findAbility(u, code) : undefined;
    if (!ab) return false;
    ab.autocastOn = !ab.autocastOn;
    return ab.autocastOn;
  }

  // === spell fields (Blizzard-style repeating area effects) =================

  private spellFields: Array<SpellFieldInit & { timer: number; done: number; team: number; flags: string[] }> = [];

  /** Waves that have been thrown but haven't hit the ground yet (see SHARD_FALL).
   *  They live OUTSIDE their field on purpose: shards already in the air still land
   *  when the channel is broken, so a Blizzard cancelled the instant before impact
   *  still deals that last wave. */
  private waveImpacts: Array<{ t: number; x: number; y: number; area: number; damage: number; casterId: number; team: number; flags: string[]; maxDamage: number; buildingReduction: number; dot: SpellFieldInit["dot"]; pctOfMax: boolean; buildingsOnly: boolean; fellsTrees: boolean }> = [];

  // --- Mirror Image (AOmi) ------------------------------------------------------------
  //
  // The shuffle, as the game stages it: the Blademaster vanishes and MirrorImageCaster
  // stands in his place; after the ability's own "Animation Delay" (DataD = 0.5s) that
  // effect throws one MirrorImageMissile per destination; each missile that lands puts an
  // illusion on its tile — except the one tile, picked at random, where the real hero is
  // set back down. Which of them is the true Blademaster is therefore anyone's guess,
  // including the caster's, and that IS the ability.
  //
  // It runs here rather than on the projectile system because these missiles fly to a
  // POINT and deal nothing; tickProjectiles is built around a target unit it damages.
  private mirrorCasts: Array<{
    casterId: number;
    abilityId: string;
    rank: number;
    delayLeft: number; // AOmi DataD "Animation Delay" — the beat before the missiles fly
    thrown: boolean;
    duration: number; // how long each illusion lasts (Dur1)
    dealt: number; // AOmi DataB "Damage Dealt (%)"
    taken: number; // AOmi DataC "Damage Taken (%)"
    /** The caster's mana the instant the spell went off — i.e. AFTER its 125 was paid. An
     *  image is a copy of the Blademaster as he is NOW, half-drained pool included; spawning
     *  it on a full bar would mark it out at a glance. Captured once here rather than read at
     *  landing, so all the images match each other and the hero exactly (mana regenerates
     *  during the missiles' flight). */
    mana: number;
    missileArt: string;
    /** One per destination tile. `hero` marks the single slot the real Blademaster takes. */
    spots: Array<{ x: number; y: number; hero: boolean; t: number; flight: number; sx: number; sy: number; landed: boolean }>;
  }> = [];

  /** Strip every timed buff (Dispel Magic; Mirror Image dispels its own caster). Auras
   *  re-apply on the next tick, so only the timed ones actually go. */
  private dispelUnit(u: SimUnit): void {
    // …except the ones no dispel may touch. Doom is the only one in 1.30 and it is the whole
    // ability: "This spell cannot be dispelled" — a Doomed unit is going to die.
    u.buffs = u.buffs.filter((b) => b.undispellable);
  }

  /** Begin Mirror Image: hide the caster, and work out where everyone lands. */
  private startMirrorImage(caster: SimUnit, def: AbilityDef, rank: number): void {
    const lvl = def.levelData[Math.min(rank, def.levelData.length) - 1];
    if (!lvl) return;
    const images = Math.max(1, Math.round(this.dataOf(lvl, 0, 1))); // DataA "Number of Images"
    // A re-cast replaces the pack: the previous images pop (each with its own
    // MirrorImageDeathCaster) rather than piling up alongside the new ones.
    for (const u of [...this.units.values()]) {
      if (u.isIllusion && u.owner === caster.owner && u.typeId === caster.typeId && u.hp > 0) this.unsummon(u);
    }
    // One tile per image PLUS one for the hero himself — he is shuffled in among them.
    const spots = this.mirrorSpots(caster, images + 1);
    if (!spots.length) return;
    const heroSlot = Math.floor(this.rng() * spots.length); // never a fixed slot: the whole
    // point is that the enemy (and the caster's own hand) cannot know which one is real.
    const speed = 1000; // AOmi Missilespeed
    this.mirrorCasts.push({
      casterId: caster.id,
      abilityId: def.id,
      rank,
      delayLeft: this.dataOf(lvl, 3, 0.5), // DataD "Animation Delay"
      thrown: false,
      duration: lvl.heroDuration || lvl.duration || 60,
      dealt: this.dataOf(lvl, 1, 0), // DataB "Damage Dealt (%)" — 0: an illusion hurts nothing
      taken: this.dataOf(lvl, 2, 2), // DataC "Damage Taken (%)"
      // The cost is spent UP FRONT at the cast commit (see the `committed` phase), so the
      // caster's pool is already post-cast by the time this handler runs.
      mana: caster.mana,
      missileArt: def.missileArt,
      spots: spots.map((s, i) => ({
        ...s,
        hero: i === heroSlot,
        t: 0,
        flight: Math.max(0.05, Math.hypot(s.x - caster.x, s.y - caster.y) / speed),
        sx: caster.x,
        sy: caster.y,
        landed: false,
      })),
    });
    // "Dispels all magic from the Blademaster" — straight off the Ubertip.
    this.dispelUnit(caster);
    caster.vanished = true; // off the field: hidden, untargetable, and it keeps him from
    // being attacked while the illusions are still in the air.
    this.stop(caster.id);
    if (def.specialArt) this.spellEffects.push({ art: def.specialArt, x: caster.x, y: caster.y, targetId: 0, z: 0 });
  }

  /** `count` free tiles to scatter the images (and the hero) across, nearest-fit around the
   *  caster so nobody lands in a cliff or a tree. Ordered randomly and spread over a ring,
   *  so the pattern differs every cast. */
  private mirrorSpots(caster: SimUnit, count: number): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    const n = caster.footprint || footprintCells(caster.radius);
    const start = this.rng() * Math.PI * 2; // random ring phase — never the same fan twice
    for (let i = 0; i < count; i++) {
      const ang = start + (i / count) * Math.PI * 2;
      const dist = 96 + this.rng() * 96;
      const wx = caster.x + Math.cos(ang) * dist;
      const wy = caster.y + Math.sin(ang) * dist;
      let spot = { x: wx, y: wy };
      if (this.grid) {
        const [cx, cy] = this.grid.footprintAnchor(wx, wy, n);
        const cell = this.grid.nearestFit(cx, cy, n, 14) ?? this.grid.nearestWalkable(cx, cy, 14);
        if (cell) {
          const [fx, fy] = this.grid.footprintCenter(cell[0], cell[1], n);
          spot = { x: fx, y: fy };
        }
      }
      out.push(spot);
    }
    return out;
  }

  private tickMirrorImage(dt: number): void {
    for (let i = this.mirrorCasts.length - 1; i >= 0; i--) {
      const m = this.mirrorCasts[i];
      const caster = this.units.get(m.casterId);
      // The Blademaster died (or was removed) mid-shuffle: drop the whole thing rather than
      // leave illusions of a hero who isn't there.
      if (!caster || caster.hp <= 0) {
        if (caster) caster.vanished = false;
        this.mirrorCasts.splice(i, 1);
        continue;
      }
      if (!m.thrown) {
        m.delayLeft -= dt;
        if (m.delayLeft > 0) continue; // MirrorImageCaster is still playing
        m.thrown = true;
        for (const s of m.spots) {
          this.mirrorMissiles.push({ art: m.missileArt, sx: s.sx, sy: s.sy, tx: s.x, ty: s.y, flight: s.flight });
        }
        continue;
      }
      let all = true;
      for (const s of m.spots) {
        if (s.landed) continue;
        s.t += dt;
        if (s.t < s.flight) { all = false; continue; }
        s.landed = true;
        if (s.hero) {
          // The real one steps out of the missile that happened to draw the short straw.
          caster.vanished = false;
          this.teleportUnit(caster, s.x, s.y);
        } else {
          this.spawnIllusion(caster, caster.owner, caster.team, caster.id, s.x, s.y, m);
        }
      }
      if (all) this.mirrorCasts.splice(i, 1);
    }
  }

  /** The illusion request itself — an exact copy of `of`, flagged so the sim knows it must
   *  not hurt anything and the renderer knows to tint it.
   *
   *  `of` and the OWNER are separate arguments because the two abilities that make illusions
   *  disagree about them: Mirror Image copies the caster and keeps him, while the Wand of
   *  Illusion copies whoever you point it at — including an enemy — and hands the copy to
   *  the player who waved the wand. Everything below is read off `of`, everything about
   *  allegiance off the arguments. */
  private spawnIllusion(of: SimUnit, owner: number, team: number, sourceId: number, x: number, y: number, m: { duration: number; dealt: number; taken: number; abilityId: string; mana: number; unsummonArt?: string }): void {
    const def = this.abilities?.get(m.abilityId);
    this.summonRequests.push({
      unitId: of.typeId,
      x,
      y,
      facing: of.facing,
      owner,
      team,
      summonLeft: m.duration,
      sourceId,
      summonArt: "",
      // Each image lands on the exact spot its missile flew to (the real hero teleports to
      // one of them), so the spot is final — never a step further along the caster's facing.
      atPoint: true,
      // An image popping is BOmi's Specialart (MirrorImageDeathCaster) — its folder-mate
      // MirrorImageDeath.wav rides it as a model SND event (AnimLookups AOMI).
      unsummonArt: m.unsummonArt ?? def?.buffSpecialArt ?? "",
      // An image is an exact copy, and that includes the name over its head and the level
      // in its bar. Spawning rolls a fresh proper name per hero and starts it at the unit
      // TYPE's level (1), so a level-5 Blademaster would have conjured three level-1 copies
      // wearing three different names — the enemy could pick the real one out of the pack
      // without swinging at it.
      illusion: {
        dealt: m.dealt,
        taken: m.taken,
        properName: of.properName,
        mana: m.mana,
        level: of.level,
        baseStr: of.baseStr,
        baseAgi: of.baseAgi,
        baseInt: of.baseInt,
        baseMaxHp: of.baseMaxHp,
        inventory: of.inventory.map((it) => (it ? { itemId: it.itemId, charges: it.charges } : null)),
      },
    });
  }

  /** MirrorImageMissile models in flight, drained by the renderer (they are pure visuals —
   *  the sim already knows where and when each one lands). */
  private mirrorMissiles: Array<{ art: string; sx: number; sy: number; tx: number; ty: number; flight: number }> = [];

  drainMirrorMissiles(): Array<{ art: string; sx: number; sy: number; tx: number; ty: number; flight: number }> {
    const out = this.mirrorMissiles;
    this.mirrorMissiles = [];
    return out;
  }

  private addSpellFieldInternal(f: SpellFieldInit): void {
    // Capture the caster's team + the ability's Targets Allowed (targs1) NOW, so the
    // field keeps affecting the right allegiances even after the caster dies mid-channel.
    const caster = this.units.get(f.casterId);
    const team = caster?.team ?? 0;
    const ab = caster ? this.findAbility(caster, f.code) : undefined;
    const flags = (ab && this.abilities?.get(ab.id)?.targetFlags) ?? [];
    // timer counts down to the next wave; seeding it with `delay` (default 0) postpones the
    // FIRST wave without dropping any (Flame Strike's subsiding burn starts after the pillar).
    this.spellFields.push({ ...f, timer: f.delay ?? 0, done: 0, team, flags });
  }

  /** Would an area effect with `flags` (the ability's targs1), cast by unit `casterId`
   *  on `casterTeam`, affect `t`? Allegiance follows targs1 EXACTLY, so WC3 friendly
   *  fire works: Flame Strike lists `enemy,friend,self`, and Blizzard/Rain of Fire/
   *  Death&Decay list no allegiance at all — every one of them damages your own units
   *  too. Only a spell that lists `enemy` WITHOUT `friend`/`self` (Starfall, Stampede,
   *  Cluster Rockets, Locust Swarm) stays enemy-only. The `self` flag makes the CASTER
   *  a valid target too (Flame Strike has it, so it burns its own caster if he stands
   *  in the fire); without `self`, the caster is spared. Neutral-passive shops/critters
   *  are spared unless `neutral` is allowed. Shared by the damage tick and the green
   *  valid-target preview so the highlight always matches who actually gets hit. */
  areaEffectAffects(casterId: number, casterTeam: number, flags: string[], t: SimUnit): boolean {
    if (t.hp <= 0) return false;
    const F = new Set(flags.map((x) => x.toLowerCase()));
    // What may be struck at all is targsKindError's answer, shared with single-target casts
    // and orbs — a field burns what its data says it burns. Flame Strike is `ground,…` and
    // so leaves a Gargoyle overhead alone; Death and Decay is `air,ground,structure` and
    // does not; Blizzard and Rain of Fire name no kind (`_`) and hit everything.
    if (targsKindError(t, flags) !== null) return false;
    if (t.neutralPassive) return F.has("neutral");
    const isSelf = t.id === casterId;
    const enemy = F.has("enemy");
    const friend = F.has("friend");
    const self = F.has("self");
    // No allegiance flag at all (Blizzard `_`, Death&Decay, Volcano's `notself`) → hit
    // everything in range except the caster (no `self` → the caster is spared).
    if (!(enemy || friend || self)) return !isSelf;
    if (isSelf) return self; // the caster is hit only when `self` is in targs1
    if (t.team === casterTeam) return friend; // own/allied (same team)
    return enemy; // different team
  }

  /** Ids of the units an area effect (`flags` = targs1) cast by `casterId`/`casterTeam`
   *  at (x,y,radius) would affect — the same set `tickSpellFields` damages. Drives the
   *  green valid-target preview (issue #20) so it matches reality, friendly fire and all. */
  areaEffectTargets(casterId: number, casterTeam: number, flags: string[], x: number, y: number, radius: number): number[] {
    const out: number[] = [];
    for (const t of this.unitsInAreaInternal(x, y, radius)) {
      if (this.areaEffectAffects(casterId, casterTeam, flags, t)) out.push(t.id);
    }
    return out;
  }

  private tickSpellFields(dt: number): void {
    for (let i = this.spellFields.length - 1; i >= 0; i--) {
      const f = this.spellFields[i];
      // A channelled field (Blizzard, Rain of Fire, Starfall, …) stops the instant
      // its caster is INTERRUPTED — re-tasked away from "cast" while channel time
      // remained, killed, or moved on to another cast — matching WC3. A channel that
      // ENDED normally (channelLeft reached 0) leaves the field to exhaust its own
      // final wave on schedule, so no tick is dropped. Fields from fire-and-forget
      // spells (Flame Strike, Volcano, Bladestorm) aren't in CHANNELED and run their
      // full course independently of the caster.
      if (CHANNELED.has(f.code)) {
        const caster = this.units.get(f.casterId);
        const pc = caster?.pendingCast;
        const interrupted = !caster || !pc || pc.code !== f.code || (caster.order !== "cast" && pc.channelLeft > 0);
        if (interrupted) {
          this.spellFields.splice(i, 1);
          continue;
        }
      }
      f.timer -= dt;
      if (f.timer <= 0) {
        f.timer = f.interval;
        f.done++;
        // The wave's damage lands when the wave does. A field with `impactDelay`
        // (Blizzard, Rain of Fire) throws its shards now and hurts on impact, 0.8s
        // later; every other field (Flame Strike's burn, Starfall, …) has no falling
        // art and detonates immediately.
        // `scatter`: the wave lands somewhere inside the field rather than dead centre.
        // Stampede is the reason — `Area1` = 1000 is the ground the herd covers, but a
        // single beast only catches `Nst4 "Damage Radius"` = 275 of it, sixty times over.
        let wx = f.x;
        let wy = f.y;
        if (f.scatter) {
          const a = this.rng() * Math.PI * 2;
          const r = f.scatter * Math.sqrt(this.rng());
          wx += Math.cos(a) * r;
          wy += Math.sin(a) * r;
        }
        const impact = {
          t: f.impactDelay ?? 0,
          x: wx,
          y: wy,
          area: f.area,
          damage: f.damagePerWave,
          casterId: f.casterId,
          team: f.team,
          flags: f.flags,
          maxDamage: f.maxDamagePerWave ?? 0,
          buildingReduction: f.buildingReduction ?? 0,
          dot: f.dot,
          pctOfMax: f.damagePctOfMax ?? false,
          buildingsOnly: f.buildingsOnly ?? false,
          fellsTrees: f.fellsTrees ?? false,
        };
        if (impact.t > 0) this.waveImpacts.push(impact);
        else this.landWave(impact);
        // Scatter the wave effect over the area (WC3 drops the ice shards across the
        // whole circle each wave, not just the centre). `artPerWave` copies land per
        // wave — Blizzard rains a cluster of 6, most fields just one. Each shard gets
        // its own sqrt-weighted radius so hits spread evenly over the disc, and the
        // angles are spaced one-per-sector (with jitter inside the sector) so a wave
        // never bunches all six shards on one side of the circle.
        if (f.art) {
          const n = f.artPerWave ?? 1;
          const base = this.rng() * Math.PI * 2;
          // Art spreads over whichever circle is bigger: the damage area, or the ground a
          // scattered field covers (Tranquility's rain fills its whole 900, Stampede's
          // beasts arrive anywhere in the herd's 1000).
          const spread = Math.max(f.area, f.scatter ?? 0);
          for (let s = 0; s < n; s++) {
            const ang = base + ((s + this.rng()) * Math.PI * 2) / n;
            const r = spread * Math.sqrt(this.rng());
            // `sound` cues the art's folder WAV — ONCE per wave (on the first shard),
            // not once per shard: six overlapping 3s BlizzardTarget clips a second
            // would be a wall of noise, where WC3 gives one shard-fall per wave.
            this.spellEffects.push({ art: f.art, x: wx + Math.cos(ang) * r, y: wy + Math.sin(ang) * r, targetId: 0, z: 0, sound: f.waveSound && s === 0 });
          }
        }
      }
      if (f.done >= f.waves) this.spellFields.splice(i, 1);
    }
    // Waves in flight: hurt whatever is standing there WHEN THEY LAND, not where the
    // targets were when the wave was thrown — so stepping out of the circle works.
    for (let i = this.waveImpacts.length - 1; i >= 0; i--) {
      const w = this.waveImpacts[i];
      w.t -= dt;
      if (w.t > 0) continue;
      this.waveImpacts.splice(i, 1);
      this.landWave(w);
    }
  }

  /** One wave of a repeating area field hitting the ground. */
  private landWave(w: (typeof this.waveImpacts)[number]): void {
    // Hit whoever the ability's targs1 allows — enemy-only for Starfall/Stampede,
    // but everyone (incl. your own units) for Flame Strike/Blizzard/Death&Decay.
    const hit = this.unitsInAreaInternal(w.x, w.y, w.area).filter((t) => this.areaEffectAffects(w.casterId, w.team, w.flags, t));
    // "Maximum Damage per Wave" (DataF): a wave has a damage BUDGET, not just a
    // per-unit figure. Blizzard's 30-per-wave with a 150 cap hits five units for full
    // and ten for 15 each — the classic WC3 AoE cap that stops a channelled nuke from
    // scaling forever with the size of the clump it lands on.
    const each = w.maxDamage > 0 && hit.length * w.damage > w.maxDamage ? w.maxDamage / hit.length : w.damage;
    for (const t of hit) {
      // Earthquake's `Oeq2` is "Damage per Second to BUILDINGS" and its units half is a
      // slow, so its waves pass straight through anything that walks.
      if (w.buildingsOnly && !t.building) continue;
      // "Building Reduction" (DataD): structures shrug off this fraction of the wave.
      let dmg = t.building ? each * (1 - w.buildingReduction) : each;
      // …and Death and Decay's is not a number of hit points at all but a SHARE of the
      // victim's pool (`Udd1 "Max Life Drained per Second (%)"` = 0.04), which is what
      // makes it the one spell a Town Hall genuinely fears.
      if (w.pctOfMax) dmg = t.maxHp * dmg;
      if (dmg > 0) this.landDamage(t, dmg, w.casterId, false); // spell damage: ignore armor
      // Rain of Fire's burn: every wave (re)lights whatever it hits for DataE dps.
      if (w.dot && w.dot.dps > 0 && !t.building) {
        this.applyBuffInternal(t, { kind: "dot", group: w.dot.group, timeLeft: t.isHero && w.dot.heroDuration > 0 ? w.dot.heroDuration : w.dot.duration, sourceId: w.casterId, value: w.dot.dps, art: w.dot.art, buffId: w.dot.buffId });
      }
    }
    // Burn down trees too when the ability lists `tree` in Targets Allowed
    // (Flame Strike's targs1 = ground,enemy,neutral,friend,structure,self,tree,debris —
    // MPQ AHfs). Each wave deals damagePerWave to a tree's HP; a standard 50-HP tree
    // falls after ~4 waves of L1 (15/wave), leaving a hole in the forest as in WC3.
    // …or when the ability says so itself: Death and Decay clears a forest in the real game
    // but its `targs1` (air,ground,structure,ward) has no way to express it (see fellsTrees).
    // A tree has no maximum life to take a percentage of, so a %-of-max field fells outright.
    if (w.fellsTrees) this.damageTreesInArea(w.x, w.y, w.area, Infinity);
    else if (w.flags.includes("tree")) this.damageTreesInArea(w.x, w.y, w.area, w.damage);
  }

  /** Apply `dmg` to the HP of every tree within `radius`; fell any that hit 0. Felled
   *  trees go through the same `felled` queue as harvest-felling, so the renderer
   *  unstamps their pathing, hides the model, and clears the sight blocker. */
  private damageTreesInArea(x: number, y: number, radius: number, dmg: number): void {
    let fell: SimTree[] | null = null;
    for (const t of this.trees.values()) {
      if (Math.hypot(t.x - x, t.y - y) > radius) continue;
      t.hp -= dmg;
      if (t.hp <= 0) (fell ??= []).push(t);
    }
    if (!fell) return;
    for (const t of fell) {
      this.trees.delete(t.id);
      this.felled.push(t);
    }
  }

  // === corpses ==============================================================

  /** Leave a corpse for an organic, ground, non-mechanical unit (Liquipedia:
   *  Corpse). Buildings collapse, mechanical units explode, summons vanish, and
   *  air units crash without leaving a raisable ground corpse — none of them do.
   *  Neither does a HERO: it dissipates and reports to its altar (see below). */
  private spawnCorpse(u: SimUnit): void {
    // A summon (isSummon) leaves no corpse even after its timer hits 0 at expiry.
    // Neutral Passive *buildings* (shops/fountains) are caught by `u.building`; their
    // mobile kin — critters — are organic and DO leave a decaying corpse (raiseable by
    // Raise Dead, edible by Cannibalize), just like any other ground unit (issue #39).
    //
    // A HERO leaves NO physical remains at all (issue #126): its body plays its death, then
    // Dissipate, then fades out and is gone, and what it leaves behind is a name on an altar.
    // That is why no corpse ability in the game can touch a fallen hero — Raise Dead and
    // Resurrection have nothing to work with rather than a body they are forbidden to take.
    // sim/corpses.ts refused a hero corpse from the other end (`isHero` → "hero"), which was
    // the right answer to the wrong question: the body was still being filed, still occupying
    // the renderer for 88 seconds, and still being shipped in every snapshot.
    if (u.building || u.mechanical || u.isSummon || u.flying || u.isHero) return;
    this.corpses.set(this.nextCorpseId, {
      id: this.nextCorpseId,
      deadId: u.id,
      unitId: u.typeId,
      x: u.x,
      y: u.y,
      facing: u.facing,
      owner: u.owner,
      isHero: u.isHero,
      mechanical: u.mechanical,
      decayLeft: CORPSE_TOTAL_TIME,
      raised: false,
      heldBy: 0,
    });
    this.nextCorpseId++;
  }

  private tickCorpses(dt: number): void {
    for (const c of this.corpses.values()) {
      c.decayLeft -= dt;
      if (c.decayLeft <= 0) this.corpses.delete(c.id);
    }
  }

  /** Run down each fallen hero's body clock (FallenHero.bodyLeft) — what the altar's revive
   *  button waits on. The record itself is NOT dropped when it hits zero: the hero stays on
   *  the roster until it is revived or the match ends. */
  private tickFallenHeroes(dt: number): void {
    for (const f of this.fallen.values()) if (f.bodyLeft > 0) f.bodyLeft = Math.max(0, f.bodyLeft - dt);
  }

  /**
   * THE corpse query — every corpse-spending ability in the game starts here.
   *
   * One filter (see sim/corpses.ts) and one ordering, parameterised by the ability's OWN row
   * rather than by whoever is calling. This replaced four hand-written scans that had drifted
   * apart: one excluded hero corpses and admitted machines, another did the reverse, a third
   * excluded both but ignored allegiance entirely, and the fourth was a copy of the third
   * written to pre-check an autocast. Between them, Carrion Scarabs could hatch out of a dead
   * Archmage and a Paladin's Resurrection stood up the enemy's dead for him.
   *
   * Nothing is claimed here — this is the LOOK. `claimCorpses` is the take.
   */
  corpsesFor(caster: SimUnit, def: AbilityDef, x: number, y: number, radius: number, o: CorpseClaim = {}): SimCorpse[] {
    const out: SimCorpse[] = [];
    for (const c of this.corpses.values()) {
      const [cx, cy] = this.corpseAt(c);
      if (Math.hypot(cx - x, cy - y) > radius) continue;
      // The allegiance the ability's `friend`/`enemy` flags are measured against. A corpse
      // has no team of its own any more, so it answers for the player who owned it.
      const allied = this.alliedPlayers(caster.owner, c.owner);
      const stance = (allied === null ? caster.owner === c.owner : allied) ? "ally" : "enemy";
      if (!corpseAdmits(c, def.targetFlags, stance, o)) continue;
      out.push(c);
    }
    return o.order === "freshest"
      ? out.sort((a, b) => b.decayLeft - a.decayLeft)
      : out.sort((a, b) => this.corpseDist(a, x, y) - this.corpseDist(b, x, y));
  }

  /** WHERE a corpse is — its own spot, or the wagon carrying it. Loading does not move the
   *  record (it is dropped back where the wagon stands), so the cargo's position is the
   *  holder's, live: drive the wagon and its bodies come along. */
  private corpseAt(c: SimCorpse): [number, number] {
    const holder = c.heldBy ? this.units.get(c.heldBy) : undefined;
    return holder ? [holder.x, holder.y] : [c.x, c.y];
  }

  private corpseDist(c: SimCorpse, x: number, y: number): number {
    const [cx, cy] = this.corpseAt(c);
    return Math.hypot(cx - x, cy - y);
  }

  /** …and the TAKE: up to `max` of them.
   *
   *  `hold` is the Meat Wagon's: the bodies go into its cargo instead of being used up, so
   *  they stay perfectly good — a Necromancer beside the wagon raises straight out of it.
   *  Everything else SPENDS what it takes, and a spent body is gone for good. */
  claimCorpses(caster: SimUnit, def: AbilityDef, x: number, y: number, radius: number, max: number, o: CorpseClaim = {}): ClaimedCorpse[] {
    const taken: ClaimedCorpse[] = [];
    for (const c of this.corpsesFor(caster, def, x, y, radius, o)) {
      if (taken.length >= max) break;
      const [cx, cy] = this.corpseAt(c);
      if (o.hold) {
        c.heldBy = caster.id; // loaded, not consumed — the renderer takes it off the ground
      } else {
        c.raised = true; // spent; the renderer drops the model
        // …and it leaves the hold it was in, if it was in one. A Necromancer raising out of a
        // Meat Wagon empties that slot: without this the wagon went on counting bodies it no
        // longer had, reported itself full, and never picked up another.
        c.heldBy = 0;
      }
      taken.push({ x: cx, y: cy, facing: c.facing, unitId: c.unitId, owner: c.owner });
    }
    return taken;
  }

  /**
   * Put a carrier's whole cargo back on the ground where it now stands (`Amed` "Meat Drop",
   * and what a destroyed wagon spills). Returns how many bodies were dropped.
   *
   * A dropped body comes back FRESH: its decay clock is returned to the full
   * `BoneDecayTime`, however long it had left when it was picked up (observed in the original
   * game). That is what makes hauling worth doing — "an advanced strategy is to collect
   * corpses then dump them in front of enemy towns to make Skeleton Warriors" (Liquipedia,
   * Meat Wagon), and a body that arrived with four seconds left on it would be no use to
   * anyone. It also means the wagon cannot be out-waited: the bodies it carries are as good
   * the moment they land as the moment they fell.
   */
  dropHeldCorpses(holderId: number, x: number, y: number): number {
    let dropped = 0;
    for (const c of this.corpses.values()) {
      if (c.heldBy !== holderId || c.raised) continue;
      c.heldBy = 0;
      c.x = x;
      c.y = y;
      c.decayLeft = CORPSE_TOTAL_TIME; // dropped bodies are fresh again — see above
      dropped++;
    }
    return dropped;
  }

  /** How many bodies a carrier is holding — the cargo count its capacity is measured against. */
  heldCorpseCount(holderId: number): number {
    let n = 0;
    for (const c of this.corpses.values()) if (c.heldBy === holderId && !c.raised) n++;
    return n;
  }

  /** A carrier's corpse CAPACITY — `Amtc "Cargo Hold"` DataA, which is 8 on the Meat Wagon.
   *  Read off the unit's own ability list rather than a constant, and off the ability that
   *  actually states it rather than the one doing the loading: `umtw` carries `Sch2` (the
   *  hold) and `Amel` (the loading) as two separate rows, and a custom map that widens the
   *  wagon widens the hold. 0 = this unit has no corpse hold at all. */
  private cargoCapacityOf(u: SimUnit): number {
    for (const ab of u.abilities) {
      if (ab.code !== "Amtc") continue;
      const def = this.abilities?.get(ab.id);
      const lvl = def?.levelData[Math.max(0, Math.min(ab.level, def.levelData.length) - 1)];
      const cap = lvl?.data[0];
      return cap === undefined || Number.isNaN(cap) ? 0 : cap;
    }
    return 0;
  }

  /** Make a corpse from nothing, of a named type — Exhume Corpses, which is the only thing in
   *  the game that does it. `heldBy` puts it straight into a hold: the upgrade "generates a
   *  Crypt Fiend corpse WITHIN the Meat Wagon" (Liquipedia), not on the ground beside it. */
  spawnCorpseOf(unitId: string, x: number, y: number, owner: number, heldBy = 0): void {
    const def = this.unitReg?.get(unitId);
    this.corpses.set(this.nextCorpseId, {
      id: this.nextCorpseId, deadId: 0, unitId, x, y, facing: 0, owner,
      isHero: false, mechanical: !!def?.classification.includes("mechanical"),
      decayLeft: CORPSE_TOTAL_TIME, raised: false, heldBy,
    });
    this.nextCorpseId++;
  }

  /** Stand claimed bodies back up AS THEMSELVES — the Hre1/Hre2 shape (Resurrection, the two
   *  Runes, Animate Dead and its copies). The claiming already happened; this is only what
   *  comes back, so it takes corpses rather than a point and knows nothing about who may
   *  have them. Each rises where it FELL, not a step in front of the caster. */
  raiseClaimedCorpses(taken: ClaimedCorpse[], owner: number, team: number, opts?: RaiseOptions): number {
    for (const c of taken) {
      this.summonRequests.push({
        unitId: c.unitId, x: c.x, y: c.y, facing: c.facing, owner, team,
        // Resurrection gives the unit back (summonLeft 0, permanent, itself again). Animate
        // Dead does not: what stands up is a SUMMON on a clock, and it is a SHELL — see
        // `stripped`, which is what strips it.
        summonLeft: opts?.durationSec ?? 0,
        stripped: (opts?.durationSec ?? 0) > 0, // a TIMED raise is a shell; Resurrection gives the unit back whole
        invulnerable: opts?.invulnerable ?? false,
        sourceId: 0, summonArt: opts?.art ?? "", unsummonArt: opts?.unsummonArt ?? "", atPoint: true,
      });
    }
    return taken.length;
  }

  private unitsInAreaInternal(x: number, y: number, radius: number): SimUnit[] {
    const out: SimUnit[] = [];
    for (const t of this.units.values()) {
      if (t.hp <= 0) continue;
      if (Math.hypot(t.x - x, t.y - y) - t.radius <= radius) out.push(t);
    }
    return out;
  }

  // === SpellApi (what spell handlers may do to the world) ===================

  private spellApi: SpellApi = {
    rng: () => this.rng(),
    getUnit: (id) => this.units.get(id),
    unitsInArea: (x, y, r) => this.unitsInAreaInternal(x, y, r),
    hostile: (a, b) => this.hostile(a, b),
    ally: (a, b) => this.allied(a, b),
    admits: (def, t) => this.targsAdmit(t, def.targetFlags),
    launchWave: (caster, def, rank, opts) => this.spawnWaveProjectile(caster, def, rank, opts),
    // Untyped ability damage ignores armor; a Banished (ethereal) target takes +66%
    // (ETHEREAL_SPELL_BONUS — the file's Spells column), the flip side of its physical
    // immunity (issue #49).
    // Magic Immunity stops spell damage as well as spell targeting — that is what makes a
    // Dryad walk through a Blizzard. It belongs on this seam and not in landDamage, because
    // landDamage is also the ATTACK path and a magic-immune unit is hit by weapons normally.
    // Runed Bracers (`AIsr`) sit BEFORE the Anti-magic Shell's pool rather than after it: the
    // bracers reduce "Magic damage dealt to the Hero", so what reaches the shell to be
    // absorbed is already the smaller number, and a hero wearing both spends his shell more
    // slowly. Ethereal's +66% is applied first for the same reason — it is a property of what
    // is being hit, not a second reduction to be netted off.
    spellDamage: (t, amount, src) =>
      t.magicImmune ? 0 : this.landDamage(t, this.absorbSpellDamage(t, (t.ethereal ? amount * ETHEREAL_SPELL_BONUS : amount) * (1 - t.magicReduction)), src, false),
    spellHeal: (t, amount) => {
      t.hp = Math.min(t.maxHp, t.hp + amount);
    },
    applyBuff: (t, buff) => {
      // A debuff landing on an enemy is the same provocation the cast itself is (see
      // applySpellEffect), and this is where the ones the cast could not name arrive: Acid
      // Bomb's `Area1` splash catches everything around the unit it was thrown at, and only
      // the handler knows who that turned out to be.
      const src = this.units.get(buff.sourceId);
      if (this.casting && src && src !== t && this.hostile(src, t)) this.provoke(t, src.id);
      this.applyBuffInternal(t, buff.buffId === undefined && this.casting ? { ...buff, buffId: buffIdOf(this.casting.def, this.casting.rank) } : buff);
    },
    dispel: (t) => this.dispelUnit(t),
    requestSummon: (unitId, x, y, facing, owner, team, dur, src, art, atPoint, bound) => {
      this.summonRequests.push({ unitId, x, y, facing, owner, team, summonLeft: dur, sourceId: src, summonArt: art?.summon ?? "", unsummonArt: art?.unsummon ?? "", atPoint: !!atPoint, bound: !!bound });
    },
    claimCorpses: (caster, def, x, y, radius, max, o) => this.claimCorpses(caster, def, x, y, radius, max, o),
    dropHeldCorpses: (holderId, x, y) => this.dropHeldCorpses(holderId, x, y),
    heldCorpseCount: (holderId) => this.heldCorpseCount(holderId),
    cargoCapacity: (unit) => this.cargoCapacityOf(unit),
    spawnCorpseOf: (unitId, x, y, owner, heldBy) => this.spawnCorpseOf(unitId, x, y, owner, heldBy),
    raiseClaimed: (taken, owner, team, opts) => this.raiseClaimedCorpses(taken, owner, team, opts),
    linkSpirits: (unit, group, durationSec, share) => {
      unit.linkGroup = [...group];
      unit.linkT = durationSec;
      unit.linkShare = share;
    },
    devour: (kodo, prey) => this.devourInternal(kodo, prey),
    toggleSpiritForm: (unit) => this.toggleSpiritForm(unit),
    isDay: () => this.isDay,
    holdPosition: (unit) => { this.issueHold(unit.id); },
    toggleRoot: (unit) => this.toggleRoot(unit),
    entangleMine: (unit, def) => this.entangleMine(unit, def),
    unsummonBuilding: (caster, target, ratio, step) => this.unsummonBuilding(caster, target, ratio, step),
    eatTree: (eater, x, y, reach) => {
      // The nearest tree to the CLICK, but only if the eater can actually reach it — the
      // point is where the player aimed and the range is the Ancient's arm.
      const tree = this.nearestTree(x, y, reach);
      if (!tree || Math.hypot(tree.x - eater.x, tree.y - eater.y) - eater.radius > reach) return false;
      this.trees.delete(tree.id);
      this.felled.push(tree); // renderer plays the tree's death and leaves the stump
      return true;
    },
    setReplenishTarget: (well, targetId) => { well.replenishTargetId = targetId; },
    morphToggle: (unit, def, rank) => this.morphToggle(unit, def, rank),
    abilityOf: (id) => this.abilities?.get(id),
    dismissSummons: (owner, typeIds) => {
      const set = new Set(typeIds);
      for (const u of [...this.units.values()]) {
        if (u.owner === owner && u.isSummon && u.hp > 0 && set.has(u.typeId)) this.unsummon(u);
      }
    },
    emitEffect: (art, x, y, targetId, life) => {
      if (art) this.spellEffects.push({ art, x, y, targetId, z: 0, life });
    },
    emitSplat: (splatId, x, y) => {
      if (splatId) this.spellSplats.push({ splatId, x, y });
    },
    emitLightning: (id, from, to, life, delay, tag) => {
      if (!id) return;
      this.spellLightnings.push({
        id,
        sourceId: from.id,
        targetId: to.id,
        sx: from.x,
        sy: from.y,
        sz: boltZ(from, "launch"),
        tx: to.x,
        ty: to.y,
        tz: boltZ(to, "impact"),
        life: life ?? 0,
        delay: delay ?? 0,
        tag,
      });
    },
    stopLightning: (tag) => {
      if (tag) this.spellLightningStops.push(tag);
    },
    buffFxOf: (buffId) => (buffId ? (this.abilities?.buffFx(buffId) ?? []) : []),
    addSpellField: (f) => this.addSpellFieldInternal(f),
    burnMana: (t, amount) => {
      const burned = Math.min(t.mana, Math.max(0, amount));
      t.mana -= burned;
      return burned;
    },
    teleport: (u, x, y) => this.teleportUnit(u, x, y),
    mirrorImage: (caster, def, rank) => this.startMirrorImage(caster, def, rank),
    changeOwner: (u, owner, team) => this.changeUnitOwner(u, owner, team),
    possess: (casterId, targetId, seconds) => this.beginPossession(casterId, targetId, seconds),
    killUnit: (u) => this.kill(u),
    transmute: (target, caster, goldFactor, lumberFactor) => this.transmuteInternal(target, caster, goldFactor, lumberFactor),
    fellTrees: (x, y, radius, max) => this.fellTreesInternal(x, y, radius, max),
    toggleImmolation: (u) => this.toggleImmolation(u),
    markDoom: (t, caster, def, rank) => {
      t.doomed = { abilityId: def.id, rank, sourceId: caster.id, owner: caster.owner, team: caster.team };
    },
    voodoo: (caster, def, rank) => {
      caster.voodooLeft = def.levelData[Math.min(rank, def.levelData.length) - 1]?.duration || 30;
      caster.voodooAbil = def.id;
    },
    countOwned: (owner, typeId) => this.countOwnedOf(owner, typeId),
    revealArea: (owner, team, o) => this.addItemReveal(owner, team, o),
    // One copy beside the original, on the spot the summon placer finds for it (`atPoint`
    // false — the wand names no destination, unlike a Mirror Image missile which does).
    createIllusion: (of, owner, team, sourceId, o) => {
      this.spawnIllusion(of, owner, team, sourceId, of.x, of.y, {
        duration: o.durationSec, dealt: o.dealt, taken: o.taken,
        abilityId: this.casting?.def.id ?? "", mana: of.mana, unsummonArt: o.unsummonArt,
      });
    },
  };

  /** Fell up to `max` trees within `radius` of a point, nearest first, and say where each
   *  stood. Force of Nature's whole shape: `targs1 = tree`, `Efn1` trees, one Treant each in
   *  the hole it left. Goes through the same `felled` queue harvesting does, so the renderer
   *  unstamps the pathing, plays the tree's death and clears the sight blocker. */
  private fellTreesInternal(x: number, y: number, radius: number, max: number): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    for (const t of this.nearestTrees(x, y, radius, Math.max(1, max))) {
      if (Math.hypot(t.x - x, t.y - y) > radius) continue; // nearestTrees pads to `limit`
      this.trees.delete(t.id);
      this.felled.push(t);
      out.push({ x: t.x, y: t.y });
    }
    return out;
  }

  /** Take the nearest corpse within `radius` and say what it was. The corpse-eating abilities
   *  that TAKE NO TARGET (Carrion Beetles, Raise Dead, Animate Dead) find
   *  their own body this way; `raised` is the same flag a raise or a Cannibalize sets, which
   *  is what stops two beetles climbing out of one Footman. */

  /** SetUnitOwner: hand a unit to another player (Charm, and the JASS native). The COLOUR
   *  has to move with it — a Charmed Knight fighting for the blue player is blue, and a
   *  creep taken off the Neutral Hostile slot stops wearing creep red. The sim only records
   *  the change; the models live on the renderer, so the swap is queued for it to pick up
   *  (drainOwnerChanges) exactly as a morph is. */
  changeUnitOwner(u: SimUnit, owner: number, team: number): void {
    if (u.owner === owner && u.team === team) return;
    u.owner = owner;
    u.team = team;
    this.ownerChanges.push({ unitId: u.id, owner });
  }

  private ownerChanges: Array<{ unitId: number; owner: number }> = [];
  /** Units whose controller changed this tick — the renderer re-tints them. */
  drainOwnerChanges(): Array<{ unitId: number; owner: number }> {
    if (!this.ownerChanges.length) return this.ownerChanges;
    const out = this.ownerChanges;
    this.ownerChanges = [];
    return out;
  }

  /** Relocate a unit instantly and re-settle it onto the pathing grid (Blink,
   *  Mass Teleport). Clears its current path so it doesn't walk back. */
  private teleportUnit(u: SimUnit, x: number, y: number): void {
    this.unsettle(u);
    this.releaseClaim(u); // the tile it was walking onto is behind it now
    if (this.grid && !u.flying) {
      const [cx, cy] = this.grid.footprintAnchor(x, y, u.footprint);
      const spot = this.grid.nearestFit(cx, cy, u.footprint, 12) ?? this.grid.nearestWalkable(cx, cy, 12);
      if (spot) [x, y] = this.grid.footprintCenter(spot[0], spot[1], u.footprint);
    } else if (this.grid && u.flying && !this.grid.playableAt(x, y)) {
      // A flyer skips the walkability snap above — it may stand on a cliff or over water —
      // but not the map's edge (issue #117). Mass Teleport is the way one gets here: a
      // Gyrocopter caught in the circle would otherwise be set down in the black.
      const [cx, cy] = this.grid.worldToCell(x, y);
      const spot = this.grid.nearestPlayable(cx, cy, 12);
      if (spot) [x, y] = this.grid.cellToWorld(spot[0], spot[1]);
    }
    u.x = x;
    u.y = y;
    u.prevX = x;
    u.prevY = y;
    u.path = [];
    u.waypoint = 0;
    u.moving = false;
    if (!u.flying) this.settle(u);
  }

  // === Way Gates (7.22 — issue #33) ========================================
  //
  // A Way Gate is a plain unit ('nwgt', Neutral Passive) whose behaviour is entirely
  // script-driven: `WaygateSetDestination` points it somewhere, `WaygateActivate`
  // switches it on, and anything that walks into it comes out the far end. Seven of the
  // eleven maps that use one are ordinary MELEE maps (CentaurGrove, WindyWaste, Riverrun,
  // Plaguelands, IceCrown, MysticIsles, Venetia) — the gate is a map feature, not a
  // custom-map gadget, and its pair of gates is set up inside `CreateAllUnits()`.
  //
  // The trigger volume is NOT a guess: the Way Gate carries ability `Awrp` (UnitAbilities
  // .slk `abilList=Awrp,Avul`), and Awrp's DataA1/DataB1 are 400/400 — which
  // AbilityMetaData.slk + WorldEditStrings.txt name **"Teleport Area Width"** and
  // **"Teleport Area Height"**. So the gate is a 400×400 world-unit BOX centred on the
  // building, not a circle.

  /** `Awrp` DataA1/DataB1 (Units\AbilityData.slk) — the Way Gate's teleport area, in
   *  world units. Half-extents, since the box is centred on the gate. */
  private static readonly WAYGATE_HALF_W = 400 / 2;
  private static readonly WAYGATE_HALF_H = 400 / 2;

  /** A gate teleports a unit that **ENTERS** its box — the rising edge — not one that
   *  merely stands in it. That distinction is the whole behaviour, and getting it wrong is
   *  not subtle: a gate's destination is its PARTNER gate, so a unit spat out at the far
   *  end lands inside the partner's box. Fire on occupancy and the partner immediately
   *  throws it back, the first gate throws it forward again, and the traveller ping-pongs
   *  between the two forever (measured live on (4)CentaurGrove — the footman bounced
   *  SW↔NE every tick and never arrived).
   *
   *  So each gate keeps the set of units already inside it, exactly as the enter-region
   *  pump keeps its baseline (7.4b): a unit deposited inside a gate is seeded as
   *  already-there and is only teleported once it leaves and walks back in. Runs after
   *  movement, so a unit ordered onto a gate crosses the instant it arrives. */
  private tickWaygates(): void {
    let gates: SimUnit[] | null = null;
    for (const g of this.units.values()) {
      if (!g.waygate?.active) continue;
      (gates ??= []).push(g);
    }
    if (!gates) return; // the overwhelmingly common case: no gates on this map

    // 1. Who has just ENTERED each gate (in its box now, wasn't last tick)?
    const moved = new Set<number>();
    for (const g of gates) {
      for (const u of this.units.values()) {
        if (!this.inWaygate(u, g) || g.waygate!.inside.has(u.id)) continue;
        if (moved.has(u.id)) continue; // one gate per unit per tick
        this.teleportUnit(u, g.waygate!.destX, g.waygate!.destY);
        moved.add(u.id);
      }
    }
    // 2. Re-baseline every gate from the FINAL positions. This is what seeds an arriving
    //    unit into the destination gate's `inside` set, so that gate does not fire on it.
    for (const g of gates) {
      const inside = g.waygate!.inside;
      inside.clear();
      for (const u of this.units.values()) if (this.inWaygate(u, g)) inside.add(u.id);
    }
  }

  /** Is `u` standing in gate `g`'s teleport box? A gate never swallows itself, another
   *  structure, or a neutral-passive prop. */
  private inWaygate(u: SimUnit, g: SimUnit): boolean {
    if (u === g || u.building || u.neutralPassive) return false;
    return (
      Math.abs(u.x - g.x) <= SimWorld.WAYGATE_HALF_W &&
      Math.abs(u.y - g.y) <= SimWorld.WAYGATE_HALF_H
    );
  }

  /** JASS WaygateSetDestination / WaygateActivate — configure a gate. Both natives
   *  work on a unit that isn't a Way Gate (WC3 lets you make anything a gate), so we
   *  don't gate on the type; a unit with no `waygate` record simply isn't one yet.
   *  Reconfiguring keeps the occupancy baseline — retargeting a gate must not make it
   *  re-fire on whoever happens to be standing in it. */
  private waygateOf(id: number): WaygateState | null {
    const u = this.units.get(id);
    if (!u) return null;
    return (u.waygate ??= { destX: 0, destY: 0, active: false, inside: new Set() });
  }
  setWaygateDestination(id: number, x: number, y: number): void {
    const w = this.waygateOf(id);
    if (!w) return;
    w.destX = x;
    w.destY = y;
  }
  waygateActivate(id: number, active: boolean): void {
    const g = this.units.get(id);
    const w = this.waygateOf(id);
    if (!g || !w) return;
    // Switching a gate ON seeds its occupancy baseline from whoever is already standing
    // in it, so it does not fire on them — a unit inside at activation has not *entered*.
    // Same silent-baseline rule the enter-region pump uses when a trigger is registered.
    if (active && !w.active) {
      w.inside.clear();
      for (const u of this.units.values()) if (this.inWaygate(u, g)) w.inside.add(u.id);
    }
    w.active = active;
  }
  /** WaygateGetDestinationX/Y — 0 on a unit that is not a gate, as the engine reports. */
  waygateDestination(id: number): { x: number; y: number } | null {
    const w = this.units.get(id)?.waygate;
    return w ? { x: w.destX, y: w.destY } : null;
  }
  waygateIsActive(id: number): boolean {
    return this.units.get(id)?.waygate?.active === true;
  }

  // === JASS trigger effects (Phase 7 — issue #33; see docs/triggers.md) ======
  // Small, public entry points the interpreter's EngineHooks bridge calls to mutate
  // a unit from a trigger action (SetUnitPosition/Facing/Owner/MoveSpeed/…). The
  // render-only properties (scale, vertex colour, fly height) live on RtsController.

  /** JASS SetUnitPosition / SetUnitX / SetUnitY — teleport with pathing re-settle. */
  setUnitPosition(id: number, x: number, y: number): void {
    const u = this.units.get(id);
    if (u) this.teleportUnit(u, x, y);
  }
  /** JASS SetUnitFacing[Timed] — instant sets both facing + target so it doesn't turn
   *  back; timed sets only the target so it rotates there at the unit's turn rate. */
  setUnitFacing(id: number, rad: number, instant: boolean): void {
    const u = this.units.get(id);
    if (!u) return;
    u.desiredFacing = rad;
    // A unit that cannot turn (turnRate 0 — every structure) would otherwise sit on an
    // unreachable target forever, so the timed form lands instantly too. The trigger still
    // gets what it asked for; only the rotating-there part has no meaning here.
    if (instant || u.turnRate <= 0) u.facing = rad;
  }
  /** JASS SetUnitOwner — reassign owner + team (team decides allegiance/vision). Goes
   *  through changeUnitOwner so a script-driven handover re-tints the model too, exactly as
   *  Charm's does (the native's own `changeColor` argument is what the engine calls it). */
  setUnitOwner(id: number, owner: number, team: number): void {
    const u = this.units.get(id);
    if (u) {
      this.changeUnitOwner(u, owner, team);
    }
  }
  /** JASS SetUnitMoveSpeed — the current move speed (buffs recompute from baseSpeed,
   *  so set the base too or a slow/haste tick would immediately overwrite it). */
  setUnitMoveSpeed(id: number, speed: number): void {
    const u = this.units.get(id);
    if (u) u.speed = u.baseSpeed = speed;
  }
  /** JASS SetUnitTurnSpeed — same 0..1 scale as UnitData `turnRate`. */
  setUnitTurnSpeed(id: number, turn: number): void {
    const u = this.units.get(id);
    if (u) u.turnRate = turn;
  }
  /** JASS SetUnitFlyHeight — the sim altitude (missiles launch/land here); the render
   *  lift is kept in step by RtsController.setUnitFlyHeight. */
  setUnitFlyHeight(id: number, height: number): void {
    const u = this.units.get(id);
    if (u) u.flyHeight = height;
  }
  /** JASS PauseUnit — freeze/unfreeze; halts movement immediately on pause. */
  pauseUnit(id: number, flag: boolean): void {
    const u = this.units.get(id);
    if (u) {
      u.paused = flag;
      if (flag) u.moving = false;
    }
  }
  isUnitPaused(id: number): boolean {
    return this.units.get(id)?.paused ?? false;
  }
  // Live reads for the Get* natives (a script-created unit's JASS handle otherwise
  // keeps its spawn-time position/facing — the sim value is the current one).
  //
  // **undefined, never 0, for a unit that is gone.** These answer the JASS natives through
  // liveNum (natives/world.ts), whose contract is "the live sim value, or the handle's
  // last-known field when there is none" — and it can only tell the two apart by
  // `undefined`. A dead unit is deleted from `units` inside kill(), one tick BEFORE the
  // death event it queued is pumped, so every GetUnitX a death trigger makes is a read of a
  // unit that no longer exists. Answering 0 there put the map origin into the hands of
  // Blizzard.j's UnitDropItem — every creep in the game dropped its loot in one pile in the
  // corner of the map, which is what "creep drops stopped working" turned out to be.
  getUnitX(id: number): number | undefined {
    return this.units.get(id)?.x;
  }
  getUnitY(id: number): number | undefined {
    return this.units.get(id)?.y;
  }
  getUnitFacing(id: number): number | undefined {
    return this.units.get(id)?.facing;
  }
  getUnitMoveSpeed(id: number): number | undefined {
    return this.units.get(id)?.speed;
  }
  getUnitFlyHeight(id: number): number | undefined {
    return this.units.get(id)?.flyHeight;
  }

  // === drains (renderer pulls these each frame) =============================

  /** Repeating area fields running RIGHT NOW (Blizzard, Rain of Fire, …). Unlike the
   *  drain* channels this is a live view, not a one-shot queue: the renderer polls it
   *  each frame to sustain a channel's looping bed and to stop it the moment the field
   *  ends — whether it exhausted its waves or the caster was interrupted. */
  activeSpellFields(): Array<{ code: string; x: number; y: number; loopSound: string; shake: boolean }> {
    return this.spellFields.map((f) => ({ code: f.code, x: f.x, y: f.y, loopSound: f.loopSound ?? "", shake: f.shake ?? false }));
  }

  /** Play a one-shot effect model at a point. For the spawn paths the renderer owns:
   *  a summon's burst belongs on the tile the renderer finally placed it on, which the
   *  sim never sees (see drainSummonRequests). Spell handlers use SpellApi.emitEffect. */
  emitEffectAt(art: string, x: number, y: number, sound = false): void {
    if (art) this.spellEffects.push({ art, x, y, targetId: 0, z: 0, sound });
  }

  /** Spell/effect models to play this frame (targetId>0 = follow that unit). */
  drainSpellEffects(): Array<{ art: string; x: number; y: number; targetId: number; z: number; life?: number; sound?: boolean; soundLabel?: string }> {
    if (!this.spellEffects.length) return this.spellEffects;
    const out = this.spellEffects;
    this.spellEffects = [];
    return out;
  }
  /** Lightning bolts strung this frame (LightningData row id + both ends). */
  drainSpellLightnings(): SimLightning[] {
    if (!this.spellLightnings.length) return this.spellLightnings;
    const out = this.spellLightnings;
    this.spellLightnings = [];
    return out;
  }
  /** Bolts cut short this frame, by tag (an interrupted Drain's tether). */
  drainLightningStops(): string[] {
    if (!this.spellLightningStops.length) return this.spellLightningStops;
    const out = this.spellLightningStops;
    this.spellLightningStops = [];
    return out;
  }
  /** Ground decals a spell asked for this frame (UberSplatData row id + centre). */
  drainSpellSplats(): Array<{ splatId: string; x: number; y: number }> {
    if (!this.spellSplats.length) return this.spellSplats;
    const out = this.spellSplats;
    this.spellSplats = [];
    return out;
  }
  /** Casts that began this frame (renderer plays the cast animation). */
  drainCastStarts(): Array<{ casterId: number; code: string; abilityId: string; hold: number; loop: boolean; tx: number; ty: number; targetId: number; warnArt: string }> {
    if (!this.castStarts.length) return this.castStarts;
    const out = this.castStarts;
    this.castStarts = [];
    return out;
  }
  /** Casts whose effect FIRED this frame (renderer plays the ability's cast sound). */
  drainCastFires(): Array<{ casterId: number; code: string; abilityId: string }> {
    if (!this.castFires.length) return this.castFires;
    const out = this.castFires;
    this.castFires = [];
    return out;
  }
  /** Floating combat text raised this frame — a crit's red number, a deny's "!" (CombatText). */
  drainCombatTexts(): CombatText[] {
    if (!this.combatTexts.length) return this.combatTexts;
    const out = this.combatTexts;
    this.combatTexts = [];
    return out;
  }
  /** Heroes that leveled up this frame (renderer plays the level-up nova). */
  drainLevelUps(): Array<{ unitId: number; level: number }> {
    if (!this.levelUps.length) return this.levelUps;
    const out = this.levelUps;
    this.levelUps = [];
    return out;
  }
  /** Units summoned/raised this frame — the renderer creates their models. */
  drainSummonRequests(): SummonRequest[] {
    if (!this.summonRequests.length) return this.summonRequests;
    const out = this.summonRequests;
    this.summonRequests = [];
    return out;
  }

  /**
   * Restart the RNG from a new seed. Legal only BEFORE the match rolls anything — the
   * lobby knows the seed after the world is constructed (render/mapViewer.ts builds the
   * world at map load and settles the match config later, at beginMatch, which still runs
   * before a single unit is seeded). Calling it mid-match would rewind the stream and
   * desync a client from its host, so don't.
   */
  reseed(seed: number): void {
    this.seed = seed;
    this.rng = lcg(seed);
  }

  /** Draw from the match's seeded stream. For the few rolls that live just OUTSIDE the sim
   *  but still decide sim state — a hero's proper name, written onto the unit — so they
   *  come off the same reproducible sequence as damage and drops instead of Math.random. */
  random(): number {
    return this.rng();
  }

  tick(dt: number): void {
    this.elapsed += dt;
    if (this.dawnDusk && !this.timeOfDaySuspended) {
      this.timeOfDay = (this.timeOfDay + dt * GAME_HOURS_PER_SEC * this.timeOfDayScale) % MISC_DATA.DayHours;
    }
    // The tech census (who owns what, and so what each player may build) is invalidated
    // wholesale each tick rather than at every birth/death/morph/construction-finish. The
    // rebuild is a single O(units) pass and only happens if something actually asks — but
    // a *missed* invalidation site would leave a player's requirements silently stale,
    // which is a far nastier bug than one cheap pass.
    this.tech?.invalidate();
    // Sub-phases of `sim.world`, for the log (src/sim/profile.ts). Six spans a step, on a
    // profiler that is a no-op unless a match plugged one in.
    simProfile.begin("sim.world.pre");
    this.tickAttackReveals(dt);
    this.tickDeathReveals(dt); // …and the eyes a body keeps while it falls (issue #126)
    this.tickItemReveals(dt); // …and the ground a Crystal Ball / flare / Dust is holding open
    this.tickMoonstone(dt); // …and the eclipse a Moonstone is holding over the map
    this.tickSoulGems(); // …and the hero a Soul Gem is holding off it
    this.tickBuildings(dt);
    this.tickMineCrews(dt); // night elf and undead gold: no round trip, just a crew and a clock
    this.tickShops(dt);
    this.tickShopBuyers(); // adopt a purchaser for whoever has just walked one up to a shop
    this.applyAuras(); // refresh aura buffs on in-range allies (before recompute)
    this.tickBlight(dt); // the rot spreading out from each new structure (before recompute)
    simProfile.end("sim.world.pre");
    simProfile.begin("sim.world.units");
    for (const u of this.units.values()) {
      if (this.tickBuffs(u, dt)) continue; // decay timed effects (a DoT may kill)
      this.tickMeld(u); // Shadow Meld holds only while the unit is still and the sun is down
      this.tickAltForm(u, dt); // a timed form (militia) running out and reverting
      this.tickImmolation(u, dt); // Immolation burns whatever it is standing next to, and pays for it
      this.tickVoodoo(u, dt); // …and Big Bad Voodoo renews its circle for as long as the ritual holds
      this.tickExhume(u, dt); // …and a Meat Wagon with the upgrade grows its own bodies
      this.tickCarriedItems(u, dt); // …and an Amulet of Spell Shield regrowing its shield
      this.recomputeStats(u); // derive armour/speed/damage/regen/stun/invuln
      this.tickRegen(u, dt); // mana + (hero) hp regeneration
      this.tickReplenish(u); // a Moon Well pouring itself into whoever is drinking
      if (u.morphT > 0) u.morphT = Math.max(0, u.morphT - dt); // an Ancient mid-root/unroot
      if (u.rootSettle) this.tickRootSettle(u); // …and one mid-ROOT is still lowering itself onto its site
      if (u.rootPending) this.tickRootAt(u); // an Ancient that walked to the spot it was told to plant on
      if (u.entanglePending) this.tickEntangleAt(u); // …and a Tree of Life that planted there to take a mine
      this.tickRenew(u); // an idle Wisp with Renew on, looking for something to mend
      if (u.cooldownLeft > 0) u.cooldownLeft -= dt;
      if (u.linkT > 0 && (u.linkT -= dt) <= 0) u.linkGroup = []; // Spirit Link expired
      if (u.repathT > 0) u.repathT -= dt;
      if (u.waitT > 0) u.waitT -= dt; // parked in a jam — counting down to the next try
      for (const a of u.abilities) if (a.cooldownLeft > 0) a.cooldownLeft -= dt;
      for (const it of u.inventory) if (it && it.cooldownLeft > 0) it.cooldownLeft -= dt;
      if (u.summonLeft > 0) {
        u.summonLeft -= dt;
        if (u.summonLeft <= 0) {
          // Its time is up. A summon whose data declares an unsummon effect LEAVES via it
          // (a Feral Spirit wolf is replaced by feralspiritdone, it is not slain); one that
          // declares none has no other way to go than to die, which is what a Water
          // Elemental does — BHwe carries no Effectart and the elemental splashes.
          if (u.unsummonArt) this.unsummon(u);
          else this.kill(u);
          continue;
        }
      }
      u.prevX = u.x;
      u.prevY = u.y;
      if (u.paused) continue; // PauseUnit: no orders/movement/turning until unpaused
      if (u.spawning > 0) {
        u.spawning -= dt; // still materializing (playing its birth clip) — can't act
        continue;
      }
      if (u.stunned) {
        this.interruptForStun(u); // stunned units can't act this tick
        continue;
      }
      // Neutral Hostile creeps run a guard/leash/sleep controller on top of the
      // normal order handling. It returns true when it has taken the unit over for
      // this tick (asleep at its post, or leashing home) — skip the order switch;
      // movement still runs in tickMovement so a returning creep keeps walking home.
      if (u.isCreep && this.tickCreep(u, dt)) continue;
      // …and a map-placed AI unit keeps the LEASH half of that behaviour (see
      // SimUnit.guarding): it holds the ground the map put it on instead of ratcheting
      // across the world one auto-acquired kill at a time.
      if (u.guarding && this.tickGuardLeash(u, dt)) continue;
      switch (u.order) {
        case "move":
          // Movement itself is driven by tickMovement while u.moving stays true;
          // this restarts a move that a stun/interrupt paused, and — when there is no path
          // left at all — one that PARKED because the way was blocked (see parkAndWait).
          if (!u.moving && u.waypoint < u.path.length) u.moving = true;
          else if (!u.moving) this.resumeRoute(u);
          break;
        case "attack":
          this.tickAttack(u, dt);
          break;
        case "cast":
          this.tickCast(u, dt); // walk into range, then fire the spell effect
          break;
        case "getitem":
          this.tickGetItem(u); // walk to a ground item / another hero, then pick up / hand over
          break;
        case "garrison":
          this.tickGarrison(u); // walk to the Orc Burrow, then climb inside
          break;
        case "follow":
          this.tickFollow(u, dt); // trail the leader; guard it against nearby enemies once caught up
          break;
        case "harvest":
          this.tickHarvest(u, dt);
          break;
        case "return":
          this.tickReturn(u);
          break;
        case "repair":
          this.tickRepair(u, dt);
          break;
        case "attackmove":
          this.tickAttackMove(u, dt); // fight nearby enemies first, then advance
          break;
        case "patrol":
          if (!u.moving && u.waypoint < u.path.length) u.moving = true; // resume after a stun
          else if (!u.moving) this.resumeRoute(u); // …or after parking in a jam
          // Autocast first here too — patrol is one of the orders Liquipedia lists as leaving
          // autocast active, so a patrolling Priest heals what it passes (issue #94).
          if (!this.tickAutocast(u)) this.tickAcquire(u, dt); // else engage enemies en route
          break;
        case "hold":
          // Autocast gets first refusal here too: Liquipedia's Autocast page lists hold
          // position among the orders that do NOT suppress it, so a Priest told to hold a
          // line still heals the Footmen holding it beside him. IN PLACE — he takes only what
          // is already within Heal's own 250 and never walks out to find work, because not
          // moving is the whole of what the order says (see tickAutocast's `inPlace`).
          // A committed swing lands first, exactly as in tickAttack.
          if (u.swingLeft >= 0 || !this.tickAutocast(u, true)) this.tickHold(u, dt); // else attack enemies in range, but never chase
          break;
        case "idle":
          // Autocast (toggled-on Heal/Slow/…) gets first refusal, then auto-attack.
          if (!this.tickAutocast(u)) this.tickAcquire(u, dt);
          break;
      }
    }
    simProfile.end("sim.world.units");
    simProfile.begin("sim.world.move");
    simProfile.begin("sim.world.move.walk");
    this.tickMovement(dt);
    this.carryPassengers(); // a transport's cargo moves with it
    simProfile.end("sim.world.move.walk");
    simProfile.begin("sim.world.move.collide");
    this.resolveCollisions();
    simProfile.end("sim.world.move.collide");
    this.tickWaygates(); // anything now standing in a gate's box comes out the far end
    simProfile.begin("sim.world.move.air");
    this.resolveAirSeparation(dt);
    simProfile.end("sim.world.move.air");
    simProfile.end("sim.world.move");
    simProfile.begin("sim.world.projectiles");
    this.tickProjectiles(dt);
    simProfile.end("sim.world.projectiles");
    simProfile.begin("sim.world.spells");
    this.tickSpellFields(dt); // Blizzard-style repeating area effects
    this.tickDrains(); // a broken Drain channel takes its buffs and its beam down with it
    this.tickPossessions(dt); // …and a Possession that survived its 4.5s changes hands
    this.tickMirrorImage(dt); // Mirror Image's caster effect -> missiles -> illusions
    this.tickLightningShields(dt); // Lightning Shield: damage units around each shielded unit
    this.tickWards(); // Stasis Trap proximity stun (the Healing Ward is an aura — see AURA_BUFFS)
    this.tickDevour(dt); // Kodo digests any swallowed unit
    this.tickCorpses(dt); // decay flesh→bone→gone
    this.tickFallenHeroes(dt); // …and a hero's body, which dissipates instead (issue #126)
    simProfile.end("sim.world.spells");
    simProfile.begin("sim.world.post");
    for (const u of this.units.values()) {
      // Turning runs every tick, independent of movement: a unit that arrived
      // (or stands attacking) still finishes rotating to its desired heading —
      // unless it has no turn rate at all (a structure; see facesTarget), in which
      // case the heading combat asked for is simply never taken up.
      if (u.turnRate > 0 && u.facing !== u.desiredFacing && !u.paused) {
        u.facing = turnToward(u.facing, u.desiredFacing, turnSpeed(u.turnRate) * dt);
      }
      this.tickSwing(u, dt); // land pending strikes at their damage point
      // Any walking (only possible after the damage point — the wind-up holds
      // position) breaks the attack animation: the unit move-canceled its backswing,
      // so its attack clip must not resume until the next real swing (which clears
      // this). Runs AFTER tickMovement so u.moving reflects this tick's actual walking.
      if (u.moving) u.swingBroken = true;
      this.checkStuck(u, dt);
    }
    // Advance shift-queues: a unit that just fell idle (and isn't building or
    // walking to a build site) starts its next queued order. Runs after all
    // order/movement processing so "arrived → idle" is visible this tick.
    for (const u of this.units.values()) {
      if (u.orderQueue.length && u.order === "idle" && u.constructing === 0 && !u.buildPending) {
        this.startNextQueued(u);
      }
    }
    simProfile.end("sim.world.post");
  }

  // A moving unit that barely progresses (blocked by units it may not push) gives
  // up after a moment: move orders stop (WC3 units halt when the way is blocked);
  // chasers pause before repathing so they don't grind against the blocker.
  //
  // Progress is measured as NET displacement over a whole STUCK_TIME window, not
  // per-tick speed: two units orbiting each other move at full speed every tick
  // (so a per-tick check never fires) yet drift almost nowhere — the window catches
  // that "dancing" and breaks it up, while a unit legitimately detouring around an
  // obstacle keeps covering real ground and is left alone.
  private checkStuck(u: SimUnit, dt: number): void {
    if (!u.moving || u.speed <= 0) {
      u.stuckT = 0;
      return;
    }
    if (u.stuckT === 0) {
      u.stuckAnchorX = u.prevX; // window opens from where this tick started
      u.stuckAnchorY = u.prevY;
    }
    u.stuckT += dt;
    if (u.stuckT < STUCK_TIME) return;
    const netMoved = Math.hypot(u.x - u.stuckAnchorX, u.y - u.stuckAnchorY);
    const expected = u.speed * u.stuckT;
    u.stuckT = 0;
    if (netMoved >= expected * STUCK_RATIO) {
      u.stuckRetries = 0; // covered real ground — not stuck
      return;
    }
    if (u.order === "attack") {
      // Attack-order approach is owned by the combat-approach watchdog in tickAttack
      // (issue #24), which measures net progress toward the target over its own window
      // and re-decides — repath if reachable, else switch to the nearest reachable
      // target. Don't also handle it here: the two would fight over the same unit with
      // different timers. (Falling through to the generic handler below would call
      // stop(), which wrongly drops the attack target.)
      u.stuckRetries = 0;
      return;
    }
    if (u.order === "cast") {
      // A CAST's approach is owned by tickCast, which re-runs it every tick until the caster
      // is within range — and the generic handler below cannot judge it, because the point a
      // cast names is very often ground nobody can stand on. Eat Tree is the case: it names a
      // TRUNK, whose cell is blocked by the tree itself, so `holdOrGiveUp` read "unreachable
      // terrain, no amount of waiting will open it" and cancelled the order — which on a
      // shift-queued line of trees silently skipped one and moved to the next.
      u.stuckRetries = 0;
      return;
    }
    // Gatherers must NEVER idle mid-job just because they're jostling in a crowd
    // around the trees/mine (which the stricter net-progress check above would
    // otherwise flag). Re-route around the crowd; a boxed-in lumberjack parks in
    // place so tickHarvest chops the nearest reachable tree instead of standing idle.
    if (u.worker && (u.order === "harvest" || u.order === "return")) {
      const routed = this.pathTo(u, u.chaseX, u.chaseY);
      if (!routed && u.order === "harvest" && u.resKind === "lumber") {
        this.settle(u);
        u.atNode = false;
      }
      u.stuckRetries = 0;
      return;
    }
    const [tx, ty] = [u.chaseX, u.chaseY];
    // Already about as close to the destination as the crowd allows (within a body or
    // two): don't keep shoving through the units parked on the goal cell — just stop.
    // This kills the "wobble at the destination" where a move order aims onto a spot
    // other units occupy and the mover vibrates against them (issue #24). Only for
    // plain move/patrol — attack/attackmove/harvest handle their own arrival above.
    if ((u.order === "move" || u.order === "patrol") && Math.hypot(tx - u.x, ty - u.y) <= PATHING_CELL * 2) {
      this.stop(u.id);
      u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
      return;
    }
    // Blocked/orbiting: the blockers may have stopped since the original path was computed,
    // so try a fresh route around them first (avoidMovers — go round the crowd rather than
    // grind into it). Two attempts; a unit that is genuinely hemmed in should stop probing
    // and wait, not re-flood A* every window.
    if (u.stuckRetries < 2 && this.pathTo(u, tx, ty, undefined, true)) {
      u.stuckRetries++;
      return;
    }
    // No way through right now. The order STANDS — a unit does not forget where it was sent
    // because somebody stood in its way for a second (issue #108: a jammed group used to
    // have its move / attack-move cancelled and just stopped there). Park on our own tile so
    // we stop shoving at the crowd, and pick the route up when the wait lapses.
    //
    // The one thing that DOES end the order is terrain: if the destination is out of reach
    // even with every other unit taken off the map, no amount of waiting will open it.
    this.holdOrGiveUp(u, tx, ty);
  }

  // --- combat -------------------------------------------------------------

  /** On a harvest round-trip: walking out to the node, working it, or hauling the
   *  load back to a depot. A worker mid-trip keeps working — it doesn't look up from
   *  the tree to fight (issue #41). This is what keeps the Ghoul, which is NOT
   *  Peon-classified and so fights like a soldier when it has nothing better to do,
   *  from abandoning the lumber line the moment a skirmish breaks out beside it. */
  private harvesting(u: SimUnit): boolean {
    return !!u.worker && (u.order === "harvest" || u.order === "return");
  }

  /** How far this unit will auto-acquire a target: the weapon's acquisition range
   *  (UnitWeapons.slk `acquire`), or a creep's own aggro range (its map-placed
   *  targetAcquisition). Zero — never auto-acquires — for a worker: always for the
   *  Peon-classified ones, and while on a harvest trip for anything else that
   *  harvests (the Ghoul). 0 here keeps them out of every automatic path: idle
   *  scans, assist, attack-move, post-kill re-acquire, and the switch to a reachable
   *  enemy. An explicit attack order goes through issueAttack and doesn't consult
   *  this, so you can always pull a worker off the line and into a fight. */
  private acquireRange(u: SimUnit): number {
    // An invisible unit doesn't pick its own fights, for the same reason a worker doesn't:
    // 0 here keeps it out of every automatic path. Nothing states this outright — it is
    // read off what invisibility is FOR. classic.battle.net's rule is that invisible units
    // "reveal themselves if they DO anything but move or stop", and an auto-attack is not
    // the player doing anything; if it counted, a Blademaster could never wind walk out of
    // a fight (he would turn round and re-reveal on the nearest enemy) and Invisibility
    // could never walk a unit past anyone. An explicit attack order still goes through
    // issueAttack, which never consults this — so you can always choose to strike, and
    // that strike is what reveals you. Gated on `cloaked`, not `invisible`, so the 0.6s
    // Transition Time isn't a window in which he auto-attacks his own wind-up away.
    if (u.cloaked) return 0;
    if (u.isPeon || this.harvesting(u)) return 0;
    if (u.isCreep) return u.aggroRange;
    return u.weapon ? u.weapon.acquire : 0;
  }

  private tickAttack(u: SimUnit, dt: number): void {
    // Banished mid-fight (issue #49): an ethereal unit can't attack — drop the order
    // and stand down rather than chase a target it can never hit.
    if (u.ethereal) {
      this.cancelSwing(u);
      this.stop(u.id);
      return;
    }
    // An attack the unit picked up ITSELF never outranks an autocast (issue #94). This is
    // where a Priest's Heal was being lost: idle auto-acquisition and attack-move both hand
    // the fight over as a plain "attack" order, and from then on nothing looked at the
    // autocast again — so one enemy wandering past turned a healer into a very bad archer,
    // permanently. `attackOrdered` is what decides how FAR the autocast may reach here, not
    // whether it runs at all: an ordered attack is the player pointing at a victim, and a
    // Priest sent at one with Heal on is still a Priest. What a commanded attack does buy is
    // the WALK — he marches on the target with the rest of the group and does not peel off
    // to heal something back down the field on the way (the ordered branch below fires only
    // once he is in the fight). A committed swing still lands first — the strike is already
    // in flight.
    if (!u.attackOrdered && u.swingLeft < 0 && this.tickAutocast(u)) return;
    // An AUTO-acquired fight ends the moment the target stops being an enemy — ally a player
    // mid-battle in WC3 and the shooting stops. Only the unit's OWN idea of a fight, never an
    // ORDERED attack: "attack THAT one" is the player overriding alliance, which is what a
    // force-attack is (issueAttack takes `force` for exactly this), and it is also how a
    // campaign's triggers send neutral Naga at the ships they are otherwise passive toward.
    if (!u.attackOrdered && u.targetId !== null) {
      const cur = this.units.get(u.targetId);
      if (cur && !this.hostile(u, cur)) {
        this.reacquireOrStop(u);
        return;
      }
    }
    let t = u.targetId !== null ? this.units.get(u.targetId) : undefined;
    // No target, no weapon, or nothing in hand that can strike THIS target (a Flying Machine
    // whose Bombs were never researched, ordered onto a Footman): don't just stand down — a
    // group that kills its target immediately rolls onto the next hostile still in range,
    // instead of waiting out an idle-scan tick (issue #24 — "especially ranged units" that
    // out-range a fleeing/dying target and were left standing around).
    let w = t ? this.weaponVs(u, t) : null;
    if (!t || !w) {
      this.reacquireOrStop(u);
      return;
    }
    // It vanished mid-fight: lose it. This is the other half of canSee's no-aggro rule — that
    // one stops an invisible unit being PICKED as a target, this one stops an attacker who
    // already had it from following it into the fade. Without it, wind walking out of a fight
    // wouldn't shake anyone: they'd keep swinging at a hero they can no longer see. The
    // re-acquire it falls into can't pick the same unit back up (canSee refuses it), so the
    // attacker rolls onto another enemy or stands down.
    if (t.invisible) {
      this.reacquireOrStop(u);
      return;
    }
    // It went UNTOUCHABLE mid-fight — a Divine Shield, a Big Bad Voodoo, a trigger's
    // SetUnitInvulnerable — and the same thing happens: lose it. An attack on an invulnerable
    // unit is one `issueAttack` refuses outright (issue #26), so an order aimed at one cannot
    // be GIVEN; an order that outlived its target's vulnerability is the same illegal state
    // arrived at by waiting, and it left a unit swinging forever at something it cannot hurt.
    //
    // The sibling order paths have always known this — attack-move and Hold Position both drop
    // a target that "went invulnerable (Divine Shield resets aggro)", and `acquireTarget`
    // refuses to pick one up — so this is the single-target attack order catching up with the
    // rule the rest of the sim already keeps. That is also what makes it safe to do every
    // tick: the re-acquire cannot hand the same unit back (acquireTarget skips it), so the
    // attacker rolls onto another enemy or stands down, once.
    //
    // The community's own workaround for "make my units ignore that one and go hit something
    // else" is to make it invulnerable, which is only a workaround if this is what the engine
    // does with it (hiveworkshop thread 359769, "How to make units ignore attacking a unit
    // with a specific buff?").
    if (t.invulnerable) {
      this.reacquireOrStop(u);
      return;
    }
    // A TOWER HOLDS NO GRUDGE. It cannot walk after what you pointed it at, so the moment an
    // ORDERED target steps outside the weapon it would answer with, the order is finished:
    // let go and look again, rather than standing there aimed at something that is never
    // coming back into reach while enemies walk past underneath. Deliberately the same test
    // `issueAttack` refuses the order with at the click ([Errors] `Notinrange`), so the rule a
    // player is told about and the rule the tower lives by are one rule.
    //
    // Only the ORDERED attack. Auto-acquisition is exactly the "lock on and wait for it to
    // close" a Spirit Tower needs (acquire 900 against a 700 weapon), and reacquireOrStop may
    // well hand this same target straight back as an UN-ordered lock — that is the tower
    // watching its ground, which is what it should be doing.
    if (u.attackOrdered && !this.canPursue(u) && !this.inWeaponRange(u, t)) {
      this.reacquireOrStop(u);
      return;
    }
    // Holding after giving up on an unreachable target (issue #24): stand completely
    // still — do NOT chase — so a boxed-in unit doesn't take a shoved-back probing step
    // every cooldown (the residual micro-wobble). While committed (repathT ticking) we
    // just hold and face; when the cooldown lapses we re-evaluate with a PURE A* check
    // (no movement): target now in reach or reachable again → drop the hold and fight;
    // a different target reachable → switch; still walled in → re-arm the hold.
    if (u.gaveUp) {
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      const band = w.ranged ? w.range : w.range + ATTACK_LEASH;
      if (gap <= band) {
        u.gaveUp = false; // it wandered into reach — fight
      } else if (Math.abs(gap - u.gaveUpGap) > ATTACK_LEASH) {
        // The target moved relative to us since we settled to wait — the fight has
        // shifted, so drop the hold and re-evaluate fresh (don't sit out a stale wait).
        u.gaveUp = false;
        u.attackStalls = 0;
      } else if (u.repathT > 0) {
        this.settle(u); // de-conflicting combat settle: queue onto our own tile, no stacking
        u.inCombat = false;
        u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
        return;
      } else if (this.canReachToAttack(u, t)) {
        u.gaveUp = false; // a blocker cleared — resume the chase (falls through to engage)
      } else {
        const range = this.acquireRange(u);
        const next = range > 0 ? this.reachableEnemy(u, range, t.id) : null;
        if (next) {
          this.issueAttack(u.id, next.id);
          return;
        }
        this.settle(u); // de-conflicting combat settle: queue onto our own tile, no stacking
        u.inCombat = false;
        u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
        u.repathT = ATTACK_GIVEUP_COOLDOWN; // keep holding — re-check again later
        return;
      }
    }
    // If we're chasing a far / walled-off target while a DIFFERENT enemy is ALREADY within
    // striking range, hit the one that's right here — a melee unit must never walk past an
    // enemy it can reach toward one it can't (issue #24: "won't fight even though it can
    // reach the enemy, especially after the first kill"). Only when we're not already
    // engaged and our current target isn't itself in reach. Cheap distance scan, filtered
    // like auto-acquire (visible, no idle creep camp); the switch resets the watchdog so
    // the rest of this tick runs against the new, in-range target. A worker keeps the
    // target it was ordered onto — it never picks up a fight of its own (issue #41), and
    // so does a unit whose attack was ORDERED: "attack THAT one" means walking past the
    // ones in between, exactly as it does in WC3 (issue #83). This switch exists for
    // targets the unit picked up itself.
    if (!u.inCombat && !u.isPeon && !u.attackOrdered) {
      u.acquireT -= dt; // throttle the scan to ~5x/sec (not every tick — it's an O(units) scan)
      if (u.acquireT <= 0) {
        u.acquireT = 0.2;
        const strike = w.ranged ? w.range : w.range + ATTACK_LEASH;
        const curGap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
        if (curGap > strike) {
          // A creep asks the same tier-ordered question it asks everywhere else: the enemy
          // that is RIGHT HERE is worth turning on, but not when the thing right here is the
          // Peasant or the Serpent Ward standing in front of the army (see threatTier).
          const near = u.isCreep ? this.bestCreepTarget(u, strike) : this.acquireTarget(u, strike);
          if (near && near.id !== t.id) {
            this.issueAttack(u.id, near.id);
            t = near;
            w = this.weaponVs(u, t) ?? w; // the new target may want the other slot
          }
        }
      }
    }
    // THE FIGHT IS JOINED, and the caster was commanded into it: now the autocast outranks
    // the attack after all. A Priest in a group told to attack a target walks in with the
    // group (the top-of-tick branch refused him while he was still closing), and once he is
    // in striking distance of the thing he was pointed at, Heal comes first — an army's
    // healer is not an archer. Nothing to heal, no mana, or the spell on cooldown, and
    // tickAutocast simply declines and he swings, which is the "unless the Heal isn't
    // possible" half of the rule.
    //
    // From here the autocast reaches as far as it does anywhere else — the caster's own
    // acquisition range, walking if it must (autocastSearchRange). It has to: a Priest's
    // weapon is 600 and his Heal is 250, so he stands half a screen behind the Footmen he
    // is there to keep alive, and a heal that could only reach what was already beside him
    // would have healed exactly once and then watched them die. The walk is bounded by his
    // own eyes, and `resume` puts him back on the ordered target the moment he is done.
    //
    // The strike-band test is the same one engage() uses to decide it has arrived, so "in
    // combat" means the same thing to both.
    //
    // NOT when the order was aimed at HIM ALONE (`attackSolo`). All of the above is about a
    // caster who came along with an army: the group was pointed at something, and inside a
    // group the healer heals. Select the Priest by himself and click an enemy and there is no
    // group — that is a player micro-ing one unit, and the general rule applies instead:
    // Liquipedia's Autocast page has an ORDER suppressing autocast, and this is as explicit as
    // an order gets. He swings until he is told otherwise (and goes straight back to healing
    // the moment the order ends — `attackSolo` dies with `attackOrdered`).
    const inBand = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius <= w.range + ATTACK_LEASH;
    if (u.attackOrdered && !u.attackSolo && u.swingLeft < 0 && inBand && this.tickAutocast(u)) return;
    this.engage(u, t);
    // Combat-approach watchdog (issue #24). Reset the moment we're within the strike
    // band (range + leash) — genuinely fighting — rather than on engage()'s inCombat
    // flag, which a unit wobbling right at the range edge flips on/off every tick,
    // perpetually zeroing the timer. Otherwise measure headway toward the target two
    // ways: net ground covered, and how much the gap shrank. Either clears it; a
    // wobbler blocked by other bodies does neither, so it re-decides.
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    // Reset iff engage() counted us "in range" this tick (didn't chase) — the SAME band it
    // uses, ranged and melee alike: weapon range while there is still road to walk,
    // range + leash once the approach has run out or the fight has already started.
    const band = u.inCombat || !u.moving ? w.range + ATTACK_LEASH : w.range;
    if (gap <= band) {
      u.stallT = 0;
      u.attackStalls = 0; // in the fight — clear the stall streak
      return;
    }
    // Committed to standing after giving up (or briefly cooling down after a block):
    // don't re-probe — engage() is already holding position while repathT ticks down.
    if (u.repathT > 0) {
      u.stallT = 0;
      return;
    }
    if (u.stallT === 0) {
      u.stallAnchorX = u.x;
      u.stallAnchorY = u.y;
      u.stallGap = gap;
    }
    u.stallT += dt;
    if (u.stallT < ATTACK_STALL_TIME) return;
    const moved = Math.hypot(u.x - u.stallAnchorX, u.y - u.stallAnchorY);
    const closed = u.stallGap - gap;
    u.stallT = 0;
    if (moved >= ATTACK_PROGRESS || closed >= ATTACK_PROGRESS) {
      u.attackStalls = 0; // real headway — keep chasing
      return;
    }
    // No headway this window. redecideAttack repaths/switches while it still looks
    // reachable; but if we keep stalling anyway (A* threads the surround's gaps, collision
    // blocks the last stretch — the outer-ring jitter), stop trusting it and HOLD.
    u.attackStalls++;
    if (u.attackOrdered) {
      // A commanded attack is a commitment (issue #83). Spend ORDERED_COMMIT_TIME just
      // trying to get there — fresh surround slot, fresh path around whatever blocked us —
      // before the reachability question is even asked.
      if (u.attackStalls * ATTACK_STALL_TIME < ORDERED_COMMIT_TIME) {
        this.repathAttack(u, t);
        return;
      }
      // Standing on the same spot for two seconds. Now the pathfinder decides: a target
      // it can still path to means we're jammed by bodies, not walled off — hold facing
      // the target we were TOLD to kill rather than wander onto someone else. Only a
      // genuinely unreachable one releases the order, and then the ordinary fallback
      // below hands us the nearest enemy we can actually reach.
      if (this.canReachToAttack(u, t)) {
        if (!this.repathAttack(u, t)) this.holdAttack(u, t);
        return;
      }
      u.attackOrdered = false;
    }
    if (u.attackStalls >= 2) {
      // Before standing down, make sure there isn't ANOTHER enemy we can actually reach
      // and fight instead — a unit must never stand idle beside an enemy it could attack
      // just because its ORIGINAL target is walled off (issue #24: "the nearest enemy must
      // always be attacked"). Only hold when nothing reachable remains.
      const range = this.acquireRange(u);
      const next = range > 0 ? this.reachableEnemy(u, range, t.id) : null;
      if (next) this.issueAttack(u.id, next.id);
      else this.holdAttack(u, t);
    } else {
      this.redecideAttack(u, t);
    }
  }

  /** Stop chasing and hold position facing the target — used when an attacker keeps
   *  failing to close despite the target looking reachable (see ATTACK_HOLD_MAX). The
   *  hold cooldown grows with the stall streak so a permanently blocked unit stands
   *  progressively stiller; tickAttack's gaveUp branch owns the wait and the exit. */
  private holdAttack(u: SimUnit, t: SimUnit): void {
    this.settle(u); // de-conflicting combat settle: queue onto our own tile, no stacking
    u.gaveUp = true;
    u.inCombat = false;
    u.gaveUpGap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
    u.repathT = Math.min(ATTACK_GIVEUP_COOLDOWN * Math.max(1, u.attackStalls - 1), ATTACK_HOLD_MAX);
  }

  /** An attacker's target just died/vanished: keep fighting by acquiring the next
   *  hostile in acquisition range and attacking it; only fall idle when nothing is
   *  left nearby (WC3 units follow up after a kill). Creeps keep their own guard/
   *  camp controller, so they just fall idle here and re-engage via tickCreep/
   *  tickAcquire next tick. */
  private reacquireOrStop(u: SimUnit): void {
    const acq = this.acquireRange(u);
    if (acq > 0 && !u.isCreep) {
      const next = this.acquireTarget(u, acq);
      if (next) {
        // Grab the nearest enemy. If it turns out to be walled off, the in-strike-range
        // switch in tickAttack (cheap) and the stall watchdog (which hands off to the
        // nearest REACHABLE enemy) take over from here — no need for an A* probe on every
        // kill, which got expensive in high-churn fights.
        this.issueAttack(u.id, next.id);
        return;
      }
    }
    // A follower that peeled off to guard its leader has cleared the area — return to
    // trailing it rather than falling idle where it stands (issue #32). The leader may
    // have moved off during the fight; issueFollow re-homes on it (dead → fall to idle).
    if (u.followLeaderId !== null && this.units.has(u.followLeaderId)) {
      this.issueFollow(u.id, u.followLeaderId, u.followOffX, u.followOffY);
      return;
    }
    this.stop(u.id);
  }

  /** A unit has been unable to close on its attack target for ATTACK_STALL_TIME.
   *  Re-decide, escalating: (1) claim a fresh surround slot in case ours is walled
   *  off and repath around the blockers; (2) if the target is genuinely unreachable,
   *  switch to the nearest hostile we CAN path in to hit; (3) if nothing reachable
   *  is left, stop grinding and just face the target (WC3 units give up on a target
   *  they can't reach rather than jiggling in place forever). */
  private redecideAttack(u: SimUnit, t: SimUnit): void {
    // (1) Is the target actually reachable — can we path a foot into weapon range?
    // Gate on that, NOT on pathTo()'s boolean: pathTo always returns a best-effort
    // path (one cell toward the goal) even when the goal can't be reached, so a unit
    // wobbling toward a walled-off slot would "succeed" here every time and never let
    // go. Only when we can genuinely close do we claim a fresh slot and repath around
    // whatever blocked our old one.
    if (this.canReachToAttack(u, t) && this.repathAttack(u, t)) return; // found a way around — resume the chase
    // (2) Target unreachable — hand off to a reachable one within our normal
    // acquisition range (creeps use their aggro range and camp threat order).
    const range = this.acquireRange(u);
    const next = range > 0 ? this.reachableEnemy(u, range, t.id) : null;
    if (next) {
      this.issueAttack(u.id, next.id); // issueAttack clears gaveUp
      return;
    }
    // (3) Nothing reachable: enter the holding sub-state — stand and face, committed
    // for a spell so we don't probe (and get shoved back) every second. tickAttack's
    // gaveUp branch owns it from here (pure A* re-checks, no movement).
    this.settle(u);
    u.gaveUp = true;
    u.gaveUpGap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
    u.repathT = ATTACK_GIVEUP_COOLDOWN;
  }

  /** Claim a fresh surround slot on `t` and path in to it — the "try another way round"
   *  step, shared by redecideAttack and the ordered-attack commitment. Clears the hold
   *  cooldown first so the repath isn't refused. False = no path at all from here. */
  private repathAttack(u: SimUnit, t: SimUnit): boolean {
    this.assignAttackSlot(u, t);
    const ax = u.atkOffX !== 0 || u.atkOffY !== 0 ? t.x + u.atkOffX : t.x;
    const ay = u.atkOffX !== 0 || u.atkOffY !== 0 ? t.y + u.atkOffY : t.y;
    u.repathT = 0;
    if (!this.pathTo(u, ax, ay, COMBAT_EXPANSIONS)) return false;
    u.gaveUp = false; // moving again — not holding
    return true;
  }

  /** Nearest hostile within `range` (excluding `excludeId`) this unit can actually
   *  path in to strike — the reachability filter the issue asks for. Bounded: only
   *  the few nearest candidates get an A* probe, and it only runs when a unit has
   *  already given up on an unreachable target, so the cost is rare. Applies the
   *  same visibility / un-aggroed-creep gates as normal auto-acquire. */
  private reachableEnemy(u: SimUnit, range: number, excludeId: number): SimUnit | null {
    const cands: Array<{ t: SimUnit; gap: number }> = [];
    for (const t of this.units.values()) {
      if (t === u || t.id === excludeId || !this.hostile(u, t)) continue;
      if (!this.canAttack(u, t)) continue; // no weapon for it — not a candidate at any distance
      if (t.isCreep && !this.creepAggroed(t)) continue; // don't pull an idle camp
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap > range) continue;
      if (!this.canSee(u, t)) continue; // never aggro what we cannot see (sight + fog + LOS)
      cands.push({ t, gap });
    }
    // Nearest first — except for a creep, which ranks by threat tier first and only breaks
    // ties by distance (threatTier), so a switch forced by an unreachable target can't be the
    // back door that puts the camp back on the workers.
    if (u.isCreep) cands.sort((a, b) => this.threatTier(b.t) - this.threatTier(a.t) || a.gap - b.gap);
    else cands.sort((a, b) => a.gap - b.gap);
    for (let i = 0; i < cands.length && i < 5; i++) {
      if (this.canReachToAttack(u, cands[i].t)) return cands[i].t;
    }
    return null;
  }

  /** True when `u` can path to within weapon range of `t` (best-effort A*: the
   *  closest reachable cell lands in striking distance). Air units and targets
   *  already in range short-circuit. Releases `u`'s own cell reservation for the
   *  probe (as pathTo does) so its footprint doesn't block its own start. */
  private canReachToAttack(u: SimUnit, t: SimUnit): boolean {
    if (u.flying) return true;
    const reach = this.weaponVs(u, t)?.range ?? 0; // the range of the slot THIS target calls for
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    if (gap <= reach) return true;
    const wasReserved = u.hasReservation;
    this.unsettle(u);
    const start = this.grid.footprintAnchor(u.x, u.y, u.footprint);
    const blocked = this.clearanceBlocker(u, start);
    const goal = this.grid.footprintAnchor(t.x, t.y, u.footprint);
    const cells = findPath(this.grid, start, goal, blocked, COMBAT_EXPANSIONS, pathDomain(u));
    if (wasReserved) this.settle(u);
    if (!cells || cells.length <= 1) return false;
    const [ecx, ecy] = cells[cells.length - 1];
    const [ex, ey] = this.grid.footprintCenter(ecx, ecy, u.footprint);
    const endGap = Math.hypot(t.x - ex, t.y - ey) - u.radius - t.radius;
    return endGap <= reach + PATHING_CELL;
  }

  /**
   * "Is this unit pointed close enough at what it is about to do" — the gate a swing and a
   * cast both wait on while the turning pass rotates the body.
   *
   * A unit with NO turn rate always passes it. `turnRate` 0 is what UnitData's "-" means
   * (see UnitDef.turnRate), and every structure row carries it: a Guard Tower, a Spirit
   * Tower, a Black Citadel. They shoot whatever walks into range from the facing they were
   * PLACED at and never rotate to track it — the swivelling a tower does show lives inside
   * its own attack clip (the Cannon Tower's head, HumanTower.mdx "Attack Stand  Ready
   * Upgrade Second"), which is the model's business, not the sim's. Without this a tower
   * would be gated forever on a heading it can never reach, and never fire at all.
   */
  private facesTarget(u: SimUnit, eps: number): boolean {
    return u.turnRate <= 0 || Math.abs(angleDiff(u.facing, u.desiredFacing)) <= eps;
  }

  /** Close to weapon range, then face + swing at the damage point. Shared by
   *  direct Attack orders and attack-move engagements. `noChase` (Hold Position)
   *  makes the unit strike only what's already in range and never pursue. */
  private engage(u: SimUnit, t: SimUnit, noChase = false): void {
    // Ethereal (Banished) units can't swing — cancel any pending strike and hold,
    // never chase (issue #49). Covers the Hold / attack-move callers of engage; the
    // plain "attack" order is stood down in tickAttack.
    if (u.ethereal) {
      this.cancelSwing(u);
      u.inCombat = false;
      this.settle(u);
      return;
    }
    // The slot for THIS target — a Gargoyle's ground claws or its air spit, and each with its
    // own range and cooldown (the Flying Machine's bombs reach 100, its flak 500). Nothing we
    // can hit it with: stand down rather than chase a target we could never strike.
    const w = this.weaponVs(u, t);
    if (!w) {
      this.cancelSwing(u);
      u.inCombat = false;
      this.settle(u);
      return;
    }
    // Committed to a swing: the attack animation is playing toward its damage point,
    // where the strike/projectile fires (a delayed frame WITHIN the animation). A
    // WC3 unit stands still for that whole wind-up — it NEVER walks mid-strike, so
    // don't let a target drifting out of range start a chase now. Hold position and
    // keep facing the swing's target; tickSwing lands the hit at the damage point,
    // and only afterwards (swingLeft back to -1) do we re-check range and give chase.
    if (u.swingLeft >= 0) {
      if (u.moving) this.settle(u);
      u.inCombat = true;
      const st = this.units.get(u.swingTargetId) ?? t;
      u.desiredFacing = Math.atan2(st.y - u.y, st.x - u.x);
      return;
    }
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    // How close is "close enough to plant and swing". Walk in to the WEAPON RANGE; the
    // extra ATTACK_LEASH is only what a unit may already be standing at, never a licence
    // to stop short of the range.
    //
    // Issue #24 used to give MELEE the whole band (range + leash) unconditionally, so a
    // unit in a crowd stopped and attacked the moment it was within striking distance
    // rather than shoving toward a pixel-exact surround slot it could not physically reach
    // through the other bodies ("tries to pass through units, wobbling next to the target
    // without hitting"). That cost every melee attacker a full leash of ground: a ring of
    // them read as a loose scatter around the target rather than a surround pressed up
    // against it — issue #108's "surrounds aren't working as expected, we must move unit A
    // a bit closer". The grinding that made the wide band necessary is what the tile claims
    // removed: a blocked attacker no longer pushes, it stops and re-routes.
    //
    // So the band is now the same shape ranged units always had, and applies to both: the
    // tight range while there is still road to walk (a live approach path), the wide one
    // once that route has run out — it arrived, or a body stopped it — and once the fight
    // has started, where it is re-chase hysteresis. The wide reach is honest either way:
    // range + leash is what tickSwing actually connects a hit from.
    const chaseGap = u.inCombat || !u.moving ? w.range + ATTACK_LEASH : w.range;
    if (gap > chaseGap) {
      u.inCombat = false;
      // A tower cannot follow. Whatever it was shooting at has left, so the order is over and
      // it goes back to watching its ground — otherwise an ordered target that walks away
      // blinds the tower for good: it would hold an "attack" order on something it can never
      // reach while enemies walked past underneath it.
      if (!this.canPursue(u)) {
        this.stop(u.id);
        return;
      }
      if (noChase) {
        this.settle(u); // Hold Position: attack in range only, never step forward
        return;
      }
      this.chaseToAttack(u, t);
      return;
    }
    // In range: halt onto a distinct tile (spread, don't cluster — settleSpread), face
    // the target, swing when ready (rotation itself is applied by the shared turning pass).
    this.settleSpread(u, t);
    u.inCombat = true;
    u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
    // Don't start a new swing while facing the wrong way, cooling down, or with a
    // swing already mid-flight toward its damage point.
    if (!this.facesTarget(u, FACING_EPS) || u.cooldownLeft > 0 || u.swingLeft >= 0) return;
    // Begin the attack: the cooldown starts now, but the strike/projectile only
    // lands at the weapon's damage point (a fraction into the swing animation) —
    // matching WC3 so e.g. the Archmage's fireball leaves at the right moment.
    u.cooldownLeft = w.cooldown;
    u.swingLeft = Math.max(0, w.damagePoint);
    u.swingBroken = false; // a genuine new swing always animates (clears any prior break)
    u.swingTargetId = t.id;
    u.swingWeapon = w; // the strike lands with the slot it was launched from
    // Roll this swing's procs now, before the clip is picked (see swingCrit/swingSlam).
    // Critical Strike is only ever applied by dealDamage, so only a melee swing rolls it —
    // a ranged shooter must not slam for a crit it would never deal. And only against
    // something it may proc on: AOcr's `targs1` is "air,ground,enemy,neutral" — no `friend`
    // — so a force-attack on your own unit never crits (and so never slams).
    u.swingCrit = !w.ranged && this.hostile(u, t) && this.rollCriticalStrike(u);
    // Bash (AHbh) rolls here for the same reason crit does — the Mountain King's
    // "Attack Slam" clip is picked as the swing begins. Unlike crit it is NOT melee-only
    // (the item Bash AIbx sits happily on a ranged hero), but like crit it only procs on
    // something it may target: AHbh's targs1 is "ground,air" with no `friend`, so a
    // force-attack on your own unit never bashes.
    u.swingBash = this.hostile(u, t) && !t.invulnerable && this.rollBash(u);

    // A blow out of Wind Walk shows the same strike: the fade breaks at the damage point
    // (tickSwing) and that blow carries the Backstab Damage, so a swing begun while cloaked
    // is the backstab swing. `cloaked`, not `invisible` — the bonus is owed from the moment
    // the buff lands, transition included, which is the same test breakInvisibility makes.
    u.swingSlam = u.swingCrit || (u.swingBash && !w.ranged) || u.cloaked;
    u.swingSeq++; // renderer restarts the attack animation so the strike lines up
    // EVENT_(PLAYER_)UNIT_ATTACKED fires as the attacker commits a swing at the target.
    if (this.captureAttacks) this.attackEvents.push({ attacked: eventInfo(t), attacker: eventInfo(u) });
  }

  /** Attack-move: fight any hostiles within acquisition range FIRST (chasing +
   *  attacking, and acquiring the next the moment one dies), advancing toward the
   *  destination only when nothing is left to fight nearby (WC3 A-move). */
  private tickAttackMove(u: SimUnit, dt: number): void {
    const acq = this.acquireRange(u); // 0 for a worker — it just walks the route (issue #41)
    // Committed to a swing (see engage): stand still through the wind-up rather than
    // advancing toward the attack-move destination — a target fleeing past acquire
    // range mustn't drag the unit into walking while its strike is still pending.
    if (u.swingLeft >= 0) {
      if (u.moving) this.settle(u);
      u.inCombat = true;
      const st = this.units.get(u.swingTargetId);
      if (st) u.desiredFacing = Math.atan2(st.y - u.y, st.x - u.x);
      return;
    }
    // Autocast outranks the auto-attack, and does so BEFORE the enemy scan (issue #94). An
    // A-moved army's Priests heal and its Sorceresses Slow instead of plinking with their
    // sticks: Liquipedia's Autocast page is explicit that an ORDER suppresses autocast but
    // that "autocast remains active during attack-move, patrol, stop, and hold position
    // orders" — attack-move is not the player picking a victim, it is the player pointing.
    // (Only a single-target Attack order suppresses it; see tickAttack.)
    if (this.tickAutocast(u)) return;
    if (acq > 0) {
      const hadTarget = u.targetId !== null;
      let t = hadTarget ? this.units.get(u.targetId!) : undefined;
      // Drop the target if it died, turned friendly, went invulnerable (Divine Shield resets aggro), or fled past the leash.
      if (t && (!this.hostile(u, t) || t.invulnerable || Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius > acq)) t = undefined;
      if (!t) {
        if (hadTarget) u.acquireT = 0; // just lost one — re-scan now, don't creep forward
        u.acquireT -= dt;
        if (u.acquireT <= 0) {
          u.acquireT = ACQUIRE_PERIOD;
          // Sight-gated: an attack-moving army engages what it can SEE, not whatever
          // the sim knows is out there in the fog ahead of it (issue #45).
          t = this.nearestEnemy(u, acq, true) ?? undefined;
        }
      }
      if (t) {
        this.setAttackSlot(u, t); // fan out around it, like a direct attack order
        u.targetId = t.id;
        this.engage(u, t);
        // engage() either planted us in striking distance or set us walking. If it managed
        // neither, the way to this enemy is shut; and even when it did set us walking, the
        // walk may be going nowhere. Standing off from a fight we never join is the one
        // thing an attack-move must never do (issue #108), so both cases let the enemy go
        // and fall through to advancing on the destination — advancing is itself what
        // usually opens the way, and the scan half a second later picks up whatever we CAN
        // reach, this one included. A committed swing counts as fighting: it is in flight.
        const engaged = u.moving || u.inCombat || u.swingLeft >= 0;
        if (engaged && !this.attackMoveStalled(u, t, dt)) return;
        u.targetId = null;
        u.acquireT = ACQUIRE_PERIOD;
        u.stallT = 0;
      }
    }
    // Nothing to fight nearby (and nothing to cast on — that was tried first): resume toward
    // the attack-move destination.
    u.targetId = null;
    u.inCombat = false;
    if (Math.hypot(u.amDestX - u.x, u.amDestY - u.y) <= ARRIVE_EPS) {
      this.stop(u.id); // arrived
      return;
    }
    if (!u.moving) {
      // Parked in a jam: the order stands, we are just waiting for the way to open.
      if (u.waitT > 0) return;
      if (!this.pathTo(u, u.amDestX, u.amDestY)) {
        // Bodies in the way → wait them out, keeping the order. Terrain → the destination
        // is genuinely out of reach, and only then does the attack-move end (issue #108).
        this.holdOrGiveUp(u, u.amDestX, u.amDestY);
      }
    } else if (Math.hypot(u.chaseX - u.amDestX, u.chaseY - u.amDestY) > CHASE_REPATH) {
      this.pathTo(u, u.amDestX, u.amDestY); // was chasing an enemy — steer back on course
    }
  }

  /** Attack-move's approach watchdog — the thing tickAttack has had all along and this did
   *  not (issue #108). Without it an attacker whose surround slot turns out to be a dead
   *  end never closes and never lets go: it wobbles a few metres short of the fight for the
   *  rest of the battle, holding a target it neither reaches nor hits.
   *
   *  Headway here is measured ONLY as the GAP shrinking, not as ground covered. That is the
   *  whole distinction: a unit genuinely walking in closes; a unit shuffling between two
   *  spots it can reach covers plenty of ground and closes nothing, and reading that as
   *  progress is exactly what let the wobble run forever.
   *
   *  True = give this enemy up for now. The caller then advances on the attack-move
   *  destination and re-scans; nothing is lost, because advancing changes the geometry that
   *  blocked us and the same enemy is a candidate again half a second later. */
  private attackMoveStalled(u: SimUnit, t: SimUnit, dt: number): boolean {
    const w = this.weaponVs(u, t);
    if (!w) return true;
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    if (gap <= w.range + ATTACK_LEASH) {
      u.stallT = 0; // in the fight — nothing to watch
      u.attackStalls = 0;
      return false;
    }
    if (u.stallT === 0) {
      u.stallAnchorX = u.x;
      u.stallAnchorY = u.y;
      u.stallGap = gap;
    }
    u.stallT += dt;
    if (u.stallT < ATTACK_STALL_TIME) return false;
    const closed = u.stallGap - gap;
    u.stallT = 0;
    if (closed >= ATTACK_PROGRESS) {
      u.attackStalls = 0; // genuinely closing — leave it alone
      return false;
    }
    // One window lost: the slot we were handed may simply be walled off by the ranks
    // already fighting. Claim a fresh one and route again before giving up on the enemy.
    if (++u.attackStalls < 2) {
      this.repathAttack(u, t);
      return false;
    }
    u.attackStalls = 0;
    u.atkOffTarget = -1; // that slot was a dead end — take a new one if we come back to it
    return true;
  }

  /** Nearest hostile within `range` (gap measured hull-to-hull), or null. */
  private nearestEnemy(u: SimUnit, range: number, needSight = false): SimUnit | null {
    let best: SimUnit | null = null;
    let bestGap = range;
    for (const t of this.units.values()) {
      if (t === u || !this.hostile(u, t)) continue;
      // Untouchable is not a target — the same line `acquireTarget` keeps, and it has to be
      // kept HERE too or the attack-move that reads this loops: tickAttackMove drops an
      // invulnerable target, zeroes its scan timer because it just lost one, and is handed the
      // same unit straight back, every tick, for as long as it stands there. An A-move walked
      // into a Divine Shield stopped dead beside it and never reached its destination. The
      // creep uses (wake, go-home) want the same answer: a unit nothing in the camp can hurt
      // is not a reason to get up.
      if (t.invulnerable) continue;
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap >= bestGap) continue;
      if (!this.canAttack(u, t)) continue; // nothing in hand that can hit it (air/ground/structure)
      if (needSight && !this.canSee(u, t)) continue;
      bestGap = gap;
      best = t;
    }
    return best;
  }

  /** This unit's sight radius right now: UnitBalance `sight` by day, `nsight` after
   *  dark (the same radii that lift the fog for the player). */
  private sightOf(u: SimUnit): number {
    return (this.isDay ? u.sightDay : u.sightNight) || u.sightDay || 800;
  }

  /** Can `u` actually SEE `t`? Every auto-acquisition asks this; an explicit attack
   *  order and return fire never do (a struck unit always turns on whoever hit it).
   *
   *  Two gates. First the unit's OWN eyes: nothing is acquired beyond its sight radius,
   *  which shrinks at night — that's why an army can slip past a creep camp in the dark
   *  even though the camp's acquisition range hasn't changed (issue #45: creeps were
   *  aggroing through the fog because no creep path consulted sight at all). Then the
   *  player's shared team vision (`visibleToTeam`), so nothing aggros an enemy its own
   *  side hasn't revealed. Non-local teams pass that second gate — only the local team's
   *  fog is modelled — so for creeps this is purely eyes and terrain.
   *
   *  Last and most expensive, LINE OF SIGHT: a treeline or a cliff between the two
   *  blinds the watcher exactly as it blanks the fog map. Ranged creeps were shooting
   *  heroes straight through a forest they could not see over. Ordered last, and after
   *  each caller's range test, so the ray is only cast for a target already worth it. */
  /** Does any living unit on `team` have True Sight covering (x, y)? Detection is shared
   *  across the team, so one Shade or one Sentry Ward uncovers a Wind Walking hero for
   *  every unit that side owns. */
  teamDetects(team: number, x: number, y: number): boolean {
    for (const d of this.units.values()) {
      if (d.team !== team || d.hp <= 0 || d.detectRadius <= 0) continue;
      if (Math.hypot(d.x - x, d.y - y) <= d.detectRadius) return true;
    }
    // …and detection an ITEM bought rather than a unit carries: Dust of Appearance and the
    // Crystal Ball reveal invisible units inside their circle for as long as it lasts, with
    // nothing standing there to do the seeing (see ItemReveal.detect).
    for (const r of this.itemReveals) {
      if (!r.detect || r.team !== team) continue;
      if (Math.hypot(r.x - x, r.y - y) <= r.radius) return true;
    }
    return false;
  }

  private canSee(u: SimUnit, t: SimUnit): boolean {
    // An invisible unit is INVISIBLE: it draws no aggro. classic.battle.net's invisibility
    // page — "just because you can't see them, it doesn't mean you can't hit them!" — is the
    // other half of this: being unseen stops the automatic paths, not a deliberate blow, and
    // every caller here is an automatic one (idle scan, creep aggro, assist, re-acquire).
    // An explicit attack order goes through issueAttack and never consults canSee.
    //
    // …unless somebody on the watcher's side has TRUE SIGHT over it. Detection is a team
    // property in WC3, not a personal one: the Shade stands at the back and the whole army
    // sees what it uncovers, which is the entire reason the unit exists.
    if (t.invisible && !this.teamDetects(u.team, t.x, t.y)) return false;
    if (Math.hypot(t.x - u.x, t.y - u.y) - t.radius > this.sightOf(u)) return false;
    if (!this.visibleToTeam(u.team, t.x, t.y)) return false;
    return this.lineOfSight(u.x, u.y, t.x, t.y, u.flying || t.flying);
  }

  /** The two things a creep camp turns on LAST, however close they are standing: a WORKER
   *  and a WARD. Both are the same mistake — the camp spends itself on something that is not
   *  the fight while the army that brought it stands on top of them.
   *
   *  Both come straight from UnitBalance.slk's `type` column rather than from anything we
   *  infer: `Peon` is exactly the nine harvest-and-build units (Peasant, Peon, Acolyte, Wisp
   *  and the five neutral variants) and `Ward` is exactly the ten planted gadgets (Serpent,
   *  Healing, Sentry and Watcher Wards, Stasis Trap, Monster Lure, Goblin Land Mine). Keying
   *  off the classification is what makes the Militia a normal soldier: `hmil` is its own
   *  unit type with no `Peon` in its `type` at all, so a Peasant that calls to arms stops
   *  being a worker the instant it changes shape — which is the point of the ability.
   *
   *  It is also why an armed ward is still bottom of the pile: a Serpent Ward carries a real
   *  weapon and would otherwise outrank the Grunt beside it. */
  private lowPriorityTarget(t: SimUnit): boolean {
    return t.isPeon || t.ward;
  }

  /** The target a roused creep actually turns on, given the one it was HANDED — a camp-mate's
   *  shout (alertCamp) or whatever just hit it. Ranking workers and wards last has to survive
   *  both, or the ordering is decided by whichever of them fires first: an edge creep with only
   *  the Peasant inside its own 500 shouts, and the whole camp walks past the army to mob the
   *  Peasant; a Serpent Ward plinks a Murloc, and the camp turns on the ward that was planted
   *  to make it do exactly that. So a handed-over worker or ward is only a SUGGESTION — the
   *  creep still looks around first and keeps whatever outranks it. Anything else is handed
   *  straight through, because a shout about a Footman is the camp cohesion working. */
  private creepTargetOver(c: SimUnit, handed: SimUnit): SimUnit {
    if (!this.lowPriorityTarget(handed)) return handed;
    const own = this.bestCreepTarget(c, c.aggroRange);
    return own && this.threatTier(own) > this.threatTier(handed) ? own : handed;
  }

  /** How much of a threat a target is to a creep, for target selection: armed
   *  units (incl. heroes) rank above helpless units, which rank above buildings,
   *  which rank above the workers and wards of lowPriorityTarget.
   *  Creeps "attack enemy units first" instead of chewing a structure while an
   *  army stands on them. Same tier → distance breaks the tie (see bestCreepTarget). */
  private threatTier(t: SimUnit): number {
    if (this.lowPriorityTarget(t)) return 0; // workers and wards dead last
    if (t.building) return 1; // structures next
    if (t.weapon) return 3; // armed units / heroes first
    return 2; // unarmed units in between
  }

  /** Highest-threat hostile within `range` for a creep — the biggest threat tier,
   *  nearest within that tier. This is what makes a camp focus the real threat
   *  rather than the nearest thing, and — through the bottom tier — what stops it
   *  focusing the Peasant or the Serpent Ward standing in front of the real thing. */
  private bestCreepTarget(u: SimUnit, range: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestTier = -1;
    let bestGap = Infinity;
    for (const t of this.units.values()) {
      if (t === u || !this.hostile(u, t)) continue;
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap > range) continue;
      if (!this.canAttack(u, t)) continue; // a ground-only creep ignores the flyer overhead
      if (!this.canSee(u, t)) continue; // a creep aggroes only what it can see (issue #45)
      const tier = this.threatTier(t);
      if (tier > bestTier || (tier === bestTier && gap < bestGap)) {
        bestTier = tier;
        bestGap = gap;
        best = t;
      }
    }
    return best;
  }

  /** Advance an in-progress attack swing; when it reaches the weapon's damage
   *  point, launch the projectile (ranged) or deal the hit (melee). */
  private tickSwing(u: SimUnit, dt: number): void {
    const w = u.swingWeapon;
    if (u.swingLeft < 0 || !w) return;
    u.swingLeft -= dt;
    if (u.swingLeft > 0) return;
    u.swingLeft = -1;
    const t = this.units.get(u.swingTargetId);
    if (!t) return; // target gone before impact — the swing whiffs
    // The swing reached its fire frame: play the attacker's own weapon sound (its
    // model's SND "K" event) regardless of whether a melee strike will connect.
    this.attackSwings.push(u.id);
    // Attacking reveals — at the fire frame, so a ranged shot gives its shooter away when it
    // is loosed and not when it lands. The blow that breaks the fade carries the Backstab
    // Damage; a melee swing that then whiffs still spends it, having already given the unit up.
    const backstab = this.breakInvisibility(u);
    if (launchesMissile(w.weaponType)) {
      this.spawnProjectile(u, t, w, backstab);
    } else if (w.ranged) {
      // `instant` — ranged HITSCAN. The damage lands on the fire frame with nothing in
      // flight, and the slot's `Missileart` is a one-shot burst played on the unit struck:
      // all six stock instant slots name a `*Impact.mdx` that holds a lone "Birth" sequence
      // (RifleImpact = a Dust3 puff + a Yellow_Star_Dim spark — the bullet hit), with no
      // "Stand" to loop while travelling. No reach re-test: like a homing missile, a loosed
      // instant shot connects — only MELEE can whiff on a target that drifted out of reach.
      if (w.missileArt) this.spellEffects.push({ art: w.missileArt, x: t.x, y: t.y, targetId: t.id, z: w.impactZ });
      this.dealDamage(u, t, w, backstab);
    } else {
      // Melee connects if the target is still within the same reach the unit is
      // allowed to swing from (range + the combat-hold leash) — NOT the tighter
      // ARRIVE_EPS, which left a dead band where the attack animation played but
      // the strike whiffed and no damage landed against a target drifting away.
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap <= w.range + ATTACK_LEASH) this.dealDamage(u, t, w, backstab);
    }
  }

  /** Cancel any pending swing (unit re-tasked away from its attack). */
  private cancelSwing(u: SimUnit): void {
    u.swingLeft = -1;
  }

  /**
   * Reveal an invisible unit, and return the Backstab Damage the blow that broke it earns
   * (0 if it wasn't invisible, or for a plain invisibility that carries no bonus).
   *
   * WC3's rule is the same for EVERY source of invisibility — Wind Walk, the Sorceress's
   * Invisibility, a Potion — so this is the one place it lives. classic.battle.net:
   * "Invisible units will reveal themselves if they do anything but move or stop."
   *
   * Breaking ends the whole ABILITY, not just the fade: it drops every buff sharing the
   * invisible buff's group, so a broken Wind Walk takes its Movement Speed Increase with it
   * (liquipedia has the cooldown starting "when Wind Walk breaks" — the ability is over).
   * The group is what scopes that: Wind Walk's speed and invisibility are both "windwalk",
   * while a bare Invisibility only ever drops itself. An ungrouped ("") buff is nobody's
   * sibling, so it must never be swept up by group equality.
   */
  /**
   * Shadow Meld's two extra break conditions, checked every tick because neither one is an
   * EVENT the unit does — they are conditions that stop holding.
   *
   * MOVING. Liquipedia: the meld is lost if the unit "moves, attacks, uses an ability, or
   * casts a spell". The last three already reveal through breakInvisibility (the shared path
   * every invisibility uses), but movement is Shadow Meld's alone — Wind Walk's entire point
   * is that you keep it while you walk. Tested on actual displacement rather than on the
   * order, because an order is an intent: a melded Archer shoved by a collision resolve, or
   * carried along by a settle() snap, has moved whether she meant to or not. `moving` alone
   * would also miss the frame a push happens outside any order.
   *
   * DAY. `[Ashm]` is night-only for units (Liquipedia: "usually disabled during the day"),
   * so dawn ends a meld already in force — it is not merely a bar on casting it.
   *
   * The two columns this does NOT spend are DataB "Day/Night Duration" (2.5) and DataC
   * "Action Duration" (0.5). Their names are from AbilityMetaData/WorldEditStrings, but no
   * source says what either measures — a grace period at dawn, a re-meld lockout after
   * acting, something else. Per CLAUDE.md the number gets implemented when its MEANING is
   * known, not guessed at from its size, so dawn is sharp and re-melding is immediate until
   * somebody measures the real client. DataA "Fade Duration" (1.5) is spent, as the buff's
   * `delay` — Liquipedia names that one outright.
   */
  private tickMeld(u: SimUnit): void {
    if (!u.buffs.some((b) => b.kind === "invisible" && b.meld)) return;
    const moved = u.x !== u.prevX || u.y !== u.prevY;
    if (moved || this.isDay) this.breakInvisibility(u);
  }

  private breakInvisibility(u: SimUnit): number {
    if (!u.cloaked) return 0;
    let bonus = 0;
    const groups = new Set<string>();
    for (const b of u.buffs) {
      if (b.kind !== "invisible") continue;
      bonus = Math.max(bonus, b.value); // Backstab Damage (AOwk DataC: 40/70/100)
      if (b.group) groups.add(b.group);
    }
    u.buffs = u.buffs.filter((b) => b.kind !== "invisible" && !(b.group && groups.has(b.group)));
    this.recomputeStats(u);
    return bonus;
  }

  /** Launch a homing projectile from attacker to target. Damage is rolled now
   *  and applied when it lands (armor is applied at impact). */
  private spawnProjectile(u: SimUnit, t: SimUnit, w: SimWeapon, bonus = 0): void {
    const id = this.nextProjectileId++;
    // The orb this shot carries is decided — and paid for — HERE, at the loosing, because
    // the orb owns the missile: every member of the family carries its own `Missileart`
    // (Searing Arrows' fire arrow, Orb of Frost's LichMissile, the Mask of Death's
    // NeutralizationMissile), which is the community's own test for what counts as an orb.
    const orb = this.resolveOrb(u, t);
    // Launch from the weapon's model point (local offset rotated by facing), not the
    // unit's feet — e.g. the Archmage's fireball leaves from launchz=66 (his rod).
    const [lx, ly, lz0] = launchPoint(u, w.launchX, w.launchY, w.launchZ);
    // Height off the ground: the weapon's local launch offset PLUS the shooter's
    // flight altitude, so a flyer's missile leaves from the model (not the terrain
    // beneath it). Likewise the missile aims at the target's altitude on impact —
    // a shot at an air unit lands at its height, not on the ground below it.
    const lz = lz0 + u.flyHeight;
    const impactBase = w.impactZ > 0 ? w.impactZ : lz0;
    const proj: SimProjectile = {
      id,
      x: lx,
      y: ly,
      z: lz,
      sourceId: u.id,
      targetId: t.id,
      speed: w.missileSpeed > 0 ? w.missileSpeed : 900,
      damage: this.rollDamage(w) + bonus, // + Backstab Damage if this shot broke a fade
      art: this.orbMissileArt(orb) || w.missileArt,
      attackType: w.attackType,
      weaponSound: w.weaponSound,
      orb: orb ?? undefined,
      startZ: lz,
      impactZ: impactBase + t.flyHeight,
      startDist: Math.hypot(t.x - lx, t.y - ly),
      spill: w.spillDist > 0 && w.spillRadius > 0
        ? { dist: w.spillDist, radius: w.spillRadius, loss: w.damageLoss, ox: lx, oy: ly }
        : undefined,
      // An ARTILLERY slot throws its shell at the ground the target is standing on RIGHT NOW
      // and forgets about the target (see SimProjectile.area). Keyed on the weapon type the
      // data states rather than on "has an area", because those are two different claims and
      // only `weapTp` is the one the engine sorts missiles by: the Cannon Tower's slot 1 is
      // `artillery` with 50/100/125 rings, its slot 2 is a plain homing `missile` at buildings.
      area: w.weaponType === WeaponType.Artillery || w.weaponType === WeaponType.ArtilleryLine
        ? {
            aimX: t.x, aimY: t.y,
            full: w.areaFull, half: w.areaHalf, quarter: w.areaQuarter,
            halfFactor: w.areaHalfFactor, quarterFactor: w.areaQuarterFactor,
            targets: w.splashTargets,
          }
        : undefined,
    };
    this.projectiles.set(id, proj);
    this.spawnedProjectiles.push({ id, art: proj.art, x: proj.x, y: proj.y, z: proj.z });
  }

  /** Carry a line weapon's hit PAST its target (issue #57). The "spill" fields on a Missile
   *  (Line) / Artillery (Line) weapon describe a corridor that starts at the unit struck and
   *  runs on along the missile's heading for `spillDist`, catching anything within
   *  `spillRadius` of it — thehelper's "the damage will continue beyond the unit you hit".
   *  Both stock users of it are pure upgrades: the Gryphon Rider's hammer and the Glaive
   *  Thrower's bolt already ship the 50-unit radius and the 0.2 falloff and a spill DISTANCE
   *  of 0, so they hit exactly one unit until Storm Hammers / Impaling Bolt (`rasd` = 200)
   *  opens the corridor.
   *
   *  The magnitudes are all data (spillDist1/spillRadius1/damageLoss1). The FALLOFF CURVE is
   *  the one thing no game file states: the Object Editor names "Damage Loss Factor" and stops
   *  there. Hive/thehelper describe it as damage shed per further body down the line, so each
   *  successive unit takes (1 - loss)× the one before — 44 → 35 → 28 for a Gryphon. */
  private applySpill(p: SimProjectile, primary: SimUnit): void {
    const s = p.spill!;
    const dx = primary.x - s.ox;
    const dy = primary.y - s.oy;
    const len = Math.hypot(dx, dy);
    if (len < 1) return; // point-blank — no line to spill along
    const ux = dx / len;
    const uy = dy / len;
    const source = this.units.get(p.sourceId);
    // Everything in the corridor behind the target, nearest first — the hammer loses its bite
    // as it goes, so the order it meets them decides how hard each is hit.
    const hits: Array<{ t: SimUnit; along: number }> = [];
    for (const t of this.units.values()) {
      if (t === primary || t.hp <= 0 || t.invulnerable) continue;
      // Enemies only: the Gryphon's own splashTargs list is "ground,structure,enemy,debris",
      // so a hammer that carries through never mows down the rank of Footmen behind it.
      if (!source || !this.hostile(source, t)) continue;
      if (!this.canAttack(source, t)) continue;
      const along = (t.x - primary.x) * ux + (t.y - primary.y) * uy; // projection onto the line
      if (along <= 0 || along > s.dist) continue; // behind the target, within the spill distance
      const off = Math.abs((t.x - primary.x) * -uy + (t.y - primary.y) * ux); // perpendicular offset
      if (off > s.radius + t.radius) continue;
      hits.push({ t, along });
    }
    hits.sort((a, b) => a.along - b.along);
    let damage = p.damage;
    for (const h of hits) {
      damage *= 1 - s.loss;
      if (damage <= 0) break;
      this.applyDamage(h.t, damage, p.sourceId, p.attackType ?? AttackType.None, p.weaponSound ?? "", true);
    }
  }

  /** Advance in-flight projectiles toward their (moving) targets; deal damage on
   *  arrival, and fizzle harmlessly if the target died before impact. */
  private tickProjectiles(dt: number): void {
    for (const p of this.projectiles.values()) {
      // An artillery shell is aimed at GROUND: it keeps flying (and still lands) whether or
      // not the unit it was thrown at is alive, or still there. See SimProjectile.area.
      if (p.area) {
        this.tickAreaProjectile(p, dt);
        continue;
      }
      // A wave sweeps a line and hits what it passes; it has no target to home on.
      if (p.wave) {
        this.tickWaveProjectile(p, dt);
        continue;
      }
      const t = this.units.get(p.targetId);
      if (!t) {
        this.removeProjectile(p.id);
        continue;
      }
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      const dist = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (dist <= step + t.radius) {
        this.projectileImpacts.push({ id: p.id, x: t.x, y: t.y, z: p.impactZ }); // record the hit point
        if (p.spell) {
          // Spell missile (Storm Bolt/Death Coil): run the ability effect on impact.
          // Resolve the exact ability by id (several abilities share a base code).
          const caster = this.units.get(p.sourceId) ?? t; // caster may have died mid-flight
          const def = this.abilities?.get(p.spell.abilityId);
          this.applySpellEffect(p.spell.code, p.spell.rank, caster, { targetId: t.id, x: t.x, y: t.y }, def);
        } else {
          // Orb of Corruption strips armour BEFORE the blow it rode in on (Liquipedia,
          // Orb of Corruption: "the armor reduction happens before the damage of the hero is
          // dealt"), so the debuff half of an orb goes on first and the rest after.
          this.applyOrbArmorFirst(this.units.get(p.sourceId), t, p.orb);
          const dealt = this.applyDamage(t, p.damage, p.sourceId, p.attackType ?? AttackType.None, p.weaponSound ?? "", true);
          this.applyOrbEffect(this.units.get(p.sourceId), t, p.orb, dealt); // the orb this arrow carried
          this.applyLiquidFire(this.units.get(p.sourceId), t); // Batrider: burn a struck building
          const shooter = this.units.get(p.sourceId);
          if (shooter) this.applyPillage(shooter, t, dealt); // ranged Pillage (Raider) off a struck building
          if (p.spill) this.applySpill(p, t); // Storm Hammers / Impaling Bolt carry on down the line
        }
        this.removeProjectile(p.id);
      } else {
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
        // Straight-line 3D flight: height lerps launch→impact by horizontal progress.
        const prog = p.startDist > 1 ? Math.max(0, Math.min(1, (p.startDist - dist) / p.startDist)) : 1;
        p.z = p.startZ + (p.impactZ - p.startZ) * prog;
      }
    }
  }

  /** Fly an ARTILLERY shell to the spot it was thrown at and burst there. Same straight-line
   *  flight as a homing missile, but the destination is a fixed point rather than a unit, so
   *  the target can simply walk out from under it. */
  private tickAreaProjectile(p: SimProjectile, dt: number): void {
    const a = p.area!;
    const dx = a.aimX - p.x;
    const dy = a.aimY - p.y;
    const dist = Math.hypot(dx, dy);
    const step = p.speed * dt;
    if (dist > step) {
      p.x += (dx / dist) * step;
      p.y += (dy / dist) * step;
      const prog = p.startDist > 1 ? Math.max(0, Math.min(1, (p.startDist - dist) / p.startDist)) : 1;
      p.z = p.startZ + (p.impactZ - p.startZ) * prog;
      return;
    }
    p.x = a.aimX;
    p.y = a.aimY;
    this.projectileImpacts.push({ id: p.id, x: a.aimX, y: a.aimY, z: p.impactZ });
    this.applyAreaSplash(p);
    this.removeProjectile(p.id);
  }

  /**
   * The burst: full damage inside `Farea`, half out to `Harea`, a quarter out to `Qarea`
   * (the three "Area of Effect (Full/Medium/Small Damage)" rings the SLK carries per weapon
   * slot). Distance is measured to the unit's HULL, as every other range in the sim is, so a
   * big building standing at the edge is still caught by the ring its edge is in.
   *
   * Who it may catch is `splashTargs` — a list distinct from `targs`, and pointedly narrower:
   * the Cannon Tower may AIM at `ground,debris,tree,wall,ward,item` but its burst is
   * `ground,structure,debris,tree,wall,notself`, which is how a shell aimed at a footman also
   * knocks the wall behind him down. Restricted to hostiles on top of that, which is the same
   * call applySpill already makes and for the same reason: the one splash list in the data
   * that names an allegiance at all (the Gryphon's `enemy`) names that one.
   */
  private applyAreaSplash(p: SimProjectile): void {
    const a = p.area!;
    const source = this.units.get(p.sourceId);
    const outer = Math.max(a.quarter, a.half, a.full);
    if (outer <= 0) return; // an artillery row with no rings — nothing to burst
    let nearest: SimUnit | undefined; // for an `aline` shot, whoever the line starts at
    for (const t of this.units.values()) {
      if (t.hp <= 0 || t.invulnerable) continue;
      if (t.id === p.sourceId) continue; // `notself`
      if (!source || !this.hostile(source, t)) continue;
      if (a.targets.length && !a.targets.includes(targetKeyOf(t))) continue;
      const gap = Math.hypot(t.x - a.aimX, t.y - a.aimY) - t.radius;
      // The outer rings' shares are the SLOT's own — a Mortar Team's "half" ring is 0.4 and
      // its "quarter" ring 0.1. Only a row that states neither takes the names literally.
      const frac = gap <= a.full ? 1 : gap <= a.half ? a.halfFactor : gap <= a.quarter ? a.quarterFactor : 0;
      if (frac <= 0) continue;
      const dealt = this.applyDamage(t, p.damage * frac, p.sourceId, p.attackType ?? AttackType.None, p.weaponSound ?? "", true);
      if (source) this.applyPillage(source, t, dealt); // a Demolisher with Pillage loots what it shells
      if (frac === 1 && !nearest) nearest = t;
    }
    // Artillery (Line) — the Glaive Thrower — is BOTH: it bursts, and with Impaling Bolt
    // researched the bolt carries on down the line from whoever it hit (see applySpill).
    if (p.spill && nearest) this.applySpill(p, nearest);
  }

  private removeProjectile(id: number): void {
    if (this.projectiles.delete(id)) this.removedProjectiles.push(id);
  }

  // Path toward the target; repath only when the target strays from the path
  // goal (A* every tick would be wasteful and jittery), and not while cooling
  // down after being blocked by units we may not push.
  private chase(u: SimUnit, t: SimUnit): void {
    this.chasePoint(u, t.x, t.y);
  }

  /** Head for a target to ATTACK it, aiming at this unit's assigned formation slot
   *  around the target (see assignAttackSlot) rather than its exact centre — so a
   *  group swarming one enemy fans out around it and holds a surround, instead of
   *  lining up behind each other and shoving. The slot is a relative offset, so it
   *  tracks a moving target. A lone attacker (no slot) heads straight in. */
  private chaseToAttack(u: SimUnit, t: SimUnit): void {
    // The slot is a PREFERENCE, not a requirement. It can turn out to be unreachable —
    // walled off by the ring of allies already fighting, or on a tile this unit no longer
    // fits — and then the chase simply fails and the unit stands there with a target it
    // never walks at. So fall back to the enemy itself: join the fight and let
    // settleSpread find the tile once we are there. tickAttack has a whole stall watchdog
    // that eventually rescues this; attack-move calls engage() directly and has none, which
    // is how an attack-moved squad ended up with members frozen mid-field, in range of
    // nothing, staring at a grunt 250 units away (issue #108).
    if (u.atkOffTarget === t.id && (u.atkOffX !== 0 || u.atkOffY !== 0)) {
      if (this.chasePoint(u, t.x + u.atkOffX, t.y + u.atkOffY)) return;
    } else {
      this.chasePoint(u, t.x, t.y);
      return;
    }
    // The slot was unreachable. Only walk at the enemy itself if we can genuinely GET to
    // it — a best-effort path exists toward anything, so an unconditional fallback would
    // march a unit ordered at a walled-off enemy into the wall and then shuffle it along
    // that wall forever, which the give-up watchdog reads as headway and so never fires.
    if (this.canReachToAttack(u, t)) this.chasePoint(u, t.x, t.y);
  }

  /** Follow a leader: trail it at FOLLOW_GAP, parking when close and re-approaching
   *  when it moves off. If the leader dies/vanishes, stop where we stand. A group
   *  told to follow one unit carries a formation offset (followOff*) so each holds a
   *  distinct slot around the leader instead of stacking on its centre and shoving.
   *  Once caught up, a follower GUARDS its leader — it strikes an enemy that comes
   *  within its own acquisition range, then returns to trailing when the fight ends
   *  (issue #32). While still marching up it never peels off, so it doesn't wander. */
  private tickFollow(u: SimUnit, dt: number): void {
    const t = u.targetId !== null ? this.units.get(u.targetId) : undefined;
    if (!t) {
      this.stop(u.id);
      return;
    }
    // The point we trail: our formation slot (leader centre + offset) when fanned,
    // else the leader itself at FOLLOW_GAP. `d` is the distance to it (hull gap in the
    // lone case). Hysteresis: while parked, tolerate the leader drifting out by
    // FOLLOW_LEASH before re-chasing, so small leader movement (or the settle snap)
    // doesn't oscillate the walk↔stand clip — the follow-animation "jiggle".
    const slotted = u.followOffX !== 0 || u.followOffY !== 0;
    const ax = slotted ? t.x + u.followOffX : t.x;
    const ay = slotted ? t.y + u.followOffY : t.y;
    const d = slotted
      ? Math.hypot(ax - u.x, ay - u.y)
      : Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    const arrive = slotted
      ? u.moving
        ? FOLLOW_SLOT_ARRIVE
        : FOLLOW_SLOT_ARRIVE + FOLLOW_LEASH
      : u.moving
        ? FOLLOW_GAP
        : FOLLOW_GAP + FOLLOW_LEASH;
    const caughtUp = d <= arrive;
    // Guard the leader: once caught up, peel off to strike the nearest enemy within
    // our OWN acquisition range (a follower still marching up keeps moving instead of
    // wandering off). issueAttack switches us to the attack order and arms the resume;
    // when that fight ends with nothing left in range, reacquireOrStop returns us here.
    const acq = u.isCreep ? 0 : this.acquireRange(u);
    if (caughtUp && acq > 0) {
      u.acquireT -= dt; // throttle the O(units) scan (same period as idle auto-acquire)
      if (u.acquireT <= 0) {
        u.acquireT = ACQUIRE_PERIOD;
        const enemy = this.acquireTarget(u, acq);
        if (enemy) {
          const leaderId = u.targetId; // save: issueAttack overwrites targetId with the enemy
          if (this.issueAttack(u.id, enemy.id)) u.followLeaderId = leaderId; // resume-to-follow
          return;
        }
      }
    }
    if (!caughtUp) {
      if (slotted) this.chasePoint(u, ax, ay);
      else this.chase(u, t); // approach (chasePoint repaths as the leader strays)
    } else {
      if (u.moving) this.settle(u); // caught up — hold position near the leader
      u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x); // face the leader while parked
    }
  }

  /** False when no route toward the point could be laid at all — the caller then still has
   *  a standing unit on its hands and must do something else with it. Already-heading-there
   *  and committed-to-a-hold both count as success: nothing is wrong in either case. */
  private chasePoint(u: SimUnit, x: number, y: number): boolean {
    if (u.repathT > 0) return true;
    if (u.moving && Math.hypot(x - u.chaseX, y - u.chaseY) < CHASE_REPATH) return true;
    // Chasing (an attack target or a follow leader) is LOCAL — the thing is within
    // acquisition/leader range, a couple of dozen cells off. Cap the search low so a
    // blocked/unreachable chase gives up after a small local flood instead of the full
    // 8192-cell map flood (issue #24 perf: 100 melee all probing paths to one crowded
    // target flooded the frame to ~20fps). A best-effort short path is fine here —
    // chasePoint re-runs as the target moves anyway.
    return this.pathTo(u, x, y, COMBAT_EXPANSIONS);
  }

  // --- resource gathering ---------------------------------------------------

  /**
   * Fill a gatherer's rates from its own HARVEST ABILITY, so no harvesting number is written
   * out anywhere in the codebase (CLAUDE.md: never re-type a value the game data carries).
   *
   * Units\UnitAbilities.slk hands each worker the ability by name — Peasant and Peon `Ahar`,
   * Ghoul `Ahrl`, Wisp `Awha`, Acolyte `Aaha` — and AbilityData.slk's row is the rate card:
   * DataA lumber per interval, DataB the load it fills before hauling, DataC the gold a trip
   * is worth, and `Dur1` the interval itself. A Peasant chops every **1.1** seconds and a
   * Ghoul every **1.35**, not the round 1 and 1.1 that had been typed in by hand.
   *
   * Every field is left alone when its column is blank, which is what keeps one reader honest
   * across four rows that fill in different subsets: `Aaha` carries no rate at all (an Acolyte
   * only mines), and `Awha` no capacity (a Wisp has no trip to fill — see `deliversInPlace`).
   */
  private applyHarvestData(w: WorkerState): void {
    const lvl = w.harvestAbility ? this.abilities?.get(w.harvestAbility)?.levelData[0] : undefined;
    if (!lvl) return; // no registry mounted (headless tests) — the profile's own fallbacks stand
    if (lvl.duration > 0) w.chopPeriod = lvl.duration;
    const perChop = this.dataOf(lvl, 0, 0);
    if (perChop > 0) w.lumberPerChop = perChop;
    // A Wisp's load is the one column that means nothing: it never carries anything anywhere.
    const capacity = this.dataOf(lvl, 1, 0);
    if (capacity > 0 && !w.deliversInPlace) {
      w.lumberCapacity = capacity;
      w.baseLumberCapacity = capacity;
    }
    const gold = this.dataOf(lvl, 2, 0);
    if (gold > 0) w.goldPerTrip = gold;
  }

  /**
   * A worker has ONE pair of hands, and taking up a load drops whatever else was in them.
   *
   * A Peasant sent to the mine with four lumber still on its back comes out with ten gold and
   * no lumber; a Peon pulled off the mine and put on trees loses the gold on its first chop.
   * The old sack kept both at once, so that lumber was banked later on a trip it never made —
   * the worker delivered gold AND lumber at the hall from one visit to one node.
   *
   * The drop happens where the new load is PICKED UP, not when the order is given, because
   * that is where the game shows it: the walk to the mine is still played with the lumber
   * carry clip, exactly as it is in WC3, and the switch happens out of sight inside the shaft.
   */
  private dropOtherLoad(w: WorkerState, taking: "gold" | "lumber"): void {
    if (taking === "gold") w.carryLumber = 0;
    else w.carryGold = 0;
  }

  private tickHarvest(u: SimUnit, dt: number): void {
    const w = u.worker;
    if (!w) {
      this.stop(u.id);
      return;
    }
    // Inside the mine: wait out the mining time, then emerge with the load.
    if (u.inMine) {
      u.workT -= dt;
      if (u.workT <= 0) {
        u.inMine = false;
        // The mine it is IN, not the one its order names — see `inMineId`.
        const mine = this.mines.get(u.inMineId ?? u.resId);
        u.inMineId = undefined;
        if (mine) {
          mine.busy = false;
          this.dropOtherLoad(w, "gold"); // it walked in with lumber; it walks out with gold
          w.carryGold = Math.min(w.goldPerTrip || GOLD_PER_TRIP, mine.gold);
          mine.gold -= w.carryGold;
          if (mine.gold <= 0) {
            this.mines.delete(mine.id);
            this.depleted.push(mine);
            // "A gold mine has collapsed." — told to whoever was working it, since they are
            // the one who has to go and find another (Goldminedestroyed + GoldMineCollapseSound).
            this.alerts.push({ kind: "minedestroyed", player: u.owner, x: mine.x, y: mine.y });
          } else if (mine.gold < MISC_DATA.LowGoldAmount && !this.minesRunningLow.has(mine.id)) {
            // MiscData names the line itself: "this is the amount where a gold mine is
            // considered low" (LowGoldAmount=1500). Warned on the trip that crosses it, once.
            this.minesRunningLow.add(mine.id);
            this.alerts.push({ kind: "minelow", player: u.owner, x: mine.x, y: mine.y });
          }
          // Emerge on the side facing the town hall — the worker was invisible
          // inside, so re-placing it here is seamless and makes it ALWAYS exit
          // toward the drop-off (forming the mine→hall line) whatever side it
          // entered from. `mine` is still a valid object even if just depleted.
          [u.x, u.y] = this.mineApproach(u, mine);
        }
        // Emerging from the mine with gold: ghost through other units for the
        // whole auto back-and-forth (WC3), until the player takes manual control.
        u.noCollision = true;
        this.startReturn(u);
      }
      return;
    }
    // Carrying a full load already (e.g. re-ordered mid-return): go deposit.
    if (w.carryGold > 0 || (w.lumberCapacity > 0 && w.carryLumber >= w.lumberCapacity)) {
      this.startReturn(u);
      return;
    }

    if (u.resKind === "gold") {
      const mine = this.mines.get(u.resId);
      if (!mine) {
        this.stop(u.id);
        return;
      }
      // A HAUNTED mine is worked from outside: take a station in its ring and stay there.
      // There is no shaft, no load and no walk home — the gold is credited off the building's
      // own clock (tickMineCrews) for as long as anyone is kneeling.
      const haunt = this.hauntedMine(mine.id);
      if (haunt) {
        this.tickRingHarvest(u, haunt);
        return;
      }
      // Walk up to the mine and duck inside from WHATEVER side we reached — the reach
      // is the stand-off a worker's own cell block needs beside the footprint (see
      // mineStandDist), plus a cell of slack for whoever had to shuffle a tile over.
      // (It re-emerges on the hall-facing side; see the emerge branch above.)
      if (!this.arriveAtNode(u, mine.x, mine.y, this.mineStandDist(u, mine) + PATHING_CELL, () => this.pathToNode(u))) return;
      if (mine.busy) return; // parked at the entrance, waiting our turn (no re-path)
      mine.busy = true;
      u.inMine = true;
      u.inMineId = mine.id;
      u.workT = MINE_TIME;
      u.atNode = false;
      this.unsettle(u); // don't block cells while invisible inside
      u.moving = false;
      u.path = [];
      return;
    }

    // Lumber.
    let tree = this.trees.get(u.resId) ?? null;
    if (!tree) {
      // Our tree is gone (chopped out from under us, burned, eaten). Take the next one —
      // for a wisp, the next FREE one: one wisp to a tree (treeWorkedBy).
      tree = w.deliversInPlace ? this.freeTreeNear(u, u.x, u.y, RETARGET_RANGE) : this.nearestTree(u.x, u.y, RETARGET_RANGE);
      if (!tree) {
        // No tree left to chop: haul the partial load home (startReturn clears the
        // working flag and paths to the depot), or idle if empty-handed.
        if (w.carryLumber > 0) this.startReturn(u);
        else this.stop(u.id);
        return;
      }
      u.resId = tree.id;
      u.atNode = false;
      u.working = false;
      this.pathTo(u, tree.x, tree.y); // walk to the freshly-picked tree
    }
    // Approach until parked next to the tree, then chop in place (never re-path
    // once working — that was the source of the mining "jiggle").
    // A wisp is measured against the tree's BLOCKED footprint rather than against an axe's
    // arm: it cannot stand where a chopper does, because it never enters the blocked cells at
    // all — it stops against them. Measured the chopper's way, a wisp arrives, is judged out
    // of reach, re-targets the nearest tree, is out of reach again — and drifts across the
    // forest one tree at a time instead of working the one it was sent to.
    const reach = w.deliversInPlace
      ? tree.blockRadius + u.radius + 40
      : u.radius + TREE_RADIUS + 40;
    if (!this.arriveAtNode(u, tree.x, tree.y, reach)) {
      u.working = false;
      return;
    }
    // Arrived — but is the seat still free? One wisp to a tree (treeWorkedBy): the order-time
    // check cannot see a wisp that took this trunk while we were flying to it, and two wisps
    // sent at the same free tree in the same breath both set out for it. So the claim is made
    // HERE, at the trunk, against whoever is already WORKING it — the wisp in the tree keeps
    // it and the one arriving moves on to the nearest free one, rather than the two of them
    // sharing a trunk and paying double. (Ticking is in map order, so the pair that arrive on
    // the same tick resolve the same way on every machine.)
    if (w.deliversInPlace && !u.working && this.treeWorkedBy(tree.id, u.id, true)) {
      const free = this.freeTreeNear(u, u.x, u.y, RETARGET_RANGE);
      if (free && free.id !== tree.id) {
        u.resId = free.id;
        u.atNode = false;
        this.pathToNode(u);
        return;
      }
    }
    // A Wisp does not stand beside the tree with an axe: it goes INTO it and holds still.
    // Freeing its cell is what lets it — the tree's own cells are blocked, so nothing that
    // reserves ground could be there at all — and it is honest twice over, since a body parked
    // against the treeline would wall off the forest one wisp at a time. (`noCollision` is the
    // same ghosting a laden worker gets on its auto round trip.)
    if (w.deliversInPlace) {
      this.unsettle(u);
      u.noCollision = true;
    }
    // Parked. If the clicked tree is out of reach (walled in / deep in the
    // forest), harvest the nearest tree to where the worker actually stopped —
    // WC3 gathers from the closest ACCESSIBLE tree to the one you clicked. Asked ONCE, on
    // the tick it parks: this is a fix-up for the approach, not a standing re-evaluation.
    if (!u.working && Math.hypot(tree.x - u.x, tree.y - u.y) > reach) {
      // …and for a wisp the substitute has to be a FREE tree, or the fix-up for one problem
      // (the tree it was sent to is walled off) would hand it straight into the other (a
      // trunk another wisp is already inside).
      const near = w.deliversInPlace ? this.freeTreeNear(u, u.x, u.y, reach + 48) : this.nearestTree(u.x, u.y, reach + 48);
      if (near && near.id !== tree.id) {
        tree = near;
        u.resId = near.id;
      }
    }
    // A wisp is paid for the interval it WORKS, not for arriving. `Awha`'s `Dur1` = 8s is a
    // wage for eight seconds of work, and a clock left at zero handed it out the instant the
    // wisp slipped into the trunk — so a wisp flitting from tree to tree earned 5 lumber per
    // LANDING, and the first tree of the game paid before the harvest loop had even started.
    // Started here, on the tick it latches on, so the first 5 land 8 seconds later. (`atNode`
    // is latched by then, so the clock is not restarted by a wisp merely sitting there.)
    //
    // A chopper's clock is the SWING CYCLE, and it starts here too — on the tick it parks,
    // with the first axe going up at once (`chopSeq`). What that swing cuts arrives partway
    // through it rather than with it; see the damage point below.
    if (!u.working) {
      u.workT = w.chopPeriod;
      if (!w.deliversInPlace) u.chopSeq++; // the first swing goes up now; its wood lands later
    }
    u.working = true;
    // …and a Wisp works from INSIDE the tree, not from a spot in front of it: it takes the
    // trunk's own position and hangs there. Everything that would ordinarily forbid standing
    // on a tree's blocked cells has already been given up two blocks above — it holds no
    // reservation and collides with nothing — and `popFromCanopy` is what walks it back onto
    // ground A* can start from the moment it is told to do anything else.
    if (w.deliversInPlace) {
      if (u.x !== tree.x || u.y !== tree.y) {
        u.desiredFacing = Math.atan2(tree.y - u.y, tree.x - u.x); // the heading it slipped in on
        u.x = tree.x;
        u.y = tree.y;
      }
    } else {
      u.desiredFacing = Math.atan2(tree.y - u.y, tree.x - u.x);
    }
    // WHERE IN THE SWING THE WOOD LANDS is the weapon's own DAMAGE POINT — the same `dmgpt1`
    // that decides when a blow deals its damage (Peasant 0.433, Ghoul 0.39), read through the
    // same `SimWeapon.damagePoint` an attack uses, hasted and all. A chop IS an attack: the
    // clip is "Attack Lumber" and the axe connects a third of the way through it, not at the
    // end. Crediting at the END of the cycle put the wood, the chop sound and the trunk's
    // wobble on the tick the NEXT axe went up — a full `Dur1` after the blow that cut it, so
    // the tree shook while the arm was already swinging again. The cycle is `chopPeriod` long
    // and the blow lands `damagePoint` into it, which is what both columns have said all along.
    //
    // Read as a CROSSING rather than latched on a flag, so nothing has to be carried between
    // ticks: `landAt` is the `workT` value the axe connects at, and exactly one tick per cycle
    // straddles it.
    //
    // No weapon, no swing: a Wisp (`Awha` gives it none) and any map's own weaponless builder
    // fall back to the whole period, which puts `landAt` at 0 and credits them at the interval
    // END — which for the Wisp is not a fallback at all but its actual rule, a wage for eight
    // seconds of work (see the clock's start above).
    const dmgPoint = Math.min(u.weapon?.damagePoint || w.chopPeriod, w.chopPeriod);
    const landAt = w.chopPeriod - dmgPoint;
    const before = u.workT;
    u.workT -= dt;
    const landed = before >= landAt && u.workT < landAt;
    if (u.workT <= 0) {
      u.workT = w.chopPeriod;
      if (!w.deliversInPlace) u.chopSeq++; // the cycle rolled over — the next axe goes up
    }
    if (!landed) return;
    // The load, and how it gets home. Everyone else fills a sack and walks it to a depot;
    // the Wisp has no sack and no walk — Wisp Harvest (`Awha`) pays straight into the stash
    // every interval, for as long as it is left alone in the tree. That is why night elf
    // lumber has no round trip to optimise and why a wisp on a tree is worth what it is.
    if (w.deliversInPlace) {
      this.stashOf(u.owner).lumber += w.lumberPerChop;
      // The credit floats on the TREE, because for a Wisp the tree is the whole delivery
      // (see docs/night-elf.md) — there is no hall for it to arrive at later.
      this.floatCredit("lumber", w.lumberPerChop, u.owner, tree);
      // `Awha` Targetart, attached at `origin` — the green glow that says the tree is
      // being worked. It stands in for the axe SFX every other worker's chop plays: there
      // is no axe here (NightElfAbilityFunc [Awha] has an Effectsoundlooped, not a hit).
      if (this.harvestArt) this.spellEffects.push({ art: this.harvestArt, x: tree.x, y: tree.y, targetId: 0, z: 0 });
      return;
    }
    // The axe has just CONNECTED: the sound, the wood and the trunk's wobble all belong to
    // this instant, which is `damagePoint` into the swing the renderer is already playing.
    this.chops.push(u.id); // axe landed → renderer plays the chop SFX
    this.dropOtherLoad(w, "lumber"); // the first chip of wood costs it the gold in its hands
    w.carryLumber = Math.min(w.lumberCapacity, w.carryLumber + w.lumberPerChop);
    if (w.damagesTree) {
      tree.lumber -= w.lumberPerChop;
      if (tree.lumber <= 0) {
        this.trees.delete(tree.id);
        this.felled.push(tree); // renderer plays "death" + leaves the stump
        // The tree we were chopping just fell. If we aren't full yet, walk to the
        // nearest remaining tree straight away and keep gathering (no idle frame).
        if (w.carryLumber < w.lumberCapacity) {
          const next = this.nearestTree(u.x, u.y, RETARGET_RANGE);
          if (next) {
            u.resId = next.id;
            u.atNode = false;
            u.working = false;
            this.pathTo(u, next.x, next.y);
            return;
          }
        }
      } else {
        this.treeHits.push({ x: tree.x, y: tree.y }); // still standing → "stand hit" wobble
      }
    }
    if (w.carryLumber >= w.lumberCapacity) {
      this.startReturn(u);
    }
  }

  /** `Awha`'s Targetart — `Abilities\Spells\NightElf\TargetArtLumber\TargetArtLumber.mdl`,
   *  attached at the tree's origin. Read off the ability row rather than written out, so a
   *  map that reskins Wisp Harvest reskins this too. */
  private get harvestArt(): string {
    return this.abilities?.get("Awha")?.targetArt ?? "";
  }

  /** Latch a worker as "parked at the node". The approach path was issued once
   *  at order time (pathToNode), so here we only need to wait for arrival: still
   *  moving → keep walking; within `reach` or arrived (best-effort path ended)
   *  → park in place (no snap, no re-path — this is what killed the jitter).
   *
   *  `repath` re-issues the approach when the worker came to rest SHORT of the node.
   *  Without it, "stopped" alone counted as "arrived", so a worker whose path failed
   *  banked its load — or ducked into the mine — from wherever it happened to stand:
   *  the frozen-worker-with-rising-gold of issue #89. Bounded by `nodeRetries`, so a
   *  genuinely boxed-in gatherer still parks and works its node instead of standing
   *  idle or re-flooding A* every tick. The budget resets on every latch, so each
   *  round trip gets a fresh pair of attempts. */
  private arriveAtNode(u: SimUnit, x: number, y: number, reach: number, repath?: () => void): boolean {
    if (u.atNode) return true;
    const short = Math.hypot(x - u.x, y - u.y) > reach;
    if (u.moving && short) return false;
    if (short && repath && u.nodeRetries < NODE_REPATH_TRIES) {
      u.nodeRetries++;
      repath();
      if (u.moving) return false; // walking again — not there yet
    }
    this.settle(u, false);
    u.atNode = true;
    u.nodeRetries = 0;
    return true;
  }

  private tickReturn(u: SimUnit): void {
    const w = u.worker;
    if (!w || (w.carryGold <= 0 && w.carryLumber <= 0)) {
      if (w && u.resKind) u.order = "harvest";
      else this.stop(u.id);
      return;
    }
    const depot = this.nearestDepot(u);
    if (!depot) {
      this.stop(u.id); // nowhere to drop off (hall destroyed) — idle
      return;
    }
    // Deposit once we've reached the depot's near edge: within range, or parked
    // as close as the pathfinder can get us (its footprint blocks the last
    // stretch). Approaching the near side keeps workers from all funnelling to
    // one back corner, and the arrive-then-deposit contract stops them circling
    // a town hall they can't quite touch.
    const [ax, ay] = this.depotApproach(u, depot);
    if (!this.arriveAtNode(u, ax, ay, u.radius + DEPOSIT_RANGE, () => this.pathTo(u, ax, ay))) return;
    const stash = this.stashOf(u.owner);
    // What the load is WORTH to this owner — the carried amount for everyone, doubled for an
    // insane computer (see harvestBonus). The floats below report what was banked, because
    // what the player is told is what the player got.
    const factor = this.harvestBonus.get(u.owner) ?? 1;
    const gold = Math.floor(w.carryGold * factor);
    const lumber = Math.floor(w.carryLumber * factor);
    stash.gold += gold;
    stash.lumber += lumber;
    // The load lands where you can SEE it land (issue #116) — the credit the game's
    // `GoldText*`/`LumberText*` rows were written for in the first place.
    //
    // It is raised on the WORKER's spot rather than the depot's, and that is not cosmetic: a
    // hall is served by five of these and they arrive in a clump, so anchoring on the building
    // prints every "+10" at one pixel and three of them mash into an unreadable smear. The
    // workers stand at their own approach points around the near edge (depotApproach), so
    // anchoring on them spreads the numbers out the way the real client's do. Placed, not
    // attached: the worker turns straight back around for another load, and the number is a
    // report of what just happened here, not a label that follows him to the trees.
    this.floatCredit("gold", gold, u.owner, u);
    this.floatCredit("lumber", lumber, u.owner, u);
    w.carryGold = 0;
    w.carryLumber = 0;
    // Head back to the same node (or the nearest remaining tree), WC3-style.
    u.atNode = false;
    if (u.resKind === "gold" && this.mines.has(u.resId)) {
      u.order = "harvest";
      // Return to the SAME hall-facing edge we exited from (not the centre), so the
      // round trip is a straight mine→hall line instead of re-entering off a side.
      const mine = this.mines.get(u.resId)!;
      const [tx, ty] = this.mineApproach(u, mine);
      this.pathTo(u, tx, ty);
    } else if (u.resKind === "lumber") {
      const tree = this.trees.get(u.resId) ?? this.nearestTree(u.x, u.y, RETARGET_RANGE);
      if (tree) {
        u.resId = tree.id;
        u.order = "harvest";
        this.pathToNode(u);
      } else {
        this.stop(u.id);
      }
    } else {
      this.stop(u.id);
    }
  }

  /** Roll a weapon's pre-armor damage: base + dice×(1..sides). */
  private rollDamage(w: SimWeapon): number {
    let dmg = w.damage;
    for (let i = 0; i < w.dice; i++) dmg += 1 + Math.floor(this.rng() * w.sides);
    return dmg;
  }

  /** Land a melee strike. `w` is the slot it was swung with — a Gargoyle's ground claws and
   *  its air spit have different attack types, so the damage table must see the right one. */
  private dealDamage(attacker: SimUnit, target: SimUnit, w: SimWeapon, bonus = 0): void {
    // Critical Strike (Blademaster passive AOcr): a chance to multiply the swing.
    // `bonus` is Wind Walk's Backstab Damage on the blow that broke the fade. It is added
    // AFTER the crit multiply — the two are independent bonuses on the same swing, and
    // nothing we have says a crit doubles the backstab.
    // Bash's Damage Bonus rides this swing. Added AFTER the crit multiply, alongside the
    // backstab: it is a flat bonus on the strike, not something a crit doubles.
    const bashBonus = attacker.swingBash ? this.bashDamageBonus(attacker) : 0;
    const raw = this.applyCriticalStrike(attacker, this.rollDamage(w)) + bonus + bashBonus;
    // A melee strike is delivered and lands in the same instant, so its orb is resolved here
    // rather than at a launch — but the ordering inside the blow is the same (see above).
    const orb = this.resolveOrb(attacker, target);
    this.applyOrbArmorFirst(attacker, target, orb);
    const dealt = this.applyDamage(target, raw, attacker.id, w.attackType, w.weaponSound, w.ranged);
    // The crit's own tell: WC3 prints the blow over the victim in red with an exclamation
    // mark ("127!"), and it is the DAMAGE DEALT — what the health bar actually loses, after
    // armour — not the pre-mitigation roll. Nothing lands, nothing is printed: a swing the
    // target was invulnerable to (or that an evade ate before this) shows no number.
    if (attacker.swingCrit && dealt > 0) {
      this.combatTexts.push({ kind: "crit", unitId: target.id, x: target.x, y: target.y, text: `${Math.round(dealt)}!`, colorSlot: -1, forPlayer: -1 });
    }
    // Cleaving Attack (Pit Lord passive ANca): splash a fraction to nearby enemies.
    if (dealt > 0) this.applyCleave(attacker, target, raw);
    // Vampiric Aura: the attacker heals for a fraction of the melee damage dealt.
    if (attacker.lifesteal > 0 && dealt > 0 && attacker.hp > 0) {
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + dealt * attacker.lifesteal);
    }
    // Thorns Aura: the target returns a fraction of the damage to the attacker.
    if (target.thorns > 0 && dealt > 0) this.landDamage(attacker, dealt * target.thorns, target.id, false);
    if (dealt > 0) this.applyPulverize(attacker, target); // Tauren passive: chance for a splash
    this.applyOrbEffect(attacker, target, orb, dealt); // the one orb this swing carried
    this.applyPillage(attacker, target, dealt); // Pillage: gold off a struck enemy building
    // Bash: rolled when the swing began (see engage), spent here on the blow that landed.
    if (attacker.swingBash) this.applyBash(attacker, target);
  }

  /** Pillage (Asal): a landed attack on an enemy BUILDING gains its owner gold equal to dataA
   *  (50%) of the damage dealt. Gated on the Pillage upgrade (Ropg) — the ability sits on the
   *  unit from birth but only pays out once researched. */
  private applyPillage(attacker: SimUnit, target: SimUnit, dealt: number): void {
    if (dealt <= 0 || !target.building || !this.hostile(attacker, target)) return;
    const lvl = this.passiveLevelData(attacker, "Asal");
    if (!lvl || !this.tech || this.tech.researchLevel(attacker.owner, "Ropg") <= 0) return;
    this.stashOf(attacker.owner).gold += dealt * this.dataOf(lvl, 0, 0.5);
  }

  /** Pulverize (Tauren passive Awar): dataA% chance that a landed attack also deals dataB
   *  damage to enemies within dataC of the struck target. */
  private applyPulverize(attacker: SimUnit, target: SimUnit): void {
    const lvl = this.passiveLevelData(attacker, "Awar");
    // Pulverize is granted by the Pulverize upgrade (Rows, Awar's Requires) — the ability
    // sits on the Tauren from birth but only splashes once researched.
    if (!lvl || !this.tech || this.tech.researchLevel(attacker.owner, "Rows") <= 0) return;
    const chance = this.dataOf(lvl, 0, 25) / 100; // dataA — % chance
    if (chance <= 0 || this.rng() >= chance) return;
    const dmg = this.dataOf(lvl, 1, 60); // dataB — splash damage
    const radius = this.dataOf(lvl, 2, 250) || 250; // dataC — splash radius
    for (const t of this.unitsInAreaInternal(target.x, target.y, radius)) {
      if (t === attacker || t.building || !this.hostile(attacker, t)) continue;
      this.landDamage(t, dmg, attacker.id, false); // spell-style splash, ignores further armor
    }
  }

  /** Apply already-rolled PHYSICAL damage: reduced by the target's armor value,
   *  plays the weapon-impact SFX. Returns the HP actually removed (0 if immune). */
  /** Attack modifiers that fire on a landed hit — by standing order (autocast) or because
   *  this one shot was aimed by hand (issueArrowShot). Searing Arrows (AHfa) / Black Arrow
   *  (ANba) / Incinerate (ANia) add bonus fire damage; Cold & Frost Arrows (AHca) slow the
   *  target. Each spends the ability's per-shot mana, here, as the blow lands. */
  /** Liquid Fire (Batrider passive Aliq): a struck BUILDING burns for dataA dps over the
   *  duration, its attack rate cut by dataC, and it cannot be repaired while burning. The
   *  burn refreshes on each hit (re-applied by group), so sustained fire keeps it down. */
  private applyLiquidFire(attacker: SimUnit | undefined, target: SimUnit): void {
    if (!attacker || !target.building || target.hp <= 0) return;
    const lvl = this.passiveLevelData(attacker, "Aliq");
    if (!lvl) return;
    const dur = lvl.duration || 3;
    const buffId = lvl.buffs?.[0] ?? ""; // `BUlf` — one buff row behind both halves (Status row)
    this.applyBuffInternal(target, { kind: "dot", group: "liquidfire", timeLeft: dur, value: this.dataOf(lvl, 0, 8), sourceId: attacker.id, buffId });
    this.applyBuffInternal(target, { kind: "slow", group: "liquidfire-atk", timeLeft: dur, value: 0, value2: this.dataOf(lvl, 2, 0.8), sourceId: attacker.id, buffId });
  }

  /** Whether a building is currently burning under Liquid Fire (blocks repair). */
  private hasLiquidFire(u: SimUnit): boolean {
    return u.buffs.some((b) => b.group === "liquidfire");
  }

  // === Orb effects ==========================================================
  //
  // See src/sim/orbs.ts for what an "orb" is, which abilities are in the family, and the
  // priority ladder that decides which single one rides a blow. This half is the sim's:
  // resolving the winner at the moment the attack is DELIVERED, and running its effect at
  // the moment the blow LANDS.
  //
  // Delivered, not landed, is deliberate. A ranged orb has to be resolved at the launch
  // because the orb OWNS THE MISSILE — every member of the family carries its own
  // `Missileart` (Searing Arrows' fire arrow, Orb of Frost's LichMissile, the Mask of
  // Death's NeutralizationMissile), which is the community's own test for whether an
  // ability is an orb. That is also where the per-shot mana goes: the arrow you have
  // already loosed is paid for whether or not it connects. The chosen orb then travels on
  // the projectile so that impact runs exactly the orb the missile was drawn as.

  /** The orb one blow carries: the exact ability (art, missile, per-rank numbers) plus the
   *  inventory it came from, if any (see resolveOrb). */
  private orbOf(def: AbilityDef, rank: number): ResolvedOrb {
    return { def, rank, lvl: def.levelData[Math.min(rank, def.levelData.length) - 1] ?? emptyAbilityLevel() };
  }

  /**
   * Pick — and pay for — the orb effect this unit's blow carries, or null.
   *
   * Candidates come from two places, exactly as in WC3:
   *   • the unit's own ability list — arrows (only while autocast is on, or on the one shot
   *     that was aimed by hand) and always-on passives like Slow Poison or Feedback;
   *   • every ITEM in the inventory, whose orb abilities are taken as a SET — the Orb of
   *     Venom is `AIpb` (+5 damage) *and* `Apo2` (the poison), one orb with two halves, so
   *     they must win or lose together rather than compete with each other.
   *
   * An arrow the caster cannot pay for is not a candidate at all, which is what lets a
   * Priestess out of mana fall through to the orb in her bag instead of shooting nothing.
   */
  private resolveOrb(attacker: SimUnit, target: SimUnit): ResolvedOrb | null {
    if (!this.abilities) return null;
    // Almost every attacker in the game has no orb of any kind, and this runs on every blow.
    if (!attacker.arrowShot && !attacker.inventory.some(Boolean) && !attacker.abilities.some((a) => a.level >= 1 && isOrbCode(a.code))) return null;
    // NO ORB RIDES A FRIENDLY BLOW. An orb effect is a hostile on-hit effect to the last
    // member of the family, and the data says so wherever it says anything: Cold Arrows is
    // `air,ground,enemy,neutral`, Searing Arrows `…,enemy,neutral`, Black Arrow the same —
    // not one of them lists `friend` or `self`. The item orbs (`ground,air,ward`) name no
    // allegiance at all, so the family rule is what covers them.
    //
    // This is the gate autocast used to duck: picking an autocast TARGET already went
    // through targetAllowed (autocastWants), but a blow the player ordered by hand never
    // did, so Cold Arrows with autocast on froze a unit its own targs1 forbids. Refusing
    // here — before any candidate is collected — is also what makes the fallback right:
    // the swing goes out as an ORDINARY attack, no mana spent, no aimed shot consumed.
    if (!this.hostile(attacker, target)) return null;
    // The one blow this unit was told to enhance by hand, if it is going at the unit it was
    // aimed at (issueArrowShot). Consumed here whether or not it ends up winning: an aimed
    // shot is spent on the shot, and a second arrow is a second order.
    const aimed = attacker.arrowShot?.targetId === target.id ? attacker.arrowShot.code : "";
    if (aimed) attacker.arrowShot = null;
    const candidates: OrbCandidate<ResolvedOrb>[] = [];
    for (const ab of attacker.abilities) {
      if (ab.level < 1 || !isOrbCode(ab.code)) continue;
      const tier = abilityOrbTier(ab.code);
      if (tier === null) continue;
      // An arrow only counts while its standing order is on, or on the shot it was aimed
      // for. A passive orb is always on — but still has to clear its own upgrade gate
      // (`[Aven] Requires=Rovs`), the same test the command card and every other
      // upgrade-granted ability makes.
      if (isArrowOrb(ab.code)) {
        if (!ab.autocastOn && ab.code !== aimed) continue;
      } else if (!this.techMeets(attacker.owner, ab.id)) continue;
      const def = this.abilities.get(ab.id);
      if (!def) continue;
      // …and what this particular orb may strike is its own `targs1`, read by the same
      // predicate every cast uses: Searing Arrows lists `structure` and so fires at a
      // tower, Cold Arrows does not and so lets the same swing land bare.
      if (!this.targsAdmit(target, def.targetFlags)) continue;
      const orb = this.orbOf(def, ab.level);
      if (attacker.mana < orb.lvl.cost) continue; // can't pay for this shot — try the next orb
      candidates.push({ tier, slot: -1, payload: orb });
    }
    if (this.itemReg) {
      for (let slot = 0; slot < attacker.inventory.length; slot++) {
        const held = attacker.inventory[slot];
        const item = held ? this.itemReg.get(held.itemId) : undefined;
        if (!item) continue;
        const codes: string[] = [];
        const parts: ResolvedOrb[] = [];
        for (const abilId of item.abilities) {
          const def = this.abilities.get(abilId);
          if (!def || !isOrbCode(def.code)) continue;
          codes.push(def.code);
          parts.push(this.orbOf(def, 1));
        }
        if (!parts.length) continue;
        // The item's PRIMARY half is the one that names the effect; the rest ride with it
        // (Orb of Venom's poison, the RoC Orb of Lightning's purge).
        const primary = parts[0];
        // One orb, one verdict: an item's halves win or lose together, so the primary's
        // `targs1` decides for the set (the stock pairs carry identical flags anyway).
        // This is also where WC3's "vampiric does not drain buildings" falls out for free
        // — the Mask of Death's `AIva` is `air,ground,enemy`, with no `structure`.
        if (!this.targsAdmit(target, primary.def.targetFlags)) continue;
        primary.extra = parts.slice(1);
        candidates.push({ tier: itemOrbTier(codes), slot, payload: primary });
      }
    }
    const orb = pickOrb(candidates);
    if (orb && orb.lvl.cost > 0) attacker.mana -= orb.lvl.cost; // per-shot cost, spent on the shot
    return orb;
  }

  /** Run a resolved orb's on-hit effect. `dealt` is the damage the blow itself did (0 if it
   *  was absorbed or the target was immune) — an orb whose effect is a share of the hit
   *  needs it, and every orb needs to know the blow actually connected. */
  private applyOrbEffect(attacker: SimUnit | undefined, target: SimUnit, orb: ResolvedOrb | null | undefined, dealt: number): void {
    if (!attacker || !orb || target.hp <= 0) return;
    // A blow that did not connect carries nothing: "Missing an Attack does not trigger the
    // reduction" (Liquipedia, Orb of Corruption), and the same holds for the slow, the
    // poison and the mark. `dealt` is 0 for an evaded swing, an invulnerable target and the
    // physical immunity of an ethereal one — every way an attack fails to land.
    if (dealt <= 0) return;
    this.runOrbPart(attacker, target, orb, dealt);
    for (const part of orb.extra ?? []) this.runOrbPart(attacker, target, part, dealt);
  }

  private runOrbPart(attacker: SimUnit, target: SimUnit, orb: ResolvedOrb, dealt: number): void {
    const { def, lvl } = orb;
    const code = def.code;
    // Duration: WC3 gives heroes their own, shorter figure for almost every debuff, and an
    // orb is no exception (Orb of Frost 3s on a unit, 1s on a hero).
    const dur = target.isHero && lvl.heroDuration > 0 ? lvl.heroDuration : lvl.duration;
    switch (code) {
      // --- Flat bonus damage on the blow. Searing Arrows' whole effect, and Black Arrow's
      // and Orb of Annihilation's damage half. `DataA` is "Damage Bonus"/"Extra Damage" in
      // AbilityMetaData (Hfa1/Nba1/fak1) for all of them.
      case "AHfa":
        this.landDamage(target, this.dataOf(lvl, 0, 10), attacker.id, false);
        break;
      // --- Cold / Frost Arrows: `DataA` Extra Damage, `DataB` Movement Speed Factor,
      // `DataC` Attack Speed Factor (AbilityMetaData Hca1..Hca3). The creep row `ACcw` fills
      // only A and B, so it slows movement and not attack rate — that is what its data says.
      case "AHca": {
        const extra = this.dataOf(lvl, 0);
        if (extra > 0) this.landDamage(target, extra, attacker.id, false);
        this.applyBuffInternal(target, {
          kind: "slow", group: "coldarrow", timeLeft: dur || 4,
          value: this.dataOf(lvl, 1, 0.3), value2: this.dataOf(lvl, 2, 0.3), sourceId: attacker.id, ...this.buffArtOf(def),
        });
        break;
      }
      // --- Black Arrow / Orb of Darkness: `DataA` bonus damage, and a MARK — a unit that
      // dies carrying it rises as `UnitID1` (`ndr1`, the Dark Minion), `DataB` of them for
      // `DataC` seconds. The raise lives in kill(); this only lays the mark.
      case "ANba":
      case "ANbs": {
        const bonus = this.dataOf(lvl, 0);
        if (bonus > 0) this.landDamage(target, bonus, attacker.id, false);
        // The mark only takes on something that could leave a body to raise: `targs1` is
        // `air,ground,enemy,organic,neutral` — no `structure` — and a hero or a summon
        // leaves no corpse to make a skeleton of. The bonus damage above lands regardless.
        if (target.hp > 0 && lvl.summon && !target.building && !target.isHero && !target.isSummon) {
          target.blackArrow = { abilityId: def.id, rank: orb.rank, sourceId: attacker.id, owner: attacker.owner, team: attacker.team };
          this.applyBuffInternal(target, { kind: "mark", group: "blackarrow", timeLeft: dur || 2, sourceId: attacker.id, ...this.buffArtOf(def) });
        }
        break;
      }
      // --- Incinerate: "<DataA> damage on the first attack, twice as much on the second,
      // three times as much on the third, etc." — the ability's own Ubertip. The stack count
      // rides the buff (`value2`), and a unit that dies still burning explodes for up to
      // `DataB` in `DataE` (see kill()).
      case "ANia":
      case "ANic": {
        const step = this.dataOf(lvl, 0, 2);
        const worn = target.buffs.find((b) => b.group === "incinerate");
        const stacks = (worn ? worn.value2 : 0) + 1;
        this.landDamage(target, step * stacks, attacker.id, false);
        if (target.hp > 0) {
          this.applyBuffInternal(target, {
            kind: "mark", group: "incinerate", timeLeft: dur || 4, value: 0, value2: stacks,
            sourceId: attacker.id, ...this.buffArtOf(def),
          });
          target.incinerate = { abilityId: def.id, rank: orb.rank, sourceId: attacker.id };
        }
        break;
      }
      // --- Orb of Annihilation (Destroyer): `DataA` bonus damage on the target plus a
      // falloff splash — `fak2`/`fak3` are the Medium and Small Damage Factors, `Area1` the
      // radius the medium band reaches.
      case "Afak": {
        const bonus = this.dataOf(lvl, 0, 15);
        this.landDamage(target, bonus, attacker.id, false);
        const radius = lvl.area || 150;
        for (const o of this.unitsInAreaInternal(target.x, target.y, radius)) {
          if (o === target || o === attacker || !this.hostile(attacker, o)) continue;
          this.landDamage(o, bonus * this.dataOf(lvl, 1, 0.45), attacker.id, false);
        }
        break;
      }
      // --- Poison Arrows: `DataA` Extra Damage, then the poison columns (Poa2..Poa4 =
      // Damage per Second / Attack Speed Factor / Movement Speed Factor).
      case "AEpa": {
        const extra = this.dataOf(lvl, 0);
        if (extra > 0) this.landDamage(target, extra, attacker.id, false);
        // `Poa5` is its Stacking Types column (0 — nothing stacks), one place further along
        // than the poison family's, because Poison Arrows carries an Extra Damage column too.
        this.applyPoison(attacker, target, def, dur, this.dataOf(lvl, 1, 1), this.dataOf(lvl, 2), this.dataOf(lvl, 3), this.dataOf(lvl, 4));
        break;
      }
      // --- Poison (Slow Poison, Envenomed Spears, Poison Sting, Orb of Venom's half).
      // AbilityMetaData Poi1..Poi3 / Spo1..Spo3: `DataA` Damage per Second, `DataB` and
      // `DataC` the Attack- and Movement-Speed factors — and the two families put them in
      // the OPPOSITE order, which is the metadata's own answer and not a guess:
      //   Spo2 = "Movement Speed Factor", Spo3 = "Attack Speed Factor"   (Aspo)
      //   Poi2 = "Attack Speed Factor",   Poi3 = "Movement Speed Factor" (Apoi/Apo2/Aven)
      case "Aspo":
        this.applyPoison(attacker, target, def, dur, this.dataOf(lvl, 0), this.dataOf(lvl, 2), this.dataOf(lvl, 1), this.dataOf(lvl, 3));
        break;
      case "Apoi":
      case "Apo2":
      case "Aven":
        this.applyPoison(attacker, target, def, dur, this.dataOf(lvl, 0), this.dataOf(lvl, 1), this.dataOf(lvl, 2), this.dataOf(lvl, 3));
        break;
      // --- Feedback (Spell Breaker, Arcane Tower): burn up to `DataA` mana from a unit or
      // `DataC` from a hero, and deal that much damage times the matching Damage Ratio
      // (`DataB`/`DataD`). `DataE` is flat bonus damage to SUMMONED units — the Arcane
      // Tower's 20, and 0 on the Spell Breaker, so it costs nothing to read here.
      case "Afbk": {
        const cap = target.isHero ? this.dataOf(lvl, 2, 4) : this.dataOf(lvl, 0, 20);
        const ratio = target.isHero ? this.dataOf(lvl, 3, 1) : this.dataOf(lvl, 1, 1);
        const burned = Math.min(cap, Math.max(0, target.mana));
        if (burned > 0) {
          target.mana -= burned;
          this.landDamage(target, burned * ratio, attacker.id, false);
        }
        const vsSummon = this.dataOf(lvl, 4);
        if (vsSummon > 0 && target.isSummon && target.hp > 0) this.landDamage(target, vsSummon, attacker.id, false);
        break;
      }
      // --- Life steal (Mask of Death, Killmaim). `DataA` is "Life Stolen Per Attack" as a
      // FRACTION of the damage dealt (0.5). Unlike the Vampiric Aura this is an orb, so it
      // works on a ranged attack too — which is why it lives here and not on u.lifesteal.
      case "AIva":
        if (dealt > 0 && attacker.hp > 0) attacker.hp = Math.min(attacker.maxHp, attacker.hp + dealt * this.dataOf(lvl, 0, 0.5));
        break;
      // --- Orb of Fire / Orb of Kil'jaeden: "do splash damage to nearby enemy units" (the
      // items' own Ubertip). `Area1` is the radius; the splash is the orb's own damage bonus,
      // the only magnitude the row carries.
      case "AIfb": {
        const splash = this.dataOf(lvl, 0, 10);
        for (const o of this.unitsInAreaInternal(target.x, target.y, lvl.area || 150)) {
          if (o === target || o === attacker || !this.hostile(attacker, o)) continue;
          this.landDamage(o, splash, attacker.id, false);
        }
        break;
      }
      // --- Orb of Frost: the generic Slowed buff (`Bfro`) for the row's own duration. The
      // magnitudes are engine-internal — see SLOWED_MOVE/SLOWED_ATTACK in orbs.ts. Frost
      // Attack (Frost Wyrm, Nerubian Tower, the Blue Dragons) is the same buff, longer.
      case "AIob":
      case "Afra":
      case "Afrb":
        this.applyBuffInternal(target, {
          kind: "slow", group: "frostattack", timeLeft: dur || 3,
          value: SLOWED_MOVE, value2: SLOWED_ATTACK, sourceId: attacker.id, ...this.buffArtOf(def),
        });
        break;
      // --- Orb of Corruption. Its armour strip goes on BEFORE the blow that carried it, so
      // it is applied in applyOrbArmorFirst rather than here; all that is left for the
      // landing is the proc art at the bottom of this function.
      case "AIcb":
        break;
      // --- The RoC Orb of Lightning's purge half. Its own row carries a slow factor
      // (`DataA`) and bonus damage to summons (`DataC`) but no chance column, so it fires on
      // every hit.
      case "AIlp": {
        const bonusVsSummon = this.dataOf(lvl, 2);
        if (target.isSummon && bonusVsSummon > 0) this.landDamage(target, bonusVsSummon, attacker.id, false);
        this.applyBuffInternal(target, {
          kind: "slow", group: "itempurge", timeLeft: dur || 3,
          value: Math.min(1, this.dataOf(lvl, 0, 1)), value2: 0, sourceId: attacker.id, ...this.buffArtOf(def),
        });
        break;
      }
      // --- The "Effect Ability" orbs — Orb of Slow, the TFT Orb of Lightning, Orb of
      // Darkness. AbilityMetaData names their columns outright: `Iob2`/`Iob3`/`Iob4` are
      // "Chance To Hit Units/Heros/Summons (%)" and `Iobu` (UnitID1) is the "Effect Ability"
      // to run on the target. So this is one generic wrapper for all three, and what each
      // does is entirely in its own data: 15/5/35 → Slow, 30/10/30 → Purge, 100/100/100 →
      // raise a Dark Minion.
      case "AIsb": {
        const chance = target.isHero ? this.dataOf(lvl, 2) : target.isSummon ? this.dataOf(lvl, 3) : this.dataOf(lvl, 1);
        if (this.rng() * 100 >= chance) break;
        const effect = this.abilities?.get(lvl.summon);
        if (!effect) break;
        // The wrapper's own effect ability is a real spell row (`AIos` is Slow, `AIpg` is
        // Purge), so it dispatches through the ordinary spell path — no mana, no cooldown,
        // it is the orb that paid. `ANbs` is not a spell but an orb in its own right and
        // runs through this same switch.
        if (isOrbCode(effect.code)) this.runOrbPart(attacker, target, this.orbOf(effect, 1), dealt);
        else this.applySpellEffect(effect.code, 1, attacker, { targetId: target.id, x: target.x, y: target.y }, effect);
        break;
      }
      // Damage-bonus-only orbs (Orb of Lightning's `AIlb`, Orb of Venom's `AIpb`): the bonus
      // is a carried stat (itemBonuses), so winning the priority contest costs them nothing
      // and there is no on-hit effect of their own. They are still full members of the
      // family — an Orb of Venom in slot 6 really does switch a Dryad's Slow Poison off.
      default:
        break;
    }
    // The orb's `Specialart` is its PROC — the flash on the unit that was hit (Orb of
    // Corruption's ribbon, the Mask of Death's VampiricAuraTarget, Feedback's
    // SpellBreakerAttack). Distinct from `Targetart`, which for an orb is the persistent
    // model worn on the carrier's weapon and never a one-shot (see orbAttachments).
    if (def.specialArt) this.spellEffects.push({ art: def.specialArt, x: target.x, y: target.y, targetId: target.id, z: 0 });
  }

  /** The missile model an orb lends the shot it rides — the orb's own `Missileart`, which
   *  every member of the family carries and which is what makes an orb visible on a ranged
   *  unit at all. An item orb's damage half names it (Orb of Frost → LichMissile); if it
   *  doesn't, one of its other halves might (Orb of Venom's `Apo2` → OrbVenomMissile). */
  private orbMissileArt(orb: ResolvedOrb | null): string {
    if (!orb) return "";
    if (orb.def.missileArt) return orb.def.missileArt;
    for (const part of orb.extra ?? []) if (part.def.missileArt) return part.def.missileArt;
    return "";
  }

  /**
   * The half of an orb that has to land BEFORE the blow it rode in on: Orb of Corruption's
   * armour strip. Liquipedia's Orb of Corruption page is explicit — "The armor reduction
   * happens, before the damage of the hero is dealt" — so even the first hit of a fight is
   * already taking the reduced-armour damage, which is most of why the item is worth its
   * 375 gold in a big fight. Everything else an orb does happens after (applyOrbEffect).
   */
  private applyOrbArmorFirst(attacker: SimUnit | undefined, target: SimUnit, orb: ResolvedOrb | null | undefined): void {
    if (!attacker || !orb || target.hp <= 0) return;
    for (const part of [orb, ...(orb.extra ?? [])]) {
      if (part.def.code !== "AIcb") continue;
      const lvl = part.lvl;
      const dur = target.isHero && lvl.heroDuration > 0 ? lvl.heroDuration : lvl.duration;
      this.applyBuffInternal(target, {
        kind: "armor", group: "orbcorruption", timeLeft: dur || 5,
        value: -this.dataOf(lvl, 1, 4), sourceId: attacker.id, ...this.buffArtOf(part.def),
      });
      this.recomputeStats(target); // armour is a derived stat — the strip has to be live NOW
    }
  }

  /**
   * A poison DoT + its slow, shared by every poison orb.
   *
   * WC3 poison is NON-LETHAL — "the poison damage is 8 damage per second and is non-lethal"
   * (Liquipedia, Orb of Venom) — so the tick clamps at 1 hp rather than killing.
   *
   * `stack` is the ability's Stacking Types bitmask (see STACK_DAMAGE in orbs.ts). With the
   * Damage bit set — which the whole poison family carries — the DoT is keyed per ATTACKER,
   * so two Wind Riders' poison adds up while one Wind Rider's re-hit merely refreshes. The
   * slow half is keyed per ability either way: our slow model takes the strongest rather
   * than summing, so a per-source key there would change nothing.
   *
   * NOTE the group names carry no colon. A colon in a buff group means "aura, and the first
   * half is its ability code" to the renderer's persistent-FX pass, and a poison is not one.
   */
  private applyPoison(attacker: SimUnit, target: SimUnit, def: AbilityDef, dur: number, dps: number, attackFactor: number, moveFactor: number, stack = 0): void {
    const t = dur || 5;
    const group = `poison-${def.code}` + (stack & STACK_DAMAGE ? `-${attacker.id}` : "");
    if (dps > 0) this.applyBuffInternal(target, { kind: "dot", group, timeLeft: t, value: dps, sourceId: attacker.id, nonLethal: true, ...this.buffArtOf(def) });
    if (moveFactor > 0 || attackFactor > 0) {
      // Same buff row as the damage half above (`BSpo` IS "Slow Poison"), split in two only
      // because our buffs carry one kind each — so the Status row shows it once.
      this.applyBuffInternal(target, { kind: "slow", group: `poison-${def.code}-slow`, timeLeft: t, value: moveFactor, value2: attackFactor, sourceId: attacker.id, buffId: buffIdOf(def) });
    }
  }

  /** The persistent models a buff-carrying orb hangs on its victim — its own `buffid1` row's
   *  art, exactly as every other buff resolves it. Never the ability's `Targetart`: for an
   *  orb that field is the model worn by the CARRIER (see orbAttachments). */
  private buffArtOf(def: AbilityDef, rank = 1): { art?: string; fx?: BuffFx[]; buffId: string } {
    const buffId = buffIdOf(def, rank);
    return def.buffFx?.length ? { art: def.buffArt, fx: def.buffFx, buffId } : { buffId };
  }

  /**
   * The persistent orb art a unit is WEARING, for the renderer.
   *
   * Every orb item names it the same way and it is not the buff system's business:
   *
   *     [AIfb]  Targetart   = Abilities\Spells\Items\AIfb\AIfbTarget.mdl
   *             Targetattach = weapon
   *
   * "Targetart" is a misnomer inherited from the spell rows — these models are LOOPS (every
   * one of them is a single `Stand` sequence flagged looping; verified by parsing them out of
   * the install), so they cannot be one-shot hit effects. They are the glowing orb on the
   * hero's weapon hand, and `Targetattach` is the bone to hang it from. Mask of Death spells
   * out the counter-case by writing `Targetart=` empty: no orb, nothing worn.
   *
   * Unlike the on-hit EFFECT this is not exclusive — a hero carrying three orbs wears three,
   * because carrying is all it takes.
   */
  orbAttachments(u: SimUnit): BuffFx[] {
    if (!this.abilities || !this.itemReg || !u.inventory.length) return [];
    const out: BuffFx[] = [];
    for (const held of u.inventory) {
      if (!held) continue;
      const item = this.itemReg.get(held.itemId);
      if (!item) continue;
      for (const abilId of item.abilities) {
        const def = this.abilities.get(abilId);
        if (!def || !isOrbCode(def.code) || !def.targetArt) continue;
        out.push({ path: def.targetArt, attach: def.targetAttach });
      }
    }
    return out;
  }

  private applyDamage(target: SimUnit, rawDamage: number, attackerId: number, attackType = AttackType.None, weaponSound = "", ranged = false): number {
    // A Mirror Image illusion swings, connects, and does nothing: AOmi's DataB ("Damage
    // Dealt (%)") is 0. Its sheet still reads like the Blademaster's — the deception is
    // the whole ability — so this is enforced here, at the blow, not by editing its stats.
    // (Only its ATTACKS need this: an illusion cannot cast, so no spell damage is ever
    // attributed to one. "Damage Taken" lives in landDamage, which spells reach too.)
    //
    // The blow must still LAND: same swing, same weapon-on-armour clang as the real
    // Blademaster, because a silent attacker would give the copy away instantly. So record
    // the hit the way landDamage would and return 0, rather than bailing out before it —
    // bailing early is exactly what left the images swinging in silence.
    const attacker = attackerId ? this.units.get(attackerId) : undefined;
    if (attacker?.isIllusion && attacker.illusionDamageDealt <= 0) {
      if (!target.invulnerable) this.hits.push({ attackerId, targetId: target.id, weaponSound });
      return 0;
    }
    if (attacker?.isIllusion) rawDamage *= attacker.illusionDamageDealt;
    // Evasion (Demon Hunter passive AEev): a chance to dodge a physical attack.
    if (this.tryEvade(target)) return 0;
    // …and the other side of the same coin: a drunk ATTACKER simply misses. Drunken Haze's
    // `Nsi2 "Chance To Miss (%)"` (0.45/0.65/0.8) is not a damage cut or a slow — the swing
    // is thrown and goes nowhere, which is why the buff has a kind of its own.
    if (attacker && this.rollMiss(attacker)) return 0;
    // Defend (Adef, granted by the Rhde research): a Footman braced behind his shield turns
    // arrows aside. Straight off the ability's own Ubertip, which spells the whole thing out:
    // "Activate to have a <DataF1>% chance to reflect Piercing attacks upon the source, and to
    // take only <DataA1,%>% of the damage from attacks that are not reflected."
    const defend = attackType === AttackType.Pierce ? this.defendStance(target) : null;
    if (defend) {
      if (this.rng() * 100 < this.dataOf(defend, 5, 30)) {
        // Reflected: the shot goes back down its own flight path. The defender takes nothing.
        if (attacker) this.landDamage(attacker, rawDamage, target.id, false);
        return 0;
      }
      rawDamage *= this.dataOf(defend, 0, 0.5); // dataA — the fraction that gets through
    }
    // The Arcanite Shield (`AIdd`, whose row is literally called "Defend (Item)") is the same
    // idea worn rather than braced, and its Ubertip states the rule the same way round:
    // "Reduces damage from ranged attacks to <AIdd,DataA1,%>%". No reflect, no stance, no
    // research — just a standing cut on anything that arrives by projectile.
    if (ranged && target.rangedReduction > 0) rawDamage *= 1 - target.rangedReduction;
    // WC3 damage table: the weapon's attack type vs the target's armor type scales
    // the hit (Normal +50% vs Medium, Pierce ×2 vs Light/Unarmored, Siege ×1.5 vs
    // Fortified, Magic ×2 vs Heavy, …). Applied before the armor-value reduction;
    // both are multiplicative so order is immaterial.
    let typeMult = damageMultiplier(attackType, target.armorType);
    // Banished (ethereal) targets take a SECOND multiplier by the attacker's type:
    // 0 for every physical type (immune to melee/pierce/siege) and ×1.66 from
    // Magic/Spells (issue #49, EtherealDamageBonus). A physical auto-attack thus
    // lands 0 on a banished unit — the melee simply can't hurt it.
    if (target.ethereal) typeMult *= etherealDamageMultiplier(attackType);
    // Berserk (Absk) and the like: the holder takes a fraction MORE damage from every source.
    let vuln = 0;
    for (const b of target.buffs) if (b.kind === "vuln") vuln = Math.max(vuln, b.value);
    const reduction = armorDamageReduction(target.armor);
    const final = rawDamage * typeMult * (1 + vuln) * (1 - reduction);
    return this.landDamage(target, this.spiritLinkSplit(target, final), attackerId, true, weaponSound);
  }

  /** Spirit Link (Aspl): `linkShare` of a post-armor hit is spread equally across the linked
   *  group (each living member, including the target, takes an equal share); the rest stays
   *  on the target. Returns the reduced amount the target itself should take. */
  private spiritLinkSplit(target: SimUnit, dmg: number): number {
    if (target.linkT <= 0 || target.linkGroup.length < 2 || dmg <= 0) return dmg;
    const members = target.linkGroup.map((id) => this.units.get(id)).filter((u): u is SimUnit => !!u && u.hp > 0);
    if (members.length < 2) return dmg;
    const share = target.linkShare;
    const per = (dmg * share) / members.length; // equal slice for every linked unit
    for (const m of members) {
      if (m === target) continue;
      m.hp -= per; // already post-armor; spirit-shared damage isn't reduced again
      if (m.hp <= 0) this.kill(m);
    }
    return dmg * (1 - share) + per; // target keeps the unshared part + its own slice
  }

  /** The Critical Strike level-data the unit carries, from EITHER row the effect ships as —
   *  the Blademaster's AOcr or the Pandaren Brewmaster's ANdb (Drunken Brawler), which the
   *  meta table declares as one field group (see isCriticalStrikeCode). A unit is not
   *  expected to hold both; the first one found wins. */
  private criticalStrikeLevel(u: SimUnit): AbilityLevel | null {
    if (!this.abilities) return null;
    for (const ab of u.abilities) {
      if (ab.level < 1 || !isCriticalStrikeCode(ab.code)) continue;
      const def = this.abilities.get(ab.id);
      const lvl = def?.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (lvl) return lvl;
    }
    return null;
  }

  /**
   * Critical Strike (AOcr / ANdb): roll dataA "Chance to Critical Strike" for a swing about
   * to begin. Rolled at the swing's START, not at the blow, so the strike can animate as one
   * (see swingCrit/swingSlam); dealDamage spends the result via applyCriticalStrike.
   *
   * dataA is a PERCENT, not a fraction: AbilityMetaData.slk gives Ocr1 `data=1` (→ dataA)
   * with `maxVal=100`, and AOcr carries DataA1..4 = 15 — the Blademaster's 15% (ANdb carries
   * 10). Note the sibling field Ocr4 "Chance to Evade" (data=4) has `maxVal=1` and AEev
   * stores 0.1, so the two conventions genuinely differ within one table; read the meta,
   * don't assume — and Drunken Brawler carries BOTH fields, which is what makes it one
   * ability rather than a crit bolted to an evasion (see tryEvade).
   */
  private rollCriticalStrike(u: SimUnit): boolean {
    const lvl = this.criticalStrikeLevel(u);
    if (!lvl) return false;
    const chance = this.dataOf(lvl, 0) / 100; // dataA — "Chance to Critical Strike" (%)
    return chance > 0 && this.rng() < chance;
  }

  /** Critical Strike (AOcr / ANdb): multiply a swing the roll already marked as a crit by
   *  dataB "Damage Multiplier" (AOcr DataB1..4 = 2/3/4/4 — the Blademaster's x2/x3/x4; ANdb
   *  carries the same 2/3/4 for Drunken Brawler). */
  private applyCriticalStrike(attacker: SimUnit, damage: number): number {
    if (!attacker.swingCrit) return damage;
    const lvl = this.criticalStrikeLevel(attacker);
    if (!lvl) return damage;
    return damage * this.dataOf(lvl, 1, 2); // dataB — damage multiplier
  }

  /** Evasion: dataA chance for the DEFENDER to dodge a physical attack.
   *
   *  Two rows, two field layouts, because they are two different abilities that happen to
   *  share an effect: the Demon Hunter's Evasion (AEev) IS the dodge, so it sits in dataA
   *  (0.1/0.2/0.3); Drunken Brawler (ANdb) is a Critical Strike row whose dodge rides the
   *  Ocr4 "Chance to Evade" field, i.e. dataD (0.07/0.14/0.21). Both are FRACTIONS —
   *  AbilityMetaData gives Ocr4 `maxVal=1`, unlike the crit chance next to it. */
  /** Does this attacker's swing go wide? The highest `miss` buff it wears decides — the
   *  chances do not add up, the same way two slows don't (see recomputeStats). */
  private rollMiss(attacker: SimUnit): boolean {
    let chance = 0;
    for (const b of attacker.buffs) if (b.kind === "miss") chance = Math.max(chance, b.value);
    return chance > 0 && this.rng() < chance;
  }

  private tryEvade(target: SimUnit): boolean {
    const evasion = this.passiveLevelData(target, "AEev");
    const brawler = evasion ? null : this.criticalStrikeLevel(target);
    // A Blademaster falls through to here too and correctly dodges nothing: AOcr's dataD is 0.
    const chance = evasion ? this.dataOf(evasion, 0) : brawler ? this.dataOf(brawler, 3) : 0;
    return chance > 0 && this.rng() < chance;
  }

  /** Cleaving Attack (ANca): the attacker splashes dataA of its swing to other
   *  enemies within a short radius of the struck target (armor-reduced). */
  private applyCleave(attacker: SimUnit, target: SimUnit, rawDamage: number): void {
    const lvl = this.passiveLevelData(attacker, "ANca");
    if (!lvl) return;
    const frac = this.dataOf(lvl, 0); // dataA — cleave fraction
    if (frac <= 0) return;
    const radius = this.dataOf(lvl, 3, 200) || 200; // dataD — cleave radius
    for (const t of this.unitsInAreaInternal(target.x, target.y, radius)) {
      if (t === target || t === attacker || t.building || !this.hostile(attacker, t)) continue;
      this.landDamage(t, rawDamage * frac, attacker.id, false); // splash ignores further armor tables
    }
  }

  /** An attacker the victim's side cannot see has just hit it: give away where the blow
   *  came from (FOGGED_ATTACK_REVEAL_RADIUS) for FOGGED_ATTACK_REVEAL_TIME, refreshed by
   *  each further blow. The reveal is stamped at the attacker's position AT THE MOMENT of
   *  the hit and stays put — you learn where it shot from, not where it ran to. It also
   *  outlives the attacker by its second, so a killing blow from the dark still points at
   *  the shooter. Attacks the victim's side can already see cost nothing. */
  private revealFoggedAttacker(attackerId: number, target: SimUnit): void {
    const attacker = this.units.get(attackerId);
    if (!attacker || !this.hostile(attacker, target)) return;
    const key = `${attackerId}:${target.team}`;
    // Only a blow from HIDDEN cover opens a reveal. Once one is open, every further blow
    // re-stamps it without re-testing visibility — because the reveal itself is what's
    // making the attacker visible, and re-testing would refuse to refresh it, leaving the
    // attacker to blink out every second while it kept firing.
    if (!this.attackReveals.has(key) && this.visibleToTeam(target.team, attacker.x, attacker.y)) return;
    this.attackReveals.set(key, {
      x: attacker.x,
      y: attacker.y,
      radius: FOGGED_ATTACK_REVEAL_RADIUS,
      team: target.team,
      flying: attacker.flying,
      timeLeft: FOGGED_ATTACK_REVEAL_TIME,
    });
  }

  /** Age out the fogged-attacker reveals (see revealFoggedAttacker). */
  private tickAttackReveals(dt: number): void {
    for (const [key, r] of this.attackReveals) {
      r.timeLeft -= dt;
      if (r.timeLeft <= 0) this.attackReveals.delete(key);
    }
  }

  /** The circles a hidden attacker's blows are currently lighting up, for the fog pass. */
  activeAttackReveals(): Iterable<AttackReveal> {
    return this.attackReveals.values();
  }

  /**
   * File the sight a unit keeps while it falls (issue #126, see DeathReveal).
   *
   * Called from `kill()` while the unit is still whole — its position, its team and its
   * CURRENT sight radius are all read off the body before the record is dropped.
   *
   * Two things are deliberately not here. A structure gets none: it does not "die" on a
   * clock, it collapses, and leaving a 500-radius eye on a razed base for three seconds would
   * hand the attacker's own scouting back to the defender. And nothing is filed for a unit
   * that never had eyes to begin with (radius 0), which is what keeps a match's stream of
   * critter and summon deaths from filling this array with records that reveal nothing.
   */
  private revealDyingUnit(u: SimUnit): void {
    if (u.building) return;
    const life = this.unitReg?.get(u.typeId)?.deathTime ?? 0;
    if (life <= 0) return;
    // A CAP, not a replacement, and read LIVE: a Footman (1400 day / 800 night) is cut back to
    // 500 either way, while a crab (350) dies seeing everything it saw in life.
    const radius = Math.min(this.sightOf(u), DYING_REVEAL_RADIUS);
    if (radius <= 0) return;
    this.deathReveals.push({ x: u.x, y: u.y, radius, team: u.team, owner: u.owner, flying: u.flying, timeLeft: life });
  }

  /** Age out the dying-unit reveals. Swap-and-pop: order means nothing here and a match with
   *  a big fight in it churns this array hard. */
  private tickDeathReveals(dt: number): void {
    for (let i = this.deathReveals.length - 1; i >= 0; i--) {
      if ((this.deathReveals[i].timeLeft -= dt) <= 0) {
        this.deathReveals[i] = this.deathReveals[this.deathReveals.length - 1];
        this.deathReveals.pop();
      }
    }
  }

  /** The sight bodies on the ground are still lending their side, for the fog pass. */
  activeDeathReveals(): Iterable<DeathReveal> {
    return this.deathReveals;
  }

  /** Open a patch of fog for a player (see ItemReveal and SpellApi.revealArea). */
  addItemReveal(owner: number, team: number, o: { x: number; y: number; radius: number; seconds: number; detect?: boolean; follow?: number; untilBuffGone?: string }): void {
    if (o.radius <= 0 || o.seconds <= 0) return;
    this.itemReveals.push({
      x: o.x, y: o.y, radius: o.radius, owner, team, timeLeft: o.seconds,
      detect: !!o.detect, unitId: o.follow ?? 0, untilBuffGone: o.untilBuffGone ?? "",
    });
  }

  /** Age the item reveals, and drop the ones whose subject has gone. A following reveal
   *  re-reads its unit's position every tick, which is the whole point of the Wand of
   *  Shadowsight: the eye goes where the unit goes. */
  private tickItemReveals(dt: number): void {
    for (let i = this.itemReveals.length - 1; i >= 0; i--) {
      const r = this.itemReveals[i];
      r.timeLeft -= dt;
      let done = r.timeLeft <= 0;
      if (!done && r.unitId) {
        const u = this.units.get(r.unitId);
        // The unit died, or the buff that was holding the eye open was dispelled off it.
        if (!u || u.hp <= 0 || (r.untilBuffGone && !u.buffs.some((b) => b.group === r.untilBuffGone))) done = true;
        else { r.x = u.x; r.y = u.y; }
      }
      if (done) {
        this.itemReveals[i] = this.itemReveals[this.itemReveals.length - 1];
        this.itemReveals.pop();
      }
    }
  }

  /** The fog an item is holding open, for the vision pass. */
  activeItemReveals(): Iterable<ItemReveal> {
    return this.itemReveals;
  }

  /**
   * A blow landed on somebody's property: raise the under-attack warning, at most as often
   * as MiscData allows (see `attackNotify`).
   *
   * Which of the two lines it is comes from what was hit — a STRUCTURE is the town
   * ("Our town is under siege!"), anything else is the field ("The battle has been
   * joined."). The data gives no rule for the split, but it gives the pair: two [Errors]
   * rows, `Unitattack` and `Townattack`, matched by two war3skins sound keys,
   * `UnderAttackSound` and `TownAttackSound`. Unit-or-building is the only division of a
   * hit that both halves can be read off.
   *
   * Called from `landDamage`, so a spell counts as an attack — being burned by a Flame
   * Strike is being attacked, and the warning has no way to tell the player otherwise.
   */
  private noteAttacked(target: SimUnit, attackerId: number): void {
    const src = attackerId ? this.units.get(attackerId) : undefined;
    if (!src || !this.hostile(src, target)) return; // friendly fire is not an invasion
    const last = this.attackNotify.get(target.owner);
    if (last && this.elapsed - last.t < MISC_DATA.AttackNotifyDelay &&
        Math.hypot(target.x - last.x, target.y - last.y) <= MISC_DATA.AttackNotifyRange) return;
    this.attackNotify.set(target.owner, { t: this.elapsed, x: target.x, y: target.y });
    this.alerts.push({ kind: target.building ? "townattack" : "attack", player: target.owner, x: target.x, y: target.y });
  }

  /** Apply FINAL (post-reduction) damage: death, return fire, and (for physical
   *  hits) the impact SFX. Spell damage calls this directly with recordHit=false —
   *  WC3 ability damage ignores the armor value and plays its own effects. Returns
   *  the HP removed (0 if the target was invulnerable). */
  private landDamage(target: SimUnit, amount: number, attackerId: number, recordHit: boolean, weaponSound = ""): number {
    if (target.invulnerable) return 0; // Divine Shield / Avatar: immune to damage
    // A Mirror Image illusion takes AOmi's DataC ("Damage Taken (%)") = 200%, which is why
    // one melts the moment somebody works out which is which. It belongs HERE and not in
    // applyDamage because that is only the ATTACK path: spellDamage lands straight here, and
    // Dispel Magic hitting a summon is exactly the case that has to double.
    if (target.isIllusion) amount *= target.illusionDamageTaken;
    // Sleep (Dreadlord) breaks the instant the sleeper takes damage (WC3).
    if (target.buffs.some((b) => b.kind === "sleep")) target.buffs = target.buffs.filter((b) => b.kind !== "sleep");
    // …and so does a regeneration item. Drinking a Healing Salve and walking into a fight
    // wastes it: the effect is dispelled by a hit worth at least ITEM_REGEN_BREAK damage.
    // That threshold is an engine constant in no data file — it is documented on
    // Liquipedia's Healing Salve page ("dispelled if the target is attacked or damaged by
    // an ability that does at least 20 damage, before the damage is modified") and cannot
    // be confirmed from the MPQ, unlike the amounts and durations above.
    if (amount >= ITEM_REGEN_BREAK && target.buffs.some((b) => b.group?.startsWith(ITEM_REGEN_GROUP))) {
      target.buffs = target.buffs.filter((b) => !b.group?.startsWith(ITEM_REGEN_GROUP));
      this.recomputeStats(target); // the mana half is a stat bonus — drop it now, not next tick
    }
    // Mana Shield (Naga): absorb incoming damage into mana at `value` mana per hp.
    amount = this.absorbWithManaShield(target, amount);
    if (amount <= 0) return 0;
    if (recordHit) this.hits.push({ attackerId, targetId: target.id, weaponSound });
    this.noteAttacked(target, attackerId); // "The battle has been joined." / "Our town is under siege!"
    this.revealFoggedAttacker(attackerId, target);
    // EVENT_UNIT_DAMAGED: the amount that actually landed (after mana shield), with
    // the source. Captured before the hp subtraction so the target snapshot is live.
    if (this.captureDamage) {
      const src = attackerId ? this.units.get(attackerId) : undefined;
      this.damageEvents.push({ target: eventInfo(target), source: src ? eventInfo(src) : null, amount });
    }
    target.hp -= amount;
    if (target.hp <= 0) {
      this.kill(target, attackerId);
      return amount;
    }
    this.provoke(target, attackerId);
    return amount;
  }

  /**
   * Being ATTACKED, from the victim's side: waking, returning fire, and calling the camp.
   *
   * Split out of landDamage because a blow is not the only way to attack someone. Every
   * harmful SPELL is one too, and WC3 treats it as one — a creep hit by Slow, Curse, Purge or
   * Faerie Fire turns on the caster exactly as if it had been struck, and its camp comes with
   * it. Reached from applySpellEffect for those, which is the only path that has the fact:
   * several of them land no damage at all (Transmute does not damage its victim, it deletes
   * it) and several more land it as a buff the victim's own tick spends (Acid Bomb is a dot),
   * so nothing about them ever passes through here. The Alchemist could Acid Bomb or Transmute
   * a creep camp and walk away un-chased.
   */
  private provoke(target: SimUnit, attackerId: number): void {
    if (target.hp <= 0) return;
    // A struck creep wakes and, being in combat, resets its "head home" timer —
    // so while it's between the soft and hard guard limits, continued attacks keep
    // it fighting (MiscGame: it only leaves after GuardReturnTime *unattacked*).
    if (target.isCreep) {
      target.asleep = false;
      target.strayT = 0;
      target.campHelper = false; // being hit makes it an originator: it may now call for help
    } else if (target.guarding) {
      target.strayT = 0; // …and so does a placed AI unit on the same leash (tickGuardLeash)
    }
    // Retaliate: an armed victim turns on its attacker (WC3 return fire), unless the
    // attacker died mid-flight or the victim is a creep leashing home (it prioritises
    // returning). Fires when the victim is idle, OR is on an attack order but NOT actually
    // in combat — i.e. it's chasing / stalled / holding on a target it can't reach while
    // THIS enemy stands here hitting it (issue #24: "units stand around while enemies
    // attack them, the nearest enemy must always be attacked"). An enemy landing hits on
    // us is by definition adjacent and reachable, a strictly better target than one we
    // can't close on. A unit already trading blows (inCombat) keeps its target; HOLD-
    // position units (order "hold") never leave their post. Workers never return fire —
    // a peasant being cut down just stands there until you order it to fight, and a Ghoul
    // on a lumber trip keeps chopping through the blows (issue #41). The harvest check is
    // belt-and-braces: a harvesting unit isn't "notFighting" today, but the rule belongs
    // next to the one it mirrors in acquireRange.
    // ...but NOT while it is walking to a target a player ORDERED it onto (issue #83): being
    // shot on the way is not a reason to abandon the order and turn on the shooter. That is
    // the whole point of "attack THAT one" — it holds until the player says otherwise (or the
    // ordered target turns out to be unreachable, which clears attackOrdered).
    const attacker = this.units.get(attackerId);
    const notFighting = target.order === "idle" || (target.order === "attack" && !target.inCombat && !target.attackOrdered);
    // A unit under an invisibility effect never returns fire either — the same reason it
    // never picks its own fights in acquireRange. Retaliation reaches issueAttack directly,
    // so it would otherwise be the one automatic path that could give a wind-walking hero
    // away without the player asking for it.
    const passive = target.isPeon || this.harvesting(target) || target.cloaked;
    if (notFighting && target.weapon && !passive && !target.returning && attacker && this.hostile(target, attacker)) {
      // A creep hit by a WARD (or by a worker) returns fire on whatever it can see that
      // outranks the thing that hit it — see creepTargetOver. A Serpent Ward's whole job is
      // to be shot at instead of the army that planted it.
      const foe = target.isCreep ? this.creepTargetOver(target, attacker) : attacker;
      if (foe.id !== target.targetId) this.issueAttack(target.id, foe.id);
    }
    // Creep "call for help" (Battle.net creep basics): attacking one creep rallies
    // its whole camp — every camp-mate within CREEP_CALL_FOR_HELP aggros the
    // attacker at once, even one still out of its own acquisition range.
    if (target.isCreep && attacker && this.hostile(target, attacker)) {
      this.alertCamp(target, attacker);
    }
    // "Creeps will also call for help if you attack another unit currently being
    // targeted by those creeps." Only a NON-creep attacker striking a NON-creep
    // victim can trigger this (a creep is never hostile to a fellow creep, and no
    // creep ever targets a camp-mate), so the reverse-target scan is skipped in the
    // common player↔creep exchanges where it could never fire.
    else if (attacker && !attacker.isCreep && !target.isCreep) {
      for (const c of this.units.values()) {
        if (c.isCreep && c.hp > 0 && !c.returning && c.targetId === target.id && this.hostile(c, attacker)) {
          this.alertCamp(c, attacker);
        }
      }
    }
  }

  /** Mana Shield (Naga Sea Witch, ANms): redirect incoming damage into the unit's
   *  mana. `value` = mana consumed per hp absorbed; the shield covers as much as the
   *  mana pool allows, then any overflow damage falls through to hp. */
  private absorbWithManaShield(u: SimUnit, amount: number): number {
    if (amount <= 0 || u.mana <= 0) return amount;
    const buff = u.buffs.find((b) => b.kind === "manaShield");
    if (!buff) return amount;
    const perHp = buff.value > 0 ? buff.value : 1;
    const absorbable = Math.min(amount, u.mana / perHp);
    u.mana -= absorbable * perHp;
    return amount - absorbable;
  }

  /** Reincarnation (AOre): if a dying hero has it learned and off cooldown, revive
   *  it in place at full HP/mana, put the ability on cooldown, and keep it alive. */
  private tryReincarnate(u: SimUnit): boolean {
    if (!u.isHero || u.hp > 0) return false;
    if (this.tryAnkh(u)) return true;
    const ab = u.abilities.find((a) => a.code === "AOre" && a.level >= 1 && a.cooldownLeft <= 0);
    if (!ab || !this.abilities) return false;
    const def = this.abilities.get(ab.id);
    if (!def) return false;
    const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
    ab.cooldownLeft = lvl.cooldown > 0 ? lvl.cooldown : 240;
    u.hp = u.maxHp;
    u.mana = u.maxMana;
    u.buffs = u.buffs.filter((b) => b.kind === "manaShield"); // clear debuffs on revive
    if (def.targetArt || def.casterArt) this.spellEffects.push({ art: def.targetArt || def.casterArt, x: u.x, y: u.y, targetId: u.id, z: 0 });
    return true;
  }

  /** ANKH OF REINCARNATION (`AIrc`, "ItemReincarnation") — "Automatically brings the Hero back
   *  to life with <AIrc,DataB1> hit points when the Hero wearing the Ankh dies."
   *
   *  Reincarnation carried rather than learned, and its columns say the same things:
   *    DataA "Delay After Death (seconds)"      7
   *    DataB "Restored Life"                    500
   *    DataC "Restored Mana (-1 for current)"   -1  ← keep whatever he had
   *  The Ankh is `uses = 1` and `perishable = 1`, so it is SPENT: the item is gone and the
   *  hero is standing where he fell. (Like the Tauren Chieftain's own `AOre` above, the
   *  revive is immediate rather than after DataA — the delay is not modelled for either, and
   *  modelling it for one only would make the item behave unlike the ability it is.)
   *
   *  Checked BEFORE `AOre` so a Tauren Chieftain wearing an Ankh spends the item and keeps
   *  his ultimate off cooldown, which is the order that loses the player less. */
  private tryAnkh(u: SimUnit): boolean {
    const slot = u.inventory.findIndex((h) => {
      const item = h && this.itemReg?.get(h.itemId);
      return !!item && item.abilities.some((a) => this.abilities?.get(a)?.code === "AIrc");
    });
    if (slot < 0) return false;
    const ankh = this.itemAbility(u, "AIrc");
    if (!ankh) return false;
    u.inventory[slot] = null; // spent — `uses` 1, `perishable` 1
    u.hp = Math.min(u.maxHp, this.dataOf(ankh.level, 1, 500));
    const mana = this.dataOf(ankh.level, 2, -1);
    if (mana >= 0) u.mana = Math.min(u.maxMana, mana);
    u.buffs = u.buffs.filter((b) => b.kind === "manaShield"); // clear debuffs on revive
    this.recomputeStats(u);
    if (ankh.def.fxArt || ankh.def.targetArt) this.spellEffects.push({ art: ankh.def.fxArt || ankh.def.targetArt, x: u.x, y: u.y, targetId: u.id, z: 0 });
    return true;
  }

  /** A summon LEAVES: its duration ran out, or a re-cast dismissed it. Its unsummon
   *  effect takes its place and the unit is simply removed — no death.
   *
   *  This is not the same event as a summon being killed, and must not be routed through
   *  kill(): that plays the unit's Death clip (a Feral Spirit wolf has one, and it looked
   *  like the wolf had been slain when its timer merely expired), grants kill XP, and
   *  fires death triggers. A wolf cut down in a fight still goes through kill() and dies
   *  properly — deathType=0 leaves no corpse and it dissipates (MiscData DissipateTime). */
  private unsummon(u: SimUnit): void {
    if (u.unsummonArt) this.spellEffects.push({ art: u.unsummonArt, x: u.x, y: u.y, targetId: 0, z: 0, sound: true });
    this.removeUnit(u.id); // silent: no corpse, no death XP, no death trigger
  }

  /** `Adda` — "AOE damage upon death": the unit detonates as it dies, damaging everything
   *  around it. The Goblin Land Mine and the Goblin Sapper are the units that carry it
   *  (`Adda` itself, plus `Amnx` and `Amnz` for the small and BIG mine), and the rings are
   *  the same four columns every death blast uses (AbilityMetaData Dda1..Dda4): dataA "Full
   *  Damage Radius", dataB "Full Damage Amount", dataC "Partial Damage Radius", dataD
   *  "Partial Damage Amount".
   *
   *  Chain reactions are real — a mine's blast sets off the mine beside it — but they must
   *  terminate. Two guards do that: a unit blasts at most once (`exploded`), and the blast
   *  skips anything already at zero hp, so the corpse it just made cannot be re-killed into
   *  a second explosion. */
  private exploded = new Set<number>();
  private deathBlast(u: SimUnit): void {
    if (this.exploded.has(u.id) || !this.abilities) return;
    const ab = u.abilities.find((a) => a.code === "Adda" && a.level >= 1);
    if (!ab) return;
    const lvl = this.abilities.get(ab.id)?.levelData[Math.max(0, ab.level - 1)];
    if (!lvl) return;
    this.exploded.add(u.id);
    const num = (i: number) => (lvl.data[i] === undefined || Number.isNaN(lvl.data[i]) ? 0 : lvl.data[i]);
    const fullR = num(0);
    const full = num(1);
    const partR = num(2);
    const part = num(3);
    for (const t of this.units.values()) {
      if (t.id === u.id || t.hp <= 0) continue;
      const dist = Math.hypot(t.x - u.x, t.y - u.y);
      if (dist > Math.max(fullR, partR)) continue;
      const amount = dist <= fullR ? full : part;
      if (amount > 0) this.landDamage(t, amount, u.id, false);
    }
  }

  /**
   * The two orb effects that only pay out when their victim DIES.
   *
   * Black Arrow / Orb of Darkness: "Units killed while under the effect of Black Arrow will
   * turn into <ndr1,RealHP> hit point skeletons" (the ability's own Ubertip). The numbers are
   * `DataB` "Number of Summoned Units", `DataC` "Summoned Unit Duration (seconds)" and
   * `UnitID1` "Summoned Unit Type" — AbilityMetaData's own names for Nba1..NbaU. The minion
   * belongs to whoever fired the arrow, not to the corpse's owner.
   *
   * Incinerate: "If a unit dies while under this effect, it is incinerated, causing up to
   * <DataB> damage to all nearby hostile units" — `DataE` is the radius and `DataF` the
   * falloff at its edge.
   *
   * Both read the mark the blow laid (SimUnit.blackArrow / .incinerate), and both are gated
   * on the matching buff still being on: the mark and its timer are the same effect.
   */
  private orbDeathEffects(u: SimUnit): void {
    const mark = u.blackArrow;
    u.blackArrow = null;
    if (mark && this.abilities && u.buffs.some((b) => b.group === "blackarrow")) {
      const def = this.abilities.get(mark.abilityId);
      const lvl = def?.levelData[Math.min(mark.rank, def.levelData.length) - 1];
      if (def && lvl && lvl.summon) {
        const count = Math.max(1, Math.round(this.dataOf(lvl, 1, 1)));
        for (let i = 0; i < count; i++) {
          this.summonRequests.push({
            unitId: lvl.summon, x: u.x, y: u.y, facing: u.facing, owner: mark.owner, team: mark.team,
            summonLeft: this.dataOf(lvl, 2, 80), sourceId: mark.sourceId,
            summonArt: def.targetArt, unsummonArt: def.buffEffectArt, atPoint: true,
          });
        }
      }
    }
    // DOOM (`ANdo`): "…until the unit dies, at which point a Doom Guard is summoned in its
    // place." `Ndo2 "Number of Summoned Units"` = 1 of `UnitID1` = nba2 for `Ndo3` = 120
    // seconds, and it belongs to the Pit Lord who cast it, not to the corpse's owner. Same
    // shape as the Black Arrow mark above: the effect IS the death, so the fact rides the
    // victim. `[BNdi] Effectart = …\Other\Doom\DoomDeath.mdl` is the flare it arrives in.
    // A body that goes out stops burning: Immolation is a standing toggle, and leaving it set
    // on a dead unit would relight a revived hero for free (and keep draining his mana).
    if (u.immolation) this.douseImmolation(u);
    const doom = u.doomed;
    u.doomed = null;
    if (doom && this.abilities) {
      const def = this.abilities.get(doom.abilityId);
      const lvl = def?.levelData[Math.min(doom.rank, def.levelData.length) - 1];
      if (def && lvl && lvl.summon) {
        const deathArt = this.abilities.buffFx(lvl.buffs[1] ?? "")[0]?.path ?? def.buffEffectArt;
        for (let i = 0; i < Math.max(1, Math.round(this.dataOf(lvl, 1, 1))); i++) {
          this.summonRequests.push({
            unitId: lvl.summon, x: u.x, y: u.y, facing: u.facing, owner: doom.owner, team: doom.team,
            summonLeft: this.dataOf(lvl, 2, 120), sourceId: doom.sourceId,
            summonArt: deathArt, unsummonArt: def.buffEffectArt, atPoint: true,
          });
        }
      }
    }
    const burn = u.incinerate;
    u.incinerate = null;
    if (burn && this.abilities && u.buffs.some((b) => b.group === "incinerate")) {
      const def = this.abilities.get(burn.abilityId);
      const lvl = def?.levelData[Math.min(burn.rank, def.levelData.length) - 1];
      const src = this.units.get(burn.sourceId);
      if (def && lvl && src) {
        const full = this.dataOf(lvl, 1, 30);
        const radius = this.dataOf(lvl, 4, 240);
        const edge = this.dataOf(lvl, 5, 0.2); // the share still dealt at the rim
        for (const t of this.unitsInAreaInternal(u.x, u.y, radius)) {
          if (t.id === u.id || t.hp <= 0 || !this.hostile(src, t)) continue;
          const k = radius > 0 ? Math.min(1, Math.hypot(t.x - u.x, t.y - u.y) / radius) : 0;
          this.landDamage(t, full * (1 - k * (1 - edge)), burn.sourceId, false);
        }
        if (def.specialArt) this.spellEffects.push({ art: def.specialArt, x: u.x, y: u.y, targetId: 0, z: 0, sound: true });
      }
    }
  }

  private kill(u: SimUnit, killerId = 0): void {
    // A Mirror Image illusion that is destroyed does not die — it pops, with BOmi's
    // Specialart (MirrorImageDeathCaster, whose AOMI SND event is MirrorImageDeath.wav).
    // It must not play the Blademaster's death, which would both look wrong and tell the
    // enemy they had found a copy; and it grants no XP, being nothing but a picture.
    if (u.isIllusion) {
      this.unsummon(u);
      return;
    }
    // Reincarnation (Tauren Chieftain / Elder Sage, AOre): a fatal blow instead
    // revives the hero in place, on a long cooldown (stored on the ability).
    if (this.tryReincarnate(u)) return;
    // A DENY: this unit was killed by its own side. WC3 marks it with a bare "!" floating up
    // from the body in the colour of the player who owned it — the tell that the kill was
    // taken away from the enemy rather than earned by them, and the only feedback the engine
    // gives for it. Raised here, above every other death consequence, because the victim's
    // record is about to be picked apart (and, further down, deleted).
    //
    // Both sides must be real player slots: a creep camp cutting down one of its own is not a
    // deny, and neither is anything Neutral Passive (`hostile` already answers false for a
    // shop or a critter, which would otherwise make every dead sheep flash a mark). The
    // killer must not be the victim — a unit that blows itself up denied nobody.
    const denier = killerId ? this.units.get(killerId) : undefined;
    if (denier && denier.id !== u.id && u.owner >= 0 && denier.owner >= 0 && !this.hostile(denier, u)) {
      this.combatTexts.push({ kind: "deny", unitId: 0, x: u.x, y: u.y, text: "!", colorSlot: u.owner, forPlayer: -1 });
    }
    this.deathBlast(u); // `Adda` — goblin land mines and sappers take the neighbours with them
    this.orbDeathEffects(u); // Black Arrow raises its minion, Incinerate goes off
    this.refundPendingBuild(u); // died before its building went up → refund the cost
    this.unsettle(u); // corpses don't block cells
    this.releaseClaim(u); // …nor does a tile the dead unit was walking onto
    this.releasePathStamp(u); // …and neither does a collapsed building's footprint
    if (u.inMine) {
      const mine = this.mines.get(u.resId);
      if (mine) mine.busy = false; // don't wedge the mine shut forever
    }
    if (u.constructing) this.detachBuilder(u.id); // free the halted construction
    // …and the same in the other direction: a half-built STRUCTURE dying takes its builders off
    // the job. An Orc peon is inside it, and without this it stays in there — hidden, off the
    // field and (since it is off the field) invulnerable — for the rest of the match. Both of
    // the other ways a unit leaves the world, destroyUnit and removeUnit, already did this; the
    // death path was the one that did not, and death is how a building under attack goes.
    //
    // An ANCIENT is the exception, and it is the same rule as the one at the other end: a Wisp
    // that has merged into an Ancient is part of it. "If an Ancient is destroyed while a Wisp
    // is constructing it, the Wisp will also be killed. However, if a Wisp is creating a
    // non-Ancient building such as a Moon Well it will survive" (Warcraft Wiki, Wisp). Killed
    // rather than removed here, unlike the merge at completion: this one IS a death — it is
    // the enemy's kill, and the credit belongs to them.
    if (u.building) {
      const eatsBuilder = u.ancient && u.building.constructionLeft > 0;
      for (const bid of [...u.building.builderIds]) {
        const w = eatsBuilder ? this.units.get(bid) : null;
        this.detachBuilder(bid);
        if (w && w.hp > 0) this.kill(w, killerId);
      }
    }
    // Orc Burrow destroyed with peons inside: they die with it (WC3). Kill them first so
    // each death is recorded, then this burrow's own death proceeds.
    if (u.garrison.length) {
      for (const pid of [...u.garrison]) {
        const p = this.units.get(pid);
        if (p) {
          p.inBurrow = false;
          p.garrisonHost = 0;
          this.kill(p, killerId);
        }
      }
      u.garrison = [];
    }
    // Kodo Devour: a Kodo slain mid-digest spits its prey back out alive; a prey unit that
    // dies inside (fully digested, or the whole Map cleared) frees the Kodo's slot.
    if (u.devouring > 0) {
      const prey = this.units.get(u.devouring);
      if (prey && prey.hp > 0) this.freePrey(prey, u);
    }
    if (u.devouredBy > 0) {
      const kodo = this.units.get(u.devouredBy);
      if (kodo) kodo.devouring = 0;
    }
    // A garrisoned peon dying by any other path leaves its host's roster + rescales it.
    if (u.garrisonHost) {
      const host = this.units.get(u.garrisonHost);
      if (host) {
        host.garrison = host.garrison.filter((id) => id !== u.id);
        this.recomputeStats(host);
      }
    }
    this.awardKillXp(u, killerId); // enemy heroes near the kill gain experience
    this.awardBounty(u, killerId); // ...and the killer's player is paid the body's bounty
    this.rollCreepDrops(u); // creeps scatter their dropped-item table on death
    this.dropInventory(u); // a dying non-hero inventory-unit drops its held items
    // A carrier that dies SPILLS: the bodies it was hauling land where the wreck does. They
    // were never consumed — a Meat Wagon borrows corpses, it does not use them up — so
    // deleting them with it would destroy something that still belongs to the field. (The
    // same call covers a wagon removed outright; see removeUnit.)
    this.dropHeldCorpses(u.id, u.x, u.y);
    this.spawnCorpse(u); // leave a decaying corpse (targetable by corpse spells)
    // A hero has fallen, and the whole army is told. Raised HERE rather than off the death
    // event stream because that one only runs when a script is listening (captureDeaths) —
    // and a melee match, which is exactly where this line matters, listens to nothing.
    // Reincarnation and an illusion popping both returned long before this point, so
    // neither is announced: nothing has actually been lost.
    if (u.isHero) {
      const killer = killerId ? this.units.get(killerId) : undefined;
      this.alerts.push({
        kind: "herodeath", player: u.owner, x: u.x, y: u.y,
        hero: { properName: u.properName, typeId: u.typeId, level: u.level },
        killer: killer?.isHero ? { properName: killer.properName, typeId: killer.typeId } : undefined,
      });
      this.recordFallenHero(u);
    }
    this.releaseEntangled(u); // an Entangled Gold Mine knocked down hands the mine back
    // The body goes on seeing while it falls — read off the unit here, one line before it
    // stops existing (issue #126; see revealDyingUnit).
    this.revealDyingUnit(u);
    this.units.delete(u.id); // Map delete during values() iteration is safe
    this.deaths.push(u.id);
    // …and anything BOUND to it goes with it — "Lasts 50 seconds or until the avatar dies".
    // Death does not run through removeUnit (a corpse stays behind, a hero goes to the
    // altar), so the sweep has to be asked for on both paths.
    this.dismissBoundSummons(u.id);
    // A structure is kept WHOLE, not just as an id: a player who cannot see this spot must go
    // on being shown the building until they re-scout it, and the id above resolves to nothing
    // the moment the delete on the previous line runs. See drainDeadStructures.
    if (u.building != null) this.deadStructures.push(u);
    // Record a death event for the trigger engine (Phase 7 — EVENT_UNIT_DEATH /
    // EVENT_PLAYER_UNIT_DEATH). Only when a script is listening (captureDeaths), so a
    // melee match with no trigger pump doesn't accumulate these. Snapshot both units
    // now — the victim is gone from `units` next tick, and the killer may move/die.
    if (this.captureDeaths) {
      const killer = killerId ? this.units.get(killerId) : undefined;
      this.deathEvents.push({ victim: eventInfo(u), killer: killer ? eventInfo(killer) : null });
    }
    this.unitDrops.delete(u.id);
  }

  // === items ================================================================

  /** Register a creep's dropped-item table (from war3mapUnits.doo), rolled when it
   *  dies. Called by the game layer as it seeds each Neutral Hostile creep. */
  setUnitDrops(id: number, sets: ItemDropSet[]): void {
    if (sets.length) this.unitDrops.set(id, sets);
  }

  /** Hand this unit's loot back to the map script. The script owns the drop when it watches
   *  the unit's death: the World Editor compiles the .doo drop table into war3map.j, so both
   *  copies describe the SAME loot and rolling both drops it twice. See syncEventCaptures. */
  clearUnitDrops(id: number): void {
    this.unitDrops.delete(id);
  }

  /** Roll a dead unit's drop table and scatter the results on the ground. Each SET
   *  drops at most one item, chosen among its entries by their `chance` percentages
   *  (WC3 dropped-item-set semantics); leftover probability = no drop. */
  private rollCreepDrops(u: SimUnit): void {
    const sets = this.unitDrops.get(u.id);
    if (!sets || !this.itemReg) return;
    let n = 0;
    for (const set of sets) {
      let roll = this.rng() * 100;
      let chosen: string | null = null;
      for (const entry of set.items) {
        if (roll < entry.chance) { chosen = entry.id; break; }
        roll -= entry.chance;
      }
      if (!chosen) continue;
      const def = this.itemReg.resolveDrop(chosen, this.rng);
      if (!def) continue;
      // Fan multiple drops out around the corpse so they don't stack on one spot.
      const ang = (n * 2.399963) % (Math.PI * 2); // golden-angle spread
      const r = n === 0 ? 0 : 48;
      this.spawnGroundItem(def.id, u.x + Math.cos(ang) * r, u.y + Math.sin(ang) * r, def.charges);
      n++;
    }
  }

  /** A dying inventory-holder scatters its held items on the ground. Each one keeps its
   *  entity id (it's the same item, now lying down) and raises DROP_ITEM.
   *
   *  A HERO is the exception, and it is the important one: a dead hero in WC3 keeps its
   *  whole inventory and walks back out of the altar still carrying it. Dropping a hero's
   *  items would hand the killer six free artifacts and is not how the game plays. Only
   *  non-hero inventory units (the `AInv` ability on a normal unit) drop what they carry. */
  private dropInventory(u: SimUnit): void {
    if (u.isHero) return; // items ride with the hero through death and revival
    let n = 0;
    for (let i = 0; i < u.inventory.length; i++) {
      const held = u.inventory[i];
      if (!held) continue;
      u.inventory[i] = null;
      const ang = (n * 2.399963) % (Math.PI * 2);
      this.spawnGroundItem(held.itemId, u.x + Math.cos(ang) * 64, u.y + Math.sin(ang) * 64, held.charges, held.id);
      this.noteItem(u, held, "drop");
      n++;
    }
  }

  /** Create a ground item at a point (queued for the renderer to model). The
   *  position is snapped to a pathing-grid cell centre so items always rest on a
   *  grid slot (WC3 behaviour) rather than at arbitrary sub-cell offsets. `reuseId`
   *  puts an item that already exists as an entity (one dropped from an inventory)
   *  back on the ground AS ITSELF: identity survives the move, so a JASS `item` handle
   *  taken before the drop still refers to it (7.18). */
  private spawnGroundItem(itemId: string, x: number, y: number, charges: number, reuseId = 0): SimItem {
    const [sx, sy] = this.snapItemPos(x, y);
    const it: SimItem = { id: reuseId || this.nextItemId++, itemId, x: sx, y: sy, charges };
    this.items.set(it.id, it);
    this.itemSpawns.push(it);
    return it;
  }

  /** Snap a world point to the centre of its pathing-grid cell. */
  private snapItemPos(x: number, y: number): [number, number] {
    const [ox, oy] = this.grid.origin;
    return [
      ox + (Math.floor((x - ox) / PATHING_CELL) + 0.5) * PATHING_CELL,
      oy + (Math.floor((y - oy) / PATHING_CELL) + 0.5) * PATHING_CELL,
    ];
  }

  /** New ground items since the last drain (renderer creates their models). */
  drainItemSpawns(): SimItem[] {
    if (!this.itemSpawns.length) return this.itemSpawns;
    const out = this.itemSpawns;
    this.itemSpawns = [];
    return out;
  }

  /** Ground items removed since the last drain (renderer drops their models). `died`
   *  asks the renderer to play the model's DEATH clip in place rather than snapping it
   *  out — see removeGroundItem. */
  drainItemRemovals(): Array<{ id: number; died: boolean }> {
    if (!this.itemRemovals.length) return this.itemRemovals;
    const out = this.itemRemovals;
    this.itemRemovals = [];
    return out;
  }

  /** Take a ground item off the world. `died` = it was CONSUMED where it lay, so the
   *  renderer plays the model's Death clip (which is also what spawns the little puff:
   *  every powerup model carries an `SPN…TOBO` → ToonBoom event on its Death track, and
   *  the Chest of Gold an `SPN…GDCR` → GoldCredit one — verified 1.27a). It is NOT set
   *  for the plumbing removals: an item that merely MOVES is removed and re-modelled at
   *  the new spot (see moveItem), and dying there would puff on every reposition. */
  private removeGroundItem(id: number, died = false): void {
    if (this.items.delete(id)) this.itemRemovals.push({ id, died });
  }

  /** The ground item nearest a world point within `radius`, or null (for click-to-
   *  pick-up hit-testing). */
  itemAt(x: number, y: number, radius = 64): SimItem | null {
    let best: SimItem | null = null;
    let bestD = radius;
    for (const it of this.items.values()) {
      const d = Math.hypot(it.x - x, it.y - y);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  /** Order a hero to walk to a ground item and pick it up. */
  issueGetItem(unitId: number, itemId: number): boolean {
    const u = this.units.get(unitId);
    const it = this.items.get(itemId);
    if (!u || !it || !u.inventory.length || this.castLocked(u)) return false;
    u.getItemId = itemId;
    u.pendingGive = null;
    u.pendingSell = null;
    u.order = "getitem";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(unitId);
    if (Math.hypot(it.x - u.x, it.y - u.y) <= u.radius + ITEM_PICKUP_RANGE) {
      this.pickUpItem(u, it);
      this.stop(unitId);
    } else {
      this.pathTo(u, it.x, it.y);
    }
    return true;
  }

  /** Order a hero to walk to another hero and hand over the item in `slot`. */
  /** Order a hero to SELL a held item to `shopId` — WC3's gesture is the same one that drops
   *  an item (right-click it in the inventory, then click the target); clicking a shop instead
   *  of the ground sells it. The hero walks over first: pawning has its own, shorter reach
   *  (PawnItemRange 300) than buying does. False if the shop doesn't deal in items at all. */
  issueSellItem(unitId: number, slot: number, shopId: number): boolean {
    const u = this.units.get(unitId);
    const shop = this.units.get(shopId);
    if (!u || !shop || !u.inventory[slot] || !this.canPawnAt(shop) || this.castLocked(u)) return false;
    const def = this.itemReg?.get(u.inventory[slot]!.itemId);
    if (!def?.pawnable) return false;
    u.pendingSell = { shopId, slot };
    u.pendingGive = null;
    u.pendingDrop = null;
    u.getItemId = 0;
    u.order = "getitem";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    // Walk to the shop's NEAR EDGE, never its centre — that cell is inside the footprint and
    // unwalkable, so a path to it fails and the hero just stands there holding the item.
    if (!this.inPawnRange(u, shop)) {
      const [ax, ay] = this.shopApproach(u, shop);
      this.pathTo(u, ax, ay);
    }
    return true;
  }

  /** Does this building DEAL IN ITEMS — i.e. may a hero pawn one to it? The data says so
   *  outright: every item shop carries the `Apit` ability ("Shop Purchase Item") — the
   *  Marketplace, the Goblin Merchant, the Arcane Vault, the Tomb of Relics — and the two
   *  shops that trade in UNITS, the Tavern (`ntav`) and the Mercenary Camp (`nmer`), do not.
   *  So you cannot sell a Claws of Attack at a Tavern, and asking the ability rather than the
   *  ware list is what lets you sell to a Marketplace whose shelves are still empty. */
  canPawnAt(shop: SimUnit): boolean {
    if (shop.hp <= 0 || !this.abilities) return false;
    const def = this.unitReg?.get(shop.typeId);
    return !!def?.abilities.some((id) => this.abilities?.get(id)?.code === "Apit");
  }

  private inPawnRange(u: SimUnit, shop: SimUnit): boolean {
    return Math.hypot(u.x - shop.x, u.y - shop.y) <= MISC_GAME.PawnItemRange + shop.radius;
  }

  /** A standing spot on the shop's near side, OUTSIDE its pathing footprint. A building's
   *  collision `radius` is far smaller than the block it actually stamps (the Goblin Merchant's
   *  radius is 50, its footprint several times that), so aiming at centre-plus-radius — as the
   *  depot approach does for a town hall — lands the goal inside solid ground, the path fails,
   *  and the hero stands there holding the item he was told to sell. Pawning reaches 300, so
   *  stopping at the footprint's edge is comfortably close enough to trade. */
  private shopApproach(u: SimUnit, shop: SimUnit): [number, number] {
    const dx = u.x - shop.x;
    const dy = u.y - shop.y;
    const d = Math.hypot(dx, dy) || 1;
    const half = Math.max(shop.radius, ((shop.footprint || 2) * PATHING_CELL) / 2);
    const reach = half + u.radius + PATHING_CELL;
    return [shop.x + (dx / d) * reach, shop.y + (dy / d) * reach];
  }

  issueGiveItem(fromId: number, slot: number, toId: number): boolean {
    const u = this.units.get(fromId);
    const to = this.units.get(toId);
    if (!u || !to || !u.inventory[slot] || !to.inventory.length || this.castLocked(u)) return false;
    u.pendingGive = { toId, slot };
    u.getItemId = 0;
    u.order = "getitem";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    if (Math.hypot(to.x - u.x, to.y - u.y) <= u.radius + to.radius + ITEM_GIVE_RANGE) {
      this.transferItem(u, slot, to);
      this.stop(fromId);
    } else {
      this.pathTo(u, to.x, to.y);
    }
    return true;
  }

  /** Drive the "getitem" order: walk to the ground item (or target hero) and, once
   *  close enough, pick it up / hand it over. */
  private tickGetItem(u: SimUnit): void {
    if (u.pendingDrop) {
      const { slot, x, y } = u.pendingDrop;
      if (!u.inventory[slot]) { this.stop(u.id); return; } // slot emptied meanwhile
      if (Math.hypot(x - u.x, y - u.y) <= ITEM_DROP_RANGE + u.radius) {
        this.doDropItem(u, slot, x, y);
        this.stop(u.id);
      } else if (!u.moving) {
        this.pathTo(u, x, y);
      }
      return;
    }
    if (u.pendingGive) {
      const to = this.units.get(u.pendingGive.toId);
      if (!to || to.hp <= 0 || !u.inventory[u.pendingGive.slot]) { this.stop(u.id); return; }
      if (Math.hypot(to.x - u.x, to.y - u.y) <= u.radius + to.radius + ITEM_GIVE_RANGE) {
        this.transferItem(u, u.pendingGive.slot, to);
        this.stop(u.id);
      } else if (!u.moving) {
        this.pathTo(u, to.x, to.y);
      }
      return;
    }
    // Walking to a shop to sell (issueSellItem). Pawning reaches only PawnItemRange (300), so
    // the hero closes the distance first — exactly as he walks over to drop an item.
    if (u.pendingSell) {
      const shop = this.units.get(u.pendingSell.shopId);
      if (!shop || shop.hp <= 0 || !u.inventory[u.pendingSell.slot]) { this.stop(u.id); return; }
      if (this.inPawnRange(u, shop)) {
        this.pawnItem(u.id, u.pendingSell.slot, shop.id);
        this.notifyCreepsOfShopUse(shop, u, MISC_GAME.ItemSaleAggroRange); // using a neutral shop is loud
        this.stop(u.id);
      } else if (!u.moving) {
        const [ax, ay] = this.shopApproach(u, shop);
        this.pathTo(u, ax, ay);
      }
      return;
    }
    const it = this.items.get(u.getItemId);
    if (!it) { this.stop(u.id); return; } // item gone (someone else grabbed it)
    if (Math.hypot(it.x - u.x, it.y - u.y) <= u.radius + ITEM_PICKUP_RANGE) {
      this.pickUpItem(u, it);
      this.stop(u.id);
    } else if (!u.moving) {
      this.pathTo(u, it.x, it.y); // arrived-but-not-close (blocked) or needs a repath
    }
  }

  /** Put a ground item into a hero's inventory. `wantSlot` >= 0 demands THAT slot and
   *  fails if it's taken (UnitAddItemToSlotById is exact — it does not fall back to a free
   *  slot); -1 takes the first free one, which is what walking over an item does. Powerups
   *  (tomes, runes, gold) are consumed instantly instead of stored. False if there's no
   *  room. Raises PICKUP_ITEM — a powerup fires it too (WC3 picks the tome up, then
   *  consumes it). */
  private pickUpItem(u: SimUnit, it: SimItem, wantSlot = -1): boolean {
    // A Mirror Image illusion carries no inventory of its own and cannot take anything off
    // the ground — it would be handing the real hero's items to a copy that is about to
    // expire. Blocked here rather than at the order, because every route in (walking over
    // an item, a right-click, a trigger's UnitAddItem) funnels through this one door.
    if (u.isIllusion) return false;
    if (!this.itemReg) return false;
    const def = this.itemReg.get(it.itemId);
    if (!def) { this.removeGroundItem(it.id); return true; }
    if (def.powerup) {
      this.noteItem(u, it, "pickup");
      this.applyPowerup(u, def);
      // A consumed powerup DIES where it lay — it doesn't just vanish. Playing the model's
      // Death clip is what gives the tome its little burst on the ground (the clip carries
      // the ToonBoom spawn event), and it is the reason `died` exists at all.
      this.removeGroundItem(it.id, true);
      return true;
    }
    const slot = wantSlot >= 0
      ? (wantSlot < u.inventory.length && !u.inventory[wantSlot] ? wantSlot : -1)
      : u.inventory.indexOf(null);
    if (slot < 0) return false; // inventory full (or that slot taken) — leave it on the ground
    u.inventory[slot] = { id: it.id, itemId: it.itemId, charges: it.charges, cooldownLeft: 0 };
    this.removeGroundItem(it.id);
    this.noteItem(u, it, "pickup");
    this.recomputeStats(u); // reflect any stat bonus immediately
    return true;
  }

  /** Hand a held item from one hero to another (drops to the ground if the
   *  recipient's inventory is full). WC3 raises BOTH events for a hand-over: the giver
   *  DROPs the item and the receiver PICKs it UP. */
  private transferItem(from: SimUnit, slot: number, to: SimUnit): void {
    // An illusion's inventory is a picture of the original's: it is there to be SEEN and to
    // grant the same stat bonuses, and nothing more. The items are inert copies with no
    // entity behind them (see initIllusion), so letting a copy move one would either
    // duplicate the original's gear or hand out an item that does not exist.
    if (from.isIllusion) return;
    const held = from.inventory[slot];
    if (!held) return;
    const dest = to.inventory.indexOf(null);
    if (dest < 0) { this.spawnGroundItem(held.itemId, to.x, to.y, held.charges, held.id); }
    else { to.inventory[dest] = { id: held.id, itemId: held.itemId, charges: held.charges, cooldownLeft: 0 }; }
    from.inventory[slot] = null;
    from.pendingGive = null;
    from.pendingSell = null;
    this.noteItem(from, held, "drop");
    this.noteItem(to, held, "pickup");
    this.recomputeStats(from);
    this.recomputeStats(to);
  }

  /** Drop a held item onto the ground at a point (WC3 manual item drop). WC3's
   *  "Item Drop Distance" gameplay constant (150) is the reach: a spot within range
   *  drops immediately; a spot further out makes the unit WALK toward it and drop
   *  once the spot comes within range (handled in tickGetItem). */
  dropItem(unitId: number, slot: number, x: number, y: number): boolean {
    const u = this.units.get(unitId);
    if (!u || slot < 0 || slot >= u.inventory.length) return false;
    const held = u.inventory[slot];
    if (!held) return false;
    if (Math.hypot(x - u.x, y - u.y) <= ITEM_DROP_RANGE + u.radius) {
      this.doDropItem(u, slot, x, y);
      return true;
    }
    // Out of reach: walk to the spot and drop it when it comes within drop range.
    u.pendingDrop = { slot, x, y };
    u.getItemId = 0;
    u.pendingGive = null;
    u.pendingSell = null;
    u.order = "getitem";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(unitId);
    this.pathTo(u, x, y);
    return true;
  }

  /** Actually place a slot's item on the ground at (x,y) and clear the slot. The item
   *  keeps its entity id (same item, now on the ground) and raises DROP_ITEM. */
  private doDropItem(u: SimUnit, slot: number, x: number, y: number): void {
    // An illusion's inventory is a picture of the original's: it is there to be SEEN and to
    // grant the same stat bonuses, and nothing more. The items are inert copies with no
    // entity behind them (see initIllusion), so letting a copy move one would either
    // duplicate the original's gear or hand out an item that does not exist.
    if (u.isIllusion) return;
    const held = u.inventory[slot];
    if (!held) return;
    u.inventory[slot] = null;
    u.pendingDrop = null;
    this.spawnGroundItem(held.itemId, x, y, held.charges, held.id);
    this.noteItem(u, held, "drop");
    this.recomputeStats(u);
  }

  /** Swap (or move) two inventory slots on the same unit. */
  swapItems(unitId: number, a: number, b: number): boolean {
    const u = this.units.get(unitId);
    if (u?.isIllusion) return false; // a copy's inventory is a picture — it cannot be rearranged
    if (!u || a === b || a < 0 || b < 0 || a >= u.inventory.length || b >= u.inventory.length) return false;
    const tmp = u.inventory[a];
    u.inventory[a] = u.inventory[b];
    u.inventory[b] = tmp;
    return true;
  }

  /** Use an active item in a slot (potion/scroll). Returns true if it fired (a
   *  charge was consumed / a cooldown started). Dispatches on the granted ability's
   *  base `code`, like spells. */
  useItem(unitId: number, slot: number, targetId: number, x: number, y: number): boolean {
    // …and a copy cannot USE one either: no potion, no scroll, no charge spent. Its items
    // are not the original's, so drinking one would heal off a bottle nobody owns — and the
    // charge would not come off the real hero's.
    const u = this.units.get(unitId);
    if (!u || u.isIllusion || !this.itemReg || !this.abilities) return false;
    const held = u.inventory[slot];
    if (!held || held.cooldownLeft > 0) return false;
    const def = this.itemReg.get(held.itemId);
    if (!def || !def.usable) return false;
    // The active behaviour is the first granted ability with a code we handle.
    for (const abilId of def.abilities) {
      const ad = this.abilities.get(abilId);
      if (!ad) continue;
      const fired = this.applyItemAbility(u, ad, held, targetId, x, y);
      if (fired === "unhandled") continue; // ability we don't handle — try the next one
      if (!fired) return false; // handled code but nothing to do (already full) — no charge spent
      this.consumeItemUse(u, slot, def, ad.levelData[0]?.cooldown || 0);
      // USE_ITEM is raised AFTER the charge is spent: GetItemCharges inside a use trigger
      // reports what's left, which is what the classic "give the item its charge back to
      // make it infinite" JASS idiom relies on (SetItemCharges(GetManipulatedItem(), n+1)).
      this.noteItem(u, held, "use");
      return true;
    }
    return false;
  }

  /**
   * Run ONE item ability's effect on `u` — the single dispatcher behind both ways an item's
   * effect can be reached (issue #130), because they are the same effect:
   *
   *   • PRESSED out of the inventory (useItem) — a potion, a scroll, a wand, a staff;
   *   • CONSUMED on pickup (applyPowerup) — a tome, a rune, a glyph, a chest of gold.
   *
   * The game ships several abilities BOTH ways round and expects one behaviour from them:
   * `AIha` is the Scroll of Healing and the three Runes of Healing, `AIsa` the Scroll and the
   * Rune of Speed, `AIdi` the Wand of Negation and the Rune of Dispel Magic. Keeping a
   * separate switch per path is what left the scroll half of each pair doing nothing at all.
   *
   * Returns `"unhandled"` when no code here (and no SPELL_HANDLERS entry) knows this ability,
   * so the caller can try the item's next one; `false` when it was understood but there was
   * nothing to do, which is what refuses a Potion of Healing at full health WITHOUT spending
   * its charge; `true` when it fired.
   */
  private applyItemAbility(u: SimUnit, ad: AbilityDef, held: HeldItem | null, targetId: number, x: number, y: number): boolean | "unhandled" {
    if (!this.abilities) return "unhandled";
    {
      const lvl = ad.levelData[0];
      const d = (i: number) => (lvl?.data[i] === undefined || Number.isNaN(lvl.data[i]) ? 0 : lvl.data[i]);
      let fired = false;
      switch (ad.code) {
        // The four INSTANT restore codes, which differ only in which columns they fill and
        // how far they reach — so one helper serves all of them and the reach comes off each
        // row's own `Area1`/`targs1` rather than being assumed (see itemAreaTargets).
        //
        //   `AIhe` Potion of Healing, Health Stone, Essence of Aszune   DataA hp, no area
        //   `AIma` Potion of Mana, Mana Stone                           DataA mana, no area
        //   `AIha` Scroll of Healing (and the three Runes of Healing)   DataA hp, Area 600
        //   `AImr` Scroll of Mana (and the two Runes of Mana)           DataA mana, Area 600
        //   `AIra` Scroll of Restoration (and the Rune)                 DataA hp + DataB mana
        //
        // The last three used to exist only on the powerup path, so the three SCROLLS — a
        // Scroll of Healing is on every shop's front row — did nothing at all when pressed
        // (issue #130). They are the same ability as their runes and now share the handler.
        // === The PERMANENT pickups — a tome is not an effect, it is a change ===
        // Attribute tomes (dataA=agi, dataB=int, dataC=str) — permanent, so bump the BASE
        // attribute. The HP/mana the new points confer needs no hand-adding: recomputeStats
        // raises the ceiling and carries the current pool up with it in proportion, the same
        // rule every other ceiling move obeys (see recomputeStats).
        case "AIam": case "AIim": case "AIsm": case "AIxm":
          u.baseAgi += d(0); u.baseInt += d(1); u.baseStr += d(2);
          this.recomputeStats(u);
          fired = true;
          break;
        case "AImi": u.baseMaxHp += d(0); this.recomputeStats(u); fired = true; break; // Manual of Health
        case "AIem": if (u.isHero) { this.gainXp(u, d(0)); fired = true; } break; // Tome of Experience
        case "AIgo": this.stashOf(u.owner).gold += d(0); fired = true; break; // Gold Coins
        case "AIlu": this.stashOf(u.owner).lumber += d(0); fired = true; break; // Bundle of Lumber
        case "AIhe": fired = this.itemRestore(u, ad, 0, -1); break;
        case "AIma": fired = this.itemRestore(u, ad, -1, 0); break;
        case "AIha": fired = this.itemRestore(u, ad, 0, -1); break;
        case "AImr": fired = this.itemRestore(u, ad, -1, 0); break;
        case "AIra": fired = this.itemRestore(u, ad, 0, 1); break;
        // Healing Salve / Clarity Potion / Potion & Scroll of Rejuvenation — restore over
        // TIME, not at once. DataA is the total hit points and DataB the total mana the
        // effect is worth across `Dur1`, so the per-second rate is the total over the
        // duration: the Healing Salve's 400 HP / 45s, the greater Clarity Potion's 200 mana
        // / 45s, a Scroll of Rejuvenation's 250 + 100 (1.27a Units\AbilityData.slk).
        //
        // Which buff the unit visibly wears is the ability's own choice among the three it
        // lists (`BuffID1 = BIrg,BIrl,BIrm`): life-and-mana, life alone, mana alone. So the
        // numbers pick it — a salve with no DataB wears BIrl and shows only the green swirl.
        //
        // WHO it lands on is the row's own business, and the three shapes it takes are the
        // reason this reads its reach rather than assuming the user (issue #130):
        //
        //   `AIsl` Scroll of Regeneration  Area1 600, targs `…friend,self,organic…`  → the AREA
        //   `AIrl` Healing Salve           Rng1 500,  same targs, no Area1           → a UNIT
        //   `AIp*`/`AIpr`/`AIpl`           neither                                  → the user
        //
        // and each states it in words too: the scroll's Ubertip says "all friendly
        // non-mechanical units in an area around your Hero", the salve's "a target unit's hit
        // points", the Clarity Potion's "the Hero's mana". Applying every one of them to the
        // drinker turned the scroll into a potion — which is the bug this issue opens with.
        case "AIrg": {
          const seconds = lvl?.duration || 0;
          const hp = d(0);
          const mana = d(1);
          if (seconds <= 0 || (hp <= 0 && mana <= 0)) break;
          // A unit is only AIMED AT when the row carries a cast range to aim over. The Clarity
          // Potion has neither `Area1` nor `Rng1`, so a stray target id (a click that happened
          // to land on somebody) must not redirect the drink.
          const aimed = targetId && (lvl?.castRange ?? 0) > 0 ? this.units.get(targetId) : undefined;
          const targets = (lvl?.area ?? 0) > 0
            ? this.itemAreaTargets(u, ad)
            : [aimed && this.targetAllowed(u, aimed, ad.targetFlags) === null ? aimed : u];
          const buffId = hp > 0 && mana > 0 ? "BIrg" : hp > 0 ? "BIrl" : "BIrm";
          const fx = this.abilities.buffFx(buffId);
          // …and that same choice is the icon the info panel's Status line shows: a salve's
          // BTNHealingSalve, a Clarity Potion's BTNPotionOfClarity, a Rejuvenation scroll's
          // BTNGreaterRejuvScroll — one row, one art, one name ("Regeneration").
          for (const t of targets) {
            // Nothing to restore = nothing to spend. WC3 refuses a salve at full health — and
            // for an area scroll that means refusing only when NOBODY in the circle wants it.
            if (hp > 0 && mana <= 0 && t.hp >= t.maxHp) continue;
            if (mana > 0 && hp <= 0 && t.mana >= t.maxMana) continue;
            if (hp > 0 && mana > 0 && t.hp >= t.maxHp && t.mana >= t.maxMana) continue;
            if (hp > 0) {
              this.applyBuffInternal(t, {
                kind: "hot", group: ITEM_REGEN_GROUP, timeLeft: seconds, sourceId: u.id,
                value: hp / seconds, value2: 0, fx, buffId,
              });
            }
            if (mana > 0) {
              this.applyBuffInternal(t, {
                kind: "manaRegen", group: `${ITEM_REGEN_GROUP}:mana`, timeLeft: seconds, sourceId: u.id,
                value: mana / seconds, value2: 0, fx: hp > 0 ? [] : fx, buffId, // one set of models, not two
              });
            }
            fired = true;
          }
          break;
        }
        case "AIvu": // Potion of Invulnerability → brief invulnerability (`Bvul`, "Invulnerable")
          this.applyBuffInternal(u, { kind: "invuln", group: "item:invuln", timeLeft: lvl?.duration || 15, sourceId: u.id, value: 0, value2: 0, buffId: buffIdOf(ad) });
          fired = true;
          break;
        // The corpse-spending items are not item behaviour at all — they are the SPELL, with
        // the item's own numbers on it, so they run the spell's handler rather than a second
        // copy of it here. The Rod of Necromancy IS Raise Dead (`AIrd` carries `code = AIrd`
        // but the identical Rai1..Rai4 columns: 2 skeletons of `uske` a body, for 65 seconds
        // instead of the Necromancer's 45), and the two Runes of Resurrection ARE Resurrection
        // (`APrl`/`APrr` carry `code = AHre` outright, DataA 1 and 3). Wiring them through
        // applySpellEffect is what keeps the corpse rules — whose dead, hero corpses, one
        // taker per body — in the one place that owns them (see sim/corpses.ts).
        case "AIrd": // Rod of Necromancy         → Raise Dead
        case "ACad": // Scroll of the Dead (`stre`) → Animate Dead
        case "AIan": // Scroll of Animate Dead      → Animate Dead
        case "AIrs": // Scroll of Resurrection      → Resurrection
        case "AHre": { // …and the two Runes, which carry `code = AHre` outright
          // …including the corpse gate itself. No body, no cast and NO CHARGE: `fired` is left
          // false, so consumeItemUse below never runs and a Rod of Necromancy waved over bare
          // ground still has all its charges (the UI says why — see itemUseError).
          const code = ITEM_CORPSE_SPELL[ad.code] ?? ad.code;
          if (this.corpseRefusal(u, ad, ad.levelData[0], u.x, u.y)) break;
          this.applySpellEffect(code, 1, u, { targetId: 0, x, y }, ad);
          fired = true;
          break;
        }
        case "AEbl": { // Kelen's Dagger of Escape → blink to a point within range
          // The same rule the spell keeps: the unplayable black is not a place to land, and
          // a dagger waved at it keeps its charge (issue #117 — `fired` stays false below).
          if (!this.inPlayableArea(x, y)) break;
          const range = d(0) || 1000;
          const dist = Math.hypot(x - u.x, y - u.y);
          const s = dist > range ? range / dist : 1;
          const tx = u.x + (x - u.x) * s;
          const ty = u.y + (y - u.y) * s;
          this.unsettle(u);
          u.x = tx; u.y = ty;
          u.path = []; u.moving = false; u.waypoint = 0;
          this.settle(u);
          fired = true;
          break;
        }
        // The two STAVES that send a unit home: Staff of Preservation (`spre` → `ANpr`) and
        // Staff of Sanctuary (`ssan` → `ANsa`). One ability shape, two payloads — see
        // staffSendHome for the shared half and the Sanctuary buff below for the rest.
        case "ANpr":
        case "ANsa": {
          const t = this.units.get(targetId);
          if (!t || this.staffTargetError(u, ad, t) !== null) break;
          const dest = this.staffDestination(t.owner, d(0));
          if (!dest) break;
          // Art, in the roles Blizzard's own comments in ItemAbilityFunc.txt spell out for
          // the sibling Staff of Teleportation: `Casterart` on whoever waved the staff,
          // `Targetart` on the traveller where it LEAVES from, `Specialart` on it where it
          // ARRIVES. All three are the Mass Teleport set — the staves borrow it wholesale.
          //
          // And so is the SOUND: the teleport whoosh, which is `MassTeleportTarget.wav`, the
          // one WAV in that folder. Neither staff names an `Effectsound`, so it is resolved
          // off the effect model like every other spell's (see playSpellSound) — the models'
          // own embedded SND event if they carry one, else the folder WAV, which
          // MassTeleportCaster.mdx also reaches through folderSounds' folder-name pass.
          //
          // It rides the TRAVELLER, at both ends of the hop, not the staff-bearer: those are
          // two different places, the whoosh belongs to the unit that moved, and the two are
          // positional so distance already decides which one you actually hear. Sounding the
          // caster's flourish too would be a third copy of one clip in the same instant.
          this.emitEffectAt(ad.casterArt, u.x, u.y);
          this.emitEffectAt(ad.targetArt, t.x, t.y, true);
          this.teleportUnit(t, dest.x, dest.y);
          this.emitEffectAt(ad.specialArt, t.x, t.y, true);
          this.stop(t.id); // it arrives idle, not still walking the errand it was pulled off
          if (ad.code === "ANsa") {
            // Sanctuary's payload (`ANsa` DataB/DataC/DataE, named by AbilityMetaData.slk's
            // Nsa2/Nsa3/Nsa5 rows through WorldEditStrings): "Hero Regeneration Delay" 1,
            // "Unit Regeneration Delay" 5, "Hit Points Per Second" 15 — the last of which the
            // item's own tooltip prints as `<ANsa,DataE1>`. The delay is the beat between
            // landing and the healing engaging; a hero waits 1s, everything else 5s.
            //
            // Both halves run `untilHealed` rather than on a duration, and `ANsa` carries no
            // Dur1 to run on anyway: "Lasts until the unit is fully healed" (Liquipedia).
            // The regeneration STACKS (same page), so it takes no group — a second staff adds
            // a second 15 hp/sec — while the stun takes one, since two stuns are one stun.
            const delay = t.isHero ? d(1) : d(2);
            // fx(ad) is BNsa's own art — Staff_Sanctuary_Target.mdx, worn for as long as the
            // effect runs — plus the buff id the info panel's Status row reads its icon,
            // name and "cannot move, attack or cast spells" tooltip off.
            this.applyBuffInternal(t, { kind: "hot", timeLeft: Infinity, sourceId: u.id, value: d(4), delay, untilHealed: true, ...fx(ad) });
            // The stun wears no art of its own: one set of models, not two (see the salve).
            this.applyBuffInternal(t, { kind: "stun", group: "ANsa", timeLeft: Infinity, sourceId: u.id, buffId: buffIdOf(ad), untilHealed: true });
            this.recomputeStats(t); // pinned from this instant, not from the next tick
          }
          fired = true;
          break;
        }
        // === The WORLD-LEVEL items ===========================================
        // Each of these reaches for something no spell handler can see — the clock, the
        // terrain, the tech graph, the hero's own progression — so each keeps its own small
        // method here rather than a place in SPELL_HANDLERS.
        case "AIct": fired = this.itemArtificialNight(ad); break; // Moonstone
        case "AItp": fired = this.itemTownPortal(u, ad, x, y); break; // Scroll of Town Portal
        case "AIrt": // Amulet of Recall …
        case "AUds": fired = this.itemRecall(u, ad, x, y); break; // …and the Diamond of Summoning
        case "Ablp": fired = this.itemBlight(u, ad, x, y); break; // Sacrificial Skull
        case "AIbl": fired = this.itemBuild(u, ad, x, y); break; // the eight "Tiny" buildings
        case "AIlm": fired = this.itemLevelGain(u, ad); break; // Tome of Power
        case "Aret": fired = this.itemRetrain(u); break; // Tome of Retraining
        case "AIgl": fired = this.itemGlyph(u, ad); break; // Glyph of Fortification / Ultravision
        // Soul Gem — the one item whose effect is recorded against the ITEM the user is
        // holding, so it is only reachable from the press (a powerup has no held item).
        case "AIso": fired = !!held && this.itemSoulGem(u, held, targetId); break;
        // MECHANICAL CRITTER (`Amec`) — "Creates a player-controlled critter that can be used
        // to scout enemies." `DataA "Number of Units Created"` = 1, no Dur1 at all (it is
        // permanent, not a timed summon).
        //
        // Here rather than in SPELL_HANDLERS for one reason: its row names NO unit. `UnitID1`
        // is empty and no "Mechanical Critter" unit type exists anywhere in the install — the
        // engine picks the map's own critter and nothing in the data says which. So the item
        // does nothing and KEEPS ITS ONE CHARGE (`mcri` is uses 1, perishable 1) rather than
        // vanishing to summon something we invented. A custom map that fills the column in
        // gets its critter.
        case "Amec": fired = this.itemSummonUnits(u, ad, 0); break;
        // The FLAGS (`AIfe`/`AIfl`/`AIfm`/`AIfn`/`AIfo`) — Human/Orc/Night Elf/Undead Flag and
        // the orc Battle Standard. Their ability rows are EMPTY: no duration, no data, no
        // buff, no targets. That is not a gap in our reading, it is what the item is — "an
        // object that is often captured in special scenarios as a win condition", carried so
        // a map's own triggers can ask who is holding it. Listed so the fall-through below
        // does not go looking for a handler that was never meant to exist.
        case "AIfe": case "AIfl": case "AIfm": case "AIfn": case "AIfo":
          return "unhandled";
        default: {
          // === and everything else: the item IS the spell =====================
          // An item ability row carries the same fields a unit's does — `targs1`, `Area1`,
          // `Dur1`, the Data columns — so anything with a handler in SPELL_HANDLERS runs
          // through the same dispatch a cast does, with the ITEM's numbers on it. That is
          // what makes a Wand of the Wind a Cyclone, a Scroll of the Beast a Roar and the
          // Legion Doom-Horn an Unholy Aura without any of them needing a case here.
          //
          // The corpse items above are not folded into this: they need their refusal checked
          // BEFORE the charge is spent, which this path cannot express.
          if (!SPELL_HANDLERS[ad.code]) return "unhandled";
          // A unit-aimed item pressed at nothing (or at something its row refuses) keeps its
          // charge. The HUD already asked itemUseError before spending the click, so this is
          // the guard for the paths that do not — a trigger's UnitUseItemTarget, and the AI.
          if (ad.target === "unit") {
            const t = this.units.get(targetId);
            if (!t || this.targetError(u, t, ad.targetFlags, ad.code) !== null) break;
          }
          this.applySpellEffect(ad.code, 1, u, { targetId, x, y }, ad);
          fired = true;
          break;
        }
      }
      return fired;
    }
  }

  /** Why a staff (`ANpr`/`ANsa`) may not be aimed at `t`, as a commandstrings.txt [Errors]
   *  key — or null if it may. Split out of useItem so the HUD can ask BEFORE it spends the
   *  click, exactly as `castError` lets it ask about a spell (see itemUseError).
   *
   *  On top of the row's own `targs1` (`ground,air,vuln,invu,player,neutral`, so no
   *  buildings and never the staff-bearer itself) and its Rng1 of 700, the staves carry two
   *  rules the flags cannot express, both from Liquipedia's Staff of Preservation /
   *  Staff of Sanctuary pages:
   *
   *  • **"Cannot target summoned units."** A Water Elemental has no home to be sent to.
   *  • **"Cannot teleport crowd-controlled units (including with Purge)."** Anything
   *    holding the unit in place holds it against the staff too — a stun, a sleep,
   *    Entangling Roots or Ensnare, a slow (Purge's included), Banish's ethereal drag.
   *
   *  And one from the patch notes: 1.13 "Staff of Preservation no longer affects allied
   *  units — it now can only affect its owner's units." That is what `player` means in the
   *  flag list, and it is stricter than the generic friend test targetAllowed applies, so
   *  it is checked here rather than left to the flags. */
  private staffTargetError(u: SimUnit, ad: AbilityDef, t: SimUnit): string | null {
    if (t.hp <= 0) return "Notthisunit";
    const flagErr = this.targetError(u, t, ad.targetFlags, ad.code);
    if (flagErr !== null) return flagErr;
    if (t.owner !== u.owner) return "Targetowned"; // "Must target one of your own units."
    if (t.isSummon) return "Notsummoned"; // "Unable to target summoned units."
    // …with the unit's OWN Sanctuary exempted. Its hold is a `stun` like any other, but the
    // same pages say "multiple instances of the heal-over-time effect stack" — which is only
    // possible if a second staff may be aimed at a unit the first one is already holding.
    if (t.buffs.some((b) => !b.untilHealed && CROWD_CONTROL_BUFFS.has(b.kind))) return "Teleportfail"; // "A unit could not be teleported."
    const range = ad.levelData[0]?.castRange ?? 0;
    if (range > 0 && Math.hypot(t.x - u.x, t.y - u.y) > range + u.radius + t.radius) return "Notinrange";
    return null;
  }

  /** Where a staff sends its target: the highest-ranked building `owner` holds that the
   *  ability's **"Building Types Allowed"** mask admits (`ANpr`/`ANsa` DataA = 15 = all four).
   *  Null when they hold none — the game has a string for exactly that case,
   *  `Nopreservationtarget` = "No structures are available to teleport the target to."
   *
   *  The mask's bits are the four `pickFlags` UI\UnitEditorData.txt lists in this order —
   *  Hall, Resource, Factory, General — and a building declares which one it is in
   *  UnitData.slk's `buffType` (see UnitDef.buffType). Ranking is that bit order first,
   *  then UnitData `prio` descending inside a category, and it reproduces Liquipedia's
   *  documented fallback chains exactly, for both races they list:
   *
   *    Human   halls → Barracks (prio 9) → Workshop / Arcane Sanctum / Altar of Kings (5)
   *            → Cannon Tower (3) → Arcane / Guard Tower (2) → Scout Tower (1)
   *    Elf     halls → Altar of Elders (6) → Ancient of War (5) → Ancient of Lore (4)
   *            → Ancient of Wind (3) → Ancient Protector (4, General) → Moon Well (2)
   *
   *  …and it drops exactly the buildings both pages call out as never-valid destinations
   *  (Farm, Blacksmith, Lumber Mill, Arcane Vault, Gryphon Aviary; Hunter's Hall, Ancient
   *  of Wonders, Chimaera Roost) without naming one of them: none carries a `buffType`.
   *  "Highest LEVEL town hall" falls out of the same sort — a Castle's prio is 8, a Keep's
   *  7, a Town Hall's 6 — and the categories are what keeps the prio-9 Barracks behind them. */
  private staffDestination(owner: number, buildingTypes: number): { x: number; y: number } | null {
    let best: SimUnit | null = null;
    let bestRank = -1;
    for (const b of this.units.values()) {
      if (b.owner !== owner || b.hp <= 0 || !b.building) continue;
      if (b.building.constructionLeft > 0) continue; // a shell is not somewhere to arrive
      const def = this.unitReg?.get(b.typeId);
      const category = STAFF_PICK_CATEGORIES.indexOf(def?.buffType ?? "");
      if (category < 0 || !(buildingTypes & (1 << category))) continue;
      // Category dominates prio: pack it into the high bits so the whole comparison is one
      // number and a prio-9 Barracks can never outrank a prio-6 Town Hall.
      const rank = (STAFF_PICK_CATEGORIES.length - category) * 1000 + (def?.priority ?? 0);
      if (rank > bestRank) { bestRank = rank; best = b; }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /** Why the item in `slot` cannot be used AT ALL right now, before any question of what it
   *  would be aimed at — as a commandstrings.txt [Errors] key, null if it is ready.
   *
   *  This is the half that must be answered the moment the button is PRESSED. WC3 never lets
   *  a cooling-down item put the cursor into targeting mode: pressing it says "This item is
   *  cooling down." there and then, and nothing is armed. Which matters most for the item
   *  that has to be aimed — arming a staff you cannot actually use leaves the player holding
   *  a live reticle over a click that was always going to be thrown away. */
  itemReadyError(unitId: number, slot: number): string | null {
    const u = this.units.get(unitId);
    if (!u || !this.itemReg) return "Cantuseitem";
    const held = u.inventory[slot];
    if (!held) return "Cantuseitem";
    if (held.cooldownLeft > 0) return "Itemcooldown"; // "This item is cooling down."
    const def = this.itemReg.get(held.itemId);
    if (!def?.usable) return "Cantuseitem";
    return null;
  }

  /** Why the local player's click on `targetId` with the item in `slot` would be refused,
   *  as a commandstrings.txt [Errors] key (null = it goes through). The HUD asks this before
   *  it spends an aimed item-use, the way it asks `castError` before an aimed spell — so a
   *  bad target draws the game's own gold line and leaves the item armed to click again. */
  itemUseError(unitId: number, slot: number, targetId: number): string | null {
    const ready = this.itemReadyError(unitId, slot);
    if (ready !== null) return ready;
    const u = this.units.get(unitId)!;
    const def = this.itemReg!.get(u.inventory[slot]!.itemId)!;
    if (!this.abilities) return "Cantuseitem";
    for (const abilId of def.abilities) {
      const ad = this.abilities.get(abilId);
      if (!ad) continue;
      // The corpse items — the Rod of Necromancy and the two Runes of Resurrection — refuse
      // exactly as the spells they ARE do, and for the same reason: pressing one with nothing
      // to raise would otherwise burn a charge on nothing. Same line, same query.
      const missing = this.corpseRefusal(u, ad, ad.levelData[0], u.x, u.y);
      if (missing) return missing;
      if (ad.code === "ANpr" || ad.code === "ANsa") {
        const t = this.units.get(targetId);
        if (!t) return "Targetunit"; // "Must target a unit with this action." — clicked bare ground
        const err = this.staffTargetError(u, ad, t);
        if (err !== null) return err;
        const lvl = ad.levelData[0];
        const mask = lvl?.data[0] === undefined || Number.isNaN(lvl.data[0]) ? 0 : lvl.data[0];
        return this.staffDestination(t.owner, mask) ? null : "Nopreservationtarget";
      }
      // A Scroll of Town Portal with nowhere to go. The game ships the line written for
      // exactly this: `Notownportalhalls` = "There are no friendly Town Halls to Town Portal
      // to." Answered on the CLICK so the scroll keeps its charge, as the staves are.
      if (ad.code === "AItp") return this.nearestHall(u.owner, u.x, u.y) ? null : "Notownportalhalls";
      // The UNIT-AIMED items. Each is refused by its own row's `targs1` and `Rng1` through the
      // one shared test a spell goes through (targetError), plus the handful of rules the flag
      // list cannot express — the same shape POLARITY_SPELLS and MANA_TARGET_SPELLS take.
      if (ad.target !== "unit") continue;
      const t = this.units.get(targetId);
      if (!t) return "Targetunit";
      const flagErr = this.targetError(u, t, ad.targetFlags, ad.code);
      if (flagErr !== null) return flagErr;
      const range = ad.levelData[0]?.castRange ?? 0;
      if (range > 0 && Math.hypot(t.x - u.x, t.y - u.y) > range + u.radius + t.radius) return "Notinrange";
      // Control Magic (`Acmg`) takes SUMMONED units and nothing else — "Grants the ability to
      // control summoned units", which no `targs1` value can say.
      // (`Needsummoned` = "Must target summoned units." — the positive line, not `Notsummoned`,
      // which is the refusal an ability that may NOT touch a summon gives.)
      if (ad.code === "Acmg" && t.summonLeft <= 0) return "Needsummoned";
      // The Scepter of Mastery (`AIco`) is Charm with an item's numbers, and carries Charm's
      // one extra rule in `DataA "Maximum Creep Level"` = 5: "Cannot be used on Heroes or on
      // creeps higher than level <AIco,DataA1>."
      if (ad.code === "AIco" && t.isCreep && t.level > this.dataOf(ad.levelData[0] ?? emptyAbilityLevel(), 0, 5)) return "Creeptoopowerful";
      return null;
    }
    return null; // not an aimed item — nothing to check here
  }

  /** Spend a charge + start the item's cooldown (shared across its cooldown group,
   *  WC3-style: drinking one potion puts every item in that group on cooldown). */
  private consumeItemUse(u: SimUnit, slot: number, def: ItemDef, cooldown: number): void {
    const held = u.inventory[slot];
    if (!held) return;
    if (def.charges > 0) {
      held.charges -= 1;
      if (held.charges <= 0 && def.perishable) { u.inventory[slot] = null; this.recomputeStats(u); }
    }
    if (cooldown > 0) {
      held.cooldownLeft = Math.max(held.cooldownLeft, cooldown);
      if (def.cooldownGroup && this.itemReg) {
        for (const other of u.inventory) {
          if (!other || other === held) continue;
          const od = this.itemReg.get(other.itemId);
          if (od && od.cooldownGroup === def.cooldownGroup) other.cooldownLeft = Math.max(other.cooldownLeft, cooldown);
        }
      }
    }
  }

  /** Who an item's effect actually lands on. An ability with no `Area1` is the user's alone
   *  (a tome, a chest of gold, a Potion of Healing); one with a radius reaches every unit
   *  inside it that its own `targs1` admits — which for the runes and the scrolls is the
   *  friendly, organic army standing around the hero. The user is always in the list:
   *  `self` is in those flags, and a zero-area ability short-circuits to it.
   *
   *  This is the SAME question for a rune you walk over and a scroll you press, so it is
   *  asked in one place for both (issue #130). Answering it only on the powerup path is why
   *  a Scroll of Regeneration — `AIsl`, `Area1 = 600`, `targs1 = air,ground,friend,self,
   *  organic,vuln,invu`, whose own Ubertip says "all friendly non-mechanical units in an
   *  area around your Hero" — used to regenerate nobody but the hero holding it. */
  private itemAreaTargets(u: SimUnit, ad: AbilityDef, x = u.x, y = u.y): SimUnit[] {
    const area = ad.levelData[0]?.area ?? 0;
    if (area <= 0) return [u];
    const out = this.unitsInAreaInternal(x, y, area)
      .filter((t) => t.hp > 0 && !t.building && this.targetAllowed(u, t, ad.targetFlags) === null);
    return out.includes(u) ? out : [u, ...out];
  }

  /** The RESTORE family — instant hit points and/or mana over `itemAreaTargets`. `hpIdx` /
   *  `manaIdx` are which Data column each half is in (-1 = this half is not in this row), a
   *  distinction the data insists on: `AIha` puts its hit points in DataA and `AImr` its
   *  mana in DataA too, while `AIra` carries both (DataA life, DataB mana).
   *
   *  Returns whether anything was actually restored — which is what decides whether a CHARGE
   *  is spent. WC3 refuses a Potion of Healing at full health rather than wasting it, and
   *  the same rule holds for the area scrolls: a Scroll of Restoration pressed with a whole,
   *  full army standing round the hero keeps its charge. */
  private itemRestore(u: SimUnit, ad: AbilityDef, hpIdx: number, manaIdx: number): boolean {
    const lvl = ad.levelData[0];
    const val = (i: number) => (i < 0 || lvl?.data[i] === undefined || Number.isNaN(lvl.data[i]) ? 0 : lvl.data[i]);
    const hp = val(hpIdx);
    const mana = val(manaIdx);
    let did = false;
    for (const t of this.itemAreaTargets(u, ad)) {
      if (hp > 0 && t.hp < t.maxHp) { t.hp = Math.min(t.maxHp, t.hp + hp); did = true; }
      if (mana > 0 && t.mana < t.maxMana) { t.mana = Math.min(t.maxMana, t.mana + mana); did = true; }
    }
    return did;
  }

  // === the WORLD-LEVEL item actives (issue #130) ==========================================
  // Everything an item can do that a SPELL_HANDLERS entry cannot see: the world clock, the
  // terrain, the tech graph, a hero's own progression. Each is small, each is reached from
  // exactly one `case` in useItem, and each returns whether it actually did something — which
  // is what decides whether a charge is spent.

  /** MOONSTONE (`AIct`, "ItemChangeTOD") — "Causes an eclipse that blocks out the sun and
   *  creates an artificial night. Lasts <AIct,Dur1> seconds."
   *
   *  Its two columns are `DataA "New Time of Day - Hour"` and `DataB "New Time of Day -
   *  Minute"`, both EMPTY on this row — which is the data saying midnight, and midnight is
   *  what an eclipse looks like. The clock is not stopped while it runs (a suspended day
   *  would owe the match 30 seconds back); it is wound to midnight and left going, and when
   *  the eclipse lifts the time it would have reached is restored. */
  private itemArtificialNight(ad: AbilityDef): boolean {
    const lvl = ad.levelData[0] ?? emptyAbilityLevel();
    const seconds = lvl.duration || 30;
    if (seconds <= 0) return false;
    const hour = this.dataOf(lvl, 0, 0) + this.dataOf(lvl, 1, 0) / 60;
    this.moonstone = { left: seconds, restore: this.timeOfDay };
    this.timeOfDay = ((hour % MISC_DATA.DayHours) + MISC_DATA.DayHours) % MISC_DATA.DayHours;
    return true;
  }

  /** …and the sun coming back up where it would have been. */
  private tickMoonstone(dt: number): void {
    if (!this.moonstone) return;
    this.moonstone.left -= dt;
    if (this.moonstone.left > 0) return;
    const owed = this.moonstone.restore;
    this.moonstone = null;
    this.timeOfDay = owed % MISC_DATA.DayHours;
  }

  /** SCROLL OF TOWN PORTAL (`AItp`) — "Teleports the Hero and any of its nearby troops to a
   *  target friendly town hall."
   *
   *  Aimed at a POINT (Rng1 99999 — anywhere on the map, minimap included) and resolved to
   *  the owner's nearest finished HALL, which is what its `targs1 = structure,vuln,invu`
   *  describes. `Area1` 1100 is the circle of troops that come along and `DataA "Maximum
   *  Number of Units"` 90 the cap on them. Nothing to arrive at = no teleport and no charge. */
  private itemTownPortal(u: SimUnit, ad: AbilityDef, x: number, y: number): boolean {
    const dest = this.nearestHall(u.owner, x, y);
    if (!dest) return false;
    const lvl = ad.levelData[0] ?? emptyAbilityLevel();
    const party = this.itemTeleportParty(u, ad, u.x, u.y, lvl.area || 1100, this.dataOf(lvl, 0, 90));
    this.emitEffectAt(ad.casterArt, u.x, u.y);
    for (const t of party) {
      this.emitEffectAt(ad.targetArt, t.x, t.y, true);
      this.teleportUnit(t, dest.x, dest.y);
      this.stop(t.id);
      this.emitEffectAt(ad.specialArt, t.x, t.y, true);
    }
    return true;
  }

  /** AMULET OF RECALL (`AIrt`) and DIAMOND OF SUMMONING (`AUds`) — the Town Portal run
   *  backwards: "Teleports <DataA> of the player's units within the targeted area to the
   *  location of the Hero." Same columns (`DataA "Maximum Number of Units"` 12, `Area1` 700),
   *  same party rule, opposite direction — so one method serves both. */
  private itemRecall(u: SimUnit, ad: AbilityDef, x: number, y: number): boolean {
    const lvl = ad.levelData[0] ?? emptyAbilityLevel();
    const party = this.itemTeleportParty(u, ad, x, y, lvl.area || 700, this.dataOf(lvl, 0, 12))
      .filter((t) => t !== u); // the hero is the destination, not part of the party
    if (!party.length) return false;
    for (const t of party) {
      this.emitEffectAt(ad.targetArt, t.x, t.y, true);
      this.teleportUnit(t, u.x, u.y);
      this.stop(t.id);
      this.emitEffectAt(ad.specialArt, t.x, t.y, true);
    }
    return true;
  }

  /** Who travels: the user's OWN units inside the circle that the ability's `targs1` admits,
   *  nearest first, up to `max`. The user is always first in the list — a Town Portal that
   *  left the hero behind because 90 Peasants stood closer would be a bad joke. */
  private itemTeleportParty(u: SimUnit, ad: AbilityDef, x: number, y: number, radius: number, max: number): SimUnit[] {
    const cap = Math.max(1, Math.round(max || 1));
    const party = this.unitsInAreaInternal(x, y, radius)
      .filter((t) => t !== u && t.hp > 0 && t.owner === u.owner && !t.building && this.targetAllowed(u, t, ad.targetFlags) === null)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
    return [u, ...party].slice(0, cap);
  }

  /** The owner's finished town hall nearest a point — what a Town Portal resolves to.
   *  "Town hall" is UnitData's own `buffType` category (the first of the four the staves rank
   *  by, see STAFF_PICK_CATEGORIES), so a Great Hall, a Necropolis and a Tree of Life all
   *  answer to it without a per-race list. */
  private nearestHall(owner: number, x: number, y: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestDist = Infinity;
    for (const b of this.units.values()) {
      if (b.owner !== owner || b.hp <= 0 || !b.building || b.building.constructionLeft > 0) continue;
      if (this.unitReg?.get(b.typeId)?.buffType !== STAFF_PICK_CATEGORIES[0]) continue;
      const dist = Math.hypot(b.x - x, b.y - y);
      if (dist < bestDist) { bestDist = dist; best = b; }
    }
    return best;
  }

  /** SACRIFICIAL SKULL (`Ablp`, "BlightPlacement") — "Creates an area of Blight at a target
   *  location." The same row shape every Undead building carries (see blightPaintOf): `DataA
   *  "Expansion Amount"` 64 a step, `DataB "Creates Blight"` 1, `Dur1` 0.08 the beat, `Area1`
   *  350 the disc. So it BLOOMS like a building's rather than appearing, through the very
   *  same growth queue — the skull is simply a blight source with no building under it. */
  private itemBlight(u: SimUnit, ad: AbilityDef, x: number, y: number): boolean {
    const lvl = ad.levelData[0] ?? emptyAbilityLevel();
    const max = lvl.area || 350;
    if (max <= 0) return false;
    this.blightGrowth.set(u.id, {
      x, y, r: 0, max, step: this.dataOf(lvl, 0, 64) || 64, period: lvl.duration || 0.08,
      t: 0, on: this.dataOf(lvl, 1, 1) > 0,
    });
    return true;
  }

  /** The eight "TINY" buildings (`AIbl`) — Tiny Great Hall / Castle / Scout Tower /
   *  Blacksmith / Farm / Lumber Mill / Barracks / Altar of Kings. "Creates a X at a target
   *  location", finished, free and instantly.
   *
   *  `UnitID1` is a FOUR-ENTRY list, not one id: `htow,ogre,unpl,etol` on the Tiny Great
   *  Hall, in the fixed race order human / orc / undead / night elf — which is exactly what
   *  its Ubertip promises ("Human, Night Elf, and Undead players will get their racial
   *  equivalent town hall"). The seven others repeat one human id four times, so the same
   *  read serves them all. */
  private itemBuild(u: SimUnit, ad: AbilityDef, x: number, y: number): boolean {
    const lvl = ad.levelData[0] ?? emptyAbilityLevel();
    const ids = (lvl.summon || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return false;
    const race = Math.max(0, TINY_BUILDING_RACES.indexOf(u.race));
    const typeId = ids[Math.min(race, ids.length - 1)];
    if (!typeId || !this.unitReg?.has(typeId)) return false;
    // Through the summon queue like every other unit the sim conjures — with NO duration, so
    // what arrives is a permanent building rather than a timed summon (see drainSummonRequests).
    this.summonRequests.push({
      unitId: typeId, x, y, facing: u.facing, owner: u.owner, team: u.team, summonLeft: 0,
      sourceId: u.id, summonArt: ad.targetArt, unsummonArt: "", atPoint: true,
    });
    return true;
  }

  /** Summon whatever an item ability's own `UnitID1` names, `DataA`-many of them, beside the
   *  user and for the row's own duration (0 = permanent). False when the row names nothing,
   *  which is not a failure to read the data but the data declining to say (see `Amec`). */
  private itemSummonUnits(u: SimUnit, ad: AbilityDef, countIdx: number): boolean {
    const lvl = ad.levelData[0] ?? emptyAbilityLevel();
    const typeId = (lvl.summon || "").split(",")[0]?.trim();
    if (!typeId || !this.unitReg?.has(typeId)) return false;
    const count = Math.max(1, Math.round(this.dataOf(lvl, countIdx, 1)));
    for (let i = 0; i < count; i++) {
      this.summonRequests.push({
        unitId: typeId, x: u.x, y: u.y, facing: u.facing + (i - (count - 1) / 2) * 0.5,
        owner: u.owner, team: u.team, summonLeft: lvl.duration || 0, sourceId: u.id,
        summonArt: ad.specialArt || ad.targetArt, unsummonArt: ad.buffEffectArt, atPoint: false,
      });
    }
    return true;
  }

  /** TOME OF POWER (`AIlm`, "LevelMod") — "Increases the level of the Hero by <AIlm,DataA1>."
   *  Granted as EXPERIENCE up to the next threshold rather than by bumping the counter, so
   *  everything a level-up entails (the skill point, the stat growth, the nova, the
   *  HERO_LEVEL event, the images levelling with him) happens exactly once and in order. */
  private itemLevelGain(u: SimUnit, ad: AbilityDef): boolean {
    if (!u.isHero || u.level >= MAX_HERO_LEVEL) return false;
    const levels = Math.max(1, Math.round(this.dataOf(ad.levelData[0] ?? emptyAbilityLevel(), 0, 1)));
    for (let i = 0; i < levels && u.level < MAX_HERO_LEVEL; i++) {
      this.gainXp(u, Math.max(1, xpToReachLevel(u.level + 1) - u.xp));
    }
    return true;
  }

  /** TOME OF RETRAINING (`Aret`) — "Unlearns all of the Hero's spells, allowing the Hero to
   *  learn different skills." Every rank goes back into the pool: the points are what the
   *  hero paid, so the refund is the sum of the ranks, and an ultimate learned at level 6
   *  is one point like any other. */
  private itemRetrain(u: SimUnit): boolean {
    if (!u.isHero) return false;
    let refunded = 0;
    for (const a of u.abilities) {
      // A LEARNABLE ability, which is the `hero` column on its own row — not "an ability a
      // hero has". A Demon Hunter's Evasion and his Immolation sit side by side on the same
      // unit and only one of them was ever paid for.
      if (!this.abilities?.get(a.id)?.isHero || a.level < 1) continue;
      refunded += a.level;
      a.level = 0;
      a.cooldownLeft = 0;
    }
    if (!refunded) return false;
    u.skillPoints += refunded;
    this.recomputeStats(u);
    return true;
  }

  /** GLYPH OF FORTIFICATION (`AIgf` → `Rgfo`) and GLYPH OF ULTRAVISION (`AIgu` → `Rguv`) —
   *  "Increases the armor and hit points of your buildings" / "Gives all of your units the
   *  ability to see as far at night as they do during the day."
   *
   *  Neither is an effect at all: each is an UPGRADE the item researches outright, named in
   *  its own `UnitID1`, and the tech graph does the rest. That is why a glyph is permanent
   *  and why its benefit reaches units built afterwards — it is the research, not a buff. */
  private itemGlyph(u: SimUnit, ad: AbilityDef): boolean {
    const upgradeId = (ad.levelData[0]?.summon || "").split(",")[0]?.trim();
    if (!upgradeId || !this.tech) return false;
    if (this.tech.researchLevel(u.owner, upgradeId) > 0) return false; // already ours — keep the charge
    this.tech.setResearchLevel(u.owner, upgradeId, 1);
    this.tech.invalidate();
    return true;
  }

  /** SOUL GEM (`AIso`, "SoulTrap") — "Traps the targeted enemy Hero inside the Soul Gem when
   *  used. The enemy Hero is returned to play when the bearer of the Soul Gem is killed."
   *  `targs1 = enemy,hero`, Rng1 500.
   *
   *  The trapped hero is taken OFF THE FIELD rather than killed — `vanished`, which is the
   *  same state a Blademaster spends mid-Mirror-Image: hidden, untargetable, unorderable —
   *  and held by whoever is carrying the gem. Kept on the world rather than on the HeldItem
   *  so the record survives the item moving between slots, and released the moment the
   *  carrier dies OR stops carrying a gem (which covers dropping and selling it too). */
  private itemSoulGem(u: SimUnit, held: HeldItem, targetId: number): boolean {
    const t = this.units.get(targetId);
    if (!t || !t.isHero || t.hp <= 0 || !this.hostile(u, t) || t.vanished) return false;
    if (this.soulGems.some((g) => g.heroId === t.id)) return false; // already in somebody's gem
    this.stop(t.id);
    t.vanished = true;
    this.recomputeStats(t);
    this.soulGems.push({ carrierId: u.id, heroId: t.id, itemId: held.itemId });
    return true;
  }

  /** Let a trapped hero out — when the carrier falls, or stops carrying the gem. */
  private tickSoulGems(): void {
    if (!this.soulGems.length) return;
    for (let i = this.soulGems.length - 1; i >= 0; i--) {
      const g = this.soulGems[i];
      const carrier = this.units.get(g.carrierId);
      const stillHeld = !!carrier && carrier.hp > 0 && carrier.inventory.some((h) => h?.itemId === g.itemId);
      if (stillHeld) continue;
      this.soulGems.splice(i, 1);
      const hero = this.units.get(g.heroId);
      if (!hero) continue;
      hero.vanished = false;
      // Back where the gem was, which is where the story left him — beside the body of
      // whoever was carrying him around.
      if (carrier) this.teleportUnit(hero, carrier.x, carrier.y);
      this.recomputeStats(hero);
    }
  }

  /** Apply a powerup consumed on pickup (tomes, manuals, runes, gold/lumber),
   *  dispatched on its granted ability's base `code`. */
  private applyPowerup(u: SimUnit, def: ItemDef): void {
    if (!this.abilities) return;
    for (const abilId of def.abilities) {
      const ad = this.abilities.get(abilId);
      if (!ad) continue;
      // The SAME dispatcher a pressed item goes through (see applyItemAbility). A rune and
      // the scroll beside it on the shop shelf are one ability with one set of numbers —
      // `AIha` is the Rune of Healing AND the Scroll of Healing — and the only thing that
      // differs is how the player reached it. A powerup aims at nothing: no target, no
      // point, its own position.
      this.applyItemAbility(u, ad, null, 0, u.x, u.y);
      // …and the pickup's LOOK, which is data, not per-code: the ability names a model to
      // play on the unit that took it. Which slot holds it is not consistent in the game's
      // own data — the tomes use `Targetart` (AIsm/AIam/AIim → …\AIsmTarget.mdl et al) but
      // the Tome of Experience, Manual of Health and Chest of Gold use `Casterart` for the
      // very same job — so take whichever is set. Every powerup attaches at `origin`, which
      // is where a unit-targeted effect already plays. (1.27a Units\ItemAbilityFunc.txt.)
      //
      // An AoE rune plays it on EVERY unit it restored, not just the one that stepped on it:
      // the flash over each of them is how the player can see who was in range.
      const art = ad.targetArt || ad.casterArt;
      if (art || ad.effectSound) {
        for (const t of this.itemAreaTargets(u, ad)) {
          this.powerupPickups.push({ unitId: t.id, art, soundLabel: t === u ? ad.effectSound : "" });
        }
      }
    }
    this.recomputeStats(u);
  }

  /** PowerUps consumed this frame (renderer plays the effect model + its sound). */
  drainPowerupPickups(): Array<{ unitId: number; art: string; soundLabel: string }> {
    if (!this.powerupPickups.length) return this.powerupPickups;
    const out = this.powerupPickups;
    this.powerupPickups = [];
    return out;
  }

  // === item trigger-effect API (7.18) ======================================
  // What a map's triggers reach for: create an item, give it to a hero, drop it, use
  // it, read/set its charges. Each is a thin wrapper over the item mechanics above, so
  // a trigger-driven pickup goes through exactly the same path (and raises exactly the
  // same events) as a hero walking over the item. The JASS bridge is
  // src/jass/natives/items.ts → EngineHooks; ids are ITEM entity ids (SimItem.id /
  // HeldItem.id), which is what a JASS `item` handle stands for.

  /** CreateItem — put a new item of type `typeId` on the ground. Charges default to the
   *  item's own `uses` (a Potion of Healing is created with its 1 charge). -1 if the
   *  rawcode isn't a known item type. */
  createItem(typeId: string, x: number, y: number, charges = -1): number {
    const def = this.itemReg?.get(typeId);
    if (!def) return -1;
    return this.spawnGroundItem(typeId, x, y, charges >= 0 ? charges : def.charges).id;
  }

  /** Where item `id` is right now — on the ground or in an inventory (7.18). One lookup
   *  for both, because a JASS `item` handle doesn't care which. */
  itemSnapshot(id: number): ItemSnapshot | null {
    const ground = this.items.get(id);
    // PLAYER_NEUTRAL_PASSIVE (common.j player 15) owns everything nobody carries.
    if (ground) return { id, typeId: ground.itemId, charges: ground.charges, x: ground.x, y: ground.y, holder: 0, slot: -1, owner: 15 };
    for (const u of this.units.values()) {
      const slot = u.inventory.findIndex((h) => h?.id === id);
      if (slot >= 0) {
        const held = u.inventory[slot]!;
        return { id, typeId: held.itemId, charges: held.charges, x: u.x, y: u.y, holder: u.id, slot, owner: jassOwnerOf(u) };
      }
    }
    return null;
  }

  /** Every item lying on the ground (EnumItemsInRect scans this — a carried item is not
   *  enumerable, matching WC3). */
  groundItems(): SimItem[] {
    return [...this.items.values()];
  }

  /** RemoveItem — destroy an item wherever it is (ground or inventory). */
  removeItemById(id: number): boolean {
    if (this.items.has(id)) { this.removeGroundItem(id); return true; }
    for (const u of this.units.values()) {
      const slot = u.inventory.findIndex((h) => h?.id === id);
      if (slot >= 0) {
        u.inventory[slot] = null;
        this.recomputeStats(u);
        return true;
      }
    }
    return false;
  }

  /** SetItemCharges. */
  setItemCharges(id: number, charges: number): boolean {
    const n = Math.max(0, Math.trunc(charges));
    const ground = this.items.get(id);
    if (ground) { ground.charges = n; return true; }
    for (const u of this.units.values()) {
      const held = u.inventory.find((h) => h?.id === id);
      if (held) { held.charges = n; return true; }
    }
    return false;
  }

  /** SetItemPosition — move a ground item. WC3 semantics: positioning an item a unit is
   *  CARRYING takes it out of the inventory and puts it on the ground there. */
  setItemPosition(id: number, x: number, y: number): boolean {
    const ground = this.items.get(id);
    if (ground) {
      const [sx, sy] = this.snapItemPos(x, y);
      ground.x = sx;
      ground.y = sy;
      // Re-model at the new spot (the renderer has no "move item"). Never `died` — this
      // is a reposition, and a death clip here would puff the item at its old spot.
      this.itemRemovals.push({ id, died: false });
      this.itemSpawns.push(ground);
      return true;
    }
    for (const u of this.units.values()) {
      const slot = u.inventory.findIndex((h) => h?.id === id);
      if (slot >= 0) { this.doDropItem(u, slot, x, y); return true; }
    }
    return false;
  }

  /** UnitAddItem — give an existing item to a unit (from the ground, or straight out of
   *  another unit's inventory). `wantSlot` >= 0 targets a specific slot
   *  (UnitAddItemToSlotById). False if the item is gone or the inventory is full — the
   *  item then stays exactly where it was, which is what makes blizzard.j's
   *  UnitAddItemByIdSwapped leave it at the hero's feet. */
  unitAddItem(unitId: number, itemId: number, wantSlot = -1): boolean {
    const u = this.units.get(unitId);
    if (!u || !u.inventory.length) return false;
    const ground = this.items.get(itemId);
    if (ground) return this.pickUpItem(u, ground, wantSlot);
    // Held by someone else: hand it over (the giver DROPs, the receiver PICKs UP).
    for (const from of this.units.values()) {
      const slot = from.inventory.findIndex((h) => h?.id === itemId);
      if (slot >= 0) {
        if (from.id === unitId) return true; // already his
        if (u.inventory.indexOf(null) < 0) return false;
        this.transferItem(from, slot, u);
        return true;
      }
    }
    return false;
  }

  /** UnitRemoveItem — take an item off a unit and leave it on the ground at its feet. */
  unitRemoveItem(unitId: number, itemId: number): boolean {
    const u = this.units.get(unitId);
    const slot = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || slot < 0) return false;
    this.doDropItem(u, slot, u.x, u.y);
    return true;
  }

  /** UnitRemoveItemFromSlot — the same, by slot; returns the item id (0 = empty slot). */
  unitRemoveItemFromSlot(unitId: number, slot: number): number {
    const u = this.units.get(unitId);
    const held = u?.inventory[slot];
    if (!u || !held) return 0;
    const id = held.id;
    this.doDropItem(u, slot, u.x, u.y);
    return id;
  }

  /** UnitDropItemPoint — a trigger drops the item AT the point immediately (unlike the
   *  player's drop order, which walks the hero over first — see dropItem). */
  unitDropItemPoint(unitId: number, itemId: number, x: number, y: number): boolean {
    const u = this.units.get(unitId);
    const slot = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || slot < 0) return false;
    this.doDropItem(u, slot, x, y);
    return true;
  }

  /** UnitDropItemSlot — despite the name, this MOVES the item within the unit's own
   *  inventory (the GUI's "Hero - Give item to slot"): a swap, not a drop. */
  unitDropItemSlot(unitId: number, itemId: number, slot: number): boolean {
    const u = this.units.get(unitId);
    const from = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || from < 0 || slot < 0 || slot >= u.inventory.length) return false;
    return from === slot || this.swapItems(unitId, from, slot);
  }

  /** UnitDropItemTarget — hand the item to another unit (the GUI's "Hero - Give item to
   *  hero"), immediately. */
  unitDropItemTarget(unitId: number, itemId: number, targetId: number): boolean {
    const u = this.units.get(unitId);
    const to = this.units.get(targetId);
    const slot = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || !to || slot < 0 || !to.inventory.length) return false;
    this.transferItem(u, slot, to);
    return true;
  }

  /** UnitUseItem / UnitUseItemPoint / UnitUseItemTarget — fire a carried item's active
   *  effect (potion, scroll, dagger). Rides on the same useItem() the HUD's item button
   *  calls, so it spends the charge, starts the cooldown, and raises USE_ITEM. */
  unitUseItem(unitId: number, itemId: number, targetId: number, x: number, y: number): boolean {
    const u = this.units.get(unitId);
    const slot = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || slot < 0) return false;
    return this.useItem(unitId, slot, targetId, x, y);
  }

  /** UnitInventorySize — how many slots the unit has (0 = no inventory ability). */
  inventorySizeOf(unitId: number): number {
    return this.units.get(unitId)?.inventory.length ?? 0;
  }

  /** UnitItemInSlot — the item entity id in a slot (0 = empty / no such slot). */
  itemInSlot(unitId: number, slot: number): number {
    return this.units.get(unitId)?.inventory[slot]?.id ?? 0;
  }

  // Idle (or patrolling) armed units scan for the nearest enemy in acquisition
  // range and turn on it. Creeps acquire within their own aggro range (from the
  // map's per-unit target-acquisition, else the weapon's), and never while asleep
  // or leashing home; acquiring rallies the rest of their camp (call-for-help).
  private tickAcquire(u: SimUnit, dt: number): void {
    if (!u.weapon) return;
    if (u.isCreep && (u.asleep || u.returning)) return;
    const range = this.acquireRange(u);
    if (range <= 0) return;
    u.acquireT -= dt;
    if (u.acquireT > 0) return;
    u.acquireT = ACQUIRE_PERIOD;
    // Creeps pick the highest-threat target (enemy units before buildings); other
    // units auto-acquire the nearest VISIBLE enemy, skipping idle creep camps. When
    // nothing's in that unit's own acquisition range, a non-creep also RALLIES to a fight
    // a nearby friend is already in — an enemy just past its own range that's attacking an
    // ally (issue #24: "units stand behind after the first kill; they should help friends
    // fighting nearby"). This is what stops a back-rank unit idling while its group fights
    // a few paces ahead. Creeps keep their own camp cohesion (campFightTarget) instead.
    const best = u.isCreep
      ? this.bestCreepTarget(u, range)
      : this.acquireTarget(u, range) ?? this.assistTarget(u, ASSIST_RANGE);
    if (best) {
      // A fight it chose for itself is leashed to where it stands (see setAutoGuardPost).
      // Only from IDLE: an attack-move or a patrol already has somewhere to be, and planting
      // a post under one would have the unit walk "home" instead of resuming its route.
      if (!u.isCreep && u.order === "idle") this.setAutoGuardPost(u);
      this.issueAttack(u.id, best.id);
      if (u.isCreep) {
        u.campHelper = false; // saw it with its own eyes, inside its own aggro range
        this.alertCamp(u, best);
      }
    } else if (u.isCreep) {
      // Nothing in our own aggro range, but if a camp-mate is still fighting, go
      // help — no creep sits idle at the post while its camp is in a fight.
      const help = this.campFightTarget(u);
      if (help) {
        this.issueAttack(u.id, help.id);
        u.campHelper = true; // answering the shout — don't relay it onward
      }
    }
  }

  /** Drive a Hold-Position unit: strike any hostile that is within weapon range
   *  (fog- and idle-creep-filtered, like normal auto-acquire) but NEVER move to
   *  chase — the unit stays planted where Hold was issued (issue #17). */
  private tickHold(u: SimUnit, dt: number): void {
    const w = u.weapon;
    if (!w || w.range <= 0 || u.isPeon) {
      // A worker holds its ground without swinging at anything: no auto-acquisition,
      // on Hold as anywhere else (issue #41).
      u.inCombat = false;
      this.settle(u);
      return;
    }
    // A committed swing always finishes (a unit never walks mid-strike anyway).
    if (u.swingLeft >= 0) {
      const st = this.units.get(u.swingTargetId);
      if (st) {
        this.engage(u, st, true);
        return;
      }
      this.cancelSwing(u);
    }
    // Hold onto the current target while it's still hostile, alive, and within
    // reach; otherwise re-scan (throttled) for the nearest in-range enemy.
    const reach = w.range + (u.inCombat ? ATTACK_LEASH : 0);
    let t = u.targetId !== null ? this.units.get(u.targetId) : undefined;
    if (t && !this.canAttack(u, t)) t = undefined; // nothing in hand for it (air/ground/structure)
    if (t && (!this.hostile(u, t) || t.invulnerable || Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius > reach)) t = undefined;
    if (!t) {
      u.acquireT -= dt;
      if (u.acquireT <= 0) {
        u.acquireT = ACQUIRE_PERIOD;
        t = this.acquireTarget(u, w.range) ?? undefined; // striking distance only
      }
    }
    if (t) {
      u.targetId = t.id;
      this.engage(u, t, true); // noChase — attack in place
    } else {
      u.targetId = null;
      u.inCombat = false;
      this.settle(u);
    }
  }

  /** Nearest hostile within `range` that an idle/holding non-creep unit will
   *  auto-acquire. Beyond plain hostility it must be (a) VISIBLE to the acquirer's
   *  team — WC3 units never aggro a target hidden in the fog of war — and (b) not
   *  an un-triggered neutral-hostile creep camp: you only pull a camp by attacking
   *  it or walking into its own aggro range, never by an idle unit noticing it. */
  private acquireTarget(u: SimUnit, range: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestGap = range;
    for (const t of this.units.values()) {
      if (t === u || !this.hostile(u, t)) continue;
      if (t.invulnerable) continue; // invulnerable enemies (goblin merchant, gold mine, Divine Shield, …) aren't attackable (issue #26)
      if (t.isCreep && !this.creepAggroed(t)) continue; // don't wake an idle creep camp
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap >= bestGap) continue;
      if (!this.canAttack(u, t)) continue; // a Footman never turns on the Gryphon overhead
      if (!this.canSee(u, t)) continue; // out of sight (fog, night, or a treeline) → don't aggro
      bestGap = gap;
      best = t;
    }
    return best;
  }

  /** Assist fallback for an idle unit with no enemy in its own acquisition range: rally to
   *  a fight a friend is already in. Scans our own side for allies currently ATTACKING an
   *  enemy and returns the nearest such enemy within the wider ASSIST_RANGE (issue #24:
   *  back-rank units left idle a few paces behind the fight). Keying off "an ally is
   *  attacking it" — rather than "it is attacking an ally" — is what makes this fire even
   *  when the enemy is being focused down and isn't hitting back, and it still can't pull a
   *  peaceful/un-aggroed creep camp (no ally is attacking those). */
  private assistTarget(u: SimUnit, range: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestGap = range;
    for (const ally of this.units.values()) {
      if (ally === u || ally.team !== u.team) continue; // one of our own army
      if (ally.order !== "attack" || ally.targetId === null) continue; // that is fighting
      const enemy = this.units.get(ally.targetId);
      if (!enemy || !this.hostile(u, enemy)) continue; // attacking an actual enemy of ours
      if (!this.canAttack(u, enemy)) continue; // …that we could actually contribute against
      // Distance to the FRIEND that's fighting, not to its enemy — a unit left behind is
      // near its comrades even when their enemy is farther off, and it should march up to
      // help. It then attacks the enemy that friend is engaging (and re-targets to whatever
      // it can actually reach once it arrives, via the in-strike-range switch in tickAttack).
      const gap = Math.hypot(ally.x - u.x, ally.y - u.y) - u.radius - ally.radius;
      if (gap >= bestGap) continue;
      if (!this.canSee(u, enemy)) continue; // out of sight (fog/night/treeline) → can't join that fight
      bestGap = gap;
      best = enemy;
    }
    return best;
  }

  /** True while a neutral-hostile creep is in its aggroed (fighting) state — it has
   *  a live attack target. An idle/guarding/sleeping/leashing creep is NOT aggroed,
   *  so nearby player units won't auto-attack it until the camp has been triggered. */
  private creepAggroed(c: SimUnit): boolean {
    return c.order === "attack" && c.targetId !== null && this.units.has(c.targetId);
  }

  // === neutral-hostile creep guard AI =======================================

  /** Drive a creep's guard/leash/sleep behaviour, run before the order switch.
   *  Returns true when it has handled the unit this tick (asleep or leashing
   *  home) so the caller skips the normal order logic. */
  private tickCreep(u: SimUnit, dt: number): boolean {
    const atHome = Math.hypot(u.x - u.guardX, u.y - u.guardY) <= CREEP_HOME_EPS;
    // --- sleep (night): doze off while guarding at the post, with no hostile
    // right on top of us; dawn (or the checks below) wakes it. ---
    if (u.canSleep && !u.returning) {
      if (this.isDay) u.asleep = false;
      else if (!u.asleep && u.order === "idle" && atHome && !this.nearestEnemy(u, SLEEP_WAKE_RANGE)) u.asleep = true;
    } else if (!u.canSleep) {
      u.asleep = false;
    }
    if (u.asleep) {
      // A hostile straying very close wakes it (else you can scout past at night).
      if (this.nearestEnemy(u, SLEEP_WAKE_RANGE)) {
        u.asleep = false;
        return false; // awake now — let it acquire this tick
      }
      u.inCombat = false;
      this.settle(u);
      u.desiredFacing = u.guardFacing;
      return true; // still asleep — stand at the post
    }
    // --- leashing home: ignore enemies until back at the post ---
    if (u.returning) {
      this.tickCreepReturn(u, dt);
      return true;
    }
    // --- fighting: leash back once we've strayed too far from the post ---
    const engaged = u.order === "attack" && u.targetId !== null && this.units.has(u.targetId);
    const dist = Math.hypot(u.x - u.guardX, u.y - u.guardY);
    if (engaged) {
      // Stay on the biggest threat: periodically upgrade off a low-threat target
      // (e.g. a building) onto a real unit that walked into range.
      u.acquireT -= dt;
      if (u.acquireT <= 0) {
        u.acquireT = ACQUIRE_PERIOD;
        const cur = this.units.get(u.targetId!)!;
        // ...unless it is already TRADING BLOWS with a WORKER. Ranking workers last decides
        // what a creep PICKS; a fight it has already closed on and is swinging at is not
        // re-opened, or a camp mobbing the Peasant that pulled it would walk off him the
        // moment the army it fetched arrived, and the worker it had all but killed would live.
        // `inCombat` (in the strike band, per engage) is the line: still walking over is
        // still choosing, and that one does upgrade.
        //
        // A WARD gets no such stay of execution, and that asymmetry is the point of it: a
        // worker is a real kill the camp is most of the way through, while a Serpent Ward is
        // bait — standing there trading with it while the Riflemen shoot is precisely the
        // thing the ward was planted to buy.
        if (!(u.inCombat && cur.isPeon)) {
          const best = this.bestCreepTarget(u, u.aggroRange);
          if (best && best.id !== cur.id && this.threatTier(best) > this.threatTier(cur)) {
            this.issueAttack(u.id, best.id);
            u.campHelper = false; // picked this one out of its own aggro range
          }
        }
      }
      if (dist >= MAX_GUARD_DISTANCE) {
        this.beginCreepReturn(u); // dragged out past the hard limit — always go home
        return true;
      }
      if (dist >= GUARD_DISTANCE) {
        // Past the soft limit: normally head home after chasing GUARD_RETURN_TIME
        // unattacked (each hit resets strayT in landDamage). But do NOT peel off
        // while a camp-mate is still in the fight — the camp commits as one and
        // breaks off together (or at the hard MaxGuardDistance above). This is what
        // stops a single creep being left fighting at max range while the rest sit.
        if (this.campFightTarget(u)) {
          u.strayT = 0;
        } else {
          u.strayT += dt;
          if (u.strayT >= GUARD_RETURN_TIME) {
            this.beginCreepReturn(u);
            return true;
          }
        }
      } else {
        u.strayT = 0;
      }
      return false; // keep fighting
    }
    // Guarding: nothing to fight. If displaced from the post (e.g. a target just
    // died out in the field) and no new enemy is in range, walk back home. The
    // trigger uses CREEP_RETURN_TRIGGER, NOT the tighter CREEP_HOME_EPS the return
    // finishes at — the gap between them is the hysteresis that stops the settle
    // snap from re-triggering a return every tick (the return "jiggle").
    u.strayT = 0;
    if (u.order === "idle" && dist > CREEP_RETURN_TRIGGER && !this.nearestEnemy(u, u.aggroRange, true)) {
      // About to walk home — but if a camp-mate is still fighting, go help instead
      // of standing down while the camp is engaged.
      const help = u.weapon ? this.campFightTarget(u) : null;
      if (help) {
        this.issueAttack(u.id, help.id);
        u.campHelper = true; // answering the shout — don't relay it onward
        return false;
      }
      this.beginCreepReturn(u);
      return true;
    }
    return false;
  }

  /**
   * The LEASH, for a map-placed AI unit that is not a creep (see SimUnit.guarding).
   *
   * Deliberately only the leash: no sleep, no camp cohesion, no threat re-pick — those are
   * Neutral Hostile's own behaviours and a campaign's Naga are not a creep camp. What it
   * shares with a creep is the one rule `MiscGame.txt` writes for units in general —
   * `GuardDistance` (600) starts the clock, `GuardReturnTime` (5 s) unattacked ends the
   * chase, `MaxGuardDistance` (1000) ends it outright.
   *
   * An ORDERED attack is never leashed. `attackOrdered` is the same distinction the rest of
   * the sim draws between "the unit's own idea" and "someone said to": a trigger pointing
   * these units at a target means it, and the harbour sequence does exactly that.
   *
   * Returns true when it has taken the unit over for this tick.
   */
  private tickGuardLeash(u: SimUnit, dt: number): boolean {
    if (u.returning) {
      this.tickCreepReturn(u, dt);
      return true;
    }
    if (u.order !== "attack" || u.attackOrdered || u.targetId === null || !this.units.has(u.targetId)) {
      u.strayT = 0;
      return false;
    }
    const dist = Math.hypot(u.x - u.guardX, u.y - u.guardY);
    // "If a CREEP goes beyond 'MaxGuardDistance' then it always returns home regardless of
    // who's attacking it" — the one sentence in MiscGame.txt that names creeps, so it holds
    // for the map's own units and not for a player's unit on a post it planted itself.
    if (dist >= MAX_GUARD_DISTANCE && !u.guardAuto) {
      this.beginCreepReturn(u);
      return true;
    }
    if (dist >= GUARD_DISTANCE) {
      u.strayT += dt; // landDamage resets this — being shot at keeps it in the fight
      if (u.strayT >= GUARD_RETURN_TIME) {
        this.beginCreepReturn(u);
        return true;
      }
    } else {
      u.strayT = 0;
    }
    return false;
  }

  /** Something COMMANDED this unit: it is no longer holding the ground the map put it on
   *  (see SimUnit.guarding). One call at the order funnel rather than a flag per order type,
   *  so nothing that reaches a unit deliberately can be leashed away from it. */
  private clearGuardPost(u: SimUnit): void {
    if (!u.guarding) return;
    u.guarding = false;
    u.guardAuto = false;
    u.returning = false;
    u.strayT = 0;
  }

  /**
   * Plant the post a self-started fight is leashed to: where the unit is STANDING as it
   * decides, by itself, to go and fight something (see SimUnit.guardAuto).
   *
   * This is the half of WC3's aggro model that the sim was missing, and the bug it caused is
   * the one worth stating: pull a hero back out of a creep camp and stand him somewhere, and
   * the moment anything wandered into his 600-unit acquisition range he would set off after
   * it — and then after the next thing from wherever THAT ended, ratcheting back into the camp
   * he was just pulled out of. A unit fighting on its own account now has somewhere to be, so
   * the chase ends and it walks back to the spot the player left it on.
   *
   * A unit that already holds a post (a map-placed creep or AI unit) keeps its own — the map's
   * ground outranks wherever this particular fight started.
   */
  private setAutoGuardPost(u: SimUnit): void {
    if (u.guarding) return;
    u.guarding = true;
    u.guardAuto = true;
    u.guardX = u.x;
    u.guardY = u.y;
    u.guardFacing = u.facing;
    u.strayT = 0;
    u.returning = false;
  }

  /** Begin leashing a creep back to its guard point. */
  private beginCreepReturn(u: SimUnit): void {
    u.returning = true;
    u.targetId = null;
    u.inCombat = false;
    u.campHelper = false; // out of the fight — back to guarding on its own account
    this.cancelSwing(u);
    u.strayT = 0;
    u.returnBestDist = Math.hypot(u.x - u.guardX, u.y - u.guardY);
    u.returnStuckT = 0;
    u.order = "move";
    if (!this.pathTo(u, u.guardX, u.guardY)) u.desiredFacing = Math.atan2(u.guardY - u.y, u.guardX - u.x);
  }

  /** Advance a leashing creep: walk home, and — if it can't make progress for
   *  GUARD_RETURN_TIME (boxed in / body-blocked) — give up and fight again where
   *  it stands (so a player can't kite it forever against a wall). */
  private tickCreepReturn(u: SimUnit, dt: number): void {
    const d = Math.hypot(u.x - u.guardX, u.y - u.guardY);
    if (d <= CREEP_HOME_EPS) {
      this.finishCreepReturn(u); // back at the post — resume guarding
      return;
    }
    if (d < u.returnBestDist - ARRIVE_EPS) {
      u.returnBestDist = d; // getting closer — reset the give-up timer
      u.returnStuckT = 0;
    } else {
      u.returnStuckT += dt;
      if (u.returnStuckT >= GUARD_RETURN_TIME) {
        u.returning = false; // can't get home — resume fighting from here
        u.returnStuckT = 0;
        u.order = "idle";
        this.settle(u);
        return;
      }
    }
    if (!u.moving) {
      // Stopped short of home (path blocked when computed) — try again toward it.
      if (this.pathTo(u, u.guardX, u.guardY)) u.order = "move";
      else u.desiredFacing = Math.atan2(u.guardY - u.y, u.guardX - u.x);
    }
  }

  /** A creep reached its guard point: face its guard heading and resume guarding
   *  (it will re-acquire any enemies still in range next tick). It keeps whatever
   *  HP it had — no return-to-camp heal (removed at the maintainer's request). */
  private finishCreepReturn(u: SimUnit): void {
    u.returning = false;
    u.returnStuckT = 0;
    u.strayT = 0;
    u.order = "idle";
    this.settle(u);
    u.desiredFacing = u.guardFacing;
  }

  /** Two creeps belong to the same camp when their guard posts were placed within
   *  CreepCallForHelp of each other. Membership is keyed to the fixed GUARD points,
   *  NOT live positions — so a creep dragged out to the edge of its leash still
   *  counts as a camp-mate and can rally (or be rallied by) the ones back home. */
  private sameCamp(a: SimUnit, b: SimUnit): boolean {
    return Math.hypot(a.guardX - b.guardX, a.guardY - b.guardY) <= CREEP_CALL_FOR_HELP;
  }

  /** Camp cohesion (MiscGame CreepCallForHelp): a creep that engages a target
   *  wakes every sleeping camp-mate and pulls idle ones onto the same target —
   *  "a creep camp acts as one unit; attack one and they all attack" (Battle.net
   *  creep basics). Leashing camp-mates are left alone.
   *
   *  The call travels exactly ONE hop: everyone it rouses is flagged `campHelper`,
   *  and a helper never calls for help itself. Without that flag the shout relays —
   *  a helper is on an attack order, so the NEXT camp's idle creeps see it through
   *  campFightTarget and join, and theirs after that (issue #55: a creep 2200 units
   *  from the player, four times its own aggro range, charging out of a camp nobody
   *  touched). A creep that acquires a target itself, or that gets hit, becomes an
   *  originator again and may shout — which is the real CallForHelp rule. */
  private alertCamp(u: SimUnit, target: SimUnit): void {
    for (const c of this.units.values()) {
      if (c === u || !c.isCreep || c.hp <= 0 || c.returning) continue;
      if (!this.sameCamp(c, u)) continue;
      c.asleep = false; // rouse the camp
      if (c.order === "idle" && c.weapon && this.hostile(c, target)) {
        const t = this.creepTargetOver(c, target); // a shout about a Peasant doesn't blind it
        this.issueAttack(c.id, t.id);
        // Only a creep that took the shouter's word for it is a helper. One that looked up and
        // picked something better found it inside its OWN aggro range, which is exactly what
        // makes a creep an originator in tickAcquire — so it may shout in its turn.
        c.campHelper = t === target;
      }
    }
  }

  /** Laying a new foundation notifies the creeps around it (MiscData
   *  BuildingPlacementNotifyRadius = 600) and they come to tear it down. The radius is
   *  measured from the building's edge, and it is quite separate from acquisition range —
   *  a creep that would never have noticed a Peasant walking past at 600 charges the
   *  moment he plants a Town Hall there.
   *
   *  Only "Normal" creeps answer. The map's per-creep targetAcquisition is a two-way flag,
   *  Normal (-1) or Camp (-2), and across every shipped melee map the mapmakers set Normal
   *  on exactly the camps guarding a gold mine and Camp on all the rest. That lines up with
   *  what players observe — "all creeps who protect a gold mine will be aggressive and other
   *  creeps will be passive, so you more safely can build near them" (warcraft3.info,
   *  "Interacting With Creeps") — so we read Camp as "deaf to construction". The split is an
   *  inference from those two facts together, not something any file states outright.
   *
   *  The notified creep is an originator (it was shouted at directly), so it may call its
   *  own camp in — that is how one Peasant's foundation brings the whole mine camp. */
  private notifyCreepsOfPlacement(b: SimUnit): void {
    for (const c of this.units.values()) {
      if (!c.isCreep || c.hp <= 0 || c.returning || c.campGuard || !c.weapon) continue;
      if (!this.hostile(c, b)) continue;
      if (Math.hypot(b.x - c.x, b.y - c.y) - b.radius > BUILDING_PLACEMENT_NOTIFY_RADIUS) continue;
      c.asleep = false;
      c.campHelper = false; // notified in its own right — it may shout for the rest of the camp
      this.issueAttack(c.id, b.id);
      this.alertCamp(c, b);
    }
  }

  /** A hostile currently being fought by a live camp-mate of `u`, or null. Used to
   *  keep the camp committed as one: while any member is engaged, the rest rejoin
   *  rather than idling at the post or peeling off home — even when the fight has
   *  been kited out near the leash limit (the exact case where a lone creep used to
   *  be left fighting while its camp sat back).
   *
   *  Only an ORIGINATOR anchors the camp — one that acquired the enemy inside its own
   *  aggro range or was struck by it. A camp-mate that is itself only answering a shout
   *  (campHelper) is skipped, so the call can't hop from camp to camp (issue #55). */
  private campFightTarget(u: SimUnit): SimUnit | null {
    for (const c of this.units.values()) {
      if (c === u || !c.isCreep || c.hp <= 0 || c.returning || c.campHelper) continue;
      if (c.order !== "attack" || c.targetId === null) continue;
      if (!this.sameCamp(c, u)) continue;
      const t = this.units.get(c.targetId);
      if (t && this.hostile(u, t) && this.canAttack(u, t)) return t;
    }
    return null;
  }

  // --- movement -----------------------------------------------------------

  /** Proactive reroute (issue #6). Every REPATH_POLL seconds a moving ground unit
   *  re-checks the path just ahead; if another unit has stopped and reserved cells
   *  across it since the path was computed, recompute the route toward the same
   *  goal so we steer AROUND the crowd instead of forcing through it. Applies to
   *  every moving footprint unit — player move/attack/patrol orders and creeps
   *  returning home alike — because they all set chaseX/chaseY via pathTo(). Cheap
   *  by design: the lookahead scan runs on the poll tick and only the genuinely-
   *  blocked minority pay for a fresh A*; a moving crowd reserves no cells, so we
   *  never thrash rerouting around our own squadmates. checkStuck() stays the
   *  backstop for the boxed-in case where no better route exists. */
  private repathPoll(u: SimUnit, dt: number): void {
    // Flyers (footprint 0) path straight and ignore ground occupancy; ghosting
    // workers (mining) pass through units, so neither reroutes.
    if (u.footprint <= 0 || u.noCollision) return;
    if (u.repathT > 0) return; // just got blocked — honour the chaser repath cooldown
    u.repollT -= dt;
    if (u.repollT > 0) return;
    u.repollT = REPATH_POLL;
    if (u.waypoint >= u.path.length) return; // nothing left to walk
    if (!this.pathAheadBlocked(u)) return;
    if (this.repathsThisStep >= REPATH_BUDGET_PER_STEP) return; // …next poll, then
    this.repathsThisStep++;
    this.pathTo(u, u.chaseX, u.chaseY); // reroute toward the same goal
  }

  /** True when the remaining path — out to REPATH_LOOKAHEAD ahead — now runs
   *  through a cell the mover's footprint no longer fits, i.e. a unit has stopped
   *  and reserved cells across our route. Cheap: a bounded half-cell walk of the
   *  path polyline, no A*. Uses the SAME clearance predicate A* would, so it only
   *  flags obstructions A* would actually route around. */
  private pathAheadBlocked(u: SimUnit): boolean {
    const start = this.grid.footprintAnchor(u.x, u.y, u.footprint);
    const blocked = this.clearanceBlocker(u, start);
    if (!blocked) return false; // footprint-less mover — nothing to check
    const stepLen = PATHING_CELL * 0.5;
    let remaining = REPATH_LOOKAHEAD;
    let px = u.x;
    let py = u.y;
    for (let i = u.waypoint; i < u.path.length && remaining > 0; i++) {
      const [wx, wy] = u.path[i];
      const segDx = wx - px;
      const segDy = wy - py;
      const segLen = Math.hypot(segDx, segDy);
      if (segLen > 0) {
        const ux = segDx / segLen;
        const uy = segDy / segLen;
        for (let d = stepLen; d <= segLen && remaining > 0; d += stepLen) {
          // Anchor space, like every other cell the clearance predicate is asked about.
          const [cx, cy] = this.grid.footprintAnchor(px + ux * d, py + uy * d, u.footprint);
          if (blocked(cx, cy)) return true;
          remaining -= stepLen;
        }
      }
      px = wx;
      py = wy;
    }
    return false;
  }

  /**
   * Route a FLYER around the unplayable area (issue #117) — the only obstacle air movement
   * has. Returns the waypoints, or null when there is no way round at all (in which case the
   * caller keeps the straight line and the destination clamp has already pulled the target
   * inside the map).
   *
   * No `blocked` predicate and no footprint: a flyer is not stopped by a crowd, and the air
   * domain reads no stamps. Smoothed with the same string-pull the ground path gets, so the
   * result is a couple of long straight runs around the strip rather than a 45° staircase —
   * which for something that visibly banks and turns matters more than it does for a Footman.
   * The last waypoint is replaced with the ORDERED point so the flyer finishes exactly where
   * it was sent rather than on a cell centre.
   */
  private airPath(u: SimUnit, tx: number, ty: number, maxExpansions?: number): Array<[number, number]> | null {
    const start = this.grid.worldToCell(u.x, u.y);
    const goal = this.grid.worldToCell(tx, ty);
    const cells = findPath(this.grid, start, goal, undefined, maxExpansions, "air");
    if (!cells || cells.length <= 1) return null;
    const smoothed = smoothPath(this.grid, cells, undefined, "air");
    const pts = smoothed.slice(1).map(([cx, cy]) => this.grid.cellToWorld(cx, cy)) as Array<[number, number]>;
    if (!pts.length) return null;
    pts[pts.length - 1] = [tx, ty];
    return pts;
  }

  /** Set a path toward a world point (straight line for air units). False when
   *  no movement toward the point is possible at all.
   *
   *  `avoidMovers` widens the clearance test from "cells a STOPPED unit reserves" to "cells
   *  anybody is holding, walking units included". Off by default on purpose: WC3 paths
   *  through a crowd that is itself on the move, and a group marching together would
   *  otherwise re-route around its own members every few metres. It goes on only for the
   *  reroute a genuinely blocked unit makes — the disruption the issue describes, where the
   *  way is shut right now and the answer is to go round rather than to keep pushing.
   *
   *  `approach` says the goal is a THING standing on (tx,ty) with these half-extents, not a
   *  spot: walk up to its box and stop, taking the fastest route to anywhere against it
   *  rather than the nearest cell to its unreachable centre. See findPath's `arrived`. */
  private pathTo(
    u: SimUnit,
    tx: number,
    ty: number,
    maxExpansions?: number,
    avoidMovers = false,
    approach?: { hx: number; hy: number },
  ): boolean {
    // A re-path at the SAME goal inherits the approach. Every reroute (blocked, stuck,
    // repath-poll) re-aims at chaseX/chaseY without knowing what is standing there, and
    // without this the order would quietly degrade to "walk to the middle of that
    // building" — unreachable ground whose goal-snapping lands on one fixed side, which is
    // how two units out of six ended up hiking round to the far face.
    if (!approach && u.chaseHX > 0 && tx === u.chaseX && ty === u.chaseY) {
      approach = { hx: u.chaseHX, hy: u.chaseHY };
    }
    // The black border is the ONE thing a flyer may not cross (issue #117): war3map.wpm sets
    // `Unflyable` on the unplayable area and on nothing else, which is exactly the difference
    // between it and a cliff. A ground unit already has this — the same cells are Unwalkable
    // and findPath snaps the goal to the nearest walkable one — so it is only the straight
    // line below that needs telling, and it is told the same way: aim at the nearest cell
    // inside the map instead. (The LINE is still straight, so a flyer sent across a strip of
    // "Nothing" painted mid-map crosses it rather than routing round; the border itself is a
    // frame, and no straight line between two points inside a frame leaves it.)
    if (u.flying && this.grid && !this.grid.playableAt(tx, ty)) {
      const [bx, by] = this.grid.worldToCell(tx, ty);
      const spot = this.grid.nearestPlayable(bx, by);
      if (!spot) return false;
      [tx, ty] = this.grid.cellToWorld(spot[0], spot[1]);
    }
    u.chaseX = tx;
    u.chaseY = ty;
    u.chaseHX = approach?.hx ?? 0;
    u.chaseHY = approach?.hy ?? 0;
    if (u.flying) {
      // Air units ignore the pathing grid (fly over trees/cliffs/buildings) — straight line
      // to the target. Height is applied by the renderer.
      //
      // With ONE exception, and it is the whole of air pathing: the unplayable area (issue
      // #117). A flyer may not cross the black, so when the straight line would, it searches
      // instead — the same A* every ground unit runs, over the same grid, read through the
      // air domain (`Unflyable` alone: no cliffs, no trees, no buildings, no crowd). The
      // segment test is what keeps that off the hot path: on an ordinary map nothing is in
      // the way and the line stands, which is what it costs to fly across open ground.
      if (!this.grid.segmentPlayable(u.x, u.y, tx, ty)) {
        const air = this.airPath(u, tx, ty, maxExpansions);
        if (air) {
          u.path = air;
          u.waypoint = 0;
          u.moving = true;
          return true;
        }
      }
      u.path = [[tx, ty]];
      u.waypoint = 0;
      u.moving = true;
      return true;
    }
    // Release our own cells while pathing so they don't block us, but re-settle
    // if no path exists (position/reservation must stay consistent).
    const wasReserved = u.hasReservation;
    this.unsettle(u);
    const start = this.grid.footprintAnchor(u.x, u.y, u.footprint);
    let blocked = this.clearanceBlocker(u, start, avoidMovers);
    const domain = pathDomain(u);
    const goal = this.grid.footprintAnchor(tx, ty, u.footprint);
    // How many whole cells clear of the target this cell leaves us — 0 is "up against it".
    // Measured from the mover's own block edge (half its footprint), because that block is
    // the thing that actually has to fit, and rounded to cells so an entire face ties and
    // the cheapest one to walk to wins (findPath's `ring`).
    const half = (u.footprint || 1) * PATHING_CELL * 0.5;
    const ring = approach
      ? (cx: number, cy: number) => {
          const [wx, wy] = this.grid.footprintCenter(cx, cy, u.footprint);
          const dx = Math.max(0, Math.abs(wx - tx) - approach.hx);
          const dy = Math.max(0, Math.abs(wy - ty) - approach.hy);
          return Math.max(0, Math.round((Math.hypot(dx, dy) - half) / PATHING_CELL));
        }
      : undefined;
    let cells = findPath(this.grid, start, goal, blocked, maxExpansions, domain, ring);
    // Routing around the live crowd can leave nowhere to go at all (hemmed in on every
    // side). Fall back to the ordinary route — walk up to the obstruction and wait it out —
    // rather than reporting "no path" and standing down.
    if (avoidMovers && (!cells || cells.length <= 1)) {
      blocked = this.clearanceBlocker(u, start);
      cells = findPath(this.grid, start, goal, blocked, maxExpansions, domain, ring);
    }
    // A single-cell (or empty) result means the unit can't get any closer.
    if (!cells || cells.length <= 1) {
      if (wasReserved) this.settle(u);
      return false;
    }
    // String-pull the raw A* staircase into straight runs (same clearance
    // predicate, so it never routes anywhere A* wouldn't). This makes the unit
    // glide straight toward each turn-point instead of stepping cell-to-cell in
    // 45° increments — the per-segment heading (and thus facing) then tracks the
    // real travel direction rather than zig-zagging and snapping on arrival.
    const smoothed = smoothPath(this.grid, cells, blocked, domain);
    // Waypoints are where the unit STANDS when its footprint is anchored on that cell —
    // footprintCenter, not cellToWorld. For an EVEN footprint (every unit whose collision
    // is 16–31: a Footman, a Grunt, a Ghoul) the two are half a cell apart, and the whole
    // search is run in anchor space: the clearance predicate checks the block
    // `cx-n/2 … cx+n/2-1`, which is the block a unit standing at footprintCenter reserves,
    // and NOT the one it reserves standing at the cell centre. Walking to cell centres
    // therefore marched every even-footprint unit half a cell off the cells A* had cleared
    // for it — it would arrive somewhere it did not fit, get shoved back, and re-path.
    // When the path actually reaches the target cell (best-effort paths stop short), finish
    // on the footprint-aligned point so the unit settles exactly onto the cells it reserves.
    const pts = smoothed.slice(1).map(([cx, cy]) => this.grid.footprintCenter(cx, cy, u.footprint)) as Array<[number, number]>;
    const [lastX, lastY] = pts[pts.length - 1];
    // …but never for an approach: (tx,ty) is the middle of the thing we walked up to, and
    // stepping onto it is the one place the unit must not go.
    if (!approach && Math.hypot(tx - lastX, ty - lastY) <= PATHING_CELL) {
      pts.push(this.grid.snapForFootprint(tx, ty, u.footprint));
    }
    u.path = pts;
    u.waypoint = 0;
    u.moving = true;
    return true;
  }

  /** The way is shut by other bodies. KEEP the order and park: settle onto our own tile so
   *  we stop grinding at the crowd, face where we were sent, and pick the route up again in
   *  a moment (resumeRoute). The wait grows with the length of the jam so a long one costs
   *  almost nothing, and nothing here ends the order — that is the whole point (issue #108:
   *  units that stood still a moment used to have their move / attack-move cancelled). */
  private parkAndWait(u: SimUnit): void {
    // Stop walking, but do NOT settle. A unit waiting its turn at a choke has not STOPPED,
    // it is still on its way — and that distinction is load-bearing here, because settling
    // RESERVES cells and reservations are walls to the pathfinder. A queue that all settled
    // in front of a gap became a wall to itself: every one of them blocked every other's
    // route and the whole group sat there with the way ahead wide open. Holding the walking
    // CLAIM instead leaves them solid to each other's MOVEMENT while staying transparent to
    // each other's ROUTING, which is precisely the difference the two layers exist to draw.
    // (tickMovement's claim pass keeps a parked unit's claim alive off waitT.)
    u.moving = false;
    u.path = [];
    u.waypoint = 0;
    u.stuckT = 0;
    u.waitT = Math.min(BLOCKED_WAIT * Math.max(1, u.stuckRetries), BLOCKED_WAIT_MAX);
    u.stuckRetries++;
    u.desiredFacing = Math.atan2(u.chaseY - u.y, u.chaseX - u.x);
  }

  /** Ask whoever is corking us to shuffle aside — WC3 units make way for one another, and
   *  without that a queue at a narrow gap can cork itself for good. Two units waiting on
   *  either side of a two-cell corridor each hold ONE of the rows the next unit needs
   *  (blocks are two cells a side but sit on a one-cell stride, so neighbouring blocks
   *  overlap the one between them), and neither has any reason to budge. One tile of
   *  sideways shuffle from either of them frees the corridor for everybody.
   *
   *  Only an ally that is standing about — parked on its own blocked order, or plain idle —
   *  is ever asked. Nobody is shoved off a job, off a Hold, or out of a fight. */
  private makeWay(u: SimUnit): void {
    const n = u.footprint;
    if (n <= 0 || u.waypoint >= u.path.length) return;
    const [wx, wy] = u.path[u.waypoint];
    const d = Math.hypot(wx - u.x, wy - u.y);
    if (d < 1e-3) return;
    // The block we just failed to take: one cell further along the way we were heading.
    const [bx0, by0] = this.grid.footprintOrigin(u.x + ((wx - u.x) / d) * PATHING_CELL, u.y + ((wy - u.y) / d) * PATHING_CELL, n);
    for (const o of this.units.values()) {
      if (o === u || o.moving || o.building || o.speed <= 0 || o.footprint <= 0) continue;
      if (o.team !== u.team || o.hp <= 0 || isOffField(o)) continue;
      if (!(o.waitT > 0 || o.order === "idle")) continue; // busy with something of its own
      const m = o.footprint;
      const [ox0, oy0] = this.grid.footprintOrigin(o.x, o.y, m);
      if (!(ox0 < bx0 + n && bx0 < ox0 + m && oy0 < by0 + n && by0 < oy0 + m)) continue; // not in our way
      // A tile of its own to step onto: any neighbouring block it fits in that is clear of
      // the one we want. Nearest ring first, so the shuffle is as small as it can be.
      for (let r = 1; r <= 2 && !o.moving; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const cx0 = ox0 + dx;
            const cy0 = oy0 + dy;
            if (cx0 < bx0 + n && bx0 < cx0 + m && cy0 < by0 + n && by0 < cy0 + m) continue; // still in the way
            if (!this.blockClaimable(o, cx0, cy0)) continue;
            const [sx, sy] = this.grid.footprintCenter(cx0 + (m >> 1), cy0 + (m >> 1), m);
            // Written onto the path directly rather than through pathTo(), so the ally's
            // OWN destination (chaseX/chaseY) survives the errand: it steps out of the way
            // and then carries straight on with the order it was already under.
            o.path = [[sx, sy]];
            o.waypoint = 0;
            o.moving = true;
            o.waitT = 0;
            o.stuckT = 0;
            o.desiredFacing = Math.atan2(sy - o.y, sx - o.x);
            break;
          }
          if (o.moving) break;
        }
      }
      if (o.moving) return; // one is enough — the corridor only needs one row back
    }
  }

  /** The way is shut. Keep the order and WAIT when only bodies are in the way — they move,
   *  so where the unit was sent is still where it is going. End it only when the terrain
   *  itself puts the destination out of reach, because no amount of waiting opens a cliff.
   *  Every give-up path for a move / attack-move / patrol goes through here (issue #108). */
  private holdOrGiveUp(u: SimUnit, tx: number, ty: number): void {
    if (this.terrainReachable(u, tx, ty)) {
      this.parkAndWait(u);
      return;
    }
    this.stop(u.id);
    u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
  }

  /** Has this mover actually got where it was sent? A plain point means standing within a
   *  body or two of it — closer than that is the crowd standing on the spot, and WC3 stops
   *  there rather than shoving. An APPROACH (a move that named a unit or building) aims at
   *  the middle of the thing, ground the unit can never stand on, so arrival there is
   *  standing against its box. */
  private atMoveGoal(u: SimUnit): boolean {
    const dx = Math.abs(u.chaseX - u.x);
    const dy = Math.abs(u.chaseY - u.y);
    if (u.chaseHX > 0) {
      const ox = Math.max(0, dx - u.chaseHX);
      const oy = Math.max(0, dy - u.chaseHY);
      return Math.hypot(ox, oy) <= (u.footprint || 1) * PATHING_CELL * 0.5 + PATHING_CELL * 1.5;
    }
    return Math.hypot(dx, dy) <= PATHING_CELL * 2;
  }

  /** A parked mover picking its route back up once the wait lapses. True when it is walking
   *  again. Standing within a body or two of the ordered point counts as having ARRIVED —
   *  the crowd on the spot is the only thing left between us and it, and WC3 stops there
   *  rather than shoving. */
  private resumeRoute(u: SimUnit): boolean {
    if (u.waitT > 0) return false; // still counting down
    if (this.atMoveGoal(u)) {
      this.stop(u.id); // as close as the crowd allows — that IS arriving
      u.desiredFacing = Math.atan2(u.chaseY - u.y, u.chaseX - u.x);
      return false;
    }
    if (this.pathTo(u, u.chaseX, u.chaseY)) return true;
    this.holdOrGiveUp(u, u.chaseX, u.chaseY);
    return false;
  }

  /** Could this unit get there if nobody else were in the way — is the destination reachable
   *  through the TERRAIN? The question that decides whether a blocked mover keeps its order
   *  (bodies move, so wait them out) or gives it up (a cliff does not). Deliberately a
   *  separate, unit-blind search rather than a flag on the usual one: the ordinary clearance
   *  test cannot tell "a Grunt is standing there" from "that is a cliff", and those two
   *  deserve opposite answers. Run only when a unit is about to give up, so it is rare. */
  private terrainReachable(u: SimUnit, tx: number, ty: number): boolean {
    const n = u.footprint;
    const domain = pathDomain(u);
    const start = this.grid.footprintAnchor(u.x, u.y, n);
    const goal = this.grid.footprintAnchor(tx, ty, n);
    const half = n >> 1;
    const blocked =
      n <= 0
        ? undefined
        : (cx: number, cy: number) => {
            for (let y = cy - half; y < cy - half + n; y++)
              for (let x = cx - half; x < cx - half + n; x++) if (!this.grid.walkable(x, y, domain)) return true;
            return false;
          };
    const cells = findPath(this.grid, start, goal, blocked, undefined, domain);
    if (!cells || cells.length <= 1) return false;
    const [ecx, ecy] = cells[cells.length - 1];
    const [ex, ey] = this.grid.footprintCenter(ecx, ecy, n);
    return Math.hypot(tx - ex, ty - ey) <= PATHING_CELL * 2;
  }

  /** After finishing a path that stopped short of the ordered point, try again
   *  when the goal's cells have been vacated in the meantime. */
  private retryFreedGoal(u: SimUnit): boolean {
    if (u.stuckRetries >= 2) return false;
    if (Math.hypot(u.chaseX - u.x, u.chaseY - u.y) <= PATHING_CELL * 1.5) return false;
    const n = u.footprint;
    if (n > 0) {
      const [sx, sy] = this.grid.snapForFootprint(u.chaseX, u.chaseY, n);
      const [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
      const domain = pathDomain(u);
      for (let y = cy0; y < cy0 + n; y++) {
        for (let x = cx0; x < cx0 + n; x++) {
          if (!this.grid.walkable(x, y, domain) || this.grid.isOccupied(x, y)) return false;
        }
      }
    }
    u.stuckRetries++;
    return this.pathTo(u, u.chaseX, u.chaseY);
  }

  /** WC3-style clearance test for pathfinding: the mover's own n×n cell footprint
   *  must fit on statically-walkable, unreserved cells at every path node. A
   *  reserved cell is exempt ONLY where it belongs to the unit's OWN starting
   *  footprint — so a unit that spawned overlapping others (or that another unit
   *  settled on top of) can still path out of its own cells, without the exemption
   *  extending to neighbours (a 3×3 margin let a unit hugging a reserved wall route
   *  straight through it — half the "units squeeze through" of issue #24). */
  private clearanceBlocker(
    self: SimUnit,
    start: [number, number],
    avoidMovers = false,
  ): ((cx: number, cy: number) => boolean) | undefined {
    const n = self.footprint;
    if (n <= 0) return undefined;
    const [sx, sy] = start;
    const half = n >> 1;
    const ownX0 = sx - half; // the unit's own footprint (reservation-exempt) origin
    const ownY0 = sy - half;
    const domain = pathDomain(self);
    // Normally only STOPPED units are walls (see pathTo's `avoidMovers`); a blocked unit's
    // reroute widens it to everyone currently holding ground, walkers included.
    const held = avoidMovers
      ? (x: number, y: number) => this.grid.isOccupied(x, y)
      : (x: number, y: number) => this.grid.isReserved(x, y);
    return (cx, cy) => {
      const cx0 = cx - half;
      const cy0 = cy - half;
      for (let y = cy0; y < cy0 + n; y++) {
        for (let x = cx0; x < cx0 + n; x++) {
          if (!this.grid.walkable(x, y, domain)) return true;
          if (held(x, y)) {
            const own = x >= ownX0 && x < ownX0 + n && y >= ownY0 && y < ownY0 + n;
            if (!own) return true;
          }
        }
      }
      return false;
    };
  }

  /** Reroutes already spent this sim step — see REPATH_BUDGET_PER_STEP. Reset here rather
   *  than in step() because tickMovement is the only pass that spends it, and a counter reset
   *  next to what spends it cannot drift away from it. */
  private repathsThisStep = 0;

  private tickMovement(dt: number): void {
    this.repathsThisStep = 0;
    // Every walker takes the block it is standing on BEFORE anyone takes a step. Done in
    // its own pass because the claims have to be complete for the stepping pass to mean
    // anything: whoever ran first would otherwise walk straight over a unit that had not
    // got round to claiming its own ground yet, and iteration order would decide who wins.
    for (const u of this.units.values()) {
      // Stopped, dead, boarded or ghosting: a claim it may still hold is stale. (settle()
      // normally hands it back; this catches every other way movement can end.)
      if ((u.moving || u.waitT > 0) && this.claimsCells(u)) this.ensureClaim(u);
      else if (u.hasClaim) this.releaseClaim(u);
    }
    for (const u of this.units.values()) {
      if (!u.moving || !u.path.length) continue; // parked units hold a claim but walk nowhere
      // Still materializing: a raised Skeleton is climbing out of the ground and has no feet
      // to walk on yet. The order switch already skips a `spawning` unit (tickUnits), but an
      // order given DURING the birth sets `moving` and this pass would have honoured it —
      // so a Rod of Necromancy's pair slid across the map while still half-buried. The order
      // is kept, not refused: WC3 lets you queue one and the unit leaves the instant it is up.
      if (u.spawning > 0) continue;
      // Proactively reroute around units that have stopped across our path since
      // it was computed (issue #6), before we grind into them (checkStuck backstop).
      this.repathPoll(u, dt);
      if (u.yieldT > 0) {
        // Giving way to an oncoming unit: hold position this tick (the shared
        // turning pass still lets it keep facing its heading) so the other passes.
        u.yieldT -= dt;
        continue;
      }
      let budget = u.speed * dt;
      let dirX = 0;
      let dirY = 0;
      let blocked = false;
      while (budget > 0 && u.waypoint < u.path.length) {
        const isLast = u.waypoint === u.path.length - 1;
        const [wx, wy] = u.path[u.waypoint];
        const dx = wx - u.x;
        const dy = wy - u.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= ARRIVE_EPS) {
          u.waypoint++;
          continue;
        }
        const ux = dx / dist;
        const uy = dy / dist;
        const step = Math.min(budget, dist);
        // The tile has to be OURS before we glide onto it (issue #108). claimStep takes the
        // block the step would land us in and only then moves us; if another unit holds it,
        // we stay exactly where we are this tick rather than sliding in and being shoved
        // back out. That is what makes standing in front of a unit actually stop it.
        if (!this.claimStep(u, u.x + ux * step, u.y + uy * step)) {
          blocked = true;
          break;
        }
        budget -= step;
        // Steer facing from real travel segments only. pathTo appends a sub-cell
        // "footprint-snap" nudge as the final waypoint (so even-footprint units
        // settle onto their reserved corner without a position pop); that nudge
        // points along an arbitrary axis/diagonal and must NOT hijack the heading
        // on the last ticks — leave desiredFacing on the true approach heading.
        if (!(isLast && dist < PATHING_CELL)) {
          dirX = ux;
          dirY = uy;
        }
        if (dist - step <= ARRIVE_EPS) u.waypoint++;
      }
      // Face the movement direction; the shared turning pass rotates at the
      // unit's turn rate (and keeps rotating after arrival if needed).
      if (dirX || dirY) {
        u.desiredFacing = Math.atan2(dirY, dirX);
      }
      if (blocked) {
        // Held up by a body in the way. This is the case the issue describes as
        // path-finding disruption: the way is shut, so recalculate and route AROUND rather
        // than grind into it. The reroute treats the crowd's current cells as walls too
        // (avoidMovers) so it genuinely goes round; if that leaves nowhere to go it falls
        // back to the ordinary route and waits the blocker out. checkStuck is still the
        // longer backstop for a unit that is simply boxed in.
        u.blockedT += dt;
        if (u.blockedT >= BLOCKED_REPATH_TIME) {
          u.blockedT = 0;
          if (u.waypoint < u.path.length && !u.flying) {
            this.makeWay(u); // ask an idle/parked ally standing in the gap to shuffle over
            this.pathTo(u, u.chaseX, u.chaseY, undefined, true);
          }
        }
        continue;
      }
      u.blockedT = 0;
      if (u.waypoint >= u.path.length) {
        // A best-effort path may have stopped short because the goal cells
        // were reserved when it was computed; if the blocker has since left,
        // continue to the real goal (bounded retries).
        if ((u.order === "move" || u.order === "attackmove") && this.retryFreedGoal(u)) continue;
        // Patrol: reached one endpoint — turn around and head to the other.
        if (u.order === "patrol") {
          const nx = u.patrolX;
          const ny = u.patrolY;
          u.patrolX = u.chaseX; // the endpoint just reached becomes the return point
          u.patrolY = u.chaseY;
          if (!this.pathTo(u, nx, ny)) this.holdOrGiveUp(u, nx, ny);
          continue;
        }
        // A move ends when it has actually got WHERE IT WAS SENT — not merely because its
        // path ran out. Those are different things: a best-effort route around a blocker
        // ends short of the goal, and treating that as arrival is what cancelled a move the
        // moment a crowd got in the way (issue #108). Falling short parks instead, and
        // resumeRoute picks the order back up. An attack-move already worked this way.
        const arrived =
          (u.order === "move" && this.atMoveGoal(u)) ||
          (u.order === "attackmove" && Math.hypot(u.amDestX - u.x, u.amDestY - u.y) <= PATHING_CELL * 1.5);
        if (arrived) {
          // Flip to idle BEFORE settling so a finished attack-move fans out at its
          // destination exactly like a move does — settle() only spreads onto a free
          // tile for non-combat orders, and while the order still reads "attackmove" it
          // would cram every unit onto the one destination tile instead (issue #24: make
          // attack-move's arrival behave like move). Its en-route fighting is unchanged.
          u.order = "idle";
          this.settle(u); // snaps onto the grid, to a free tile if this one's taken (fan-out)
          // Keep the heading the unit travelled with: pin desiredFacing onto the
          // current facing so the shared turning pass (which keeps rotating even
          // a stopped unit toward desiredFacing) has nothing left to do. Without
          // this a unit that arrived mid-turn would keep swivelling to its last
          // path segment after halting — a visible "snap". u.facing is still last
          // tick's smoothed travel heading here (the turning pass runs later this
          // tick), so it lands facing the way it came — as WC3 units do. Belt-and-
          // suspenders alongside path smoothing + the final-nudge guard above.
          u.desiredFacing = u.facing;
        } else if (u.order === "move") {
          this.holdOrGiveUp(u, u.chaseX, u.chaseY); // fell short — hold it, or end it if walled off
        } else {
          this.settle(u); // attack-move paused mid-chase: settle in place and keep fighting
        }
      }
    }
  }

  // Keep overlapping ground units apart (WC3 circle collision) WITHOUT pushing:
  // WC3 units never displace others. A moving unit that runs into a stationary
  // one is shoved back out itself (net effect: blocked; checkStuck() then makes
  // it give up). Two moving units split the correction, letting them slide past
  // each other. Stationary pairs are left alone. Air units and footprint-less
  // units (radius 0) are excluded. O(n²) — fine for melee-scale counts; a
  // spatial grid is the scale-up path.
  private resolveCollisions(): void {
    const list: SimUnit[] = [];
    // Movable ground units only. Buildings (speed 0) block via their stamped grid
    // footprint, not separation; air units don't collide; mining workers ghost
    // through everything until manually controlled (u.noCollision). A unit that is OFF THE
    // FIELD is not there to collide with either — and a passenger is the case that bites,
    // because it rides at its carrier's exact position: the two then read as one unit
    // standing inside another, and the separation pass shoved the ship off its course a few
    // hundred units into the voyage. (A mining peon or a devoured sheep was only ever saved
    // from the same fate by sitting inside a building's footprint.)
    for (const u of this.units.values())
      if (!u.flying && u.radius > 0 && u.speed > 0 && !u.noCollision && !isOffField(u)) list.push(u);
    // Snapshot each unit's intended (pathed) velocity for this tick, captured
    // before the nudges below mutate positions. prevX/prevY are set pre-movement,
    // so (x-prevX) is the step tickMovement just took toward the goal — used to
    // tell head-on closers (slide past) from units circling or brushing shoulders
    // (separate radially only, so they don't feed a perpetual orbit = "dancing").
    for (const u of list) {
      u.velX = u.x - u.prevX;
      u.velY = u.y - u.prevY;
    }
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (!a.moving && !b.moving) continue; // nobody to blame — leave them
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const min = a.radius + b.radius;
          let d = Math.hypot(dx, dy);
          if (d >= min) continue;
          if (d === 0) {
            dx = 1;
            dy = 0;
            d = 1;
          }
          const overlap = min - d;
          if (a.moving && b.moving) {
            const nx = dx / d; // unit vector a→b
            const ny = dy / d;
            const half = overlap / 2;
            // Tangential slide ONLY when the pair is genuinely closing head-on
            // (relative velocity shrinks the gap) — that's the deadlock case the
            // slide is meant to break. Parallel/circling pairs (relative velocity
            // perpendicular to the gap) get pure radial separation, so nothing
            // keeps spinning them around each other.
            const closing = (b.velX - a.velX) * nx + (b.velY - a.velY) * ny < -1e-4;
            if (closing && a.yieldT <= 0 && b.yieldT <= 0) {
              // Head-on: rather than both sidestepping forever (the "dance"), the
              // lower-priority unit (higher id) pauses a beat so the other clears.
              // The guard (neither already yielding) keeps it a one-shot pause per
              // encounter, not a re-armed freeze; checkStuck() is the backstop if the
              // way never opens.
              (a.id > b.id ? a : b).yieldT = YIELD_TIME;
            }
            const tx = closing ? -ny * half : 0;
            const ty = closing ? nx * half : 0;
            this.nudge(a, -nx * half + tx, -ny * half + ty);
            this.nudge(b, nx * half - tx, ny * half - ty);
          } else if (a.moving) {
            this.nudge(a, (-dx / d) * overlap, (-dy / d) * overlap);
          } else {
            this.nudge(b, (dx / d) * overlap, (dy / d) * overlap);
          }
        }
      }
    }
  }


  // Fan stopped air units apart (issue #31). Flyers cruise with no collision (they
  // fly over everything), so a moving group is a single point and they stack exactly
  // on top of each other once they arrive or converge on a target. WC3 flyers don't
  // stack: the moment they stop they glide apart until their hulls clear. So this
  // acts on air units that are NOT moving — i.e. those that have reached their
  // destination or are holding position while fighting — and leaves cruising flyers
  // untouched (they still pass freely through the air). Both units in an overlapping
  // pair are stationary, so the correction is split evenly and each drifts out; the
  // per-unit step is capped to a share of its move speed so a clump spreads over a
  // few frames instead of popping. Air-vs-air only; ground collision is separate.
  private resolveAirSeparation(dt: number): void {
    const list: SimUnit[] = [];
    for (const u of this.units.values())
      if (u.flying && u.radius > 0 && !u.moving && !u.noCollision && u.hp > 0) list.push(u);
    if (list.length < 2) return;
    // Accumulate every pair's desired push, then apply once (capped) per unit — so a
    // flyer buried in a stack drifts out smoothly instead of jerking pair-by-pair.
    const pushX = new Float64Array(list.length);
    const pushY = new Float64Array(list.length);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const min = a.radius + b.radius;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d === 0) {
          // Exact stack (a group that arrived on one point): split along a
          // deterministic per-unit heading (golden angle, no RNG — the sim is
          // lockstep) so the pile bursts into a ring rather than a single line.
          const ang = a.id * 2.399963;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d = 1;
        }
        const half = (min - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        pushX[i] -= nx * half;
        pushY[i] -= ny * half;
        pushX[j] += nx * half;
        pushY[j] += ny * half;
      }
    }
    for (let i = 0; i < list.length; i++) {
      let px = pushX[i];
      let py = pushY[i];
      const mag = Math.hypot(px, py);
      if (mag <= 1e-6) continue;
      const maxStep = list[i].speed * AIR_FANOUT_SPEED * dt;
      if (maxStep > 0 && mag > maxStep) {
        px = (px / mag) * maxStep;
        py = (py / mag) * maxStep;
      }
      list[i].x += px;
      list[i].y += py;
    }
  }

  // Move a unit, but never onto an unwalkable cell (don't push units into walls).
  private nudge(u: SimUnit, dx: number, dy: number): void {
    const nx = u.x + dx;
    const ny = u.y + dy;
    // Collision separation must honour the pathing grid, not brute-force through it
    // (issue #24: "units squeeze through others that don't fit"). A shove may only slide
    // a unit to a spot where its whole FOOTPRINT fits: never onto unwalkable terrain,
    // and never DEEPER into cells another (settled) unit has reserved. Checking only the
    // centre cell's walkability — as this did — let repeated shoves in a crowd walk a
    // unit's centre straight through a standing unit or a gap too small for its body.
    // "Deeper" (not "any overlap") is deliberate: a unit that a settle() reserved on top
    // of can still be pushed OUT, and moving units (which hold no reservation) still
    // separate normally via the circle push — only intrusion into reserved cells is
    // blocked, which is exactly the grid's "this tile isn't reachable for your size".
    if (!this.footprintWalkableAt(u, nx, ny)) return;
    if (this.footprintReservedAt(u, nx, ny) > this.footprintReservedAt(u, u.x, u.y)) return;
    // Go through claimStep, not a bare assignment: a shove that carries the unit into a
    // NEW cell block has to take that block first, exactly as a walked step does — else
    // separation would be the back door through which a unit slides into a tile its own
    // movement is forbidden from entering, and its claim would be left behind on the block
    // it no longer stands on.
    this.claimStep(u, nx, ny);
  }

  /** True if every cell under `u`'s footprint anchored at world (wx,wy) is walkable
   *  terrain. Footprint-less movers (radius 0 / flyers) test just the centre cell. */
  private footprintWalkableAt(u: SimUnit, wx: number, wy: number): boolean {
    const n = u.footprint;
    const domain = pathDomain(u);
    const [cx, cy] = this.grid.footprintAnchor(wx, wy, n);
    if (n <= 0) return this.grid.walkable(cx, cy, domain);
    const half = n >> 1;
    for (let y = cy - half; y < cy - half + n; y++)
      for (let x = cx - half; x < cx - half + n; x++)
        if (!this.grid.walkable(x, y, domain)) return false;
    return true;
  }

  /** How many cells under `u`'s footprint anchored at (wx,wy) another unit is holding —
   *  the "how far into someone else's space" measure nudge() guards on. Both layers count:
   *  a stopped unit's reservation and a walker's claim are equally "not yours". Cells inside
   *  `u`'s OWN claim are its own, so a shove that only slides it around inside the tile it
   *  holds is always allowed — which is what keeps the separation pass working at all. */
  private footprintReservedAt(u: SimUnit, wx: number, wy: number): number {
    const n = u.footprint;
    if (n <= 0) return 0;
    const [cx, cy] = this.grid.footprintAnchor(wx, wy, n);
    const half = n >> 1;
    let count = 0;
    for (let y = cy - half; y < cy - half + n; y++)
      for (let x = cx - half; x < cx - half + n; x++) {
        if (u.hasClaim && x >= u.claimX && x < u.claimX + n && y >= u.claimY && y < u.claimY + n) continue;
        if (this.grid.isOccupied(x, y)) count++;
      }
    return count;
  }
}

// Fallback launch/impact height (units above ground) for missiles whose weapon has
// no launch data — every real ranged unit's impactz is ~60, so this matches the game.
const DEFAULT_MISSILE_HEIGHT = 60;

/** How far either side of a wave's front to look for units to sweep (see
 *  tickWaveProjectile). The front advances ~17 units a frame at Shock Wave's 1050, so this
 *  only has to cover the widest collision hull that can straddle it. */
const WAVE_SWEEP_MARGIN = 128;

/** Where a lightning bolt attaches to a unit: height above ground, not a world z.
 *
 *  The game already states, per unit, where a bolt leaves it and where one lands on it —
 *  UnitWeapons.slk `launchz` (the Archmage's rod at 66) and `impactz` (~60 on every real
 *  ranged unit). Reusing them keeps a Chain Lightning arriving at chest height on a
 *  footman and up on the body of a chimaera instead of at everyone's feet, without
 *  inventing a per-unit table. A flyer's ALTITUDE is deliberately not folded in here: the
 *  renderer adds each end's live `flyHeight` every frame, so a bolt strung to a gryphon
 *  rides it up rather than staying where it was when the spell went off. */
function boltZ(u: SimUnit, end: "launch" | "impact"): number {
  const w = u.weapon;
  const local = end === "launch" ? (w && w.launchZ > 0 ? w.launchZ : 0) : w && w.impactZ > 0 ? w.impactZ : 0;
  return local || DEFAULT_MISSILE_HEIGHT;
}

// World-space launch point for a missile: the unit origin plus the weapon's LOCAL
// (launchX forward, launchY left, launchZ up) offset, rotated by facing. WC3
// UnitWeapons.slk launchx/y/z — e.g. the Archmage's fireball leaves from his rod.
// Returns [worldX, worldY, heightAboveGround].
function launchPoint(u: SimUnit, lx: number, ly: number, lz: number): [number, number, number] {
  const c = Math.cos(u.facing);
  const s = Math.sin(u.facing);
  return [u.x + lx * c - ly * s, u.y + lx * s + ly * c, lz];
}

// Angular speed in rad/sec from a unit's UnitData turnrate (WC3 semantics).
/** Which "Targets Allowed" class a target answers to. WC3 sorts by what the thing IS
 *  (allegiance is the caller's business, via hostile()): a flyer is `air`, a structure is
 *  `structure`, everything else is `ground` — and a DESTRUCTIBLE carries its own class in
 *  `targType` (a gate is `debris`, never a "structure"). Shared by the weapon-slot pick and
 *  by an artillery burst's `splashTargs` list. */
function targetKeyOf(t: SimUnit): string {
  // …and a WEBBED flyer answers to `ground`, because that is where it is. Web's whole point is
  // that it "forces the target to the ground, where it can be attacked by melee units"
  // ([Aweb], the Crypt Fiend's) — the swap is not a side-effect of the ability, it IS the
  // ability, and it belongs here rather than in the handler because every question about what
  // may hit the unit comes through this one function.
  if (t.targetKey) return t.targetKey; // a destructible carries its own (`debris`, `wall`)
  if (t.flying && t.webbed) return "ground"; // …and Web overrides even the type's own answer
  // The type's own `targType` where the registry has one, and only then the guess — which is
  // right for 819 of the 836 stock rows and wrong for every ward.
  return t.targClass || (t.building ? "structure" : t.flying ? "air" : "ground");
}

function turnSpeed(turnRate: number): number {
  return Math.min(turnRate, TURN_RATE_CAP) / TURN_FRAME;
}

// Rotate `from` toward `to` by at most `maxDelta` radians, shortest direction.
function turnToward(from: number, to: number, maxDelta: number): number {
  const diff = angleDiff(from, to);
  if (Math.abs(diff) <= maxDelta) return to;
  return from + Math.sign(diff) * maxDelta;
}

// Signed shortest angular distance from `from` to `to`, in (-π, π].
function angleDiff(from: number, to: number): number {
  let diff = to - from;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

// Deterministic RNG (plan §1.4: sim stays replayable) — Park–Miller LCG.
function lcg(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
