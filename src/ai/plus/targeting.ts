import { WeaponType } from "../../data/enums";
import type { SimUnit } from "../../sim/world";
import type { PlusProfile } from "./profile";

// Computer+ — WHO a spell or an army swings at, by difficulty (issue #124).
//
// One ladder, two callers. `plus/casting.ts` asks it which unit a button should be pointed at
// and `plus/index.ts` asks it which unit the squad should kill first, and they have to be the
// same ladder or the AI fights itself: a Mountain King who stuns the Tauren while every Footman
// beside him is swinging at the Shaman is worse than either decision taken alone.
//
// **None of these numbers are Warcraft III's** — the same standing caveat as plus/profile.ts.
// Nothing in the install describes an improved AI, so unlike the race scripts (where a value is
// Blizzard's unless a comment says otherwise) every value here is OURS. Two of them do come off
// the game's own data and say so at the use site: a disable's `heroDuration` (herodur1, the
// SHORTER duration every hard crowd-control ability has on a hero) and a weapon's damage roll.
//
// Two behaviours this file exists to produce:
//
//  1. **A difficulty aims differently, not just faster.** `castDelay` already models how fast a
//     player REACTS; this models how well they CHOOSE. An easy computer reads a fight the way a
//     new player does — the biggest body on the screen is the important one — so it throws Storm
//     Bolt at the Tauren and Death Coil at the Abomination while the Shaman keeps casting. A
//     normal one values what a unit IS and mostly gets it right. An insane one also knows what a
//     spell is FOR: a nuke goes where it finishes something, a disable where it takes the most
//     damage per second out of the fight.
//  2. **It does not chase heroes.** The single most-complained-about habit of Blizzard's own
//     melee AI is that it drops everything to swing at the enemy hero, follows it out of the
//     fight, and loses the army to the units it walked past. So a HEALTHY hero here is worth
//     barely more than a soldier, and only a hero that can actually be FINISHED (`heroKillable`)
//     climbs the ladder — which is the same judgement a good player makes and the opposite of
//     the flat "a hero is worth four soldiers" this file replaces.
//  3. **A BUILDING IS NOT A TARGET WHILE ANYTHING IS DEFENDING IT — unless you are siege.**
//     Reported: the army walks into a base and punches the Farm at the edge of it while the
//     defenders kill it from behind. A building does not shoot back, does not move, and will
//     still be standing when the fight is over, so it is priced an order of magnitude under a
//     body here (`BUILDING`) — with the one exception every player makes, the building that IS
//     part of the fight (`TOWER`). The other half of the same rule is `isSiege`: a Mortar Team,
//     a Demolisher, a Glaive Thrower, a Meat Wagon or a Siege Engine is FOR the buildings and
//     is aimed at them by its caller (plus/index.ts `siegeTarget`) instead of by this ladder.

/** How well this player reads a fight. Set per difficulty in plus/profile.ts. */
export type TargetSkill =
  /** The biggest thing on the screen is the important one. */
  | "naive"
  /** Values what a unit IS, and how hurt it is. */
  | "sound"
  /** …and what the SPELL is for: kill shots, damage-per-second, hero stun durations. */
  | "expert";

/** What a target picker needs to know about the player doing the picking. */
export interface AimCtx {
  readonly skill: TargetSkill;
  /** How hard the ladder is allowed to pull onto an enemy HERO (0 = a hero is just a soldier). */
  readonly heroFocus: number;
  /** Raiding: in an enemy base, are the WORKERS the point of being there? */
  readonly harass: boolean;
}

export const aimCtx = (p: PlusProfile): AimCtx => ({
  skill: p.castTargeting, heroFocus: p.heroFocus, harass: p.harass,
});

/** What a button is FOR, as far as aiming is concerned. Mirrors `Role` in plus/casting.ts —
 *  imported as a string union rather than the type itself so the two files do not depend on
 *  each other in a circle. */
export type AimRole = "panic" | "heal" | "morph" | "disable" | "nuke" | "summon" | "buff" | "debuff" | "utility";

/** What the ability's own row says, where it changes the aim. */
export interface SpellFacts {
  /** `herodur1 / dur1` for this rank. Every hard disable in the game carries both, and the hero
   *  number is a fraction of the other — Storm Bolt is 5 s / 1.5 s, Hex 15 s / 5 s, Sleep
   *  20 s / 10 s. So a stun spent on a hero buys a third of the fight it buys on a soldier, and
   *  an expert prices it that way. 1 when the ability has no duration to shorten. */
  readonly heroDurationRatio: number;
}

// --- what a body is worth ---------------------------------------------------------------

const SOLDIER = 1;
/** Kill the support, not the meat: anything with a mana bar is doing more than its damage. */
const CASTER = 2.5;
/** A summon is leaving on its own clock; spending a spell on one is spending it on nothing. */
const SUMMON = 0.5;
const WORKER = 0.4;
/** …unless killing workers is the entire reason we walked into this base. */
const WORKER_RAID = 1.5;

/**
 * A BUILDING, as something to swing at: barely a target at all.
 *
 * Under a WORKER, which is the comparison that matters — a Peasant runs away and repairs, a
 * Farm does neither, so of the two things standing in front of an army only one of them is
 * getting more expensive to kill. Buildings are what is left when the fight is won, and the
 * whole point of the number is that anything with a pulse outbids one.
 */
const BUILDING = 0.15;
/** …except the one that is IN the fight. A tower cannot be walked away from — it goes on
 *  shooting the army's back for as long as the army is in the base — so it is priced as what
 *  it is, a soldier that cannot retreat. Above a soldier, below a caster: the developer's own
 *  "army units and towers first". */
const TOWER = 1.5;

/** A hero at full health: a strong soldier and nothing more. See the header. */
const HERO_HEALTHY = 1.15;
/** …and one that can be finished: the best target on the field, because a dead hero is a hero
 *  that is not on the map for the next minute and a half. */
const HERO_KILLABLE = 5;
/** Where the ramp between those two starts. Under this share of its hit points a hero is
 *  "killable" — the same threshold the army uses to decide a hero is worth walking towards. */
export const HERO_KILL_HP = 0.4;

/** Is this hero worth committing to? The one question that turns hero focus on. */
export const heroKillable = (u: SimUnit): boolean => u.hp / Math.max(1, u.maxHp) <= HERO_KILL_HP;

/** A building that SHOOTS — the game's own reading of "tower", and the same one `AiPlayer`
 *  already uses for `IsTowered` ("a building with a weapon on it"). `u.weapon` is the first
 *  ENABLED slot, so a Burrow with nobody in it and an un-upgraded Ancient answer no. */
export const isTower = (u: SimUnit): boolean => u.building !== null && u.weapon !== null && u.weapon.cooldown > 0;

/**
 * IS THIS UNIT SIEGE — a body whose job is the enemy's buildings?
 *
 * Read off the weapon rows rather than from a list of ids, so a custom map's artillery is siege
 * too — but the list it has to produce is the game's own, and it is written down: `AddSiege` in
 * `Scripts\common.ai` names MEAT_WAGON, MORTAR, TANK (the Siege Engine), BALLISTA (the Glaive
 * Thrower) and CATAPULT (the Demolisher). Two columns of UnitWeapons.slk name exactly those:
 *
 *  • **`weapTp` = artillery / aline.** A shot that flies at the GROUND and splashes, which is
 *    the whole artillery roster — Mortar Team, Demolisher, Meat Wagon, Glaive Thrower and the
 *    creep Catapult, and nothing else. (Their `targs1` does not even list `structure`; a
 *    building is caught by the burst's `splashTargs`, which does.)
 *  • **a STRUCTURE-ONLY slot** — `targs` that admits `structure` and neither `ground` nor
 *    `air`. A weapon that can hit nothing but buildings is a weapon the unit was given FOR
 *    buildings: the Siege Engine's cannon, the Chimaera's Corrosive Breath (which is why that
 *    slot is switched off until the upgrade is bought), and the second slot the Mortar Team,
 *    Demolisher and Meat Wagon each carry precisely because their ground shot cannot reach a
 *    wall.
 *
 * A tower is artillery too (the Cannon Tower is), hence the building test first — a siege unit
 * is something that WALKS to the buildings.
 */
export function isSiege(u: SimUnit): boolean {
  if (u.building || u.isPeon) return false;
  for (const w of u.weapons) {
    if (!w.enabled || w.cooldown <= 0) continue;
    if (w.weaponType === WeaponType.Artillery || w.weaponType === WeaponType.ArtilleryLine) return true;
    // `targetKeyOf`'s own classes (src/sim/world.ts): a building answers to `structure`, a
    // flyer to `air`, everything else to `ground`.
    if (w.targets.includes("structure") && !w.targets.includes("ground") && !w.targets.includes("air")) return true;
  }
  return false;
}

/** Hit points per point of "looks important" in the naive read. A Tauren (1300) reads as three
 *  Peons; a Grunt (700) as one and a half. This one line is the whole easy-computer behaviour. */
const NAIVE_BULK = 500;

/** Absolute hit points under which a nuke plausibly FINISHES something. A fraction is the wrong
 *  measure and this is what an expert knows that a sound player does not: 40 % of a Tauren is
 *  more hit points than a whole Footman, so "the one lowest on health" and "the one I can
 *  actually kill" are different units. */
const KILL_HP = 400;

/** A floor under the hero discount, so a disable is still POINTED at a hero rather than thrown
 *  away on a summon when the hero is the only thing in range. */
const HERO_DISABLE_FLOOR = 0.5;

/**
 * A HEAL GOES ON THE HERO FIRST — at every difficulty, including the novice one.
 *
 * The one place the anti-chase reading above has to be inverted rather than reused. `bodyValue`
 * deliberately prices a healthy enemy hero at barely more than a soldier, and read as-is that
 * says a Paladin should heal the Footman at 40 % before his own Archmage at 45 % — which is
 * nobody's play at any level. Our own hero is the unit the whole army is arranged around, the
 * one carrying the items, and the one whose death costs a minute and a half and a revival fee.
 *
 * Not so large that it overrides how hurt somebody is: the wound multiplier reaches 3 at a
 * sliver of health, so a soldier under about a fifth of its life still outbids a hero that is
 * merely scratched. It is a preference, which is what "heroes have priority" means — at 2 it
 * would be a rule, and no soldier could ever be healed while a hero anywhere in range was one
 * point down.
 *
 * The `naive` read is the exception and is left alone on purpose: it aims by BULK, so a hero's
 * own hit points already put it in front and an easy computer heals the hero more or less
 * regardless. That is the same player who Storm Bolts your Tauren.
 */
const HEAL_HERO = 1.5;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Average damage per second, off the weapon's own roll (`damage + dice×(sides+1)/2`, the
 *  sim's own `rollDamage` shape). The expert's measure of "who is hurting us most". */
function threat(u: SimUnit): number {
  const w = u.weapon;
  if (!w || !w.enabled || w.cooldown <= 0) return 0;
  return (w.damage + (w.dice * (w.sides + 1)) / 2) / w.cooldown;
}

/** What a body is worth to a player who knows what the units do. */
function bodyValue(t: SimUnit, ctx: AimCtx): number {
  if (t.building) return isTower(t) ? TOWER : BUILDING;
  if (t.isHero) {
    const frac = t.hp / Math.max(1, t.maxHp);
    const ramp = frac >= HERO_KILL_HP ? 0 : (HERO_KILL_HP - frac) / HERO_KILL_HP;
    const raw = HERO_HEALTHY + (HERO_KILLABLE - HERO_HEALTHY) * ramp;
    // `heroFocus` scales the part ABOVE a soldier, so 0 means "a hero is a unit" rather than
    // "a hero is worth nothing" — an AI that refuses to hit heroes is as broken as one that
    // hits nothing else.
    return SOLDIER + (raw - SOLDIER) * ctx.heroFocus;
  }
  if (t.isSummon) return SUMMON;
  if (t.isPeon) return ctx.harass ? WORKER_RAID : WORKER;
  return t.maxMana > 0 ? CASTER : SOLDIER;
}

/** …and what it is worth to somebody who is reading hit-point bars and nothing else. */
function naiveValue(t: SimUnit, ctx: AimCtx): number {
  // …and a building is the one thing a novice does NOT read as bulk. A Town Hall is 1500 hit
  // points, three Tauren's worth, and an easy computer that aimed by size alone would walk past
  // an army to punch it — which is the bug this whole rule exists to stop, at every difficulty.
  if (t.building) return isTower(t) ? TOWER : BUILDING;
  const bulk = Math.max(0.25, t.maxHp / NAIVE_BULK);
  // A novice does notice that a hero is a hero. What they cannot do is tell a killable one from
  // a healthy one, so it is a flat premium rather than the curve `bodyValue` applies — and a
  // small one, since a Tauren still out-bulks a level-1 Paladin by half again.
  return t.isHero ? bulk * (1 + ctx.heroFocus) : bulk;
}

/**
 * How much this target is worth to THIS kind of spell.
 *
 * `naive` never gets past the first branch: it aims by bulk, with the one correction any player
 * makes without being told (a heal goes on whoever is hurt). That is the requested behaviour —
 * an easy computer Storm Bolts the Tauren — and it falls out of one rule rather than out of a
 * list of mistakes.
 *
 * DISTANCE is deliberately not in here. A single-target pick breaks ties with it
 * (`PlusCaster.pickTarget`), but an AREA spell's score is the SUM of what its circle catches,
 * and a distance term inside that sum would make a spell prefer a smaller pile of bodies for
 * standing closer — and, since the sum could then go negative, would make `pickSpot`'s zero
 * floor silently reject a legal cast.
 */
export function spellValue(t: SimUnit, role: AimRole, ctx: AimCtx, facts?: SpellFacts): number {
  const frac = t.hp / Math.max(1, t.maxHp);
  if (ctx.skill === "naive") {
    return naiveValue(t, ctx) * (role === "heal" ? (1 + (1 - frac) * 2) * (t.isHero ? HEAL_HERO : 1) : 1);
  }

  let v = bodyValue(t, ctx);
  switch (role) {
    case "heal":
      v *= 1 + (1 - frac) * 2; // the most wounded…
      v *= t.isHero ? HEAL_HERO : 1; // …and the HERO first, which `bodyValue` alone does not say
      break;
    case "nuke":
      // The wounded — but an expert prices "wounded" in hit points remaining rather than in
      // percent, because what a nuke buys is a body REMOVED from the fight.
      v *= ctx.skill === "expert"
        ? 1 + clamp01((KILL_HP - t.hp) / KILL_HP) * 2 + (1 - frac) * 0.5
        : 1 + (1 - frac);
      break;
    case "disable": {
      // The healthiest, because that is the one that will still be swinging in ten seconds…
      v *= 1 + frac;
      // …and, for an expert, the one swinging HARDEST. Normalised against a Footman's own rate
      // (~13 damage on a 1.35 s cooldown) so the multiplier sits either side of 1.
      if (ctx.skill === "expert") v *= 1 + clamp01(threat(t) / 10 - 0.5);
      // A stun on a hero is a THIRD of a stun (see SpellFacts.heroDurationRatio) — the game's
      // own number, and the reason a good player saves the Hex for the Shaman.
      if (t.isHero && facts) v *= Math.max(HERO_DISABLE_FLOOR, facts.heroDurationRatio);
      break;
    }
    default:
      break;
  }
  return v;
}

/**
 * What an enemy unit is worth KILLING — the army's half of the same ladder.
 *
 * Not `spellValue(t, "nuke")`, though it is close: a squad kills by walking over and swinging
 * until the thing falls down, so "nearly dead" is worth much less to it than it is to a nuke
 * (it has to survive the walk) and the difference between a Tauren and a Footman is a matter of
 * how long it takes rather than of whether it works at all.
 */
export function killValue(t: SimUnit, ctx: AimCtx): number {
  const frac = t.hp / Math.max(1, t.maxHp);
  if (ctx.skill === "naive") return naiveValue(t, ctx) * (1 + (1 - frac) * 0.5);
  return bodyValue(t, ctx) * (1 + (1 - frac)); // …and finish what is nearly dead
}

/**
 * …and what a BUILDING is worth knocking down, for the units that are there to knock buildings
 * down (`isSiege`). A separate ladder because it answers a different question: not "what is the
 * dangerous thing here" but "what does razing this base start with".
 *
 * A tower first, because it is the building that is shooting at the army while the army works;
 * then whatever is nearest and most nearly down. `killValue` deliberately cannot be reused —
 * it prices a Farm at a seventh of a soldier, which is right for a Grunt and meaningless for a
 * Demolisher, whose alternative is not a soldier but another building.
 */
export function razeValue(t: SimUnit): number {
  const frac = t.hp / Math.max(1, t.maxHp);
  return (isTower(t) ? TOWER : BUILDING) * (1 + (1 - frac));
}

/** The ability row's own aiming facts, for `spellValue`. `dur1`/`herodur1` are per RANK. */
export function spellFacts(duration: number, heroDuration: number): SpellFacts {
  return { heroDurationRatio: duration > 0 && heroDuration > 0 ? heroDuration / duration : 1 };
}
