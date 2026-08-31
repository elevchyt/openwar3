import { isRepairCode, NO_AOE_CURSOR, type AbilityDef, type AbilityLevel } from "../../data/abilities";
import type { SimUnit } from "../../sim/world";
import { DISPEL_CODES, POLARITY_SPELLS, worthDispelling } from "../../sim/spells";
import { friendlySpell, near, waveDistance, type CasterView } from "../casting";
import { MELEE } from "../../data/gameplayConstants";
import { MELEE_INSANE, MELEE_NEWBIE, WIND_WALK } from "../ids";
import type { PlusProfile } from "./profile";
import { aimCtx, HERO_KILL_HP, killValue, spellFacts, spellValue, type AimCtx } from "./targeting";

// Computer+ — when its units press their buttons (issue #124).
//
// The classic caster (src/ai/casting.ts) is a TRANSCRIPTION: one hiveworkshop thread of
// observations of the real client, one `CAST_RULES` row per ability, quoting the line it came
// from, and a blanket refusal to touch anything the thread does not describe — including,
// explicitly, "transform abilities like Destroyer Form/Bear Form/Crow Form". It reproduces
// Blizzard's AI, warts included, and that is exactly what it is for.
//
// This one has a different job, stated in issue #124: "a separate one that is more
// intelligent, more human like and it must utilize ALL abilities, especially things like Bear
// Form". So it is not a table of abilities at all. It is:
//
//   1. a ROLE for every ability — what the button is FOR (`ROLES` below, with a derivation
//      from the ability's own row for anything unlisted, so a custom map's spells are played
//      rather than ignored);
//   2. a PRIORITY over those roles — a caster presses its most valuable legal button, not the
//      first one on its command card, which is the single biggest difference in how the two
//      read to play against;
//   3. TARGET VALUE — casters over footmen, the wounded for a nuke and the healthy for a
//      disable, workers when raiding, and a hero only when it can actually be finished. The
//      ladder itself lives in plus/targeting.ts, because the ARMY aims by the same one: a
//      Mountain King who stuns the Tauren while every Footman beside him swings at the Shaman
//      is worse than either decision taken alone;
//   4. a REACTION DELAY, because a human does not Storm Bolt on the first frame of a fight —
//      a smaller ROLE VOCABULARY at the lower difficulties, because a novice does not use half
//      these buttons at all, and a WORSE READ of the fight at those difficulties too
//      (`PlusProfile.castTargeting`): an easy computer aims at the biggest body on the screen,
//      which is how its Storm Bolt ends up on your Tauren.
//
// What it keeps from the classic caster, and must: LEGALITY is the sim's. `castUseError` /
// `castError` are the click-time gates — mana, cooldown, the upgrade requirement, Targets
// Allowed, spell polarity, "is there even a corpse" — so this can never be more permissive
// than the button a player presses, and every cast still leaves through `RtsController.execute`.
// Autocast is also still the sim's (`SimWorld.tickAutocast`); the caster only arms it.

/** What a button is FOR. The ladder is the priority order, highest first — see `roleRank`. */
export type Role =
  /** Save yourself, right now: Divine Shield, Avatar, Mana Shield, Wind Walk, Cannibalize. */
  | "panic"
  /** Put hit points back on somebody (or back on their feet). */
  | "heal"
  /** Change shape — the family the classic caster refuses outright. */
  | "morph"
  /** Take an enemy OUT of the fight: stuns, holds, polymorphs, silences. */
  | "disable"
  /** Damage. */
  | "nuke"
  /** Put another body on the field. */
  | "summon"
  /** Make our side better at fighting. */
  | "buff"
  /** Make their side worse at it, without removing them. */
  | "debuff"
  /** Worth pressing in a fight, but nothing above describes it. */
  | "utility";

const LADDER: readonly Role[] = ["panic", "heal", "morph", "disable", "nuke", "summon", "buff", "debuff", "utility"];
const roleRank = (r: Role): number => LADDER.indexOf(r);

/**
 * Every base ability the four melee races own, by role.
 *
 * Grouped by ROLE rather than listed per ability, because the role is the only thing this file
 * needs and a list of ninety single-entry rows would say less. Where an ability could
 * plausibly sit in two groups the choice is written out; everything else is its tooltip.
 */
const ROLES: Partial<Record<Role, readonly string[]>> = {
  panic: [
    "AHds", // Divine Shield
    "AHav", // Avatar
    "ANms", // Mana Shield
    "AOwk", // Wind Walk — but see `windWalkRole`: this is only HALF of that button, the exit,
            // and the row is here so the exit sits at the top of the ladder where an exit
            // belongs. Its other half is an opener and is graded `buff`.
    "Acan", // Cannibalize — a Ghoul eating a body IS its heal
    "AEbl", // Blink — an ESCAPE here and nothing else. The classic caster refuses it because
            // the thread records nothing about when the engine blinks; used only to leave a
            // fight the hero is losing, a wrong guess costs one hero one hop.
  ],
  heal: [
    "AHhb", // Holy Light
    "AUdc", // Death Coil — the same button on the other polarity; POLARITY_SPELLS decides who
            // each may touch, so both are simply "heal" here
    "AOhw", // Healing Wave
    "Arej", // Rejuvenation
    "AEtq", // Tranquility
    "AHre", // Resurrection — a heal that works on the dead
    "AUan", // Animate Dead
    // Healing Ward (Witch Doctor). Named here rather than left to `roleOf`, which would grade
    // it `summon` off its `UnitID1` — and a summon is aimed at the ENEMY, which is where the
    // ward was being planted. What it summons is a HEAL: `[ohwd]` carries `Aoar`, the same
    // regeneration aura the Fountain of Health has. Its polarity cannot be read off its row
    // either (`[Ahwd] targs1` is "_", no allegiance flag at all) — see `friendlyAim`.
    "Ahwd",
  ],
  morph: [
    "Abrf", // Bear Form — issue #124's named example, and the fighting form of the Druid
    "AEme", // Metamorphosis
    "ANcr", // Chemical Rage
    "ANrg", // Robo-Goblin
    "ANef", // Storm, Earth and Fire
    "Abur", // Burrow — a Crypt Fiend hiding to regenerate (see MORPH_WHEN)
  ],
  disable: [
    "AHtb", "ANfb", // Storm Bolt / Fire Bolt
    "AOhx", // Hex
    "AUsl", // Sleep
    "AHbn", // Banish
    "AEer", // Entangling Roots
    "ANdo", // Doom
    "ANsi", // Silence
    "AHtc", "AOws", // Thunder Clap / War Stomp — damage as well, but a stun that lands on the
                    // whole enemy line is worth more than the damage and is what opens a fight
    "AUim", // Impale
    "Asta", // Stasis Trap
    "ANch", // Charm
    "Adev", // Devour
    "Aprg", // Purge — a slow as much as a dispel
  ],
  nuke: [
    "AOcl", "ANfl", // Chain Lightning / Forked Lightning
    "AUfn", // Frost Nova
    "AHbz", "ANrf", // Blizzard / Rain of Fire
    "AHfs", // Flame Strike
    "AUcs", "AOsh", "ANbf", // Carrion Swarm / Shock Wave / Breath of Fire
    "AEsf", // Starfall
    "AEfk", // Fan of Knives
    "AOww", // Bladestorm
    "AUdd", "AOeq", // Death and Decay / Earthquake
    "AUls", // Locust Swarm
    "ANfd", // Finger of Death
    "ANso", // Soul Burn
    "AHdr", // Life Drain
    "AEsh", // Shadow Strike
    "ANab", // Acid Bomb
    "ANtm", // Transmute
  ],
  summon: [
    "AHwe", // Water Elemental
    "AOsf", // Feral Spirit
    "AUcb", // Carrion Beetles
    "AEfn", // Force of Nature
    "AOwd", // Serpent Ward — the row's alias is `AOsw`, its CODE (what this map is keyed on)
            // is `AOwd`. Named as the alias it matched nothing; the derivation caught it anyway
            // because the row summons, so this is the same role by a shorter road.
    "AHpx", // Summon Phoenix
    "AUin", // Inferno
    "AEsv", // Vengeance
    "AOvd", // Big Bad Voodoo
  ],
  buff: [
    "Aroa", // Roar
    "Aspl", // Spirit Link
    "Auhf", // Unholy Frenzy
    "Aams", // Anti-magic Shell
    // Immolation — a toggle, and the only ability with an OFF as well as an on: `buffFree`
    // stops it being doused half a second after it is lit, and `douseImmolation` is what
    // finally puts it out when the fighting stops.
    "AEim",
    "Absk", // Berserk
    "AOmi", // Mirror Image — three more bodies is a buff on the hero carrying it
    "Alsh", // Lightning Shield: aimed at an enemy, but what it does is add damage to a fight
  ],
  debuff: [
    "AEmb", // Mana Burn
    "ANht", // Howl of Terror
    "Acri", // Cripple
    "ANdh", // Drunken Haze
    "Adis", // Dispel Magic
    "AUdr", // Dark Ritual — see DARK_RITUAL_MANA: it is mana economy, gated on being short
  ],
};

/**
 * WHAT A NUKE TAKES OFF ONE BODY the instant it lands, by base ability code.
 *
 * Only the single-target ones are here, because this exists for exactly one question and that
 * question is only ever asked of a unit-target cast (`pickTarget` → `nukeWorthIt`): *may this
 * spell be spent on a WORKER?* A line or area nuke is aimed at a SPOT and priced by the sum of
 * what its circle catches (`pickSpot`), where a peon is one more body in the pile and no waste
 * at all — a Blizzard dropped on six Peasants is the play, not the mistake.
 *
 * The columns are the ones the sim's own handlers read (src/sim/spells.ts), and they have to be:
 * what this asks is "will the blow that is about to land finish it", so the two must agree about
 * the size of that blow or the promise is not the sim's. The defaults beside them are the same
 * defaults, and the per-rank numbers quoted are 1.30.4's `Units\AbilityData.slk`. Two entries that look
 * wrong and are not: Frost Nova's damage to the unit it is AIMED at is `DataB` (`DataA` is what
 * everyone else in the ring takes), and Shadow Strike's `DataE` is the only part that lands at
 * once — `DataA` is a dot spread over fifteen seconds and cannot finish anything now.
 *
 * A unit-target nuke that is NOT here scores 0 and is therefore never spent on a worker, which
 * is the right way round for a rule phrased as "unless it can finish it": Soul Burn, Life Drain
 * and Acid Bomb are all damage over time and none of them removes a body from the fight this
 * second, and an ability a later patch or a custom map adds is not something to guess about.
 */
const NUKE_BURST: Record<string, (lvl: AbilityLevel) => number> = {
  AUdc: (l) => dat(l, 0, 100), // Death Coil — DataA (200/400/600)
  // Frost Nova — DataB, the share the unit the missile HITS takes, and it is 100 at all three
  // ranks (the scaling DataA 50/100/150 is the ring around it). Which is why this spell is the
  // developer's own example: it never grows into finishing a worker, at any rank.
  AUfn: (l) => dat(l, 1, 100),
  AOcl: (l) => dat(l, 0, 85),  // Chain Lightning — DataA, before the per-jump falloff (85/125/180)
  ANfl: (l) => dat(l, 0, 85),  // Forked Lightning — DataA per unit the fan catches (85/160/250)
  ANfd: (l) => dat(l, 2, 500), // Finger of Death — DataC (500, flat across its ranks)
  AEsh: (l) => dat(l, 4, 75),  // Shadow Strike — DataE, the impact (75/150/225)
  // Transmute takes the body outright, whatever is left of it: the handler's only conditions
  // are that the victim is not a hero and not a building, and `castError` has already asked
  // both. So it FINISHES a worker by definition — and turning a Peasant into gold is one of
  // the few things a nuke aimed at a worker is unambiguously worth doing.
  ANtm: () => Infinity,
};

/** One of `AbilityLevel.data`'s nine columns, or the sim's own default for it. The columns are
 *  NaN when the row does not set them, exactly as `emptyAbilityLevel` leaves them. */
function dat(lvl: AbilityLevel, i: number, fallback: number): number {
  const v = lvl.data[i];
  return Number.isFinite(v) ? v : fallback;
}

/** What this nuke takes off the unit it is aimed at, right now. 0 for anything unpriced — see
 *  `NUKE_BURST` for why that is the safe direction. */
export function nukeBurst(code: string, lvl: AbilityLevel): number {
  return NUKE_BURST[code]?.(lvl) ?? 0;
}

/**
 * MAY THIS NUKE BE SPENT ON THIS TARGET? The workers rule, and it is only ever about workers.
 *
 * *"The AI must not use nuke spells like Death Coil and Frost Nova on worker units if it cannot
 * instakill them with that spell"* — the developer's own words, and the arithmetic behind them
 * is the same one a player does without thinking. A worker is the cheapest body on the map
 * (`WORKER` is 0.4 on the shared ladder, plus/targeting.ts) and a nuke is a hero's mana and a
 * cooldown. The game's own numbers say the rest: a Peasant has 220 hit points, an Acolyte 230, a
 * Peon 250, and even a Wisp 120 (`UnitBalance.slk`), while Frost Nova's share to the unit it hits
 * is 100 at EVERY rank and Death Coil's is 200 at rank 1. So both of them buy a hurt worker that
 * walks back to the mine — a cast, a cooldown and a minute of regeneration spent on nothing.
 * Kill it and the trade is the other way round.
 *
 * Everything else is untouched: this says nothing about a soldier, a caster or a hero, and
 * nothing about the area nukes (see `NUKE_BURST`). It is applied at LEGALITY rather than as a
 * penalty on the score so that the misclick (`castMistake`) cannot land there either — a
 * "mistake" that spends the same mana on the same peon is not sloppiness, it is the bug wearing
 * a different hat.
 *
 * The damage is compared against the target's CURRENT hit points and not against a fraction of
 * them: what a nuke buys is a body removed, and armour is not in the sum because untyped spell
 * damage does not pay it (`SimWorld`'s `spellDamage` goes straight to `landDamage`). What it
 * DOES pay is magic reduction, and a magic-immune target takes nothing at all — both are read
 * off the unit here for the same reason, so this cannot promise a kill the sim will not deliver.
 */
export function nukeWorthIt(code: string, lvl: AbilityLevel, t: SimUnit): boolean {
  if (!t.isPeon) return true;
  if (t.magicImmune) return false;
  return nukeBurst(code, lvl) * (1 - t.magicReduction) >= t.hp;
}

/** code → role, flattened once. */
const ROLE_OF = new Map<string, Role>(
  (Object.entries(ROLES) as Array<[Role, readonly string[]]>).flatMap(([role, codes]) => codes.map((c) => [c, role] as const)),
);

/**
 * What the AI still will not press, and why each one is here.
 *
 * MUCH shorter than the classic caster's `NEVER`, which is the point of this file — the whole
 * transform family and every "the thread records nothing" entry have moved into the table
 * above. What is left is the three kinds of button that are not a combat decision at all:
 */
const NEVER = new Set<string>([
  // 1. Jobs that belong to other parts of the AI, not to a caster.
  "Aent", // Entangle Gold Mine — the economy's (AiPlayer.entangleMines)
  "Ambt", // Replenish — the Moon Well pours itself
  "Aeat", // Eat Tree
  "Auns", // Unsummon
  "Ashm", // Shadow Meld — a stance the sim holds
  "Aroo", // Root / Uproot — an Ancient walking, which is a building decision
  "Amel", "Amed", // the Meat Wagon's corpse cargo (armed as autocast instead)
  // 2. Buttons that spend the unit itself. A human uses a Sapper; an AI with no read on
  //    whether the trade is worth it uses them on a Footman. Left out until it can be judged.
  "Asds", // Kaboom!
  "Auco", // Unstable Concoction
  "Adtn", // Detonate — a Wisp is a worker, and the economy has already assigned it
  // 3. Buttons whose value is entirely in information or logistics, which this AI does not
  //    model: it scouts with a worker and it has one army in one place.
  "AOfs", // Far Sight
  "AHmt", // Mass Teleport
  "ANpr", "ANsa", // Staff of Preservation / Sanctuary
  // 4. …and the one form change that makes its owner useless in a fight: a Druid of the Talon
  //    in Raven Form is a flyer that cannot attack. Its use is scouting, and this AI scouts
  //    with a worker (ComputerPlusAi.scoutPass) rather than with a spell.
  "Arav",
  // Ethereal Form, likewise: it trades the Spirit Walker's attack for immunity to physical
  // damage, which is a call about the ENEMY's composition rather than about this fight.
  "Aetf",
]);

// ITEMS — NOT HANDLED HERE, AND DELIBERATELY. See docs/computer-plus.md "Items: not yet".
//
// Nothing in this file can reach an item even by accident: an item's granted abilities are not
// in `SimUnit.abilities` at all (they hang off the inventory slot and dispatch through
// `SimWorld.useItem`, gated by `itemReadyError` / `itemUseError`), so the ability walk in
// `tryCast` never sees a Scroll of Healing. Buying is the other half and is not here either —
// `{ c: "buyitem", shopId, itemId }` belongs in the build ladder beside the rest of the AI's
// gold, not in a caster.
//
// This is a hole waiting on the sim rather than a decision about play: the item side is still
// being filled in, and an AI written against a half-implemented inventory would encode the
// half. When it lands, a Potion of Healing is a `panic`/`heal` row on the ladder above, a Scroll
// of Healing is an area heal `pickSpot` already knows how to aim, and a Scroll of Town Portal
// belongs to the army manager's retreat rather than to this file.

/** Autocasts the AI must not simply switch on — the same two the classic caster holds back,
 *  for the same reasons (Defend costs 30% move speed and has a condition; Replenish is a job). */
const HAND_AUTOCAST = new Set<string>(["Adef", "Ambt"]);

/**
 * A morph's condition. The classic caster refuses this whole family; Computer+ is asked to use
 * it, so each one needs a rule of its own — a shape change is not a spell you spam.
 */
const MORPH_WHEN: Record<string, "engage" | "regen"> = {
  Abrf: "engage", // Bear Form: the Druid's fighting body. Morph when a fight starts and stay.
  AEme: "engage", // Metamorphosis
  ANcr: "engage", // Chemical Rage
  ANrg: "engage", // Robo-Goblin
  ANef: "engage", // Storm, Earth and Fire
  Abur: "regen", // Burrow: a hurt Crypt Fiend digs in to heal, and only with nothing near it
};

/** How hurt something has to be before a heal is spent on it. */
const HURT = 0.75;
/**
 * …and how hurt a friendly UNDEAD unit has to be before Death Coil is spent healing it.
 *
 * The developer's own number, and much later than an ordinary heal for a reason the ability's
 * own row states: `AUdc` is ONE button with two halves (POLARITY_SPELLS — "enemy living units
 * or friendly Undead units"), so every coil poured into a lightly scratched Ghoul is the burst
 * that was going to finish something. At a third of its life a body is about to be lost, which
 * is the point at which a player spends it that way instead.
 *
 * Holy Light keeps the ordinary `HURT` bar: `AHhb` competes with nothing — its other half is
 * only ever aimed at enemy Undead — so there is no reason to hold it.
 */
const COIL_HEAL_HP = 0.3;
/** How much a POLARITY spell's healing half outbids its damaging half. Both halves are scored
 *  by `spellValue`, but on different ladders — "who is worth healing" and "who is worth
 *  hurting" are not the same number — so without a thumb on the scale a Death Knight with a
 *  Ghoul at a fifth of its life still coils whatever is standing in front of it. */
const POLARITY_HEAL_FIRST = 2;

/**
 * OFFENSIVE SPELLS ARE NOT SPENT ON EVERY SCUFFLE — how often one is pressed at all, by what
 * the fight is against.
 *
 * The reported behaviour: *"it feels like the AI is spending too much mana on small creep
 * camps"* — a Death Knight that Coils two Gnolls, a Far Seer whose Chain Lightning goes into a
 * three-body green camp, a Tauren Chieftain that War Stomps a pair of Murlocs. All of it is
 * legal, none of it is wrong on its own, and the sum of it is a hero that arrives at the fight
 * that matters with an empty bar.
 *
 * So the roll is made ONCE PER ENGAGEMENT per unit rather than per pass (`offense`), which is
 * the difference between a chance and a delay: re-rolled twice a second, any chance short of
 * zero fires within a second or two and nothing has been lowered at all.
 *
 * Against a PLAYER the answer is always yes — a spell held back in the fight that decides the
 * game is a spell wasted far more expensively than one thrown at a Gnoll. Against CREEPS it is
 * priced by how big the camp actually is, on the same reading `plus/items.ts` uses for "is this
 * a fight at all": bodies that can fight back. Ours, like every number in Computer+.
 */
const CREEP_SPELL_SMALL = 0.25;
const CREEP_SPELL_BIG = 0.7;
/** How many creep bodies in the fight make it worth the mana at `CREEP_SPELL_BIG` — about the
 *  size of an orange camp, which is the first one the party is not going to walk through. */
const CREEP_SPELL_BODIES = 4;
/** The roles the roll above gates: the offensive half of the ladder. A heal, a panic button, a
 *  morph and a summon are never held back — they are answers to something that has already
 *  happened, and the developer's list is nukes and hard disables ("death coil, frost nova,
 *  impale, carrion swarm, war stomp, shockwave"), which is exactly these two. */
const OFFENSIVE: ReadonlySet<Role> = new Set<Role>(["nuke", "disable"]);
/** …and how hurt the CASTER has to be for a panic button. */
const NEAR_DEATH = 0.5;
/** Dark Ritual is mana economy: it only makes sense when the caster is actually short. */
const DARK_RITUAL_MANA = 0.5;
/** How many bodies an area spell wants under it. The same two the classic caster uses, from
 *  the same observations — an AoE on one target is a wasted cast at any skill level. */
const CLUSTER = 2;
/** How far a caster looks to decide there is a fight around it (the Priest's own `acquire`). */
const MIN_LOOK = 600;
/**
 * How long a Wind Walked hero will hold its blow while it walks at the body it pressed the
 * button for (`backstabPass`).
 *
 * A ceiling and not a wait: the blow goes out on the FIRST pass after the fade has landed, and
 * `[AOwk]` DataA is 0.6 s against a `castPeriod` of 0.35-2 s, so this is only ever reached by a
 * hero that is still walking. Five seconds is what the walk gets before the intent is dropped
 * and the hero is handed back to the army's own orders — well inside the 20 s that is the
 * shortest rank of the invisibility itself, so nothing is held past the ability that bought it.
 * OURS, like every other number in this file that no install file states.
 */
const BACKSTAB_HOLD = 5;
/** …and how far from the caster a fight has to be to count as "around us" for a morph. */
const ENGAGE_LOOK = 900;
/** Immolation (`AEim`), by base code — the one ability this file switches OFF as well as on. */
const IMMOLATION = "AEim";
/** How long nothing may be in reach before Immolation is put out — see `douseImmolation`. */
const IMMOLATION_HOLD = 4;

/**
 * Which roles a difficulty actually uses.
 *
 * This is the caster's half of "meaningful difficulties" (issue #124), and it is deliberately
 * coarse: an easy computer heals, throws its damage spell, summons and morphs — the four
 * things a new player notices they can do — and never disables, buffs, debuffs or presses a
 * panic button. A normal one plays everything except the fiddly enemy-weakening spells. Insane
 * uses the whole card.
 */
function rolesFor(profile: PlusProfile): ReadonlySet<Role> {
  if (profile.difficulty === MELEE_NEWBIE) return new Set<Role>(["heal", "nuke", "summon", "morph"]);
  if (profile.difficulty === MELEE_INSANE) return new Set<Role>(LADDER);
  return new Set<Role>(["panic", "heal", "morph", "disable", "nuke", "summon", "buff"]);
}

/**
 * What the BELT knows and the caster does not.
 *
 * One question today, and it exists because two different buttons answer "the hero is about to
 * die": a Scroll of Town Portal and a Wind Walk. The scroll is the better of the two by every
 * measure (docs/items.md — the press makes the hero invulnerable for the whole channel and ends
 * in the base), so the spell is the exit for a hero that has not got one. An item ability is not
 * in `SimUnit.abilities` at all, so this file cannot see a scroll by itself; plus/items.ts
 * answers it (`PlusItems.holdsEscape`).
 */
export interface CastCtx {
  holdsPortal(u: SimUnit): boolean;
  /** Where a hero that has just Wind Walked out of a fight runs TO — the AI's own main base,
   *  the same point `ComputerPlusAi.escapePass` then holds it at. */
  home: { x: number; y: number };
}

/** One Computer+ player's casters. */
export class PlusCaster {
  private readonly roles: ReadonlySet<Role>;
  /** Each of our units' hit points at the end of the previous pass — the "is it being
   *  attacked" signal, the same one the classic caster reads. */
  private lastHp = new Map<number, number>();
  /** When each of our units first had an enemy in reach of THIS fight. The reaction delay is
   *  measured off it, so a spell lands a beat after the swords meet rather than before. */
  private fightSince = new Map<number, number>();
  /** Seconds since the player was seated — the brain's clock, handed in each pass. */
  private now = 0;
  /** How this player reads a fight (plus/targeting.ts), built once from the profile. */
  private readonly aim0: AimCtx;
  /** What the belt knows — handed in each pass (see `CastCtx`). */
  private ctx: CastCtx = { holdsPortal: () => false, home: { x: 0, y: 0 } };
  /** Heroes that have just Wind Walked OUT of a fight this pass, and are waiting to be walked
   *  home. Drained once by the army manager — see `drainEscapes` and `windWalk`. */
  private escapes: number[] = [];
  /** Heroes that have Wind Walked INTO a fight and are still fading, with the body the blow is
   *  meant for. The attack is held here until the fade lands — see `backstabPass`. */
  private backstabs = new Map<number, { targetId: number; until: number }>();
  /** When each burning unit last had something in reach — the dwell `douseImmolation` measures
   *  its "the fight is over" from. Swept with `fightSince` at the end of every pass. */
  private burningSince = new Map<number, number>();
  /** Whether each unit is spending offensive mana on THIS engagement — rolled once when the
   *  fight starts and kept for as long as it lasts. See `CREEP_SPELL_SMALL` for why it cannot
   *  be a per-pass roll, and `trackFight`, which is what clears it. */
  private offense = new Map<number, boolean>();

  /**
   * `roll` is the AI's OWN random stream (`AiPlayer.randomInt`), not `Math.random` — a
   * misclick has to be deterministic for the same seed like every other AI decision, or two
   * replays of one match diverge.
   */
  constructor(
    private readonly view: CasterView,
    private readonly profile: PlusProfile,
    private readonly roll: () => number,
  ) {
    this.roles = rolesFor(profile);
    this.aim0 = aimCtx(profile);
  }

  pass(now: number, ctx: CastCtx): void {
    this.now = now;
    this.ctx = ctx;
    const own: SimUnit[] = [];
    const foes: SimUnit[] = [];
    // OURS, AND OUR ALLIES'. The two lists are different questions and were one: `own` is who
    // this player gives ORDERS to, and `friends` is who its friendly spells may LAND on. A
    // Paladin may Holy Light his ally's Footman and a Death Knight may Coil his ally's Ghoul —
    // `castError` has always allowed it (the polarity rule asks `hostile`, not `owner`) — so
    // the only thing that stopped it was this pool. See `CasterView.allied`.
    const friends: SimUnit[] = [];
    for (const u of this.view.world.units.values()) {
      if (u.hp <= 0) continue;
      if (u.owner === this.view.player) {
        own.push(u);
        friends.push(u);
      } else if (this.view.hostile(u)) foes.push(u);
      else if (this.view.allied?.(u)) friends.push(u);
    }
    this.backstabPass(own);
    this.townBell(own, foes);
    this.douseImmolation(own, foes);
    for (const u of own) {
      // ARMING is asked of buildings as well, and `canAct` (which refuses one out of hand) is
      // deliberately not consulted for it. The Moon Well is why: Replenish Life and Mana
      // (`Ambt`) is an AUTOCAST on a BUILDING, and with it off a night elf's wells pour into
      // nobody — a whole race's healing, silently absent, because the one walk that could have
      // switched it on skipped every building in the game. The Obsidian Statue is the same row
      // on a unit and was already reached; the well was not.
      if (this.canArm(u)) this.armAutocasts(u);
      if (!this.canAct(u)) continue;
      this.tryCast(u, friends, foes);
    }
    this.lastHp.clear();
    const alive = new Set<number>();
    for (const u of own) {
      this.lastHp.set(u.id, u.hp);
      alive.add(u.id);
    }
    // `fightSince` is the one map that outlives a pass, so it is the one that has to be swept:
    // a unit that died mid-engagement would otherwise sit in it for the rest of the match.
    for (const id of this.fightSince.keys()) if (!alive.has(id)) this.fightSince.delete(id);
    for (const id of this.burningSince.keys()) if (!alive.has(id)) this.burningSince.delete(id);
    for (const id of this.offense.keys()) if (!alive.has(id)) this.offense.delete(id);
  }

  /** May this unit's autocasts be switched on? A much shorter list than `canAct`: arming is a
   *  toggle rather than an action, so a building may do it, and the only things that stop it are
   *  not being there yet and not being able to act at all. */
  private canArm(u: SimUnit): boolean {
    if (u.hp <= 0 || u.paused || u.isIllusion) return false;
    if (u.building && u.building.constructionLeft > 0) return false; // still going up
    return true;
  }

  private canAct(u: SimUnit): boolean {
    if (u.building || u.paused || u.stunned || u.silenced || u.isIllusion || u.morphT > 0) return false;
    // A channel is cancelled by the next order, so a unit already casting is left alone —
    // without this a chooser running twice a second starts Starfall forever and finishes it
    // never (docs/melee-ai.md).
    if (u.order === "cast") return false;
    if (u.isPeon || u.order === "harvest" || u.order === "return" || u.order === "repair") return false;
    if (u.constructing || u.repair) return false;
    return true;
  }

  // ====================================================================================
  //  Autocast — armed, then left to the sim
  // ====================================================================================

  /** Switch on every autocast the unit owns, and let `SimWorld.tickAutocast` run them. That
   *  covers Heal, Inner Fire, Slow, Bloodlust, Curse, Faerie Fire, Frost Armor, Abolish Magic,
   *  Ensnare, Web, Raise Dead, Get Corpse and every arrow orb, with none of it restated here. */
  private armAutocasts(u: SimUnit): void {
    for (const ab of u.abilities) {
      if (ab.level < 1 || ab.autocastOn) continue;
      const def = this.view.def(ab.id);
      if (!def?.autocast) continue;
      if (NEVER.has(def.code) || HAND_AUTOCAST.has(def.code) || isRepairCode(def.code)) continue;
      if (!this.view.world.techMeets(u.owner, ab.id)) continue;
      this.view.order({ c: "autocast", unitId: u.id, code: ab.code });
    }
  }

  /**
   * Call to Arms — the one button on a BUILDING, and a very human one.
   *
   * `Amic` is the Human town bell: every Peasant within 2000 becomes a Militia for 45 seconds.
   * It is the answer to "something is in my base and my army is somewhere else", which is
   * precisely the situation an AI is worst at, and no other race has anything like it. Rung
   * only when the raiders outnumber whatever is home, and only above Easy — a novice does not
   * know the bell exists.
   */
  private townBell(own: SimUnit[], foes: SimUnit[]): void {
    if (this.profile.difficulty === MELEE_NEWBIE) return;
    // The bell is a TOGGLE (`townbellon` / `townbelloff`), so pressing it while the militia are
    // out sends them straight back to work — and this pass runs twice a second. Call to Arms is
    // a TIMED form (`[Amil]` Dur 40 = HeroDur 40), so `altFormLeft` on something that carries
    // the ability is exactly "the militia are already up".
    //
    // …and `militiaCall` is "they are on their way", which has to count for the same thing.
    // The bell calls Peasants TO the hall and arms them at the door (docs: `[Amic]` Ubertip),
    // so for the length of that run nobody is a Militia yet — a pass that only looked at
    // `altFormLeft` rang the bell again twice a second all the way there, and each ring
    // re-issued the walk from wherever they had got to.
    if (own.some((o) => (o.altFormLeft > 0 || o.militiaCall > 0) && o.abilities.some((a) => a.code === "Amil"))) return;
    for (const hall of own) {
      if (!hall.building || hall.hp <= 0) continue;
      const bell = hall.abilities.find((a) => a.code === "Amic" && a.level >= 1);
      if (!bell) continue;
      if (this.view.world.castUseError(hall.id, "Amic") !== null) continue;
      const raiders = foes.filter((f) => !f.building && !f.isPeon && near(hall, f, ENGAGE_LOOK)).length;
      if (raiders < 1) continue;
      const defenders = own.filter((o) => !o.building && !o.isPeon && o.speed > 0 && near(hall, o, ENGAGE_LOOK)).length;
      if (defenders >= raiders) continue;
      this.view.order({ c: "cast", unitId: hall.id, code: "Amic", targetId: 0, x: hall.x, y: hall.y, queued: false });
      return; // one bell is the whole town
    }
  }

  /**
   * PUT IMMOLATION OUT when the fighting stops.
   *
   * Every other button on a hero's card is spent once and then costs nothing. `AEim` is the
   * exception and its own data says so: `Cost1` 25 to light it, then **DataB "Mana Drained per
   * Second" = 7** for as long as it burns, until DataC's 10-mana buffer snuffs it out. So a
   * Demon Hunter who lights it for a creep camp and never presses it again arrives at the next
   * fight with an empty bar — no Mana Burn, no Metamorphosis, and a Fountain of Mana's worth of
   * gold thrown into the grass on the way. The Ubertip is written for exactly this and from
   * both sides: *"Drains mana until deactivated." / "Deactivate Immolation to stop draining
   * mana."* Half of that instruction was implemented.
   *
   * It is a pass of its own rather than a rung on the ladder because `tryCast` only ever
   * answers "what is the best thing to press *at* something", and this is the opposite: there
   * is nothing to aim at, which is precisely the condition. `wants` already refuses to re-light
   * it (a `buff` needs `engaged`, and `buffFree` sees `BEim` while it burns), so the two halves
   * cannot fight: out when the fight ends, on again when the next one starts.
   *
   * `IMMOLATION_HOLD` is the whole of the judgement. Nothing here decides whether the fight is
   * *won*, only whether anything is still within reach — so without a dwell a Demon Hunter
   * chasing the last Ghoul out of a camp douses the moment it steps outside `MIN_LOOK` and
   * pays the 25 again a second later. Ours, like every other number in Computer+.
   */
  private douseImmolation(own: SimUnit[], foes: SimUnit[]): void {
    for (const u of own) {
      if (!u.immolation || !this.canAct(u)) continue;
      if (this.engaged(u, foes)) {
        this.burningSince.set(u.id, this.now);
        continue;
      }
      const quiet = this.burningSince.get(u.id);
      if (quiet !== undefined && this.now - quiet < IMMOLATION_HOLD) continue;
      // The same door a player's click goes through — and it is not a formality here: `Cost1`
      // is charged to LIGHT it, so `castUseError` answers "Nomana" below 25, at which point the
      // sim's own DataC buffer is about to put it out anyway.
      if (this.view.world.castUseError(u.id, IMMOLATION) !== null) continue;
      if (this.view.order({ c: "cast", unitId: u.id, code: IMMOLATION, targetId: 0, x: u.x, y: u.y, queued: false })) {
        this.burningSince.delete(u.id);
      }
    }
  }

  // ====================================================================================
  //  The deliberate cast
  // ====================================================================================

  /**
   * One button per unit per pass — the BEST one it can legally press.
   *
   * The abilities are walked in role-priority order rather than command-card order, which is
   * the whole difference between this and the classic caster: a Paladin with a dying Footman
   * in range heals before he stuns, and a Mountain King with a fight starting stuns before he
   * throws his hammer at whatever is nearest.
   */
  private tryCast(u: SimUnit, friends: SimUnit[], foes: SimUnit[]): boolean {
    const engaged = this.engaged(u, foes);
    this.trackFight(u, engaged, foes);
    const cards: Array<{ role: Role; ab: SimUnit["abilities"][number]; def: AbilityDef; lvl: AbilityLevel }> = [];
    for (const ab of u.abilities) {
      if (ab.level < 1 || ab.cooldownLeft > 0) continue;
      const def = this.view.def(ab.id);
      if (!def || def.target === "passive") continue;
      if (NEVER.has(def.code) || HAND_AUTOCAST.has(def.code) || isRepairCode(def.code)) continue;
      // An autocast is the sim's job (see armAutocasts) — except a morph, which wears the flag
      // on some rows and is emphatically a decision.
      if (def.autocast && !MORPH_WHEN[def.code]) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (!lvl) continue;
      const role = def.code === WIND_WALK ? this.windWalkRole(u) : roleOf(def, lvl);
      if (!role || !this.roles.has(role)) continue;
      cards.push({ role, ab, def, lvl });
    }
    cards.sort((a, b) => roleRank(a.role) - roleRank(b.role));

    for (const card of cards) {
      if (!this.ready(u, card.role, engaged)) continue;
      // Mana, cooldown, the upgrade gate and "is there even a corpse" — asked of the sim, at
      // the same door a player's click asks, so this can never be more permissive.
      if (this.view.world.castUseError(u.id, card.ab.code) !== null) continue;
      if (!this.wants(u, card.def, card.role, foes, engaged)) continue;
      if (this.aim(u, card.ab.code, card.def, card.lvl, card.role, friends, foes)) return true;
    }
    return false;
  }

  /**
   * The REACTION DELAY — how long a fight has to have been going before a spell goes out.
   *
   * A reflex (a panic button, a heal) is immediate at every difficulty: those are the casts a
   * player makes because something just happened to them. Everything else waits
   * `PlusProfile.castDelay`, which is two and a half seconds for an easy computer and nothing
   * at all for an insane one. It is the cheapest possible model of "how fast does this player
   * see the fight", and it is what makes an easy computer's Shock Wave land after you have
   * already walked out of it.
   */
  private ready(u: SimUnit, role: Role, engaged: boolean): boolean {
    if (role === "panic" || role === "heal") return true;
    // …AND WHETHER IT IS SPENDING THE MANA ON THIS FIGHT AT ALL — see `CREEP_SPELL_SMALL`. The
    // decision belongs to the engagement rather than to the pass, so it is asked of a roll made
    // once when the fight started (`trackFight`) and it holds for the whole of it.
    if (OFFENSIVE.has(role) && this.offense.get(u.id) === false) return false;
    if (!engaged) return true; // nothing to be late for
    const since = this.fightSince.get(u.id);
    return since === undefined || this.now - since >= this.profile.castDelay;
  }

  /**
   * IS THIS FIGHT WORTH A SPELL? — rolled once, when the fight starts.
   *
   * A player's own mana discipline in one line: everything goes into the fight against another
   * player, and a small camp on the way to it gets swung at rather than nuked. See
   * `CREEP_SPELL_SMALL` for the numbers and for why this cannot be re-rolled every pass.
   *
   * "Creeps" is asked of the units in front of us rather than of the objective, because that is
   * the thing that is actually true: a camp standing between the army and the enemy base is a
   * creep fight whatever the wave was sent at. One hostile PLAYER body in reach is enough to
   * make it a real fight — a scout's Peasant is not (`isPeon`), and neither is a building.
   */
  private worthTheMana(u: SimUnit, foes: SimUnit[]): boolean {
    const look = Math.max(u.weapon?.acquire ?? 0, MIN_LOOK);
    let bodies = 0;
    for (const f of foes) {
      if (f.building || f.isPeon || !near(u, f, look)) continue;
      if (!f.isCreep && f.owner >= 0 && f.owner < MELEE.MAX_PLAYERS) return true; // a player: always
      bodies++;
    }
    const chance = bodies >= CREEP_SPELL_BODIES ? CREEP_SPELL_BIG : CREEP_SPELL_SMALL;
    return this.roll() < chance;
  }

  /** Does the caster want this ability at all, before anything is aimed? */
  private wants(u: SimUnit, def: AbilityDef, role: Role, foes: SimUnit[], engaged: boolean): boolean {
    switch (role) {
      case "panic":
        // WIND WALK'S EXIT has already asked the two questions that decide it — the hit points
        // and whether there is a scroll to leave with (`windWalkRole`) — so the only thing left
        // is that there is a fight to leave at all. Without that clause a hero at a third life
        // walking home across an empty map spends the cooldown on nothing.
        if (def.code === WIND_WALK) return engaged;
        // "Casts when attacked … the health of the unit isn't a factor" is the real client's
        // Divine Shield; a Wind Walk or a Blink is the opposite, an exit taken when losing.
        // Both are here: hit right now, or hurt badly enough to leave.
        return this.underAttack(u, foes) || u.hp / Math.max(1, u.maxHp) <= NEAR_DEATH;
      case "morph":
        return this.morphWanted(u, def, foes, engaged);
      case "heal":
        // A WARD ALREADY STANDING IS THE HEAL — see `summonStanding`. `[Ahwd] Cool1` is ZERO,
        // so nothing in the data stops a Witch Doctor planting a second 200-mana ward on top
        // of the first one every pass for as long as somebody nearby is hurt.
        return !this.summonStanding(u, def);
      case "nuke":
      case "disable":
        return true; // the target search is the gate — see aim()
      case "debuff":
        if (def.code === "AUdr") return u.maxMana > 0 && u.mana / u.maxMana <= DARK_RITUAL_MANA;
        return engaged;
      case "summon":
      case "buff":
      case "utility":
        return engaged;
    }
  }

  /**
   * A shape change, by its own rule (MORPH_WHEN).
   *
   * `SimUnit.altModel` is the whole state this needs: it is true exactly while the unit is
   * standing in the ability's ALTERNATE form, and pressing the button in that state is the
   * way BACK (see `SimWorld.morphToggle`). So an "engage" morph asks "am I still in my other
   * body, and is there a fight", and Burrow — the one two-way rule — reads it from both ends.
   */
  private morphWanted(u: SimUnit, def: AbilityDef, foes: SimUnit[], engaged: boolean): boolean {
    if (MORPH_WHEN[def.code] === "regen") {
      // A Crypt Fiend digs in to heal — hurt, and with nothing close enough to punish it for
      // being underground — and digs out again the moment either half stops being true.
      const hurt = u.hp / Math.max(1, u.maxHp) <= NEAR_DEATH;
      const quiet = !foes.some((f) => near(u, f, ENGAGE_LOOK));
      return u.altModel ? !quiet || !hurt : hurt && quiet;
    }
    // A fighting form is entered once and kept: it is the body this unit fights in.
    return engaged && !u.altModel;
  }

  /** Point the ability at something and issue it. */
  private aim(
    u: SimUnit,
    code: string,
    def: AbilityDef,
    lvl: AbilityLevel,
    role: Role,
    friends: SimUnit[],
    foes: SimUnit[],
  ): boolean {
    // Wind Walk is neither aimed nor merely pressed: the press is half the button and the ORDER
    // that follows it is the other half. See `windWalk`.
    if (def.code === WIND_WALK) return this.windWalk(u, code, lvl, role, foes);
    // A morph is aimed at nobody: its condition already ran in `morphWanted`, and the cast
    // point is ignored by the handler (`SPELL_HANDLERS`' morph entries take only the caster).
    if (role === "morph") {
      return this.view.order({ c: "cast", unitId: u.id, code, targetId: 0, x: u.x, y: u.y, queued: false });
    }
    if (def.target === "unit") {
      const t = this.pickTarget(u, code, def, lvl, role, friends, foes);
      if (!t) return false;
      return this.view.order({ c: "cast", unitId: u.id, code, targetId: t.id, x: 0, y: 0, queued: false });
    }
    const spot = this.pickSpot(u, code, def, lvl, role, friends, foes);
    if (!spot) return false;
    return this.view.order({ c: "cast", unitId: u.id, code, targetId: 0, x: spot.x, y: spot.y, queued: false });
  }

  // ====================================================================================
  //  Wind Walk — the one button on the card that is two buttons
  // ====================================================================================

  /**
   * WHICH of Wind Walk's two buttons this is, right now.
   *
   * `[AOwk]` is three things at once, and its `Data` columns say so (AbilityMetaData names them
   * Owk1/2/3, and src/sim/spells.ts spends all three):
   *
   *   DataA "Transition Time"             0.6      — the beat before he actually fades
   *   DataB "Movement Speed Increase (%)" 0.1/0.4/0.7
   *   DataC "Backstab Damage"             40/70/100
   *
   * The backstab is not a standing bonus: it rides on the ONE blow that breaks the invisibility
   * (`SimWorld.breakInvisibility`). So the ability is an OPENER as much as it is an escape, and
   * grading it as nothing but a panic button is what produced the reported behaviour — "it seems
   * to like to use it and just stay in the fight invisible", a hero pressing the top of its
   * ladder the moment anything scratched it and getting one 40-damage swing out of a cooldown
   * it should have opened a fight with.
   *
   *  · an EXIT (`panic`, top of the ladder) when the hero is actually leaving: at
   *    `HERO_KILL_HP`, which is the share of its life at which this AI's own targeting starts
   *    treating a hero as a kill (plus/targeting.ts) and therefore the last moment at which
   *    walking away is still cheap — and only with no Scroll of Town Portal to leave with,
   *    which is the better exit by every measure and is the one the belt will press
   *    (plus/items.ts `holdsEscape`, and `ESCAPE_HP` there is the same 0.4 for the same reason).
   *  · an OPENER (`buff`) otherwise. `buff` puts it BELOW the ultimate on the ladder, which is
   *    where it belongs: a Blademaster with Bladestorm off cooldown presses Bladestorm.
   */
  private windWalkRole(u: SimUnit): Role {
    const hurt = u.hp / Math.max(1, u.maxHp) <= HERO_KILL_HP;
    return hurt && !this.ctx.holdsPortal(u) ? "panic" : "buff";
  }

  /**
   * Press it, and then do the thing the press was FOR.
   *
   * Both halves need an order after the cast, and neither one used to get it, because `AOwk` is
   * IMMEDIATE (`SimWorld.castImmediate`): it fires on the spot and *leaves the caster's current
   * order completely alone*. That is exactly right for the real client — the Blademaster fades
   * mid-stride — and it is why a cast on its own changes nothing about what the hero does next.
   * A hero that was swinging keeps swinging, so the invisibility is spent breaking itself on
   * whatever was already in front of it; a hero that was walking keeps walking.
   *
   *  · The EXIT is the walk, and it goes out here rather than on the next army pass: a hero
   *    left swinging reveals itself within a second, which is well inside the one to three
   *    seconds until the army thinks again. `ComputerPlusAi.escapePass` then takes the id off
   *    `drainEscapes` and HOLDS it there through the army's own withdrawal channel, so that
   *    `commit` cannot order it straight back into the fight and the army does not follow its
   *    captain out (see that method).
   *  · The OPENER is the blow, but NOT on the same tick. The hero is aimed at the body worth
   *    the backstab rather than at whatever it happened to be hitting — `killValue` is the
   *    army's own ladder, because this is a swing and not a spell — and it WALKS there while
   *    it fades. The Backstab Damage is bought by full invisibility rather than by the press
   *    (`[AOwk]` DataA "Transition Time" 0.6, and world.ts `breakInvisibility` asks the buff's
   *    own `delay`), so a hero sent in on the tick it pressed swings inside the window, gives
   *    itself away and collects nothing — a whole cooldown spent on an ordinary blow. The walk
   *    is also what takes the hero off the swing it was already making, since `AOwk` leaves the
   *    current order alone. `backstabPass` orders the blow once the fade has landed.
   */
  private windWalk(u: SimUnit, code: string, lvl: AbilityLevel, role: Role, foes: SimUnit[]): boolean {
    // Already walking: the buff is up, and pressing it again would only re-start a cooldown.
    if (u.cloaked || !buffFree(u, lvl)) return false;
    const press = (): boolean =>
      this.view.order({ c: "cast", unitId: u.id, code, targetId: 0, x: u.x, y: u.y, queued: false });
    if (role === "panic") {
      if (!press()) return false;
      // THE WALK IS ISSUED HERE, not on the next army pass. `AOwk` leaves the hero's current
      // order alone, so a hero still swinging breaks its own invisibility within a second —
      // long before an army pass one to three seconds away could have moved it. `escapePass`
      // is what KEEPS it walking (and keeps `commit` off it); this is what starts it.
      this.view.order({ c: "order", unitId: u.id, order: { kind: "move", x: this.ctx.home.x, y: this.ctx.home.y }, queued: false });
      this.escapes.push(u.id);
      return true;
    }
    // Nothing worth a backstab is nothing worth a Wind Walk: the opener is not pressed into an
    // empty field, and returning false here leaves the rest of the card to be tried.
    const t = this.backstab(u, foes);
    if (!t) return false;
    if (!press()) return false;
    this.view.order({ c: "order", unitId: u.id, order: { kind: "move", x: t.x, y: t.y }, queued: false });
    this.backstabs.set(u.id, { targetId: t.id, until: this.now + BACKSTAB_HOLD });
    return true;
  }

  /**
   * The held blow: order it the moment the fade has actually landed.
   *
   * A move rather than an attack goes out at the press (see `windWalk`), so this is the other
   * half of that decision and without it the opener never strikes at all — a Wind Walked hero
   * auto-acquires nothing (`SimWorld.acquireRange` answers 0 for anything cloaked, which is
   * what stops an invisibility walking out of itself), so the blow has to be ordered.
   *
   * `invisible` is the gate and `cloaked` is the abort: the first is the fade in force, the
   * second is the effect being there at all, so a walk that has been dispelled — or broken by
   * something else the hero did in the meantime — drops the intent instead of firing a stale
   * attack order into it. The deadline is the third way out, for a target that has been walked
   * to and never reached.
   */
  private backstabPass(own: SimUnit[]): void {
    if (!this.backstabs.size) return;
    const mine = new Map(own.map((u) => [u.id, u]));
    for (const [id, held] of this.backstabs) {
      const u = mine.get(id);
      if (!u || !u.cloaked || this.now > held.until) {
        this.backstabs.delete(id);
        continue;
      }
      if (!u.invisible) continue; // still fading — waiting it out is the whole point
      this.backstabs.delete(id);
      const t = this.view.world.units.get(held.targetId);
      if (!t || t.hp <= 0 || t.invulnerable) continue; // it died while the hero walked
      this.view.order({ c: "order", unitId: u.id, order: { kind: "attack", targetId: t.id }, queued: false });
    }
  }

  /**
   * What the backstab goes on: the most valuable body in this fight, by the ARMY's ladder
   * (`killValue`) rather than by a spell's — this is one blow, and what it buys is a body closer
   * to dead. Distance breaks ties, since the hero has to walk there before the fade runs out.
   * Buildings are not backstabbed.
   *
   * And nor is a HEALTHY enemy hero, which is the same anti-chase rule the army follows
   * (`ComputerPlusAi.focusTarget`, docs/computer-plus.md § it does not chase heroes): above
   * `HERO_KILL_HP` a hero is a strong soldier with an escape and a healer, and a Wind Walk spent
   * walking after one is the cooldown thrown away. Below it, it is the best thing on the field
   * and `killValue` already says so.
   */
  private backstab(u: SimUnit, foes: SimUnit[]): SimUnit | null {
    const look = Math.max(u.weapon?.acquire ?? 0, MIN_LOOK);
    let best: SimUnit | null = null;
    let bestScore = -Infinity;
    for (const t of foes) {
      if (t.building || t.invulnerable || t.hp <= 0) continue;
      if (t.isHero && t.hp / Math.max(1, t.maxHp) > HERO_KILL_HP) continue;
      if (!near(u, t, look)) continue;
      const s = killValue(t, this.aim0) * 1000 - Math.hypot(t.x - u.x, t.y - u.y);
      if (s > bestScore) { bestScore = s; best = t; }
    }
    return best;
  }

  /** The heroes that Wind Walked out of a fight since this was last asked — see `windWalk`.
   *  Drained rather than read, so one escape produces exactly one walk home. */
  drainEscapes(): number[] {
    const out = this.escapes;
    this.escapes = [];
    return out;
  }

  /** The most VALUABLE legal target — see `value`. Legality is `castError`, the click's own. */
  private pickTarget(
    u: SimUnit,
    code: string,
    def: AbilityDef,
    lvl: AbilityLevel,
    role: Role,
    friends: SimUnit[],
    foes: SimUnit[],
  ): SimUnit | null {
    const friendly = friendlyAim(code, def, role);
    // A POLARITY SPELL IS TWO SPELLS ON ONE BUTTON, and the pool has to say so.
    //
    // Holy Light and Death Coil are mirror images — "friendly living units or enemy Undead" and
    // "enemy living units or friendly Undead" (POLARITY_SPELLS, sim/spells.ts) — and neither
    // row carries an allegiance FLAG, which is why the engine hardcodes the rule and gives each
    // its own error string. `friendlySpell` reads those flags, so it answers FALSE for both,
    // and the pool was therefore the enemy list alone: a Paladin could only ever smite enemy
    // Undead and a Death Knight could only ever burn enemy living. Neither ability had a
    // healing half at all, which is most of a Paladin and the whole of the undead's own heal.
    const polarity = POLARITY_SPELLS[code] !== undefined;
    // …and WHICH polarity spell, because only one of the two holds its heal back. The row itself
    // says so: `healsUndead` is what makes this the Death Coil side of the mirror, whose other
    // half is the undead's opening nuke (see `COIL_HEAL_HP`). Holy Light's other half only ever
    // reaches enemy Undead, so it competes with nothing and keeps the ordinary `HURT` bar.
    const healBar = POLARITY_SPELLS[code]?.healsUndead ? COIL_HEAL_HP : HURT;
    const pool: SimUnit[] = friendly ? friends : polarity ? [...friends, ...foes] : foes;
    // WAS THE POLARITY INFERRED? — true when the row named no side and its ROLE settled it
    // (`friendlyAim`). It matters for one thing only: whether the CASTER is a candidate. Every
    // row that is meant for the presser says `self` in its flags (Divine Shield, Berserk, Mana
    // Shield), and `friendlySpell` is true the moment it does — so a row that says neither
    // `friend` nor `self` has not said it is for the caster, and inferring that as well would
    // have a Necromancer put Unholy Frenzy's 3-hit-points-a-second on its own 220-hp body.
    const inferred = friendly && !friendlySpell(def);
    // Every LEGAL target is collected rather than only the best one, because the misclick
    // below has to draw from the same set: a "mistake" that could land on something the click
    // itself would refuse is not a mistake, it is a dropped cast.
    const legal: SimUnit[] = [];
    let best: SimUnit | null = null;
    let bestScore = -Infinity;
    for (const t of pool) {
      // WHICH HALF of the button this target is. `hostile` is the same question the sim's own
      // `wouldHeal` asks (allegiance, once `polarityOk` has vouched for the race), so the two
      // cannot disagree about whether this cast is a heal or a nuke.
      const heals = friendly || (polarity && !this.view.hostile(t));
      const half: Role = polarity ? (heals ? "heal" : "nuke") : role;
      if (t.building && !heals) continue;
      // A COPY IS NOT SOMEBODY TO HEAL. An illusion deals no damage, arrives at full health and
      // is meant to die (docs/illusions.md), so mana spent putting hit points back into one is
      // mana spent on a picture. Only the friendly half needs saying: hitting a copy is fine,
      // and is often the whole point of the enemy having made it.
      if (heals && t.isIllusion) continue;
      if (inferred && t === u) continue; // see `inferred`

      if (!near(u, t, lvl.castRange)) continue;
      // …and the healing half of a POLARITY spell is held later than an ordinary heal — see
      // `COIL_HEAL_HP`. Death Coil's other half is the undead's opening nuke, so a coil spent
      // on a scratch is a burst that was going to finish something.
      if (half === "heal" && t.hp / Math.max(1, t.maxHp) > healBar) continue;
      // A NUKE IS NOT SPENT ON A WORKER IT CANNOT FINISH — see `nukeWorthIt`. Here rather than
      // in the score so the misclick below cannot land on one either.
      if (half === "nuke" && !nukeWorthIt(code, lvl, t)) continue;
      // …AND A DISPEL IS SPENT ON WHAT A DISPEL DOES — `worthDispelling` (sim/spells.ts), asked
      // of the side this body is on, and here rather than in the score for the same reason the
      // clause above is: a "mistake" that lands on a unit with nothing to strip is not a
      // mistake, it is a wasted cast. Purge is the single-target one that reaches this line.
      if (DISPEL_CODES.has(code) && !worthDispelling(t, this.view.world.units, !this.view.hostile(t))) continue;
      // …and the mana gate the ladder applies to every other nuke (`ready`) has to be applied
      // HERE for a polarity spell, because the card as a whole is graded `heal` and a heal is
      // never held back. Death Coil is the developer's own first example of a nuke thrown at a
      // small camp, and without this clause it is the one nuke in the game the rule missed.
      if (polarity && half === "nuke" && this.offense.get(u.id) === false) continue;
      if (!buffFree(t, lvl)) continue;
      if (this.view.world.castError(u.id, code, t.id) !== null) continue;
      legal.push(t);
      // Worth first, distance only as the tie-break — and `bestScore` starts below every
      // possible score, because a cheap target at the edge of a long cast range scores
      // negative and would otherwise never be picked at all.
      // A HEAL OUTBIDS THE NUKE on a polarity button: the two halves are scored on different
      // ladders and would otherwise be compared as if they were the same number, so a Death
      // Knight with a Ghoul at a fifth of its life would still coil whatever was in front of
      // it. Putting a body back on its feet is worth more than hurting one.
      const s = this.value(t, half, lvl) * (half === "heal" && polarity ? POLARITY_HEAL_FIRST : 1) * 1000
        - Math.hypot(t.x - u.x, t.y - u.y);
      if (s > bestScore) { bestScore = s; best = t; }
    }
    // …and then, sometimes, the wrong one. `castMistake` is ordinary sloppiness on top of a
    // difficulty's READ of the fight (`castTargeting`), and the two compose: an easy computer
    // aims at the biggest body most of the time and at whatever it happened to click on the
    // rest of it. A heal is exempt — a player who means to heal somebody heals somebody, and
    // the pool is already only the wounded.
    const bestHeals = !!best && (friendly || (polarity && !this.view.hostile(best)));
    if (best && role !== "heal" && !bestHeals && legal.length > 1 && this.mistake()) {
      return legal[Math.min(legal.length - 1, Math.floor(this.roll() * legal.length))] ?? best;
    }
    return best;
  }

  /** Did this click go astray? Drawn off the AI's own stream, so a match replays identically. */
  private mistake(): boolean {
    return this.profile.castMistake > 0 && this.roll() < this.profile.castMistake;
  }

  /**
   * How much this target is worth to this kind of spell — the shared ladder, plus this
   * ability's own row.
   *
   * The ladder is `plus/targeting.ts` (read its header for what a difficulty changes about it);
   * all this adds is `spellFacts`, the two columns of the ABILITY that change the aim. Today
   * that is `dur1`/`herodur1`: every hard disable in the game has a shorter hero duration, so
   * an expert prices a stun spent on a hero at what it actually buys.
   */
  private value(t: SimUnit, role: Role, lvl?: AbilityLevel): number {
    return spellValue(t, role, this.aim0, lvl ? spellFacts(lvl.duration, lvl.heroDuration) : undefined);
  }

  /**
   * Where a point / no-target ability goes: the spot that catches the most VALUE, not the most
   * bodies.
   *
   * The classic caster counts heads and takes the biggest pile, which is the observed
   * behaviour of the real engine. Weighing each body by what it is worth is the human version
   * of the same decision — a Blizzard on two Sorceresses is better than one on three Footmen —
   * and it costs the same search.
   */
  private pickSpot(
    u: SimUnit,
    code: string,
    def: AbilityDef,
    lvl: AbilityLevel,
    role: Role,
    friends: SimUnit[],
    foes: SimUnit[],
  ): { x: number; y: number } | null {
    const friendly = friendlyAim(code, def, role);
    // A DISPEL IS AIMED AT BOTH SIDES, because its handler is: `Adis` clears every unit inside
    // its circle without asking allegiance (sim/spells.ts), so the circle is worth drawing over
    // an enemy's Bloodlusted pack AND over our own Huntress standing in Entangling Roots.
    // `counts` asks `worthDispelling` of each body from the side it is on.
    const dispel = DISPEL_CODES.has(def.code);
    const pool = dispel ? [...friends, ...foes] : friendly ? friends : foes;
    const area = lvl.area > 0;
    // A novice does not hold an area spell for a clump — they press it on whoever they are
    // looking at. So the quorum is the difficulty's too, and an easy computer's Blizzard lands
    // on one Footman.
    const quorum = this.profile.castTargeting === "naive" ? 1 : CLUSTER;
    // …and ONE body is enough for a dispel, which is the classic caster's own argument for its
    // `count: 1` (src/ai/casting.ts): a single summoned unit is already worth a Dispel, because
    // damaging it is what the ability is FOR. The quorum was standing in for "is anything here
    // worth it"; `worthDispelling` answers that directly and much better.
    const need = dispel ? 1 : area && !friendly ? quorum : 1;

    if (def.target === "none") {
      if (!buffFree(u, lvl)) return null; // a self-buff already up is not re-pressed
      if (!area) return { x: u.x, y: u.y }; // a bare self-cast — nothing to aim
      const hits = this.catchment(u, u.x, u.y, def, lvl, role, pool, friendly);
      return hits.count >= need ? { x: u.x, y: u.y } : null;
    }

    const wave = NO_AOE_CURSOR.has(def.code);
    const reach = wave ? waveDistance(lvl) : lvl.castRange;
    const legal: Array<{ x: number; y: number }> = [];
    let best: { x: number; y: number } | null = null;
    let bestValue = 0;
    for (const t of pool) {
      if (!near(u, t, reach)) continue;
      const hits = wave ? this.corridor(u, t, def, lvl, role, pool, friendly) : this.catchment(u, t.x, t.y, def, lvl, role, pool, friendly);
      if (hits.count < need) continue;
      if (this.view.world.castError(u.id, code, 0, t.x, t.y) !== null) continue;
      legal.push({ x: t.x, y: t.y });
      if (hits.value <= bestValue) continue;
      bestValue = hits.value;
      best = { x: t.x, y: t.y };
    }
    // The same misclick a single-target cast can make (`pickTarget`), on the same stream: the
    // Blizzard that went down on the edge of the fight rather than on the middle of it.
    if (best && legal.length > 1 && this.mistake()) {
      return legal[Math.min(legal.length - 1, Math.floor(this.roll() * legal.length))] ?? best;
    }
    return best;
  }

  /** Who a circle centred on (x, y) would catch, and what they are worth. */
  private catchment(
    u: SimUnit, x: number, y: number, def: AbilityDef, lvl: AbilityLevel, role: Role,
    pool: SimUnit[], friendly: boolean,
  ): { count: number; value: number } {
    const area = lvl.area || MIN_LOOK;
    const dispel = DISPEL_CODES.has(def.code);
    let count = 0;
    let value = 0;
    for (const t of pool) {
      if (Math.hypot(t.x - x, t.y - y) > area) continue;
      // A DISPEL IS BLIND — `Adis` clears (and DAMAGES the summons of) every unit in its circle,
      // ours included. So a spot that would take out one of our own summons is not a spot: the
      // Water Elemental we paid for is worth more than a buff taken off a Grunt. Vetoed here
      // rather than in `counts`, which can only leave a body out of the tally.
      if (dispel && t.summonLeft > 0 && !this.view.hostile(t)) return { count: 0, value: 0 };
      if (!this.counts(u, t, def, role, friendly)) continue;
      count++;
      value += this.value(t, role, lvl);
    }
    return { count, value };
  }

  /** …and who a wave aimed through `at` would sweep (mirrors `lineTargets` in sim/spells.ts). */
  private corridor(
    u: SimUnit, at: SimUnit, def: AbilityDef, lvl: AbilityLevel, role: Role,
    pool: SimUnit[], friendly: boolean,
  ): { count: number; value: number } {
    const dist = waveDistance(lvl);
    const half = lvl.area || 125;
    const len = Math.hypot(at.x - u.x, at.y - u.y) || 1;
    const ux = (at.x - u.x) / len;
    const uy = (at.y - u.y) / len;
    let count = 0;
    let value = 0;
    for (const t of pool) {
      const px = t.x - u.x;
      const py = t.y - u.y;
      const along = px * ux + py * uy;
      if (along < 0 || along > dist) continue;
      if (Math.abs(px * -uy + py * ux) > half + t.radius) continue;
      if (!this.counts(u, t, def, role, friendly)) continue;
      count++;
      value += this.value(t, role, lvl);
    }
    return { count, value };
  }

  /** Does this unit count toward an area spell's quorum? */
  private counts(u: SimUnit, t: SimUnit, def: AbilityDef, role: Role, friendly: boolean): boolean {
    if (t.invulnerable) return false;
    if (!this.view.world.targsAdmit(t, def.targetFlags)) return false;
    // A DISPEL asks its own question of every body in the circle — see `worthDispelling`, and
    // `pickSpot` for why the pool is both sides. Before the `t === u` line deliberately: a
    // Dryad rooted by an enemy Keeper freeing HERSELF is the cast working exactly as intended.
    if (DISPEL_CODES.has(def.code)) return worthDispelling(t, this.view.world.units, !this.view.hostile(t));
    if (t === u && !friendly) return false;
    if (friendly) return role !== "heal" || t.hp / Math.max(1, t.maxHp) <= HURT;
    return !t.building;
  }

  /**
   * Is one of OUR summons from this very ability already standing here?
   *
   * Asked of a `heal` that summons, which today is the Healing Ward alone: the heal is not the
   * cast, it is the thing the cast leaves on the ground, so a second one inside the first one's
   * reach heals nobody who is not already being healed. The type is the row's own `UnitID1`
   * (`[Ahwd]` → `ohwd`) and the reach its own `Rng1`, so nothing here is a constant of ours.
   *
   * `levelData[0]` rather than the learned rank because what a row summons does not change with
   * rank — only how long it lives does.
   */
  private summonStanding(u: SimUnit, def: AbilityDef): boolean {
    const lvl = def.levelData[0];
    const type = lvl?.summon;
    if (!type) return false;
    const reach = lvl.castRange || MIN_LOOK;
    for (const o of this.view.world.units.values()) {
      if (o.hp <= 0 || o.owner !== this.view.player || o.typeId !== type) continue;
      if (near(u, o, reach)) return true;
    }
    return false;
  }

  // --- the fight, as the AI reads it --------------------------------------------------

  /** Is there a fight around this unit at all? */
  private engaged(u: SimUnit, foes: SimUnit[]): boolean {
    const look = Math.max(u.weapon?.acquire ?? 0, MIN_LOOK);
    return foes.some((f) => !f.building && near(u, f, look));
  }

  /** Remember when THIS fight started, and forget it when the fight ends — the delay is per
   *  engagement, not a cooldown, so a unit that has been fighting for a minute is not slow to
   *  react to the next spell it wants. */
  private trackFight(u: SimUnit, engaged: boolean, foes: SimUnit[]): void {
    if (!engaged) {
      this.fightSince.delete(u.id);
      this.offense.delete(u.id); // …and so does the decision about spending mana on it
      return;
    }
    if (this.fightSince.has(u.id)) return;
    this.fightSince.set(u.id, this.now);
    this.offense.set(u.id, this.worthTheMana(u, foes));
  }

  /** Has it lost hit points since the previous pass, or is something visibly swinging at it? */
  private underAttack(u: SimUnit, foes: SimUnit[]): boolean {
    const was = this.lastHp.get(u.id);
    if (was !== undefined && u.hp < was) return true;
    return foes.some((f) => f.targetId === u.id && near(f, u, (f.weapon?.range ?? 0) + 100));
  }
}

/**
 * IS THIS BUTTON AIMED AT OUR OWN SIDE? — and the target flags alone cannot answer it.
 *
 * `friendlySpell` reads `targs1`'s ALLEGIANCE flags, which is the right reading and the same
 * one `SimWorld.tickAutocast` makes. The trouble is that a beneficial row is not obliged to
 * carry one. Three of them in the melee game carry none at all:
 *
 *     Auhf  Unholy Frenzy   targs1 "air,ground,organic"      → no allegiance flag
 *     Aams  Anti-magic Shell targs1 "air,ground,vuln,invu"   → no allegiance flag
 *     Ahwd  Healing Ward    targs1 "_"                       → no flags whatsoever
 *
 * and the sim reads them exactly as the engine does: `targetAllowed` allows ANY allegiance for a
 * row that names none, so the click is legal on either side. With the flags silent, `pickTarget`
 * fell through to the enemy pool and a Necromancer spent its mana giving the other player's
 * Grunts a 75 % attack-speed buff. (Reported: *"the Computer+ AI seems to like to cast Unholy
 * Frenzy on enemy units"*.)
 *
 * What settles it when the data does not is what the button is FOR — its `Role`. A heal or a
 * buff goes on our own side; a nuke, a disable or a debuff goes on theirs. The fallback is
 * deliberately narrow, because a wrong answer here aims a spell at the wrong army:
 *
 *  · a POLARITY spell (Holy Light / Death Coil) is two spells on one button and has its own
 *    branch in `pickTarget` — this must not collapse it to one half;
 *  · an `enemy` flag is the last word: Lightning Shield says "friend,enemy" and is played at
 *    the enemy, Immolation says "enemy" and burns them;
 *  · a `dead` row (Animate Dead) is aimed at CORPSES, which neither pool describes;
 *  · and only a `unit` or `point` cast is aimed at anybody at all. A bare self-cast (Berserk,
 *    Mirror Image) lands on the caster whatever is standing around, and for those the pool is
 *    a reading of the FIGHT — flipping it would fire Mirror Image at the first ally in sight.
 *
 * Everything else keeps the flags' own answer, so a custom map's flagless spell is still
 * derived (`roleOf` reaches "nuke"/"disable" for one, never "heal"/"buff") and still aimed at
 * the enemy exactly as before.
 */
function friendlyAim(code: string, def: AbilityDef, role: Role): boolean {
  if (POLARITY_SPELLS[code] !== undefined) return false; // two spells on one button
  if (friendlySpell(def)) return true;
  const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
  if (F.has("enemy") || F.has("dead")) return false;
  if (def.target !== "unit" && def.target !== "point") return false;
  return role === "heal" || role === "buff";
}

/** Already carrying a buff this rank applies — the sim's own no-restack doctrine, narrowed to
 *  THIS ability's buff ids so two spells never block each other. */
function buffFree(t: SimUnit, lvl: AbilityLevel): boolean {
  if (!lvl.buffs.length) return true;
  const want = lvl.buffs.map((b) => b.toLowerCase());
  return !t.buffs.some((b) => b.buffId && want.includes(b.buffId.toLowerCase()));
}

/**
 * The role of an ability the table above does not name.
 *
 * Every ability gets one — that is the difference from the classic caster, which leaves
 * anything it has no rule for alone. A custom map's spells, a creep's, a neutral hero's and
 * anything a later patch adds are all played, at the role their own row implies:
 *
 *   summons a unit                 → summon
 *   wants a corpse (`dead`)        → heal (Resurrection's shape: it puts bodies back)
 *   aimed at a friend, restores    → heal … or buff, if it has no duration to run out
 *   aimed at an enemy, has an area → nuke
 *   aimed at an enemy, single      → nuke if it does damage, else disable
 *   a bare self-cast               → buff
 */
function roleOf(def: AbilityDef, lvl: AbilityLevel): Role | null {
  const named = ROLE_OF.get(def.code);
  if (named) return named;
  const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
  if (lvl.summon || def.levelData.some((l) => !!l.summon)) return "summon";
  if (F.has("dead")) return "heal";
  const friendly = friendlySpell(def);
  if (friendly) return lvl.duration > 0 ? "buff" : "heal";
  if (def.target === "unit") return lvl.duration > 0 ? "disable" : "nuke";
  if (def.target === "point") return lvl.area > 0 ? "nuke" : null;
  return lvl.area > 0 ? "nuke" : "buff"; // no target at all
}
