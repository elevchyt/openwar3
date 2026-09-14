import type { AbilityDef, AbilityLevel } from "../../../data/abilities";
import type { SimAbility, SimUnit } from "../../../sim/world";

// Computer+ on WarChasers — how a party member spends its HEALS.
//
// The melee caster (plus/casting.ts) heals whoever its target ladder rates highest, at 75 % of
// their life, out of the same mana it throws its nukes with — right for an army, where a Paladin's
// Footman is as much his as his own hero is. A dungeon party is not an army. The developer's brief
// is three rules, and this file is where their numbers live:
//
//  1. An allied HERO below `HERO_HEAL_HP` is healed — before any unit of the healer's own (its Water
//     Elemental, its Feral Spirits) and before the heal goes anywhere else.
//  2. ESPECIALLY with mana to spare: a healer with `SURPLUS_CASTS` heals in the bank tops a hero up
//     between fights too, and walks further to reach one; a healer short of mana keeps what it has
//     for heroes in a fight and spends none of it on anybody else.
//  3. A person who ASKS for a heal ("heal me", chat.ts `readHealRequest`) gets it as soon as the
//     healer can land it — if it can within `HEAL_CALL_WINDOW` seconds, the heal and the mana for it
//     are kept for them until it does.
//
// Nothing in the install describes a computer party member (docs/computer-plus.md), so every number
// here is OURS.

/** A hero below this share of its life is healed. The developer's number. */
export const HERO_HEAL_HP = 0.65;
/** How many heals' worth of mana is "to spare" — the developer's "3–4 holy lights in the bank". */
export const SURPLUS_CASTS = 3;
/** A requested heal is promised if the healer can land it within this many seconds (the brief's
 *  "within the next 5–10 seconds"). */
export const HEAL_CALL_WINDOW = 10;
/** A promise that has not been kept in this long is dropped (the target walked off, died, or the
 *  healer got stuck). */
export const HEAL_CALL_TTL = 15;
/** A requester above this share of its life has nothing to heal. */
export const HEAL_FULL = 0.98;
/** How far past its cast range a healer walks to reach a hero: short of mana, and with mana to spare. */
export const HEAL_WALK = 250;
export const HEAL_WALK_SURPLUS = 650;

/**
 * The heals a party member presses on somebody else, by BASE code, and how each is aimed.
 *
 * `unit` is a single target (Holy Light, Healing Wave, Rejuvenation, Heal); `area` is pressed where
 * the caster stands and heals around it (Tranquility). Death Coil is left out on purpose: its
 * healing half is for undead ALLIES only and its other half is the caster's nuke, which the melee
 * caster already weighs (`COIL_HEAL_HP`). Holy Light's polarity is the sim's (`POLARITY_SPELLS`) —
 * `targetError` refuses it on an undead hero, and this file asks the same door.
 */
export const PARTY_HEALS: Readonly<Record<string, "unit" | "area">> = {
  AHhb: "unit", // Holy Light — Snake Aes and Beast Knight carry it (map.ts `PICKS`)
  AOhw: "unit", // Healing Wave
  Arej: "unit", // Rejuvenation
  Ahea: "unit", // Heal
  AEtq: "area", // Tranquility — Megotron X
};

/** One heal a body owns, as the pass reads it. */
export interface HealCard {
  readonly ab: SimAbility;
  readonly def: AbilityDef;
  readonly lvl: AbilityLevel;
  readonly aim: "unit" | "area";
}

/** The learned heals on a body's card. */
export function healCards(u: SimUnit, def: (id: string) => AbilityDef | undefined): HealCard[] {
  const out: HealCard[] = [];
  for (const ab of u.abilities) {
    if (ab.level < 1) continue;
    const d = def(ab.id);
    const aim = d ? PARTY_HEALS[d.code] : undefined;
    if (!d || !aim) continue;
    const lvl = d.levelData[Math.min(ab.level, d.levelData.length) - 1];
    if (lvl) out.push({ ab, def: d, lvl, aim });
  }
  return out;
}

/**
 * Seconds until this heal can go out: the cooldown, or the mana it is short of at the body's own
 * regeneration, whichever is longer. Infinity when the mana is not coming back at all.
 */
export function healEta(u: Pick<SimUnit, "mana" | "manaRegen">, card: Pick<HealCard, "ab" | "lvl">): number {
  const short = card.lvl.cost - u.mana;
  const manaWait = short <= 0 ? 0 : u.manaRegen > 0 ? short / u.manaRegen : Infinity;
  return Math.max(card.ab.cooldownLeft, manaWait);
}

/** How many of this heal the body's bar holds right now. */
export function healsInBank(u: Pick<SimUnit, "mana">, card: Pick<HealCard, "lvl">): number {
  return card.lvl.cost > 0 ? Math.floor(u.mana / card.lvl.cost) : Infinity;
}
