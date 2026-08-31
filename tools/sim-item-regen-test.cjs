// Headless check of the regeneration items' effect (`AIrg` — Healing Salve, Clarity Potion,
// Potion & Scroll of Rejuvenation): restore over time, and break when the holder is hit.
//
// The numbers are the real 1.27a ones from Units\AbilityData.slk (DataA = total hit points,
// DataB = total mana, Dur1 = seconds). Driving useItem() itself would need the item and
// ability registries — i.e. the MPQs — so this exercises the buff mechanics the case builds,
// which is where the behaviour actually lives.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

const world = new SimWorld({ width: 4, height: 4, cell: 128, blocked: new Uint8Array(16) }, 1);

let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, hp: 100, maxHp: 1000, mana: 0, maxMana: 500, buffs: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, race: "human", hpRegen: 0, manaRegen: 0,
    // recomputeStats runs on the break (the mana half is a stat bonus), so the stub needs
    // the fields it reads.
    inventory: [], weapons: [], abilities: [], typeId: "hfoo", level: 1, baseMaxHp: 1000, baseMaxMana: 500,
    baseHpRegen: 0, baseManaRegen: 0, baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}

// TypeScript `private` is not a runtime barrier — in the compiled CommonJS these are plain
// methods, which is what lets a headless test drive them without a browser.
const applyRegen = (u, hp, mana, seconds) => {
  if (hp > 0) world.applyBuffInternal(u, { kind: "hot", group: "item:regen", timeLeft: seconds, sourceId: u.id, value: hp / seconds, value2: 0 });
  if (mana > 0) world.applyBuffInternal(u, { kind: "manaRegen", group: "item:regen:mana", timeLeft: seconds, sourceId: u.id, value: mana / seconds, value2: 0 });
};

let failed = 0;
function check(what, got, want, tol = 0.01) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}\n        want ${want}, got ${Math.round(got * 100) / 100}`);
}

// Healing Salve — DataA=400 over Dur=45s, no mana.
{
  const u = unit({ hp: 100 });
  applyRegen(u, 400, 0, 45);
  for (let i = 0; i < 45; i++) world.tickBuffs(u, 1);
  check("Healing Salve restores its full 400 hp over 45s", u.hp - 100, 400);
  check("…and the buff is gone at the end", u.buffs.length, 0);
}

// Healing Salve, interrupted at 10s by a 30-damage hit.
{
  const u = unit({ hp: 100 });
  applyRegen(u, 400, 0, 45);
  for (let i = 0; i < 10; i++) world.tickBuffs(u, 1);
  const healed = u.hp - 100;
  world.landDamage(u, 30, 0, false);
  check("10s of a Healing Salve is 400*10/45", healed, (400 * 10) / 45);
  check("a 30-damage hit dispels it", u.buffs.filter((b) => b.group?.startsWith("item:regen")).length, 0);
  const afterBreak = u.hp;
  for (let i = 0; i < 20; i++) world.tickBuffs(u, 1);
  check("…and nothing regenerates afterwards", u.hp - afterBreak, 0);
}

// There is NO damage threshold: Blizzard's own classic site says the effect "will be canceled
// if the units using the potion are attacked or are hit by a spell which does damage", so a
// Footman's or a Ghoul's blow — well under the 20 this once demanded — takes it too.
{
  const u = unit({ hp: 100 });
  applyRegen(u, 400, 0, 45);
  world.landDamage(u, 5, 0, false);
  check("a 5-damage hit dispels it too — no threshold", u.buffs.filter((b) => b.group?.startsWith("item:regen")).length, 0);
}

// …and every OTHER path that removes hit points is damage as well, not just the attack path.
{
  const u = unit({ hp: 100 });
  applyRegen(u, 400, 0, 45);
  // A dot ticking on the holder ("hit by a spell which does damage"): Rain of Fire's burn.
  world.applyBuffInternal(u, { kind: "dot", group: "burn", timeLeft: 5, sourceId: 0, value: 4, value2: 0 });
  world.tickBuffs(u, 1);
  check("a dot tick dispels it", u.buffs.filter((b) => b.group?.startsWith("item:regen")).length, 0);
}
{
  // Spirit Link's shared slice, which Blizzard's forums confirm is not a bug: a crit on the
  // linked hero dispelled the linked Spirit Walker's salve.
  const walker = unit({ hp: 100 });
  const hero = unit({ hp: 500 });
  applyRegen(walker, 400, 0, 45);
  for (const u of [walker, hero]) { u.linkT = 10; u.linkShare = 0.5; u.linkGroup = [walker.id, hero.id]; }
  world.spiritLinkSplit(hero, 40); // the split itself; applyDamage's armor pass is not the point here
  check("a spirit-linked share dispels the OTHER unit's", walker.buffs.filter((b) => b.group?.startsWith("item:regen")).length, 0);
}

// Scroll of Rejuvenation I — DataA=250 hp AND DataB=100 mana over 45s: both halves break together.
{
  const u = unit({ hp: 100, mana: 0 });
  applyRegen(u, 250, 100, 45);
  check("both halves are worn at once", u.buffs.filter((b) => b.group?.startsWith("item:regen")).length, 2);
  world.landDamage(u, 25, 0, false);
  check("one hit takes both", u.buffs.filter((b) => b.group?.startsWith("item:regen")).length, 0);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
