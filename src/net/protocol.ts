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
  /** The map's own name, for the game list ("Echo Isles"). */
  mapName: string;
  /**
   * The map's path inside the install ("Maps\\FrozenThrone\\(2)EchoIsles.w3x") — how a
   * joiner finds the SAME map in ITS OWN install.
   *
   * The map file itself is never sent. It is Blizzard content (CLAUDE.md "Legal boundary"),
   * every player already holds a licensed copy of it, and it is megabytes we would be pushing
   * through a free-tier relay. The path is the whole handshake; a player whose install lacks
   * that map is told so, rather than being handed one.
   */
  mapPath: string;
  players: number;
  maxPlayers: number;
}

// --- client → relay ---------------------------------------------------------------

export type ClientMessage =
  /** Announce a game. The sender becomes the room's host, hence its authority. */
  | { t: "create"; name: string; playerName: string; mapName: string; mapPath: string; maxPlayers: number }
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

// --- game traffic (inside `relay`/`deliver`) ---------------------------------------
//
// Everything below is opaque to the relay — it forwards these without looking. This is the
// layer the command stream and the snapshot stream will join (docs/multiplayer.md Phase C/E);
// `start` is the first member, and the only one so far.

/**
 * The host's "we are playing this, now". Sent to every peer the instant the host presses
 * Start Game, and the host acts on its own copy at the same moment.
 *
 * It carries the whole match identity: which map, who is in which slot, and the seed. Every
 * recipient builds the SAME `MeleeConfig` from it — the one difference between two clients is
 * which slot each calls its own, and each works that out from `slots[].peer` rather than from
 * anything the host has to say separately.
 */
export interface StartMatch {
  k: "start";
  /** Where the map lives in the install. Resolved locally by every client — see RoomInfo. */
  mapPath: string;
  /** The map's name, for the "you don't have this map" message a joiner may have to show. */
  mapName: string;
  /** The match's RNG seed. The host rolls it once; nobody else rolls one (Phase A). */
  seed: number;
  /** The seated slots, exactly as `MeleeConfig.slots` — plus, for a human slot, the relay
   *  peer id sitting in it. A client's own slot is the one whose `peer` is its own id. */
  slots: Array<{
    id: number;
    controller: "user" | "computer";
    race: string;
    team: number;
    startX: number;
    startY: number;
    peer?: number;
  }>;
}

export type GameMessage = StartMatch;

/** Bumped whenever the shapes above change incompatibly; the client refuses a mismatch
 *  rather than failing in a confusing way three messages later. */
export const PROTOCOL_VERSION = 2;

/** Default relay port. Overridable via PORT (the env var Railway/Render both inject). */
export const DEFAULT_RELAY_PORT = 8787;
