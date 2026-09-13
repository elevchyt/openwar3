// Headless check of Computer+ on Extreme Candy War (src/ai/plus/candy/, docs/candy-war-ai.md).
// Run: pnpm sim:test
//
// Pinned here, because each breaks silently in a running match:
//
//  1. **Its own lines are not calls.** Every line a Candy War hero says goes out on the channel the
//     other computers on its team are listening to. A "falling back" read as "back!" pulls the whole
//     team out of its lanes; a "can't join, i'm dead" read as a rally is answered by the next one.
//  2. **A person's calls are understood** — help, a rally with a lane, a call to fall back, a lane
//     claim — however they are typed.
//  3. **A hero is named and resolved** by class and given name, and a word two heroes answer to names
//     neither.
//  4. **Every class build is LEGAL** under the map's own slot triggers (one weapon, one armour, two
//     accessories, one artifact, the sapper lists), so nothing bought is ever destroyed and refunded.
//  5. **The lane geometry** round-trips, and the map is recognised by its script.
//
// Nothing here is Warcraft III's except what map.ts cites from the map itself.
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const chat = require(join(REPO, ".sim-build", "src", "ai", "plus", "candy", "chat.js"));
const map = require(join(REPO, ".sim-build", "src", "ai", "plus", "candy", "map.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}
const kind = (s) => chat.readCandyCall(s)?.kind ?? null;

// --- 1. its own vocabulary ---------------------------------------------------------------------
const name = chat.heroCallName("|cffffaa00Undead Warlock|r", "");
const news = [
  ...["top", "mid", "bot"].flatMap((l) => chat.laneSwitchLines(l)),
  ...chat.SELF_BACK_LINES, ...chat.DEATH_LINES, ...chat.killLines(name), ...chat.banterLines(name),
  ...chat.GOOD_SPORT_LINES, ...chat.warnLines(3, "mid"), ...chat.warnLines(2, null), ...chat.followLines(name),
  ...chat.CANDY_COMING_LINES, ...Object.values(chat.CANDY_BUSY_LINES).flat(),
  ...chat.CANDY_RALLY_YES_LINES, ...Object.values(chat.CANDY_RALLY_NO_LINES).flat(),
  ...Object.values(chat.LANE_LINES).flat(),
];
for (const said of news) {
  const c = chat.readCandyCall(said);
  const call = !!c && (c.kind === "help" || c.kind === "retreat" || (c.kind === "rally" && c.ask));
  check(`its own line is not a call: ${JSON.stringify(said)}`, call, false);
}
// The answers read as answers, so nothing ever answers them.
for (const said of [...chat.CANDY_COMING_LINES, ...Object.values(chat.CANDY_BUSY_LINES).flat(), ...chat.CANDY_RALLY_YES_LINES, ...Object.values(chat.CANDY_RALLY_NO_LINES).flat()]) {
  check(`an answer reads as an answer: ${JSON.stringify(said)}`, kind(said), "answer");
}
// A lane announcement is a lane claim, and names its own lane.
for (const [lane, lines] of Object.entries(chat.LANE_LINES)) {
  for (const said of lines) check(`"${said}" claims ${lane}`, chat.readCandyCall(said), { kind: "lane", lane });
}
// The call to the TEAM to fall back is the one line of its own that IS a call.
for (const said of chat.TEAM_BACK_LINES) check(`a team call to fall back: ${JSON.stringify(said)}`, kind(said), "retreat");
// Every engage line names the hero it is about, so the caller resolves it to an engage.
const heroes = [
  { id: 1, typeName: "|cffffaa00Undead Warlock|r", properName: "" },
  { id: 2, typeName: "Human Mage", properName: "Boogie" },
  { id: 3, typeName: "Troll Mage", properName: "" },
];
for (const said of chat.engageLines(name)) {
  check(`an engage names its hero: ${JSON.stringify(said)}`, chat.namedHero(said, heroes), 1);
  check(`…and is an engage-shaped line: ${JSON.stringify(said)}`, kind(said), "rally");
}

// --- 2. a person's calls -----------------------------------------------------------------------
check("help", chat.readCandyCall("HELP!!"), { kind: "help", lane: null });
check("help top", chat.readCandyCall("help top"), { kind: "help", lane: "top" });
check("need help bottom", chat.readCandyCall("need help bottom"), { kind: "help", lane: "bot" });
check("attack", chat.readCandyCall("attack"), { kind: "rally", lane: null, ask: true });
check("lets push mid", chat.readCandyCall("lets push mid"), { kind: "rally", lane: "mid", ask: true });
check("let's go top", chat.readCandyCall("let's go top"), { kind: "rally", lane: "top", ask: true });
check("push bot", chat.readCandyCall("push bot"), { kind: "rally", lane: "bot", ask: true });
for (const said of ["back", "back!", "retreat", "fall back", "guys back off", "run"]) check(`fall back: ${JSON.stringify(said)}`, kind(said), "retreat");
for (const said of ["falling back", "backing off, low hp", "im back"]) check(`not a call to fall back: ${JSON.stringify(said)}`, kind(said) === "retreat", false);
check("im going top", chat.readCandyCall("im going top"), { kind: "lane", lane: "top" });
check("mid is mine", chat.readCandyCall("mid is mine"), { kind: "lane", lane: "mid" });
check("i'll take bottom", chat.readCandyCall("i'll take bottom"), { kind: "lane", lane: "bot" });
check("glhf is nothing", chat.readCandyCall("glhf"), null);

// --- 3. naming a hero --------------------------------------------------------------------------
check("the hero's name, markup stripped", chat.heroCallName("|cffffaa00Orc Warlock|r", ""), "Orc Warlock");
check("the hero's name only, never the given one", chat.heroCallName("Undead Priest", "Boogie Kid"), "Undead Priest");
check("a nameless type falls back on the given name", chat.heroCallName("", "Boogie Kid"), "Boogie Kid");
check("an engage names the hero and nothing else", chat.engageLines(chat.heroCallName("Undead Priest", "Boogie Kid")).every((l) => l.includes("Undead Priest") && !/boogie| the undead/i.test(l)), true);
check("by given name", chat.namedHero("focus boogie", heroes), 2);
check("by whole class", chat.namedHero("kill the troll mage", heroes), 3);
check("by last word", chat.namedHero("attack the warlock", heroes), 1);
check("a word two heroes answer to names neither", chat.namedHero("kill the mage", heroes), 0);
check("no hero named", chat.namedHero("lets push mid", heroes), 0);

// --- 4. the builds -----------------------------------------------------------------------------
const CLASSES = ["warrior", "mage", "rogue", "warlock", "shaman", "hunter", "priest", "druid", "paladin"];
function legal(cls, list) {
  const held = [];
  for (const id of list) {
    if (!map.mayCarry(cls, held, id)) return `${id} after ${held.join(",") || "nothing"}`;
    held.push(id);
  }
  return true;
}
for (const cls of CLASSES) {
  check(`${cls}: its build is legal`, legal(cls, map.BUILDS[cls]), true);
  check(`${cls}: the cheap build is legal`, legal(cls, map.CHEAP_BUILD), true);
  check(`${cls}: four skills, all different`, new Set(map.SKILLS[cls]).size, 4);
  for (const id of map.BUILDS[cls]) check(`${cls}: a shop sells ${id}`, typeof map.SHOP_OF[id], "string");
}
check("a sapper may not carry Paleth's Visage", map.mayCarry("warrior", [], "mcou"), false);
check("only a sapper may carry the Pink Pill", map.mayCarry("mage", [], "pams"), false);
check("…and a sapper may", map.mayCarry("rogue", [], "pams"), true);
check("one weapon", map.mayCarry("warrior", ["rat6"], "ratc"), false);
check("two accessories", map.mayCarry("mage", ["I003", "lgdh"], "penr"), false);
check("one artifact (a weapon that is also one)", map.mayCarry("hunter", ["axas"], "modt"), false);
check("Skibi's Pendant has no slot", map.mayCarry("warrior", ["rat6", "rst1", "bspd", "penr"], "belv"), true);
for (const id of [map.POTION, ...map.TEAM_UPGRADES]) check(`a shop sells ${id}`, typeof map.SHOP_OF[id], "string");

// --- 5. the lanes and the map ------------------------------------------------------------------
for (const lane of ["top", "mid", "bot"]) {
  const len = map.laneLength(lane);
  for (const t of [0, len * 0.25, len * 0.5, len * 0.9]) {
    const back = map.project(lane, map.pointAt(lane, t)).t;
    check(`${lane}: pointAt/project round-trip at ${Math.round(t)}`, Math.abs(back - t) < 1, true);
  }
}
check("the middle lane's centre is mid", map.laneOf({ x: -16, y: -2560 }), "mid");
check("the north lane's centre is top", map.laneOf({ x: -64, y: 2128 }), "top");
check("the south lane's centre is bot", map.laneOf({ x: -160, y: -6512 }), "bot");
check("the hero pick is on no lane", map.laneOf({ x: 7000, y: -8400 }), null);
check("recognised by its triggers", map.isCandyWarScript(new Set(map.CANDY_SCRIPT_MARKERS)), true);
check("…all four of them", map.isCandyWarScript(new Set(map.CANDY_SCRIPT_MARKERS.slice(1))), false);
check("seat 0 is the Horde", map.sideOf(0)?.name, "horde");
check("seat 6 is the Alliance", map.sideOf(6)?.name, "alliance");
check("the Horde's army seat is nobody's hero", map.sideOf(5), null);
check("the Alliance's army seat is nobody's hero", map.sideOf(11), null);
check("the Horde walks east", map.HORDE.forward, 1);

// --- 6. a match, on a stub host ----------------------------------------------------------------
// The brain against a world of plain unit records: it has to PICK (two selections of one costume,
// and the stub plays the map's `Pick_Heroes` by creating the hero), learn, say its lane and walk out,
// go for an enemy hero standing next to it, answer a call for help and a rally, and walk its ghost
// back to its corpse and press the revive. What is checked is that each of those happens at all and
// nothing throws — the numbers are the profile's and are not what this pins.
{
  const { CandyWarAi } = require(join(REPO, ".sim-build", "src", "ai", "plus", "candy", "index.js"));
  const { MELEE_NEWBIE, MELEE_NORMAL, MELEE_INSANE } = require(join(REPO, ".sim-build", "src", "ai", "ids.js"));
  for (const [label, difficulty] of [["easy", MELEE_NEWBIE], ["normal", MELEE_NORMAL], ["insane", MELEE_INSANE]]) {
    let nextId = 1;
    const units = new Map();
    const unit = (over) => {
      const u = {
        id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, hp: 100, maxHp: 100, mana: 0, maxMana: 0, radius: 16,
        isHero: false, isIllusion: false, building: null, weapon: null, invulnerable: false, invisible: false, vanished: false,
        paused: false, abilities: [], buffs: [], inventory: [], order: "idle", targetId: null, pendingCast: null, prevX: 0, prevY: 0,
        level: 1, str: 22, agi: 20, int: 22, skillPoints: 0, properName: "", stunned: false, ...over,
      };
      units.set(u.id, u);
      return u;
    };
    const heroOf = (typeId, owner, at, over = {}) => unit({
      typeId, owner, x: at.x, y: at.y, prevX: at.x, prevY: at.y, isHero: true, hp: 600, maxHp: 600, mana: 400, maxMana: 400, level: 3,
      weapon: { damage: 30, dice: 1, sides: 6, cooldown: 2, range: 550 },
      abilities: (map.SKILLS[map.HERO_CLASS[typeId]] ?? []).map((id) => ({ id, code: id, level: 0, cooldownLeft: 0, autocastOn: false })),
      inventory: [{ id: 0, itemId: "shas" }, { id: 0, itemId: "stwp" }, null, null, null, null], ...over,
    });
    // The costume rack, both sides.
    for (const [t, x, y] of [["Ucrl", -7010, -8295], ["Nklj", -6549, -8472], ["Ulic", -7140, -8474], ["Usyl", -6852, -8471], ["Oshd", -6707, -8296]]) {
      unit({ typeId: t, owner: 5, x, y, isHero: true });
    }
    for (const [t, x, y] of [["Hjai", 6705, -8580], ["Hpal", 7131, -8445]]) unit({ typeId: t, owner: 11, x, y, isHero: true });
    for (const [lane, t] of Object.entries(map.MONSTERS)) {
      const at = map.pointAt(lane, map.laneLength(lane) / 2);
      unit({ typeId: t, owner: 15, x: at.x, y: at.y, invulnerable: true });
    }
    for (const t of Object.values(map.HORDE.mages)) unit({ typeId: t, owner: 5, x: -5600, y: 0 });
    for (const t of Object.values(map.ALLIANCE.mages)) unit({ typeId: t, owner: 11, x: 6300, y: 0 });
    unit({ typeId: "unp2", owner: 5, x: -5888, y: -64, building: {}, invulnerable: true });
    unit({ typeId: "hcas", owner: 11, x: 6656, y: 0, building: {}, invulnerable: true });
    unit({ typeId: "nfnp", owner: 5, ...map.HORDE.fountain, building: {} });
    unit({ typeId: "usap", owner: 5, x: -7872, y: 448, building: {}, invulnerable: true });
    const commands = [];
    const lines = [];
    const selects = [];
    const kills = [];
    const stash = { gold: 5000, lumber: 0 };
    const host = {
      world: {
        units,
        castError: () => null,
        stashOf: () => stash,
        shopReaches: (shopId, unitId) => Math.hypot(units.get(shopId).x - units.get(unitId).x, units.get(shopId).y - units.get(unitId).y) < 500,
      },
      registry: { get: (t) => ({ name: t === "Hjai" ? "Human Mage" : "Some Hero" }) },
      abilities: { get: (id) => ({ id, code: id, levels: 3, levelData: [{ cost: 50, castRange: 600 }, { cost: 50, castRange: 600 }, { cost: 50, castRange: 600 }] }) },
      items: { get: () => ({ gold: 400 }) },
      coAllied: (a, b) => (a <= 5) === (b <= 5),
      visible: () => true,
      foodCeiling: () => 100,
      say: (player, text, scope) => lines.push({ player, text, scope: scope ?? "all" }),
      execute: (player, cmd) => {
        commands.push({ player, ...cmd });
        const u = units.get(cmd.unitId);
        if (cmd.c === "order" && u) { u.order = cmd.order.kind === "attack" ? "attack" : cmd.order.kind; u.targetId = cmd.order.targetId ?? null; }
        if (cmd.c === "learnskill" && u) {
          const ab = u.abilities.find((a) => a.id === cmd.abilityId);
          if (!ab || u.skillPoints <= 0 || ab.level >= 3) return false;
          ab.level++; u.skillPoints--;
        }
        return true;
      },
      select: (player, unitId) => {
        selects.push(unitId);
        // The map's `Pick_Heroes`: the SECOND selection of the same costume hands out the hero.
        if (selects.length >= 2 && selects[selects.length - 1] === selects[selects.length - 2]) {
          heroOf(units.get(unitId).typeId, player, map.HORDE.spawn, { skillPoints: 3 });
        }
      },
      scriptBool: () => true,
      heroKills: () => kills,
    };
    const ai = new CandyWarAi(host);
    ai.add(0, difficulty, 7);
    const run = (seconds) => { for (let t = 0; t < seconds; t += 0.1) ai.tick(0.1); };
    run(30);
    const hero = [...units.values()].find((u) => u.owner === 0 && u.isHero);
    check(`${label}: it picked a hero through two selections`, !!hero && selects.length === 2, true);
    check(`${label}: it learned a skill`, !!hero && hero.abilities.some((a) => a.level > 0), true);
    check(`${label}: it greeted`, lines.some((l) => l.scope === "all"), true);
    // Out of the shopping area, it says its lane and walks.
    hero.x = -5200; hero.y = -300;
    run(3);
    check(`${label}: it said its lane to its allies`, lines.some((l) => l.scope === "allies" && chat.readCandyCall(l.text)?.kind === "lane"), true);
    check(`${label}: it gave its hero an order`, commands.some((c) => c.c === "order" && c.unitId === hero.id), true);
    // An enemy hero, hurt, right in front of it.
    const foe = heroOf("Hjai", 6, { x: hero.x + 300, y: hero.y }, { hp: 150, maxHp: 600 });
    run(4);
    check(`${label}: it went for the hurt enemy hero`, commands.some((c) => (c.c === "order" && c.order.targetId === foe.id) || (c.c === "cast" && c.targetId === foe.id)), true);
    units.delete(foe.id);
    // An ally asks for help, and then calls a push.
    heroOf("Nklj", 3, { x: hero.x + 800, y: hero.y });
    const before = lines.length;
    ai.heard({ from: 3, text: "help mid", target: { scope: "allies" } }, [0, 1, 2, 3, 4, 5]);
    run(3);
    check(`${label}: it answered the call for help`, lines.slice(before).some((l) => l.scope === "allies" && l.player === 0), true);
    const beforeRally = lines.length;
    run(25); // past the answer gap
    ai.heard({ from: 3, text: "lets push top", target: { scope: "allies" } }, [0, 1, 2, 3, 4, 5]);
    run(3);
    check(`${label}: it answered the rally`, lines.slice(beforeRally).some((l) => l.scope === "allies" && chat.readCandyCall(l.text)?.kind === "answer"), true);
    // It dies: the corpse goes to Neutral Passive, a ghost appears beside it, and the revive is offered.
    kills.push({ seq: 1, victimId: hero.id, victimOwner: 0, victimType: hero.typeId, victimName: "", killerId: 0, killerOwner: 6 });
    hero.owner = 15; hero.paused = true;
    run(1);
    const ghost = unit({ typeId: "owyv", owner: 0, x: hero.x + 900, y: hero.y, invulnerable: true, invisible: true, abilities: [] });
    run(2);
    check(`${label}: it walked its ghost`, commands.some((c) => c.c === "order" && c.unitId === ghost.id), true);
    ghost.x = hero.x + 100;
    ghost.abilities.push({ id: map.REVIVE_CORPSE, code: map.REVIVE_CORPSE, level: 1, cooldownLeft: 0 });
    run(2);
    check(`${label}: it pressed the revive at its corpse`, commands.some((c) => c.c === "cast" && c.unitId === ghost.id && c.code === map.REVIVE_CORPSE), true);
  }
}

console.log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);
