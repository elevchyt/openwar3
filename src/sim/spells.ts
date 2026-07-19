import type { AbilityDef, AbilityLevel, BuffFx } from "../data/abilities";
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
  /** Ask the renderer to create a summoned/raised unit (deferred, like training).
   *  `art.summon` plays where the unit materializes; `art.unsummon` replaces it when its
   *  timer runs out or it is dismissed (see summonArt/unsummonArt).
   *  `atPoint` says (x, y) is a TARGETED point the unit must land ON — a ward goes where
   *  you clicked. Without it (x, y) is the caster's own position and the unit is placed a
   *  step in front of them, WC3-style (see MapViewerScene.summonSpot). */
  requestSummon(unitId: string, x: number, y: number, facing: number, owner: number, team: number, durationSec: number, sourceId: number, art?: { summon: string; unsummon: string }, atPoint?: boolean): void;
  /** Raise up to `max` friendly corpses near a point back to life (Resurrection). */
  raiseNearbyCorpses(x: number, y: number, radius: number, owner: number, team: number, max: number): number;
  /** Consume ONE corpse within `radius` — the Ghoul's meal. Returns false when there is
   *  nothing to eat, which is the difference between raising (take what you can, any number)
   *  and cannibalising (one body, and no ability without it). */
  consumeCorpse(x: number, y: number, radius: number): boolean;
  /** Spirit Link: mark `unit` as sharing `share` of its damage across the `group` unit ids
   *  for `durationSec`. Applied to every member so the split is symmetric. */
  linkSpirits(unit: SimUnit, group: number[], durationSec: number, share: number): void;
  /** Kodo Devour: `kodo` swallows `prey` (hidden inside, digested over time). */
  devour(kodo: SimUnit, prey: SimUnit): void;
  /** Spirit Walker: toggle between ethereal and corporeal form (morph + ethereal state). */
  toggleSpiritForm(unit: SimUnit): void;
  /** True during daylight (Dawn–Dusk on the sim clock). Shadow Meld is a night ability, and
   *  the day/night cycle is the only world state any spell currently reads. */
  isDay(): boolean;
  /** Root/Unroot (`Aroo`): toggle an Ancient between planted and walking. False if it refused
   *  — the only refusal is trying to plant where the footprint no longer fits. */
  toggleRoot(unit: SimUnit): boolean;
  /** Put a unit into the hold-position stance (order "hold"), clearing whatever it was
   *  doing. Shadow Meld melds a unit INTO this stance: WC3 has a melded unit "hold position
   *  and hold their fire", which is what stops it walking out of its own invisibility. */
  holdPosition(unit: SimUnit): void;
  /** Dismiss an owner's existing summons of the given types — Feral Spirit replaces the
   *  caster's old wolves on re-cast. Each leaves via its OWN unsummon effect (the art it
   *  was summoned with), so this needs no art passed in. */
  dismissSummons(owner: number, typeIds: string[]): void;
  /** Play an effect model at a unit (targetId>0) or a point (renderer). `life` = how
   *  long (s) the model instance is held before detaching (default ~2s); pass a longer
   *  value for a sustained effect like Flame Strike's 7s fire pillar. */
  emitEffect(art: string, x: number, y: number, targetId: number, life?: number): void;
  /** Paint a temporary ground decal at a point — an `Splats\UberSplatData.slk` row id
   *  (Thunder Clap's `THND`). The row carries the texture, its half-width `Scale`, and
   *  the BirthTime/PauseTime/Decay fade the renderer plays it through. Which ability
   *  paints which splat is the engine's own wiring: nothing in AbilityData points at an
   *  ubersplat, but the table names the rows after the abilities that use them. */
  emitSplat(splatId: string, x: number, y: number): void;
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

  /** Mirror Image: run the caster-vanishes -> missiles -> illusions sequence (AOmi).
   *  Staged over time in the world, so the handler only kicks it off. */
  mirrorImage(caster: SimUnit, def: AbilityDef, rank: number): void;
}

export interface SimBuffInit {
  kind: BuffKind;
  group?: string;
  timeLeft: number;
  sourceId: number;
  value?: number;
  value2?: number;
  art?: string;
  /** The buff's persistent models + attachment points (def.buffFx). Pass this via
   *  `...fx(def)` — see below — rather than setting `art` by hand. */
  fx?: BuffFx[];
  delay?: number; // seconds before the effect engages (Wind Walk's Transition Time)
  /** Marks a Shadow Meld invisibility, which also breaks on MOVEMENT and at DAWN
   *  (world.ts tickMeld). See SimBuff.meld. */
  meld?: boolean;
}

/** The art half of an applyBuff: spread into a SimBuffInit (`...fx(def)`).
 *
 *  A buff's persistent model lives on its BUFF row, not on the ability — most
 *  buff-applying abilities (Divine Shield, Slow, Bloodlust, Inner Fire…) have no
 *  TargetArt of their own at all, so reaching for `def.targetArt` here silently
 *  rendered nothing. `def.targetArt` is the one-shot CAST burst (Holy Light's
 *  flash) and belongs in emitEffect, not on a buff. Falls back to targetArt for
 *  the handful of custom abilities that do put their buff model there. */
export function fx(def: AbilityDef): { art: string; fx: BuffFx[] } {
  if (def.buffFx.length) return { art: def.buffArt, fx: def.buffFx };
  return { art: def.targetArt, fx: def.targetArt ? [{ path: def.targetArt, attach: [] }] : [] };
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
  artPerWave?: number; // how many copies of `art` to scatter across the area each wave (default 1).
  //                      WC3's Blizzard rains a handful of shards per wave, not a single one.
  waveSound?: boolean; // cue the art's folder WAV once per wave (Blizzard's shard fall).
  delay?: number; // seconds before the FIRST wave (default 0 = fire immediately). Lets a
  //                 field start after another (Flame Strike's subsiding burn follows the pillar).
  maxDamagePerWave?: number; // "Maximum Damage per Wave" (DataF): the total a single wave may
  //                            deal across everything it hits. Over that, the wave splits its
  //                            budget evenly — Blizzard's 30/wave hits 5 units for full, 10 for 15.
  buildingReduction?: number; // "Building Reduction" (DataD): fraction of the wave's damage a
  //                             BUILDING shrugs off (0.5 → structures take half).
  dot?: { dps: number; duration: number; heroDuration: number; group: string; art: string }; // per-wave
  //       burn left on everything the wave hits (Rain of Fire's "and N damage per second for 3 seconds").
  impactDelay?: number; // seconds between a wave's art SPAWNING and its damage landing. The shard
  //                       is a falling model, and WC3 hurts you when it hits the ground, not when
  //                       it appears in the sky. See SHARD_FALL.
}

/** Where a cast is aimed. */
export interface CastContext {
  targetId: number; // unit target (0 = none)
  x: number; // point target / caster position
  y: number;
}

type Handler = (api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, ctx: CastContext) => void;

/** Curated effect models for spell fields whose art isn't in the ability data.
 *  (Neither ability names one: MPQ HumanAbilityFunc [AHbz] / NeutralAbilityFunc
 *  [ANrf] both have an empty Casterart and no Target/Special art at all.) */
const FIELD_ART: Record<string, string> = {
  AHbz: "Abilities\\Spells\\Human\\Blizzard\\BlizzardTarget.mdx",
  ANrf: "Abilities\\Spells\\Demon\\RainOfFire\\RainOfFireTarget.mdx",
};

/** When a shard's damage lands, measured off the models themselves: in BOTH
 *  BlizzardTarget.mdx and RainOfFireTarget.mdx (the same rig, reskinned) the falling
 *  helper `Dummy01` drops from z=+161 to the ground over 33→833ms, and the impact
 *  burst emitters (BlizParticle01x, Rain of Fire's Sphere1x debris) switch their
 *  visibility on at exactly 800ms. The rest of the 3.3s "Birth" clip is the ice/fire
 *  lingering on the ground. So a wave hurts you 0.8s after it appears in the sky —
 *  you can walk out from under a Blizzard you see coming. */
const SHARD_FALL = 0.8;

// Flame Strike models, straight from the 1.27 MPQ (War3x, Abilities\Spells\Human\
// FlameStrike\). The ability's Specialart lists FlameStrike1,FlameStrike2,FlameStrike
// but our data keeps only the first (FlameStrike1); WC3 erupts the PLAIN FlameStrike
// pillar, whose "birth" clip burns for ~7.2s — the lingering fire. FlameStrikeEmbers
// (a ~0.7s flame burst) is dropped in a ring to paint the burning circle at ignition.
const FLAMESTRIKE_PILLAR = "Abilities\\Spells\\Human\\FlameStrike\\FlameStrike.mdx";
const FLAMESTRIKE_EMBERS = "Abilities\\Spells\\Human\\FlameStrike\\FlameStrikeEmbers.mdx";

/** Effect duration on a target: heroes resist longer effects (herodur). */
function dur(lvl: AbilityLevel, target: SimUnit): number {
  return target.isHero && lvl.heroDuration > 0 ? lvl.heroDuration : lvl.duration;
}
/** Read dataX (a=0..i=8); NaN-safe default. */
function d(lvl: AbilityLevel, i: number, def = 0): number {
  const v = lvl.data[i];
  return v === undefined || Number.isNaN(v) ? def : v;
}

/** Blizzard and Rain of Fire are the SAME engine ability with different numbers:
 *  MPQ Units\AbilityMetaData.slk gives their Data columns one shared row
 *  (`useSpecific=ahbz,acbz,anrf,acrf`), so both read
 *    DataA "Number of Waves"  DataB "Damage"  DataC "Number of Shards"
 *    DataD "Building Reduction"  DataE "Damage Per Second"  DataF "Maximum Damage per Wave".
 *  Neither the Duration column nor any Data column holds the gap between waves —
 *  it's fixed in the engine at one second (Liquipedia "Blizzard": "Wave Duration:
 *  1 second"), so Blizzard's 6 waves fill its 6s channel and cooldown exactly. */
export const WAVE_FIELDS = new Set(["AHbz", "ANrf"]);
const WAVE_INTERVAL = 1; // seconds between waves — engine constant, in no data file

/** Wave schedule for a repeating area field, shared by the spell handler (which
 *  registers the field) and `channelDuration` (which locks the caster for exactly as
 *  long as the waves run) so the two can never drift apart. Rain of Fire's Duration
 *  column is its BURN duration (3s), not its channel — the channel is waves × 1s,
 *  which is why both spells must come through here rather than read `duration`. */
export function waveSchedule(lvl: AbilityLevel): { waves: number; interval: number } {
  return { waves: d(lvl, 0, 6), interval: WAVE_INTERVAL };
}

/** Blizzard / Rain of Fire: register the repeating wave field both of them are.
 *  Every number comes from the shared data row (see WAVE_FIELDS); `defaultDamage`
 *  only covers a custom ability that left DataB blank. */
function waveField(api: SpellApi, caster: SimUnit, def: AbilityDef, rank: number, ctx: CastContext, defaultDamage: number): void {
  const lvl = def.levelData[rank - 1];
  const { waves, interval } = waveSchedule(lvl);
  const dps = d(lvl, 4, 0); // DataE — Rain of Fire burns, Blizzard's is 0
  api.addSpellField({
    code: def.code,
    x: ctx.x,
    y: ctx.y,
    area: lvl.area || 200,
    damagePerWave: d(lvl, 1, defaultDamage),
    waves,
    interval,
    casterId: caster.id,
    art: def.areaArt || def.targetArt || FIELD_ART[def.code] || "",
    artPerWave: Math.max(1, d(lvl, 2, 6)), // DataC "Number of Shards": 6/7/10 by rank
    waveSound: true,
    impactDelay: SHARD_FALL,
    buildingReduction: d(lvl, 3, 0), // DataD
    maxDamagePerWave: d(lvl, 5, 0), // DataF (0 = uncapped)
    dot: dps > 0 ? { dps, duration: lvl.duration || 3, heroDuration: lvl.heroDuration || lvl.duration || 3, group: def.code, art: def.buffArt } : undefined,
  });
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
function summonMany(api: SpellApi, caster: SimUnit, def: AbilityDef, unitId: string, x: number, y: number, count: number, durationSec: number, atPoint = false): void {
  if (!unitId) return;
  const art = summonArt(def);
  for (let i = 0; i < Math.max(1, count); i++) {
    const facing = caster.facing + (i - (count - 1) / 2) * 0.5;
    api.requestSummon(unitId, x, y, facing, caster.owner, caster.team, durationSec, caster.id, art, atPoint);
  }
}

/** The pair of effects a summoning ability gives its summons: the burst each unit
 *  materializes in, and the one that replaces it when it leaves.
 *
 *  Both come straight from the data, and neither is where you'd first look:
 *    [AOsf] Specialart = …\FeralSpirit\feralspirittarget.mdl   ← summon
 *    [BOsf] Effectart  = …\FeralSpirit\feralspiritdone.mdl     ← unsummon (on the BUFF)
 *  The Beastmaster's summons (ANsg/ANsq/ANsw) put their summon burst in `TargetArt`
 *  instead of `Specialart`, hence the fallback. Nothing here may default to Undead's
 *  `Unsummon\UnsummonTarget.mdl` — that is the acolyte's *Unsummon Building* art and has
 *  nothing to do with a summon expiring (it was hardcoded here, and looked very wrong on
 *  a wolf). A summon with no art in the data simply leaves without one. */
function summonArt(def: AbilityDef): { summon: string; unsummon: string } {
  return { summon: def.specialArt || def.targetArt, unsummon: def.buffEffectArt };
}

/** Summoned-unit ids for abilities whose unit isn't in the SLK `unitid` column
 *  (it lives in a data string we parse only as a number). Verified in the MPQ. */
const SUMMON_FALLBACK: Record<string, string> = {
  AUcb: "ucs1", // Carrion Beetles → Carrion Beetle (dataC string in the SLK)
  ANef: "npn1", // Storm, Earth & Fire → one of the split pandaren (npn1/2/3)
};

/** The spells whose legal targets are a POLARITY, not a flag list. `targs1` can say
 *  "organic, not self" but it has no way to say "a friendly living unit or an enemy
 *  Undead one" — so the engine hardcodes that rule and gives each of these its own
 *  error string in commandstrings.txt (Holybolttarget/Deathcoiltarget), which is how we
 *  know the rule is the ability's and not the data's. `healsUndead` says which side the
 *  Undead are on; the handlers below apply the same split to decide heal vs. damage.
 *  Verified in the 1.27 MPQ: AHhb targs1 = "air,ground,organic,notself,invu,vuln,
 *  nonancient" — no allegiance flag at all, so the flags alone would let a Paladin
 *  Holy Light an enemy Footman, which the real game refuses. */
export const POLARITY_SPELLS: Record<string, { healsUndead: boolean; error: string }> = {
  AHhb: { healsUndead: false, error: "Holybolttarget" }, // "Must target friendly living units or enemy Undead units."
  AUdc: { healsUndead: true, error: "Deathcoiltarget" }, // "Must target enemy living units or friendly Undead units."
};

/** Single-target heals that ALWAYS heal whatever they may legally touch. The polarity
 *  spells above heal too, but only their friendly half, so they're judged separately.
 *  A heal that would restore nothing is refused by WC3 rather than wasted (HPmaxed /
 *  UnitHPmaxed) — you cannot burn a Paladin's mana on an undamaged Footman. */
export const HEAL_SPELLS = new Set(["Ahea"]); // Priest — Heal

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
    api.applyBuff(t, { kind: "stun", timeLeft: dur(lvl, t), sourceId: caster.id, ...fx(def) });
  },

  // Thunder Clap — slam the ground: dataA damage + slow (move dataC, attack dataD)
  // to enemy ground units within `area`.
  AHtc: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    // The shockwave also scorches the ground under the caster: UberSplatData row THND
    // ("ThunderClap", ReplaceableTextures\Splats\ThunderClapUbersplat.blp).
    api.emitSplat("THND", caster.x, caster.y);
    for (const t of api.unitsInArea(ctx.x, ctx.y, lvl.area)) {
      if (t === caster || !api.hostile(caster, t) || t.flying) continue;
      api.spellDamage(t, d(lvl, 0), caster.id);
      // fx(def) → the slow buff BHtc's own Targetart, StasisTotemTarget.mdx worn
      // `overhead` (the amber swirl — the same rig as the blue stun one).
      api.applyBuff(t, { kind: "slow", timeLeft: dur(lvl, t), sourceId: caster.id, value: d(lvl, 2, 0.25), value2: d(lvl, 3, 0.25), ...fx(def) });
    }
  },

  // Divine Shield — self-invulnerability for the duration.
  AHds: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.applyBuff(caster, { kind: "invuln", timeLeft: lvl.duration || lvl.heroDuration, sourceId: caster.id, ...fx(def) });
  },

  // Avatar (MK ultimate) — become a giant: +armour, +damage, immune to stun/slow
  // (approximated via the invuln flag being magic-immunity here). Big and brief.
  AHav: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const t = lvl.duration || lvl.heroDuration || 30;
    api.applyBuff(caster, { kind: "armor", group: "avatar", timeLeft: t, sourceId: caster.id, value: d(lvl, 0, 5) < 1 ? 15 : d(lvl, 0), ...fx(def) });
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
    api.requestSummon(lvl.summon, caster.x, caster.y, caster.facing, caster.owner, caster.team, lvl.heroDuration || lvl.duration || 60, caster.id, summonArt(def));
  },

  // Blizzard — channelled: DataA waves of DataB damage in `area`, a second apart
  // (registered as a repeating field; see tickSpellFields / waveSchedule).
  //
  // Blizzard ships no effect-art field in the data — use the known shard model.
  // (It ships no SOUND field either: MPQ HumanAbilityFunc.txt [AHbz] has an EMPTY
  // Casterart and no Target/Special art at all, and BlizzardTarget.mdx carries no
  // SND event objects. So neither of our sound paths — ability-art folder scan,
  // model SND events — could find anything, and Blizzard played silent. Its WAVs
  // sit unclaimed in the ability's own folder next to the shard model:
  // BlizzardTarget1/2/3.wav (the 3s shard fall, one per wave) and BlizzardLoop1.wav
  // (the 4s wind bed, looped for the channel — started by the renderer off
  // activeSpellFields). `waveSound` cues the former from the art's folder.
  AHbz: (api, caster, def, rank, ctx) => waveField(api, caster, def, rank, ctx, 30),

  // Rain of Fire (Pit Lord) — Blizzard's twin (same engine ability, same six data
  // columns), but each wave also leaves a burn: DataE damage per second for the
  // ability's Duration (MPQ NeutralAbilityStrings [ANrf]: "Each wave deals <DataB>
  // initial damage and <DataE> damage per second for <Dur> seconds. Lasts for <DataA>
  // waves."). Blizzard's DataE is 0, so the same code path leaves no burn there.
  ANrf: (api, caster, def, rank, ctx) => waveField(api, caster, def, rank, ctx, 25),

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
    api.applyBuff(t, { kind: "armor", group: "innerfire", timeLeft: dur(lvl, t) || 30, sourceId: caster.id, value: d(lvl, 1, 5), ...fx(def) });
    api.applyBuff(t, { kind: "damage", group: "innerfire", timeLeft: dur(lvl, t) || 30, sourceId: caster.id, value: Math.max(1, Math.round((t.baseDamage || 10) * (d(lvl, 0, 0.1) || 0.1))) });
  },

  // Slow — cripple an enemy: slow its movement (dataA) and attack (dataB).
  Aslo: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "slow", group: "slow", timeLeft: dur(lvl, t) || 15, sourceId: caster.id, value: d(lvl, 0, 0.35), value2: d(lvl, 1, 0.35), ...fx(def) });
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

  // Bloodlust (Shaman) — buff a friendly unit: +attack speed (dataA) and +move
  // speed (dataB). haste buff: value = move fraction, value2 = attack fraction.
  Ablo: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "haste", group: "bloodlust", timeLeft: dur(lvl, t) || 60, sourceId: caster.id, value: d(lvl, 1, 0.25), value2: d(lvl, 0, 0.4), ...fx(def) });
  },

  // Purge (Shaman) — strip ALL buffs from the target; an enemy is then slowed to a
  // crawl for dataD seconds (movement only), and a summoned unit is destroyed outright.
  Aprg: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.dispel(t); // remove every timed buff (good AND bad)
    if (api.hostile(caster, t)) {
      if (t.summonLeft > 0) { api.spellDamage(t, 100000, caster.id); return; } // Purge destroys summons
      // dataD = slow duration; heavy MOVE slow that recovers when it expires (no attack slow).
      api.applyBuff(t, { kind: "slow", group: "purge", timeLeft: d(lvl, 3, 3), sourceId: caster.id, value: 0.75, value2: 0, ...fx(def) });
    }
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Ensnare (Raider) — bind an enemy to the ground: it cannot move (root pins movement
  // to 1.0) for the duration (hero units get the shorter herodur). It can still attack.
  Aens: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "root", group: "ensnare", timeLeft: dur(lvl, t) || 12, sourceId: caster.id, value: 1, ...fx(def) });
  },

  // Lightning Shield (Shaman) — a shield of electricity around the TARGET: the target is
  // unharmed, but every unit around it takes dataA dps (area = radius). Cast it on an enemy
  // (hurts them + their neighbours) or an expendable own unit. See tickLightningShields.
  Alsh: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "shield", group: "lightningshield", timeLeft: dur(lvl, t) || 20, sourceId: caster.id, value: d(lvl, 0, 20), value2: lvl.area || 160, ...fx(def) });
  },

  // Spirit Link (Spirit Walker) — link up to dataB friendly organic units within the area
  // into a group; dataA of any hit taken by a member is spread across the whole group. Sets
  // the shared link state on each member (world.spiritLinkSplit does the distribution).
  Aspl: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const cap = Math.max(2, Math.round(d(lvl, 1, 4)));
    const share = d(lvl, 0, 0.5);
    const anchor = api.getUnit(ctx.targetId) ?? caster;
    const group = api
      .unitsInArea(anchor.x, anchor.y, lvl.area || 500)
      .filter((t) => api.ally(caster, t) && !t.building && !t.isSummon)
      .slice(0, cap);
    if (group.length < 2) return;
    const ids = group.map((u) => u.id);
    for (const u of group) {
      api.linkSpirits(u, ids, dur(lvl, u) || 75, share);
      if (def.targetArt) api.emitEffect(def.targetArt, u.x, u.y, u.id);
    }
  },

  // Ancestral Spirit (Spirit Walker) — raise ONE fallen non-hero Tauren from its corpse at
  // the point, back at full strength (dataA = HP fraction restored ≈ 1).
  Aast: (api, caster, def, _rank, ctx) => {
    api.raiseNearbyCorpses(ctx.x, ctx.y, 250, caster.owner, caster.team, 1);
    if (def.targetArt) api.emitEffect(def.targetArt, ctx.x, ctx.y, 0);
  },

  // Corporeal/Ethereal Form (Spirit Walker) — a self toggle between its two forms (both carry
  // this one ability). morphUnit swaps the type (weapons + abilities), and the ethereal form
  // (no weapon) becomes immune to physical / unable to attack / +magic damage.
  Acpf: (api, caster) => api.toggleSpiritForm(caster),

  // === Creep & neutral casters ===
  //
  // Every Data index below is named by the game itself: AbilityMetaData.slk's `useSpecific`
  // rows point at WorldEditStrings.txt, which spells out what each column of each of these
  // abilities means ("WESTRING_AEVAL_CRI1 = Movement Speed Reduction (%)"). Nothing here is
  // inferred from watching the ability — see docs and the ability-data-column-names memory.

  // Roar — the caster bellows and every FRIENDLY unit within `area` hits harder for the
  // duration. dataA "Damage Increase (%)", dataB "Defense Increase", dataC "Life
  // Regeneration Rate". The stock Roar carries only dataA (0.25), so the armour and regen
  // halves are applied only when a row actually sets them — a custom map may.
  Aroa: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    if (def.casterArt) api.emitEffect(def.casterArt, caster.x, caster.y, caster.id);
    for (const t of alliesInArea(api, caster, caster.x, caster.y, lvl.area || 500, { self: true })) {
      const time = dur(lvl, t) || 45;
      api.applyBuff(t, { kind: "damagePct", group: "roar", timeLeft: time, sourceId: caster.id, value: d(lvl, 0, 0.25), ...fx(def) });
      const armor = d(lvl, 1, 0);
      if (armor) api.applyBuff(t, { kind: "armor", group: "roar", timeLeft: time, sourceId: caster.id, value: armor });
      const regen = d(lvl, 2, 0);
      if (regen) api.applyBuff(t, { kind: "hpRegen", group: "roar", timeLeft: time, sourceId: caster.id, value: regen });
    }
  },

  // Fire Bolt — the creeps' Storm Bolt: a missile that deals dataA "Damage" and stuns for
  // the row's duration. Same shape as AHtb, and like it the missile is the caller's
  // business (world.ts spawns it off def.missileArt) — the handler is the impact.
  ANfb: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.spellDamage(t, d(lvl, 0, 100), caster.id);
    api.applyBuff(t, { kind: "stun", group: "firebolt", timeLeft: dur(lvl, t) || 2, sourceId: caster.id, ...fx(def) });
  },

  // Finger of Death — one enormous hit, no stun and no duration. dataC is the "Damage"
  // (500); dataA and dataB are "Graphic Delay" and "Graphic Duration", i.e. presentation,
  // which is why the damage is NOT read from dataA the way most nukes are.
  ANfd: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    api.spellDamage(t, d(def.levelData[rank - 1], 2, 500), caster.id);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Heal (creep) — the neutral casters' version of the Priest's Heal, dataA "Hit Points
  // Gained". Shares Ahea's rules: allies only, and never a mechanical unit.
  Anhe: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t) || t.mechanical) return;
    api.spellHeal(t, d(def.levelData[rank - 1], 0, 15));
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Rejuvenation — dataA "Hit Points Gained" and dataB "Mana Points Gained", both restored
  // ACROSS the duration rather than at once (the Druid of the Claw's 400 over 12s). Same
  // total-over-duration shape as the regeneration items, and the mana half is likewise a
  // timed manaRegen bonus.
  Arej: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.ally(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    const time = dur(lvl, t) || 12;
    const hp = d(lvl, 0, 400);
    const mana = d(lvl, 1, 0);
    if (hp > 0) api.applyBuff(t, { kind: "hot", group: "rejuv", timeLeft: time, sourceId: caster.id, value: hp / time, ...fx(def) });
    if (mana > 0) api.applyBuff(t, { kind: "manaRegen", group: "rejuv", timeLeft: time, sourceId: caster.id, value: mana / time });
  },

  // Cripple — dataA "Movement Speed Reduction (%)", dataB "Attack Speed Reduction (%)",
  // dataC "Damage Reduction". The third is what separates it from a plain Slow: the target
  // also hits for less, so it rides a NEGATIVE damagePct buff.
  Acri: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    const time = dur(lvl, t) || 60;
    api.applyBuff(t, { kind: "slow", group: "cripple", timeLeft: time, sourceId: caster.id, value: d(lvl, 0, 0.75), value2: d(lvl, 1, 0.5), ...fx(def) });
    const cut = d(lvl, 2, 0.5);
    if (cut) api.applyBuff(t, { kind: "damagePct", group: "cripple", timeLeft: time, sourceId: caster.id, value: -cut });
  },

  // Faerie Fire — dataA "Defense Reduction" (4), as a negative armour buff. (Its other
  // column, dataB, is "Always Autocast" — a flag about the button, not an effect.)
  Afae: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t)) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "armor", group: "faeriefire", timeLeft: dur(lvl, t) || 90, sourceId: caster.id, value: -d(lvl, 0, 4), ...fx(def) });
  },

  // Unholy Frenzy — dataA "Attack Speed Bonus (%)" and dataB "Damage per Second", the
  // bargain the spell IS: the target swings faster and bleeds for it. Cast on allies in
  // WC3 (a Necromancer frenzies his own front line), so allegiance is not restricted here.
  Auhf: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const time = dur(lvl, t) || 45;
    api.applyBuff(t, { kind: "haste", group: "unholyfrenzy", timeLeft: time, sourceId: caster.id, value: 0, value2: d(lvl, 0, 0.75), ...fx(def) });
    api.applyBuff(t, { kind: "dot", group: "unholyfrenzy", timeLeft: time, sourceId: caster.id, value: d(lvl, 1, 4) });
  },

  // Abolish Magic (Dryad) — Dispel Magic aimed at ONE unit instead of an area: strip its
  // timed buffs, and a summon takes dataB "Summoned Unit Damage" (300), which is enough to
  // end most of them. dataA is "Mana Loss", 0 on every stock row but honoured if a map sets
  // it. Its allegiance is deliberately unrestricted — the same cast cleanses a poisoned
  // ally and strips an enemy's Bloodlust, which is exactly why `targs1` names neither
  // `friend` nor `enemy`.
  // Cannibalize (Ghoul) — eat a nearby corpse and regenerate off it. dataA is "Hit Points
  // per Second" (10) across the row's duration (33s), so a body is worth 330 hit points if
  // the meal is not interrupted.
  //
  // dataB is "Max Hit Points" (800) and is deliberately unused: at the stock rate and
  // duration the total is 330, so the cap cannot bind, and inventing a meaning for a number
  // that never takes effect would be guessing. A custom map that raises the rate would need
  // it, and that is the point at which to work out what it actually caps.
  //
  // No corpse, no ability — the cast simply does nothing rather than granting the buff,
  // which is why this reads the corpse first.
  Acan: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const reach = lvl.castRange || 50;
    if (!api.consumeCorpse(ctx.x || caster.x, ctx.y || caster.y, reach)) return;
    api.applyBuff(caster, {
      kind: "hot", group: "cannibalize", timeLeft: dur(lvl, caster) || 33,
      sourceId: caster.id, value: d(lvl, 0, 10), ...fx(def),
    });
  },

  Aadm: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.dispel(t);
    if (t.summonLeft > 0) api.spellDamage(t, d(lvl, 1, 300), caster.id);
    const manaLoss = d(lvl, 0, 0);
    if (manaLoss > 0) t.mana = Math.max(0, t.mana - manaLoss);
    if (def.targetArt) api.emitEffect(def.targetArt, t.x, t.y, t.id);
  },

  // Kaboom! (Goblin Sapper) — he walks up to the target and detonates himself. The blast is
  // two concentric rings, and the columns say so: dataA "Full Damage Radius" (100) and dataB
  // "Full Damage Amount" (250), then dataC "Partial Damage Radius" (250) and dataD "Partial
  // Damage Amount" (100). Those four are shared with the other death-blast abilities
  // (AbilityMetaData rows Dda1..Dda4, useSpecific = Adda,Amnx,Amnz,Asds,Auco).
  //
  // Everything in range is hit, friend and foe alike: `targs1` is `ground,structure,debris,
  // tree,ward` with no allegiance flag at all, and a sapper pack really does kill its own
  // escort if it detonates among them.
  //
  // NOT applied: the extra damage a sapper is famous for doing to BUILDINGS. dataE is
  // "Building Damage Factor" (AbilityMetaData Sds1, data=5) and its value is 100, while
  // Liquipedia states the ability does "3 times as much damage against buildings". 100 is
  // neither 3 nor a percentage that yields 3, so the two sources do not reconcile and
  // neither reading can be called verified. Rather than invent a multiplier, the blast lands
  // as written and this is left for a measurement against the real client (see the
  // wc3-ground-truth memory) — the one source that can settle it.
  Asds: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const t = api.getUnit(ctx.targetId);
    const cx = t ? t.x : ctx.x;
    const cy = t ? t.y : ctx.y;
    const fullR = d(lvl, 0, 100);
    const full = d(lvl, 1, 250);
    const partR = d(lvl, 2, 250);
    const part = d(lvl, 3, 100);
    for (const e of api.unitsInArea(cx, cy, Math.max(fullR, partR))) {
      if (e === caster) continue; // he dies below, not to his own blast
      const amount = Math.hypot(e.x - cx, e.y - cy) <= fullR ? full : part;
      if (amount > 0) api.spellDamage(e, amount, caster.id);
    }
    if (def.specialArt) api.emitEffect(def.specialArt, cx, cy, 0);
    else if (def.targetArt) api.emitEffect(def.targetArt, cx, cy, 0);
    api.killUnit(caster);
  },

  // Devour (Kodo Beast) — swallow an enemy land non-hero unit whole; it's digested inside
  // (tickDevour) and freed if the Kodo is slain first.
  Adev: (api, caster, def, _rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || !api.hostile(caster, t) || t.building || t.isHero) return;
    api.devour(caster, t);
    if (def.targetArt) api.emitEffect(def.targetArt, caster.x, caster.y, caster.id);
  },

  // Unstable Concoction (Batrider) — the rider blows himself up: dataB damage to the target
  // air unit and dataD to other enemy air units within dataC, then the caster dies.
  Auco: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const t = api.getUnit(ctx.targetId);
    const cx = t ? t.x : ctx.x;
    const cy = t ? t.y : ctx.y;
    if (t && api.hostile(caster, t)) api.spellDamage(t, d(lvl, 1, 600), caster.id); // dataB — direct hit
    const splash = d(lvl, 3, 140); // dataD — nearby air
    const radius = d(lvl, 2, 200) || 200; // dataC — blast radius
    for (const e of api.unitsInArea(cx, cy, radius)) {
      if (e === t || e === caster || !e.flying || !api.hostile(caster, e)) continue;
      api.spellDamage(e, splash, caster.id);
    }
    if (def.specialArt) api.emitEffect(def.specialArt, cx, cy, 0);
    api.killUnit(caster); // the Batrider explodes
  },

  // Witch Doctor wards — each summons an immobile ward at the point (unitid1). Sentry
  // gives vision for free (an owned unit reveals fog); the Healing Ward's heal and the
  // Stasis Trap's proximity stun run in world.tickWards, keyed off the ward's own data.
  Aeye: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  Ahwd: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),
  Asta: (api, caster, def, rank, ctx) => summonSpell(api, caster, def, rank, { count: 1, atPoint: true }, ctx),

  // Berserk (Troll Berserker) — self only: attack dataB% faster (haste) but take dataC%
  // more damage (vuln) for the duration. dataA rides the haste's move-speed slot.
  Absk: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const t = dur(lvl, caster) || 12;
    api.applyBuff(caster, { kind: "haste", group: "berserk", timeLeft: t, sourceId: caster.id, value: d(lvl, 0, 0), value2: d(lvl, 1, 0.5), ...fx(def) });
    api.applyBuff(caster, { kind: "vuln", group: "berserk", timeLeft: t, sourceId: caster.id, value: d(lvl, 2, 0.5) });
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
      api.applyBuff(t, { kind: "stun", timeLeft: dur(lvl, t) || 1, sourceId: caster.id, ...fx(def) });
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
      // fx(def) → the shared stun buff BPSE's Targetart (ThunderclapTarget.mdx, `overhead`) —
      // the swirl every stunned unit wears. Without it War Stomp stunned in silence.
      api.applyBuff(t, { kind: "stun", timeLeft: dur(lvl, t) || 2, sourceId: caster.id, ...fx(def) });
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
      if (!t.mechanical) api.applyBuff(t, { kind: "hot", group: "tranquility", timeLeft: lvl.duration || 30, sourceId: caster.id, value: d(lvl, 0, 20), ...fx(def) });
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
    api.applyBuff(t, { kind: "root", group: "roots", timeLeft: d0, sourceId: caster.id, value: 1, ...fx(def) });
    api.applyBuff(t, { kind: "dot", group: "roots", timeLeft: d0, sourceId: caster.id, value: d(lvl, 0, 15) });
  },

  // Sleep (Dreadlord) — put a target to sleep (disabled until it takes damage).
  AUsl: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t || t.building) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "sleep", group: "sleep", timeLeft: dur(lvl, t) || 5, sourceId: caster.id, ...fx(def) });
  },

  // Hex (Shadow Hunter) — transform a target into a critter: disabled (can't
  // attack or cast) for the duration; modelled as a stun.
  AOhx: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "stun", group: "hex", timeLeft: dur(lvl, t) || 4, sourceId: caster.id, ...fx(def) });
  },

  // Banish (Blood Mage) — turn a target ETHEREAL for the duration (issue #49). While
  // ethereal the unit can't attack and takes NO physical damage, but takes +66% from
  // Magic/Spells (EtherealDamageBonus) — so Banish pulls a unit out of the melee and
  // hands it to your casters. It also slows movement by DataA ("Movement Speed
  // Reduction (%)"; DataB is the now-moot attack-speed cut). The banished unit wears
  // the ethereal BanishTarget glow the whole time — that model is the buff's own
  // TargetArt (def.buffArt), not the ability's (which is empty), so the renderer keeps
  // it attached while the buff lasts.
  AHbn: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "ethereal", group: "banish", timeLeft: dur(lvl, t) || 12, sourceId: caster.id, value: d(lvl, 0, 0.5), ...fx(def) });
  },

  // Doom (Pit Lord, ult) — a heavy damage-over-time curse (dataA/sec).
  ANdo: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    api.applyBuff(t, { kind: "dot", group: "doom", timeLeft: 40, sourceId: caster.id, value: d(lvl, 0, 40), ...fx(def) });
  },

  // Soul Burn (Firelord) — a damage-over-time burn that also silences the target.
  ANso: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    const d0 = dur(lvl, t) || 6;
    api.applyBuff(t, { kind: "dot", group: "soulburn", timeLeft: d0, sourceId: caster.id, value: d(lvl, 0, 7), ...fx(def) });
    api.applyBuff(t, { kind: "silence", group: "soulburn", timeLeft: d0, sourceId: caster.id });
  },

  // Acid Bomb (Alchemist) — splash: reduce armour (negative armour buff, dataD)
  // and apply a corrosive damage-over-time (dataE) to the target and nearby units.
  ANab: (api, caster, def, rank, ctx) => {
    const t = api.getUnit(ctx.targetId);
    if (!t) return;
    const lvl = def.levelData[rank - 1];
    for (const o of enemiesInArea(api, caster, t.x, t.y, lvl.area || 200)) {
      api.applyBuff(o, { kind: "armor", group: "acid", timeLeft: lvl.duration || 15, sourceId: caster.id, value: -d(lvl, 3, 5), ...fx(def) });
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
    api.applyBuff(t, { kind: "dot", group: "shadowstrike", timeLeft: d0, sourceId: caster.id, value: d(lvl, 0, 10), ...fx(def) });
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
      api.applyBuff(t, { kind: "slow", group: "haze", timeLeft: dur(lvl, t) || 10, sourceId: caster.id, value: 0.25, value2: 0.25, ...fx(def) });
    }
  },

  // Silence (Dark Ranger) — enemies in the area can't cast for the duration.
  ANsi: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    if (def.areaArt) api.emitEffect(def.areaArt, ctx.x, ctx.y, 0);
    for (const t of enemiesInArea(api, caster, ctx.x, ctx.y, lvl.area || 300, true)) {
      api.applyBuff(t, { kind: "silence", group: "silence", timeLeft: lvl.duration || 8, sourceId: caster.id, ...fx(def) });
    }
  },

  // --- point-AoE fields (Blizzard-style repeating waves) ---
  // (Blizzard AHbz and Rain of Fire ANrf both live up with the Archmage's spells.)

  // Flame Strike (Blood Mage) — reached only when the 1.33s cast wind-up FINISHES
  // (MPQ AHfs Cast=1.33). The wind-up drops the FlameStrikeTarget "beware" vortex and
  // spends the mana up front (in tickCast, PRECAST_WARNING), so moving the Blood Mage
  // before ignition aborts here and leaves just the gong + vortex and a wasted cast —
  // matching WC3 (Liquipedia: Blood Mage). At ignition the plain FlameStrike pillar
  // erupts ONCE (its ~7.2s "birth" clip is the lingering fire), then FlameStrikeEmbers
  // paint the burning circle: 9 in a ring around the area + 1 at the centre.
  //
  // Damage is TWO phases, straight from the MPQ AHfs fields (verified 2026-07 against the
  // 1.27 SLK + ubertip): the ubertip reads "burns ground units for N damage a second for
  // 3 seconds. As the pillar of flame subsides, units within the fire continue to take
  // minor damage." So the pillar deals "Full Damage Dealt" (dataA) every "Full Damage
  // Interval" (dataB, 0.33s) — L1 15/0.33s ≈ 45 dps, matching the tooltip's 45/80/110 —
  // for the FIRST THIRD of the duration (Dur=9 → 3s), then the subsiding "Half Damage
  // Dealt" (dataC) every "Half Damage Interval" (dataD, 1s) for the remaining two-thirds.
  // The old code spread dataA over the whole 9s as 1s waves (15 dps for 9s), so the burn
  // did far too little per second and lasted three times too long. Heroes take the shorter
  // herodur (2.67s) throughout. Damage begins the instant this handler runs — i.e. when the
  // cast-point wind-up ends — since a field's first wave fires on its next tick (delay 0).
  AHfs: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    const area = lvl.area || 200;
    // Eruption pillar: hold it ~7.2s so the whole "birth" fire plays out, not just 2s.
    api.emitEffect(FLAMESTRIKE_PILLAR, ctx.x, ctx.y, 0, 7.2);
    // Ring of embers marking the burning circle (see reference: a solid ring of flame
    // blobs with one in the middle). A ring a little inside `area` reads as a cohesive
    // ring rather than sparse dots on the rim.
    const ringR = area * 0.62;
    api.emitEffect(FLAMESTRIKE_EMBERS, ctx.x, ctx.y, 0); // centre
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2;
      api.emitEffect(FLAMESTRIKE_EMBERS, ctx.x + Math.cos(ang) * ringR, ctx.y + Math.sin(ang) * ringR, 0);
    }
    const total = caster.isHero && lvl.heroDuration > 0 ? lvl.heroDuration : lvl.duration || 9;
    const fullDur = total / 3; // the "3 seconds" full-damage pillar (Dur=9 → 3s)
    const fullInt = d(lvl, 1, 0.33) || 0.33; // Full Damage Interval
    const halfInt = d(lvl, 3, 1) || 1; // Half Damage Interval
    // Full-damage pillar: dataA every dataB, over the first third of the duration.
    api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area, damagePerWave: d(lvl, 0, 15), waves: Math.max(1, Math.round(fullDur / fullInt)), interval: fullInt, casterId: caster.id, art: "" });
    // Subsiding "minor damage": dataC every dataD, for the remaining two-thirds — begins
    // once the pillar fades (delay = fullDur) so the two phases don't overlap.
    const halfDmg = d(lvl, 2, 0);
    const halfWaves = Math.max(0, Math.round((total - fullDur) / halfInt));
    if (halfDmg > 0 && halfWaves > 0) {
      api.addSpellField({ code: def.code, x: ctx.x, y: ctx.y, area, damagePerWave: halfDmg, waves: halfWaves, interval: halfInt, delay: fullDur, casterId: caster.id, art: "" });
    }
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

  // Wind Walk (Blademaster) — vanish after a beat, move faster, and hit the next thing you
  // touch harder. AbilityData.slk AOwk, whose Data columns AbilityMetaData names Owk1/2/3:
  //   DataA "Transition Time"            0.6      — the pause before he actually fades out
  //   DataB "Movement Speed Increase (%)" 0.1/0.4/0.7
  //   DataC "Backstab Damage"             40/70/100
  // The backstab is NOT a standing damage bonus (it used to be modelled as one, which paid
  // out on every swing for the whole 20-50s). Liquipedia: "when the Blademaster attacks a
  // unit to break invisibility, he will deal bonus damage" — it is one blow's worth, so it
  // rides on the invisible buff and world.ts breakInvisibility() hands it to that swing.
  // Both buffs share the "windwalk" group, which is what makes the break end the speed too.
  AOwk: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    const d0 = lvl.duration || 20;
    const transition = d(lvl, 0, 0.6);
    api.applyBuff(caster, { kind: "haste", group: "windwalk", timeLeft: d0, sourceId: caster.id, value: d(lvl, 1, 0.5), value2: 0, ...fx(def) });
    api.applyBuff(caster, { kind: "invisible", group: "windwalk", timeLeft: d0, sourceId: caster.id, value: d(lvl, 2, 40), delay: transition });
  },

  // Root / Unroot (`Aroo`, aliases Aro1/Aro2) — an Ancient pulling itself out of the ground,
  // or planting again. One ability, two directions (`Order=root` / `Unorder=unroot`), so it
  // toggles; the command card shows one button that swaps its label with the state.
  //
  // Everything the two states differ by is DERIVED in recomputeStats — the walk speed and the
  // live weapon slot both fall out of `uprooted` — so the handler only has to ask the sim to
  // make the physical transition (free or claim the Ancient's cells). See toggleRoot.
  //
  // Unspent: DataD "Uprooted Defense Type" = 2. It is an INDEX into the game's own defense
  // type ordering, and our ArmorType is a string enum with no such index, so mapping it means
  // establishing what 2 means rather than assuming it lands on Medium because that is the
  // answer I expect. A rooted Ancient is `fort` in UnitBalance and stays `fort` uprooted until
  // that is settled — see CLAUDE.md on not inventing a number.
  Aroo: (api, caster) => { api.toggleRoot(caster); },

  // Shadow Meld (`Ashm`) — the night elf racial: an Archer standing still in the dark simply
  // isn't there. Every night elf ground unit has it, which is what a night elf army does when
  // it wants the map to stop knowing where it is.
  //
  // It is the one invisibility that is a STANCE, not a spell, and that shapes the whole
  // implementation. There is no duration column at all: it holds for as long as its
  // conditions hold. So the buff goes on with timeLeft Infinity and world.ts tickMeld takes
  // it off again when the unit moves or the sun comes up (`meld: true` marks it) — the other
  // breaks (attack, cast) come free through the shared breakInvisibility path.
  //
  // AbilityData.slk Ashm, Data columns named by AbilityMetaData Shm1/2/3 through
  // WorldEditStrings:
  //   DataA "Fade Duration"      1.5   (Sshm, the instant variant, 0.1)
  //   DataB "Day/Night Duration" 2.5
  //   DataC "Action Duration"    0.5
  // Only DataA is spent, as the buff's `delay` — Liquipedia names the 1.5s fade outright and
  // the number agrees. DataB and DataC have names but no source that says what they MEASURE,
  // so they stay unspent rather than guessed at (see tickMeld, and CLAUDE.md's "do not invent
  // a number"). Both want a measurement against the real client.
  //
  // Casting is refused by day. That is not decoration: without it the unit would meld, pay
  // the fade, and be stripped by tickMeld on the very next tick.
  Ashm: (api, caster, def, rank) => {
    if (api.isDay()) return; // night ability — the button is dead in daylight
    const lvl = def.levelData[rank - 1];
    // Hold position and hold fire. WC3 melds the unit INTO this stance, and it is the reason
    // a melded unit stays melded: left on its own orders it would walk or shoot itself out of
    // hiding within seconds.
    api.holdPosition(caster);
    api.applyBuff(caster, {
      kind: "invisible",
      group: "shadowmeld",
      timeLeft: Infinity, // no duration column — the conditions are the duration
      sourceId: caster.id,
      value: 0, // no Backstab Damage: that is Wind Walk's DataC, and Ashm has no equivalent
      delay: d(lvl, 0, 1.5), // "Fade Duration"
      meld: true,
      ...fx(def),
    });
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
    api.applyBuff(t, { kind: "armor", group: "frostarmor", timeLeft: lvl.duration || 60, sourceId: caster.id, value: d(lvl, 1, 3), ...fx(def) });
  },

  // Far Sight (Far Seer) — reveal an area of the map. We have no fog of war yet, so
  // this only plays its effect; it exists so the Far Seer can learn all 4 skills.
  AOfs: (api, _caster, def, _rank, ctx) => {
    if (def.areaArt || def.targetArt) api.emitEffect(def.areaArt || def.targetArt, ctx.x, ctx.y, 0);
  },

  // Mana Shield (Naga) — absorb incoming damage into mana (dataA mana per hp).
  ANms: (api, caster, def, rank) => {
    const lvl = def.levelData[rank - 1];
    api.applyBuff(caster, { kind: "manaShield", group: "manashield", timeLeft: 3600, sourceId: caster.id, value: d(lvl, 0, 1) || 1, ...fx(def) });
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
      api.applyBuff(t, { kind: "invuln", group: "voodoo", timeLeft: lvl.duration || 30, sourceId: caster.id, ...fx(def) });
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
    api.applyBuff(t, { kind: "dot", group: "drain", timeLeft: d0, sourceId: caster.id, value: rate, ...fx(def) });
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

  // Feral Spirit (Far Seer) — dismiss the caster's existing wolves (with an unsummon poof),
  // then raise a fresh pack of dataB (2) Spirit Wolves beside him. count:0 → summonSpell reads
  // the count from the ability's dataB.
  AOsf: (api, caster, def, rank) => {
    const wolfTypes = def.levelData.map((l) => l.summon).filter(Boolean);
    api.dismissSummons(caster.owner, wolfTypes);
    summonSpell(api, caster, def, rank, { count: 0, atPoint: false });
  },
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
  // Mirror Image (Blademaster) — the whole ability is a staged shuffle (the caster
  // vanishes, MirrorImageCaster plays, missiles fly out, and images land alongside the
  // real hero on random tiles), so it runs as its own sequence in the world rather than
  // as a plain summon. See startMirrorImage.
  //
  // It was summonMany'd off `d(lvl, 1, …)` — DataB — which AbilityMetaData names "Damage
  // Dealt (%)" and the data sets to 0. `Math.max(1, 0)` meant exactly one image at every
  // rank, for an ability whose entire tooltip is about the count going 1 → 2 → 3. The
  // count is DataA, "Number of Images".
  AOmi: (api, caster, def, rank) => api.mirrorImage(caster, def, rank),

  // Inferno (Dreadlord, ult) — an infernal crashes down at the point, dealing
  // dataA impact damage to enemies in `area`, then fights for the duration.
  AUin: (api, caster, def, rank, ctx) => {
    const lvl = def.levelData[rank - 1];
    for (const t of enemiesInArea(api, caster, ctx.x, ctx.y, lvl.area || 250, true)) api.spellDamage(t, d(lvl, 0, 50), caster.id);
    if (lvl.summon) api.requestSummon(lvl.summon, ctx.x, ctx.y, caster.facing, caster.owner, caster.team, lvl.heroDuration || lvl.duration || 180, caster.id, { summon: "", unsummon: def.buffEffectArt }, true);
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
  api.applyBuff(caster, { kind: "armor", group: "transform", timeLeft: t, sourceId: caster.id, value: armor, ...fx(def) });
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
  // The summon burst rides each unit (requestSummon's `art.summon`), fired where it
  // actually materializes. It used to be emitted once, here, at the CASTER's feet — so
  // three wolves fanned out around the Far Seer shared a single puff behind them.
  summonMany(api, caster, def, unitId, x, y, count, lvl.heroDuration || lvl.duration || 60, opts.atPoint);
}

/** One stat effect an aura grants to a unit in range. */
export interface AuraEffect {
  kind: BuffKind;
  value: number;
  value2?: number;
  rangedOnly?: boolean; // only benefits units with a ranged weapon (Trueshot)
  meleeOnly?: boolean; // only benefits melee units (Vampiric)
  /** Seconds the buff LINGERS once applied, for auras whose effect outlives the radius.
   *  Omitted for an ordinary aura, which re-applies on a short TTL and therefore fades the
   *  moment its holder walks out (see AURA_REFRESH). Disease Cloud is the exception the
   *  field exists for: catching the plague is not "standing in the cloud", and its own
   *  column says so — dataA is named "Aura Duration" and reads 120 seconds. */
  duration?: number;
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
  Aakb: (lvl) => [{ kind: "damagePct", value: d(lvl, 0, 0.1) }], // War Drums (Kodo) — +attack damage
  // Disease Cloud (Abomination) — the one HOSTILE aura here. Its targs1 is
  // `ground,enemy,organic,neutral`, so unlike every entry above it lands on enemies, and
  // the world picks the side off those flags rather than a rule in the code. dataB is
  // "Damage per Second" (1) and dataA "Aura Duration" (120), the latter being why the
  // plague follows a unit that walks out of the cloud instead of ending at its edge.
  Aapl: (lvl) => [{ kind: "dot", value: d(lvl, 1, 1), duration: d(lvl, 0, 120) }],
};
