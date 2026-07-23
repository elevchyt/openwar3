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
const {
  allSeated, applyRequest, buildStart, newSetup, seatPeers,
} = require(join(REPO, ".sim-build", "src", "net", "lobbySetup.js"));

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

  // -------------------------------------------------------------------------------------
  // Phase F item 4: the wire changes hands at match start, and the menu must not close it.
  //
  // `startGame` disposes the glue BEFORE it attaches the match link — it has to, the world the
  // link snapshots does not exist until after the map loads. So the LAN screen's own teardown
  // was closing the socket a beat before the match was wired onto it. The symptom was silent
  // on both ends: the host counted 685 snapshots "sent" into a closed transport, and the
  // client received 0 while both windows sat happily simulating.
  // -------------------------------------------------------------------------------------

  console.log("\nthe match's wire survives the screen that made it (item F4)");
  {
    const { lobby, t } = await joinedLobby();
    check("connected while in the lobby", t().connected, true);

    lobby.handOff(); // the LAN screen hands the link to the match…
    lobby.dispose(); // …and is then disposed by startGame, an instant later
    check("the screen's dispose does NOT close the match's wire", t().connected, true);
    // And it is still a working wire, not merely an unclosed one: the match sends through it.
    const before = t().sent.length;
    lobby.send({ k: "snap" }, 2);
    check("the match can still send", t().sent.length, before + 1);

    lobby.close(); // End Game
    check("leaving the match closes it", t().connected, false);
  }

  console.log("\n…and without a hand-off the screen still closes it");
  {
    // The counter-check, and it is what stops the fix from being "dispose never closes
    // anything". Cancel out of the LAN screen and the socket must go.
    const { lobby, t } = await joinedLobby();
    lobby.dispose();
    check("a screen that never handed off still closes its own wire", t().connected, false);
  }

  // -------------------------------------------------------------------------------------
  // Phase F item 6: the room closing IS the end of the match, and the match has to be told.
  //
  // v1 has no host migration, so a host leaving ends the game for everyone. The relay says so
  // once, with `room-closed`, and nothing else ever will — the wire just goes quiet. A client
  // that is not told keeps simulating a world nobody owns and shows the player nothing.
  // -------------------------------------------------------------------------------------

  console.log("\nthe match is told when the room closes (item F6)");
  {
    const { lobby, store, t } = await joinedLobby();
    lobby.handOff(); // in a match: the screen is long gone, so onChange reaches nobody
    const told = [];
    // Recorded WITH the room state at the moment of the call: the match must not be told while
    // the lobby still claims to be in a room, or anything that reads it in response sees a lie.
    lobby.onRoomClosed = (reason) => told.push(`${reason} | inRoom=${lobby.snapshot.room !== null}`);
    t().onMessage({ t: "room-closed", reason: "The host left the game." });
    check("the match is told, with the reason, after the room is gone",
      told, ["The host left the game. | inRoom=false"]);
    check("and the rejoin token is forgotten — there is nothing to come back to", store.load(), null);
  }

  // -------------------------------------------------------------------------------------
  // Issue #77: the GAME LOBBY's seating.
  //
  // Creating a LAN game drops the host into a lobby (UI\FrameDef\Glue\GameChatroom.fdf) and
  // everyone who joins afterwards lands in it too, auto-seated in the first Open slot. The
  // host owns that seating; these are the rules it runs, with no screen and no relay.
  // -------------------------------------------------------------------------------------

  console.log("\ngame lobby: auto-seating (issue #77)");
  {
    /** A 4-slot melee map, plus a custom one whose last slot the MAP owns. */
    const melee = { slots: [0, 1, 2, 3].map((id) => ({ id, defaultRace: "human", startX: id, startY: 0, controller: "user", team: id })) };
    const custom = {
      slots: [
        { id: 0, defaultRace: "human", startX: 0, startY: 0, controller: "user", team: 0 },
        { id: 1, defaultRace: "orc", startX: 1, startY: 0, controller: "user", team: 0 },
        { id: 11, defaultRace: "undead", startX: 2, startY: 0, controller: "computer", team: 1 },
      ],
    };
    const HOST = { id: 1, name: "Alice", host: true };
    const GUEST = { id: 2, name: "Bob", host: false };
    const kinds = (s) => s.slots.map((x) => x.kind);
    const names = (s) => s.slots.map((x) => x.name ?? null);

    const fresh = newSetup("m", "Echo Isles", "Local Game (Alice)", melee);
    check("a fresh lobby is all Open", kinds(fresh), ["open", "open", "open", "open"]);
    check("…and a slot the MAP owns is its computer", kinds(newSetup("m", "M", "G", custom)),
      ["open", "open", "computer"]);

    const withHost = seatPeers(fresh, [HOST]);
    check("the host takes the first slot", kinds(withHost.setup), ["player", "open", "open", "open"]);
    check("…under its own name", names(withHost.setup), ["Alice", null, null, null]);

    const withGuest = seatPeers(withHost.setup, [HOST, GUEST]);
    check("a joiner drops into the first OPEN slot", kinds(withGuest.setup),
      ["player", "player", "open", "open"]);
    check("…and is reported as having joined", withGuest.joined.map((p) => p.name), ["Bob"]);
    check("the host is not re-seated", names(withGuest.setup), ["Alice", "Bob", null, null]);

    // A slot the host CLOSED is not a seat a joiner may be dropped into…
    const closed = { ...withHost.setup, slots: withHost.setup.slots.map((s, i) => (i === 1 ? { ...s, kind: "closed" } : s)) };
    check("a closed slot is skipped for the next open one",
      kinds(seatPeers(closed, [HOST, GUEST]).setup), ["player", "closed", "player", "open"]);

    // …but a person already in the room outranks a parked seat when there is nothing else.
    const allClosed = { ...withHost.setup, slots: withHost.setup.slots.map((s, i) => (i ? { ...s, kind: "closed" } : s)) };
    check("with no open seat left, a joiner takes a closed one rather than standing",
      kinds(seatPeers(allClosed, [HOST, GUEST]).setup), ["player", "player", "closed", "closed"]);

    // The map's own computer is never a seat, however full the lobby gets.
    const locked = seatPeers(newSetup("m", "M", "G", custom), [HOST, GUEST, { id: 3, name: "Cara", host: false }]);
    check("the map's own computer is never seated over", kinds(locked.setup), ["player", "player", "computer"]);
    check("…and the peer with nowhere to go is left standing", locked.joined.map((p) => p.name), ["Alice", "Bob"]);
    check("which Start Game refuses", allSeated(locked.setup, [HOST, GUEST, { id: 3, name: "Cara", host: false }]), false);
    check("…where a fully-seated room does not", allSeated(withGuest.setup, [HOST, GUEST]), true);

    // A peer that leaves frees its seat — back to Open, or back to the map's computer.
    const afterLeave = seatPeers(withGuest.setup, [HOST]);
    check("a departing player frees its slot", kinds(afterLeave.setup), ["player", "open", "open", "open"]);
    check("…and is named as having left", afterLeave.left, ["Bob"]);
  }

  console.log("\ngame lobby: a client may only ever change its OWN row");
  {
    const melee = { slots: [0, 1].map((id) => ({ id, defaultRace: "human", startX: 0, startY: 0, controller: "user", team: id })) };
    const seated = seatPeers(newSetup("m", "M", "G", melee), [
      { id: 1, name: "Alice", host: true }, { id: 2, name: "Bob", host: false },
    ]).setup;

    const changed = applyRequest(seated, 2, { k: "lobbyreq", race: "orc", team: 0 });
    check("the requester's own row moves", [changed.slots[1].race, changed.slots[1].team], ["orc", 0]);
    check("…and nobody else's does", [changed.slots[0].race, changed.slots[0].team], ["human", 0]);
    // The identity is the relay's `from` stamp, so a peer with no seat has no row to change —
    // which is the whole of the forgery rule: there is nothing in the payload to lie with.
    check("a peer with no seat changes nothing", applyRequest(seated, 9, { k: "lobbyreq", race: "orc" }), null);
  }

  console.log("\ngame lobby: an Open slot is an empty chair, not a free AI");
  {
    const melee = { slots: [0, 1, 2].map((id) => ({ id, defaultRace: "human", startX: id * 10, startY: 0, controller: "user", team: id })) };
    let setup = seatPeers(newSetup("m", "Echo Isles", "G", melee), [
      { id: 1, name: "Alice", host: true }, { id: 2, name: "Bob", host: false },
    ]).setup;
    let start = buildStart(setup, 7);
    check("only the seats that are FILLED cross the wire", start.slots.map((s) => s.controller), ["user", "user"]);
    check("…each carrying the peer that sits in it", start.slots.map((s) => s.peer), [1, 2]);
    check("…the map's start location", start.slots.map((s) => s.startX), [0, 10]);
    check("…and the host's one seed", start.seed, 7);

    // The host turning the spare seat into a Computer is what puts an AI in the game — the
    // lobby is where that choice is made, which is why it is no longer made for the host.
    setup = { ...setup, slots: setup.slots.map((s, i) => (i === 2 ? { ...s, kind: "computer" } : s)) };
    start = buildStart(setup, 7);
    check("a slot the host set to Computer plays as one", start.slots.map((s) => s.controller),
      ["user", "user", "computer"]);
    check("…with no peer of its own", start.slots[2].peer, undefined);
  }

  console.log(failed === 0 ? "\nlobby: all checks passed" : `\nlobby: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
