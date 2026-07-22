import type { SimAbility, SimBuff, HeldItem } from "../sim/world";
import type { ProjectileSnapshot, UnitSnapshot, WeaponSnapshot, WorldSnapshot } from "./snapshot";

/**
 * The binary HOT LANE (docs/multiplayer.md Phase G — the wire after the whistle).
 *
 * A `WorldSnapshot`'s bulk is `units` and `projectiles`: one live `UnitSnapshot` is ~1.2 KB
 * of JSON of which ~50 bytes is information — the field NAMES dominate, repeated per unit
 * per payload per recipient, and `JSON.stringify` burns host main-thread CPU re-discovering
 * them at every send. At the 60 Hz cadence the sim already runs, that is what capped the
 * wire at 30 (see `SNAPSHOT_INTERVAL`'s history). So the two hot arrays cross as a
 * fixed-layout binary record instead — positions quantized to i16 world units, facing to
 * u16 of 2π, hp/mana to u16, every boolean packed into one flags word, every string
 * interned once in a per-payload table — and everything else (stash, research, creepCamps,
 * fx, deaths, corpses, mines, items) stays JSON: tiny, rare, not worth hand-packing.
 *
 * **Transport: base64 inside the existing JSON envelope**, by decision. The relay is
 * JSON-framed end to end (`server/relay.mjs` stringifies, `tools/loopback.mjs` clones via
 * JSON) and must stay dumb; binary WebSocket frames would teach it a second framing for a
 * +33% base64 tax this encoding already beats twentyfold. If the internet deployment ever
 * wants the last third back, that is a relay-framing item, not a codec change.
 *
 * **The codec owns its representation**, so JSON's blind spots stop applying to the hot
 * lane: a buff's `timeLeft` is `Infinity` for an aura, which `JSON.stringify` silently
 * turns to `null` — the old wire shipped that corruption to every client — and an f32
 * carries Infinity natively. (Shop stock still crosses -1-encoded: `snapshotFor` already
 * applied `encodeStockTime` building the payload, and the shelf rides the string table as
 * the small JSON blob it is.)
 *
 * **What quantization costs, stated rather than discovered:** positions round to 1 world
 * unit (the map is ±~15k; a footman covers ~5 u per payload at 60 Hz, and `poseLerp`
 * glides between payload poses either way), hp/mana/speed round to integers (the HUD never
 * shows fractions), facing rounds to 1/65536 of a turn. Time-shaped floats (cooldowns,
 * construction clocks, buff durations) cross as f32, which is exact for anything a player
 * can perceive. Deep round-trip fidelity is pinned by `tools/sim-wire-test.cjs`.
 *
 * Polymorphic composites a fixed layout cannot carry — a building's `queue` (a
 * discriminated union), `orderQueue` (present on the recipient's own units only), the shop
 * shelf — ride the string table as JSON: rare, small, and deduped with every other string.
 *
 * **This file imports no renderer and no transport** — same discipline as `snapshot.ts`
 * (whose types it encodes) and `snapshotApply.ts` (which consumes what `decodeSnapshot`
 * rebuilds). The envelope that carries a `WireSnapshot` is `MatchLink`'s business.
 */

/** A `WorldSnapshot` with the two hot arrays packed into `hot` (base64 of the binary
 *  record). Everything else is carried verbatim — the cold lanes were never the problem. */
export type WireSnapshot = Omit<WorldSnapshot, "units" | "projectiles"> & { hot: string };

/** Bumped when the binary layout changes. Carried in the blob so a mismatched decode fails
 *  loudly at the header rather than as garbage fields three units in. The relay's
 *  `PROTOCOL_VERSION` still gates the SESSION; this gates the blob. */
const CODEC_VERSION = 1;

const TWO_PI = Math.PI * 2;

// --- quantizers -------------------------------------------------------------------------
// Exported for the round-trip test, which builds its exact-equality payload on the grid
// these define — that is what makes "decode(encode(snap)) deep-equals snap" a real check
// of the layout rather than a tautology about lossless fields.

/** Positions: i16 world units. */
export const quantPos = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));
/** Facing: u16 of one full turn, decoded back into [0, 2π). */
export const quantFacing = (f: number): number => (((Math.round((f / TWO_PI) * 65536) % 65536) + 65536) % 65536 / 65536) * TWO_PI;
/** hp/mana/speed/range and kin: rounded, clamped to u16. */
export const quantU16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));
/** Bonus damage/stats: rounded, clamped to i16. */
export const quantI16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));
/** Time-shaped floats cross as f32. */
export const quantF32 = Math.fround;

// --- base64 -----------------------------------------------------------------------------
// Hand-rolled because the two runtimes disagree: the browser has `btoa` (strings only,
// latin1), Node has `Buffer`, and neither exists in the other. ~30 lines buys "runs
// anywhere the sim compiles", which the headless test harness depends on.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV = new Uint8Array(128);
for (let i = 0; i < B64.length; i++) B64_REV[B64.charCodeAt(i)] = i;

function toBase64(bytes: Uint8Array, len: number): string {
  const parts: string[] = [];
  let out = "";
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out +=
      B64[b0 >> 2] +
      B64[((b0 & 3) << 4) | (b1 >> 4)] +
      (i + 1 < len ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=") +
      (i + 2 < len ? B64[b2 & 63] : "=");
    // Chunked so a big payload does not build one ever-growing rope string.
    if (out.length >= 8192) {
      parts.push(out);
      out = "";
    }
  }
  parts.push(out);
  return parts.join("");
}

function fromBase64(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61 /* '=' */) len--;
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_REV[s.charCodeAt(i)];
    const c1 = B64_REV[s.charCodeAt(i + 1)];
    const c2 = i + 2 < len ? B64_REV[s.charCodeAt(i + 2)] : 0;
    const c3 = i + 3 < len ? B64_REV[s.charCodeAt(i + 3)] : 0;
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (o < outLen) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (o < outLen) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out;
}

// --- the writer -------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * One growable buffer, reused across every encode — the host emits payloads one at a time
 * on one thread, so a module-level scratch is safe and keeps the 60 Hz × recipients hot
 * path allocation-free (the base64 string is the one unavoidable product). Doubles on
 * demand and never shrinks: a late-game teamfight sets the high-water mark once.
 */
class Writer {
  buf = new ArrayBuffer(1 << 17); // 128 KB — a full 12-player late game fits without a grow
  view = new DataView(this.buf);
  bytes = new Uint8Array(this.buf);
  pos = 0;

  /** The per-payload string intern table. Cleared by `reset`, not reallocated. */
  strings: string[] = [];
  private indexOf = new Map<string, number>();

  reset(): void {
    this.pos = 0;
    this.strings.length = 0;
    this.indexOf.clear();
  }

  ensure(extra: number): void {
    if (this.pos + extra <= this.buf.byteLength) return;
    let size = this.buf.byteLength;
    while (size < this.pos + extra) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  /** Intern a string, returning its table index. 0xffff is reserved as the null sentinel
   *  (never minted: the cap below trips first). */
  intern(s: string): number {
    const hit = this.indexOf.get(s);
    if (hit !== undefined) return hit;
    const idx = this.strings.length;
    if (idx >= 0xffff) throw new Error("snapshotWire: string table overflow");
    this.strings.push(s);
    this.indexOf.set(s, idx);
    return idx;
  }

  u8(v: number): void { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  u16(v: number): void { this.ensure(2); this.view.setUint16(this.pos, v, true); this.pos += 2; }
  i16(v: number): void { this.ensure(2); this.view.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v: number): void { this.ensure(4); this.view.setUint32(this.pos, v, true); this.pos += 4; }
  f32(v: number): void { this.ensure(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; }

  /** Write the string table where the cursor stands: u16 count, then per string a u16
   *  byte length + UTF-8 bytes. */
  writeStringTable(): void {
    this.u16(this.strings.length);
    for (const s of this.strings) {
      this.ensure(2 + s.length * 3);
      const written = textEncoder.encodeInto(s, this.bytes.subarray(this.pos + 2)).written;
      this.view.setUint16(this.pos, written, true);
      this.pos += 2 + written;
    }
  }
}

const writer = new Writer();

class Reader {
  view: DataView;
  pos = 0;
  strings: string[] = [];
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  f32(): number { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  str(): string { return this.strings[this.u16()]; }
  readStringTableAt(offset: number): void {
    const at = this.pos;
    this.pos = offset;
    const count = this.u16();
    for (let i = 0; i < count; i++) {
      const len = this.u16();
      this.strings.push(textDecoder.decode(this.bytes.subarray(this.pos, this.pos + len)));
      this.pos += len;
    }
    this.pos = at;
  }
}

// --- unit layout ------------------------------------------------------------------------
// One u32 of flags per unit: bits 0–19 are the payload's booleans in declaration order,
// bits 20–28 are presence bits for the optional blocks that follow the fixed block.

const F_NEUTRAL_PASSIVE = 1 << 0;
const F_IS_HERO = 1 << 1;
const F_IS_CREEP = 1 << 2;
const F_REMEMBERED = 1 << 3;
const F_FLYING = 1 << 4;
const F_MOVING = 1 << 5;
const F_IN_COMBAT = 1 << 6;
const F_WORKING = 1 << 7;
const F_SWING_BROKEN = 1 << 8;
const F_SWING_SLAM = 1 << 9;
const F_ALT_MODEL = 1 << 10;
const F_IN_MINE = 1 << 11;
const F_INSIDE_BUILD = 1 << 12;
const F_IN_BURROW = 1 << 13;
const F_VANISHED = 1 << 14;
const F_INVISIBLE = 1 << 15;
const F_ETHEREAL = 1 << 16;
const F_INVULNERABLE = 1 << 17;
const F_IS_SUMMON = 1 << 18;
const F_IS_ILLUSION = 1 << 19;
const F_HAS_WEAPON = 1 << 20;
const F_HAS_SWING_WEAPON = 1 << 21;
const F_HAS_WORKER = 1 << 22;
const F_HAS_BUILDING = 1 << 23;
const F_HAS_REPAIR = 1 << 24;
const F_REPAIR_ACTIVE = 1 << 25;
const F_HAS_BUILD_PENDING = 1 << 26;
const F_HAS_ORDER_QUEUE = 1 << 27;
const F_HAS_PENDING_CAST = 1 << 28;
// Presence gates for blocks that are all-zero on the common soldier — a footman pays one
// flag bit instead of 18 bytes of empty hero block. The summon pair and `illusionOf` need
// no bits of their own: `snapshotFor` already masks them to zero unless F_IS_SUMMON /
// F_IS_ILLUSION is set, so those flags ARE the presence.
const F_HAS_HERO = 1 << 29; // level/xp/skillPoints/str/agi/int/bonus* — a creep's level rides too
const F_HAS_GUARD = 1 << 30; // guardX/guardY, creep camp homes
const F_DEVOURED = 1 << 31; // devouredBy

// A weapon is static per-type-and-upgrade CONFIG — nothing in `WeaponSnapshot` ticks (its
// `cooldown` is the period; the swing countdown never crosses the wire) — so an army's
// hundred identical weapons dedupe to ONE string-table entry and a u16 per unit. Cheaper
// than a fixed 22-byte block the moment three units share a weapon, and exact (JSON round-
// trips numbers losslessly, so damage keeps its float where a fixed layout would round it).
const writeWeapon = (w: Writer, wp: WeaponSnapshot): void => w.u16(w.intern(JSON.stringify(wp)));
const readWeapon = (r: Reader): WeaponSnapshot => JSON.parse(r.str());

function writeUnit(w: Writer, s: UnitSnapshot): void {
  let flags = 0;
  if (s.neutralPassive) flags |= F_NEUTRAL_PASSIVE;
  if (s.isHero) flags |= F_IS_HERO;
  if (s.isCreep) flags |= F_IS_CREEP;
  if (s.remembered) flags |= F_REMEMBERED;
  if (s.flying) flags |= F_FLYING;
  if (s.moving) flags |= F_MOVING;
  if (s.inCombat) flags |= F_IN_COMBAT;
  if (s.working) flags |= F_WORKING;
  if (s.swingBroken) flags |= F_SWING_BROKEN;
  if (s.swingSlam) flags |= F_SWING_SLAM;
  if (s.altModel) flags |= F_ALT_MODEL;
  if (s.inMine) flags |= F_IN_MINE;
  if (s.insideBuild) flags |= F_INSIDE_BUILD;
  if (s.inBurrow) flags |= F_IN_BURROW;
  if (s.vanished) flags |= F_VANISHED;
  if (s.invisible) flags |= F_INVISIBLE;
  if (s.ethereal) flags |= F_ETHEREAL;
  if (s.invulnerable) flags |= F_INVULNERABLE;
  if (s.isSummon) flags |= F_IS_SUMMON;
  if (s.isIllusion) flags |= F_IS_ILLUSION;
  if (s.weapon) flags |= F_HAS_WEAPON;
  if (s.swingWeapon) flags |= F_HAS_SWING_WEAPON;
  if (s.worker) flags |= F_HAS_WORKER;
  if (s.building) flags |= F_HAS_BUILDING;
  if (s.repair) flags |= F_HAS_REPAIR;
  if (s.repair?.active) flags |= F_REPAIR_ACTIVE;
  if (s.buildPending) flags |= F_HAS_BUILD_PENDING;
  if (s.orderQueue) flags |= F_HAS_ORDER_QUEUE;
  if (s.pendingCastCode !== null) flags |= F_HAS_PENDING_CAST;
  const hasHero =
    s.isHero || s.level !== 0 || s.xp !== 0 || s.skillPoints !== 0 || s.str !== 0 || s.agi !== 0 || s.int !== 0 ||
    s.bonusStr !== 0 || s.bonusAgi !== 0 || s.bonusInt !== 0;
  if (hasHero) flags |= F_HAS_HERO;
  if (s.guardX !== 0 || s.guardY !== 0) flags |= F_HAS_GUARD;
  if (s.devouredBy !== 0) flags |= F_DEVOURED;
  w.u32(flags >>> 0);

  w.u32(s.id);
  w.u8(s.owner);
  w.u8(s.team);
  w.u16(w.intern(s.typeId));
  w.u16(w.intern(s.race));
  w.u16(w.intern(s.properName));
  w.u16(w.intern(s.order));
  w.i16(quantPos(s.x));
  w.i16(quantPos(s.y));
  w.u16(Math.round((s.facing / TWO_PI) * 65536) & 0xffff);
  w.f32(s.flyHeight);
  w.u16(quantU16(s.speed));
  w.u8(Math.min(255, Math.round(s.radius)));
  w.u16(s.swingSeq & 0xffff);
  w.u16(s.chopSeq & 0xffff);
  w.f32(s.spawning);
  w.f32(s.constructing);
  if (flags & F_DEVOURED) w.u32(s.devouredBy);
  w.u16(quantU16(s.hp));
  w.u16(quantU16(s.maxHp));
  w.u16(quantU16(s.mana));
  w.u16(quantU16(s.maxMana));
  w.f32(s.armor);
  w.f32(s.bonusArmor);
  w.i16(quantI16(s.bonusDamage));
  if (flags & F_HAS_HERO) {
    w.u8(s.level);
    w.u32(s.xp);
    w.u8(s.skillPoints);
    w.u16(quantU16(s.str));
    w.u16(quantU16(s.agi));
    w.u16(quantU16(s.int));
    w.i16(quantI16(s.bonusStr));
    w.i16(quantI16(s.bonusAgi));
    w.i16(quantI16(s.bonusInt));
  }
  if (flags & F_IS_SUMMON) {
    w.f32(s.summonLeft);
    w.f32(s.summonMax);
  }
  if (flags & F_IS_ILLUSION) w.u32(s.illusionOf);
  if (flags & F_HAS_GUARD) {
    w.i16(quantPos(s.guardX));
    w.i16(quantPos(s.guardY));
  }
  w.u8(s.garrisonCap);

  if (s.weapon) writeWeapon(w, s.weapon);
  if (s.swingWeapon) writeWeapon(w, s.swingWeapon);

  if (s.worker) {
    w.u8((s.worker.gold ? 1 : 0) | (s.worker.lumber ? 2 : 0));
    w.u8(Math.min(255, Math.round(s.worker.carryGold)));
    w.u8(Math.min(255, Math.round(s.worker.carryLumber)));
  }

  if (s.building) {
    const b = s.building;
    w.u8((b.producesUnits ? 1 : 0) | (b.stock ? 2 : 0));
    w.f32(b.constructionLeft);
    w.f32(b.buildTimeTotal);
    w.f32(b.rallyX);
    w.f32(b.rallyY);
    w.u16(w.intern(b.rallyKind));
    w.u32(b.rallyTargetId);
    // The production queue is a discriminated union (BuildJob) and the shelf is already the
    // -1-encoded JSON-safe shape — both ride the string table as the small JSON they are.
    w.u16(w.intern(JSON.stringify(b.queue)));
    if (b.stock) w.u16(w.intern(JSON.stringify(b.stock)));
  }

  w.u8(s.abilities.length);
  for (const a of s.abilities) {
    w.u16(w.intern(a.id));
    w.u16(w.intern(a.code));
    w.u8(a.level);
    w.u8(a.autocastOn ? 1 : 0);
    w.f32(a.cooldownLeft);
  }

  w.u8(s.buffs.length);
  for (const b of s.buffs) {
    w.u16(w.intern(b.kind));
    w.u16(w.intern(b.group));
    w.u16(w.intern(b.art));
    w.u32(b.sourceId);
    w.f32(b.timeLeft); // f32 carries an aura's Infinity, which JSON never could
    w.f32(b.value);
    w.f32(b.value2);
    w.f32(b.delay);
    w.u8(b.meld ? 1 : 0);
    w.u8(b.fx.length);
    for (const fx of b.fx) {
      w.u16(w.intern(fx.path));
      w.u8(fx.attach.length);
      for (const at of fx.attach) w.u16(w.intern(at));
    }
  }

  w.u8(s.inventory.length);
  for (const it of s.inventory) {
    w.u8(it ? 1 : 0);
    if (!it) continue;
    w.u32(it.id);
    w.u16(w.intern(it.itemId));
    w.u8(Math.min(255, it.charges));
    w.f32(it.cooldownLeft);
  }

  w.u8(s.garrison.length);
  for (const id of s.garrison) w.u32(id);

  if (s.buildPending) {
    w.u16(w.intern(s.buildPending.defId));
    w.f32(s.buildPending.x);
    w.f32(s.buildPending.y);
  }
  if (s.orderQueue) w.u16(w.intern(JSON.stringify(s.orderQueue)));
  if (s.pendingCastCode !== null) w.u16(w.intern(s.pendingCastCode));
}

function readUnit(r: Reader): UnitSnapshot {
  const flags = r.u32();
  const s: UnitSnapshot = {
    id: r.u32(),
    owner: r.u8(),
    team: r.u8(),
    typeId: r.str(),
    race: r.str(),
    properName: "",
    isCreep: (flags & F_IS_CREEP) !== 0,
    neutralPassive: (flags & F_NEUTRAL_PASSIVE) !== 0,
    isHero: (flags & F_IS_HERO) !== 0,
    remembered: (flags & F_REMEMBERED) !== 0,
    x: 0,
    y: 0,
    facing: 0,
    flyHeight: 0,
    speed: 0,
    radius: 0,
    flying: (flags & F_FLYING) !== 0,
    order: "",
    moving: (flags & F_MOVING) !== 0,
    inCombat: (flags & F_IN_COMBAT) !== 0,
    working: (flags & F_WORKING) !== 0,
    swingSeq: 0,
    chopSeq: 0,
    swingBroken: (flags & F_SWING_BROKEN) !== 0,
    swingSlam: (flags & F_SWING_SLAM) !== 0,
    altModel: (flags & F_ALT_MODEL) !== 0,
    spawning: 0,
    constructing: 0,
    repair: flags & F_HAS_REPAIR ? { active: (flags & F_REPAIR_ACTIVE) !== 0 } : null,
    inMine: (flags & F_IN_MINE) !== 0,
    insideBuild: (flags & F_INSIDE_BUILD) !== 0,
    inBurrow: (flags & F_IN_BURROW) !== 0,
    devouredBy: 0,
    vanished: (flags & F_VANISHED) !== 0,
    invisible: (flags & F_INVISIBLE) !== 0,
    ethereal: (flags & F_ETHEREAL) !== 0,
    hp: 0,
    maxHp: 0,
    mana: 0,
    maxMana: 0,
    armor: 0,
    bonusArmor: 0,
    bonusDamage: 0,
    invulnerable: (flags & F_INVULNERABLE) !== 0,
    weapon: null,
    swingWeapon: null,
    level: 0,
    xp: 0,
    skillPoints: 0,
    str: 0,
    agi: 0,
    int: 0,
    bonusStr: 0,
    bonusAgi: 0,
    bonusInt: 0,
    worker: null,
    building: null,
    abilities: [],
    buffs: [],
    inventory: [],
    garrison: [],
    garrisonCap: 0,
    isSummon: (flags & F_IS_SUMMON) !== 0,
    summonLeft: 0,
    summonMax: 0,
    isIllusion: (flags & F_IS_ILLUSION) !== 0,
    illusionOf: 0,
    guardX: 0,
    guardY: 0,
    buildPending: null,
    orderQueue: null,
    pendingCastCode: null,
  };
  // The fixed block, in the writer's exact order. Kept as assignments rather than inlined
  // into the literal above because argument evaluation order is the one thing that must
  // never drift from `writeUnit` — here the sequence is the code you read.
  s.properName = r.str();
  s.order = r.str();
  s.x = r.i16();
  s.y = r.i16();
  s.facing = (r.u16() / 65536) * TWO_PI;
  s.flyHeight = r.f32();
  s.speed = r.u16();
  s.radius = r.u8();
  s.swingSeq = r.u16();
  s.chopSeq = r.u16();
  s.spawning = r.f32();
  s.constructing = r.f32();
  if (flags & F_DEVOURED) s.devouredBy = r.u32();
  s.hp = r.u16();
  s.maxHp = r.u16();
  s.mana = r.u16();
  s.maxMana = r.u16();
  s.armor = r.f32();
  s.bonusArmor = r.f32();
  s.bonusDamage = r.i16();
  if (flags & F_HAS_HERO) {
    s.level = r.u8();
    s.xp = r.u32();
    s.skillPoints = r.u8();
    s.str = r.u16();
    s.agi = r.u16();
    s.int = r.u16();
    s.bonusStr = r.i16();
    s.bonusAgi = r.i16();
    s.bonusInt = r.i16();
  }
  if (flags & F_IS_SUMMON) {
    s.summonLeft = r.f32();
    s.summonMax = r.f32();
  }
  if (flags & F_IS_ILLUSION) s.illusionOf = r.u32();
  if (flags & F_HAS_GUARD) {
    s.guardX = r.i16();
    s.guardY = r.i16();
  }
  s.garrisonCap = r.u8();

  if (flags & F_HAS_WEAPON) s.weapon = readWeapon(r);
  if (flags & F_HAS_SWING_WEAPON) s.swingWeapon = readWeapon(r);

  if (flags & F_HAS_WORKER) {
    const wf = r.u8();
    s.worker = { gold: (wf & 1) !== 0, lumber: (wf & 2) !== 0, carryGold: r.u8(), carryLumber: r.u8() };
  }

  if (flags & F_HAS_BUILDING) {
    const bf = r.u8();
    const constructionLeft = r.f32();
    const buildTimeTotal = r.f32();
    const rallyX = r.f32();
    const rallyY = r.f32();
    const rallyKind = r.str();
    const rallyTargetId = r.u32();
    const queue = JSON.parse(r.str());
    const stock = bf & 2 ? JSON.parse(r.str()) : null;
    s.building = { constructionLeft, buildTimeTotal, queue, producesUnits: (bf & 1) !== 0, rallyX, rallyY, rallyKind, rallyTargetId, stock };
  }

  const nAbilities = r.u8();
  for (let i = 0; i < nAbilities; i++) {
    const a: SimAbility = { id: r.str(), code: r.str(), level: r.u8(), cooldownLeft: 0, autocastOn: false };
    a.autocastOn = r.u8() !== 0;
    a.cooldownLeft = r.f32();
    s.abilities.push(a);
  }

  const nBuffs = r.u8();
  for (let i = 0; i < nBuffs; i++) {
    const b = {
      kind: r.str(),
      group: r.str(),
      art: r.str(),
      sourceId: r.u32(),
      timeLeft: r.f32(),
      value: r.f32(),
      value2: r.f32(),
      delay: r.f32(),
    } as unknown as SimBuff;
    const meld = r.u8() !== 0;
    if (meld) b.meld = true; // written only when set — the sim omits the key everywhere else
    b.fx = [];
    const nFx = r.u8();
    for (let j = 0; j < nFx; j++) {
      const path = r.str();
      const attach: string[] = [];
      const nAt = r.u8();
      for (let k = 0; k < nAt; k++) attach.push(r.str());
      b.fx.push({ path, attach });
    }
    s.buffs.push(b);
  }

  const nInv = r.u8();
  for (let i = 0; i < nInv; i++) {
    if (r.u8() === 0) {
      s.inventory.push(null);
      continue;
    }
    const it: HeldItem = { id: r.u32(), itemId: r.str(), charges: r.u8(), cooldownLeft: 0 };
    it.cooldownLeft = r.f32();
    s.inventory.push(it);
  }

  const nGar = r.u8();
  for (let i = 0; i < nGar; i++) s.garrison.push(r.u32());

  if (flags & F_HAS_BUILD_PENDING) s.buildPending = { defId: r.str(), x: r.f32(), y: r.f32() };
  if (flags & F_HAS_ORDER_QUEUE) s.orderQueue = JSON.parse(r.str());
  if (flags & F_HAS_PENDING_CAST) s.pendingCastCode = r.str();

  return s;
}

function writeProjectile(w: Writer, p: ProjectileSnapshot): void {
  w.u32(p.id);
  w.u32(p.targetId);
  w.i16(quantPos(p.x));
  w.i16(quantPos(p.y));
  w.i16(quantPos(p.tx));
  w.i16(quantPos(p.ty));
  w.f32(p.z);
  w.f32(p.startZ);
  w.f32(p.impactZ);
  w.f32(p.startDist);
  w.u16(quantU16(p.speed));
  w.u16(w.intern(p.art));
}

function readProjectile(r: Reader): ProjectileSnapshot {
  const p: ProjectileSnapshot = {
    id: r.u32(),
    targetId: r.u32(),
    x: r.i16(),
    y: r.i16(),
    tx: r.i16(),
    ty: r.i16(),
    z: 0,
    startZ: 0,
    impactZ: 0,
    startDist: 0,
    speed: 0,
    art: "",
  };
  p.z = r.f32();
  p.startZ = r.f32();
  p.impactZ = r.f32();
  p.startDist = r.f32();
  p.speed = r.u16();
  p.art = r.str();
  return p;
}

// --- the payload ------------------------------------------------------------------------
// Blob layout: u8 codec version, u32 string-table offset, u16 unit count, u16 projectile
// count, the unit records, the projectile records, then the string table (written last so
// interning can happen while the records are written, read first so `str()` can resolve).

/** Pack the hot lanes of one payload. The cold lanes ride along verbatim. */
export function encodeSnapshot(snap: WorldSnapshot): WireSnapshot {
  const w = writer;
  w.reset();
  w.u8(CODEC_VERSION);
  w.u32(0); // string-table offset, patched below
  w.u16(snap.units.length);
  w.u16(snap.projectiles.length);
  for (const u of snap.units) writeUnit(w, u);
  for (const p of snap.projectiles) writeProjectile(w, p);
  const tableAt = w.pos;
  w.writeStringTable();
  w.view.setUint32(1, tableAt, true);
  const { units: _u, projectiles: _p, ...cold } = snap;
  return { ...cold, hot: toBase64(w.bytes, w.pos) };
}

/** Unpack a wire payload back into the `WorldSnapshot` every consumer already reads —
 *  `snapshotApply` and the pose interpolation never learn the wire changed. */
export function decodeSnapshot(wire: WireSnapshot): WorldSnapshot {
  const r = new Reader(fromBase64(wire.hot));
  const version = r.u8();
  if (version !== CODEC_VERSION) throw new Error(`snapshotWire: codec ${version}, expected ${CODEC_VERSION}`);
  r.readStringTableAt(r.u32());
  const unitCount = r.u16();
  const projCount = r.u16();
  const units: UnitSnapshot[] = [];
  for (let i = 0; i < unitCount; i++) units.push(readUnit(r));
  const projectiles: ProjectileSnapshot[] = [];
  for (let i = 0; i < projCount; i++) projectiles.push(readProjectile(r));
  const { hot: _hot, ...cold } = wire;
  return { ...cold, units, projectiles };
}
