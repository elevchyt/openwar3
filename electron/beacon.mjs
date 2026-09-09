// Announcing this game on the local network, and hearing everyone else's.
//
// This is the half of LAN play a browser cannot do at all: a page cannot send a datagram, so two
// copies of OpenWar3 on one network could never find each other and somebody had to type an
// address. Real Warcraft III has never asked that — it broadcasts on the subnet and the games
// appear — and this is the same trick in the one place we can play it, the desktop app's own
// process.
//
// It is deliberately SMALL. All a beacon carries is "an OpenWar3 speaking protocol N is on this
// address, and its relay is on this port"; everything after that is the relay's own conversation
// (src/net/lobby.ts `addRelay`), which already knows how to watch another machine and merge its
// games into the list. So discovery adds an ADDRESS and nothing else — no game state travels in
// a datagram, and a beacon is never trusted for anything but where to knock.
//
// It broadcasts while the APP is running rather than only while a game is hosted. Two seconds
// and a hundred bytes is nothing on a LAN, and it means the other machine is already being
// watched when a game is created there — the games list fills in the moment somebody hosts,
// rather than a beacon-interval later.

import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";

/** The relay's port plus one, and deliberately nowhere near **6112** — that is Warcraft III's
 *  own, and a real install on the same subnet must never be confused by us nor we by it. */
export const DEFAULT_BEACON_PORT = 8788;

/** How often we say we are here. Also the unit the far end forgets us in: a peer unheard for
 *  `MISSES` beacons is gone (a closed game, a pulled cable), which is the same "noticed within a
 *  couple of beats" rule the relay's own heartbeat uses. */
const INTERVAL_MS = 2000;
const MISSES = 3;

/** Every directed broadcast address this machine has, one per IPv4 interface.
 *
 *  Not just 255.255.255.255: that is the LIMITED broadcast, which plenty of stacks refuse to
 *  route out of a chosen interface, so a machine with wifi and ethernet can end up shouting down
 *  only one of them. The per-interface address (host bits all ones) is the one that reliably
 *  reaches the subnet the other player is actually on. The limited one is sent too, as a
 *  fallback for anything that only listens for that. */
function broadcastAddresses() {
  const out = new Set(["255.255.255.255"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.internal || (e.family !== "IPv4" && e.family !== 4)) continue;
      const addr = e.address.split(".").map(Number);
      const mask = e.netmask.split(".").map(Number);
      if (addr.length !== 4 || mask.length !== 4) continue;
      out.add(addr.map((b, i) => (b | (~mask[i] & 0xff)) & 0xff).join("."));
    }
  }
  return [...out];
}

/**
 * Start announcing, and listening.
 *
 * `port()` is asked each beat rather than captured: the server takes the port it can get
 * (electron/server.mjs walks a busy one), and a beacon that announced a stale number would send
 * every listener knocking at nothing.
 *
 * `onChange(peers)` fires whenever the set of machines we can hear changes — each peer being
 * `{ url, id }`, the url being what `LanLobby.addRelay` takes. It fires on a peer ARRIVING and
 * on one being forgotten, never on the beats in between, so the renderer is told about changes
 * and not about time passing.
 */
export function startBeacon({ port, protocol, beaconPort = DEFAULT_BEACON_PORT, onChange }) {
  // Ours, so we can ignore our own broadcasts. An address cannot do this job: we hear ourselves
  // on whichever interface the datagram went out of, and on a machine running two copies (which
  // is how this gets tested) both would look like "us".
  const id = randomUUID();
  const peers = new Map(); // id → { url, address, port, seen }
  let timer = null;
  let closed = false;

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  const snapshot = () => [...peers].map(([peerId, p]) => ({ id: peerId, url: p.url }));
  const announce = (changed) => { if (changed && !closed) onChange?.(snapshot()); };

  socket.on("message", (buf, rinfo) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    // Anything that is not our own beacon shape is somebody else's traffic on a port we happen
    // to share. A datagram is unauthenticated by nature, which is exactly why nothing here is
    // believed except an address to knock at.
    if (!msg || msg.app !== "openwar3" || msg.id === id) return;
    // A build that speaks another protocol would be refused at the relay's handshake anyway;
    // dropping it here means it is never even listed, rather than listed and unjoinable.
    if (msg.protocol !== protocol) return;
    if (typeof msg.port !== "number" || typeof msg.id !== "string") return;

    const url = `ws://${rinfo.address}:${msg.port}/relay`;
    const existing = peers.get(msg.id);
    peers.set(msg.id, { url, address: rinfo.address, port: msg.port, seen: Date.now() });
    announce(!existing || existing.url !== url);
  });

  socket.on("error", (err) => {
    // A refused bind is a machine where discovery cannot work (a firewall, a port in use). It is
    // not a reason to fail to start a GAME — the address box still exists — so it is reported and
    // the rest of the app carries on.
    console.warn("[OpenWar3] beacon unavailable:", err?.message ?? err);
    try { socket.close(); } catch { /* already gone */ }
    if (timer) { clearInterval(timer); timer = null; }
  });

  socket.bind(beaconPort, () => {
    socket.setBroadcast(true);
    const beat = () => {
      const payload = Buffer.from(JSON.stringify({ app: "openwar3", protocol, id, port: port() }));
      for (const target of broadcastAddresses()) {
        socket.send(payload, beaconPort, target, () => { /* a send that fails is one lost beat */ });
      }
      // Forget whoever has stopped talking.
      const cutoff = Date.now() - INTERVAL_MS * MISSES;
      let dropped = false;
      for (const [peerId, p] of peers) if (p.seen < cutoff) { peers.delete(peerId); dropped = true; }
      announce(dropped);
    };
    beat();
    timer = setInterval(beat, INTERVAL_MS);
    // Node keeps a process alive for a pending timer; the window is what should decide that.
    timer.unref?.();
  });

  return {
    peers: snapshot,
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      try { socket.close(); } catch { /* never bound */ }
    },
  };
}
