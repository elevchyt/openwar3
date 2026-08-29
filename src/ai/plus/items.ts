import type { ItemDef } from "../../data/items";
import type { SimUnit } from "../../sim/world";
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
export type Use = "escape" | "panic" | "healSelf" | "healArea" | "healOther" | "mana" | "buff";

const LADDER: readonly Use[] = ["escape", "panic", "healSelf", "healArea", "healOther", "mana", "buff"];
const useRank = (u: Use): number => LADDER.indexOf(u);

/**
 * Ability code → what pressing it is for. Every code here was read off `ItemData.slk`'s
 * `abilList` for an item that is `usable`; anything not listed is CARRIED and never pressed,
 * which is the safe direction to be wrong in.
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
  AIvl: "panic", // Potion of Lesser Invulnerability (the one the Goblin Merchant stocks)
  AIvu: "panic", // Potion of Invulnerability
  AIdv: "panic", // Potion of Divinity

  // --- hit points, on the drinker ----------------------------------------------------------
  AIh1: "healSelf", // Potion of Healing
  AIh2: "healSelf", // Potion of Greater Healing / Health Stone
  AIh3: "healSelf", // Essence of Aszune
  AIre: "healSelf", // Potion of Restoration
  AIp1: "healSelf", // Minor / Lesser / … Replenishment Potion — hit points AND mana, on the user
  AIp2: "healSelf",
  AIp3: "healSelf",
  AIp4: "healSelf",

  // --- hit points, on an AREA around the user ----------------------------------------------
  AIha: "healArea", // Scroll of Healing
  AIsl: "healArea", // Scroll of Regeneration
  AIra: "healArea", // Scroll of Restoration
  AIp5: "healArea", // Lesser / Greater Scroll of Replenishment
  AIp6: "healArea",

  // --- hit points, on somebody you point at -------------------------------------------------
  AIrl: "healOther", // Healing Salve — the one regeneration item you aim (docs/items.md)

  // --- mana ---------------------------------------------------------------------------------
  AIm1: "mana", // Potion of Mana
  AIm2: "mana", // Potion of Greater Mana / Mana Stone
  AIpr: "mana", // Clarity Potion
  AIpl: "mana", // Lesser Clarity Potion
  AImr: "mana", // Scroll of Mana

  // --- make the fight better ----------------------------------------------------------------
  AIda: "buff", // Scroll of Protection
  AIsa: "buff", // Scroll of Speed
  AIsp: "buff", // Potion of Speed
  AIrr: "buff", // Scroll of the Beast
};

/** One row of the shopping list: what to buy, and how many of it to carry. */
interface Want {
  readonly id: string;
  readonly want: number;
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

/** Where the Town Portal sits in that list. `keepPortal` puts it FIRST — a player who plans
 *  around having one buys it before the potions, because the potions are no use if the army
 *  it would have saved is dead. Without the habit it is merely the last thing it gets round to. */
const PORTAL: Want = { id: "stwp", want: 1 };

/** The Scroll of Town Portal's ability, keyed on the ABILITY rather than on the item id for the
 *  same reason `USE_OF` is: a custom map's re-skinned scroll is still a Town Portal. */
const PORTAL_ABILITY = "AItp";

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
/** Mana fraction that sends a caster to the bottom of a Clarity Potion. */
const MANA_LOW = 0.35;
/** The radius everything here calls "this fight" — the same figure plus/casting.ts engages at. */
const LOOK = 900;
/** How close to home is close enough that a Town Portal would be spent on nothing. */
const HOME = 1200;
/** Seconds between shopping trips. A player checks the shop occasionally; they do not stand in
 *  it. Also what keeps a hero from being re-ordered towards a shop every army pass. */
const SHOP_PERIOD = 5;
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

  constructor(
    private readonly view: ItemView,
    private readonly profile: PlusProfile,
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
    this.shop(now, own, ctx);
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
      if (!this.wants(u, card.use, own, foes, engaged, ctx)) continue;
      if (this.aim(u, card.slot, card.def, card.use, own)) return true;
    }
    return false;
  }

  /** The item's own primary `Use`: the first ability in its `abilList` that names one. Keyed on
   *  the ability rather than the item, so a custom map's re-skinned potion is played. */
  private useOf(def: ItemDef): Use | null {
    for (const aid of def.abilities) {
      const ad = this.view.def(aid);
      const use = ad && USE_OF[ad.code];
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
  private wants(u: SimUnit, use: Use, own: SimUnit[], foes: SimUnit[], engaged: boolean, ctx: ItemCtx): boolean {
    const hp = u.hp / Math.max(1, u.maxHp);
    switch (use) {
      // The retreat, in one press. Either the ARMY has decided it is losing (`ctx.losing` is the
      // manager's own read, so the scroll and the walk home are one decision) or this hero alone
      // is about to die in a fight — which is the same conclusion reached about a smaller group.
      // Never within sight of home, where it would be spent to travel no distance.
      case "escape":
        if (!engaged && !ctx.losing) return false;
        if (Math.hypot(u.x - ctx.home.x, u.y - ctx.home.y) <= HOME) return false;
        return ctx.losing || hp < ESCAPE_HP;
      case "panic":
        return engaged && hp < PANIC_HP;
      case "healSelf":
        return engaged && hp < HURT_HP;
      // An area heal is worth a charge when it is healing a GROUP. Below `CLUSTER` it is being
      // spent to do a potion's job, and the potion is one rung down.
      case "healArea":
        return engaged && this.hurtNear(u, own, HURT_HP) >= CLUSTER;
      case "healOther":
        return engaged && !!this.hurtest(u, own);
      // Mana is topped up for the fight, not during the panic — a hero with no mana is a hero
      // whose spells are the reason the army is winning, so this fires as the fight starts as
      // well as inside one.
      case "mana":
        return u.maxMana > 0 && u.mana / u.maxMana < MANA_LOW && (engaged || foes.some((f) => near(u, f, LOOK * 2)));
      // A buff is pre-fight, and only for a fight worth buffing: one scout walking past is not.
      case "buff":
        return engaged && foes.filter((f) => !f.building && !f.isPeon && near(u, f, LOOK)).length >= CLUSTER;
    }
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
    const target = def.abilities.map((aid) => this.view.def(aid)?.target).find((t) => t === "point" || t === "unit");
    let targetId = 0;
    if (target === "unit") {
      const t = use === "healOther" ? this.hurtest(u, own) : u;
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

  /** How many of ours near this unit are below `frac` of their own maximum. */
  private hurtNear(u: SimUnit, own: SimUnit[], frac: number): number {
    let n = 0;
    for (const o of own) {
      if (o.building || o.isPeon || !near(u, o, LOOK)) continue;
      if (o.hp / Math.max(1, o.maxHp) < frac) n++;
    }
    return n;
  }

  /** The most hurt of ours in reach — who a Healing Salve goes on. Buildings and workers are
   *  left out for the same reason the army leaves them out: the salve is for the fight. */
  private hurtest(u: SimUnit, own: SimUnit[]): SimUnit | null {
    let best: SimUnit | null = null;
    let worst = ALLY_HP;
    for (const o of own) {
      if (o.building || o.isPeon || !near(u, o, LOOK)) continue;
      const frac = o.hp / Math.max(1, o.maxHp);
      if (frac < worst) {
        worst = frac;
        best = o;
      }
    }
    return best;
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
    const purse = this.view.gold() - this.profile.itemReserve;
    if (purse <= 0) return void (this.onErrand = 0);
    const hero = this.shopper(own);
    if (!hero) return void (this.onErrand = 0);
    const buy = this.pick(own, purse, ctx);
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
   *  first row some reachable shop actually has on the shelf and this hero can afford. */
  private pick(
    own: SimUnit[],
    purse: number,
    ctx: ItemCtx,
  ): { shopId: number; itemId: string; x: number; y: number } | null {
    const shops = this.shops(ctx);
    if (!shops.length) return null;
    for (const want of this.list()) {
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

  /** The shopping list this difficulty uses — see `PORTAL` for what `keepPortal` moves. */
  private list(): readonly Want[] {
    return this.profile.keepPortal ? [PORTAL, ...LIST] : [...LIST, PORTAL];
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
