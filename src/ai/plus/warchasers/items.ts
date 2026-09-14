import type { AbilityDef } from "../../../data/abilities";
import { PrimaryAttribute } from "../../../data/enums";
import type { ItemDef } from "../../../data/items";
import { isOrbCode } from "../../../sim/orbs";
import { ANKHS, GOLD_ITEMS, KEYS } from "./map";

// Computer+ on WarChasers — what an item is WORTH to one hero.
//
// The developer's brief: a computer "must pick up all types of items, but if it doesn't have space,
// it should drop strength/agility items for intelligence items" when it plays an intelligence hero,
// and it "must prefer to always keep an ankh of reincarnation". So an item has no value of its own
// here — it has a value TO THIS HERO, and the belt is six slots of the most valuable things it has
// found, with the Ankh above everything.
//
// Every stat is read off the item's own abilities, on the same base codes `SimWorld.itemBonuses`
// switches on (`AIab` the three attributes, `AIat` damage, `AIde` armour, …), so a map's re-skinned
// item is valued by what it actually does. The WEIGHTS are OURS: nothing in the install says what a
// point of Strength is worth to a Lich.

export interface ItemEye {
  /** The ability row behind an item's `abilList` entry. */
  ability(id: string): AbilityDef | undefined;
  /** The hero's primary attribute (UnitBalance `Primary`, a map's `upra`). */
  primary: PrimaryAttribute;
  /** Does it fight in melee — which decides how much raw damage and life steal are worth. */
  melee: boolean;
}

/** What an Ankh is worth: more than anything else a belt could hold, so it is never the slot given up. */
export const ANKH_VALUE = 10_000;
/** A key is never worth a slot of ours — see map.ts `KEYS`. */
export const NOT_OURS = -1;

/** Is this item an Ankh — by id (`ankh`, `IC17`) or by what it does (`AIrc`, the reincarnation)? */
export function isAnkh(def: ItemDef, ability: (id: string) => AbilityDef | undefined): boolean {
  return ANKHS.has(def.id) || def.abilities.some((a) => ability(a)?.code === "AIrc");
}

/**
 * THE VALUE of an item to a hero, in rough "points" (OURS).
 *
 *  · An Ankh is `ANKH_VALUE`; a key is `NOT_OURS`; one of the map's gold trinkets is its 200 gold.
 *  · An ATTRIBUTE is three points on the hero's primary and one on the other two — so an intelligence
 *    hero rates Robe of the Magi +6 at 18 and Gauntlets of Ogre Strength +3 at 3, and gives the
 *    gauntlets up first.
 *  · Damage is worth more to a hero that swings for a living, mana to one that casts.
 *  · An ability nothing here knows is still worth something (a passive 3, a button it has no rule for 2), and the item's
 *    PRICE breaks the tie, because the map's own shopkeeper already priced what it does.
 */
export function itemValue(def: ItemDef, eye: ItemEye): number {
  if (KEYS.has(def.id)) return NOT_OURS;
  if (isAnkh(def, (id) => eye.ability(id))) return ANKH_VALUE;
  if (GOLD_ITEMS.has(def.id)) return 40;
  const int = eye.primary === PrimaryAttribute.Intelligence;
  const w = (attr: PrimaryAttribute): number => (eye.primary === attr ? 3 : 1);
  let v = def.gold / 400;
  for (const id of def.abilities) {
    const ab = eye.ability(id);
    if (!ab) continue;
    const d = ab.levelData[0]?.data ?? [];
    const val = (i: number): number => (d[i] === undefined || Number.isNaN(d[i]) ? 0 : d[i]);
    switch (ab.code) {
      case "AIab": v += val(0) * w(PrimaryAttribute.Agility) + val(1) * w(PrimaryAttribute.Intelligence) + val(2) * w(PrimaryAttribute.Strength); break;
      case "AIat": v += val(0) * (int ? 0.8 : 1.5); break;
      case "AIde": v += val(0) * 2.5; break;
      case "AIas": v += val(0) * (int ? 15 : 40); break;
      case "Arel": v += val(0) * 3; break;
      case "AIrm": v += val(0) * (int ? 12 : 5); break;
      case "AIms": v += val(0) / 12; break;
      case "AIml": v += val(0) / 20; break;
      case "AImm": v += val(0) / (int ? 25 : 60); break;
      case "AIva": v += eye.melee ? 10 : 6; break; // Mask of Death — life steal
      // Potions and scrolls that put life back are what a party of four lives on between fountains.
      case "AIhe": case "AIre": case "AIha": case "AIra": case "Ahwd": v += 8; break;
      case "AIma": case "AImr": v += int ? 6 : 2; break;
      default:
        if (isOrbCode(ab.code)) v += val(0) * (int ? 0.8 : 1.5) + 4;
        // A button nothing here knows how to press is worth less than a passive that simply works.
        else v += def.usable ? 2 : 3;
    }
  }
  return v;
}

/** One slot of a belt, valued. */
export interface Valued {
  slot: number;
  itemId: string;
  value: number;
}

/**
 * The slot a hero gives up first to make room, or -1: the LEAST valuable thing it carries that it is
 * allowed to let go of. An Ankh and a key are never offered (`itemValue` rates them out of reach), nor
 * is anything the item row says cannot be dropped.
 */
export function worstSlot(
  inventory: ReadonlyArray<{ itemId: string } | null>,
  item: (id: string) => ItemDef | undefined,
  eye: ItemEye,
): Valued | null {
  let worst: Valued | null = null;
  inventory.forEach((held, slot) => {
    if (!held) return;
    const def = item(held.itemId);
    if (!def || !def.droppable || KEYS.has(def.id)) return;
    const value = itemValue(def, eye);
    if (value >= ANKH_VALUE) return;
    if (!worst || value < worst.value) worst = { slot, itemId: held.itemId, value };
  });
  return worst;
}

/**
 * How much better a new item has to be than the one it replaces before the hero bothers — so it
 * does not trade a +3 claw for a +3 ring and back again every time it walks past one. OURS.
 */
export const UPGRADE_MARGIN = 2;

/** Would this hero want `candidate` in its belt as it stands — and, if the belt is full, which slot
 *  goes to make room for it (-1 when there is a free one)? Null when it is not worth taking. */
export function wantsItem(
  candidate: ItemDef,
  inventory: ReadonlyArray<{ itemId: string } | null>,
  item: (id: string) => ItemDef | undefined,
  eye: ItemEye,
): { replace: number; value: number } | null {
  let value = itemValue(candidate, eye);
  if (value <= 0) return null;
  // A second of the same USABLE item is worth less than the first (two Scrolls of Restoration are
  // one trip's heal and a spare); a second Claws of Attack stacks and is worth what the first was.
  if (candidate.usable && inventory.some((h) => h?.itemId === candidate.id)) value *= 0.5;
  // A second Ankh is a spare life, but not worth more than the first — it takes a slot, not a place
  // above everything.
  if (value >= ANKH_VALUE && inventory.some((h) => h && ANKHS.has(h.itemId))) value = 30;
  if (candidate.powerup) return { replace: -1, value };
  if (inventory.some((h) => !h)) return { replace: -1, value };
  if (GOLD_ITEMS.has(candidate.id)) return null; // 200 gold is not worth throwing an item on the floor
  const worst = worstSlot(inventory, item, eye);
  if (!worst || value < worst.value + UPGRADE_MARGIN) return null;
  return { replace: worst.slot, value };
}
