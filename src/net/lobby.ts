import { DEFAULT_RELAY_PORT, RELAY_PATH, type GameMessage, type HostInfo, type PeerInfo, type RoomInfo, type ServerMessage } from "./protocol";
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

/**
 * A game in the LIST, which is not the same thing as a game on our relay.
 *
 * `RoomInfo.id` is minted by one relay and is unique only within it, so the moment the list
 * carries games from more than one machine the ids collide — two hosts both have a room 1. The
 * `key` is what the screen selects by; `source` is which relay to talk to in order to join it,
 * empty for our own.
 */
/** A machine we are watching, as a screen sees it. */
export interface RelayInfo {
  url: string;
  /** Answering right now. False for one that has not been started yet, or has gone away — both
   *  of which are waited out rather than reported as failures. */
  connected: boolean;
  /** Where the address came from. A `typed` one is the player's and only they take it off the
   *  list; a `found` one is the network's (the desktop app's beacon) and comes and goes with the
   *  machine that is broadcasting it, so it is not theirs to remove — it would be back within
   *  two seconds. */
  source: RelaySource;
}

export type RelaySource = "typed" | "found";

/** How long between knocks at an address that is not answering. A failed connect on a LAN is
 *  immediate and costs nothing; this is really about how long a player will sit looking at a
 *  list that has not noticed the other machine yet. */
const RETRY_MS = 4000;

interface RemoteRelay {
  /** Null between attempts. */
  transport: LobbyTransport | null;
  rooms: RoomInfo[];
  connected: boolean;
  retry: ReturnType<typeof setTimeout> | null;
  source: RelaySource;
}

export interface ListedRoom extends RoomInfo {
  source: string;
  key: string;
}

export interface LobbyState {
  phase: LobbyPhase;
  rooms: ListedRoom[];
  room: RoomInfo | null;
  peers: PeerInfo[];
  you: PeerInfo | null;
  error: string | null;
  /** What the relay says about THIS machine's reachability, when it is the one serving the page
   *  and therefore in a position to know (`HostInfo`). Null against a standalone or cloud relay,
   *  which is not the same as "unreachable" — it is "nobody can tell you". */
  host: HostInfo | null;
}

const EMPTY: LobbyState = {
  phase: "offline",
  rooms: [],
  room: null,
  peers: [],
  you: null,
  error: null,
  host: null,
};

/**
 * Turn what a person types into a relay URL, or null if it is not one.
 *
 * What they have in their hand is whatever the host's lobby offered to copy — today
 * `http://192.168.1.42:8787` — but people also type the bare address off a screen, and paste
 * things with spaces on the end. So every spelling of the same machine is accepted and folded
 * into the one form the transport wants.
 *
 * A bare address with no port gets the DESKTOP GAME's port, because that is who is typing: a
 * dev server is reached by people who know they are on 5173 and can say so.
 */
export function normalizeRelayUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // Any scheme they might have copied, including our own ws:// — and the path with it, since
  // the only path a relay has is the one we are about to add back.
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "");
  if (!authority || /[\s/@?#]/.test(authority)) return null;
  const [host, port = String(DEFAULT_RELAY_PORT)] = authority.split(":");
  // A hostname or an IPv4 address, and nothing else — so a word somebody typed by mistake is
  // answered as the typo it is rather than dialled and reported as a machine that did not reply.
  if (!host || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host)) return null;
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  return `ws://${host}:${port}${RELAY_PATH}`;
}

/** What to tell the player about this machine's reachability, given the relay's `HostInfo`.
 *
 *  Three answers and no fourth. **Nothing** — either no report (a standalone or cloud relay,
 *  which cannot know) or nothing worth saying. **A warning**, for the one failure a program can
 *  actually detect: the server is bound to loopback, so the game is invisible to every other
 *  machine and NOTHING at the far end will ever say so — the other player just sees an empty
 *  list and blames the network. **An address**, otherwise, because the remaining question is
 *  "what do I type over there" and this is the only place that knows.
 *
 *  What it deliberately does NOT claim is that the game IS reachable. A bound interface is not
 *  an open firewall, and no test from inside this process can tell the difference; the address
 *  is offered as the thing to try, not as a promise. */
export function reachabilityLine(host: HostInfo | null): { text: string; warn: boolean } | null {
  if (!host) return null;
  if (!host.lan) {
    return {
      warn: true,
      // Three lines is what the panel has (src/overrides/ui/LocalMultiplayerJoin.fdf), so both
      // say the CONSEQUENCE first and the cause second — a player who reads no further has
      // still learned the thing that matters, which is that nobody can see them.
      text: host.kind === "dev"
        ? "Other computers cannot see your games. Restart the server with --host."
        : "Other computers cannot see your games — this computer is not on a network.",
    };
  }
  if (!host.addresses.length) return null;
  // One address is the ordinary case. Several means several networks (wifi and ethernet, a VPN),
  // and there is no way to know which one the other player is on, so offer them all rather than
  // guessing — a wrong single address is worse than a short list.
  return { warn: false, text: `Other players join at ${host.addresses.join(" or ")}` };
}

export class LanLobby {
  /** The relay we HOST on, rejoin to, and hand to the match. One of these, always. */
  private transport: LobbyTransport | null = null;
  /** …and where it is, so a dropped connection reconnects to the same place. Undefined means
   *  the default (our own origin — `defaultRelayUrl`), which is what it is until we join a
   *  game on somebody else's machine. */
  private primaryUrl: string | undefined;
  /**
   * Other machines' relays, open for BROWSING only (`addRelay`).
   *
   * Until there is a beacon, the only way a second machine's games can appear in this list is
   * for somebody to say where to look. Each address gets its own connection, its rooms merge
   * into the one list, and joining one of them PROMOTES that connection to primary — because
   * the match wire has to be with the host's relay, and nothing else about a match changes.
   */
  private remotes = new Map<string, RemoteRelay>();
  /** Our own relay's game list, kept apart from the merged one so a remote's update cannot be
   *  mistaken for ours (the reconnect consults OURS, and only ours). */
  private ownRooms: RoomInfo[] = [];
  private state: LobbyState = { ...EMPTY };
  /** True while a dropped connection is being recovered — a rejoin is in flight and the
   *  incoming game list is about to be consulted for our room (item 11a-client). */
  private reconnecting = false;
  /**
   * The MATCH owns this wire now, so the screen that made it must not close it.
   *
   * A LAN lobby has two lives. In the first it belongs to the LAN screen, which creates it,
   * connects it, and closes it on the way out. In the second it is the MATCH'S TRANSPORT —
   * `MatchChannel` is satisfied by this class structurally, and `fdfLan` hands it straight
   * over. The two lives overlap for exactly one moment, and that moment used to eat the game:
   * `startGame` disposes the glue (`main.ts`) BEFORE it attaches the match link, so the screen's
   * teardown pulled the socket out and the link was then wired onto a closed transport. The
   * host counted 685 snapshots sent into nothing and the client received 0
   * (docs/multiplayer.md Phase F item 4).
   *
   * So the close is a question of OWNERSHIP, not of timing, and no ordering fix would have been
   * safe — `attachMatchLink` has to come after the world exists, which is after the menus are
   * gone. `handOff()` moves the ownership and `dispose()` becomes the screen's no-op; `close()`
   * is what actually ends the wire, and after a hand-off only the match's own teardown calls it.
   */
  private handedToMatch = false;
  /** Fired on every state change; the screen re-renders from the snapshot it receives. */
  onChange: (state: LobbyState) => void = () => {};
  /** Opaque in-room traffic from a peer — the seam the command stream will arrive through. */
  onPeerData: (from: number, data: unknown) => void = () => {};
  /** The host said go. Fires on every client in the room EXCEPT the host, which acts on its
   *  own `startMatch` call directly (the relay never echoes a sender its own message). */
  onStart: (msg: GameMessage & { k: "start" }) => void = () => {};
  /** A dropped peer reclaimed its slot. The ROSTER heals itself below either way; this hook is
   *  for the MATCH, whose host owes that seat the world it missed (item 11b). Separate from
   *  `onPeerData` because it is relay news about who is in the room, not game traffic. */
  onPeerRejoin: (peer: number) => void = () => {};
  /** The room is gone — in v1 that means the HOST left, since a host drop closes the room and
   *  there is no migration. For the LAN screen this is just an error line; for a MATCH in
   *  progress it is the end of the game, and nothing else will ever say so: the wire simply
   *  goes quiet and a client would otherwise keep simulating alone against it (item F6). */
  onRoomClosed: (reason: string) => void = () => {};

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
    t.onClose = (reason) => this.onLost(reason);
    await t.connect(url ?? this.primaryUrl);
    this.transport = t;
    this.primaryUrl = url ?? this.primaryUrl;
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
  private onLost(reason: string): void {
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
    void this.connect(this.primaryUrl).catch(() => {
      this.reconnecting = false;
      this.store.save(null);
      this.state = { ...EMPTY, error: reason };
      this.onChange(this.state);
    });
  }

  /** Announce a game. `maxPlayers` is every seat the lobby has — the map's slots plus the
   *  Observers bench under Full Observers — and `observers` is what the game list prints. */
  host(name: string, playerName: string, mapName: string, mapPath: string, maxPlayers = 12, observers = false): void {
    this.transport?.send({ t: "create", name, playerName, mapName, mapPath, maxPlayers, observers });
  }

  /**
   * Join a game from the list, wherever it is. `key` is a `ListedRoom.key`, not a relay's own
   * room id — see that type for why they are not the same thing.
   *
   * A game on ANOTHER machine promotes that machine's connection to primary before the join is
   * sent, because everything after this moment — the roster, the countdown, the match's whole
   * wire — is with the HOST's relay and not with ours. Nothing else about a match changes: the
   * promoted connection is a `LobbyTransport` like any other, and `handOff` hands it over the
   * same way. The browse connections are kept until the join is answered, so a refusal (a full
   * room, a game that ended while we read the list) leaves us still browsing.
   */
  join(key: string, playerName: string): void {
    const room = this.state.rooms.find((r) => r.key === key);
    if (!room) return;
    if (room.source) this.promote(room.source);
    this.transport?.send({ t: "join", roomId: room.id, playerName });
  }

  /**
   * Watch another machine's relay as well as our own (`ws://host:port/relay`).
   *
   * This is the manual half of discovery, and until a UDP beacon exists it is the only half:
   * an Electron window has no address bar, so a second machine cannot be reached by navigating
   * to it, and the app's own relay is on loopback — two copies of the game on one network can
   * otherwise never see each other. The host copies its address out of the game lobby and the
   * joiner pastes it here.
   *
   * Rejects with a readable reason: the screen shows it, and "nothing happened" is the one
   * answer a typed-in address must never give.
   */
  addRelay(input: string, source: RelaySource = "typed"): void {
    const url = normalizeRelayUrl(input);
    if (!url) throw new Error(`"${input}" is not an address. Try 192.168.1.42 or 192.168.1.42:${DEFAULT_RELAY_PORT}.`);
    if (this.isOurOwn(url)) throw new Error("That address is this computer — your own games are already listed.");
    const already = this.remotes.get(url);
    if (already) {
      // A machine the player had already typed in, now also heard on the network, stays THEIRS:
      // it should not lose its ✕ because a beacon happened to arrive.
      if (source === "typed") already.source = "typed";
      this.refresh();
      return;
    }
    const entry: RemoteRelay = { transport: null, rooms: [], connected: false, retry: null, source };
    this.remotes.set(url, entry);
    this.mergeRooms();
    this.dial(url, entry);
  }

  /**
   * The machines the network says are there, as a whole set (src/net/discovery.ts).
   *
   * Given the SET rather than arrivals and departures, because the beacon already knows exactly
   * who it can hear and the alternative is the same bookkeeping written twice, in two places
   * that would disagree the first time a datagram went missing. Addresses the player typed are
   * untouched: those are theirs, and a machine that stops broadcasting has not stopped being an
   * address they asked to watch.
   */
  setDiscovered(urls: readonly string[]): void {
    const wanted = new Set(urls.map((u) => normalizeRelayUrl(u)).filter((u): u is string => !!u));
    for (const [url, entry] of [...this.remotes]) {
      if (entry.source === "found" && !wanted.has(url)) this.removeRelay(url);
    }
    for (const url of wanted) {
      // `isOurOwn` throws for our own address, and a beacon can legitimately carry it: two copies
      // of the game on one machine hear each other, which is how this gets tested.
      try { this.addRelay(url, "found"); } catch { /* ours, or unparseable — nothing to watch */ }
    }
  }

  /**
   * Open (or re-open) a browse connection, and keep trying.
   *
   * A machine that does not answer is not a mistake — the game there has not been started yet,
   * which is the ordinary case when two people are sitting down to play. So the address stays on
   * the list and this keeps knocking, and the moment somebody hosts on it their game appears
   * with no second act from the player. The same loop covers a host who quits and comes back.
   *
   * `RETRY_MS` is a whole failed TCP connect on a LAN, which costs nothing, against how long a
   * player is willing to sit looking at a list that has not noticed yet.
   */
  private dial(url: string, entry: RemoteRelay): void {
    const again = (): void => {
      entry.transport = null;
      if (entry.connected) { entry.connected = false; entry.rooms = []; this.mergeRooms(); }
      // Removed while we were away: stop, and leave no timer behind.
      if (this.remotes.get(url) !== entry) return;
      entry.retry = setTimeout(() => { entry.retry = null; this.dial(url, entry); }, RETRY_MS);
    };
    const t = this.newTransport();
    entry.transport = t;
    t.onMessage = (m) => {
      // A browse connection understands exactly one message. Everything else a relay can say is
      // about a room we are in, and we are not in one — until we join, at which point this
      // connection has been promoted and `handle` is the listener.
      if (m.t === "rooms" && this.remotes.get(url) === entry) { entry.rooms = m.rooms; this.mergeRooms(); }
    };
    t.onClose = again;
    void t.connect(url).then(
      () => {
        if (this.remotes.get(url) !== entry) return t.close(); // removed mid-dial
        entry.connected = true;
        this.mergeRooms();
      },
      again,
    );
  }

  /** The addresses being watched besides our own, and whether each is answering — a screen
   *  shows both, because an address that nothing is hosting on yet is a normal thing to be
   *  looking at and should not read as an error. */
  get relays(): RelayInfo[] {
    return [...this.remotes].map(([url, entry]) => ({ url, connected: entry.connected, source: entry.source }));
  }

  /** Stop watching one. Its games leave the list with it — they were never ours to show once
   *  nobody is listening to the machine hosting them — and its retry stops with it. */
  removeRelay(url: string): void {
    const entry = this.remotes.get(url);
    if (!entry) return;
    this.remotes.delete(url);
    if (entry.retry !== null) clearTimeout(entry.retry);
    entry.transport?.close();
    this.mergeRooms();
  }

  /** Is this address one of ours? The relay tells us its own addresses at the handshake
   *  (`HostInfo`), so pasting your own link is answered rather than silently listing every game
   *  twice — which, with our own port on loopback and a LAN address for the same server, is
   *  otherwise indistinguishable from two machines that happen to agree. */
  private isOurOwn(url: string): boolean {
    const mine = this.state.host?.addresses ?? [];
    const authority = url.replace(/^ws:\/\//, "").replace(/\/relay$/, "");
    return mine.includes(authority);
  }

  /** Make a browse connection the primary one — see `join`. */
  private promote(url: string): void {
    const entry = this.remotes.get(url);
    if (!entry) return;
    this.remotes.delete(url);
    if (entry.retry !== null) clearTimeout(entry.retry);
    this.transport?.close();
    const t = entry.transport;
    if (!t) return; // still knocking: there is nothing yet to promote
    t.onMessage = (m) => this.handle(m);
    t.onClose = (reason) => this.onLost(reason);
    this.transport = t;
    this.primaryUrl = url;
    // Their list is now ours, and every OTHER machine's is no longer any of our business.
    this.ownRooms = entry.rooms;
    for (const other of this.remotes.values()) {
      if (other.retry !== null) clearTimeout(other.retry);
      other.transport?.close();
    }
    this.remotes.clear();
    this.mergeRooms();
  }

  /** One list out of every relay we are watching. Ours first — it is the one the player made
   *  their own game on, and a list that reorders itself as a remote answers is a list whose
   *  rows move under the mouse. */
  private mergeRooms(): void {
    const listed: ListedRoom[] = this.ownRooms.map((r) => ({ ...r, source: "", key: `#${r.id}` }));
    for (const [url, entry] of this.remotes) {
      for (const r of entry.rooms) listed.push({ ...r, source: url, key: `${url}#${r.id}` });
    }
    this.set({ rooms: listed });
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

  /**
   * The match takes the wire (see `handedToMatch`). Called by the LAN screen at the instant it
   * hands the link over — before `startGame`, because `startGame` is what disposes the screen.
   */
  handOff(): void {
    this.handedToMatch = true;
  }

  /** The SCREEN is done with the lobby. Refused once the match owns the wire: a menu going away
   *  must not disconnect a game in progress. */
  dispose(): void {
    if (this.handedToMatch) return;
    this.close();
  }

  /** End the wire, whoever owns it. The match's teardown (`exitToMenu`) calls this; before a
   *  hand-off, `dispose()` does. */
  close(): void {
    this.store.save(null); // the match is over on our end; a fresh game starts a fresh session
    this.transport?.close();
    this.transport = null;
    for (const entry of this.remotes.values()) {
      if (entry.retry !== null) clearTimeout(entry.retry);
      entry.transport?.close();
    }
    this.remotes.clear();
    this.ownRooms = [];
    this.primaryUrl = undefined;
    this.reconnecting = false;
    this.handedToMatch = false;
    this.state = { ...EMPTY };
  }

  private handle(m: ServerMessage): void {
    switch (m.t) {
      case "rooms":
        this.ownRooms = m.rooms;
        this.mergeRooms();
        // A reconnect in flight: the game list is the answer to "is my game still up?". Asked
        // of OUR relay's list and never the merged one — the room we are crawling back into is
        // on the machine we were playing on, whose id means nothing anywhere else.
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
        this.set({
          peers: this.state.peers.some((p) => p.id === m.peer.id) ? this.state.peers : [...this.state.peers, m.peer],
        });
        // Then tell the match. On the host this is what triggers the catch-up snapshot; on
        // another client it is ignored. Fired AFTER the roster heals, so anything that reads
        // the roster in response sees the peer already in it.
        return this.onPeerRejoin(m.peer.id);
      case "room-closed": {
        this.store.save(null); // the game is gone; nothing to rejoin
        this.reconnecting = false;
        this.set({ phase: "browsing", room: null, peers: [], you: null, error: m.reason });
        // Then the match, AFTER the state settles — the same order `peer-rejoin` uses, so
        // anything reading the lobby in response sees the room already gone.
        return this.onRoomClosed(m.reason);
      }
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
        // The version check is the transport's (it must fail before a lobby exists). What the
        // screen wants from the handshake is the reachability report beside it.
        return this.set({ host: m.host ?? null });
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
