// Orb effects — WC3's family of ATTACK MODIFIERS, and the rule that only one of them
// may ride a given blow.
//
// The name comes from the orb ITEMS (Orb of Fire, Orb of Frost, …), but the family is much
// wider than the shop: Searing Arrows, Cold Arrows, Black Arrow and Incinerate are orbs; so
// are the Dryad's Slow Poison, the Wind Rider's Envenomed Spears, the Spell Breaker's
// Feedback, the Frost Wyrm's Frost Attack and the Mask of Death's life steal. Liquipedia's
// Orb page is the index we work from ("Orb effects are passive attack effects… In warcraft 3
// orb effects cannot stack and only one can be active at the same time"), and its own listing
// is what ORB_ABILITIES below mirrors.
//
// THE RULE (Liquipedia, Orb § Priority — verbatim order):
//   1. Arrows have the highest priority
//   2. Mask of Death has the highest priority of all items
//   3. Items have a higher priority than passive abilities
//   4. All orbs have the same priority
//   5. If multiple orbs are in one inventory, their position determines which is active
//
// So this is a four-tier ladder with the inventory slot breaking the tie inside the item
// tier. On WHICH slot wins, the wiki only says "their position determines" — the concrete
// answer is a player test reported on r/warcraft3 ("Do two orbs cancel each other's effect?",
// 2024): orbs in slots 1 and 2, and the slot-2 orb is the one that fires; a second reply in
// the same thread puts it as "6 having the highest orb priority". Hence LATER SLOT WINS.
//
// What is NOT exclusive, and is easy to get wrong: an orb's flat DAMAGE BONUS. Every orb
// item's tooltip words it as a carried stat — "Adds 5 bonus damage to the attack of a Hero
// when carried" (Units\ItemStrings.txt `oven`) — i.e. a Claws-of-Attack line, not part of the
// on-hit effect, and the same reddit thread says so outright ("1) flat attack bonus… will
// always stack. It will function as a claw"). Two orbs therefore give two damage bonuses and
// one effect. Same for the air attack (see ENABLED_ATTACK_INDEX below): it is a property of
// carrying the item, not of winning the priority contest.
//
// Not reproduced: the wrapper-ability bug Liquipedia documents (the `Iobu` "Effect Ability"
// orbs — Slow, Lightning, Darkness — fail to fire when the attacker auto-acquired its target
// while idle / on Stop / on Hold Position, but work under Attack-Move and Patrol). We fire
// them on every qualifying hit.

/**
 * The orb family, keyed by base ability `code` (never by alias — `ACsa` is the creep's
 * Searing Arrows and its code is `AHfa`, `AIll` and `AIdf` are both `AIsb`, `AIsz` is
 * `Aspo`). The value is only what decides the unit's PRIORITY TIER when the ability is
 * carried by a unit; an ability reached through an ITEM is always item-tier, whatever it
 * says here (Assassin's Blade carries `AIsz`, whose code is the Dryad's passive `Aspo`,
 * and an item still outranks a passive).
 */
export type OrbKind =
  | "arrow" // an ability that enhances the unit's own shots — highest priority of all
  | "passive" // an always-on attack modifier a unit type carries — lowest priority
  | "item"; // only ever reached through an item's ability list

export const ORB_ABILITIES: Readonly<Record<string, OrbKind>> = {
  // --- Arrows (Liquipedia, Orb § Arrows). Each spends its own Cost per SHOT, and each
  // swaps the shooter's missile art, which is the community's own "is it an orb?" test
  // (hiveworkshop "Orb Abilities" #83426: "give it to a ranged unit and see if it changes
  // the missile art").
  AHfa: "arrow", // Searing Arrows — Priestess of the Moon (`ACsa` for the creep archers)
  AHca: "arrow", // Cold / Frost Arrows — Naga Sea Witch (`ANfa`), Skeletal Marksman (`ACcw`)
  ANba: "arrow", // Black Arrow — Dark Ranger (`ACbk` for the creep version)
  ANia: "arrow", // Incinerate (autocast) — Firelord
  ANic: "arrow", // Incinerate (the always-on variant of the same ability)
  AEpa: "arrow", // Poison Arrows
  Afak: "arrow", // Orb of Annihilation — Destroyer
  // --- Passive attack modifiers a unit type is born with (or researches).
  Aspo: "passive", // Slow Poison — Dryad, Hydra, …
  Aven: "passive", // Envenomed Spears — Wind Rider (gated on `Rovs`); `ACvs` on creeps
  Apoi: "passive", // Poison Sting
  Apo2: "passive", // Poison Sting (Orb of Venom's half — reached as an item, see above)
  Afbk: "passive", // Feedback — Spell Breaker (`Afbt` Arcane Tower, `Afbb` campaign)
  Afra: "passive", // Frost Attack — Nerubian Tower, Halls of the Dead / Black Citadel
  Afrb: "passive", // Frost Attack (Frost Wyrm / Blue Dragons — same buff, longer duration)
  // --- Item-only ability codes.
  AIva: "item", // Life Steal — Mask of Death, Killmaim (`SCva`)
  AIfb: "item", // Item Attack Fire Bonus — Orb of Fire, Orb of Kil'jaeden (`AIgd`)
  AIlb: "item", // Item Attack Lightning Bonus — Orb of Lightning (RoC)
  AIlp: "item", // Item Purge — the other half of the RoC Orb of Lightning
  AIob: "item", // Item Attack Frost Bonus — Orb of Frost
  AIpb: "item", // Item Attack Poison Bonus — Orb of Venom (poison half is `Apo2`)
  AIcb: "item", // Item Attack Corruption Bonus — Orb of Corruption
  AIsb: "item", // the "Effect Ability" orbs — Orb of Slow, Orb of Lightning (TFT), Orb of Darkness
  ANbs: "item", // Orb of Darkness's raise-a-minion effect (also `AIdf`'s Effect Ability)
};

/** Priority tiers, LOWEST NUMBER WINS (see the ladder in the file header). */
export const enum OrbTier {
  Arrow = 0,
  Lifesteal = 1, // Mask of Death — "the highest priority of all items"
  Item = 2,
  Passive = 3,
}

/** Is `code` an attack modifier at all? */
export function isOrbCode(code: string): boolean {
  return code in ORB_ABILITIES;
}

/** The ARROW half of the family: an ability that enhances the unit's own shots, spends mana
 *  per shot, and can be both autocast and aimed by hand at one target (see issueArrowShot).
 *  Everything else in the family is either always on (a passive) or carried (an item). */
export function isArrowOrb(code: string): boolean {
  return ORB_ABILITIES[code] === "arrow";
}

/** The tier an orb reached through a unit's OWN ability list sits in. */
export function abilityOrbTier(code: string): OrbTier | null {
  const kind = ORB_ABILITIES[code];
  if (!kind) return null;
  // An "item" code found on a unit rather than in an inventory is a map handing it out
  // directly; it still is not an arrow, so it lands with the passives.
  return kind === "arrow" ? OrbTier.Arrow : OrbTier.Passive;
}

/** The tier an ITEM's orb sits in. Life steal (Mask of Death, Killmaim) outranks the rest. */
export function itemOrbTier(codes: readonly string[]): OrbTier {
  return codes.includes("AIva") ? OrbTier.Lifesteal : OrbTier.Item;
}

/**
 * `DataE` on every orb item — AbilityMetaData.slk row `Iob5`, whose WorldEditStrings name is
 * **"Enabled Attack Index"** (min 0, max 2), carried by AIdf/AIcb/AIfb/AIzb/AIob/AIll/AIlb/
 * AIsb/AIpb and set to 2 on every one of them.
 *
 * This is the whole of "orbs let a melee hero hit air", and it is pure data once you notice
 * that EVERY hero ships a second, dormant weapon: UnitWeapons.slk gives the Paladin
 * `weapsOn=1` with slot 1 a 100-range melee that lists no `air`, and slot 2 a 500-range
 * homing missile that does — identical dice, identical damage. The orb simply switches slot 2
 * on. (Ranged heroes carry the same pair; for them slot 2 is a duplicate and changes nothing.)
 *
 * The index is 1-based, matching the `weapsOn` bit order the sim already uses: 2 = the second
 * slot. Mask of Death carries no `Iob5` at all, which is why it is the one "orb" that does
 * NOT grant an air attack — a point the r/warcraft3 thread above corrects a poster on.
 */
export const ENABLED_ATTACK_INDEX = 4; // DataE — index into AbilityLevel.data (a=0 … e=4)

/**
 * The generic **Slowed** buff (`Bfro`) — the one WC3 hangs off every frost source: Frost
 * Nova, Frost Armor's chill, Frost Attack, Frost Breath and the Orb of Frost. Not one of
 * those abilities carries the magnitude in its own Data columns (AIob's are `DataA` damage
 * and nothing else, Afra/Afrb's are empty), so the numbers are engine-internal and come from
 * Liquipedia's buff card (Template:Infobox_Buff/Slowed): **50% movement, 25% attack speed**.
 * Durations DO come from the data — Orb of Frost 3s / 1s on heroes, Frost Attack 5s / 5s,
 * Frost Wyrm 10s / 3s.
 */
export const SLOWED_MOVE = 0.5;
export const SLOWED_ATTACK = 0.25;

/**
 * **Stacking Types** — the column that decides whether two sources of the same effect ADD or
 * merely refresh each other. AbilityMetaData gives it the type `stackFlags` (rows `Spo4`,
 * `Poi4`, `Poa5`, `Hca4`), and WorldEditStrings names the bits:
 *
 *     WESTRING_UE_STACKFLAGS_DAMAGE=Damage            1
 *     WESTRING_UE_STACKFLAGS_MOVEMENT=Movement        2
 *     WESTRING_UE_STACKFLAGS_ATTACKRATE=Attack Rate   4
 *     WESTRING_UE_STACKFLAGS_KILLUNIT=Kill unit       8
 *
 * The stock rows are unambiguous once read this way: Slow Poison, Envenomed Spears and the
 * Orb of Venom's poison all carry **1** — the damage-over-time stacks between different
 * attackers, the slow does not — which is exactly what Liquipedia's Orb of Venom page states
 * ("The poison damage stacks, if the orbs are carried by different Heroes"). Cold Arrows
 * carries **7** (everything stacks) and Poison Arrows **0** (nothing does).
 */
export const STACK_DAMAGE = 1;
export const STACK_MOVEMENT = 2;
export const STACK_ATTACKRATE = 4;

/** One resolved orb candidate, before the priority sort. */
export interface OrbCandidate<T> {
  tier: OrbTier;
  /** Inventory slot (0-5) for an item orb, -1 for a unit ability. Later slot wins. */
  slot: number;
  payload: T;
}

/**
 * Pick the single orb effect that rides this blow: lowest tier, and inside a tier the
 * HIGHEST inventory slot (see the file header on why later wins). Ability orbs share slot
 * -1 and so keep the order they were found in, which is their order on the unit.
 */
export function pickOrb<T>(candidates: OrbCandidate<T>[]): T | null {
  let best: OrbCandidate<T> | null = null;
  for (const c of candidates) {
    if (!best || c.tier < best.tier || (c.tier === best.tier && c.slot > best.slot)) best = c;
  }
  return best ? best.payload : null;
}
