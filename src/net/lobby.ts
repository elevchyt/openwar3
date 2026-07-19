import type { PeerInfo, RoomInfo, ServerMessage } from "./protocol";
import { WebSocketTransport, type Transport } from "./transport";

// Client-side LAN lobby state: the game list, the room you are in, and who is in it.
//
// This is the layer the LAN screen (src/ui/fdfLan.ts) renders and nothing else. It holds no
// DOM and no game state — when the match starts, whoever is `isHost` here becomes the
// authority that owns the SimWorld (docs/multiplayer.md).
//
// Note the deliberate split from src/ui/lobby.ts: THAT file is the game-setup contract
// (`MeleeConfig` — races, teams, fog) consumed by the sim. THIS file is the network
// membership of a room. They meet when the host converts peers into `SlotConfig`s at launch.

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
  private transport: Transport | null = null;
  private state: LobbyState = { ...EMPTY };
  /** Fired on every state change; the screen re-renders from the snapshot it receives. */
  onChange: (state: LobbyState) => void = () => {};
  /** Opaque in-room traffic from a peer — the seam the command stream will arrive through. */
  onPeerData: (from: number, data: unknown) => void = () => {};

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
    const t = new WebSocketTransport();
    t.onMessage = (m) => this.handle(m);
    t.onClose = (reason) => {
      this.transport = null;
      this.state = { ...EMPTY, error: reason };
      this.onChange(this.state);
    };
    await t.connect(url);
    this.transport = t;
    this.set({ phase: "browsing", error: null });
  }

  host(name: string, playerName: string, mapName: string, maxPlayers = 12): void {
    this.transport?.send({ t: "create", name, playerName, mapName, maxPlayers });
  }

  join(roomId: string, playerName: string): void {
    this.transport?.send({ t: "join", roomId, playerName });
  }

  leave(): void {
    this.transport?.send({ t: "leave" });
    this.set({ phase: "browsing", room: null, peers: [], you: null });
  }

  refresh(): void {
    this.transport?.send({ t: "list" });
  }

  /** Send opaque data to the room (or one peer). Game traffic rides this. */
  send(data: unknown, to?: number): void {
    this.transport?.send({ t: "relay", to, data });
  }

  dispose(): void {
    this.transport?.close();
    this.transport = null;
    this.state = { ...EMPTY };
  }

  private handle(m: ServerMessage): void {
    switch (m.t) {
      case "rooms":
        return this.set({ rooms: m.rooms });
      case "created":
        return this.set({ phase: "hosting", room: m.room, you: m.you, peers: [m.you], error: null });
      case "joined":
        return this.set({ phase: "joined", room: m.room, you: m.you, peers: m.peers, error: null });
      case "peer-join":
        return this.set({ peers: [...this.state.peers, m.peer] });
      case "peer-leave":
        return this.set({ peers: this.state.peers.filter((p) => p.id !== m.peerId) });
      case "room-closed":
        return this.set({ phase: "browsing", room: null, peers: [], you: null, error: m.reason });
      case "deliver":
        return this.onPeerData(m.from, m.data);
      case "error":
        return this.set({ error: m.message });
      case "hello":
        return; // handled during the transport handshake
    }
  }
}
