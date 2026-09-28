import type { AbilityDef } from "../../data/abilities";
import type { ItemDef } from "../../data/items";
import type { PlayableRace } from "../../data/races";
import { ITEM_REGEN_GROUP, type SimUnit } from "../../sim/world";
import { isOrbCode } from "../../sim/orbs";
import { near, type CasterView } from "../casting";
import type { PlusProfile } from "./profile";

// Computer+ — buying items, and pressing them (issue #124, issue #130).
//
// The hole docs/computer-plus.md used to describe as "Items: not yet". Nothing in `src/ai/`
// bought from a shop or drank anything: a Computer+ hero picked up what it walked over and
// carried it to the grave. This is the AI's half, and it is deliberately built on exactly the
// doors a player's click goes through — there is no item path here that a human does not have.
//
// Four facts about items shape the whole file, and the first three are docs/items.md's:
//
//   1. **An item's behaviour is not in the item.** It is an ability id in the item's `abilList`,
//      and that row has the same fields a hero spell's does. So `USE_OF` below is keyed on the
//      ABILITY code, never on the item id — which is also why one entry covers a Potion of
//      Healing bought at a Vault and the same potion picked up off a dead ogre.
//   2. **Item abilities are not in `SimUnit.abilities`.** They hang off the inventory slot and
//      dispatch through `useItem`, which is why plus/casting.ts cannot see them and why this is
//      a second walk rather than more rows in the caster's table. (That is the first of the two
//      gates the doc told us to check before writing any of this.)
//   3. **Who an effect reaches comes off its own row**, not off the item's name — a Scroll of
//      Regeneration is an AREA, a Healing Salve is a UNIT and a Clarity Potion is the drinker,
//      all three healing and all three aimed differently. So aiming here is not a table at all:
//      it is the ability's own `target`, read exactly as `RtsController.useInventorySlot` reads
//      it to decide whether your click needs a second one.
//   4. **"Friendly" means OUR SIDE, not our units.** Every beneficial row in the game says
//      `friend` in its `targs1` — the Healing Salve, the Scroll of Regeneration, the Scroll of
//      Healing, the Scroll of Protection, the Scroll of the Beast — and the sim answers that
//      flag with `hostile`, not with `owner` (`targetAllowed`, `itemAreaTargets`), so an
//      ALLY'S units have always been inside the circle a scroll draws and have always been a
//      legal target for the salve. The only thing that ever excluded them was this file's own
//      candidate list. So there are two pools here and they are different questions: `own` is
//      who this player gives ORDERS to (whose belt may be pressed, who may walk to a shop),
//      and `friends` is who a press may LAND on. plus/casting.ts draws exactly the same line
//      for the same reason — see `CasterView.allied`.
//
// The other gate the doc named is the money, and `PlusProfile.itemReserve` is the answer: item
// gold is gold `OneBuildLoop` was going to spend, so the shop only ever sees the surplus above
// a floor the build order keeps. See that field for why a floor rather than a rung.
//
// **None of the numbers here are Warcraft III's.** Nothing in the install describes an AI that
// shops. What IS the game's is the stock: `[ngme] Sellitems=stwp,bspd,dust,tret,prvt,cnob,stel,
// pnvl,shea,spro,pinv` (Units\NeutralUnitFunc.txt) is the Goblin Merchant's shelf, and the four
// race shops' `Makeitems` are theirs — every id in `LIST` was read off those rows.

/**
 * What an item is FOR.
 *
 * A much smaller vocabulary than the caster's `Role`, because the item side of the game is
 * small and closed: these are the codes that appear in `abilList` on the things a melee hero
 * actually carries. The order below is the PRIORITY order — the ladder a hero presses down,
 * highest first, one button per pass — and it reads the way a player's hands do: get out, don't
 * die, top up, then everything else.
 */
export type Use = "escape" | "panic" | "healSelf" | "healArea" | "healOther" | "mana" | "replenish" | "manaRegen" | "raise" | "illusion" | "buff";

const LADDER: readonly Use[] = ["escape", "panic", "healSelf", "healArea", "healOther", "mana", "replenish", "manaRegen", "raise", "illusion", "buff"];
const useRank = (u: Use): number => LADDER.indexOf(u);

/**
 * Ability CODE → what pressing it is for.
 *
 * **The key is the base `code`, never the alias**, and getting that wrong is a whole-feature
 * bug rather than a typo. `AbilityData.slk` gives every row an `alias` and a `code`, and for
 * most of the potions they are DIFFERENT: the Potion of Healing is alias `AIh1` on code `AIhe`,
 * the Potion of Mana `AIm1` on `AIma`, the Potion of Lesser Invulnerability `AIvl` on `AIvu`,
 * and every regeneration item — Healing Salve, Clarity Potion, Scroll of Regeneration, the
 * Replenishment family — is an alias of the ONE code `AIrg`. `useOf` looks a card up by
 * `AbilityDef.code`, which is what `SimWorld.applyItemAbility` dispatches on, so a table keyed
 * on aliases matches nothing: an AI that bought a Healing Salve, a Potion of Healing, a Potion
 * of Mana and a Clarity Potion could press none of the four, and the whole belt came down to
 * the four rows below whose alias and code happen to coincide.
 *
 * Two families are deliberately absent. **The runes** (`APh1`, `APmr`, …) are `powerup` items —
 * consumed on pickup, never stored — so there is no button to press. And **Kelen's Dagger of
 * Escape** (`AIbk`) is a point-target blink, which needs a decision about WHERE that none of
 * the aiming below makes; a blink aimed like a Town Portal would fire off the end of its own
 * range. It is a drop, never shop stock, so it waits.
 */
const USE_OF: Readonly<Record<string, Use>> = {
  // --- get out -----------------------------------------------------------------------------
  // Scroll of Town Portal. The one item that changes how a lost fight ends: it takes the party
  // standing around the hero (`Area1`) with it, so it saves the army and not just the hero.
  AItp: "escape",

  // --- don't die ---------------------------------------------------------------------------
  AIvu: "panic", // Potion of Invulnerability — and `AIvl`, the Lesser one the Merchant stocks
  AHds: "panic", // Potion of Divinity (`AIdv`) — it IS the Paladin's Divine Shield row

  // --- hit points, on the drinker ----------------------------------------------------------
  AIhe: "healSelf", // Potion of Healing / of Greater Healing / Health Stone / Essence of Aszune
  AIre: "healSelf", // Potion of Restoration

  // --- hit points, on an AREA around the user ----------------------------------------------
  AIha: "healArea", // Scroll of Healing (and the three Runes of Healing)
  AIra: "healArea", // Scroll of Restoration (and its Rune)

  // --- mana ---------------------------------------------------------------------------------
  AIma: "mana", // Potion of Mana / of Greater Mana / Mana Stone
  AImr: "mana", // Scroll of Mana (and the two Runes of Mana)

  // `AIrg` is NOT here: one code, four different answers. See `regenUse`.

  // --- more bodies --------------------------------------------------------------------------
  // ROD OF NECROMANCY (`rnec`, four charges, 150 gold, the Tomb of Relics' first shelf). It is
  // not item behaviour at all: `[AIrd] code = AIrd` but the whole `Rai1..Rai4` group with it, so
  // `SimWorld.useItem` runs RAISE DEAD's own handler with the item's numbers — two Skeleton
  // Warriors (`uske`) out of ONE body within `Rng1` = 600, for `Dur1` = 65 seconds instead of
  // the Necromancer's 45 (docs/items.md; sim/corpses.ts `CORPSE_SPAWNERS`).
  //
  // It sits on the ladder beside the Wand of Illusion because what it buys is the same thing —
  // bodies in the line that nobody paid food for — and ABOVE it because these ones actually
  // swing: an illusion deals no damage (docs/illusions.md) and a Skeleton Warrior is a real
  // 180-hit-point unit. Below `mana`, though: a hero with an empty bar has lost the spells the
  // fight is being won with, and that is worth more than two skeletons.
  //
  // No "is there a corpse" test is needed here or in `wants`: `itemUseError` asks
  // `corpseRefusal` — the same query the handler will take its body from, at the same radius —
  // so a rod waved over bare ground is refused at the door and keeps its charge.
  AIrd: "raise",

  // Wand of Illusion (`will`, three charges). It is on this ladder ABOVE the scrolls because
  // what it buys is not a percentage: an illusion is another body in the line, it is what the
  // camp swings at instead of the hero, and it hurts nothing — so the whole of its value is
  // being in front of the party when the blows start landing. `targs1` is "ground,air,friend,
  // self", so it is aimed at one of OURS (see `toCopy`), and the copy arrives at full hit
  // points however hurt the original is (docs/illusions.md `initIllusion`).
  AIil: "illusion",

  // --- make the fight better ----------------------------------------------------------------
  AIda: "buff", // Scroll of Protection
  AIsa: "buff", // Scroll of Speed
  AIsp: "buff", // Potion of Speed
  Aroa: "buff", // Scroll of the Beast (`AIrr`) — it IS Roar
};

/** The one code that is four different items — see `regenUse`. */
const REGEN = "AIrg";

/** The mana items whose bar moves AT THE PRESS — `SimWorld.useItem` sends both of them to
 *  `itemRestore(u, ad, -1, 0)`, so what they are worth is their `DataA`. The pouring kind is
 *  `REGEN` and its mana is `DataB`. Only `manaRoom` reads either column, and the two are listed
 *  apart because they live in different ones. */
const MANA_INSTANT = new Set<string>(["AIma", "AImr"]);

/**
 * `AIrg` — one code, four different items, and the row itself is what says which.
 *
 * This is docs/items.md's own example of why an item's behaviour cannot be read off its code
 * alone, and `SimWorld.applyItemAbility` already splits them exactly this way when the button is
 * pressed. This is the same split asked one step earlier: what is this item FOR.
 *
 *     alias   item                        row                        reaches
 *     AIsl    Scroll of Regeneration      Area1 600                  the AREA      -> healArea
 *     AIp5/6  Scroll of Replenishment     Area1 600                  the AREA      -> healArea
 *     AIrl    Healing Salve               Rng1 500, no Area1         a UNIT        -> healOther
 *     AIpr    Clarity Potion              neither, DataB mana only   the drinker   -> manaRegen
 *     AIp1-4  Replenishment Potion        neither, DataA hp AND DataB mana         -> replenish
 *
 * The last two are told apart by which column the row FILLS — a Clarity Potion is 200 mana and
 * no hit points, a Replenishment Potion is both — because "what is it for" is the question the
 * ladder sorts on, and a mana item pressed as a heal is pressed at the wrong moment.
 *
 * **A REPLENISHMENT POTION IS BOTH, AND THAT IS ITS OWN RUNG.** It used to answer `healSelf`,
 * on the strength of its hit-point column alone, and that is the one answer that can never be
 * right for it: `healSelf` is the INSTANT potion's rung and is therefore gated on `engaged` —
 * so the AI drank a POUR (`AIrg`, cancelled by the next blow) at precisely the moment the next
 * blow was coming, and never drank it at any other. Its own Ubertip is the whole argument:
 * *"|cff87ceebNon-Combat Consumable|r … Regenerates <AIp1,DataA1> hit points and
 * <AIp1,DataB1> mana of the Hero over <AIp1,Dur1> seconds"* — the game itself calls it
 * non-combat, and it names the two bars in one sentence. See the `replenish` rung in `wants`.
 *
 * **A CLARITY POTION IS NOT A POTION OF MANA**, and it answers `manaRegen` rather than `mana`
 * for the one reason that decides when it may be drunk at all: it pours. `applyItemAbility`'s
 * `AIrg` branch hangs its mana as a `manaRegen` BUFF in `ITEM_REGEN_GROUP:mana` over the row's
 * own `Dur1`, and `breakItemRegen` strips that group on **any** damage the drinker takes — the
 * real game's own rule, and the same one that already holds the Healing Salve and the Scroll of
 * Regeneration out of fights. A Potion of Mana (`AIma`) is `itemRestore`: the bar moves at the
 * press and nothing can take it back. Two items, two very different moments, and one `Use` for
 * them made the eager one unreachable — the fight gate written for the instant potion is
 * precisely the state in which the pouring one is thrown away.
 *
 * A blank SLK column parses to NaN, which fails `> 0` — so a row that fills neither says nothing
 * and is left alone rather than guessed at.
 */
function regenUse(ad: AbilityDef): Use | null {
  const lvl = ad.levelData[0];
  if (!lvl) return null;
  if (lvl.area > 0) return "healArea";
  if (lvl.castRange > 0) return "healOther";
  const hp = lvl.data[0];
  const mana = lvl.data[1];
  if (hp > 0 && mana > 0) return "replenish"; // both bars: the Replenishment Potion
  return hp > 0 ? "healSelf" : mana > 0 ? "manaRegen" : null;
}

/** One row of the shopping list: what to buy, and how many of it to carry. */
interface Want {
  readonly id: string;
  readonly want: number;
  /**
   * Is this row part of the OPENING — one of the race's own first buys (`RACE_FIRST`)?
   *
   * It changes only one thing, and it is the money. Everything else on the list is bought out
   * of the surplus above `PlusProfile.itemReserve`, which is the build order's gold; an opening
   * row is bought out of the purse. That is not a loophole, it is what the reserve is for read
   * honestly: a floor of 300 gold on a Normal computer means it never shops at all — measured
   * on Echo Isles, a Normal orc's gold sat between 2 and 162 for the whole match while it paid
   * for peons and Grunts, so `gold − 300` was never once positive at the moment the five-second
   * shopping pass looked. The Healing Salve it is supposed to open with is ONE HUNDRED GOLD and
   * the Voodoo Lounge that sells it cost 130: an AI that will build the shop but never has the
   * hundred spare to buy from it has spent the 130 on nothing. A player buys the salves out of
   * the same pocket the build order comes from, because at that price it is part of the build
   * order.
   */
  readonly opening?: boolean;
}

/**
 * The shopping list, in preference order — the standard ladder one, over items the game
 * actually sells.
 *
 * It belongs here beside the strategy rather than in `PlusProfile` for the reason the expansion
 * clock does (docs/computer-plus.md): WHAT to buy is not a difficulty, it is what a melee player
 * buys. The difficulty decides how MUCH of it (`shopping`), how much gold it will part with
 * (`itemReserve`) and whether it plans around a Town Portal (`keepPortal`).
 *
 * Every id is off the real shop rows:
 *   • Goblin Merchant `[ngme] Sellitems` — stwp, bspd, dust, tret, prvt, cnob, stel, pnvl,
 *     shea, spro, pinv
 *   • Arcane Vault `[hvlt]` — sreg, mcri, plcl, phea, pman, stwp, tsct, ofir, ssan
 *   • Voodoo Lounge `[ovln]` — shas, hslv, plcl, phea, pman, stwp, tgrh, oli2
 *   • Ancient of Wonders `[eden]` — moon, plcl, dust, phea, pman, stwp, spre, oven, pams
 *   • Tomb of Relics `[utom]` — rnec, dust, skul, phea, pman, stwp, ocor, shea
 *
 * Note the near-homographs, which are a standing trap in this data: `pinv` is Potion of
 * *Invisibility*, `pnvu` Potion of Invulnerability, and `pnvl` the *Lesser* one that is what the
 * Merchant actually stocks. Only `pnvl` is bought here, because only `pnvl` is on a shelf.
 */
const LIST: readonly Want[] = [
  // Two healing potions before anything else: it is the item that wins the most fights, every
  // race shop has it, and at 150 it is the cheapest thing on this list that does.
  //
  // Out of the PURSE (`opening`) and past the habit ceiling (`ESSENTIAL`), for the Town Portal's
  // reason: a hero that fights without one is a hero that dies. Measured on Echo Isles before
  // this, a Normal orc played twelve minutes and never bought one — its gold was almost never
  // 300 + 150 at the moment the shopping pass looked, and by the time `[phea] stockStart` (440 s)
  // had put the potion on the shelf its hero's belt was four creep drops deep, which is
  // `shopping`'s whole ceiling on Normal. The shelf's own clock is still the only wait: before
  // 7:20 `shopStock` answers 0 and the row is skipped, exactly as a player's click would be.
  { id: "phea", want: 2, opening: true },
  // The area heal. The Merchant's and the Tomb's; the reason a Computer+ push does not
  // evaporate the moment it is behind on the trade.
  { id: "shea", want: 1 },
  // The cheap AREA heals, and they are high on the list on purpose: this is what puts an army
  // back together between creep camps, which is where a Computer+ hero spends its early game.
  // A Healing Salve is 100 gold for three charges and the Scroll of Regeneration 100 for a
  // whole group — the best hit points per gold in the game, and the reason a creeping computer
  // does not have to walk home after every camp.
  { id: "hslv", want: 2 }, // Healing Salve (Voodoo Lounge) — three charges, aimed at a unit
  { id: "sreg", want: 1 }, // Scroll of Regeneration (Arcane Vault) — the area version
  // Mana, in descending order of what it costs to keep a caster hero casting.
  { id: "pman", want: 1 }, // Potion of Mana
  { id: "pclr", want: 1 }, // Clarity Potion
  { id: "plcl", want: 1 }, // Lesser Clarity Potion — 70 gold, on three of the four race shops
  // The hero it expects to lose drinks this instead of dying.
  { id: "pnvl", want: 1 }, // Potion of Lesser Invulnerability (Merchant)
  // BOOTS OF SPEED — the one PERMANENT item on this list, and the one thing a melee player
  // walks to a Goblin Merchant for without thinking about it.
  //
  // It is not pressed and never will be: `[bspd]` is not `usable`, so `useOf` answers null and
  // `press` skips the slot forever. Its whole value is being CARRIED — the movement its row
  // grants, for the rest of the match — which is exactly why it suits this AI: a Computer+ hero
  // creeps, walks between camps and runs home from lost fights, and all three are faster for
  // 250 gold with no decision to make afterwards. It sits below the consumables because a potion
  // wins the fight in front of you and boots win the next one, which is the order a player buys
  // them in too.
  { id: "bspd", want: 1 }, // Boots of Speed (Merchant)
  { id: "spro", want: 1 }, // Scroll of Protection (Merchant)
];

/**
 * …and what it buys once the gold is demonstrably NOT going into the build order.
 *
 * `itemReserve` is a floor, and a floor answers "may I spend at all"; it says nothing about a
 * computer sitting on twelve hundred gold because its production is capped (`armyFood`) or its
 * tech is finished. That is the state a player empties the shop in, and it is the state this AI
 * was most obviously wrong in: banked gold, a Goblin Merchant across the clearing, and a hero
 * carrying one Potion of Healing because `shopping` said three slots and the general list had
 * already filled them.
 *
 * So being RICH does two things and only two (see `shop`): it opens these extra rows, and it
 * lifts the belt ceiling to the six slots a hero actually has. Nothing here is a new KIND of
 * item — the ids are the same shelves — it is the same shopping list, wanted deeper.
 *
 * The Town Portal is not repeated here. `keepPortal` already puts it at the head of the list on
 * both difficulties that shop at all, and `carried` counts across every hero, so "buy one when
 * we have not got one" is the row that is already there and is already first.
 */
const RICH: readonly Want[] = [
  { id: "shea", want: 2 }, // a second Scroll of Healing — the Merchant's, 250
  { id: "phea", want: 3 },
  { id: "pnvl", want: 2 },
  { id: "spro", want: 2 },
];

/**
 * …and what a RACE buys with that surplus, on top of `RICH`.
 *
 * **UNDEAD — mana.** The one race whose army is mana, and the developer's own reading of it:
 * *"undead is a very mana-hungry race"*. The data agrees from every direction — a Necromancer
 * pays for each Raise Dead and each Cripple, a Banshee for every Curse and Anti-magic Shell, an
 * Obsidian Statue's Spirit Touch is a mana bar being spent on other people's mana bars, and the
 * Death Knight's Death Coil is the race's heal. `[utom] Makeitems` stocks `pman`, so a rich
 * undead computer's answer to "what do I do with this gold" is a belt of Potions of Mana. Three
 * of them: half a hero's inventory, and about what one long fight's worth of casting costs.
 *
 * The other three races have no equivalent — their surplus goes into the general `RICH` rows,
 * which is what a human does with it — so they stay unlisted rather than being given a habit.
 */
const RACE_SURPLUS: Partial<Record<PlayableRace, readonly Want[]>> = {
  undead: [{ id: "pman", want: 3 }],
};

/**
 * What a RACE reaches for before anything else on that list.
 *
 * `LIST` is what a melee player buys; this is what a melee player buys *playing this race*, and
 * it goes in front of everything — the Town Portal included — because a habit that only ever
 * gets its turn once the general list is satisfied is a habit the belt never has room for.
 * `PlusProfile.shopping` is only three slots on Normal, so a row three places down the ladder
 * is a row that is never bought at all: an orc computer's belt was stwp + two Potions of
 * Healing, every game, and the Healing Salve two lines further down was never once reached.
 *
 * **ORC — the Healing Salve.** `[ovln]` (the Voodoo Lounge) is the one race shop that stocks
 * `hslv`, it is 100 gold for THREE charges — the best hit points per gold in the game — and it
 * is aimed at somebody ELSE (`Rng1` 500, no `Area1`, so it is a `healOther`; docs/items.md).
 * That last part is why it is the orc's first buy and not merely a cheap potion: it is the item
 * that puts the ARMY back together between creep camps rather than the hero, which is exactly
 * what an orc's early game is made of. Two of them, so there is one left after the first camp.
 *
 * **HUMAN — the Scroll of Regeneration.** The same job, done the human way: `[hvlt] Makeitems`
 * opens with `sreg`, it is the first thing on the Arcane Vault's shelf, and it is the AREA
 * version of the same 100 gold — `[AIsl] Area1` 600, 225 hit points poured over 45 seconds
 * (`Dur1`) into everything standing in the circle. So where the orc's captain heals the ONE
 * unit that came out worst, the human's heals the whole party at once, which is why `wants`
 * asks a different question of it: not "is somebody hurt" but "is the ARMY hurt, and is the
 * army actually STANDING here" (see the `healArea` rung).
 *
 * **UNDEAD — the Rod of Necromancy.** `[utom] Makeitems` opens with `rnec` exactly as the
 * Vault's opens with `sreg`, and it is the same kind of row for the same reason: the one item on
 * that shelf that changes how the early game goes. 150 gold buys FOUR charges of Raise Dead
 * (`[rnec] uses` = 4), and each one is two Skeleton Warriors out of a body the fight has already
 * made — so a creeping Crypt Lord or Death Knight walks out of every camp with an escort it paid
 * no food for, which is the whole of "help it creep". It is bought out of the purse rather than
 * out of the surplus (`Want.opening`) for the reason the orc's salves are: at 150 gold it is
 * part of the build order, not spare change, and a Tomb of Relics that is built and never bought
 * from is 215 gold spent on nothing.
 *
 * Its `[rnec] stockStart` is 0 against a `stockRegen` of 60, so the shelf is empty for the first
 * minute of the match whatever the AI wants — `pick` asks `shopStock` and simply waits, which is
 * the same wait a player has.
 *
 * The night elf has no equivalent first buy — the Ancient of Wonders opens on the potions `LIST`
 * already starts with — so it stays unlisted rather than being given an invented habit.
 */
const RACE_FIRST: Partial<Record<PlayableRace, readonly Want[]>> = {
  orc: [{ id: "hslv", want: 2 }],
  human: [{ id: "sreg", want: 2 }],
  undead: [{ id: "rnec", want: 1 }],
};

/**
 * …and the MANA the race can actually get, which is not the same item for all four.
 *
 * Reported: the computers must *"be more eager/keen towards using Clarity Potions to constantly
 * restore their heroes mana (all races)"*, and *"Undead should also buy and use mana potions
 * (unlocked at tier 2) and use them if their heroes mana is low (since they don't have clarity
 * potions in their shops)."* Both halves of that are in the data rather than in a preference,
 * and the second is exactly right:
 *
 *   • `[pclr] Requires = etoe` — the full Clarity Potion is gated on a **Tree of Eternity**, so
 *     for three of the four races it is a late-game item on somebody else's shelf.
 *   • `[plcl]` — the **Lesser** Clarity Potion — carries no requirement at all, is 70 gold, and
 *     is on three of the four race shelves: `[hvlt]`, `[ovln]` and `[eden]` all list it.
 *   • `[utom] Makeitems = rnec,dust,skul,phea,pman,stwp,ocor,shea` lists NEITHER. The undead's
 *     mana comes in a Potion of Mana, and `[pman] Requires = TWN2` is the tier-2 unlock the
 *     report names — enforced by the shop itself (`missingForShop`), so there is no clock here.
 *
 * Why it is a row of its own rather than a line in `LIST`: the general list is walked in order
 * and stops at the first row it can act on, and the belt is a habit that is only a few slots
 * deep (`PlusProfile.shopping`), so a mana potion five rows down is a mana potion no computer
 * ever buys. That is the same argument `RACE_FIRST` makes, and this sits just behind it for the
 * same reason — a hero whose bar is empty has lost the spells the fight is being won with, which
 * is worth more than the second Potion of Healing it was buying instead. Behind the SCROLL too
 * (see `list`): an empty bar loses a fight, no Town Portal loses the army.
 *
 * Bought out of the PURSE (`Want.opening`) rather than out of the surplus above `itemReserve`,
 * again for `RACE_FIRST`'s own reason: at 70 and 200 gold these are part of the build order, not
 * spare change, and a Normal computer's gold is almost never 300 above anything.
 *
 * ONE of each, deliberately. This is the habit — a hero that tops up between fights — and not a
 * stockpile; a rich undead's answer to a banked purse is already three more of them
 * (`RACE_SURPLUS`), which is where a belt full of mana belongs.
 */
const RACE_MANA: Partial<Record<PlayableRace, readonly Want[]>> = {
  human: [{ id: "plcl", want: 1 }],
  orc: [{ id: "plcl", want: 1 }],
  nightelf: [{ id: "plcl", want: 1 }],
  undead: [{ id: "pman", want: 1 }],
};

/** The buys `PlusProfile.shopping` does not cap: the Town Portal (see `shop`), the Potion of
 *  Healing (see `LIST`) and the two FIGHT items (`FIGHT`). A free SLOT is still required —
 *  `shopper` asks for one. */
const ESSENTIAL: ReadonlySet<string> = new Set(["stwp", "phea", "shea", "pnvl"]);

/**
 * The two items that decide a fight rather than the walk between two: the Scroll of Healing (the
 * army's burst heal) and the Potion of Lesser Invulnerability (the hero that would have died does
 * not). Both are on the Goblin Merchant's shelf (`[ngme] Sellitems`; the scroll is also the
 * undead's, `[utom] Makeitems`), and both come into stock at 7:20 (`stockStart` 440, the same
 * clock as the Potion of Healing and the Town Portal).
 *
 * Reported: a Normal computer NEVER bought either, and a 17-minute observed match agreed — two
 * reasons, both in this file. They sat below the Potion of Healing in `LIST`, so a Normal belt had
 * met `PlusProfile.shopping`'s four-slot habit ceiling (creep drops count) before the ladder got to
 * them; and they were paid out of the surplus above `itemReserve` — 550 and 450 in hand at the
 * instant the pass looked, a purse a Normal computer sees for seconds at a time. So they are
 * ESSENTIAL (past the ceiling), bought out of the PURSE (`opening`, the Town Portal's argument:
 * this is part of how the army fights, not shopping) and listed right behind the race's opening
 * buys, ahead of its mana.
 */
const FIGHT: readonly Want[] = [
  { id: "shea", want: 1, opening: true },
  { id: "pnvl", want: 1, opening: true },
];

/** Where the Town Portal sits in that list. `keepPortal` puts it FIRST — a player who plans
 *  around having one buys it before the potions, because the potions are no use if the army
 *  it would have saved is dead. Without the habit it is merely the last thing it gets round to. */
const PORTAL: Want = { id: "stwp", want: 1 };

/** The Scroll of Town Portal's ability, keyed on the ABILITY rather than on the item id for the
 *  same reason `USE_OF` is: a custom map's re-skinned scroll is still a Town Portal. */
const PORTAL_ABILITY = "AItp";

/** …and the Wand of Illusion's, for the same reason. `makeIllusions` is the one press the army
 *  manager reaches for by name (plus/index.ts), so it has to be able to find the wand. */
const ILLUSION_ABILITY = "AIil";

// --- when a button is pressed ---------------------------------------------------------------
// All ours; see the file header. Stated as fractions of a unit's own maximum so they mean the
// same thing on a Peasant and on a level-6 Tauren Chieftain.

/** Hit-point fraction at which the hero reaches for the thing that stops it dying. */
const PANIC_HP = 0.3;
/**
 * …and at which it LEAVES, which is a higher bar than the one at which it panics.
 *
 * Reported, from a real game: "the AI didn't use the scroll of town portal when its hero was
 * low health and was about to die and died."
 *
 * Be clear about what the risk actually is, because it is easy to get backwards. Once the
 * scroll is PRESSED the hero is invulnerable for the whole five seconds (docs/items.md) — it
 * cannot die mid-channel, and the channel is never a risk to take. **The only window in which
 * a hero holding a Town Portal can be killed is the window before it presses**, and the width
 * of that window is this AI's own reaction: the belt is walked once per `castPeriod`, which is
 * two seconds on Easy and one on Normal. A hero at 30 % with an army on it does not reliably
 * survive a second, so a threshold set AT the panic line is a threshold that is sometimes read
 * for the first time after the hero is already dead.
 *
 * 0.4 is where that margin lands, and it is not an arbitrary number: it is `HERO_KILL_HP`, the
 * same line plus/targeting.ts uses to decide a hero can be FINISHED. So the scroll comes out at
 * exactly the point the AI's own targeting would start treating this hero as a kill — which is
 * the point at which a competent opponent commits to it, and therefore the last moment at which
 * leaving is still cheap.
 */
const ESCAPE_HP = 0.4;
/**
 * …and the bar the scroll comes out at when what the hero is fighting is a CREEP CAMP: the
 * hero's LAST RESORT, and nothing above it.
 *
 * Reported: the AI "should never use its Scroll of Town Portal while fighting a creep camp".
 * The reason is the one `ItemCtx.portalWorthIt` already states for the army's half of this rung
 * — creeps do not chase, do not follow you home and will still be standing there in two minutes
 * — and a hero being worn down in one has two cheaper answers before the scroll: it is walked
 * out of the camp the way any other hurt unit is (`pullPass` in plus/index.ts, which gives a
 * hero in a creep fight the higher bar this used to be), and if the fight itself has gone the
 * party breaks off and walks home (`fightLost` → `retreat(b, "creeps")`). A scroll spent on a
 * camp is a scroll not in the belt for the fight that decides the game.
 *
 * What survives is the case neither of those answers reaches: a hero already so low that the
 * walk out is not going to finish. 8 % is the developer's own number, and it is a floor rather
 * than a tactic — at that share of its life a hero is one blow from dead whatever it is
 * fighting, and 320 gold is cheaper than a level-6 Blademaster.
 */
const LAST_RESORT_HP = 0.08;
/**
 * …and the band a hero drinks a HEALING POTION in (`healSelf`: Potion of Healing, of Greater
 * Healing, a Health Stone — every `AIhe`). Higher than `PANIC_HP`, because a hero that waits for
 * the panic line to drink has usually waited too long.
 *
 * A BAND and not a line, and the developer's own numbers: heroes carrying a potion "use it when
 * they are at around 45 to 60 percent health". Each hero is handed its own bar inside the band
 * (`drinkBar`) so two heroes in one fight do not drink on the same blow — which is what a
 * single threshold made them do, and what no player does.
 */
const HURT_HP_LOW = 0.45;
const HURT_HP_HIGH = 0.6;

/**
 * This hero's own drinking bar, somewhere in [`HURT_HP_LOW`, `HURT_HP_HIGH`].
 *
 * Off the unit's ID and nothing else: the AI runs on the authority and every client must be
 * able to reproduce it, so there is no `Math.random` in it — a Knuth multiplicative hash spreads
 * consecutive ids across the band. Fixed for the hero's life, so it is a temperament and not a
 * coin tossed every pass (which would simply drink at the top of the band, eventually).
 */
export function drinkBar(unitId: number): number {
  const spread = (Math.imul(unitId, 2654435761) >>> 0) / 0xffffffff;
  return HURT_HP_LOW + (HURT_HP_HIGH - HURT_HP_LOW) * spread;
}
/**
 * How hurt somebody else has to be to be worth a Healing Salve.
 *
 * Ours, like the rest of this block. Read one bar above `drinkBar` (the line a hero drinks its
 * own potion at) rather than below it, and for the same reason `ARMY_HURT` sits there: a salve
 * pours over forty-five seconds and is cancelled by the next blow (`ITEM_REGEN_GROUP`,
 * docs/items.md), so it is spent BETWEEN fights on a body that is going into the next one — not
 * as an emergency top-up on somebody about to die, which is what the potion is for. Waiting for
 * half health on a three-charge, hundred-gold item that regenerates rather than heals leaves
 * most of an army walking to the next camp hurt with the charges still in the belt.
 */
const ALLY_HP = 0.65;
/** How many of ours have to be hurt before an AREA heal is better than a potion. Below this the
 *  scroll is being spent to heal one unit, which is what the potion is for. */
const CLUSTER = 3;
/**
 * …and how hurt the PARTY has to be, pooled, before an area heal is worth its charge.
 *
 * Ours, like everything else in this block. Higher than `drinkBar` (the line one unit drinks a
 * potion at) and deliberately so: pooled health is a gentler number than any one soldier's —
 * an army at two thirds usually has somebody in it at a third — and the thing being spent
 * pours over forty-five seconds rather than saving anybody from the next blow. Two thirds is
 * where a player reaches for the scroll: after the camp, before the walk to the next one.
 */
const ARMY_HURT = 0.65;
/**
 * How many doubles standing is enough — the whole of "do not empty the wand into one fight".
 *
 * A Wand of Illusion carries THREE charges (`[will] uses` = 3) and its ability's `Cool1` is 0,
 * so nothing in the data stops a hero pressing all three in the same second. This is what does,
 * and it is stated as *doubles alive* rather than as presses so it self-limits without a clock:
 * two go in, and the third is only ever spent once one of them has popped — which is the fight
 * that is still going, i.e. the one that needed it.
 */
const ILLUSION_CAP = 2;
/**
 * Mana fraction at which a hero swallows an INSTANT top-up — a Potion of Mana, a Scroll of Mana.
 *
 * Ours. Low, because the bar moves the moment it is pressed and nothing can interrupt it: the
 * only thing a charge held back buys is the option of pressing it later, so the honest line is
 * "the spells the fight is being won with have gone" rather than "the bar is not full".
 */
const MANA_LOW = 0.35;
/**
 * …and the bar a POURING one is drunk at, which is a much higher one — see `regenUse`.
 *
 * Reported: the computers *"must be more eager/keen towards using Clarity Potions to constantly
 * restore their heroes mana … note that they should use them only when not fighting as their
 * effect gets interrupted by damage"*, which is both halves of this rung in one sentence, and
 * the data agrees with the second half exactly (`breakItemRegen`).
 *
 * A Clarity Potion pours 200 mana over its `Dur1` and a Lesser one 100 (`[AIpr]`/`[AIpl]`), so
 * what it is for is the walk BETWEEN fights: the whole charge lands only if nothing touches the
 * drinker while it runs, and every second of the pour spent with a full bar is thrown away. So
 * the rung is stated twice over — a bar this far down, AND enough room in it for the whole pour
 * (`manaRoom`) — and the second clause is what makes "eager" mean eager rather than wasteful: a
 * hero with a small pool drinks the moment it is meaningfully down, one with a deep late-game
 * pool waits until there is a potion's worth of room in it.
 */
const MANA_TOPUP = 0.75;
/**
 * The two bars a REPLENISHMENT POTION is drunk at — and EITHER of them on its own is enough.
 *
 * Reported: *"all Computer+ AI should be willing to use Replenishment potion even if they have
 * a lot of health. they should also be willing to use it if they have less than 70% mana."*
 * The 70 % is the developer's own number; the hit-point bar beside it is `MANA_TOPUP`'s, and it
 * is deliberately the eager one rather than `drinkBar`, because this potion is not an emergency
 * item at all. It restores BOTH bars at once for one charge, it is bought by the pair, and its
 * own row calls it a Non-Combat Consumable — so what it is for is the walk between fights, and
 * a charge still in the belt when the next fight starts has done nothing for anybody.
 *
 * OR, and not AND, is the whole of the report: a hero at full health with a spent bar wants
 * this exactly as much as a hurt one with a full bar does, and asking for both left the pair
 * bought at the shop undrunk for the rest of the match.
 */
const REPLENISH_HP = 0.75;
const REPLENISH_MANA = 0.7;
/** The radius everything here calls "this fight" — the same figure plus/casting.ts engages at. */
const LOOK = 900;
/** How close to home is close enough that a Town Portal would be spent on nothing. */
const HOME = 1200;
/** Seconds between shopping trips. A player checks the shop occasionally; they do not stand in
 *  it. Also what keeps a hero from being re-ordered towards a shop every army pass. */
const SHOP_PERIOD = 5;

/** How often the ground is looked at for drops. Cheap — a melee map's loose-item table is a
 *  handful of entries — but there is no reason to walk it four times a second. */
const LOOT_PERIOD = 2;
/**
 * How far a hero will walk for a drop.
 *
 * Generously wider than a creep camp, so the loot of the camp it just cleared is always inside
 * it, and short enough that the hero is not sent across the map for a Potion of Healing. A
 * player picks up what is in front of them.
 */
const LOOT_WALK = 2200;
/** …and how close something hostile may be to the item before it is left where it lies. A hero
 *  that walks into a live camp for a Ring of Protection is a hero that dies for one. */
const LOOT_DANGER = 700;
/**
 * …EXCEPT A DROP AT THE HERO'S FEET, which is picked up whatever is going on — see `loot`.
 *
 * The developer's own number: an item "within 200 units of one of its heroes" (raised from 50,
 * which let a drop a stride away sit there the rest of the fight). The engine's own reach is
 * `PickupItemRange` = 150 past the hero's radius, so from 200 the grab is at most a step or
 * two: the hero does not leave the fight, it bends down in it. Reported: a creep dies in the camp, drops its item
 * beside the hero that killed it, and the hero fights on around it for the rest of the camp
 * before walking back for it — or, when the camp is the one that ends the party, never does.
 */
const LOOT_GRAB = 200;
/** How long a failed at-the-feet grab of one item is not tried again. OURS. The whole grab is a
 *  step, so a second try inside this is a hero bending over the same item every loot pass while
 *  the fight goes on around it — the see-saw the step exists to be too short for. */
const LOOT_GRAB_RETRY = 10;
/** The pause between NOTICING a drop at a hero's feet and bending for it, in seconds — the
 *  developer's own band: "a randomized delay between 0.5 and 2 seconds". A grab on the very
 *  pass the creep died read as a machine: no player has the item in hand the frame it lands. */
const LOOT_GRAB_DELAY_MIN = 0.5;
const LOOT_GRAB_DELAY_MAX = 2;

/**
 * This hero's pause before picking up this drop, somewhere in [`LOOT_GRAB_DELAY_MIN`,
 * `LOOT_GRAB_DELAY_MAX`]. Off the two ids for the reason `drinkBar` is off one: the AI runs on
 * the authority and every client must be able to reproduce it, so there is no `Math.random`
 * here — the same Knuth multiplicative hash, over the pair, so two drops (or two heroes) in one
 * camp do not all wait the same time.
 */
export function lootGrabDelay(itemId: number, heroId: number): number {
  const spread = (Math.imul((itemId * 31 + heroId) | 0, 2654435761) >>> 0) / 0xffffffff;
  return LOOT_GRAB_DELAY_MIN + (LOOT_GRAB_DELAY_MAX - LOOT_GRAB_DELAY_MIN) * spread;
}
/**
 * How far from home a shop has to be before it is not worth the walk. A Goblin Merchant across
 * the map is a hero out of the game for a minute, which is worse than having no potion.
 *
 * Ours, like everything else in this block, and it started at 4000 — which turned out to be
 * shorter than the thing it is measuring. A melee map's neutral shop sits in the CONTESTED
 * ground, not beside anybody's hall: the further a map spreads its start locations the further
 * its Goblin Merchant is from all of them, so the maps with the most shops to visit were
 * exactly the ones on which no shop was ever in range. 5000 is a walk a hero takes and comes
 * back from, and it is still well short of "across the map" on anything four players fit on.
 */
const SHOP_REACH = 5000;
/**
 * How far off its way a hero will walk to REPLACE a missing Town Portal while its party musters —
 * at home or out between two creep camps (`ItemCtx.mayDetour`). OURS. Reported: the AI "seems to
 * not want to re-buy Scroll of Town Portal if it doesn't have one" — it should buy one "when it
 * gets the chance (e.g. near goblin merchant or has shop at home)". The ordinary shopping trip is
 * only ever started from the muster point AT HOME, and a Computer+ army spends most of a game in
 * the field, so a Goblin Merchant a screen away from the camp it had just cleared was walked past
 * every time. A screen or two is a walk a player takes for the one item that decides how a lost
 * fight ends; across the map is not.
 */
const PORTAL_DETOUR = 2000;

/**
 * Gold above `itemReserve` at which the shopping stops being careful — see `RICH`.
 *
 * The reserve answers "is there anything spare at all", and it has to be a low bar or a Normal
 * computer never shops (see `Want.opening`). This is the other end of the same question: money
 * the build order has visibly failed to spend. Set at rather more than the dearest thing on the
 * list (the 350-gold Scroll of Town Portal) so that crossing it means the purse could absorb the
 * whole ladder and not merely the next row of it.
 */
const SURPLUS = 500;

/**
 * THE CARRIED ABILITIES THAT ACTUALLY STACK — mirrors `SimWorld.itemBonuses`, and the mirror is
 * the point.
 *
 * What decides whether a SECOND copy of an item is worth a slot is whether the game adds it to
 * the first one, and the game answers that in exactly one place: the `switch` in `itemBonuses`
 * (plus the orb rule beside it, whose flat damage bonus is *"a carried stat, it stacks"* —
 * docs/orbs.md). Two Claws of Attack are +12 damage; two Rings of Protection are +6 armour.
 *
 * Everything else an item can grant is an ABILITY or an AURA, and a second copy of an ability
 * the unit already has does nothing at all — a hero carrying two Cloaks of Shadows (`Ashm`,
 * Shadow Meld) melds exactly as well as one carrying one, and the second cloak is a slot that
 * could have held a potion. Note the two damage-reduction items are deliberately absent: the
 * sim takes `Math.max` of them, so a second Runed Bracers is worth nothing either.
 *
 * Being wrong in the "it stacks" direction costs a slot; being wrong the other way THROWS AWAY
 * an item, so anything unlisted counts as stacking would be the wrong default — which is why
 * `sparePermanent` also refuses to pawn anything usable, charged or perishable, where a second
 * copy is a second set of charges whatever its ability does.
 */
const STACKS = new Set<string>([
  "AIat", // Claws of Attack — +damage
  "AIde", // Ring of Protection — +armour
  "AIab", // the stat items — +agi/+int/+str
  "AIas", // Gloves of Haste — +attack speed
  "Arel", // Ring of Regeneration / Health Stone — +hp per second
  "AIrm", // Sobi Mask and the wands — +mana per second
  "AIms", // Boots of Speed — +movement
  "AIml", // Periapt of Vitality — +max hp
  "AImm", // the Pendants — +max mana
]);

/**
 * THE ITEMS A COMPUTER+ HERO ALWAYS PAWNS — junk, even when it is the only copy.
 *
 * `STACKS` above answers "is a SECOND one worth a slot"; this answers the blunter question "is
 * the FIRST one". The two live side by side because a belt slot is the scarce thing, and an item
 * this AI will never press is a slot spent on nothing however it got there.
 *
 * Membership is deliberately a short, argued list rather than a rule — the general rule would
 * have to be "an item whose ability is not on the `USE_OF` ladder", and that would pawn the next
 * item somebody adds a handler for before they get round to adding its card.
 *
 *   • **Wand of Lightning Shield (`wlsd`)** — reported. Nothing in the install stocks it (no
 *     `Makeitems`/`Sellitems` row names it, only `ItemData.slk`'s own row), so it reaches a
 *     Computer+ hero exactly one way: a level-2 creep drop that `loot` walked over. Its ability
 *     is `AIls`, which is Lightning Shield (`Alsh`) with the item's numbers on it — an offensive
 *     buff cast on an ENEMY, whose whole value is picking the body in the enemy line that the
 *     most of its own army is packed around. That is a targeting question the item ladder does
 *     not ask (`USE_OF` has no `AIls` card, so `press` never reaches for it), so the wand rides
 *     the belt for the rest of the match holding a slot that a Potion of Healing wants. Pawned,
 *     it is 75 gold — `PawnItemRate` 0.5 of its 150 — towards the next row of `LIST`.
 */
const JUNK = new Set<string>([
  "wlsd", // Wand of Lightning Shield — see above
]);

/** How often the belt is looked over for duplicates worth pawning — the shopping clock, since
 *  it is the same errand and the same walk. */
const PAWN_PERIOD = SHOP_PERIOD;

/**
 * SHARING A SPARE POTION — `share`. Both ours.
 *
 *  · `SHARE_PERIOD`: how often the belts are compared. A hand-over is a walk, and at most one is
 *    started a look.
 *  · `SHARE_REACH`: how far apart the two heroes may be. A hero crossing the map with a potion
 *    is a hero out of its army; two heroes of one army are within this of each other whenever
 *    it is together.
 */
const SHARE_PERIOD = 2;
const SHARE_REACH = 1500;

/** Which bar a potion refills — the two a hero is handed a spare of. A Scroll of Healing or
 *  Restoration (`healArea`) is not a potion and is the whole army's, so it is not in either. */
export type PotionKind = "heal" | "mana";
export function potionKind(use: Use | null): PotionKind | null {
  switch (use) {
    case "healSelf": case "healOther": case "replenish": return "heal";
    case "mana": case "manaRegen": return "mana";
    default: return null;
  }
}

/**
 * Who hands a spare potion to whom: the first hero in `belts` holding TWO or more of a kind,
 * and the first other hero holding NONE of it with a slot free. `belts[i]` is hero i's
 * potions by kind and its free slots. Pure, for the test — `share` feeds it the real belts.
 */
export function potionHandover(
  belts: ReadonlyArray<{ heal: number; mana: number; free: number }>,
): { from: number; to: number; kind: PotionKind } | null {
  for (const kind of ["heal", "mana"] as const) {
    for (let from = 0; from < belts.length; from++) {
      if (belts[from][kind] < 2) continue;
      for (let to = 0; to < belts.length; to++) {
        if (to !== from && belts[to][kind] === 0 && belts[to].free > 0) return { from, to, kind };
      }
    }
  }
  return null;
}

/** What `PlusItems` needs beyond the caster's view: the item rows, a shop's catalogue, and the
 *  purse. Everything else — legality, stock, ranges — is asked of the sim through `world`. */
export interface ItemView extends CasterView {
  /** An item's row: cost, charges, and the ability ids it grants. */
  item(id: string): ItemDef | undefined;
  /** A shop type's catalogue — `Makeitems` (a race shop) and `Sellitems` (a neutral one)
   *  together, since from the buyer's side they are the same shelf. */
  wares(typeId: string): readonly string[];
  /** The player's gold. */
  gold(): number;
}

/** What the army manager knows and this does not. */
export interface ItemCtx {
  /** Where a Town Portal goes — the AI's own main base. */
  home: { x: number; y: number };
  /** Has the army decided it is losing? `ComputerPlusAi` sets this from the retreat it has
   *  already decided on, so the scroll and the retreat are one decision rather than two that
   *  disagree. */
  losing: boolean;
  /**
   * Is the Scroll of Town Portal WORTH SPENDING on this retreat?
   *
   * False when what the army is running from is a CREEP CAMP, true when it is a player. Creeps
   * do not chase far, they do not follow you home, and they will still be standing there in two
   * minutes — so a scroll spent to leave one buys a few seconds of walking and is then not in
   * the belt for the fight that decides the game. An opponent's army chases, and a hero that
   * walks away from one usually does not get home; that is exactly the trip the item is for
   * (docs/items.md).
   *
   * It gates the `escape` rung's ARMY half. The hero's OWN half is gated by `creeping`, which
   * is the same judgement asked of the fight the hero is standing in rather than of the retreat
   * the army has already decided on.
   */
  portalWorthIt: boolean;
  /**
   * Is the fight this party is in a CREEP CAMP's?
   *
   * Distinct from `portalWorthIt`, which is a question about a retreat that has already been
   * ordered and is therefore false in every fight nobody has given up on yet. This one is true
   * from the moment the party sets off at a camp, and it is what holds the hero's own Scroll of
   * Town Portal back to `LAST_RESORT_HP` — see there for why a camp is not worth one.
   */
  creeping: boolean;
  /** May a hero walk off to a shop right now? False while there is a wave in the field, so the
   *  trip never pulls the captain out of a fight. */
  mayShop: boolean;
  /** May a hero step off to a shop NEAR it for a missing Town Portal (`PORTAL_DETOUR`)? True
   *  whenever the party is mustering, in the field as much as at home — a wider door than
   *  `mayShop`, for the one item worth it. Absent means no. */
  mayDetour?: boolean;
}

/** One computer player's inventory: what it buys, and when it presses it. */
export class PlusItems {
  /** When the last shopping trip was considered — see `SHOP_PERIOD`. */
  private lastShop = -Infinity;
  /** The unit currently walking to a shop, or 0. Read by the army manager, which must NOT drag
   *  it back to the muster point while it is on the errand — the trip is re-issued only every
   *  `SHOP_PERIOD`, so a rally order in between would leave the hero walking back and forth
   *  between the shop and the rally point and never arriving at either. */
  private onErrand = 0;
  /** When the ground was last looked at for drops — see `loot`. */
  private lastLoot = -Infinity;
  /** Items an at-the-feet grab (`LOOT_GRAB`) was ordered on, and when — see `LOOT_GRAB_RETRY`.
   *  Pruned every loot pass, so it holds at most the handful of drops on the floor. */
  private grabbed = new Map<number, number>();
  /** Drops NOTICED at a hero's feet and waiting out `lootGrabDelay` before the hero bends for
   *  them — item id → the hero and the clock time it is due. Fired by `tickGrabs`, every AI step,
   *  because the pass that notices them runs every 0.35–2 s and would round the pause up to that. */
  private pendingGrabs = new Map<number, { heroId: number; due: number }>();
  /** …and when the belt was last looked over for duplicates worth pawning — see `pawn`. */
  private lastPawn = -Infinity;
  /** …and the heroes' belts were last compared for a spare potion to hand over — see `share`. */
  private lastShare = -Infinity;
  /** Has a Scroll of Town Portal ever been in this player's belt? Latched true and never
   *  cleared — spending one does not stop being a player who carries one. See `list`. */
  private hadPortal = false;
  /** When a hero was last sent off on a Town Portal detour — throttled like a shopping trip. */
  private lastDetour = -Infinity;

  constructor(
    private readonly view: ItemView,
    private readonly profile: PlusProfile,
    /** Whose shelf this is shopping from — see `RACE_FIRST`. */
    private readonly race: PlayableRace,
  ) {}

  pass(now: number, ctx: ItemCtx): void {
    const own: SimUnit[] = [];
    const foes: SimUnit[] = [];
    // OURS, AND OUR ALLIES' — see fact 4 in the file header. `own` is who this player gives
    // orders to; `friends` is who a charge may be poured into. Everything below that asks "who
    // would this help" takes `friends`, and everything that asks "who can I order" takes `own`.
    const friends: SimUnit[] = [];
    for (const u of this.view.world.units.values()) {
      if (u.hp <= 0) continue;
      if (u.owner === this.view.player) {
        own.push(u);
        friends.push(u);
      } else if (this.view.hostile(u)) foes.push(u);
      else if (this.view.allied?.(u)) friends.push(u);
    }
    for (const u of own) {
      if (!u.inventory.length || !this.canAct(u) || this.view.world.holdsChannel(u.id)) continue;
      this.press(u, own, friends, foes, ctx);
    }
    this.loot(now, own, foes);
    this.share(now, own, foes);
    // BEFORE the shopping, and deliberately: a belt with a dead slot in it is a belt the
    // shopper skips (`shopper` wants a free slot), so clearing the duplicate is what lets the
    // next row of the list be bought at all — and the sale pays a third of it.
    this.pawn(now, own, ctx);
    // THE LATCH (`hadPortal`, see `list`) is read by every buying branch below, so it is set
    // before any of them can return — `fightChance` acting first used to leave it unset.
    if (!this.hadPortal && this.carried(own, PORTAL.id) > 0) this.hadPortal = true;
    // A missing Town Portal first, and on the BELT's clock rather than the shop's: a hero walking
    // past a Goblin Merchant is in its range for a second or two, and a five-second look misses it.
    if (this.portalChance(now, own, ctx)) return;
    // …and the FIGHT items the same way, for the same reason: they are Goblin Merchant wares, and
    // on a map whose Merchant is out in the contested ground (Echo Isles: ~8000 from either
    // start, past `SHOP_REACH`) the ordinary trip from home never goes there at all.
    if (this.fightChance(now, own, ctx)) return;
    this.shop(now, own, ctx);
  }

  /**
   * THE BELT ALONE — press what the heroes carry, and nothing else: no looting, no pawning, no shop.
   *
   * For the hero players that are not melee computers (plus/warchasers/): a party member on a dungeon
   * map picks its own loot and does its own shopping by rules that are that map's, but when to drink
   * a potion is the same question it is everywhere, and it is answered here once.
   */
  beltPass(ctx: ItemCtx): void {
    const own: SimUnit[] = [];
    const foes: SimUnit[] = [];
    const friends: SimUnit[] = [];
    for (const u of this.view.world.units.values()) {
      if (u.hp <= 0) continue;
      if (u.owner === this.view.player) {
        own.push(u);
        friends.push(u);
      } else if (this.view.hostile(u)) foes.push(u);
      else if (this.view.allied?.(u)) friends.push(u);
    }
    for (const u of own) {
      if (!u.inventory.length || !this.canAct(u) || this.view.world.holdsChannel(u.id)) continue;
      this.press(u, own, friends, foes, ctx);
    }
  }

  // ==========================================================================================
  //  Handing a spare potion to a hero that has none
  // ==========================================================================================

  /**
   * ONE HERO'S SPARE IS ANOTHER HERO'S FIRST.
   *
   * Reported: *"if a hero has more than one healing/mana potion, it must try and give one to a
   * friendly hero that doesn't have one and has an empty inventory slot"*. The shopper is
   * whoever is standing at the shop (`shopper`) and a drop goes to whoever is nearest (`loot`),
   * so one hero ends up with three Potions of Healing and the other with none — and the one
   * with none is the one that dies.
   *
   * The hand-over is the sim's own `giveitem`, the gesture a player makes by dragging the potion
   * onto the other hero: the giver walks into `GiveItemRange` and the item changes belts. Only
   * our OWN heroes — `giveitem` checks both ends' ownership, as the game does — and never in a
   * fight: the walk is a `getitem` order, which replaces whatever the giver was doing, and a
   * hero that leaves the line to deliver a potion has spent the fight on it. `underFire` is the
   * reading every press on this file's ladder calls "this fight", asked of both heroes.
   */
  private share(now: number, own: SimUnit[], foes: SimUnit[]): void {
    if (now - this.lastShare < SHARE_PERIOD) return;
    this.lastShare = now;
    const heroes = own.filter((u) => u.isHero && !u.isIllusion && u.inventory.length && this.canAct(u)
      && !this.view.world.holdsChannel(u.id) && u.order !== "getitem" && !this.underFire(u, foes));
    if (heroes.length < 2) return;
    const belts = heroes.map((u) => {
      const belt = { heal: 0, mana: 0, free: 0 };
      for (const held of u.inventory) {
        if (!held) { belt.free++; continue; }
        const def = this.view.item(held.itemId);
        const kind = def ? potionKind(this.useOf(def)) : null;
        if (kind) belt[kind]++;
      }
      return belt;
    });
    for (let i = 0; i < heroes.length; i++) {
      // Only heroes standing near THIS one are offered it: a hero across the map is not walked to.
      const group = heroes.filter((o) => Math.hypot(o.x - heroes[i].x, o.y - heroes[i].y) <= SHARE_REACH);
      const pick = potionHandover(group.map((o) => belts[heroes.indexOf(o)]));
      if (!pick || group[pick.from] !== heroes[i]) continue;
      const from = group[pick.from];
      const to = group[pick.to];
      // The LAST such potion in the belt is handed over, so the one the giver presses first
      // (`press` walks the slots in order) stays where it is.
      for (let slot = from.inventory.length - 1; slot >= 0; slot--) {
        const held = from.inventory[slot];
        const def = held ? this.view.item(held.itemId) : null;
        if (!def || potionKind(this.useOf(def)) !== pick.kind) continue;
        this.view.order({ c: "giveitem", unitId: from.id, slot, targetId: to.id });
        return; // one hand-over a look
      }
    }
  }

  // ==========================================================================================
  //  Selling what a second copy of is worth nothing
  // ==========================================================================================

  /**
   * PAWN THE DUPLICATE — and the junk.
   *
   * Reported: *"heroes that carry multiple Cloak of Shadows must try to sell them at shops (or
   * goblin merchant/marketplace) and keep only 1"*. It is the natural consequence of a hero that
   * picks up everything it walks over (`loot`) on a map whose creeps drop from the same tables:
   * two cloaks, two Rings of Protection +1, two Talismans — and a six-slot belt with two slots
   * spent on nothing.
   *
   * The other half is `JUNK`, which IS a list of items and is checked first: an item this AI
   * has no button for is a dead slot at any count, so it does not wait for a second copy to
   * become worth selling. See that list for why membership is argued one item at a time.
   *
   * WHICH duplicates is not a list of items, it is `sparePermanent` — the question "does the
   * game add the second one to the first", asked of the same codes `SimWorld.itemBonuses`
   * switches on (`STACKS`). A second Claws of Attack is +6 more damage and is kept; a second
   * Cloak of Shadows grants an ability the hero already has and is sold.
   *
   * The SALE is the sim's own gesture end to end: `issueSellItem` walks the hero to the shop's
   * near edge and pawns on arrival, and it sets `order` to `"getitem"` — which is precisely the
   * order the army manager already leaves alone (`massing`, `commit`), so the trip needs no
   * errand flag of its own. `canPawnAt` is what makes a Marketplace or a Goblin Merchant a
   * valid destination and a Tavern not one: it asks for the `Apit` ability rather than for a
   * ware list, which is the whole reason a Marketplace with empty shelves still buys.
   *
   * Gated on `mayShop` like the shopping trip, and for the same reason: it is a walk, and a
   * walk is not something to start while there is a wave in the field.
   */
  private pawn(now: number, own: SimUnit[], ctx: ItemCtx): void {
    if (!ctx.mayShop || this.profile.shopping <= 0) return;
    if (now - this.lastPawn < PAWN_PERIOD) return;
    this.lastPawn = now;
    const shops = this.shops(ctx).filter((sh) => this.view.world.canPawnAt(sh));
    if (!shops.length) return;
    for (const u of own) {
      if (!u.isHero || u.isIllusion || !u.inventory.length || !this.canAct(u)) continue;
      if (u.order === "getitem") continue; // already walking to a shop, or to a drop
      const slot = this.pawnSlot(u);
      if (slot < 0) continue;
      // The nearest shop that deals in items — `shops` is already ordered ours-first then by
      // distance from home, which is the same preference the buying trip uses.
      this.view.order({ c: "sellitem", unitId: u.id, slot, shopId: shops[0].id });
      return; // one errand at a time; the next pass takes the next duplicate
    }
  }

  /**
   * The slot this hero should pawn, or -1 — junk first, then the spare duplicate.
   *
   * Junk goes first because it is the unconditional answer: a `JUNK` item is worth nothing to
   * this AI at any count, while a duplicate is only worth pawning relative to the copy already
   * in the belt. One errand carries one item either way (`pawn` returns after issuing), so the
   * order here is the order the belt is cleared in.
   */
  private pawnSlot(u: SimUnit): number {
    const junk = this.junkSlot(u);
    return junk >= 0 ? junk : this.sparePermanent(u);
  }

  /**
   * The slot holding something on the `JUNK` list, or -1.
   *
   * The two refusals are `issueSellItem`'s own — it drops the order outright for anything not
   * `pawnable`, and a `powerup` is never in a belt to begin with — so asking here means the pass
   * moves on to the duplicate rather than spending its one errand a pass on an order the sim
   * will refuse.
   */
  private junkSlot(u: SimUnit): number {
    for (let slot = 0; slot < u.inventory.length; slot++) {
      const held = u.inventory[slot];
      if (!held || !JUNK.has(held.itemId)) continue;
      const def = this.view.item(held.itemId);
      if (!def || !def.pawnable || def.powerup) continue;
      return slot;
    }
    return -1;
  }

  /**
   * The slot holding a SECOND copy of something a second copy of is worth nothing, or -1.
   *
   * Three refusals before the duplicate test, and each is an item whose second copy IS worth
   * carrying: anything with charges or a press (two Potions of Healing are two heals), anything
   * `powerup` (which is never in a belt at all), and anything the shops will not take back
   * (`pawnable` — a quest item, a campaign artifact).
   *
   * The LATER slot is the one sold, so the hero keeps what it picked up first — which is also
   * the copy an aura or an ability is already being granted from, so nothing blinks off.
   */
  private sparePermanent(u: SimUnit): number {
    for (let slot = 0; slot < u.inventory.length; slot++) {
      const held = u.inventory[slot];
      if (!held) continue;
      const def = this.view.item(held.itemId);
      if (!def || !def.pawnable || def.powerup) continue;
      if (def.usable || def.charges > 0 || def.perishable) continue;
      if (this.stacking(def)) continue;
      // …and it is only spare if an EARLIER slot already holds the same item.
      for (let first = 0; first < slot; first++) {
        if (u.inventory[first]?.itemId === held.itemId) return slot;
      }
    }
    return -1;
  }

  /** Does carrying two of this add up? See `STACKS`. */
  private stacking(def: ItemDef): boolean {
    for (const aid of def.abilities) {
      const code = this.view.def(aid)?.code;
      if (!code) continue;
      if (STACKS.has(code) || isOrbCode(code)) return true;
    }
    return false;
  }

  // ==========================================================================================
  //  Picking things up
  // ==========================================================================================

  /**
   * WHAT THE CREEPS DROPPED — and the tomes.
   *
   * The whole point of creeping, and the AI did not do it at all: it cleared a camp, walked
   * away, and left the Tome of Strength and the Claws of Attack lying on the grass for the other
   * player to collect. On a melee map that is most of the value of the fight it just paid for.
   *
   * Two kinds of thing, one rule, and the difference is worth naming because it decides who is
   * sent:
   *
   *  · a **POWERUP** (`ItemDef.powerup` — the tomes, the runes, a bag of gold) is consumed on
   *    contact and never stored, so a full inventory is no obstacle and a hero should walk over
   *    one whatever it is carrying. It is also permanent: a Tome of Strength is +2 Strength for
   *    the rest of the match, which is worth more than most of what a shop sells.
   *  · an ordinary **ITEM** needs a free slot, so it is only worth walking for if the hero has
   *    one.
   *
   * **Who goes** is the nearest hero with room — never a soldier. Only a hero has an inventory
   * in melee WC3, and sending the one unit whose death loses the fight is exactly why this is
   * bounded by `LOOT_WALK` and refused outright while enemies are near the item: a hero that
   * walks into a live creep camp to pick up a drop is a hero that dies for a Ring of Protection.
   * (The camp's OWN drops are picked up after the camp is dead, which is when nothing is near
   * them any more — this needs no special case, it is just the same test.)
   *
   * With ONE exception, and it is a distance rather than a situation: a drop within `LOOT_GRAB`
   * (200) of a hero is picked up at once, mid-fight and live camp or not, because at that range
   * there is no walk for either rule to be about. Everything further away still waits for the
   * camp — the developer's own line: "otherwise it's fine to wait until the camp is finished".
   *
   * It runs on the belt's own clock rather than a slower one because it is the same kind of
   * decision the belt makes and it is cheap — the ground-item table is a handful of entries on
   * a melee map.
   */
  /**
   * Bend for the drops whose `lootGrabDelay` has run out. Every AI step, and nearly free: the
   * table is empty except in the second or two after a creep dies beside a hero.
   *
   * Everything `loot` checked is asked AGAIN, because up to two seconds have passed: the item may
   * be gone (somebody else took it), the hero dead, stunned, channelling, carrying a full belt
   * now, or — the one that matters — no longer at its feet. A hero the fight has carried past
   * `LOOT_GRAB` is not sent back for it; the drop waits for the camp like any other.
   */
  tickGrabs(now: number): void {
    if (!this.pendingGrabs.size) return;
    for (const [itemId, g] of this.pendingGrabs) {
      if (now < g.due) continue;
      this.pendingGrabs.delete(itemId);
      const it = this.view.world.items.get(itemId);
      const u = this.view.world.units.get(g.heroId);
      if (!it || !u || u.hp <= 0 || !this.canAct(u) || this.view.world.holdsChannel(u.id)) continue;
      const def = this.view.item(it.itemId);
      if (!def || (!def.powerup && u.inventory.indexOf(null) < 0)) continue;
      if (Math.hypot(u.x - it.x, u.y - it.y) > LOOT_GRAB) continue;
      if (u.order === "getitem" && u.getItemId === it.id) continue;
      // Remembered, and NOT re-issued inside `LOOT_GRAB_RETRY` whatever happens to it: the
      // order ends on its own (picked up, or `tickGetItem` gives up), after which the army's
      // own passes put the hero back on the fight — the step is taken once, never argued over.
      this.grabbed.set(itemId, now);
      this.view.order({ c: "getitem", unitId: u.id, itemId: it.id });
    }
  }

  private loot(now: number, own: SimUnit[], foes: SimUnit[]): void {
    // The at-the-feet look runs every pass (it only SCHEDULES — `tickGrabs` does the bending);
    // the walk below keeps its slower clock.
    const walkDue = now - this.lastLoot >= LOOT_PERIOD;
    if (walkDue) this.lastLoot = now;
    const ground = [...this.view.world.items.values()];
    if (!ground.length) return;
    // Heroes only, and the errand runner is left alone — it is walking to a shop.
    //
    // A HERO THAT IS FIGHTING DOES NOT GO SHOPPING ON THE FLOOR. Reported: *"Computer+ AI
    // heroes should prioritize fighting instead of picking up orphaned items from the ground"*
    // — and the gate this file already had is the wrong end of that sentence. `LOOT_DANGER` is
    // measured around the ITEM ("do not walk into a live camp for a Ring of Protection"), which
    // says nothing at all about a drop lying quietly two screens away while the army is in the
    // fight that decides the match: `getitem` replaces whatever the hero was doing, so the one
    // unit the whole squad musters on walked out of the battle for a tome. `underFire` is the
    // same reading every press on this file's ladder calls "this fight", asked of the hero.
    const able = own.filter((u) => u.isHero && u.inventory.length && !u.isIllusion && this.canAct(u));
    const heroes = able.filter((u) => !this.underFire(u, foes));
    // …AND THE ONE EXCEPTION: a drop lying AT a hero's feet (`LOOT_GRAB`). Both gates above and
    // below are about the WALK — out of the fight, into a live camp — and a step of less than a
    // body's width is neither, so it is taken mid-fight and with the camp still standing. A hero
    // holding a channel is still left alone: the order would break a Starfall for a Ring.
    const grabbers = able.filter((u) => !this.view.world.holdsChannel(u.id));
    if (!heroes.length && !grabbers.length) return;
    for (const [id, at] of this.grabbed) if (now - at >= LOOT_GRAB_RETRY || !this.view.world.items.has(id)) this.grabbed.delete(id);
    const taken = new Set<number>();
    // A hero already waiting to bend for one drop is spoken for, here and for the walk below.
    for (const g of this.pendingGrabs.values()) taken.add(g.heroId);
    for (const it of ground) {
      const def = this.view.item(it.itemId);
      if (!def) continue;
      // At the feet first. The belt rule is the same one the walk obeys below — a powerup needs no
      // slot, anything else does — so this can never send a full belt to an item it cannot hold.
      if (this.pendingGrabs.has(it.id)) continue;
      if (!this.grabbed.has(it.id)) {
        let feet: SimUnit | null = null;
        let feetD = LOOT_GRAB;
        for (const u of grabbers) {
          if (taken.has(u.id)) continue;
          if (!def.powerup && u.inventory.indexOf(null) < 0) continue;
          const d = Math.hypot(u.x - it.x, u.y - it.y);
          if (d <= feetD) { feetD = d; feet = u; }
        }
        if (feet) {
          taken.add(feet.id);
          if (feet.order === "getitem" && feet.getItemId === it.id) continue;
          // Not yet: the hero NOTICES it now and bends for it `lootGrabDelay` later (`tickGrabs`).
          this.pendingGrabs.set(it.id, { heroId: feet.id, due: now + lootGrabDelay(it.id, feet.id) });
          continue;
        }
      }
      if (!walkDue || !heroes.length) continue;
      // Nothing is walked to while something hostile is standing over it. This is the whole of
      // "do not feed the hero to the camp for a drop", and it also means a camp's own loot is
      // simply collected once the camp is dead.
      if (foes.some((f) => !f.building && Math.hypot(f.x - it.x, f.y - it.y) <= LOOT_DANGER)) continue;
      let best: SimUnit | null = null;
      let bestD = LOOT_WALK;
      for (const u of heroes) {
        if (taken.has(u.id)) continue;
        // A powerup is consumed on contact and never stored, so a full belt is no obstacle.
        if (!def.powerup && u.inventory.indexOf(null) < 0) continue;
        const d = Math.hypot(u.x - it.x, u.y - it.y);
        if (d < bestD) { bestD = d; best = u; }
      }
      if (!best) continue;
      // IS THERE A ROUTE TO IT? A drop lies where the creep died, and creeps die at the edges of
      // things — so an item quite often ends up somewhere no body can stand: inside a treeline,
      // over a cliff, in the water. The walk itself now gives up rather than re-pathing for ever
      // (`SimWorld.tickGetItem`), but giving up and being re-sent every `LOOT_PERIOD` is the
      // same freeze at a slower rate, and the hero is the unit the whole army musters on. Asked
      // of the terrain alone, so a drop merely screened by bodies is still collected.
      if (!this.view.world.canWalkTo(best.id, it.x, it.y)) continue;
      taken.add(best.id);
      // Already on its way to this very item: leave it alone. A re-issued `getitem` restarts the
      // path search, so re-stating it every pass is a full A* per hero for an order nothing has
      // changed about — the same rule `commit` follows for an attack-move.
      if (best.order === "getitem" && best.getItemId === it.id) continue;
      // `getitem` is the ordinary right-click on a ground item: the unit walks to it and picks
      // it up on arrival (`SimWorld.issueGetItem`), and a powerup is consumed there. One hero
      // per item per pass, so two heroes never race for the same drop.
      this.view.order({ c: "getitem", unitId: best.id, itemId: it.id });
    }
  }

  // ==========================================================================================
  //  Pressing
  // ==========================================================================================

  /** A unit that cannot act cannot drink. The same list plus/casting.ts refuses on, minus the
   *  worker clauses — a hero is never harvesting. Silence does NOT stop an item (that is the
   *  point of items), but being stunned, paused or mid-morph does. */
  private canAct(u: SimUnit): boolean {
    // (The BELT additionally leaves a hero holding a channel alone — the pass and beltPass: a pressed
    // item breaks the channel in the sim, so a Salve drunk mid-Starfall would throw the Starfall
    // away. The Town Portal escape (portalTo) asks only this, because breaking the channel to leave IS
    // the decision there.)
    if (u.building || u.paused || u.stunned || u.isIllusion || u.morphT > 0) return false;
    return u.spawning <= 0;
  }

  /**
   * One button per hero per pass — the highest rung of the ladder it can legally press.
   *
   * The shape is the caster's on purpose (plus/casting.ts `tryCast`): collect the cards, sort by
   * what they are FOR rather than by slot order, and press the first that both the situation and
   * the sim allow. A hero whose command card and whose belt disagreed about which came first
   * would be two decisions undoing each other, which is the whole argument in plus/targeting.ts.
   */
  private press(u: SimUnit, own: SimUnit[], friends: SimUnit[], foes: SimUnit[], ctx: ItemCtx): boolean {
    const cards: Array<{ slot: number; use: Use; def: ItemDef }> = [];
    for (let slot = 0; slot < u.inventory.length; slot++) {
      const held = u.inventory[slot];
      if (!held) continue;
      const def = this.view.item(held.itemId);
      if (!def?.usable) continue;
      const use = this.useOf(def);
      if (!use) continue;
      // Charges, the shared `cooldownid` group, "is it usable at all" — asked of the sim at the
      // same door the HUD asks before it spends the click.
      if (this.view.world.itemReadyError(u.id, slot) !== null) continue;
      cards.push({ slot, use, def });
    }
    if (!cards.length) return false;
    cards.sort((a, b) => useRank(a.use) - useRank(b.use));

    const engaged = foes.some((f) => !f.building && near(u, f, LOOK));
    for (const card of cards) {
      if (!this.wants(u, card.use, card.def, own, friends, foes, engaged, ctx)) continue;
      if (this.aim(u, card.slot, card.def, card.use, friends, foes)) return true;
    }
    return false;
  }

  /** The item's own primary `Use`: the first ability in its `abilList` that names one. Keyed on
   *  the ability's base CODE rather than on the item, so a custom map's re-skinned potion is
   *  played — and see `USE_OF` for why the code and not the alias. */
  private useOf(def: ItemDef): Use | null {
    for (const aid of def.abilities) {
      const ad = this.view.def(aid);
      if (!ad) continue;
      const use = ad.code === REGEN ? regenUse(ad) : USE_OF[ad.code];
      if (use) return use;
    }
    return null;
  }

  /**
   * Does the situation call for this rung?
   *
   * Every clause is about what is happening to the unit rather than about what the item is,
   * which is what makes it read as a player: a potion is drunk because you are being hit, not
   * because you have one.
   */
  private wants(u: SimUnit, use: Use, def: ItemDef, own: SimUnit[], friends: SimUnit[], foes: SimUnit[], engaged: boolean, ctx: ItemCtx): boolean {
    const hp = u.hp / Math.max(1, u.maxHp);
    switch (use) {
      // The retreat, in one press. Either the ARMY has decided it is losing (`ctx.losing` is the
      // manager's own read, so the scroll and the walk home are one decision) or this hero alone
      // is about to die in a fight — which is the same conclusion reached about a smaller group.
      // Never within sight of home, where it would be spent to travel no distance.
      case "escape": {
        if (!engaged && !ctx.losing) return false;
        if (Math.hypot(u.x - ctx.home.x, u.y - ctx.home.y) <= HOME) return false;
        // AGAINST CREEPS the scroll is the LAST RESORT and nothing else — `LAST_RESORT_HP`, and
        // neither half of the rung below it. The hero steps back out of the camp instead
        // (`pullPass`), and a camp that is actually winning is walked away from.
        if (ctx.creeping) return hp < LAST_RESORT_HP;
        // The hero's OWN skin is otherwise unconditional — see `portalWorthIt`. The ARMY's
        // retreat only spends the scroll on a retreat worth spending it on, which is a player's
        // army and never a creep camp.
        if (hp < ESCAPE_HP) return true;
        return ctx.losing && ctx.portalWorthIt;
      }
      case "panic":
        return engaged && hp < PANIC_HP;
      case "healSelf":
        return engaged && hp < drinkBar(u.id);
      // The REGENERATION rungs, and they are the only ones gated on there being NO fight.
      //
      // Reported from both races that open with one: *"the Orc AI must avoid using healing salve
      // during fights and fighting with creeps … same thing for human's Scroll of Regeneration"*,
      // and the reason is in the item rather than in the tactics. `AIrg` hangs a HOT — 400 hit
      // points over forty-five seconds — and **the sim cancels it the moment its bearer is hit**
      // (`ITEM_REGEN_GROUP`, docs/items.md), which is the real game's own rule. So a salve poured
      // on a Grunt that is being swung at is not a heal that races the damage, it is a hundred
      // gold and a charge thrown away on the next blow.
      //
      // The comment that used to be here had the right instinct — *"the moment it is worth is
      // the moment the camp is dead and the party is about to walk to the next one"* — and no
      // gate implementing it. This is that gate: nothing hostile within `LOOK` of the PRESSER,
      // and (in `hurtest` / `armyHeal`) nothing hostile beside whoever the charge is being
      // poured into, since the presser can be nine hundred units from the fight its army is in.
      //
      // An AREA scroll has a SECOND reason to be poured, and it is the one the army reading
      // cannot see. Reported: *"Computer+ AI for human must use scroll of regeneration if their
      // hero has low health, even if the overall army is healthy."* `armyHeal` is deliberately
      // a question about the PARTY — three bodies in the circle, more than half the army in it,
      // pooled health under `ARMY_HURT` — and a hero that came out of a camp at a third of its
      // life beside five untouched Footmen fails every one of those clauses while being exactly
      // the unit the next fight turns on. The circle is drawn on the hero either way (`aim`
      // leaves an area item at the presser's own feet), so the two readings are the same press
      // asked for two different reasons: is the ARMY worth 100 gold, or is the HERO.
      case "healArea":
        return (
          !engaged
          && (this.armyHeal(u, own, friends, this.areaOf(def), foes) || this.selfRegenWorthIt(u, hp, def))
        );
      case "healOther":
        return !engaged && !!this.hurtest(u, friends, foes);
      // Mana is topped up for the fight, not during the panic — a hero with no mana is a hero
      // whose spells are the reason the army is winning.
      //
      // Nothing here asks whether there IS a fight, and that is the undead's rung. Its shop has
      // no Clarity Potion to pour — `[utom] Makeitems` is `rnec,dust,skul,phea,pman,stwp,ocor,
      // shea`, and `pclr` is gated on `etoe` (a Tree of Eternity) while `plcl` is simply not on
      // that shelf — so the one mana item a Death Knight can carry is the instant Potion of
      // Mana, which the race that pays for every Raise Dead, every Cripple and every Death Coil
      // needs more than any other (see `RACE_MANA`).
      //
      // No `manaRoom` here, and that asymmetry with the rung below is the whole difference
      // between the two items. A pour is worth what LANDS, so a Clarity Potion emptied into a
      // nearly-full bar is a charge thrown away; an instant restore is spent at the moment the
      // bar is already down to a third of itself, where the question is not "will all 150 of it
      // fit" but "can this hero cast anything at all". A player swallows it.
      case "mana":
        return u.maxMana > 0 && u.mana / u.maxMana < MANA_LOW;
      // THE POTION THAT FILLS BOTH BARS, and the rung that is not an emergency — see
      // `REPLENISH_HP` / `REPLENISH_MANA` for the two lines and `regenUse` for why it is its
      // own rung rather than a heal. A pour, so it is drunk with nothing hostile in sight and
      // never on top of one that is already running; and either bar being down is reason
      // enough, since one charge fills both whichever of them asked for it.
      //
      // No `manaRoom` clause, unlike the pure mana pour below it. That guard exists to stop a
      // Clarity Potion being emptied into a bar with no room for it — the only thing it does —
      // and here the charge is buying hit points as well, so a full bar wastes half a potion at
      // worst while the missing 25 % of a hero's life goes on being missing.
      case "replenish":
        return (
          !engaged
          && !this.regenerating(u)
          && (hp < REPLENISH_HP || (u.maxMana > 0 && u.mana / u.maxMana < REPLENISH_MANA))
        );
      // …and the POURING one, which is the same top-up read the other way round: it may only be
      // drunk with nothing hostile in sight, and it is drunk far more readily. See `MANA_TOPUP`,
      // and `regenUse` for why a Clarity Potion is not a Potion of Mana.
      case "manaRegen":
        return (
          !engaged
          && u.maxMana > 0
          && u.mana / u.maxMana < MANA_TOPUP
          && this.manaRoom(u, def)
          // Already pouring: a second charge REPLACES the first (one buff group, one instance),
          // so it would be a charge spent to restart a clock. The same guard `hurtest` and
          // `armyHeal` apply to the hit-point half of `AIrg`.
          && !this.regenerating(u)
        );
      // Another body, for a fight big enough that another body decides it. Gated exactly as the
      // buff below is — one scout walking past is not a fight — plus the cap on how many doubles
      // may be standing at once, which is what keeps the wand's three charges from going into
      // the first skirmish of the match (`ILLUSION_CAP`).
      //
      // This is the IN-FIGHT press. The other one is the army manager's, made a few seconds
      // BEFORE a creep camp so the doubles walk in ahead of the party — see `makeIllusions`.
      case "illusion":
        return engaged && this.realFight(u, foes) >= CLUSTER && this.doubles(own) < ILLUSION_CAP;
      // TWO MORE BODIES OUT OF SOMETHING THAT IS ALREADY DEAD — see the `AIrd` card.
      //
      // The developer's own framing is that this is a CREEPING item, and the timing falls out of
      // that: the corpses a rod spends are made by the fight it is spent in, so the moment worth
      // pressing is *while the camp is still standing* — a camp with two of its five down is a
      // camp with two skeletons' worth of bodies on the floor and three creeps left to swing at.
      // Waiting until the fight is over would be waiting until the thing the skeletons were for
      // has finished (they last 65 seconds, `[AIrd] Dur1`).
      //
      // The second half is the walk BETWEEN camps: a hero standing over the last camp's dead
      // with the next one already in sight takes its skeletons along, which is the press a
      // player makes and the reason the early game is what this item is bought for. `LOOK * 2`
      // is the same "a fight is about to start" reading the `mana` rung above uses.
      //
      // One real fighting body is enough, unlike the wand's `CLUSTER`: a rod charge costs no
      // food, no mana and nothing that the next fight wants back, so there is no trade to weigh
      // — only the four charges, which `itemReadyError` and the row's 22-second `Cool1` already
      // ration. A lone scout is still not a fight (`realFight` leaves workers out).
      case "raise":
        return this.realFight(u, foes) >= 1 || foes.some((f) => !f.building && !f.isPeon && near(u, f, LOOK * 2));
      // A buff is pre-fight, and only for a fight worth buffing: one scout walking past is not.
      case "buff":
        return engaged && this.realFight(u, foes) >= CLUSTER;
    }
  }

  /** How much of what is standing around this unit is worth spending a charge on — bodies that
   *  can fight back, so a worker or a building on the way past is not a fight. */
  private realFight(u: SimUnit, foes: SimUnit[]): number {
    let n = 0;
    for (const f of foes) if (!f.building && !f.isPeon && near(u, f, LOOK)) n++;
    return n;
  }

  /**
   * Point it at something and press it.
   *
   * The AIMING is not a table: it is the item's own ability `target`, read exactly as
   * `RtsController.useInventorySlot` reads it to decide whether your click needs a second one.
   * A `unit` item wants somebody; a `point` item wants a spot; everything else — which is the
   * overwhelming majority, every potion in the game — fires on the press with the user's own
   * position, and its row's `Area1` decides who it reaches (docs/items.md).
   *
   * Legality is the sim's, at the same door: `itemUseError` is what the HUD asks before it
   * spends a click, so this can never be more permissive than a player.
   */
  private aim(u: SimUnit, slot: number, def: ItemDef, use: Use, friends: SimUnit[], foes: SimUnit[]): boolean {
    // The aimed ability itself rather than only its `target`, because one rung needs the row's
    // own `Rng1` as well: the Wand of Illusion reaches 500 (`[AIil] Rng1`), and a copy chosen
    // out of that is a press `itemUseError` throws away.
    const aimed = def.abilities.map((aid) => this.view.def(aid)).find((ad) => ad?.target === "point" || ad?.target === "unit");
    let targetId = 0;
    if (aimed?.target === "unit") {
      const t =
        use === "healOther" ? this.hurtest(u, friends, foes)
        : use === "illusion" ? this.toCopy(u, friends, aimed.levelData[0]?.castRange ?? 0)
        : u;
      if (!t) return false;
      targetId = t.id;
    }
    // Note what is NOT done for a `point` item, and specifically for the Town Portal: the aim
    // is left at the hero's own position.
    //
    // That is the DOUBLE-CLICK, which is how a player uses a scroll to escape and is the whole
    // reason it works as one. Blizzard's own page: *"You can also double click on the Town
    // Portal Scroll which will automatically select the highest (allied) Town Hall as a
    // transport destination"*, and *"Don't double click on your Town Portal unless you want to
    // go back to your Hall."* `SimWorld.itemTownPortal` resolves to `nearestHall(owner, x, y)`,
    // so aiming at the hero IS "the nearest hall of the user" — no destination to choose, no
    // hall to pick wrong, and nothing to get out of date while the hero runs.
    //
    // Aiming at the main base instead (which is what this used to do) is the one-click form,
    // and it is worse for an escape in the case that matters: a hero fleeing a fight beside its
    // own expansion would run PAST the hall that could save it to reach a hall across the map.
    //
    // Legality is the sim's, at the same door: `itemUseError` is what the HUD asks before it
    // spends a click, so this can never be more permissive than a player's press.
    if (this.view.world.itemUseError(u.id, slot, targetId) !== null) return false;
    return this.view.order({ c: "useitem", unitId: u.id, slot, targetId, x: u.x, y: u.y });
  }

  /**
   * IS THE ARMY HURT, AND IS THE ARMY HERE? — the whole of when an area heal is spent.
   *
   * Three questions, and the developer's own statement of the feature names all three: *"it
   * should base its usage around total army health and it must make sure that their hero uses
   * it while close to its army so that more than half the army is in range of the Scroll of
   * Regeneration's radius."*
   *
   *  1. **Is it reaching a GROUP?** `CLUSTER` bodies inside the circle, or the scroll is being
   *     spent to do a potion's job and the potion is one rung down.
   *  2. **Is more than HALF the army in the circle?** This is the one that makes it an army
   *     item rather than a bigger potion, and it is measured against the whole army rather than
   *     against what happens to be standing beside the hero — a Scroll of Regeneration poured
   *     over the two units that arrived first is 100 gold spent on two units. It is also why
   *     nothing here walks the hero anywhere: the Computer+ army moves as ONE BODY anchored on
   *     its captain (docs/computer-plus.md), so "wait until the party is around you" is a
   *     condition the army manager satisfies by itself a few seconds later.
   *  3. **Is the army hurt?** POOLED — one fraction over the hit points and maxima of everybody
   *     the circle covers, which is what "total army health" means and is a different question
   *     from counting heads: five soldiers at 90 % are not an army that needs a scroll, and two
   *     at 20 % beside three at full are.
   *
   * The radius is the item's OWN (`areaOf`), never a constant of ours — the Scroll of
   * Regeneration reaches 600 (`[AIsl] Area1`) and the Scroll of Healing its own figure, and a
   * rule written against `LOOK` would have promised to cover units standing 300 units outside
   * the circle it was about to draw.
   *
   * THE TWO POOLS ARE NOT THE SAME POOL, and the asymmetry is the point (file header, fact 4).
   * What the circle COVERS is every friendly body inside it, an ally's included — the sim pours
   * over exactly that set (`itemAreaTargets` admits anything the row's `friend` flag admits, and
   * `friend` is answered with `hostile`), so counting only ours would price the charge at less
   * than it is worth and hold a scroll that would put four armies' worth of hit points back.
   * The PARTY it is measured against is ours alone: that is the body the hero moves with
   * (docs/computer-plus.md — the army travels anchored on its captain), and an ally's army
   * standing across the map is not a reason this hero's scroll is being wasted. Putting them in
   * the denominator would mean a computer with a busy ally could never reach the half.
   */
  private armyHeal(u: SimUnit, own: SimUnit[], friends: SimUnit[], radius: number, foes: SimUnit[]): boolean {
    let party = 0;
    for (const o of own) {
      if (o.building || o.isPeon || o.isIllusion || o.hp <= 0) continue;
      party++;
    }
    let covered = 0;
    let hp = 0;
    let maxHp = 0;
    for (const o of friends) {
      // The ARMY: what fights. Buildings, workers and the doubles are none of it — an illusion
      // arrives at full health, takes double damage and is meant to die (docs/illusions.md), so
      // counting it would price the party as healthier than it is and put it in the denominator
      // of a question about where the real army is standing.
      if (o.building || o.isPeon || o.isIllusion || o.hp <= 0) continue;
      if (!near(u, o, radius)) continue;
      // Somebody already pouring is not somebody this charge would help — see `regenerating`.
      // It stays in the PARTY (it is still a body the circle has to be drawn around) but not
      // in what the circle COVERS, so a second scroll cannot follow the first over the same
      // party a second later.
      if (this.regenerating(o)) continue;
      // …and neither is somebody who is being HIT. The regeneration buff is cancelled by the
      // next blow that lands, so a body in contact is a body this charge pours into the damage
      // — see the `healArea` rung. It stays in the party for the same reason a regenerating one
      // does: it is still a body the circle has to be drawn around.
      if (this.underFire(o, foes)) continue;
      covered++;
      hp += o.hp;
      maxHp += o.maxHp;
    }
    if (covered < CLUSTER) return false;
    if (covered * 2 <= party) return false;
    return hp / Math.max(1, maxHp) < ARMY_HURT;
  }

  /**
   * IS THIS UNIT ALREADY POURING? — the guard that stops a belt emptying itself in one breath.
   *
   * A regeneration item is a HOT: `applyItemAbility`'s `AIrg` branch hangs a buff in the
   * `ITEM_REGEN_GROUP` for the row's own `Dur1` — 45 seconds for a Healing Salve, restoring
   * 400 hit points over that time — and a second charge poured on the same unit does not
   * stack, it REPLACES (one group, one instance). So a salve spent on somebody who is already
   * regenerating is a salve thrown away, and without this the whole belt goes into the first
   * camp: measured, a Blademaster carrying two Healing Salves (six charges) emptied both
   * inside fifteen seconds because the unit it kept picking was still the most hurt one there
   * — it was regenerating, but it had not finished yet.
   *
   * Asked of the sim's own buff list rather than remembered here, so a salve a PLAYER'S ally
   * poured, or one from a rune off the ground, counts exactly the same.
   */
  private regenerating(u: SimUnit): boolean {
    return u.buffs.some((b) => b.group.startsWith(ITEM_REGEN_GROUP) && b.timeLeft > 0);
  }

  /**
   * The radius an area item's own row reaches — `Area1` off the ability that carries the
   * effect, exactly as `SimWorld.applyItemAbility` reads it when the button is pressed.
   *
   * Falls back to `LOOK` for a row that names no area, which cannot happen for anything that
   * reached this rung (`regenUse` and `USE_OF` only ever answer `healArea` for a row with an
   * `Area1`) and is the harmless direction to be wrong in if a custom map manages it.
   */
  private areaOf(def: ItemDef): number {
    for (const aid of def.abilities) {
      const area = this.view.def(aid)?.levelData[0]?.area ?? 0;
      if (area > 0) return area;
    }
    return LOOK;
  }

  /**
   * IS THE HERO ITSELF WORTH THE SCROLL? — the second half of the `healArea` rung.
   *
   * A Scroll of Regeneration draws its circle on the presser, so this asks nothing about who
   * else is standing in it: the question is only whether the body at the centre wants what is
   * about to be poured. `drinkBar` is the line the hero drinks its own potion at, which is the
   * right bar for a hundred-gold area charge spent on one unit — above it the scroll is being
   * spent on a scratch, and `armyHeal` is the reading that decides whether the party makes it
   * worth pouring anyway.
   *
   * `regenerating` for the reason it guards every other `AIrg` press: one buff group, one
   * instance, so a second charge would only restart a clock that is already running.
   *
   * THE POURING KIND ONLY, and that clause is doing real work. Two quite different items answer
   * `healArea`: the Scroll of Regeneration and its Replenishment cousins pour `AIrg` over
   * forty-five seconds for 100 gold, and the Scroll of Healing (`AIha`, `AIra`) restores at the
   * press for 250. The report is about the first — *"must use scroll of regeneration if their
   * hero has low health"* — and only the first is worth spending on one body: the cheap trickle
   * is what a hero drinks walking between camps, while the Scroll of Healing is the charge that
   * puts a whole army back on its feet in the middle of a fight, and emptying it into one hero
   * at 54 % out of combat is exactly the press a player would kick themselves for. The army
   * reading above still spends either.
   */
  private selfRegenWorthIt(u: SimUnit, hp: number, def: ItemDef): boolean {
    if (hp >= drinkBar(u.id) || this.regenerating(u)) return false;
    return def.abilities.some((aid) => this.view.def(aid)?.code === REGEN);
  }

  /**
   * IS THERE ROOM IN THE BAR FOR THE WHOLE THING? — the guard on both mana rungs.
   *
   * A mana item's worth is a flat number of points off its own row, not a fraction, so "the bar
   * is low" says nothing about whether a charge would be wasted: a hero with 900 mana at a
   * third of it is missing six hundred and a Lesser Clarity Potion's hundred all lands, while a
   * level-1 hero at the same fraction is missing 200 and a 200-mana Potion of Mana overflows the
   * moment it regenerates a point on its own. The sim will not refuse the press for that — its
   * only refusal is a bar that is completely FULL (`itemRestore`'s `t.mana < t.maxMana`, and
   * `applyItemAbility`'s `mana > 0 && hp <= 0` clause for the pouring kind) — so the judgement
   * has to be here, and it is what lets `MANA_TOPUP` sit as high as it does.
   *
   * Read off the item's OWN row, in the column the sim's handler reads: `AIma`/`AImr` restore
   * `DataA` at once (`itemRestore(u, ad, -1, 0)`), and the `AIrg` family pours `DataB` over
   * `Dur1`. A row that names no mana at all answers true — it is not a mana item, and nothing
   * that reached this rung is one.
   */
  private manaRoom(u: SimUnit, def: ItemDef): boolean {
    let worth = 0;
    for (const aid of def.abilities) {
      const ad = this.view.def(aid);
      const lvl = ad?.levelData[0];
      if (!ad || !lvl) continue;
      const mana = ad.code === REGEN ? lvl.data[1] : MANA_INSTANT.has(ad.code) ? lvl.data[0] : 0;
      if (mana > 0) worth = Math.max(worth, mana);
    }
    return worth <= 0 || u.maxMana - u.mana >= worth;
  }

  /** The most hurt of OUR SIDE in reach — who a Healing Salve goes on. Buildings and workers
   *  are left out for the same reason the army leaves them out: the salve is for the fight.
   *
   *  The pool is `friends` and not `own` (file header, fact 4): `[AIrl] targs1` is
   *  "air,ground,friend,self,organic,vuln,invu" and the sim answers `friend` with `hostile`,
   *  so an ally's Grunt has always been a legal target for this charge — `itemUseError` would
   *  have allowed the press all along. Nothing else needed changing for it. */
  private hurtest(u: SimUnit, friends: SimUnit[], foes: SimUnit[]): SimUnit | null {
    let best: SimUnit | null = null;
    let worst = ALLY_HP;
    for (const o of friends) {
      if (o.building || o.isPeon || !near(u, o, LOOK)) continue;
      if (this.regenerating(o)) continue; // already pouring — see `regenerating`
      // …and a body that is being swung at pours the salve straight into the damage: the buff
      // is cancelled by the next blow (see the `healOther` rung). The presser's own fight is
      // already gated there, but it can be a screen away from the one its army is in.
      if (this.underFire(o, foes)) continue;

      const frac = o.hp / Math.max(1, o.maxHp);
      if (frac < worst) {
        worst = frac;
        best = o;
      }
    }
    return best;
  }

  /** Is anything hostile close enough to this unit to break a regeneration buff on it? The
   *  same `LOOK` everything else here calls "this fight", asked of the BODY being healed rather
   *  than of the hero doing the pouring. Buildings do not count — a tower is a fight, so it is
   *  left in deliberately: only a `building` with no weapon would be, and `near` already has to
   *  reach it. */
  private underFire(o: SimUnit, foes: SimUnit[]): boolean {
    return foes.some((f) => !f.building && near(o, f, LOOK));
  }

  /**
   * WHO THE WAND COPIES — the biggest body in reach, and the presser itself when there is none.
   *
   * `[AIil] targs1` is "ground,air,friend,self", so the double is made of one of OUR SIDE's —
   * an ally's Tauren as readily as our own, since the sim answers `friend` with `hostile` (file
   * header, fact 4) and the copy is OURS however it was made. It arrives at FULL hit points
   * however hurt the original is (`initIllusion`, docs/illusions.md). What the double is FOR is soaking blows that would otherwise land on the
   * party — it deals no damage at all — so the only thing worth reading is how much punishment
   * the copy can stand, which is `maxHp` and not the original's current health.
   *
   * It takes DOUBLE damage (`DataB` = 2), which does not change the ordering: twice the hit
   * points is still twice the blows absorbed. A Tauren's copy outlasts a Tauren Chieftain's, so
   * this is deliberately not "always the hero".
   *
   * Illusions are excluded, or the second press copies the first double — a copy of a copy is
   * the same body at a further remove and it stops being the biggest thing in the party the
   * moment anything hits it. Workers are excluded because a Peasant's double fools nobody and
   * tanks nothing.
   */
  private toCopy(u: SimUnit, friends: SimUnit[], range: number): SimUnit {
    let best = u; // the presser is always in range of itself, so there is always an answer
    for (const o of friends) {
      if (o.building || o.isPeon || o.isIllusion || o.hp <= 0) continue;
      if (range > 0 && Math.hypot(o.x - u.x, o.y - u.y) > range) continue;
      if (o.maxHp > best.maxHp) best = o;
    }
    return best;
  }

  /** How many doubles of ours are standing. Counted across the PLAYER rather than per hero: the
   *  charges are the player's, and two heroes each pressing to their own cap is the wand emptied
   *  twice as fast for no more bodies in the line. */
  private doubles(own: readonly SimUnit[]): number {
    let n = 0;
    for (const o of own) if (o.isIllusion && o.hp > 0) n++;
    return n;
  }

  /**
   * THROW THE DOUBLES IN — the press the army manager makes for itself, before a creep camp.
   *
   * The ladder's own `illusion` rung is a reading of the fight this hero is ALREADY in, which is
   * the wrong moment for a camp: by the time the party is engaged the creeps have picked their
   * targets and the hero is one of them. This is the other press — made a few seconds out from
   * an orange or red camp so the copies walk in ahead of the party and the camp spends its
   * opening blows on them (plus/index.ts `vanguardPass`). Same doors as any other press, so it
   * can never be more permissive than a player's click.
   *
   * It presses UP TO the cap in one go rather than one per pass. A vanguard has to set off
   * together — doubles dribbled out a second apart arrive a second apart and are killed in
   * ones — and the data allows it: `[AIil] Cool1` is 0, so a second charge is legal the instant
   * the first is spent.
   *
   * The doubles already ordered do not exist yet when the next press is decided (spawning is
   * asynchronous — the request is drained by the renderer, docs/illusions.md), which is why the
   * loop counts its OWN presses against the cap rather than re-counting what is standing.
   *
   * Returns how many went through.
   */
  makeIllusions(u: SimUnit, cap: number = ILLUSION_CAP): number {
    if (!u.inventory.length || !this.canAct(u)) return 0;
    const own: SimUnit[] = [];
    // The same two pools `pass` keeps, for the same reason: the CAP is counted over our own
    // doubles (they are our units and our charges), and what may be COPIED is our whole side.
    const friends: SimUnit[] = [];
    for (const o of this.view.world.units.values()) {
      if (o.hp <= 0) continue;
      if (o.owner === this.view.player) {
        own.push(o);
        friends.push(o);
      } else if (!this.view.hostile(o) && this.view.allied?.(o)) friends.push(o);
    }
    const standing = this.doubles(own);
    let made = 0;
    while (standing + made < cap) {
      const slot = this.illusionSlot(u);
      if (slot < 0) break; // no wand, out of charges, or cooling down
      const def = this.view.item(u.inventory[slot]!.itemId);
      // No foes list: `illusion` aims at one of OURS (`toCopy`) and reads nothing about the
      // fight, and this press is the army manager's own — made a few seconds BEFORE contact.
      if (!def || !this.aim(u, slot, def, "illusion", friends, [])) break;
      made++;
    }
    return made;
  }

  /** The slot holding a Wand of Illusion this unit could press right now, or -1. Keyed on the
   *  ABILITY code for the same reason `USE_OF` is, and `itemReadyError` is the sim's own door:
   *  a wand out of charges is a wand the hero has not got. */
  private illusionSlot(u: SimUnit): number {
    for (let slot = 0; slot < u.inventory.length; slot++) {
      const held = u.inventory[slot];
      if (!held) continue;
      const def = this.view.item(held.itemId);
      if (!def?.usable) continue;
      if (!def.abilities.some((aid) => this.view.def(aid)?.code === ILLUSION_ABILITY)) continue;
      if (this.view.world.itemReadyError(u.id, slot) !== null) continue;
      return slot;
    }
    return -1;
  }

  // ==========================================================================================
  //  Shopping
  // ==========================================================================================

  /**
   * Go to a shop, and buy the next thing on the list.
   *
   * Two steps, and the AI may sit in the first of them for a while: a purchase needs the buyer
   * standing at the shop (`purchaseItem` refuses "nopatron" otherwise), and the sim adopts
   * whoever is in range as the patron by itself (`tickShopBuyers`) — so the whole of "select
   * this hero as the buyer" is *walking it there*, exactly as it is for a player.
   *
   * `mayShop` is what keeps that walk off the battlefield: the trip is only ever started while
   * the army is at home, so the captain is never pulled out of a fight to go shopping.
   */
  private shop(now: number, own: SimUnit[], ctx: ItemCtx): void {
    // Whatever else happens below, nobody is on an errand once the army has somewhere to be.
    if (!ctx.mayShop || this.profile.shopping <= 0) this.onErrand = 0;
    if (this.profile.shopping <= 0) return;
    if (now - this.lastShop < SHOP_PERIOD) return;
    this.lastShop = now;
    // Is the build order visibly failing to spend this? Then shop like it — deeper rows and a
    // fuller belt (see `RICH` and `SURPLUS`). Asked once, here, so the two halves cannot
    // disagree about which hero is doing the shopping and what it is allowed to buy.
    // THE LATCH — see `list`. Asked here because the answer is a fact about the belt and this
    // is where the belt is about to be shopped for; it can only ever go from false to true.
    if (!this.hadPortal && this.carried(own, PORTAL.id) > 0) this.hadPortal = true;
    const rich = this.view.gold() - this.profile.itemReserve >= SURPLUS;
    // WHAT to buy is decided before WHO fetches it, and that order is load-bearing rather than
    // tidy: the answer decides which ceiling the shopper is held to (see below). `pick` reads
    // nothing about the hero, so asking it first costs nothing.
    //
    // The whole purse, not the surplus: `pick` applies `itemReserve` per ROW, because the
    // race's opening buys are not discretionary spending — see `Want.opening`.
    let buy = this.pick(own, this.view.gold(), ctx, rich);
    if (!buy) return void (this.onErrand = 0); // nothing left worth walking for
    // A REPLACEMENT SCROLL IS NOT SHOPPING, and `PlusProfile.shopping` must not stop it.
    //
    // That number is a HABIT — how much of a belt this player bothers to fill — and it is
    // counted against everything the hero is holding, drops included. Three slots on Normal is
    // reached by two potions and one thing picked up off a creep, at which point the hero
    // stopped shopping for the rest of the match while the one item that decides how a lost
    // fight ends sat unbought at the shop it walked past. A player who keeps a Town Portal
    // replaces it whatever else is in the belt; a free SLOT is the only thing that can stop
    // them, and `shopper` still asks for one.
    let hero = this.shopper(own, rich, ESSENTIAL.has(buy.itemId));
    // …and a row the habit ceiling refuses must not hide an ESSENTIAL one below it. `pick` stops
    // at the first row it can act on, which for an orc is its opening salve — so a hero at the
    // ceiling was refused the salve and the pass ended there, every pass, with the Potion of
    // Healing two rows further down (measured: 1258 gold banked at 15:00 and no potion bought).
    if (!hero && !ESSENTIAL.has(buy.itemId)) {
      const essential = this.pick(own, this.view.gold(), ctx, rich, true);
      if (essential) {
        buy = essential;
        hero = this.shopper(own, rich, true);
      }
    }
    if (!hero) return void (this.onErrand = 0);
    if (this.view.world.shopReaches(buy.shopId, hero.id)) {
      this.onErrand = 0; // arrived — the army may have it back
      this.view.order({ c: "buyitem", shopId: buy.shopId, itemId: buy.itemId });
      return;
    }
    if (!ctx.mayShop) return; // there is a wave out; the errand waits
    this.onErrand = hero.id;
    this.view.order({ c: "order", unitId: hero.id, order: { kind: "move", x: buy.x, y: buy.y }, queued: false });
  }

  /**
   * REPLACE A MISSING TOWN PORTAL WHEREVER THE CHANCE COMES.
   *
   * Reported: the AI "seems to not want to re-buy Scroll of Town Portal if it doesn't have one" —
   * it should buy one on one of its heroes, ideally the first, "when it gets the chance (e.g. near
   * goblin merchant or has shop at home)". `shop` could not: its trip only starts from the muster
   * point at home (`mayShop`), and only looks at shops within `SHOP_REACH` of home, so a hero
   * STANDING at a Goblin Merchant between two creep camps walked on without a scroll. Two chances,
   * in order:
   *
   *  1. A hero with a free slot is already IN RANGE of any shop that will sell us one — anywhere
   *     on the map, in any mode, a fight included (the purchase is instant): buy it.
   *  2. The party is mustering (`mayDetour`) and a shop that sells one is within `PORTAL_DETOUR`
   *     of our best hero: send that hero, as an errand the army manager leaves alone.
   *
   * Only for a player that PLANS around a scroll (`keepPortal` — Normal and Insane; Easy shops for
   * nothing at all), and out of the whole purse, for `list`'s reason: a replacement is not
   * shopping. Answers whether it acted, so the ordinary shopping pass stands aside that pass — it
   * would otherwise clear the errand (a field muster is not `mayShop`) and the two would argue.
   */
  private portalChance(now: number, own: SimUnit[], ctx: ItemCtx): boolean {
    if (!this.profile.keepPortal || this.profile.shopping <= 0) return false;
    if (this.carried(own, PORTAL.id) > 0) return false;
    // The race's OPENING buys still come ahead of the FIRST scroll (`list`): the orc's two
    // salves are what hold the first creep camps together. Once a scroll has been carried, a
    // missing one outranks everything.
    if (!this.hadPortal && (RACE_FIRST[this.race] ?? []).some((w) => this.carried(own, w.id) < w.want)) return false;
    return this.itemChance(now, own, ctx, PORTAL.id);
  }

  /**
   * `portalChance` for the `FIGHT` items: a missing Scroll of Healing or Potion of Lesser
   * Invulnerability is bought wherever a hero stands in a shop's range, and fetched on the field
   * detour, exactly as a missing scroll is. Only once the portal is carried — the portal outranks
   * them, and a pass that bought a potion with the scroll's gold would be `list`'s order upside
   * down. The first missing one that some shop can sell us wins the pass.
   */
  private fightChance(now: number, own: SimUnit[], ctx: ItemCtx): boolean {
    if (!this.profile.keepPortal || this.profile.shopping <= 0) return false;
    if (this.carried(own, PORTAL.id) <= 0) return false;
    for (const w of FIGHT) {
      if (this.carried(own, w.id) >= w.want) continue;
      if (this.itemChance(now, own, ctx, w.id)) return true;
    }
    return false;
  }

  /** Buy `itemId` for our first hero with room if one is standing in range of a shop that sells
   *  it, else walk that hero there on the field detour (`PORTAL_DETOUR`, `ItemCtx.mayDetour`).
   *  Out of the whole purse. Answers whether it acted. */
  private itemChance(now: number, own: SimUnit[], ctx: ItemCtx, itemId: string): boolean {
    const def = this.view.item(itemId);
    if (!def || def.gold > this.view.gold()) return false;
    // The FIRST hero where it can be: the highest level (which is nearly always the first one
    // trained), the older of two at the same level. A full belt cannot take it.
    const heroes = own
      .filter((u) => u.isHero && !u.isIllusion && u.inventory.length && u.inventory.indexOf(null) >= 0 && u.order !== "getitem" && this.canAct(u))
      .sort((a, b) => b.level - a.level || a.id - b.id);
    if (!heroes.length) return false;
    const shops: SimUnit[] = [];
    for (const u of this.view.world.units.values()) {
      if (u.hp <= 0 || !u.building || u.building.constructionLeft > 0 || this.view.hostile(u)) continue;
      if (this.view.world.canUseShop(u.id, this.view.player) && this.stocks(u, itemId)) shops.push(u);
    }
    if (!shops.length) return false;
    for (const hero of heroes) {
      const at = shops.find((shop) => this.view.world.shopReaches(shop.id, hero.id));
      if (!at) continue;
      if (this.onErrand === hero.id) this.onErrand = 0; // arrived — the army may have it back
      // Delivered to THIS hero, not to whichever unit of ours the shop adopted first (which may
      // be a hero with a full belt, whose purchase is refused every pass): the "Select Hero"
      // pick a player makes, refused harmlessly by a shop that does not offer one.
      if (this.view.world.shopBuyer(at.id, this.view.player)?.id !== hero.id) {
        this.view.order({ c: "shopbuyer", shopId: at.id, unitId: hero.id });
      }
      this.view.order({ c: "buyitem", shopId: at.id, itemId });
      return true;
    }
    if (!ctx.mayDetour) return false;
    const hero = heroes[0];
    // Already on its way: leave it walking (re-ordered on the throttle, in case it was bumped).
    if (this.onErrand && this.onErrand !== hero.id) return false;
    if (hero.inCombat) return false;
    let near: SimUnit | null = null;
    let best = PORTAL_DETOUR;
    for (const shop of shops) {
      const d = Math.hypot(shop.x - hero.x, shop.y - hero.y);
      if (d <= best) {
        best = d;
        near = shop;
      }
    }
    if (!near) return false;
    this.onErrand = hero.id;
    if (now - this.lastDetour < SHOP_PERIOD) return true;
    this.lastDetour = now;
    this.view.order({ c: "order", unitId: hero.id, order: { kind: "move", x: near.x, y: near.y }, queued: false });
    return true;
  }

  /**
   * How much gold the BUILD LADDER must hold back so that a missing Town Portal can be bought —
   * the scroll's price, or 0. Read by the plan (plus/plan.ts `portalSaving`) and turned into a
   * `AiPlayer.reserveGold` row.
   *
   * Reported: the AI does not SAVE for a scroll it cannot afford. `pick` already refuses to spend
   * the SHOP's gold on the next row down while a scroll is wanted, and `portalChance` buys one
   * the moment the purse covers it — but the purse is emptied every build pass by a ladder that
   * knows nothing about either, so the moment "the purse covers it" was one the build order
   * almost never left standing. The shopping half was saving; the half that spends most of the
   * gold was not. This is that half.
   *
   * Asked under exactly the conditions the buy itself is (`portalChance`), so gold is never
   * held for a scroll nobody could fetch:
   *  · a player that PLANS around one (`keepPortal`), and has not got one;
   *  · past the race's opening buys, for the FIRST scroll (the orc's salves come first, as in
   *    `portalChance` and `list`);
   *  · a hero with a free slot to put it in;
   *  · a shop that will sell one to us RIGHT NOW (stock on the shelf, its tech requirement met
   *    — an Arcane Vault's scroll wants a Keep) that a hero will actually get to: within
   *    `SHOP_REACH` of home, where the ordinary trip goes, or within `PORTAL_DETOUR` of a hero,
   *    which is the field detour's own leash.
   * Held for as long as the scroll is MISSING, and not merely while it is unaffordable. Letting
   * go the moment the bank covered the price handed the whole of it straight back to the ladder
   * on the same pass, so the bank see-sawed around 350 and was below it again by the time a
   * hero stood at a shop — the saving would have been a pretence. Held until the hero HAS it,
   * the gold is in the bank whenever `portalChance` looks. The price, never more — the reserve is
   * not a halt (see `reserveGold`), so the worst a scroll that is never fetched costs the build
   * order is 350 gold sitting in the bank.
   */
  /**
   * `portalSaving` for the `FIGHT` items: the price of the first missing one some shop will sell
   * us and a hero will get to (the same two reaches), once the Town Portal is carried — or 0.
   * Added to the same `reserveGold` row (plus/plan.ts `portalSaving`). Measured on an observed
   * Normal match: the bank stood at 17–298 gold every time the shopping pass looked, so a
   * 250-gold Scroll of Healing was never affordable however high it sat on the list.
   */
  fightSaving(ctx: ItemCtx): number {
    if (!this.profile.keepPortal || this.profile.shopping <= 0) return 0;
    const own: SimUnit[] = [];
    for (const u of this.view.world.units.values()) if (u.hp > 0 && u.owner === this.view.player) own.push(u);
    if (this.carried(own, PORTAL.id) <= 0) return 0;
    const heroes = own.filter((u) => u.isHero && !u.isIllusion && u.inventory.length && u.inventory.indexOf(null) >= 0);
    if (!heroes.length) return 0;
    for (const w of FIGHT) {
      if (this.carried(own, w.id) >= w.want) continue;
      const def = this.view.item(w.id);
      if (!def || def.gold <= 0) continue;
      for (const shop of this.view.world.units.values()) {
        if (shop.hp <= 0 || !shop.building || shop.building.constructionLeft > 0 || this.view.hostile(shop)) continue;
        if (!this.view.world.canUseShop(shop.id, this.view.player) || !this.stocks(shop, w.id)) continue;
        const home = Math.hypot(shop.x - ctx.home.x, shop.y - ctx.home.y) <= SHOP_REACH;
        if (home || heroes.some((h) => Math.hypot(shop.x - h.x, shop.y - h.y) <= PORTAL_DETOUR)) return def.gold;
      }
    }
    return 0;
  }

  portalSaving(ctx: ItemCtx): number {
    if (!this.profile.keepPortal || this.profile.shopping <= 0) return 0;
    const own: SimUnit[] = [];
    for (const u of this.view.world.units.values()) if (u.hp > 0 && u.owner === this.view.player) own.push(u);
    if (this.carried(own, PORTAL.id) > 0) return 0;
    if (!this.hadPortal && (RACE_FIRST[this.race] ?? []).some((w) => this.carried(own, w.id) < w.want)) return 0;
    const def = this.view.item(PORTAL.id);
    if (!def || def.gold <= 0) return 0;
    const heroes = own.filter((u) => u.isHero && !u.isIllusion && u.inventory.length && u.inventory.indexOf(null) >= 0);
    if (!heroes.length) return 0;
    for (const shop of this.view.world.units.values()) {
      if (shop.hp <= 0 || !shop.building || shop.building.constructionLeft > 0 || this.view.hostile(shop)) continue;
      if (!this.view.world.canUseShop(shop.id, this.view.player) || !this.stocks(shop, PORTAL.id)) continue;
      const home = Math.hypot(shop.x - ctx.home.x, shop.y - ctx.home.y) <= SHOP_REACH;
      if (home || heroes.some((h) => Math.hypot(shop.x - h.x, shop.y - h.y) <= PORTAL_DETOUR)) return def.gold;
    }
    return 0;
  }

  /**
   * Spend the Scroll of Town Portal on ARRIVING somewhere, rather than on leaving.
   *
   * The belt's own `escape` rung is a retreat: the aim is left at the hero's own feet, which is
   * the DOUBLE-CLICK, and it resolves to the nearest hall it can reach (see `aim`). This is the
   * other press — the ONE-CLICK, aimed at a spot — and it is called by the army manager rather
   * than reached from the ladder, because it is not a reading of this hero's danger at all: it
   * is a decision about where the whole army needs to be, and only the manager knows that
   * (src/ai/plus/teamchat.ts — an ally's call for help from across the map).
   *
   * `SimWorld.nearestHall` resolves the aim to the nearest hall to that spot that this player
   * may travel to, ALLIES INCLUDED, which is the item's stated behaviour and is what makes the
   * trip land in the ally's base rather than back in ours.
   *
   * Legality is the sim's at the same two doors a press from the ladder uses, so this can never
   * be more permissive than a player's click.
   */
  portalTo(u: SimUnit, x: number, y: number): boolean {
    if (!this.canAct(u)) return false;
    for (let slot = 0; slot < u.inventory.length; slot++) {
      const held = u.inventory[slot];
      if (!held) continue;
      const def = this.view.item(held.itemId);
      if (!def?.usable) continue;
      if (!def.abilities.some((aid) => this.view.def(aid)?.code === PORTAL_ABILITY)) continue;
      if (this.view.world.itemReadyError(u.id, slot) !== null) continue;
      if (this.view.world.itemUseError(u.id, slot, 0) !== null) continue;
      return this.view.order({ c: "useitem", unitId: u.id, slot, targetId: 0, x, y });
    }
    return false;
  }

  /**
   * Is this hero carrying a Scroll of Town Portal it could press RIGHT NOW?
   *
   * Read by the caster, and by exactly one rule there: Wind Walk's defensive half is the escape
   * a hero takes when it has no scroll to leave with (plus/casting.ts `windWalk`). The scroll is
   * the better exit — it is instant, it is invulnerable for the whole channel, and it ends in the
   * base rather than somewhere on the way to it — so a hero holding one does not spend a Wind
   * Walk cooldown a beat before pressing it.
   *
   * "Could press" is `itemReadyError`, the sim's own door: a scroll on cooldown or out of
   * charges is a scroll the hero has not got.
   */
  holdsEscape(u: SimUnit): boolean {
    for (let slot = 0; slot < u.inventory.length; slot++) {
      const held = u.inventory[slot];
      if (!held) continue;
      const def = this.view.item(held.itemId);
      if (!def?.usable) continue;
      if (!def.abilities.some((aid) => this.view.def(aid)?.code === PORTAL_ABILITY)) continue;
      if (this.view.world.itemReadyError(u.id, slot) !== null) continue;
      return true;
    }
    return false;
  }

  /** The unit on a shopping errand, or 0 — see `onErrand`. */
  get errand(): number {
    return this.onErrand;
  }

  /** Let go of this unit's errand.
   *
   *  The belt marks a hero as SHOPPING so that the army manager leaves it alone on the way
   *  (`commit`, `massing`), which is right up until the walk is the thing that has gone wrong:
   *  the army's own last-resort freeze watchdog (src/ai/plus/index.ts `freezePass`) then hands
   *  the hero a new order, and without this the very next shop pass would hand the errand
   *  straight back and the two would argue for the rest of the match. */
  forget(unitId: number): void {
    if (this.onErrand === unitId) this.onErrand = 0;
  }

  /** Who does the shopping: our highest-level hero with a free slot. The best hero is the one
   *  worth keeping alive, so it is the one that carries the potions.
   *
   *  `PlusProfile.shopping` is the ceiling on how much of a belt this player will FILL, and it
   *  is a habit rather than a wallet — but a habit that is counted against everything the hero
   *  is holding, drops included. So a Normal computer that walked over two tomes and a Claws of
   *  Attack had "three items" and stopped shopping for the rest of the match, with the gold
   *  still in the bank. `rich` lifts it to the six slots the hero actually has: a player with
   *  money spare fills the belt, whatever is already in it. */
  private shopper(own: SimUnit[], rich: boolean, essential = false): SimUnit | null {
    let best: SimUnit | null = null;
    for (const u of own) {
      if (!u.isHero || !u.inventory.length || u.isIllusion) continue;
      // A hero already walking to a drop or to a shop with something to SELL is left alone: a
      // move order issued over the top of `getitem` cancels the errand and the two passes then
      // argue about the same hero for the rest of the match. Same rule `pawn` and `loot` follow.
      if (u.order === "getitem") continue;
      if (u.inventory.indexOf(null) < 0) continue; // belt full
      // …and the habit ceiling, which an ESSENTIAL buy is exempt from — see `shop`.
      const cap = rich || essential ? u.inventory.length : this.profile.shopping;
      if (u.inventory.filter((h) => h !== null).length >= cap) continue;
      if (!best || u.level > best.level) best = u;
    }
    return best;
  }

  /** The next thing to buy, and where. Walks the list in preference order and stops at the
   *  first row some reachable shop actually has on the shelf and this hero can afford — where
   *  "afford" is the whole purse for one of the race's opening buys and the surplus above
   *  `itemReserve` for everything else (`Want.opening`). */
  private pick(
    own: SimUnit[],
    gold: number,
    ctx: ItemCtx,
    rich: boolean,
    essentialOnly = false,
  ): { shopId: number; itemId: string; x: number; y: number } | null {
    const shops = this.shops(ctx);
    if (!shops.length) return null;
    for (const want of this.list(rich)) {
      if (essentialOnly && !ESSENTIAL.has(want.id)) continue;
      const purse = want.opening ? gold : gold - this.profile.itemReserve;
      const def = this.view.item(want.id);
      if (!def) continue;
      if (this.carried(own, want.id) >= want.want) continue;
      if (def.gold > purse) {
        // SAVE for a missing Town Portal rather than spend the gold on the next row down. With
        // the scroll first on the list (`hadPortal`) but 350 gold, every pass it could not be
        // paid for bought a 100-gold salve instead, and the purse never reached it — or the belt
        // filled first. Only when some shop here would actually sell one.
        if (want.id === PORTAL.id && this.profile.keepPortal && this.hadPortal && shops.some((sh) => this.stocks(sh, want.id))) return null;
        continue;
      }
      for (const shop of shops) {
        // Stock is the whole gate at a neutral shop and half of it at a race one, and both are
        // the sim's answer rather than ours: `-1` is "not stock-limited", `0` is "sold out".
        if (this.view.world.shopStock(shop.id, want.id) === 0) continue;
        if (!this.sells(shop, want.id)) continue;
        // A race shop's tech requirement — an Arcane Vault's Town Portal wants a Keep. A
        // Goblin Merchant's shelf has none, and `missingForShop` knows the difference.
        if (this.view.world.missingForShop(shop.id, want.id, this.view.player).length) continue;
        return { shopId: shop.id, itemId: want.id, x: shop.x, y: shop.y };
      }
    }
    return null;
  }

  /**
   * The shopping list this player uses — the race's own first buys (`RACE_FIRST`), then the
   * general one, with the Town Portal where `keepPortal` puts it.
   *
   * The race's rows go in FRONT of the portal rather than behind it. `pick` walks this in
   * preference order and stops at the first row it can afford, and the belt is three slots
   * deep on Normal — so anything below the first two or three rows is decoration. A row that
   * describes what a race actually opens with has to be one of them.
   *
   * Duplicates are dropped rather than deduplicated by the `carried` gate, so a row that
   * appears in both lists keeps the RACE's count rather than being asked for twice at two
   * different quantities.
   */
  private list(rich: boolean): readonly Want[] {
    const first = (RACE_FIRST[this.race] ?? []).map((w) => ({ ...w, opening: true }));
    // …and the race's MANA, which is bought out of the purse for the same reason but sits one
    // place further down: BEHIND the scroll. A hero with an empty bar has lost its spells; a
    // hero with no Town Portal loses the army, and that is the bigger loss (`PORTAL`).
    const mana = (RACE_MANA[this.race] ?? []).map((w) => ({ ...w, opening: true }));
    const fight = FIGHT;
    const seen = new Set([...first, ...fight, ...mana].map((w) => w.id));
    const rest = LIST.filter((w) => !seen.has(w.id));
    // WHERE THE PORTAL SITS DEPENDS ON WHETHER THIS PLAYER HAS EVER HAD ONE.
    //
    // Two rules that both have a match behind them, and they are about different halves of it:
    //
    //  · the OPENING is the race's. `RACE_FIRST` leads, for the reason it gives — the orc's two
    //    Healing Salves are what put the army back together between the first creep camps, and
    //    a row the three-slot belt never reaches is a row that does not exist.
    //  · a REPLACEMENT is not shopping, it is the first thing on the list. Reported: the hero
    //    used its scroll and never bought another. `RACE_FIRST`'s rows re-satisfy themselves
    //    every time they are drunk — a salve is 100 gold against the scroll's 350 — so behind
    //    them the portal row was reached only in the gaps, and on Normal the belt filled up
    //    before it ever was (see `shop` for the ceiling that closed the last of it).
    //
    // `hadPortal` is the latch between the two, and it says exactly what it means: this player
    // is one that PLANS around carrying a scroll, which is `keepPortal`'s own words, and is
    // only demonstrably true once one has been in the belt.
    // …AND A REPLACEMENT SCROLL IS BOUGHT OUT OF THE PURSE, not out of the surplus.
    //
    // Reported again, after the ordering above had already been fixed: the AI *"is still not
    // re-buying Scroll of Town Portal when able to / is available. it does sometimes but not
    // very often."* Being FIRST on the list is no use while the row cannot be paid for, and the
    // arithmetic is stark — the scroll is 350 gold (`[stwp] goldcost`) and an ordinary row is
    // bought out of `gold − itemReserve`, so a Normal computer needed **650 gold in hand at the
    // instant the five-second shopping pass looked**, and an Insane one 550. That is a purse a
    // melee computer sees for a few seconds at a time, which is exactly "sometimes but not very
    // often".
    //
    // `Want.opening` is the answer already written for the race's first buys and its argument is
    // the same one this file makes two paragraphs up: *a replacement is not shopping*. The gold
    // floor exists so that the shop cannot eat the build order's money — and a player who plans
    // around carrying a Town Portal (`keepPortal`) buys the next one out of the same pocket the
    // build order comes from, because at that price and that value it IS part of the build
    // order. Only under `keepPortal`, so a difficulty that does not plan around one still picks
    // it up merely with what is spare.
    const portal = this.profile.keepPortal ? { ...PORTAL, opening: true } : PORTAL;
    const core = this.profile.keepPortal && this.hadPortal
      ? [portal, ...first, ...fight, ...mana, ...rest]
      : this.profile.keepPortal
        ? [...first, portal, ...fight, ...mana, ...rest]
        : [...first, ...fight, ...mana, ...rest, portal];
    if (!rich) return core;
    // The surplus rows go on the END, never in front: they are the same items wanted DEEPER
    // (`RICH`), so reaching them at all means every row above is already satisfied. The race's
    // own surplus habit leads them, for the reason `RACE_FIRST` leads the core list — a row the
    // ladder never reaches is a row that does not exist, and `pick` stops at the first one it
    // can act on.
    return [...core, ...(RACE_SURPLUS[this.race] ?? []), ...RICH];
  }

  /** How many of an item our heroes are already carrying. Counted across ALL of them: two
   *  heroes with a Town Portal each is one wasted, and the second hero's slot is better spent. */
  private carried(own: SimUnit[], itemId: string): number {
    let n = 0;
    for (const u of own) for (const held of u.inventory) if (held?.itemId === itemId) n++;
    return n;
  }

  /** Shops we may buy at and would walk to: alive, not hostile (a Goblin Merchant is Neutral
   *  Passive, our own Vault is ours, an ally's is shoppable), and near enough to home that the
   *  errand is worth a hero's time. */
  private shops(ctx: ItemCtx): SimUnit[] {
    const out: SimUnit[] = [];
    for (const u of this.view.world.units.values()) {
      if (u.hp <= 0 || !u.building || this.view.hostile(u)) continue;
      if (u.building.constructionLeft > 0) continue;
      // "May we trade here at all" is the sim's own question, and asking it rather than
      // merely "is it hostile" is what keeps a hero from walking across the map to a counter
      // that will refuse him — a non-hostile NEUTRAL player's shop is nobody's ally.
      if (!this.view.world.canUseShop(u.id, this.view.player)) continue;
      if (Math.hypot(u.x - ctx.home.x, u.y - ctx.home.y) > SHOP_REACH) continue;
      out.push(u);
    }
    // OUR OWN SHOP FIRST, then everything else nearest-first.
    //
    // A race shop is in the base, so the errand is a few seconds rather than a trek, and it is
    // the one shelf that cannot be emptied by the other player — a Goblin Merchant is shared,
    // and it restocks on the GAME clock rather than per buyer. So the Vault/Lounge/Ancient of
    // Wonders/Tomb is where a Town Portal gets replaced, and the Merchant is the fallback for a
    // map where there is one and we have not built ours (or it stocks something ours does not:
    // the Scroll of Healing and the Potion of Lesser Invulnerability are Merchant-only for
    // three of the four races).
    const mine = (u: SimUnit): number => (u.owner === this.view.player ? 0 : 1);
    out.sort(
      (a, b) =>
        mine(a) - mine(b) ||
        Math.hypot(a.x - ctx.home.x, a.y - ctx.home.y) - Math.hypot(b.x - ctx.home.x, b.y - ctx.home.y),
    );
    return out;
  }

  /** Would this shop sell us this item right now — on its shelf, in stock, its tech met? */
  private stocks(shop: SimUnit, itemId: string): boolean {
    return this.view.world.shopStock(shop.id, itemId) !== 0 && this.sells(shop, itemId)
      && !this.view.world.missingForShop(shop.id, itemId, this.view.player).length;
  }

  /** Is this ware on this shop's shelf? The catalogue from the tech row, plus whatever a
   *  script has stocked — a Marketplace carries no `Sellitems` at all and is entirely the
   *  latter (docs/computer-plus.md). */
  private sells(shop: SimUnit, itemId: string): boolean {
    if (this.view.wares(shop.typeId).includes(itemId)) return true;
    return (shop.building?.stock?.has(itemId) ?? false);
  }
}
