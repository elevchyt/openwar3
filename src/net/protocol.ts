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
  /** The host chose Full Observers: the game list prints the game's own `GAMELIST_OBSERVERS`
   *  " (observers)" after it, and `maxPlayers` counts the bench. */
  observers: boolean;
}

// --- client → relay ---------------------------------------------------------------

export type ClientMessage =
  /** Announce a game. The sender becomes the room's host, hence its authority. */
  | { t: "create"; name: string; playerName: string; mapName: string; mapPath: string; maxPlayers: number; observers?: boolean }
  /** Ask for the game list. The relay also pushes `rooms` unprompted when it changes. */
  | { t: "list" }
  /** Join a room. `token` is a REJOIN token from an earlier `created`/`joined` in this room —
   *  present it to reclaim the same slot after a dropped connection (Phase E item 11). Absent
   *  for a first-time join. */
  | { t: "join"; roomId: string; playerName: string; token?: string }
  | { t: "leave" }
  /** Opaque game traffic. `to` omitted = everyone else in the room. */
  | { t: "relay"; to?: number; data: unknown };

// --- relay → client ---------------------------------------------------------------

export type ServerMessage =
  /** Handshake: sent once on connect, before anything else. */
  | { t: "hello"; protocol: number; host?: HostInfo }
  /** `token` is this peer's OWN rejoin token — secret, sent only to it, never in a peer list.
   *  Stash it; presenting it on a later `join` reclaims this exact slot (item 11). */
  | { t: "created"; room: RoomInfo; you: PeerInfo; token: string }
  | { t: "rooms"; rooms: RoomInfo[] }
  | { t: "joined"; room: RoomInfo; you: PeerInfo; peers: PeerInfo[]; token: string }
  | { t: "peer-join"; peer: PeerInfo }
  | { t: "peer-leave"; peerId: number }
  /** A peer's connection DROPPED (item 11). Its slot is HELD for reconnect, not freed — this
   *  is distinct from `peer-leave`, which is a chosen departure. A roster may show "reconnecting". */
  | { t: "peer-drop"; peerId: number }
  /** A dropped peer came back on its token, reclaiming the SAME id it had before. */
  | { t: "peer-rejoin"; peer: PeerInfo }
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
    /** The colour the lobby gave the seat (a PLAYER_COLORS index — `SetPlayerColor`). Absent
     *  reads as the slot's own index, WC3's default. */
    color?: number;
    startX: number;
    startY: number;
    peer?: number;
    /** WHICH computer, on a computer slot — `MeleeDifficulty()` (src/ai/ids.ts). Absent on a
     *  human's slot; absent on a computer's reads as MELEE_NORMAL. */
    aiDifficulty?: number;
    /** …and whether it is a Computer+ (src/ai/plus/) — the host's Advanced Options switch. */
    aiPlus?: boolean;
    /** The person in the seat, by name — what the LOADING SCREEN's roster prints (issue #78).
     *  Absent on a computer slot, which is named by what it is. */
    name?: string;
  }>;
  /** Who is WATCHING: the Observers bench, by relay peer. They hold no slot above — each
   *  machine seats them one past the last player there is (ui/lobby.ts OBSERVER_PLAYER). */
  observers?: Array<{ peer: number; name: string }>;
  /** The host's Advanced Options, so every machine builds the same match from them
   *  (src/net/advancedOptions.ts). Absent reads as the defaults. */
  advanced?: import("./advancedOptions").AdvancedOptions;
}

/**
 * One player action, on its way to the host (Phase E item 9). The shape and the identity rule
 * live in [`commandLink.ts`](./commandLink.ts) — deliberately not here, because the rule that
 * matters (the sender is the relay's `from` stamp, never anything in the payload) wants to sit
 * next to the code that enforces it rather than next to a type alias.
 */
export type { CommandMessage } from "./commandLink";

/** The game LOBBY's traffic (issue #77): the host's seating broadcast, a client's request to
 *  change its own row, and lobby chat. Shapes and rules in [`lobbySetup.ts`](./lobbySetup.ts). */
export type { LobbySetup, LobbyRequest, LobbyChat } from "./lobbySetup";

export type GameMessage =
  | StartMatch
  | import("./commandLink").CommandMessage
  | import("../game/matchLink").PauseRequestMessage
  | import("../game/matchLink").PauseStateMessage
  | import("./lobbySetup").LobbySetup
  | import("./lobbySetup").LobbyRequest
  | import("./lobbySetup").LobbyChat;

/** Bumped whenever the shapes above change incompatibly; the client refuses a mismatch
 *  rather than failing in a confusing way three messages later. */
export const PROTOCOL_VERSION = 13; // 13: observers, colours, advanced options — 12: per-slot AI difficulty

/**
 * What the relay knows about ITS OWN reachability, sent with the handshake.
 *
 * A page cannot find out whether other machines can reach it — it can only reach itself. The
 * server can: it knows which interface it bound and what addresses this machine has. So the one
 * LAN failure that is genuinely diagnosable is diagnosed on the side that can see it, and the
 * screen prints the answer instead of the player discovering it from an empty game list on the
 * other machine.
 *
 * Sent only by a relay that is SERVING THE PAGE (the dev server's plugin, the desktop app). A
 * standalone or cloud relay omits it: its own addresses say nothing about how a player reaches
 * the page, and a wrong address is worse than none. The field is therefore optional in both
 * directions and needs no `PROTOCOL_VERSION` bump — an older client ignores it, and a client
 * that does not get one simply says nothing about the network.
 */
export interface HostInfo {
  /** Who is serving: the dev server (`pnpm dev`) or the packaged game. They fail differently
   *  and the fixes are not the same sentence, so the client words it and the server does not. */
  kind: "dev" | "app";
  /** False when the server is bound to the LOOPBACK interface only — the `pnpm dev` without
   *  `--host` case — or when this machine has no network address at all. Games created here
   *  are then invisible to every other machine, and nothing at the far end will say so. */
  lan: boolean;
  /** `host:port` for each non-loopback IPv4 address, ready to be typed into a browser on
   *  another machine. Empty when there is nothing to offer. */
  addresses: string[];
}

/** Default relay port, for the STANDALONE server (`node server/relay.mjs`). Overridable via
 *  PORT (the env var Railway/Render both inject). A dev server or an exported build serves the
 *  relay on its own port instead — see RELAY_PATH. */
export const DEFAULT_RELAY_PORT = 8787;

/** Where the relay lives on a server that also serves the page — the dev server
 *  (tools/vite-plugin-relay.ts) and, later, the exported game's own process. MUST equal the
 *  path that plugin claims; the two are hand-kept in sync because the plugin is loaded by
 *  Vite's config, outside this module graph. The standalone relay accepts any path, so this
 *  suffix is harmless when VITE_RELAY_URL points at one. */
export const RELAY_PATH = "/relay";
