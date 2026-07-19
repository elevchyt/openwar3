// The OpenWar3 relay — rooms and message forwarding, nothing else.
//
// Run locally for LAN play and for two-window testing:   node server/relay.mjs
// Deploy the same file to Railway/Render for internet play (it reads PORT).
//
// WHY THIS IS DUMB, ON PURPOSE (docs/multiplayer.md):
//   • It runs no simulation. The authoritative sim is the HOST CLIENT's. That keeps the
//     CPU cost on hardware we don't rent, which is what makes a free tier viable.
//   • It never loads Blizzard data. An authoritative *server* would have to read the
//     install's SLKs to know a footman's stats — and OpenWar3_PLAN.md §8 forbids hosting
//     Blizzard content. A relay sidesteps that entirely: it forwards opaque payloads.
//   • It keeps no match state beyond a room table, so a cold start or a restart costs a
//     lobby, never a game in progress.
//
// The protocol is src/net/protocol.ts. This file must stay in sync with it by hand — it is
// plain .mjs so the relay can be deployed on its own, with no build step and no bundler.

import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8787;
const PROTOCOL_VERSION = 1;

/** Rooms live only in memory. Losing them on restart loses lobbies, not matches. */
const rooms = new Map(); // roomId -> { id, name, hostName, mapName, maxPlayers, peers: Map<id, {id,name,host,ws}> }
let nextRoomId = 1;

const send = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

/** The game list, as LocalMultiplayerJoin.fdf wants it. */
const roomInfo = (r) => ({
  id: r.id,
  name: r.name,
  hostName: r.hostName,
  mapName: r.mapName,
  players: r.peers.size,
  maxPlayers: r.maxPlayers,
});

const peerInfo = (p) => ({ id: p.id, name: p.name, host: p.host });

const listing = () => [...rooms.values()].map(roomInfo);

/** Push the game list to everyone not already in a room — WC3's LAN screen refreshes
 *  itself, so the browser never has to poll. */
function broadcastRooms() {
  const msg = { t: "rooms", rooms: listing() };
  for (const ws of wss.clients) if (!ws.roomId) send(ws, msg);
}

function inRoom(room, msg, exceptId) {
  for (const p of room.peers.values()) if (p.id !== exceptId) send(p.ws, msg);
}

/** Remove a connection from its room, closing the room if the host left. */
function leaveRoom(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  const peer = room.peers.get(ws.peerId);
  room.peers.delete(ws.peerId);
  ws.roomId = null;

  // No host migration in v1 (docs/multiplayer.md "What we are accepting"): the host owns
  // the only copy of game state, so its departure ends the room for everyone.
  if (peer?.host || room.peers.size === 0) {
    inRoom(room, { t: "room-closed", reason: peer?.host ? "The host left the game." : "Empty." });
    for (const p of room.peers.values()) p.ws.roomId = null;
    rooms.delete(room.id);
  } else {
    inRoom(room, { t: "peer-leave", peerId: ws.peerId });
  }
  broadcastRooms();
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  ws.roomId = null;
  ws.peerId = 0;
  send(ws, { t: "hello", protocol: PROTOCOL_VERSION });
  send(ws, { t: "rooms", rooms: listing() });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { t: "error", message: "Malformed message." });
    }

    switch (msg.t) {
      case "list":
        return send(ws, { t: "rooms", rooms: listing() });

      case "create": {
        if (ws.roomId) return send(ws, { t: "error", message: "Already in a game." });
        const id = String(nextRoomId++);
        const peer = { id: 1, name: msg.playerName || "Player", host: true, ws };
        const room = {
          id,
          name: msg.name || "OpenWar3 Game",
          hostName: peer.name,
          mapName: msg.mapName || "",
          maxPlayers: Math.max(2, Math.min(12, msg.maxPlayers || 12)),
          peers: new Map([[peer.id, peer]]),
          nextPeerId: 2,
        };
        rooms.set(id, room);
        ws.roomId = id;
        ws.peerId = peer.id;
        send(ws, { t: "created", room: roomInfo(room), you: peerInfo(peer) });
        broadcastRooms();
        return;
      }

      case "join": {
        if (ws.roomId) return send(ws, { t: "error", message: "Already in a game." });
        const room = rooms.get(msg.roomId);
        if (!room) return send(ws, { t: "error", message: "That game is no longer available." });
        if (room.peers.size >= room.maxPlayers) return send(ws, { t: "error", message: "That game is full." });
        const peer = { id: room.nextPeerId++, name: msg.playerName || "Player", host: false, ws };
        room.peers.set(peer.id, peer);
        ws.roomId = room.id;
        ws.peerId = peer.id;
        send(ws, {
          t: "joined",
          room: roomInfo(room),
          you: peerInfo(peer),
          peers: [...room.peers.values()].map(peerInfo),
        });
        inRoom(room, { t: "peer-join", peer: peerInfo(peer) }, peer.id);
        broadcastRooms();
        return;
      }

      case "leave":
        return leaveRoom(ws);

      // Opaque game traffic. The relay does not look inside `data` — that payload is the
      // authority's business, and keeping it opaque is what lets the netcode evolve
      // (lobby state now, command stream and snapshots later) without redeploying this.
      case "relay": {
        const room = rooms.get(ws.roomId);
        if (!room) return send(ws, { t: "error", message: "Not in a game." });
        const out = { t: "deliver", from: ws.peerId, data: msg.data };
        if (typeof msg.to === "number") {
          const target = room.peers.get(msg.to);
          if (target) send(target.ws, out);
        } else {
          inRoom(room, out, ws.peerId);
        }
        return;
      }

      default:
        return send(ws, { t: "error", message: `Unknown message: ${String(msg.t)}` });
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

console.log(`[OpenWar3] relay listening on ws://localhost:${PORT}`);
