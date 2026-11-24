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

// MUST equal `PROTOCOL_VERSION` in src/net/protocol.ts. The two are hand-kept in sync because
// this file is plain .mjs on purpose — the relay deploys with no build step and so cannot import
// a .ts constant — and a client whose number differs is REFUSED at the handshake. Drift is
// therefore not a degraded lobby, it is no lobby at all: 12 landed on the client alone once and
// every LAN game died at "Connection to the game host was lost." `pnpm relay:test` now reads
// protocol.ts and compares, so the next bump that forgets this line fails a test instead.
export const PROTOCOL_VERSION = 14; // 14: `drop`/`seat`/`abandon`, a refused stale rejoin — 13: observers, colours, advanced options

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
  // Full Observers: the list prints " (observers)" after the game, as the real client does.
  observers: r.observers,
  // Which game the host is on — Reign of Chaos or The Frozen Throne. Passed through untouched;
  // the clients list only their own edition's games (src/net/protocol.ts RoomInfo.edition).
  edition: r.edition,
  // The host's Game Speed rung (src/data/gameSpeed.ts), for the join screen's "Game Speed:" row.
  speed: r.speed,
  // The host's OpenWar3 version, when its client said (0.4.15+). A joiner that gets no answer to
  // a map request words its error off this (src/ui/mapDownload.ts): a host that never said is
  // older than the field, and may be older than map downloads too.
  ...(r.version ? { version: r.version } : {}),
});

const peerInfo = (p) => ({ id: p.id, name: p.name, host: p.host });

/** A rejoin token: unguessable enough that another client cannot seize a dropped player's
 *  slot, cheap enough to mint on a free tier. Node's global crypto in every runtime we target. */
const mkToken = () => globalThis.crypto.randomUUID();

/**
 * How long a DROPPED player's slot is held before the drop becomes a leave.
 *
 * A held slot is a promise that the player may come back, and until this existed it was a
 * promise with no end: a client that closed its tab, lost its machine or quit without a word
 * stayed "disconnected" in the room for the rest of the match, the host was never told it had
 * gone, and so the map's own `EVENT_PLAYER_LEAVE` never fired — its units stood there under a
 * player who was not coming back and the victory check never ran. The client's reconnect is a
 * few seconds of re-dialling (LanLobby.onLost). Ours, not the game's.
 *
 * In a MATCH the host's "Waiting for players..." countdown comes first (`SuspendDialog.fdf`, a
 * few seconds with the game PAUSED). A player with nobody on their side is then let go with a
 * `drop` (below); one with a TEAM is held for the rest of THIS, and may come back through the
 * main menu's "Reconnect?" prompt (`seat`/`abandon` below) — two minutes is the developer's
 * figure (docs/multiplayer.md "A player who drops").
 */
const HOLD_MS = 120_000;

/** The refusal a dropped player's rejoin gets. MUST equal `DROPPED_MESSAGE` in
 *  src/net/protocol.ts — the client tells it apart from every other refusal by this text. */
const DROPPED = "You were dropped from the game.";

/** A client `report` (src/net/lobby.ts `report`): what is kept of it. Every report is written to
 *  the log as it came, so these bound what one client can put there. */
const REPORT_MAX_KEYS = 32;
const REPORT_MAX_STRING = 4000;
/** Reports per connection per minute. A client in a crash loop reports the same error forever;
 *  the client de-duplicates (src/net/lobby.ts) and this is the backstop. */
const REPORTS_PER_MINUTE = 60;

/** A report's `data`, flattened to what a log line can hold: primitives only, strings clipped,
 *  keys clipped, at most REPORT_MAX_KEYS of them. Anything else is dropped rather than trusted. */
function cleanReport(data) {
  const out = {};
  if (!data || typeof data !== "object") return out;
  let n = 0;
  for (const [k, v] of Object.entries(data)) {
    if (n >= REPORT_MAX_KEYS) break;
    const key = String(k).replace(/[^\w.-]/g, "_").slice(0, 40);
    // Prefixed: a client's field can never overwrite one the relay itself writes (level, room…).
    if (typeof v === "string") out[`c_${key}`] = v.slice(0, REPORT_MAX_STRING);
    else if (typeof v === "number" && Number.isFinite(v)) out[`c_${key}`] = v;
    else if (typeof v === "boolean" || v === null) out[`c_${key}`] = v;
    else continue;
    n++;
  }
  return out;
}

const word = (v, max = 64) => (typeof v === "string" ? v.slice(0, max) : undefined);
export class RelayCore {
  /**
   * `describeHost` is asked, per connection, what this machine looks like from the network —
   * `HostInfo` in src/net/protocol.ts. Only a relay that also SERVES THE PAGE passes one (the
   * dev plugin, the desktop app); a standalone or cloud relay leaves it out, because its own
   * addresses say nothing about how a player reaches the game. Asked per connection rather than
   * captured once, since an address can appear or vanish while the game sits on the menu.
   */
  constructor({ describeHost = null, holdMs = HOLD_MS, log = null } = {}) {
    /** Rooms live only in memory. Losing them on restart loses lobbies, not matches. */
    this.rooms = new Map();
    this.conns = new Set();
    this.nextRoomId = 1;
    this.describeHost = describeHost;
    this.holdMs = holdMs;
    /**
     * The event log (server/eventLog.mjs) — `log(event, fields, level)`. Only the deployed relay
     * passes one (relay.mjs); the dev plugin, the desktop app and the tests run silent.
     */
    this.log = log ?? (() => {});
    this.logging = log !== null;
    this.nextConnId = 1;
    if (log) {
      // Who is on, every ten minutes — the line that says the server was alive and how busy.
      const stats = setInterval(() => this.log("relay.stats", this.stats()), 10 * 60_000);
      stats.unref?.();
    }
  }

  /** How busy the server is: connections, rooms, and the players in them. */
  stats() {
    let players = 0;
    let held = 0;
    for (const r of this.rooms.values()) for (const p of r.peers.values()) (p.disconnected ? held++ : players++);
    return { conns: this.conns.size, rooms: this.rooms.size, players, held };
  }

  /** The fields every line about a room carries. */
  roomFields(room) {
    return {
      room: room.id,
      roomName: room.name,
      map: room.mapName,
      mapPath: room.mapPath,
      edition: room.edition,
      hostVersion: room.version ?? null,
      players: [...room.peers.values()].filter((p) => !p.disconnected).length,
      maxPlayers: room.maxPlayers,
      ageS: Math.round((Date.now() - room.createdAt) / 1000),
    };
  }

  /** …and every line about a connection: which client, as it introduced itself. */
  connFields(conn) {
    return { conn: conn.connId, version: conn.client?.version ?? null, install: conn.client?.install ?? null };
  }

  /** A room is gone: one line with how it ended and how long it lived. */
  logRoomClosed(room, why) {
    this.log("room.closed", { ...this.roomFields(room), why, peak: room.peak });
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
    // A dropped peer being held for reconnect (item 11) has no live conn — skip it. It catches
    // up on rejoin, via the host's full snapshot, not by replaying what it missed while gone.
    for (const p of room.peers.values()) if (p.id !== exceptId && p.conn) p.conn.send(msg);
  }

  /** A new connection. Sends the handshake and the current game list, in that order — the
   *  client's `connect()` treats the first message as the version check and will ignore
   *  anything that arrives before it. */
  connect(conn) {
    conn.roomId = null;
    conn.peerId = 0;
    conn.connId = this.nextConnId++;
    conn.openedAt = Date.now();
    conn.reports = { minute: 0, count: 0, dropped: 0 };
    this.conns.add(conn);
    this.log("conn.open", { conn: conn.connId, conns: this.conns.size });
    const host = this.describeHost?.() ?? null;
    // `reports`: this relay KEEPS a log and takes the `report` message (below). Said only by one
    // that logs — the deployed relay, never the dev plugin or the desktop app's own, whose reports
    // would go nowhere — so a client sends its reports to a server that writes them down
    // (src/net/lobby.ts `reportWire`). An older relay answers `report` with "Unknown message",
    // which a lobby would paint as an error, and is never sent one. No protocol bump: older
    // clients ignore the field.
    const hello = this.logging
      ? { t: "hello", protocol: PROTOCOL_VERSION, reports: true }
      : { t: "hello", protocol: PROTOCOL_VERSION };
    conn.send(host ? { ...hello, host } : hello);
    conn.send({ t: "rooms", rooms: this.listing() });
  }

  /**
   * The connection DROPPED — the socket closed, the process died, the wifi went (item 11).
   *
   * A drop is NOT a leave. A leave is a player choosing to quit and frees the slot at once; a
   * drop is an accident the player wants to recover from, so the slot is HELD — the peer stays
   * in the room table, marked disconnected, and its rejoin token still opens it. A `join`
   * carrying that token reclaims the SAME peer id, which is the whole of what "reconnect" means
   * on the relay side.
   *
   * The host is the exception, because v1 has no host migration: if the authority's connection
   * drops, the match cannot continue and the room closes, exactly as a host leave does. So does
   * a drop that empties the room of live connections.
   */
  disconnect(conn) {
    if (!this.conns.delete(conn)) return; // `close` and `error` can both arrive for one socket
    this.log("conn.close", { ...this.connFields(conn), secs: Math.round((Date.now() - conn.openedAt) / 1000), inRoom: conn.roomId ?? null, conns: this.conns.size });
    const room = this.rooms.get(conn.roomId);
    if (!room) return;
    const peer = room.peers.get(conn.peerId);
    conn.roomId = null;
    if (!peer) return;

    // Host drop, or nobody left connected → close, same as a host leave. A room whose every
    // peer is disconnected is holding slots for a match nobody is in; reap it rather than leak.
    const anyLive = [...room.peers.values()].some((p) => p !== peer && !p.disconnected);
    if (peer.host || !anyLive) {
      this.inRoom(room, { t: "room-closed", reason: peer.host ? "The host left the game." : "Empty." });
      for (const p of room.peers.values()) if (p.conn) p.conn.roomId = null;
      this.rooms.delete(room.id);
      this.logRoomClosed(room, peer.host ? "host-dropped" : "everyone-dropped");
      this.broadcastRooms();
      return;
    }

    // A non-host client dropped and others are still here: hold the slot for its return.
    peer.disconnected = true;
    peer.conn = null; // the old connection is gone; a rejoin reattaches a fresh one
    peer.droppedAt = Date.now();
    // With the hold's length, so a TEAM game can count down "Time to reconnect" off the
    // relay's own clock rather than a copy of the number that might disagree with it.
    this.inRoom(room, { t: "peer-drop", peerId: peer.id, holdMs: this.holdMs });
    this.log("peer.drop", { ...this.roomFields(room), ...this.connFields(conn), peer: peer.id, name: peer.name, holdMs: this.holdMs }, "warn");
    this.broadcastRooms();
    // …but not for ever (HOLD_MS). The seat is let go exactly as a chosen `leave` would let it
    // go, so every peer — the host above all — hears the same `peer-leave` either way.
    clearTimeout(peer.dropTimer);
    peer.dropTimer = setTimeout(() => {
      peer.dropTimer = null;
      if (!peer.disconnected || this.rooms.get(room.id) !== room || room.peers.get(peer.id) !== peer) return;
      room.peers.delete(peer.id);
      this.log("peer.hold-expired", { ...this.roomFields(room), peer: peer.id, name: peer.name }, "warn");
      const anyLive = [...room.peers.values()].some((p) => !p.disconnected);
      if (!anyLive) {
        this.rooms.delete(room.id);
        this.logRoomClosed(room, "hold-expired");
      } else {
        this.inRoom(room, { t: "peer-leave", peerId: peer.id });
      }
      this.broadcastRooms();
    }, this.holdMs);
    peer.dropTimer.unref?.(); // a test's RelayCore must not keep Node alive on a held seat
  }

  /** A CHOSEN departure (the `leave` message). Frees the slot immediately — the opposite of a
   *  drop. Closes the room if the host left or nobody is left. */
  leaveRoom(conn) {
    const room = this.rooms.get(conn.roomId);
    if (!room) return;
    const peer = room.peers.get(conn.peerId);
    room.peers.delete(conn.peerId);
    conn.roomId = null;
    this.log("peer.leave", { ...this.roomFields(room), ...this.connFields(conn), peer: conn.peerId, name: peer?.name, host: !!peer?.host });

    // No host migration in v1 (docs/multiplayer.md "What we are accepting"): the host owns
    // the only copy of game state, so its departure ends the room for everyone.
    if (peer?.host || room.peers.size === 0) {
      this.inRoom(room, { t: "room-closed", reason: peer?.host ? "The host left the game." : "Empty." });
      for (const p of room.peers.values()) if (p.conn) p.conn.roomId = null;
      this.rooms.delete(room.id);
      this.logRoomClosed(room, peer?.host ? "host-left" : "empty");
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
        const peer = { id: 1, name: msg.playerName || "Player", host: true, conn, token: mkToken(), disconnected: false };
        const room = {
          id,
          name: msg.name || "OpenWar3 Game",
          hostName: peer.name,
          mapName: msg.mapName || "",
          mapPath: msg.mapPath || "",
          maxPlayers: Math.max(2, Math.min(12, msg.maxPlayers || 12)),
          observers: msg.observers === true,
          edition: msg.edition === "roc" ? "roc" : "tft",
          // 0 Slow … 3 Fastest; anything else (an older client's silence) is Fast, 2.
          speed: Number.isInteger(msg.speed) && msg.speed >= 0 && msg.speed <= 3 ? msg.speed : 2,
          // The host's OpenWar3 version (roomInfo's `version`), as its client sent it.
          version: word(msg.version, 32),
          peers: new Map([[peer.id, peer]]),
          nextPeerId: 2,
          createdAt: Date.now(),
          peak: 1,
        };
        this.rooms.set(id, room);
        conn.roomId = id;
        conn.peerId = peer.id;
        conn.send({ t: "created", room: roomInfo(room), you: peerInfo(peer), token: peer.token });
        this.log("room.create", { ...this.roomFields(room), ...this.connFields(conn), hostName: room.hostName, observers: room.observers, speed: room.speed });
        this.broadcastRooms();
        return;
      }

      case "join": {
        if (conn.roomId) return conn.send({ t: "error", message: "Already in a game." });
        const room = this.rooms.get(msg.roomId);
        if (!room) {
          this.log("join.refused", { ...this.connFields(conn), room: msg.roomId ?? null, why: "gone" });
          return conn.send({ t: "error", message: "That game is no longer available." });
        }

        // RECONNECT (item 11): a `token` matching a slot this room is HOLDING for a dropped
        // player reclaims that exact slot — same peer id, same token — rather than minting a
        // new one. Checked before the full-room test, because reclaiming your own held slot is
        // not taking a new one; a room that is "full" of held slots must still let its own
        // players back in.
        const held = msg.token && [...room.peers.values()].find((p) => p.disconnected && p.token === msg.token);
        if (held) {
          clearTimeout(held.dropTimer); // back in time: the seat is not let go
          held.dropTimer = null;
          held.conn = conn;
          held.disconnected = false;
          if (msg.playerName) held.name = msg.playerName;
          conn.roomId = room.id;
          conn.peerId = held.id;
          conn.send({
            t: "joined",
            room: roomInfo(room),
            you: peerInfo(held),
            peers: [...room.peers.values()].map(peerInfo),
            token: held.token,
          });
          this.inRoom(room, { t: "peer-rejoin", peer: peerInfo(held) }, held.id);
          this.log("peer.rejoin", { ...this.roomFields(room), ...this.connFields(conn), peer: held.id, name: held.name, awayS: Math.round((Date.now() - held.droppedAt) / 1000) });
          this.broadcastRooms();
          return;
        }

        // A token that opens NOTHING is a player coming back to a seat that was let go — dropped
        // by the host's countdown, or by the hold running out. That is not a first join: it is
        // somebody who was in this game and is not any more, and seating them as a new peer
        // would put them in the middle of a match that has already ruled them out. Refused, and
        // the client takes this answer to mean "you were disconnected".
        if (msg.token) {
          this.log("join.refused", { ...this.roomFields(room), ...this.connFields(conn), why: "dropped" });
          return conn.send({ t: "error", message: DROPPED });
        }
        if (room.peers.size >= room.maxPlayers) {
          this.log("join.refused", { ...this.roomFields(room), ...this.connFields(conn), why: "full" });
          return conn.send({ t: "error", message: "That game is full." });
        }
        const peer = { id: room.nextPeerId++, name: msg.playerName || "Player", host: false, conn, token: mkToken(), disconnected: false };
        room.peers.set(peer.id, peer);
        conn.roomId = room.id;
        conn.peerId = peer.id;
        conn.send({
          t: "joined",
          room: roomInfo(room),
          you: peerInfo(peer),
          peers: [...room.peers.values()].map(peerInfo),
          token: peer.token,
        });
        this.inRoom(room, { t: "peer-join", peer: peerInfo(peer) }, peer.id);
        room.peak = Math.max(room.peak, room.peers.size);
        this.log("peer.join", { ...this.roomFields(room), ...this.connFields(conn), peer: peer.id, name: peer.name });
        this.broadcastRooms();
        return;
      }

      case "leave":
        return this.leaveRoom(conn);

      // A player back on the MAIN MENU after a drop asks whether the seat is still theirs to
      // reclaim — the menu's "Reconnect?" prompt is put up only when it is. Answered on the
      // token alone, from a connection in no room: nothing about the room is told but yes/no.
      case "seat": {
        const room = this.rooms.get(msg.roomId);
        const seat = msg.token && room && [...room.peers.values()].find((p) => p.disconnected && p.token === msg.token);
        // …and how long it will stay so, for the prompt's own "Time to reconnect".
        const left = seat ? Math.max(0, seat.droppedAt + this.holdMs - Date.now()) : 0;
        return conn.send({ t: "seat", held: !!seat, left });
      }

      // …and its No: give the held seat up now. A LEAVE in every respect but the connection it
      // arrives on — the seat is freed and every peer is told `peer-leave`, which the host turns
      // into the map's EVENT_PLAYER_LEAVE.
      case "abandon": {
        const room = this.rooms.get(msg.roomId);
        const held = msg.token && room && [...room.peers.values()].find((p) => p.disconnected && p.token === msg.token);
        if (!held) return;
        clearTimeout(held.dropTimer);
        held.dropTimer = null;
        room.peers.delete(held.id);
        this.log("peer.abandon", { ...this.roomFields(room), ...this.connFields(conn), peer: held.id, name: held.name });
        if ([...room.peers.values()].some((p) => !p.disconnected)) this.inRoom(room, { t: "peer-leave", peerId: held.id });
        else {
          this.rooms.delete(room.id);
          this.logRoomClosed(room, "abandoned");
        }
        this.broadcastRooms();
        return;
      }

      // The HOST lets a dropped seat go before its hold runs out — WC3's "Waiting for
      // players..." countdown reached zero (docs/multiplayer.md "A player who drops"). It does
      // exactly what the hold's own timer does, a moment sooner, so every peer hears the same
      // `peer-leave` either way. Only the host may ask, and only of a seat that IS held: a
      // live connection is never thrown out by this, and a client cannot drop anybody.
      case "drop": {
        const room = this.rooms.get(conn.roomId);
        if (!room || !room.peers.get(conn.peerId)?.host) return;
        const held = room.peers.get(msg.peerId);
        if (!held?.disconnected) return;
        clearTimeout(held.dropTimer);
        held.dropTimer = null;
        room.peers.delete(held.id);
        this.log("peer.dropped-by-host", { ...this.roomFields(room), peer: held.id, name: held.name }, "warn");
        this.inRoom(room, { t: "peer-leave", peerId: held.id });
        this.broadcastRooms();
        return;
      }

      // What a CLIENT saw (src/net/lobby.ts `report`): a map that would not download, an error
      // thrown in a match, a match started or ended. Written to the log as it came — prefixed and
      // clipped (`cleanReport`) — beside who sent it and the room it is in. The first one a client
      // sends is `client`, which says who it is; that is kept on the connection and stamped on
      // every line about it afterwards. Never answered: a report is fire-and-forget.
      case "report": {
        const minute = Math.floor(Date.now() / 60_000);
        const quota = conn.reports;
        if (quota.minute !== minute) {
          if (quota.dropped) this.log("report.throttled", { ...this.connFields(conn), dropped: quota.dropped }, "warn");
          quota.minute = minute;
          quota.count = 0;
          quota.dropped = 0;
        }
        if (++quota.count > REPORTS_PER_MINUTE) { quota.dropped++; return; }
        const event = word(msg.event, 48)?.replace(/[^\w.-]/g, "_") || "unnamed";
        const data = cleanReport(msg.data);
        if (event === "client") {
          conn.client = { version: word(msg.data?.version, 32) ?? null, install: word(msg.data?.install, 40) ?? null };
        }
        const level = msg.level === "error" || msg.level === "warn" ? msg.level : "info";
        const room = this.rooms.get(conn.roomId);
        const peer = room?.peers.get(conn.peerId);
        this.log(`client.${event}`, { ...(room ? this.roomFields(room) : {}), ...this.connFields(conn), peer: peer?.id ?? null, name: peer?.name ?? null, ...data }, level);
        return;
      }

      // Opaque game traffic. The relay does not look inside `data` — that payload is the
      // authority's business, and keeping it opaque is what lets the netcode evolve
      // (lobby state now, command stream and snapshots later) without redeploying this.
      case "relay": {
        const room = this.rooms.get(conn.roomId);
        if (!room) return conn.send({ t: "error", message: "Not in a game." });
        const out = { t: "deliver", from: conn.peerId, data: msg.data };
        if (typeof msg.to === "number") {
          const target = room.peers.get(msg.to);
          // `target.conn` is NULL for a peer whose slot is being HELD — item 11a keeps a
          // dropped player in the room table so its token can reclaim the seat, and clears
          // the connection because there is no longer one. Every other send site in this file
          // already guards for that; this one did not, and it predates the held slot entirely.
          //
          // The cost of the miss was not a dropped message, it was the SERVER: the host goes
          // on addressing snapshots to that peer at 10 Hz, and the first one threw
          // `Cannot read properties of null (reading 'send')` out of the connection handler
          // and killed the process — taking every other room on the relay with it. One player
          // choosing Quit Game ended everybody's game (docs/multiplayer.md Phase F item 8).
          //
          // Silence is the right answer, not a queue. What that peer misses while it is away
          // is a stream of snapshots that are stale the moment the next one is built, and a
          // rejoin is already answered with a FULL one off the cadence (item 11b) — so the
          // gap heals itself the instant they are back, and buffering would only make the
          // relay hold match state, which is the one thing it must never do.
          if (target?.conn) target.conn.send(out);
        } else {
          this.inRoom(room, out, conn.peerId);
        }
        return;
      }

      default:
        this.log("relay.unknown-message", { ...this.connFields(conn), t: word(String(msg.t), 32) }, "warn");
        return conn.send({ t: "error", message: `Unknown message: ${String(msg.t)}` });
    }
  }
}
