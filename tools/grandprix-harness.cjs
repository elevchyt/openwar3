// Azeroth Grand Prix, headless: the REAL `war3map.j` of `Maps\FrozenThrone\Scenario\
// (8)AzerothGrandPrix.w3x` running in the real interpreter over a real `SimWorld`, on the map's
// own terrain (war3map.w3e cliff levels) and pathing (war3map.wpm). Shared by
// tools/ai-plus-grandprix-test.cjs; nothing here is the game's except what it reads out of the
// developer's own install.
//
// What is real: the script (every trigger, timer and wait — the lap dialog, the cart picker, the
// 3-2-1, `Trig_Move_Cart_Actions`' physics, the 34 check points, the lap count, the power-up
// dice and slots, `CompletedAllLaps`), the unit moves (`SimWorld.setUnitPosition`, pathed, and
// the timed facing the cart steers by), `GetTerrainCliffLevel`, the rect and death events.
//
// What is NOT: there is no ability registry here, so a cast is raised to the script as its
// EVENT_PLAYER_UNIT_SPELL_CAST (which is all the map itself listens for — every cart button is a
// Channel dummy) and the dummy casters the script then orders about (`unholyfrenzy`, `slow`,
// `ensnare`…) cast nothing: no buff ever lands, so an Engine Boost is spent and does not speed
// the cart. Trees are not stamped either (the wpm is the editor's bake). The live game has both.

const { readFileSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { requireInstallScripts } = require("./jass-install-scripts.cjs");

const REPO = resolve(__dirname, "..");
const B = (...p) => require(join(REPO, ".sim-build", "src", ...p));
const MAP = join(REPO, "Warcraft III", "Maps", "FrozenThrone", "Scenario", "(8)AzerothGrandPrix.w3x");
const SIM_DT = 1 / 60; // render/mapViewer.ts SIM_DT

/** Is the map there to be read? A contributor without the install skips the live half. */
const available = () => existsSync(MAP) && existsSync(join(REPO, "Warcraft III", "ExtractedData", "merged", "Scripts", "common.j"));

/** The cart bodies and what the script-move natives need to know of them (war3map.w3u: all
 *  eight are `hmtt` with `ucol` 33 — the four racers — or 20 — the four on the picker). */
const CARTS = new Set(["h000", "h002", "h004", "h008"]);
const PICK_CARTS = new Set(["h001", "h007", "h009", "h00B"]);

function boot({ seats, seed = 7 }) {
  require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
  const { SimWorld } = B("sim", "world.js");
  const { PathingGrid, PathingFlag, parseWpm } = B("sim", "pathing.js");
  const { parseW3E } = B("world", "terrain.js");
  const { makeCliffLevelSampler } = B("game", "heightmap.js");
  const { simHooks, unitSnapshots } = B("game", "jassHooks.js");
  const { buildInterpreter } = B("jass", "headless.js");
  const mpq = require("mdx-m3-viewer/dist/cjs/parsers/mpq");
  const Archive = (mpq.default ?? mpq).Archive;

  const SCRIPTS = requireInstallScripts("common.j", "Blizzard.j");
  const archive = new Archive();
  const raw = readFileSync(MAP);
  const bytes = new Uint8Array(raw.byteLength);
  bytes.set(raw);
  archive.load(bytes, true);
  const file = (name) => archive.get(name).bytes();
  const text = (name) => new TextDecoder("windows-1252").decode(file(name));

  const terrain = parseW3E(file("war3map.w3e"));
  const pathing = parseWpm(file("war3map.wpm"));
  // THE TWO BRIDGES. The track crosses a river twice on an Extra Large wooden bridge (`LT08`,
  // war3map.doo: at (1248, −3072) and (4064, −3072), unrotated). In the match a deck is found from
  // the bridge MODEL's own geometry (render/walkableHeight.ts) — it reads the cliff level of the
  // banks it joins and its cells are walkable — and no model is loaded here, so the two decks
  // are stated: the river is 640 across there and the road 640 wide.
  const DECKS = BRIDGES.map(([x, y]) => ({ minX: x - 352, maxX: x + 352, minY: y - 448, maxY: y + 448 }));
  const onDeck = (x, y) => DECKS.some((d) => x >= d.minX && x <= d.maxX && y >= d.minY && y <= d.maxY);
  for (let cy = 0; cy < pathing.height; cy++) {
    for (let cx = 0; cx < pathing.width; cx++) {
      if (onDeck(terrain.centerOffset[0] + (cx + 0.5) * 32, terrain.centerOffset[1] + (cy + 0.5) * 32)) pathing.flags[cy * pathing.width + cx] &= ~PathingFlag.Unwalkable;
    }
  }
  const grid = new PathingGrid(pathing, [terrain.centerOffset[0], terrain.centerOffset[1]]);
  const world = new SimWorld(grid, seed);
  const cliff = makeCliffLevelSampler(terrain);
  world.setCliffLevelField((x, y) => (onDeck(x, y) ? 4 * 128 : cliff(x, y)));

  // --- the world half of the hook table: SimWorld's own, plus the four things a headless host
  //     has to answer itself (a unit's birth, the roster, and the abilities with no registry).
  let nextId = 1;
  const has = new Map(); // sim id → Set of ability ids the script gave it
  const orders = []; // every order a trigger issued, for the test to read
  const spawn = (player, typeId, x, y, facingDeg) => {
    const id = nextId++;
    const cart = CARTS.has(typeId) || PICK_CARTS.has(typeId);
    world.add({
      id, owner: player, team: player, typeId, x, y, facing: (facingDeg * Math.PI) / 180,
      hp: 600, maxHp: 600, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      // `umvs` 0 on every cart: nothing but the script moves one. hmtt's turnRate is 0.4.
      speed: 0, turnRate: 0.4, radius: cart ? 33 : 0, scale: 1,
      armor: 0, armorType: "medium", defUp: 0, sightDay: 1400, sightNight: 800,
      flying: false, mechanical: true, invulnerable: !cart, race: "human",
      isBuilding: false, foodCost: 0, goldCost: 0, lumberCost: 0,
      // Only a cart has a body. Everything else the script makes is a marker, a dummy caster
      // or a pick-up, and must not be something a cart is set down beside.
      upgrades: [], moveType: "foot", collisionSize: CARTS.has(typeId) ? 33 : 0,
      canFlee: false, targetedAs: "ground", deathTime: 0.1, name: typeId,
      worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
      weapons: [], oldWeapons: [],
    });
    const u = world.units.get(id);
    if (u && !CARTS.has(typeId)) u.noCollision = true;
    return id;
  };
  const stash = new Map();
  const hooks = {
    ...simHooks(world, (p) => p),
    createUnit: spawn,
    enumUnits: () => unitSnapshots(world),
    unitAddAbility: (id, ab) => (has.get(id) ?? has.set(id, new Set()).get(id)).add(ab) && true,
    unitRemoveAbility: (id, ab) => !!has.get(id)?.delete(ab),
    getUnitAbilityLevel: (id, ab) => (has.get(id)?.has(ab) ? 1 : 0),
    // A trigger's order. Nothing here walks (every unit's speed is 0, as a cart's is), so the one
    // order the race itself WAITS on is answered at once: `GiveMeNewCart` flies a helicopter to
    // where a cart was destroyed and polls until it is within 20 of the spot before it drops the
    // new one. The dummy casters' spell orders are recorded and cast nothing (see the header).
    issueUnitOrder: (id, orderId, order, kind, x, y, targetId) => {
      orders.push({ id, order, kind, x, y, targetId });
      if (order === "move" && kind === "point") world.setUnitPosition(id, x, y, false);
      return true;
    },
    getPlayerState: (p, s) => stash.get(`${p}:${s}`) ?? 0,
    setPlayerState: (p, s, v) => void stash.set(`${p}:${s}`, v),
  };
  world.captureDeaths = true;

  const silent = console.warn;
  const interp = buildInterpreter(
    [readFileSync(join(SCRIPTS, "common.j"), "latin1"), readFileSync(join(SCRIPTS, "Blizzard.j"), "latin1"), text("war3map.j")],
    { hooks, wts: new TextDecoder("utf-8").decode(file("war3map.wts")), seed },
  );
  const rt = interp.rt;
  rt.recordOnlySpawnFns?.delete("CreateAllUnits"); // nothing is adopted here: the script places its own
  interp.run("config", []);
  // Every seat a PERSON's, as the map expects of its racers (docs/grand-prix-ai.md "Seating").
  rt.applyLobby(seats.map((index) => ({ index, raceIndex: 1, controller: 0, team: index, startLocation: index })), seats[0]);
  rt.mapInitializing = true;
  interp.run("main", []);
  rt.mapInitializing = false;
  console.warn = silent;

  const snap = (id) => {
    const u = world.units.get(id);
    return u ? { id: u.id, typeId: u.typeId, owner: u.owner, x: u.x, y: u.y, facing: u.facing } : null;
  };
  let clock = 0;
  /** One sim step, in the scene's own order: the AIs think, the world steps, the script is
   *  pumped (MapViewerScene.pumpMapScript). */
  const step = (think) => {
    think?.(SIM_DT);
    world.tick(SIM_DT);
    interp.advanceTime(SIM_DT);
    const deaths = world.drainDeathEvents();
    if (deaths.length) interp.pumpUnitDeaths(deaths);
    interp.pumpRegions(unitSnapshots(world));
    clock += SIM_DT;
  };

  // --- what a script global holds, read the way MapViewerScene's reader does ---
  const num = (name, index) => {
    const v = index === undefined ? rt.globals.get(name) : rt.globalArrays.get(name)?.get(index);
    return v && (v.k === "int" || v.k === "real") ? v.n : null;
  };
  const unitOf = (name, index) => {
    const v = index === undefined ? rt.globals.get(name) : rt.globalArrays.get(name)?.get(index);
    const u = v && v.k === "handle" ? rt.data(v) : undefined;
    return u && !u.removed && u.simId >= 0 && world.units.has(u.simId) ? u.simId : 0;
  };
  const point = (name, index) => {
    const v = rt.globalArrays.get(name)?.get(index);
    const p = v && v.k === "handle" ? rt.data(v) : undefined;
    return p && typeof p.x === "number" ? { x: p.x, y: p.y } : null;
  };
  const str = (name, index) => {
    const v = rt.globalArrays.get(name)?.get(index);
    return v && v.k === "string" ? v.s : null;
  };

  /** The four doors a seat has onto the script, exactly as the scene opens them
   *  (`MapViewerScene.grandPrixPort`): its arrow keys, a dialog button, and the two reads. */
  const port = {
    num, unit: unitOf, point,
    arrow: (player, ev) => {
      if (interp.playerEventAnswered(player, ev)) interp.firePlayerEvent(player, ev);
    },
    dialog: (player) => {
      const d = rt.dialogs.find((x) => x.visibleFor.has(player));
      return d ? { id: d.handleId, buttons: d.buttons.map((b) => ({ id: b.handleId, text: b.text })) } : null;
    },
    clickDialog: (player, dialog, button) => {
      const d = rt.dialogs.find((x) => x.handleId === dialog);
      d?.visibleFor.delete(player);
      interp.fireDialogClick(button, dialog, player);
    },
  };

  /** `Authority.execute`, as far as this map needs it: a cast is the unit's own ability, raised
   *  to the script as the spell event its triggers wait for. Everything else is refused. */
  const casts = [];
  const execute = (player, cmd) => {
    if (cmd.c !== "cast") return false;
    const u = world.units.get(cmd.unitId);
    if (!u || u.owner !== player || !has.get(u.id)?.has(cmd.code) && !PICK_ABILITIES[u.typeId]?.includes(cmd.code)) return false;
    casts.push({ player, code: cmd.code, at: clock });
    interp.pumpSpellEvents([{ caster: snap(u.id), abilityId: cmd.code, phase: "cast", target: null, x: u.x, y: u.y }]);
    return true;
  };

  return {
    world, grid, terrain, interp, rt, port, execute, step, num, unit: unitOf, point, str, casts, orders, has,
    get clock() { return clock; },
    SIM_DT,
  };
}

/** The track's two `LT08` bridges (war3map.doo). */
const BRIDGES = [[1248, -3072], [4064, -3072]];

/** What each picker cart carries (war3map.w3u `uabi`): Previous, its own Select, Next. */
const PICK_ABILITIES = {
  h001: ["A002", "A00V", "A00S"],
  h007: ["A002", "A00U", "A00S"],
  h009: ["A002", "A00Z", "A00S"],
  h00B: ["A002", "A00W", "A00S"],
};

module.exports = { boot, available, MAP, SIM_DT, PICK_ABILITIES };
