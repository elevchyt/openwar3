// SAVED GAMES (issue #159, docs/save-games.md) — what a match's STATE is, for the codec.
//
// graph.ts writes whatever it is handed; this file says what that is. The roots are the
// authoritative objects of a match, and the codec walks everything reachable from them:
//
//   sim     the world (SimWorld): every unit, item, corpse, mine, tree, missile, the banks, the
//           tech, the clock, the random stream, the pathing grid and its stamps, the blight;
//   rts     the controller's books (RtsController): the alliances and the fog — what every player
//           has SEEN — the control groups and the selection, the computers' brains (melee,
//           Computer+, a campaign's .ai on its own JASS VMs, the creeps' casting), the placed-unit
//           index that hands out ids, a script's unit looks;
//   script  the map's JASS VM (Interpreter + Runtime): globals, handles, triggers, timers, quests,
//           dialogs, multiboards, game caches — and its sleeping threads, by their traces.
//
// The STATIC world they point into — the object tables' rows — is written as keys and looked up
// again on load (`externalsFor`), never copied: a unit's weapon may BE its type's row.

import { ExternalIndex, resolveExternalKey } from "./graph";
import type { UnitRegistry } from "../../data/units";
import type { AbilityRegistry } from "../../data/abilities";
import type { ItemRegistry } from "../../data/items";
import type { UpgradeRegistry } from "../../data/upgrades";
import type { TechRegistry } from "../../data/techtree";
import { JNULL } from "../../jass/values";

export interface SaveRegistries {
  units: UnitRegistry;
  abilities: AbilityRegistry;
  items: ItemRegistry;
  upgrades: UpgradeRegistry;
  tech: TechRegistry;
}

/** The registries' rows, indexed for the encoder. Both what `get` answers (a map's own row over
 *  the install's) and what `base` answers, since state may hold either. */
export function externalsFor(r: SaveRegistries): ExternalIndex {
  const ix = new ExternalIndex();
  ix.add("k", "JNULL", JNULL);
  for (const reg of [r.units, r.abilities, r.items, r.upgrades] as const) {
    const prefix = prefixOf(reg, r);
    for (const def of reg.all() as Array<{ id: string }>) {
      ix.add(prefix, def.id, def);
      const base = reg.base(def.id);
      if (base && base !== (def as unknown)) ix.add(`${prefix}base`, def.id, base);
    }
  }
  // The registries themselves, so a field that holds one (an AI's handle on the tables) is a key.
  ix.add("reg", "units", r.units);
  ix.add("reg", "abilities", r.abilities);
  ix.add("reg", "items", r.items);
  ix.add("reg", "upgrades", r.upgrades);
  ix.add("reg", "tech", r.tech);
  return ix;
}

function prefixOf(reg: unknown, r: SaveRegistries): string {
  return reg === r.units ? "unit" : reg === r.abilities ? "abil" : reg === r.items ? "item" : "upg";
}

/** The other half of `externalsFor`: a key back to the same row in the match being loaded. */
export function externalResolver(r: SaveRegistries): (key: string) => unknown {
  const sources = new Map<string, (id: string) => unknown>([
    ["k", (id) => (id === "JNULL" ? JNULL : undefined)],
    ["unit", (id) => r.units.get(id)],
    ["unitbase", (id) => r.units.base(id)],
    ["abil", (id) => r.abilities.get(id)],
    ["abilbase", (id) => r.abilities.base(id)],
    ["item", (id) => r.items.get(id)],
    ["itembase", (id) => r.items.base(id)],
    ["upg", (id) => r.upgrades.get(id)],
    ["upgbase", (id) => r.upgrades.base(id)],
    ["reg", (id) => (r as unknown as Record<string, unknown>)[id]],
  ]);
  return (key) => resolveExternalKey(key, sources);
}
