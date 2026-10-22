// Do a match's messages take the DIRECT link once it opens — in order, whole, and back onto the
// relay when it dies? (docs/multiplayer.md "Direct links (WebRTC)" — src/net/directLink.ts)
//
// Node has no WebRTC, so this drives `DirectChannel` over a FAKE one: peer connections that
// "connect" when both descriptions are set and hand data-channel messages across after a short
// delay, and a fake relay that hands messages across after a LONG one — the relay hairpin is the
// slow path, which is exactly what makes the cutover worth testing: a message sent direct can
// overtake one sent over the relay a moment earlier, and must not be delivered before it.
// The real thing is exercised in two browsers (devBoot `?dev&lan=host|join`); this pins the
// rules that are invisible there.
//
// Run: pnpm sim:test (after `tsc -p tools/tsconfig.sim.json`)
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { DirectChannel } = require(join(REPO, ".sim-build", "src", "net", "directLink.js"));

let failed = 0;
function check(what, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RELAY_MS = 30;
const DIRECT_MS = 2;

// ---- a fake relay: one MatchChannel per peer, ordered per pair, slow -------------------------
function fakeRelay(ids) {
  const ends = new Map();
  for (const id of ids) {
    const end = {
      id,
      sent: 0,
      onPeerData: () => {},
      onPeerRejoin: () => {},
      onPeerLeave: () => {},
      onRoomClosed: () => {},
      send(data, to) {
        end.sent++;
        const copy = JSON.parse(JSON.stringify(data));
        for (const other of ends.values()) {
          if (other === end || (to !== undefined && other.id !== to)) continue;
          setTimeout(() => other.onPeerData(id, copy), RELAY_MS); // timers of equal delay fire in order
        }
      },
    };
    ends.set(id, end);
  }
  return ends;
}

// ---- a fake WebRTC ---------------------------------------------------------------------------
const registry = new Map(); // sdp token → pc
let nextToken = 1;
const fake = { refuse: false, made: [] };

class FakeChannel {
  constructor(pc) {
    this.pc = pc;
    this.readyState = "connecting";
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.peer = null;
  }
  send(text) {
    if (this.readyState !== "open") throw new Error("not open");
    const peer = this.peer;
    setTimeout(() => peer.readyState === "open" && peer.onmessage?.({ data: text }), DIRECT_MS);
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
    const peer = this.peer;
    if (peer && peer.readyState !== "closed") setTimeout(() => peer.close(), DIRECT_MS);
  }
}

class FakePC {
  constructor() {
    this.token = `t${nextToken++}`;
    registry.set(this.token, this);
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = "new";
    this.dc = null;
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.ondatachannel = null;
    this.candidates = [];
    fake.made.push(this);
  }
  createDataChannel() {
    this.dc = new FakeChannel(this);
    return this.dc;
  }
  async createOffer() { return { type: "offer", sdp: this.token }; }
  async createAnswer() { return { type: "answer", sdp: this.token }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    setTimeout(() => this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: `cand ${this.token}`, sdpMid: "0" }) } }), 1);
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    this.remote = registry.get(d.sdp);
    if (d.type === "answer") this.connect();
  }
  async addIceCandidate(c) { this.candidates.push(c); }
  connect() {
    const a = this;
    const b = this.remote;
    if (fake.refuse) {
      setTimeout(() => { a.connectionState = "failed"; a.onconnectionstatechange?.(); }, 5);
      return;
    }
    setTimeout(() => {
      // The offerer made the channel; the answerer is handed its twin, already OPEN (Chrome's way).
      const theirs = new FakeChannel(b);
      a.dc.peer = theirs;
      theirs.peer = a.dc;
      a.connectionState = b.connectionState = "connected";
      theirs.readyState = "open";
      b.dc = theirs;
      b.ondatachannel?.({ channel: theirs });
      a.dc.readyState = "open";
      a.dc.onopen?.();
    }, 5);
  }
  close() {
    this.connectionState = "closed";
    this.dc?.close();
  }
}
const rtc = () => new FakePC();

async function room(peersOf = { 1: [2, 3], 2: [1, 3], 3: [1, 2] }) {
  registry.clear();
  fake.made.length = 0;
  const relay = fakeRelay([1, 2, 3]);
  const got = { 1: [], 2: [], 3: [] };
  const ch = {};
  for (const id of [1, 2, 3]) {
    ch[id] = new DirectChannel(relay.get(id), { self: id, hostPeer: 1, isHost: id === 1, peers: peersOf[id], rtc });
    ch[id].onPeerData = (from, data) => got[id].push({ from, data });
  }
  return { relay, ch, got };
}

(async () => {
  // ---- 1. it opens, and the cutover keeps order ------------------------------------------------
  {
    const { relay, ch, got } = await room();
    // A client firing commands from the first instant, through the whole handshake and past it.
    for (let i = 0; i < 120; i++) {
      ch[2].send({ k: "cmd", n: i }, 1);
      await sleep(1);
    }
    await sleep(RELAY_MS * 3);
    const seq = got[1].filter((m) => m.from === 2 && m.data.k === "cmd").map((m) => m.data.n);
    check("every command a client sent reaches the host exactly once", seq.length === 120, seq.length);
    check("…in the order it was sent, across the switch from relay to direct", seq.every((n, i) => n === i), seq.slice(0, 40));
    check("the client's link to the host is direct once it opens", ch[2].isDirect(1));
    check("…and so is the host's to it", ch[1].isDirect(2));
    check("…and most of the traffic took it", ch[2].counts.directOut > 60, ch[2].counts);
    check("no client opens a link to another client — the star stays a star", !ch[2].isDirect(3) && !ch[3].isDirect(2));
    check("the rtc signaling never reaches the match", !got[1].some((m) => m.data.k === "rtc") && !got[2].some((m) => m.data.k === "rtc"));

    // A host broadcast reaches both clients, direct to each.
    const before = relay.get(1).sent;
    ch[1].send({ k: "pause", on: true });
    await sleep(RELAY_MS * 2);
    check("a host broadcast reaches every client", got[2].some((m) => m.data.k === "pause") && got[3].some((m) => m.data.k === "pause"));
    check("…without touching the relay once every client has a link", relay.get(1).sent === before);
    // A client broadcast reaches the host direct and the other client over the relay.
    ch[2].send({ k: "ready" });
    await sleep(RELAY_MS * 2);
    check("a client broadcast reaches the host and the other client", got[1].some((m) => m.from === 2 && m.data.k === "ready") && got[3].some((m) => m.from === 2 && m.data.k === "ready"));

    // A payload far past one data-channel message arrives whole.
    const big = { k: "snapw", snap: "x".repeat(300_000) + "end" };
    ch[1].send(big, 2);
    await sleep(DIRECT_MS * 10);
    const back = got[2].find((m) => m.data.k === "snapw");
    check("a 300 KB payload is sent in pieces and arrives whole", back?.data.snap.length === big.snap.length && back.data.snap.endsWith("end"));

    // ---- 2. the link dies mid-match: back on the relay, nothing after it lost, then re-offered --
    const pc = fake.made.find((p) => p.dc?.peer && p.connectionState === "connected");
    got[1].length = 0;
    ch[3].send({ k: "x" }, 1); // keep the other client honest: its link is untouched
    pc.dc.close();
    await sleep(DIRECT_MS * 5);
    check("a dead link puts its peer back on the relay", !ch[2].isDirect(1) || !ch[1].isDirect(2));
    for (let i = 0; i < 20; i++) ch[2].send({ k: "cmd", n: 1000 + i }, 1);
    await sleep(RELAY_MS * 3);
    const after = got[1].filter((m) => m.from === 2 && m.data.k === "cmd").map((m) => m.data.n);
    check("…and what is sent after it arrives, in order, over the relay", after.length === 20 && after.every((n, i) => n === 1000 + i), after);
    await sleep(2500); // the first retry is 2 s out
    check("the client offers again, and the link comes back", ch[2].isDirect(1) && ch[1].isDirect(2));
    for (const c of Object.values(ch)) c.close();
  }

  // ---- 3. a NAT that refuses: the match plays on the relay ------------------------------------
  {
    fake.refuse = true;
    const { relay, ch, got } = await room();
    await sleep(50);
    ch[2].send({ k: "cmd", n: 1 }, 1);
    await sleep(RELAY_MS * 2);
    check("a link ICE cannot open leaves the peer on the relay", !ch[2].isDirect(1) && !ch[1].isDirect(2));
    check("…and the match's traffic still arrives", got[1].some((m) => m.data.n === 1));
    check("…sent over the relay", relay.get(2).sent > 0 && ch[2].counts.directOut === 0);
    fake.refuse = false;
    for (const c of Object.values(ch)) c.close();
  }

  // ---- 4. nobody can open a link in somebody else's name -----------------------------------
  {
    const { ch } = await room({ 1: [2], 2: [1], 3: [1, 2] });
    await sleep(100);
    check("a host answers only the peers seated in its match", ch[2].isDirect(1) && !ch[1].isDirect(3) && !ch[3].isDirect(1));
    for (const c of Object.values(ch)) c.close();
  }

  // ---- 5. leaving --------------------------------------------------------------------------
  {
    const { relay, ch } = await room();
    await sleep(100);
    relay.get(1).onPeerLeave(2);
    check("a peer that leaves loses its link", !ch[1].isDirect(2) && ch[1].isDirect(3));
    let closedSeen = false;
    ch[2].onRoomClosed = () => (closedSeen = true);
    relay.get(2).onRoomClosed("gone");
    check("the room closing tears every link down and is still reported", closedSeen && !ch[2].isDirect(1));
    for (const c of Object.values(ch)) c.close();
  }

  console.log(failed === 0 ? "\ndirect-link: all checks passed" : `\ndirect-link: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
