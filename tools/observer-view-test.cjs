// OBSERVER HUD readings — issue #168 (src/game/observerView.ts, src/game/apm.ts).
//
// What the watcher's panels print about each player, read off the world: the heroes (hire
// order, the dead keeping their place, three at most), the work in hand (only the HEAD of a
// queue, soonest first), the army by type (no buildings, heroes or illusions) and the research
// at its reached rank. Plus the APM meter's window.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { observePlayer, OBSERVER_MAX_HEROES } = require(join(REPO, ".sim-build", "src", "game", "observerView.js"));
const { ApmMeter } = require(join(REPO, ".sim-build", "src", "game", "apm.js"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const DEFS = {
  Hamg: { name: "Archmage", icon: "BTNHeroArchMage.blp", heroAbilities: ["AHbz", "AHwe", "AHab", "AHav"] },
  Hmkg: { name: "Mountain King", icon: "BTNHeroMountainKing.blp", heroAbilities: ["AHtb", "AHtc", "AHbh", "AHav"] },
  Hpal: { name: "Paladin", icon: "BTNHeroPaladin.blp", heroAbilities: ["AHhb", "AHds", "AHad", "AHre"] },
  Hblm: { name: "Blood Mage", icon: "BTNHeroBloodElfPrince.blp", heroAbilities: [] },
  hfoo: { name: "Footman", icon: "BTNFootman.blp" },
  hpea: { name: "Peasant", icon: "BTNPeasant.blp" },
  hbar: { name: "Barracks", icon: "BTNHumanBarracks.blp" },
  hkee: { name: "Keep", icon: "BTNKeep.blp" },
  htow: { name: "Town Hall", icon: "BTNTownHall.blp" },
  hhou: { name: "Farm", icon: "BTNFarm.blp" },
};
const ABILS = { AHbz: { name: "Blizzard", icon: "BTNBlizzard.blp" }, AHwe: { name: "Summon Water Elemental", icon: "BTNSummonWaterElemental.blp" }, AHab: { name: "Brilliance Aura", icon: "BTNBrilliance.blp" } };
const ITEMS = { stwp: { name: "Scroll of Town Portal", icon: "BTNScrollUber.blp" }, phea: { name: "Potion of Healing", icon: "BTNPotionGreenSmall.blp" } };
const UPGRADES = { Rhme: { names: ["Iron Forged Swords", "Steel Forged Swords", "Mithril Forged Swords"], icons: ["BTNSteelMelee.blp", "BTNThoriumMelee.blp", "BTNArcaniteMelee.blp"] } };

let nextId = 1;
const unit = (typeId, over = {}) => ({
  id: nextId++, owner: 0, typeId, hp: 100, maxHp: 100, mana: 0, maxMana: 0, isHero: false, isIllusion: false, hidden: false,
  properName: "", level: 0, abilities: [], inventory: [], building: null, ...over,
});
const building = (typeId, queue = [], constructionLeft = 0, over = {}) => unit(typeId, { building: { constructionLeft, queue }, ...over });

function sources(units, extra = {}) {
  return {
    units: new Map(units.map((u) => [u.id, u])),
    registry: { get: (id) => DEFS[id] },
    abilities: { get: (id) => ABILS[id] },
    items: { get: (id) => ITEMS[id] },
    upgrades: {
      has: (id) => id in UPGRADES,
      name: (id, l) => UPGRADES[id].names[Math.min(l, 3) - 1],
      icon: (id, l) => UPGRADES[id].icons[Math.min(l, 3) - 1],
    },
    stash: () => ({ gold: 500, lumber: 150 }),
    food: () => ({ used: 23, made: 40 }),
    apm: () => 77,
    research: () => [],
    fallen: () => [],
    disabledIcon: (icon) => `DIS${icon}`,
    ...extra,
  };
}

console.log("\nthe HEROES: hire order, learned skills at their ranks, the belt slot for slot");
{
  const am = unit("Hamg", { isHero: true, level: 5, properName: "Dalar", hp: 300, maxHp: 600, mana: 100, maxMana: 400,
    abilities: [{ id: "AHbz", level: 2 }, { id: "AHwe", level: 1 }, { id: "AHab", level: 0 }, { id: "Aatk", level: 1 }],
    inventory: [{ itemId: "stwp", charges: 1 }, null, { itemId: "phea", charges: 2 }, null, null, null] });
  const mk = unit("Hmkg", { isHero: true, level: 2, properName: "Muradin" });
  const view = observePlayer(sources([mk, am].sort((a, b) => b.id - a.id)), 0);
  check("the first hero hired comes first", view.heroes[0].simId === am.id && view.heroes[1].simId === mk.id);
  const skills = view.heroes[0].skills;
  check("only LEARNED hero skills, in the type's slot order, at their rank",
    skills.length === 2 && skills[0].name === "Blizzard" && skills[0].value === 2 && skills[1].value === 1,
    JSON.stringify(skills.map((s) => [s.name, s.value])));
  check("a unit ability (Aatk) is not a hero skill", !skills.some((s) => s.key === "Aatk"));
  const belt = view.heroes[0].items;
  check("the belt keeps its slots and charges", belt.length === 6 && belt[0].name === "Scroll of Town Portal" && belt[1] === null && belt[2].value === 2);
  check("bars: hp half, mana a quarter", view.heroes[0].hpFrac === 0.5 && view.heroes[0].manaFrac === 0.25);
  check("no mana pool reads -1 (no bar)", view.heroes[1].manaFrac === -1);
}

console.log("\na DEAD hero keeps its place, greyed, with the revival's seconds");
{
  const alive = unit("Hmkg", { isHero: true, level: 3 });
  const altar = building("halt", [{ kind: "revive", unitId: "Hamg", heroId: 0, timeLeft: 12.2, buildTime: 30 }]);
  const deadId = alive.id - 1; // hired BEFORE the Mountain King
  altar.building.queue[0].heroId = deadId;
  const view = observePlayer(sources([alive, altar], {
    fallen: () => [{ id: deadId, typeId: "Hamg", properName: "Dalar", level: 4, revivingAt: altar.id }],
  }), 0);
  check("the fallen Archmage is first, dead", view.heroes[0].dead && view.heroes[0].simId === deadId);
  check("…wearing the DIS twin", view.heroes[0].disabledIcon === "DISBTNHeroArchMage.blp");
  check("…with the revival's seconds, rounded up", view.heroes[0].reviveSecondsLeft === 13);
  check("the altar's revive also counts as production in hand", view.production.some((p) => p.name === "Archmage" && p.value === 13));
}

console.log(`\nat most ${OBSERVER_MAX_HEROES} heroes`);
{
  const hs = ["Hamg", "Hmkg", "Hpal", "Hblm"].map((t) => unit(t, { isHero: true, level: 1 }));
  check("a fourth (a map's) hero is left off the panel", observePlayer(sources(hs), 0).heroes.length === OBSERVER_MAX_HEROES);
}

console.log("\nPRODUCTION: the head of every queue and every structure going up, soonest first");
{
  const barracks = building("hbar", [
    { kind: "unit", unitId: "hfoo", timeLeft: 9.1, buildTime: 20 },
    { kind: "unit", unitId: "hfoo", timeLeft: 20, buildTime: 20 },
  ]);
  const hall = building("htow", [{ kind: "upgrade", unitId: "hkee", timeLeft: 60.5, buildTime: 140 }]);
  const smith = building("hbla", [{ kind: "research", unitId: "Rhme", level: 2, timeLeft: 3.3, buildTime: 60 }]);
  const farm = building("hhou", [], 14.4);
  const theirs = building("hbar", [{ kind: "unit", unitId: "hfoo", timeLeft: 1, buildTime: 20 }], 0, { owner: 1 });
  const p = observePlayer(sources([barracks, hall, smith, farm, theirs]), 0).production;
  check("four jobs: one per queue head + the farm going up", p.length === 4, JSON.stringify(p.map((x) => x.name)));
  check("soonest first", p.map((x) => x.value).join(",") === "4,10,15,61", p.map((x) => x.value).join(","));
  check("research wears the RANK being researched", p[0].name === "Steel Forged Swords" && p[0].icon === "BTNThoriumMelee.blp");
  check("a tier is the target building's icon", p[3].name === "Keep");
  check("each points the camera at its building", p[1].simId === barracks.id && p[2].simId === farm.id);
}
{
  // Two Barracks a half-second apart, the LATER one first in the world's own order. On whole
  // seconds they tie every other half-second, and a tie fell back on that order — so the two
  // icons swapped places every second, and the one under the pointer changed its name with them.
  const late = building("hbar", [{ kind: "unit", unitId: "hfoo", timeLeft: 11.8, buildTime: 20 }]);
  const early = building("hbar", [{ kind: "unit", unitId: "hpea", timeLeft: 11.3, buildTime: 20 }]);
  const orders = new Set();
  for (let t = 0; t < 10; t += 0.25) {
    late.building.queue[0].timeLeft = 11.8 - t;
    early.building.queue[0].timeLeft = 11.3 - t;
    orders.add(observePlayer(sources([late, early]), 0).production.map((x) => x.name).join(","));
  }
  check("two jobs showing the same seconds never swap places as the clock ticks", orders.size === 1, [...orders].join(" | "));
}

console.log("\nthe ARMY: by type, largest first, never buildings, heroes or illusions");
{
  const us = [unit("hfoo"), unit("hfoo"), unit("hfoo"), unit("hpea"), unit("hfoo", { isIllusion: true }),
    unit("Hamg", { isHero: true }), building("hbar"), unit("hfoo", { owner: 1 }), unit("hpea", { hp: 0 })];
  const army = observePlayer(sources(us), 0).army;
  check("three Footmen, then one Peasant", army.length === 2 && army[0].name === "Footman" && army[0].value === 3 && army[1].value === 1,
    JSON.stringify(army.map((a) => [a.name, a.value])));
}

console.log("\nUPGRADES: at the reached rank");
{
  const ups = observePlayer(sources([], { research: () => [["Rhme", 3], ["Rxxx", 1], ["Rhme0", 0]] }), 0).upgrades;
  check("Mithril, at 3; an unknown id is skipped", ups.length === 1 && ups[0].name === "Mithril Forged Swords" && ups[0].value === 3);
}

console.log("\nthe bank, food and APM come from the sources as given");
{
  const v = observePlayer(sources([]), 0);
  check("gold/lumber/food/apm", v.gold === 500 && v.lumber === 150 && v.foodUsed === 23 && v.foodMax === 40 && v.apm === 77);
}

console.log("\nthe APM meter: a one-minute window of game time");
{
  const m = new ApmMeter();
  for (let t = 0; t < 30; t++) m.note(3, t + 0.5);
  check("30 actions in the first 30 s read as 60 APM", m.apm(3, 30) === 60, String(m.apm(3, 30)));
  check("the first action does not read as thousands", new ApmMeter().apm(0, 1) === 0);
  const one = new ApmMeter(); one.note(0, 1);
  check("…nor does one action at 1 s (floored span)", one.apm(0, 1) === 6, String(one.apm(0, 1)));
  check("a player who stops drops to 0 a minute later", m.apm(3, 95) === 0, String(m.apm(3, 95)));
  check("an unseen player is 0", m.apm(7, 50) === 0);
}

console.log("\nthe OBSERVER LANE rides a bench seat's payload and nobody else's");
{
  const { MatchLink } = require(join(REPO, ".sim-build", "src", "game", "matchLink.js"));
  const { decodeSnapshot } = require(join(REPO, ".sim-build", "src", "game", "snapshotWire.js"));
  const sent = [];
  const channel = { send: (msg, peer) => sent.push({ msg, peer }), onPeerData: null };
  // Host is seat 0 on peer 1; a player on peer 2; a watcher (seat 16) on peer 3.
  const link = new MatchLink(channel, 0, [{ id: 0, peer: 1 }, { id: 1, peer: 2 }, { id: 16, peer: 3 }], 1);
  const world = { units: new Map(), items: new Map(), mines: new Map(), stashOf: () => ({ gold: 0, lumber: 0 }) };
  const viewer = { seesFor: () => true, fogHides: () => false, fogBlocksClick: () => false, fogBlocksAt: () => false };
  const lane = [{ player: 0, gold: 500, lumber: 100, apm: 40, research: { Rhme: 1 }, fallen: [] }];
  link.tickHost(1, world, {
    viewers: () => [{ player: 0, viewer }, { player: 1, viewer }, { player: 16, viewer }],
    ghostsFor: () => [], commandsApplied: () => 0,
    watchedFor: (p) => (p === 16 ? lane : null),
  }, 5);
  const byPeer = new Map(sent.map((x) => [x.peer, decodeSnapshot(x.msg.snap)]));
  check("the player's payload carries no lane — nobody else's bank", byPeer.get(2) && byPeer.get(2).watched === undefined);
  const w = byPeer.get(3)?.watched;
  check("the watcher's does, whole, through the wire codec", !!w && w[0].gold === 500 && w[0].apm === 40 && w[0].research.Rhme === 1);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
