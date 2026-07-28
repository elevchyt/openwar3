// Hostility is DIRECTED, and dropping a fight when it ends.
//
// WC3's alliance matrix is per-PAIR and per-SETTING, and it is directed: SetPlayerAlliance(A,
// B, …) says what A grants B, and the two ways are independent. ALLIANCE_PASSIVE is the one
// that means "I will not shoot you", and it belongs to the ATTACKER.
//
// We had it as a MUTUAL test — blizzard.j's PlayersAreCoAllied, PASSIVE both ways — and read
// anything less as a fight. That is the right predicate for "are we ALLIES" (shared XP, ally
// colours) and the wrong one for "will this unit attack that one", and campaigns prove it,
// because they write one direction and mean it. Rise of the Naga's init:
//
//     call SetPlayerAllianceStateBJ( udg_AP4_Naga,   udg_AP3_FishingVillage, bj_ALLIANCE_NEUTRAL )
//     call SetPlayerAllianceStateBJ( udg_AP5_Satyrs, udg_AP3_FishingVillage, bj_ALLIANCE_NEUTRAL )
//     call SetPlayerAllianceStateBJ( udg_AP6_Wildkin, udg_AP3_FishingVillage, bj_ALLIANCE_NEUTRAL )
//
// — three of the map's factions told to hold their fire toward the fishing village, and the
// village never told anything back. Read mutually, none of it took: the Naga stand over the
// village's ships for the whole mission, so they auto-acquired them in the opening seconds and
// two ship deaths is a scripted defeat. The chapter was unwinnable before the player moved.
//
// (And when a map wants the relationship to be mutual it says so twice — the same init writes
// UNALLIED for the Furbolgs in both directions, two lines apart.)
//
// bj_ALLIANCE_NEUTRAL is PASSIVE alone, which is what makes it different from ALLIED: blizzard.j
// clears the five ally settings and then puts PASSIVE back on by itself.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { AllianceTable, AllianceType } = require(join(REPO, ".sim-build", "src", "sim", "alliances.js"));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) failures++;
};

const SIM_DT = 1 / 60;
const W = 96, H = 96;
const grid = () => new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);

const WEAPON = () => ({
  enabled: true, targets: ["ground", "structure", "debris", "item", "ward"], ranged: false,
  damage: 20, baseDamage: 20, dice: 1, baseDice: 1, sides: 1,
  cooldown: 1.0, baseCooldown: 1.0, range: 90, baseRange: 90,
  damagePoint: 0.1, baseDamagePoint: 0.1, backswing: 0.1, baseBackswing: 0.1,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 800, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

function addUnit(w, id, owner, team, x, y, over = {}) {
  const weapons = over.weapons ?? [WEAPON()];
  return w.add({
    id, owner, team, typeId: "hfoo", x, y, facing: 0,
    hp: 4000, maxHp: 4000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    castPoint: 0, castBackswing: 0,
    ...over, weapons, oldWeapons: weapons,
  });
}

/** Wire a world to a real AllianceTable, the way RtsController does. */
function withMatrix(w) {
  const m = new AllianceTable();
  w.alliedPlayers = (a, b) => m.coAllied(a, b);
  w.passivePlayers = (a, b) => m.get(a, b, AllianceType.Passive);
  return m;
}

const run = (w, seconds) => { for (let i = 0; i < Math.round(seconds / SIM_DT); i++) w.tick(SIM_DT); };

console.log("one-way neutral: the side that holds its fire is the side that was told to");
{
  const w = new SimWorld(grid(), 1);
  const m = withMatrix(w);
  // Exactly the map's line: the Naga (3) go neutral toward the fishing village (2).
  m.set(3, 2, AllianceType.Passive, true);
  const naga = addUnit(w, 1, 3, 1, 900, 500);
  const ship = addUnit(w, 2, 2, 2, 1200, 500, { weapons: [], speed: 0 });
  check("the Naga will not attack the village", !w.hostile(naga, ship));
  check("…while the village still counts the Naga an enemy", w.hostile(ship, naga));
  check("and they are NOT allies — one-way passive is not friendship", !w.allied(naga, ship));
  run(w, 6);
  check(`the ship is untouched (hp ${ship.hp})`, ship.hp === ship.maxHp);
  check("and nobody went looking for a fight", naga.order === "idle" && naga.targetId === null);
}

console.log("\nwithout that line they fight, which is what makes the line load-bearing");
{
  const w = new SimWorld(grid(), 1);
  withMatrix(w);
  const naga = addUnit(w, 1, 3, 1, 900, 500);
  const ship = addUnit(w, 2, 2, 2, 1200, 500, { weapons: [], speed: 0 });
  check("hostile with an empty matrix", w.hostile(naga, ship));
  run(w, 6);
  check(`the ship is being taken apart (hp ${Math.round(ship.hp)})`, ship.hp < ship.maxHp);
}

console.log("\nmutual passive IS friendship (bj_ALLIANCE_ALLIED, and a melee team)");
{
  const w = new SimWorld(grid(), 1);
  const m = withMatrix(w);
  m.set(3, 2, AllianceType.Passive, true);
  m.set(2, 3, AllianceType.Passive, true);
  const a = addUnit(w, 1, 3, 1, 900, 500);
  const b = addUnit(w, 2, 2, 2, 1200, 500);
  check("neither is hostile", !w.hostile(a, b) && !w.hostile(b, a));
  check("and now they are allies", w.allied(a, b) && w.allied(b, a));
}

console.log("\nan auto-acquired fight ends when the target stops being an enemy");
{
  const w = new SimWorld(grid(), 1);
  const m = withMatrix(w);
  const a = addUnit(w, 1, 3, 1, 900, 500);
  const b = addUnit(w, 2, 2, 2, 1100, 500, { weapons: [], speed: 0 });
  run(w, 3);
  check("picked the fight up on its own", a.order === "attack" && a.targetId === b.id);
  m.set(3, 2, AllianceType.Passive, true); // the map's init lands, late
  run(w, 1);
  check("and drops it the moment the alliance says so", a.targetId === null);
  const hp = b.hp;
  run(w, 5);
  check("…for good", b.hp === hp);
}

console.log("\nbut an ORDERED attack is the player's call, alliance or not");
{
  const w = new SimWorld(grid(), 1);
  const m = withMatrix(w);
  m.set(3, 2, AllianceType.Passive, true);
  const a = addUnit(w, 1, 3, 1, 900, 500);
  const b = addUnit(w, 2, 2, 2, 1100, 500, { weapons: [], speed: 0 });
  // This is how the harbour sequence sends the very same neutral Naga at the very same ships.
  check("a forced attack is accepted", w.issueOrder(1, { kind: "attack", targetId: b.id, force: true }));
  run(w, 6);
  check(`and it is carried out (hp ${Math.round(b.hp)})`, b.hp < b.maxHp);
}

console.log("\na force says what it grants, and a team is not a licence to see");
{
  // Chapter one of Terror of the Tides: both its forces are w3i flags **1** — allied, and NOT
  // sharing vision. Seeding sight off the team number alone lit the Watchers', the villagers'
  // and the prisoners' half of the map from the first frame. (Force flags → grants: see
  // MapInfo.ForceGrants, pinned per force against the InitCustomTeams the editor generates.)
  const chapter = new AllianceTable();
  const teamOf = (p) => (p === 0 || p === 1 || p === 2 || p === 9 ? 0 : 1);
  chapter.seedFromTeams(teamOf, () => ({ allied: true, sharedVision: false }));
  check("the villagers are your allies", chapter.coAllied(0, 2) && chapter.coAllied(2, 0));
  check("…and lend you no sight at all", !chapter.sharesVisionWith(2, 0) && !chapter.sharesVisionWith(0, 2));
  check("the prisoners likewise", chapter.coAllied(0, 9) && !chapter.sharesVisionWith(9, 0));
  check("and the Naga are neither", !chapter.coAllied(0, 3) && !chapter.sharesVisionWith(3, 0));

  // A force that DOES grant it (flags 9 — NightElfX06/07, UndeadX01) gets it.
  const shared = new AllianceTable();
  shared.seedFromTeams(teamOf, () => ({ allied: true, sharedVision: true }));
  check("a force with the vision bit shares sight", shared.sharesVisionWith(2, 0) && shared.sharesVisionWith(0, 2));

  // A melee lobby states no forces at all, and its Team column promises both.
  const melee = new AllianceTable();
  melee.seedFromTeams((p) => (p < 2 ? 0 : 1));
  check("a melee team is allied", melee.coAllied(0, 1) && melee.coAllied(1, 0));
  check("…and shares vision, as it always did", melee.sharesVisionWith(0, 1) && melee.sharesVisionWith(1, 0));
  check("across teams, nothing", !melee.coAllied(0, 2) && !melee.sharesVisionWith(0, 2));

  // A force with flags 0 (NightElfX06's first) allies nobody: a heading, not a pact.
  const grouped = new AllianceTable();
  grouped.seedFromTeams(teamOf, () => ({ allied: false, sharedVision: false }));
  check("a force that grants nothing allies nobody", !grouped.coAllied(0, 2));
}

console.log("\na neutral CONTROLLER is an alliance the map can overrule, not a shield");
{
  // What SetPlayerController(p, MAP_CONTROL_NEUTRAL) grants, as Blizzard.j grants it:
  // bj_ALLIANCE_NEUTRAL is "clear the ally settings, then set ALLIANCE_PASSIVE", mutually.
  const grantNeutral = (m, p) => {
    for (const other of [...Array(12).keys(), 12, 15]) {
      if (other === p) continue;
      m.set(p, other, AllianceType.Passive, true);
      m.set(other, p, AllianceType.Passive, true);
    }
  };
  const w = new SimWorld(grid(), 1);
  const m = withMatrix(w);
  grantNeutral(m, 1); // the Watchers' Trackers — config() marks them neutral
  grantNeutral(m, 2); // …and the Fishing Village

  // Illidan (8) is named in no alliance line anywhere in the chapter, and still must not
  // touch the village's ships: the controller is the only thing holding him.
  const illidan = addUnit(w, 1, 8, 1, 900, 500);
  const ship = addUnit(w, 2, 2, 2, 1200, 500, { weapons: [], speed: 0 });
  check("Illidan holds his fire toward the village", !w.hostile(illidan, ship));
  run(w, 6);
  check(`…and the ship is untouched (hp ${ship.hp})`, ship.hp === ship.maxHp);

  // The Wildkin cinematic then sets ITS pair at each other — both ways, on purpose.
  const wildkin = addUnit(w, 3, 5, 1, 1500, 1500);
  const archer = addUnit(w, 4, 1, 0, 1620, 1500, { weapons: [], speed: 0 });
  check("before the scene they are at peace", !w.hostile(wildkin, archer));
  m.set(1, 5, AllianceType.Passive, false); // SetPlayerAllianceStateBJ(Trackers, Wildkin, UNALLIED)
  m.set(5, 1, AllianceType.Passive, false); // …and the same line the other way round
  check("the scene's own UNALLIED lines start the fight", w.hostile(wildkin, archer));
  run(w, 6);
  check(`…and the Archer is being mauled (hp ${Math.round(archer.hp)})`, archer.hp < archer.maxHp);

  // …and bj_ALLIANCE_NEUTRAL stops it again, which is how the scene ends.
  m.set(1, 5, AllianceType.Passive, true);
  m.set(5, 1, AllianceType.Passive, true);
  run(w, 1);
  check("writing NEUTRAL back calls it off", !w.hostile(wildkin, archer) && wildkin.targetId === null);
}

console.log(failures ? `\n${failures} FAILED` : "\nalliances: all checks passed");
process.exit(failures ? 1 : 0);
