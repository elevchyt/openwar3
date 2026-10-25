// The MATCH LOG (docs/match-log.md): its writer's two limits (about 1 MB per file, nothing kept
// past three days — electron/logStore.mjs) and the recorder's reading of a world
// (src/game/matchLog.ts): the starting position is one line, not a flood of "built"/"trained";
// births, completions, upgrades, hero levels and research are events; deaths name the killer.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

(async () => {
  // ---------------------------------------------------------------------------- the store
  console.log("\n-- the writer: roll-over at the size cap, sweep at three days --------------------");
  const { createLogStore, MAX_BYTES, MAX_AGE_MS } = await import(join(REPO, "electron", "logStore.mjs"));
  check("the cap is about a megabyte", MAX_BYTES, 1024 * 1024);
  check("the age limit is three days", MAX_AGE_MS, 3 * 24 * 3600 * 1000);
  const dir = fs.mkdtempSync(join(os.tmpdir(), "ow3-matchlog-"));
  try {
    const store = createLogStore(dir, { maxBytes: 1000 });
    const { id, file } = store.begin("(2)EchoIsles.w3x");
    check("the file is named for the map", /_2-EchoIsles\.log$/.test(file), true);
    const line = "x".repeat(99) + "\n"; // 100 bytes
    for (let i = 0; i < 25; i++) store.append(id, line);
    const files = fs.readdirSync(dir).sort();
    check("2500 bytes at a 1000-byte cap is three files", files.length, 3);
    check("…each at most the cap (plus the continuation line)", files.every((f) => fs.statSync(join(dir, f)).size <= 1000 + 80), true);
    check("…and no line is split", files.every((f) => fs.readFileSync(join(dir, f), "utf8").split("\n").every((l) => l === "" || l.startsWith("#") || l.length === 99)), true);
    check("a part says what it continues", fs.readFileSync(join(dir, files.find((f) => f.includes(".part2."))), "utf8").startsWith("# continued from "), true);
    store.end(id);
    const old = join(dir, "2026-01-01_00-00-00_old.ndjson");
    fs.writeFileSync(old, "{}\n");
    const fourDays = (Date.now() - 4 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(old, fourDays, fourDays);
    const swept = store.sweep();
    check("a four-day-old file (a perf session too) is swept", [swept, fs.existsSync(old)], [1, false]);
    check("…and today's are kept", fs.readdirSync(dir).length, 3);
    const again = createLogStore(dir).begin("(2)EchoIsles.w3x");
    check("two matches in the same second get two files", again && again.file !== file, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------- the recorder
  console.log("\n-- the recorder: what a second of world becomes ----------------------------------");
  globalThis.window = {};
  globalThis.addEventListener = () => {};
  const { MatchLog, countList, clockText } = require(join(REPO, ".sim-build", "src", "game", "matchLog.js"));
  check("the clock reads mm:ss", clockText(125.7), "02:05");
  check("…and h:mm:ss past an hour", clockText(3725), "1:02:05");
  check("a count list is biggest first", countList(new Map([["hpea", 1], ["hfoo", 3]]), (id) => id), "3 hfoo, 1 hpea");

  let clock = 0;
  const units = new Map();
  const research = new Map();
  const world = {
    units, deathObserver: null,
    stashOf: () => ({ gold: 500, lumber: 150 }),
    tech: { researchedBy: (p) => (p === 0 ? research : new Map()) },
  };
  const unit = (o) => ({ id: units.size + 1, owner: 0, hp: 100, building: null, isHero: false, isPeon: false, isSummon: false, isIllusion: false, level: 0, properName: "", ...o });
  const add = (o) => { const u = unit(o); units.set(u.id, u); return u; };
  const written = [];
  const sink = { begin: async () => "id1", append: (_id, text) => written.push(...text.trim().split("\n")), end: async () => null };
  const NAMES = { htow: "Town Hall", hkee: "Keep", hpea: "Peasant", hfoo: "Footman", hbar: "Barracks", Hpal: "Paladin", ogru: "Grunt", Rhme: "Iron Forged Swords" };
  const log = new MatchLog(sink, {
    clock: () => clock, world: () => world,
    seats: () => [{ player: 0, name: "Red", race: "human", team: 0, controller: "human" }, { player: 1, name: "Blue", race: "orc", team: 1, controller: "Computer+ (Insane)" }],
    food: () => ({ used: 5, made: 12 }), nameOf: (id) => NAMES[id] ?? id, ai: () => [], pace: () => ({ fps: 60, speed: "Fast" }),
  });
  log.open("Echo Isles", { version: "test" });
  const hall = add({ typeId: "htow", building: { constructionLeft: 0 } });
  for (let i = 0; i < 5; i++) add({ typeId: "hpea", isPeon: true });
  log.update();
  clock = 1.2; log.update();
  clock = 2.5; log.update(); // past the start window
  const rax = add({ typeId: "hbar", building: { constructionLeft: 60 } });
  add({ typeId: "hfoo" }); add({ typeId: "hfoo" });
  const pal = add({ typeId: "Hpal", isHero: true, level: 1, properName: "Uther" });
  clock = 3.5; log.update();
  rax.building.constructionLeft = 0;
  hall.typeId = "hkee"; hall.building.constructionLeft = 30;
  pal.level = 2;
  research.set("Rhme", 1);
  const grunt = { id: 99, owner: 1, typeId: "ogru", hp: 100 };
  world.deathObserver(pal, grunt);
  clock = 4.5; log.update();
  const peasant = [...units.values()].find((u) => u.typeId === "hpea");
  world.deathObserver(peasant, grunt);
  world.deathObserver({ ...peasant, id: 50 }, grunt);
  clock = 5.5; log.update();
  log.close(["# result: test"]);
  await new Promise((r) => setTimeout(r, 0));
  const body = written.filter((l) => !l.startsWith("#"));
  const has = (re) => body.some((l) => re.test(l));
  check("the starting position is ONE line", body.filter((l) => /P0 starts with/.test(l)), ["[00:02] P0 starts with 5 Peasant, 1 Town Hall"]);
  check("…and nothing of it is 'built' or 'trained'", has(/\[00:0[01]\].*(built|trained)/), false);
  check("a building begun", has(/\[00:03\] P0 began Barracks/), true);
  check("units trained, summed", has(/\[00:03\] P0 trained 2 Footman/), true);
  check("a hero hired, by name", has(/\[00:03\] P0 hero Paladin "Uther" \(level 1\)/), true);
  check("a building finished", has(/\[00:04\] P0 built Barracks/), true);
  check("an upgrade under way", has(/\[00:04\] P0 Town Hall -> Keep \(upgrading\)/), true);
  check("a hero level", has(/\[00:04\] P0 Paladin reached level 2/), true);
  check("research", has(/\[00:04\] P0 researched Iron Forged Swords/), true);
  check("a hero's death names the killer", has(/P0 lost hero Paladin "Uther" \(level 2\) — killed by P1 Grunt/), true);
  check("soldiers' deaths are summed by killer", has(/\[00:05\] P0 lost 2 Peasant \(to P1\)/), true);
  check("STATUS blocks are written on close", body.some((l) => /STATUS P0 gold=500 lumber=150 food=5\/12/.test(l)), true);
  check("…and the closing lines", written.includes("# result: test"), true);
  check("the death hook is let go on close", world.deathObserver, null);

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})();
