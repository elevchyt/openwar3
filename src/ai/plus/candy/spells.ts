import type { AbilityDef } from "../../../data/abilities";
import type { SimAbility, SimUnit } from "../../../sim/world";
import type { HeroClass } from "./map";
import type { CandyProfile } from "./profile";

// Computer+ on Extreme Candy War — how each CLASS fights with its spells.
//
// Every ability id below is the map's own (war3map.w3a, each hero's `uhab` and innates), and what
// each one DOES is read off the map's triggers where the triggers decide it — `Warrior_Charge_*`,
// `Mage_Frost_Nova`, `Rogue_Sinister_Strike` / `Rogue_Evisercate`, `Warlock_Immolate`,
// `Warlock_Hellfire`, `Paladin_Lay_on_Hands` — because the map rebuilt most of its spells on
// unrelated bases (Fireball is Firebolt, Eviscerate is Finger of Death, Frost Nova is Roar with a
// trigger that roots). A table keyed on base codes would read those as the wrong spells, so this one
// is keyed on the map's ids and the numbers come from `AbilityDef` at the moment of the cast.
//
// What is OURS is the judgement: when a spell is worth its mana, and on whom. And that is where the
// difficulties differ (plus/candy/profile.ts):
//
//  · EASY presses what is ready on whatever it is fighting, a second and a half into the fight, and
//    misclicks a third of the time. No combos, no holding anything back.
//  · NORMAL combos — a disable first, the burst into it — interrupts a channel it sees, heals its
//    team, and keeps its mana for heroes.
//  · INSANE does all that at once and also HOLDS its finishers for the kill (`holdNuke`): an
//    Eviscerate waits for three combo points or a target it kills, a Mortal Blow for a target under
//    its damage, rather than both being spent at full health.
//
// Every cast leaves through `SpellCtx.castUnit/castPoint/castSelf`, which asks `SimWorld.castError`
// first and then `execute`s — the same judgement a person's click gets. Nothing here can cast what
// a player could not.

export interface SpellCtx {
  readonly hero: SimUnit;
  readonly cls: HeroClass;
  readonly profile: CandyProfile;
  /** Enemy heroes this hero can SEE within 1400, alive and targetable. */
  readonly foeHeroes: readonly SimUnit[];
  /** Enemy non-heroes it can see within 1000 — creeps, summons. */
  readonly foeUnits: readonly SimUnit[];
  /** Allied heroes within 1400 — this one included. */
  readonly allyHeroes: readonly SimUnit[];
  /** The enemy hero it is fighting, or null. */
  readonly target: SimUnit | null;
  /** Is it leaving the fight? */
  readonly fleeing: boolean;
  /** How long this enemy hero has been in reach of it — what `castDelay` is measured against. */
  seenFor(u: SimUnit): number;
  /** Seconds since this hero last pressed `id` (Infinity if never). */
  sinceCast(id: string): number;
  /** The ability, if learned, off cooldown and affordable. */
  ready(id: string): { ab: SimAbility; def: AbilityDef; rank: number } | null;
  castUnit(id: string, t: SimUnit): boolean;
  castPoint(id: string, x: number, y: number): boolean;
  castSelf(id: string): boolean;
  /** 0..1 off the AI's own seeded stream. */
  roll(): number;
  /** How many of this player's units of a type are alive (a summon already out). */
  ownCount(typeId: string): number;
  /** Is an enemy tower's reach over this spot? */
  underTower(x: number, y: number, slack?: number): boolean;
}

// --- reading a unit ----------------------------------------------------------------------------

const pct = (u: SimUnit): number => (u.maxHp > 0 ? u.hp / u.maxHp : 0);
const dist = (a: SimUnit, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
/** Hull to hull, which is how a cast range and an attack range are both measured. */
const edge = (a: SimUnit, b: SimUnit): number => Math.max(0, dist(a, b) - a.radius - b.radius);
const hasBuff = (u: SimUnit, ids: readonly string[]): boolean => u.buffs.some((b) => ids.includes(b.buffId));

/** Is it holding a channel (Drain Life, Hellfire, Blizzard, Tranquility)? A disable breaks one. */
export function channeling(u: SimUnit): boolean {
  const p = u.pendingCast;
  return u.order === "cast" && !!p && p.fired && p.channelLeft > 0;
}

/** Rooted or stunned — somebody who cannot walk out of what lands next. */
function pinned(u: SimUnit): boolean {
  return u.stunned || hasBuff(u, ["Beng", "Bena", "BEer"]);
}

/** Walking away from `from` — its last step took it further off. */
function leaving(from: SimUnit, u: SimUnit): boolean {
  return Math.hypot(u.x - from.x, u.y - from.y) > Math.hypot(u.prevX - from.x, u.prevY - from.y) + 1;
}

function nearest(units: readonly SimUnit[], to: SimUnit, within: number): SimUnit | null {
  let best: SimUnit | null = null;
  let bestD = within;
  for (const u of units) {
    const d = edge(to, u);
    if (d <= bestD) { bestD = d; best = u; }
  }
  return best;
}

/** The ally (itself included) in most need under `below` life within `within`. */
function neediest(units: readonly SimUnit[], from: SimUnit, within: number, below: number): SimUnit | null {
  let best: SimUnit | null = null;
  for (const u of units) {
    if (pct(u) >= below || edge(from, u) > within) continue;
    if (!best || pct(u) < pct(best)) best = u;
  }
  return best;
}

/** The centre of the densest knot of `min` or more units within `radius` of one of them, or null. */
function cluster(units: readonly SimUnit[], radius: number, min: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let most = min - 1;
  for (const u of units) {
    const near = units.filter((v) => dist(u, v) <= radius);
    if (near.length <= most) continue;
    most = near.length;
    best = { x: near.reduce((s, v) => s + v.x, 0) / near.length, y: near.reduce((s, v) => s + v.y, 0) / near.length };
  }
  return best;
}

/** How far an ability reaches at its current rank (`Rng`), 0 for a self cast. */
function reach(c: SpellCtx, id: string): number {
  const ab = c.hero.abilities.find((a) => a.id === id && a.level >= 1);
  const def = ab ? c.ready(id)?.def : undefined;
  return def && ab ? (def.levelData[Math.min(ab.level, def.levelData.length) - 1]?.castRange ?? 0) : 0;
}

/** Within this ability's reach of `t` (with a little slack for a unit already walking in). */
function inReach(c: SpellCtx, id: string, t: SimUnit, slack = 40): boolean {
  return edge(c.hero, t) <= reach(c, id) + slack;
}

/** Has this enemy hero been in reach long enough for this player to have NOTICED it? */
function noticed(c: SpellCtx, t: SimUnit): boolean {
  return c.seenFor(t) >= c.profile.castDelay;
}

/**
 * The target a spell actually goes on — `t`, unless this is one of this player's misclicks
 * (`castMistake`), in which case it is some OTHER enemy hero the spell could reach.
 */
function aim(c: SpellCtx, id: string, t: SimUnit): SimUnit {
  if (c.profile.castMistake <= 0 || c.roll() >= c.profile.castMistake) return t;
  const others = c.foeHeroes.filter((f) => f !== t && inReach(c, id, f));
  return others.length ? others[Math.floor(c.roll() * others.length)] : t;
}

/** May it spend mana on CREEPS right now? A player who knows better keeps it for the heroes. */
function mayFarm(c: SpellCtx): boolean {
  return c.foeHeroes.length === 0 && (!c.profile.saveMana || c.hero.mana >= c.hero.maxMana * 0.8);
}

const rankOf = (c: SpellCtx, id: string): number => c.hero.abilities.find((a) => a.id === id)?.level ?? 0;

// --- the classes -------------------------------------------------------------------------------

/**
 * WARRIOR (`Nklj`/`Hart`) — rage, not mana: +8 per swing (`Warrior_Rage_Cap`), draining away
 * between fights (`ACba`), topped up by the innate `A00X` Rage Potion.
 *
 * Charge (`ACfb`) is the opener and the gap-closer: past 200 it stuns and puts the Warrior beside
 * the target (`Warrior_Charge_Teleport`), so it is pressed from 200-450 and never from melee.
 * Mortal Blow (`AIfz`) is 5×STR — a finisher, held for one when the player is good enough to.
 */
function warrior(c: SpellCtx): boolean {
  const h = c.hero;
  const t = c.target;
  if ((t || c.fleeing) && h.mana < 30 && c.ready("A00X") && c.castSelf("A00X")) return true;
  if (c.fleeing) {
    const chaser = nearest(c.foeHeroes, h, 300);
    if (chaser && c.castSelf("AHtc")) return true;
    if (chaser && inReach(c, "Acri", chaser) && c.castUnit("Acri", chaser)) return true;
    return false;
  }
  if (t) {
    if (!noticed(c, t)) return false;
    const e = edge(h, t);
    if (c.profile.combos && channeling(t) && inReach(c, "ACfb", t) && c.castUnit("ACfb", t)) return true;
    if (e > 200 && inReach(c, "ACfb", t) && c.castUnit("ACfb", aim(c, "ACfb", t))) return true;
    if (e <= 200) {
      const blow = 5 * h.str;
      if ((!c.profile.holdNuke || t.hp <= blow * 1.1 || pct(t) < 0.4) && c.castUnit("AIfz", t)) return true;
      if (c.castUnit("Acri", t)) return true;
    }
    if (c.foeHeroes.some((f) => edge(h, f) <= 300) && c.castSelf("AHtc")) return true;
    return false;
  }
  if (mayFarm(c) && c.foeUnits.filter((u) => edge(h, u) <= 300).length >= 3 && c.castSelf("AHtc")) return true;
  return false;
}

/** Fireball (`Awfb`) damage by rank — its data (125/200/300), which the tooltip agrees with. */
const FIREBALL = [125, 200, 300];

/**
 * MAGE (`Ulic`/`Hjai`) — the burst caster. Frost Nova (`Aroa`) roots everything within 500 of the
 * Mage (`Mage_Frost_Nova`), which is both the combo's opener (a rooted hero stands in the Flame
 * Strike) and the Mage's escape. Frost Armor (`A00S`) is kept up between fights.
 */
function mage(c: SpellCtx): boolean {
  const h = c.hero;
  const t = c.target;
  const close = c.foeHeroes.filter((f) => edge(h, f) <= 480);
  if (!t && !c.fleeing && c.foeHeroes.length === 0 && c.sinceCast("A00S") > 58 && h.mana >= 160 && c.castSelf("A00S")) return true;
  if (c.fleeing) {
    if (close.length && c.castSelf("Aroa")) return true;
    if (pct(h) < 0.45 && h.mana > 60 && !hasBuff(h, ["BNms"]) && c.castSelf("ANms")) return true;
    return false;
  }
  if (t) {
    if (!noticed(c, t)) return false;
    const e = edge(h, t);
    const fb = FIREBALL[Math.max(0, rankOf(c, "Awfb") - 1)] ?? 0;
    if (c.profile.combos) {
      if (channeling(t) && inReach(c, "Awfb", t) && c.castUnit("Awfb", t)) return true;
      if (e <= 480 && c.castSelf("Aroa")) return true;
      if (pinned(t) && inReach(c, "AHfs", t) && c.castPoint("AHfs", t.x, t.y)) return true;
      if ((!c.profile.holdNuke || !c.ready("Aroa") || t.hp <= fb * 1.15 || pct(t) < 0.5) && inReach(c, "Awfb", t) && c.castUnit("Awfb", aim(c, "Awfb", t))) return true;
    } else {
      if (inReach(c, "Awfb", t) && c.castUnit("Awfb", aim(c, "Awfb", t))) return true;
      if (close.length && c.castSelf("Aroa")) return true;
      if (inReach(c, "AHfs", t) && c.castPoint("AHfs", t.x, t.y)) return true;
    }
    // Blizzard only where it lands on more than one hero and nobody is standing on the Mage.
    if (c.foeHeroes.filter((f) => dist(f, t) <= 300).length >= 2 && close.length === 0 && inReach(c, "AHbz", t) && c.castPoint("AHbz", t.x, t.y)) return true;
    if (pct(h) < 0.5 && h.mana > 120 && !hasBuff(h, ["BNms"]) && c.foeHeroes.some((f) => f.targetId === h.id) && c.castSelf("ANms")) return true;
    return false;
  }
  if (mayFarm(c)) {
    const knot = cluster(c.foeUnits, 200, 3);
    if (knot && Math.hypot(knot.x - h.x, knot.y - h.y) <= reach(c, "AHfs") + 100 && c.castPoint("AHfs", knot.x, knot.y)) return true;
  }
  return false;
}

/** The combo points on a target (`Rogue_Sinister_Strike` gives it `Asp1` → `Asp2` → `Asp3`). */
function comboPoints(t: SimUnit): number {
  if (t.abilities.some((a) => a.id === "Asp3")) return 3;
  if (t.abilities.some((a) => a.id === "Asp2")) return 2;
  if (t.abilities.some((a) => a.id === "Asp1")) return 1;
  return 0;
}

/**
 * ROGUE (`Ewar`/`Edem`) — energy, not mana (7.5 a second). Sinister Strike (`ANfl`) builds combo
 * points on the target and Eviscerate (`Afod`) spends them: 75×rank + 2×AGI, plus 100/125/150 for
 * 1/2/3 points as the trigger actually codes it (`Rogue_Evisercate`). So the right play is strike,
 * strike, strike, eviscerate — and the wrong one, pressing Eviscerate the moment it is ready, is the
 * Easy one. Stealth (`AOwk`) is an escape, and never near a tower: every tower has true sight.
 */
function rogue(c: SpellCtx): boolean {
  const h = c.hero;
  const t = c.target;
  if (c.fleeing) {
    if (!h.invisible && !c.underTower(h.x, h.y, 250) && c.castSelf("AOwk")) return true;
    const chaser = nearest(c.foeHeroes, h, 170);
    if (chaser && c.profile.combos && c.castUnit("AUsl", chaser)) return true;
    return false;
  }
  if (t) {
    if (!noticed(c, t)) return false;
    if (c.profile.combos) {
      const other = c.foeHeroes.find((f) => f !== t && edge(h, f) <= 170 && !f.stunned);
      if (other && c.castUnit("AUsl", other)) return true;
    }
    if (edge(h, t) > 200) return false;
    const points = comboPoints(t);
    const evis = 75 * rankOf(c, "Afod") + 2 * h.agi + ([0, 100, 125, 150][points] ?? 0);
    const finish = c.profile.holdNuke ? points >= 3 || t.hp <= evis : c.profile.combos ? points >= 2 || t.hp <= evis : true;
    if (finish && c.castUnit("Afod", t)) return true;
    if (h.mana >= 20 + (c.profile.combos ? 50 : 0) && c.castUnit("ANfl", t)) return true;
    return false;
  }
  return false;
}

/**
 * WARLOCK (`Uwar`/`Hblm`) — damage over time and control. Immolate (`Auhf`) is its nuke (+100×rank,
 * `Warlock_Immolate`); Fear (`ACfd`) sends everything allied to the target within 150 of it walking
 * home (`Warlock_Fear`), which peels a diver off and breaks a channel; Hellfire (`AEsf`) burns the
 * Warlock for 100 a second while it lasts, so it is only ever started with the life to pay for it.
 */
function warlock(c: SpellCtx): boolean {
  const h = c.hero;
  const t = c.target;
  if (c.fleeing) {
    const chaser = nearest(c.foeHeroes, h, 450);
    if (chaser && c.castUnit("ACfd", chaser)) return true;
    return false;
  }
  if ((t || c.foeUnits.some((u) => edge(h, u) <= 600)) && c.ownCount("nvdw") === 0 && c.castSelf("AHwe")) return true;
  if (t) {
    if (!noticed(c, t)) return false;
    const e = edge(h, t);
    if (c.profile.combos && channeling(t) && inReach(c, "ACfd", t) && c.castUnit("ACfd", t)) return true;
    if (c.profile.combos) {
      const diver = c.foeHeroes.find((f) => edge(h, f) <= 160 && (f.weapon?.range ?? 999) <= 200);
      if (diver && c.castUnit("ACfd", diver)) return true;
    }
    const immolate = 100 * rankOf(c, "Auhf") + 40;
    if ((!c.profile.holdNuke || t.hp <= immolate * 1.3 || pct(t) < 0.6 || h.mana >= h.maxMana * 0.7) && inReach(c, "Auhf", t) && c.castUnit("Auhf", aim(c, "Auhf", t))) return true;
    if (c.foeHeroes.filter((f) => edge(h, f) <= 420).length >= 2 && pct(h) >= 0.65 && c.castSelf("AEsf")) return true;
    if (pct(h) < 0.8 && e <= 450 && !c.foeHeroes.some((f) => f !== t && edge(h, f) <= 650) && c.castUnit("ANdr", t)) return true;
    if (!c.profile.combos && inReach(c, "ACfd", t) && c.castUnit("ACfd", t)) return true;
    return false;
  }
  if (mayFarm(c) && pct(h) >= 0.85 && c.foeUnits.filter((u) => edge(h, u) <= 400).length >= 5 && c.castSelf("AEsf")) return true;
  return false;
}

/**
 * SHAMAN (`Oshd`, Horde only) — the totems. The Healing Stream Totem (`Ahwd`) has NO cooldown in this
 * map's data, so the only thing between a Shaman and a carpet of them is mana; it is dropped where
 * hurt allies are standing and not otherwise. The Earthbind Totem (`AOsw`) slows everything in 500
 * by 65%, which is what catches a hero walking away.
 */
function shaman(c: SpellCtx): boolean {
  const h = c.hero;
  const t = c.target;
  const hurt = c.allyHeroes.filter((a) => pct(a) < 0.7 && edge(h, a) <= 500);
  if ((hurt.length >= 2 || (hurt.length === 1 && (t || c.fleeing))) && c.sinceCast("Ahwd") > 6) {
    const x = hurt.reduce((s, a) => s + a.x, 0) / hurt.length;
    const y = hurt.reduce((s, a) => s + a.y, 0) / hurt.length;
    if (c.castPoint("Ahwd", x, y)) return true;
  }
  if (c.fleeing) {
    const chaser = nearest(c.foeHeroes, h, 500);
    if (chaser && c.castPoint("AOsw", chaser.x, chaser.y)) return true;
    if (chaser && c.castUnit("Apg2", chaser)) return true;
    return false;
  }
  if (t) {
    if (!noticed(c, t)) return false;
    const lust = c.allyHeroes.find((a) => (a.weapon?.range ?? 999) <= 200 && edge(h, a) <= 500 && !hasBuff(a, ["Bblo"]) && c.foeHeroes.some((f) => edge(a, f) <= 400));
    if (lust && c.castUnit("ACbl", lust)) return true;
    if (inReach(c, "AOcl", t) && c.castUnit("AOcl", aim(c, "AOcl", t))) return true;
    if (inReach(c, "A00W", t) && c.castUnit("A00W", t)) return true;
    if ((pct(t) < 0.45 || leaving(h, t)) && edge(h, t) <= reach(c, "AOsw") + 300 && c.castPoint("AOsw", t.x, t.y)) return true;
    if (c.profile.combos && hasBuff(t, ["Bblo", "Binf", "Brej"]) && inReach(c, "Apg2", t) && c.castUnit("Apg2", t)) return true;
    return false;
  }
  if (mayFarm(c) && c.foeUnits.filter((u) => edge(h, u) <= 700).length >= 4) {
    const first = nearest(c.foeUnits, h, 700);
    if (first && c.castUnit("AOcl", first)) return true;
  }
  return false;
}

/**
 * HUNTER (`Usyl`/`Hvwd`) — a slow, a poison and a trap. Concussive Shot (`ANdh`) is kept for the
 * target that is about to get away, or for the one closing in; Wing Clip (`Aprg`) is the melee-range
 * slow; Frost Trap (`AIbt`) is laid under a fight, or at its own feet with something chasing it.
 */
function hunter(c: SpellCtx): boolean {
  const h = c.hero;
  const t = c.target;
  if ((t || c.foeUnits.length) && c.ownCount("ngzc") === 0 && c.castSelf("Arsg")) return true;
  if (c.fleeing) {
    const chaser = nearest(c.foeHeroes, h, 520);
    if (chaser && edge(h, chaser) <= 190 && c.castUnit("Aprg", chaser)) return true;
    if (chaser && c.castUnit("ANdh", chaser)) return true;
    if (chaser && c.castPoint("AIbt", h.x, h.y)) return true;
    return false;
  }
  if (t) {
    if (!noticed(c, t)) return false;
    const e = edge(h, t);
    if (inReach(c, "ANab", t) && c.castUnit("ANab", aim(c, "ANab", t))) return true;
    if ((!c.profile.combos || pct(t) < 0.5 || leaving(h, t)) && inReach(c, "ANdh", t) && c.castUnit("ANdh", t)) return true;
    if (e <= 190 && c.castUnit("Aprg", t)) return true;
    if (e <= 650 && c.castPoint("AIbt", t.x, t.y)) return true;
    return false;
  }
  return false;
}

/**
 * PRIEST (`Ucrl`/`Harf`) — the healer. Flash Heal (`AChv`, 350) is the save, Heal (`Ahea`) runs on
 * autocast, Inner Fire (`Ainf`) goes on the ally who is actually fighting, and Mana Burn (`AEmb`) on
 * the enemy caster with the fullest bar — the map forbids it on Warriors and Rogues, which
 * `castError` enforces, so a sapper is never even tried.
 */
function priest(c: SpellCtx): boolean {
  const h = c.hero;
  const t = c.target;
  const low = neediest(c.allyHeroes, h, 740, 0.5);
  if (low && c.castUnit("AChv", low)) return true;
  if (c.fleeing) return false;
  if (t) {
    if (!noticed(c, t)) return false;
    const fire = c.allyHeroes.find((a) => a !== h && edge(h, a) <= 500 && !hasBuff(a, ["Binf"]) && c.foeHeroes.some((f) => edge(a, f) <= 500));
    if (fire && c.castUnit("Ainf", fire)) return true;
    if (inReach(c, "ACuf", t) && c.castUnit("ACuf", aim(c, "ACuf", t))) return true;
    const burn = [...c.foeHeroes].filter((f) => f.mana >= 100 && inReach(c, "AEmb", f)).sort((a, b) => b.mana - a.mana)[0];
    if (burn && c.castUnit("AEmb", burn)) return true;
    return false;
  }
  const hurt = neediest(c.allyHeroes, h, 520, 0.75);
  if (hurt && c.castUnit("Ahea", hurt)) return true;
  return false;
}

/**
 * DRUID (`Otch`/`Hapm`) — heals over time and a root. Rejuvenation (`Arej`) on the ally who needs it
 * and does not have it; Tranquility (`AEtq`) only with nobody on top of the Druid, because it is a
 * channel; Faerie Fire (`ACff`) before the team focuses; Entangling Roots (`AEer`) on the target
 * that is leaving or channelling.
 */
function druid(c: SpellCtx): boolean {
  const h = c.hero;
  const t = c.target;
  const hurt = c.allyHeroes.filter((a) => pct(a) < 0.6 && edge(h, a) <= 700);
  if (hurt.length >= 2 && !c.foeHeroes.some((f) => edge(h, f) <= 500) && c.castSelf("AEtq")) return true;
  const rej = [...c.allyHeroes].filter((a) => pct(a) < 0.65 && !hasBuff(a, ["Brej"]) && inReach(c, "Arej", a)).sort((a, b) => pct(a) - pct(b))[0];
  if (rej && c.castUnit("Arej", rej)) return true;
  if (c.fleeing) {
    const chaser = nearest(c.foeHeroes, h, 600);
    if (chaser && c.castUnit("AEer", chaser)) return true;
    return false;
  }
  if (t) {
    if (!noticed(c, t)) return false;
    if (c.profile.combos && !hasBuff(t, ["Bfae"]) && inReach(c, "ACff", t) && c.castUnit("ACff", t)) return true;
    if ((!c.profile.combos || channeling(t) || pct(t) < 0.5 || leaving(h, t)) && inReach(c, "AEer", t) && c.castUnit("AEer", aim(c, "AEer", t))) return true;
    if (inReach(c, "Suhf", t) && c.castUnit("Suhf", t)) return true;
    return false;
  }
  return false;
}

/**
 * PALADIN (`Hpal`, Alliance only) — Hammer of Justice (`AHtb`) is a 150-range stun, so it is a
 * melee opener and an interrupt; Divine Shield (`AHds`) is the panic button; Lay on Hands (`ACf3`)
 * heals 1000 and empties the Paladin's mana (`Paladin_Lay_on_Hands`), so it is a save and nothing
 * less. The aura button (`ACro`) CYCLES the aura and is never pressed: the first rank already gives
 * Devotion, and a computer flicking through auras mid-fight is a computer stripping its own team.
 */
function paladin(c: SpellCtx): boolean {
  const h = c.hero;
  const t = c.target;
  if (pct(h) < 0.3 && c.foeHeroes.some((f) => edge(h, f) <= 600) && c.castSelf("AHds")) return true;
  const dying = neediest(c.allyHeroes, h, 490, 0.25);
  if (dying && c.castUnit("ACf3", dying)) return true;
  const hurt = neediest(c.allyHeroes, h, 540, 0.55);
  if (hurt && c.castUnit("AIhl", hurt)) return true;
  if (c.fleeing) {
    const chaser = nearest(c.foeHeroes, h, 190);
    if (chaser && c.castUnit("AHtb", chaser)) return true;
    return false;
  }
  if (t && noticed(c, t) && inReach(c, "AHtb", t, 60) && (channeling(t) || !c.profile.holdNuke || pct(t) < 0.85) && c.castUnit("AHtb", t)) return true;
  return false;
}

const CLASS_SPELLS: Readonly<Record<HeroClass, (c: SpellCtx) => boolean>> = {
  warrior, mage, rogue, warlock, shaman, hunter, priest, druid, paladin,
};

/**
 * One spell pass: at most ONE cast. A hero holding a channel is left to it unless it is running
 * (the channel is the fight's whole point — breaking a Tranquility to Rejuvenate is how a computer
 * wastes its ultimate).
 */
export function castPass(c: SpellCtx): boolean {
  if (channeling(c.hero) && !c.fleeing) return false;
  return CLASS_SPELLS[c.cls](c);
}

/** The abilities whose AUTOCAST a class turns on as soon as it has them — Heal and Bloodlust, which
 *  a player leaves on for the whole game. */
export const AUTOCAST_ON: readonly string[] = ["Ahea", "ACbl"];
