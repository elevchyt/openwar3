import { isRepairCode, NO_AOE_CURSOR, targetFlagSet, type AbilityDef, type AbilityLevel } from "../../data/abilities";
import type { SimUnit } from "../../sim/world";
import { DISPEL_CODES, POLARITY_SPELLS, worthDispelling } from "../../sim/spells";
import { friendlySpell, near, stripsOwnShield, treeAim, treeSpots, waveDistance, waveHalfWidth, type CasterView } from "../casting";
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
    "Acan", // Cannibalize — a Ghoul eating a body IS its heal, but NOT in a fight: see
            // `CANNIBALIZE_HP`
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
    // Destroyer Form. Named, because the derivation would grade it `summon` off its `UnitID1`
    // (`ubsp`) — and a "summon" is pressed in every fight, which spends the race's only healer
    // and 100/50/2 on the first scuffle it walks into. See `destroyerWanted`.
    "Aave",
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
    // IMPALE, with its cousins rather than with the stuns, and it belongs here for the same
    // reason they do: it is the Crypt Lord's LINE NUKE. `Uim1..4` is a wave group in
    // AbilityMetaData exactly as `Osh1..4` and `Ucs1..4` are (data/abilities.ts
    // `NO_AOE_CURSOR`), it is aimed the same way — a direction, scored by what the corridor
    // catches — and `UndeadAbilityStrings [AUim]` leads with the damage: "shooting spiked
    // tendrils out in a straight line, dealing <AUim,DataC1> damage and hurling enemy ground
    // units into the air in their wake". The air time is one second (`Uim4`) and rides the
    // damage; it is not what the button is spent for, the way a Storm Bolt's five seconds are.
    //
    // Graded `disable` it also fell out of the novice vocabulary entirely (`rolesFor`), so an
    // easy computer's Crypt Lord had no offensive button at all while an easy Tauren Chieftain
    // Shock Waved — which is the reported behaviour, and the developer's own reading of it:
    // treat Impale as Shock Wave.
    "AUim",
    // MANA BURN, and it is here for the same two reasons Impale is: the damage is what the
    // ability DOES, and `debuff` is a vocabulary almost nobody has.
    //
    // Reported: *"the Computer+ AI is not utilizing the Demon Hunter's Mana Burn at all"* —
    // and it could not, at two of the three difficulties, because `rolesFor` gives `debuff`
    // to Insane alone. Every Demon Hunter this AI fields learns `AEmb` at hero level 1 and
    // takes rank 3 by level 5 (plus/races.ts: it is the fixed half of both night elf skill
    // builds), so the one button the hero is guaranteed to own was the one button an easy or
    // normal computer could never press.
    //
    // It belongs with the nukes rather than beside Cripple in any case. The handler is a nuke
    // (sim/spells.ts `AEmb`: `burnMana` up to `DataA`, then `spellDamage` for exactly what it
    // took), and `NightElfAbilityStrings [AEmb]` leads with both halves — "Burns mana … Deals
    // damage equal to the amount of mana burned". 50/100/150 at 60 mana and a 7/6/5 s
    // cooldown (`Units\AbilityData.slk`), which is a Demon Hunter's whole opening.
    //
    // What it does NOT get from this row is its aim: a nuke goes on the wounded, and Mana Burn
    // goes on the full pool that is about to be spent on us. See `manaBurnValue`.
    "AEmb",
    "AEsf", // Starfall
    "AEfk", // Fan of Knives
    "AOww", // Bladestorm
    "AUdd", "AOeq", // Death and Decay / Earthquake
    "AUls", // Locust Swarm
    "ANfd", // Finger of Death
    "ANso", // Soul Burn
    "AHdr", // Life Drain
    "AEsh", // Shadow Strike
    // DEVOUR MAGIC — with the nukes for the reason Mana Burn and Impale are here: it is the
    // button the unit exists to press, and a rung only Insane speaks (`debuff`, where Dispel
    // Magic sits) would leave every other Destroyer standing with it. It is the Destroyer's ONLY
    // mana — its regeneration is −3 a second (UnitBalance `ubsp`) and Orb of Annihilation costs
    // 25 a shot — and 160 to every summon in the circle. It is aimed as a DISPEL, not as a nuke:
    // `DISPEL_CODES` has it, so `pickSpot` draws the circle over both sides and counts only the
    // bodies `worthDispelling` answers for, which are exactly the ones that pay (sim `Advm`).
    "Advm",
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

// ==========================================================================================
//  MANA BURN — the one nuke that is aimed at a bar rather than at a body
// ==========================================================================================

/** Mana Burn (Demon Hunter), by base code. `Rng1` 300, `Cost1` 60, `Cool1` 7/6/5, `DataA1`
 *  50/100/150 (`Units\AbilityData.slk`). */
const MANA_BURN = "AEmb";

/**
 * HOW MUCH MORE A HERO'S POOL IS WORTH THAN ANYBODY ELSE'S.
 *
 * The developer's own instruction — *"it must primarily target enemy heroes when possible and
 * enemy casters if there are no heroes"* — and it is what the button is for. A Sorceress spends
 * her bar on one Slow at a time; a hero's bar is the Storm Bolt, the Frost Nova and the ultimate
 * the whole fight turns on, and it is the only bar on the field that does not walk away and come
 * back full a minute later, because a hero keeps what it is left with.
 *
 * NOT scaled by `heroFocus`, which every other hero preference in this AI is (plus/targeting.ts
 * `bodyValue`). That dial is the ANTI-CHASE rule — how far the army is allowed to be pulled onto
 * a hero it cannot finish — and this is not a chase: Mana Burn is a 300-range press at whoever
 * is already standing in front of the Demon Hunter, and stripping a hero's mana is the right
 * click at every skill level. What a difficulty still changes here is how LATE the press comes
 * (`castDelay`) and how often it goes on the wrong body (`castMistake`).
 *
 * Four rather than a rule, so a hero already burned dry stops outbidding a Sorceress with a full
 * bar (below a quarter of what the rank can take) — which is the button working, not an
 * exception to it: there is nothing left on that hero to burn.
 */
const MANA_BURN_HERO = 4;
/** …and a summon's pool, which is leaving on its own clock — the same reading `SUMMON` gets on
 *  the shared ladder, for the same reason. */
const MANA_BURN_SUMMON = 0.5;
/**
 * The floor when the target owns no button with a price on it — a creep with a bar and nothing
 * to spend it on, or a hero whose one learned skill is a passive. Half of what this rank can
 * take: a press that cannot fill half its own burn is not what 60 mana is for. Ours, like every
 * number in Computer+ that no install file states.
 */
const MANA_BURN_SLIVER = 0.5;

/**
 * WHAT THIS TARGET IS WORTH BURNING.
 *
 * Deliberately NOT `spellValue(t, "nuke")`, though the role is `nuke` and the damage is real. A
 * nuke is worth most on the body it can finish; a Mana Burn is worth exactly what it TAKES, and
 * what it takes is `min(DataA, mana)` — so the target that has been saving its bar is the target,
 * whatever its hit points say. An empty pool is a 60-mana cast that does nothing at all, which is
 * how the same button reads as spam or as play.
 *
 * The two terms are therefore: WHO is holding the mana (a hero above everybody, `MANA_BURN_HERO`)
 * and HOW MUCH of the press actually lands (the share of the rank's own burn the pool can pay).
 * `pickTarget` breaks ties with distance as it does for every other single-target cast.
 */
export function manaBurnValue(t: SimUnit, lvl: AbilityLevel): number {
  const cap = dat(lvl, 0, 50);
  const lands = cap > 0 ? Math.min(cap, t.mana) / cap : 0;
  const who = t.isHero ? MANA_BURN_HERO : t.isSummon ? MANA_BURN_SUMMON : 1;
  return who * lands;
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
/** Unstable Concoction's two bars (`concoction`): this many enemy flyers in the blast… */
const CONCOCTION_AIR = 3;
/** …or this many Batriders' worth of hit points taken. OURS, both. */
const CONCOCTION_TRADE = 2;
/** …and how far past its cast range a Batrider looks for one — it is a flyer, it gets there. */
const CONCOCTION_REACH = 300;

const NEVER = new Set<string>([
  // 1. Jobs that belong to other parts of the AI, not to a caster.
  "Aent", // Entangle Gold Mine — the economy's (AiPlayer.entangleMines)
  "Ambt", // Replenish — the Moon Well pours itself
  "Aeat", // Eat Tree
  // HARVEST — a worker's job, and the GHOUL's. Reported: Ghouls "play their attack animation
  // and stop it abruptly before the attack registers" in creep camps. Traced live (Insane
  // undead, Echo Isles, seven minutes): 183 Ghoul swings at creeps were cancelled by a CAST
  // order, every one of them `Ahrl` "Harvest Lumber" aimed at the creep being hit — 118 times at
  // one Forest Troll. The Ghoul is not `isPeon`, so `canAct` let it through; `Ahrl` is on no list
  // here, so `roleOf` derived it as a unit-target attack spell off its row; and the press
  // re-tasked the Ghoul mid-swing (`issueCast` → `cancelSwing`) every `castPeriod` (0.35 s on
  // Insane), shorter than a Ghoul's own swing, so the blow never landed. All four harvest codes
  // (AbilityData.slk: `Ahar` Harvest, `Ahrl` Harvest Lumber and its two aliases, `Aaha` Acolyte
  // Harvest, `Awha` Wisp Harvest) are the economy's.
  "Ahar", "Ahrl", "Aaha", "Awha",
  "Auns", // Unsummon
  "Ashm", // Shadow Meld — a stance the sim holds
  "Aroo", // Root / Uproot — an Ancient walking, which is a building decision
  "Amel", "Amed", // the Meat Wagon's corpse cargo (armed as autocast instead)
  // 2. Buttons that spend the unit itself. A human uses a Sapper; an AI with no read on
  //    whether the trade is worth it uses them on a Footman. Left out until it can be judged.
  "Asds", // Kaboom!
  // Unstable Concoction is judged on its own instead, against enemy AIR — see `concoction`.
  "Auco", // Unstable Concoction
  "Adtn", // Detonate — a Wisp is a worker, and the economy has already assigned it
  // ABSORB MANA takes ALL of one of our own units' mana — `[Aabs] targs1 = player`, which the
  // derivation reads as a friendly spell with no duration, i.e. a HEAL, and a heal is the second
  // rung of the ladder: the Destroyer walked home to empty its own statue. It is a trade between
  // two of our own bars and the answer is almost always no — "seldom used because of the
  // Destroyer's high mana pool, which would result in draining Necromancers, Banshees and your
  // Heroes of a considerable amount of mana" (Wowpedia, Destroyer). Its mana comes from Devour.
  "Aabs",
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

const BEAR_FORM = "Abrf";
const REJUVENATION = "Arej";
/** A hero under this share of its hit points is worth a druid leaving Bear Form — the
 *  developer's 60 %. */
const REJUV_HERO_HP = 0.6;
/** How far a bear will go back for a hero — OURS: a little past Rejuvenation's own cast range
 *  (`[Arej] Rng1` 400), so the walk is short and the druid is still in the same fight. */
const REJUV_REACH = 900;
/** A task that has not landed in this long is given up — OURS. */
const REJUV_TASK_TIME = 8;
const rejuvenating = (u: SimUnit): boolean => u.buffs.some((b) => b.group === "rejuv");

/**
 * Autocasts that are ON against a player's army and OFF against a creep camp — the developer's
 * rule for the Sea Witch's Frost Arrows (`ANfa`): each arrow costs mana that a camp is not worth
 * and the slow is what a fight against a player is decided by. Flipped every pass by
 * `armAutocasts` off `playerInReach`, at every difficulty.
 */
const PLAYERS_ONLY_AUTOCAST = new Set<string>(["ANfa"]);

/** The share of its mana pool a caster whose autocast slot is a HEAL keeps back from the
 *  autocasts it presses by hand (`armAutocasts`): a Priest stops buffing with Inner Fire (35)
 *  at a quarter of his bar, which is still a dozen Heals (5). OURS. */
const SLOT_HEAL_RESERVE = 0.25;

/** Autocasts the AI must not simply switch on — the same two the classic caster holds back,
 *  for the same reasons (Defend costs 30% move speed and has a condition; Replenish is a job). */
const HAND_AUTOCAST = new Set<string>([
  "Adef", "Ambt",
  // …and the Obsidian Statue's two, which are one statue's CHOICE rather than two switches: a
  // statue autocasts one of them at a time, and `ComputerPlusAi.statuePass` decides which (life
  // on the first, mana on the second). Armed here as well, the two passes took turns flipping
  // the statue between them every pass for as long as it lived.
  "Arpl", "Arpm",
]);

/**
 * A morph's condition. The classic caster refuses this whole family; Computer+ is asked to use
 * it, so each one needs a rule of its own — a shape change is not a spell you spam.
 */
const MORPH_WHEN: Record<string, "engage" | "regen" | "destroyer"> = {
  Abrf: "engage", // Bear Form: the Druid's fighting body. Morph when a fight starts and stay.
  AEme: "engage", // Metamorphosis
  ANcr: "engage", // Chemical Rage
  ANrg: "engage", // Robo-Goblin
  ANef: "engage", // Storm, Earth and Fire
  Abur: "regen", // Burrow: a hurt Crypt Fiend digs in to heal, and only with nothing near it
  Aave: "destroyer", // Destroyer Form: a one-way, paid morph with rules of its own — see `destroyerWanted`
};

/**
 * DESTROYER FORM'S RULES. A statue is the undead's only healer and the morph cannot be undone,
 * so it is spent on one of the two occasions the guides name, and never on a whim:
 *
 *  · A STATUE ABOUT TO BE LOST. "Morph your low health statues into destroyers and produce new
 *    ones to replace them" (Liquipedia, Obsidian Statue — Strategy): a statue is Mechanical, so
 *    nothing but an Acolyte's repair ever heals it, and a Destroyer is a flyer with 850 life at
 *    the same share. `NEAR_DEATH` in a fight.
 *  · MAGIC WORTH EATING, with a statue to spare. The Destroyer is "an anti-caster unit designed
 *    to fight spellcasters" (Liquipedia, Destroyer), and "you can morph your statue into a
 *    Destroyer at any time, including in the middle of a fight, to have dispel at your
 *    disposal" (Obsidian Statue). So: `DESTROYER_MAGIC` bodies in the fight that Devour Magic
 *    would pay for, or enemy casters to stand among — and only while another statue keeps
 *    healing, since "you generally want to have 2 statues".
 *
 * And not past `DESTROYER_CAP`: "one or two Destroyers are needed when playing alone, but in team
 * matches three or four of them may prove useful" (Wowpedia, Destroyer). The statue spent is
 * rebuilt by the plan (races.ts `always` counts `uobs` alone). The price and the research are
 * `castUseError`'s, asked before this.
 */
const DESTROYER_MAGIC = 3;
const DESTROYER_CAP = 2;
const DESTROYER_CAP_TEAM = 4;
/** Destroyer Form, by base code. */
const DESTROYER_FORM = "Aave";

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
/**
 * WHEN A CREEP CAMP IS NO LONGER WORTH A SUMMON — `campSpent`.
 *
 * Reported: *"when a creep camp is too weak in terms of enemies and health % left, then heroes
 * with summoning abilities (far seer's feral spirit, archmage's summon water elemental etc.)
 * must not waste another summon cast on such a weak camp. However, it's good if they summon
 * when the camp is still healthy."* A summon is the one offensive press `OFFENSIVE` does not
 * gate, and rightly — a Water Elemental thrown in at the start of a creep run is most of what
 * makes an Archmage able to creep at all. But with `Cool1` 20 against a `Dur1` 60 it comes
 * back mid-run, and pressed again at the last Gnoll on a sliver it buys 125 mana of body for a
 * fight that is already over, and walks the hero into the next one with an empty bar.
 *
 * So a creep camp is judged by the two things a player sees of it — how many are left and how
 * much of the camp's hit points (`AiPlayer.campStanding`, the dead counted at zero) — and it is
 * SPENT when either says so:
 *
 *  · under `CAMP_SPENT_HP` of its hit points, whatever the count: six creeps at a fifth each
 *    are a camp the army already on the field finishes;
 *  · or down to `CAMP_FEW_BODIES` bodies and under `CAMP_FEW_HP` — the last one or two of a
 *    camp, which the rest of the party is already swinging at. The HEALTH half is what keeps a
 *    fresh two-Gnoll green camp (two bodies, all of its hit points) worth its opening summon.
 *
 * A PLAYER in reach makes it a real fight and the camp is not asked at all. Ours, all three.
 */
const CAMP_SPENT_HP = 0.25;
const CAMP_FEW_BODIES = 2;
const CAMP_FEW_HP = 0.5;
/** …and how hurt the CASTER has to be for a panic button. */
const NEAR_DEATH = 0.5;
/**
 * CANNIBALIZE IS EATEN BETWEEN FIGHTS, never in one — and only by a Ghoul that is actually hurt.
 *
 * The other half of the Ghoul report (see the harvest codes in `NEVER` for the half the trace
 * proved): `Acan` sat with the panic buttons, and a panic button fires the moment the caster is
 * `underAttack`, which a Ghoul in a camp always is — a press that re-tasks it mid-swing exactly as
 * the harvest one did, the moment a corpse lies within reach. Cannibalize is a CHANNEL (`[Acan]`
 * `Dur1` 15) that stands the Ghoul over a corpse, which a player does when the camp is DEAD, not
 * in the middle of it. So: no enemy in reach (`engaged` false) and under this share of its life.
 * Ours — nothing in the install says when an AI eats.
 */
const CANNIBALIZE_HP = 0.7;
const CANNIBALIZE = "Acan";
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
/**
 * Mirror Image (`AOmi`), by base code — the one `buff` whose effect is not a buff at all.
 *
 * Everything else on that rung leaves something on the caster that `buffFree` can see, so a
 * spell already up is never re-pressed. Mirror Image leaves BODIES: `[AOmi] BuffID1` is `BOmi`,
 * and `BOmi` is not a state the Blademaster carries — it is the popping effect an image dies
 * with (`MirrorImageDeathCaster`, src/sim/world.ts). So nothing in the data or in `buffFree`
 * says "you have already done this", and with `Cool1` = **3** against a `Dur1` of **60** the
 * rung fired every three seconds for as long as the fight lasted.
 *
 * Which is worse than merely wasteful, because of what the sim does on a re-cast: the previous
 * pack POPS (`startMirrorImage` unsummons every image of the caster before it places the new
 * ones), so a Blademaster pressing it on cooldown spends 100 mana to throw away the three
 * bodies the last 100 bought, over and over, and is never actually screened by anything.
 *
 * See `imagesStanding` for the gate.
 */
const MIRROR_IMAGE = "AOmi";
/**
 * Buttons pressed ONCE PER CREEP CAMP — the developer's: *"make the Mountain King use Thunder
 * Clap against creeps as well (don't spam it, perhaps use it once per creep camp)"*.
 *
 * Against creeps an offensive press waits on the once-per-fight roll (`CREEP_SPELL_SMALL` 25 %,
 * `CREEP_SPELL_BIG` 70 %), so most camps never saw the clap at all — and a camp that rolled
 * "yes" got it every time the cooldown came back. A row here bypasses that roll in a CREEP
 * fight and is then spent: one press per camp per caster (`campCasts`, keyed on the camp the
 * nearest creep was placed in — `CastCtx.campKey`). It still has to find its quorum of
 * bodies in the circle (`pickSpot`), so it lands when the camp is gathered round the hero rather
 * than on the first Gnoll to arrive. Against a PLAYER nothing here applies: the stun opens the
 * fight that matters every time it is up. Thunder Clap is `[AHtc]`: 300 area, 90 mana, a slow
 * and damage — the camp's whole melee line at once, which is what it is for. Ours.
 */
const ONCE_PER_CAMP: ReadonlySet<string> = new Set(["AHtc"]);

/**
 * …and a stun that is NOT held back for a bigger camp at all: the Tauren Chieftain's War Stomp.
 * The developer's *"tauren chieftain must be ok with using war stomp on 2-3 enemy units. Right
 * now it seems to only look for larger groups but less is ok too"*. Against creeps a three-body
 * camp rolled `CREEP_SPELL_SMALL` once for the whole fight, so three camps in four never saw the
 * stomp; it is a six-second cooldown on the hero standing in the middle of them, and two or
 * three stunned bodies are exactly what it is for. Still `CLUSTER` bodies in the circle
 * (`pickSpot`). Ours.
 */
const ANY_FIGHT: ReadonlySet<string> = new Set(["AOws"]);

/**
 * …and the spells NEVER spent on creeps at all, by base code: only a PLAYER's body in reach
 * (`playerInFight`) unlocks them, asked every pass rather than rolled, so the button is there the
 * moment an enemy army walks into the camp the party is clearing.
 *
 * The developer: *"the Far Seer AI is using too much of the 'Chain Lightning' ability on creep
 * camps. we must disable its usage against creep camps."* `CREEP_SPELL_SMALL`'s quarter chance
 * was not enough for this hero: Feral Spirit is its creeping skill (maxed first, `skills`), so the
 * Far Seer spends more of its game in a camp than anywhere else, and at 120 mana a press
 * (`[AOcl] Cost1`, `Cool1` 9) two presses are a bar — on Gnolls, with the fight against the
 * player that decides the game still ahead. Ours.
 */
const NO_CREEP_SPELLS: ReadonlySet<string> = new Set(["AOcl"]);

/**
 * THE BLOOD MAGE AND THE PALADIN — Siphon Mana (`AHdr`) as a mana PUMP.
 *
 * The developer's pairing (plus/races.ts `HeroCombo`): "the Blood Mage drains mana from enemy
 * units that have mana using Siphon Mana and then uses Siphon Mana to 'feed' mana to the Paladin
 * so that the Paladin can spam Holy Light". The row is two spells on one button and the sim
 * already plays both halves (sim/spells.ts `AHdr`): aimed at an enemy it TAKES `DataB` mana a
 * second, aimed at an ally it GIVES `DataE` — 15 and 30 at rank 1, over `Dur1` 6 s.
 *
 * Graded `nuke` with everything else it was simply thrown at the best enemy body, whether or not
 * that body had a drop of mana (a Footman), and never at a friend. So the button gets an aim of
 * its own (`siphonMana`), FEED first:
 *
 *  · an allied HERO with a mana pool under `SIPHON_FEED_BELOW` of it, in range, while the Blood
 *    Mage holds at least `SIPHON_FEED_KEEP` of his own — a hero that carries a HEAL is fed
 *    `SIPHON_HEALER` times as eagerly, which is the Paladin;
 *  · otherwise an ENEMY with at least `SIPHON_DRAIN_MIN` mana to take (a hero at `SIPHON_HERO`×),
 *    while his own bar has room for it. Never a worker: no melee worker has a mana pool anyway.
 *
 * The Dark Ranger's Drain shares the CODE and moves life, not mana (`DataB`/`DataE` both 0), so
 * it keeps the ordinary nuke aim. All of the numbers here are ours.
 */
const SIPHON_MANA = "AHdr";
const SIPHON_FEED_BELOW = 0.6;
const SIPHON_FEED_KEEP = 0.35;
const SIPHON_HEALER = 3;
const SIPHON_DRAIN_MIN = 40;
const SIPHON_HERO = 2;
/** The heals a fed hero is spending its mana on — Holy Light first among them. */
const SIPHON_HEALS: ReadonlySet<string> = new Set(["AHhb", "AOhw", "AUdc", "ANhs", "AEtq", "Arej"]);

/**
 * HEX GOES ON HEROES — the developer's "hex must be used on heroes more than units". A hero is
 * what a Shadow Hunter's one disable buys the most against: the Hex takes the hero's spells AND
 * its blows out of the fight, where a hexed Footman is one Footman. The expert ladder prices a
 * disable on a hero DOWN by its shorter `herodur1` (targeting.ts `spellFacts`: 3 s of 7), which is
 * right of a stun and wrong of this — so Hex is priced at its full duration on a hero, and then at
 * this premium on top. Ours.
 */
const HEX = "AOhx";
const HEX_HERO_FIRST = 3;

/**
 * HOLY LIGHT IS SPAMMED WHEN THE MANA IS THERE — the other end of `SIPHON_MANA`'s pump. A
 * Paladin holding more than `HOLY_LIGHT_RICH` of his bar heals anybody under `HOLY_LIGHT_TOPUP`
 * rather than waiting for the ordinary `HURT` bar: the mana the Blood Mage is pouring in is worth
 * nothing sitting in the Paladin. Ours.
 */
const HOLY_LIGHT = "AHhb";
const HOLY_LIGHT_RICH = 0.5;
const HOLY_LIGHT_TOPUP = 0.9;

/** How far past a dispel's own `Rng1` an enemy summon may stand and still be gone after
 *  (`dispelSummon`) — a short walk, the way a player's click on it walks the caster into range,
 *  and no further, or a Priest is walked out in front of the army for a Spirit Wolf. Ours. */
const DISPEL_REACH = 250;

/**
 * THE BREWMASTER'S COMBO — Drunken Haze, THEN Breath of Fire. The breath ignites what the haze
 * has soaked ("Units that have Drunken Haze on them will ignite and burn for <ANbf,DataE1> damage
 * per second", NeutralAbilityStrings `[ANbf]`; sim/spells.ts `ANbf`), which on a non-hero more
 * than doubles what it takes (Liquipedia, Breath of Fire). So with both buttons up the haze goes
 * FIRST, at the clump the breath can reach (`hazeFirst`), and the breath waits for the flask to
 * land and then goes through the soaked bodies, which count `SOAKED_WORTH` times (`corridor`).
 *
 * `HAZE_LAND` is the flask's flight and a little: `[ANdh] Missilespeed=1500` over a `Rng1` of
 * 550 is 0.37 s. `COMBO_WAIT` is how far off its own cooldown a breath may still be for the
 * haze to be thrown for it. Both OURS, as is `SOAKED_WORTH`.
 */
const DRUNKEN_HAZE = "ANdh";
const BREATH_OF_FIRE = "ANbf";
const HAZE_LAND = 0.6;
const COMBO_WAIT = 1;
const SOAKED_WORTH = 2;
const soaked = (t: SimUnit): boolean => t.buffs.some((b) => b.group === "haze" && b.timeLeft > 0);

/**
 * What a dispel does to ONE summon, by base code — the column each handler in sim/spells.ts
 * reads, with the same default beside it, so this and the sim agree about whether the press
 * finishes the body. Purge destroys a summon outright (its handler deals 100000).
 */
function summonBlow(code: string, lvl: AbilityLevel): number {
  switch (code) {
    case "Aprg": return Infinity;
    case "Adis": return dat(lvl, 1, 200);
    case "Aadm": return dat(lvl, 1, 300);
    case "Advm": return dat(lvl, 4, 160);
    default: return 0;
  }
}

/** Sentry Ward's base code — the Witch Doctor's `[Aeye]` and the item `[AIsw]` alike. Its
 *  planting is spaced out (`wardsWatching`). */
const SENTRY_WARD = "Aeye";
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
  /**
   * A button this caster must NOT press this pass, though it is legal and it would like to — asked
   * of every deliberate cast after `castUseError`. Optional because only a map AI with promises of
   * its own has one: a WarChasers party member keeps its heal (and the mana for it) for the hero it
   * has told "heal in 3 sec", and keeps a single-target heal for the party's HEROES while its bar
   * is short (warchasers/heal.ts).
   */
  holds?(u: SimUnit, code: string): boolean;
  /**
   * What is left of the creep camp this creep belongs to — its living bodies and the fraction of
   * the camp's hit points still standing (`AiPlayer.campStanding`) — or null when it is in no
   * camp. Optional because only the melee Computer+ reads a map's camps; a map AI's enemies are
   * that map's own and are never priced as one (`campSpent`).
   */
  campLeft?(creep: SimUnit): { alive: number; health: number } | null;
  /** …and WHICH camp it is, as a stable key (its centre) — what `ONCE_PER_CAMP` remembers a press
   *  against. Optional for the same reason as `campLeft`. */
  campKey?(creep: SimUnit): string | null;
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
  /** Caster → the creep camps it has already spent a `ONCE_PER_CAMP` button on. */
  private campCasts = new Map<number, Set<string>>();
  /** Druid of the Claw → the hero it has left Bear Form to Rejuvenate (`druidPass`). */
  private rejuvTask = new Map<number, { hero: number; since: number }>();
  /** Brewmaster → when it last threw Drunken Haze, so the breath waits for the flask
   *  (`HAZE_LAND`). Swept with `fightSince`. */
  private hazedAt = new Map<number, number>();

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
      if (this.canArm(u)) this.armAutocasts(u, foes);
      if (!this.canAct(u)) continue;
      if (this.druidPass(u, own)) continue;
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
    for (const id of this.campCasts.keys()) if (!alive.has(id)) this.campCasts.delete(id);
    for (const id of this.rejuvTask.keys()) if (!alive.has(id)) this.rejuvTask.delete(id);
    for (const id of this.hazedAt.keys()) if (!alive.has(id)) this.hazedAt.delete(id);
  }

  /**
   * THE DRUID OF THE CLAW LIVES IN BEAR FORM — the developer's rule for the night elf's tier-3
   * army: a druid that has Bear Form (`Redc` rank 2, `[Abrf] Requires=Redc Requiresamount=2`)
   * wears it all the time, not only for a fight, and leaves it for ONE reason: an own hero
   * under `REJUV_HERO_HP` it can Rejuvenate. The bear's card has no Rejuvenation (`edcm`
   * carries Roar and Bear Form only — UnitAbilities.slk), so the druid has to change back first,
   * and two rules keep that from wrecking the army:
   *
   *  · ONE druid per hero (`rejuvTask`) — every druid in reach turning back for the same
   *    Demon Hunter is the whole bear line standing in caster form at once.
   *  · only with the mana for BOTH presses, the change back and the heal — Bear Form keeps the
   *    absolute mana across the morph (SimWorld.morphUnit: the pools are 200/200), so the bear's
   *    own bar is what is read; a druid that changes back and cannot cast is a caster in a melee.
   *
   * The task ends when the hero wears Rejuvenation (anybody's), dies, or `REJUV_TASK_TIME` runs
   * out, and the druid goes straight back into the bear. Returns true when it has issued (or is
   * waiting on) an order of its own, so `tryCast` leaves it alone this pass; a bear with nothing
   * to do falls through to the ladder, which still Roars.
   */
  private druidPass(u: SimUnit, own: SimUnit[]): boolean {
    const bear = u.abilities.find((a) => a.level >= 1 && this.view.def(a.id)?.code === BEAR_FORM);
    if (!bear || !this.view.world.unitMeets(u, bear.id)) return false;
    const press = (code: string, targetId = 0): boolean =>
      this.view.world.castUseError(u.id, code) === null
      && this.view.order({ c: "cast", unitId: u.id, code, targetId, x: targetId ? 0 : u.x, y: targetId ? 0 : u.y, queued: false });
    const task = this.rejuvTask.get(u.id);
    if (task) {
      const hero = this.view.world.units.get(task.hero);
      if (!hero || hero.hp <= 0 || rejuvenating(hero) || this.now - task.since > REJUV_TASK_TIME) {
        this.rejuvTask.delete(u.id);
      } else if (u.altModel) {
        if (!press(bear.code)) this.rejuvTask.delete(u.id);
        return true;
      } else {
        const rej = u.abilities.find((a) => a.level >= 1 && this.view.def(a.id)?.code === REJUVENATION);
        if (rej && this.view.world.castError(u.id, rej.code, hero.id) === null && press(rej.code, hero.id)) return true;
        this.rejuvTask.delete(u.id);
      }
    }
    if (u.altModel) {
      const hero = this.rejuvWanted(u, own, bear);
      if (!hero) return false;
      this.rejuvTask.set(u.id, { hero: hero.id, since: this.now });
      press(bear.code);
      return true;
    }
    // In caster form with nothing to heal: back into the bear.
    return press(bear.code);
  }

  /** The own hero this BEAR should change back for, if any — see `druidPass`. */
  private rejuvWanted(u: SimUnit, own: SimUnit[], bear: SimUnit["abilities"][number]): SimUnit | null {
    const rejDef = this.view.def(REJUVENATION);
    const bearDef = this.view.def(bear.id);
    if (!rejDef || !bearDef) return null;
    const rejCost = rejDef.levelData[0]?.cost ?? 0;
    const bearCost = bearDef.levelData[Math.min(bear.level, bearDef.levelData.length) - 1]?.cost ?? 0;
    if (u.mana < rejCost + bearCost) return null;
    const claimed = new Set([...this.rejuvTask.values()].map((t) => t.hero));
    let best: SimUnit | null = null;
    for (const h of own) {
      if (!h.isHero || h.hp <= 0 || claimed.has(h.id) || rejuvenating(h)) continue;
      if (h.hp / Math.max(1, h.maxHp) >= REJUV_HERO_HP || !near(u, h, REJUV_REACH)) continue;
      if (!best || h.hp / h.maxHp < best.hp / best.maxHp) best = h;
    }
    return best;
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

  /**
   * Switch on the unit's autocast, and let `SimWorld.tickAutocast` run it. That covers Heal,
   * Slow, Bloodlust, Curse, Faerie Fire, Frost Armor, Abolish Magic, Web, Raise Dead, Get Corpse
   * and every arrow orb, with none of it restated here. (Ensnare is a target spell, not an
   * autocast, and is cast off `roleOf` as a disable.)
   *
   * ONE PER UNIT, the way a player has it: the toggle is the game's one-at-a-time slot
   * (`SimWorld.toggleAutocast`), and switching a second autocast on puts the first out. A Priest
   * carries two, Heal and Inner Fire, and this walk used to switch on whichever was off — so
   * every pass lit one and doused the other, and the Priest spent the fight with Heal off half
   * the time, standing beside the wounded. The slot goes to the HEAL when the unit has one (the
   * developer's "leave autocast on Heal"), else to the first; every other autocast it carries is
   * PRESSED BY HAND off the ladder instead (`tryCast`), which is how a player gets Inner Fire on
   * the army while the Priest heals. A morph is never the slot — it is a decision (`MORPH_WHEN`).
   */
  private armAutocasts(u: SimUnit, foes: SimUnit[]): void {
    for (const ab of u.abilities) {
      if (ab.level < 1) continue;
      const def = this.view.def(ab.id);
      if (!def || !PLAYERS_ONLY_AUTOCAST.has(def.code)) continue;
      // A TOGGLE both ways round, so it is only flipped when it disagrees with the fight.
      const want = this.playerInReach(u, foes);
      if (want !== ab.autocastOn) this.view.order({ c: "autocast", unitId: u.id, code: ab.code });
    }
    const slot = this.autocastSlot(u);
    if (slot && !slot.autocastOn) this.view.order({ c: "autocast", unitId: u.id, code: slot.code });
  }

  /** WHICH autocast holds the unit's one slot (`armAutocasts`): its HEAL if it has one, else the
   *  first it may arm; null for none. Asked by `tryCast` too, which presses the others by hand. */
  private autocastSlot(u: SimUnit): SimUnit["abilities"][number] | null {
    let slot: SimUnit["abilities"][number] | null = null;
    let slotHeals = false;
    for (const ab of u.abilities) {
      if (ab.level < 1) continue;
      const def = this.view.def(ab.id);
      if (!def?.autocast || PLAYERS_ONLY_AUTOCAST.has(def.code)) continue;
      if (NEVER.has(def.code) || HAND_AUTOCAST.has(def.code) || isRepairCode(def.code) || MORPH_WHEN[def.code]) continue;
      if (!this.view.world.unitMeets(u, ab.id)) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      const heals = !!lvl && roleOf(def, lvl) === "heal";
      if (!slot || (heals && !slotHeals)) {
        slot = ab;
        slotHeals = heals;
      }
    }
    return slot;
  }

  /** A hostile PLAYER's unit (never a creep, a building or a worker) inside the unit's look —
   *  the same reading `worthTheMana` makes, without the creep roll. */
  private playerInReach(u: SimUnit, foes: SimUnit[]): boolean {
    const look = Math.max(u.weapon?.acquire ?? 0, MIN_LOOK);
    for (const f of foes) {
      if (f.building || f.isPeon || f.isCreep || !near(u, f, look)) continue;
      if (f.owner >= 0 && f.owner < MELEE.MAX_PLAYERS) return true;
    }
    return false;
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
    // ENEMY SUMMONS FIRST, on the rung that does it (`PlusProfile.dispelSummons`) — see
    // `dispelSummon`. Above the whole ladder, because the button is the cheapest kill there is
    // and the summon is only on the field for its own short clock.
    if (this.profile.dispelSummons && this.dispelSummon(u, friends, foes)) return true;
    // …and a BATRIDER worth trading for the air it would take with it — see `concoction`.
    if (this.concoction(u, foes)) return true;
    // THE BREWMASTER'S HAZE GOES BEFORE HIS BREATH — see `DRUNKEN_HAZE`.
    if (this.hazeFirst(u, foes, engaged)) return true;
    const flaskFlying = this.now - (this.hazedAt.get(u.id) ?? -Infinity) < HAZE_LAND;
    const slot = this.autocastSlot(u);
    const cards: Array<{ role: Role; ab: SimUnit["abilities"][number]; def: AbilityDef; lvl: AbilityLevel }> = [];
    for (const ab of u.abilities) {
      if (ab.level < 1 || ab.cooldownLeft > 0) continue;
      const def = this.view.def(ab.id);
      if (!def || def.target === "passive") continue;
      if (NEVER.has(def.code) || HAND_AUTOCAST.has(def.code) || isRepairCode(def.code)) continue;
      // An autocast is the sim's job (see armAutocasts) — except a morph, which wears the flag
      // on some rows and is emphatically a decision, and an autocast that does NOT hold the
      // unit's one slot: the Priest's Inner Fire, with Heal on, is pressed by hand like a
      // spell (armAutocasts).
      if (def.autocast && !MORPH_WHEN[def.code] && (ab === slot || PLAYERS_ONLY_AUTOCAST.has(def.code))) continue;
      // …and the breath waits while the flask it is for is still in the air.
      if (def.code === BREATH_OF_FIRE && flaskFlying) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (!lvl) continue;
      const role = def.code === WIND_WALK ? this.windWalkRole(u) : roleOf(def, lvl);
      if (!role || !this.roles.has(role)) continue;
      cards.push({ role, ab, def, lvl });
    }
    cards.sort((a, b) => roleRank(a.role) - roleRank(b.role));

    // The creep camp this fight is against, if it is one — asked only for a `ONCE_PER_CAMP` card.
    let camp: string | null | undefined;
    for (const card of cards) {
      // ONCE PER CAMP (`ONCE_PER_CAMP`): spent on this camp already → skip; not yet → the
      // engagement's mana roll is not asked.
      let once = ANY_FIGHT.has(card.def.code); // `ANY_FIGHT` — no mana roll either, and never spent
      if (ONCE_PER_CAMP.has(card.def.code) && engaged) {
        if (camp === undefined) camp = this.creepCamp(u, foes);
        if (camp !== null) {
          if (this.campCasts.get(u.id)?.has(camp)) continue;
          once = true;
        }
      }
      if (!this.ready(u, card.role, engaged, once)) continue;
      // Mana, cooldown, the upgrade gate and "is there even a corpse" — asked of the sim, at
      // the same door a player's click asks, so this can never be more permissive.
      if (this.view.world.castUseError(u.id, card.ab.code) !== null) continue;
      if (this.ctx.holds?.(u, card.ab.code)) continue;
      if (NO_CREEP_SPELLS.has(card.def.code) && !this.playerInFight(u, foes)) continue;
      if (!this.wants(u, card.def, card.role, friends, foes, engaged)) continue;
      if (this.aim(u, card.ab.code, card.def, card.lvl, card.role, friends, foes)) {
        if (once && camp && ONCE_PER_CAMP.has(card.def.code)) {
          let spent = this.campCasts.get(u.id);
          if (!spent) this.campCasts.set(u.id, (spent = new Set()));
          spent.add(camp);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * The CREEP CAMP this caster is fighting, as `CastCtx.campKey` names it — the camp of the
   * nearest creep in reach — or null when it is not a creep fight: a hostile PLAYER's body in
   * reach makes it a real one (the same rule `campSpent` and `worthTheMana` read), and so does a
   * map that keeps no camp table.
   */
  private creepCamp(u: SimUnit, foes: SimUnit[]): string | null {
    if (!this.ctx.campKey) return null;
    const look = Math.max(u.weapon?.acquire ?? 0, MIN_LOOK);
    let nearest: SimUnit | null = null;
    let nearestD = Infinity;
    for (const f of foes) {
      if (f.building || !near(u, f, look)) continue;
      if (!f.isCreep) {
        if (f.owner >= 0 && f.owner < MELEE.MAX_PLAYERS && !f.isPeon) return null;
        continue;
      }
      const d = Math.hypot(f.x - u.x, f.y - u.y);
      if (d < nearestD) { nearestD = d; nearest = f; }
    }
    return nearest ? this.ctx.campKey(nearest) : null;
  }

  /**
   * DRUNKEN HAZE, THROWN FOR THE BREATH — see `DRUNKEN_HAZE` for the combo.
   *
   * Only for a hero who holds BOTH, with the breath up (or about to be, `COMBO_WAIT`) and the mana
   * for the two presses, in a fight this caster is spending mana on. Thrown on the enemy whose
   * splash (`Area1` 200) soaks the most VALUE that is not soaked already — a clump of at least
   * `CLUSTER` bodies, which is what the breath's line then goes through — and only within the
   * breath's own reach plus that splash, so the ignite follows the throw rather than a walk.
   *
   * On every rung but Easy (`disable` in `rolesFor`). A haze thrown with NO breath behind it is
   * still the `debuff` it always was, and still Insane's alone.
   */
  private hazeFirst(u: SimUnit, foes: SimUnit[], engaged: boolean): boolean {
    if (!engaged || !this.roles.has("disable") || this.offense.get(u.id) === false) return false;
    let haze: { ab: SimUnit["abilities"][number]; def: AbilityDef; lvl: AbilityLevel } | null = null;
    let breath: { ab: SimUnit["abilities"][number]; def: AbilityDef; lvl: AbilityLevel } | null = null;
    for (const ab of u.abilities) {
      if (ab.level < 1) continue;
      const def = this.view.def(ab.id);
      if (!def || (def.code !== DRUNKEN_HAZE && def.code !== BREATH_OF_FIRE)) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (!lvl) continue;
      if (def.code === DRUNKEN_HAZE) haze = { ab, def, lvl };
      else breath = { ab, def, lvl };
    }
    if (!haze || !breath || haze.ab.cooldownLeft > 0 || breath.ab.cooldownLeft > COMBO_WAIT) return false;
    if (u.mana < haze.lvl.cost + breath.lvl.cost) return false;
    if (!this.ready(u, "disable", engaged)) return false;
    if (this.view.world.castUseError(u.id, haze.ab.code) !== null) return false;
    if (this.ctx.holds?.(u, haze.ab.code)) return false;
    const splash = haze.lvl.area || 200;
    const reach = Math.min(haze.lvl.castRange, waveDistance(breath.def, breath.lvl) + splash);
    let best: SimUnit | null = null;
    let bestValue = 0;
    for (const t of foes) {
      if (t.building || !near(u, t, reach)) continue;
      let count = 0;
      let value = 0;
      for (const o of foes) {
        if (Math.hypot(o.x - t.x, o.y - t.y) > splash + o.radius) continue;
        if (soaked(o) || !this.counts(u, o, haze.def, "debuff", false)) continue;
        count++;
        value += this.value(o, "debuff", haze.lvl);
      }
      if (count < CLUSTER || value <= bestValue) continue;
      if (this.view.world.castError(u.id, haze.ab.code, t.id) !== null) continue;
      if (this.view.refuses?.(u, haze.ab.code, t)) continue;
      bestValue = value;
      best = t;
    }
    if (!best) return false;
    if (!this.view.order({ c: "cast", unitId: u.id, code: haze.ab.code, targetId: best.id, x: 0, y: 0, queued: false })) return false;
    this.hazedAt.set(u.id, this.now);
    return true;
  }

  /**
   * KILL THE ENEMY'S SUMMONS WITH A DISPEL — the developer's: Insane "must use its dispel
   * abilities (Priest's Dispel Magic, Dryad Abolish Magic, Spirit Walker Disenchant, Destroyer
   * Devour Magic etc.) on enemy summoned units to kill them fast (like water elementals, lava
   * spawns etc.)".
   *
   * Every member of the family (`DISPEL_CODES`; Disenchant is `Adcn` on the `Adis` code) ends a
   * summon by its own handler (sim/spells.ts): Purge destroys it outright, Dispel Magic and
   * Disenchant deal `DataB`, Abolish Magic `DataB`, Devour Magic `DataE` — 200 / 300 / 160 at
   * rank 1, which is a Water Elemental or a Lava Spawn gone in one press. The ordinary ladder
   * already reaches some of these buttons, but on its own terms: Dispel Magic is a `debuff`,
   * the last rung before utility, and Abolish Magic is an AUTOCAST the ladder never presses at
   * all — and its autocast is the SMART dispel that leaves summons alone by design
   * (`AbolishMagicDispelSmart`, see `worthDispelling`). So a Dryad standing next to a Water
   * Elemental never touched it. This is the manual press a player makes instead.
   *
   * A single-target dispel goes on the summon it kills, else the biggest one in reach; an area
   * one goes where it catches the most enemy summon hit points, and never where it would catch
   * as much of OUR OWN — the handlers do not ask allegiance, and our Water Elemental dies to our
   * Priest's Dispel exactly as theirs does. `DISPEL_REACH` lets the caster walk a little way to
   * it, as a player's click does. Legality is the click's own (`castUseError` / `castError`).
   */
  private dispelSummon(u: SimUnit, friends: SimUnit[], foes: SimUnit[]): boolean {
    const theirs = foes.filter((f) => f.isSummon && f.hp > 0 && !f.invulnerable && !f.building);
    if (!theirs.length) return false;
    const ours = friends.filter((f) => f.isSummon && f.hp > 0);
    for (const ab of u.abilities) {
      if (ab.level < 1 || ab.cooldownLeft > 0) continue;
      const def = this.view.def(ab.id);
      if (!def || !DISPEL_CODES.has(def.code)) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (!lvl) continue;
      if (this.view.world.castUseError(u.id, ab.code) !== null) continue;
      if (this.ctx.holds?.(u, ab.code)) continue;
      const reach = lvl.castRange + DISPEL_REACH;
      if (def.target === "unit") {
        let best: SimUnit | null = null;
        let bestScore = -Infinity;
        for (const t of theirs) {
          if (!near(u, t, reach)) continue;
          if (this.view.world.castError(u.id, ab.code, t.id) !== null) continue;
          if (this.view.refuses?.(u, ab.code, t)) continue;
          // What the press ENDS — a body it finishes outright is worth its whole life; one it
          // only hurts, the damage. Distance breaks ties, as everywhere else in this file.
          const blow = summonBlow(def.code, lvl);
          const s = Math.min(t.hp, blow) * 10 + t.maxHp - Math.hypot(t.x - u.x, t.y - u.y) * 0.01;
          if (s > bestScore) { bestScore = s; best = t; }
        }
        if (best && this.view.order({ c: "cast", unitId: u.id, code: ab.code, targetId: best.id, x: 0, y: 0, queued: false })) return true;
        continue;
      }
      if (def.target !== "point") continue;
      const area = lvl.area || 200;
      const blow = summonBlow(def.code, lvl);
      const caught = (x: number, y: number, pool: SimUnit[]): number => {
        let hp = 0;
        for (const t of pool) {
          if (Math.hypot(t.x - x, t.y - y) > area + t.radius) continue;
          if (!this.view.world.targsAdmit(t, def.targetFlags)) continue;
          hp += Math.min(t.hp, blow);
        }
        return hp;
      };
      let spot: { x: number; y: number } | null = null;
      let bestValue = 0;
      for (const t of theirs) {
        if (!near(u, t, reach)) continue;
        const gain = caught(t.x, t.y, theirs);
        if (gain <= 0 || caught(t.x, t.y, ours) >= gain) continue;
        if (gain <= bestValue) continue;
        if (this.view.world.castError(u.id, ab.code, 0, t.x, t.y) !== null) continue;
        bestValue = gain;
        spot = { x: t.x, y: t.y };
      }
      if (spot && this.view.order({ c: "cast", unitId: u.id, code: ab.code, targetId: 0, x: spot.x, y: spot.y, queued: false })) return true;
    }
    return false;
  }

  /**
   * UNSTABLE CONCOCTION — the Batrider flies into an enemy flyer and explodes: `DataB` to the one
   * it hits and `DataD` to every other enemy AIR unit within `DataC`, and the Batrider dies
   * (spells.ts `Auco`). The developer's: *"batriders can use Unstable Concoction to kill a bunch
   * of air units of the enemy"*.
   *
   * It spends the unit, which is why it sat on `NEVER`: pressed at the first flyer in reach, it
   * trades 160 gold of Batrider for a Gryphon's scratch. So it is pressed only where the trade is
   * plainly good, and both bars are OURS:
   *
   *  · a CLUSTER — `CONCOCTION_AIR` enemy flyers inside the blast, the one it hits included —
   *    which is what "a bunch of air units" means;
   *  · or a BIG ONE — hit points taken (each body's share capped at what it has left) of at least
   *    `CONCOCTION_TRADE` Batriders' worth of life: a Frost Wyrm or a Chimaera, alone.
   *
   * Never on Easy, which does not know the button exists. Aimed at the target that takes the most.
   */
  private concoction(u: SimUnit, foes: SimUnit[]): boolean {
    if (this.profile.difficulty === MELEE_NEWBIE) return false;
    const ab = u.abilities.find((a) => a.level >= 1 && a.cooldownLeft <= 0 && this.view.def(a.id)?.code === "Auco");
    if (!ab) return false;
    const def = this.view.def(ab.id);
    const lvl = def?.levelData[Math.min(ab.level, def.levelData.length) - 1];
    if (!def || !lvl) return false;
    if (this.view.world.castUseError(u.id, ab.code) !== null) return false;
    if (this.ctx.holds?.(u, ab.code)) return false;
    const air = foes.filter((f) => f.flying && f.hp > 0 && !f.invulnerable && !f.building);
    if (!air.length) return false;
    const direct = lvl.data[1] || 600;
    const radius = lvl.data[2] || 200;
    const splash = lvl.data[3] || 140;
    const reach = lvl.castRange + CONCOCTION_REACH;
    let best: SimUnit | null = null;
    let bestValue = 0;
    for (const t of air) {
      if (!near(u, t, reach)) continue;
      let caught = 0;
      let value = 0;
      for (const e of air) {
        if (e !== t && Math.hypot(e.x - t.x, e.y - t.y) > radius) continue;
        caught++;
        value += Math.min(e.hp, e === t ? direct : splash);
      }
      if (caught < CONCOCTION_AIR && value < u.maxHp * CONCOCTION_TRADE) continue;
      if (value <= bestValue) continue;
      if (this.view.world.castError(u.id, ab.code, t.id) !== null) continue;
      best = t;
      bestValue = value;
    }
    return !!best && this.view.order({ c: "cast", unitId: u.id, code: ab.code, targetId: best.id, x: 0, y: 0, queued: false });
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
  private ready(u: SimUnit, role: Role, engaged: boolean, oncePerCamp = false): boolean {
    if (role === "panic" || role === "heal") return true;
    // …AND WHETHER IT IS SPENDING THE MANA ON THIS FIGHT AT ALL — see `CREEP_SPELL_SMALL`. The
    // decision belongs to the engagement rather than to the pass, so it is asked of a roll made
    // once when the fight started (`trackFight`) and it holds for the whole of it. A
    // `ONCE_PER_CAMP` press against a camp it has not yet been spent on is not asked.
    if (OFFENSIVE.has(role) && !oncePerCamp && this.offense.get(u.id) === false) return false;
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
  /** Is a hostile PLAYER's fighting body in this caster's reach — the half of `worthTheMana`
   *  that answers "always", asked on its own for `NO_CREEP_SPELLS`. A scout's worker and a
   *  building do not make it a player fight, exactly as there. */
  private playerInFight(u: SimUnit, foes: SimUnit[]): boolean {
    const look = Math.max(u.weapon?.acquire ?? 0, MIN_LOOK);
    return foes.some((f) => !f.building && !f.isPeon && !f.isCreep && f.owner >= 0 && f.owner < MELEE.MAX_PLAYERS
      && near(u, f, look));
  }

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
  private wants(u: SimUnit, def: AbilityDef, role: Role, friends: SimUnit[], foes: SimUnit[], engaged: boolean): boolean {
    switch (role) {
      case "panic":
        // WIND WALK'S EXIT has already asked the two questions that decide it — the hit points
        // and whether there is a scroll to leave with (`windWalkRole`) — so the only thing left
        // is that there is a fight to leave at all. Without that clause a hero at a third life
        // walking home across an empty map spends the cooldown on nothing.
        if (def.code === WIND_WALK) return engaged;
        if (def.code === CANNIBALIZE) return !engaged && u.hp / Math.max(1, u.maxHp) < CANNIBALIZE_HP;
        // "Casts when attacked … the health of the unit isn't a factor" is the real client's
        // Divine Shield; a Wind Walk or a Blink is the opposite, an exit taken when losing.
        // Both are here: hit right now, or hurt badly enough to leave.
        return this.underAttack(u, foes) || u.hp / Math.max(1, u.maxHp) <= NEAR_DEATH;
      case "morph":
        if (MORPH_WHEN[def.code] === "destroyer") return this.destroyerWanted(u, def, friends, foes, engaged);
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
        // NOT ON A CAMP THAT IS ALREADY BEATEN — see `CAMP_SPENT_HP`.
        return engaged && !this.campSpent(u, foes);
      case "buff":
      case "utility":
        // MIRROR IMAGE IS NOT RE-PRESSED WHILE ITS OWN IMAGES ARE STILL WALKING — see
        // `MIRROR_IMAGE`. Reported: the Computer+ orc "seems to be spamming the Mirror Image
        // ability instead of waiting for the mirror images to die first".
        // …nor while the Blademaster is INVULNERABLE: the press dispels everything on him, his
        // own Potion of Invulnerability included (`stripsOwnShield`).
        if (def.code === MIRROR_IMAGE) return engaged && !stripsOwnShield(def.code, u) && !this.imagesStanding(u);
        // …and an autocast pressed by HAND beside a heal that holds the slot (the Priest's Inner
        // Fire, see `armAutocasts`) leaves the heal its mana — see `SLOT_HEAL_RESERVE`.
        if (def.autocast && this.healHoldsSlot(u)) { // (never the slot itself — `tryCast` skips it)
          const cost = def.levelData[0]?.cost ?? 0;
          return engaged && u.mana - cost >= u.maxMana * SLOT_HEAL_RESERVE;
        }
        return engaged;
    }
  }

  /** Is one of this unit's autocasts a HEAL, switched on — the slot `armAutocasts` gives it? */
  private healHoldsSlot(u: SimUnit): boolean {
    for (const ab of u.abilities) {
      if (!ab.autocastOn || ab.level < 1) continue;
      const def = this.view.def(ab.id);
      const lvl = def?.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (def && lvl && roleOf(def, lvl) === "heal") return true;
    }
    return false;
  }

  /**
   * IS THE CREEP FIGHT IN FRONT OF THIS CASTER ALREADY WON? — the gate on a summon (see
   * `CAMP_SPENT_HP` for the report and the numbers).
   *
   * Read at the same reach and with the same "a player is always a real fight" rule as
   * `worthTheMana`, but asked EVERY pass rather than rolled once: the whole point is that the
   * camp that was worth the first summon is not worth the second. The camp is the NEAREST
   * creep's, found off its guard post (where it was placed, and what the camp table is built
   * from) rather than off where the fight has dragged it. Two camps pulled into one fight are
   * the rare case, and the nearer is the one the caster is actually in.
   */
  private campSpent(u: SimUnit, foes: SimUnit[]): boolean {
    if (!this.ctx.campLeft) return false;
    const look = Math.max(u.weapon?.acquire ?? 0, MIN_LOOK);
    let nearest: SimUnit | null = null;
    let nearestD = Infinity;
    for (const f of foes) {
      if (f.building || !near(u, f, look)) continue;
      if (!f.isCreep) {
        if (f.owner >= 0 && f.owner < MELEE.MAX_PLAYERS) return false; // a player: always worth it
        continue;
      }
      const d = Math.hypot(f.x - u.x, f.y - u.y);
      if (d < nearestD) { nearestD = d; nearest = f; }
    }
    if (!nearest) return false;
    const camp = this.ctx.campLeft(nearest);
    if (!camp) return false;
    if (camp.health < CAMP_SPENT_HP) return true;
    return camp.alive <= CAMP_FEW_BODIES && camp.health < CAMP_FEW_HP;
  }

  /**
   * ARE THIS HERO'S OWN COPIES STILL STANDING? — the gate on Mirror Image.
   *
   * Asked of the sim's own link rather than remembered here: `SimUnit.illusionOf` is the id of
   * the body a copy was made FROM (`initIllusion`, docs/illusions.md), so this is exactly the
   * set `startMirrorImage` would pop if the button were pressed again. Which also means a
   * double made by a Wand of Illusion off this hero counts — and it should: what the rung is
   * for is bodies in the line that the enemy cannot tell from the hero, and those already are
   * some. The pack lives `Dur1` = 60 seconds, so the button comes back when it is empty, when
   * the images have been killed, or when the hero is somewhere new — which is what a player
   * presses it for.
   */
  private imagesStanding(u: SimUnit): boolean {
    for (const o of this.view.world.units.values()) {
      if (o.hp > 0 && o.isIllusion && o.illusionOf === u.id) return true;
    }
    return false;
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

  /**
   * Is this the moment to spend an Obsidian Statue on a Destroyer? See `DESTROYER_MAGIC` for the
   * two occasions and where each is quoted from.
   *
   * Asked only of the statue half: a Destroyer carries `Aave` too, and `castUseError` has already
   * refused it there (a permanent form has no way back), but the check here is cheaper to read.
   */
  private destroyerWanted(u: SimUnit, def: AbilityDef, friends: SimUnit[], foes: SimUnit[], engaged: boolean): boolean {
    if (!engaged) return false;
    const lvl = def.levelData[0];
    const statue = lvl?.dataStr[0] ?? "";
    const destroyer = lvl?.summon ?? "";
    if (!statue || u.typeId !== statue) return false;
    let statues = 0;
    let destroyers = 0;
    const opponents = new Set<number>();
    for (const o of this.view.world.units.values()) {
      if (o.hp <= 0) continue;
      if (o.owner === this.view.player) {
        // A statue already ORDERED into the form is a Destroyer for this count. Two statues read
        // in the same pass both saw "a second statue is still healing" and both morphed, because
        // the body only changes when the order fires — the army lost both its healers at once.
        const going = o.pendingCast?.code === DESTROYER_FORM && !o.pendingCast.fired;
        if (o.typeId === statue && !going) statues++;
        else if (o.typeId === destroyer || going) destroyers++;
      } else if (!o.isCreep && o.owner >= 0 && o.owner < MELEE.MAX_PLAYERS && this.view.hostile(o)) {
        opponents.add(o.owner);
      }
    }
    if (destroyers >= (opponents.size > 1 ? DESTROYER_CAP_TEAM : DESTROYER_CAP)) return false;
    // About to be lost: a Destroyer it becomes, whatever else is true.
    if (u.hp / Math.max(1, u.maxHp) <= NEAR_DEATH) return true;
    // Magic worth eating — and a second statue still pouring life into the army.
    if (statues < 2) return false;
    const units = this.view.world.units;
    let magic = 0;
    for (const f of foes) {
      if (f.building || f.hp <= 0 || !near(u, f, ENGAGE_LOOK)) continue;
      if (worthDispelling(f, units, false) || (!f.isHero && !f.isCreep && f.maxMana > 0)) magic++;
    }
    for (const f of friends) {
      if (f.hp > 0 && !f.building && near(u, f, ENGAGE_LOOK) && worthDispelling(f, units, true)) magic++;
    }
    return magic >= DESTROYER_MAGIC;
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
    if (def.code === SIPHON_MANA && (dat(lvl, 1, 0) > 0 || dat(lvl, 4, 0) > 0)) {
      const t = this.siphonTarget(u, code, lvl, friends, foes);
      if (!t) return false;
      return this.view.order({ c: "cast", unitId: u.id, code, targetId: t.id, x: 0, y: 0, queued: false });
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
   *    own `delay`), so a hero sent in on the tick it pressed would arrive swinging inside the
   *    window and collect nothing — a whole cooldown spent on an ordinary blow. The sim will
   *    not let that swing start at all now (`SimWorld.engage` refuses one from a unit still
   *    fading, and the press itself drops the fight — `dropAggression`), so what this order
   *    buys is the WALK: the hero closes the ground while it disappears. `backstabPass` orders
   *    the blow once the fade has landed, and it has to, because nothing under an invisibility
   *    ever picks its own fight (`acquireRange` is 0 for anything cloaked).
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
    // MANA BURN is aimed at a BAR and not at a body — see `manaBurnValue` for the ladder and
    // `manaBurnWorthIt` for the floor under it.
    const manaBurn = code === MANA_BURN;
    // …and WHICH polarity spell, because only one of the two holds its heal back. The row itself
    // says so: `healsUndead` is what makes this the Death Coil side of the mirror, whose other
    // half is the undead's opening nuke (see `COIL_HEAL_HP`). Holy Light's other half only ever
    // reaches enemy Undead, so it competes with nothing and keeps the ordinary `HURT` bar.
    const healBar = POLARITY_SPELLS[code]?.healsUndead ? COIL_HEAL_HP
      : code === HOLY_LIGHT && u.mana >= u.maxMana * HOLY_LIGHT_RICH ? HOLY_LIGHT_TOPUP
      : HURT;
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
      // …NOR, FOR DEATH COIL, IS A SUMMON. Reported: the Death Knight coiling its own Skeleton
      // Warriors back up. A raised Skeleton is undead, friendly and hurt, so it passes every rule
      // the heal half has — and it is leaving on its own clock (Raise Dead's `Dur1`),
      // costs nothing to replace, and is the one body in an undead army the NEXT corpse makes
      // another of. The same coil is the 200/400/600 burst that finishes something on the other
      // side. Both marks are asked: `isSummon` (the spell's own summons, and UNIT_TYPE_SUMMONED)
      // and a running `summonLeft` (any unit on a timed life — `UnitApplyTimedLife` puts one on
      // a unit that is not a summon, and it is leaving just the same). Death Coil's half only
      // (`healsUndead`): Holy Light's heal competes with no nuke, and the ordinary heals already
      // price a summon down (`targeting.ts` `SUMMON`) rather than ruling it out.
      if (heals && polarity && POLARITY_SPELLS[code]?.healsUndead && (t.isSummon || t.summonLeft > 0)) continue;
      if (inferred && t === u) continue; // see `inferred`

      if (!near(u, t, lvl.castRange)) continue;
      // …and the healing half of a POLARITY spell is held later than an ordinary heal — see
      // `COIL_HEAL_HP`. Death Coil's other half is the undead's opening nuke, so a coil spent
      // on a scratch is a burst that was going to finish something.
      if (half === "heal" && t.hp / Math.max(1, t.maxHp) > healBar) continue;
      // A NUKE IS NOT SPENT ON A WORKER IT CANNOT FINISH — see `nukeWorthIt`. Here rather than
      // in the score so the misclick below cannot land on one either.
      if (half === "nuke" && !nukeWorthIt(code, lvl, t)) continue;
      // …AND A MANA BURN IS NOT SPENT ON AN EMPTY BAR. Here rather than in the score for the
      // same reason: a "mistake" that burns 4 mana off a drained Sorceress is not sloppiness.
      if (manaBurn && !this.manaBurnWorthIt(t, lvl)) continue;
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
      // …and a target the owner's own judgement keeps off this button (`CasterView.refuses`) —
      // a WarChasers party member's heroes, whose heals have a pass of their own.
      if (this.view.refuses?.(u, code, t)) continue;
      legal.push(t);
      // Worth first, distance only as the tie-break — and `bestScore` starts below every
      // possible score, because a cheap target at the edge of a long cast range scores
      // negative and would otherwise never be picked at all.
      // A HEAL OUTBIDS THE NUKE on a polarity button: the two halves are scored on different
      // ladders and would otherwise be compared as if they were the same number, so a Death
      // Knight with a Ghoul at a fifth of its life would still coil whatever was in front of
      // it. Putting a body back on its feet is worth more than hurting one.
      const worth = manaBurn
        ? manaBurnValue(t, lvl)
        : code === HEX
          // HEX: priced at its FULL duration on a hero, and then at a premium — see `HEX_HERO_FIRST`.
          ? this.value(t, half, { ...lvl, heroDuration: lvl.duration }) * (t.isHero ? HEX_HERO_FIRST : 1)
          : this.value(t, half, lvl, def.code) * (half === "heal" && polarity ? POLARITY_HEAL_FIRST : 1);
      const s = worth * 1000 - Math.hypot(t.x - u.x, t.y - u.y);
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

  /** Siphon Mana's aim — FEED a hero that is short, else DRAIN an enemy that has some. See
   *  `SIPHON_MANA`. Legality is still the click's own (`castError`). */
  private siphonTarget(u: SimUnit, code: string, lvl: AbilityLevel, friends: SimUnit[], foes: SimUnit[]): SimUnit | null {
    const ok = (t: SimUnit): boolean =>
      near(u, t, lvl.castRange) && this.view.world.castError(u.id, code, t.id) === null && !this.view.refuses?.(u, code, t);
    if (dat(lvl, 4, 0) > 0 && u.mana >= u.maxMana * SIPHON_FEED_KEEP) {
      let best: SimUnit | null = null;
      let bestScore = 0;
      for (const t of friends) {
        if (t === u || !t.isHero || t.isIllusion || t.maxMana <= 0) continue;
        if (t.mana >= t.maxMana * SIPHON_FEED_BELOW) continue;
        const healer = t.abilities.some((ab) => ab.level > 0 && SIPHON_HEALS.has(this.view.def(ab.id)?.code ?? ""));
        const score = (t.maxMana - t.mana) * (healer ? SIPHON_HEALER : 1);
        if (score > bestScore && ok(t)) { bestScore = score; best = t; }
      }
      if (best) return best;
    }
    const take = dat(lvl, 1, 0);
    if (take <= 0 || u.mana > u.maxMana - take * 2) return null;
    let best: SimUnit | null = null;
    let bestScore = 0;
    for (const t of foes) {
      if (t.building || t.isPeon || t.mana < SIPHON_DRAIN_MIN) continue;
      const score = Math.min(t.mana, take * Math.max(1, lvl.duration)) * (t.isHero ? SIPHON_HERO : 1);
      if (score > bestScore && ok(t)) { bestScore = score; best = t; }
    }
    return best;
  }

  /** Did this click go astray? Drawn off the AI's own stream, so a match replays identically. */
  private mistake(): boolean {
    return this.profile.castMistake > 0 && this.roll() < this.profile.castMistake;
  }

  /**
   * IS THERE ENOUGH LEFT IN THIS BAR TO BE WORTH BURNING?
   *
   * Mana Burn's own legality is the sim's and it is already narrow — `TARGET_RULES` (sim/targetRules.ts)
   * refuses any target with no mana POOL, which is the game's own
   * `Cantmanaburn` and the reason a Demon Hunter may not pick a Footman at all. What the data
   * cannot say is that a pool with nothing in it is legal and useless: a drained Sorceress is
   * still a caster, and 60 mana spent taking 4 off her is the cast that makes an AI look like
   * it is pressing buttons for the sake of it.
   *
   * The bar is READ OFF THE TARGET rather than picked: keep burning while it can still afford
   * one of its OWN buttons, and stop when it cannot. That is what the spell is for — a hero
   * below its cheapest spell is out of the fight's magic already — and it needs no constant of
   * ours, since the price is `Cost1` on the row of whatever the target is carrying. Items are
   * not in it: an item ability is paid for in CHARGES and out of the item's own row, so a
   * Scroll of Healing is not something a burn can take away (docs/items.md).
   *
   * Worth noting for anyone reading this beside `nukeWorthIt`, which sits one gate away: the
   * WORKER rule can never fire here. No worker in the melee game has a mana bar at all —
   * `UnitBalance.slk` gives `hpea`, `opeo`, `uaco` and `ewsp` no `mana0` — so the Demon Hunter
   * could not pick one if it wanted to.
   */
  private manaBurnWorthIt(t: SimUnit, lvl: AbilityLevel): boolean {
    let cheapest = Infinity;
    for (const ab of t.abilities) {
      if (ab.level < 1) continue;
      const def = this.view.def(ab.id);
      if (!def || def.target === "passive") continue;
      const l = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (l && l.cost > 0) cheapest = Math.min(cheapest, l.cost);
    }
    return t.mana >= (Number.isFinite(cheapest) ? cheapest : dat(lvl, 0, 50) * MANA_BURN_SLIVER);
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
  private value(t: SimUnit, role: Role, lvl?: AbilityLevel, code?: string): number {
    return spellValue(t, role, this.aim0, lvl ? spellFacts(lvl.duration, lvl.heroDuration, code) : undefined);
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
      // A SUMMON'S `Area1` IS NOT AN AREA OF EFFECT — it is where the summoned body is PUT.
      //
      // This is the whole of the reported "the Computer+ Archmage never casts Water Elemental,
      // in fights or while creeping". `[AHwe] Area1` is 200 (and `[AOsf]` Feral Spirit, `[AHpx]`
      // Phoenix and `[AEsv]` Vengeance all carry the same 200; `[AUcb]` Carrion Beetles 900),
      // which is the radius the summon appears in around its caster — nothing is caught by it
      // and nobody has to be standing in it. Read as a catchment it became a QUORUM: two enemy
      // bodies within 200 units of the hero, which for a 600-range caster standing behind its
      // own army is a thing that essentially never happens, so the button was never pressed.
      //
      // The condition a summon actually has is the one `wants` already asks, and it is the
      // classic caster's rule from the same observation thread — *"~Water Elemental - Casts when
      // caster or nearby allies are engaging enemies"* (src/ai/casting.ts, `AHwe: engaged`).
      // There is a fight; press it. Note src/ai/casting.ts does not have this bug: its `need`
      // is 0 for anything that is not a `cluster` rule, so only this file's `quorum` reached it.
      if (!area || role === "summon") return { x: u.x, y: u.y }; // a bare press — nothing to aim
      const hits = this.catchment(u, u.x, u.y, def, lvl, role, pool, friendly);
      return hits.count >= need ? { x: u.x, y: u.y } : null;
    }

    // FORCE OF NATURE IS AIMED AT TREES — the one point spell whose target is not a body.
    //
    // `[AEfn] targs1` is **"tree"** and nothing else: `Rng1` 800 to a spot, `Area1` 150/225/300
    // around it, `DataA` 2/3/4 trees FELLED there and one Treant standing in each hole (the
    // sim's own shape — `SimWorld.fellTrees`, called by the `AEfn` handler in sim/spells.ts).
    // Aimed like an area nuke it was pointed at a clump of ENEMIES, which is a spot with trees
    // in it only by luck: 100 mana and a 20-second cooldown spent felling nothing at all.
    //
    // So the aim is the treeline, and "which treeline" is the fight — a Keeper of the Grove
    // pulls his Treants up where they can reach somebody, not out of the forest behind him.
    // Trees first (there is no cast without them), the nearest one to the enemy second.
    if (role === "summon" && treeAim(def)) return this.treeSpot(u, code, lvl, foes, quorum);

    const wave = NO_AOE_CURSOR.has(def.code);
    const reach = wave ? waveDistance(def, lvl) : lvl.castRange;
    const legal: Array<{ x: number; y: number }> = [];
    let best: { x: number; y: number } | null = null;
    let bestValue = 0;
    const watched = def.code === SENTRY_WARD ? this.wardsWatching(def, lvl) : null;
    for (const t of pool) {
      if (!near(u, t, reach)) continue;
      if (watched && watched.some((w) => Math.hypot(t.x - w.x, t.y - w.y) < w.r)) continue;
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

  /**
   * Force of Nature's aim, at this difficulty.
   *
   * The search itself is shared with the classic caster (`treeSpots` in ../casting.ts) because
   * the ability's shape is the same for both — it is a treeline or it is nothing. What belongs
   * to Computer+ is the two dials it puts on top: the QUORUM (an easy computer presses it on a
   * single trunk, a better one wants a clump — but never more than the rank can actually fell,
   * `DataA` 2/3/4, or a level-1 Keeper would be held to a bar its own ability cannot reach),
   * and the misclick every other spot in this file can make.
   */
  private treeSpot(
    u: SimUnit, code: string, lvl: AbilityLevel, foes: SimUnit[], quorum: number,
  ): { x: number; y: number } | null {
    // `DataA` "Trees Consumed" — how many Treants this rank raises.
    const fells = Math.max(1, Math.round(lvl.data[0] || 2));
    const legal = treeSpots(this.view, u, code, lvl, foes, Math.min(fells, quorum));
    if (!legal.length) return null;
    if (legal.length > 1 && this.mistake()) {
      return legal[Math.min(legal.length - 1, Math.floor(this.roll() * legal.length))] ?? legal[0];
    }
    return legal[0];
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
      // EDGE TO EDGE where the row states a circle, which is how the sim measures one
      // (`unitsInAreaInternal`: a body is in once its HULL is). Centre to centre it undercounted
      // every circle by a body's width — a War Stomp's 250 round a Tauren Chieftain read the
      // two Grunts swinging at him from the far side as out of it, and the stomp waited for a
      // crowd (`ANY_FIGHT`).
      if (Math.hypot(t.x - x, t.y - y) - (lvl.area > 0 ? t.radius : 0) > area) continue;
      // A DISPEL IS BLIND — `Adis` clears (and DAMAGES the summons of) every unit in its circle,
      // ours included. So a spot that would take out one of our own summons is not a spot: the
      // Water Elemental we paid for is worth more than a buff taken off a Grunt. Vetoed here
      // rather than in `counts`, which can only leave a body out of the tally.
      if (dispel && t.isSummon && !this.view.hostile(t)) return { count: 0, value: 0 };
      if (!this.counts(u, t, def, role, friendly)) continue;
      count++;
      value += this.value(t, role, lvl);
    }
    return { count, value };
  }

  /** …and who a wave aimed through `at` would sweep — the corridor as long and as wide as the
   *  wave itself, which is not the same pair of columns for every family (`waveDistance` /
   *  `waveHalfWidth`; mirrors `lineTargets` in sim/spells.ts). */
  private corridor(
    u: SimUnit, at: SimUnit, def: AbilityDef, lvl: AbilityLevel, role: Role,
    pool: SimUnit[], friendly: boolean,
  ): { count: number; value: number } {
    const dist = waveDistance(def, lvl);
    const half = waveHalfWidth(def, lvl);
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
      // A body Drunken Haze has soaked IGNITES under the breath — see `DRUNKEN_HAZE`.
      value += this.value(t, role, lvl) * (def.code === BREATH_OF_FIRE && soaked(t) ? SOAKED_WORTH : 1);
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
  /**
   * WHERE OUR SENTRY WARDS ALREADY SEE — the ground a new one must not be planted on.
   *
   * Reported: the Computer+ Witch Doctor plants its Sentry Wards "very close to each other".
   * The aim is the enemy it is fighting (a `summon` aimed like any point spell), so every ward
   * of a fight went down on the same few bodies, one on top of the last. A ward is worth what
   * it REVEALS, and a second one inside the first one's sight circle reveals next to nothing:
   * so each standing ward of ours rules out its own sight radius (`sightDay`/`sightNight`, the
   * smaller of the two — the ground it sees at every hour; `[oeye]` is 1600 both). A ward
   * still being CAST — ours, the same code, the point already chosen — rules its point out
   * too, or two Witch Doctors in one pass pick the same spot; its radius is a standing ward's
   * if there is one, and otherwise the ability's own `Rng1`, which is a stand-in of OURS for a
   * body that does not exist yet.
   */
  private wardsWatching(def: AbilityDef, lvl: AbilityLevel): Array<{ x: number; y: number; r: number }> {
    const type = lvl.summon || def.levelData[0]?.summon || "";
    const out: Array<{ x: number; y: number; r: number }> = [];
    const pending: Array<{ x: number; y: number }> = [];
    let sight = 0;
    for (const o of this.view.world.units.values()) {
      if (o.hp <= 0 || o.owner !== this.view.player) continue;
      if (type && o.typeId === type) {
        const r = Math.min(o.sightDay, o.sightNight);
        sight = Math.max(sight, r);
        out.push({ x: o.x, y: o.y, r });
      }
      const pc = o.pendingCast;
      if (pc && pc.code === def.code && !pc.fired) pending.push({ x: pc.x, y: pc.y });
    }
    for (const p of pending) out.push({ ...p, r: sight || lvl.castRange });
    return out;
  }

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
  const F = targetFlagSet(def.targetFlags);
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
  const F = targetFlagSet(def.targetFlags);
  if (lvl.summon || def.levelData.some((l) => !!l.summon)) return "summon";
  if (F.has("dead")) return "heal";
  const friendly = friendlySpell(def);
  if (friendly) return lvl.duration > 0 ? "buff" : "heal";
  if (def.target === "unit") return lvl.duration > 0 ? "disable" : "nuke";
  if (def.target === "point") return lvl.area > 0 ? "nuke" : null;
  return lvl.area > 0 ? "nuke" : "buff"; // no target at all
}
