// Two clients in one process, over the real relay logic (docs/multiplayer.md Phase E item 8).
//
// The point of this file is not to re-test the relay — `pnpm relay:test` does that over real
// sockets, against the same `RelayCore`. It is to prove the in-process adapter is a faithful
// enough stand-in that items 9–11 can be developed and tested here instead of against a port,
// and to write the RECONNECT test now rather than after item 11, which is what the plan asked
// for: "keep it exercised by a test from day one".
//
// The reconnect section describes what happens TODAY, and today reconnect does not work. Those
// checks are pinned as current behaviour and labelled, the same discipline item 3c used — when
// item 11 lands they are what has to change, deliberately and visibly, instead of a gap nobody
// notices.
//
// Run: pnpm loopback:test
import { join } from "node:path";
import { LoopbackRelay, tick } from "./loopback.mjs";

// The command router is TypeScript, compiled by `tsc -p tools/tsconfig.sim.json` into
// .sim-build alongside the sim. `pnpm sim:test` runs that build; run it before this file.
const { CommandRouter, commandMessage, accepted } = await import(
  "file://" + join(process.cwd(), ".sim-build", "src", "net", "commandLink.js")
);
const { MatchLink } = await import("file://" + join(process.cwd(), ".sim-build", "src", "game", "matchLink.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const CREATE = { t: "create", name: "Test", playerName: "Host", mapName: "Echo Isles", mapPath: "Maps/(2)EchoIsles.w3x", maxPlayers: 2 };

/** A room with a host and one joiner, settled. Returns both ends. */
async function room() {
  const relay = new LoopbackRelay();
  const host = relay.connect("host");
  const peer = relay.connect("peer");
  await tick();
  host.send(CREATE);
  await tick();
  const roomId = host.last("created").room.id;
  peer.send({ t: "join", roomId, playerName: "Joiner" });
  await tick();
  return { relay, host, peer, roomId };
}

console.log("a client connects and is handshaked before anything else");
{
  const relay = new LoopbackRelay();
  const c = relay.connect();
  // Nothing is delivered synchronously — a real transport never answers inside the send.
  check("nothing has arrived yet", c.inbox.length, 0);
  await tick();
  check("hello first, then the game list", c.seen().map((m) => m.t), ["hello", "rooms"]);
  check("and it speaks our protocol", c.last("hello").protocol, 10);
}

console.log("the room forms exactly as it does over a socket");
{
  const { host, peer } = await room();
  check("host is peer 1 and holds the room", [host.last("created").you.id, host.last("created").you.host], [1, true]);
  check("joiner is peer 2 and is not the host", [peer.last("joined").you.id, peer.last("joined").you.host], [2, false]);
  check("the joiner sees both players", peer.last("joined").peers.map((p) => p.id), [1, 2]);
  check("the host was told somebody arrived", host.last("peer-join").peer.id, 2);
}

console.log("game traffic crosses, and the relay does not look inside it");
{
  const { host, peer } = await room();
  peer.clear();
  // The `start` handshake is the only GameMessage today; the command stream (item 9) and the
  // snapshot stream (item 10) join this same envelope.
  const start = { k: "start", mapPath: "Maps/(2)EchoIsles.w3x", mapName: "Echo Isles", seed: 4242, slots: [] };
  host.send({ t: "relay", data: start });
  await tick();
  check("the joiner received it", peer.last("deliver").data.k, "start");
  check("stamped with who sent it", peer.last("deliver").from, 1);
  check("and the seed came through intact", peer.last("deliver").data.seed, 4242);

  // Addressed delivery — how a per-recipient snapshot will be sent.
  host.clear();
  peer.clear();
  host.send({ t: "relay", to: 2, data: { k: "snapshot", recipient: 2 } });
  await tick();
  check("an addressed payload reaches its target", peer.last("deliver").data.recipient, 2);
  check("and does not echo back to the sender", host.seen("deliver").length, 0);
}

// Two copies happen on the way through — one as a message leaves a client, one as it arrives.
// They protect DIFFERENT things, and the first version of this section tested neither: it
// asserted "the sender's payload survives", which either copy alone is enough to guarantee, so
// deleting either one left every check green. That is the "something else was doing the work"
// trap, hit for real. Each copy now has a check that fails when only that copy is removed.

console.log("a message is frozen at send(), the way a socket serialises it");
{
  const { host, peer } = await room();
  peer.clear();
  const msg = { t: "relay", data: { k: "start", seed: 4242 } };
  host.send(msg);
  // Mutated BEFORE the delivery runs — this is the window a socket does not have, because
  // `ws.send(JSON.stringify(msg))` has already put bytes on the wire. A loopback that copies
  // at delivery time instead of at send time reads almost identically and gives the opposite
  // guarantee: the recipient would see 9999.
  msg.data.seed = 9999;
  await tick();
  check("the recipient gets the seed as it was when sent", peer.last("deliver").data.seed, 4242);
}

console.log("what a client receives is its own copy, not one shared with the other recipients");
{
  const relay = new LoopbackRelay();
  const host = relay.connect("host");
  const a = relay.connect("a");
  const b = relay.connect("b");
  await tick();
  host.send({ ...CREATE, maxPlayers: 3 });
  await tick();
  const roomId = host.last("created").room.id;
  a.send({ t: "join", roomId, playerName: "A" });
  b.send({ t: "join", roomId, playerName: "B" });
  await tick();
  a.clear();
  b.clear();

  // One broadcast, two recipients. The relay builds ONE `deliver` object and fans it out, so
  // without a copy per arrival both clients would hold the same object.
  host.send({ t: "relay", data: { k: "start", slots: [{ id: 0, race: "human" }] } });
  await tick();
  a.last("deliver").data.slots[0].race = "orc"; // A scribbles on what it was handed
  check("B's copy is unaffected by A editing its own", b.last("deliver").data.slots[0].race, "human");
  check("and they are not the same object", a.last("deliver") === b.last("deliver"), false);
}

console.log("the host leaving ends the room, as v1 says it must");
{
  const { host, peer } = await room();
  peer.clear();
  host.close();
  await tick();
  // No host migration in v1: the host holds the only copy of the game state.
  check("the joiner is told the room closed", peer.last("room-closed").reason, "The host left the game.");
}

// ---------------------------------------------------------------------------------------
// RECONNECT, relay side (item 11a). A dropped connection is not a departure: the slot is HELD
// under a rejoin token, and a `join` carrying that token reclaims the SAME peer id. The host's
// full-snapshot catch-up is item 11b; here the relay-level protocol is what is pinned.
// ---------------------------------------------------------------------------------------

console.log("\na dropped client reclaims its own slot on its token (item 11a)");
{
  const { relay, host, peer, roomId } = await room();
  const token = peer.last("joined").token;
  check("the joiner was handed a rejoin token", typeof token, "string");
  host.clear();

  peer.drop();
  await tick();
  // A drop is announced as a DROP, not a leave: the slot is held, and a roster may say
  // "reconnecting" rather than removing the player.
  check("the host is told the peer DROPPED, not left", host.last("peer-drop")?.peerId, 2);
  check("no peer-leave was sent", host.seen("peer-leave").length, 0);

  const back = relay.connect("peer-again");
  await tick();
  back.send({ t: "join", roomId, playerName: "Joiner", token });
  await tick();

  // THE FLIP. With the token, the returning connection is the SAME player, not a stranger.
  check("it reclaims peer id 2, not a fresh 3", back.last("joined")?.you.id, 2);
  check("the host is told it is a REJOIN", host.last("peer-rejoin")?.peer.id, 2);
  // 11a stops here: the relay has put the player back in the room. Handing it the state it
  // missed is 11b (the host's full snapshot), so nothing is delivered yet.
  check("no game state is replayed by the relay itself", back.seen("deliver").length, 0);
}

console.log("a held slot is kept even against a full room, but a wrong token is a stranger");
{
  const { relay, host, peer, roomId } = await room(); // maxPlayers 2, so host + joiner = full
  const token = peer.last("joined").token;
  peer.drop();
  await tick();

  // Someone else tries to walk into the held slot with no token: the room is full (the slot is
  // reserved), so they are refused rather than seated over the dropped player.
  const intruder = relay.connect("intruder");
  await tick();
  intruder.send({ t: "join", roomId, playerName: "Intruder" });
  await tick();
  check("a tokenless join cannot take a held slot in a full room", intruder.last("error")?.message, "That game is full.");

  // The real player returns on the token and gets in, full room or not.
  const back = relay.connect("back");
  await tick();
  back.send({ t: "join", roomId, playerName: "Joiner", token });
  await tick();
  check("the token holder still gets back in", back.last("joined")?.you.id, 2);

  // A wrong token is just a new join (and now the room really is full again).
  const wrong = relay.connect("wrong");
  await tick();
  wrong.send({ t: "join", roomId, playerName: "Wrong", token: "not-the-token" });
  await tick();
  check("a wrong token does not reclaim the slot", wrong.last("error")?.message, "That game is full.");
}

console.log("a chosen LEAVE frees the slot; only a DROP holds it");
{
  const { relay, host, peer, roomId } = await room();
  const token = peer.last("joined").token;
  host.clear();
  peer.send({ t: "leave" });
  await tick();
  check("a leave is announced as a leave", host.last("peer-leave")?.peerId, 2);
  check("and not as a drop", host.seen("peer-drop").length, 0);

  // The slot is GONE: the token no longer opens it, and rejoining is an ordinary new join.
  const back = relay.connect("back");
  await tick();
  back.send({ t: "join", roomId, playerName: "Joiner", token });
  await tick();
  check("the freed slot cannot be reclaimed on the old token", back.last("joined")?.you.id, 3);
}

console.log("the host dropping still ends the room — no host migration in v1");
{
  const { host, peer } = await room();
  peer.clear();
  host.drop();
  await tick();
  // A client drop holds a slot; the HOST is the authority, and v1 cannot continue without it.
  check("the joiner is told the room closed", peer.last("room-closed").reason, "The host left the game.");
}

console.log("a drop tells the client its connection was lost");
{
  const { peer } = await room();
  let told = "";
  peer.onClose = (r) => (told = r);
  peer.drop();
  await tick();
  check("a drop notifies the client it lost the connection", told, "Connection to the game host was lost.");
  check("and the endpoint knows it is down", peer.connected, false);
}

// ---------------------------------------------------------------------------------------
// Item 9: commands cross the wire. The rule under test is that the SENDER'S IDENTITY comes
// from the relay's `from` stamp and never from the payload — Phase C gated a faked unit id,
// this gates a faked player, and they are different holes.
// ---------------------------------------------------------------------------------------

console.log("\na command crosses the wire and the host learns who really sent it");
{
  const { host, peer } = await room();
  // The seating the host already broadcast in StartMatch: player 0 is the host (peer 1),
  // player 1 is the joiner (peer 2), player 2 is a computer and has no peer at all.
  const router = new CommandRouter([
    { id: 0, peer: 1 },
    { id: 1, peer: 2 },
    { id: 2 },
  ]);
  host.clear();

  const move = { c: "order", unitId: 42, order: { kind: "move", x: 100, y: 200 }, queued: false };
  peer.send({ t: "relay", to: 1, data: commandMessage(move) });
  await tick();

  const env = host.last("deliver");
  check("the host received it", env.data.k, "cmd");
  const judged = router.receive(env.from, env.data);
  check("and resolved the sender to player 1", accepted(judged) && judged.player, 1);
  check("with the command intact", accepted(judged) && judged.cmd.unitId, 42);
}

console.log("a client cannot claim to be somebody else");
{
  const { host, peer } = await room();
  const router = new CommandRouter([{ id: 0, peer: 1 }, { id: 1, peer: 2 }]);
  host.clear();

  // The joiner (peer 2 = player 1) sends a command with player 0 written all over the payload.
  // Every field here is the sender's to choose, which is exactly why none of them may decide
  // identity. If the host ever reads `player` off the envelope, this is the test that dies.
  const forged = { ...commandMessage({ c: "order", unitId: 7, order: { kind: "move", x: 0, y: 0 }, queued: false }), player: 0, from: 1 };
  peer.send({ t: "relay", to: 1, data: forged });
  await tick();

  const env = host.last("deliver");
  check("the payload's own claim says player 0", env.data.player, 0);
  check("the relay's stamp says peer 2", env.from, 2);
  // The stamp wins. This is the whole item.
  const judged = router.receive(env.from, env.data);
  check("the host bills it to player 1, not player 0", accepted(judged) && judged.player, 1);
}

console.log("a peer with no seat is refused rather than guessed at");
{
  const router = new CommandRouter([{ id: 0, peer: 1 }, { id: 1, peer: 2 }]);
  const cmd = commandMessage({ c: "order", unitId: 1, order: { kind: "move", x: 0, y: 0 }, queued: false });
  // A spectator, a peer that joined the room after the match started, or a stale connection.
  check("an unseated peer gets no player", router.receive(9, cmd), "no-seat");
  // A computer slot has no peer, so nothing on the wire can ever speak for it — the host
  // simulates it. `peer: 0` would be a REAL peer, which is why the seating test is an
  // explicit `!== undefined` and not a truthiness check.
  check("a computer slot cannot be spoken for", new CommandRouter([{ id: 3 }]).playerFor(undefined), null);
  check("peer 0 is a real peer, not an absent one", new CommandRouter([{ id: 5, peer: 0 }]).playerFor(0), 5);
}

console.log("rubbish on the game channel is refused, not thrown");
{
  const router = new CommandRouter([{ id: 0, peer: 1 }]);
  // A hostile or simply buggy peer must not be able to interrupt the host's tick, so these
  // return a reason instead of raising.
  check("a start message is not a command", router.receive(1, { k: "start" }), "not-a-command");
  check("nor is null", router.receive(1, null), "not-a-command");
  check("nor is a bare string", router.receive(1, "cmd"), "not-a-command");
}

// ---------------------------------------------------------------------------------------
// Item 10b: snapshots actually cross the wire, through the real relay core, and the receiving
// client diffs them against what it simulated for itself. This is the first test in the whole
// phase where the authority's payload reaches another endpoint.
// ---------------------------------------------------------------------------------------

/** A `MatchChannel` over one loopback endpoint — what `LanLobby` provides in the real app. */
function channelFor(t) {
  // `close` is the fourth member (Phase F4/G1): the match owns the wire once the lobby hands it
  // over, so it is the match that ends it. Counted rather than acted on, so a test can ask
  // whether the wire was hung up without needing a real socket to hang up.
  const ch = {
    send: (data, to) => t.send({ t: "relay", to, data }),
    onPeerData: () => {}, onPeerRejoin: () => {}, onRoomClosed: () => {},
    closed: 0, close: () => { ch.closed++; },
  };
  // Both halves of `MatchChannel`: game traffic, and the one piece of roster news the match
  // needs. Routing `peer-rejoin` here rather than faking a call is what makes the 11b check
  // below run over the REAL relay core -- a held slot, a token, the same peer id back.
  t.onMessage = (m) => {
    if (m.t === "deliver") ch.onPeerData(m.from, m.data);
    else if (m.t === "peer-rejoin") ch.onPeerRejoin(m.peer.id);
  };
  return ch;
}

const SEATS = [{ id: 0, peer: 1 }, { id: 1, peer: 2 }, { id: 2 }]; // p2 is a computer

/** A world with one unit at a given hp, plus the stub viewer/sources the link needs. */
function worldAt(hp) {
  const u = {
    id: 1, owner: 0, team: 0, typeId: "hfoo", race: "human", neutralPassive: false,
    isHero: false, properName: "", isCreep: false, x: 10, y: 20, facing: 0, flyHeight: 0,
    speed: 270, radius: 16, flying: false, order: "idle", moving: false, inCombat: false,
    working: false, swingSeq: 0, chopSeq: 0, swingBroken: false, swingSlam: false,
    altModel: false, spawning: 0, constructing: 0, repair: null, inMine: false,
    insideBuild: false, inBurrow: false, devouredBy: 0, vanished: false, invisible: false,
    ethereal: false, hp, maxHp: 420, mana: 0, maxMana: 0, armor: 2, bonusArmor: 0,
    bonusDamage: 0, invulnerable: false, weapon: null, swingWeapon: null, level: 0, xp: 0,
    skillPoints: 0, str: 0, agi: 0, int: 0, bonusStr: 0, bonusAgi: 0, bonusInt: 0,
    worker: null, building: null, abilities: [], buffs: [], inventory: [], garrison: [],
    garrisonCap: 0, isSummon: false, summonLeft: 0, summonMax: 0, isIllusion: false,
    illusionOf: 0, guardX: 0, guardY: 0, buildPending: null, orderQueue: [], pendingCast: null,
  };
  return { units: new Map([[1, u]]), mines: new Map(), items: new Map(), timeOfDay: 12, dawnDusk: true, stashOf: () => ({ gold: 500, lumber: 150 }) };
}
const seer = { seesFor: () => true, fogHides: () => false, fogBlocksClick: () => false, invisHides: () => false, fogBlocksAt: () => false };
// `commandsApplied` is the input-parity stamp every snapshot carries (item F5). 0 here: these
// worlds are built by hand and nobody has commanded them, which is what makes the drift checks
// below comparable at all.
const sources = { viewers: () => [{ player: 0, viewer: seer }, { player: 1, viewer: seer }, { player: 2, viewer: seer }], ghostsFor: () => [], commandsApplied: () => 0 };

console.log("\nthe host's snapshot reaches the client it was addressed to");
{
  const { host, peer } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);
  peer.clear();

  const sent = hostLink.tickHost(1, worldAt(420), sources, 5);
  await tick();
  // Player 0 is the host itself — already looking at the authoritative world, so sending it a
  // round trip to learn what it knows would be waste. Player 2 is a computer with no peer.
  check("one snapshot sent, not three", sent, 1);
  check("the client is holding it", peerLink.latest()?.recipient, 1);
  check("with the world in it", peerLink.latest()?.units[0].hp, 420);
  check("stamped with the authority's clock", peerLink.latest()?.time, 5);
}

console.log("the client diffs what it was sent against what it simulated");
{
  const { host, peer } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);

  hostLink.tickHost(1, worldAt(245), sources, 5);
  await tick();
  // Sequencing B: the client kept simulating and reached a different answer.
  const found = peerLink.compare(worldAt(260), seer);
  check("the disagreement is found", found.length, 1);
  check("named down to the field and both values", [found[0].id, found[0].field, found[0].local, found[0].authority], [1, "hp", 260, 245]);
  check("and it reads as a line a human can act on", peerLink.describe()[0], "unit 1.hp: local 260 vs authority 245");

  // Agreement is silence — otherwise the log is useless the moment it works.
  hostLink.tickHost(1, worldAt(260), sources, 6);
  await tick();
  check("agreement reports nothing", peerLink.compare(worldAt(260), seer), []);
}

// The diff is only a bug report while both worlds have taken the SAME input: none. A client's
// local sim applies this player's commands at once, the authority applies them a round trip
// later, and it never hears anybody else's at all — so after the first command a difference
// reports the missing inputs. Measured live: one ordinary move order took the log from silent
// to 13 findings a tick, not one of them actionable (docs/multiplayer.md Phase F item 5).
console.log("once a command has landed, the comparison stops rather than reporting inputs as drift");
{
  const { host, peer } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);

  // Same disagreement as above, and while both worlds are pristine it is still reported —
  // pinning that the gate below is the gate, and not the diff having quietly stopped working.
  hostLink.tickHost(1, worldAt(245), sources, 5);
  await tick();
  check("while nobody has commanded, a real difference is still found", peerLink.compare(worldAt(260), seer, [], 0).length, 1);
  check("…and the comparison has not been declared over", peerLink.comparisonStopped, false);

  // Now OUR side has applied one. Same two worlds, same disagreement, no longer a finding.
  check("our own command ends it", peerLink.compare(worldAt(260), seer, [], 1), []);
  check("and it says so, once", peerLink.comparisonStopped, true);
}

// The melee victory/defeat screen is a plain JASS dialog, and a CLIENT's own script will never
// raise one: blizzard.j's defeat check runs off unit DEATH events in the world it can see, and a
// client's world never receives the host's commands — so the army that razed its hall never
// moved there and the hall is still standing in it. Observed exactly that way in a real match:
// the loser watched its base turn to rubble and went on playing (docs/multiplayer.md item F7).
console.log("the authority's verdict reaches the player it is about, and nobody else");
{
  // A THREE-seat room, built here rather than with `room()`, because the bystander below is
  // the whole point and `room()` caps at two — a third `join` is refused as full and then
  // receives nothing for the most boring possible reason.
  const relay = new LoopbackRelay();
  const host = relay.connect("host");
  const peer = relay.connect("peer");
  const third = relay.connect("third");
  await tick();
  host.send({ ...CREATE, maxPlayers: 3 });
  await tick();
  const roomId = host.last("created").room.id;
  peer.send({ t: "join", roomId, playerName: "Joiner" });
  third.send({ t: "join", roomId, playerName: "Bystander" });
  await tick();
  const THREE = [{ id: 0, peer: 1 }, { id: 1, peer: 2 }, { id: 2, peer: 3 }];
  const hostLink = new MatchLink(channelFor(host), 0, THREE);
  const peerLink = new MatchLink(channelFor(peer), 1, THREE);
  const seen = [];
  peerLink.onDialog = (d) => seen.push(d);

  const defeat = { k: "dlg", message: "You failed to achieve victory.", buttons: [{ text: "Quit Game", quit: true }] };
  check("the host says it went somewhere", hostLink.sendDialog(1, defeat), true);
  await tick();
  check("the loser is told, with the game's own words", seen.map((d) => d.message), ["You failed to achieve victory."]);
  check("…and the button that ends the match came with it", seen[0]?.buttons, [{ text: "Quit Game", quit: true }]);

  // A defeat belongs to ONE person. Addressed, never broadcast — a room-wide "You failed to
  // achieve victory." would be the funniest possible desync.
  //
  // The bystander has to be a THIRD peer, and that is the whole point of this block. Asking the
  // HOST whether it received its own broadcast proves nothing: the relay never echoes a sender
  // its own message, so a `send` with no recipient passes that check while spraying the room.
  // Written the easy way first, and the injection walked straight through it.
  const thirdLink = new MatchLink(channelFor(third), 2, THREE);
  const bystander = [];
  thirdLink.onDialog = (d) => bystander.push(d);
  hostLink.sendDialog(1, { k: "dlg", message: "You failed to achieve victory.", buttons: [] });
  await tick();
  check("a third player in the room is not handed the loser's screen", bystander, []);
  check("…while the loser got this one too", seen.length, 2);
}

// Phase G item 1: once the victory/defeat screen is up the match is officially decided, so the
// wire is dropped and every machine keeps its own private idea of the world from there — the
// developer's rule, and how WC3 behaves. What matters on the wire is that the AUTHORITY says
// which dialog is final: a client that hung up because any old dialog arrived would drop off
// mid-match the first time a map raised a quest popup for it.
console.log("the authority stamps which screen is the END of a player's game");
{
  const { host, peer } = await room();
  const hostCh = channelFor(host);
  const peerCh = channelFor(peer);
  const hostLink = new MatchLink(hostCh, 0, SEATS);
  const peerLink = new MatchLink(peerCh, 1, SEATS);
  const seen = [];
  peerLink.onDialog = (d) => seen.push(d);

  // A quest popup for that player is NOT the end of anything.
  hostLink.sendDialog(1, { k: "dlg", message: "A quest is complete.", buttons: [] });
  await tick();
  check("an ordinary dialog carries no ending", seen.map((d) => d.over ?? false), [false]);

  hostLink.sendDialog(1, { k: "dlg", message: "You failed to achieve victory.", buttons: [], over: true });
  await tick();
  check("the verdict does", seen.map((d) => d.over ?? false), [false, true]);
}

console.log("…and ending the match hangs up that end of the wire");
{
  const { host } = await room();
  const ch = channelFor(host);
  const link = new MatchLink(ch, 0, SEATS);
  check("the wire is open while the match runs", ch.closed, 0);
  link.endMatch();
  check("the match ending closes it", ch.closed, 1);
}

console.log("a verdict for a seat nobody is sitting in goes nowhere, and says so");
{
  const { host } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  // Player 0 is the host itself — its own script already showed it — and a computer slot has
  // no peer at all. Both must report FALSE rather than being silently counted as delivered,
  // so the caller retries a seat that simply is not seated yet instead of writing it off.
  check("the host's own seat is not relayed to itself", hostLink.sendDialog(0, { k: "dlg", message: "Victory!", buttons: [] }), false);
  check("nor is a computer slot", hostLink.sendDialog(2, { k: "dlg", message: "Victory!", buttons: [] }), false);
}

console.log("…and the AUTHORITY's own input ends it too, which a client cannot see any other way");
{
  const { host, peer } = await room();
  const commanded = { ...sources, commandsApplied: () => 3 }; // the host player moved something
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);

  hostLink.tickHost(1, worldAt(245), sources, 5);
  await tick();
  check("a pristine snapshot still compares", peerLink.compare(worldAt(260), seer, [], 0).length, 1);

  hostLink.tickHost(1, worldAt(245), commanded, 6);
  await tick();
  // THE check that a local-only gate would fail: this client has issued nothing, so it could
  // never have known on its own that the match had inputs in it. The stamp is how it learns.
  check("the count rides in the snapshot", peerLink.latest()?.commands, 3);
  check("a commanded authority ends it even though we issued nothing", peerLink.compare(worldAt(260), seer, [], 0), []);
  check("and it says so", peerLink.comparisonStopped, true);
}

console.log("an out-of-order or mis-addressed snapshot is refused, not rendered");
{
  const { host, peer } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);

  hostLink.tickHost(1, worldAt(300), sources, 10);
  await tick();
  check("the newer one is held", peerLink.latest().time, 10);

  // Over a relay "arrived later" and "happened later" are different claims. Rendering an older
  // world would jerk every unit backwards.
  hostLink.tickHost(1, worldAt(999), sources, 4);
  await tick();
  check("an older snapshot is dropped", peerLink.latest().time, 10);
  check("and counted, because a rising count is itself a diagnostic", peerLink.stale, 1);

  // Addressed to player 0, delivered to player 1's endpoint: a routing bug, and `recipient`
  // is carried in the payload (item 5) precisely so it is noticed instead of quietly drawn.
  host.send({ t: "relay", to: 2, data: { k: "snap", snap: { recipient: 0, time: 99, timeOfDay: 12, dawnDusk: true, units: [], mines: [], items: [] } } });
  await tick();
  check("somebody else's snapshot is ignored", peerLink.latest().time, 10);
}

console.log("both ends of the pipe are counted, so a dead pipe is distinguishable from a quiet one");
{
  const { host, peer } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);

  // The heartbeat these counters feed (rts.ts, dev-only) is what makes the two-client LAN
  // harness watchable: a silent [sync] with received === 0 is a broken pipe, with received
  // rising it is a working one that happens to agree. The distinction is the whole point.
  check("nothing sent or received before the first tick", [hostLink.sent, peerLink.received], [0, 0]);
  for (let t = 1; t <= 3; t++) {
    hostLink.tickHost(1, worldAt(420), sources, t);
    await tick();
  }
  check("the host counts what it emitted", hostLink.sent, 3);
  check("the client counts what it accepted", peerLink.received, 3);
  // A stale arrival is counted as stale, NOT as received — the two counters must not
  // double-count, or a replayed snapshot would read as progress.
  hostLink.tickHost(1, worldAt(420), sources, 2); // older than time=3
  await tick();
  check("a stale snapshot bumps stale, not received", [peerLink.received, peerLink.stale], [3, 1]);
}

console.log("the link demuxes the two kinds of game traffic and passes anything else through");
{
  const { host, peer } = await room();
  const other = [];
  const ch = channelFor(peer);
  ch.onPeerData = (from, data) => other.push(data.k);
  const link = new MatchLink(ch, 1, SEATS); // wraps the handler above
  const cmds = [];
  link.onCommand = (from, msg) => cmds.push([from, msg.cmd.c]);
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);

  // A snapshot: consumed internally, not surfaced to either callback.
  hostLink.tickHost(1, worldAt(420), sources, 5);
  await tick();
  // A command: surfaced to onCommand, NOT passed through as "the rest".
  host.send({ t: "relay", to: 2, data: commandMessage({ c: "order", unitId: 4, order: { kind: "move", x: 0, y: 0 }, queued: false }) });
  await tick();
  // Something else entirely: passed through untouched, so a future message type needs no change
  // to this seam.
  host.send({ t: "relay", to: 2, data: { k: "chat", text: "gg" } });
  await tick();

  check("the command reached onCommand, stamped with the relay's from", cmds, [[1, "order"]]);
  check("and did not fall through to the passthrough", other, ["chat"]);
  check("the snapshot went to neither callback", link.received, 1);
}

console.log("\na client's command crosses the wire to the host, and the host learns who really sent it");
{
  // Full item-9b path: client sends -> relay stamps -> host demuxes -> CommandRouter judges.
  // The controller wires onCommand to CommandRouter + Authority.execute; here we stand in for
  // that last hop so the wire half is tested without a sim.
  const { host, peer } = await room();
  const hostPeer = 1;
  const hostLink = new MatchLink(channelFor(host), 0, SEATS, hostPeer);
  const clientLink = new MatchLink(channelFor(peer), 1, SEATS, hostPeer);
  const router = new CommandRouter(SEATS);
  const applied = [];
  hostLink.onCommand = (from, msg) => {
    const j = router.receive(from, msg);
    if (accepted(j)) applied.push([j.player, j.cmd.unitId]);
  };

  clientLink.sendCommand({ c: "order", unitId: 77, order: { kind: "attack", targetId: 5, force: true }, queued: false });
  await tick();
  // The client is peer 2 = player 1. Identity comes from the relay stamp, never the payload
  // (item 9) — so the host bills the order to player 1 and to unit 77.
  check("the host applied it for the real sender", applied, [[1, 77]]);

  // And a SECOND client must not receive it. A command is aimed at the host, not broadcast,
  // because the model is authoritative-host: only the host applies it, and other clients see
  // the effect through their snapshot. Broadcasting would make every client's onCommand fire
  // — the lockstep leak this addressing prevents. A 2-peer room cannot catch it (the host is
  // the only "everyone else"); this needs a third seat.
  const relay3 = new LoopbackRelay();
  const h3 = relay3.connect("h3");
  const a3 = relay3.connect("a3");
  const b3 = relay3.connect("b3");
  await tick();
  h3.send({ ...CREATE, maxPlayers: 3 });
  await tick();
  const rid = h3.last("created").room.id;
  a3.send({ t: "join", roomId: rid, playerName: "A" });
  b3.send({ t: "join", roomId: rid, playerName: "B" });
  await tick();
  const SEATS3 = [{ id: 0, peer: 1 }, { id: 1, peer: 2 }, { id: 2, peer: 3 }];
  new MatchLink(channelFor(h3), 0, SEATS3, 1); // host
  const aLink = new MatchLink(channelFor(a3), 1, SEATS3, 1);
  const bLink = new MatchLink(channelFor(b3), 2, SEATS3, 1);
  const bGot = [];
  bLink.onCommand = (from, msg) => bGot.push(msg.cmd.unitId);
  aLink.sendCommand({ c: "order", unitId: 55, order: { kind: "move", x: 0, y: 0 }, queued: false });
  await tick();
  check("the other client is not sent a peer's command", bGot, []);

  // The host does not echo its own commands onto the wire — it IS the authority. A command it
  // sent would come straight back to it here; nothing does.
  applied.length = 0;
  host.send({ t: "relay", to: hostPeer, data: commandMessage({ c: "order", unitId: 9, order: { kind: "move", x: 1, y: 2 }, queued: false }) });
  await tick();
  check("a command addressed to the host from the host is still just judged by stamp", applied, [[0, 9]]);
}

console.log("\na reconnected player is handed the world it missed, off the cadence (item 11b)");
{
  const { relay, host, peer, roomId } = await room();
  const token = peer.last("joined").token;
  // Spy on the SEND side. The inbox records what a connection received, and "was this
  // addressed or broadcast" is a fact about the call, not about any one inbox -- with a single
  // remote peer in the room the two are indistinguishable from the receiving end.
  const outbox = [];
  const hostChannel = channelFor(host);
  const realSend = hostChannel.send;
  hostChannel.send = (data, to) => { outbox.push({ k: data.k, to }); realSend(data, to); };
  const hostLink = new MatchLink(hostChannel, 0, SEATS);
  // Settle the cadence first: one ordinary broadcast leaves `accum` at zero, so anything that
  // goes out later on a tiny dt can only be a catch-up and not a broadcast that came due.
  hostLink.tickHost(1, worldAt(420), sources, 1);
  await tick();
  outbox.length = 0;

  peer.drop();
  await tick();
  const back = relay.connect("peer-again");
  await tick();
  back.send({ t: "join", roomId, playerName: "Joiner", token });
  await tick();
  const backLink = new MatchLink(channelFor(back), 1, SEATS);
  back.clear();

  // A tick far below SNAPSHOT_INTERVAL. Under the old gate this returned 0 and the player
  // waited out the rest of the cadence holding a world that stopped when their wifi did.
  const sent = hostLink.tickHost(0.001, worldAt(77), sources, 9);
  await tick();
  check("the host sent one, without waiting for the cadence", sent, 1);
  check("to the returning seat, carrying the world as it is NOW", [backLink.latest()?.recipient, backLink.latest()?.units[0].hp], [1, 77]);
  // "FULL" is free today (there are no deltas) and the check is the promise for when there are.
  check("and it is a whole world, not a delta", backLink.latest()?.units.length, 1);
  // ADDRESSED, not broadcast. A catch-up that fanned out to the room would be an off-cadence
  // broadcast wearing another name -- a burst of traffic to everyone every time one player's
  // connection hiccups, and on a twelve-slot map that is the expensive way to be wrong.
  check("aimed at the returning peer alone", outbox, [{ k: "snapw", to: 2 }]);

  // The debt is paid exactly once -- otherwise every tick for the rest of the match sends an
  // extra snapshot to whoever once reconnected.
  check("nothing further goes out off cadence", hostLink.tickHost(0.001, worldAt(77), sources, 10), 0);
  // And the catch-up did not disturb the cadence it cut across: the broadcast still comes round
  // on its own clock rather than having been reset by the interruption.
  check("the broadcast still comes round on time", hostLink.tickHost(0.1, worldAt(77), sources, 11), 1);
}

console.log("\nspell fx ride due broadcasts, filtered per recipient, and never replay (item 9c-fx)");
{
  const { host, peer } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);

  // A viewer whose eyes end at x=500 — the far burst must not cross to it.
  const halfBlind = { ...seer, fogBlocksAt: (p) => p.x > 500 };
  const fxSources = {
    viewers: () => [{ player: 0, viewer: seer }, { player: 1, viewer: halfBlind }, { player: 2, viewer: seer }],
    ghostsFor: () => [],
    commandsApplied: () => 0,
    drainFx: () => fxThisTick.shift() ?? { effects: [], splats: [], castStarts: [], castFires: [] },
  };
  // Two ticks of events land BETWEEN sends: both must arrive in the one due broadcast.
  const fxThisTick = [
    { effects: [{ art: "HolyBolt.mdx", x: 100, y: 100, targetId: 7, z: 0 }], splats: [], castStarts: [], castFires: [] },
    { effects: [{ art: "FarBurst.mdx", x: 900, y: 900, targetId: 0, z: 0 }], splats: [{ splatId: "THND", x: 50, y: 60 }], castStarts: [], castFires: [] },
  ];
  hostLink.tickHost(0.005, worldAt(420), fxSources, 1); // buffers, not due (interval 1/60)
  hostLink.tickHost(0.005, worldAt(420), fxSources, 2); // buffers the second tick's too
  hostLink.tickHost(0.05, worldAt(420), fxSources, 3); // due — flushes
  await tick();
  check("both ticks' events arrive in the one due payload", peerLink.latest()?.fx.effects.map((e) => e.art), ["HolyBolt.mdx"]);
  check("…the burst beyond this recipient's eyes withheld", peerLink.latest()?.fx.effects.length, 1);
  check("…and the scorch decal rides along", peerLink.latest()?.fx.splats, [{ splatId: "THND", x: 50, y: 60 }]);

  // The next due broadcast must NOT replay them.
  hostLink.tickHost(0.05, worldAt(420), fxSources, 4);
  await tick();
  check("a flushed burst never plays twice", peerLink.latest()?.fx.effects, []);
}

console.log("deaths ride EVERY send — the expedited payload that carries the absence carries the collapse");
{
  const { host, peer } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);
  const deathsThisTick = [[{ id: 42, x: 10, y: 20 }]];
  const dSources = { ...sources, drainDeaths: () => deathsThisTick.shift() ?? [] };
  hostLink.tickHost(0.05, worldAt(420), dSources, 1); // settle the cadence + consume the death
  await tick();
  check("the due broadcast names the death", peerLink.latest()?.deaths, [{ id: 42, x: 10, y: 20 }]);

  // Between cadences: a second death lands, then an EXPEDITED send goes out. The death must
  // be on it — its record's absence is — and the next due broadcast may repeat it (the
  // client's routing is idempotent), but must not carry it a third time after that.
  deathsThisTick.push([{ id: 43, x: 1, y: 2 }]);
  hostLink.expedite(2);
  hostLink.tickHost(0.001, worldAt(300), dSources, 2);
  await tick();
  check("the expedited send carries the pending death", peerLink.latest()?.deaths, [{ id: 43, x: 1, y: 2 }]);
  hostLink.tickHost(0.05, worldAt(300), dSources, 3);
  await tick();
  check("the due broadcast repeats it once (idempotent client)", peerLink.latest()?.deaths, [{ id: 43, x: 1, y: 2 }]);
  hostLink.tickHost(0.05, worldAt(300), dSources, 4);
  await tick();
  check("…and then it is spent", peerLink.latest()?.deaths, []);
}

// At 60 Hz every broadcast is due, so each fx burst and each death rides exactly ONE
// payload — and `latest()` keeps only the newest. A client rendering slower than the wire
// supersedes payloads it never applied; reading events off the applied payload alone
// silently dropped the rest (a spell with no burst, a death with no collapse — the exact
// bugs items 16/17 fixed, resurrected by the cadence). So the link ACCUMULATES events from
// every accepted payload, and the applier takes them from the accumulator.
console.log("a client slower than the wire still gets every burst and every collapse");
{
  const { host, peer } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);
  const fxQ = [
    { effects: [{ art: "A.mdx", x: 1, y: 2, targetId: 0, z: 0 }], splats: [], castStarts: [], castFires: [] },
    { effects: [{ art: "B.mdx", x: 3, y: 4, targetId: 0, z: 0 }], splats: [], castStarts: [], castFires: [] },
  ];
  const dQ = [[{ id: 7, x: 0, y: 0 }], [{ id: 8, x: 1, y: 1 }]];
  const src = {
    ...sources,
    drainFx: () => fxQ.shift() ?? { effects: [], splats: [], castStarts: [], castFires: [] },
    drainDeaths: () => dQ.shift() ?? [],
  };
  // Two due broadcasts back to back, BEFORE the client consumes anything — the second
  // supersedes the first exactly the way a slow frame loop experiences the 60 Hz wire.
  hostLink.tickHost(1 / 60, worldAt(420), src, 1);
  hostLink.tickHost(1 / 60, worldAt(420), src, 2);
  await tick();
  check("only the newest payload is held", peerLink.latest()?.time, 2);
  check("…carrying only its own burst", peerLink.latest()?.fx.effects.map((e) => e.art), ["B.mdx"]);
  const took = peerLink.takeFx();
  check("the accumulator kept BOTH bursts", took.effects.map((e) => e.art), ["A.mdx", "B.mdx"]);
  check("taking them spends them", peerLink.takeFx().effects, []);
  check("both deaths survived the skipped payload", peerLink.takeDeaths().map((d) => d.id), [7, 8]);
  check("and deaths are spent too", peerLink.takeDeaths(), []);
}

console.log("a command's consequences are expedited off-cadence, without fx and without disturbing the clock");
{
  const { host, peer } = await room();
  const hostLink = new MatchLink(channelFor(host), 0, SEATS);
  const peerLink = new MatchLink(channelFor(peer), 1, SEATS);
  hostLink.tickHost(0.05, worldAt(420), sources, 1); // settle the cadence
  await tick();

  hostLink.expedite(2); // the joiner's peer id — a command of theirs just applied
  const sent = hostLink.tickHost(0.001, worldAt(300), sources, 2);
  await tick();
  check("the very next tick carries the answer", sent, 1);
  check("…with the world as it now is", peerLink.latest()?.units[0].hp, 300);
  check("and the broadcast still comes round on its own clock", hostLink.tickHost(0.05, worldAt(300), sources, 3), 1);
}

console.log(failed === 0 ? "\nloopback: all checks passed" : `\nloopback: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
