// Headless check of Computer+ on WarChasers (src/ai/plus/warchasers/, docs/warchasers-ai.md).
// Run: pnpm sim:test
//
// Pinned here, because each breaks silently in a running match:
//
//  1. **The party's orders are understood** — "wait", "lets wait", "back", "lets go", "follow me",
//     "attack", "hit them" — however they are typed ("wiat", "folow", "atack", "lets goo").
//  2. **Ordinary chat is not an order.** "im back", "what", "shop", "nice hit", "be right back" and
//     "im waiting" must never stop or send a computer, and a negation turns an order round.
//  3. **A computer is named** by any word of its hero's name ("optimus wait").
//  4. **Items are valued for the hero carrying them**: an intelligence hero rates Intelligence over
//     Strength and gives the Strength up first; nobody ever gives up an Ankh; a key is never ours.
//  5. **The hero picker's geometry**: eight pedestals, none of them on the aisle the wisp walks up.
//  6. **Heal requests are heard** ("heal me", "need heal", "hael pls", "heal optimus") and offers,
//     thanks and news are not ("i heal", "thanks for the heals", "im healing"); a lone "b" is back.
//  7. **The party's heals go to its heroes** (index.ts `healPass`, heal.ts), driven through
//     `WarChasersAi.tick` on a stub world: an allied hero below 65 % is healed, before a summon and
//     between fights only with three heals in the bank; a person who asks is answered and healed
//     the moment the heal is ready; and a summoner with a monster on it steps back behind its
//     Water Elemental.
//  8. **It rests for life, never for mana**, and never alone: with the party out of reach it
//     follows them instead of asking them to wait.
//  9. **Mumm-Rah's Sleep waits for 85 % mana**, so the bar is there for Frost Nova.
//
// Nothing here is Warcraft III's except what map.ts cites from the map itself.
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const chat = require(join(REPO, ".sim-build", "src", "ai", "plus", "warchasers", "chat.js"));
const items = require(join(REPO, ".sim-build", "src", "ai", "plus", "warchasers", "items.js"));
const map = require(join(REPO, ".sim-build", "src", "ai", "plus", "warchasers", "map.js"));
const heal = require(join(REPO, ".sim-build", "src", "ai", "plus", "warchasers", "heal.js"));
const { WarChasersAi } = require(join(REPO, ".sim-build", "src", "ai", "plus", "warchasers", "index.js"));
const ids = require(join(REPO, ".sim-build", "src", "ai", "ids.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}
const cmd = (s) => chat.readCommand(s)?.command ?? null;

// --- 1. orders -----------------------------------------------------------------------------------
const ORDERS = {
  wait: ["wait", "lets wait", "let's wait", "WAIT!!", "wiat", "waitt", "wai", "hold on", "hang on", "stop", "stay here", "one sec", "wait up", "hold"],
  back: ["back", "back!", "bakc", "bak", "go back", "fall back", "get back", "retreat", "retreet", "run", "get out"],
  go: ["lets go", "let's go", "lets goo", "letsgo", "go", "go go go", "gogo", "come on", "move", "push", "dont wait", "stop waiting", "no need to wait"],
  follow: ["follow me", "follow", "folow", "fallow me", "follwo", "come", "come back", "on me", "with me", "i lead", "im the leader"],
  attack: ["attack", "atack", "attak", "hit", "hit them", "hti them", "kill them", "get them", "charge", "fight"],
};
for (const [want, lines] of Object.entries(ORDERS)) for (const said of lines) check(`${JSON.stringify(said)} is ${want}`, cmd(said), want);
check("the last order in a line wins", cmd("wait... ok lets go"), "go");
check("dont go is a wait", cmd("dont go"), "wait");
check("stop attacking is a wait", cmd("stop attacking"), "wait");
check("follow me takes the lead", chat.readCommand("follow me"), { command: "follow", claimsLead: true });
check("follow does not", chat.readCommand("follow"), { command: "follow", claimsLead: false });

// --- 2. not orders -------------------------------------------------------------------------------
for (const said of [
  "im back", "be right back", "what", "shop", "yellow", "hollow", "no", "ok", "gg", "lol", "thanks", "good job", "the hut",
  "hot", "nice hit", "im waiting", "attacking now", "where are you going", "i need gold", "buy an ankh", "",
]) check(`${JSON.stringify(said)} is not an order`, cmd(said), null);
check("a typo is not a different word", chat.sounds("what", "wait"), false);
check("…but a slip of the finger is the word", chat.sounds("waot", "wait"), true);
check("a short word must be exact or swapped", chat.sounds("hot", "hit"), false);
check("…swapped", chat.sounds("hti", "hit"), true);

// --- 3. naming a computer ------------------------------------------------------------------------
check("named by the first word", chat.namesHero("optimus wait", "Optimus Primo"), true);
check("named by the second word", chat.namesHero("beast knight attack", "Beast Knight"), true);
check("named with a typo", chat.namesHero("megatron go", "Megotron X"), true);
check("named through the hyphen", chat.namesHero("mumm rah back", "Mumm-Rah"), true);
check("a line naming nobody names nobody", chat.namesHero("wait", "Optimus Primo"), false);
check("an order word is not a name", chat.namesHero("attack", "Assassin"), false);

// --- 4. items ------------------------------------------------------------------------------------
const lvl = (data) => ({ data });
const ABILITIES = new Map([
  ["AIs3", { code: "AIab", levelData: [lvl([0, 0, 3])] }], // +3 Strength
  ["AIi6", { code: "AIab", levelData: [lvl([0, 6, 0])] }], // +6 Intelligence
  ["AIa6", { code: "AIab", levelData: [lvl([6, 0, 0])] }], // +6 Agility
  ["AIat", { code: "AIat", levelData: [lvl([3])] }],
  ["AIrc", { code: "AIrc", levelData: [lvl([7, 500])] }],
  ["AIh2", { code: "AIhe", levelData: [lvl([500])] }],
]);
const def = (id, abilities, gold, extra = {}) => ({ id, abilities, gold, usable: false, powerup: false, droppable: true, ...extra });
const ITEMS = new Map([
  ["rst1", def("rst1", ["AIs3"], 100)],
  ["ciri", def("ciri", ["AIi6"], 400)],
  ["rag1", def("rag1", ["AIa6"], 400)],
  ["rat3", def("rat3", ["AIat"], 50)],
  ["ankh", def("ankh", ["AIrc"], 450)],
  ["IC17", def("IC17", [], 5000)],
  ["pghe", def("pghe", ["AIh2"], 400, { usable: true })],
  ["kymn", def("kymn", [], 200)],
  ["stwp", def("stwp", [], 350, { usable: true })],
]);
const eye = (primary, melee = false) => ({ ability: (id) => ABILITIES.get(id), primary, melee });
const INT = eye("INT");
const STR = eye("STR", true);
const item = (id) => ITEMS.get(id);
const v = (id, e) => items.itemValue(ITEMS.get(id), e);
check("an intelligence hero rates Intelligence over Strength", v("ciri", INT) > v("rst1", INT) + 10, true);
check("…and over Agility", v("ciri", INT) > v("rag1", INT), true);
check("a strength hero rates the other way", v("rst1", STR) > v("rst1", INT), true);
check("an Ankh is worth more than anything", v("ankh", INT), items.ANKH_VALUE);
check("…by what it does, whatever its id", items.isAnkh(def("xxxx", ["AIrc"], 0), (id) => ABILITIES.get(id)), true);
check("the map's Ankh of Reincarnation Deluxe is one", v("IC17", STR), items.ANKH_VALUE);
check("a key is never ours", v("kymn", STR), items.NOT_OURS);
const full = ["ankh", "rst1", "rag1", "rag1", "pghe", "pghe"].map((itemId) => ({ itemId }));
check("full belt: a Robe of the Magi replaces a Strength item for an intelligence hero",
  full[items.wantsItem(ITEMS.get("ciri"), full, item, INT)?.replace]?.itemId, "rst1");
check("…and the Ankh is never the slot given up", items.worstSlot(full, item, INT).itemId !== "ankh", true);
check("a strength hero does not swap its gauntlets for a robe", items.wantsItem(ITEMS.get("ciri"), ["ankh", "rst1", "rst1", "rst1", "rst1", "rst1"].map((itemId) => ({ itemId })), item, STR), null);
check("a key is not picked up", items.wantsItem(ITEMS.get("kymn"), [null, null], item, STR), null);
check("a free slot takes a gold trinket", items.wantsItem(ITEMS.get("stwp"), [{ itemId: "ankh" }, null], item, STR)?.replace, -1);
check("…a full belt does not throw an item away for one", items.wantsItem(ITEMS.get("stwp"), full, item, STR), null);
const ankhOnly = [{ itemId: "ankh" }, { itemId: "ankh" }, { itemId: "ankh" }, { itemId: "ankh" }, { itemId: "ankh" }, { itemId: "ankh" }];
check("nothing replaces a belt of Ankhs", items.wantsItem(ITEMS.get("ciri"), ankhOnly, item, INT), null);

// --- 5. the picker ---------------------------------------------------------------------------------
check("eight heroes", map.PICKS.length, 8);
check("eight different heroes", new Set(map.PICKS.map((p) => p.hero)).size, 8);
check("a skill order for every hero", map.PICKS.every((p) => (map.SKILLS[p.hero] ?? []).length === 4), true);
check("the aisle crosses no pedestal", map.PICKS.every((p) => map.PICK_AISLE_X < p.rect.minX || map.PICK_AISLE_X > p.rect.maxX), true);
check("the four hero seats", [...map.HERO_SEATS], [0, 1, 5, 6]);
check("recognised by its triggers", map.isWarChasersScript(new Set(map.WARCHASERS_SCRIPT_MARKERS)), true);
check("…all four of them", map.isWarChasersScript(new Set(map.WARCHASERS_SCRIPT_MARKERS.slice(1))), false);

// --- 6. heal requests ------------------------------------------------------------------------------
check('"b" is back', cmd("b"), "back");
check('"b!" is back', cmd("b!"), "back");
check('"plan b" is not', cmd("plan b"), null);
const asks = (s) => chat.readHealRequest(s) !== null;
for (const said of [
  "heal", "heal me", "hael", "hael me", "heal!", "heal me!", "Heal me please", "heal plz", "HEAL ME PLS", "heal pls", "need heal", "i need a heal", "can i get a heal", "healz", "hael", "heall me",
  "heals pls", "i need healing", "need hp", "hp pls", "low hp", "im low", "im low on health", "wait i need heal", "snake heal me",
]) check(`${JSON.stringify(said)} asks for a heal`, asks(said), true);
for (const said of [
  "i heal", "ill heal you", "i can heal", "heal you", "thanks for the heals", "dont heal me", "no need to heal", "i dont need heal",
  "im healing", "healing now", "the boss is low hp", "his hp", "help", "deal", "hell", "real", "wait", "im back", "",
]) check(`${JSON.stringify(said)} does not`, asks(said), false);
check("heal optimus is for Optimus", chat.readHealRequest("heal optimus pls")?.after, "optimus");
check("heal me is for the speaker", chat.readHealRequest("heal me")?.after, "");
check("…and the order in the same line is still read", cmd("wait i need heal"), "wait");
check("heal eta: the cooldown", heal.healEta({ mana: 300, manaRegen: 1 }, { ab: { cooldownLeft: 4 }, lvl: { cost: 65 } }), 4);
check("heal eta: the mana it is short of, at its regeneration", heal.healEta({ mana: 45, manaRegen: 2 }, { ab: { cooldownLeft: 0 }, lvl: { cost: 65 } }), 10);
check("heals in the bank", heal.healsInBank({ mana: 260 }, { lvl: { cost: 65 } }), 4);

// --- 7. the party's heals, on a stub world ------------------------------------------------------------
{
  const PERSON = 0;
  const COMPUTER = 1;
  const DUNGEON = map.DUNGEON;
  const lvlRow = (o = {}) => ({ area: 0, castRange: 800, cost: 65, cooldown: 5, duration: 0, heroDuration: 0, data: [200, NaN], buffs: [], summon: "", ...o });
  const ABILS = new Map([
    ["AHhb", { id: "AHhb", code: "AHhb", target: "unit", autocast: false, targetFlags: ["air", "ground", "organic", "notself", "vuln", "invu", "nonancient"], levelData: [lvlRow()] }],
    ["ANrf", { id: "ANrf", code: "ANrf", target: "point", autocast: false, targetFlags: ["ground", "enemy"], levelData: [lvlRow({ area: 200, cost: 75 })] }],
  ]);
  let nextId = 1;
  const unit = (o = {}) => ({
    id: nextId++, owner: DUNGEON, typeId: "nC00", x: 0, y: 0, radius: 16, hp: 500, maxHp: 500, mana: 0, maxMana: 0, manaRegen: 0,
    isHero: false, isPeon: false, isCreep: false, isSummon: false, isIllusion: false, hidden: false, vanished: false, invulnerable: false,
    invisible: false, neutralPassive: false, building: null, paused: false, stunned: false, silenced: false, morphT: 0, order: "idle",
    constructing: false, repair: false, immolation: "", altModel: false, altFormLeft: 0, reviveT: 0, skillPoints: 0, level: 1,
    race: "human", weapon: { range: 100, acquire: 500, cooldown: 1.5 }, weapons: [], abilities: [], buffs: [], inventory: [], speed: 300,
    targetId: 0, summonLeft: 0, illusionOf: 0, ...o,
  });
  const snake = (o = {}) => unit({
    owner: COMPUTER, typeId: "EC12", isHero: true, hp: 700, maxHp: 700, mana: 300, maxMana: 400, manaRegen: 1, weapon: { range: 600, acquire: 600, cooldown: 1.5 },
    abilities: [{ id: "AHhb", code: "AHhb", level: 1, cooldownLeft: 0, autocastOn: false }, { id: "ANrf", code: "ANrf", level: 1, cooldownLeft: 0, autocastOn: false }], ...o,
  });
  const optimus = (o = {}) => unit({ owner: PERSON, typeId: "HC07", isHero: true, hp: 1000, maxHp: 1000, x: 300, ...o });

  /** One WarChasers match on a stub world: `ticks` seconds of passes, and the commands and lines it produced. */
  function match(units, { difficulty = ids.MELEE_INSANE, seconds = 1, before, lines = [] } = {}) {
    const cmds = [];
    const said = [];
    const world = {
      units: new Map(units.map((u) => [u.id, u])),
      items: new Map(),
      stashOf: () => ({ gold: 0, lumber: 0 }),
      techMeets: () => true,
      targsAdmit: () => true,
      canWalkTo: () => true,
      castUseError: (id, code) => {
        const u = world.units.get(id);
        const ab = u?.abilities.find((a) => a.code === code);
        if (!ab) return "Notthisunit";
        if (ab.cooldownLeft > 0) return "Cooldown";
        return u.mana < ABILS.get(ab.id).levelData[0].cost ? "Nomana" : null;
      },
      // Holy Light's polarity and "Unable to target self.", the two refusals the heal pass must respect.
      targetError: (caster, t, flags, code) => (t === caster ? "Notself" : code === "AHhb" && (t.race === "undead" || t.owner === DUNGEON) ? "Holybolttarget" : null),
      castError: (id, code, targetId) => {
        const use = world.castUseError(id, code);
        if (use || !targetId) return use;
        return world.targetError(world.units.get(id), world.units.get(targetId), [], code);
      },
    };
    const allied = (a, b) => (a === PERSON || a === COMPUTER) && (b === PERSON || b === COMPUTER);
    const host = {
      world,
      abilities: ABILS,
      items: new Map(),
      tech: { get: () => ({ sellitems: [] }) },
      registry: new Map([["EC12", { primaryAttr: "AGI" }], ["UC13", { primaryAttr: "STR" }]]),
      coAllied: allied,
      visible: () => true,
      execute: (player, cmd) => {
        cmds.push({ player, ...cmd });
        // A cast lands at once here: its mana and its cooldown are paid, as `tickCast` pays them.
        const u = cmd.c === "cast" ? world.units.get(cmd.unitId) : null;
        const ab = u?.abilities.find((a) => a.code === cmd.code);
        if (ab) {
          const row = ABILS.get(ab.id).levelData[0];
          ab.cooldownLeft = row.cooldown;
          u.mana -= row.cost;
        }
        return true;
      },
      say: (player, text) => said.push({ player, text }),
    };
    const ai = new WarChasersAi(host);
    ai.add(COMPUTER, difficulty, 7);
    // Seated and picked: skip the pick delay.
    ai.brains[0].heroId = units.find((u) => u.owner === COMPUTER && u.isHero)?.id ?? 0;
    before?.(ai, world);
    for (const text of lines) ai.heard({ from: PERSON, text }, [PERSON, COMPUTER]);
    const dt = 0.05;
    for (let t = 0; t < seconds; t += dt) {
      for (const u of world.units.values()) for (const ab of u.abilities) ab.cooldownLeft = Math.max(0, ab.cooldownLeft - dt);
      ai.tick(dt);
    }
    return { cmds, said, casts: cmds.filter((c) => c.c === "cast") };
  }

  {
    const s = snake();
    const o = optimus({ hp: 500 });
    const r = match([s, o]);
    check("an allied hero at 50 % is Holy Lit, between fights, with four heals in the bank", r.casts[0]?.targetId, o.id);
  }
  {
    const s = snake();
    const o = optimus({ hp: 700 });
    check("…a hero at 70 % is not", match([s, o]).casts.filter((c) => c.code === "AHhb").length, 0);
  }
  {
    const s = snake({ mana: 100 });
    const o = optimus({ hp: 500 });
    check("short of mana, a hero between fights is left to rest", match([s, o]).casts.length, 0);
    const s2 = snake({ mana: 100 });
    const o2 = optimus({ hp: 500 });
    const ghoul = unit({ x: 450, targetId: o2.id });
    check("…and healed the moment it is in a fight", match([s2, o2, ghoul]).casts[0]?.targetId, o2.id);
  }
  {
    const s = snake({ mana: 150 });
    const o = optimus({ hp: 600 });
    const elemental = unit({ owner: COMPUTER, typeId: "hwat", isSummon: true, summonLeft: 40, hp: 100, maxHp: 600, x: -200 });
    const ghoul = unit({ x: 450, targetId: o.id });
    const r = match([s, o, elemental, ghoul]);
    check("the hero before the healer's own Water Elemental", r.casts.find((c) => c.code === "AHhb")?.targetId, o.id);
    const s2 = snake({ mana: 150 });
    const o2 = optimus({ hp: 900 });
    const el2 = unit({ owner: COMPUTER, typeId: "hwat", isSummon: true, summonLeft: 40, hp: 100, maxHp: 600, x: -200 });
    const g2 = unit({ x: 450, targetId: el2.id });
    check("…and short of mana, not on the Water Elemental at all", match([s2, o2, el2, g2]).casts.filter((c) => c.code === "AHhb").length, 0);
  }
  {
    const s = snake({ mana: 400 });
    s.abilities[0].cooldownLeft = 3;
    const o = optimus({ hp: 900 });
    const r = match([s, o], { lines: ["heal me pls"], seconds: 4 });
    check("a person asks: it answers with how long", r.said.some((l) => /heal .*3/.test(l.text)), true);
    check("…and heals them the moment the cooldown is up, at 90 %", r.casts.find((c) => c.code === "AHhb")?.targetId, o.id);
    check("…not before", r.casts.filter((c) => c.code === "AHhb").length, 1);
  }
  {
    const s = snake({ mana: 400 });
    s.abilities[0].cooldownLeft = 30;
    const o = optimus({ hp: 600 });
    const r = match([s, o], { lines: ["heal"], seconds: 1 });
    check("…a heal 30 seconds away is not promised, and it says why", r.said.some((l) => /cooldown|cd/.test(l.text)), true);
  }
  {
    const s = snake({ mana: 100, manaRegen: 2 });
    s.abilities[0].cooldownLeft = 2;
    const o = optimus({ hp: 900 });
    const ghouls = [0, 1, 2].map((i) => unit({ x: 300 + i * 40, y: 300, race: "undead", targetId: s.id }));
    const r = match([s, o, ...ghouls], { lines: ["heal me"], seconds: 1.5 });
    check("a promised heal keeps its mana: no Rain of Fire that would leave too little for it", r.casts.filter((c) => c.code === "ANrf").length, 0);
  }
  {
    const s = snake({ mana: 400 });
    const o = optimus({ hp: 600, race: "undead" });
    const r = match([s, o], { lines: ["heal me"], seconds: 1 });
    check("an undead hero asking a Holy Light is told it cannot", r.said.some((l) => /cant/.test(l.text)), true);
  }
  {
    // KITING: a Beast Knight with its Water Elemental beside the Ghoul that is on him.
    const bk = unit({ owner: COMPUTER, typeId: "UC13", isHero: true, hp: 900, maxHp: 1000, x: 0 });
    const o = optimus({ x: -300 });
    const el = unit({ owner: COMPUTER, typeId: "hwat", isSummon: true, summonLeft: 40, hp: 600, maxHp: 600, x: 150, y: 120 });
    const ghoul = unit({ x: 100, targetId: bk.id, order: "attack" });
    const r = match([bk, o, el, ghoul], { seconds: 1 });
    const step = r.cmds.find((c) => c.c === "order" && c.order.kind === "move");
    check("a summoner with a monster on it steps back", !!step, true);
    check("…away from the monster", step && step.order.x < bk.x, true);
    const bk2 = unit({ owner: COMPUTER, typeId: "UC13", isHero: true, hp: 900, maxHp: 1000, x: 0 });
    const o2 = optimus({ x: -300 });
    const g2 = unit({ x: 100, targetId: bk2.id, order: "attack" });
    const r2 = match([bk2, o2, g2], { seconds: 1 });
    check("…and with no summon to take it, it fights", r2.cmds.some((c) => c.c === "order" && c.order.kind === "attack" && c.order.targetId === g2.id), true);
    const bk3 = unit({ owner: COMPUTER, typeId: "UC13", isHero: true, hp: 900, maxHp: 1000, x: 0 });
    const o3 = optimus({ x: -300 });
    const el3 = unit({ owner: COMPUTER, typeId: "hwat", isSummon: true, summonLeft: 40, hp: 600, maxHp: 600, x: 150, y: 120 });
    const g3 = unit({ x: 100, targetId: bk3.id, order: "attack" });
    const r3 = match([bk3, o3, el3, g3], { seconds: 1, difficulty: ids.MELEE_NEWBIE });
    check("…an easy computer never kites", r3.cmds.some((c) => c.c === "order" && c.order.kind === "move"), false);
  }
  {
    // RESTING is for life alone: an intelligence hero with an empty bar walks on with the party.
    const mumm = (o = {}) => unit({ owner: COMPUTER, typeId: "UC11", isHero: true, hp: 700, maxHp: 700, mana: 10, maxMana: 500, x: 0, ...o });
    let ai;
    match([mumm(), optimus({ x: 200 })], { seconds: 1, before: (a) => { ai = a; } });
    check("out of mana, it does not stop to rest", ai.brains[0].resting, null);
    // Hurt, with the party far off: it gives the rest up and goes after them.
    const m2 = mumm({ hp: 150, mana: 500 });
    const far = optimus({ x: 4000 });
    let ai2;
    const r2 = match([m2, far], { seconds: 1.5, before: (a) => { ai2 = a; } });
    check("hurt, with the party out of reach, it does not rest alone", ai2.brains[0].resting, null);
    check("…it follows them", r2.cmds.some((c) => c.c === "order" && c.order.kind === "follow" && c.order.targetId === far.id), true);
    check("…without asking them to wait", r2.said.some((l) => /wait|hold on|sec/.test(l.text)), false);
    // Hurt with the party beside it: it rests.
    let ai3;
    match([mumm({ hp: 150, mana: 500 }), optimus({ x: 300 })], { seconds: 1, before: (a) => { ai3 = a; } });
    check("…and with the party beside it, it rests", ai3.brains[0].resting, "hp");
  }
  {
    // SLEEP beside FROST NOVA waits for a near-full bar (index.ts `holds`).
    const kit = [{ id: "AUsl", code: "AUsl", level: 1, cooldownLeft: 0 }, { id: "AUfn", code: "AUfn", level: 1, cooldownLeft: 0 }];
    const m = unit({ owner: COMPUTER, typeId: "UC11", isHero: true, mana: 400, maxMana: 500, abilities: kit });
    let ai;
    match([m, optimus()], { seconds: 0.05, before: (a) => { ai = a; } });
    check("at 80 % mana Mumm-Rah holds Sleep", ai.holds(ai.brains[0], m, "AUsl"), true);
    m.mana = 450;
    check("…at 90 % it may sleep", ai.holds(ai.brains[0], m, "AUsl"), false);
    m.mana = 100;
    check("…and Frost Nova is never held for it", ai.holds(ai.brains[0], m, "AUfn"), false);
  }
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall WarChasers AI checks passed");
