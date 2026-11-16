// SAVED GAMES (issue #159, docs/save-games.md) — the `.o3s` FILE and the folder it lives in.
//
// Pins the container (sections, magic, format), that a header can be read without inflating the
// state, the version check (the game files only — a save from another OpenWar3 build loads as it
// is), and the one writer's rules (electron/saveStore.mjs): a name is a FILE in the
// folder and never a path, written beside and moved over, listed newest first.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { mkdtempSync, rmSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const B = (...p) => require(join(REPO, ".sim-build", "src", ...p));
const { encodeSave, decodeSave, readSaveHeader, saveIncompatibility, SAVE_FORMAT, SAVE_GAME_VERSION } = B("game", "save", "saveFile.js");
const { encodeGraph } = B("game", "save", "graph.js");

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};

const HEADER = {
  format: SAVE_FORMAT, version: "0.9.0", commit: "abc1234", fingerprint: "fp-1", gameVersion: SAVE_GAME_VERSION,
  install: "casc-1.30.4", savedAt: "2026-11-16T12:00:00.000Z", gameTime: 754.5, name: "My Game",
  map: { path: "Maps\\FrozenThrone\\(2)EchoIsles.w3x", name: "Echo Isles", hash: "0123", size: 100, melee: true },
  config: { slots: [], fog: "explored", seed: 7 }, edition: "tft", patch: "2.0.4", localPlayer: 0,
};

(async () => {
  const state = encodeGraph({ sim: { units: new Map([[1, { hp: 420, x: Infinity }]]), grid: new Uint8Array([1, 2, 3]) } });
  const bytes = await encodeSave({ header: HEADER, state, scene: { camera: { distance: 1650 } } });
  check("the file starts OW3S", String.fromCharCode(...bytes.subarray(0, 4)) === "OW3S");
  const back = await decodeSave(bytes);
  check("the header reads back", JSON.stringify(back.header) === JSON.stringify(HEADER));
  check("the state reads back exactly", JSON.stringify(back.state) === JSON.stringify(state));
  check("…and the scene", back.scene?.camera?.distance === 1650);
  check("the header alone can be read", (await readSaveHeader(bytes)).name === "My Game");
  const newer = bytes.slice();
  newer[4] = (SAVE_FORMAT + 1) & 0xff;
  check("a newer format is refused", await decodeSave(newer).then(() => false, () => true));
  check("a replay is not a saved game", await decodeSave(new Uint8Array([0x4f, 0x57, 0x33, 0x52, 1, 0])).then(() => false, () => true));

  // The version check: the game files only. Another OpenWar3 build's save loads as it is.
  check("a save from another OpenWar3 build loads", saveIncompatibility({ ...HEADER, version: "0.1.0", fingerprint: "other" }) === null
    && saveIncompatibility({ ...HEADER, fingerprint: undefined }) === null);
  check("another game version is refused", saveIncompatibility({ ...HEADER, gameVersion: "1.31.1" }) === "game");

  // The store.
  const { createSaveStore, safeSaveName } = await import(join(REPO, "electron", "saveStore.mjs"));
  check("a name is a file, never a path", safeSaveName("../../evil") === "evil.o3s" && safeSaveName("a\\b\\c.o3s") === "c.o3s" && safeSaveName("") === null && safeSaveName(".o3s") === null);
  const dir = mkdtempSync(join(tmpdir(), "ow3-saves-"));
  try {
    const store = createSaveStore(dir);
    check("a save is written under its name", store.write("First", bytes) === "First.o3s" && store.exists("First"));
    await new Promise((r) => setTimeout(r, 20));
    store.write("Second.o3s", bytes);
    const list = store.list();
    check("listed newest first", list.length === 2 && list[0].name === "Second.o3s", JSON.stringify(list));
    check("no half-written file is left behind", readdirSync(dir).every((f) => !f.endsWith(".part")));
    check("read gives the bytes back", Buffer.compare(Buffer.from(store.read("First")), Buffer.from(bytes)) === 0);
    check("delete removes it", store.remove("First") && !store.exists("First"));
    check("a write outside the folder is impossible", store.write("../outside", bytes) === "outside.o3s" && store.exists("outside"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\nsave file: ${failures} check(s) FAILED` : "\nsave file: all checks passed");
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
