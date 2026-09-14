import type { ChatLine } from "../../../game/chat";
import { MELEE } from "../../../data/gameplayConstants";
import { PrimaryAttribute } from "../../../data/enums";
import type { SimUnit } from "../../../sim/world";
import { PlusCaster } from "../casting";
import type { PlusHost } from "../index";
import { PlusItems, type ItemCtx } from "../items";
import { plusProfile, type PlusProfile } from "../profile";
import {
  ACK_LINES, ANKH_BOUGHT_LINES, ANKH_USED_LINES, DEAD_LINES, GOING_HURT_LINES, NO_ANKH_LINES, READY_LINES,
  REST_HP_LINES, REST_MANA_LINES, REST_TALK_GAP, TALK_GAP,
  leaderLines, namesHero, pickLines, readCommand, type Command,
} from "./chat";
import { ANKH_VALUE, isAnkh, wantsItem, worstSlot, type ItemEye } from "./items";
import {
  DUNGEON, FOUNTAIN, KEYS, PICKS, PICK_AISLE_X, PICK_OF, SHOPS, SKILLS, TANK, TANK_ENTER, TANK_LEAVE, WISP,
  centre, dist, type HeroPick, type Pt, type Role,
} from "./map";
import { warChasersProfile, type WarChasersProfile } from "./profile";

// Computer+ on WarChasers — a PARTY MEMBER for Blizzard's co-operative dungeon crawl.
//
// `(4)WarChasers.w3m` is a scenario for four people against the dungeon, and a computer seat in it
// has nothing to play in the real game: no script seats an AI, and the dungeon cannot be walked
// without knowing where the party is going. Computer+ plays the seat the one way that works on a
// map like this — it FOLLOWS a person (the LEADER) and is a good party member around them. What
// that means, from the developer's brief, and where each part lives (docs/warchasers-ai.md):
//
//  1. PICK a hero — through the map's own picker, by walking the seat's wisp onto a pedestal
//     (`pickPass`), for the PARTY: a healer if there is none, a front line if there is none.
//  2. FOLLOW the leader and FIGHT beside them — the leader's target first, then whatever is hitting
//     the party (`fightPass`, `followPass`), through gates, waygates and the tank ride.
//  3. OBEY the party in chat — "wait", "back", "lets go", "follow me", "attack" (chat.ts
//     `readCommand`, typos and all) — and an order OVERRIDES what it had decided for itself.
//  4. REST when it needs to, and SAY so ("wait i need a bit more health") — and say when it is
//     ready again ("right behind you").
//  5. CAST everything it has, heals on the party included (the melee Computer+ caster), and drink
//     what it carries (the melee Computer+ belt).
//  6. LOOT — pick up what is worth carrying, and drop the least useful thing for something better,
//     by what the item is worth to ITS hero (items.ts): an intelligence hero gives up Strength first.
//  7. SHOP when a shop is at hand — an Ankh of Reincarnation before anything else, because a hero
//     that dies without one is gone for good (`Game_Over`).
//
// The standing rules of every Computer+ player hold: authority-side only, every decision leaves
// through `PlusHost.execute` (the door a person's click goes through), and no cheats at any rung.

/** What the party last told it to do. `rest` is not here: resting is its own decision, and an order
 *  is what overrides it. */
type Stance = "follow" | "wait" | "back" | "attack";

interface Brain {
  player: number;
  profile: WarChasersProfile;
  plus: PlusProfile;
  rng: () => number;
  clock: number;
  thinkIn: number;
  castIn: number;
  caster: PlusCaster;
  belt: PlusItems;
  // --- the pick
  pick: HeroPick | null;
  pickAt: number;
  pickSince: number;
  heroId: number;
  // --- the party
  stance: Stance;
  stanceSince: number;
  holdAt: Pt | null;
  /** Until when an order from the party overrides its own decision to rest. */
  obeyUntil: number;
  resting: "hp" | "mana" | null;
  target: number;
  targetAt: number;
  /** When a monster first came into this fight — `WarChasersProfile.react` is measured from it. */
  fightSince: number;
  // --- items
  lootId: number;
  lootDrop: number;
  lootAt: number;
  dropped: Map<number, number>;
  shopTried: Map<string, number>;
  errandUntil: number;
  ankhs: number;
  // --- orders and talk
  orderKey: string;
  orderAt: number;
  spokeAt: number;
  restSaidAt: number;
  leaderSaid: number;
  dead: boolean;
  queue: Array<{ command: Command; turn: number; claimsLead: boolean }>;
  replies: Array<{ at: number; lines: readonly string[] }>;
}

/** What one body sees around itself this pass. */
interface Sense {
  foes: SimUnit[];
  friends: SimUnit[];
}

/** How far a party member looks for monsters. */
const LOOK = 1400;
/** Around the LEADER, what counts as the party's fight. */
const LEADER_FIGHT = 850;
/** Around ITSELF, what it answers on its own. */
const SELF_FIGHT = 550;
/** How far from the leader a target may drag it before it lets go (an `attack` order doubles it). */
const LEASH = 1150;
/** How long an order from the party overrides its own decision to rest. */
const OBEY_HOLD = 45;
/** How long "attack" stays aggressive before it settles back into following. */
const ATTACK_HOLD = 40;
/** How long "back" walks out before it turns into a wait. */
const BACK_HOLD = 5;
/** A wait the leader has walked away from: this far, for this long, and it comes after them. */
const WAIT_ABANDON = 2600;
const WAIT_ABANDON_AFTER = 12;
/** The gap it keeps behind the leader, plus a step per party member so they do not stack. */
const FOLLOW_GAP = 190;
const FOLLOW_STEP = 90;
/** Items: how far it walks for one, and how far from the leader it may be. */
const LOOT_REACH = 700;
const LOOT_LEASH = 1300;
/** A shop is "at hand" within this of the hero, while the leader is within `SHOP_LEASH` of it. */
const SHOP_NEAR = 1300;
const SHOP_LEASH = 2200;
/** The least an item has to be worth to its hero (items.ts `itemValue`) to be bought rather than found. */
const SHOP_WORTH = 8;
/** An errand gives up after this long. */
const ERRAND = 20;
/** Seconds before a failed purchase is tried again. */
const BUY_RETRY = 25;
/** An item it has just dropped is not picked back up for this long. */
const DROP_FORGET = 60;
/** A resting hero trails a leader who has walked further than this rather than rest alone. */
const REST_TRAIL = 1150;
/** Below this, with no Ankh, it backs off whatever it was told (`NO_ANKH_LINES`). */
const NO_ANKH_FLOOR = 0.15;
/** Seconds between two computers answering the same order, so a party of three is not one voice. */
const REPLY_STAGGER = 1.1;

export class WarChasersAi {
  private readonly brains: Brain[] = [];
  /** The seat the party follows — a person's, taken by "follow me" and otherwise the first person
   *  seated. Null until anybody is. */
  private leaderSeat: number | null = null;
  private frame: SimUnit[] | null = null;

  constructor(private readonly host: PlusHost) {}

  get active(): boolean {
    return this.brains.length > 0;
  }

  add(player: number, difficulty: number, seed: number): void {
    if (this.brains.some((b) => b.player === player)) return;
    const rng = mulberry32((seed ^ Math.imul(player + 7, 0x9e3779b1)) >>> 0);
    const plus = plusProfile(difficulty);
    const allied = (u: SimUnit): boolean => u.owner !== player && this.alliedSeat(player, u.owner);
    const hostile = (u: SimUnit): boolean => this.hostileTo(player, u);
    const order = (cmd: Parameters<PlusHost["execute"]>[1]): boolean => this.host.execute(player, cmd);
    const view = { world: this.host.world, player, def: (id: string) => this.host.abilities.get(id), hostile, allied, order };
    this.brains.push({
      player, profile: warChasersProfile(difficulty), plus, rng,
      clock: 0, thinkIn: rng() * 0.5, castIn: rng() * plus.castPeriod,
      caster: new PlusCaster(view, plus, rng),
      // The belt is the melee Computer+'s: when to drink is the same question on every map. Its race
      // only picks a melee shopping list, which `beltPass` never reads.
      belt: new PlusItems({
        ...view,
        item: (id) => this.host.items.get(id),
        wares: (typeId) => this.host.tech.get(typeId).sellitems,
        gold: () => this.host.world.stashOf(player).gold,
      }, plus, "human"),
      pick: null, pickAt: 8 + this.brains.length * 4 + rng() * 3, pickSince: 0, heroId: 0,
      stance: "follow", stanceSince: 0, holdAt: null, obeyUntil: 0, resting: null,
      target: 0, targetAt: -Infinity, fightSince: -1,
      lootId: 0, lootDrop: -1, lootAt: -Infinity, dropped: new Map(), shopTried: new Map(), errandUntil: 0, ankhs: -1,
      orderKey: "", orderAt: -Infinity, spokeAt: -Infinity, restSaidAt: -Infinity, leaderSaid: -1, dead: false,
      queue: [], replies: [],
    });
  }

  reset(): void {
    this.brains.length = 0;
    this.leaderSeat = null;
  }

  tick(dt: number): void {
    this.frame = null;
    for (const b of this.brains) {
      b.clock += dt;
      this.speakPass(b);
      b.thinkIn -= dt;
      b.castIn -= dt;
      if (b.thinkIn > 0) continue;
      b.thinkIn = b.profile.think;
      this.think(b);
    }
  }

  /**
   * A line was said and `recipients` heard it. Only a PERSON on the party is obeyed — never another
   * computer, whose "wait i need a bit more health" is news about itself — and nothing is acted on
   * here, in the middle of chat delivery: the order is parked and read on each brain's next pass.
   */
  heard(line: ChatLine, recipients: readonly number[]): void {
    if (this.brains.some((b) => b.player === line.from)) return;
    const heard = readCommand(line.text);
    if (!heard) return;
    const party = this.brains.filter((b) => recipients.includes(b.player) && this.alliedSeat(b.player, line.from));
    if (!party.length) return;
    // A line that NAMES one of the computers' heroes ("optimus wait") is for those alone.
    const named = party.filter((b) => b.pick && namesHero(line.text, b.pick.name));
    const to = named.length ? named : party;
    if (heard.claimsLead) this.leaderSeat = line.from;
    to.forEach((b, turn) => b.queue.push({ command: heard.command, turn, claimsLead: heard.claimsLead }));
  }

  // ==========================================================================================
  //  One pass
  // ==========================================================================================

  private think(b: Brain): void {
    const body = this.bodyOf(b.player);
    if (!body) {
      if (!b.heroId) return void this.pickPass(b);
      if (!b.dead && !this.units().some((u) => u.owner === b.player && u.isHero && u.hp > 0)) {
        b.dead = true;
        this.say(b, DEAD_LINES);
      }
      return;
    }
    const hero = body.typeId === TANK ? null : body;
    if (hero) {
      this.learnPass(b, hero);
      this.ankhPass(b, hero);
    }
    const leader = this.leaderBody(b, body);
    this.orderPass(b, body, leader);
    const s = this.sense(b, body);
    this.restDecision(b, body, s);

    if (b.castIn <= 0) {
      b.castIn = b.plus.castPeriod;
      const home = leader ?? body;
      b.caster.pass(b.clock, { holdsPortal: () => false, home: { x: home.x, y: home.y } });
      const ctx: ItemCtx = { home: { x: home.x, y: home.y }, losing: !!b.resting, portalWorthIt: false, creeping: false, mayShop: false };
      b.belt.beltPass(ctx);
    }
    // A cast winding up or a channel held is left alone unless the hero is getting out — breaking a
    // Tranquility to walk two steps behind the leader is how a healer wastes its ultimate.
    const leaving = !!b.resting || b.stance === "back";
    if (body.order === "cast" && !leaving) return;

    if (b.resting) return void this.restPass(b, body, leader, s);
    if (b.stance === "back") return void this.backPass(b, body, leader, s);
    if (this.fightPass(b, body, leader, s)) return;
    b.fightSince = -1;
    if (hero && this.shopPass(b, hero, leader, s)) return;
    if (hero && this.lootPass(b, hero, leader, s)) return;
    if (b.stance === "wait") return void this.waitPass(b, body);
    this.followPass(b, body, leader);
  }

  // --- who is where ------------------------------------------------------------------------

  private units(): SimUnit[] {
    if (this.frame) return this.frame;
    const out: SimUnit[] = [];
    for (const u of this.host.world.units.values()) if (u.hp > 0 && !u.vanished) out.push(u);
    return (this.frame = out);
  }

  /** A seat of the party (not the dungeon, not a neutral). */
  private alliedSeat(player: number, other: number): boolean {
    return other >= 0 && other < MELEE.MAX_PLAYERS && other !== DUNGEON && (other === player || this.host.coAllied(player, other));
  }

  private hostileTo(player: number, u: SimUnit): boolean {
    if (u.hp <= 0 || u.neutralPassive) return false;
    if (u.owner === PLAYER_NEUTRAL_HOSTILE) return true;
    return u.owner >= 0 && u.owner < MELEE.MAX_PLAYERS && u.owner !== player && !this.host.coAllied(player, u.owner);
  }

  /**
   * The unit a seat plays with right now: its steam tank while it drives one (map.ts `TANK`), else its
   * hero. A hero held down by its Ankh (`reviveT`) is still its body — it gets up where it lies.
   */
  private bodyOf(player: number): SimUnit | null {
    let hero: SimUnit | null = null;
    for (const u of this.units()) {
      if (u.owner !== player || u.isIllusion) continue;
      if (u.typeId === TANK) return u;
      if (u.isHero && (!hero || PICK_OF.has(u.typeId))) hero = u;
    }
    return hero;
  }

  /** The seats of the party that PEOPLE play. */
  private people(b: Brain): number[] {
    const out: number[] = [];
    for (let p = 0; p < MELEE.MAX_PLAYERS; p++) {
      if (p === b.player || p === DUNGEON || this.brains.some((o) => o.player === p)) continue;
      if (!this.host.coAllied(b.player, p)) continue;
      if (this.units().some((u) => u.owner === p && (u.isHero || u.typeId === WISP || u.typeId === TANK))) out.push(p);
    }
    return out;
  }

  /**
   * THE LEADER's body. The seat "follow me" named, while it has a body; else the first person with
   * one; and only with no person left standing, another party member (so the computers at least
   * keep together). Announced once per leader, with the leader's hero's name when there is more than
   * one person to tell apart.
   */
  private leaderBody(b: Brain, self: SimUnit): SimUnit | null {
    const people = this.people(b);
    let seat = this.leaderSeat !== null && this.leaderSeat !== b.player && this.bodyOf(this.leaderSeat) ? this.leaderSeat : null;
    if (seat === null) seat = people.find((p) => this.bodyOf(p)) ?? null;
    if (seat === null) {
      const others = this.brains.filter((o) => o.player < b.player && this.bodyOf(o.player));
      seat = others[0]?.player ?? null;
    }
    const body = seat !== null ? this.bodyOf(seat) : null;
    if (!body || body === self) return null;
    if (seat !== null && b.leaderSaid !== seat && people.includes(seat)) {
      b.leaderSaid = seat;
      const name = people.length > 1 ? this.heroName(body) : null;
      this.say(b, name ? leaderLines(name) : READY_LINES, true);
    }
    return body;
  }

  private sense(b: Brain, body: SimUnit): Sense {
    const s: Sense = { foes: [], friends: [] };
    for (const u of this.units()) {
      if (dist(u, body) > LOOK) continue;
      if (this.hostileTo(b.player, u)) {
        if (u.invulnerable || u.invisible || !this.host.visible(b.player, u.x, u.y)) continue;
        s.foes.push(u);
      } else if (this.alliedSeat(b.player, u.owner)) s.friends.push(u);
    }
    return s;
  }

  // --- the pick ------------------------------------------------------------------------------

  /**
   * PICK A HERO the way a person does: walk the seat's wisp onto a pedestal (map.ts `PICKS`), and the
   * map's own trigger removes the wisp and hands over the hero — with its Ankh — at the start.
   *
   * It waits a few seconds first so the people pick before it does, and then picks for the PARTY:
   * the roles nobody has yet, in the order a party of four needs them — somebody to heal, somebody
   * to stand in front, somebody to cast — and never a hero a party member already plays while
   * another is free.
   */
  private pickPass(b: Brain): void {
    const wisp = this.units().find((u) => u.owner === b.player && u.typeId === WISP);
    const hero = this.units().find((u) => u.owner === b.player && u.isHero);
    if (hero) {
      b.heroId = hero.id;
      b.pick = PICK_OF.get(hero.typeId) ?? b.pick;
      return;
    }
    if (!wisp || b.clock < b.pickAt) return;
    if (!b.pick || b.clock - b.pickSince > 15) {
      b.pick = this.choosePick(b);
      b.pickSince = b.clock;
      this.say(b, pickLines(b.pick.name));
    }
    // Up the AISLE first, then across. The eight pedestals stand in two columns either side of it and
    // every one of them hands out its hero to whatever walks in (one of them to anything at all), so
    // a wisp that walked straight at a pedestal in the back row picked whichever one stood in the way.
    const c = centre(b.pick.rect);
    const aisle = { x: PICK_AISLE_X, y: c.y };
    const leg = Math.abs(wisp.y - c.y) > 60 ? aisle : c;
    this.order(b, wisp, `pick${b.pick.hero}${leg === c ? "" : "a"}`, { c: "order", unitId: wisp.id, order: { kind: "move", x: leg.x, y: leg.y }, queued: false });
  }

  private choosePick(b: Brain): HeroPick {
    const taken = new Set<string>();
    for (const u of this.units()) if (u.isHero && PICK_OF.has(u.typeId) && this.alliedSeat(b.player, u.owner)) taken.add(u.typeId);
    for (const o of this.brains) if (o !== b && o.pick) taken.add(o.pick.hero);
    const roles = new Set<Role>([...taken].map((t) => PICK_OF.get(t)!.role));
    const open = PICKS.filter((p) => !taken.has(p.hero));
    const pool = open.length ? open : PICKS;
    for (const role of ["healer", "tank", "caster", "damage"] as const) {
      if (roles.has(role)) continue;
      const fits = pool.filter((p) => p.role === role);
      if (fits.length) return fits[Math.floor(b.rng() * fits.length)];
    }
    return pool[Math.floor(b.rng() * pool.length)];
  }

  private learnPass(b: Brain, hero: SimUnit): void {
    if (hero.skillPoints <= 0) return;
    const list = SKILLS[hero.typeId] ?? this.host.registry.get(hero.typeId)?.heroAbilities ?? [];
    for (const id of list) if (this.host.execute(b.player, { c: "learnskill", unitId: hero.id, abilityId: id })) return;
  }

  /** Counts its Ankhs, and says when one has just been spent. */
  private ankhPass(b: Brain, hero: SimUnit): void {
    const n = hero.inventory.filter((h) => h && this.isAnkhId(h.itemId)).length;
    if (b.ankhs > n && hero.reviveT > 0) this.say(b, ANKH_USED_LINES, true);
    b.ankhs = n;
  }

  private isAnkhId(itemId: string): boolean {
    const def = this.host.items.get(itemId);
    return !!def && isAnkh(def, (id) => this.host.abilities.get(id));
  }

  // --- orders from the party -----------------------------------------------------------------

  /**
   * THE PARTY'S WORD. Every order is obeyed at once and answered, and the ones that send it on — go,
   * follow, attack — override its own decision to rest for `OBEY_HOLD`: told to come, it comes, and
   * says it is still hurt if it is.
   *
   * A wait the leader then walks away from is not held for ever: past `WAIT_ABANDON` for
   * `WAIT_ABANDON_AFTER` seconds, it comes after them — a party member left standing in an empty
   * corridor two rooms back is no use to anybody.
   */
  private orderPass(b: Brain, body: SimUnit, leader: SimUnit | null): void {
    const due = b.queue;
    b.queue = [];
    for (const q of due) {
      const hp = pct(body);
      switch (q.command) {
        case "wait":
          b.stance = "wait";
          b.holdAt = { x: body.x, y: body.y };
          b.obeyUntil = 0; // told to stop: whatever it was told to push on through is over
          break;
        case "back":
          b.stance = "back";
          b.obeyUntil = 0;
          break;
        case "attack":
          b.stance = "attack";
          break;
        case "go":
        case "follow":
          b.stance = "follow";
          break;
      }
      // An order that sends it on OVERRIDES the rest it is taking, or the one it is about to take — it
      // is hurt and has been told to come anyway. An order given to a healthy hero overrides nothing
      // that has not happened yet: a fight twenty seconds later that leaves it on a sliver is a new
      // decision, and it makes it.
      if (q.command !== "wait" && q.command !== "back" && (b.resting || hp < b.profile.readyHp)) b.obeyUntil = b.clock + OBEY_HOLD;
      b.stanceSince = b.clock;
      b.target = 0;
      b.orderKey = "";
      const wasResting = b.resting;
      if (q.command !== "wait" && q.command !== "back") b.resting = null;
      const lines = wasResting && q.command !== "wait" && q.command !== "back" && hp < b.profile.readyHp ? GOING_HURT_LINES
        : q.claimsLead && leader ? READY_LINES : ACK_LINES[q.command];
      // The first computer answers; the rest only sometimes, and a beat apart — three "ok"s at once
      // is a bot, not a party.
      if (q.turn === 0 || b.rng() < 0.4) b.replies.push({ at: b.clock + 0.3 + REPLY_STAGGER * q.turn + b.rng() * 0.6, lines });
    }
    if (b.stance === "attack" && b.clock - b.stanceSince > ATTACK_HOLD) b.stance = "follow";
    if (b.stance === "back" && b.clock - b.stanceSince > BACK_HOLD) {
      b.stance = "wait";
      b.holdAt = { x: body.x, y: body.y };
    }
    if (b.stance === "wait" && leader && b.holdAt && dist(leader, b.holdAt) > WAIT_ABANDON && b.clock - b.stanceSince > WAIT_ABANDON_AFTER) {
      b.stance = "follow";
      this.say(b, READY_LINES);
    }
  }

  // --- resting -------------------------------------------------------------------------------

  /**
   * WHEN TO STOP AND HEAL. Below `restHp` of its life (or, a caster, `restMana` of its mana) it stops,
   * says so, and holds until it is at `readyHp` — unless the party has told it to come
   * (`obeyUntil`), which it does. The one order it will not follow is into its own death with no
   * Ankh left: that is the end of the hero on this map, not a setback (`Game_Over`).
   */
  private restDecision(b: Brain, body: SimUnit, s: Sense): void {
    const P = b.profile;
    // A steam tank has no fountain to go to and no Ankh to lose — it drives.
    if (body.typeId === TANK) {
      b.resting = null;
      return;
    }
    const hp = pct(body);
    const mp = body.maxMana > 0 ? body.mana / body.maxMana : 1;
    // Only a CASTER stops for mana — an intelligence hero, whose fight is its bar. A Blade Berserker's
    // mana is Immolation's to burn and comes back at a hero's trickle; one that stopped for it stood in
    // a corridor for two minutes while the party walked on.
    const caster = P.restMana > 0 && this.host.registry.get(body.typeId)?.primaryAttr === PrimaryAttribute.Intelligence;
    if (b.resting) {
      const manaOk = b.resting !== "mana" || mp >= Math.min(0.5, P.restMana * 3);
      if (hp >= P.readyHp && manaOk) {
        b.resting = null;
        this.say(b, READY_LINES);
      }
      return;
    }
    const noAnkh = body.isHero && !body.inventory.some((h) => h && this.isAnkhId(h.itemId));
    if (hp < NO_ANKH_FLOOR && noAnkh && s.foes.some((f) => dist(f, body) <= 700)) {
      b.resting = "hp";
      b.obeyUntil = 0;
      this.say(b, NO_ANKH_LINES);
      return;
    }
    if (b.clock < b.obeyUntil) return;
    // Not in the middle of a fight the party is winning at a third life — only when it is the one
    // being hit, or the fight is over.
    const beingHit = s.foes.some((f) => f.targetId === body.id);
    if (hp < P.restHp && (beingHit || !s.foes.some((f) => dist(f, body) <= 600) || hp < P.restHp * 0.6)) {
      b.resting = "hp";
      b.restSaidAt = b.clock;
      this.say(b, REST_HP_LINES, true);
      return;
    }
    if (caster && mp < P.restMana && !s.foes.some((f) => dist(f, body) <= 700) && hp < 0.98) {
      b.resting = "mana";
      b.restSaidAt = b.clock;
      this.say(b, REST_MANA_LINES, true);
    }
  }

  /**
   * RESTING: out of reach of whatever is swinging at it, at a Fountain of Health when there is one at
   * hand, and otherwise where it stands. It keeps TELLING the leader while the leader walks away — the
   * brief's "wait i need a bit more health" — and it does not let itself be left behind on its own:
   * past a long way it trails after the party without joining a fight.
   */
  private restPass(b: Brain, body: SimUnit, leader: SimUnit | null, s: Sense): void {
    const threats = s.foes.filter((f) => f.targetId === body.id || dist(f, body) <= 450);
    if (threats.length) {
      const away = this.awayFrom(body, threats, leader, 650);
      return void this.move(b, body, away.x, away.y);
    }
    if (leader && dist(leader, body) > 700 && b.clock - b.restSaidAt > REST_TALK_GAP) {
      b.restSaidAt = b.clock;
      this.say(b, b.resting === "mana" ? REST_MANA_LINES : REST_HP_LINES, true);
    }
    const fountain = this.units().find((u) => u.typeId === FOUNTAIN && dist(u, body) <= 1600 && (!leader || dist(u, leader) <= REST_TRAIL));
    if (fountain && !s.foes.some((f) => dist(f, fountain) <= 700)) {
      if (dist(body, fountain) > 260) this.move(b, body, fountain.x, fountain.y);
      return;
    }
    // The leader has not waited: keep up, well behind and out of the fight, rather than heal alone in
    // a corridor the party has left (it still regenerates on the walk).
    if (leader && dist(leader, body) > REST_TRAIL) {
      const p = this.behind(leader, body, REST_TRAIL * 0.6);
      this.move(b, body, p.x, p.y);
      return;
    }
    if (body.order === "move" || body.order === "attackmove" || body.order === "attack") this.stop(b, body);
  }

  /** "back": out of the fight to the leader's side of it, then a wait (`orderPass`). */
  private backPass(b: Brain, body: SimUnit, leader: SimUnit | null, s: Sense): void {
    if (s.foes.length) {
      const away = this.awayFrom(body, s.foes, leader, 700);
      return void this.move(b, body, away.x, away.y);
    }
    if (leader && dist(leader, body) > 400) {
      const p = this.behind(leader, body, FOLLOW_GAP);
      return void this.move(b, body, p.x, p.y);
    }
  }

  // --- fighting ----------------------------------------------------------------------------------

  /**
   * THE PARTY'S FIGHT. What is in it depends on the stance: following, it is what is near the LEADER
   * and what comes at itself; attacking, anything in sight; waiting, only what comes to it. The
   * target is the leader's own when the leader is swinging at something (a party that focuses kills
   * things), then whatever is hitting a party member, then the wounded — a difficulty that does not
   * `focus` takes the nearest. Nothing drags it further than a leash from the leader.
   */
  private fightPass(b: Brain, body: SimUnit, leader: SimUnit | null, s: Sense): boolean {
    const P = b.profile;
    const attack = b.stance === "attack";
    const anchor: Pt = b.stance === "wait" ? b.holdAt ?? body : leader ?? body;
    const leash = attack ? LEASH * 1.6 : b.stance === "wait" ? 800 : LEASH;
    const friendIds = new Set(s.friends.map((f) => f.id));
    const inFight = (f: SimUnit): boolean => {
      if (dist(f, anchor) > leash) return false;
      if (attack) return true;
      if (friendIds.has(f.targetId ?? 0) || f.targetId === body.id) return dist(f, body) <= LOOK * 0.75;
      if (dist(f, body) <= SELF_FIGHT) return true;
      return b.stance !== "wait" && !!leader && dist(f, leader) <= LEADER_FIGHT;
    };
    const mobile = s.foes.filter((f) => !f.building && inFight(f));
    // A spawner hut is only the party's business once the leader goes for it, or nothing else is left.
    const leaderOn = leader && leader.order === "attack" ? leader.targetId : 0;
    const huts = s.foes.filter((f) => f.building && inFight(f) && (f.id === leaderOn || attack || (!mobile.length && !!leader && dist(f, leader) <= 500)));
    const cands = mobile.length ? mobile : huts;
    if (!cands.length) {
      b.target = 0;
      return false;
    }
    if (b.fightSince < 0) b.fightSince = b.clock;
    const cur = b.target ? cands.find((c) => c.id === b.target) : undefined;
    let t = cur && b.clock - b.targetAt < 2.5 ? cur : undefined;
    if (!t) {
      const score = (f: SimUnit): number => {
        if (!P.focus) return -dist(f, body);
        let v = -dist(f, body) / 500 + (1 - pct(f)) * 2;
        if (f.id === leaderOn) v += 4;
        if (friendIds.has(f.targetId ?? 0)) v += this.host.world.units.get(f.targetId ?? 0)?.isHero ? 3 : 1;
        if (f.targetId === body.id) v += 2;
        if (f.building) v -= 6;
        return v;
      };
      t = cands.reduce((best, f) => (score(f) > score(best) ? f : best));
      b.targetAt = b.clock; // looked again in 2.5 seconds — a target is kept that long, not swapped every pass
      b.target = t.id;
    }
    // The first beat of a fight: a player sees the monster, then swings. Only for a fight it walks
    // INTO — something already hitting the party is answered at once.
    const answering = t.targetId === body.id || friendIds.has(t.targetId ?? 0);
    if (!answering && b.clock - b.fightSince < P.react) return true;
    this.attack(b, body, t);
    return true;
  }

  // --- following ---------------------------------------------------------------------------------

  /**
   * FOLLOW THE LEADER, a few steps behind, each computer on its own step so the party does not stand
   * in one heap. Three things are not a walk: the leader through a WAYGATE (walk into the gate that
   * lands nearest them), the leader in a steam TANK (walk into the rect that hands out ours), and the
   * leader out of one while we are still driving (drive into the rect that gives the hero back).
   */
  private followPass(b: Brain, body: SimUnit, leader: SimUnit | null): void {
    if (!leader) return;
    const P_ = FOLLOW_GAP + FOLLOW_STEP * Math.max(0, this.brains.indexOf(b));
    if (leader.typeId === TANK && body.typeId !== TANK) {
      const c = centre(TANK_ENTER);
      return void this.move(b, body, c.x, c.y);
    }
    if (leader.typeId !== TANK && body.typeId === TANK) {
      const c = centre(TANK_LEAVE);
      return void this.move(b, body, c.x, c.y);
    }
    const d = dist(leader, body);
    if (d > 2200 && !this.host.world.canWalkTo(body.id, leader.x, leader.y)) {
      const gate = this.gateTowards(body, leader);
      if (gate) return void this.move(b, body, gate.x, gate.y);
    }
    if (d <= P_ + 160) return;
    const a = Math.atan2(body.y - leader.y, body.x - leader.x);
    this.order(b, body, `f${leader.id}`, {
      c: "order", unitId: body.id, order: { kind: "follow", targetId: leader.id, offX: Math.cos(a) * P_, offY: Math.sin(a) * P_ }, queued: false,
    });
  }

  /** Waiting: stand at the spot it was told to, and walk back to it after a fight moved it. */
  private waitPass(b: Brain, body: SimUnit): void {
    const at = b.holdAt ?? body;
    if (dist(at, body) > 220) return void this.move(b, body, at.x, at.y);
    if (body.order === "follow" || body.order === "move") this.stop(b, body);
  }

  /** An active waygate within reach whose destination puts us much nearer the leader. */
  private gateTowards(body: SimUnit, leader: SimUnit): SimUnit | null {
    let best: SimUnit | null = null;
    let bestGain = 1500;
    for (const g of this.units()) {
      if (!g.waygate?.active || dist(g, body) > 5000) continue;
      const land = { x: g.waygate.destX, y: g.waygate.destY };
      const gain = dist(body, leader) - dist(land, leader) - dist(body, g) * 0.25;
      if (gain > bestGain && this.host.world.canWalkTo(body.id, g.x, g.y)) {
        bestGain = gain;
        best = g;
      }
    }
    return best;
  }

  // --- items ---------------------------------------------------------------------------------------

  private eye(hero: SimUnit): ItemEye {
    const def = this.host.registry.get(hero.typeId);
    return {
      ability: (id) => this.host.abilities.get(id),
      primary: def?.primaryAttr ?? ("" as ItemEye["primary"]),
      melee: (hero.weapon?.range ?? 100) <= 200,
    };
  }

  /**
   * LOOT: the most valuable thing on the floor near it that it would carry (items.ts `wantsItem`), and
   * with a full belt, the least valuable thing in it dropped first to make room — so an intelligence
   * hero trades Gauntlets of Ogre Strength for a Robe of the Magi, and nobody ever trades an Ankh.
   *
   * Never in a fight, never an item a monster is standing over, never a KEY (the leader's to carry —
   * map.ts `KEYS`), never one a person on the party is already walking to, and never one it has only
   * just dropped.
   */
  private lootPass(b: Brain, hero: SimUnit, leader: SimUnit | null, s: Sense): boolean {
    if (s.foes.some((f) => !f.building && dist(f, hero) <= 900)) return false;
    // The drop half of a trade has gone through: pick the item up now.
    if (b.lootId) {
      const it = this.host.world.items.get(b.lootId);
      if (it && b.clock - b.lootAt < 8) {
        if (b.lootDrop >= 0 && hero.inventory[b.lootDrop]) return true; // still putting the old one down
        if (!(hero.order === "getitem" && hero.getItemId === it.id)) this.host.execute(b.player, { c: "getitem", unitId: hero.id, itemId: it.id });
        return true;
      }
      b.lootId = 0;
    }
    if (b.clock - b.lootAt < 1) return false;
    const anchor = b.stance === "wait" ? b.holdAt ?? hero : leader ?? hero;
    const reach = b.stance === "wait" ? 450 : LOOT_REACH;
    const eye = this.eye(hero);
    const claimed = new Set<number>();
    for (const u of this.units()) if (u.order === "getitem" && u.owner !== b.player) claimed.add(u.getItemId);
    for (const o of this.brains) if (o !== b && o.lootId) claimed.add(o.lootId);
    for (const [id, at] of b.dropped) if (b.clock - at > DROP_FORGET) b.dropped.delete(id);
    let best: { id: number; replace: number; value: number } | null = null;
    for (const it of this.host.world.items.values()) {
      if (claimed.has(it.id) || b.dropped.has(it.id) || KEYS.has(it.itemId)) continue;
      if (dist(it, hero) > reach || dist(it, anchor) > LOOT_LEASH) continue;
      if (s.foes.some((f) => dist(f, it) <= 500)) continue;
      const def = this.host.items.get(it.itemId);
      if (!def) continue;
      const want = wantsItem(def, hero.inventory, (id) => this.host.items.get(id), eye);
      if (!want || (best && want.value <= best.value)) continue;
      if (!this.host.world.canWalkTo(hero.id, it.x, it.y)) continue;
      best = { id: it.id, ...want };
    }
    b.lootAt = b.clock;
    if (!best) return false;
    b.lootId = best.id;
    b.lootDrop = best.replace;
    if (best.replace >= 0) {
      const held = hero.inventory[best.replace];
      if (held) b.dropped.set(held.id, b.clock);
      this.host.execute(b.player, { c: "dropitem", unitId: hero.id, slot: best.replace, x: hero.x, y: hero.y });
    } else {
      this.host.execute(b.player, { c: "getitem", unitId: hero.id, itemId: best.id });
    }
    return true;
  }

  /**
   * SHOP when a shop is at hand — near the hero, with the leader not far from it and nothing to fight.
   *
   * An ANKH first, always: a hero without one buys one the moment it can afford it, and while it
   * cannot it buys nothing else, because the gold is the next life. With the Ankh carried it buys the
   * most valuable thing on the shelf that is worth a slot to its hero, selling (or, at a shop that
   * does not buy, dropping) the least valuable thing it carries when the belt is full.
   */
  private shopPass(b: Brain, hero: SimUnit, leader: SimUnit | null, s: Sense): boolean {
    if (s.foes.some((f) => !f.building && dist(f, hero) <= 900)) return false;
    const shop = this.units()
      .filter((u) => SHOPS.has(u.typeId) && dist(u, hero) <= SHOP_NEAR && (!leader || dist(u, leader) <= SHOP_LEASH))
      .sort((x, y) => dist(x, hero) - dist(y, hero))[0];
    // …and one it can WALK to: the dungeon's walls are thin, and a shop 700 away through one is a shop
    // on the far side of a gate. Asked of the ground at the shop's edge on our side, because its centre
    // is inside its own footprint.
    const edgeAt = shop ? this.behind(shop, hero, 240) : null;
    if (!shop || !edgeAt || !this.host.world.canWalkTo(hero.id, edgeAt.x, edgeAt.y)) {
      b.errandUntil = 0;
      return false;
    }
    const gold = this.host.world.stashOf(b.player).gold;
    const wares = this.host.tech.get(shop.typeId).sellitems;
    const eye = this.eye(hero);
    const price = (id: string): number => this.host.items.get(id)?.gold ?? Infinity;
    const ready = (id: string): boolean => b.clock - (b.shopTried.get(id) ?? -Infinity) > BUY_RETRY;
    const hasAnkh = hero.inventory.some((h) => h && this.isAnkhId(h.itemId));
    let want: { id: string; replace: number } | null = null;
    if (!hasAnkh) {
      const ankh = wares.filter((id) => this.isAnkhId(id) && ready(id)).sort((x, y) => price(x) - price(y))[0];
      if (!ankh || gold < price(ankh)) return false; // saving for it
      const w = wantsItem(this.host.items.get(ankh)!, hero.inventory, (id) => this.host.items.get(id), eye);
      want = { id: ankh, replace: w ? w.replace : worstSlot(hero.inventory, (id) => this.host.items.get(id), eye)?.slot ?? -1 };
    } else {
      let bestValue = 0;
      for (const id of wares) {
        const def = this.host.items.get(id);
        if (!def || gold < def.gold || !ready(id)) continue;
        if (this.isAnkhId(id)) continue; // one is carried; a second is a spare the gold is better spent on
        const w = wantsItem(def, hero.inventory, (x) => this.host.items.get(x), eye);
        if (!w || w.value >= ANKH_VALUE) continue;
        // Worth the walk and the gold: a real upgrade, not a +1 in a free slot.
        if (w.value < SHOP_WORTH || w.value <= bestValue) continue;
        bestValue = w.value;
        want = { id, replace: w.replace };
      }
    }
    if (!want) {
      b.errandUntil = 0;
      return false;
    }
    if (!b.errandUntil) b.errandUntil = b.clock + ERRAND;
    if (b.clock > b.errandUntil) {
      b.shopTried.set(want.id, b.clock);
      b.errandUntil = 0;
      return false;
    }
    if (!this.host.world.shopReaches(shop.id, hero.id)) {
      // A move that NAMES the shop walks up to its edge — its centre is inside its own footprint, and a
      // plain point order there finds no path and leaves the hero standing still.
      this.order(b, hero, `shop${shop.id}`, { c: "order", unitId: hero.id, order: { kind: "move", x: shop.x, y: shop.y, targetId: shop.id }, queued: false });
      return true;
    }
    if (want.replace >= 0 && hero.inventory[want.replace]) {
      const held = hero.inventory[want.replace]!;
      if (this.host.world.canPawnAt(shop)) this.host.execute(b.player, { c: "sellitem", unitId: hero.id, slot: want.replace, shopId: shop.id });
      else {
        b.dropped.set(held.id, b.clock);
        this.host.execute(b.player, { c: "dropitem", unitId: hero.id, slot: want.replace, x: hero.x, y: hero.y });
      }
      return true; // bought on the next pass, once the slot is free
    }
    const ok = this.host.execute(b.player, { c: "buyitem", shopId: shop.id, itemId: want.id });
    b.shopTried.set(want.id, b.clock);
    b.errandUntil = 0;
    if (ok && this.isAnkhId(want.id)) this.say(b, ANKH_BOUGHT_LINES, true);
    return ok;
  }

  // --- orders -------------------------------------------------------------------------------------

  private attack(b: Brain, body: SimUnit, t: SimUnit): void {
    if (body.order === "attack" && body.targetId === t.id) return;
    this.order(b, body, `a${t.id}`, { c: "order", unitId: body.id, order: { kind: "attack", targetId: t.id }, queued: false });
  }

  private move(b: Brain, body: SimUnit, x: number, y: number): void {
    this.order(b, body, `m${Math.round(x / 96)},${Math.round(y / 96)}`, { c: "order", unitId: body.id, order: { kind: "move", x, y }, queued: false });
  }

  private stop(b: Brain, body: SimUnit): void {
    this.order(b, body, "stop", { c: "order", unitId: body.id, order: { kind: "stop" }, queued: false });
  }

  /** One order, not the same order every pass: a path search per repeat is a cost and a stutter. */
  private order(b: Brain, u: SimUnit, key: string, cmd: Parameters<PlusHost["execute"]>[1]): void {
    if (key === b.orderKey && b.clock - b.orderAt < 3 && u.order !== "idle") return;
    if (this.host.execute(b.player, cmd)) {
      b.orderKey = key;
      b.orderAt = b.clock;
    }
  }

  /** A point `gap` from `from`, on the side of it that `toward` is on. */
  private behind(from: Pt, toward: Pt, gap: number): Pt {
    const d = dist(from, toward) || 1;
    return { x: from.x + ((toward.x - from.x) / d) * gap, y: from.y + ((toward.y - from.y) / d) * gap };
  }

  /** Where to step to get `reach` further from a knot of monsters — towards the leader when the leader
   *  is the safer side of them, straight away otherwise. */
  private awayFrom(body: SimUnit, foes: readonly SimUnit[], leader: SimUnit | null, reach: number): Pt {
    const cx = foes.reduce((s, f) => s + f.x, 0) / foes.length;
    const cy = foes.reduce((s, f) => s + f.y, 0) / foes.length;
    const knot = { x: cx, y: cy };
    if (leader && dist(leader, knot) > dist(body, knot) + 150) return this.behind(leader, knot, -150);
    const d = dist(body, knot) || 1;
    return { x: body.x + ((body.x - cx) / d) * reach, y: body.y + ((body.y - cy) / d) * reach };
  }

  // --- talk -----------------------------------------------------------------------------------------

  /** Said on its own account — held to `TALK_GAP` unless `force` (the rest line keeps its own clock). */
  private say(b: Brain, lines: readonly string[], force = false): void {
    if (!lines.length) return;
    if (!force && b.clock - b.spokeAt < TALK_GAP) return;
    b.spokeAt = b.clock;
    this.host.say(b.player, lines[Math.floor(b.rng() * lines.length)], "allies");
  }

  /** Answers to the party's orders go out a beat after the order, and are never held back. */
  private speakPass(b: Brain): void {
    if (!b.replies.length) return;
    const due = b.replies.filter((r) => r.at <= b.clock);
    if (!due.length) return;
    b.replies = b.replies.filter((r) => r.at > b.clock);
    this.say(b, due[due.length - 1].lines, true);
  }

  private heroName(u: SimUnit): string {
    return PICK_OF.get(u.typeId)?.name ?? this.host.registry.get(u.typeId)?.name ?? "you";
  }
}

/** Neutral Hostile's slot. */
const PLAYER_NEUTRAL_HOSTILE = 12;

const pct = (u: SimUnit): number => (u.maxHp > 0 ? u.hp / u.maxHp : 0);

/** A small seeded stream, so every computer's decisions replay for the same match seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
