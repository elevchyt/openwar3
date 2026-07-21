// Headless test for the relay (server/relay.mjs) — no browser, no MPQs.
//
// Drives two clients through the whole LAN flow: host announces a game, joiner sees it in
// the list and joins, both see the peer list agree, opaque game traffic crosses, and the
// host leaving closes the room (v1 has no host migration — docs/multiplayer.md).
//
// Also covers the start handshake: the host announces which MAP (a path into each install,
// never the file), and its `start` carries one seed plus the slot table both clients read —
// each finding its own seat in it by peer id.
//
// Run:  pnpm relay:test

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799; // not the default, so a relay you already have running is left alone
const URL = `ws://localhost:${PORT}`;
/** The relay's ping interval, wound right down so a reaping is watchable inside a test run.
 *  A live client answers a ping under the WebSocket protocol itself, so a fast beat is
 *  harmless to every other section here — which is the point of running them all under it. */
const HEARTBEAT_MS = 250;
/** The map a hosted game advertises. A path into the install, never the file itself. */
const MAP_PATH = "Maps\\\\FrozenThrone\\\\(2)EchoIsles.w3x";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) failures++;
};

/** A test client: collects every message, and can await the next one of a given type. */
function client(name) {
  const ws = new WebSocket(URL);
  const seen = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    seen.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].t === msg.t) {
        // Claim it here too, not only on the already-buffered path: an unclaimed message
        // stays visible to the next next() of the same type, so a later `rooms` check
        // could match a STALE earlier broadcast and pass or fail at random.
        msg.__claimed = true;
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  });
  return {
    name,
    ws,
    seen,
    send: (m) => ws.send(JSON.stringify(m)),
    /** Wait for the next message of type `t` (or one already received but unclaimed). */
    next(t, ms = 2000) {
      const pending = seen.find((m) => m.t === t && !m.__claimed);
      if (pending) {
        pending.__claimed = true;
        return Promise.resolve(pending);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: timed out waiting for '${t}'`)), ms);
        waiters.push({ t, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    open: () => new Promise((r) => (ws.readyState === WebSocket.OPEN ? r() : ws.on("open", r))),
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the relay for the game list and read the answer. Every `rooms` already received is
 *  claimed FIRST, so this cannot hand back a stale broadcast from an earlier room change. */
async function roomsNow(c) {
  for (const m of c.seen) if (m.t === "rooms") m.__claimed = true;
  c.send({ t: "list" });
  return await c.next("rooms", 3000);
}

const relay = spawn(process.execPath, [join(REPO, "server", "relay.mjs")], {
  env: { ...process.env, PORT: String(PORT), RELAY_HEARTBEAT_MS: String(HEARTBEAT_MS) },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("relay did not start")), 5000);
  relay.stdout.on("data", (d) => {
    if (d.toString().includes("listening")) { clearTimeout(timer); resolve(); }
  });
});

try {
  console.log("relay handshake + game list");
  const host = client("host");
  await host.open();
  const hello = await host.next("hello");
  check("sends hello with a protocol version", hello.protocol === 3);
  const empty = await host.next("rooms");
  check("game list starts empty", Array.isArray(empty.rooms) && empty.rooms.length === 0);

  console.log("host announces a game");
  host.send({
    t: "create", name: "Test Game", playerName: "Host",
    mapName: "Echo Isles", mapPath: MAP_PATH, maxPlayers: 2,
  });
  const created = await host.next("created");
  check("host is peer 1 and flagged host", created.you.id === 1 && created.you.host === true);
  check("room carries the map name", created.room.mapName === "Echo Isles");
  // The PATH is what a joiner resolves in its own install; the map file never crosses the
  // wire (src/net/protocol.ts RoomInfo.mapPath). A room without it is unjoinable.
  check("room carries the map path", created.room.mapPath === MAP_PATH);

  console.log("joiner sees the game and joins");
  const joiner = client("joiner");
  await joiner.open();
  await joiner.next("hello");
  const list = await joiner.next("rooms");
  check("game appears in the list", list.rooms.length === 1 && list.rooms[0].hostName === "Host");
  check("the listing advertises the map path", list.rooms[0].mapPath === MAP_PATH);
  joiner.send({ t: "join", roomId: created.room.id, playerName: "Joiner" });
  const joined = await joiner.next("joined");
  check("joiner is not host", joined.you.host === false && joined.you.id === 2);
  check("joiner sees both peers", joined.peers.length === 2);
  const peerJoin = await host.next("peer-join");
  check("host is told the peer joined", peerJoin.peer.name === "Joiner");

  console.log("opaque game traffic");
  host.send({ t: "relay", data: { hello: "world" } });
  const delivered = await joiner.next("deliver");
  check("payload arrives verbatim", delivered.data.hello === "world" && delivered.from === 1);

  console.log("the host starts the match");
  // The host's "we are playing this, now" — one seed, one slot table, each client picking
  // its own seat out of it by peer id (docs/multiplayer.md, protocol.ts StartMatch).
  const start = {
    k: "start",
    mapPath: MAP_PATH,
    mapName: "Echo Isles",
    seed: 12345,
    slots: [
      { id: 0, controller: "user", race: "human", team: 0, startX: 100, startY: 200, peer: 1 },
      { id: 1, controller: "user", race: "orc", team: 1, startX: 300, startY: 400, peer: 2 },
    ],
  };
  host.send({ t: "relay", data: start });
  const got = await joiner.next("deliver");
  check("the joiner is told to start", got.data.k === "start" && got.from === 1);
  check("both machines get the SAME seed", got.data.seed === 12345);
  // The one thing the two clients read differently out of one message.
  const mine = got.data.slots.find((s) => s.peer === joined.you.id);
  check("the joiner finds its own slot by peer id", mine && mine.id === 1 && mine.race === "orc");

  console.log("a full room refuses further joins");
  const third = client("third");
  await third.open();
  await third.next("hello");
  third.send({ t: "join", roomId: created.room.id, playerName: "Third" });
  const full = await third.next("error");
  check("third player is refused (maxPlayers 2)", /full/i.test(full.message));
  third.ws.close();

  console.log("host leaving closes the room");
  host.ws.close();
  const closed = await joiner.next("room-closed");
  check("joiner is told the host left", /host/i.test(closed.reason));
  joiner.send({ t: "list" });
  const after = await joiner.next("rooms");
  check("room is gone from the list", after.rooms.length === 0);
  joiner.ws.close();

  console.log("addressing a peer whose slot is HELD does not kill the relay");
  // The failure this covers took the whole SERVER down, so it is checked over real sockets and
  // the check is "is the relay still there afterwards" rather than anything about the message.
  // A player choosing Quit Game leaves their slot held (item 11a: peer stays, `conn` goes
  // null); the host keeps addressing snapshots to it at 10 Hz; the first one threw out of the
  // connection handler and ended the process, taking every other room with it.
  {
    const h = client("holder");
    await h.open();
    await h.next("hello");
    h.send({
      t: "create", name: "Held Slot", playerName: "Host",
      mapName: "Echo Isles", mapPath: MAP_PATH, maxPlayers: 2,
    });
    await h.next("created");

    const leaver = client("leaver");
    await leaver.open();
    await leaver.next("hello");
    leaver.send({ t: "join", roomId: (await roomsNow(h)).rooms[0].id, playerName: "Leaver" });
    await leaver.next("joined");
    await h.next("peer-join");

    leaver.ws.close();
    const dropped = await h.next("peer-drop");
    check("the room holds the departed player's slot", dropped.peerId, 2);

    // The exact message the host's snapshot cadence sends, to the exact peer that is not there.
    h.send({ t: "relay", to: 2, data: { k: "snap", snap: { recipient: 1 } } });
    // …and THE check: the relay is still serving. Before the guard, this timed out because the
    // process was gone — along with every other game it was hosting.
    const alive = await roomsNow(h).catch(() => null);
    check("the relay survives it and is still answering", alive?.rooms?.length, 1);
    check("…and the room is still there, with the slot still held", alive?.rooms?.[0]?.name, "Held Slot");
    h.ws.close();
    await delay(HEARTBEAT_MS * 2);
  }

  console.log("a socket that dies WITHOUT closing is reaped");
  // The failure this covers was seen live: the games list advertised a room whose both tabs
  // had been shut minutes earlier. `ws.on("close")` never fired for them, because a tab that
  // is force-killed (or a laptop lid, or wifi pulled) sends no FIN — the socket just stops.
  const zombie = client("zombie");
  await zombie.open();
  await zombie.next("hello");
  zombie.send({
    t: "create", name: "Ghost Game", playerName: "Zombie",
    mapName: "Echo Isles", mapPath: MAP_PATH, maxPlayers: 2,
  });
  await zombie.next("created");

  const watcher = client("watcher");
  await watcher.open();
  await watcher.next("hello");
  const listedAlive = await roomsNow(watcher);
  check(
    "the room is listed while its host is answering",
    listedAlive.rooms.length === 1 && listedAlive.rooms[0].name === "Ghost Game",
  );

  // Pull the plug at the physical layer: stop READING bytes off the socket, so the relay's
  // ping frame is never parsed and so never answered. No FIN, no close event, no error —
  // from Node's side the connection is still perfectly open. This is the only way to make
  // the bug appear, which is why the check is worth its weight.
  zombie.ws._socket.pause();

  // An unanswered poll is reported as "still listed" rather than thrown: a sweep that reaps
  // the WATCHER too would otherwise abort the section on a timeout, and the three claims below
  // would never be judged — the loudest failure would name the wrong thing.
  const askOrNothing = () => roomsNow(watcher).catch(() => null);

  let listedDead = listedAlive;
  const deadline = Date.now() + HEARTBEAT_MS * 12;
  while (Date.now() < deadline && (listedDead?.rooms?.length ?? 1) > 0) {
    await delay(HEARTBEAT_MS);
    listedDead = await askOrNothing();
  }
  check("a host that stops answering pings is reaped and its room delisted", listedDead?.rooms?.length === 0);
  // The other half of the claim, and the half a "terminate everything each beat" relay would
  // fail: a client that DID answer, across a dozen beats, is still connected and still served.
  check("a live client is not terminated by the heartbeat", watcher.ws.readyState === WebSocket.OPEN);
  const stillServed = await askOrNothing();
  check("the live client is still answered after those beats", Array.isArray(stillServed?.rooms));
  watcher.ws.close();
  zombie.ws.terminate();
} catch (err) {
  console.error(`\n  FAIL ${err.message}`);
  failures++;
} finally {
  relay.kill();
}

console.log(failures === 0 ? "\nrelay: all checks passed" : `\nrelay: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
