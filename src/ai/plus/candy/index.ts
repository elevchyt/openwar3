import type { ChatLine } from "../../../game/chat";
import { MELEE } from "../../../data/gameplayConstants";
import type { HeroKill, SimUnit } from "../../../sim/world";
import { GREETINGS, GREET_AT, GREET_SPREAD } from "../chatter";
import type { PlusHost } from "../index";
import {
  BANTER_CHANCE, BANTER_GAP, CANDY_ANSWER_GAP, CANDY_BUSY_LINES, CANDY_COMING_LINES, CANDY_RALLY_NO_LINES,
  CANDY_RALLY_YES_LINES, CANDY_TALK_GAP, DEATH_LINES, ENGAGE_TALK_GAP, GOOD_SPORT_CHANCE, GOOD_SPORT_LINES,
  LANES, LANE_LINES, SELF_BACK_LINES, TEAM_BACK_LINES, WARN_GAP,
  banterLines, engageLines, followLines, heroCallName, killLines, laneIn, laneSwitchLines, namedHero, readCandyCall,
  type HeroName, type Lane,
} from "./chat";
import {
  BUILDS, CASTER, CHEAP_BUILD, CORPSE_REACH, GHOST_TYPES, HEALER_REACH, HERO_CLASS, ITEM_USE, MELEE as MELEE_CLASSES,
  MONSTERS, PICK_ORDER, POTION, PUSH_REACH, REVIVE_CORPSE, REVIVE_HEALER, REVIVE_HEALER_MAX, SAPPER, SHOP_OF, SKILLS,
  TEAM_UPGRADES, dist, enemySide, inBox, laneOf, mayCarry, pointAt, project, sideOf,
  type HeroClass, type Pt, type Side,
} from "./map";
import { candyProfile, type CandyProfile } from "./profile";
import { AUTOCAST_ON, castPass, channeling, type SpellCtx } from "./spells";

// Computer+ on Extreme Candy War — a HERO player for Blizzard's Halloween lane map.
//
// The classic melee AI has nothing to offer this map: `MeleeStartingAI` is a melee script's
// action and a scenario runs none of it, so in the real game a computer seat on Extreme Candy
// War stands in the hero picker for the whole match. Computer+ plays it — the developer asked for
// exactly that — and it plays it the way plus/index.ts plays melee: authority-side only, every
// decision leaving through `PlusHost.execute` (the door a person's click goes through), and no
// cheats at any difficulty.
//
// What a Candy War player has to do, and therefore what this file does (docs/candy-war-ai.md):
//
//  1. PICK a hero — through the map's own `Pick_Heroes` trigger, by selecting a costume twice, the
//     way a person does (`pickPass`). The map then hands over the hero and its starting items
//     itself. The +300 gold and food cap a person is given at init are granted to the seat by the
//     controller, because the map's `Initialize_Players` hands them to MAP_CONTROL_USER only and a
//     computer on this map is otherwise simply poorer than the person beside it.
//  2. TAKE A LANE, and say so ("im going mid") — split against where its teammates already are.
//  3. ESCORT the lane's candy monster. That is the whole win condition: a monster only walks while
//     one side's heroes are within 600 of it and the other's are not (`Crate_Detection_*`), each one
//     that reaches the far end kills a Candy Mage, and three dead mages open the Candy Vault. So
//     the objective is never "kill creeps" — creeps are what it farms while it walks.
//  4. FIGHT heroes — harass when it is safe, commit when the fight is worth it, focus with its
//     allies and TELL them ("going in on the undead warlock"), and join theirs.
//  5. LEAVE in time — to the fountain, the only healing building on the map — and come back.
//  6. SPEND — a class build under the map's slot rules, potions, team creep upgrades — and PRESS
//     what it carries.
//  7. COME BACK from the dead: the map revives nobody at an altar. A dead hero is a GHOST that has
//     to walk to its corpse (free) or to the Spirit Healer (costs experience) and click (`deadPass`).

export interface CandyHost extends PlusHost {
  /** A selection by this computer player — raised to the map's `EVENT_PLAYER_UNIT_SELECTED`
   *  triggers exactly as a person's click is (RtsController.selectForAi). How a hero is picked. */
  select(player: number, unitId: number): void;
  /** A boolean JASS global of the running map (`udg_GameOn`), or null if it has none. */
  scriptBool(name: string): boolean | null;
  /** Every hero death so far, oldest first (SimWorld.heroKills). */
  heroKills(): readonly HeroKill[];
}

type Mode = "lane" | "fight" | "home" | "help" | "backoff" | "dead";

interface Brain {
  player: number;
  side: Side;
  foe: Side;
  profile: CandyProfile;
  rng: () => number;
  clock: number;
  thinkIn: number;
  // --- the pick
  cls: HeroClass | null;
  pickAt: number;
  pickModel: number;
  pickStep: number;
  pickStepAt: number;
  // --- the hero
  heroId: number;
  mode: Mode;
  lane: Lane;
  /** Has it split into a lane yet (`pickLane`)? Until then `lane` is only a default. */
  laneChosen: boolean;
  laneSaid: boolean;
  /** Until when a Scroll of Teleportation is channelling — nothing may be ordered over it. */
  channelUntil: number;
  target: number;
  targetFrom: Pt | null;
  joined: boolean;
  harassUntil: number;
  harassNext: number;
  backoffUntil: number;
  helpAnchor: number;
  helpUntil: number;
  rallyUntil: number;
  /** When each enemy hero first came within reach — `castDelay` is measured off it. */
  seen: Map<number, number>;
  lastCast: Map<string, number>;
  itemTried: Map<string, number>;
  upgradeTried: Map<string, number>;
  orderKey: string;
  orderAt: number;
  // --- death
  deathSpot: Pt | null;
  deathLevel: number;
  deathFoesNear: boolean;
  foesNearLast: boolean;
  // --- talk
  greeted: boolean;
  greetAt: number;
  spokeAt: number;
  engageSaidAt: number;
  engageSaidOn: number;
  banterAt: number;
  warnAt: number;
  answeredAt: number;
  killSeq: number;
  heard: Array<{ from: number; text: string; at: number }>;
}

/** Everything alive on the map, taken ONCE per sim step and shared by every brain that thinks in it. */
interface Frame {
  heroes: SimUnit[];
  units: SimUnit[];
  buildings: SimUnit[];
  byType: Map<string, SimUnit[]>;
}

/** What one hero sees around itself this pass. */
interface Sense {
  foeHeroes: SimUnit[];
  foeUnits: SimUnit[];
  foeTowers: SimUnit[];
  foeBuildings: SimUnit[];
  allyHeroes: SimUnit[];
  allyUnits: SimUnit[];
}

/** How far a hero looks — its night sight (heroes see 1300 on this always-night map, `usin`). */
const LOOK = 1300;
/** How far it looks for creeps, towers and buildings that matter to what it does next. */
const NEAR = 1000;
/** Seconds between two computers answering one line (plus/teamchat.ts `HELP_ANSWER_STAGGER`). */
const ANSWER_STAGGER = 1.5;
/** How long an engagement stays on the team board after it was declared. */
const ENGAGE_HOLD = 8;
/** Seconds before a purchase that failed is tried again. */
const BUY_RETRY = 10;

export class CandyWarAi {
  private readonly brains: Brain[] = [];
  /** Enemy heroes an ally of a side has declared it is going in on — what `allyEngagement` reads
   *  besides what it can see. A person's "going in on the mage" lands here too. */
  private readonly engagements: Array<{ side: Side; from: number; targetId: number; until: number }> = [];
  /** Lanes claimed in chat by the people on a team ("im going top"), for the lane split. */
  private readonly claims = new Map<number, { lane: Lane; at: number }>();
  private frame: Frame | null = null;

  constructor(private readonly host: CandyHost) {}

  get active(): boolean {
    return this.brains.length > 0;
  }

  /** Seat one hero seat. Only seats `sideOf` knows are ever passed in (see `HERO_SEATS`). */
  add(player: number, difficulty: number, seed: number): void {
    const side = sideOf(player);
    if (!side || this.brains.some((b) => b.player === player)) return;
    const rng = mulberry32((seed ^ Math.imul(player + 1, 0x9e3779b1)) >>> 0);
    const kills = this.host.heroKills();
    const seatIndex = this.brains.filter((b) => b.side === side).length;
    this.brains.push({
      player, side, foe: enemySide(side), profile: candyProfile(difficulty), rng,
      clock: 0, thinkIn: rng() * 0.5,
      cls: null, pickAt: 6 + seatIndex * 2 + rng() * 3, pickModel: 0, pickStep: 0, pickStepAt: 0,
      heroId: 0, mode: "lane", lane: "mid", laneChosen: false, laneSaid: false, channelUntil: 0,
      target: 0, targetFrom: null, joined: false, harassUntil: 0, harassNext: 0, backoffUntil: 0,
      helpAnchor: 0, helpUntil: 0, rallyUntil: 0,
      seen: new Map(), lastCast: new Map(), itemTried: new Map(), upgradeTried: new Map(),
      orderKey: "", orderAt: -Infinity,
      deathSpot: null, deathLevel: 1, deathFoesNear: false, foesNearLast: false,
      greeted: false, greetAt: GREET_AT + rng() * GREET_SPREAD,
      spokeAt: -Infinity, engageSaidAt: -Infinity, engageSaidOn: 0, banterAt: -Infinity, warnAt: -Infinity,
      answeredAt: -Infinity, killSeq: kills.length ? kills[kills.length - 1].seq : 0, heard: [],
    });
  }

  reset(): void {
    this.brains.length = 0;
    this.engagements.length = 0;
    this.claims.clear();
  }

  tick(dt: number): void {
    this.frame = null;
    for (const b of this.brains) {
      b.clock += dt;
      if (!b.greeted && b.clock >= b.greetAt) {
        b.greeted = true;
        this.host.say(b.player, GREETINGS[Math.floor(b.rng() * GREETINGS.length)]);
      }
      b.thinkIn -= dt;
      if (b.thinkIn > 0) continue;
      b.thinkIn = b.profile.think;
      this.think(b);
    }
    const now = this.brains[0]?.clock ?? 0;
    for (let i = this.engagements.length - 1; i >= 0; i--) if (this.engagements[i].until < now) this.engagements.splice(i, 1);
  }

  /**
   * A line was said and `recipients` heard it — the same fence plus/index.ts `heard` puts up: only
   * a line addressed to this computer, only from a player it is allied to, never its own. Nothing is
   * done here; the line is parked and read on the brain's next pass, because this is called from the
   * middle of chat delivery.
   */
  heard(line: ChatLine, recipients: readonly number[]): void {
    let turn = 0;
    for (const b of this.brains) {
      if (line.from === b.player || !recipients.includes(b.player)) continue;
      if (!this.host.coAllied(b.player, line.from)) continue;
      b.heard.push({ from: line.from, text: line.text, at: b.clock + ANSWER_STAGGER * turn++ });
    }
    const call = readCandyCall(line.text);
    if (call?.kind === "lane") this.claims.set(line.from, { lane: call.lane, at: this.brains[0]?.clock ?? 0 });
  }

  // ==========================================================================================
  //  One pass of one brain
  // ==========================================================================================

  private think(b: Brain): void {
    const hero = this.heroOf(b);
    if (!hero) {
      if (!b.heroId) return void this.pickPass(b);
      if (b.mode !== "dead") this.died(b);
      this.hearPass(b, null);
      this.killTalk(b);
      return void this.deadPass(b);
    }
    if (b.mode === "dead") this.revived(b);
    const s = this.sense(b, hero);
    this.trackSeen(b, s);
    this.learnPass(b, hero);
    this.hearPass(b, hero);
    this.killTalk(b);
    this.decide(b, hero, s);
    const ctx = this.spellCtx(b, hero, s);
    const cast = castPass(ctx);
    this.itemPass(b, hero, s);
    // A cast just issued, or one winding up or channelling, is not walked away from — unless the
    // hero is leaving, in which case walking is the point.
    const leaving = b.mode === "home" || b.mode === "backoff";
    if ((cast || hero.order === "cast" || channeling(hero)) && !leaving) return;
    if (b.clock < b.channelUntil) return; // a Scroll of Teleportation is channelling — see itemPass
    // The shop walk comes FIRST and owns the legs while it lasts: the fountain walk and the shop walk
    // issued one after the other would re-path the hero between the two every pass.
    if (this.shopPass(b, hero, s)) return;
    this.movePass(b, hero, s);
  }

  // --- finding things ---------------------------------------------------------------------

  private getFrame(): Frame {
    if (this.frame) return this.frame;
    const f: Frame = { heroes: [], units: [], buildings: [], byType: new Map() };
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.vanished) continue;
      const list = f.byType.get(u.typeId);
      if (list) list.push(u);
      else f.byType.set(u.typeId, [u]);
      if (u.owner < 0 || u.owner > PLAYER_NEUTRAL_HOSTILE) continue;
      if (u.building) f.buildings.push(u);
      else if (u.isHero && !u.isIllusion) f.heroes.push(u);
      else f.units.push(u);
    }
    this.frame = f;
    return f;
  }

  private ofType(typeId: string): readonly SimUnit[] {
    return this.getFrame().byType.get(typeId) ?? [];
  }

  /** This seat's hero, alive and ITS OWN — a dead one on this map is a Neutral Passive corpse. */
  private heroOf(b: Brain): SimUnit | null {
    const known = b.heroId ? this.host.world.units.get(b.heroId) : undefined;
    if (known && known.owner === b.player && known.hp > 0 && !known.paused) return known;
    for (const u of this.getFrame().heroes) {
      if (u.owner !== b.player || u.paused || !HERO_CLASS[u.typeId]) continue;
      b.heroId = u.id;
      b.cls = HERO_CLASS[u.typeId];
      return u;
    }
    return null;
  }

  private hostile(b: Brain, u: SimUnit): boolean {
    if (u.owner === PLAYER_NEUTRAL_HOSTILE) return true;
    return u.owner >= 0 && u.owner < MELEE.MAX_PLAYERS && u.owner !== b.player && !this.host.coAllied(b.player, u.owner);
  }

  private allied(b: Brain, u: SimUnit): boolean {
    return u.owner >= 0 && u.owner < MELEE.MAX_PLAYERS && (u.owner === b.player || this.host.coAllied(b.player, u.owner));
  }

  /** Can this computer SEE that unit — its own side's fog, and never a unit that is invisible to it. */
  private sees(b: Brain, u: SimUnit): boolean {
    return !u.invisible && this.host.visible(b.player, u.x, u.y);
  }

  private sense(b: Brain, hero: SimUnit): Sense {
    const f = this.getFrame();
    const s: Sense = { foeHeroes: [], foeUnits: [], foeTowers: [], foeBuildings: [], allyHeroes: [], allyUnits: [] };
    for (const u of f.heroes) {
      const d = dist(hero, u);
      if (d > LOOK) continue;
      if (this.allied(b, u)) s.allyHeroes.push(u);
      // An ELITE creep can be a hero-flagged unit (`nerw`, `nubw`) — a camp, not an opponent.
      else if (this.hostile(b, u) && u.owner !== PLAYER_NEUTRAL_HOSTILE && !u.invulnerable && this.sees(b, u)) s.foeHeroes.push(u);
    }
    for (const u of f.units) {
      const d = dist(hero, u);
      if (d > NEAR) continue;
      if (this.allied(b, u)) s.allyUnits.push(u);
      else if (this.hostile(b, u) && !u.invulnerable && this.sees(b, u)) {
        // A creep CAMP is not the lane: only one that is swinging at us counts.
        if (u.owner === PLAYER_NEUTRAL_HOSTILE && u.targetId !== hero.id) continue;
        s.foeUnits.push(u);
      }
    }
    for (const u of f.buildings) {
      if (!this.hostile(b, u) || u.owner === PLAYER_NEUTRAL_HOSTILE) continue;
      const d = dist(hero, u);
      if (u.weapon && u.weapon.range > 0 && d <= 1600) s.foeTowers.push(u);
      if (!u.invulnerable && d <= NEAR) s.foeBuildings.push(u);
    }
    return s;
  }

  private trackSeen(b: Brain, s: Sense): void {
    const ids = new Set(s.foeHeroes.map((u) => u.id));
    for (const id of [...b.seen.keys()]) if (!ids.has(id)) b.seen.delete(id);
    for (const u of s.foeHeroes) if (!b.seen.has(u.id)) b.seen.set(u.id, b.clock);
    b.foesNearLast = s.foeHeroes.length > 0;
  }

  // --- the pick ---------------------------------------------------------------------------

  /**
   * PICK A HERO the way a person does — `Pick_Heroes` fires on `EVENT_PLAYER_UNIT_SELECTED`, shows a
   * costume's description on the first selection and hands the hero over on the second, and it has
   * no controller check. So the computer selects its costume twice (`CandyHost.select`) and the map
   * does the rest: creates the hero at the side's spawn, gives it Boots of Haste and a Scroll of
   * Teleportation, marks the seat as picked.
   *
   * It waits for `udg_GameOn` (control handed back after the intro) so a pick is never made under
   * the cinematic, and it picks for the TEAM: a healer if there is none, a front line if there is
   * none, and never a class somebody on the side already plays when another is free.
   */
  private pickPass(b: Brain): void {
    if (b.clock < b.pickAt) return;
    if (this.host.scriptBool("udg_GameOn") === false && b.clock < 120) return;
    if (b.pickStep === 0) {
      const cls = this.choosePick(b);
      const model = this.getFrame().buildings.concat(this.getFrame().heroes)
        .find((u) => u.owner === b.side.army && u.isHero && HERO_CLASS[u.typeId] === cls && inBox(b.side.pickArea, u.x, u.y))
        ?? this.getFrame().heroes.find((u) => u.owner === b.side.army && HERO_CLASS[u.typeId] === cls);
      if (!model) { b.pickAt = b.clock + 2; return; }
      b.cls = cls;
      b.pickModel = model.id;
      this.host.select(b.player, model.id);
      b.pickStep = 1;
      b.pickStepAt = b.clock;
    } else if (b.pickStep === 1 && b.clock - b.pickStepAt >= 0.7) {
      this.host.select(b.player, b.pickModel);
      b.pickStep = 2;
      b.pickStepAt = b.clock;
    } else if (b.pickStep === 2 && b.clock - b.pickStepAt >= 6) {
      // Nothing came of it (a costume that moved, a trigger not yet on) — try again.
      b.pickStep = 0;
      b.pickAt = b.clock + 2;
    }
  }

  private choosePick(b: Brain): HeroClass {
    const taken = new Set<HeroClass>();
    for (const u of this.getFrame().heroes) {
      if (u.owner === b.side.army || !this.allied(b, u)) continue;
      const c = HERO_CLASS[u.typeId];
      if (c) taken.add(c);
    }
    for (const other of this.brains) if (other !== b && other.side === b.side && other.cls) taken.add(other.cls);
    // Only the classes this side's costume rack actually holds — the Horde has the Shaman and the
    // Alliance the Paladin (war3mapUnits.doo).
    const racked = new Set<HeroClass>();
    for (const u of this.getFrame().heroes) if (u.owner === b.side.army && HERO_CLASS[u.typeId]) racked.add(HERO_CLASS[u.typeId]);
    const open = PICK_ORDER.filter((c) => racked.has(c) && !taken.has(c));
    if (!open.length) {
      const any = PICK_ORDER.filter((c) => racked.has(c));
      return any[Math.floor(b.rng() * any.length)] ?? "warrior";
    }
    const hasHealer = [...taken].some((c) => c === "priest" || c === "druid" || c === "paladin" || c === "shaman");
    const hasFront = [...taken].some((c) => MELEE_CLASSES.has(c));
    if (!hasHealer) {
      const heal = open.filter((c) => c === "priest" || c === "druid" || c === "paladin" || c === "shaman");
      if (heal.length) return heal[Math.floor(b.rng() * Math.min(2, heal.length))];
    }
    if (!hasFront) {
      const front = open.filter((c) => MELEE_CLASSES.has(c));
      if (front.length) return front[Math.floor(b.rng() * front.length)];
    }
    // …otherwise one of the first few open ones, so two matches on the same seed do not always
    // produce the same team but the team is still sensible.
    return open[Math.floor(b.rng() * Math.min(3, open.length))];
  }

  // --- learning ---------------------------------------------------------------------------

  private learnPass(b: Brain, hero: SimUnit): void {
    if (hero.skillPoints <= 0 || !b.cls) return;
    for (const id of SKILLS[b.cls]) {
      if (!this.host.execute(b.player, { c: "learnskill", unitId: hero.id, abilityId: id })) continue;
      if (AUTOCAST_ON.includes(id)) {
        const ab = hero.abilities.find((a) => a.id === id);
        if (ab && !ab.autocastOn) this.host.execute(b.player, { c: "autocast", unitId: hero.id, code: ab.code });
      }
      return;
    }
  }

  // --- deciding -----------------------------------------------------------------------------

  private decide(b: Brain, hero: SimUnit, s: Sense): void {
    const P = b.profile;
    const cls = b.cls ?? "warrior";
    const hp = pct(hero);
    const mp = hero.maxMana > 0 ? hero.mana / hero.maxMana : 1;
    const foesClose = s.foeHeroes.filter((f) => dist(hero, f) <= 900);
    const ratio = this.ratioAt(hero, s);

    // HELLFIRE burns the Warlock for 100 a second for as long as it is held (`Warlock_Hellfire`), so
    // the channel is broken — by walking — before it finishes the job for the enemy.
    if (channeling(hero) && hero.pendingCast?.abilityId === "AEsf" && hp < 0.45) {
      b.mode = "backoff";
      b.backoffUntil = b.clock + 2;
      b.target = 0;
      return;
    }

    // Home, until it is fit to come back.
    if (b.mode === "home") {
      const manaOk = SAPPER.has(cls) || !CASTER.has(cls) || !P.retreatMana || mp >= 0.6;
      const atFountain = dist(hero, b.side.fountain) <= 700;
      if (hp >= P.returnHp && manaOk && (atFountain || foesClose.length === 0)) {
        b.mode = "lane";
        b.laneSaid = false;
      } else return;
    }

    // …and when to GO home.
    let flee = hp < P.retreatHp;
    if (P.readsFights && foesClose.length && hp < 0.5 && ratio < 0.75) flee = true;
    if (P.retreatMana && CASTER.has(cls) && mp < P.retreatMana && foesClose.length === 0 && hp < 0.95) flee = true;
    // A shopping trip: a full build item's gold in the bank, a little hurt, nobody around.
    if (P.shopSmart && foesClose.length === 0 && hp < 0.8 && this.nextBuy(b, hero) && dist(hero, b.side.fountain) < 5000) flee = true;
    if (flee) {
      if (hp < P.retreatHp + 0.1 && foesClose.length && b.clock - b.spokeAt > CANDY_TALK_GAP && b.rng() < 0.5) this.tell(b, SELF_BACK_LINES);
      b.mode = "home";
      b.target = 0;
      return;
    }

    // The whole side is outnumbered where this hero stands — say so, and step back with it.
    if (P.readsFights && foesClose.length >= 3 && foesClose.length >= s.allyHeroes.length + 2 && ratio < 0.7) {
      if (b.clock - b.warnAt > WARN_GAP) {
        b.warnAt = b.clock;
        this.tell(b, TEAM_BACK_LINES);
      }
      b.mode = "backoff";
      b.backoffUntil = b.clock + 4;
      b.target = 0;
      return;
    }
    if (b.mode === "backoff" && b.clock < b.backoffUntil) return;
    if (b.mode === "backoff") b.mode = "lane";
    if (b.mode === "help" && (b.clock > b.helpUntil || !this.host.world.units.get(b.helpAnchor))) b.mode = "lane";

    // FIGHT: keep the current target while it is worth it, join an ally's, or pick one.
    const t = this.chooseTarget(b, hero, s);
    if (t) {
      if (t.id !== b.target) {
        b.target = t.id;
        b.targetFrom = { x: hero.x, y: hero.y };
        this.announceEngage(b, hero, t, s);
      }
      if (b.mode !== "help") b.mode = "fight";
      return;
    }
    b.target = 0;
    b.joined = false;
    if (b.mode === "fight") b.mode = "lane";

    // HARASS: a free swing at an enemy hero standing in reach, and back out of it.
    if (P.readsFights && b.mode === "lane" && b.clock >= b.harassNext && hp >= 0.6 && ratio >= 0.9) {
      const range = (hero.weapon?.range ?? 100) + 120;
      const prey = s.foeHeroes.find((f) => edge(hero, f) <= range && !this.towerCovers(s, f.x, f.y, 100) && !this.towerCovers(s, hero.x, hero.y, 0));
      if (prey) {
        b.target = prey.id;
        b.targetFrom = { x: hero.x, y: hero.y };
        b.harassUntil = b.clock + 1.2 + (hero.weapon?.cooldown ?? 1.5);
        b.harassNext = b.clock + 6;
        b.mode = "fight";
      }
    }
  }

  /**
   * WHO to fight. The current target while it is still worth it, else an ally's (focus), else the
   * best of what is in front of it — and "worth it" is the difficulty's whole reading of a fight.
   */
  private chooseTarget(b: Brain, hero: SimUnit, s: Sense): SimUnit | null {
    const P = b.profile;
    const cur = b.target ? this.host.world.units.get(b.target) : undefined;
    if (cur && cur.hp > 0 && this.hostile(b, cur) && !cur.invulnerable && this.sees(b, cur) && !inBox(b.foe.shopArea, cur.x, cur.y)) {
      const chased = b.targetFrom ? dist(b.targetFrom, cur) : 0;
      const harassDone = b.harassUntil > 0 && b.clock > b.harassUntil;
      if (harassDone) b.harassUntil = 0;
      // A harass is its own bar (`decide`): the swing it started is finished even when the fight
      // bar would not have started one.
      const harassing = b.harassUntil > b.clock;
      if (chased <= P.chase && !harassDone && (harassing || !P.readsFights || this.worthFighting(b, hero, cur, s))) return cur;
      if (harassDone && this.worthFighting(b, hero, cur, s) && pct(cur) <= P.killHp) return cur;
    }
    if (P.focus) {
      const joined = this.allyEngagement(b, hero, s);
      if (joined && this.worthFighting(b, hero, joined, s)) {
        b.joined = true;
        return joined;
      }
    }
    const reachFor = P.readsFights ? 950 : 600;
    const cands = s.foeHeroes.filter((f) => dist(hero, f) <= reachFor && !inBox(b.foe.shopArea, f.x, f.y) && this.worthFighting(b, hero, f, s));
    if (!cands.length) return null;
    if (!P.readsFights) return cands.sort((x, y) => dist(hero, x) - dist(hero, y))[0];
    const score = (f: SimUnit): number =>
      (1 - pct(f)) * 3 - dist(hero, f) / 900 + (CASTER.has(HERO_CLASS[f.typeId] ?? "warrior") ? 0.4 : 0) - (this.towerCovers(s, f.x, f.y, 100) ? 1.5 : 0);
    return cands.sort((x, y) => score(y) - score(x))[0];
  }

  private worthFighting(b: Brain, hero: SimUnit, t: SimUnit, s: Sense): boolean {
    const P = b.profile;
    const hp = pct(hero);
    if (!P.readsFights) return hp >= 0.3;
    if (hp < P.retreatHp + 0.12) return false;
    const tp = pct(t);
    const r = this.ratioAt(t, s);
    const underTower = this.towerCovers(s, t.x, t.y, 120) && !this.creepsTanking(b, s, t);
    if (underTower && !(tp <= P.killHp && hp >= 0.6 && r >= 1.2)) return false;
    return r >= 1.1 || (tp <= P.killHp && r >= 0.65) || (tp + 0.25 < hp && r >= 0.85);
  }

  /** An enemy hero an ally near us is fighting — seen (its attack or its spell is on it) or declared. */
  private allyEngagement(b: Brain, hero: SimUnit, s: Sense): SimUnit | null {
    for (const a of s.allyHeroes) {
      if (a.id === hero.id) continue;
      const tid = a.order === "attack" ? a.targetId : a.pendingCast?.targetId;
      if (!tid) continue;
      const t = s.foeHeroes.find((f) => f.id === tid);
      if (t && dist(hero, t) <= 1400) return t;
    }
    for (const e of this.engagements) {
      if (e.side !== b.side || e.from === b.player || e.until < b.clock) continue;
      const t = s.foeHeroes.find((f) => f.id === e.targetId);
      if (t && dist(hero, t) <= 1800) return t;
    }
    return null;
  }

  /** "going in on the undead warlock" — or, joining somebody else's, "with you on the warlock". */
  private announceEngage(b: Brain, hero: SimUnit, t: SimUnit, s: Sense): void {
    // Every difficulty SAYS it — telling the team who you are going in on is table stakes on a lane
    // map. Whether a teammate then JOINS is the listener's `focus`.
    if (b.harassUntil > 0) return;
    this.engagements.push({ side: b.side, from: b.player, targetId: t.id, until: b.clock + ENGAGE_HOLD });
    const others = s.allyHeroes.filter((a) => a.id !== hero.id).length;
    if (!others && !b.joined) return;
    if (b.engageSaidOn === t.id && b.clock - b.engageSaidAt < ENGAGE_TALK_GAP) return;
    if (b.clock - b.spokeAt < 4) return;
    b.engageSaidOn = t.id;
    b.engageSaidAt = b.clock;
    const name = this.heroName(t);
    this.tell(b, b.joined ? followLines(name) : engageLines(name));
  }

  /**
   * Its side against theirs around `at`, as √Σ(life × damage) — plus/power.ts's measure, applied to
   * heroes, with an enemy TOWER that has nothing else to shoot counted against us.
   */
  private ratioAt(at: { x: number; y: number }, s: Sense): number {
    let mine = 0;
    let theirs = 0;
    for (const a of s.allyHeroes) if (dist(at, a) <= 900) mine += strength(a);
    for (const f of s.foeHeroes) if (dist(at, f) <= 900) theirs += strength(f);
    for (const t of s.foeTowers) {
      if (dist(at, t) > (t.weapon?.range ?? 0) + t.radius + 150) continue;
      if (s.allyUnits.some((u) => dist(u, t) <= (t.weapon?.range ?? 0) + t.radius)) continue;
      theirs += strength(t) * 0.6;
    }
    if (theirs <= 0) return Infinity;
    return Math.sqrt(mine) / Math.sqrt(theirs);
  }

  private towerCovers(s: Sense, x: number, y: number, slack: number): boolean {
    return s.foeTowers.some((t) => Math.hypot(t.x - x, t.y - y) <= (t.weapon?.range ?? 0) + t.radius + slack);
  }

  /** Are our creeps standing under the tower that covers `t`, so the tower has somebody else to shoot? */
  private creepsTanking(b: Brain, s: Sense, t: { x: number; y: number }): boolean {
    for (const tower of s.foeTowers) {
      const reach = (tower.weapon?.range ?? 0) + tower.radius;
      if (Math.hypot(tower.x - t.x, tower.y - t.y) > reach + 120) continue;
      if (s.allyUnits.filter((u) => u.owner === b.side.army && dist(u, tower) <= reach).length < 2) return false;
    }
    return true;
  }

  // --- spells -------------------------------------------------------------------------------

  private spellCtx(b: Brain, hero: SimUnit, s: Sense): SpellCtx {
    const ready = (id: string) => {
      const ab = hero.abilities.find((a) => a.id === id && a.level >= 1);
      if (!ab || ab.cooldownLeft > 0) return null;
      const def = this.host.abilities.get(ab.id);
      if (!def) return null;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (lvl && lvl.cost > hero.mana) return null;
      return { ab, def, rank: ab.level };
    };
    const cast = (id: string, targetId: number, x: number, y: number): boolean => {
      const r = ready(id);
      if (!r) return false;
      if (this.host.world.castError(hero.id, r.ab.code, targetId, x, y) !== null) return false;
      const ok = this.host.execute(b.player, { c: "cast", unitId: hero.id, code: r.ab.code, targetId, x, y, queued: false });
      if (ok) {
        b.lastCast.set(id, b.clock);
        b.orderKey = "";
      }
      return ok;
    };
    const target = b.target ? this.host.world.units.get(b.target) ?? null : null;
    return {
      hero, cls: b.cls ?? "warrior", profile: b.profile,
      foeHeroes: s.foeHeroes, foeUnits: s.foeUnits, allyHeroes: s.allyHeroes,
      target: target && target.hp > 0 ? target : null,
      fleeing: b.mode === "home" || b.mode === "backoff",
      seenFor: (u) => b.clock - (b.seen.get(u.id) ?? b.clock),
      sinceCast: (id) => b.clock - (b.lastCast.get(id) ?? -Infinity),
      ready,
      castUnit: (id, t) => cast(id, t.id, t.x, t.y),
      castPoint: (id, x, y) => cast(id, 0, x, y),
      castSelf: (id) => cast(id, 0, hero.x, hero.y),
      roll: b.rng,
      ownCount: (typeId) => this.ofType(typeId).filter((u) => u.owner === b.player).length,
      underTower: (x, y, slack = 0) => this.towerCovers(s, x, y, slack),
    };
  }

  // --- moving -------------------------------------------------------------------------------

  private movePass(b: Brain, hero: SimUnit, s: Sense): void {
    switch (b.mode) {
      case "home": {
        const f = b.side.fountain;
        if (dist(hero, f) > 300) this.move(b, hero, f.x, f.y);
        return;
      }
      case "backoff": {
        const pr = project(b.lane, hero);
        const back = pointAt(b.lane, pr.t - b.side.forward * 700);
        this.move(b, hero, back.x, back.y);
        return;
      }
      case "fight": {
        const t = b.target ? this.host.world.units.get(b.target) : undefined;
        if (t && t.hp > 0) return void this.attack(b, hero, t);
        b.mode = "lane";
        return this.laneMove(b, hero, s);
      }
      case "help": {
        // At the ally, the fight it came for is the job — `decide` has picked the target.
        const t = b.target ? this.host.world.units.get(b.target) : undefined;
        if (t && t.hp > 0) return void this.attack(b, hero, t);
        const anchor = this.host.world.units.get(b.helpAnchor);
        if (!anchor) { b.mode = "lane"; return; }
        if (dist(hero, anchor) > 400) this.attackMove(b, hero, anchor.x, anchor.y);
        return;
      }
      default:
        return this.laneMove(b, hero, s);
    }
  }

  /**
   * THE OBJECTIVE. In order: an enemy Candy Vault that has lost its shield (the game ends there);
   * this lane's candy monster while the enemy mage it would kill is alive (escort it); this lane's
   * monster on OUR half while our mage is alive (stand by it — two sides within 600 freeze it); and
   * otherwise another lane that still has something to win.
   */
  private laneMove(b: Brain, hero: SimUnit, s: Sense): void {
    const vault = this.ofType(b.foe.vault)[0];
    if (vault && !vault.invulnerable) {
      if (dist(hero, vault) <= 900 && !s.foeHeroes.some((f) => dist(vault, f) <= 800)) return void this.attack(b, hero, vault);
      return void this.attackMove(b, hero, vault.x, vault.y);
    }
    if (!b.laneChosen) {
      b.lane = this.pickLane(b, hero);
      b.laneChosen = true;
    }
    if (b.clock > b.rallyUntil && this.laneValue(b, b.lane) <= 0) {
      const next = this.pickLane(b, hero);
      if (next !== b.lane) {
        b.lane = next;
        if (b.laneSaid) this.tell(b, laneSwitchLines(next));
      }
    }
    if (!b.laneSaid && !inBox(b.side.shopArea, hero.x, hero.y)) {
      b.laneSaid = true;
      if (b.clock - b.spokeAt > 3) this.tell(b, LANE_LINES[b.lane]);
    }
    const lane = b.lane;
    const monster = this.ofType(MONSTERS[lane])[0];
    const attackOn = this.mageAlive(b.foe.mages[lane]);
    if (monster && (attackOn || this.onOurHalf(b, lane, monster))) return this.escort(b, hero, s, lane, monster, attackOn);
    this.push(b, hero, s, lane);
  }

  /** Walk BEHIND the monster, within its 600, farming what comes at it — and wait for creeps
   *  before walking it under a tower. */
  private escort(b: Brain, hero: SimUnit, s: Sense, lane: Lane, monster: SimUnit, forward: boolean): void {
    const P = b.profile;
    const pr = project(lane, monster);
    const spot = pointAt(lane, pr.t - b.side.forward * (forward ? 260 : -120));
    const tower = s.foeTowers.find((t) => dist(t, spot) <= (t.weapon?.range ?? 0) + t.radius + 150);
    if (forward && tower && P.towerSense) {
      const reach = (tower.weapon?.range ?? 0) + tower.radius;
      const tanks = s.allyUnits.filter((u) => u.owner === b.side.army && dist(u, tower) <= reach).length;
      const friends = s.allyHeroes.filter((a) => dist(a, tower) <= reach + 600).length;
      const rallied = b.clock <= b.rallyUntil && friends >= 2;
      if (tanks >= 2 || friends >= 3 || rallied) {
        if (!s.foeHeroes.some((f) => dist(f, tower) <= reach)) return void this.attack(b, hero, tower);
      } else {
        const wait = pointAt(lane, project(lane, tower).t - b.side.forward * (reach + 260));
        const creep = this.pickCreep(b, hero, s, wait, 700);
        if (creep && !this.towerCovers(s, creep.x, creep.y, 60)) return void this.attack(b, hero, creep);
        if (dist(hero, wait) > 150) this.move(b, hero, wait.x, wait.y);
        return;
      }
    }
    // A stealthed hero pushes nothing (`Crate_Detection_*` skips a `BOwk` buff): swing at something.
    const creep = this.pickCreep(b, hero, s, monster, PUSH_REACH + 50) ?? (hero.invisible ? this.pickCreep(b, hero, s, null, 900) : null);
    if (creep && (!P.towerSense || !this.towerCovers(s, creep.x, creep.y, 60) || this.creepsTanking(b, s, creep))) return void this.attack(b, hero, creep);
    // Far off, it WALKS to the monster fighting whatever it meets — a plain move would stroll through
    // an enemy wave taking hits it never answers. Close, it steps into place.
    if (dist(hero, spot) > 900) this.attackMove(b, hero, spot.x, spot.y);
    else if (dist(hero, spot) > 140) this.move(b, hero, spot.x, spot.y);
  }

  /** No monster to walk: take the lane's buildings with the creeps, or wait for them. */
  private push(b: Brain, hero: SimUnit, s: Sense, lane: Lane): void {
    const P = b.profile;
    // Never a building inside their shopping area — a hero that walks in is teleported out
    // (`Anti_Camping_*`), and would walk straight back in on the next pass.
    const building = s.foeBuildings.filter((u) => !inBox(b.foe.shopArea, u.x, u.y)).sort((x, y) => dist(hero, x) - dist(hero, y))[0];
    if (building) {
      const covered = this.towerCovers(s, building.x, building.y, 0) || (building.weapon?.range ?? 0) > 0;
      if (!P.towerSense || !covered || this.creepsTanking(b, s, building) || s.allyHeroes.length >= 3) {
        if (!s.foeHeroes.some((f) => dist(f, building) <= 700)) return void this.attack(b, hero, building);
      }
    }
    const creep = this.pickCreep(b, hero, s, null, 0);
    if (creep && (!P.towerSense || !this.towerCovers(s, creep.x, creep.y, 60) || this.creepsTanking(b, s, creep))) return void this.attack(b, hero, creep);
    const pr = project(lane, hero);
    let ahead = pointAt(lane, pr.t + b.side.forward * 600);
    if (P.towerSense && this.towerCovers(s, ahead.x, ahead.y, 120) && !this.creepsTanking(b, s, ahead)) ahead = pointAt(lane, pr.t);
    if (dist(hero, ahead) > 150) this.attackMove(b, hero, ahead.x, ahead.y);
  }

  /** The creep to swing at: one it can finish (Insane last-hits for the bounty), else the weakest. */
  private pickCreep(b: Brain, hero: SimUnit, s: Sense, anchor: { x: number; y: number } | null, within: number): SimUnit | null {
    const range = (hero.weapon?.range ?? 100) + 250;
    const cands = s.foeUnits.filter((u) => edge(hero, u) <= range && (!anchor || Math.hypot(anchor.x - u.x, anchor.y - u.y) <= within));
    if (!cands.length) return null;
    if (b.profile.lastHit) {
      const blow = avgDamage(hero) * 1.15;
      const kill = cands.filter((u) => u.hp <= blow).sort((x, y) => x.hp - y.hp)[0];
      if (kill) return kill;
    }
    return cands.sort((x, y) => x.hp - y.hp)[0];
  }

  private mageAlive(typeId: string): boolean {
    return this.ofType(typeId).length > 0;
  }

  private onOurHalf(b: Brain, lane: Lane, u: SimUnit): boolean {
    const t = project(lane, u).t;
    const len = project(lane, LANE_END[lane]).t;
    return b.side.forward > 0 ? t < len / 2 : t > len / 2;
  }

  /** What a lane is still worth to this side: 2 while there is an enemy mage in it to kill, 1 while
   *  its monster is on our half with our mage to lose, 0 when there is nothing left there. */
  private laneValue(b: Brain, lane: Lane): number {
    const monster = this.ofType(MONSTERS[lane])[0];
    if (this.mageAlive(b.foe.mages[lane])) return 2;
    if (monster && this.mageAlive(b.side.mages[lane]) && this.onOurHalf(b, lane, monster)) return 1;
    return 0;
  }

  /**
   * THE LANE SPLIT. The lane with the fewest of its side already in it among those still worth
   * something — counting the other computers' choices, the lanes the people on the team CLAIMED in
   * chat, and, for a person who said nothing, the lane their hero is standing in.
   */
  private pickLane(b: Brain, hero: SimUnit | null): Lane {
    const count: Record<Lane, number> = { top: 0, mid: 0, bot: 0 };
    for (const o of this.brains) if (o !== b && o.side === b.side && o.laneChosen) count[o.lane]++;
    for (const u of this.getFrame().heroes) {
      if (u.owner === b.player || u.owner === b.side.army || !this.allied(b, u)) continue;
      if (this.brains.some((o) => o.player === u.owner)) continue;
      const claim = this.claims.get(u.owner);
      const lane = claim && b.clock - claim.at < 240 ? claim.lane : dist(u, b.side.base) > 2200 ? laneOf(u) : null;
      if (lane) count[lane]++;
    }
    const worth = LANES.filter((l) => this.laneValue(b, l) > 0);
    const pool = worth.length ? worth : LANES;
    const least = Math.min(...pool.map((l) => count[l]));
    const best = pool.filter((l) => count[l] === least);
    // The hero's own lane wins a tie — nobody walks across the map to break a draw.
    const here = hero ? laneOf(hero) : null;
    if (here && best.includes(here) && b.heroId && b.laneSaid) return here;
    return best[Math.floor(b.rng() * best.length)];
  }

  // --- orders -------------------------------------------------------------------------------

  private attack(b: Brain, hero: SimUnit, t: SimUnit): void {
    if (hero.order === "attack" && hero.targetId === t.id) return;
    this.order(b, hero, `a${t.id}`, { c: "order", unitId: hero.id, order: { kind: "attack", targetId: t.id }, queued: false });
  }

  private move(b: Brain, hero: SimUnit, x: number, y: number): void {
    this.order(b, hero, `m${Math.round(x / 96)},${Math.round(y / 96)}`, { c: "order", unitId: hero.id, order: { kind: "move", x, y }, queued: false });
  }

  private attackMove(b: Brain, hero: SimUnit, x: number, y: number): void {
    this.order(b, hero, `am${Math.round(x / 96)},${Math.round(y / 96)}`, { c: "order", unitId: hero.id, order: { kind: "attackmove", x, y }, queued: false });
  }

  /** One order, not the same order every pass: a path search per repeat is a cost and a stutter. */
  private order(b: Brain, hero: SimUnit, key: string, cmd: Parameters<CandyHost["execute"]>[1]): void {
    if (key === b.orderKey && b.clock - b.orderAt < 3 && hero.order !== "idle") return;
    if (this.host.execute(b.player, cmd)) {
      b.orderKey = key;
      b.orderAt = b.clock;
    }
  }

  // --- items --------------------------------------------------------------------------------

  /** Press what it carries — the Normal and Insane habit; an Easy computer never touches a potion. */
  private itemPass(b: Brain, hero: SimUnit, s: Sense): void {
    const P = b.profile;
    if (!P.items) return;
    const hp = pct(hero);
    const mp = hero.maxMana > 0 ? hero.mana / hero.maxMana : 1;
    const target = b.target ? this.host.world.units.get(b.target) : undefined;
    const fleeing = b.mode === "home" || b.mode === "backoff";
    const chaser = s.foeHeroes.find((f) => dist(hero, f) <= 700);
    const quiet = s.foeHeroes.length === 0 && s.foeUnits.every((u) => dist(hero, u) > 900);
    hero.inventory.forEach((it, slot) => {
      if (!it) return;
      const use = ITEM_USE[it.itemId];
      if (!use) return;
      if (b.clock - (b.itemTried.get(it.itemId) ?? -Infinity) < 2) return;
      let targetId = 0;
      let x = hero.x;
      let y = hero.y;
      let go = false;
      switch (use) {
        case "heal": go = hp < (chaser ? 0.4 : 0.3); break;
        case "regen": go = hp < 0.6 && quiet; break;
        case "mana": go = !SAPPER.has(b.cls ?? "warrior") && mp < 0.25 && !!(target || chaser); break;
        case "haste": go = (fleeing && !!chaser) || (!!target && pct(target) <= P.killHp && edge(hero, target) > (hero.weapon?.range ?? 100) + 150); break;
        case "shield": go = hp < 0.22 && !!chaser; break;
        case "armor": go = !!target && edge(hero, target) <= 500; break;
        case "roar": go = !!target && edge(hero, target) <= 400; break;
        case "curse": go = s.foeHeroes.filter((f) => dist(hero, f) <= 600).length >= 2; break;
        case "hex":
        case "nova": {
          const on = fleeing ? chaser : target && edge(hero, target) <= 550 ? target : undefined;
          if (on) { go = true; targetId = on.id; x = on.x; y = on.y; }
          break;
        }
        case "blink": {
          if (fleeing && chaser) {
            const f = b.side.fountain;
            const d = dist(hero, f) || 1;
            x = hero.x + ((f.x - hero.x) / d) * 900;
            y = hero.y + ((f.y - hero.y) / d) * 900;
            go = true;
          }
          break;
        }
        case "teleport": {
          // Home by scroll: far from it, hurt, and nobody close enough to interrupt the channel.
          const fountain = this.ofType("nfnp").find((u) => u.owner === b.side.army);
          if (fleeing && fountain && dist(hero, fountain) > 4500 && !chaser && hp < 0.6) {
            go = true; targetId = fountain.id; x = fountain.x; y = fountain.y;
          }
          // …or to an ally who asked for help across the map.
          const anchor = b.mode === "help" ? this.host.world.units.get(b.helpAnchor) : undefined;
          if (!go && anchor && dist(hero, anchor) > 4500 && !chaser) {
            go = true; targetId = anchor.id; x = anchor.x; y = anchor.y;
          }
          break;
        }
      }
      if (!go) return;
      b.itemTried.set(it.itemId, b.clock);
      const used = this.host.execute(b.player, { c: "useitem", unitId: hero.id, slot, targetId, x, y });
      // The scroll is a CHANNEL: an order given over it cancels the trip (see `think`).
      if (used && use === "teleport") b.channelUntil = b.clock + 4;
    });
  }

  /** The next thing on its list it can afford and legally carry, or null. */
  private nextBuy(b: Brain, hero: SimUnit): string | null {
    const cls = b.cls ?? "warrior";
    const held = hero.inventory.filter((i): i is NonNullable<typeof i> => !!i).map((i) => i.itemId);
    const free = hero.inventory.length ? hero.inventory.filter((i) => !i).length : 0;
    if (free <= 0) return null;
    const gold = this.host.world.stashOf(b.player).gold;
    const price = (id: string): number => this.host.items.get(id)?.gold ?? Infinity;
    const list = b.profile.shopSmart ? BUILDS[cls] : CHEAP_BUILD;
    for (const id of list) {
      if (held.includes(id)) continue;
      if (!mayCarry(cls, held, id)) continue;
      // Save for the list in ORDER — skipping to what it can afford now is how a caster ends the
      // game with four rings of regeneration and no Paleth's Visage.
      return gold >= price(id) ? id : null;
    }
    if (b.profile.items && !held.includes(POTION) && gold >= price(POTION) + 150) return POTION;
    return null;
  }

  /**
   * At the shops: buy the next item, and with the build done, the team's creep upgrades. True when it
   * has taken the hero's legs this pass (walking it to a shop).
   *
   * A buy that FAILS (the shelf is restocking, a trigger-stocked upgrade not unlocked yet) is not
   * retried for `BUY_RETRY` seconds, or a hero standing at a shop with gold would stand there for ever.
   */
  private shopPass(b: Brain, hero: SimUnit, s: Sense): boolean {
    if (!inBox(b.side.shopArea, hero.x, hero.y) && dist(hero, b.side.fountain) > 900) return false;
    if (s.foeHeroes.length) return false;
    let want = this.nextBuy(b, hero);
    if (!want && b.profile.shopSmart && b.cls) {
      const held = hero.inventory.filter(Boolean).map((i) => i!.itemId);
      const done = BUILDS[b.cls].every((id) => held.includes(id));
      const gold = this.host.world.stashOf(b.player).gold;
      if (done && gold >= 900) {
        want = TEAM_UPGRADES.find((id) => gold >= (this.host.items.get(id)?.gold ?? Infinity) + 300 && b.clock - (b.upgradeTried.get(id) ?? -Infinity) > 45) ?? null;
        if (want) b.upgradeTried.set(want, b.clock);
      }
    }
    if (!want) return false;
    if (b.clock - (b.itemTried.get(`buy:${want}`) ?? -Infinity) < BUY_RETRY) return false;
    const shopType = SHOP_OF[want];
    const shop = this.ofType(shopType).filter((u) => u.owner === b.side.army).sort((x, y) => dist(hero, x) - dist(hero, y))[0];
    if (!shop) return false;
    if (!this.host.world.shopReaches(shop.id, hero.id)) {
      this.move(b, hero, shop.x, shop.y);
      return true;
    }
    if (!this.host.execute(b.player, { c: "buyitem", shopId: shop.id, itemId: want })) b.itemTried.set(`buy:${want}`, b.clock);
    return false;
  }

  // --- death --------------------------------------------------------------------------------

  private died(b: Brain): void {
    const corpse = this.host.world.units.get(b.heroId);
    b.mode = "dead";
    b.target = 0;
    b.deathSpot = corpse ? { x: corpse.x, y: corpse.y } : null;
    b.deathLevel = corpse?.level ?? b.deathLevel;
    b.deathFoesNear = b.foesNearLast;
    b.laneSaid = false;
  }

  private revived(b: Brain): void {
    b.mode = "lane";
    b.seen.clear();
    b.orderKey = "";
  }

  /**
   * THE GHOST. On this map a dead hero is a corpse where it fell and an invisible, invulnerable ghost
   * at the graveyard (`Hero_Spirit_Spawn`), and the ghost has to go and get it: within 600 of the
   * corpse it is offered a free revive at 70% life (`AEsb`), within 300 of the Spirit Healer a full
   * one that costs experience (`ANbr`, or 400 gold at level 10 — `AAns`). Both only once the death
   * timer is up (`Resurrect_Detection`).
   *
   * The corpse is the better revive when it is not a trap: close, and not where the enemy that killed
   * it is still standing. Otherwise the healer, which stands in our own base.
   */
  private deadPass(b: Brain): void {
    const ghost = this.getFrame().units.find((u) => u.owner === b.player && GHOST_TYPES.has(u.typeId));
    if (!ghost) return;
    const corpse = this.host.world.units.get(b.heroId);
    const corpseAt = corpse ? { x: corpse.x, y: corpse.y } : b.deathSpot;
    const gold = this.host.world.stashOf(b.player).gold;
    const healerOk = b.deathLevel < 10 || gold >= 400;
    const corpseOk = !!corpseAt && dist(corpseAt, b.side.graveyard) <= 5200 && !inBox(b.foe.shopArea, corpseAt.x, corpseAt.y) &&
      (!b.deathFoesNear || !b.profile.readsFights);
    const dest = corpseOk || !healerOk ? corpseAt ?? b.side.healer : b.side.healer;
    const has = (id: string) => ghost.abilities.find((a) => a.id === id && a.level >= 1);
    const revive = (id: string): boolean => {
      const ab = has(id);
      if (!ab || ab.cooldownLeft > 0) return false;
      return this.host.execute(b.player, { c: "cast", unitId: ghost.id, code: ab.code, targetId: 0, x: ghost.x, y: ghost.y, queued: false });
    };
    if (corpseAt && dist(ghost, corpseAt) <= CORPSE_REACH - 40 && revive(REVIVE_CORPSE)) return;
    if (dist(ghost, b.side.healer) <= HEALER_REACH - 30 && (revive(REVIVE_HEALER) || revive(REVIVE_HEALER_MAX))) return;
    if (dist(ghost, dest) > (dest === b.side.healer ? 120 : 250)) {
      this.order(b, ghost, `g${Math.round(dest.x / 96)},${Math.round(dest.y / 96)}`, { c: "order", unitId: ghost.id, order: { kind: "move", x: dest.x, y: dest.y }, queued: false });
    }
  }

  // --- talk -----------------------------------------------------------------------------------

  private tell(b: Brain, lines: readonly string[]): void {
    if (!lines.length) return;
    b.spokeAt = b.clock;
    this.host.say(b.player, lines[Math.floor(b.rng() * lines.length)], "allies");
  }

  private heroName(u: SimUnit): string {
    return heroCallName(this.host.registry.get(u.typeId)?.name ?? "", u.properName);
  }

  /** The hero kills since the last pass: its own kills (a word to the team, and sometimes one to
   *  everybody) and its own death. */
  private killTalk(b: Brain): void {
    const kills = this.host.heroKills();
    for (const k of kills) {
      if (k.seq <= b.killSeq) continue;
      b.killSeq = k.seq;
      if (k.killerOwner === b.player && k.victimOwner !== b.player && k.victimOwner >= 0 && k.victimOwner < MELEE.MAX_PLAYERS && !this.host.coAllied(b.player, k.victimOwner)) {
        const name = heroCallName(this.host.registry.get(k.victimType)?.name ?? "", k.victimName);
        if (b.rng() < 0.35 && b.clock - b.spokeAt > 5) this.tell(b, killLines(name));
        if (b.rng() < BANTER_CHANCE && b.clock - b.banterAt > BANTER_GAP) {
          b.banterAt = b.clock;
          const lines = banterLines(name);
          this.host.say(b.player, lines[Math.floor(b.rng() * lines.length)], "all");
        }
      } else if (k.victimOwner === b.player) {
        if (b.rng() < 0.5 && b.clock - b.spokeAt > 5) this.tell(b, DEATH_LINES);
        if (k.killerOwner >= 0 && k.killerOwner < MELEE.MAX_PLAYERS && k.killerOwner !== b.foe.army && b.rng() < GOOD_SPORT_CHANCE && b.clock - b.banterAt > BANTER_GAP) {
          b.banterAt = b.clock;
          this.host.say(b.player, GOOD_SPORT_LINES[Math.floor(b.rng() * GOOD_SPORT_LINES.length)], "all");
        }
      }
    }
  }

  /**
   * What its allies said, read on its own turn: a call for help, a rally ("attack", "lets push mid"),
   * an engage on a named hero, a call to fall back, and a lane claim. A help call and a rally are
   * ANSWERED — yes, or no and why (plus/teamchat.ts `AllyCall`); the rest are acted on silently.
   */
  private hearPass(b: Brain, hero: SimUnit | null): void {
    const due = b.heard.filter((h) => h.at <= b.clock);
    if (!due.length) return;
    b.heard = b.heard.filter((h) => h.at > b.clock);
    for (const line of due) {
      const call = readCandyCall(line.text);
      if (!call || call.kind === "answer" || call.kind === "lane") continue;
      const callerHero = this.getFrame().heroes.find((u) => u.owner === line.from);
      const hp = hero ? pct(hero) : 0;
      if (call.kind === "retreat") {
        if (hero && callerHero && dist(hero, callerHero) <= 1600 && b.mode !== "home") {
          const t = b.target ? this.host.world.units.get(b.target) : undefined;
          if (!t || pct(t) > b.profile.killHp) {
            b.mode = "backoff";
            b.backoffUntil = b.clock + 4;
            b.target = 0;
          }
        }
        continue;
      }
      if (call.kind === "rally") {
        // An ENGAGE first: a line that names an enemy HERO ("going in on the undead warlock", "focus
        // the mage") is a call on that hero, joined silently by whoever is close enough — and never a
        // rally owed an answer. Tested before the rally for the loop reason plus/teamchat.ts gives:
        // every engage line a computer says names a hero, and one read as a rally would have every
        // teammate answer every other computer's dive with a yes or a no.
        const foes = this.getFrame().heroes.filter((u) => this.hostile(b, u) && u.owner !== PLAYER_NEUTRAL_HOSTILE);
        const id = namedHero(line.text, foes.map((u): HeroName => ({ id: u.id, typeName: this.host.registry.get(u.typeId)?.name ?? "", properName: u.properName })));
        if (id) {
          const t = this.host.world.units.get(id);
          if (t && hero && dist(hero, t) <= 2500 && hp >= 0.4) this.engagements.push({ side: b.side, from: line.from, targetId: t.id, until: b.clock + ENGAGE_HOLD });
          continue;
        }
        if (!call.ask) continue; // an engage verb with no hero in it is nothing
      }
      // Help, or a rally: owed an answer, once per `CANDY_ANSWER_GAP`.
      if (b.clock - b.answeredAt < CANDY_ANSWER_GAP) continue;
      b.answeredAt = b.clock;
      const fighting = b.mode === "fight" && !!b.target;
      if (call.kind === "help") {
        if (!hero) { this.tell(b, CANDY_BUSY_LINES.dead); continue; }
        if (hp < 0.35) { this.tell(b, CANDY_BUSY_LINES.hurt); continue; }
        if (fighting) { this.tell(b, CANDY_BUSY_LINES.fighting); continue; }
        const anchor = callerHero ?? null;
        const hasScroll = hero.inventory.some((i) => i?.itemId === "stwp");
        if (!anchor || (dist(hero, anchor) > 7000 && !hasScroll)) { this.tell(b, CANDY_BUSY_LINES.far); continue; }
        b.mode = "help";
        b.helpAnchor = anchor.id;
        b.helpUntil = b.clock + 35;
        this.tell(b, CANDY_COMING_LINES);
        continue;
      }
      // A rally.
      if (!hero) { this.tell(b, CANDY_RALLY_NO_LINES.dead); continue; }
      if (hp < 0.35 || b.mode === "home") { this.tell(b, CANDY_RALLY_NO_LINES.hurt); continue; }
      if (fighting) { this.tell(b, CANDY_RALLY_NO_LINES.fighting); continue; }
      const lane = call.lane ?? laneIn(line.text) ?? (callerHero ? laneOf(callerHero) : null) ?? b.lane;
      if (lane !== b.lane) b.laneSaid = true;
      b.lane = lane;
      b.laneChosen = true;
      b.rallyUntil = b.clock + 60;
      b.mode = "lane";
      this.tell(b, CANDY_RALLY_YES_LINES);
    }
  }
}

/** Neutral Hostile's slot — creeps. */
const PLAYER_NEUTRAL_HOSTILE = 12;

/** Each lane's east end (its last waypoint), for "which half is it on". */
const LANE_END: Readonly<Record<Lane, Pt>> = {
  top: { x: 6368, y: 352 }, mid: { x: 6160, y: -256 }, bot: { x: 6624, y: -560 },
};

const pct = (u: SimUnit): number => (u.maxHp > 0 ? u.hp / u.maxHp : 0);
const edge = (a: SimUnit, b: SimUnit): number => Math.max(0, Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius);

function avgDamage(u: SimUnit): number {
  const w = u.weapon;
  return w ? w.damage + (w.dice * (w.sides + 1)) / 2 : 0;
}

/** Life × damage per second, with a hero's level standing in for the spells a swing does not show. */
function strength(u: SimUnit): number {
  const w = u.weapon;
  const dps = w ? avgDamage(u) / Math.max(0.5, w.cooldown) : 0;
  return Math.max(1, u.hp) * (dps + (u.isHero ? 8 * u.level + 10 : 0) + 1);
}

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
