// Headless check of a LAN game's MAP crossing from host to joiner (src/net/mapTransfer.ts,
// ui/mapDownload.ts): two real `LanLobby`s, each on a fake transport, with this file playing
// the relay between them — exactly what server/rooms.mjs does with a `relay`: stamp `from`,
// deliver to `to`. Then the seating rule that keeps a downloading player out of a start
// (net/lobbySetup.ts `LobbySlot.download`), and the file-name rules of assets/downloadedMaps.ts.
//
// Run: pnpm sim:test  (it compiles src/net/lobby.ts + its imports into .sim-build first)
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { LanLobby } = require(join(REPO, ".sim-build", "src", "net", "lobby.js"));
const { memoryStore } = require(join(REPO, ".sim-build", "src", "net", "reconnect.js"));
const { fetchMap, MAP_CHUNK } = require(join(REPO, ".sim-build", "src", "net", "mapTransfer.js"));
const { buildStart, canStart, markDownloads, newSetup, seatPeers } = require(join(REPO, ".sim-build", "src", "net", "lobbySetup.js"));
const { localMapPath, safeMapName, downloadedMapKey } = require(join(REPO, ".sim-build", "src", "assets", "downloadedMaps.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const PATH = "Maps\\Custom\\(3)Test.w3x";
const ROOM = { id: "1", name: "G", hostName: "Host", mapName: "Test", mapPath: PATH, players: 2, maxPlayers: 3 };
const HOST = { id: 1, name: "Host", host: true };
const JOINER = { id: 2, name: "Joiner", host: false };

/** Two lobbies wired through a relay of our own. The relay delivers asynchronously, as a socket
 *  does, so a whole download is many turns of the event loop. */
async function room(mapBytes) {
  let ht, jt;
  const fake = (onSend) => {
    const t = { onMessage: () => {}, onClose: () => {}, connected: true, connect: () => Promise.resolve(), close: () => {}, send: onSend };
    return t;
  };
  const relayed = { toHost: 0, toJoiner: 0 };
  const host = new LanLobby(() => (ht = fake((m) => {
    if (m.t !== "relay") return;
    relayed.toJoiner++;
    setTimeout(() => jt.onMessage({ t: "deliver", from: HOST.id, data: JSON.parse(JSON.stringify(m.data)) }), 0);
  })), memoryStore());
  const joiner = new LanLobby(() => (jt = fake((m) => {
    if (m.t !== "relay") return;
    relayed.toHost++;
    setTimeout(() => ht.onMessage({ t: "deliver", from: JOINER.id, data: JSON.parse(JSON.stringify(m.data)) }), 0);
  })), memoryStore());
  await host.connect();
  await joiner.connect();
  ht.onMessage({ t: "created", room: ROOM, you: HOST, token: "h" });
  ht.onMessage({ t: "peer-join", peer: JOINER });
  jt.onMessage({ t: "joined", room: ROOM, you: JOINER, peers: [HOST, JOINER], token: "j" });
  host.mapSource = (p) => (p === PATH && mapBytes ? new File([mapBytes], "(3)Test.w3x") : null);
  return { host, joiner, ht, jt, relayed };
}

(async () => {
  console.log("a map crosses whole, piece by piece");
  {
    const bytes = new Uint8Array(MAP_CHUNK * 5 + 1234);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const { host, joiner } = await room(bytes);
    const seen = [];
    host.onChange = (s) => seen.push(s.downloads[JOINER.id]);
    const progress = [];
    const got = await fetchMap(joiner.mapWire(), PATH, (f, size) => progress.push([f, size]), new AbortController().signal);
    check("every byte arrived, in order", got.length === bytes.length && got.every((b, i) => b === bytes[i]), true);
    check("progress ends at 1 and knows the size", progress[progress.length - 1], [1, bytes.length]);
    check("the host counted the joiner as downloading, up to 100%", seen.includes(100) && seen[0] !== undefined, true);
    check("…and still does until the joiner says the map is in", host.snapshot.downloads, { [JOINER.id]: 100 });
    joiner.mapWire().arrived(PATH);
    await tick();
    check("`mapgot` takes it off the list", host.snapshot.downloads, {});
  }

  console.log("\nthe host serves its room's map and nothing else");
  {
    const { joiner } = await room(new Uint8Array(10));
    const err = await fetchMap(joiner.mapWire(), "war3.mpq", () => {}, new AbortController().signal).catch((e) => e.message);
    check("another path is refused", err, "The host only sends the map of its own game.");
  }
  {
    const { joiner } = await room(null);
    const err = await fetchMap(joiner.mapWire(), PATH, () => {}, new AbortController().signal).catch((e) => e.message);
    check("a host that cannot read its map says so", err, "The host could not read its map.");
  }
  {
    const { joiner } = await room(new Uint8Array(10));
    const ac = new AbortController();
    const p = fetchMap(joiner.mapWire(), PATH, () => {}, ac.signal);
    ac.abort();
    check("Cancel rejects at once", await p.catch((e) => e.name), "AbortError");
  }

  console.log("\na leaver is forgotten by the host");
  {
    const bytes = new Uint8Array(MAP_CHUNK * 40);
    const { host, joiner, ht } = await room(bytes);
    const ac = new AbortController();
    const p = fetchMap(joiner.mapWire(), PATH, (f) => { if (f > 0.2) ac.abort(); }, ac.signal).catch(() => {});
    await p;
    await tick();
    check("mid-download the host lists the joiner", JOINER.id in host.snapshot.downloads, true);
    ht.onMessage({ t: "peer-leave", peerId: JOINER.id });
    check("a peer-leave takes it off", host.snapshot.downloads, {});
  }

  console.log("\na seat still downloading is not in the match");
  {
    const map = {
      slots: [0, 1, 2].map((id) => ({ id, defaultRace: "human", startX: id, startY: 0, controller: "user", team: id })),
      isMelee: false,
    };
    let setup = newSetup(PATH, "Test", "G", map);
    const third = { id: 3, name: "Late", host: false };
    setup = seatPeers(setup, [HOST, JOINER, third]).setup;
    const peers = [HOST, JOINER, third];
    check("three seated can start", canStart(setup, peers), true);
    setup = markDownloads(setup, { [third.id]: 42 });
    check("the row carries its percentage", setup.slots.find((s) => s.peer === third.id).download, 42);
    check("two playing + one downloading can still start", canStart(setup, peers), true);
    check("…and the start leaves the downloader out",
      buildStart(setup, 1).slots.map((s) => s.peer), [HOST.id, JOINER.id]);
    const two = markDownloads(setup, { [JOINER.id]: 10, [third.id]: 42 });
    check("one playing + two downloading cannot", canStart(two, peers), false);
    const done = markDownloads(setup, {});
    check("once it is in, the mark goes", done.slots.some((s) => "download" in s), false);
    check("an unchanged mark is the same setup", markDownloads(setup, { [third.id]: 42 }) === setup, true);
  }

  console.log("\nwhere a downloaded map is kept and found");
  {
    check("the host's file name, safe", safeMapName("Maps\\Custom\\(4)Some Map.w3x"), "(4)Some Map.w3x");
    check("a path that climbs is reduced to its name", safeMapName("..\\..\\evil.w3m"), "evil.w3m");
    check("not a map, no name", safeMapName("Maps\\x.exe"), null);
    check("the key", downloadedMapKey("(2)A.w3x"), "Maps\\Download\\(2)A.w3x");
    const maps = new Map([["maps\\download\\(2)A.w3x", null], ["Maps\\FrozenThrone\\(2)EchoIsles.w3x", null]]);
    check("the host's own path first", localMapPath(maps, "Maps\\FrozenThrone\\(2)EchoIsles.w3x"), "Maps\\FrozenThrone\\(2)EchoIsles.w3x");
    check("then a copy in Download, any case", localMapPath(maps, "Maps\\Custom\\(2)A.w3x"), "maps\\download\\(2)A.w3x");
    check("else nothing", localMapPath(maps, "Maps\\Custom\\(2)B.w3x"), null);
  }

  console.log(failed === 0 ? "\nmap transfer: all checks passed" : `\nmap transfer: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
