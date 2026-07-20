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

const relay = spawn(process.execPath, [join(REPO, "server", "relay.mjs")], {
  env: { ...process.env, PORT: String(PORT) },
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
  check("sends hello with a protocol version", hello.protocol === 2);
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
} catch (err) {
  console.error(`\n  FAIL ${err.message}`);
  failures++;
} finally {
  relay.kill();
}

console.log(failures === 0 ? "\nrelay: all checks passed" : `\nrelay: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
