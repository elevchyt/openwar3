import type { GameMessage, PeerInfo, RoomInfo, ServerMessage } from "./protocol";
import type { Transport } from "./transportTypes";
import { localStorageStore, reconnectPlan, type SessionStore } from "./reconnect";

// Client-side LAN lobby state: the game list, the room you are in, and who is in it.
//
// This is the layer the LAN screen (src/ui/fdfLan.ts) renders and nothing else. It holds no
// DOM and no game state — when the match starts, whoever is `isHost` here becomes the
// authority that owns the SimWorld (docs/multiplayer.md).
//
// Note the deliberate split from src/ui/lobby.ts: THAT file is the game-setup contract
// (`MeleeConfig` — races, teams, fog) consumed by the sim. THIS file is the network
// membership of a room. They meet when the host converts peers into `SlotConfig`s at launch.
//
// The transport is INJECTED (a factory), not imported. `WebSocketTransport` reads `import.meta`
// and `window`, which cannot compile to the CommonJS this project's headless tests run as — so
// depending on it would put the whole lobby out of a test's reach. With the dependency inverted
// the lobby imports only `type Transport`, and a test drives it with a fake (item 11a-client).
// The real factory is passed by the caller, which already holds `WebSocketTransport`.

/** What the lobby needs of a transport: the `Transport` seam plus `connect`, which the
 *  in-process transport does not have but a socket-backed one does. */
export type LobbyTransport = Transport & { connect(url?: string): Promise<void> };

export type LobbyPhase = "offline" | "browsing" | "hosting" | "joined";

export interface LobbyState {
  phase: LobbyPhase;
  rooms: RoomInfo[];
  room: RoomInfo | null;
  peers: PeerInfo[];
  you: PeerInfo | null;
  error: string | null;
}

const EMPTY: LobbyState = {
  phase: "offline",
  rooms: [],
  room: null,
  peers: [],
  you: null,
  error: null,
};

export class LanLobby {
  private transport: LobbyTransport | null = null;
  private state: LobbyState = { ...EMPTY };
  /** True while a dropped connection is being recovered — a rejoin is in flight and the
   *  incoming game list is about to be consulted for our room (item 11a-client). */
  private reconnecting = false;
  /** Fired on every state change; the screen re-renders from the snapshot it receives. */
  onChange: (state: LobbyState) => void = () => {};
  /** Opaque in-room traffic from a peer — the seam the command stream will arrive through. */
  onPeerData: (from: number, data: unknown) => void = () => {};
  /** The host said go. Fires on every client in the room EXCEPT the host, which acts on its
   *  own `startMatch` call directly (the relay never echoes a sender its own message). */
  onStart: (msg: GameMessage & { k: "start" }) => void = () => {};

  constructor(
    /** How to make a transport. Injected so the lobby carries no value dependency on
     *  `WebSocketTransport` and stays headless-testable — see the file header. */
    private readonly newTransport: () => LobbyTransport,
    /** Where the rejoin token is kept between a drop and a return. localStorage by default —
     *  survives a tab reload, which memory would not. */
    private readonly store: SessionStore = localStorageStore(),
  ) {}

  get snapshot(): LobbyState {
    return this.state;
  }

  get isHost(): boolean {
    return this.state.you?.host === true;
  }

  private set(patch: Partial<LobbyState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** Open the game list. Rejects with a human-readable reason if no relay is running —
   *  the LAN screen shows that text verbatim, since "start the relay" is the fix. */
  async connect(url?: string): Promise<void> {
    if (this.transport) return;
    const t = this.newTransport();
    t.onMessage = (m) => this.handle(m);
    t.onClose = (reason) => this.onLost(reason, url);
    await t.connect(url);
    this.transport = t;
    // A fresh connect lands on the game list. A RECONNECT keeps its "Reconnecting…" state
    // instead — flipping to "browsing" would blink the roster away for the beat between the
    // socket opening and the rejoin completing (item 11a-client). `tryRejoin` takes it from here.
    if (!this.reconnecting) this.set({ phase: "browsing", error: null });
  }

  /**
   * The connection went away (item 11a-client).
   *
   * A drop that happens while we hold a rejoin session is not the end of the game — the relay
   * is holding our slot (item 11a), so we reconnect and reclaim it. A drop with no session is a
   * plain disconnect from the game list, shown as before. The reconnect itself is best-effort:
   * if the relay is unreachable the promise rejects, and only THEN do we surrender to the error,
   * so a momentary blip does not throw the player out of a game the host is still running.
   */
  private onLost(reason: string, url?: string): void {
    this.transport = null;
    if (!this.store.load()) {
      this.reconnecting = false;
      this.state = { ...EMPTY, error: reason };
      this.onChange(this.state);
      return;
    }
    this.reconnecting = true;
    this.set({ error: "Reconnecting…" });
    // Re-open the socket. On success the relay sends the game list, and `handle` consults it for
    // our room (`reconnectPlan`); on failure the game is truly unreachable, so give up cleanly.
    void this.connect(url).catch(() => {
      this.reconnecting = false;
      this.store.save(null);
      this.state = { ...EMPTY, error: reason };
      this.onChange(this.state);
    });
  }

  host(name: string, playerName: string, mapName: string, mapPath: string, maxPlayers = 12): void {
    this.transport?.send({ t: "create", name, playerName, mapName, mapPath, maxPlayers });
  }

  join(roomId: string, playerName: string): void {
    this.transport?.send({ t: "join", roomId, playerName });
  }

  leave(): void {
    this.transport?.send({ t: "leave" });
    this.store.save(null); // a chosen departure — forget the token so we do not try to crawl back
    this.set({ phase: "browsing", room: null, peers: [], you: null });
  }

  refresh(): void {
    this.transport?.send({ t: "list" });
  }

  /** Send opaque data to the room (or one peer). Game traffic rides this. */
  send(data: unknown, to?: number): void {
    this.transport?.send({ t: "relay", to, data });
  }

  /** Host only: tell the room to load the map and play. */
  startMatch(msg: GameMessage & { k: "start" }): void {
    this.send(msg);
  }

  dispose(): void {
    this.store.save(null); // the match is over on our end; a fresh game starts a fresh session
    this.transport?.close();
    this.transport = null;
    this.reconnecting = false;
    this.state = { ...EMPTY };
  }

  private handle(m: ServerMessage): void {
    switch (m.t) {
      case "rooms":
        this.set({ rooms: m.rooms });
        // A reconnect in flight: the game list is the answer to "is my game still up?".
        if (this.reconnecting) this.tryRejoin(m.rooms);
        return;
      case "created":
        this.store.save({ roomId: m.room.id, token: m.token, playerName: m.you.name });
        return this.set({ phase: "hosting", room: m.room, you: m.you, peers: [m.you], error: null });
      case "joined":
        // Both a first join and a rejoin land here; remember the token either way (a rejoin
        // carries the same one). The reconnect, if any, is complete: we are back in.
        this.reconnecting = false;
        this.store.save({ roomId: m.room.id, token: m.token, playerName: m.you.name });
        return this.set({ phase: "joined", room: m.room, you: m.you, peers: m.peers, error: null });
      case "peer-join":
        return this.set({ peers: [...this.state.peers, m.peer] });
      case "peer-leave":
        return this.set({ peers: this.state.peers.filter((p) => p.id !== m.peerId) });
      case "peer-drop":
        // A peer dropped but its slot is HELD (item 11a). Keep it in the roster — it may be
        // back — rather than removing it as a leave does. The screen may grey it as "reconnecting".
        return;
      case "peer-rejoin":
        // The dropped peer reclaimed its slot; ensure it is present (it never left our roster on
        // a drop, so this is a no-op unless we missed the drop, in which case it heals).
        return this.set({
          peers: this.state.peers.some((p) => p.id === m.peer.id) ? this.state.peers : [...this.state.peers, m.peer],
        });
      case "room-closed":
        this.store.save(null); // the game is gone; nothing to rejoin
        this.reconnecting = false;
        return this.set({ phase: "browsing", room: null, peers: [], you: null, error: m.reason });
      case "deliver": {
        // Game traffic. `start` is the one message the lobby itself understands — everything
        // else is passed through to whoever owns the match (Phase C/E).
        const data = m.data as Partial<GameMessage> | null;
        if (data && data.k === "start") return this.onStart(data as GameMessage & { k: "start" });
        return this.onPeerData(m.from, m.data);
      }
      case "error":
        this.reconnecting = false; // a refused rejoin (room full, wrong token) stops the attempt
        return this.set({ error: m.message });
      case "hello":
        return; // handled during the transport handshake
    }
  }

  /** Reconnect step: our game list just arrived — reclaim our slot if the room is still there,
   *  else the host has gone and the session is dead (item 11a-client). */
  private tryRejoin(rooms: RoomInfo[]): void {
    const plan = reconnectPlan(this.store.load(), rooms);
    if (plan) {
      this.transport?.send({ t: "join", roomId: plan.roomId, playerName: plan.playerName, token: plan.token });
    } else {
      this.reconnecting = false;
      this.store.save(null);
      this.set({ ...EMPTY, phase: "browsing", error: "The game has ended." });
    }
  }
}
