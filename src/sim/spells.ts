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
};

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
