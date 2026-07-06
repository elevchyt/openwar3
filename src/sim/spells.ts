import type { AbilityDef, AbilityLevel } from "../data/abilities";
import type { SimUnit, BuffKind } from "./world";

// Spell effect handlers, dispatched on an ability's base `code` (data/abilities).
// This is the modular seam: the sim executes a cast by looking up the handler for
// the ability's `code`, so a custom map's ability that copies a standard one runs
// the same behaviour with the map's own numbers. Adding a spell = one entry here
// + a KNOWN_ABILITIES row; no other engine changes.
//
// Handlers are pure effect appliers over a small SpellApi (below). Whether the
// effect is delivered instantly or by a travelling missile is decided by the
// caller (world.ts, from the ability's missileArt) — the handler is the same.

/** What a handler can do to the world. Implemented by SimWorld. */
export interface SpellApi {
  rng(): number;
  getUnit(id: number): SimUnit | undefined;
  /** Live units whose collision hull is within `radius` of a point. */
  unitsInArea(x: number, y: number, radius: number): SimUnit[];
  hostile(a: SimUnit, b: SimUnit): boolean;
  /** Same team (friendly). */
  ally(a: SimUnit, b: SimUnit): boolean;
  /** Deal spell damage (armour is NOT applied to most spell damage in WC3). */
  spellDamage(target: SimUnit, amount: number, sourceId: number): void;
  spellHeal(target: SimUnit, amount: number): void;
  applyBuff(target: SimUnit, buff: SimBuffInit): void;
  /** Remove timed (dispellable) buffs from a unit (Dispel Magic, etc.). */
  dispel(target: SimUnit): void;
  /** Ask the renderer to create a summoned/raised unit (deferred, like training). */
  requestSummon(unitId: string, x: number, y: number, facing: number, owner: number, team: number, durationSec: number, sourceId: number): void;
  /** Raise up to `max` friendly corpses near a point back to life (Resurrection). */
  raiseNearbyCorpses(x: number, y: number, radius: number, owner: number, team: number, max: number): number;
  /** Play an effect model at a unit (targetId>0) or a point (renderer). */
  emitEffect(art: string, x: number, y: number, targetId: number): void;
  /** Register a repeating area effect (Blizzard waves, Rain of Fire, …). */
  addSpellField(f: SpellFieldInit): void;
  /** Drain up to `amount` mana from a unit; returns the mana actually removed
   *  (Mana Burn deals damage equal to what it burned). */
  burnMana(target: SimUnit, amount: number): number;
  /** Move a unit instantly to a point (Blink, Mass Teleport) — re-settles pathing. */
  teleport(unit: SimUnit, x: number, y: number): void;
  /** Change a unit's controller (Charm): new owner + team. */
  changeOwner(unit: SimUnit, owner: number, team: number): void;
  /** Kill a unit outright (Death Pact / Dark Ritual sacrifice, Transmute). */
  killUnit(unit: SimUnit): void;
}

export interface SimBuffInit {
  kind: BuffKind;
  group?: string;
  timeLeft: number;
  sourceId: number;
  value?: number;
  value2?: number;
  art?: string;
}

export interface SpellFieldInit {
  code: string;
  x: number;
  y: number;
  area: number;
  damagePerWave: number;
  waves: number;
  interval: number; // seconds between waves
  casterId: number;
  art: string;
}

/** Where a cast is aimed. */
export interface CastContext {
  targetId: number; // unit target (0 = none)
  x: number; // point target / caster position
  y: number;
}

type Handler = (api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, ctx: CastContext) => void;

/** Curated effect models for spell fields whose art isn't in the ability data. */
const FIELD_ART: Record<string, string> = {
  AHbz: "Abilities\\Spells\\Human\\Blizzard\\BlizzardTarget.mdx",
};

/** Effect duration on a target: heroes resist longer effects (herodur). */
function dur(lvl: AbilityLevel, target: SimUnit): number {
  return target.isHero && lvl.heroDuration > 0 ? lvl.heroDuration : lvl.duration;
}
/** Read dataX (a=0..i=8); NaN-safe default. */
function d(lvl: AbilityLevel, i: number, def = 0): number {
  const v = lvl.data[i];
  return v === undefined || Number.isNaN(v) ? def : v;
}

// --- targeting helpers (shared by the hero spell handlers) -----------------

/** Live enemies of `caster` within `radius` of a point (excludes buildings unless
 *  `hitBuildings`, and the caster itself). */
function enemiesInArea(api: SpellApi, caster: SimUnit, x: number, y: number, radius: number, hitBuildings = false): SimUnit[] {
  return api.unitsInArea(x, y, radius).filter((t) => t !== caster && api.hostile(caster, t) && (hitBuildings || !t.building) && !t.invulnerable);
}

/** Living allies of `caster` within `radius` of a point (optionally excluding the
 *  caster and/or buildings). */
function alliesInArea(api: SpellApi, caster: SimUnit, x: number, y: number, radius: number, opts: { self?: boolean; buildings?: boolean } = {}): SimUnit[] {
  return api.unitsInArea(x, y, radius).filter((t) => (opts.self || t !== caster) && api.ally(caster, t) && (opts.buildings || !t.building));
}

/** Units struck by a line from the caster toward (tx,ty): within `length` forward
 *  and `halfWidth` to either side. Powers the line nukes (Shockwave, Impale,
 *  Carrion Swarm, Breath of Fire). */
function lineTargets(api: SpellApi, caster: SimUnit, tx: number, ty: number, length: number, halfWidth: number): SimUnit[] {
  const dx = tx - caster.x;
  const dy = ty - caster.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const out: SimUnit[] = [];
  // Query a circle covering the whole segment, then keep units near the axis.
  for (const t of api.unitsInArea(caster.x + ux * (length / 2), caster.y + uy * (length / 2), length / 2 + halfWidth + 64)) {
    if (t === caster) continue;
    const rx = t.x - caster.x;
    const ry = t.y - caster.y;
    const forward = rx * ux + ry * uy;
    const perp = Math.abs(rx * uy - ry * ux);
    if (forward >= -t.radius && forward <= length + t.radius && perp <= halfWidth + t.radius) out.push(t);
  }
  return out;
}

/** Units inside a cone of half-angle `halfAngle` (radians) from the caster toward
 *  (tx,ty), within `length` (Forked Lightning). */
function coneTargets(api: SpellApi, caster: SimUnit, tx: number, ty: number, length: number, halfAngle: number): SimUnit[] {
  const base = Math.atan2(ty - caster.y, tx - caster.x);
  const out: SimUnit[] = [];
  for (const t of api.unitsInArea(caster.x, caster.y, length + 64)) {
    if (t === caster) continue;
    const dist = Math.hypot(t.x - caster.x, t.y - caster.y);
    if (dist > length + t.radius) continue;
    const ang = Math.atan2(t.y - caster.y, t.x - caster.x);
    const diff = Math.abs(((ang - base + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (diff <= halfAngle) out.push(t);
  }
  return out;
}

/** Build a bounce chain of up to `count` targets, each the nearest unvisited valid
 *  unit within `jumpRange` of the previous (Chain Lightning, Healing Wave). */
function chainFrom(api: SpellApi, caster: SimUnit, first: SimUnit, count: number, jumpRange: number, wantHostile: boolean): SimUnit[] {
  const chain = [first];
  const visited = new Set<number>([first.id]);
  let cur = first;
  while (chain.length < count) {
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const t of api.unitsInArea(cur.x, cur.y, jumpRange)) {
      if (visited.has(t.id) || t === caster || t.building) continue;
      if (wantHostile ? !api.hostile(caster, t) || t.invulnerable : !api.ally(caster, t)) continue;
      const dd = Math.hypot(t.x - cur.x, t.y - cur.y);
      if (dd < bestD) {
        bestD = dd;
        best = t;
      }
    }
    if (!best) break;
    visited.add(best.id);
    chain.push(best);
    cur = best;
  }
  return chain;
}

/** Summon `count` copies of a unit for the caster, fanned around a point (each
 *  request is placed on the nearest free tile by the renderer). */
function summonMany(api: SpellApi, caster: SimUnit, unitId: string, x: number, y: number, count: number, durationSec: number): void {
  if (!unitId) return;
  for (let i = 0; i < Math.max(1, count); i++) {
    const facing = caster.facing + (i - (count - 1) / 2) * 0.5;
    api.requestSummon(unitId, x, y, facing, caster.owner, caster.team, durationSec, caster.id);
  }
}

/** Summoned-unit ids for abilities whose unit isn't in the SLK `unitid` column
 *  (it lives in a data string we parse only as a number). Verified in the MPQ. */
const SUMMON_FALLBACK: Record<string, string> = {
  AUcb: "ucs1", // Carrion Beetles → Carrion Beetle (dataC string in the SLK)
  ANef: "npn1", // Storm, Earth & Fire → one of the split pandaren (npn1/2/3)
};

export const SPELL_HANDLERS: Record<string, Handler> = {
  // Holy Light — heal a friendly living unit for dataA, or smite an enemy Undead
  // unit for dataA (the projectile/impact carries this on units with a missile;
  // Holy Light itself is instant). Half damage vs the living is not applicable —
  // it only harms the Undead.
  AHhb: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    if (api.ally(caster, t) && t.race !== "undead") api.spellHeal(t, d(lvl, 0));
    else if (api.hostile(caster, t) && t.race === "undead") api.spellDamage(t, d(lvl, 0), caster.id);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Death Coil — the inverse: heal a friendly Undead unit, or harm an enemy
  // living unit, for dataA.
  AUdc: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    if (api.ally(caster, t) && t.race === "undead") api.spellHeal(t, d(lvl, 0));
    else if (api.hostile(caster, t) && t.race !== "undead") api.spellDamage(t, d(lvl, 0), caster.id);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Storm Bolt — throw a hammer: dataA damage + stun for dur/herodur.
  AHtb: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.spellDamage(t, d(lvl, 0), caster.id);
    api.applyBuff(t, { kind: "stun", timeLeft: dur(lvl, t), sourceId: caster.id, art: def.targetArt });
  },

  // Thunder Clap — slam the ground: dataA damage + slow (move dataC, attack dataD)
  // to enemy ground units within `area`.
  AHtc: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    for (const t of api.unitsInArea(ctx.x, ctx.y, lvl.area)) {
      if (t === caster || !api.hostile(caster, t) || t.flying) continue;
      api.spellDamage(t, d(lvl, 0), caster.id);
      api.applyBuff(t, { kind: "slow", timeLeft: dur(lvl, t), sourceId: caster.id, value: d(lvl, 2, 0.25), value2: d(lvl, 3, 0.25) });
    }
  },

  // Divine Shield — self-invulnerability for the duration.
  AHds: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.applyBuff(caster, { kind: "invuln", timeLeft: lvl.duration || lvl.heroDuration, sourceId: caster.id, art: def.targetArt });
  },

  // Avatar (MK ultimate) — become a giant: +armour, +damage, immune to stun/slow
  // (approximated via the invuln flag being magic-immunity here). Big and brief.
  AHav: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const t = lvl.duration || lvl.heroDuration || 30;
    api.applyBuff(caster, { kind: "armor", group: "avatar", timeLeft: t, sourceId: caster.id, value: d(lvl, 0, 5) < 1 ? 15 : d(lvl, 0), art: def.targetArt });
    api.applyBuff(caster, { kind: "damage", group: "avatar", timeLeft: t, sourceId: caster.id, value: 40 });
  },

  // Resurrection (Paladin ultimate) — raise up to dataA dead friendly units near
  // the caster back to life from their corpses.
  AHre: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    api.raiseNearbyCorpses(ctx.x, ctx.y, lvl.area || 900, caster.owner, caster.team, Math.max(1, d(lvl, 0, 6)));
  },

  // Summon Water Elemental — spawn the summoned unit (unitid) beside the caster
  // for the duration; it expires (and dies) automatically.
  AHwe: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    if (!lvl.summon) return;
    api.requestSummon(lvl.summon, caster.x, caster.y, caster.facing, caster.owner, caster.team, lvl.heroDuration || lvl.duration || 60, caster.id);
  },

  // Blizzard — channelled: dataA waves, each dealing dataB damage in `area`,
  // dataD seconds apart (registered as a repeating field; see tickSpellFields).
  AHbz: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    // Blizzard ships no effect-art field in the data — use the known shard model.
    const art = def.areaArt || def.targetArt || FIELD_ART[def.code] || "";
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area: lvl.area, damagePerWave: d(lvl, 1, 30), waves: d(lvl, 0, 6), interval: d(lvl, 3, 0.5) || 0.5, casterId: caster.id, art });
  },

  // Heal (Priest) — restore dataA HP to a friendly living, non-mechanical unit.
  Ahea: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t) || t.mechanical) return;
    api.spellHeal(t, d(def.levelData[rank - 1], 0, 25));
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Inner Fire — buff a friendly unit: +armour (dataB) and +damage (dataA as a
  // fraction of base is complex; apply a flat bonus scaled by the caster's data).
  Ainf: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "armor", group: "innerfire", timeLeft: dur(lvl, t) || 30, sourceId: caster.id, value: d(lvl, 1, 5), art: def.targetArt });
    api.applyBuff(t, { kind: "damage", group: "innerfire", timeLeft: dur(lvl, t) || 30, sourceId: caster.id, value: Math.max(1, Math.round((t.baseDamage || 10) * (d(lvl, 0, 0.1) || 0.1))) });
  },

  // Slow — cripple an enemy: slow its movement (dataA) and attack (dataB).
  Aslo: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "slow", group: "slow", timeLeft: dur(lvl, t) || 15, sourceId: caster.id, value: d(lvl, 0, 0.35), value2: d(lvl, 1, 0.35), art: def.targetArt });
  },

  // Dispel Magic — clear timed buffs from every unit in the area; summoned units
  // additionally take dataB damage (which usually destroys them).
  Adis: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.targetArt) api.emitEffect(def.targetArt, ctx.x, ctx.y, 0);
    for (const t of api.unitsInArea(ctx.x, ctx.y, lvl.area)) {
      api.dispel(t);
      if (t.summonLeft > 0) api.spellDamage(t, d(lvl, 1, 200), caster.id);
    }
  },

  // ======================================================================
  //  Melee hero abilities (dispatched on base code — see data/abilities.ts).
  //  Numbers read from the MPQ AbilityData.slk data columns (verified 2026-07).
  // ======================================================================

  // --- line / cone / area nukes ---

  // Shockwave (Tauren) — dataA damage to every enemy along an 800-long, 125-wide
  // line toward the target point (dataC = distance, area = width).
  AOsh: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    for (const t of lineTargets(api, caster, ctx.x, ctx.y, d(lvl, 2, 800), lvl.area || 125)) {
      if (api.hostile(caster, t)) api.spellDamage(t, d(lvl, 0, 75), caster.id);
    }
  },

  // Carrion Swarm (Dreadlord) — line nuke (dataC distance, area width), dataA per
  // unit up to a dataB total-damage cap.
  AUcs: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    let budget = d(lvl, 1, 300);
    for (const t of lineTargets(api, caster, ctx.x, ctx.y, d(lvl, 2, 700), lvl.area || 100)) {
      if (!api.hostile(caster, t) || budget <= 0) continue;
      const dmg = Math.min(d(lvl, 0, 75), budget);
      api.spellDamage(t, dmg, caster.id);
      budget -= dmg;
    }
  },

  // Impale (Crypt Lord) — spikes erupt along a line (dataA distance, area width):
  // dataC damage + a stun (dur/herodur) to ground enemies.
  AUim: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    for (const t of lineTargets(api, caster, ctx.x, ctx.y, d(lvl, 0, 600), (lvl.area || 250) / 2)) {
      if (!api.hostile(caster, t) || t.flying) continue;
      api.spellDamage(t, d(lvl, 2, 50), caster.id);
      api.applyBuff(t, { kind: "stun", timeLeft: dur(lvl, t) || 1, sourceId: caster.id, art: def.targetArt });
    }
  },

  // Breath of Fire (Brewmaster) — cone/line of flame: dataA damage (dataC distance,
  // area width) to enemies in front of the caster.
  ANbf: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    for (const t of lineTargets(api, caster, ctx.x, ctx.y, d(lvl, 2, 375), lvl.area || 125)) {
      if (api.hostile(caster, t)) api.spellDamage(t, d(lvl, 0, 65), caster.id);
    }
  },

  // Forked Lightning (Naga) — dataA damage to up to dataB enemies in a cone.
  ANfl: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const targets = coneTargets(api, caster, ctx.x, ctx.y, lvl.castRange || 600, 0.5).filter((t) => api.hostile(caster, t));
    for (const t of targets.slice(0, d(lvl, 1, 3))) api.spellDamage(t, d(lvl, 0, 85), caster.id);
  },

  // Fan of Knives (Warden) — PBAoE: dataA damage to all enemies within `area`.
  AEfk: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    for (const t of enemiesInArea(api, caster, caster.x, caster.y, lvl.area || 400)) api.spellDamage(t, d(lvl, 0, 75), caster.id);
  },

  // War Stomp (Tauren) — slam: dataA damage + a stun (dur/herodur) to ground
  // enemies within `area`.
  AOws: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    for (const t of enemiesInArea(api, caster, caster.x, caster.y, lvl.area || 250)) {
      if (t.flying) continue;
      api.spellDamage(t, d(lvl, 0, 25), caster.id);
      api.applyBuff(t, { kind: "stun", timeLeft: dur(lvl, t) || 2, sourceId: caster.id });
    }
  },

  // Frost Nova (Lich) — the missile impacts one unit; dataB to the primary target,
  // dataA to others within `area`, and a movement/attack slow to all of them.
  AUfn: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, 0);
    api.spellDamage(t, d(lvl, 1, 100), caster.id);
    for (const o of enemiesInArea(api, caster, t.x, t.y, lvl.area || 200)) {
      if (o !== t) api.spellDamage(o, d(lvl, 0, 50), caster.id);
      api.applyBuff(o, { kind: "slow", group: "frostnova", timeLeft: dur(lvl, o) || 4, sourceId: caster.id, value: 0.4, value2: 0.4 });
    }
  },

  // Chain Lightning (Far Seer) — bounces to dataB targets, losing dataC of the
  // damage each jump (area = jump range, dataA = base damage).
  AOcl: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const chain = chainFrom(api, caster, t, d(lvl, 1, 4), lvl.area || 500, true);
    const falloff = d(lvl, 2, 0.15);
    chain.forEach((u, i) => {
      api.spellDamage(u, d(lvl, 0, 85) * Math.pow(1 - falloff, i), caster.id);
      if (def.targetArt) api.emitEffect(def.targetArt, u.x, u.y, u.id);
    });
  },

  // --- heals ---

  // Healing Wave (Shadow Hunter) — heals the target for dataA, then bounces to
  // dataB allies, losing dataC of the healing each jump.
  AOhw: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const chain = chainFrom(api, caster, t, d(lvl, 1, 3), lvl.area || 500, false);
    const falloff = d(lvl, 2, 0.25);
    chain.forEach((u, i) => {
      if (!u.mechanical) api.spellHeal(u, d(lvl, 0, 130) * Math.pow(1 - falloff, i));
      if (def.targetArt) api.emitEffect(def.targetArt, u.x, u.y, u.id);
    });
  },

  // Tranquility (Keeper, ult) — heal every ally in a wide area over time (applied
  // as a heal-over-time buff for the channel duration; dataA = hp/sec).
  AEtq: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.areaArt) api.emitEffect(def.areaArt, ctx.x, ctx.y, 0);
    for (const t of alliesInArea(api, caster, ctx.x, ctx.y, lvl.area || 1000, { self: true })) {
      if (!t.mechanical) api.applyBuff(t, { kind: "hot", group: "tranquility", timeLeft: lvl.duration || 30, sourceId: caster.id, value: d(lvl, 0, 20), art: def.targetArt });
    }
  },

  // Healing Spray (Alchemist) — heal allies in a small area for dataA on cast.
  ANhs: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.areaArt) api.emitEffect(def.areaArt, ctx.x, ctx.y, 0);
    for (const t of alliesInArea(api, caster, ctx.x, ctx.y, lvl.area || 250, { self: true })) {
      if (!t.mechanical) api.spellHeal(t, d(lvl, 0, 40));
    }
  },

  // --- disables / debuffs ---

  // Entangling Roots (Keeper) — root a target in place (can still attack) and
  // deal dataA damage per second for the duration.
  AEer: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || t.flying) return;
    const lvl = def.levelData[rank - 1];
    const d0 = dur(lvl, t) || 9;
    api.applyBuff(t, { kind: "root", group: "roots", timeLeft: d0, sourceId: caster.id, value: 1, art: def.targetArt });
    api.applyBuff(t, { kind: "dot", group: "roots", timeLeft: d0, sourceId: caster.id, value: d(lvl, 0, 15) });
  },

  // Sleep (Dreadlord) — put a target to sleep (disabled until it takes damage).
  AUsl: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || t.building) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "sleep", group: "sleep", timeLeft: dur(lvl, t) || 5, sourceId: caster.id, art: def.targetArt });
  },

  // Hex (Shadow Hunter) — transform a target into a critter: disabled (can't
  // attack or cast) for the duration; modelled as a stun.
  AOhx: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "stun", group: "hex", timeLeft: dur(lvl, t) || 4, sourceId: caster.id, art: def.targetArt });
  },

  // Banish (Blood Mage) — slow a target's movement & attack (and, in WC3, make it
  // take extra magic damage — approximated by the slow) for the duration. The
  // banished unit wears the ethereal BanishTarget glow for the whole time — that
  // model is the buff's own TargetArt (def.buffArt), not the ability's (which is
  // empty), so the renderer keeps it attached while the buff lasts.
  AHbn: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "slow", group: "banish", timeLeft: dur(lvl, t) || 12, sourceId: caster.id, value: d(lvl, 0, 0.5), value2: d(lvl, 0, 0.5), art: def.buffArt });
  },

  // Doom (Pit Lord, ult) — a heavy damage-over-time curse (dataA/sec).
  ANdo: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "dot", group: "doom", timeLeft: 40, sourceId: caster.id, value: d(lvl, 0, 40), art: def.targetArt });
  },

  // Soul Burn (Firelord) — a damage-over-time burn that also silences the target.
  ANso: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const d0 = dur(lvl, t) || 6;
    api.applyBuff(t, { kind: "dot", group: "soulburn", timeLeft: d0, sourceId: caster.id, value: d(lvl, 0, 7), art: def.targetArt });
    api.applyBuff(t, { kind: "silence", group: "soulburn", timeLeft: d0, sourceId: caster.id });
  },

  // Acid Bomb (Alchemist) — splash: reduce armour (negative armour buff, dataD)
  // and apply a corrosive damage-over-time (dataE) to the target and nearby units.
  ANab: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    for (const o of enemiesInArea(api, caster, t.x, t.y, lvl.area || 200)) {
      api.applyBuff(o, { kind: "armor", group: "acid", timeLeft: lvl.duration || 15, sourceId: caster.id, value: -d(lvl, 3, 5), art: def.targetArt });
      api.applyBuff(o, { kind: "dot", group: "acid", timeLeft: lvl.duration || 15, sourceId: caster.id, value: d(lvl, 4, 3) });
    }
  },

  // Mana Burn (Demon Hunter) — burn up to dataA mana; deal that much damage.
  AEmb: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const burned = api.burnMana(t, d(lvl, 0, 50));
    if (burned > 0) api.spellDamage(t, burned, caster.id);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Shadow Strike (Warden) — the missile hits for dataE, then a poison damage-
  // over-time (dataA/sec) plus a movement slow for the duration.
  AEsh: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const d0 = dur(lvl, t) || 15;
    api.spellDamage(t, d(lvl, 4, 75), caster.id);
    api.applyBuff(t, { kind: "dot", group: "shadowstrike", timeLeft: d0, sourceId: caster.id, value: d(lvl, 0, 10), art: def.targetArt });
    api.applyBuff(t, { kind: "slow", group: "shadowstrike", timeLeft: d0, sourceId: caster.id, value: d(lvl, 1, 0.5), value2: 0 });
  },

  // Howl of Terror (Pit Lord) — enemies in `area` deal dataA less attack damage.
  ANht: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    for (const t of enemiesInArea(api, caster, caster.x, caster.y, lvl.area || 500, true)) {
      api.applyBuff(t, { kind: "damagePct", group: "howl", timeLeft: lvl.duration || 15, sourceId: caster.id, value: -d(lvl, 0, 0.3) });
    }
  },

  // Drunken Haze (Brewmaster) — slow the movement & attack of enemies in an area
  // (the WC3 miss chance isn't modelled).
  ANdh: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    for (const t of enemiesInArea(api, caster, ctx.x, ctx.y, lvl.area || 200)) {
      api.applyBuff(t, { kind: "slow", group: "haze", timeLeft: dur(lvl, t) || 10, sourceId: caster.id, value: 0.25, value2: 0.25, art: def.targetArt });
    }
  },

  // Silence (Dark Ranger) — enemies in the area can't cast for the duration.
  ANsi: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.areaArt) api.emitEffect(def.areaArt, ctx.x, ctx.y, 0);
    for (const t of enemiesInArea(api, caster, ctx.x, ctx.y, lvl.area || 300, true)) {
      api.applyBuff(t, { kind: "silence", group: "silence", timeLeft: lvl.duration || 8, sourceId: caster.id, art: def.targetArt });
    }
  },

  // --- point-AoE fields (Blizzard-style repeating waves) ---

  // Rain of Fire (Pit Lord) — dataA waves of dataB damage in `area`, dataD apart.
  ANrf: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 200, damagePerWave: d(lvl, 1, 25), waves: d(lvl, 0, 6), interval: d(lvl, 3, 0.5) || 0.5, casterId: caster.id, art: def.areaArt || def.targetArt });
  },

  // Flame Strike (Blood Mage) — a burning pillar: dataA damage per second in `area`
  // for the burn duration (modelled as one-second waves). WC3 shows two distinct
  // arts: the ground "beware" warning ring (ability Effectart = FlameStrikeTarget)
  // that drops the instant the cast lands, and the erupting fire pillar (ability
  // Specialart = FlameStrike1) — scattered across the burn area each wave so the
  // whole circle looks alight, not just its centre.
  AHfs: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const waves = Math.max(4, Math.round(lvl.duration || 9));
    if (def.effectArt) api.emitEffect(def.effectArt, ctx.x, ctx.y, 0); // warning ring at centre
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 200, damagePerWave: d(lvl, 0, 15), waves, interval: 1, casterId: caster.id, art: def.specialArt || def.areaArt || def.targetArt });
  },

  // Death and Decay (Lich, ult) — a decay field damaging everything in `area` each
  // second for the duration (flat approximation of WC3's %-max-hp tick).
  AUdd: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const waves = Math.max(6, Math.round(lvl.duration || 30));
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 300, damagePerWave: 20, waves, interval: 1, casterId: caster.id, art: def.areaArt || def.targetArt });
  },

  // Starfall (Priestess, ult) — channelled: stars rain on enemies around the
  // caster (dataA per wave, dataB apart) for the duration.
  AEsf: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const interval = d(lvl, 1, 1.5) || 1.5;
    const waves = Math.max(4, Math.round((lvl.duration || 45) / interval));
    api.addSpellField({ code: def.code, x: caster.x, y: caster.y, area: lvl.area || 800, damagePerWave: d(lvl, 0, 50), waves, interval, casterId: caster.id, art: def.areaArt || def.targetArt });
  },

  // Stampede (Beastmaster, ult) — a herd tramples the target area over time.
  ANst: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 1000, damagePerWave: d(lvl, 1, 55), waves: 15, interval: 2, casterId: caster.id, art: def.areaArt || def.targetArt });
  },

  // Cluster Rockets (Tinker) — dataC volleys of dataA damage in `area`.
  ANcs: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 200, damagePerWave: d(lvl, 0, 30), waves: d(lvl, 2, 6), interval: 0.2, casterId: caster.id, art: def.areaArt || def.targetArt });
  },

  // Volcano (Firelord, ult) — sustained eruption damaging the target area.
  ANvc: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 500, damagePerWave: d(lvl, 1, 8), waves: 12, interval: 1, casterId: caster.id, art: def.areaArt || def.targetArt });
  },

  // Earthquake (Far Seer, ult) — rumbling field: slows units and damages buildings
  // in `area`. Modelled as a repeating damage field over the ground.
  AOeq: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const waves = Math.max(6, Math.round(lvl.duration || 25));
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area: lvl.area || 250, damagePerWave: d(lvl, 1, 50) / 4, waves, interval: 1, casterId: caster.id, art: def.areaArt || def.targetArt });
    for (const t of enemiesInArea(api, caster, ctx.x, ctx.y, lvl.area || 250, true)) {
      api.applyBuff(t, { kind: "slow", group: "quake", timeLeft: lvl.duration || 25, sourceId: caster.id, value: d(lvl, 0, 0.5), value2: 0 });
    }
  },

  // --- self buffs / channels ---

  // Bladestorm (Blademaster, ult) — the caster becomes a whirlwind, dealing dataA
  // damage per second to surrounding enemies for the channel.
  AOww: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.addSpellField({ code: def.code, x: caster.x, y: caster.y, area: lvl.area || 200, damagePerWave: d(lvl, 0, 110), waves: Math.max(3, Math.round(lvl.duration || 7)), interval: 1, casterId: caster.id, art: def.casterArt || def.specialArt });
  },

  // Immolation (Demon Hunter) — burn nearby enemies for dataA/sec; here it fires a
  // short damage field around the caster (a toggle isn't modelled).
  AEim: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.addSpellField({ code: def.code, x: caster.x, y: caster.y, area: lvl.area || 160, damagePerWave: d(lvl, 0, 10), waves: 12, interval: 1, casterId: caster.id, art: def.specialArt || def.casterArt });
  },

  // Locust Swarm (Crypt Lord, ult) — a swarm drains enemies around the caster.
  AUls: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.addSpellField({ code: def.code, x: caster.x, y: caster.y, area: lvl.area || 800, damagePerWave: d(lvl, 0, 20) / 4, waves: Math.max(6, Math.round(lvl.duration || 30)), interval: 1, casterId: caster.id, art: def.casterArt || def.specialArt });
  },

  // Wind Walk (Blademaster) — a burst of speed + bonus attack damage (WC3 also
  // grants invisibility, which we don't model) for the duration.
  AOwk: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const d0 = lvl.duration || 20;
    api.applyBuff(caster, { kind: "haste", group: "windwalk", timeLeft: d0, sourceId: caster.id, value: d(lvl, 1, 0.5), value2: 0, art: def.targetArt });
    api.applyBuff(caster, { kind: "damage", group: "windwalk", timeLeft: d0, sourceId: caster.id, value: d(lvl, 2, 40) });
  },

  // Metamorphosis / Robo-Goblin / Chemical Rage — transforms modelled as a timed
  // self power-up (bonus armour, damage, and attack speed) rather than a full
  // model/stat swap.
  AEme: (api, caster, def, rank) => transformBuff(api, caster, def, rank, 6, 20),
  ANrg: (api, caster, def, rank) => transformBuff(api, caster, def, rank, 4, 12),
  ANcr: (api, caster, def, rank) => transformBuff(api, caster, def, rank, 3, 10),

  // Frost Armor (Lich) — buff a friendly unit with +armour (dataB) for the
  // duration (WC3 also slows melee attackers, which we don't model). Autocasts.
  AUfu: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "armor", group: "frostarmor", timeLeft: lvl.duration || 60, sourceId: caster.id, value: d(lvl, 1, 3), art: def.targetArt });
  },

  // Far Sight (Far Seer) — reveal an area of the map. We have no fog of war yet, so
  // this only plays its effect; it exists so the Far Seer can learn all 4 skills.
  AOfs: (api, _caster, def, _rank, ctx) => {
    if (def.areaArt || def.targetArt) api.emitEffect(def.areaArt || def.targetArt, ctx.x, ctx.y, 0);
  },

  // Mana Shield (Naga) — absorb incoming damage into mana (dataA mana per hp).
  ANms: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.applyBuff(caster, { kind: "manaShield", group: "manashield", timeLeft: 3600, sourceId: caster.id, value: d(lvl, 0, 1) || 1, art: def.targetArt });
  },

  // Blink (Warden / Demon Hunter's Illidan) — teleport toward the target point,
  // capped at the ability's max range (dataA).
  AEbl: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const maxR = d(lvl, 0, 1000);
    const dx = ctx.x - caster.x;
    const dy = ctx.y - caster.y;
    const dist = Math.hypot(dx, dy) || 1;
    const r = Math.min(dist, maxR);
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, 0);
    api.teleport(caster, caster.x + (dx / dist) * r, caster.y + (dy / dist) * r);
    if (def.targetArt) api.emitEffect(def.targetArt, caster.x, caster.y, 0);
  },

  // Mass Teleport (Archmage, ult) — warp the caster and nearby allies to a point.
  AHmt: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const allies = alliesInArea(api, caster, caster.x, caster.y, lvl.area || 700, { self: true }).slice(0, d(lvl, 0, 24));
    allies.forEach((t, i) => {
      const a = (i / Math.max(1, allies.length)) * Math.PI * 2;
      api.teleport(t, ctx.x + Math.cos(a) * (i === 0 ? 0 : 128), ctx.y + Math.sin(a) * (i === 0 ? 0 : 128));
    });
  },

  // Big Bad Voodoo (Shadow Hunter, ult) — nearby allies become invulnerable.
  AOvd: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    for (const t of alliesInArea(api, caster, caster.x, caster.y, lvl.area || 800, { self: false })) {
      api.applyBuff(t, { kind: "invuln", group: "voodoo", timeLeft: lvl.duration || 30, sourceId: caster.id, art: def.targetArt });
    }
  },

  // --- drains / sacrifices ---

  // Siphon Mana / Life Drain (Blood Mage / Dark Ranger) — drain the target: a
  // damage-over-time on it and an equal heal-over-time on the caster.
  AHdr: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const rate = d(lvl, 1, 15) || 15;
    const d0 = lvl.duration || 6;
    api.applyBuff(t, { kind: "dot", group: "drain", timeLeft: d0, sourceId: caster.id, value: rate, art: def.targetArt });
    api.applyBuff(caster, { kind: "hot", group: "drain", timeLeft: d0, sourceId: caster.id, value: rate });
  },

  // Death Pact (Death Knight) — sacrifice a friendly non-hero unit to heal the
  // caster for its remaining hit points.
  AUdp: (api, caster, def, _rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t) || t.isHero) return;
    api.spellHeal(caster, t.maxHp);
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    api.killUnit(t);
  },

  // Dark Ritual (Lich) — sacrifice a friendly non-hero unit for mana (dataA of its
  // hit points).
  AUdr: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t) || t.isHero) return;
    const lvl = def.levelData[rank - 1];
    caster.mana = Math.min(caster.maxMana, caster.mana + t.maxHp * d(lvl, 0, 0.33));
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    api.killUnit(t);
  },

  // Charm (Dark Ranger, ult) — take control of a non-hero enemy of level ≤ dataA.
  ANch: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || t.isHero || t.level > d(def.levelData[rank - 1], 0, 5)) return;
    api.changeOwner(t, caster.owner, caster.team);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Transmute (Alchemist, ult) — instantly kill a non-hero target (gold reward is
  // handled by the economy layer).
  ANtm: (api, _caster, def, _rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || t.isHero || t.building) return;
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
    api.killUnit(t);
  },

  // --- summons ---

  // Feral Spirit (Far Seer) — summon dataB wolves.
  AOsf: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  // Force of Nature (Keeper) — summon dataA treants at the target point.
  AEfn: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 0, atPoint: true }, ctx),
  // Carrion Beetles (Crypt Lord) — raise a beetle from a corpse at the point.
  AUcb: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  // Summon Bear / Quilbeast / Hawk (Beastmaster) — one beast beside the caster.
  ANsg: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  ANsq: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  ANsw: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  // Scout (Priestess) — summon a flying owl for vision.
  AEst: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  // Summon Lava Spawn (Firelord) — spawn a lava spawn at the point.
  ANlm: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  // Serpent Ward (Shadow Hunter) — a stationary attack ward at the point.
  AOwd: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  // Tornado (Naga, ult) — a roaming tornado at the point.
  ANto: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  // Pocket Factory (Tinker) — deploy a factory at the point.
  ANsy: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  // Storm, Earth and Fire (Brewmaster, ult) — split into three pandaren.
  ANef: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 3, atPoint: false }),
  // Phoenix (Blood Mage, ult) — summon a phoenix beside the caster.
  AHpx: (api, caster, def, rank) => summonSpell(api, caster, def, rank, { count: 1, atPoint: false }),
  // Mirror Image (Blademaster) — conjure illusions (copies of the caster's type).
  AOmi: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    summonMany(api, caster, caster.typeId, caster.x, caster.y, Math.max(1, d(lvl, 1, 1)), lvl.heroDuration || lvl.duration || 60);
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
  },

  // Inferno (Dreadlord, ult) — an infernal crashes down at the point, dealing
  // dataA impact damage to enemies in `area`, then fights for the duration.
  AUin: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    for (const t of enemiesInArea(api, caster, ctx.x, ctx.y, lvl.area || 250, true)) api.spellDamage(t, d(lvl, 0, 50), caster.id);
    if (lvl.summon) api.requestSummon(lvl.summon, ctx.x, ctx.y, caster.facing, caster.owner, caster.team, lvl.heroDuration || lvl.duration || 180, caster.id);
    if (def.specialArt) api.emitEffect(def.specialArt, ctx.x, ctx.y, 0);
  },

  // Animate Dead (Death Knight, ult) — raise dataA nearby corpses to fight again.
  AUan: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, ctx.x, ctx.y, 0);
    api.raiseNearbyCorpses(ctx.x, ctx.y, lvl.area || 900, caster.owner, caster.team, Math.max(1, d(lvl, 0, 6)));
  },
};

/** Level-data of the ability being cast (rank is 1-based). */
function lv(def: AbilityDef, rank: number): AbilityLevel {
  return def.levelData[Math.min(rank, def.levelData.length) - 1];
}

/** A transform ultimate/toggle modelled as a timed self power-up: +armour and
 *  +attack damage, plus a movement/attack-speed boost, for the (hero) duration. */
function transformBuff(api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, armor: number, damage: number): void {
  const lvl = lv(def, rank);
  const t = lvl.heroDuration || lvl.duration || 30;
  api.applyBuff(caster, { kind: "armor", group: "transform", timeLeft: t, sourceId: caster.id, value: armor, art: def.targetArt });
  api.applyBuff(caster, { kind: "damage", group: "transform", timeLeft: t, sourceId: caster.id, value: damage });
  api.applyBuff(caster, { kind: "haste", group: "transform", timeLeft: t, sourceId: caster.id, value: 0.15, value2: 0.15 });
}

/** Generic summon: place `count` (0 ⇒ read dataA/dataB) copies of the ability's
 *  summoned unit (SLK `unitid`, or a per-code fallback) beside the caster or at a
 *  target point, for the (hero) duration. */
function summonSpell(api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, opts: { count: number; atPoint: boolean }, ctx?: CastContext): void {
  const lvl = lv(def, rank);
  const unitId = lvl.summon || SUMMON_FALLBACK[def.code] || "";
  if (!unitId) return;
  const count = opts.count > 0 ? opts.count : Math.max(1, d(lvl, 1, d(lvl, 0, 1)));
  const x = opts.atPoint && ctx ? ctx.x : caster.x;
  const y = opts.atPoint && ctx ? ctx.y : caster.y;
  summonMany(api, caster, unitId, x, y, count, lvl.heroDuration || lvl.duration || 60);
  if (def.specialArt) api.emitEffect(def.specialArt, x, y, 0);
}

/** One stat effect an aura grants to a unit in range. */
export interface AuraEffect {
  kind: BuffKind;
  value: number;
  value2?: number;
  rangedOnly?: boolean; // only benefits units with a ranged weapon (Trueshot)
  meleeOnly?: boolean; // only benefits melee units (Vampiric)
}

/** Passive auras, applied each tick by the world to the caster + nearby allies.
 *  Keyed by base `code` → the effect(s) each aura grants at the shown level. Data
 *  columns verified against the MPQ + Liquipedia (see docs/REFERENCES.md). */
export const AURA_BUFFS: Record<string, (lvl: AbilityLevel) => AuraEffect[]> = {
  AHad: (lvl) => [{ kind: "armor", value: d(lvl, 0, 1.5) }], // Devotion — +armour
  AHab: (lvl) => [{ kind: "manaRegen", value: d(lvl, 0, 0.75) }], // Brilliance — +mana regen/sec
  AOae: (lvl) => [{ kind: "haste", value: d(lvl, 0, 0.1), value2: d(lvl, 0, 0.1) }], // Endurance — +move & attack speed
  AUau: (lvl) => [
    { kind: "haste", value: d(lvl, 0, 0.1), value2: 0 }, // Unholy — +move speed
    { kind: "hpRegen", value: d(lvl, 1, 0.5) }, // …and hp regen
  ],
  AEar: (lvl) => [{ kind: "damagePct", value: d(lvl, 0, 0.1), rangedOnly: true }], // Trueshot — +ranged damage
  AOac: (lvl) => [{ kind: "damagePct", value: d(lvl, 0, 0.1) }], // Command — +attack damage
  AUav: (lvl) => [{ kind: "lifesteal", value: d(lvl, 0, 0.15), meleeOnly: true }], // Vampiric — melee life steal
  AEah: (lvl) => [{ kind: "thorns", value: d(lvl, 0, 0.1) }], // Thorns — return melee damage
};
