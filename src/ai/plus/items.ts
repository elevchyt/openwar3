import type { AbilityDef } from "../../data/abilities";
import type { ItemDef } from "../../data/items";
import type { PlayableRace } from "../../data/races";
import { ITEM_REGEN_GROUP, type SimUnit } from "../../sim/world";
import { near, type CasterView } from "../casting";
import type { PlusProfile } from "./profile";

// Computer+ — buying items, and pressing them (issue #124, issue #130).
//
// The hole docs/computer-plus.md used to describe as "Items: not yet". Nothing in `src/ai/`
// bought from a shop or drank anything: a Computer+ hero picked up what it walked over and
// carried it to the grave. This is the AI's half, and it is deliberately built on exactly the
// doors a player's click goes through — there is no item path here that a human does not have.
//
// Three facts about items shape the whole file, and all three are docs/items.md's:
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
export type Use = "escape" | "panic" | "healSelf" | "healArea" | "healOther" | "mana" | "illusion" | "buff";

const LADDER: readonly Use[] = ["escape", "panic", "healSelf", "healArea", "healOther", "mana", "illusion", "buff"];
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
 *     AIpr    Clarity Potion              neither, DataB mana only   the drinker   -> mana
 *     AIp1-4  Replenishment Potion        neither, DataA hp          the drinker   -> healSelf
 *
 * The last two are told apart by which column the row FILLS — a Clarity Potion is 200 mana and
 * no hit points, a Replenishment Potion is both — because "what is it for" is the question the
 * ladder sorts on, and a mana item pressed as a heal is pressed at the wrong moment.
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
  return hp > 0 ? "healSelf" : lvl.data[1] > 0 ? "mana" : null;
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
  { id: "phea", want: 2 },
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
  { id: "spro", want: 1 }, // Scroll of Protection (Merchant)
];

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
 * The undead and the night elf have no equivalent first buy — the Tomb and the Ancient of
 * Wonders both open on the potions `LIST` already starts with — so they stay unlisted rather
 * than being given an invented habit.
 */
const RACE_FIRST: Partial<Record<PlayableRace, readonly Want[]>> = {
  orc: [{ id: "hslv", want: 2 }],
  human: [{ id: "sreg", want: 2 }],
};

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
/** …and at which it drinks. Higher, because a potion heals over time and a hero that waits for
 *  `PANIC_HP` to drink one has usually waited too long. */
const HURT_HP = 0.55;
/** How hurt somebody else has to be to be worth a Healing Salve. */
const ALLY_HP = 0.5;
/** How many of ours have to be hurt before an AREA heal is better than a potion. Below this the
 *  scroll is being spent to heal one unit, which is what the potion is for. */
const CLUSTER = 3;
/**
 * …and how hurt the PARTY has to be, pooled, before an area heal is worth its charge.
 *
 * Ours, like everything else in this block. Higher than `HURT_HP` (the line one unit drinks a
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
/** Mana fraction that sends a caster to the bottom of a Clarity Potion. */
const MANA_LOW = 0.35;
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
/** How far from home a shop has to be before it is not worth the walk. A Goblin Merchant across
 *  the map is a hero out of the game for a minute, which is worse than having no potion. */
const SHOP_REACH = 4000;

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
   * It gates only the `escape` rung's ARMY half. A hero that is personally about to die still
   * scrolls out whatever it is fighting — a dead hero is a dead hero, and the camp is not a
   * reason to lose one.
   */
  portalWorthIt: boolean;
  /** May a hero walk off to a shop right now? False while there is a wave in the field, so the
   *  trip never pulls the captain out of a fight. */
  mayShop: boolean;
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

  constructor(
    private readonly view: ItemView,
    private readonly profile: PlusProfile,
    /** Whose shelf this is shopping from — see `RACE_FIRST`. */
    private readonly race: PlayableRace,
  ) {}

  pass(now: number, ctx: ItemCtx): void {
    const own: SimUnit[] = [];
    const foes: SimUnit[] = [];
    for (const u of this.view.world.units.values()) {
      if (u.hp <= 0) continue;
      if (u.owner === this.view.player) own.push(u);
      else if (this.view.hostile(u)) foes.push(u);
    }
    for (const u of own) {
      if (!u.inventory.length || !this.canAct(u)) continue;
      this.press(u, own, foes, ctx);
    }
    this.loot(now, own, foes);
    this.shop(now, own, ctx);
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
   * It runs on the belt's own clock rather than a slower one because it is the same kind of
   * decision the belt makes and it is cheap — the ground-item table is a handful of entries on
   * a melee map.
   */
  private loot(now: number, own: SimUnit[], foes: SimUnit[]): void {
    if (now - this.lastLoot < LOOT_PERIOD) return;
    this.lastLoot = now;
    const ground = [...this.view.world.items.values()];
    if (!ground.length) return;
    // Heroes only, and the errand runner is left alone — it is walking to a shop.
    const heroes = own.filter((u) => u.isHero && u.inventory.length && !u.isIllusion && this.canAct(u));
    if (!heroes.length) return;
    const taken = new Set<number>();
    for (const it of ground) {
      const def = this.view.item(it.itemId);
      if (!def) continue;
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
      taken.add(best.id);
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
  private press(u: SimUnit, own: SimUnit[], foes: SimUnit[], ctx: ItemCtx): boolean {
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
      if (!this.wants(u, card.use, card.def, own, foes, engaged, ctx)) continue;
      if (this.aim(u, card.slot, card.def, card.use, own)) return true;
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
  private wants(u: SimUnit, use: Use, def: ItemDef, own: SimUnit[], foes: SimUnit[], engaged: boolean, ctx: ItemCtx): boolean {
    const hp = u.hp / Math.max(1, u.maxHp);
    switch (use) {
      // The retreat, in one press. Either the ARMY has decided it is losing (`ctx.losing` is the
      // manager's own read, so the scroll and the walk home are one decision) or this hero alone
      // is about to die in a fight — which is the same conclusion reached about a smaller group.
      // Never within sight of home, where it would be spent to travel no distance.
      case "escape": {
        if (!engaged && !ctx.losing) return false;
        if (Math.hypot(u.x - ctx.home.x, u.y - ctx.home.y) <= HOME) return false;
        // The hero's OWN skin is unconditional — see `portalWorthIt`. The ARMY's retreat only
        // spends the scroll on a retreat worth spending it on, which is a player's army and
        // never a creep camp.
        if (hp < ESCAPE_HP) return true;
        return ctx.losing && ctx.portalWorthIt;
      }
      case "panic":
        return engaged && hp < PANIC_HP;
      case "healSelf":
        return engaged && hp < HURT_HP;
      // An area heal is worth a charge when it is healing a GROUP — see `armyHeal`, which is
      // where the three questions it actually asks live.
      //
      // These two are the ONLY rungs not gated on `engaged`, and it is deliberate: they are the
      // ones aimed at somebody ELSE, and a Scroll of Regeneration or a Healing Salve pours over
      // forty-five seconds. Spending one while the blows are still landing is spending it into
      // the damage; the moment it is worth is the moment the camp is dead and the party is about
      // to walk to the next one — which is the job the shopping list says it bought them for
      // ("what puts an army back together between creep camps", see `LIST`).
      case "healArea":
        return this.armyHeal(u, own, this.areaOf(def));
      case "healOther":
        return !!this.hurtest(u, own);
      // Mana is topped up for the fight, not during the panic — a hero with no mana is a hero
      // whose spells are the reason the army is winning, so this fires as the fight starts as
      // well as inside one.
      case "mana":
        return u.maxMana > 0 && u.mana / u.maxMana < MANA_LOW && (engaged || foes.some((f) => near(u, f, LOOK * 2)));
      // Another body, for a fight big enough that another body decides it. Gated exactly as the
      // buff below is — one scout walking past is not a fight — plus the cap on how many doubles
      // may be standing at once, which is what keeps the wand's three charges from going into
      // the first skirmish of the match (`ILLUSION_CAP`).
      //
      // This is the IN-FIGHT press. The other one is the army manager's, made a few seconds
      // BEFORE a creep camp so the doubles walk in ahead of the party — see `makeIllusions`.
      case "illusion":
        return engaged && this.realFight(u, foes) >= CLUSTER && this.doubles(own) < ILLUSION_CAP;
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
  private aim(u: SimUnit, slot: number, def: ItemDef, use: Use, own: SimUnit[]): boolean {
    // The aimed ability itself rather than only its `target`, because one rung needs the row's
    // own `Rng1` as well: the Wand of Illusion reaches 500 (`[AIil] Rng1`), and a copy chosen
    // out of that is a press `itemUseError` throws away.
    const aimed = def.abilities.map((aid) => this.view.def(aid)).find((ad) => ad?.target === "point" || ad?.target === "unit");
    let targetId = 0;
    if (aimed?.target === "unit") {
      const t =
        use === "healOther" ? this.hurtest(u, own)
        : use === "illusion" ? this.toCopy(u, own, aimed.levelData[0]?.castRange ?? 0)
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
   */
  private armyHeal(u: SimUnit, own: SimUnit[], radius: number): boolean {
    let party = 0;
    let covered = 0;
    let hp = 0;
    let maxHp = 0;
    for (const o of own) {
      // The ARMY: what fights. Buildings, workers and the doubles are none of it — an illusion
      // arrives at full health, takes double damage and is meant to die (docs/illusions.md), so
      // counting it would price the party as healthier than it is and put it in the denominator
      // of a question about where the real army is standing.
      if (o.building || o.isPeon || o.isIllusion || o.hp <= 0) continue;
      party++;
      if (!near(u, o, radius)) continue;
      // Somebody already pouring is not somebody this charge would help — see `regenerating`.
      // It stays in the PARTY (it is still a body the circle has to be drawn around) but not
      // in what the circle COVERS, so a second scroll cannot follow the first over the same
      // party a second later.
      if (this.regenerating(o)) continue;
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

  /** The most hurt of ours in reach — who a Healing Salve goes on. Buildings and workers are
   *  left out for the same reason the army leaves them out: the salve is for the fight. */
  private hurtest(u: SimUnit, own: SimUnit[]): SimUnit | null {
    let best: SimUnit | null = null;
    let worst = ALLY_HP;
    for (const o of own) {
      if (o.building || o.isPeon || !near(u, o, LOOK)) continue;
      if (this.regenerating(o)) continue; // already pouring — see `regenerating`

      const frac = o.hp / Math.max(1, o.maxHp);
      if (frac < worst) {
        worst = frac;
        best = o;
      }
    }
    return best;
  }

  /**
   * WHO THE WAND COPIES — the biggest body in reach, and the presser itself when there is none.
   *
   * `[AIil] targs1` is "ground,air,friend,self", so the double is made of one of OURS, and the
   * copy arrives at FULL hit points however hurt the original is (`initIllusion`, docs/
   * illusions.md). What the double is FOR is soaking blows that would otherwise land on the
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
  private toCopy(u: SimUnit, own: SimUnit[], range: number): SimUnit {
    let best = u; // the presser is always in range of itself, so there is always an answer
    for (const o of own) {
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
    for (const o of this.view.world.units.values()) {
      if (o.hp > 0 && o.owner === this.view.player) own.push(o);
    }
    const standing = this.doubles(own);
    let made = 0;
    while (standing + made < cap) {
      const slot = this.illusionSlot(u);
      if (slot < 0) break; // no wand, out of charges, or cooling down
      const def = this.view.item(u.inventory[slot]!.itemId);
      if (!def || !this.aim(u, slot, def, "illusion", own)) break;
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
    const hero = this.shopper(own);
    if (!hero) return void (this.onErrand = 0);
    // The whole purse, not the surplus: `pick` applies `itemReserve` per ROW, because the
    // race's opening buys are not discretionary spending — see `Want.opening`.
    const buy = this.pick(own, this.view.gold(), ctx);
    if (!buy) return void (this.onErrand = 0); // nothing left worth walking for
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

  /** Who does the shopping: our highest-level hero with a free slot. The best hero is the one
   *  worth keeping alive, so it is the one that carries the potions. */
  private shopper(own: SimUnit[]): SimUnit | null {
    let best: SimUnit | null = null;
    for (const u of own) {
      if (!u.isHero || !u.inventory.length || u.isIllusion) continue;
      if (u.inventory.indexOf(null) < 0) continue; // belt full
      if (u.inventory.filter((h) => h !== null).length >= this.profile.shopping) continue;
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
  ): { shopId: number; itemId: string; x: number; y: number } | null {
    const shops = this.shops(ctx);
    if (!shops.length) return null;
    for (const want of this.list()) {
      const purse = want.opening ? gold : gold - this.profile.itemReserve;
      const def = this.view.item(want.id);
      if (!def || def.gold > purse) continue;
      if (this.carried(own, want.id) >= want.want) continue;
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
  private list(): readonly Want[] {
    const first = (RACE_FIRST[this.race] ?? []).map((w) => ({ ...w, opening: true }));
    const seen = new Set(first.map((w) => w.id));
    const rest = LIST.filter((w) => !seen.has(w.id));
    return this.profile.keepPortal ? [...first, PORTAL, ...rest] : [...first, ...rest, PORTAL];
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
      if (!this.view.world.isShopUnit(u.id)) continue;
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

  /** Is this ware on this shop's shelf? The catalogue from the tech row, plus whatever a
   *  script has stocked — a Marketplace carries no `Sellitems` at all and is entirely the
   *  latter (docs/computer-plus.md). */
  private sells(shop: SimUnit, itemId: string): boolean {
    if (this.view.wares(shop.typeId).includes(itemId)) return true;
    return (shop.building?.stock?.has(itemId) ?? false);
  }
}
