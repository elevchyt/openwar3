// Headless check of the REVEALS and of Dust of Appearance, which is not one.
//
// The Crystal Ball (`AIta`, and the Arcane Tower's Reveal on the same code), Far Sight (`AOfs`)
// and the Goblin Laboratory's Reveal (`Andt`) light a circle of map for their `Dur1` and uncover
// the invisible units inside it for as long as it lasts, with a marker at its centre that every
// player sees (`global`). The Crystal Ball also hangs its ball over the user for the same length.
//
// Every one of them, and Dust of Appearance too, is HEARD: RevealMap.wav, the `SNDxANDT` event
// AItbTarget.mdx carries, played once (`sound`).
//
// The FLARES (the Mortar Team's `Afla`, the Flare Gun's `AIfa`) are the other shape: the gun's
// FlareCaster.mdl at the shooter, and `Fla2` = 0.8 s later FlareTarget.mdl coming down on the
// target with all four of its own SND events (`events`), and only then does the ground light.
//
// Dust of Appearance lights NOTHING. It marks the hidden enemies around the user with `Bdet`
// (the `dusted` buff), and a marked unit is detected by the duster's side wherever it walks —
// which is what these cases pin, because the old handler was a reveal round the hero and so
// lost a Wind Walker the moment it stepped out of the circle.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { SPELL_HANDLERS } = require(join(REPO, ".sim-build", "src", "sim", "spells.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

const D = (...v) => { const a = new Array(9).fill(NaN); v.forEach((x, i) => { a[i] = x; }); return a; };
const lvl = (over = {}) => ({ cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0, data: D(), dataStr: [], buffs: [], summon: "", ...over });
const def = (over) => ({ id: over.code, targetFlags: [], buffFx: [], casterArt: "", casterAttach: [], targetArt: "", ...over });
// The real rows' numbers (AbilityData.slk) and art (ItemAbilityFunc.txt / NeutralAbilityFunc.txt).
const AIta = def({ code: "AIta", casterArt: "Abilities\\Spells\\Items\\AIta\\CrystalBallCaster.mdl", casterAttach: ["overhead"], levelData: [lvl({ area: 900, duration: 10, heroDuration: 10, data: D(3) })] });
const AOfs = def({ code: "AOfs", levelData: [lvl({ area: 900, duration: 8, heroDuration: 8, data: D(3) })] });
const Andt = def({ code: "Andt", levelData: [lvl({ area: 900, duration: 6, heroDuration: 6, data: D(50, 0, 3) })] });
const Afla = def({ code: "Afla", casterArt: "Abilities\\Spells\\Human\\Flare\\FlareCaster.mdl", fxArt: "Abilities\\Spells\\Human\\Flare\\FlareTarget.mdl", levelData: [lvl({ area: 1800, duration: 15, heroDuration: 15, data: D(3, 0.8, 0) })] });
const AIfa = def({ code: "AIfa", casterArt: "Abilities\\Spells\\Human\\Flare\\FlareCaster.mdl", fxArt: "Abilities\\Spells\\Human\\Flare\\FlareTarget.mdl", levelData: [lvl({ area: 1800, duration: 45, heroDuration: 45, data: D(1, 0.8) })] });
const AItb = def({ code: "AItb", casterArt: "Abilities\\Spells\\Items\\AItb\\AItbTarget.mdl", targetFlags: ["air", "ground", "ward", "enemy", "neutral", "vuln", "invu"], levelData: [lvl({ area: 1000, duration: 20, heroDuration: 20, data: D(3), buffs: ["Bdet"] })] });

/** A SpellApi that records what a handler asked for, over a unit list. */
function fakeApi(units) {
  const log = { reveals: [], effects: [], buffs: [] };
  const api = {
    unitsInArea: (x, y, r) => units.filter((u) => Math.hypot(u.x - x, u.y - y) <= r),
    hostile: (a, b) => a.team !== b.team,
    admits: () => true,
    allows: () => true,
    revealArea: (owner, team, o) => log.reveals.push({ owner, team, ...o }),
    emitEffect: (art, x, y, targetId, life, attach, opts) => log.effects.push({ art, x, y, targetId, life, attach, ...(opts ?? {}) }),
    applyBuff: (t, b) => { log.buffs.push({ t, b }); t.buffs.push(b); },
  };
  return { api, log };
}
const unit = (over) => ({ id: 0, owner: 0, team: 0, hp: 100, x: 0, y: 0, invisible: false, buffs: [], isHero: true, resistant: false, level: 1, ...over });

// --- the Crystal Ball ------------------------------------------------------------------
{
  const hero = unit({ id: 1, owner: 0, team: 0 });
  const { api, log } = fakeApi([hero]);
  SPELL_HANDLERS.AIta(api, hero, AIta, 1, { targetId: 0, x: 3000, y: 4000 });
  const r = log.reveals[0];
  check("Crystal Ball: one reveal, at the aimed point", !!r && r.x === 3000 && r.y === 4000, true);
  check("…900 wide (Area1) for 10 s (Dur1)", r && r.radius === 900 && r.seconds === 10, true);
  check("…and it DETECTS inside it", r && r.detect, true);
  const marker = log.effects.find((e) => /AItbTarget/i.test(e.art));
  check("…an AItbTarget marker at the centre, held for the whole reveal", !!marker && marker.x === 3000 && marker.life === 10 && marker.anim === "hold", true);
  check("…seen by everyone (global)", marker?.global, true);
  check("…and heard: its own RevealMap event, once (sound)", marker?.sound, true);
  const ball = log.effects.find((e) => /CrystalBallCaster/i.test(e.art));
  check("…and the ball over the user's head (overhead, held for Dur1)", !!ball && ball.targetId === 1 && ball.attach?.[0] === "overhead" && ball.anim === "hold" && ball.life === 10, true);
}

// --- Far Sight and Reveal: the same, no ball ---------------------------------------------
for (const [name, d, secs, key] of [["Far Sight", AOfs, 8, "AOfs"], ["Reveal", Andt, 6, "Andt"]]) {
  const caster = unit({ id: 2, owner: 1, team: 1 });
  const { api, log } = fakeApi([caster]);
  SPELL_HANDLERS[key](api, caster, d, 1, { targetId: 0, x: 100, y: 200 });
  const r = log.reveals[0];
  check(`${name}: a detecting reveal for ${secs} s at the point`, !!r && r.detect && r.seconds === secs && r.x === 100, true);
  check(`${name}: its marker, and no crystal ball`, log.effects.length === 1 && /AItbTarget/i.test(log.effects[0].art) && log.effects[0].global === true, true);
}
{
  // The Goblin Laboratory is Neutral Passive: its Reveal is the BUYER's.
  const lab = unit({ id: 3, owner: 15, team: 15, isHero: false });
  const { api, log } = fakeApi([lab]);
  SPELL_HANDLERS.Andt(api, lab, Andt, 1, { targetId: 0, x: 0, y: 0, onBehalfOf: { owner: 2, team: 5 } });
  check("Reveal bought at the lab lights the BUYER's side", log.reveals[0]?.owner === 2 && log.reveals[0]?.team === 5, true);
}

// --- Dust of Appearance --------------------------------------------------------------------
{
  const hero = unit({ id: 10, owner: 0, team: 0 });
  const walker = unit({ id: 11, owner: 1, team: 1, invisible: true, x: 400 }); // a Wind Walker in range
  const seen = unit({ id: 12, owner: 1, team: 1, x: 300 }); // an enemy nobody needs to show
  const far = unit({ id: 13, owner: 1, team: 1, invisible: true, x: 5000 }); // out of Area1
  const ally = unit({ id: 14, owner: 2, team: 0, invisible: true, x: 200 }); // our own, melded
  const { api, log } = fakeApi([hero, walker, seen, far, ally]);
  SPELL_HANDLERS.AItb(api, hero, AItb, 1, { targetId: 0, x: 0, y: 0 });
  check("Dust lights NO fog at all", log.reveals.length, 0);
  check("…marks the invisible enemy inside Area1", walker.buffs.some((b) => b.kind === "dusted"), true);
  check("…with the Bdet row, 20 s, owned by the duster's team", walker.buffs[0]?.buffId === "Bdet" && walker.buffs[0]?.timeLeft === 20 && walker.buffs[0]?.value === 0, true);
  check("…and wears no model for it", walker.buffs[0]?.fx.length === 0 && walker.buffs[0]?.art === "", true);
  check("…not a visible enemy", seen.buffs.length, 0);
  check("…not one out of range", far.buffs.length, 0);
  check("…not an ally", ally.buffs.length, 0);
  const puff = log.effects[0];
  check("…plays AItbTarget ONCE on the user (Stand, the clip's own length)", log.effects.length === 1 && /AItbTarget/i.test(puff.art) && puff.targetId === 10 && puff.anim === "stand" && puff.life === 0, true);
  check("…with RevealMap.wav (sound)", puff.sound, true);

  // The mark is what the duster's side detects by, wherever the body goes.
  const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
  world.units.set(walker.id, walker);
  walker.x = 9000; // walked far away from where it was dusted, and from anything that sees
  check("a dusted unit is detected by the duster's team anywhere", world.teamDetects(0, walker.x, walker.y, walker), true);
  check("…not by a third side", world.teamDetects(2, walker.x, walker.y, walker), false);
  check("…and the bare point it stands on uncovers nobody else", world.teamDetects(0, walker.x, walker.y), false);
}

// --- the flares ------------------------------------------------------------------------------
for (const [name, d, secs, detect] of [["Flare (Mortar Team)", Afla, 15, true], ["Flare Gun", AIfa, 45, true]]) {
  const mortar = unit({ id: 20, owner: 0, team: 0, isHero: false });
  const { api, log } = fakeApi([mortar]);
  SPELL_HANDLERS[d.code](api, mortar, d, 1, { targetId: 0, x: 2000, y: -1000 });
  const r = log.reveals[0];
  check(`${name}: reveals 1800 for ${secs} s, detecting`, !!r && r.radius === 1800 && r.seconds === secs && r.detect === detect, true);
  check(`${name}: …opening after Fla2's 0.8 s Effect Delay`, r?.delay, 0.8);
  const gun = log.effects.find((e) => /FlareCaster/i.test(e.art));
  check(`${name}: FlareCaster at the shooter, now`, !!gun && gun.targetId === 20 && !gun.delay, true);
  const fl = log.effects.find((e) => /FlareTarget/i.test(e.art));
  check(`${name}: FlareTarget on the point, 0.8 s later, its clip's own length`, !!fl && fl.x === 2000 && fl.delay === 0.8 && fl.life === 0, true);
  check(`${name}: …firing its own four SND events, seen by all`, fl?.events === true && fl?.global === true, true);
  check(`${name}: …and no reveal marker`, log.effects.some((e) => /AItbTarget/i.test(e.art)), false);
}
{
  // The flare lights nothing while it is still in the air.
  const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
  world.addItemReveal(0, 0, { x: 0, y: 0, radius: 1800, seconds: 15, detect: true, delay: 0.8 });
  check("a flare in the air neither detects…", world.teamDetects(0, 100, 0), false);
  check("…nor lights the fog", [...world.activeItemReveals()].length, 0);
  world.tickClient(0.5);
  check("…at 0.5 s, still not", [...world.activeItemReveals()].length, 0);
  world.tickClient(0.4);
  check("…landed at 0.8 s: lights and detects", [...world.activeItemReveals()].length === 1 && world.teamDetects(0, 100, 0), true);
  world.tickClient(14.9);
  check("…and its 15 s run from the landing, not the shot", [...world.activeItemReveals()].length, 1);
  world.tickClient(0.2);
  check("…then out", [...world.activeItemReveals()].length, 0);
}

// --- a reveal's circle detects through ItemReveal.detect ---------------------------------
{
  const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
  world.addItemReveal(0, 0, { x: 0, y: 0, radius: 900, seconds: 10, detect: true });
  check("inside a Crystal Ball's circle an invisible unit is detected", world.teamDetects(0, 500, 0), true);
  check("…outside it, not", world.teamDetects(0, 1500, 0), false);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall reveal checks passed");
