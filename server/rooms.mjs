// The relay's actual logic — rooms, peers, and message routing — with no socket in sight.
//
// This was the body of `relay.mjs` (docs/multiplayer.md Phase E item 8). It came out because
// the alternative was writing it TWICE: once over WebSockets for real play, and once
// in-process so two clients can be driven from one Node test without a listening port. Two
// implementations of a routing table is two sets of rules that agree until the day they do
// not, and the one that would drift is the one no test covers.
//
// So the rule has one home and two adapters. `relay.mjs` is the WebSocket adapter — it owns
// the port, the JSON framing, and nothing else. `tools/loopback.mjs` is the in-process one.
// `pnpm relay:test` still drives the real server over real sockets, so the extraction is
// covered by the test that was already there rather than by a new one asserting the move.
//
// A CONNECTION here is anything with `send(msg)`. The core hangs `roomId`/`peerId` on it, the
// same two fields the adapter used to hang on the `ws` object. It never sees bytes: framing
// and parse errors belong to whoever owns the wire.
//
// Still deliberately dumb, and for the reasons relay.mjs states: no simulation, no Blizzard
// data, no match state beyond this table. Keep it that way — it is what makes a free tier
// viable and what keeps us clear of hosting Blizzard content.

export const PROTOCOL_VERSION = 2;

/** The game list entry, as LocalMultiplayerJoin.fdf wants it. */
const roomInfo = (r) => ({
  id: r.id,
  name: r.name,
  hostName: r.hostName,
  mapName: r.mapName,
  // The PATH, not the file: joiners open the same map out of their own install. The relay
  // never carries Blizzard content — see src/net/protocol.ts RoomInfo.mapPath.
  mapPath: r.mapPath,
  players: r.peers.size,
  maxPlayers: r.maxPlayers,
});

const peerInfo = (p) => ({ id: p.id, name: p.name, host: p.host });

export class RelayCore {
  constructor() {
    /** Rooms live only in memory. Losing them on restart loses lobbies, not matches. */
    this.rooms = new Map();
    this.conns = new Set();
    this.nextRoomId = 1;
  }

  listing() {
    return [...this.rooms.values()].map(roomInfo);
  }

  /** Push the game list to everyone not already in a room — WC3's LAN screen refreshes
   *  itself, so the browser never has to poll. */
  broadcastRooms() {
    const msg = { t: "rooms", rooms: this.listing() };
    for (const c of this.conns) if (!c.roomId) c.send(msg);
  }

  inRoom(room, msg, exceptId) {
    for (const p of room.peers.values()) if (p.id !== exceptId) p.conn.send(msg);
  }

  /** A new connection. Sends the handshake and the current game list, in that order — the
   *  client's `connect()` treats the first message as the version check and will ignore
   *  anything that arrives before it. */
  connect(conn) {
    conn.roomId = null;
    conn.peerId = 0;
    this.conns.add(conn);
    conn.send({ t: "hello", protocol: PROTOCOL_VERSION });
    conn.send({ t: "rooms", rooms: this.listing() });
  }

  /** The connection is gone (closed, errored, or the process it lived in went away). */
  disconnect(conn) {
    this.leaveRoom(conn);
    this.conns.delete(conn);
  }

  /** Remove a connection from its room, closing the room if the host left. */
  leaveRoom(conn) {
    const room = this.rooms.get(conn.roomId);
    if (!room) return;
    const peer = room.peers.get(conn.peerId);
    room.peers.delete(conn.peerId);
    conn.roomId = null;

    // No host migration in v1 (docs/multiplayer.md "What we are accepting"): the host owns
    // the only copy of game state, so its departure ends the room for everyone.
    if (peer?.host || room.peers.size === 0) {
      this.inRoom(room, { t: "room-closed", reason: peer?.host ? "The host left the game." : "Empty." });
      for (const p of room.peers.values()) p.conn.roomId = null;
      this.rooms.delete(room.id);
    } else {
      this.inRoom(room, { t: "peer-leave", peerId: conn.peerId });
    }
    this.broadcastRooms();
  }

  /** One already-parsed client message. */
  handle(conn, msg) {
    switch (msg.t) {
      case "list":
        return conn.send({ t: "rooms", rooms: this.listing() });

      case "create": {
        if (conn.roomId) return conn.send({ t: "error", message: "Already in a game." });
        const id = String(this.nextRoomId++);
        const peer = { id: 1, name: msg.playerName || "Player", host: true, conn };
        const room = {
          id,
          name: msg.name || "OpenWar3 Game",
          hostName: peer.name,
          mapName: msg.mapName || "",
          mapPath: msg.mapPath || "",
          maxPlayers: Math.max(2, Math.min(12, msg.maxPlayers || 12)),
          peers: new Map([[peer.id, peer]]),
          nextPeerId: 2,
        };
        this.rooms.set(id, room);
        conn.roomId = id;
        conn.peerId = peer.id;
        conn.send({ t: "created", room: roomInfo(room), you: peerInfo(peer) });
        this.broadcastRooms();
        return;
      }

      case "join": {
        if (conn.roomId) return conn.send({ t: "error", message: "Already in a game." });
        const room = this.rooms.get(msg.roomId);
        if (!room) return conn.send({ t: "error", message: "That game is no longer available." });
        if (room.peers.size >= room.maxPlayers) return conn.send({ t: "error", message: "That game is full." });
        const peer = { id: room.nextPeerId++, name: msg.playerName || "Player", host: false, conn };
        room.peers.set(peer.id, peer);
        conn.roomId = room.id;
        conn.peerId = peer.id;
        conn.send({
          t: "joined",
          room: roomInfo(room),
          you: peerInfo(peer),
          peers: [...room.peers.values()].map(peerInfo),
        });
        this.inRoom(room, { t: "peer-join", peer: peerInfo(peer) }, peer.id);
        this.broadcastRooms();
        return;
      }

      case "leave":
        return this.leaveRoom(conn);

      // Opaque game traffic. The relay does not look inside `data` — that payload is the
      // authority's business, and keeping it opaque is what lets the netcode evolve
      // (lobby state now, command stream and snapshots later) without redeploying this.
      case "relay": {
        const room = this.rooms.get(conn.roomId);
        if (!room) return conn.send({ t: "error", message: "Not in a game." });
        const out = { t: "deliver", from: conn.peerId, data: msg.data };
        if (typeof msg.to === "number") {
          const target = room.peers.get(msg.to);
          if (target) target.conn.send(out);
        } else {
          this.inRoom(room, out, conn.peerId);
        }
        return;
      }

      default:
        return conn.send({ t: "error", message: `Unknown message: ${String(msg.t)}` });
    }
  }
}
