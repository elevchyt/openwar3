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
  check("and it speaks our protocol", c.last("hello").protocol, 2);
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
// RECONNECT — pinned as it behaves TODAY, which is: not at all.
//
// Item 11 is "rejoin token → full snapshot → deltas resume". None of that exists. These
// checks describe the gap precisely so that landing item 11 has to change them on purpose.
// ---------------------------------------------------------------------------------------

console.log("\nNOT YET RECONNECT, pinned as-is: a dropped client comes back as a stranger (item 11)");
{
  const { relay, host, peer, roomId } = await room();
  host.clear();

  peer.drop();
  await tick();
  // The host IS told, which is the half that already works — item 11 does not have to invent
  // notification, only what happens next.
  check("the host learns the peer went away", host.last("peer-leave").peerId, 2);

  const back = relay.connect("peer-again");
  await tick();
  back.send({ t: "join", roomId, playerName: "Joiner" });
  await tick();

  // THE GAP. A returning player is a brand-new peer: new id, no memory that slot 2 was theirs,
  // and nothing that hands them the state they missed. In a real match they would be seated as
  // an extra player in a room that already started.
  check("they are given a NEW peer id, not their old one", back.last("joined").you.id, 3);
  check("nothing tells them a match is already running", back.seen("deliver").length, 0);
  check("and nothing replays what they missed", back.seen().map((m) => m.t), ["hello", "rooms", "joined"]);

  // What item 11 has to add, stated as the assertions that will replace these:
  //   • the room keeps the slot alive for a grace period, keyed by a rejoin token
  //   • `join` with that token restores peer id 2 rather than minting 3
  //   • the host answers the rejoin with a FULL snapshot instead of a delta
}

console.log("\na drop is not a leave, even though the relay cannot yet tell");
{
  const { peer } = await room();
  let told = "";
  peer.onClose = (r) => (told = r);
  peer.drop();
  await tick();
  // `close()` is the player choosing to quit; `drop()` is the wifi dying. They are the same
  // path through the relay today and must not be when item 11 lands — a drop has to hold the
  // slot, a leave has to free it.
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

console.log(failed === 0 ? "\nloopback: all checks passed" : `\nloopback: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
