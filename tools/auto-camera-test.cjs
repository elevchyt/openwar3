// AUTO CAMERA — the observer's camera (issue #167, src/game/autoCamera.ts).
//
// The brief it is held to: heroes and armies are the focus; it pans SMOOTHLY; and it does not
// pan often — "there must be a delay between each pan even if the point of interest changes".
// Plus the rule that makes it usable at all: the observer's own hand on the camera wins.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const AC = require(join(REPO, ".sim-build", "src", "game", "autoCamera.js"));
const { AutoCamera, MIN_HOLD, MANUAL_GRACE, PAN_MAX } = AC;

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

let nextId = 1;
const unit = (x, y, over = {}) => ({
  id: nextId++, x, y, owner: 0, hp: 100, isHero: false, building: null, isPeon: false, inCombat: false, ...over,
});
const DT = 1 / 60;

/** Drive the camera like the renderer does: write what it asks for, confirm, repeat. */
function drive(cam, focus, units, seconds, each = () => {}) {
  const trace = [];
  for (let t = 0; t < seconds; t += DT) {
    each(t, focus);
    const want = cam.update(DT, focus, units);
    if (want) { focus.x = want.x; focus.y = want.y; }
    cam.confirm(focus);
    trace.push({ t, x: focus.x, y: focus.y });
  }
  return trace;
}

console.log("\nit goes to the HEROES and ARMIES, and does nothing while off");
{
  const cam = new AutoCamera();
  const focus = { x: 0, y: 0 };
  const units = [
    unit(5000, 5000, { isHero: true }), unit(5050, 5000), unit(5000, 5060), // a hero with an army
    unit(-3000, 0, { isPeon: true }), unit(-3040, 0, { isPeon: true }), unit(-3000, 40, { building: {} }), // a quiet base
  ];
  drive(cam, focus, units, 3);
  check("off, it never moves the camera", focus.x === 0 && focus.y === 0);
  cam.setEnabled(true);
  drive(cam, focus, units, 4);
  check("on, it goes to the hero and his army, not the base", Math.hypot(focus.x - 5017, focus.y - 5012) < 60, `(${focus.x.toFixed(0)}, ${focus.y.toFixed(0)})`);
}

console.log("\nthe pan is SMOOTH");
{
  const cam = new AutoCamera();
  cam.setEnabled(true);
  const focus = { x: 0, y: 0 };
  const units = [unit(6000, 0, { isHero: true })];
  const trace = [{ t: -DT, x: 0, y: 0 }, ...drive(cam, focus, units, PAN_MAX + 1)];
  let maxStep = 0, first = trace.findIndex((p) => p.x > 1);
  for (let i = 1; i < trace.length; i++) maxStep = Math.max(maxStep, trace[i].x - trace[i - 1].x);
  const start = trace[first].x - trace[first - 1].x;
  check("no frame jumps more than a small share of the way (no cut)", maxStep < 6000 * 0.03, `largest step ${maxStep.toFixed(0)}`);
  check("it eases OUT of the old spot (the first step is small)", start < maxStep * 0.2, `first ${start.toFixed(1)}, largest ${maxStep.toFixed(0)}`);
  check("and arrives", Math.abs(focus.x - 6000) < 1, `x ${focus.x.toFixed(0)}`);
}

console.log("\nit does NOT pan often: a hold after every pan, however the action moves");
{
  const cam = new AutoCamera();
  cam.setEnabled(true);
  const focus = { x: 0, y: 0 };
  const a = [unit(4000, 0, { isHero: true, owner: 0 }), unit(4050, 0, { owner: 1, inCombat: true }), unit(4000, 60, { owner: 0, inCombat: true })];
  const units = [...a];
  drive(cam, focus, units, 3); // settled on fight A
  // A BIGGER fight breaks out far away, one second later.
  const b = [];
  for (let i = 0; i < 8; i++) b.push(unit(-4000 + i * 30, 3000, { owner: i % 2, inCombat: true, isHero: i < 2 }));
  units.push(...b);
  let movedAt = -1;
  const t0 = 3;
  drive(cam, focus, units, MIN_HOLD + 3, (t) => { if (movedAt < 0 && focus.x < 2000) movedAt = t0 + t; });
  check("it does go to the bigger fight…", focus.x < 0, `x ${focus.x.toFixed(0)}`);
  check(`…but not before its ${MIN_HOLD}s hold since the last pan is up`, movedAt >= MIN_HOLD - 0.1, `moved at ${movedAt.toFixed(2)} s`);
}
{
  // Two spots trading places every second: it must not ping-pong between them.
  const cam = new AutoCamera();
  cam.setEnabled(true);
  const focus = { x: 0, y: 0 };
  const left = [unit(-3000, 0, { isHero: true }), unit(-3040, 0, { isHero: true })];
  const right = [unit(3000, 0, { isHero: true }), unit(3040, 0, { isHero: true })];
  const units = [...left, ...right];
  let pans = 0, wasLeft = null;
  drive(cam, focus, units, 30, (t) => {
    // Whichever side is "hot" swaps every second.
    const hot = Math.floor(t) % 2 === 0 ? left : right;
    for (const u of units) u.inCombat = hot.includes(u);
    const isLeft = focus.x < 0;
    if (wasLeft !== null && isLeft !== wasLeft) pans++;
    wasLeft = isLeft;
  });
  check("over 30 s of flip-flopping action it pans at most once per hold", pans <= Math.ceil(30 / MIN_HOLD), `${pans} pans`);
}

console.log("\nit FOLLOWS the action it is watching between pans");
{
  const cam = new AutoCamera();
  cam.setEnabled(true);
  const focus = { x: 0, y: 0 };
  const army = [unit(0, 0, { isHero: true }), unit(40, 0), unit(0, 40)];
  drive(cam, focus, army, 2);
  drive(cam, focus, army, 8, () => { for (const u of army) u.x += 150 * DT; }); // marching east at 150/s
  check("a marching army is kept in view without a new pan", focus.x > 900, `x ${focus.x.toFixed(0)}, army at ${army[0].x.toFixed(0)}`);
}

console.log("\nthe observer's own hand wins");
{
  const cam = new AutoCamera();
  cam.setEnabled(true);
  const focus = { x: 0, y: 0 };
  const units = [unit(5000, 0, { isHero: true })];
  drive(cam, focus, units, 4); // there
  focus.x = -2000; focus.y = 800; // the observer scrolls away
  drive(cam, focus, units, MANUAL_GRACE - 0.5);
  check("it stands aside while the observer is looking elsewhere", focus.x === -2000 && focus.y === 800);
  drive(cam, focus, units, 4);
  check("and takes over again once the grace is up", Math.abs(focus.x - 5000) < 5, `x ${focus.x.toFixed(0)}`);
}

console.log("\nwhat counts as a fight: being HURT, not only swinging");
{
  const cam = new AutoCamera();
  cam.setEnabled(true);
  const focus = { x: 0, y: 0 };
  const army = [unit(3000, 0), unit(3040, 0)]; // two idle soldiers
  const raided = [unit(-3000, 0, { isPeon: true }), unit(-3040, 0, { isPeon: true }), unit(-3000, 40, { isPeon: true })];
  const units = [...army, ...raided];
  drive(cam, focus, units, 1);
  const before = focus.x;
  drive(cam, focus, units, MIN_HOLD + 3, (t) => { if (t > 0.5) for (const p of raided) p.hp -= 5 * DT; });
  check("workers losing hit points outrank soldiers standing about", before > 0 && focus.x < -2000, `before ${before.toFixed(0)}, now ${focus.x.toFixed(0)}`);
}

console.log(failures ? `\nauto camera: ${failures} FAILED` : "\nauto camera: all checks passed");
process.exit(failures ? 1 : 0);
