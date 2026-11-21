import { Mulberry32Stream } from "../../../sim/streams";
import { PATHING_CELL } from "../../../sim/pathing";
import type { SimUnit, SimWorld } from "../../../sim/world";
import type { Command } from "../../../game/commands";
import {
  ARROW, GUN, GUN_HALF_WIDTH, GUN_REACH, MODEL_ATTR, PICK_NEXT, PICK_SELECT, STATUS, TRACK_CLIFF_LEVEL, UNITS_PER_SPEED,
  powerUpOf, rawcode, type ArrowKey, type PowerUp,
} from "./map";
import { grandPrixProfile, type GrandPrixProfile } from "./profile";
import { angleDiff, buildRoute, locate, speedPlan, type Gate, type Route } from "./route";

// Computer+ on Azeroth Grand Prix — a RACER for Blizzard's kart map (docs/grand-prix-ai.md).
//
// A scenario runs none of the melee library, and this map does not imagine a computer at all:
// every loop in its script asks for `MAP_CONTROL_USER`, so in the real game a computer seat simply
// is not in the race. Computer+ takes the seat the way plus/candy takes a Candy War hero seat —
// presented to the script as a player's, so the map's own init gives it a picker, a cart, a place
// on the board and a lap count — and then plays it with what a person has:
//
//  * the four ARROW KEYS, raised as the same `EVENT_PLAYER_ARROW_*` a keyboard raises
//    (`GrandPrixPort.arrow` → `Interpreter.firePlayerEvent`, the door `MapViewerScene.scriptArrow`
//    uses). The cart is never ordered, moved or turned by us: the map's own 0.05 s loop does that
//    off the keys it believes are held, for a computer exactly as for a person;
//  * its cart's BUTTONS — the picker's Next and Select, the four power-up slots, the machine gun —
//    through `execute`, the door a click goes through;
//  * the lap DIALOG, when the map hands it to this seat.
//
// No cheats at any difficulty: the same cart physics, the same top speed, the same dice on a gift
// box. What a rung changes is how close to the limit it drives and how well it spends what it
// picks up (profile.ts). Every number in this file is OURS; every map fact is map.ts's.

/** The doors a seat has onto the map's SCRIPT. The scene owns the interpreter, so it hands these
 *  in (`MapViewerScene.grandPrixPort`); the headless test hands in the same five over the same
 *  interpreter. Reads are what a racer reads off its own screen — the board, the speedometer, its
 *  slots — and the two writes are an input a person makes. */
export interface GrandPrixPort {
  /** A number global of the running script, or an element of a number array. Null if there is none. */
  num(name: string, index?: number): number | null;
  /** The sim id of the unit a `unit` global (or array element) holds, 0 for null / gone. */
  unit(name: string, index?: number): number;
  /** The point a `location` array element holds. */
  point(name: string, index: number): { x: number; y: number } | null;
  /** Raise one of common.j's `EVENT_PLAYER_ARROW_*` for this player — a key going down or up. */
  arrow(player: number, event: number): void;
  /** The dialog on this player's screen, if the script is showing them one. */
  dialog(player: number): { id: number; buttons: ReadonlyArray<{ id: number; text: string }> } | null;
  clickDialog(player: number, dialog: number, button: number): void;
}

export interface GrandPrixHost {
  world: SimWorld;
  execute(player: number, cmd: Command): boolean;
}

interface Brain {
  player: number;
  profile: GrandPrixProfile;
  /** The seat's random stream, as STATE (sim/streams.ts) — a saved game writes where it is. */
  stream: Mulberry32Stream;
  clock: number;
  thinkIn: number;
  /** Its lateral place on the road, world units right of the line — so eight computers do not
   *  all ask for the same strip of tarmac. */
  lane: number;
  // --- before the race
  dialogAt: number;
  pickAt: number;
  pickPresses: number;
  // --- driving
  /** The keys have been let go for a seat that is not driving (see `think`). */
  handsOff: boolean;
  cartId: number;
  /** The sample of the racing line it is at. */
  at: number;
  stuckFor: number;
  reverseUntil: number;
  // --- what it carries
  slotCode: string[];
  slotSince: number[];
  pressAt: number[];
  gunAt: number;
  burstLeft: number;
}

/** One rival cart, in the frame of our own: `ahead` along our nose, `side` to our left. */
interface Rival {
  ahead: number;
  side: number;
  dist: number;
}

/** A turn is asked for once the road is this far off the nose — under the 3° one tick turns. */
const STEER_DEADBAND = (2 * Math.PI) / 180;
/** Seconds of road it looks down, and the least and most of it in world units. */
const LOOK_TIME = 0.42;
const LOOK_MIN = 260;
const LOOK_MAX = 820;
/** A cart this far off its heading gives up the line's speed and comes round slowly. */
const SLEW_ANGLE = (55 * Math.PI) / 180;
const SLEW_SPEED = 70;
/** Standing still for this long with the throttle open is a wall: back off it. */
const STUCK_SPEED = 12;
const STUCK_TIME = 0.7;
const REVERSE_TIME = 0.9;
/** The road kept between the lane and the wall. */
const LANE_KEEP = 300;
const LANE_GAP = 110;
/** A cart this close in front is driven round rather than into. */
const PASS_REACH = 420;
const PASS_WIDTH = 140;
const PASS_SHIFT = 170;
/** How much clear road an Engine Boost wants in front of it. */
const BOOST_ROAD = 1700;

export class GrandPrixAi {
  private readonly brains: Brain[] = [];
  /** The racing line, found once from the script's own check points. A CACHE of map data
   *  (game/save/classes.ts lists it transient): a loaded game finds it again. */
  private route: Route | null = null;
  private routeTried = false;
  /** Each seat's speed limit down that line — the route under its own cart and its own nerve. */
  private plans = new Map<number, Float32Array>();
  private port: GrandPrixPort | null = null;

  constructor(private readonly host: GrandPrixHost) {}

  get active(): boolean {
    return this.brains.length > 0 && !!this.port;
  }

  /** The scene's doors onto the script. Handed over again after a load (they are closures). */
  attach(port: GrandPrixPort): void {
    this.port = port;
  }

  add(player: number, difficulty: number, seed: number): void {
    if (this.brains.some((b) => b.player === player)) return;
    const stream = new Mulberry32Stream((seed ^ Math.imul(player + 11, 0x9e3779b1)) >>> 0);
    const profile = grandPrixProfile(difficulty);
    this.brains.push({
      player, profile, stream, clock: 0, thinkIn: stream.next() * 0.3, lane: 0,
      dialogAt: -1, pickAt: -1, pickPresses: Math.floor(stream.next() * 4),
      handsOff: false, cartId: 0, at: -1, stuckFor: 0, reverseUntil: -1,
      slotCode: ["", "", "", ""], slotSince: [0, 0, 0, 0], pressAt: [-1, -1, -1, -1],
      gunAt: 0, burstLeft: 0,
    });
    // Spread the seats across the road, the middle one on the line.
    const n = this.brains.length;
    this.brains.forEach((b, i) => (b.lane = (i - (n - 1) / 2) * LANE_GAP));
  }

  reset(): void {
    this.brains.length = 0;
    this.route = null;
    this.routeTried = false;
    this.plans.clear();
  }

  tick(dt: number): void {
    const port = this.port;
    if (!port) return;
    for (const b of this.brains) {
      b.clock += dt;
      b.thinkIn -= dt;
      if (b.thinkIn > 0) continue;
      b.thinkIn += b.profile.think;
      if (b.thinkIn < 0) b.thinkIn = 0;
      this.think(b, port);
    }
  }

  // ------------------------------------------------------------------------------------------
  // One look at the world
  // ------------------------------------------------------------------------------------------

  private think(b: Brain, port: GrandPrixPort): void {
    this.dialogPass(b, port);
    const picker = port.unit("udg_PickCarts", b.player);
    if (picker) {
      this.pickPass(b, picker);
      return;
    }
    const status = port.num("udg_GameGoingStatus", b.player);
    const cartId = port.unit("udg_Carts", b.player);
    const cart = cartId ? this.host.world.units.get(cartId) : undefined;
    // No cart (it was just destroyed and the helicopter is on its way), or the race is over for
    // this seat: hands off the keys, so the new cart is not born with one stuck down.
    if (!cart || cart.owner !== b.player || (status !== STATUS.driving && status !== STATUS.preparing)) {
      // Once. After the last cart is home the map stops listening to the keys altogether
      // (`udg_GameOver`), and a release it never hears must not be sent for the rest of the match.
      if (!b.handsOff) this.hold(b, port, 0, 0);
      b.handsOff = true;
      return;
    }
    b.handsOff = false;
    if (status === STATUS.preparing) {
      // The 3-2-1. `Trig_Move_Cart_Actions` already runs `CalcSpeed` for a cart that is PREPARING
      // and only withholds the move, so a throttle held on the grid is speed in hand at "GO" —
      // the map's own flying start, and anybody's to use. Easy sits and waits for the flag.
      this.hold(b, port, b.profile.flyingStart ? 1 : 0, 0);
      return;
    }
    const route = this.routeFor(port);
    if (!route) {
      this.hold(b, port, 0, 0);
      return;
    }
    this.drivePass(b, port, cart, route);
    this.itemPass(b, port, cart, route);
  }

  /** `Trig_Prepare_for_Game` asks ONE player how many laps: the first playing seat. When that is
   *  ours, it answers — after a moment, like somebody reading the box. */
  private dialogPass(b: Brain, port: GrandPrixPort): void {
    const d = port.dialog(b.player);
    if (!d || !d.buttons.length) {
      b.dialogAt = -1;
      return;
    }
    if (b.dialogAt < 0) {
      b.dialogAt = b.clock + 2 + b.stream.next() * 2;
      return;
    }
    if (b.clock < b.dialogAt) return;
    const want = d.buttons.find((x) => x.text.trim() === String(b.profile.laps)) ?? d.buttons[0];
    b.dialogAt = -1;
    port.clickDialog(b.player, d.id, want.id);
  }

  /** The picker: look at a few carts (Next), then take the one showing (its own Select). A seat
   *  that never gets there is handed the cart on show when `udg_PickCartTimer` runs out. */
  private pickPass(b: Brain, pickerId: number): void {
    if (b.pickAt < 0) {
      b.pickAt = b.clock + 2.5 + b.stream.next() * 4;
      return;
    }
    if (b.clock < b.pickAt) return;
    const picker = this.host.world.units.get(pickerId);
    if (!picker) return;
    const select = PICK_SELECT[picker.typeId];
    const code = b.pickPresses > 0 || !select ? PICK_NEXT : select;
    const took = this.host.execute(b.player, { c: "cast", unitId: picker.id, code, targetId: 0, x: picker.x, y: picker.y, queued: false });
    if (took && code === PICK_NEXT) b.pickPresses--;
    b.pickAt = b.clock + 0.7 + b.stream.next() * 0.6;
  }

  // ------------------------------------------------------------------------------------------
  // The keys
  // ------------------------------------------------------------------------------------------

  /**
   * Hold the keys that make the cart do this: `accel` +1 Up, −1 Down, 0 neither; `turn` +1 Left,
   * −1 Right, 0 neither.
   *
   * What is "held" is read back from the SCRIPT (`udg_Accelerating`, `udg_Turning`) rather than
   * remembered here, because the script's idea is the one the cart is driven by and the two can
   * part: `Accelerate` ignores a press while the other pedal is still down, and a save, a pause
   * or a destroyed cart must not leave us believing in a key the map has forgotten.
   */
  private hold(b: Brain, port: GrandPrixPort, accel: number, turn: number): void {
    const accelNow = port.num("udg_Accelerating", b.player) ?? 0; // ACCELERATE_FORWARD 1, BACKWARD −1
    if (accelNow !== accel) {
      if (accelNow !== 0) this.key(b, port, accelNow > 0 ? "up" : "down", false);
      if (accel !== 0) this.key(b, port, accel > 0 ? "up" : "down", true);
    }
    const turnNow = port.num("udg_Turning", b.player) ?? 0; // TURNING_LEFT −1, TURNING_RIGHT 1
    const wantTurn = turn > 0 ? -1 : turn < 0 ? 1 : 0;
    if (turnNow !== wantTurn) {
      if (wantTurn === 0) this.key(b, port, turnNow < 0 ? "left" : "right", false);
      else this.key(b, port, wantTurn < 0 ? "left" : "right", true);
    }
  }

  private key(b: Brain, port: GrandPrixPort, which: ArrowKey, down: boolean): void {
    port.arrow(b.player, ARROW[which] + (down ? 0 : 1));
  }

  // ------------------------------------------------------------------------------------------
  // The road
  // ------------------------------------------------------------------------------------------

  /** The racing line — built the first time anybody needs it, from the check points the script
   *  itself laid out (`Trig_Init_Place_Check_Points`) and the ground a cart may stand on. */
  private routeFor(port: GrandPrixPort): Route | null {
    if (this.route || this.routeTried) return this.route;
    const count = port.num("udg_PlaceCheckPtNum") ?? 0;
    if (count < 3) return null; // the init trigger has not run yet — ask again
    this.routeTried = true;
    const gates: Gate[] = [];
    for (let i = 0; i < count; i++) {
      const p = port.point("udg_PlaceCheckPtPos", i);
      const dir = port.num("udg_PlaceCheckPtDir", i);
      if (!p || dir === null) return null;
      gates.push({ x: p.x, y: p.y, dir });
    }
    const world = this.host.world;
    const grid = world.grid;
    const [minX, minY] = grid.cellToWorld(0, 0);
    const drivable = (x: number, y: number): boolean => {
      // `IsValidLocForVehicle` (the cliff level) AND the pathing map: the script sets the cart
      // with a PATHED move, so a tree or a wall on level ground is not road either.
      if (world.terrainCliffLevel(x, y) !== TRACK_CLIFF_LEVEL) return false;
      const [cx, cy] = grid.worldToCell(x, y);
      return grid.walkable(cx, cy);
    };
    this.route = buildRoute(gates, {
      drivable, minX: minX - PATHING_CELL / 2, minY: minY - PATHING_CELL / 2,
      maxX: minX + grid.width * PATHING_CELL, maxY: minY + grid.height * PATHING_CELL,
    });
    return this.route;
  }

  /** This seat's speed limit down the line: the road under ITS cart (`udg_ModelAttributes`). */
  private planFor(b: Brain, port: GrandPrixPort, route: Route): { plan: Float32Array; top: number } {
    const model = port.num("udg_PlayerModels", b.player) ?? 0;
    const top = port.num("udg_ModelAttributes", model * 4 + MODEL_ATTR.top) || 200;
    let plan = this.plans.get(b.player);
    if (!plan || plan.length !== route.n) {
      const accel = port.num("udg_ModelAttributes", model * 4 + MODEL_ATTR.accel) || 7;
      plan = speedPlan(route, top * b.profile.pace, accel, b.profile.corner, b.profile.braking);
      this.plans.set(b.player, plan);
    }
    return { plan, top };
  }

  private drivePass(b: Brain, port: GrandPrixPort, cart: SimUnit, route: Route): void {
    if (b.cartId !== cart.id) {
      b.cartId = cart.id; // a new cart (the first, or the helicopter's): find the road afresh
      b.at = -1;
      b.stuckFor = 0;
      b.reverseUntil = -1;
    }
    const speed = port.num("udg_Speed", b.player) ?? 0; // the speedometer's number
    const cur = port.num("udg_PlaceChkPtCur", b.player) ?? -1;
    b.at = locate(route, cart.x, cart.y, b.at, cur + 1);
    const { plan } = this.planFor(b, port, route);

    // Where it is steering for: a point down the road, further off the faster it goes, moved
    // across into its own lane where the road has the width for one.
    const real = Math.max(0, speed) * UNITS_PER_SPEED;
    const look = Math.min(LOOK_MAX, Math.max(LOOK_MIN, real * LOOK_TIME));
    const aim = (b.at + Math.max(2, Math.round(look / route.step))) % route.n;
    let lane = b.lane + this.passShift(b, cart);
    const spare = Math.max(0, route.room[aim] - LANE_KEEP);
    lane = Math.max(-spare, Math.min(spare, lane));
    // "Right of the line" is the road's heading turned −90°.
    const tx = route.x[aim] + Math.sin(route.heading[aim]) * lane;
    const ty = route.y[aim] - Math.cos(route.heading[aim]) * lane;
    const off = angleDiff(cart.facing, Math.atan2(ty - cart.y, tx - cart.x));
    const turn = off > STEER_DEADBAND ? 1 : off < -STEER_DEADBAND ? -1 : 0;

    // Against a wall. A cart that is not moving cannot turn (`CalcTurnSpeed` is 0 at speed 0), so
    // pushing at one is for ever: back away, with the wheel over the other way so the nose comes
    // round toward the road — reversing, the script turns a cart the opposite way to the key.
    if (b.clock < b.reverseUntil) {
      this.hold(b, port, -1, -turn);
      return;
    }
    b.stuckFor = Math.abs(speed) < STUCK_SPEED ? b.stuckFor + b.profile.think : 0;
    if (b.stuckFor >= STUCK_TIME) {
      b.stuckFor = 0;
      b.reverseUntil = b.clock + REVERSE_TIME;
      this.hold(b, port, -1, -turn);
      return;
    }

    // How fast: the plan a little way down the road (the distance it covers before it looks
    // again), and no faster than a crawl while the nose is nowhere near the road's direction.
    const lead = Math.ceil((real * b.profile.think) / route.step) + 1;
    let want = plan[(b.at + lead) % route.n];
    if (Math.abs(off) > SLEW_ANGLE) want = Math.min(want, SLEW_SPEED);
    const accel = speed < want - 3 ? 1 : speed > want + 9 ? -1 : 0;
    this.hold(b, port, accel, turn);
  }

  /** A cart right in front, on our strip of road: go round it, on whichever side it is not. */
  private passShift(b: Brain, cart: SimUnit): number {
    for (const r of this.rivals(b, cart)) {
      if (r.ahead > 40 && r.ahead < PASS_REACH && Math.abs(r.side) < PASS_WIDTH) return r.side >= 0 ? PASS_SHIFT : -PASS_SHIFT;
    }
    return 0;
  }

  /** The other carts on the road, as this one sees them from its seat. A cloaked one is not seen. */
  private rivals(b: Brain, cart: SimUnit): Rival[] {
    const out: Rival[] = [];
    const port = this.port;
    if (!port) return out;
    const cos = Math.cos(cart.facing), sin = Math.sin(cart.facing);
    for (let p = 0; p < 8; p++) {
      if (p === b.player) continue;
      const id = port.unit("udg_Carts", p);
      const u = id ? this.host.world.units.get(id) : undefined;
      if (!u || u.hp <= 0 || u.owner !== p || u.invisible) continue;
      const dx = u.x - cart.x, dy = u.y - cart.y;
      out.push({ ahead: dx * cos + dy * sin, side: -dx * sin + dy * cos, dist: Math.hypot(dx, dy) });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // What it carries
  // ------------------------------------------------------------------------------------------

  private itemPass(b: Brain, port: GrandPrixPort, cart: SimUnit, route: Route): void {
    const rivals = this.rivals(b, cart);
    const speed = port.num("udg_Speed", b.player) ?? 0;
    const { plan, top } = this.planFor(b, port, route);
    const place = this.placeOf(b, port);
    const racers = port.num("udg_PlaceNum") ?? 1;
    const life = cart.maxHp > 0 ? cart.hp / cart.maxHp : 1;
    const clearRoad = (): boolean => {
      const limit = top * b.profile.pace - 6;
      for (let d = 0; d < BOOST_ROAD; d += route.step) if (plan[(b.at + Math.round(d / route.step)) % route.n] < limit) return false;
      return true;
    };
    const behind = (): boolean => rivals.some((r) => r.ahead < -120 && r.ahead > -1200 && Math.abs(r.side) < 350);
    const worth = (kind: PowerUp): boolean => {
      switch (kind) {
        case "repair": return life < b.profile.repairAt;
        case "boost": return speed > top * 0.5 && clearRoad();
        case "rocket": return place > 0; // it flies at whoever leads — never while that is us
        case "lightning": return place > 0 || rivals.some((r) => r.dist < 1500);
        case "blessing": return life < 0.35 || rivals.some((r) => r.dist < 450);
        case "cloak": return life < 0.4 || (place === 0 && racers > 1); // the leader is what gets aimed at
        case "blaze":
        case "mine":
        case "trap": return behind();
        case "sheepedo": return rivals.some((r) => r.ahead > 150 && r.ahead < 1400 && Math.abs(r.side) < 100 + r.ahead * 0.25);
        case "swarm": return rivals.some((r) => r.ahead > 0 && r.ahead < 800 && Math.abs(r.side) < 250);
        case "blizzard": return rivals.some((r) => Math.hypot(r.ahead - speed * 5, r.side) < 500); // `DoBlizzard`'s own centre
      }
    };
    const react = (): number => b.profile.react[0] + b.stream.next() * (b.profile.react[1] - b.profile.react[0]);

    for (let slot = 0; slot < 4; slot++) {
      const code = rawcode(port.num("udg_CartPowerUps", b.player * 4 + slot) ?? 0);
      if (code !== b.slotCode[slot]) {
        b.slotCode[slot] = code;
        b.slotSince[slot] = b.clock;
        b.pressAt[slot] = -1;
      }
      const kind = code ? powerUpOf(code) : null;
      if (!kind) continue;
      // Worth it now — or it has sat there long enough that the slot is worth more than the wait.
      // (A Repair Kit is never thrown away at full life: it is the one thing worth a slot.)
      const stale = b.clock - b.slotSince[slot] > b.profile.hoard && (kind !== "repair" || life < 0.9);
      if (!worth(kind) && !stale) {
        b.pressAt[slot] = -1;
        continue;
      }
      if (b.pressAt[slot] < 0) {
        b.pressAt[slot] = b.clock + react();
        continue;
      }
      if (b.clock < b.pressAt[slot]) continue;
      this.host.execute(b.player, { c: "cast", unitId: cart.id, code, targetId: 0, x: cart.x, y: cart.y, queued: false });
      b.pressAt[slot] = b.clock + 1; // if the press did not take, try again in a second
      return; // one button a look
    }

    // The machine gun: a cart in the lane it fires down (`UnitCatchGunFire`), rounds in the belt.
    const inSights = rivals.some((r) => r.ahead > 60 && r.ahead < GUN_REACH && Math.abs(r.side) < GUN_HALF_WIDTH);
    if (!inSights) {
      b.burstLeft = 0;
      if (b.gunAt < b.clock) b.gunAt = b.clock + react();
      return;
    }
    if (b.clock < b.gunAt || (port.num("udg_GunAmmo", b.player) ?? 0) <= 0) return;
    if (b.burstLeft <= 0) b.burstLeft = b.profile.burst;
    this.host.execute(b.player, { c: "cast", unitId: cart.id, code: GUN, targetId: 0, x: cart.x, y: cart.y, queued: false });
    b.burstLeft--;
    b.gunAt = b.clock + (b.burstLeft > 0 ? 0.25 : b.profile.gunGap);
  }

  /** Where this seat is running, 0 the leader — the board's own order (`udg_Places`, `SortPlace`). */
  private placeOf(b: Brain, port: GrandPrixPort): number {
    const n = port.num("udg_PlaceNum") ?? 0;
    for (let i = 0; i < n; i++) if (port.num("udg_Places", i) === b.player) return i;
    return 0;
  }
}
