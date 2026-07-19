// The relay wire protocol — shared verbatim by the browser client (src/net/) and the
// relay service (server/relay.mjs).
//
// The relay is deliberately DUMB: it keeps a room table and forwards bytes. It never
// simulates, never validates a game order, and never sees a byte of Blizzard data. That
// is what lets it run on a free tier, and what keeps docs/multiplayer.md's legal line
// intact — the authoritative sim lives on the HOST client, which already holds a licensed
// install (see docs/multiplayer.md "Why the host, and not a server").
//
// Everything below the `Envelope` layer is opaque to the relay: game traffic travels as
// `relay`/`deliver` payloads it forwards without inspecting.

/** A player as the lobby knows them. `id` is assigned by the relay and is unique per room. */
export interface PeerInfo {
  id: number;
  name: string;
  /** The room's authority. Exactly one peer is the host; it is the peer that created the room. */
  host: boolean;
}

/** A room as it appears in the game list (WC3's LAN screen lists games, not codes). */
export interface RoomInfo {
  id: string;
  /** Game name as the host typed it — the "Game Creator" column on LocalMultiplayerJoin. */
  name: string;
  hostName: string;
  mapName: string;
  players: number;
  maxPlayers: number;
}

// --- client → relay ---------------------------------------------------------------

export type ClientMessage =
  /** Announce a game. The sender becomes the room's host, hence its authority. */
  | { t: "create"; name: string; playerName: string; mapName: string; maxPlayers: number }
  /** Ask for the game list. The relay also pushes `rooms` unprompted when it changes. */
  | { t: "list" }
  | { t: "join"; roomId: string; playerName: string }
  | { t: "leave" }
  /** Opaque game traffic. `to` omitted = everyone else in the room. */
  | { t: "relay"; to?: number; data: unknown };

// --- relay → client ---------------------------------------------------------------

export type ServerMessage =
  /** Handshake: sent once on connect, before anything else. */
  | { t: "hello"; protocol: number }
  | { t: "created"; room: RoomInfo; you: PeerInfo }
  | { t: "rooms"; rooms: RoomInfo[] }
  | { t: "joined"; room: RoomInfo; you: PeerInfo; peers: PeerInfo[] }
  | { t: "peer-join"; peer: PeerInfo }
  | { t: "peer-leave"; peerId: number }
  /** The host vanished. The match cannot continue — v1 has no host migration. */
  | { t: "room-closed"; reason: string }
  | { t: "deliver"; from: number; data: unknown }
  | { t: "error"; message: string };

/** Bumped whenever the shapes above change incompatibly; the client refuses a mismatch
 *  rather than failing in a confusing way three messages later. */
export const PROTOCOL_VERSION = 1;

/** Default relay port. Overridable via PORT (the env var Railway/Render both inject). */
export const DEFAULT_RELAY_PORT = 8787;
