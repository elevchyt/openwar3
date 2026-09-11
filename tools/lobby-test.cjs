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
const { LanLobby, reachabilityLine, normalizeRelayUrl, relayAuthority } = require(join(REPO, ".sim-build", "src", "net", "lobby.js"));
const { reconnectPlan, memoryStore } = require(join(REPO, ".sim-build", "src", "net", "reconnect.js"));
const {
  allSeated, applyRequest, buildStart, canStart, colorsFreeFor, editSlot, newSetup, observerSlots,
  seatPeers, setSlotColor,
} = require(join(REPO, ".sim-build", "src", "net", "lobbySetup.js"));
const { DEFAULT_ADVANCED, isDefaultAdvanced } = require(join(REPO, ".sim-build", "src", "net", "advancedOptions.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A fake `LobbyTransport`: records what the lobby sends, lets the test play the relay by
 *  driving `onMessage`, and can be `drop()`ped to fire `onClose` exactly as a lost socket does. */
/** Let the microtask queue drain — `addRelay` returns before its connect has settled. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeTransport(refuse) {
  const t = {
    sent: [],
    onMessage: () => {},
    onClose: () => {},
    connected: true,
    connect: (url) => { t.url = url; return refuse ? Promise.reject(new Error("No relay at " + url)) : Promise.resolve(); },
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
    // …and once Start Game has been pressed nothing moves at all: the rows are dead on every
    // machine while the countdown runs, so a request that arrives is a stale menu or a forgery.
    check(
      "the countdown settles the seating",
      applyRequest({ ...seated, counting: true }, 2, { k: "lobbyreq", race: "orc" }),
      null,
    );
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
    // WHICH computer is the host's choice too, and it has to reach every machine: the AI runs
    // on the authority alone, but the config is the match's identity (docs/melee-ai.md).
    check("…at the difficulty the row was left on", start.slots[2].aiDifficulty, 2); // MELEE_NORMAL
    setup = { ...setup, slots: setup.slots.map((s, i) => (i === 2 ? { ...s, ai: 3 } : s)) };
    check("…and Computer (Insane) crosses as MELEE_INSANE", buildStart(setup, 7).slots[2].aiDifficulty, 3);
    check("a human's row carries no difficulty at all", buildStart(setup, 7).slots[0].aiDifficulty, undefined);
  }

  // -------------------------------------------------------------------------------------
  // The OBSERVERS bench, colours, and the Advanced Options — the LAN lobby's second round.
  //
  // Full Observers grows an "Observers:" force under the players: the twelve seats the game
  // has, less the map's. A joiner who finds no open player slot lands on it; a player may get
  // up onto it from the team menu and come back by picking a team. Colours are one player's
  // each, kept unique across the whole lobby. Races are rolled on the HOST at Start.
  // -------------------------------------------------------------------------------------

  console.log("\ngame lobby: the Observers bench (Full Observers)");
  {
    const melee = { slots: [0, 1].map((id) => ({ id, defaultRace: "human", startX: id, startY: 0, controller: "user", team: id })) };
    const HOST = { id: 1, name: "Alice", host: true };
    const BOB = { id: 2, name: "Bob", host: false };
    const CARA = { id: 3, name: "Cara", host: false };
    const full = { ...DEFAULT_ADVANCED, observers: "FULL_OBSERVERS" };

    check("no bench without Full Observers", newSetup("m", "M", "G", melee).observers.length, 0);
    check("the bench is the game's twelve seats less the map's", observerSlots(2, full), 10);
    const fresh = newSetup("m", "M", "G", melee, full);
    check("…and opens every one of them", fresh.observers.map((o) => o.kind).slice(0, 3), ["open", "open", "open"]);

    // Two player slots, three people: the third lands on the bench, not on a closed chair.
    const seated = seatPeers(fresh, [HOST, BOB, CARA]).setup;
    check("player slots fill first", seated.slots.map((s) => s.name), ["Alice", "Bob"]);
    check("…and the overflow watches", seated.observers[0], { kind: "player", peer: 3, name: "Cara" });
    check("everybody has a seat", allSeated(seated, [HOST, BOB, CARA]), true);
    check("…and the room can start", canStart(seated, [HOST, BOB, CARA]), true);

    // Bob gets up to watch: his slot opens, he keeps his name on the bench.
    const bobWatches = applyRequest(seated, 2, { k: "lobbyreq", observe: true });
    check("a player may get up onto the bench", bobWatches.slots[1].kind, "open");
    check("…keeping his name there", bobWatches.observers[1], { kind: "player", peer: 2, name: "Bob" });
    check("one player and a bench cannot start", canStart(bobWatches, [HOST, BOB, CARA]), false);
    // …and comes back on team 1, into the slot he left (the first open one).
    const bobBack = applyRequest(bobWatches, 2, { k: "lobbyreq", team: 1 });
    check("a watcher comes back by picking a team", [bobBack.slots[1].kind, bobBack.slots[1].peer, bobBack.slots[1].team], ["player", 2, 1]);
    check("…and the bench seat opens again", bobBack.observers[1].kind, "open");
    // A watcher has nothing else to change.
    check("a watcher's race request changes nothing", applyRequest(bobWatches, 2, { k: "lobbyreq", race: "orc" }), null);
    // Without a bench the request means nothing at all.
    const noBench = seatPeers(newSetup("m", "M", "G", melee), [HOST, BOB]).setup;
    check("no bench, no getting up", applyRequest(noBench, 2, { k: "lobbyreq", observe: true }), null);

    // A watcher leaving frees the seat, and is named as having left.
    const caraGone = seatPeers(seated, [HOST, BOB]);
    check("a departing watcher frees the seat", caraGone.setup.observers[0].kind, "open");
    check("…and is named", caraGone.left, ["Cara"]);

    // The bench crosses at Start by peer, outside the slots.
    const start = buildStart(seated, 7);
    check("Start carries the bench by peer", start.observers, [{ peer: 3, name: "Cara" }]);
    check("…and no watcher is among the slots", start.slots.map((s) => s.peer), [1, 2]);
    check("…and the host's options ride with it", start.advanced.observers, "FULL_OBSERVERS");
  }

  console.log("\ngame lobby: colours are one player's each");
  {
    const melee = { slots: [0, 1, 2].map((id) => ({ id, defaultRace: "human", startX: id, startY: 0, controller: "user", team: id })) };
    const HOST = { id: 1, name: "Alice", host: true };
    const BOB = { id: 2, name: "Bob", host: false };
    const setup = seatPeers(newSetup("m", "M", "G", melee), [HOST, BOB]).setup;
    check("a seat opens on its own index", setup.slots.map((s) => s.color), [0, 1, 2]);
    check("the palette less what other SEATED rows wear is on offer", colorsFreeFor(setup, 1), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    // Bob takes the empty third seat's teal: the seat gets his blue — a swap, so nothing
    // is ever worn twice.
    const swapped = applyRequest(setup, 2, { k: "lobbyreq", color: 2 });
    check("a colour off an EMPTY seat is taken by swapping", swapped.slots.map((s) => s.color), [0, 2, 1]);
    // Alice's red is Alice's.
    check("a colour a SEATED row wears is refused", applyRequest(swapped, 2, { k: "lobbyreq", color: 0 }), null);
    check("…and a colour off the palette is refused", setSlotColor(swapped, 1, 12), null);
    check("the host edits its computers' colours by the same rule", editSlot(swapped, 2, { color: 0 }), null);
    check("…and swaps by the same rule", editSlot(swapped, 2, { color: 5 }).slots.map((s) => s.color), [0, 2, 5]);
    check("the colour crosses at Start", buildStart(swapped, 7).slots.map((s) => s.color), [0, 2]);
  }

  console.log("\ngame lobby: races are rolled on the host, and Computer+ rides per seat");
  {
    const melee = { slots: [0, 1].map((id) => ({ id, defaultRace: "human", startX: id, startY: 0, controller: "user", team: id })) };
    const HOST = { id: 1, name: "Alice", host: true };
    let setup = seatPeers(newSetup("m", "M", "G", melee), [HOST]).setup;
    setup = { ...setup, slots: setup.slots.map((s, i) => (i === 1 ? { ...s, kind: "computer", race: "random" } : s)) };
    const roll = (r) => (r === "random" ? "undead" : r);
    check("a seat left on Random crosses RESOLVED, by the host's roll", buildStart(setup, 7, roll).slots.map((s) => s.race), ["human", "undead"]);
    const everyone = { ...setup, advanced: { ...DEFAULT_ADVANCED, randomRaces: true } };
    check("Random Races rolls every seat, whatever the row said", buildStart(everyone, 7, roll).slots.map((s) => s.race), ["undead", "undead"]);
    const plus = { ...setup, advanced: { ...DEFAULT_ADVANCED, computerPlus: true } };
    check("Computer+ is stamped on each computer seat", buildStart(plus, 7).slots.map((s) => s.aiPlus), [undefined, true]);
    check("…and the classic AI is the absence of it", buildStart(setup, 7).slots.map((s) => s.aiPlus), [undefined, false]);
    check("the defaults are the defaults", isDefaultAdvanced(DEFAULT_ADVANCED), true);
    check("…and a Computer+ game is not", isDefaultAdvanced({ ...DEFAULT_ADVANCED, computerPlus: true }), false);
  }

  console.log("\nthe relay's reachability report is turned into one line, or none");
  {
    // The three answers, and the reason there is no fourth: a bound interface is not an open
    // firewall, so the address is offered as the thing to TRY and never as a promise.
    check("no report at all says nothing — a cloud relay cannot know", reachabilityLine(null), null);
    const dev = reachabilityLine({ kind: "dev", lan: false, addresses: [] });
    check("a dev server on loopback WARNS", dev.warn, true);
    check("…and names the fix", dev.text.includes("--host"), true);
    const app = reachabilityLine({ kind: "app", lan: false, addresses: [] });
    check("the packaged game says the machine is not on a network", app.text.includes("not on a network"), true);
    check("…and never tells a player to restart a server with a flag", app.text.includes("--host"), false);
    const one = reachabilityLine({ kind: "dev", lan: true, addresses: ["192.168.1.7:5173"] });
    check("reachable: the address to type, not a warning", [one.warn, one.text], [false, "Other players join at 192.168.1.7:5173"]);
    const two = reachabilityLine({ kind: "app", lan: true, addresses: ["192.168.1.7:8787", "10.8.0.2:8787"] });
    check("two networks offer BOTH — a wrong single address is worse than a list",
      two.text, "Other players join at 192.168.1.7:8787 or 10.8.0.2:8787");
    check("reachable with nothing to offer says nothing",
      reachabilityLine({ kind: "app", lan: true, addresses: [] }), null);
  }

  console.log("\nan address is read the way a person writes it");
  {
    const want = "ws://192.168.1.42:8787/relay";
    for (const typed of ["192.168.1.42", "192.168.1.42:8787", "http://192.168.1.42:8787",
                         "  http://192.168.1.42:8787/  ", "ws://192.168.1.42:8787/relay"]) {
      check(`"${typed}"`, normalizeRelayUrl(typed), want);
    }
    check("a port that is not ours is kept — a dev server is on 5173",
      normalizeRelayUrl("192.168.1.42:5173"), "ws://192.168.1.42:5173/relay");
    for (const bad of ["", "   ", "not an address", "nonsense!!", "-nope", "1.2.3.4:0", "1.2.3.4:99999", "1.2.3.4:abc"]) {
      check(`"${bad}" is not an address`, normalizeRelayUrl(bad), null);
    }
  }

  console.log("\nthe game list can hold more than one machine's games");
  {
    const made = [];
    const lobby = new LanLobby(() => { const t = fakeTransport(); made.push(t); return t; }, memoryStore());
    await lobby.connect();
    const own = made[0];
    own.onMessage({ t: "hello", protocol: 99, host: { kind: "app", lan: true, addresses: ["192.168.1.34:8787"] } });
    own.onMessage({ t: "rooms", rooms: [{ ...ROOM, id: "1", name: "Mine" }] });
    check("our own games carry no source", lobby.snapshot.rooms.map((r) => [r.key, r.source]), [["#1", ""]]);

    lobby.addRelay("192.168.1.42");
    await tick();
    const remote = made[1];
    check("a bare address takes the desktop game's port", remote.url, "ws://192.168.1.42:8787/relay");
    remote.onMessage({ t: "rooms", rooms: [{ ...ROOM, id: "1", name: "Theirs" }] });
    // The whole reason `key` exists: both relays minted a room 1.
    check("both machines' games are in ONE list", lobby.snapshot.rooms.map((r) => r.name), ["Mine", "Theirs"]);
    check("…told apart by relay, not by the id they share",
      lobby.snapshot.rooms.map((r) => r.key), ["#1", "ws://192.168.1.42:8787/relay#1"]);

    lobby.join("ws://192.168.1.42:8787/relay#1", "Bob");
    check("the join is sent to THEIR relay", remote.sent, [{ t: "join", roomId: "1", playerName: "Bob" }]);
    check("…and ours is never asked about a room it does not have", own.sent, []);
    check("…our connection is let go: the match wire is the host's", own.connected, false);
    check("…and their list is now the list", lobby.snapshot.rooms.map((r) => [r.key, r.source]), [["#1", ""]]);
  }

  console.log("\na relay that goes away takes its games with it");
  {
    const made = [];
    const lobby = new LanLobby(() => { const t = fakeTransport(); made.push(t); return t; }, memoryStore());
    await lobby.connect();
    made[0].onMessage({ t: "rooms", rooms: [{ ...ROOM, id: "1", name: "Mine" }] });
    lobby.addRelay("192.168.1.42");
    await tick();
    made[1].onMessage({ t: "rooms", rooms: [{ ...ROOM, id: "1", name: "Theirs" }] });
    check("two machines", lobby.snapshot.rooms.length, 2);
    made[1].drop("gone");
    check("one machine, and it is ours", lobby.snapshot.rooms.map((r) => r.name), ["Mine"]);
    // Still WATCHED, though — a host who quits may come back, and the row waits for them.
    check("…but the address is still on the list, waiting", lobby.relays, [{ url: "ws://192.168.1.42:8787/relay", connected: false, source: "typed" }]);
    lobby.removeRelay("ws://192.168.1.42:8787/relay");
    check("removing it is what takes it off", lobby.relays, []);
  }

  console.log("\nan address nobody is hosting on yet is KEPT, and knocked at again");
  {
    const made = [];
    let refuse = true;
    const lobby = new LanLobby(() => { const t = fakeTransport(made.length > 0 && refuse); made.push(t); return t; }, memoryStore());
    await lobby.connect();
    lobby.addRelay("192.168.1.42");
    await tick();
    // Nothing answered. That is the ORDINARY case — the other player has not started their game
    // yet — so it is a state on the row, not a refusal that throws the address away.
    check("the address is on the list", lobby.relays.map((r) => r.url), ["ws://192.168.1.42:8787/relay"]);
    check("…marked as not answering", lobby.relays[0].connected, false);
    check("…and no games came with it", lobby.snapshot.rooms, []);

    // The other player starts their game: the next knock lands.
    refuse = false;
    await new Promise((r) => setTimeout(r, 4200));
    check("a later knock connects", lobby.relays[0].connected, true);
    made[made.length - 1].onMessage({ t: "rooms", rooms: [{ ...ROOM, id: "1", name: "Late" }] });
    check("…and their game appears with no second act from the player",
      lobby.snapshot.rooms.map((r) => r.name), ["Late"]);
    lobby.close();
  }

  console.log("\nwhat the network says is there is watched like an address you typed");
  {
    const made = [];
    const lobby = new LanLobby(() => { const t = fakeTransport(); made.push(t); return t; }, memoryStore());
    await lobby.connect();
    lobby.addRelay("192.168.1.42");           // theirs, by hand
    await tick();
    lobby.setDiscovered(["ws://192.168.1.50:8787/relay", "ws://192.168.1.42:8787/relay"]);
    await tick();
    check("a heard machine joins the watched set",
      lobby.relays.map((r) => `${r.url} ${r.source}`),
      ["ws://192.168.1.42:8787/relay typed", "ws://192.168.1.50:8787/relay found"]);
    // The one the player typed stays THEIRS even though the beacon also carries it — otherwise
    // their row would lose its ✕ because a datagram happened to arrive.
    check("…and one they typed is still theirs", lobby.relays[0].source, "typed");

    // The far machine closes its game. A `found` row goes with it; a typed one never does.
    lobby.setDiscovered([]);
    await tick();
    check("a machine that stops broadcasting is dropped",
      lobby.relays.map((r) => r.url), ["ws://192.168.1.42:8787/relay"]);

    // Our own address can legitimately arrive: two copies on one machine hear each other.
    lobby.setDiscovered(["not an address", "ws://192.168.1.60:8787/relay"]);
    await tick();
    check("rubbish in the set is skipped rather than thrown",
      lobby.relays.map((r) => r.url).sort(),
      ["ws://192.168.1.42:8787/relay", "ws://192.168.1.60:8787/relay"]);
    lobby.close();
  }

  console.log("\npasting your own address is answered rather than listing everything twice");
  {
    const made = [];
    const lobby = new LanLobby(() => { const t = fakeTransport(); made.push(t); return t; }, memoryStore());
    await lobby.connect();
    // The relay names its own addresses at the handshake, which is the only way to know that
    // `192.168.1.34:8787` and the loopback connection we already hold are one machine.
    made[0].onMessage({ t: "hello", protocol: 99, host: { kind: "app", lan: true, addresses: ["192.168.1.34:8787"] } });
    let said = null;
    try { lobby.addRelay("http://192.168.1.34:8787"); } catch (e) { said = e.message; }
    check("it says so", said, "That address is this computer — your own games are already listed.");
    check("…and opened nothing", made.length, 1);
    check("…and watches nothing", lobby.relays, []);

    let refused = null;
    try { lobby.addRelay("hello there"); } catch (e) { refused = e.message; }
    check("a typo is refused with the shape of an address",
      refused, `"hello there" is not an address. Try 192.168.1.42 or 192.168.1.42:8787.`);
  }

  const OFFICIAL = "wss://openwar3.up.railway.app/relay";
  const FRIEND = "ws://192.168.1.42:8787/relay";

  console.log("\na server on the internet is dialled the way a cloud host serves it");
  {
    for (const typed of ["openwar3.up.railway.app", "https://openwar3.up.railway.app/",
                         "wss://openwar3.up.railway.app/relay", "openwar3.up.railway.app:443"]) {
      check(`"${typed}" is TLS on 443`, normalizeRelayUrl(typed), OFFICIAL);
    }
    check("a TCP proxy's port is plain ws — it forwards raw TCP",
      normalizeRelayUrl("shuttle.proxy.rlwy.net:15140"), "ws://shuttle.proxy.rlwy.net:15140/relay");
    check("a typed http:// is taken at its word", normalizeRelayUrl("http://play.example.com"), "ws://play.example.com:8787/relay");
    for (const [typed, want] of [["desktop-pc", "ws://desktop-pc:8787/relay"], ["gaming-pc.local", "ws://gaming-pc.local:8787/relay"],
                                 ["localhost", "ws://localhost:8787/relay"], ["router.lan", "ws://router.lan:8787/relay"]]) {
      check(`"${typed}" is a machine on the network, not the internet`, normalizeRelayUrl(typed), want);
    }
    check("a secure server is shown as just its name", relayAuthority(OFFICIAL), "openwar3.up.railway.app");
  }

  console.log("\nthe official server is on the list, first, and nobody takes it off");
  {
    const made = [];
    const lobby = new LanLobby(() => { const t = fakeTransport(); made.push(t); return t; }, memoryStore());
    await lobby.connect();
    lobby.addRelay("192.168.1.42");
    lobby.addRelay("openwar3.up.railway.app", "official");
    await tick();
    check("it is watched, and listed FIRST", lobby.relays.map((r) => `${r.url} ${r.source}`), [`${OFFICIAL} official`, `${FRIEND} typed`]);
    lobby.removeRelay(OFFICIAL);
    check("removing it does nothing", lobby.relays.map((r) => r.url), [OFFICIAL, FRIEND]);
    lobby.addRelay("https://openwar3.up.railway.app");
    check("typing its address in does not demote it to a row with a ✕", lobby.relays[0].source, "official");
    lobby.setDiscovered([]);
    check("…and the network going quiet does not drop it", lobby.relays.length, 2);
    lobby.close();
  }

  console.log("\na game can be CREATED on a server, not only joined there");
  {
    const made = [];
    const lobby = new LanLobby(() => { const t = fakeTransport(); made.push(t); return t; }, memoryStore());
    await lobby.connect();
    const own = made[0];
    own.onMessage({ t: "hello", protocol: 99, host: { kind: "app", lan: true, addresses: ["192.168.1.34:8787"] } });
    lobby.addRelay("openwar3.up.railway.app", "official");
    lobby.addRelay("192.168.1.42");
    await tick();
    const official = made.find((t) => t.url === OFFICIAL);
    const friend = made.find((t) => t.url === FRIEND);
    check("the Server menu offers this computer, then each server that answers",
      lobby.hostTargets, [{ url: "", kind: "own" }, { url: OFFICIAL, kind: "official" }, { url: FRIEND, kind: "typed" }]);
    lobby.host("G", "Host", "Echo Isles", "m", 2, false, OFFICIAL);
    check("the room is announced on the SERVER", official.sent.map((m) => m.t), ["create"]);
    check("…and never on this computer", own.sent, []);
    check("…whose connection is let go: the room's wire is the server's", own.connected, false);
    check("…as is every other machine's", friend.connected, false);
    check("…and this machine's LAN address is no longer the lobby's to print", lobby.snapshot.host, null);
    check("the server stays a row in the Servers List while we play on it",
      lobby.relays, [{ url: OFFICIAL, connected: true, source: "official" }]);
    check("…and it is where we stand now", lobby.primary, { url: OFFICIAL, kind: "official" });
    lobby.close();
  }

  console.log("\na server that is still knocking cannot have a game put on it");
  {
    const made = [];
    const lobby = new LanLobby(() => { const t = fakeTransport(made.length > 0); made.push(t); return t; }, memoryStore());
    await lobby.connect();
    lobby.addRelay("openwar3.up.railway.app", "official");
    await tick();
    check("it is not offered", lobby.hostTargets.map((t) => t.kind), ["own"]);
    let said = null;
    try { lobby.host("G", "Host", "Echo Isles", "m", 2, false, OFFICIAL); } catch (e) { said = e.message; }
    check("…and naming it anyway is refused out loud", said, "That server is not answering.");
    check("…with nothing sent anywhere", made[0].sent, []);
    lobby.close();
  }

  console.log("\na page with no relay of its own can still play on the official server");
  {
    const made = [];
    const lobby = new LanLobby(() => { const t = fakeTransport(made.length === 0); made.push(t); return t; }, memoryStore());
    await lobby.connect().catch(() => {});
    check("our own relay is not there", lobby.snapshot.phase, "offline");
    lobby.addRelay("openwar3.up.railway.app", "official");
    await tick();
    check("the server answering makes it a list to browse", lobby.snapshot.phase, "browsing");
    check("…and the one place to create a game", lobby.hostTargets.map((t) => t.kind), ["official"]);
    lobby.close();
  }

  console.log("\njoining a friend's game keeps the official server watched");
  {
    const made = [];
    const lobby = new LanLobby(() => { const t = fakeTransport(); made.push(t); return t; }, memoryStore());
    await lobby.connect();
    lobby.addRelay("openwar3.up.railway.app", "official");
    lobby.addRelay("192.168.1.42");
    await tick();
    made.find((t) => t.url === FRIEND).onMessage({ t: "rooms", rooms: [{ ...ROOM, id: "1", name: "Theirs" }] });
    lobby.join(`${FRIEND}#1`, "Bob");
    check("the friend's relay is where we play", lobby.primary, { url: FRIEND, kind: "typed" });
    check("…and the official server is still on the list", lobby.relays.map((r) => `${r.url} ${r.source}`), [`${OFFICIAL} official`]);
    lobby.close();
  }

  console.log("\nletting go of a relay is not LOSING one — its close event lands after the promotion");
  {
    // A real socket fires its close event even when WE closed it, a beat later. `fakeTransport`
    // does not, which is how a host on the official server came to send its countdown, its
    // start and every snapshot into a fresh socket that was in no room: the old relay's close
    // ran `onLost`, which nulled the promoted connection and went "reconnecting".
    const realClose = (t) => { t.close = () => { t.connected = false; setTimeout(() => t.onClose("Connection to the game host was lost."), 0); }; return t; };
    {
      const made = [];
      const lobby = new LanLobby(() => { const t = realClose(fakeTransport()); made.push(t); return t; }, memoryStore());
      await lobby.connect();
      lobby.addRelay("openwar3.up.railway.app", "official");
      await tick();
      const official = made.find((t) => t.url === OFFICIAL);
      lobby.host("G", "Host", "Echo Isles", "m", 2, false, OFFICIAL);
      official.onMessage({ t: "created", room: { ...ROOM, id: "4" }, you: { id: 1, name: "Host", host: true }, token: "tok" });
      await tick();
      await tick();
      check("the host is still standing on the server once the old close lands", lobby.primary, { url: OFFICIAL, kind: "official" });
      check("…hosting, and not reconnecting", [lobby.snapshot.phase, lobby.snapshot.error], ["hosting", null]);
      lobby.send({ k: "lobbycount", n: 5 });
      check("…with the room's traffic on the server's connection", official.sent[official.sent.length - 1], { t: "relay", data: { k: "lobbycount", n: 5 } });
      check("…and no second socket opened to crawl back in", made.length, 2);
      lobby.close();
    }
    {
      const made = [];
      const lobby = new LanLobby(() => { const t = realClose(fakeTransport()); made.push(t); return t; }, memoryStore());
      await lobby.connect();
      lobby.addRelay("192.168.1.42");
      await tick();
      const friend = made.find((t) => t.url === FRIEND);
      friend.onMessage({ t: "rooms", rooms: [{ ...ROOM, id: "1", name: "Theirs" }] });
      lobby.join(`${FRIEND}#1`, "Bob");
      friend.onMessage({ t: "joined", room: { ...ROOM, id: "1" }, you: ME, peers: [ME], token: "tok" });
      await tick();
      await tick();
      check("a joiner on another machine stays joined once its own relay's close lands",
        [lobby.primary, lobby.snapshot.phase, made.length], [{ url: FRIEND, kind: "typed" }, "joined", 2]);
      lobby.close();
    }
  }

  console.log(failed === 0 ? "\nlobby: all checks passed" : `\nlobby: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
