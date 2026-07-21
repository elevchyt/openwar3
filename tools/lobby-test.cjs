// Headless check of the CLIENT lobby's reconnect (docs/multiplayer.md item 11a-client).
//
// LanLobby could not be tested at all before this: it imported `WebSocketTransport`, whose
// `import.meta`/`window` cannot compile to the CommonJS these tests run as. The transport
// dependency is now INVERTED — the lobby takes a factory and imports only `type Transport` —
// so a fake transport drives the whole reconnect flow here, and the decision it turns on
// (`reconnectPlan`) is pinned directly.
//
// Run: pnpm sim:test  (it compiles src/net/lobby.ts + reconnect.ts into .sim-build first)
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { LanLobby } = require(join(REPO, ".sim-build", "src", "net", "lobby.js"));
const { reconnectPlan, memoryStore } = require(join(REPO, ".sim-build", "src", "net", "reconnect.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A fake `LobbyTransport`: records what the lobby sends, lets the test play the relay by
 *  driving `onMessage`, and can be `drop()`ped to fire `onClose` exactly as a lost socket does. */
function fakeTransport() {
  const t = {
    sent: [],
    onMessage: () => {},
    onClose: () => {},
    connected: true,
    connect: () => Promise.resolve(),
    send: (m) => t.sent.push(m),
    close: () => {
      t.connected = false;
    },
    drop: (reason) => {
      t.connected = false;
      t.onClose(reason);
    },
  };
  return t;
}

const ROOM = { id: "7", name: "G", hostName: "H", mapName: "Echo Isles", mapPath: "m", players: 2, maxPlayers: 2 };
const ME = { id: 2, name: "Joiner", host: false };

(async () => {
  console.log("reconnectPlan: rejoin only while the room is still listed");
  {
    const s = { roomId: "7", token: "tok", playerName: "Joiner" };
    check("a listed room is a go", reconnectPlan(s, [ROOM]), s);
    check("a vanished room gives up", reconnectPlan(s, []), null);
    check("no session, nothing to do", reconnectPlan(null, [ROOM]), null);
  }

  /** A connected lobby whose transport is `lobby._t`, joined into ROOM as ME with a token. */
  async function joinedLobby() {
    const store = memoryStore();
    let t;
    const lobby = new LanLobby(() => (t = fakeTransport()), store);
    await lobby.connect();
    t.onMessage({ t: "joined", room: ROOM, you: ME, peers: [{ id: 1, name: "H", host: true }, ME], token: "tok" });
    return { lobby, store, t: () => t, transports: () => [t] };
  }

  console.log("\nthe token is stashed on join and cleared on a chosen leave");
  {
    const store = memoryStore();
    let t;
    const lobby = new LanLobby(() => (t = fakeTransport()), store);
    await lobby.connect();
    check("nothing stored before joining", store.load(), null);

    t.onMessage({ t: "joined", room: ROOM, you: ME, peers: [ME], token: "tok" });
    check("the token is stashed on join", store.load(), { roomId: "7", token: "tok", playerName: "Joiner" });

    lobby.leave();
    check("a chosen leave forgets it — no crawling back", store.load(), null);
  }

  console.log("\na drop reconnects and reclaims the slot on the token");
  {
    const store = memoryStore();
    const made = [];
    const lobby = new LanLobby(() => {
      const t = fakeTransport();
      made.push(t);
      return t;
    }, store);
    await lobby.connect(); // made[0]
    made[0].onMessage({ t: "joined", room: ROOM, you: ME, peers: [ME], token: "tok" });
    check("in the match", lobby.snapshot.phase, "joined");

    made[0].drop("Connection to the game host was lost.");
    await new Promise((r) => setTimeout(r, 0)); // let the reconnect's connect() promise settle
    check("a new transport was opened for the reconnect", made.length, 2);
    check("the UI shows it is reconnecting, not dead", lobby.snapshot.error, "Reconnecting…");

    // The relay answers the reconnect with its game list — our room is still there.
    made[1].onMessage({ t: "rooms", rooms: [ROOM] });
    const join = made[1].sent.find((m) => m.t === "join");
    check("we rejoined with the stored token, not as a stranger", [join?.roomId, join?.token], ["7", "tok"]);
    check("and to the same room under the same name", [join?.playerName], ["Joiner"]);

    // The relay puts us back (same peer id 2, same token) and the match resumes.
    made[1].onMessage({ t: "joined", room: ROOM, you: ME, peers: [ME], token: "tok" });
    check("we are back in", [lobby.snapshot.phase, lobby.snapshot.you?.id, lobby.snapshot.error], ["joined", 2, null]);
  }

  console.log("\na drop into a game that has ENDED gives up, and forgets the token");
  {
    const store = memoryStore();
    const made = [];
    const lobby = new LanLobby(() => {
      const t = fakeTransport();
      made.push(t);
      return t;
    }, store);
    await lobby.connect();
    made[0].onMessage({ t: "joined", room: ROOM, you: ME, peers: [ME], token: "tok" });

    made[0].drop("lost");
    await new Promise((r) => setTimeout(r, 0));
    // The host left while we were gone: the room is not in the reconnect's game list.
    made[1].onMessage({ t: "rooms", rooms: [] });
    check("no rejoin is attempted against a room that is gone", made[1].sent.some((m) => m.t === "join"), false);
    check("the player is told the game ended", lobby.snapshot.error, "The game has ended.");
    check("and the dead token is forgotten", store.load(), null);
  }

  console.log("\na drop while merely BROWSING is a plain disconnect, not a reconnect");
  {
    const store = memoryStore(); // no session
    const made = [];
    const lobby = new LanLobby(() => {
      const t = fakeTransport();
      made.push(t);
      return t;
    }, store);
    await lobby.connect();
    made[0].onMessage({ t: "rooms", rooms: [ROOM] }); // browsing the list, never joined

    made[0].drop("Connection lost.");
    await new Promise((r) => setTimeout(r, 0));
    check("no reconnect transport is opened", made.length, 1);
    check("the disconnect is shown as-is", [lobby.snapshot.phase, lobby.snapshot.error], ["offline", "Connection lost."]);
  }

  console.log("\na dropped PEER is kept in the roster; a leave removes it");
  {
    const store = memoryStore();
    let t;
    const lobby = new LanLobby(() => (t = fakeTransport()), store);
    await lobby.connect();
    const other = { id: 3, name: "Other", host: false };
    t.onMessage({ t: "joined", room: ROOM, you: ME, peers: [{ id: 1, name: "H", host: true }, ME, other], token: "tok" });

    t.onMessage({ t: "peer-drop", peerId: 3 });
    check("a dropped peer stays in the roster (it may be back)", lobby.snapshot.peers.some((p) => p.id === 3), true);

    let rejoined = [];
    lobby.onPeerRejoin = (id) => rejoined.push(id);
    t.onMessage({ t: "peer-rejoin", peer: other });
    check("a rejoin keeps it present without duplicating", lobby.snapshot.peers.filter((p) => p.id === 3).length, 1);
    // ...and the MATCH is told, which is what makes the host owe that seat a catch-up snapshot
    // (item 11b). Without this the roster would heal and the returning player would sit looking
    // at a world frozen at the moment their connection blinked, with nothing to say so.
    check("the match is told who came back", rejoined, [3]);
    // A plain join is not a rejoin: nobody is owed anything.
    t.onMessage({ t: "peer-join", peer: { id: 4, name: "New", host: false } });
    check("an ordinary join owes nobody a catch-up", rejoined, [3]);

    t.onMessage({ t: "peer-leave", peerId: 3 });
    check("a chosen leave removes it", lobby.snapshot.peers.some((p) => p.id === 3), false);
  }

  console.log(failed === 0 ? "\nlobby: all checks passed" : `\nlobby: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
