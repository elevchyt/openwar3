// Headless check of Computer+ on Azeroth Grand Prix (src/ai/plus/grandprix/, docs/grand-prix-ai.md).
// Run: pnpm sim:test
//
// The race is REAL: tools/grandprix-harness.cjs boots the map's own `war3map.j` in the real
// interpreter over a real SimWorld on the map's own terrain, and eight Computer+ seats are handed
// exactly what the scene hands them — four arrow keys, a dialog button, their cart's buttons —
// and nothing else. Time is as fast as the machine steps it (about fifteen game seconds a second).
//
// Pinned here, because each breaks silently in a running match:
//
//  1. **map.ts is the map's.** The twelve power-ups and their four abilities each, the status
//     numbers and the picker's Select buttons are compared against the running script's own
//     globals — a table retyped wrong is a button never pressed.
//  2. **The racing line is a road**: one closed loop through all 34 check points in order, every
//     sample of it on ground a cart may stand on, never against a wall, and no corner on it
//     marked faster than the cart's turning circle allows.
//  3. **Nothing moves without the keys** (the control): the same race with no AI attached leaves
//     every cart on the grid. The checks below have to be able to fail.
//  4. **Every seat FINISHES**, all three laps, by the script's own count (`CompletedAllLaps`
//     writes `udg_TimeUsed`) — and in a LOGICAL time. The bound is derived, not chosen:
//     a lap is the racing line's own length, a cart's top speed is its model's
//     (`udg_ModelAttributes`), a point of speed is 20/3 world units a second (map.ts
//     `UNITS_PER_SPEED`), so `laps × length ÷ (top × 20/3)` is the race flat out with no corners
//     — about 235 s for three laps of the 107 000-unit lap at 205. Nobody may beat that (it would
//     mean the laps were not driven), and a seat must be home within 1.5× of it on Insane, 1.6×
//     on Normal and 1.9× on Easy, corners, traffic and other people's mines included.
//  5. **A better rung is faster**: the Insane seats' mean time is under the Easy seats'.
//  6. **Power-ups are USED, and sensibly**: every seat that drove through a gift box pressed
//     what it got, no slot is still holding something at the flag that it has held for longer
//     than the rung hoards, and Specklefrogg's Rocket — which flies at whoever leads — is never
//     pressed by the leader.
//  7. **It asks for the laps** when the map hands it the dialog, and **picks a cart** before the
//     picker's 30 s runs out.
//
// What this cannot see is said in the harness's header: no buff lands here and no tree stands,
// so an Engine Boost does not speed anybody up and the road is the editor's baked pathing. The
// live match has both; docs/grand-prix-ai.md "Verified" is that half.
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const H = require("./grandprix-harness.cjs");
const map = require(join(REPO, ".sim-build", "src", "ai", "plus", "grandprix", "map.js"));
const routes = require(join(REPO, ".sim-build", "src", "ai", "plus", "grandprix", "route.js"));
const profiles = require(join(REPO, ".sim-build", "src", "ai", "plus", "grandprix", "profile.js"));
const { GrandPrixAi } = require(join(REPO, ".sim-build", "src", "ai", "plus", "grandprix", "index.js"));

let failed = 0;
function check(what, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok && detail !== undefined) console.log(`        ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const same = (what, got, want) => check(what, JSON.stringify(got) === JSON.stringify(want), { want, got });

// --- the parts that need no install ---------------------------------------------------------------
same("recognised by its four triggers", map.isGrandPrixScript(new Set(map.GRAND_PRIX_SCRIPT_MARKERS)), true);
same("…all four of them", map.isGrandPrixScript(new Set(map.GRAND_PRIX_SCRIPT_MARKERS.slice(1))), false);
same("eight racer seats", [...map.RACER_SEATS], [0, 1, 2, 3, 4, 5, 6, 7]);
same("a rawcode reads back as its four letters", map.rawcode(0x41303151), "A01Q");
same("…and nothing as nothing", map.rawcode(0), "");
same("twelve power-ups, forty-eight buttons, no two alike", new Set(map.POWER_UPS.flatMap((p) => p.abilities)).size, 48);
same("a slot's ability names its power-up", map.powerUpOf("A00G"), "rocket");
same("…and the gun is not one", map.powerUpOf(map.GUN), null);
same("anything unrecognised drives as Normal", profiles.grandPrixProfile(99), profiles.GP_NORMAL);
check("a better rung drives nearer the limit", profiles.GP_EASY.pace < profiles.GP_NORMAL.pace && profiles.GP_NORMAL.pace <= profiles.GP_INSANE.pace
  && profiles.GP_EASY.corner < profiles.GP_NORMAL.corner && profiles.GP_NORMAL.corner < profiles.GP_INSANE.corner);
check("no rung drives faster than the cart goes", [profiles.GP_EASY, profiles.GP_NORMAL, profiles.GP_INSANE].every((p) => p.pace <= 1 && p.corner <= 1 && p.braking <= 1));
{
  // A square circuit on open ground: the line must come round, and slow for its four corners.
  const gates = [{ x: 0, y: 0, dir: 0 }, { x: 4000, y: 0, dir: 90 }, { x: 4000, y: 4000, dir: 180 }, { x: 0, y: 4000, dir: 270 }];
  const ring = (x, y) => {
    const inside = x > 500 && x < 3500 && y > 500 && y < 3500;
    return !inside && x > -500 && x < 4500 && y > -500 && y < 4500;
  };
  const r = routes.buildRoute(gates, { drivable: ring, minX: -1024, minY: -1024, maxX: 5120, maxY: 5120 });
  check("a ring of road is a route", !!r && r.length > 12000 && r.length < 17000, r && r.length);
  if (r) {
    const plan = routes.speedPlan(r, 200, 7, 1, 1);
    check("…flat out down a straight", Math.max(...plan) === 200);
    check("…and slower round the corner than the straight", Math.min(...plan) < 150, Math.min(...plan));
    same("a cart on the line is found on it", routes.locate(r, r.x[40], r.y[40], -1, 1), 40);
  }
  // Cut the ring in two (both straights walled): check points that no road joins are not a lap.
  same("a road cut in two is no route", routes.buildRoute(gates, { drivable: (x, y) => ring(x, y) && !(x > 1800 && x < 2200), minX: -1024, minY: -1024, maxX: 5120, maxY: 5120 }), null);
}

if (!H.available()) {
  console.log("\n(the race itself needs the install's Azeroth Grand Prix and `pnpm data:extract` — skipped)");
  process.exit(failed ? 1 : 0);
}

// --- 1. map.ts against the running script ---------------------------------------------------------
console.log("\nmap.ts is the map's");
const NEWBIE = profiles.GP_EASY.difficulty, NORMAL = profiles.GP_NORMAL.difficulty, INSANE = profiles.GP_INSANE.difficulty;
{
  const g = H.boot({ seats: [0] });
  for (let i = 0; i < 30; i++) g.step();
  same("the power-up count", g.num("udg_PowerUpTypeNum"), map.POWER_UPS.length);
  for (let i = 0; i < map.POWER_UPS.length; i++) {
    const want = map.POWER_UPS[i];
    same(`power-up ${i} is ${want.name}`, (g.str("udg_PowerUpNames", i) ?? "").replace(/\|c[0-9a-f]{8}|\|r/gi, ""), want.name);
    same(`…in slots ${want.abilities.join(" ")}`, [0, 1, 2, 3].map((slot) => map.rawcode(g.num("udg_PowerUpTypes", i * 4 + slot))), [...want.abilities]);
  }
  for (const [name, key] of [["PICKING", "picking"], ["PREPARING", "preparing"], ["DRIVING", "driving"], ["REPAIRING", "repairing"], ["FINISHING", "finishing"], ["OVER", "over"], ["LEFT", "left"]]) {
    same(`udg_GAME_${name}`, g.num(`udg_GAME_${name}`), map.STATUS[key]);
  }
  same("thirty-four check points", g.num("udg_PlaceCheckPtNum"), 34);
  const asked = g.port.dialog(0);
  same("the map asks the first seat for 3, 4, 5 or 6 laps", asked && asked.buttons.map((b) => b.text), ["3", "4", "5", "6"]);
  if (asked) g.port.clickDialog(0, asked.id, asked.buttons[0].id);
  const picker = g.world.units.get(g.unit("udg_PickCarts", 0));
  check("the picker stands a known cart in front of the seat", !!picker && !!map.PICK_SELECT[picker.typeId], picker && picker.typeId);
  for (const [cart, select] of Object.entries(map.PICK_SELECT)) same(`${cart} is taken with ${select}`, H.PICK_ABILITIES[cart][1], select);
  same("…and turned past with Next", H.PICK_ABILITIES.h001[2], map.PICK_NEXT);

  // --- 2. the racing line ---
  console.log("\nthe racing line");
  const gates = [];
  for (let i = 0; i < 34; i++) gates.push({ ...g.point("udg_PlaceCheckPtPos", i), dir: g.num("udg_PlaceCheckPtDir", i) });
  const [minX, minY] = g.grid.cellToWorld(0, 0);
  const drivable = (x, y) => g.world.terrainCliffLevel(x, y) === map.TRACK_CLIFF_LEVEL && g.grid.walkable(...g.grid.worldToCell(x, y));
  const r = routes.buildRoute(gates, { drivable, minX: minX - 16, minY: minY - 16, maxX: minX + g.grid.width * 32, maxY: minY + g.grid.height * 32 });
  check("the 34 check points join into a lap", !!r);
  if (r) {
    check(`…about 107 000 world units round (${Math.round(r.length)})`, r.length > 100000 && r.length < 115000);
    let offRoad = 0, tight = Infinity, jump = 0;
    for (let s = 0; s < r.n; s++) {
      if (!drivable(r.x[s], r.y[s])) offRoad++;
      tight = Math.min(tight, r.room[s]);
      const t = (s + 1) % r.n;
      jump = Math.max(jump, Math.hypot(r.x[t] - r.x[s], r.y[t] - r.y[s]));
    }
    same("…every sample of it on road", offRoad, 0);
    check(`…closed, with no gap in it (longest step ${jump.toFixed(0)})`, jump < r.step * 1.6);
    check(`…and never against a wall (least room ${Math.round(tight)})`, tight >= 200);
    const order = [...r.gateAt];
    check("…through the check points in the script's order", order.every((s, i) => i === 0 || s > order[i - 1]), order);
    const near = gates.map((q, i) => Math.hypot(r.x[r.gateAt[i]] - q.x, r.y[r.gateAt[i]] - q.y));
    check(`…passing each one (furthest miss ${Math.round(Math.max(...near))})`, Math.max(...near) < 700);
    const plan = routes.speedPlan(r, 205, 6.8, 1, 1);
    let overCorner = 0, cornerSamples = 0;
    for (let s = 0; s < r.n; s++) {
      if (plan[s] > r.cornerSpeed[s] + 1e-3) overCorner++;
      if (r.cornerSpeed[s] < 205) cornerSamples++;
    }
    same("…no corner planned faster than a cart can turn it", overCorner, 0);
    check(`…and it HAS corners to brake for (${cornerSamples} samples)`, cornerSamples > 40);
  }
}

// --- 3 … 7. the race -------------------------------------------------------------------------------
function race(difficulties, { drive = true, limit = 600 } = {}) {
  const seats = difficulties.map((_, i) => i);
  const g = H.boot({ seats });
  const ai = new GrandPrixAi({ world: g.world, execute: g.execute });
  ai.attach(g.port);
  if (drive) seats.forEach((p, i) => ai.add(p, difficulties[i], 7));
  if (!drive) {
    // The control still has to get to the grid: answer the dialog and wait the picker out.
    for (let i = 0; i < 60; i++) g.step();
    const d = g.port.dialog(0);
    if (d) g.port.clickDialog(0, d.id, d.buttons[0].id);
  }
  const out = { g, go: -1, lapsAsked: 0, pickedBy: -1, time: new Map(), stale: 0, rocketWhileLeading: 0, start: new Map() };
  const held = seats.map(() => [0, 0, 0, 0].map(() => ({ code: 0, since: 0 })));
  let seen = 0;
  while (g.clock < limit) {
    g.step(drive ? (dt) => ai.tick(dt) : undefined);
    if (out.go < 0 && seats.every((p) => g.num("udg_GameGoingStatus", p) === map.STATUS.driving)) {
      out.go = g.clock;
      out.lapsAsked = g.num("udg_LapNumber");
      for (const p of seats) {
        const c = g.world.units.get(g.unit("udg_Carts", p));
        if (c) out.start.set(p, { x: c.x, y: c.y });
      }
    }
    if (out.pickedBy < 0 && seats.every((p) => g.unit("udg_Carts", p))) out.pickedBy = g.clock;
    // What each press was, judged at the moment it was made.
    for (; seen < g.casts.length; seen++) {
      const c = g.casts[seen];
      if (map.powerUpOf(c.code) === "rocket" && g.num("udg_Places", 0) === c.player) out.rocketWhileLeading++;
    }
    for (const p of seats) {
      for (let slot = 0; slot < 4; slot++) {
        const code = g.num("udg_CartPowerUps", p * 4 + slot) ?? 0;
        const h = held[p][slot];
        if (code !== h.code) { h.code = code; h.since = g.clock; }
      }
      if (!out.time.has(p) && g.num("udg_GameGoingStatus", p) >= map.STATUS.finishing && out.go >= 0) {
        out.time.set(p, g.num("udg_TimeUsed", p));
        // A power-up still in a slot at the flag is fine — one that has been there longer than
        // this rung hoards (and a second for the press to land) was never going to be used.
        const hoard = profiles.grandPrixProfile(difficulties[p]).hoard + profiles.grandPrixProfile(difficulties[p]).react[1] + 2;
        for (const h of held[p]) if (h.code && map.powerUpOf(map.rawcode(h.code)) !== "repair" && g.clock - h.since > hoard) out.stale++;
      }
    }
    if (drive && out.time.size === seats.length) break;
    if (!drive && out.go >= 0 && g.clock - out.go > 20) break;
  }
  return out;
}

console.log("\nthe control: a race nobody drives");
{
  const idle = race([NORMAL, NORMAL], { drive: false, limit: 80 });
  check("the script got its two carts to the grid by itself", idle.go > 0, idle.go);
  let moved = 0;
  for (const [p, at] of idle.start) {
    const c = idle.g.world.units.get(idle.g.unit("udg_Carts", p));
    if (!c || Math.hypot(c.x - at.x, c.y - at.y) > 1) moved++;
  }
  same("…and twenty seconds after GO, with no key pressed, neither has moved", moved, 0);
  same("…nor crossed a check point", [0, 1].map((p) => idle.g.num("udg_PlaceChkPtLap", p)), [-1, -1]);
}

console.log("\nthe race: eight Computer+ seats, three laps");
const FIELD = [NEWBIE, NORMAL, INSANE, NEWBIE, NORMAL, INSANE, NORMAL, INSANE];
const NAME = { [NEWBIE]: "Easy", [NORMAL]: "Normal", [INSANE]: "Insane" };
const SLACK = { [NEWBIE]: 1.9, [NORMAL]: 1.6, [INSANE]: 1.5 };
const started = Date.now();
const run = race(FIELD);
const g = run.g;
same("the seat the map asked chose three laps", run.lapsAsked, 3);
check(`every seat picked a cart before the picker's 30 s ran out (${run.pickedBy.toFixed(1)} s)`, run.pickedBy > 0 && run.pickedBy < 28);
same("every seat finished", run.time.size, FIELD.length);

// The race flat out, from the map's own numbers (see the header).
const lapLength = (() => {
  const gates = [];
  for (let i = 0; i < 34; i++) gates.push({ ...g.point("udg_PlaceCheckPtPos", i), dir: g.num("udg_PlaceCheckPtDir", i) });
  const [minX, minY] = g.grid.cellToWorld(0, 0);
  const drivable = (x, y) => g.world.terrainCliffLevel(x, y) === map.TRACK_CLIFF_LEVEL && g.grid.walkable(...g.grid.worldToCell(x, y));
  return routes.buildRoute(gates, { drivable, minX: minX - 16, minY: minY - 16, maxX: minX + g.grid.width * 32, maxY: minY + g.grid.height * 32 }).length;
})();
const byRung = new Map();
for (let p = 0; p < FIELD.length; p++) {
  const t = run.time.get(p);
  const top = g.num("udg_ModelAttributes", (g.num("udg_PlayerModels", p) ?? 0) * 4 + map.MODEL_ATTR.top);
  const flatOut = (run.lapsAsked * lapLength) / (top * map.UNITS_PER_SPEED);
  const rung = FIELD[p];
  same(`P${p} (${NAME[rung]}) completed lap ${run.lapsAsked}`, g.num("udg_PlaceChkPtLap", p), run.lapsAsked);
  check(
    `P${p} (${NAME[rung]}, top ${top}) home in ${t === undefined ? "—" : t.toFixed(1)} s — flat out is ${flatOut.toFixed(0)} s, the bound ${(flatOut * SLACK[rung]).toFixed(0)} s`,
    t !== undefined && t >= flatOut && t <= flatOut * SLACK[rung],
  );
  if (t !== undefined) byRung.set(rung, [...(byRung.get(rung) ?? []), t]);
}
const mean = (rung) => (byRung.get(rung) ?? [Infinity]).reduce((a, b) => a + b, 0) / (byRung.get(rung)?.length ?? 1);
check(`the Insane seats (mean ${mean(INSANE).toFixed(0)} s) beat the Easy ones (${mean(NEWBIE).toFixed(0)} s)`, mean(INSANE) < mean(NEWBIE));

console.log("\nwhat they carried");
const presses = new Map();
for (const c of g.casts) if (map.powerUpOf(c.code)) presses.set(c.player, (presses.get(c.player) ?? 0) + 1);
const kinds = new Set(g.casts.map((c) => map.powerUpOf(c.code)).filter(Boolean));
check(`every seat pressed its power-ups (${FIELD.map((_, p) => presses.get(p) ?? 0).join(", ")})`, FIELD.every((_, p) => (presses.get(p) ?? 0) >= 3));
check(`…a spread of them, not one button (${[...kinds].sort().join(", ")})`, kinds.size >= 8);
same("no slot was still hoarding at the flag", run.stale, 0);
same("the rocket was never fired by the leader", run.rocketWhileLeading, 0);
check(`the machine gun was fired (${g.casts.filter((c) => c.code === map.GUN).length} rounds)`, g.casts.some((c) => c.code === map.GUN));
check("every press went through the cart's own card", g.casts.every((c) => map.powerUpOf(c.code) || c.code === map.GUN || c.code === map.PICK_NEXT || Object.values(map.PICK_SELECT).includes(c.code)));
console.log(`\n(${g.clock.toFixed(0)} game seconds in ${((Date.now() - started) / 1000).toFixed(0)} s)`);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall Azeroth Grand Prix checks passed");
