// What the observer HUD shows about one player (issue #168) — read off the world, never kept.
//
// Four readings, each a list of icons: the HEROES (with their learned skills and their belts),
// what the player is PRODUCING right now, the ARMY they have standing, and the UPGRADES they
// have researched. The HUD (ui/observerHud.ts) only draws these; it never asks the sim.
//
// Every reading works on a LAN client as well as on the host, because a watcher's payload
// carries every unit live (a watcher's viewpoint reveals the map) — the unit records hold the
// queues, the inventories and the skill ranks. The three things a record does NOT hold, a
// player's bank, research and dead heroes, ride the watcher's own lane
// (`WorldSnapshot.watched`) and are handed in through `ObserverSources`.

import type { SimUnit, BuildJob } from "../sim/world";
import type { UnitRegistry } from "../data/units";
import type { AbilityRegistry } from "../data/abilities";
import type { ItemRegistry } from "../data/items";
import type { UpgradeRegistry } from "../data/upgrades";

/** One icon in a reading. `value` is whatever the reading counts: seconds left for production,
 *  how many for the army, the rank for a skill or an upgrade, charges for an item. */
export interface ObserverIcon {
  /** Stable across frames (a type id, an upgrade id, a building's sim id) — the HUD reuses the
   *  element for the same key rather than rebuilding the row every refresh. */
  key: string;
  icon: string; // BLP path
  name: string;
  value: number;
  /** A unit or building to point the camera at when the icon is clicked; 0 for none. */
  simId: number;
}

export interface ObserverHero {
  simId: number;
  icon: string;
  /** The hero's own name ("Dalar Dawnweaver") and its type's ("Archmage") — the HUD words them
   *  through `INFOPANEL_LEVEL_CLASS`, as the info panel does. */
  properName: string;
  typeName: string;
  level: number;
  hpFrac: number;
  manaFrac: number; // -1: no mana pool, so no bar
  dead: boolean;
  /** The icon's `CommandButtonsDisabled\DIS*` twin, drawn while `dead` (see HeroBarEntry). */
  disabledIcon: string | null;
  reviveSecondsLeft: number; // 0 while it lies dead with nobody paying for it
  skills: ObserverIcon[]; // learned hero skills, in the type's own slot order
  items: Array<ObserverIcon | null>; // the belt, slot for slot
}

export interface ObserverPlayerView {
  player: number;
  gold: number;
  lumber: number;
  foodUsed: number;
  foodMax: number;
  apm: number;
  heroes: ObserverHero[];
  production: ObserverIcon[];
  army: ObserverIcon[];
  upgrades: ObserverIcon[];
}

/** The fallen-hero record, as either side of the wire holds it. */
interface FallenLike {
  id: number;
  typeId: string;
  properName: string;
  level: number;
  revivingAt: number;
}

export interface ObserverSources {
  units: ReadonlyMap<number, SimUnit>;
  registry: UnitRegistry;
  abilities: AbilityRegistry;
  items: ItemRegistry;
  upgrades: UpgradeRegistry;
  stash(player: number): { gold: number; lumber: number };
  food(player: number): { used: number; made: number };
  apm(player: number): number;
  research(player: number): Iterable<[string, number]>;
  fallen(player: number): Iterable<FallenLike>;
  disabledIcon(icon: string): string | null;
}

/** The most heroes a melee player can field — the bar under each pulldown is sized for this. */
export const OBSERVER_MAX_HEROES = 3;

export function observePlayer(src: ObserverSources, player: number): ObserverPlayerView {
  const stash = src.stash(player);
  const food = src.food(player);
  const mine: SimUnit[] = [];
  for (const u of src.units.values()) if (u.owner === player) mine.push(u);
  return {
    player,
    gold: stash.gold,
    lumber: stash.lumber,
    foodUsed: food.used,
    foodMax: food.made,
    apm: src.apm(player),
    heroes: heroesOf(src, player, mine),
    production: productionOf(src, mine),
    army: armyOf(src, mine),
    upgrades: upgradesOf(src, player),
  };
}

/** The roster in hire order — the order F1/F2/F3 count in — the dead keeping their place. */
function heroesOf(src: ObserverSources, player: number, mine: SimUnit[]): ObserverHero[] {
  const out: ObserverHero[] = [];
  for (const u of mine) {
    if (!u.isHero || u.isIllusion || u.hp <= 0) continue;
    const def = src.registry.get(u.typeId);
    const skills: ObserverIcon[] = [];
    for (const id of def?.heroAbilities ?? []) {
      const have = u.abilities.find((a) => a.id === id);
      const a = src.abilities.get(id);
      if (!have || have.level <= 0 || !a) continue;
      skills.push({ key: id, icon: a.icon, name: a.name, value: have.level, simId: 0 });
    }
    out.push({
      simId: u.id,
      icon: def?.icon ?? "",
      properName: u.properName,
      typeName: def?.name ?? u.typeId,
      level: u.level,
      hpFrac: u.maxHp > 0 ? u.hp / u.maxHp : 1,
      manaFrac: u.maxMana > 0 ? u.mana / u.maxMana : -1,
      dead: false,
      disabledIcon: null,
      reviveSecondsLeft: 0,
      skills,
      items: u.inventory.map((it) => {
        const d = it ? src.items.get(it.itemId) : undefined;
        return it && d ? { key: it.itemId, icon: d.icon, name: d.name, value: it.charges, simId: 0 } : null;
      }),
    });
  }
  for (const f of src.fallen(player)) {
    const def = src.registry.get(f.typeId);
    const icon = def?.icon ?? "";
    const job = f.revivingAt ? reviveJob(src.units.get(f.revivingAt)?.building?.queue, f.id) : null;
    out.push({
      simId: f.id, icon, properName: f.properName, typeName: def?.name ?? f.typeId, level: f.level,
      hpFrac: 0, manaFrac: -1, dead: true, disabledIcon: icon ? src.disabledIcon(icon) : null,
      reviveSecondsLeft: job ? Math.max(0, Math.ceil(job.timeLeft)) : 0,
      skills: [], items: [],
    });
  }
  // A hero keeps its sim id through death and revival, so id order IS hire order.
  return out.sort((a, b) => a.simId - b.simId).slice(0, OBSERVER_MAX_HEROES);
}

function reviveJob(queue: BuildJob[] | undefined, heroId: number): BuildJob | null {
  for (const j of queue ?? []) if (j.kind === "revive" && j.heroId === heroId) return j;
  return null;
}

/** Everything the player has IN HAND right now: a structure going up, and the job at the head
 *  of every queue — a unit, a hero, a research, a tier, a revival. Only the head: the jobs
 *  queued behind it are not being worked on (and have not even been paid for in food —
 *  `BuildJob`), which is what "in production" means. Soonest first. */
function productionOf(src: ObserverSources, mine: SimUnit[]): ObserverIcon[] {
  const out: ObserverIcon[] = [];
  for (const u of mine) {
    const b = u.building;
    if (!b) continue;
    if (b.constructionLeft > 0) {
      const def = src.registry.get(u.typeId);
      out.push({ key: `b${u.id}`, icon: def?.icon ?? "", name: def?.name ?? u.typeId, value: Math.ceil(b.constructionLeft), simId: u.id });
    }
    const j = b.queue[0];
    if (!j) continue;
    if (j.kind === "research") {
      out.push({ key: `q${u.id}`, icon: src.upgrades.icon(j.unitId, j.level), name: src.upgrades.name(j.unitId, j.level), value: Math.ceil(j.timeLeft), simId: u.id });
    } else {
      const def = src.registry.get(j.unitId);
      out.push({ key: `q${u.id}`, icon: def?.icon ?? "", name: def?.name ?? j.unitId, value: Math.ceil(j.timeLeft), simId: u.id });
    }
  }
  return out.sort((a, b) => a.value - b.value);
}

/** The standing army by type, largest first: every living unit that is not a structure, a hero
 *  (they have the panel below) or an illusion (a picture of the army, not part of it —
 *  docs/illusions.md). Workers count; they are what a player's economy is. */
function armyOf(src: ObserverSources, mine: SimUnit[]): ObserverIcon[] {
  const byType = new Map<string, ObserverIcon>();
  for (const u of mine) {
    if (u.building || u.isHero || u.isIllusion || u.hp <= 0 || u.hidden) continue;
    const have = byType.get(u.typeId);
    if (have) { have.value++; continue; }
    const def = src.registry.get(u.typeId);
    if (!def?.icon) continue; // a dummy the map uses for effects is nobody's army
    byType.set(u.typeId, { key: u.typeId, icon: def.icon, name: def.name, value: 1, simId: u.id });
  }
  return [...byType.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

/** Every research the player has, at the rank it has reached — wearing that RANK's own icon
 *  and name (Iron → Steel → Mithril Forged Swords), as the card does. */
function upgradesOf(src: ObserverSources, player: number): ObserverIcon[] {
  const out: ObserverIcon[] = [];
  for (const [id, level] of src.research(player)) {
    if (level <= 0 || !src.upgrades.has(id)) continue;
    out.push({ key: id, icon: src.upgrades.icon(id, level), name: src.upgrades.name(id, level), value: level, simId: 0 });
  }
  return out;
}
