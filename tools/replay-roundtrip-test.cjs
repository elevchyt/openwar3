// A REPLAY, round trip (issue #158, src/game/replay.ts): record a match's commands headlessly,
// write the file, read it back, re-simulate from the file alone, and compare the state check at
// every step it was taken.
//
// What this pins is the recorder, the file, the player and the check together with the property
// they all rest on — that a match is a function of its seed and its inputs. It is the sim-level
// half: no map script and no renderer (the scene's own ordering — the phases, the script pump —
// is checked live, docs/replays.md "Verified"). The match is two squads given orders by a seeded
// stream: attacks, moves, attack-moves, holds and stops, a share of them deliberately for units the
// sender does not own, which the authority REFUSES and the replay must refuse again.
//
// A test like this passes trivially on a world where nothing happens, and the first determinism
// test here did exactly that once. So it also asserts that the squads moved and fought, and that
// TAKING ONE COMMAND OUT of the file makes the checks fail — the checks have to be able to bite.
//
// Run: pnpm sim:test

const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const B = (...p) => require(join(REPO, ".sim-build", "src", ...p));
const { SimWorld } = B("sim", "world.js");
const { PathingGrid } = B("sim", "pathing.js");
const { Authority } = B("game", "authority.js");
const { ReplayRecorder, ReplayPlayer, encodeReplay, decodeReplay, REPLAY_FORMAT } = B("game", "replay.js");
const { stateHash, stateDump, diffDumps } = B("game", "replayHash.js");
const { StateTracker, expandStates, STATE_EVERY } = B("game", "replayState.js");
const { InputTracker, isInputSample } = B("game", "inputTrack.js");

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};

const SIM_DT = 1 / 60; // render/mapViewer.ts SIM_DT
const PRE = 1; // game/replay.ts Phase.Pre — a const enum, so its value is restated here
const STEPS = 3600; // one game minute
const CHECK_EVERY = 60;

// A footman's melee slot and body, as tools/sim-attack-order-test.cjs builds them: the live
// values AND their base* twins (recomputeStats re-derives one from the other every tick), sight
// wide enough that nothing here is a fog test, and `acquire` so a squad fights what walks up.
const WEAPON = () => ({
  enabled: true, targets: ["ground", "air", "structure"], ranged: false,
  damage: 12, baseDamage: 12, dice: 1, baseDice: 1, sides: 6,
  cooldown: 1.2, baseCooldown: 1.2, range: 90, baseRange: 90, rangeBuffer: 250,
  damagePoint: 0.4, baseDamagePoint: 0.4, backswing: 0.3, baseBackswing: 0.3,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 500, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

function grid() {
  const W = 64, H = 64;
  return new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
}

function addUnit(w, id, owner, x, y) {
  const weapons = [WEAPON()];
  w.add({
    id, owner, team: owner, typeId: "hfoo", x, y, facing: 0,
    hp: 420, maxHp: 420, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 2, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    castPoint: 0, castBackswing: 0,
    weapons, oldWeapons: weapons,
  });
}

/** Two squads of six, facing each other across open ground. */
function world(seed) {
  const w = new SimWorld(grid(), seed);
  for (let i = 0; i < 6; i++) {
    addUnit(w, 1 + i, 0, -600, -250 + i * 100);
    addUnit(w, 11 + i, 1, 600, -250 + i * 100);
  }
  const stub = { get: () => undefined };
  return { w, auth: new Authority(w, stub, stub, stub, stub) };
}

/** A small seeded stream for the ORDERS — not the sim's own, which the match draws from. */
function stream(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The commands a step's "players" give, drawn from the stream. */
function orders(rnd, w) {
  const out = [];
  if (rnd() > 0.06) return out;
  const n = 1 + Math.floor(rnd() * 3);
  const ids = [...w.units.keys()];
  for (let i = 0; i < n && ids.length; i++) {
    const unitId = ids[Math.floor(rnd() * ids.length)];
    const owner = w.units.get(unitId).owner;
    // One in eight is sent by the OTHER player: not theirs to order, so it is refused.
    const player = rnd() < 0.125 ? 1 - owner : owner;
    const x = Math.round((rnd() - 0.5) * 1400), y = Math.round((rnd() - 0.5) * 1000);
    const roll = rnd();
    // An ATTACK names its target: this fixture's units do not acquire on their own (see
    // tools/sim-determinism-test.cjs), and a match nobody is hurt in rolls no damage.
    const foes = ids.filter((id) => w.units.get(id).owner !== owner);
    const order = roll < 0.45 && foes.length ? { kind: "attack", targetId: foes[Math.floor(rnd() * foes.length)] }
      : roll < 0.6 ? { kind: "attackmove", x, y } : roll < 0.85 ? { kind: "move", x, y } : roll < 0.93 ? { kind: "hold" } : { kind: "stop" };
    out.push([player, { c: "order", unitId, order, queued: false }]);
  }
  return out;
}

const HEADER = {
  format: REPLAY_FORMAT, version: "test", recordedAt: "2026-01-01T00:00:00.000Z",
  map: { path: "test.w3x", name: "Test", hash: "0", size: 0 },
  config: { seed: 7 }, seats: [], localPlayer: 0, observer: false, edition: "tft", patch: "test",
};

(async () => {
  // ---- record --------------------------------------------------------------------------------
  const a = world(7);
  let t = 0;
  const rec = new ReplayRecorder(structuredClone(HEADER), () => ({ t, ph: PRE }));
  a.auth.onCommand = (player, cmd) => {
    const e = rec.push({ k: "cmd", p: player, cmd });
    return (took) => { if (!took) e.no = 1; };
  };
  const tracker = new StateTracker();
  a.w.deathTap = (v, k) => tracker.died(v, k);
  const rnd = stream(1234);
  const startAt = new Map([...a.w.units.values()].map((u) => [u.id, [u.x, u.y]]));
  let accepted = 0, refused = 0;
  for (t = 1; t <= STEPS; t++) {
    for (const [player, cmd] of orders(rnd, a.w)) a.auth.execute(player, cmd) ? accepted++ : refused++;
    a.w.tick(SIM_DT);
    if (t % CHECK_EVERY === 0) rec.check(t, stateHash(a.w), stateDump(a.w));
    if (t % STATE_EVERY === 0) rec.state(tracker.sample(a.w, t, { seenBy: (u) => (u.owner === 0 ? 1 : 2) }));
  }
  rec.inputs(0, "legacy", [["c", 10, 100, 200, 1650, 90], ["o", 12, "order:move", "smart"]]);
  rec.end({ ticks: STEPS, results: [] });
  const finalA = stateDump(a.w);

  // The run has to have been a match, not a still life.
  const travelled = [...a.w.units.values()].reduce((n, u) => n + Math.hypot(u.x - startAt.get(u.id)[0], u.y - startAt.get(u.id)[1]), 0);
  const hurt = [...a.w.units.values()].filter((u) => u.hp < 420).length + (12 - a.w.units.size);
  check(`the recorded match was played: ${accepted} orders taken, ${refused} refused`, accepted > 50 && refused > 3);
  check(`…its units moved (${Math.round(travelled)} world units in all)`, travelled > 3000);
  check(`…and fought (${hurt} of 12 hurt or dead)`, hurt >= 2);

  // ---- the file ------------------------------------------------------------------------------
  const bytes = await rec.finish();
  const replay = await decodeReplay(bytes);
  check("the file reads back with every input", replay.events.length === accepted + refused, `${replay.events.length} vs ${accepted + refused}`);
  check("…every refusal marked", replay.events.filter((e) => e.no === 1).length === refused);
  check("…every check", replay.checks.length === STEPS / CHECK_EVERY);
  check("…the state track", replay.states.length === STEPS / STATE_EVERY);
  check("…the input track", replay.inputs.length === 1 && replay.inputs[0].samples.length === 2 && replay.inputs[0].scheme === "legacy");
  check("…and its ending", replay.ending?.ticks === STEPS);
  console.log(`        ${bytes.length} bytes for ${STEPS / 60} game seconds`);

  // A section this reader does not know is skipped, not refused.
  const extra = new Uint8Array(bytes.length + 8 + 3);
  extra.set(bytes);
  extra.set([0x5a, 0x5a, 0x5a, 0x5a, 3, 0, 0, 0, 1, 2, 3], bytes.length);
  check("an unknown section is skipped", (await decodeReplay(extra)).events.length === replay.events.length);
  const newer = bytes.slice();
  newer[4] = (REPLAY_FORMAT + 1) & 0xff;
  check("a newer format is refused", await decodeReplay(newer).then(() => false, () => true));
  check("something that is not a replay is refused", await decodeReplay(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).then(() => false, () => true));
  // A non-finite number survives the JSON (an aura's Infinity would arrive as null).
  const inf = new ReplayRecorder(structuredClone(HEADER), () => ({ t: 1, ph: PRE }));
  inf.push({ k: "lock", unit: 1, secs: Infinity });
  check("a non-finite number survives the file", (await decodeReplay(await inf.finish())).events[0].secs === Infinity);

  // ---- play it back --------------------------------------------------------------------------
  const play = async (r) => {
    const b = world(r.header.config.seed);
    const player = new ReplayPlayer(r);
    let passed = 0;
    for (let s = 1; s <= STEPS; s++) {
      for (const e of player.take(s, PRE)) if (e.k === "cmd") b.auth.execute(e.p, e.cmd);
      b.w.tick(SIM_DT);
      if (s % CHECK_EVERY === 0 && player.verify(s, () => stateHash(b.w))) passed++;
    }
    return { b, player, passed };
  };
  const same = await play(replay);
  check(`played back, all ${replay.checks.length} checks pass`, same.player.divergedAt === null && same.passed === replay.checks.length,
    `parted at step ${same.player.divergedAt}: ${diffDumps(finalA, stateDump(same.b.w)).slice(0, 3).join(" | ")}`);
  check("…and the world ends exactly where the recording did", diffDumps(finalA, stateDump(same.b.w)).length === 0);
  check("…having used every input", same.player.done);

  // The checks must be able to FAIL: the same file with one accepted order taken out.
  const cut = structuredClone(replay);
  const at = cut.events.findIndex((e, i) => i > cut.events.length / 4 && e.k === "cmd" && !e.no && e.cmd.order.kind !== "stop");
  cut.events.splice(at, 1);
  const parted = await play(cut);
  check("with one order removed the checks fail", parted.player.divergedAt !== null, "the playback still matched every check");
  // …and a different seed is a different match.
  const reseeded = structuredClone(replay);
  reseeded.header.config.seed = 8;
  check("on another seed the checks fail", (await play(reseeded)).player.divergedAt !== null);

  // ---- the state track -----------------------------------------------------------------------
  let last = null;
  for (const s of expandStates(replay.states)) last = s;
  const live = [...a.w.units.values()];
  check("the state track's last picture is the world at the end",
    last.units.size === live.length && live.every((u) => {
      const row = last.units.get(u.id);
      return row && row[3] === Math.round(u.x) && row[4] === Math.round(u.y) && row[6] === Math.round(u.hp) && row[8] === u.order;
    }));
  check("…with the fog bits it was given", [...last.units.values()].every((row) => row[11] === (row[2] === 0 ? 1 : 2)));
  const deaths = replay.states.flatMap((s) => s.deaths ?? []);
  check(`…and every death, with its killer (${deaths.length})`, deaths.length === 12 - a.w.units.size && deaths.every((d) => d[5] > 0 && d[7] === 1 - d[2]));

  // ---- the input track -----------------------------------------------------------------------
  let now = 0;
  const it = new InputTracker(() => now);
  const cam = { x: 10, y: 20, distance: 1650, yaw: Math.PI / 2 };
  for (now = 0; now < 60; now++) it.tick(cam, [500, 500]);
  check("a camera and a cursor standing still are sampled once each", it.samples.length === 2);
  cam.x = 400;
  for (; now < 120; now++) it.tick(cam, [510 + now, 500]);
  check("…and at their own rates when they move", it.samples.filter((s) => s[0] === "c").length === 2 && it.samples.filter((s) => s[0] === "m").length === 11);
  it.selection([1, 2], "hfoo", () => "box");
  it.selection([1, 2], "hfoo", () => "box");
  it.group("set", "1", [1, 2]);
  it.command("order:move", "smart");
  check("a selection is recorded when it changes, with how it was made", it.samples.filter((s) => s[0] === "s").length === 1 && it.samples.find((s) => s[0] === "s")[2] === "box");
  check("every sample it makes is well-formed", it.samples.every(isInputSample));
  check("a malformed sample is refused", !isInputSample(["c", 1, "x", 2, 3, 4]) && !isInputSample(["z", 1, 2, 3]) && !isInputSample(["s", 1, "box", [1, "a"], ""]) && !isInputSample(null));
  const drained = it.drain();
  check("draining hands the samples over and empties the tracker", drained.length > 0 && it.samples.length === 0);

  console.log(failures ? `\nreplay round trip: ${failures} check(s) FAILED` : "\nreplay round trip: all checks passed");
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
